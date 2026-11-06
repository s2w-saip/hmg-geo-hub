"""Seed keywords and community sources (Admin › 고객 관심 데이터 관리, 2026-11-02): the input rules, how a HUB row and Gold's
rows compare, the routes' gate and validation through the ASGI app (no database), and — with HGH_INTEREST_TEST_DB_URL, a
HUB data DB with 009 applied, as a role that can SET ROLE hmg_interest_editor — every write against the real tables
inside one transaction that is rolled back. The Gold reads are faked."""
import asyncio
import datetime
import json
import os
import unittest
from contextlib import asynccontextmanager
from unittest import mock

try:
    import asyncpg
    from fastapi import HTTPException

    from data_server.hub_stores import hub_auth
    from data_server.hub_stores import interest as it
    from data_server.tests.test_hub_accounts import PASSWORD, Conn, Tables
    from data_server.tests.test_hub_editing import SECRET, call, run
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_hub_interest)") from exc

AT = datetime.datetime(2026, 10, 7, tzinfo=datetime.timezone.utc)
KR, US = {"location_code": 2410, "language_code": "ko"}, {"location_code": 2840, "language_code": "en"}


def seed(term="SUV", location=2410, language="ko", at=AT):
    return {"term": term, "term_norm": term.lower(), "location_code": location, "language_code": language, "observed_at": at}


def hub_keyword(conditions=(KR,), status="active"):
    return {"term": "SUV", "conditions": list(conditions), "source_types": ["google_keyword"], "brands": [], "note": None, "status": status,
            "origin": "hub", "updated_at": None}


