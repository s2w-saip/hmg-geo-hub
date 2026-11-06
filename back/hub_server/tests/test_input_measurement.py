"""Measurement settings on Project › Setting (hub_server/inputs/measurement.py). Previously also the cache DB's key and purge (hub_stores/cache_db.py). The
roles and CHECKs are asserted against PostgreSQL in back/hub_storage/verify-input.sql and verify-metrics.sql."""
import asyncio
import json
import unittest
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

try:
    from fastapi import HTTPException

    from hub_server.inputs import measurement as m
    from hub_server.inputs import projects as project_add
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run with back/ on the path and the API requirements installed") from exc

ACTOR = SimpleNamespace(user_id=uuid4())
OPTIONS = [{"family": "engine", "item_key": "chatgpt", "definition": {"code": "chatgpt"}}, {"family": "country", "item_key": "KR", "definition": {"code": "KR"}},
           {"family": "brand_bit", "item_key": "2", "definition": {"bit": 2, "code": "kia"}}]


class Conn:
    def __init__(self, store):
        self.store = store

    async def fetchrow(self, sql, project):
        if project != self.store["project"]:
            return None
        return self.store["rows"][-1] if self.store["rows"] else {"version": None, "sha256": None}

    async def fetch(self, sql):
        return OPTIONS

    async def execute(self, sql, *a):
        self.store["rows"].append({"version": a[1], "brands": a[2], "countries": a[3], "engines": a[4], "cadence": a[5], "acr_repeats": a[6], "web_units": a[7],
                                   "owned_urls": a[8], "tracked_urls": a[9], "tracked_targets": a[10], "origin": "hub", "sha256": a[11],
                                   "recorded_by": a[12], "recorded_at": datetime(2026, 11, 6, tzinfo=UTC)})


def writing(store):
    @asynccontextmanager
    async def opened():
        yield Conn(store)
    return opened


def body(**over):
    return m.MeasurementWrite(**{"expectedVersion": 0, **over})


class Settings(unittest.TestCase):
    def setUp(self):
        self.project = uuid4()
        self.store = {"project": self.project, "rows": []}

    def write(self, **over):
        with mock.patch.object(m, "writing", writing(self.store)):
            return asyncio.run(m.write(self.project, body(**over), ACTOR))

    def test_a_write_is_one_new_version_in_the_stored_spelling(self):
        out = self.write(brands=["KIA", "kia"], countries=[" kr "], engines=["ChatGPT"], cadence="weekly", acrRepeats=5,
                         ownedUrls=[" kia.com/kr ", "kia.com/kr", ""], trackedTargets=[{"kind": "brand", "name": " Toyota "}, {"kind": "brand", "name": "toyota"}])
        item = out["item"]
        self.assertTrue(out["changed"])
        self.assertEqual((item["version"], item["brands"], item["countries"], item["engines"], item["ownedUrls"]), (1, ["kia"], ["KR"], ["chatgpt"], ["kia.com/kr"]))
        self.assertEqual(item["trackedTargets"], [{"kind": "brand", "name": "Toyota"}])

    def test_the_same_settings_record_nothing(self):
        self.write(brands=["kia"])
        out = self.write(expectedVersion=1, brands=["kia"])
        self.assertEqual((out["changed"], len(self.store["rows"])), (False, 1))

    def test_a_stale_version_is_refused(self):
        self.write(brands=["kia"])
        with self.assertRaises(HTTPException) as caught:
            self.write(expectedVersion=0, brands=[])
        self.assertEqual((caught.exception.status_code, caught.exception.detail["code"]), (409, "version_conflict"))

    def test_codes_outside_the_reference_values_are_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.write(engines=["perplexity"])
        self.assertEqual((caught.exception.status_code, caught.exception.detail["details"]["unknown"]), (422, {"engines": ["perplexity"]}))

    def test_a_url_with_a_space_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.write(trackedUrls=["kia.com/a b"])
        self.assertEqual(caught.exception.status_code, 422)

    def test_an_unknown_project_is_not_found(self):
        self.store["project"] = uuid4()
        with self.assertRaises(HTTPException) as caught:
            self.write()
        self.assertEqual(caught.exception.status_code, 404)

    def test_no_version_yet_reads_as_empty(self):
        self.assertEqual({k: v for k, v in m.view(None).items() if v not in (None, [])}, {"version": 0})




