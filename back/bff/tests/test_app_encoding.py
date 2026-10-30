"""2026-10-30 (ACR P5): /v1/screens/* and /v1/* encode their answer once (bff.app.encode_body) instead of
jsonable_encoder over the whole answer and then json. The response bytes must stay exactly what
JSONResponse(jsonable_encoder(answer)) sent: for typed values, for keys json cannot take, for the screens of the
golden cases (one per family; GOLDEN_ENCODING_ALL=1 for every case), and through the routes."""
import asyncio
import enum
import json
import os
import unittest
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest import mock
from uuid import UUID

try:
    from fastapi.encoders import jsonable_encoder
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel
    from starlette.datastructures import QueryParams

    from bff import app as bff_app
    from bff import screens
    from bff.hub_stores import hub_auth
    from bff.screens._convert import Exact
    from bff.tests.golden_util import Tape, case_files, load
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_app_encoding)") from exc


def before(answer) -> bytes:
    """What the routes sent before 2026-10-30."""
    return JSONResponse(jsonable_encoder(answer)).body


class Tone(enum.Enum):
    UP = "up"


class Level(enum.IntEnum):
    HIGH = 2


@dataclass
class Point:
    x: float
    day: date


class Row(BaseModel):
    name: str
    at: datetime


ANSWERS = [
    {"a": [1, 2.5, -0.0, 10 ** 20, None, True, False, "한글    \"q\" \\", ""], "t": (1, "x"), "e": Exact(12.4, 12.36),
     "d": Decimal("1.50"), "i": Decimal("7"), "day": date(2026, 10, 5), "u": UUID(int=1), "nested": [{"k": {"n": [Exact(0.1, 0.06)]}}]},
    {"by_day": {date(2026, 10, 5): 3, date(2026, 10, 12): {"x": Decimal("2.25")}}},   # keys json cannot take: two passes
    {1: "int key", 2.5: "float key", False: "bool key", None: "none key"},
    {"enum": Tone.UP, "int_enum": Level.HIGH, "point": Point(1.5, date(2026, 1, 2)), "row": Row(name="kia", at=datetime(2026, 10, 30, 3, 4, tzinfo=timezone.utc)),
     "set": {"only"}, "frozen": frozenset({3})},
    [], {}, "s", 3, 2.0, None, True,
]


class Encoding(unittest.TestCase):
    def test_the_bytes_are_the_two_pass_bytes(self):
        for answer in ANSWERS:
            with self.subTest(answer=repr(answer)[:60]):
                self.assertEqual(bff_app.encode_body(answer), before(answer))

    def test_json_types_never_reach_jsonable_encoder(self):
        calls = []
        real = jsonable_encoder

        def counted(obj, *a, **k):
            calls.append(type(obj).__name__)
            return real(obj, *a, **k)

        answer = {"data": {"rows": [{"n": i, "share": i / 7, "name": f"r{i}"} for i in range(500)], "round": date(2026, 10, 5)}, "meta": {}}
        with mock.patch.object(bff_app, "jsonable_encoder", counted):
            body = bff_app.encode_body(answer)
        self.assertEqual(calls, ["date"])    # one call, for the one value json cannot write
        self.assertEqual(body, before(answer))

    def test_what_json_cannot_write_fails_as_before(self):
        for answer in ({"x": float("nan")}, {"x": [Exact(float("inf"), 1.0)]}):
            with self.assertRaises(ValueError):
                before(answer)
            with self.assertRaises(ValueError):
                bff_app.encode_body(answer)

    def test_the_golden_screens_send_the_same_bytes(self):
        """Real answers: the screens of the golden cases, built from their tapes (one case per family, or every case
        with GOLDEN_ENCODING_ALL=1). No answer carries a key jsonable_encoder would drop ("_sa…")."""
        every = os.environ.get("GOLDEN_ENCODING_ALL") == "1"
        picked, seen = [], set()
        for path in case_files():
            if every or path.parent.name not in seen:
                case = load(path)
                if "screen" in case:
                    picked.append((path, case))
                    seen.add(path.parent.name)
        self.assertTrue(picked)

        async def build(case):
            tape = Tape(case["tape"])
            q = QueryParams([(k, v) for k, vs in case["query"].items() for v in (vs if isinstance(vs, list) else [vs])])
            with mock.patch("bff.api.get", tape.get):
                return await screens.build(case["screen"], q)

        for path, case in picked:
            with self.subTest(case=f"{path.parent.name}/{path.name}"):
                answer = asyncio.run(build(case))
                self.assertEqual(bff_app.encode_body(answer), before(answer))


class Routes(unittest.TestCase):
    """The screen and data routes send encode_body's bytes with the same headers as before."""

    def request(self, path):
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "path": path,
                 "raw_path": path.encode(), "query_string": b"surface=global", "headers": [(b"authorization", b"Bearer t")],
                 "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 5555), "scheme": "http", "root_path": ""}
        out = {"status": None, "headers": None, "body": b""}

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            if message["type"] == "http.response.start":
                out["status"], out["headers"] = message["status"], dict(message["headers"])
            elif message["type"] == "http.response.body":
                out["body"] += message.get("body", b"")

        asyncio.run(bff_app.app(scope, receive, send))
        return out

    def test_screen_and_data_routes(self):
        answer = ANSWERS[0] | {"rows": [{"skey": "kia.com", "round": date(2026, 10, 5), "share": Exact(38.9, 38.94)}]}

        async def principal(*a, **k):
            return hub_auth.Principal(user_id=UUID(int=9), login="admin", email=None, display_name=None, role="admin")

        async def build(path, q):
            return answer

        async def read(path, q):
            return answer

        with mock.patch.object(hub_auth, "principal", principal), mock.patch.object(screens, "build", build), \
                mock.patch.object(bff_app.api, "read", read):
            for path in ("/v1/screens/overview", "/v1/citations/domains"):
                with self.subTest(path=path):
                    out = self.request(path)
                    self.assertEqual(out["status"], 200)
                    self.assertEqual(out["body"], before(answer))
                    self.assertEqual(out["headers"][b"content-type"], b"application/json")
                    self.assertEqual(out["headers"][b"cache-control"], b"no-store")
                    self.assertEqual(out["headers"][b"content-length"], str(len(before(answer))).encode())


if __name__ == "__main__":
    unittest.main()
