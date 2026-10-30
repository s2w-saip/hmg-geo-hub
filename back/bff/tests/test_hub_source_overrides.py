"""Source category corrections (Admin › 인용 출처 분류): the key rule, how a HUB correction and Gold's row become one
list row (state applied / pending / upstream), and the routes end to end through the ASGI app against an in-memory
store (no database): administrator only, set / change / revert with their history and the published list, Gold read
before the lock and only for a source Gold has. The Gold reads themselves are faked (gold_list, gold_check)."""
import json
import os
import unittest
from contextlib import asynccontextmanager
from datetime import date, timedelta
from unittest import mock

try:
    from fastapi import HTTPException

    from bff.hub_stores import hub_auth
    from bff.hub_stores import source_overrides as so
    from bff.tests.test_hub_accounts import PASSWORD, Conn, Tables
    from bff.tests.test_hub_editing import SECRET, T0, Ctx, Pool, call, run
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_hub_source_overrides)") from exc


CATEGORIES = [{"slug": s, "name": n, "ord": i} for i, (s, n) in enumerate(
    [("officialHmg", "Official (HMG)"), ("dealerMarketplace", "Dealer & Marketplace"), ("newsMedia", "News & Media"),
     ("wikiReference", "Wiki & Reference"), ("other", "Other")], 1)]


def gold_row(skey, src, slug, citations, *, top=True, owned=0, social=False, domain=None):
    return {"skey": skey, "domain": domain or skey, "is_social": social, "category_src": src, "owned_brand_bit": owned,
            "slug": slug, "citations": citations, "in_top": top}


# ═══ fakes ═══════════════════════════════════════════════════════════════════════════════════════════════

class Store:
    """catalog.source_override + source_override_event + the published family, answering the SQL constants sent."""

    def __init__(self):
        self.rows, self.events, self.sets, self.clock, self.locks, self.seq = {}, [], [], 0, 0, 1000

    def tick(self):
        self.clock += 1
        return T0 + timedelta(seconds=self.clock)

    def published(self):
        return self.sets[-1] if self.sets else None

    def publish(self):
        items = sorted((k, r["category"]) for k, r in self.rows.items() if r["status"] == "active")
        if self.sets and self.sets[-1]["items_list"] == items:
            return None
        self.seq += 1
        self.sets.append({"version": len(self.sets) + 1, "item_count": len(items), "change_seq": self.seq,
                          "recorded_at": self.tick(), "items_list": items})
        return {"set_version": len(self.sets), "set_change_seq": self.seq}


class StoreConn:
    def __init__(self, s):
        self.s = s

    def transaction(self):
        return Ctx()

    async def fetch(self, sql, *args):
        s = self.s
        if sql is so.HUB_ROWS_SQL:
            return [{"skey": k, **r} for k, r in s.rows.items()]
        if sql is so.HISTORY_SQL:
            return [e for e in reversed(s.events) if e["skey"] == args[0]][: args[1]]
        if sql is so.RECENT_SQL:
            return list(reversed(s.events))[: args[0]]
        raise AssertionError(sql)

    async def fetchrow(self, sql, *args):
        s = self.s
        if sql is so.ONE_SQL:
            r = s.rows.get(args[0])
            return {"skey": args[0], **r} if r else None
        if sql is so.PUBLISHED_SQL:
            return s.published()
        if sql is so.PUBLISH_SQL:
            return s.publish()
        raise AssertionError(sql)

    async def execute(self, sql, *args):
        s = self.s
        if sql.startswith("SET LOCAL lock_timeout"):
            return
        if sql is so.LOCK_SQL:
            assert args == (617427413,)
            s.locks += 1
        elif sql is so.INSERT_SQL:
            key, category, actor = args
            at = s.tick()
            s.rows[key] = {"category": category, "note": None, "status": "active", "origin": "hub", "created_at": at,
                           "updated_at": at, "updated_by": actor}
        elif sql is so.SET_SQL:
            key, category, actor = args
            s.rows[key].update(category=category, status="active", updated_at=s.tick(), updated_by=actor)
        elif sql is so.CLEAR_SQL:
            key, actor = args
            s.rows[key].update(status="cleared", updated_at=s.tick(), updated_by=actor)
        elif sql is so.EVENT_SQL:
            key, action, actor, changes, seq = args
            s.events.append({"event_id": len(s.events) + 1, "skey": key, "action": action, "actor_id": actor,
                             "changes": json.loads(changes), "published_seq": seq, "occurred_at": s.tick()})
        else:
            raise AssertionError(sql)


# ═══ rules ═══════════════════════════════════════════════════════════════════════════════════════════════

