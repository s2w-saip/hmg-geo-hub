"""intent.candidates.submit 테스트: 앱 단 dedup(요청 안·기존)·trim·빈 값·source 검증·권한·롤백."""
from __future__ import annotations

import pytest
import pytest_asyncio

from app.features.intent.keywords.research.tests import intent_fixtures as fx
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db
URL = "/v1/intent/candidates"


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def projects(seeded):
    pr = await fx.create_projects()
    yield pr
    await fx.drop_projects(pr)


async def _rows(pid) -> list[tuple]:
    c = await fx.su()
    try:
        return [tuple(r) for r in await c.fetch("SELECT source, source_keyword, text FROM app.prompt_candidate WHERE project_id = $1 "
                                                "ORDER BY created_at, text", pid)]
    finally:
        await c.close()


async def test_submit_dedup(client_as, projects):
    pid = str(projects.own)
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.post(URL, params={"project_id": pid}, json={"source": "google_keyword", "items": [
            {"text": "  코나 연비 어때?  ", "source_keyword": " kona "}, {"text": "코나 연비 어때?"}, {"text": "   "},
            {"text": "투싼 가격", "source_keyword": ""}]})
        r2 = await c.post(URL, params={"project_id": pid}, json={"source": "social_scraping", "items": [
            {"text": "투싼 가격"}, {"text": "새 질문"}]})
    assert r.status_code == 201, r.text
    d = r.json()["data"]
    assert (d["added_count"], d["skipped_count"], len(d["candidate_ids"])) == (2, 2, 2)
    assert r2.json()["data"]["added_count"] == 1 and r2.json()["data"]["skipped_count"] == 1
    rows = await _rows(projects.own)
    assert sorted(rows, key=repr) == sorted([("google_keyword", "kona", "코나 연비 어때?"), ("google_keyword", None, "투싼 가격"),
                                             ("social_scraping", None, "새 질문")], key=repr)


@pytest.mark.parametrize("body", [
    {"source": "google_keyword", "items": [{"text": " "}, {"text": ""}]},
    {"source": "manual", "items": [{"text": "x"}]},
    {"source": "google_keyword", "items": []},
    {"source": "google_keyword", "items": [{"text": f"t{i}"} for i in range(201)]},
    {"source": "google_keyword", "items": [{"text": "x", "extra": 1}]},
])
async def test_422_writes_nothing(client_as, projects, body):
    before = await _rows(projects.own)
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.post(URL, params={"project_id": str(projects.own)}, json=body)
    assert r.status_code == 422
    assert await _rows(projects.own) == before


async def test_permissions(client_as, projects):
    body = {"source": "google_keyword", "items": [{"text": "perm"}]}
    async with client_as(VENDOR) as c:
        r = await c.post(URL, params={"project_id": str(CUST_PROJECT)}, json=body)
        assert r.status_code == 403 and r.json()["error"]["code"] == "operator_forbidden"
    async with client_as(KIA_US) as c:
        assert (await c.post(URL, params={"project_id": str(projects.own)}, json=body)).status_code == 404
    async with client_as(HQ_HYUNDAI) as c:
        assert (await c.post(URL, params={"project_id": str(projects.other)}, json=body)).status_code == 404
    async with client_as(None) as c:
        assert (await c.post(URL, params={"project_id": str(projects.own)}, json=body)).status_code == 401
    async with client_as(ADMIN) as c:
        assert (await c.post(URL, params={"project_id": str(projects.other)}, json=body)).status_code == 201
    assert await _rows(projects.other) == [("google_keyword", None, "perm")]