class Rules(unittest.TestCase):
    def test_a_keyword_is_what_dataforseo_takes(self):
        self.assertEqual(it.clean_term("  패밀리   SUV "), "패밀리 SUV")
        for bad in ("", "   ", "a,b", "a (b)", "a\nb", "x" * 100):
            with self.assertRaises(HTTPException, msg=bad) as e:
                it.clean_term(bad)
            self.assertEqual(e.exception.detail["details"]["fields"], ["term"])

    def test_conditions_are_one_order_each_once(self):
        c = it.Condition
        self.assertEqual(it.clean_conditions([c(location_code=2840, language_code="en"), c(location_code=2410, language_code="ko"),
                                              c(location_code=2840, language_code="en")]), [KR, US])
        for bad, field in (([], "conditions"), ([c(location_code=12, language_code="ko")], "conditions.0"),
                           ([c(location_code=2410, language_code="Korean")], "conditions.0")):
            with self.assertRaises(HTTPException, msg=bad) as e:
                it.clean_conditions(bad)
            self.assertEqual(e.exception.detail["details"]["fields"], [field])

    def test_sources_and_brands_are_known_values_in_one_order(self):
        self.assertEqual(it.clean_source_types(["community_voc", "google_keyword"]), ["google_keyword", "community_voc"])
        self.assertEqual(it.clean_brands(["Genesis", "Hyundai"]), ["Hyundai", "Genesis"])
        self.assertEqual(it.clean_brands([]), [])
        for fn, bad in ((it.clean_source_types, []), (it.clean_source_types, ["other"]), (it.clean_brands, ["Toyota"])):
            with self.assertRaises(HTTPException):
                fn(bad)

    def test_a_source_key_drops_scheme_www_query_and_the_last_slash(self):
        self.assertEqual(it.source_key(" https://www.Bobaedream.co.kr/List/?a=1#x "), ("https://www.Bobaedream.co.kr/List/?a=1#x", "bobaedream.co.kr/list"))
        self.assertEqual(it.source_key("reddit.com/r/cars/")[1], "reddit.com/r/cars")
        self.assertEqual(it.host_of("reddit.com/r/cars"), "reddit.com")
        for bad in ("", "nodot", "a b.example", "https://nodot/x", ".", "x" * 301 + ".com"):
            with self.assertRaises(HTTPException, msg=bad) as e:
                it.source_key(bad)
            self.assertEqual(e.exception.detail["details"]["fields"], ["url"])

    def test_a_keyword_compares_with_golds_seed_rows(self):
        state = it.keyword_state
        self.assertEqual(state(hub_keyword(), [seed()]), "applied")
        self.assertEqual(state(hub_keyword((KR, US)), [seed()]), "pending")  # one condition is not collected yet
        self.assertEqual(state(hub_keyword(), [seed(location=2840, language="en")]), "pending")
        self.assertEqual(state(hub_keyword(), []), "pending")
        self.assertIsNone(state(hub_keyword(status="stopped"), [seed()]))  # past collections, nothing to compare
        self.assertEqual(state(None, [seed()]), "upstream")
        self.assertIsNone(state(None, []))

    def test_a_row_carries_the_hub_values_and_golds_collections(self):
        row = it.keyword_view("suv", hub_keyword((KR, US)), [seed(), seed(location=2356, language="en", at=AT - datetime.timedelta(days=1))])
        self.assertEqual((row["conditions"], row["collected"], row["state"]), ([KR, US], 1, "pending"))
        self.assertEqual(row["gold"]["observedAt"], AT)
        self.assertEqual([c["location_code"] for c in row["gold"]["conditions"]], [2356, 2410])
        upstream = it.keyword_view("suv", None, [seed(location=2840, language="en"), seed()])
        self.assertEqual((upstream["term"], upstream["conditions"], upstream["collected"], upstream["status"], upstream["state"]),
                         ("SUV", [KR, US], 2, None, "upstream"))

    def test_a_source_compares_with_the_corpus_without_saying_it_was_applied(self):
        g = {"entities": 3, "mentions": 9, "category": "communityForums"}
        self.assertEqual(it.source_state({"status": "active"}, g), "observed")
        self.assertEqual(it.source_state({"status": "stopped"}, g), "observed")
        self.assertEqual(it.source_state({"status": "active"}, None), "unseen")
        self.assertEqual(it.source_state(None, g), "upstream")
        hub = {"url": "reddit.com/r/cars", "channel": "community", "brands": ["Kia"], "note": None, "status": "active", "updated_at": None}
        row = it.source_view("reddit.com/r/cars", hub, g)
        self.assertEqual((row["host"], row["gold"], row["state"]), ("reddit.com", g, "observed"))
        self.assertEqual(it.source_view("arca.live", None, g)["url"], "arca.live")
        self.assertIsNone(it.source_view("arca.live", None, {"entities": 3, "mentions": 9, "category": None})["gold"]["category"])
        self.assertIn("gold.dim_source", it.GOLD_HOSTS_SQL)  # only the exact host: no subdomain takes a parent's category
        self.assertIn("s.skey=d.host", it.GOLD_HOSTS_SQL)


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
                  mock.patch.object(it, "reading", unreachable),
                  mock.patch.object(it, "_pool", None)):
            p.start()
            self.addCleanup(p.stop)
        status, body = run(call("POST", "/v1/auth/login", {"login": "admin@hub", "password": PASSWORD}))
        self.assertEqual(status, 200, body)
        self.token = body["data"]["token"]

    KEYWORD = {"term": "SUV", "conditions": [KR], "sourceTypes": ["google_keyword"]}
    SOURCE = {"url": "arca.live", "channel": "community"}

    def test_the_lists_are_the_administrators(self):
        self.t.add("hq", "hq", ["Kia"])
        status, body = run(call("POST", "/v1/auth/login", {"login": "hq", "password": PASSWORD}))
        hq = body["data"]["token"]
        for method, path, body in (("GET", "/v1/hub/interest-keywords", None), ("GET", "/v1/hub/interest-keywords/history?term=suv", None),
                                   ("POST", "/v1/hub/interest-keywords", self.KEYWORD), ("POST", "/v1/hub/interest-keywords/stop", {"term": "SUV"}),
                                   ("GET", "/v1/hub/interest-sources", None), ("GET", "/v1/hub/interest-sources/history?url=arca.live", None),
                                   ("POST", "/v1/hub/interest-sources", self.SOURCE), ("POST", "/v1/hub/interest-sources/resume", {"url": "arca.live"})):
            self.assertEqual(run(call(method, path, body))[0], 401, (method, path))
            status, out = run(call(method, path, body, hq))
            self.assertEqual((status, out["error"]["code"]), (403, "forbidden"), (method, path))

    def test_bad_requests_are_refused_before_the_store(self):
        for path, body, field in (("/v1/hub/interest-keywords", {**self.KEYWORD, "term": "a,b"}, "term"),
                                  ("/v1/hub/interest-keywords", {**self.KEYWORD, "conditions": []}, "conditions"),
                                  ("/v1/hub/interest-keywords", {**self.KEYWORD, "sourceTypes": []}, "sourceTypes"),
                                  ("/v1/hub/interest-keywords", {**self.KEYWORD, "brands": ["Toyota"]}, "brands"),
                                  ("/v1/hub/interest-keywords", {**self.KEYWORD, "note": "x" * 501}, "note"),
                                  ("/v1/hub/interest-sources", {**self.SOURCE, "url": "nodot"}, "url"),
                                  ("/v1/hub/interest-sources", {**self.SOURCE, "channel": "blog"}, "channel"),
                                  ("/v1/hub/interest-sources", {**self.SOURCE, "brands": ["Toyota"]}, "brands")):
            status, out = run(call("POST", path, body, self.token))
            self.assertEqual((status, out["error"]["code"], field in out["error"]["details"]["fields"]), (422, "invalid_value", True), (path, body, out))
        for path, body in (("/v1/hub/interest-keywords/delete", {"term": "SUV"}), ("/v1/hub/interest-sources/delete", {"url": "arca.live"})):
            self.assertEqual(run(call("POST", path, body, self.token))[0], 404)

    def test_unconfigured_editing_is_unavailable(self):
        for path, body in (("/v1/hub/interest-keywords", self.KEYWORD), ("/v1/hub/interest-sources", self.SOURCE)):
            status, out = run(call("POST", path, body, self.token))
            self.assertEqual((status, out["error"]["code"]), (503, "source_unavailable"))


