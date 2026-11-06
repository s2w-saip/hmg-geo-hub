"""Entity roles (Admin › 엔티티 카탈로그, 2026-11-02): the input rules, how a HUB role and Gold's compare, the routes' gate and
validation through the ASGI app (no database), and — with HGH_ENTITY_ROLE_TEST_DB_URL, a HUB data DB with 010 applied, as a
role that can SET ROLE hmg_entity_role_editor — every write against the real tables inside one transaction that is
rolled back. The Gold reads are faked."""
import asyncio
import datetime
import json
import os
import unittest
import uuid
from contextlib import asynccontextmanager
from unittest import mock

try:
    import asyncpg
    from fastapi import HTTPException

    from data_server.hub_stores import entity_roles as er
    from data_server.hub_stores import operations_db
    from data_server.tests.signed_in import Conn, Tables, sign_in
    from data_server.tests.test_hub_editing import SECRET, call, run
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_hub_entity_roles)") from exc

ID = "11111111-1111-4111-8111-111111111111"


def gold(role=None, brand="BMW", kind=2, name="BMW"):
    return {"registry_role": role, "brand": brand, "kind": kind, "rep_name": name, "entity_type": "Brand",
            "first_seen": datetime.datetime(2026, 7, 3, tzinfo=datetime.timezone.utc), "answers": 9, "mentions": 30}


def hub(role="own", brand="Hyundai", status="active"):
    return {"rep_name": "BMW", "role": role, "brand": brand, "note": None, "status": status, "origin": "hub", "updated_at": None}


