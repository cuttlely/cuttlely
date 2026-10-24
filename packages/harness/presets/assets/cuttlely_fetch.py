"""Cuttlely fetch helper: the one way the assets specialist downloads a file from the web.

    import cuttlely_fetch as net
    net.fetch_asset("https://commons.wikimedia.org/wiki/Special:FilePath/Example.svg", out / "logo.svg")
    # prints: saved logo.svg: 1234 bytes, image/svg+xml, from https://upload.wikimedia.org/...

    result = net.fetch(url, max_bytes=2_000_000, timeout_ms=15_000, accept="image/*")
    result["status"], result["contentType"], result["bytes"], result["finalUrl"]

Only http and https. Every hop is checked: the host name is resolved, every address it resolves to must be a
public address (no private, loopback, link-local, metadata, multicast or reserved ranges, IPv4 or IPv6), and the
connection goes to the address that was checked. Redirects are followed here, one hop at a time, and each new
location is checked the same way. The body is capped (max_bytes) and the whole fetch has one deadline
(timeout_ms). Sites such as Wikimedia refuse Python's default user agent, so this fetch, and only this fetch,
sends a browser-like user agent. Standard library only.
"""

import http.client
import ipaddress
import socket
import ssl
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

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
    )
]


class FetchError(Exception):
    """A fetch that did not return a usable body. The message names the URL and, when there was one, the status."""

    def __init__(self, message, url="", status=None):
        super().__init__(message)
        self.url = url
        self.status = status


def blocked_address(address):
    """True when an IP address (str or ipaddress object) must not be fetched from."""
    ip = ipaddress.ip_address(address) if isinstance(address, str) else address
    if isinstance(ip, ipaddress.IPv6Address):
        # IPv4-mapped, IPv4-compatible, 6to4 and NAT64 forms carry an IPv4 address; check that address too.
        mapped = ip.ipv4_mapped or ip.sixtofour
        if mapped is None and ip in ipaddress.ip_network("64:ff9b::/96"):
            mapped = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        if mapped is None and int(ip) >> 32 == 0 and int(ip) > 1:
            mapped = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        if mapped is not None and blocked_address(mapped):
            return True
    if any(ip in net for net in _BLOCKED_NETWORKS if net.version == ip.version):
        return True
    return not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_link_local or ip.is_loopback


def _resolve(host, port):
    return [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def _checked_address(host, port, url):
    try:
        literal = ipaddress.ip_address(host.strip("[]"))
        addresses = [str(literal)]
    except ValueError:
        try:
            addresses = _resolve(host, port)
        except OSError as error:
            raise FetchError(f"fetch failed: could not resolve {host} ({error}) for {url}", url) from None
    if not addresses:
        raise FetchError(f"fetch failed: {host} has no address, for {url}", url)
    for address in addresses:
        if blocked_address(address.split("%")[0]):
            raise FetchError(f"fetch refused: {host} resolves to a private or reserved address ({address}), for {url}", url)
    return addresses[0].split("%")[0]


def _split(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise FetchError(f"fetch refused: only http and https URLs, not {parts.scheme or 'none'}: {url}", url)
    if parts.username or parts.password:
        raise FetchError(f"fetch refused: URLs with a user name or password are not fetched: {parts.hostname}", url)
    if not parts.hostname:
        raise FetchError(f"fetch refused: no host in {url}", url)
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise FetchError(f"fetch refused: bad port in {url}", url) from None
    target = parts.path or "/"
    if parts.query:
        target += "?" + parts.query
    return parts.scheme, parts.hostname, port, target


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, address, timeout):
        super().__init__(host, port, timeout=timeout)
        self._address = address

    def connect(self):
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, address, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self._address = address

    def connect(self):
        raw = socket.create_connection((self._address, self.port), self.timeout)
        # The certificate is checked against the host name, while the socket goes to the checked address.
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def _bounded(value, default, limit, name):
    if value is None:
        return default
    number = int(value)
    if number <= 0:
        raise ValueError(f"{name} must be positive")
    return min(number, limit)


def fetch(url, max_bytes=None, timeout_ms=None, accept=None):
    """Download one URL. Returns {"status", "contentType", "bytes", "finalUrl"}; raises FetchError.

    max_bytes (default 10 MB, at most 50 MB) caps the body; timeout_ms (default 20 s, at most 60 s) is one deadline
    for the whole fetch, redirects included. accept is sent as the Accept header (default */*).
    A status other than 2xx is returned, not raised, so the caller can report it.
    """
    max_bytes = _bounded(max_bytes, DEFAULT_MAX_BYTES, MAX_BYTES_LIMIT, "max_bytes")
    timeout_ms = _bounded(timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeout_ms")
    deadline = time.monotonic() + timeout_ms / 1000
    current = str(url)
    for _hop in range(MAX_REDIRECTS + 1):
        scheme, host, port, target = _split(current)
        address = _checked_address(host, port, current)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchError(f"fetch failed: timed out after {timeout_ms} ms at {current}", current)
        connection_type = _PinnedHTTPSConnection if scheme == "https" else _PinnedHTTPConnection
        connection = connection_type(host, port, address, remaining)
        try:
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
                    raise FetchError(f"fetch failed: HTTP {status} without a Location, at {current}", current, status)
                current = urljoin(current, location)
                continue
            content_type = (response.getheader("Content-Type") or "").split(";")[0].strip().lower()
            declared = response.getheader("Content-Length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise FetchError(
                    f"fetch failed: {declared} bytes is over the {max_bytes} byte cap, at {current}", current, status
                )
            body = bytearray()
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise FetchError(f"fetch failed: timed out after {timeout_ms} ms at {current}", current, status)
                if connection.sock is not None:
                    connection.sock.settimeout(left)
                chunk = response.read(min(CHUNK, max_bytes + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise FetchError(f"fetch failed: body is over the {max_bytes} byte cap, at {current}", current, status)
            return {"status": status, "contentType": content_type, "bytes": bytes(body), "finalUrl": current}
        except FetchError:
            raise
        except (socket.timeout, TimeoutError):
            raise FetchError(f"fetch failed: timed out after {timeout_ms} ms at {current}", current) from None
        except (OSError, http.client.HTTPException) as error:
            raise FetchError(f"fetch failed: {type(error).__name__}: {error}, at {current}", current) from None
        finally:
            connection.close()
    raise FetchError(f"fetch failed: more than {MAX_REDIRECTS} redirects, last at {current}", current)


def _looks_like_html(data):
    head = data[:512].lstrip().lower()
    return head.startswith(b"<!doctype html") or head.startswith(b"<html")


def fetch_asset(url, path, max_bytes=None, timeout_ms=None, types=ASSET_TYPES):
    """Download an image, PDF or font to path and print its byte count. Raises FetchError when it is not one.

    Only a printed "saved <name>: <n> bytes" line means the file is there. Returns the Path.
    """
    result = fetch(url, max_bytes=max_bytes, timeout_ms=timeout_ms, accept=ASSET_ACCEPT)
    final = result["finalUrl"]
    if result["status"] != 200:
        raise FetchError(f"fetch_asset failed: HTTP {result['status']} from {final}", final, result["status"])
    data = result["bytes"]
    kind = result["contentType"]
    if not data:
        raise FetchError(f"fetch_asset failed: empty body from {final}", final, result["status"])
    if not kind.startswith(tuple(types)) or _looks_like_html(data):
        raise FetchError(
            f"fetch_asset failed: content type {kind or 'missing'} is not an image, PDF or font, from {final}",
            final,
            result["status"],
        )
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    print(f"saved {target.name}: {len(data)} bytes, {kind}, from {final}")
    return target