class AddProject(unittest.TestCase):
    """Admin › 측정 설정 › 프로젝트 만들기: the legacy form's fields; one transaction of project, first version and first settings."""

    def add(self, **over):
        calls = []

        class Conn:
            async def fetch(self, sql):
                return OPTIONS

            async def execute(self, sql, *a):
                calls.append((sql, a))

        @asynccontextmanager
        async def opened():
            yield Conn()

        body = project_add.ProjectAdd(**{"name": " EV launch ", "description": " why ", "domain": " kia.com/kr ", "brand": "kia", "country": "kr", "engines": ["ChatGPT"], **over})
        with mock.patch.object(project_add.project_prompts, "writing", opened):
            return asyncio.run(project_add.add(body, ACTOR)), calls

    def test_the_three_rows_of_a_new_project(self):
        out, calls = self.add()
        self.assertEqual([c[0].split()[2] for c in calls], ["catalog.project(project_id,origin)", "catalog.project_version(project_id,version,definition,sha256,recorded_by)",
                                                            "catalog.project_measurement_version(project_id,version,brands,countries,engines,cadence,acr_repeats,web_units,"])
        project_id = calls[0][1][0]
        self.assertEqual(out, {"projectId": str(project_id)})
        version = calls[1][1]
        self.assertEqual((version[0], version[1], version[4]), (project_id, 1, ACTOR.user_id))
        definition = json.loads(version[2])
        self.assertEqual((definition["surface"], definition["status"], definition["name"], definition["description"], definition["domain"], definition["country"]),
                         (3, "active", "EV launch", "why", "kia.com/kr", "KR"))
        self.assertEqual((definition["scope_project_id"], definition["source_project_id"]), (str(project_id), str(project_id)))
        settings = calls[2][1]
        self.assertEqual((settings[0], settings[1], settings[2], settings[3], settings[4], settings[8]), (project_id, 1, ["kia"], ["KR"], ["chatgpt"], ["kia.com/kr"]))

    def test_the_legacy_forms_required_fields(self):
        for over, code in (({"name": "  "}, "name_required"), ({"country": " "}, "country_required"), ({"engines": []}, "engines_required"), ({"engines": [" "]}, "engines_required")):
            with self.assertRaises(HTTPException) as caught:
                self.add(**over)
            self.assertEqual(caught.exception.status_code, 422)
            self.assertEqual(caught.exception.detail["code"], code, over)

    def test_brand_and_domain_are_optional(self):
        _, calls = self.add(brand=None, domain=None, description=None)
        definition = json.loads(calls[1][1][2])
        self.assertEqual((definition["domain"], definition["description"]), (None, None))
        self.assertEqual((calls[2][1][2], calls[2][1][8]), ([], []))

    def test_an_unknown_code_is_refused(self):
        for over in ({"country": "ZZ"}, {"engines": ["bard"]}, {"brand": "nope"}):
            with self.assertRaises(HTTPException) as caught:
                self.add(**over)
            self.assertEqual(caught.exception.detail["code"], "unknown_code", over)


class Listing(unittest.TestCase):
    def test_every_surface_with_or_without_settings(self):
        pid = uuid4()
        rows = [{"pid": pid, "project_definition": '{"surface": 2, "name": null, "status": "active"}', "version": None, "sha256": None},
                {"pid": pid, "project_definition": {"surface": 1, "name": "x", "domain": "d"}, "version": 2, "brands": ["kia"], "countries": ["KR"], "engines": [], "cadence": None,
                 "acr_repeats": None, "web_units": "[]", "owned_urls": [], "tracked_urls": [], "tracked_targets": "[]", "origin": "hub", "recorded_at": None}]
        one, two = (m.listed(r) for r in rows)
        self.assertEqual((one["projectId"], one["surface"], one["name"], one["measurement"]["version"]), (str(pid), 2, None, 0))
        self.assertEqual((two["surface"], two["name"], two["domain"], two["measurement"]["version"], two["measurement"]["brands"]), (1, "x", "d", 2, ["kia"]))


if __name__ == "__main__":
    unittest.main()
