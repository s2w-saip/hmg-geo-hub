"""The GA4 property registry (Admin › GA4 연동): the input rules, and the routes end to end through the ASGI app
against an in-memory registry (no database): administrator only, create / edit / stop / resume with their history,
one collected property per market, the collector's last result as it left it, and the stored events offered for
the listed-events basis."""
import json
import os
import unittest
from contextlib import asynccontextmanager
from datetime import date, timedelta
from unittest import mock

try:
    from fastapi import HTTPException

    from bff.hub_stores import ga4_registry as reg
    from bff.hub_stores import hub_auth
    from bff.tests.test_hub_accounts import PASSWORD, Conn, Tables
    from bff.tests.test_hub_editing import SECRET, T0, Pool, call, run
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_hub_ga4_registry)") from exc


# ═══ fakes ═══════════════════════════════════════════════════════════════════════════════════════════════

class Registry:
    """analytics.ga4_registry + ga4_registry_event + ga4_collect_status, answering the SQL constants sent."""

    def __init__(self):
        self.props, self.events, self.status, self.stored, self.clock, self.locks = {}, [], {}, {}, 0, 0

    def tick(self):
        self.clock += 1
        return T0 + timedelta(seconds=self.clock)

    def row(self, pid):
        if pid not in self.props:
            return None
        s = self.status.get(pid) or {}
        return {"property_id": pid, **self.props[pid], "status": s.get("status"), "checked_at": s.get("checked_at"),
                "error": s.get("error"), "collected_at": s.get("collected_at"), "collected_to": s.get("collected_to")}


class RegistryConn:
    def __init__(self, r):
        self.r = r

    def transaction(self):
        from bff.tests.test_hub_editing import Ctx
        return Ctx()

    async def fetchrow(self, sql, pid):
        assert sql is reg.ONE_SQL, sql
        return self.r.row(pid)

    async def fetch(self, sql, *args):
        r = self.r
        if sql is reg.LIST_SQL:
            return sorted((r.row(p) for p in r.props), key=lambda x: (x["brand"], x["country"], x["property_id"]))
        if sql is reg.HISTORY_SQL:
            return list(reversed([e for e in r.events if e["property_id"] == args[0]]))
        if sql is reg.EVENTS_SQL:
            pid, days = args
            self.r.asked_days = days
            return r.stored.get(pid, [])
        raise AssertionError(sql)

    async def fetchval(self, sql, *args):
        r = self.r
        if sql is reg.TAKEN_SQL:
            return 1 if args[0] in r.props else None
        if sql is reg.MARKET_SQL:
            brand, country, pid = args
            return next((p for p, v in r.props.items() if v["brand"] == brand and v["country"] == country and v["enabled"] and p != pid), None)
        raise AssertionError(sql)

    async def execute(self, sql, *args):
        r = self.r
        if sql is reg.LOCK_SQL:
            r.locks += 1
        elif sql is reg.INSERT_SQL:
            pid, brand, country, basis, events = args
            at = r.tick()
            r.props[pid] = {"brand": brand, "country": country, "conv_basis": basis, "conv_events": events, "enabled": True,
                            "created_at": at, "updated_at": at}
        elif sql is reg.UPDATE_SQL:
            pid, brand, country, basis, events = args
            r.props[pid].update(brand=brand, country=country, conv_basis=basis, conv_events=events, updated_at=r.tick())
        elif sql is reg.ENABLED_SQL:
            r.props[args[0]].update(enabled=args[1], updated_at=r.tick())
        elif sql is reg.EVENT_SQL:
            pid, action, actor, changes = args
            r.events.append({"event_id": len(r.events) + 1, "property_id": pid, "action": action, "actor_id": actor,
                             "changes": json.loads(changes), "occurred_at": r.tick()})
        else:
            raise AssertionError(sql)


def body_of(**kw):
    return {"propertyId": "469542848", "brand": "Kia", "country": "IT", "basis": "key_events", "events": [], **kw}


