"""Cuttlely fetch helper: the one way the assets specialist downloads a file from the web.

    import cuttlely_fetch as net
    net.fetch_asset("https://commons.wikimedia.org/wiki/Special:FilePath/Example.svg", out / "logo.svg")
    # prints: saved logo.svg: 1234 bytes, image/svg+xml, from https://commons.wikimedia.org/wiki/Special:FilePath/Example.svg after 1 redirect

    result = net.fetch(url, max_bytes=2_000_000, timeout_ms=15_000, accept="image/*")
    result["status"], result["contentType"], result["bytes"], result["finalUrl"], result["shownUrl"]

Only http and https. Every hop is checked: the host name is resolved, every address it resolves to must be a
public address (no private, loopback, link-local, metadata, multicast or reserved ranges, IPv4 or IPv6), and the
connection goes to the address that was checked. An IPv4-mapped IPv6 address is judged by the IPv4 address it
contains, and so are the 6to4, NAT64 and IPv4-compatible forms this module already reads. Redirects are followed
here, one hop at a time, and each new location is checked the same way. The body is capped (max_bytes) and the whole fetch has one deadline
(timeout_ms). Sites such as Wikimedia refuse Python's default user agent, so this fetch, and only this fetch,
sends a browser-like user agent. Standard library only.
"""

import http.client
import ipaddress
import os
import re
import socket
import ssl
import threading
import time
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Cuttlely-assets"
)
DEFAULT_MAX_BYTES = 10 * 1024 * 1024
MAX_BYTES_LIMIT = 50 * 1024 * 1024
DEFAULT_TIMEOUT_MS = 20_000
MAX_TIMEOUT_MS = 60_000
MAX_REDIRECTS = 5
CHUNK = 64 * 1024
REDIRECT_CODES = (301, 302, 303, 307, 308)
ASSET_TYPES = ("image/", "application/pdf", "font/", "application/font-", "application/vnd.ms-fontobject")
ASSET_ACCEPT = "image/svg+xml,image/png,image/webp,image/jpeg,image/gif,image/*;q=0.8,application/pdf;q=0.5"

# Ranges that are_global misses on some Python versions, kept explicit so the rule does not move with the runtime.
_BLOCKED_NETWORKS = [
    ipaddress.ip_network(net)
    for net in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "::/128",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
        "fec0::/10",
        "ff00::/8",
        "fd00:ec2::254/128",
        "64:ff9b:1::/48",  # local-use NAT64 (RFC 8215); Python 3.11 and 3.12 count it as global
    )
]

# Well-known NAT64 (RFC 6052). The last 32 bits are an IPv4 address. Not the local-use prefix above.
_WELL_KNOWN_NAT64 = ipaddress.ip_network("64:ff9b::/96")


_MIME = re.compile(r"[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}")


class FetchError(Exception):
    """A fetch that did not return a usable body. The message names the URL and, when there was one, the status."""

    def __init__(self, message, url="", status=None, shown=None):
        url = str(url or "")
        if shown is None:
            shown = shown_url(url)
            if url and url != shown:
                message = message.replace(url, shown)
        super().__init__(message)
        self.url = shown
        self.status = status


def shown_url(url):
    """The URL as it may appear in an error: no user name or password, and no query string, which can carry a token."""
    try:
        parts = urlsplit(str(url))
        host = parts.hostname or ""
    except ValueError:
        return "(unparseable URL)"
    if ":" in host:
        host = f"[{host}]"
    try:
        port = parts.port
    except ValueError:
        port = None
    netloc = host + (f":{port}" if port is not None else "")
    return f"{parts.scheme}://{netloc}{parts.path}" + ("?(query hidden)" if parts.query else "") if parts.scheme or netloc else "(URL hidden)"


