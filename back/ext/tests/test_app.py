"""External API: key handling, database scoping, decoding, paging and limits, through the real ASGI app
against an in-memory ext schema (no database). The views' own scoping is asserted in
back/hub_storage/verify-data.sql against PostgreSQL."""
import asyncio
import hashlib
import json
import unittest
from datetime import UTC, datetime
from unittest import mock
from uuid import UUID, uuid4

try:
    from ext import app as ext
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run with back/ on the path and the API requirements installed (ext.tests.test_app)") from exc

T0 = datetime(2026, 10, 28, 9, 0, tzinfo=UTC)
KEY = "hgh_" + "a" * 32 + "_" + "A" * 43
OTHER = "hgh_" + "b" * 32 + "_" + "B" * 43
CODES = [{"family": "surface", "item_key": str(v), "definition": json.dumps({"value": v, "code": c})}
         for v, c in ((1, "global"), (2, "website"), (3, "project"))] + \
        [{"family": "brand_bit", "item_key": str(b), "definition": json.dumps({"bit": b, "code": c})}
         for b, c in ((1, "hyundai"), (2, "kia"), (4, "genesis"), (16, "hyundai-n"))]


def sha(key):
    return hashlib.sha256(key.encode()).hexdigest()


class Ctx:
    def __init__(self, value=None):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *exc):
        return False


class Store:
    """What the ext views would answer per key hash."""

    def __init__(self):
        self.meta = {sha(KEY): {"client_id": uuid4(), "key_id": UUID("a" * 32), "as_of": T0, "hub_reference": "brand_bit:x,surface:y"}}
        self.codes = list(CODES)
        self.projects, self.prompts = {}, []
        self.sets = {"engine": {"family": "engine", "source": "gold", "item_count": 3, "sha256": "e" * 64, "change_seq": 40}}
        self.items = {"engine": [{"item_key": c, "definition": json.dumps({"code": c, "is_default": c == "chatgpt"})}
                                 for c in ("chatgpt", "deepseek", "gemini")]}
        self.connections, self.hashes, self.readonly = 0, [], []

    def project(self, definition, status="active", seq=10, reset=3):
        pid = uuid4()
        self.projects[pid] = {"project_id": pid, "origin": "gold", "change_seq": seq, "sha256": "p" * 64, "recorded_at": T0,
                              "reset_seq": reset, "definition": json.dumps({**definition, "status": status})}
        return pid

    def prompt(self, project, definition, seq, text="질문", origin="gold"):
        pid = uuid4()
        self.prompts.append({"prompt_id": pid, "project_id": project, "origin": origin, "change_seq": seq, "sha256": f"{seq:064d}",
                             "recorded_at": T0, "text": text, "definition": json.dumps(definition)})
        return pid


class Conn:
    def __init__(self, store):
        self.s, self.hash = store, None

    def transaction(self, readonly=False):
        self.s.readonly.append(readonly)
        return Ctx()

    def valid(self):
        return self.hash in self.s.meta

    async def execute(self, sql, *args):
        assert sql == "SELECT set_config('hgh.key_hash',$1,true)", sql
        self.hash = args[0]
        self.s.hashes.append(args[0])

    async def fetchrow(self, sql, *args):
        if sql is ext.META_SQL:
            return self.s.meta.get(self.hash)
        if sql is ext.PROJECT_SQL:
            return self.s.projects.get(args[0]) if self.valid() else None
        if sql is ext.SET_SQL:
            return self.s.sets.get(args[0]) if self.valid() else None
        raise AssertionError(sql)

    async def fetch(self, sql, *args):
        if not self.valid():
            return []
        if sql is ext.CODES_SQL:
            return self.s.codes
        if sql is ext.PROJECTS_SQL:
            return sorted(self.s.projects.values(), key=lambda r: str(r["project_id"]))[: args[0]]
        if sql is ext.PROMPTS_SQL:
            project, after, limit = args
            return sorted((r for r in self.s.prompts if r["project_id"] == project and r["change_seq"] > after),
                          key=lambda r: r["change_seq"])[:limit]
        if sql is ext.SETS_SQL:
            return list(self.s.sets.values())
        if sql is ext.ITEMS_SQL:
            family, after, limit = args
            return [r for r in self.s.items.get(family, []) if r["item_key"] > after][:limit]
        raise AssertionError(sql)


class Pool:
    def __init__(self, store):
        self.s = store

    def acquire(self):
        self.s.connections += 1
        return Ctx(Conn(self.s))


