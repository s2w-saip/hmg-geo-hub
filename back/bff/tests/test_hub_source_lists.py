"""Seeds, official social accounts and the code table (Admin › 인용 출처 분류, 2026-10-30): the key and matcher rules,
how a HUB row and Gold's row compare (applied / pending / shadowed / upstream), the routes' gate and validation through
the ASGI app (no database), and — with HGH_SOURCE_LISTS_TEST_DB_URL, a HUB data DB with 008 applied, as a role that
can SET ROLE hmg_source_override_editor — every write against the real tables inside one transaction that is rolled
back. The Gold reads are faked."""
import asyncio
import json
import os
import unittest
from contextlib import asynccontextmanager
from unittest import mock

try:
    import asyncpg
    from fastapi import HTTPException

    from bff.hub_stores import hub_auth
    from bff.hub_stores import source_lists as sl
    from bff.hub_stores import source_overrides as so
    from bff.tests.test_hub_accounts import PASSWORD, Conn, Tables
    from bff.tests.test_hub_editing import SECRET, call, run
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_hub_source_lists)") from exc


def gold(skey, src, slug=None, citations=0):
    return {"skey": skey, "category_src": src, "slug": slug, "citations": citations}


def hub_seed(category="newsMedia", status="active"):
    return {"category": category, "status": status, "note": None, "origin": "hub", "updated_at": None}


class Rules(unittest.TestCase):
    def test_a_seed_is_a_domain(self):
        self.assertEqual(sl.seed_key("  WWW.Example.COM "), "example.com")
        for bad in ("nodot", "a.example/path", "x", "a b.example"):
            with self.assertRaises(HTTPException, msg=bad) as e:
                sl.seed_key(bad)
            self.assertEqual(e.exception.detail["details"]["fields"], ["skey"])

    def test_an_account_is_a_domain_and_a_path_with_its_case_kept(self):
        self.assertEqual(sl.social_key(" Instagram.com/Hyundai "), ("Instagram.com/Hyundai", "instagram.com/hyundai", "instagram.com"))
        for bad in ("instagram.com", "www.instagram.com/x", "nodot/x", "a.b/"):
            with self.assertRaises(HTTPException, msg=bad):
                sl.social_key(bad)

    def test_matchers_are_lower_case_prefixes_of_the_domain_once(self):
        m = sl.Matcher
        self.assertEqual(sl.clean_matchers("linkedin.com", [m(prefix=" linkedin.com/posts/x_ ", boundary=False)]),
                         [{"prefix": "linkedin.com/posts/x_", "boundary": False}])
        for bad, field in (([m(prefix="facebook.com/x", boundary=True)], "matchers.0.prefix"),
                           ([m(prefix="linkedin.com/X", boundary=True)], "matchers.0.prefix"),
                           ([m(prefix="linkedin.com/", boundary=True)], "matchers.0.prefix"),
                           ([m(prefix="linkedin.com/a", boundary=True), m(prefix="linkedin.com/a", boundary=False)], "matchers.1.prefix")):
            with self.assertRaises(HTTPException) as e:
                sl.clean_matchers("linkedin.com", bad)
            self.assertEqual(e.exception.detail["details"]["fields"], [field])

    def test_names_are_one_line(self):
        self.assertEqual(sl.clean_name("  공식 (HMG) ", "nameKo"), "공식 (HMG)")
        self.assertIsNone(sl.clean_description("   "))
        for bad in ("", "a\nb", "x" * 81):
            with self.assertRaises(HTTPException):
                sl.clean_name(bad, "nameEn")

    def test_a_seed_compares_with_golds_layer(self):
        state = sl.seed_state
        self.assertEqual(state(hub_seed(), gold("a.example", 4, "newsMedia")), "applied")
        self.assertEqual(state(hub_seed(), gold("a.example", 4, "blogsReviews")), "pending")
        self.assertEqual(state(hub_seed(), gold("a.example", 5, "newsMedia")), "pending")
        for higher in (1, 2, 3):  # a correction, an official account or an owned domain decides first
            self.assertEqual(state(hub_seed(), gold("a.example", higher, "dealerMarketplace")), "shadowed")
        self.assertIsNone(state(hub_seed(), None))  # never cited: nothing to compare
        self.assertEqual(state(hub_seed(status="removed"), gold("a.example", 4, "newsMedia")), "pending")
        self.assertIsNone(state(hub_seed(status="removed"), gold("a.example", 5, "newsMedia")))
        self.assertEqual(state(None, gold("a.example", 4, "newsMedia")), "upstream")
        self.assertIsNone(state(None, gold("a.example", 5, "newsMedia")))

    def test_an_account_compares_with_golds_layer(self):
        state, active, stopped = sl.social_state, {"status": "active"}, {"status": "stopped"}
        self.assertEqual((state(active, gold("x.com/a", 2)), state(active, gold("x.com/a", 7)), state(active, None)),
                         ("applied", "pending", None))
        self.assertEqual((state(stopped, gold("x.com/a", 2)), state(stopped, None)), ("pending", None))
        self.assertEqual((state(None, gold("x.com/a", 2)), state(None, gold("x.com/a", 6))), ("upstream", None))

    def test_a_category_is_applied_when_golds_name_and_order_match(self):
        row = {"code": "newsMedia", "number": 5, "name_en": "News & Media", "name_ko": "뉴스·미디어", "ord": 5, "description": None,
               "updated_at": None}
        g = {"newsMedia": {"name": "News & Media", "ord": 5}}
        self.assertEqual(sl.code_row(row, g, compare=True)["state"], "applied")
        self.assertEqual(sl.code_row({**row, "ord": 4}, g, compare=True)["state"], "pending")
        self.assertEqual(sl.code_row(row, {}, compare=True)["gold"], None)
        self.assertNotIn("state", sl.code_row(row))