def _embedded_ipv4(ip):
    """The IPv4 address inside an IPv6 wrapper this module already understands, or None.

    IPv4-mapped (::ffff:a.b.c.d), 6to4 (2002:aabb:ccdd::), well-known NAT64 (64:ff9b::a.b.c.d)
    and IPv4-compatible (::a.b.c.d). :: and ::1 stay plain: they are unspecified and loopback.
    """
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip in _WELL_KNOWN_NAT64:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    if int(ip) >> 32 == 0 and int(ip) > 1:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def _address_blocked(ip):
    """True when an ipaddress object must not be fetched from."""
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded is not None:
            return _address_blocked(embedded)
    if any(ip in net for net in _BLOCKED_NETWORKS if net.version == ip.version):
        return True
    return not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_link_local or ip.is_loopback


def blocked_address(address):
    """True when an IP address (str or ipaddress object) must not be fetched from.

    An IPv6 address that carries an IPv4 address is judged only by that IPv4 address. On Python 3.12,
    ::ffff:0:0/96 is reserved IPv6, so the wrapper's own flags refuse a public address such as ::ffff:8.8.8.8.
    """
    ip = ipaddress.ip_address(address) if isinstance(address, str) else address
    return _address_blocked(ip)


def _resolve(host, port):
    return [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def _resolve_by(host, port, deadline, url, where=None, host_shown=None):
    """Resolve on a worker thread so a slow resolver cannot outlast the fetch deadline."""
    outcome = {}

    def work():
        try:
            outcome["addresses"] = _resolve(host, port)
        except Exception as error:  # noqa: BLE001 - IDNA failures raise UnicodeError; every failure becomes a FetchError
            outcome["error"] = error

    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    worker.join(max(0.0, deadline - time.monotonic()))
    if worker.is_alive():
        raise FetchError(f"fetch failed: timed out resolving {host_shown or host}, for {where or url}", url, shown=where)
    if "error" in outcome:
        error = outcome["error"]
        errno = getattr(error, "errno", None)
        detail = os.strerror(errno) if isinstance(errno, int) and errno > 0 else type(error).__name__
        raise FetchError(f"fetch failed: could not resolve {host_shown or host} ({detail}) for {where or url}", url, shown=where)
    return outcome["addresses"]


def _checked_address(host, port, url, deadline=None, where=None, redirected=False):
    """The first address of host, checked public. where names the fetch in errors; after a redirect the host and
    address come from the server, so they are left out of the message."""
    host_shown = "the redirect host" if redirected else host
    try:
        addresses = [str(ipaddress.ip_address(host.strip("[]")))]
    except ValueError:
        addresses = None
    # Resolved outside the handler, so a failure carries no earlier exception (whose text names the host).
    if addresses is None:
        addresses = _resolve_by(
            host, port, time.monotonic() + DEFAULT_TIMEOUT_MS / 1000 if deadline is None else deadline, url, where, host_shown
        )
    if not addresses:
        raise FetchError(f"fetch failed: {host_shown} has no address, for {where or url}", url, shown=where)
    for address in addresses:
        if blocked_address(address.split("%")[0]):
            shown_address = "" if redirected else f" ({address})"
            raise FetchError(
                f"fetch refused: {host_shown} resolves to a private or reserved address{shown_address}, for {where or url}",
                url,
                shown=where,
            )
    return addresses[0].split("%")[0]


def _split(url, where=None, redirected=False):
    """Scheme, host, port and request target of url. After a redirect the URL is server text, so errors name only where."""
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        shown = where or shown_url(url)
        raise FetchError(f"fetch refused: malformed URL or port, {shown}", url, shown=shown) from None
    if parts.scheme not in ("http", "https"):
        scheme = "another scheme" if redirected else f"not {parts.scheme or 'none'}"
        raise FetchError(f"fetch refused: only http and https URLs, {scheme}: {where or url}", url, shown=where)
    if parts.username or parts.password:
        named = "the redirect host" if redirected else hostname
        raise FetchError(f"fetch refused: URLs with a user name or password are not fetched: {named}", url, shown=where)
    if not hostname:
        raise FetchError(f"fetch refused: no host in {where or url}", url, shown=where)
    if "%" in hostname or any(c.isspace() or not c.isprintable() for c in hostname):
        # A scoped IPv6 literal (fe80::1%eth0) or a host with spaces is never a public asset host.
        raise FetchError(f"fetch refused: malformed host, {where or shown_url(url)}", url, shown=where)
    # Spaces and non-ASCII characters (Commons file names such as "Example logo.svg" or "Café.svg") are
    # percent-encoded; existing escapes and reserved characters are kept as they are.
    target = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
    if parts.query:
        target += "?" + quote(parts.query, safe="/%:@!$&'()*+,;=-._~?")
    return parts.scheme, hostname, port, target


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, address, timeout, deadline=None):
        super().__init__(host, port, timeout=timeout)
        self._address = address

    def connect(self):
        self.sock = self.raw_socket = socket.create_connection((self._address, self.port), self.timeout)


