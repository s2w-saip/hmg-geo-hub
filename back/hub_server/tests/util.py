"""The routes end to end through the real FastAPI app, without a database."""
import asyncio
import json
from datetime import UTC, datetime

from hub_server.app import app

SECRET = "s" * 40
T0 = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)


class Ctx:
    def __init__(self, value=None):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *exc):
        return False


class Pool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return Ctx(self.conn)


async def call(method, path, body=None, token=None, raw=None):
    path, _, query = path.partition("?")
    payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
    headers = [(b"content-type", b"application/json")] if payload else []
    if token:
        headers.append((b"authorization", f"Bearer {token}".encode()))
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "path": path,
             "raw_path": path.encode(), "query_string": query.encode(), "headers": headers, "client": ("127.0.0.1", 1),
             "server": ("127.0.0.1", 5556), "scheme": "http", "root_path": ""}
    sent, out = False, {"status": None, "body": b""}

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": payload, "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
        elif message["type"] == "http.response.body":
            out["body"] += message.get("body", b"")

    await app(scope, receive, send)
    return out["status"], json.loads(out["body"] or b"null")


def run(coro):
    return asyncio.run(coro)