# ═══ rules ═══════════════════════════════════════════════════════════════════════════════════════════════

class Rules(unittest.TestCase):
    def fields(self, **kw):
        return reg.fields_of(reg.PropertyFields(**{"brand": "Kia", "country": "IT", "basis": "key_events", **kw}))

    def refused(self, **kw):
        with self.assertRaises(HTTPException) as caught:
            self.fields(**kw)
        return caught.exception.detail["details"]["fields"]

    def test_the_collectors_registry_rules(self):
        self.assertEqual(self.fields(brand=" kia ", country="it"), ("Kia", "IT", 1, []))
        self.assertEqual(self.fields(basis="events", events=["generate_lead", " test_drive ", "generate_lead", ""]),
                         ("Kia", "IT", 2, ["generate_lead", "test_drive"]))
        # events are kept with the listed-events basis only
        self.assertEqual(self.fields(events=["generate_lead"])[3], [])
        self.assertEqual(self.refused(brand="HMG"), ["brand"])
        self.assertEqual(self.refused(country="ITA"), ["country"])
        self.assertEqual(self.refused(basis="sessions"), ["basis"])
        self.assertEqual(self.refused(basis="events"), ["events"])
        for name in ("1st_visit", "test drive", "a" * 41, "lead-form", "_x"):
            self.assertEqual(self.refused(basis="events", events=[name]), ["events"], name)
        self.assertEqual(self.fields(basis="events", events=["문의_완료", "a" * 40])[3], ["문의_완료", "a" * 40])

    def test_property_ids_are_numbers(self):
        self.assertEqual(reg.property_of(" 469542848 "), "469542848")
        for bad in ("properties/469542848", "G-ABC123", "", "1" * 21):
            with self.subTest(bad), self.assertRaises(HTTPException):
                reg.property_of(bad)


# ═══ routes ══════════════════════════════════════════════════════════════════════════════════════════════