def _tls_context():
    return ssl.create_default_context()


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, address, timeout, deadline=None):
        super().__init__(host, port, timeout=timeout, context=_tls_context())
        self._address = address
        self._deadline = deadline

    def connect(self):
        # raw_socket is what the deadline watchdog shuts down. The TLS socket is published before the handshake, so
        # the watchdog can end a slow handshake too (wrapping moves the connection out of the TCP socket object).
        raw = self.raw_socket = socket.create_connection((self._address, self.port), self.timeout)
        # The certificate is checked against the host name, while the socket goes to the checked address.
        wrapped = self._context.wrap_socket(raw, server_hostname=self.host, do_handshake_on_connect=False)
        self.sock = self.raw_socket = wrapped
        left = self._deadline - time.monotonic() if self._deadline else self.timeout
        if left <= 0:
            raise socket.timeout("deadline passed before the TLS handshake")
        wrapped.settimeout(left)
        wrapped.do_handshake()


_CERT_REASONS = {
    10: "certificate has expired",
    9: "certificate is not yet valid",
    18: "self-signed certificate",
    19: "self-signed certificate in chain",
    20: "unknown issuer",
    21: "unknown issuer",
    23: "certificate revoked",
    62: "host name mismatch",
}


def _bounded(value, default, limit, name):
    if value is None:
        return default
    number = int(value)
    if number <= 0:
        raise ValueError(f"{name} must be positive")
    return min(number, limit)


def _declared_length(response, max_bytes):
    """The declared Content-Length as an int, None when absent, -1 when malformed or repeated with different values.

    The value is server text: it is compared, never printed. Repeated headers (or a comma list) that agree count once.
    Leading zeros do not count toward its size; a number with more than 18 digits is over any cap.
    """
    values = []
    for header in response.msg.get_all("Content-Length") or []:
        values.extend(part.strip() for part in header.split(","))
    numbers = set()
    for value in values:
        if not (value.isascii() and value.isdigit()):
            return -1
        value = value.lstrip("0") or "0"
        numbers.add(max_bytes + 1 if len(value) > 18 else int(value))
    if not numbers:
        return None
    if len(numbers) > 1:
        return -1
    return numbers.pop()


