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


async def test_include_values_false_skips_project_tag_values(env, client_as, monkeypatch):
    """include_values=false: 행·건수·열 표시·초안 수는 같고, 프로젝트 전체 태그 값 집계는 실행하지 않는다(values = null)."""
    from app.features.projects.prompts import screen
    pid = await env.mk_project()
    a = await env.mk_prompt("Alpha", project_id=pid)
    await env.mk_prompt("beta", project_id=pid)
    field = await env.mk_field("tag", project_id=pid)
    await env.set_tag(a, field, "A", project_id=pid)
    seen: list[str] = []
    fetch_all = screen.fetch_all

    async def spy(conn, sql, params=None):
        seen.append(sql)
        return await fetch_all(conn, sql, params)
    async with client_as(env.owner) as client:
        url = f"/v1/projects/{pid}/prompts/screen"
        full = (await client.post(url, json={"limit": 1, "offset": 1})).json()["data"]
        monkeypatch.setattr(screen, "fetch_all", spy)
        response = await client.post(url, json={"limit": 1, "offset": 1, "include_values": False})
    assert response.status_code == 200, response.text
    rows = response.json()["data"]
    assert full["values"] == {str(field): ["A"]} and rows["values"] is None
    assert {**rows, "values": full["values"]} == full
    assert seen and not any("prompt_custom_field_value v" in sql for sql in seen)


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


async def test_ids_only_takes_five_thousand_ids_like_ten_pages_of_500(env, client_as):
    """B021: ids_only(전체 선택 id 묶음)는 limit 5,000 까지 받는다. 한 번에 읽은 id = 500 씩 10번 읽은 id(같은 순서·같은 total).
    행 읽기는 500 상한 그대로(501 → 422), ids_only 도 5,001 은 422, 후보 화면은 ids_only 여도 500 상한."""
    pid = await env.mk_project()
    seed = Sql(f"""
      SELECT set_config('app.actor_id', '{env.owner}', true);
      INSERT INTO app.prompt (project_id, text, created_by, created_at)
      SELECT '{pid}', 'ids-' || lpad(n::text, 5, '0'), app.actor(), '2026-01-01'::timestamptz + (n % 97) * interval '1 second'
      FROM generate_series(1, 5200) n;
    """)
    async with staged(seed), client_as(env.owner) as client:
        url = f"/v1/projects/{pid}/prompts/screen"
        for sort in ({}, {"sort": "text", "direction": "desc"}):
            big = await client.post(url, json={"limit": 5000, "ids_only": True, **sort})
            assert big.status_code == 200, big.text
            one = big.json()["data"]
            paged: list[str] = []
            for offset in range(0, 5000, 500):
                page = (await client.post(url, json={"offset": offset, "limit": 500, "ids_only": True, **sort})).json()["data"]
                assert page["total"] == one["total"] == 5200 and page["offset"] == offset
                paged += page["ids"]
            assert one["ids"] == paged and len(set(paged)) == 5000 and one["rows"] == []
            tail = (await client.post(url, json={"offset": 5000, "limit": 5000, "ids_only": True, **sort})).json()["data"]
            assert tail["offset"] == 5000 and len(tail["ids"]) == 200 and not set(tail["ids"]) & set(one["ids"])
        assert (await client.post(url, json={"limit": 501})).status_code == 422
        assert (await client.post(url, json={"limit": 5001, "ids_only": True})).status_code == 422
        r = await client.post(f"/v1/projects/{pid}/prompt-candidates/screen", json={"limit": 501, "ids_only": True})
        assert r.status_code == 422
