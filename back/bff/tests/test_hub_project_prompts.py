"""Project prompts (Project › Prompt, 2026-11-03): the input rules, the history a revision list reads as, the routes' gate and
validation through the ASGI app (no database), and — with HGH_PROJECT_PROMPTS_TEST_DB_URL, a HUB data DB with 012 applied, as a
role that can SET ROLE hmg_project_editor — every write against the real catalog inside one transaction that is rolled back."""
import asyncio
import json
import os
import unittest
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from unittest import mock

try:
    import asyncpg
    from fastapi import HTTPException

    from bff.hub_stores import hub_auth
    from bff.hub_stores import project_prompts as pp
    from bff.tests.test_hub_accounts import PASSWORD, Conn, Tables
    from bff.tests.test_hub_editing import SECRET, call, run
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_hub_project_prompts)") from exc

PID = "35ae7ec0-a80a-4c88-a431-9698470aa94b"
PROMPT = "11111111-1111-4111-8111-111111111111"
AT = datetime(2026, 11, 3, tzinfo=UTC)


def revision(version, text="A", status="active", recorded_by=None, **definition):
    return {"version": version, "text": text, "definition": {"status": status, "kind": "single", **definition},
            "recorded_at": AT, "recorded_by": recorded_by}


class Rules(unittest.TestCase):
    def test_a_manual_add_is_one_prompt_per_line(self):
        self.assertEqual(pp.split_lines(" A \n\nB\r\nA\n  \n"), ["A", "B"])
        for text in ("\n \n", "A\x07B", "x" * (pp.TEXT_MAX + 1)):
            with self.assertRaises(HTTPException, msg=repr(text[:10])) as e:
                pp.split_lines(text)
            self.assertEqual(e.exception.status_code, 422)
        with self.assertRaises(HTTPException):
            pp.split_lines("\n".join(f"p{i}" for i in range(pp.LINES_MAX + 1)))

    def test_a_status_and_a_language_read_as_stored(self):
        self.assertEqual(pp.status_of({}), "active")                  # Gold's revisions before statuses
        self.assertEqual(pp.status_of({"status": "paused"}), "paused")
        self.assertIsNone(pp.language_of({"language": ""}))           # Gold's empty language
        self.assertEqual(pp.language_of({"language": "KO"}), "ko")

    def test_tag_columns_are_in_golds_order_with_the_archived_ones(self):
        fields = pp.fields_of({"custom_fields": [
            {"field_id": "b", "label": "B", "archived": True, "created_at": "2026-09-18 09:12:55+00:00"},
            {"field_id": "a", "label": "A", "archived": False, "created_at": "2026-09-18 09:12:55+00:00"},
            {"field_id": "c", "label": "C", "archived": False, "created_at": "2026-09-01 00:00:00+00:00"}]})
        self.assertEqual([(f["id"], f["archived"]) for f in fields], [("c", False), ("a", False), ("b", True)])
        self.assertEqual(pp.fields_of({}), [])

    def test_the_history_names_each_change(self):
        rows = [revision(1), revision(2, custom_values={"f": "AI"}, recorded_by=uuid.uuid4()),
                revision(3, status="paused", custom_values={"f": "AI"}), revision(4, status="active", custom_values={"f": "EV"}),
                revision(5, status="archived", custom_values={"f": "EV"}), revision(6, status="active", custom_values={"f": "EV"}),
                revision(7, text="B", status="active", custom_values={"f": "EV"}, in_project_catalog=True)]
        events = pp.history(rows)
        self.assertEqual([e["event"] for e in events], ["updated", "restored", "archived", "resumed", "paused", "updated", "created"])
        self.assertEqual(events[0]["changes"], {"text": {"old": "A", "new": "B"}})
        self.assertEqual(events[3]["changes"], {"tag:f": {"old": "AI", "new": "EV"}})
        self.assertEqual(events[5]["changes"], {"tag:f": {"old": None, "new": "AI"}})
        self.assertIsNotNone(events[5]["recordedBy"])
        gold_only = pp.history([revision(1), revision(2, in_project_catalog=False)])
        self.assertEqual((gold_only[0]["event"], gold_only[0]["changes"]), ("updated", {}))  # Gold's own keys list no change

    def test_a_restore_goes_back_to_the_status_before_the_delete(self):
        newest_first = [revision(3, status="archived"), revision(2, status="paused"), revision(1)]
        self.assertEqual(pp.restored_status(newest_first, "gold"), "paused")
        self.assertEqual(pp.restored_status([revision(1, status="archived")], "hub"), "draft")
        self.assertEqual(pp.restored_status([revision(1, status="archived")], "gold"), "active")

    def test_a_row_is_the_hubs_values(self):
        row = {"prompt_id": uuid.UUID(PROMPT), "origin": "gold", "version": 3, "text": "A", "hub_edited": True,
               "definition": json.dumps({"status": "paused", "kind": "acr", "language": "", "custom_values": {"f": "AI"}}),
               "recorded_at": AT, "registered_at": AT}
        view = pp.prompt_view(row)
        self.assertEqual((view["id"], view["status"], view["kind"], view["lang"], view["custom"], view["hubEdited"]),
                         (PROMPT, "paused", "acr", None, {"f": "AI"}, True))


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
                  mock.patch.object(pp, "reading", unreachable),
                  mock.patch.object(pp, "_pool", None)):
            p.start()
            self.addCleanup(p.stop)
        status, body = run(call("POST", "/v1/auth/login", {"login": "admin@hub", "password": PASSWORD}))
        self.assertEqual(status, 200, body)
        self.token = body["data"]["token"]

    WRITES = (("POST", f"/v1/hub/projects/{PID}/prompts", {"text": "A"}),
              ("POST", f"/v1/hub/projects/{PID}/prompts/{PROMPT}", {"expectedVersion": 1, "kind": "acr"}),
              ("POST", f"/v1/hub/projects/{PID}/prompts/{PROMPT}/pause", {"expectedVersion": 1}),
              ("POST", f"/v1/hub/projects/{PID}/prompt-tags", {"promptIds": [PROMPT], "fieldId": "f", "value": "AI"}),
              ("POST", f"/v1/hub/projects/{PID}/prompt-fields", {"label": "Topic"}),
              ("POST", f"/v1/hub/projects/{PID}/prompt-fields/f/archive", None))

    def test_the_prompts_are_the_administrators(self):
        self.t.add("hq", "hq", ["Kia"])
        status, body = run(call("POST", "/v1/auth/login", {"login": "hq", "password": PASSWORD}))
        hq = body["data"]["token"]
        for method, path, body in (("GET", f"/v1/hub/projects/{PID}/prompts/{PROMPT}/history", None), *self.WRITES):
            self.assertEqual(run(call(method, path, body))[0], 401, (method, path))
            status, out = run(call(method, path, body, hq))
            self.assertEqual((status, out["error"]["code"]), (403, "forbidden"), (method, path))

    def test_bad_requests_are_refused_before_the_store(self):
        for path, body, field in ((f"/v1/hub/projects/{PID}/prompts", {"text": ""}, "text"),
                                  (f"/v1/hub/projects/{PID}/prompts", {"text": "A", "kind": "acr"}, "kind"),
                                  (f"/v1/hub/projects/{PID}/prompts/{PROMPT}", {"kind": "acr"}, "expectedVersion"),
                                  (f"/v1/hub/projects/{PID}/prompts/{PROMPT}", {"expectedVersion": 1, "kind": "multi"}, "kind"),
                                  (f"/v1/hub/projects/{PID}/prompt-tags", {"promptIds": [], "fieldId": "f"}, "promptIds"),
                                  (f"/v1/hub/projects/{PID}/prompt-tags", {"promptIds": ["x"], "fieldId": "f"}, "promptIds.0"),
                                  (f"/v1/hub/projects/{PID}/prompt-fields", {"label": ""}, "label")):
            status, out = run(call("POST", path, body, self.token))
            self.assertEqual((status, out["error"]["code"], field in out["error"]["details"]["fields"]), (422, "invalid_value", True), (path, body, out))
        self.assertEqual(run(call("POST", f"/v1/hub/projects/{PID}/prompts/{PROMPT}/run", {"expectedVersion": 1}, self.token))[0], 404)
        self.assertEqual(run(call("POST", f"/v1/hub/projects/{PID}/prompt-fields/f/delete", None, self.token))[0], 404)
        self.assertEqual(run(call("POST", f"/v1/hub/projects/nope/prompts", {"text": "A"}, self.token))[0], 422)

    def test_unconfigured_editing_is_unavailable(self):
        for method, path, body in self.WRITES:
            status, out = run(call(method, path, body, self.token))
            self.assertEqual((status, out["error"]["code"]), (503, "source_unavailable"), path)


