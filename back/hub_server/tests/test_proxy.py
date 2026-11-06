"""The proxy changes nothing on the way: T13 step 1c. The data server is a stub, so these run without any database."""
import os
import time
import unittest
from unittest import mock
from uuid import uuid4

import httpx

from hub_server import auth as hub_auth
from hub_server import proxy
from hub_server.app import app
from shared import internal_token
from shared.account import Principal

BINARY = bytes(range(256)) * 8192   # 2 MB with every byte value: a workbook's shape, none of it text


class Chunks(httpx.AsyncByteStream):
    """An answer as a real connection delivers it: unread, in pieces. httpx.Response(content=...) would come already read."""

    def __init__(self, content: bytes):
        self.content = content

    async def __aiter__(self):
        for i in range(0, len(self.content), 65536):
            yield self.content[i:i + 65536]


def answer(status: int = 200, content: bytes = b"{}", headers: dict | None = None) -> httpx.Response:
    return httpx.Response(status, headers={"content-length": str(len(content)), **(headers or {})}, stream=Chunks(content))


def hub() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://hub")


KEY = "i" * 40
ADMIN = Principal(uuid4(), "admin@hub", None, "Admin", "admin")


class Proxy(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.signed_in = ADMIN
        for p in (mock.patch.dict(os.environ, {"HGH_INTERNAL_TOKEN_SECRET": KEY}),
                  mock.patch.object(hub_auth, "principal", self.who)):
            p.start()
            self.addCleanup(p.stop)

    async def who(self, authorization, **_):
        return self.signed_in

    def use(self, handler) -> None:
        proxy._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(proxy.close_client)

    async def test_the_query_string_goes_on_byte_for_byte(self):
        seen = {}

        def data_server(request: httpx.Request) -> httpx.Response:
            seen["url"] = request.url
            return answer()

        self.use(data_server)
        query = "brand=Kia&brand=Genesis&q=%ED%98%84%EB%8C%80%20a%2Bb%26c&ctx.params=%5B%5B%22surface%22%2C%22global%22%5D%5D&empty=&plus=a+b&tilde=A~B"
        async with hub() as c:
            await c.get(f"/v1/screens/mention/rn-rate-value?{query}")
        self.assertEqual(seen["url"].raw_path, f"/v1/screens/mention/rn-rate-value?{query}".encode())

    async def test_an_encoded_path_stays_encoded(self):
        seen = {}

        def data_server(request: httpx.Request) -> httpx.Response:
            seen["path"] = request.url.raw_path
            return answer()

        self.use(data_server)
        async with hub() as c:
            await c.get("/v1/citations/domains/instagram.com%2Fhyundai")
        self.assertEqual(seen["path"], b"/v1/citations/domains/instagram.com%2Fhyundai")

    async def test_status_and_body_come_back_as_they_are(self):
        for status in (200, 201, 204, 401, 403, 404, 405, 409, 422, 429, 503):
            body = b"" if status == 204 else b'{"error": {"code": "x"}}'

            def data_server(request: httpx.Request, status=status, body=body) -> httpx.Response:
                return answer(status, body, {"content-type": "application/json"})

            self.use(data_server)
            async with hub() as c:
                reply = await c.get("/v1/kpi/summary")
            self.assertEqual((reply.status_code, reply.content), (status, body))

    async def test_a_download_comes_back_byte_for_byte_with_its_headers(self):
        def data_server(request: httpx.Request) -> httpx.Response:
            return answer(200, BINARY, {
                "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "content-disposition": 'attachment; filename="prompts.xlsx"', "cache-control": "no-store", "x-content-type-options": "nosniff"})

        self.use(data_server)
        async with hub() as c:
            reply = await c.get("/v1/screens/website/prompts-export")
        self.assertEqual(reply.content, BINARY)
        self.assertEqual(reply.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.assertEqual(reply.headers["content-disposition"], 'attachment; filename="prompts.xlsx"')
        self.assertEqual(reply.headers["cache-control"], "no-store")
        self.assertEqual(reply.headers["x-content-type-options"], "nosniff")
        self.assertEqual(reply.headers["content-length"], str(len(BINARY)))

    async def test_the_proxy_carries_reads_only(self):
        self.use(lambda request: self.fail("reached the data server"))
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            async with hub() as c:
                reply = await c.request(method, "/v1/hub/something", content=b"{}", headers={"Content-Type": "application/json"})
            self.assertEqual((reply.status_code, reply.json()["error"]["code"]), (405, "read_only"), method)

    async def test_a_method_on_a_read_only_path_is_refused_without_a_session(self):
        self.use(lambda request: self.fail("reached the data server"))
        with mock.patch.object(hub_auth, "principal", side_effect=AssertionError("no account is read for a refused write")):
            async with hub() as c:
                self.assertEqual((await c.post("/v1/kpi/summary")).status_code, 405)

    async def test_the_account_goes_on_in_the_internal_token_and_the_login_token_stops_here(self):
        seen = {}

        def data_server(request: httpx.Request) -> httpx.Response:
            seen["auth"] = request.headers.get("authorization")
            return answer()

        self.use(data_server)
        self.signed_in = Principal(uuid4(), "lee", None, None, "country", ("Kia",), ("kia-north-america",), ("US",))
        async with hub() as c:
            await c.get("/v1/source", headers={"Authorization": "Bearer the-login-token"})
        scheme, _, token = seen["auth"].partition(" ")
        self.assertEqual(scheme, "Bearer")
        self.assertNotIn("the-login-token", seen["auth"])
        self.assertEqual(internal_token.verify(KEY.encode(), token, time.time()), self.signed_in.scope())
        self.assertIsNone(internal_token.verify(KEY.encode(), token, time.time() + internal_token.TTL_S + 1))

    async def test_a_refused_account_never_reaches_the_data_server(self):
        called = []

        def data_server(request: httpx.Request) -> httpx.Response:
            called.append(request.url.path)
            return answer()

        async def nobody(authorization, **_):
            raise hub_auth.unauthorized()

        self.use(data_server)
        with mock.patch.object(hub_auth, "principal", nobody):
            async with hub() as c:
                reply = await c.get("/v1/screens/overview/cards")
        self.assertEqual((reply.status_code, reply.json()["error"]["code"]), (401, "unauthorized"))
        self.assertEqual(called, [])

    async def test_without_a_key_nothing_is_forwarded(self):
        self.use(lambda request: self.fail("reached the data server"))
        with mock.patch.dict(os.environ, {"HGH_INTERNAL_TOKEN_SECRET": "short"}):
            async with hub() as c:
                self.assertEqual((await c.get("/v1/source")).status_code, 503)

    async def test_a_read_sends_no_body_and_only_the_clients_headers(self):
        seen = {}

        def data_server(request: httpx.Request) -> httpx.Response:
            seen.update(body=request.content, headers=dict(request.headers))
            return answer()

        self.use(data_server)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://hub", headers={"user-agent": "next"}) as c:
            await c.get("/v1/source", headers={"Authorization": "Bearer t", "Connection": "keep-alive"})
        self.assertEqual(seen["body"], b"")
        self.assertEqual(seen["headers"]["user-agent"], "next")
        self.assertNotIn("connection", seen["headers"])
        self.assertEqual(seen["headers"]["host"], "127.0.0.1:5555")

    async def test_hop_by_hop_and_the_data_servers_own_headers_stop_here(self):
        def data_server(request: httpx.Request) -> httpx.Response:
            return answer(200, b"{}", {"connection": "close", "server": "uvicorn", "date": "x", "set-cookie": "a=1", "x-request-id": "r"})

        self.use(data_server)
        async with hub() as c:
            reply = await c.get("/v1/source")
        self.assertNotIn("connection", reply.headers)
        self.assertNotIn("server", reply.headers)
        self.assertNotIn("date", reply.headers)
        self.assertEqual(reply.headers["x-request-id"], "r")
        self.assertEqual(reply.headers["set-cookie"], "a=1")

    async def test_a_connection_the_data_server_closed_is_read_again_once(self):
        # uvicorn closes a connection after an unhandled 500 or when idle; a read must not fail for that (seen in the 1f comparison).
        tries = []

        def closes_once(request: httpx.Request) -> httpx.Response:
            tries.append(request.url.path)
            if len(tries) == 1:
                raise httpx.RemoteProtocolError("Server disconnected")
            return answer()

        self.use(closes_once)
        async with hub() as c:
            self.assertEqual((await c.get("/v1/source")).status_code, 200)
        self.assertEqual(len(tries), 2)

        tries.clear()

        def closes_always(request: httpx.Request) -> httpx.Response:
            tries.append(request.url.path)
            raise httpx.RemoteProtocolError("Server disconnected")

        self.use(closes_always)
        async with hub() as c:
            self.assertEqual((await c.get("/v1/source")).status_code, 503)
        self.assertEqual(len(tries), 2)

    async def test_a_data_server_that_does_not_answer_is_an_error_in_the_services_shape(self):
        def unreachable(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        def slow(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("slow")

        for handler, status, code in ((unreachable, 503, "source_unavailable"), (slow, 504, "timeout")):
            self.use(handler)
            async with hub() as c:
                reply = await c.get("/v1/source")
            self.assertEqual(reply.status_code, status)
            self.assertEqual(reply.json()["error"]["code"], code)

    async def test_only_v1_goes_on_and_the_hub_answers_its_own_health(self):
        called = []

        def data_server(request: httpx.Request) -> httpx.Response:
            called.append(request.url.path)
            return answer()

        self.use(data_server)
        async with hub() as c:
            with mock.patch.object(hub_auth.operations_db, "health", mock.AsyncMock(return_value={"ok": True})):
                self.assertEqual((await c.get("/healthz")).json()["service"], "hub_server")
            self.assertEqual((await c.get("/internal")).status_code, 404)
        self.assertEqual(called, [])

    def test_the_data_server_address_comes_from_the_environment(self):
        os.environ["HGH_DATA_SERVER_URL"] = "http://10.0.0.1:8000"
        self.addCleanup(os.environ.pop, "HGH_DATA_SERVER_URL")
        self.assertEqual(str(proxy.data_server_url()), "http://10.0.0.1:8000")


if __name__ == "__main__":
    unittest.main()