DB_URL = os.environ.get("HGH_INTEREST_TEST_DB_URL")


@unittest.skipUnless(DB_URL, "HGH_INTEREST_TEST_DB_URL (a HUB data DB with 009, as a role that can SET ROLE hmg_interest_editor) not set")
class Store(unittest.TestCase):
    """Every write as the customer-interest role, in one transaction that is rolled back."""

    def test_writes_history_and_published_lists(self):
        asyncio.run(self.scenario())

    async def scenario(self):
        conn = await asyncpg.connect(DB_URL)
        tx = conn.transaction()
        await tx.start()
        actor = mock.Mock(user_id=None)  # manage.py-like: no account behind the change

        @asynccontextmanager
        async def writing():
            await conn.execute("SET LOCAL ROLE hmg_interest_editor")
            await conn.execute("SELECT pg_advisory_xact_lock(617427413)")
            try:
                yield conn
            finally:
                await conn.execute("RESET ROLE")

        @asynccontextmanager
        async def reading():
            yield conn

        async def gold_seeds():
            return {"zz-interest suv": [seed("ZZ-Interest SUV"), ], "zz-upstream": [seed("ZZ-Upstream", 2840, "en")]}

        async def gold_hosts():
            return {"takenAt": datetime.date(2026, 7, 7), "sources": 606}, {"zz-interest.example": {"entities": 2, "mentions": 8, "category": None}, "zz-corpus.example": {"entities": 1, "mentions": 3, "category": None}}

        async def no_actors(ids):
            return {}

        patches = [mock.patch.object(it, "writing", writing), mock.patch.object(it, "reading", reading),
                   mock.patch.object(it, "gold_seeds", gold_seeds), mock.patch.object(it, "gold_hosts", gold_hosts),
                   mock.patch("data_server.hub_stores.source_lists.actors", no_actors)]
        for p in patches:
            p.start()
        try:
            await self.keywords(conn, actor)
            await self.sources(conn, actor)
        finally:
            for p in patches:
                p.stop()
            await tx.rollback()
            await conn.close()

    async def published(self, conn, family):
        return await conn.fetchrow("SELECT version,item_count FROM catalog.current_reference_set WHERE family=$1", family)

    async def definition(self, conn, family, key):
        value = await conn.fetchval("SELECT definition FROM catalog.current_reference WHERE family=$1 AND item_key=$2", family, key)
        return json.loads(value) if isinstance(value, str) else value

    async def keywords(self, conn, actor):
        before = await self.published(conn, "interest_keyword")
        body = dict(term=" ZZ-Interest  SUV ", conditions=[it.Condition(**KR)], sourceTypes=["google_keyword"], note=" 메모 ")
        out = await it.set_keyword(it.KeywordSet(**body), actor)
        self.assertEqual((out["term"], out["keyword"]["termNorm"], out["keyword"]["origin"], out["keyword"]["note"]),
                         ("ZZ-Interest SUV", "zz-interest suv", "hub", "메모"))
        self.assertIsNotNone(out["published"])
        self.assertIsNone((await it.set_keyword(it.KeywordSet(**body), actor))["published"])
        listed = {i["termNorm"]: i for i in (await it.keywords())["items"]}
        self.assertEqual(listed["zz-interest suv"]["state"], "applied")
        self.assertEqual((listed["zz-upstream"]["state"], listed["zz-upstream"]["status"]), ("upstream", None))

        changed = await it.set_keyword(it.KeywordSet(**{**body, "term": "zz-interest suv", "conditions": [it.Condition(**US), it.Condition(**KR)],
                                                        "sourceTypes": ["community_voc", "google_keyword"], "brands": ["Kia"]}), actor)
        self.assertEqual(changed["term"], "ZZ-Interest SUV")  # the first spelling stays
        self.assertEqual(changed["keyword"]["conditions"], [KR, US])
        definition = await self.definition(conn, "interest_keyword", "zz-interest suv")
        self.assertEqual((definition["term"], definition["conditions"], definition["source_types"], definition["brands"]),
                         ("ZZ-Interest SUV", [KR, US], ["google_keyword", "community_voc"], ["Kia"]))
        self.assertNotIn("key", definition)
        listed = {i["termNorm"]: i for i in (await it.keywords())["items"]}
        self.assertEqual((listed["zz-interest suv"]["state"], listed["zz-interest suv"]["collected"]), ("pending", 1))

        stopped = await it.set_keyword_status(it.KeywordKey(term="ZZ-INTEREST SUV"), True, actor)
        self.assertEqual(stopped["keyword"]["status"], "stopped")
        self.assertIsNone((await it.set_keyword_status(it.KeywordKey(term="ZZ-Interest SUV"), True, actor))["published"])
        self.assertIsNone(await self.definition(conn, "interest_keyword", "zz-interest suv"))
        await it.set_keyword_status(it.KeywordKey(term="ZZ-Interest SUV"), False, actor)
        self.assertIsNotNone(await self.definition(conn, "interest_keyword", "zz-interest suv"))
        history = (await it.keyword_history("ZZ-Interest SUV"))["history"]
        self.assertEqual([e["action"] for e in history], ["resume", "stop", "set", "add"])
        self.assertEqual(history[1]["changes"], {"status": ["active", "stopped"]})
        self.assertEqual(history[2]["changes"]["brands"], [[], ["Kia"]])
        after = await self.published(conn, "interest_keyword")
        self.assertEqual(after["version"], (before["version"] if before else 0) + 4)
        with self.assertRaises(HTTPException) as e:
            await it.set_keyword_status(it.KeywordKey(term="zz-never-added"), True, actor)
        self.assertEqual(e.exception.status_code, 404)

    async def sources(self, conn, actor):
        before = await self.published(conn, "interest_source")
        out = await it.set_source(it.SourceSet(url="https://www.ZZ-Interest.example/Forum/", channel="community", brands=["Kia"], note="메모"), actor)
        self.assertEqual((out["key"], out["source"]["url"], out["source"]["status"]), ("zz-interest.example/forum", "https://www.ZZ-Interest.example/Forum/", "active"))
        self.assertIsNone((await it.set_source(it.SourceSet(url="zz-interest.example/forum", channel="community", brands=["Kia"], note="메모"), actor))["published"])
        listing = await it.sources()
        self.assertEqual(listing["snapshot"], {"takenAt": datetime.date(2026, 7, 7), "sources": 606})  # Gold's own count
        listed = {i["key"]: i for i in listing["items"]}
        # compared by the host; the host of a registered source is no longer an upstream row
        self.assertEqual((listed["zz-interest.example/forum"]["state"], listed["zz-interest.example/forum"]["gold"]["mentions"]), ("observed", 8))
        self.assertNotIn("zz-interest.example", listed)
        self.assertEqual(listed["zz-corpus.example"]["state"], "upstream")

        changed = await it.set_source(it.SourceSet(url="zz-interest.example/forum", channel="news", brands=[]), actor)
        self.assertEqual((changed["source"]["url"], changed["source"]["channel"], changed["source"]["brands"]), ("https://www.ZZ-Interest.example/Forum/", "news", []))
        definition = await self.definition(conn, "interest_source", "zz-interest.example/forum")
        self.assertEqual((definition["url"], definition["channel"], definition["brands"]), ("https://www.ZZ-Interest.example/Forum/", "news", []))

        await it.set_source_status(it.SourceKey(url="zz-interest.example/forum"), True, actor)
        self.assertIsNone(await self.definition(conn, "interest_source", "zz-interest.example/forum"))
        await it.set_source_status(it.SourceKey(url="zz-interest.example/forum"), False, actor)
        history = (await it.source_history("zz-interest.example/forum"))["history"]
        self.assertEqual([e["action"] for e in history], ["resume", "stop", "set", "add"])
        self.assertEqual(history[2]["changes"]["channel"], ["community", "news"])
        after = await self.published(conn, "interest_source")
        self.assertEqual(after["version"], (before["version"] if before else 0) + 4)
        with self.assertRaises(HTTPException) as e:
            await it.set_source_status(it.SourceKey(url="zz-never-added.example"), True, actor)
        self.assertEqual(e.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