DB_URL = os.environ.get("HGH_PROJECT_PROMPTS_TEST_DB_URL")


@unittest.skipUnless(DB_URL, "HGH_PROJECT_PROMPTS_TEST_DB_URL (a HUB data DB with 012, as a role that can SET ROLE hmg_project_editor) not set")
class Store(unittest.TestCase):
    """Every write as the project editor on a fixture project, in one transaction that is rolled back."""

    def test_writes_revisions_the_gold_import_keeps(self):
        asyncio.run(self.scenario())

    async def scenario(self):
        conn = await asyncpg.connect(DB_URL)
        tx = conn.transaction()
        await tx.start()
        project, gold_prompt, global_project = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        field = str(uuid.uuid4())
        await conn.execute("INSERT INTO catalog.project(project_id,origin,source_id) VALUES($1,'gold',$1),($2,'gold',$2)", project, global_project)
        await conn.execute("""INSERT INTO catalog.project_version(project_id,version,definition,sha256) VALUES
            ($1,1,$2::jsonb,repeat('a',64)),($3,1,'{"surface":1,"is_root":true}',repeat('a',64))""", project,
            json.dumps({"surface": 3, "name": None, "custom_fields": [{"field_id": field, "label": "Topic", "archived": False,
                                                                        "created_at": "2026-09-18 09:12:55+00:00"}]}), global_project)
        await conn.execute("INSERT INTO catalog.prompt(prompt_id,project_id,origin,source_id) VALUES($1,$2,'gold',$1)", gold_prompt, project)
        await conn.execute("""INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256) VALUES($1,1,'Gold A',$2::jsonb,repeat('a',64))""",
                           gold_prompt, json.dumps({"surface": 3, "kind": "single", "language": "", "status": "active",
                                                    "in_project_catalog": True, "custom_values": {field: "AI"}}))
        actor = mock.Mock(user_id=uuid.uuid4())

        @asynccontextmanager
        async def writing():
            await conn.execute("SET LOCAL ROLE hmg_project_editor")
            await conn.execute("SELECT pg_advisory_xact_lock(617427413)")
            try:
                yield conn
            finally:
                await conn.execute("RESET ROLE")

        @asynccontextmanager
        async def reading():
            yield conn

        async def no_actors(ids):
            return {}

        patches = [mock.patch.object(pp, "writing", writing), mock.patch.object(pp, "reading", reading),
                   mock.patch.object(pp, "actors", no_actors), mock.patch.object(pp, "_pool", object())]
        for p in patches:
            p.start()
        try:
            await self.prompts(conn, actor, project, gold_prompt, field)
            with self.assertRaises(HTTPException) as e:   # the Global project is not a project page's
                await pp.add(global_project, pp.PromptAdd(text="x"), actor)
            self.assertEqual(e.exception.status_code, 404)
        finally:
            for p in patches:
                p.stop()
            await tx.rollback()
            await conn.close()

    async def prompts(self, conn, actor, project, gold_prompt, field):
        added = await pp.add(project, pp.PromptAdd(text="Gold A\nNew B\nNew C\nNew B"), actor)
        self.assertEqual((len(added["created"]), added["skipped"]), (2, ["Gold A"]))
        listed = {p["text"]: p for p in (await pp.catalog(project))["prompts"]}
        draft = listed["New B"]
        self.assertEqual((draft["status"], draft["origin"], draft["version"], draft["hubEdited"]), ("draft", "hub", 1, True))
        self.assertEqual((listed["Gold A"]["status"], listed["Gold A"]["hubEdited"]), ("active", False))

        edited = await pp.update(project, uuid.UUID(draft["id"]), pp.PromptEdit(expectedVersion=1, text=" New B2 ", language="KO"), actor)
        self.assertEqual((edited["item"]["text"], edited["item"]["lang"], edited["item"]["version"]), ("New B2", "ko", 2))
        for body, code in ((pp.PromptEdit(expectedVersion=1, kind="acr"), "version_conflict"),
                           (pp.PromptEdit(expectedVersion=2, text="New C"), "duplicate"),
                           (pp.PromptEdit(expectedVersion=2, language="xx"), "unknown_code")):
            with self.assertRaises(HTTPException) as e:
                await pp.update(project, uuid.UUID(draft["id"]), body, actor)
            self.assertEqual(e.exception.detail["code"], code)
        with self.assertRaises(HTTPException) as e:   # a measured prompt keeps its text
            await pp.update(project, gold_prompt, pp.PromptEdit(expectedVersion=1, text="Changed"), actor)
        self.assertEqual(e.exception.detail["code"], "not_draft")
        kind = await pp.update(project, gold_prompt, pp.PromptEdit(expectedVersion=1, kind="acr"), actor)
        self.assertEqual((kind["item"]["kind"], kind["item"]["hubEdited"]), ("acr", True))

        tags = await pp.set_tags(project, pp.TagSet(promptIds=[gold_prompt, uuid.UUID(draft["id"])], fieldId=field, value=" EV "), actor)
        self.assertEqual((len(tags["changed"]), tags["unchanged"]), (2, 0))
        again = await pp.set_tags(project, pp.TagSet(promptIds=[gold_prompt], fieldId=field, value="EV"), actor)
        self.assertEqual((again["changed"], again["unchanged"]), ([], 1))
        cleared = await pp.set_tags(project, pp.TagSet(promptIds=[uuid.UUID(draft["id"])], fieldId=field, value=None), actor)
        self.assertEqual(len(cleared["changed"]), 1)
        stored = await conn.fetchval("SELECT definition FROM catalog.current_prompt WHERE prompt_id=$1", uuid.UUID(draft["id"]))
        self.assertNotIn("custom_values", json.loads(stored))
        with self.assertRaises(HTTPException) as e:
            await pp.set_tags(project, pp.TagSet(promptIds=[gold_prompt], fieldId="nope", value="x"), actor)
        self.assertEqual(e.exception.status_code, 404)

        paused = await pp.lifecycle(project, gold_prompt, "pause", pp.VersionRef(expectedVersion=3), actor)
        self.assertEqual(paused["item"]["status"], "paused")
        archived = await pp.lifecycle(project, gold_prompt, "archive", pp.VersionRef(expectedVersion=4), actor)
        self.assertEqual(archived["item"]["status"], "archived")
        with self.assertRaises(HTTPException) as e:
            await pp.set_tags(project, pp.TagSet(promptIds=[gold_prompt], fieldId=field, value="x"), actor)
        self.assertEqual(e.exception.detail["code"], "not_editable")
        restored = await pp.lifecycle(project, gold_prompt, "restore", pp.VersionRef(expectedVersion=5), actor)
        self.assertEqual(restored["item"]["status"], "paused")
        with self.assertRaises(HTTPException) as e:
            await pp.lifecycle(project, gold_prompt, "pause", pp.VersionRef(expectedVersion=6), actor)
        self.assertEqual(e.exception.detail["code"], "invalid_status")
        events = (await pp.prompt_history(project, gold_prompt))["history"]
        self.assertEqual([e["event"] for e in events], ["restored", "archived", "paused", "updated", "updated", "created"])
        self.assertEqual(events[2]["changes"], {})
        self.assertEqual(events[3]["changes"], {f"tag:{field}": {"old": "AI", "new": "EV"}})

        added_field = await pp.add_field(project, pp.FieldAdd(label="Model"), actor)
        for label, code in (("topic", "duplicate"), ("Brand", "reserved_label")):
            with self.assertRaises(HTTPException) as e:
                await pp.add_field(project, pp.FieldAdd(label=label), actor)
            self.assertEqual(e.exception.detail["code"], code, label)
        self.assertEqual((await pp.set_field_archived(project, field, True, actor))["changed"], True)
        self.assertEqual((await pp.set_field_archived(project, field, True, actor))["changed"], False)
        fields = (await pp.catalog(project))["fields"]
        self.assertEqual([(f["label"], f["archived"]) for f in fields], [("Topic", True), ("Model", False)])
        self.assertEqual(fields[1]["id"], added_field["field"]["id"])
        recorded = await conn.fetchval("SELECT count(*) FROM catalog.project_version WHERE project_id=$1 AND recorded_by=$2", project, actor.user_id)
        self.assertEqual(recorded, 2)
        seqs = await conn.fetch("SELECT change_seq FROM catalog.prompt_version WHERE prompt_id=$1 ORDER BY version", gold_prompt)
        self.assertEqual([r["change_seq"] for r in seqs], sorted(r["change_seq"] for r in seqs))


if __name__ == "__main__":
    unittest.main()