class Routes(unittest.TestCase):
    def setUp(self):
        self.t, self.r = Tables(), Registry()
        self.admin = self.t.add("admin@hub")
        t, r = self.t, self.r

        @asynccontextmanager
        async def accounts():
            yield Conn(t)

        @asynccontextmanager
        async def data():
            yield RegistryConn(r)

        async def actors(ids):
            return {i: {"login": t.accounts[u]["subject"], "displayName": t.accounts[u]["display_name"]}
                    for u in t.accounts for i in ids if str(u) == i}

        hub_auth.limiter.failures.clear()
        for p in (mock.patch.dict(os.environ, {"HGH_AUTH_SECRET": SECRET}),
                  mock.patch.object(hub_auth.operations_db, "connection", accounts),
                  mock.patch.object(reg.analytics_db, "connection", data),
                  mock.patch.object(reg, "actors", actors),
                  mock.patch.object(reg, "_pool", Pool(RegistryConn(r)))):
            p.start()
            self.addCleanup(p.stop)
        self.token = self.sign_in("admin@hub")

    def sign_in(self, login):
        status, body = run(call("POST", "/v1/auth/login", {"login": login, "password": PASSWORD}))
        self.assertEqual(status, 200, body)
        return body["data"]["token"]

    def call(self, method, path, body=None):
        return run(call(method, path, body, self.token))

    def create(self, **kw):
        return self.call("POST", "/v1/hub/ga4-properties", body_of(**kw))

    def test_the_registry_is_the_administrators(self):
        self.t.add("hq", "hq", ["Kia"])
        hq = self.sign_in("hq")
        for method, path, body in (("GET", "/v1/hub/ga4-properties", None), ("POST", "/v1/hub/ga4-properties", body_of()),
                                   ("GET", "/v1/hub/ga4-properties/1", None), ("GET", "/v1/hub/ga4-properties/1/events", None),
                                   ("PUT", "/v1/hub/ga4-properties/1", {**body_of(), "expectedVersion": "x"}),
                                   ("POST", "/v1/hub/ga4-properties/1/stop", None)):
            self.assertEqual(run(call(method, path, body))[0], 401, (method, path))
            status, out = run(call(method, path, body, hq))
            self.assertEqual((status, out["error"]["code"]), (403, "forbidden"), (method, path))
        self.assertEqual(self.r.props, {})

    def test_create_registers_a_property_not_yet_collected(self):
        status, out = self.create(country="it")
        self.assertEqual(status, 201, out)
        item = out["data"]["item"]
        self.assertEqual((item["propertyId"], item["brand"], item["country"], item["basis"], item["events"], item["enabled"]),
                         ("469542848", "Kia", "IT", "key_events", [], True))
        self.assertEqual(item["collection"], {"status": None, "checkedAt": None, "error": None, "collectedAt": None,
                                              "collectedTo": None, "pending": True})
        self.assertEqual(out["meta"]["database"], "hmg_analytics")
        self.assertEqual(self.r.locks, 1)
        event = self.r.events[-1]
        self.assertEqual((event["action"], event["actor_id"], event["changes"]),
                         ("create", self.admin, {"brand": [None, "Kia"], "country": [None, "IT"], "basis": [None, "key_events"]}))
        self.assertEqual(self.create(brand="Hyundai")[1]["error"]["code"], "property_taken")
        status, out = self.create(propertyId="1000")
        self.assertEqual((status, out["error"]["code"], out["error"]["details"]), (409, "market_taken", {"fields": ["brand", "country"], "propertyId": "469542848"}))

    def test_bad_bodies_name_their_fields(self):
        for body, field in ((body_of(propertyId="G-1"), "propertyId"), (body_of(brand="Toyota"), "brand"),
                            (body_of(basis="events"), "events"), (body_of(basis="events", events=["has space"]), "events")):
            status, out = self.call("POST", "/v1/hub/ga4-properties", body)
            self.assertEqual((status, out["error"]["code"], out["error"]["details"]["fields"]), (422, "invalid_value", [field]), body)
        status, out = self.call("POST", "/v1/hub/ga4-properties", {**body_of(), "status": "active"})
        self.assertEqual((status, out["error"]["code"]), (422, "invalid_value"))
        self.assertEqual(self.r.props, {})

    def test_edit_changes_the_basis_and_records_what_changed(self):
        item = self.create()[1]["data"]["item"]
        edit = {"brand": "Kia", "country": "IT", "basis": "events", "events": ["generate_lead"], "expectedVersion": item["version"]}
        status, out = self.call("PUT", "/v1/hub/ga4-properties/469542848", edit)
        self.assertEqual(status, 200, out)
        self.assertEqual((out["data"]["item"]["basis"], out["data"]["item"]["events"]), ("events", ["generate_lead"]))
        self.assertEqual(self.r.events[-1]["changes"], {"basis": ["key_events", "events"], "events": [[], ["generate_lead"]]})
        # the version it was opened at is gone: another edit is refused, not merged
        status, out = self.call("PUT", "/v1/hub/ga4-properties/469542848", edit)
        self.assertEqual((status, out["error"]["code"]), (409, "version_conflict"))
        # nothing changed: no history row
        same = {**edit, "expectedVersion": out_version(self)}
        n = len(self.r.events)
        self.assertEqual(self.call("PUT", "/v1/hub/ga4-properties/469542848", same)[0], 200)
        self.assertEqual(len(self.r.events), n)
        status, out = self.call("PUT", "/v1/hub/ga4-properties/1", same)
        self.assertEqual((status, out["error"]["code"]), (404, "not_found"))

    def test_a_market_has_one_collected_property(self):
        self.create()
        other = self.create(propertyId="1000", country="FR")[1]["data"]["item"]
        moved = {"brand": "Kia", "country": "IT", "basis": "key_events", "events": [], "expectedVersion": other["version"]}
        status, out = self.call("PUT", "/v1/hub/ga4-properties/1000", moved)
        self.assertEqual((status, out["error"]["code"]), (409, "market_taken"))
        # a stopped property frees its market, and takes it back only while it is free
        status, out = self.call("POST", "/v1/hub/ga4-properties/469542848/stop")
        self.assertEqual((status, out["data"]["item"]["enabled"]), (200, False))
        self.assertEqual(self.r.events[-1]["changes"], {"enabled": [True, False]})
        self.assertEqual(self.call("PUT", "/v1/hub/ga4-properties/1000", moved)[0], 200)
        status, out = self.call("POST", "/v1/hub/ga4-properties/469542848/resume")
        self.assertEqual((status, out["error"]["code"]), (409, "market_taken"))
        self.assertEqual(self.call("POST", "/v1/hub/ga4-properties/1000/stop")[0], 200)
        status, out = self.call("POST", "/v1/hub/ga4-properties/469542848/resume")
        self.assertEqual((status, out["data"]["item"]["enabled"]), (200, True))
        self.assertEqual([e["action"] for e in self.r.events if e["property_id"] == "469542848"], ["create", "stop", "resume"])
        # stopping twice records once; unknown actions and ids are not routes
        n = len(self.r.events)
        self.call("POST", "/v1/hub/ga4-properties/1000/stop")
        self.assertEqual(len(self.r.events), n)
        self.assertEqual(self.call("POST", "/v1/hub/ga4-properties/1000/delete")[0], 404)
        self.assertEqual(self.call("GET", "/v1/hub/ga4-properties/G-1000")[0], 404)

    def test_the_collectors_last_result_is_shown_as_it_left_it(self):
        self.create()
        updated = self.r.props["469542848"]["updated_at"]
        self.r.status["469542848"] = {"status": "pending_grant", "checked_at": updated + timedelta(milliseconds=1), "error": "GA4 403: no access",
                                      "collected_at": None, "collected_to": None}
        item = self.call("GET", "/v1/hub/ga4-properties")[1]["data"]["items"][0]
        self.assertEqual((item["collection"]["status"], item["collection"]["error"], item["collection"]["pending"]),
                         ("pending_grant", "GA4 403: no access", False))
        # a change after that run is not applied yet
        self.call("POST", "/v1/hub/ga4-properties/469542848/stop")
        detail = self.call("GET", "/v1/hub/ga4-properties/469542848")[1]["data"]
        self.assertTrue(detail["item"]["collection"]["pending"])
        self.assertEqual([(e["action"], e["actor"]["login"]) for e in detail["history"]], [("stop", "admin@hub"), ("create", "admin@hub")])

    def test_the_events_offered_are_the_stored_ones(self):
        self.create()
        self.assertEqual(self.call("GET", "/v1/hub/ga4-properties/469542848/events")[1]["data"], {"days": 90, "to": None, "events": []})
        last = date(2026, 10, 28)
        self.r.stored["469542848"] = [{"name": "page_view", "count": 900, "key_events": 0, "last_day": last},
                                      {"name": "test_drive_request", "count": 12, "key_events": 12, "last_day": last}]
        out = self.call("GET", "/v1/hub/ga4-properties/469542848/events")[1]["data"]
        self.assertEqual((out["days"], out["to"], self.r.asked_days), (90, "2026-10-28", 90))
        self.assertEqual(out["events"], [{"name": "page_view", "count": 900, "keyEvent": False}, {"name": "test_drive_request", "count": 12, "keyEvent": True}])
        self.assertEqual(self.call("GET", "/v1/hub/ga4-properties/1/events")[0], 404)

    def test_unconfigured_editing_is_unavailable(self):
        with mock.patch.object(reg, "_pool", None):
            status, out = self.create()
        self.assertEqual((status, out["error"]["code"]), (503, "source_unavailable"))


def out_version(case: Routes) -> str:
    return case.call("GET", "/v1/hub/ga4-properties/469542848")[1]["data"]["item"]["version"]


if __name__ == "__main__":
    unittest.main()