def fetch(url, max_bytes=None, timeout_ms=None, accept=None):
    """Download one URL. Returns {"status", "contentType", "bytes", "finalUrl", "shownUrl"}; raises FetchError.

    shownUrl is safe to print: the original URL without credentials or query, plus the redirect count. Errors use it too.

    max_bytes (default 10 MB, at most 50 MB) caps the body; timeout_ms (default 20 s, at most 60 s) is one deadline
    for the whole fetch, redirects included. accept is sent as the Accept header (default */*).
    A status other than 2xx is returned, not raised, so the caller can report it.
    """
    max_bytes = _bounded(max_bytes, DEFAULT_MAX_BYTES, MAX_BYTES_LIMIT, "max_bytes")
    timeout_ms = _bounded(timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeout_ms")
    deadline = time.monotonic() + timeout_ms / 1000
    current = str(url)
    first = shown_url(current)
    for hop in range(MAX_REDIRECTS + 1):
        # Every part of a redirect target is server text (a server can echo the query into a path or host), so
        # after a redirect errors and the saved line name the original URL and the redirect count only.
        where = first if hop == 0 else f"{first} after {hop} redirect{'s' if hop > 1 else ''}"
        scheme, host, port, target = _split(current, where, hop > 0)
        address = _checked_address(host, port, current, deadline, where, hop > 0)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchError(f"fetch failed: timed out after {timeout_ms} ms at {where}", current, shown=where)
        connection_type = _PinnedHTTPSConnection if scheme == "https" else _PinnedHTTPConnection
        try:
            connection = connection_type(host, port, address, remaining, deadline)
        except (ValueError, http.client.HTTPException):
            # The constructor's message quotes the host, which after a redirect is server text: fixed words only.
            raise FetchError(f"fetch refused: malformed host, {where}", current, shown=where) from None
        # Socket timeouts only bound each idle wait, so a peer trickling bytes could outlast them. At the deadline
        # this watchdog shuts the socket down, which ends any read in progress (headers, chunks or body).
        expired = threading.Event()

        def stop(connection=connection, expired=expired):
            expired.set()
            # The response can hold the socket after the connection lets go of it, so the socket kept at connect is used.
            sock = getattr(connection, "raw_socket", None)
            if sock is not None:
                try:
                    # The plain socket shutdown, so a TLS socket's state is not touched from this thread.
                    socket.socket.shutdown(sock, socket.SHUT_RDWR)
                except OSError:
                    pass

        watchdog = threading.Timer(remaining, stop)
        watchdog.daemon = True
        watchdog.start()
        try:
            connection.connect()
            if expired.is_set() or time.monotonic() >= deadline:
                raise FetchError(f"fetch failed: timed out after {timeout_ms} ms at {where}", current, shown=where)
            connection.request(
                "GET",
                target,
                headers={"User-Agent": USER_AGENT, "Accept": accept or "*/*", "Accept-Encoding": "identity"},
            )
            response = connection.getresponse()
            status = response.status
            if status in REDIRECT_CODES:
                location = response.getheader("Location")
                if not location:
                    raise FetchError(f"fetch failed: HTTP {status} without a Location, at {where}", current, status, shown=where)
                try:
                    current = urljoin(current, location)
                except ValueError:
                    raise FetchError(
                        f"fetch failed: HTTP {status} with a malformed Location, at {where}", current, status, shown=where
                    ) from None
                continue
            content_type = (response.getheader("Content-Type") or "").split(";")[0].strip().lower()
            if content_type and not _MIME.fullmatch(content_type):
                content_type = "unrecognized"
            declared = _declared_length(response, max_bytes)
            if declared == -1:
                raise FetchError(f"fetch failed: HTTP {status}, malformed or conflicting declared sizes, at {where}", current, status, shown=where)
            if declared is not None and declared > max_bytes:
                raise FetchError(
                    f"fetch failed: HTTP {status}, declared size is over the {max_bytes} byte cap, at {where}", current, status, shown=where
                )
            if declared is not None and not response.chunked and response.length != declared:
                # http.client frames the body by its own reading of the header; a form it does not read the same way
                # (a comma list, for example) would leave the body unframed, so it is refused.
                raise FetchError(f"fetch failed: HTTP {status}, malformed or conflicting declared sizes, at {where}", current, status, shown=where)
            body = bytearray()
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise FetchError(f"fetch failed: timed out after {timeout_ms} ms at {where}", current, status, shown=where)
                sock = getattr(connection, "raw_socket", None)
                if sock is not None and sock.fileno() != -1:
                    sock.settimeout(left)
                chunk = response.read(min(CHUNK, max_bytes + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise FetchError(f"fetch failed: HTTP {status}, body is over the {max_bytes} byte cap, at {where}", current, status, shown=where)
            if expired.is_set():
                raise FetchError(f"fetch failed: timed out after {timeout_ms} ms at {where}", current, status, shown=where)
            if declared is not None and len(body) != declared:
                raise FetchError(
                    f"fetch failed: HTTP {status}, connection closed after {len(body)} bytes, short of the declared size, at {where}",
                    current,
                    status,
                    shown=where,
                )
            return {"status": status, "contentType": content_type, "bytes": bytes(body), "finalUrl": current, "shownUrl": where}
        except FetchError:
            raise
        except (socket.timeout, TimeoutError):
            raise FetchError(f"fetch failed: timed out after {timeout_ms} ms at {where}", current, shown=where) from None
        except (OSError, http.client.HTTPException) as error:
            if expired.is_set():
                raise FetchError(f"fetch failed: timed out after {timeout_ms} ms at {where}", current, shown=where) from None
            # Only the error's type and, for OS errors, its errno text: a remote peer controls the rest (a malformed
            # status line can echo the request target and its query).
            if isinstance(error, ssl.SSLCertVerificationError):
                # verify_message can quote the host name, which after a redirect is server text: fixed words only.
                detail = f"certificate check failed ({_CERT_REASONS.get(error.verify_code, 'not trusted')})"
            elif isinstance(error, OSError) and not isinstance(error, ssl.SSLError) and isinstance(error.errno, int):
                detail = os.strerror(error.errno)
            else:
                detail = ""
            raise FetchError(f"fetch failed: {type(error).__name__}{': ' + detail if detail else ''}, at {where}", current, shown=where) from None
        finally:
            watchdog.cancel()
            connection.close()
    raise FetchError(f"fetch failed: more than {MAX_REDIRECTS} redirects, last at {first}", current, shown=first)


def _looks_like_html(data):
    head = data[:512].lstrip().lower()
    return head.startswith(b"<!doctype html") or head.startswith(b"<html")


_KNOWN_TYPES = frozenset(
    {
        "text/html", "text/plain", "text/css", "text/javascript", "text/xml", "text/csv",
        "application/json", "application/xml", "application/javascript", "application/octet-stream",
        "application/pdf", "application/zip", "application/xhtml+xml", "application/vnd.ms-fontobject",
        "application/font-woff", "application/font-sfnt",
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif",
        "image/bmp", "image/tiff", "image/x-icon", "image/vnd.microsoft.icon",
        "font/woff", "font/woff2", "font/ttf", "font/otf", "font/sfnt", "font/collection",
    }
)


def shown_type(kind):
    """A content type safe to print: a well-known type as is, anything else as a fixed word, never server text."""
    if not kind:
        return "missing"
    if kind in _KNOWN_TYPES:
        return kind
    major = kind.split("/", 1)[0]
    return f"other {major}" if major in ("image", "font", "text", "application", "audio", "video") else "unrecognized"


def fetch_asset(url, path, max_bytes=None, timeout_ms=None, types=ASSET_TYPES):
    """Download an image, PDF or font to path and print its byte count. Raises FetchError when it is not one.

    Only a printed "saved <name>: <n> bytes" line means the file is there. Returns the Path.
    """
    result = fetch(url, max_bytes=max_bytes, timeout_ms=timeout_ms, accept=ASSET_ACCEPT)
    final = result["finalUrl"]
    where = result["shownUrl"]
    if result["status"] != 200:
        raise FetchError(f"fetch_asset failed: HTTP {result['status']} from {where}", final, result["status"], shown=where)
    data = result["bytes"]
    kind = result["contentType"]
    if not data:
        raise FetchError(f"fetch_asset failed: HTTP {result['status']}, empty body from {where}", final, result["status"], shown=where)
    if not kind.startswith(tuple(types)) or _looks_like_html(data):
        raise FetchError(
            f"fetch_asset failed: HTTP {result['status']}, content type {shown_type(kind)} is not an image, PDF or font, from {where}",
            final,
            result["status"],
            shown=where,
        )
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    print(f"saved {target.name}: {len(data)} bytes, {shown_type(kind)}, from {where}")
    return target
