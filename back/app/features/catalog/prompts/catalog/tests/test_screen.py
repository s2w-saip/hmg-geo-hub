"""Screen paging keeps global scope, complete facets and bounded response sizes."""
import pytest

from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, VENDOR, Sql, needs_db, staged

pytestmark = needs_db


@pytest.mark.parametrize("user,path,status", [
    (None, "/v1/prompts/screen", 401), (VENDOR, "/v1/prompts/screen", 403),
    (HQ_HYUNDAI, "/v1/admin/catalog/prompts/screen", 403),
])
async def test_screen_gate(client_as, user, path, status):
    async with client_as(user) as client:
        response = await client.post(path, json={})
    assert response.status_code == status, response.text


async def test_screen_scope_matches_existing_catalog_and_pages_without_duplicates(client_as):
    async with client_as(KIA_US) as client:
        original = await client.get("/v1/prompts", params={"surface": "global", "all": "true"})
        assert original.status_code == 200
        expected = {r["prompt_id"] for r in original.json()["data"]["items"]}
        actual = []
        for offset in range(0, max(1, len(expected)), 2):
            response = await client.post("/v1/prompts/screen", json={"offset": offset, "limit": 2})
            assert response.status_code == 200, response.text
            data = response.json()["data"]
            assert data["total"] == len(expected)
            assert len(data["rows"]) <= 2
            actual.extend(row["id"] for row in data["rows"])
    assert len(actual) == len(set(actual)) and set(actual) == expected


async def test_large_catalog_filter_count_facets_and_last_page(client_as, seeded):
    seed = Sql("""
      SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', true);
      INSERT INTO app.prompt (project_id, text, depth1, depth2, kind, regions, lang, created_by)
      SELECT (SELECT project_id FROM app.project WHERE kind='standard_root'),
             'large-screen-' || lpad(n::text, 5, '0'), 'paging-only', CASE WHEN n % 2 = 0 THEN 'even' ELSE 'odd' END,
             'single', ARRAY['KR','x:WW'], 'KO', app.actor() FROM generate_series(1, 12005) n;
    """)
    async with staged(seed), client_as(ADMIN) as client:
        response = await client.post("/v1/prompts/screen", json={"filters": {"depth1": "paging-only"}, "draft": {"depth1": "paging-only"}, "offset": 12000, "limit": 50, "sort": "text"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["total"] == 12005 and len(data["rows"]) == 5
        assert data["rows"][0]["text"] == "large-screen-12001"
        assert data["facets"]["depth2"] == ["even", "odd"]
        assert "KR" in data["facets"]["market"] and "depth2" in data["columns"]
        response = await client.post("/v1/admin/catalog/prompts/screen", json={"filters": {"depth1": "paging-only"}, "offset": 12000, "limit": 50, "sort": "text", "asc": False})
        assert response.status_code == 200, response.text
        admin = response.json()["data"]
        assert len(admin["rows"]) == 5 and admin["rows"][0]["text"] == "large-screen-00005"
        assert admin["stats"]["total"] >= 12005


async def test_filtering_does_not_shrink_option_population_and_search_is_literal(client_as):
    async with client_as(ADMIN) as client:
        before = await client.post("/v1/prompts/screen", json={})
        assert before.status_code == 200, before.text
        response = await client.post("/v1/prompts/screen", json={"search": "%_'; SELECT 1 --"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["total"] == 0 and data["rows"] == []
        assert data["facets"] == before.json()["data"]["facets"]


@pytest.mark.parametrize("body", [{"limit": 0}, {"limit": 501}, {"offset": -1}, {"sort": "text; SELECT 1"}, {"collation": "x"}])
async def test_paging_parameters_are_bounded_and_sort_is_whitelisted(client_as, body):
    async with client_as(ADMIN) as client:
        response = await client.post("/v1/prompts/screen", json=body)
    assert response.status_code == 422