class Routes(unittest.TestCase):
    """The gate and the request rules, before any store is touched."""

    def setUp(self):
        self.t = Tables()
        self.t.add("admin@hub")
        t = self.t

        @asynccontextmanager
        async def accounts():
            yield Conn(t)

        @asynccontextmanager
        async def unreachable():
            raise AssertionError("the store is not read for a refused request")
            yield

        hub_auth.limiter.failures.clear()
        for p in (mock.patch.dict(os.environ, {"HGH_AUTH_SECRET": SECRET}),
                  mock.patch.object(hub_auth.operations_db, "connection", accounts),
                  mock.patch.object(sl, "reading", unreachable),
                  mock.patch.object(so, "_pool", None)):
            p.start()
            self.addCleanup(p.stop)
        status, body = run(call("POST", "/v1/auth/login", {"login": "admin@hub", "password": PASSWORD}))
        self.assertEqual(status, 200, body)
        self.token = body["data"]["token"]

    def test_the_lists_are_the_administrators(self):
        self.t.add("hq", "hq", ["Kia"])
        status, body = run(call("POST", "/v1/auth/login", {"login": "hq", "password": PASSWORD}))
        hq = body["data"]["token"]
        for method, path, body in (("GET", "/v1/hub/source-seeds", None), ("GET", "/v1/hub/source-seeds/history?skey=a.example", None),
                                   ("POST", "/v1/hub/source-seeds", {"skey": "a.example", "category": "newsMedia"}),
                                   ("POST", "/v1/hub/source-seeds/remove", {"skey": "a.example"}),
                                   ("GET", "/v1/hub/source-socials", None),
                                   ("POST", "/v1/hub/source-socials", {"key": "x.com/a", "matchers": [{"prefix": "x.com/a", "boundary": True}]}),
                                   ("POST", "/v1/hub/source-socials/stop", {"key": "x.com/a"}),
                                   ("GET", "/v1/hub/source-codes", None),
                                   ("POST", "/v1/hub/source-codes", {"kind": "category", "code": "other", "nameEn": "Other", "nameKo": "기타"}),
                                   ("POST", "/v1/hub/source-codes/order", {"codes": ["other"]})):
            self.assertEqual(run(call(method, path, body))[0], 401, (method, path))
            status, out = run(call(method, path, body, hq))
            self.assertEqual((status, out["error"]["code"]), (403, "forbidden"), (method, path))

    def test_bad_requests_are_refused_before_the_store(self):
        for path, body, field in (("/v1/hub/source-seeds", {"skey": "a.example/x", "category": "newsMedia"}, "skey"),
                                  ("/v1/hub/source-seeds", {"skey": "a.example"}, "category"),
                                  ("/v1/hub/source-socials", {"key": "x.com/a", "matchers": []}, "matchers"),
                                  ("/v1/hub/source-socials", {"key": "x.com/a", "matchers": [{"prefix": "y.com/a", "boundary": True}]}, "matchers.0.prefix"),
                                  ("/v1/hub/source-socials", {"key": "x.com", "matchers": [{"prefix": "x.com/a", "boundary": True}]}, "key"),
                                  ("/v1/hub/source-codes", {"kind": "brand", "code": "x", "nameEn": "X", "nameKo": "X"}, "kind"),
                                  ("/v1/hub/source-codes", {"kind": "category", "code": "other", "nameEn": "", "nameKo": "기타"}, "nameEn"),
                                  ("/v1/hub/source-codes/order", {"codes": []}, "codes")):
            status, out = run(call("POST", path, body, self.token))
            self.assertEqual((status, out["error"]["code"], field in out["error"]["details"]["fields"]), (422, "invalid_value", True), (path, body, out))
        status, _ = run(call("POST", "/v1/hub/source-socials/delete", {"key": "x.com/a"}, self.token))
        self.assertEqual(status, 404)

    def test_unconfigured_editing_is_unavailable(self):
        status, out = run(call("POST", "/v1/hub/source-seeds", {"skey": "a.example", "category": "newsMedia"}, self.token))
        self.assertEqual((status, out["error"]["code"]), (503, "source_unavailable"))


