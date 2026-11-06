"""The proxy changes nothing on the way: T13 step 1c. The data server is a stub, so these run without any database."""
import os
import unittest

import httpx

from hub_server import proxy
from hub_server.app import app

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


class Proxy(unittest.IsolatedAsyncioTestCase):
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

    async def test_a_write_keeps_its_method_body_and_token(self):
        seen = {}

        def data_server(request: httpx.Request) -> httpx.Response:
            seen.update(method=request.method, body=request.content, auth=request.headers.get("authorization"), kind=request.headers.get("content-type"))
            return answer(201)

        self.use(data_server)
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            async with hub() as c:
                reply = await c.request(method, "/v1/hub/saved-filters/x", content=b'{"name": "\xed\x95\x9c"}',
                                        headers={"Authorization": "Bearer t", "Content-Type": "application/json"})
            self.assertEqual(reply.status_code, 201)
            self.assertEqual(seen, {"method": method, "body": b'{"name": "\xed\x95\x9c"}', "auth": "Bearer t", "kind": "application/json"})

    async def test_a_read_sends_no_body_and_only_the_clients_headers(self):
        seen = {}

        def data_server(request: httpx.Request) -> httpx.Response:
            seen.update(body=request.content, headers=dict(request.headers))
            return answer()

        self.use(data_server)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://hub", headers={"user-agent": "next"}) as c:
            await c.get("/v1/source", headers={"Authorization": "Bearer t", "Connection": "keep-alive"})
        self.assertEqual(seen["body"], b"")
        self.assertEqual(seen["headers"]["authorization"], "Bearer t")
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
            self.assertEqual((await c.get("/healthz")).json()["service"], "hub_server")
            self.assertEqual((await c.get("/internal")).status_code, 404)
        self.assertEqual(called, [])

    def test_the_data_server_address_comes_from_the_environment(self):
        os.environ["HGH_DATA_SERVER_URL"] = "http://10.0.0.1:8000"
        self.addCleanup(os.environ.pop, "HGH_DATA_SERVER_URL")
        self.assertEqual(str(proxy.data_server_url()), "http://10.0.0.1:8000")


if __name__ == "__main__":
    unittest.main()