async def call(method, path, key=None, scheme="Bearer"):
    path, _, query = path.partition("?")
    headers = [(b"authorization", f"{scheme} {key}".encode())] if key else []
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "path": path,
             "raw_path": path.encode(), "query_string": query.encode(), "headers": headers, "client": ("10.0.0.9", 1),
             "server": ("127.0.0.1", 5560), "scheme": "http", "root_path": ""}
    out = {"status": None, "body": b"", "headers": {}}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
            out["headers"] = {k.decode(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            out["body"] += message.get("body", b"")

    await ext.app(scope, receive, send)
    return out["status"], json.loads(out["body"] or b"null"), out["headers"]


def run(coro):
    return asyncio.run(coro)


class ExternalApi(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        for p in (mock.patch.object(ext, "_pool", Pool(self.store)),
                  mock.patch.object(ext, "requests_per_key", ext.Window(100)),
                  mock.patch.object(ext, "failures_per_address", ext.Window(100)),
                  mock.patch.dict(ext.running, clear=True)):
            p.start()
            self.addCleanup(p.stop)

    def get(self, path, key=KEY):
        return run(call("GET", path, key))

    # ── keys and scope ──────────────────────────────────────────────────────────────────────────────────
    def test_a_malformed_or_missing_key_never_reaches_the_database(self):
        for key, scheme in ((None, "Bearer"), ("hgh_short", "Bearer"), (KEY, "Basic"), (KEY + "x", "Bearer")):
            status, body, headers = run(call("GET", "/ext/v1/projects", key, scheme))
            self.assertEqual((status, body["error"]["code"]), (401, "unauthorized"), (key, scheme))
            self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(self.store.connections, 0)

    def test_the_key_hash_scopes_a_read_only_transaction(self):
        status, _, headers = self.get("/ext/v1/projects")
        self.assertEqual(status, 200)
        self.assertEqual(self.store.hashes, [sha(KEY)])       # the key itself is never sent
        self.assertEqual(self.store.readonly, [True])
        self.assertTrue(headers["x-request-id"])

    def test_an_unknown_key_is_401_and_failures_are_limited_per_address(self):
        with mock.patch.object(ext, "failures_per_address", ext.Window(2)):
            self.assertEqual(self.get("/ext/v1/projects", OTHER)[0], 401)
            self.assertEqual(self.get("/ext/v1/projects", "bad")[0], 401)
            status, body, headers = self.get("/ext/v1/projects", OTHER)
        self.assertEqual((status, body["error"]["code"]), (429, "rate_limited"))
        self.assertTrue(int(headers["retry-after"]) >= 1)

    def test_rate_and_concurrency_per_key(self):
        with mock.patch.object(ext, "requests_per_key", ext.Window(1)):
            self.assertEqual(self.get("/ext/v1/reference")[0], 200)
            status, body, headers = self.get("/ext/v1/reference")
        self.assertEqual((status, body["error"]["code"]), (429, "rate_limited"))
        self.assertIn("retry-after", headers)
        ext.running[str(UUID("a" * 32))] = ext.CONCURRENCY
        self.assertEqual(self.get("/ext/v1/reference")[0], 429)

    # ── projects ────────────────────────────────────────────────────────────────────────────────────────
    def test_projects_decode_gold_codes_and_removed_is_a_tombstone(self):
        site = self.store.project({"surface": 2, "site_brand_bit": 17, "country": "KR", "regions": ["KR"], "is_root": False,
                                   "web": {"units": [{"file_seq": 3, "lang_codes": ["ko"], "base": "kia.com/kr", "base_src": "decl"}]}})
        odd = self.store.project({"surface": 9, "site_brand_bit": 34})
        gone = self.store.project({"surface": 3}, status="removed")
        status, body, _ = self.get(f"/ext/v1/projects/{site}")
        self.assertEqual(status, 200, body)
        p = body["data"]
        self.assertEqual((p["surface"], p["site_brands"], p["country"]), ("website", ["hyundai", "hyundai-n"], "KR"))
        self.assertEqual(p["web"]["units"][0]["base"], "kia.com/kr")
        self.assertTrue(body["meta"]["as_of"].startswith("2026-10-28T09:00"))
        odd_view = self.get(f"/ext/v1/projects/{odd}")[1]["data"]
        self.assertEqual(odd_view["surface"], {"code": None, "raw": 9})
        self.assertEqual(odd_view["site_brands"], ["kia", {"code": None, "raw": 32}])
        self.assertEqual(set(self.get(f"/ext/v1/projects/{gone}")[1]["data"]),
                         {"id", "status", "change_seq", "reset_seq", "etag", "recorded_at"})
        listed = {i["id"]: i for i in self.get("/ext/v1/projects")[1]["data"]["items"]}
        self.assertEqual(listed[str(gone)], {"id": str(gone), "status": "removed", "change_seq": 10, "reset_seq": 3,
                                             "etag": listed[str(gone)]["etag"]})
        self.assertEqual(self.get(f"/ext/v1/projects/{uuid4()}")[0], 404)
        self.assertEqual(self.get("/ext/v1/projects/not-a-uuid")[0], 422)

    def test_the_contract_version_and_etags_follow_the_code_tables(self):
        pid = self.store.project({"surface": 1})
        first = self.get(f"/ext/v1/projects/{pid}")[1]
        self.store.meta[sha(KEY)]["hub_reference"] = "brand_bit:changed,surface:y"
        second = self.get(f"/ext/v1/projects/{pid}")[1]
        self.assertNotEqual(first["meta"]["contract_version"], second["meta"]["contract_version"])
        self.assertNotEqual(first["data"]["etag"], second["data"]["etag"])
        self.assertTrue(first["meta"]["contract_version"].startswith("ext-v1+"))

    # ── prompts ─────────────────────────────────────────────────────────────────────────────────────────
    def test_prompts_page_by_change_seq(self):
        pid = self.store.project({"surface": 3})
        for seq in (9, 5, 7):
            self.store.prompt(pid, {"surface": 3, "in_project_catalog": True, "status": "active"}, seq)
        status, body, _ = self.get(f"/ext/v1/projects/{pid}/prompts?limit=2")
        self.assertEqual(status, 200)
        self.assertEqual([i["change_seq"] for i in body["data"]["items"]], [5, 7])
        self.assertEqual((body["meta"]["next_after_seq"], body["meta"]["has_more"]), (7, True))
        body = self.get(f"/ext/v1/projects/{pid}/prompts?after_seq=7&limit=2")[1]
        self.assertEqual(([i["change_seq"] for i in body["data"]["items"]], body["meta"]["has_more"]), ([9], False))
        body = self.get(f"/ext/v1/projects/{pid}/prompts?after_seq=9")[1]
        self.assertEqual((body["data"]["items"], body["meta"]["next_after_seq"]), ([], 9))
        for bad in ("limit=0", "limit=1001", "after_seq=-1", "after_seq=x"):
            self.assertEqual(self.get(f"/ext/v1/projects/{pid}/prompts?{bad}")[0], 422, bad)
        self.assertEqual(self.get(f"/ext/v1/projects/{uuid4()}/prompts")[0], 404)

    def test_prompt_views(self):
        pid = self.store.project({"surface": 1})
        g = self.store.prompt(pid, {"surface": 1, "kind": "acr", "language": "en", "regions": ["US"], "in_root_catalog": False,
                                    "funnel": "구매", "status": "active",
                                    "catalogs": [{"catalog_row_id": "c1", "brand_bit": 6, "kind": "acr", "depth1": "SUV"}]}, 1)
        w = self.store.prompt(pid, {"surface": 2, "web_reg": True, "unit_file_seq": 4, "target_url": "https://kia.com/kr/ev",
                                    "custom_values": {"f1": "EV"}}, 2)
        h = self.store.prompt(pid, {"surface": 1, "status": "active", "funnel": "인지"}, 3, origin="hub")
        a = self.store.prompt(pid, {"surface": 1, "status": "archived"}, 4, text="숨길 문장", origin="hub")
        items = {i["id"]: i for i in self.get(f"/ext/v1/projects/{pid}/prompts")[1]["data"]["items"]}
        self.assertEqual((items[str(g)]["in_catalog"], items[str(g)]["catalogs"][0]["brands"], items[str(g)]["surface"]),
                         (False, ["kia", "genesis"], "global"))
        self.assertEqual((items[str(w)]["in_catalog"], items[str(w)]["target_url"], items[str(w)]["unit_file_seq"],
                          items[str(w)]["custom_values"], items[str(w)]["status"]), (True, "https://kia.com/kr/ev", 4, {"f1": "EV"}, "active"))
        self.assertEqual((items[str(h)]["in_catalog"], items[str(h)]["funnel"]), (True, "인지"))
        self.assertEqual(set(items[str(a)]), {"id", "project_id", "status", "change_seq", "etag", "recorded_at"})
        self.assertNotIn("숨길 문장", json.dumps(items, ensure_ascii=False))

    # ── reference ───────────────────────────────────────────────────────────────────────────────────────
    def test_reference_families_and_items(self):
        body = self.get("/ext/v1/reference")[1]
        self.assertEqual([(f["family"], f["item_count"]) for f in body["data"]["families"]], [("engine", 3)])
        body = self.get("/ext/v1/reference/engine?limit=2")[1]
        self.assertEqual([i["key"] for i in body["data"]["items"]], ["chatgpt", "deepseek"])
        self.assertEqual((body["data"]["items"][0]["is_default"], body["meta"]["next_after_key"], body["meta"]["has_more"]), (True, "deepseek", True))
        body = self.get("/ext/v1/reference/engine?after_key=deepseek")[1]
        self.assertEqual(([i["key"] for i in body["data"]["items"]], body["meta"]["has_more"]), (["gemini"], False))
        self.assertEqual(self.get("/ext/v1/reference/source")[0], 404)    # not approved / unknown

    # ── surface of the app ──────────────────────────────────────────────────────────────────────────────
    def test_get_only_no_docs_and_a_nameless_health(self):
        status, body, _ = run(call("POST", "/ext/v1/projects", KEY))
        self.assertEqual((status, body["error"]["code"]), (405, "method_not_allowed"))
        for path in ("/docs", "/openapi.json", "/redoc", "/v1/screens/x"):
            self.assertEqual(self.get(path)[0], 404, path)

        class Health:
            async def fetchval(self, sql):
                return 1
        with mock.patch.object(Pool, "acquire", lambda self: Ctx(Health())):
            status, body, _ = self.get("/ext/healthz", key=None)
        self.assertEqual((status, body), (200, {"ok": True}))


if __name__ == "__main__":
    unittest.main()