class Rules(unittest.TestCase):
    def test_an_entity_is_its_gold_id(self):
        self.assertEqual(str(er.entity_key(ID)), ID)
        for bad in ("", None, "not-a-uuid"):
            with self.assertRaises(HTTPException, msg=bad) as e:
                er.entity_key(bad)
            self.assertEqual(e.exception.detail["details"]["fields"], ["entityId"])

    def test_own_names_its_brand_and_competitor_is_no_stored_role(self):
        self.assertEqual(er.clean_role("own", "Kia"), ("own", "Kia"))
        self.assertEqual(er.clean_role("excluded", None), ("excluded", None))
        for role, brand, field in (("own", None, "brand"), ("own", "Toyota", "brand"), ("excluded", "Kia", "brand"), ("competitor", None, "role")):
            with self.assertRaises(HTTPException) as e:
                er.clean_role(role, brand)
            self.assertEqual(e.exception.detail["details"]["fields"], [field], (role, brand))

    def test_a_role_compares_with_golds_role_and_own_brand(self):
        state = er.state_of
        own = gold("own", "Hyundai", 1)
        self.assertEqual(state(hub(), own), "applied")
        self.assertEqual(state(hub(brand="Kia"), own), "pending")  # the own brand differs
        self.assertEqual(state(hub(), gold()), "pending")
        self.assertEqual(state(hub(), None), "pending")
        self.assertEqual(state(hub("excluded", None), gold("excluded")), "applied")
        self.assertEqual(state(hub("excluded", None), own), "pending")
        self.assertEqual(state(hub(status="cleared"), own), "pending")  # Gold still has a role
        self.assertIsNone(state(hub(status="cleared"), gold()))
        self.assertEqual(state(None, own), "upstream")
        self.assertIsNone(state(None, gold()))
        self.assertIsNone(state(None, None))

    def test_a_row_means_the_hub_role_then_golds_then_the_default(self):
        self.assertEqual(er.row_view(ID, None, gold())["role"], "competitor")
        upstream = er.row_view(ID, None, gold("own", "Hyundai", 1, "현대자동차"))
        self.assertEqual((upstream["role"], upstream["brand"], upstream["hub"], upstream["state"]), ("own", "Hyundai", None, "upstream"))
        active = er.row_view(ID, hub("excluded", None), gold("own", "Hyundai", 1))
        self.assertEqual((active["role"], active["brand"], active["gold"]["role"], active["state"]), ("excluded", None, "own", "pending"))
        cleared = er.row_view(ID, hub(status="cleared"), gold("own", "Hyundai", 1))
        self.assertEqual((cleared["role"], cleared["brand"], cleared["state"]), ("competitor", None, "pending"))

    def test_golds_values_are_passed_as_they_are(self):
        row = er.row_view(ID, None, {**gold(brand="Apple", kind=3, name="Apple Inc"), "answers": 36111, "mentions": 47271})
        self.assertEqual((row["name"], row["displayBrand"], row["kind"], row["answers"], row["mentions"]), ("Apple Inc", "Apple", "nonCompetitor", 36111, 47271))
        self.assertIsNone(er.row_view(ID, None, gold(brand=None, kind=0))["kind"])
        self.assertEqual(er.row_view(ID, hub(), None)["name"], "BMW")  # a role whose entity left Gold stays listed


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

        async def no_gold(key):
            return None

        for p in (mock.patch.dict(os.environ, {"HGH_INTERNAL_TOKEN_SECRET": SECRET}),
                  mock.patch.object(operations_db, "connection", accounts),
                  mock.patch.object(er, "reading", unreachable),
                  mock.patch.object(er, "gold_entity", no_gold),
                  mock.patch.object(er, "_pool", None)):
            p.start()
            self.addCleanup(p.stop)
        status, body = sign_in(self.t, "admin@hub")
        self.assertEqual(status, 200, body)
        self.token = body["data"]["token"]

    def test_the_roles_are_the_administrators(self):
        self.t.add("hq", "hq", ["Kia"])
        status, body = sign_in(self.t, "hq")
        hq = body["data"]["token"]
        for method, path, body in (("GET", "/v1/hub/entity-roles", None), ("GET", f"/v1/hub/entity-roles/history?entity={ID}", None),
                                   ("GET", f"/v1/hub/entity-roles/mentions?entity={ID}", None),
                                   ("POST", "/v1/hub/entity-roles", {"entityId": ID, "role": "excluded"}),
                                   ("POST", "/v1/hub/entity-roles/clear", {"entityId": ID})):
            self.assertEqual(run(call(method, path, body))[0], 401, (method, path))
            status, out = run(call(method, path, body, hq))
            self.assertEqual((status, out["error"]["code"]), (403, "forbidden"), (method, path))

    def test_bad_requests_are_refused_before_the_store(self):
        for path, body, field in (("/v1/hub/entity-roles", {"entityId": "x", "role": "excluded"}, "entityId"),
                                  ("/v1/hub/entity-roles", {"entityId": ID, "role": "competitor"}, "role"),
                                  ("/v1/hub/entity-roles", {"entityId": ID, "role": "own"}, "brand"),
                                  ("/v1/hub/entity-roles", {"entityId": ID, "role": "own", "brand": "Toyota"}, "brand"),
                                  ("/v1/hub/entity-roles", {"entityId": ID, "role": "excluded", "brand": "Kia"}, "brand"),
                                  ("/v1/hub/entity-roles", {"entityId": ID, "role": "excluded", "note": "x" * 501}, "note"),
                                  ("/v1/hub/entity-roles/clear", {"entityId": "x"}, "entityId")):
            status, out = run(call("POST", path, body, self.token))
            self.assertEqual((status, out["error"]["code"], field in out["error"]["details"]["fields"]), (422, "invalid_value", True), (path, body, out))
        self.assertEqual(run(call("GET", "/v1/hub/entity-roles/mentions", None, self.token))[0], 422)

    def test_unconfigured_editing_is_unavailable(self):
        status, out = run(call("POST", "/v1/hub/entity-roles", {"entityId": ID, "role": "excluded"}, self.token))
        self.assertEqual((status, out["error"]["code"]), (503, "source_unavailable"))


DB_URL = os.environ.get("HGH_ENTITY_ROLE_TEST_DB_URL")


