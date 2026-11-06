"""What the hub server sends for a signed-in account: the internal token with its scope, for routes tested on the data server alone. Signing in and editing are tested on
the hub server (hub_server/tests)."""
import asyncio
import json
import time

from data_server import app as data_server_app
from shared import internal_token

SECRET = "s" * 40


def token_for(role="admin", brands=(), regions=(), countries=()) -> str:
    scope = {"all": True} if role == "admin" else {"all": False, "brands": list(brands), "regions": list(regions), "countries": list(countries)}
    return internal_token.sign(SECRET.encode(), scope, time.time())


async def call(method, path, body=None, token=None):
    """One request through the data server's FastAPI app (routing, handlers, error envelope)."""
    path, _, query = path.partition("?")
    payload = json.dumps(body).encode() if body is not None else b""
    headers = [(b"content-type", b"application/json")] if payload else []
    if token:
        headers.append((b"authorization", f"Bearer {token}".encode()))
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "path": path,
             "raw_path": path.encode(), "query_string": query.encode(), "headers": headers, "client": ("127.0.0.1", 1),
             "server": ("127.0.0.1", 5555), "scheme": "http", "root_path": ""}
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

    await data_server_app.app(scope, receive, send)
    return out["status"], json.loads(out["body"] or b"null")


def run(coro):
    return asyncio.run(coro)