class Rules(unittest.TestCase):
    def test_keys_are_the_pipelines(self):
        self.assertEqual(so.key_of(" WWW.Danawa.com "), "danawa.com")
        self.assertEqual(so.key_of("facebook.com/Hyundai.Europe"), "facebook.com/hyundai.europe")
        for bad in ("", "x", "nodot", "a b.com", "tab\t.com", "x." * 200):
            with self.subTest(bad), self.assertRaises(HTTPException):
                so.key_of(bad)

    def test_state_compares_the_hub_with_gold(self):
        active = {"status": "active", "category": "newsMedia"}
        cleared = {"status": "cleared", "category": "newsMedia"}
        self.assertEqual(so.state_of(active, gold_row("x.com", 1, "newsMedia", 1)), "applied")
        # Gold applies another category, or none yet, or has no such source: not applied
        self.assertEqual(so.state_of(active, gold_row("x.com", 1, "other", 1)), "pending")
        self.assertEqual(so.state_of(active, gold_row("x.com", 4, "newsMedia", 1)), "pending")
        self.assertEqual(so.state_of(active, None), "pending")
        # a revert is applied once Gold no longer applies a correction
        self.assertEqual(so.state_of(cleared, gold_row("x.com", 1, "newsMedia", 1)), "pending")
        self.assertIsNone(so.state_of(cleared, gold_row("x.com", 5, "blogsReviews", 1)))
        self.assertEqual(so.state_of(None, gold_row("x.com", 1, "newsMedia", 1)), "upstream")
        self.assertIsNone(so.state_of(None, gold_row("x.com", 6, "other", 1)))

    def test_a_row_keeps_golds_values_next_to_the_hubs(self):
        hub = {"category": "newsMedia", "note": None, "status": "active", "origin": "hub", "created_at": T0, "updated_at": T0}
        row = so.row_view("kia.com", hub, gold_row("kia.com", 3, "officialHmg", 70, owned=2))
        self.assertEqual((row["category"], row["source"], row["gold"], row["state"], row["shadowsOwned"]),
                         ("newsMedia", "override", {"category": "officialHmg", "source": "owned"}, "pending", True))
        plain = so.row_view("x.com", None, gold_row("x.com", 4, "newsMedia", 5, owned=0))
        self.assertEqual((plain["category"], plain["source"], plain["override"], plain["state"], plain["shadowsOwned"]),
                         ("newsMedia", "seed", None, None, False))
        # a cleared correction shows Gold's own category and layer again
        row = so.row_view("x.com", {**hub, "status": "cleared"}, gold_row("x.com", 1, "newsMedia", 5))
        self.assertEqual((row["category"], row["source"], row["state"]), ("newsMedia", "override", "pending"))
        social = so.row_view("instagram.com/hyundai", None, gold_row("instagram.com/hyundai", 2, "officialHmg", 3, social=True, domain="instagram.com"))
        self.assertEqual((social["skey"], social["domain"], social["isSocial"], social["source"]),
                         ("instagram.com/hyundai", "instagram.com", True, "social"))


# ═══ routes ══════════════════════════════════════════════════════════════════════════════════════════════