@unittest.skipUnless(DB_URL, "HGH_ENTITY_ROLE_TEST_DB_URL (a HUB data DB with 010, as a role that can SET ROLE hmg_entity_role_editor) not set")
class Store(unittest.TestCase):
    """Every write as the entity role editor, in one transaction that is rolled back."""

    def test_writes_history_and_published_lists(self):
        asyncio.run(self.scenario())

    async def scenario(self):
        conn = await asyncpg.connect(DB_URL)
        tx = conn.transaction()
        await tx.start()
        actor = mock.Mock(user_id=None)  # manage.py-like: no account behind the change
        one, two, unknown = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        entities = {one: gold(), two: gold("excluded", "Apple", 3, "Apple")}

        @asynccontextmanager
        async def writing():
            await conn.execute("SET LOCAL ROLE hmg_entity_role_editor")
            await conn.execute("SELECT pg_advisory_xact_lock(617427413)")
            try:
                yield conn
            finally:
                await conn.execute("RESET ROLE")

        @asynccontextmanager
        async def reading():
            yield conn

        async def gold_entity(key):
            return entities.get(str(key))

        async def gold_rows(keys):
            return dict(entities)

        async def no_actors(ids):
            return {}

        patches = [mock.patch.object(er, "writing", writing), mock.patch.object(er, "reading", reading),
                   mock.patch.object(er, "gold_entity", gold_entity), mock.patch.object(er, "gold_rows", gold_rows),
                   mock.patch("data_server.hub_stores.source_lists.actors", no_actors)]
        for p in patches:
            p.start()
        try:
            await self.roles(conn, actor, one, two, unknown)
        finally:
            for p in patches:
                p.stop()
            await tx.rollback()
            await conn.close()

    async def definition(self, conn, key):
        value = await conn.fetchval("SELECT definition FROM catalog.current_reference WHERE family='entity_role' AND item_key=$1", key)
        return json.loads(value) if isinstance(value, str) else value

    async def roles(self, conn, actor, one, two, unknown):
        before = await conn.fetchrow("SELECT version FROM catalog.current_reference_set WHERE family='entity_role'")
        out = await er.set_role(er.RoleSet(entityId=one, role="own", brand="Kia", note=" 메모 "), actor)
        self.assertEqual((out["role"]["name"], out["role"]["role"], out["role"]["brand"], out["role"]["note"], out["role"]["origin"]), ("BMW", "own", "Kia", "메모", "hub"))
        self.assertIsNotNone(out["published"])
        self.assertIsNone((await er.set_role(er.RoleSet(entityId=one, role="own", brand="Kia", note="메모"), actor))["published"])
        definition = await self.definition(conn, one)
        self.assertEqual((definition["role"], definition["brand"], definition["rep_name"], definition["entity_id"]), ("own", "Kia", "BMW", one))
        self.assertNotIn("key", definition)

        changed = await er.set_role(er.RoleSet(entityId=one, role="excluded", note="메모"), actor)
        self.assertEqual((changed["role"]["role"], changed["role"]["brand"]), ("excluded", None))
        listed = {i["entityId"]: i for i in (await er.listing())["items"]}
        self.assertEqual((listed[one]["role"], listed[one]["state"]), ("excluded", "pending"))
        self.assertEqual((listed[two]["role"], listed[two]["state"], listed[two]["hub"]), ("excluded", "upstream", None))

        cleared = await er.clear(er.RoleClear(entityId=one), actor)
        self.assertEqual(cleared["role"]["status"], "cleared")
        self.assertIsNone((await er.clear(er.RoleClear(entityId=one), actor))["published"])
        self.assertIsNone(await self.definition(conn, one))
        again = await er.set_role(er.RoleSet(entityId=one, role="excluded", note="메모"), actor)
        self.assertEqual(again["role"]["status"], "active")

        # a role only Gold has: clearing keeps the HUB's decision as a cleared row, nothing goes out
        upstream = await er.clear(er.RoleClear(entityId=two), actor)
        self.assertEqual((upstream["role"]["status"], upstream["role"]["origin"], upstream["role"]["role"]), ("cleared", "hub", "excluded"))
        self.assertIsNone(upstream["published"])
        self.assertIsNone(await self.definition(conn, two))
        listed = {i["entityId"]: i for i in (await er.listing())["items"]}
        self.assertEqual((listed[two]["role"], listed[two]["state"]), ("competitor", "pending"))

        history = (await er.history(one))["history"]
        self.assertEqual([e["action"] for e in history], ["set", "clear", "set", "set"])
        self.assertEqual(history[0]["changes"], {"status": ["cleared", "active"]})
        self.assertEqual(history[2]["changes"]["brand"], ["Kia", None])
        self.assertEqual(history[3]["changes"]["role"], [None, "own"])
        self.assertTrue((await er.history(None))["history"])
        after = await conn.fetchrow("SELECT version FROM catalog.current_reference_set WHERE family='entity_role'")
        self.assertEqual(after["version"], (before["version"] if before else 0) + 4)
        for run_it, body in ((er.set_role, er.RoleSet(entityId=unknown, role="excluded")), (er.clear, er.RoleClear(entityId=unknown))):
            with self.assertRaises(HTTPException) as e:
                await run_it(body, actor)
            self.assertEqual(e.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
