"""Large project screens: bounded rows, complete columns/tags/selection, existing membership gate."""
import uuid

from tests.support import ADMIN, HQ_HYUNDAI, Sql, needs_db, staged

pytestmark = needs_db


async def test_project_pages_over_twenty_thousand_rows(env, client_as):
    pid = await env.mk_project()
    field = await env.mk_field("late tag", project_id=pid)
    seed = Sql(f"""
      SELECT set_config('app.actor_id', '{env.owner}', true);
      INSERT INTO app.prompt (project_id, text, brand_code, category, created_by, created_at)
      SELECT '{pid}', 'zz-paged-' || lpad(n::text, 5, '0'), CASE WHEN n=25001 THEN 'Hyundai' END,
             CASE WHEN n=25001 THEN 'late-category' END, app.actor(), '2026-01-01'::timestamptz + n * interval '1 second'
      FROM generate_series(1, 25001) n;
      INSERT INTO app.prompt_custom_field_value (project_id, prompt_id, field_id, value)
      SELECT '{pid}', prompt_id, '{field}', 'late-only' FROM app.prompt WHERE project_id='{pid}' AND text='zz-paged-25001';
      INSERT INTO app.prompt_candidate (project_id, source, text, created_at)
      SELECT '{pid}', 'manual', 'candidate-' || lpad(n::text, 5, '0'), '2026-01-01'::timestamptz + n * interval '1 second'
      FROM generate_series(1, 25001) n;
    """)
    async with staged(seed), client_as(env.owner) as client:
        url = f"/v1/projects/{pid}/prompts/screen"
        first = await client.post(url, json={})
        assert first.status_code == 200, first.text
        data = first.json()["data"]
        assert data["total"] == 25001 and len(data["rows"]) == 200
        assert data["show_brand"] and data["show_category"]
        assert data["values"][str(field)] == ["late-only"]
        assert data["draft_count"] == 25001
        assert len(first.content) < 200_000
        end = await client.post(url, json={"offset": 25000, "limit": 500, "ids_only": True})
        assert end.status_code == 200, end.text
        tail = end.json()["data"]
        assert len(tail["ids"]) == 1 and tail["rows"] == []
        tag_sorted = await client.post(url, json={"sort": str(field), "direction": "desc", "limit": 1})
        assert tag_sorted.status_code == 200, tag_sorted.text
        assert tag_sorted.json()["data"]["rows"][0]["text"] == "zz-paged-25001"
        candidates = await client.post(f"/v1/projects/{pid}/prompt-candidates/screen", json={"offset": 25000, "limit": 500, "sort": "oldest"})
        assert candidates.status_code == 200, candidates.text
        assert candidates.json()["data"]["total"] == 25001
        assert [row["text"] for row in candidates.json()["data"]["rows"]] == ["candidate-25001"]


async def test_sort_keeps_empty_tags_last_and_rejects_other_project_fields(env, client_as):
    pid = await env.mk_project()
    a = await env.mk_prompt("Alpha", project_id=pid)
    b = await env.mk_prompt("beta", project_id=pid)
    field = await env.mk_field("tag", project_id=pid)
    await env.set_tag(a, field, "A", project_id=pid)
    async with client_as(env.owner) as client:
        url = f"/v1/projects/{pid}/prompts/screen"
        for direction in ("asc", "desc"):
            response = await client.post(url, json={"sort": str(field), "direction": direction})
            assert response.status_code == 200, response.text
            assert [r["prompt_id"] for r in response.json()["data"]["rows"]] == [str(a), str(b)]
        response = await client.post(url, json={"sort": str(uuid.uuid4()), "direction": "asc"})
        assert response.status_code == 404


async def test_screen_reads_require_active_membership(env, client_as):
    pid = await env.mk_project()
    for suffix in ("prompts", "prompt-candidates"):
        async with client_as(None) as client:
            response = await client.post(f"/v1/projects/{pid}/{suffix}/screen", json={})
            assert response.status_code == 401
        # A fresh project uses the fixture's owner; a distinct nonmember stays hidden.
        other = HQ_HYUNDAI if str(env.owner) != str(HQ_HYUNDAI) else env.outsider
        async with client_as(other) as client:
            response = await client.post(f"/v1/projects/{pid}/{suffix}/screen", json={})
            assert response.status_code == 404, response.text
        async with client_as(ADMIN) as client:
            response = await client.post(f"/v1/projects/{pid}/{suffix}/screen", json={})
            assert response.status_code == 200, response.text