class Routes(unittest.TestCase):
    def setUp(self):
        self.t, self.s = Tables(), Store()
        self.admin = self.t.add("admin@hub")
        self.gold = [gold_row("kia.com", 3, "officialHmg", 900, owned=2), gold_row("danawa.com", 1, "dealerMarketplace", 191),
                     gold_row("blog.example", 6, "other", 40), gold_row("Instagram.com/Hyundai", 2, "officialHmg", 0, top=False, social=True, domain="instagram.com"),
                     gold_row("upstream.example", 1, "newsMedia", 0, top=False)]
        self.gold_calls, self.asked_keys = [], []
        t, s = self.t, self.s

        @asynccontextmanager
        async def accounts():
            yield Conn(t)

        @asynccontextmanager
        async def data():
            yield StoreConn(s)

        async def actors(ids):
            return {i: {"login": t.accounts[u]["subject"], "displayName": t.accounts[u]["display_name"]}
                    for u in t.accounts for i in ids if str(u) == i}

        async def gold_list(keys):
            self.asked_keys.append(keys)
            # Gold picks the HUB's keys and its own corrections whatever their count (GOLD_ROWS_SQL)
            rows = [r for r in self.gold if r["in_top"] or r["category_src"] == 1 or so.key_of_gold(r["skey"]) in keys]
            return {"asOf": date(2026, 10, 27), "categories": CATEGORIES, "rows": rows}

        async def gold_check(key, category):
            self.gold_calls.append((key, category, s.locks))
            if category is not None and category not in {c["slug"] for c in CATEGORIES}:
                raise so.invalid("The category is one of Gold's source categories", "category")
            return next((r for r in self.gold if so.key_of_gold(r["skey"]) == key), None)

        hub_auth.limiter.failures.clear()
        for p in (mock.patch.dict(os.environ, {"HGH_AUTH_SECRET": SECRET}),
                  mock.patch.object(hub_auth.operations_db, "connection", accounts),
                  mock.patch.object(so.analytics_db, "connection", data),
                  mock.patch.object(so, "actors", actors),
                  mock.patch.object(so, "gold_list", gold_list),
                  mock.patch.object(so, "gold_check", gold_check),
                  mock.patch.object(so, "_pool", Pool(StoreConn(s)))):
            p.start()
            self.addCleanup(p.stop)
        self.token = self.sign_in("admin@hub")

    def sign_in(self, login):
        status, body = run(call("POST", "/v1/auth/login", {"login": login, "password": PASSWORD}))
        self.assertEqual(status, 200, body)
        return body["data"]["token"]

    def call(self, method, path, body=None):
        return run(call(method, path, body, self.token))

    def listing(self):
        status, out = self.call("GET", "/v1/hub/source-overrides")
        self.assertEqual(status, 200, out)
        return out["data"], {i["key"]: i for i in out["data"]["items"]}

    def test_the_corrections_are_the_administrators(self):
        self.t.add("hq", "hq", ["Kia"])
        hq = self.sign_in("hq")
        for method, path, body in (("GET", "/v1/hub/source-overrides", None), ("GET", "/v1/hub/source-overrides/history?skey=kia.com", None),
                                   ("POST", "/v1/hub/source-overrides", {"skey": "kia.com", "category": "newsMedia"}),
                                   ("POST", "/v1/hub/source-overrides/clear", {"skey": "kia.com"})):
            self.assertEqual(run(call(method, path, body))[0], 401, (method, path))
            status, out = run(call(method, path, body, hq))
            self.assertEqual((status, out["error"]["code"]), (403, "forbidden"), (method, path))
        self.assertEqual((self.s.rows, self.gold_calls), ({}, []))

    def test_the_list_is_golds_round_with_the_hubs_corrections(self):
        data, rows = self.listing()
        self.assertEqual((data["asOf"], data["limit"], data["published"], [c["slug"] for c in data["categories"]][:2]),
                         ("2026-10-27", 500, None, ["officialHmg", "dealerMarketplace"]))
        # top sources by citations, then every source Gold corrects (upstream: the HUB does not have it yet)
        self.assertEqual([i["key"] for i in data["items"]], ["kia.com", "danawa.com", "blog.example", "upstream.example"])
        self.assertEqual((rows["danawa.com"]["source"], rows["danawa.com"]["state"]), ("override", "upstream"))
        self.assertEqual((rows["blog.example"]["category"], rows["blog.example"]["source"], rows["blog.example"]["state"]),
                         ("other", "fallback", None))
        self.assertEqual(self.asked_keys, [[]])

    def test_a_correction_is_pending_until_gold_applies_it(self):
        status, out = self.call("POST", "/v1/hub/source-overrides", {"skey": " WWW.Blog.Example ", "category": "newsMedia"})
        self.assertEqual(status, 200, out)
        data = out["data"]
        self.assertEqual((data["skey"], data["override"]["category"], data["override"]["status"], data["override"]["origin"]),
                         ("blog.example", "newsMedia", "active", "hub"))
        self.assertEqual(data["published"], {"version": 1, "changeSeq": 1001})
        # Gold was read before the lock, never under it; the write took the catalog lock once
        self.assertEqual((self.gold_calls, self.s.locks), ([("blog.example", "newsMedia", 0)], 1))
        event = self.s.events[-1]
        self.assertEqual((event["action"], event["actor_id"], event["changes"], event["published_seq"]),
                         ("set", self.admin, {"category": [None, "newsMedia"], "status": [None, "active"]}, 1001))
        _, rows = self.listing()
        row = rows["blog.example"]
        self.assertEqual((row["category"], row["source"], row["state"], row["gold"]),
                         ("newsMedia", "override", "pending", {"category": "other", "source": "fallback"}))
        self.assertEqual(self.asked_keys[-1], ["blog.example"])
        # Gold applies it after the pipeline reads the list: applied
        self.gold[2].update(category_src=1, slug="newsMedia")
        self.assertEqual(self.listing()[1]["blog.example"]["state"], "applied")

    def test_the_same_category_changes_nothing_and_a_change_is_recorded(self):
        self.call("POST", "/v1/hub/source-overrides", {"skey": "kia.com", "category": "newsMedia"})
        n, sets = len(self.s.events), len(self.s.sets)
        status, out = self.call("POST", "/v1/hub/source-overrides", {"skey": "kia.com", "category": "newsMedia"})
        self.assertEqual((status, out["data"]["published"], len(self.s.events), len(self.s.sets)), (200, None, n, sets))
        status, out = self.call("POST", "/v1/hub/source-overrides", {"skey": "kia.com", "category": "wikiReference"})
        self.assertEqual((status, out["data"]["published"]["version"]), (200, 2))
        self.assertEqual(self.s.events[-1]["changes"], {"category": ["newsMedia", "wikiReference"]})
        # an owned source under a correction carries Gold's owned flag
        self.assertTrue(self.listing()[1]["kia.com"]["shadowsOwned"])

    def test_a_revert_keeps_the_row_and_leaves_the_published_list(self):
        self.call("POST", "/v1/hub/source-overrides", {"skey": "blog.example", "category": "newsMedia"})
        status, out = self.call("POST", "/v1/hub/source-overrides/clear", {"skey": "blog.example"})
        self.assertEqual((status, out["data"]["override"]["status"], out["data"]["published"]["version"]), (200, "cleared", 2))
        self.assertEqual(self.s.sets[-1]["items_list"], [])
        self.assertEqual(self.s.events[-1]["changes"], {"status": ["active", "cleared"]})
        # Gold had not applied it: nothing to follow, an ordinary row again
        row = self.listing()[1]["blog.example"]
        self.assertEqual((row["category"], row["source"], row["state"], row["override"]["status"]), ("other", "fallback", None, "cleared"))
        # reverting again records nothing; setting again reactivates the same row
        n = len(self.s.events)
        self.assertEqual(self.call("POST", "/v1/hub/source-overrides/clear", {"skey": "blog.example"})[1]["data"]["published"], None)
        self.assertEqual(len(self.s.events), n)
        self.call("POST", "/v1/hub/source-overrides", {"skey": "blog.example", "category": "wikiReference"})
        self.assertEqual(self.s.events[-1]["changes"], {"category": ["newsMedia", "wikiReference"], "status": ["cleared", "active"]})
        # a revert Gold still applies is pending until Gold follows
        self.s.rows["danawa.com"] = {"category": "dealerMarketplace", "note": None, "status": "cleared", "origin": "gold_import",
                                     "created_at": T0, "updated_at": T0, "updated_by": None}
        self.assertEqual(self.listing()[1]["danawa.com"]["state"], "pending")

    def test_history_names_who_changed_what(self):
        self.call("POST", "/v1/hub/source-overrides", {"skey": "kia.com", "category": "newsMedia"})
        self.call("POST", "/v1/hub/source-overrides/clear", {"skey": "kia.com"})
        status, out = self.call("GET", "/v1/hub/source-overrides/history?skey=KIA.com")
        self.assertEqual(status, 200, out)
        data = out["data"]
        self.assertEqual((data["skey"], data["override"]["status"]), ("kia.com", "cleared"))
        self.assertEqual([(e["action"], e["actor"]["login"], e["publishedSeq"]) for e in data["history"]],
                         [("clear", "admin@hub", 1002), ("set", "admin@hub", 1001)])
        recent = self.call("GET", "/v1/hub/source-overrides/history")[1]["data"]
        self.assertEqual((recent["skey"], len(recent["history"])), (None, 2))
        none = self.call("GET", "/v1/hub/source-overrides/history?skey=blog.example")[1]["data"]
        self.assertEqual((none["override"], none["history"]), (None, []))

    def test_bad_requests_change_nothing(self):
        for body, code, field in (({"skey": "kia.com", "category": "News & Media"}, "invalid_value", "category"),
                                  ({"skey": "nodot", "category": "newsMedia"}, "invalid_value", "skey"),
                                  ({"skey": "kia.com"}, "invalid_value", "category"),
                                  ({"skey": "kia.com", "category": "newsMedia", "note": "x"}, "invalid_value", "note")):
            status, out = self.call("POST", "/v1/hub/source-overrides", body)
            self.assertEqual((status, out["error"]["code"], field in out["error"]["details"]["fields"]), (422, code, True), body)
        status, out = self.call("POST", "/v1/hub/source-overrides", {"skey": "unknown.example", "category": "newsMedia"})
        self.assertEqual((status, out["error"]["code"]), (404, "not_found"))
        status, out = self.call("POST", "/v1/hub/source-overrides/clear", {"skey": "kia.com"})
        self.assertEqual((status, out["error"]["code"]), (404, "not_found"))
        self.assertEqual((self.s.rows, self.s.events, self.s.sets), ({}, [], []))

    def test_unconfigured_editing_is_unavailable(self):
        with mock.patch.object(so, "_pool", None):
            status, out = self.call("POST", "/v1/hub/source-overrides", {"skey": "kia.com", "category": "newsMedia"})
        self.assertEqual((status, out["error"]["code"]), (503, "source_unavailable"))


if __name__ == "__main__":
    unittest.main()