DB_URL = os.environ.get("HGH_SOURCE_LISTS_TEST_DB_URL")
GOLD_CATEGORIES = {"newsMedia": {"slug": "newsMedia", "name": "News & Media", "ord": 5},
                   "blogsReviews": {"slug": "blogsReviews", "name": "Blogs & Reviews", "ord": 8}}


@unittest.skipUnless(DB_URL, "HGH_SOURCE_LISTS_TEST_DB_URL (a HUB data DB with 008, as a role that can SET ROLE hmg_source_override_editor) not set")
class Store(unittest.TestCase):
    """Every write as the 인용 출처 분류 role, in one transaction that is rolled back."""

    def test_writes_history_and_published_lists(self):
        asyncio.run(self.scenario())

    async def scenario(self):
        conn = await asyncpg.connect(DB_URL)
        tx = conn.transaction()
        await tx.start()
        actor = mock.Mock(user_id=None)  # manage.py-like: no account behind the change

        @asynccontextmanager
        async def writing():
            await conn.execute("SET LOCAL ROLE hmg_source_override_editor")
            await conn.execute("SELECT pg_advisory_xact_lock(617427413)")
            try:
                yield conn
            finally:
                await conn.execute("RESET ROLE")

        @asynccontextmanager
        async def reading():
            yield conn

        async def gold_sources(layer, keys):
            rows = {"seed-test.example": gold("seed-test.example", 4, "blogsReviews", 7),
                    "x-test.example/acct": gold("x-test.example/Acct", 2, "officialHmg", 3)}
            return "2026-10-05", rows

        async def gold_categories():
            return GOLD_CATEGORIES

        async def no_actors(ids):
            return {}

        patches = [mock.patch.object(sl, "writing", writing), mock.patch.object(sl, "reading", reading),
                   mock.patch.object(sl, "gold_sources", gold_sources), mock.patch.object(sl, "gold_categories", gold_categories),
                   mock.patch.object(sl, "actors", no_actors)]
        for p in patches:
            p.start()
        try:
            await self.seeds(conn, actor)
            await self.socials(conn, actor)
            await self.codes(conn, actor)
        finally:
            for p in patches:
                p.stop()
            await tx.rollback()
            await conn.close()

    async def published(self, conn, family):
        return await conn.fetchrow("SELECT version,item_count FROM catalog.current_reference_set WHERE family=$1", family)

    async def seeds(self, conn, actor):
        before = await self.published(conn, "source_seed")
        out = await sl.set_seed(sl.SeedSet(skey="WWW.Seed-Test.example", category="newsMedia"), actor)
        self.assertEqual((out["skey"], out["seed"]["category"], out["seed"]["origin"]), ("seed-test.example", "newsMedia", "hub"))
        self.assertIsNotNone(out["published"])
        self.assertIsNone((await sl.set_seed(sl.SeedSet(skey="seed-test.example", category="newsMedia"), actor))["published"])
        await sl.set_seed(sl.SeedSet(skey="seed-test.example", category="blogsReviews"), actor)
        listed = {i["skey"]: i for i in (await sl.seeds())["items"]}
        self.assertEqual((listed["seed-test.example"]["state"], listed["seed-test.example"]["gold"]["citations"]), ("applied", 7))
        removed = await sl.remove_seed(sl.SeedKey(skey="seed-test.example"), actor)
        self.assertEqual(removed["seed"]["status"], "removed")
        self.assertIsNone((await sl.remove_seed(sl.SeedKey(skey="seed-test.example"), actor))["published"])
        self.assertFalse(await conn.fetchval("SELECT EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='source_seed' AND item_key='seed-test.example')"))
        restored = await sl.set_seed(sl.SeedSet(skey="seed-test.example", category="blogsReviews"), actor)
        self.assertEqual(restored["seed"]["status"], "active")
        history = (await sl.seed_history("seed-test.example"))["history"]
        self.assertEqual([e["action"] for e in history], ["set", "remove", "set", "add"])
        self.assertEqual(history[0]["changes"], {"status": ["removed", "active"]})
        after = await self.published(conn, "source_seed")
        self.assertEqual(after["version"], (before["version"] if before else 0) + 4)
        with self.assertRaises(HTTPException) as e:
            await sl.set_seed(sl.SeedSet(skey="seed-test.example", category="noSuchCategory"), actor)
        self.assertEqual(e.exception.status_code, 422)
        with self.assertRaises(HTTPException) as e:
            await sl.remove_seed(sl.SeedKey(skey="never-seeded.example"), actor)
        self.assertEqual(e.exception.status_code, 404)

    async def socials(self, conn, actor):
        m = [sl.Matcher(prefix="x-test.example/acct", boundary=True)]
        out = await sl.set_social(sl.SocialSet(key="x-test.example/Acct", matchers=m), actor)
        self.assertEqual((out["key"], out["account"]["accountKey"], out["account"]["status"]), ("x-test.example/Acct", "x-test.example/acct", "active"))
        self.assertIsNone((await sl.set_social(sl.SocialSet(key="X-TEST.example/acct", matchers=m), actor))["published"])
        m2 = m + [sl.Matcher(prefix="x-test.example/posts/acct_", boundary=False)]
        changed = await sl.set_social(sl.SocialSet(key="x-test.example/acct", matchers=m2), actor)
        self.assertEqual((changed["key"], len(changed["account"]["matchers"])), ("x-test.example/Acct", 2))
        listed = {i["accountKey"]: i for i in (await sl.socials())["items"]}
        self.assertEqual(listed["x-test.example/acct"]["state"], "applied")
        stopped = await sl.set_social_status(sl.SocialKey(key="x-test.example/acct"), True, actor)
        self.assertEqual(stopped["account"]["status"], "stopped")
        self.assertFalse(await conn.fetchval("SELECT EXISTS(SELECT 1 FROM catalog.current_reference WHERE family='source_social' AND item_key='x-test.example/acct')"))
        await sl.set_social_status(sl.SocialKey(key="x-test.example/acct"), False, actor)
        definition = await conn.fetchval("SELECT definition FROM catalog.current_reference WHERE family='source_social' AND item_key='x-test.example/acct'")
        definition = json.loads(definition) if isinstance(definition, str) else definition
        self.assertEqual((definition["skey"], definition["category"], len(definition["matchers"])), ("x-test.example/Acct", "officialHmg", 2))
        history = (await sl.social_history("x-test.example/acct"))["history"]
        self.assertEqual([e["action"] for e in history], ["resume", "stop", "set", "add"])

    async def codes(self, conn, actor):
        await conn.execute("""INSERT INTO catalog.source_code(kind,code,number,name_en,name_ko,ord)
            VALUES('category','zzTestA',98,'Test A','시험 A',98),('category','zzTestB',99,'Test B','시험 B',99)""")
        out = await sl.set_code(sl.CodeSet(kind="category", code="zzTestA", nameEn=" Test A2 ", nameKo="시험 A", description="설명"), actor)
        self.assertEqual((out["row"]["nameEn"], out["row"]["description"]), ("Test A2", "설명"))
        self.assertIsNone((await sl.set_code(sl.CodeSet(kind="category", code="zzTestA", nameEn="Test A2", nameKo="시험 A", description="설명"), actor))["published"])
        listing = await sl.codes()
        order = [c["code"] for c in listing["categories"]]
        swapped = order[:-2] + [order[-1], order[-2]]
        moved = await sl.order_codes(sl.CodeOrder(codes=swapped), actor)
        self.assertEqual([c["code"] for c in moved["categories"]], swapped)
        self.assertEqual([c["ord"] for c in moved["categories"]], list(range(1, len(swapped) + 1)))
        with self.assertRaises(HTTPException):
            await sl.order_codes(sl.CodeOrder(codes=swapped[:-1]), actor)
        with self.assertRaises(HTTPException) as e:
            await sl.set_code(sl.CodeSet(kind="layer", code="zzNoSuch", nameEn="X", nameKo="X"), actor)
        self.assertEqual(e.exception.status_code, 404)
        history = (await sl.code_history("category", "zzTestA"))["history"]
        self.assertEqual(history[-1]["action"], "set")
        self.assertEqual(history[-1]["changes"]["name_en"], ["Test A", "Test A2"])


if __name__ == "__main__":
    unittest.main()
