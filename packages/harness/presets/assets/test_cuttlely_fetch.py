"""Tests for the assets fetch helper. Standard library only:

    python3 packages/harness/presets/assets/test_cuttlely_fetch.py
"""

import contextlib
import io
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cuttlely_fetch as net  # noqa: E402

SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>'
SEEN = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body=b"", headers=None, length=True):
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        if length:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        SEEN.append({"path": self.path, "ua": self.headers.get("User-Agent"), "accept": self.headers.get("Accept")})
        port = self.server.server_address[1]
        routes = {
            "/logo.svg": lambda: self._send(200, SVG, {"Content-Type": "image/svg+xml"}),
            "/page": lambda: self._send(200, b"<!doctype html><p>hi</p>", {"Content-Type": "text/html; charset=utf-8"}),
            "/fake-image": lambda: self._send(200, b"<html><p>login</p></html>", {"Content-Type": "image/png"}),
            "/forbidden": lambda: self._send(403, b"no", {"Content-Type": "text/plain"}),
            "/to-logo": lambda: self._send(302, headers={"Location": "/logo.svg"}),
            "/to-named": lambda: self._send(301, headers={"Location": f"http://assets.test:{port}/logo.svg"}),
            "/to-metadata": lambda: self._send(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"}),
            "/to-v6-loopback": lambda: self._send(307, headers={"Location": f"http://v6.test:{port}/logo.svg"}),
            "/to-file": lambda: self._send(302, headers={"Location": "file:///etc/passwd"}),
            "/loop": lambda: self._send(302, headers={"Location": "/loop"}),
            "/big-declared": lambda: self._send(200, b"x" * 5000, {"Content-Type": "image/png"}),
            "/big-undeclared": self._big_undeclared,
            "/slow": self._slow,
            "/trickle-headers": self._trickle_headers,
            "/trickle-body": self._trickle_body,
            "/trickle-chunked": self._trickle_chunked,
        }
        routes.get(self.path, lambda: self._send(404, b"missing"))()

    def _big_undeclared(self):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Connection", "close")
        self.end_headers()
        for _ in range(10):
            self.wfile.write(b"y" * 1000)
        self.close_connection = True

    def _drip(self, data, gap=0.05):
        for index in range(len(data)):
            self.wfile.write(data[index : index + 1])
            self.wfile.flush()
            time.sleep(gap)

    def _trickle_headers(self):
        # Each byte arrives well inside any per-read socket timeout; only an overall deadline stops it.
        self._drip(b"HTTP/1.1 200 OK\r\nContent-Type: image/svg+xml\r\nX-Pad: " + b"a" * 200 + b"\r\n\r\n")

    def _trickle_body(self):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", "400")
        self.end_headers()
        self._drip(b"z" * 400)

    def _trickle_chunked(self):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self._drip(b"190\r\n" + b"c" * 400 + b"\r\n0\r\n\r\n")

    def _slow(self):
        time.sleep(2)
        self._send(200, SVG, {"Content-Type": "image/svg+xml"})


class FetchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.server.handle_error = lambda request, address: None  # a client that stops reading is expected here
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        SEEN.clear()
        self.out = Path(tempfile.mkdtemp(prefix="cuttlely-fetch-"))
        self._blocked = net.blocked_address
        self._resolve = net._resolve
        # The test server is on 127.0.0.1. Only that exact address is let through; every other rule stays.
        net.blocked_address = lambda address: False if str(address) == "127.0.0.1" else self._blocked(address)
        names = {
            "assets.test": ["127.0.0.1"],
            "meta.test": ["169.254.169.254"],
            "v6.test": ["::1"],
            "mixed.test": ["93.184.216.34", "10.0.0.7"],
        }
        net._resolve = lambda host, port: names[host] if host in names else self._resolve(host, port)

    def tearDown(self):
        net.blocked_address = self._blocked
        net._resolve = self._resolve

    def url(self, path, host="127.0.0.1"):
        return f"http://{host}:{self.port}{path}"

    # Address rules
    def test_blocked_address_covers_private_loopback_link_local_and_metadata(self):
        blocked = [
            "169.254.169.254", "127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
            "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
            "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "fd00:ec2::254",
            "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::127.0.0.1",
            "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2002:a9fe:a9fe::1",
        ]
        for address in blocked:
            self.assertTrue(self._blocked(address), address)
        for address in ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]:
            self.assertFalse(self._blocked(address), address)

    def test_metadata_and_private_hosts_are_refused_before_any_connection(self):
        def no_connect(*args, **kwargs):
            raise AssertionError("a refused fetch must not open a connection")

        original = socket.create_connection
        socket.create_connection = no_connect
        try:
            for url in [
                "http://169.254.169.254/latest/meta-data/",
                "http://[::1]/",
                "http://[fd00:ec2::254]/",
                "http://[::ffff:169.254.169.254]/",
                f"http://meta.test:{self.port}/",
                f"http://v6.test:{self.port}/",
                f"http://mixed.test:{self.port}/",
                "http://10.0.0.1/",
            ]:
                with self.assertRaises(net.FetchError, msg=url) as caught:
                    net.fetch(url)
                self.assertIn("private or reserved address", str(caught.exception))
        finally:
            socket.create_connection = original

    def test_only_http_and_https_without_credentials(self):
        for url in ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"]:
            with self.assertRaisesRegex(net.FetchError, "only http and https"):
                net.fetch(url)
        with self.assertRaisesRegex(net.FetchError, "user name or password"):
            net.fetch("http://user:secret@example.com/")

    # Redirects
    def test_redirects_are_followed_one_hop_at_a_time(self):
        result = net.fetch(self.url("/to-logo"))
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["finalUrl"], self.url("/logo.svg"))
        result = net.fetch(self.url("/to-named"))
        self.assertEqual(result["finalUrl"], self.url("/logo.svg", host="assets.test"))
        self.assertEqual([seen["path"] for seen in SEEN], ["/to-logo", "/logo.svg", "/to-named", "/logo.svg"])

    def test_every_redirect_hop_is_checked_again(self):
        with self.assertRaisesRegex(net.FetchError, r"private or reserved address \(169\.254\.169\.254\)"):
            net.fetch(self.url("/to-metadata"))
        with self.assertRaisesRegex(net.FetchError, r"private or reserved address \(::1\)"):
            net.fetch(self.url("/to-v6-loopback"))
        with self.assertRaisesRegex(net.FetchError, "only http and https"):
            net.fetch(self.url("/to-file"))
        with self.assertRaisesRegex(net.FetchError, "more than 5 redirects"):
            net.fetch(self.url("/loop"))
        self.assertEqual(len([seen for seen in SEEN if seen["path"] == "/loop"]), net.MAX_REDIRECTS + 1)

    # Caps
    def test_size_cap_with_and_without_content_length(self):
        with self.assertRaisesRegex(net.FetchError, "5000 bytes is over the 1000 byte cap"):
            net.fetch(self.url("/big-declared"), max_bytes=1000)
        with self.assertRaisesRegex(net.FetchError, "body is over the 1000 byte cap"):
            net.fetch(self.url("/big-undeclared"), max_bytes=1000)
        self.assertEqual(len(net.fetch(self.url("/big-undeclared"), max_bytes=20000)["bytes"]), 10000)

    def test_timeout_cap_is_one_deadline(self):
        started = time.monotonic()
        with self.assertRaisesRegex(net.FetchError, "timed out after 300 ms"):
            net.fetch(self.url("/slow"), timeout_ms=300)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_deadline_holds_against_trickled_headers_body_and_chunks(self):
        for path in ("/trickle-headers", "/trickle-body", "/trickle-chunked"):
            started = time.monotonic()
            with self.assertRaisesRegex(net.FetchError, "timed out after 400 ms"):
                net.fetch(self.url(path), timeout_ms=400)
            self.assertLess(time.monotonic() - started, 1.2, path)

    def test_deadline_covers_name_resolution(self):
        net._resolve = lambda host, port: time.sleep(3) or ["127.0.0.1"]
        started = time.monotonic()
        with self.assertRaisesRegex(net.FetchError, "timed out resolving slow-dns.test"):
            net.fetch("http://slow-dns.test/logo.svg", timeout_ms=300)
        self.assertLess(time.monotonic() - started, 1.2)

    def test_caps_have_safe_defaults_and_ceilings(self):
        self.assertEqual(net._bounded(None, net.DEFAULT_MAX_BYTES, net.MAX_BYTES_LIMIT, "max_bytes"), 10 * 1024 * 1024)
        self.assertEqual(net._bounded(10**12, net.DEFAULT_MAX_BYTES, net.MAX_BYTES_LIMIT, "max_bytes"), net.MAX_BYTES_LIMIT)
        self.assertEqual(net._bounded(None, net.DEFAULT_TIMEOUT_MS, net.MAX_TIMEOUT_MS, "timeout_ms"), 20_000)
        self.assertEqual(net._bounded(10**9, net.DEFAULT_TIMEOUT_MS, net.MAX_TIMEOUT_MS, "timeout_ms"), 60_000)
        for bad in (0, -5):
            with self.assertRaises(ValueError):
                net.fetch(self.url("/logo.svg"), max_bytes=bad)

    # User agent
    def test_browser_like_user_agent_on_this_path_only(self):
        net.fetch(self.url("/to-logo"), accept="image/*")
        self.assertTrue(all(seen["ua"] == net.USER_AGENT for seen in SEEN))
        self.assertTrue(net.USER_AGENT.startswith("Mozilla/5.0"))
        self.assertNotIn("Python-urllib", net.USER_AGENT)
        self.assertEqual(SEEN[0]["accept"], "image/*")
        # Importing the helper does not change Python's own default for urllib.
        opener = urllib.request.build_opener()
        self.assertTrue(dict(opener.addheaders)["User-agent"].startswith("Python-urllib/"))

    # fetch_asset
    def test_fetch_asset_saves_and_prints_the_byte_count(self):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            path = net.fetch_asset(self.url("/to-logo"), self.out / "brand" / "logo.svg")
        self.assertEqual(path.read_bytes(), SVG)
        self.assertEqual(
            printed.getvalue().strip(), f"saved logo.svg: {len(SVG)} bytes, image/svg+xml, from {self.url('/logo.svg')}"
        )

    def test_fetch_asset_failures_name_the_status_and_url_and_write_nothing(self):
        cases = {
            "/forbidden": r"HTTP 403 from http://127\.0\.0\.1:\d+/forbidden$",
            "/page": r"content type text/html is not an image, PDF or font, from http://127\.0\.0\.1:\d+/page$",
            "/fake-image": r"content type image/png is not an image, PDF or font",
        }
        for path, pattern in cases.items():
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed), self.assertRaisesRegex(net.FetchError, pattern) as caught:
                net.fetch_asset(self.url(path), self.out / "x.png")
            self.assertEqual(printed.getvalue(), "")
            self.assertFalse((self.out / "x.png").exists())
        self.assertEqual(caught.exception.status, 200)


if __name__ == "__main__":
    unittest.main()
