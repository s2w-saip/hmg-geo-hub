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


async def test_admin_count_is_the_view_population(client_as):
    """관리자 '전체'(count) 는 보기(활성·삭제) 모집단이다 — 필터 없이 count == total, 활성 보기 count == 통계 줄 total.
    수정 전: count 가 루트 전체(삭제 포함)를 세어 활성 300 · 삭제 12 면 '표시 300 / 전체 312', 통계 줄은 '전체 300'."""
    seed = Sql("""
      SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', true);
      INSERT INTO app.prompt (project_id, text, depth1, kind, regions, lang, created_by, deleted_at)
      SELECT (SELECT project_id FROM app.project WHERE kind='standard_root'), 'deleted-screen-' || n, 'deleted-only', 'single',
             ARRAY['KR'], 'KO', app.actor(), now() FROM generate_series(1, 3) n;
    """)
    async with staged(seed), client_as(ADMIN) as client:
        got = {}
        for view in ("active", "deleted"):
            response = await client.post("/v1/admin/catalog/prompts/screen", json={"filters": {"view": view}})
            assert response.status_code == 200, response.text
            got[view] = response.json()["data"]
            assert got[view]["count"] == got[view]["total"], (view, got[view]["count"], got[view]["total"])
        assert got["deleted"]["count"] >= 3
        assert got["active"]["count"] == got["active"]["stats"]["total"]

async def test_filtering_does_not_shrink_option_population_and_search_is_literal(client_as):
    async with client_as(ADMIN) as client:
        before = await client.post("/v1/prompts/screen", json={})
        assert before.status_code == 200, before.text
        response = await client.post("/v1/prompts/screen", json={"search": "%_'; SELECT 1 --"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["total"] == 0 and data["rows"] == []
        assert data["facets"] == before.json()["data"]["facets"]


@pytest.mark.parametrize("path", ["/v1/prompts/screen", "/v1/admin/catalog/prompts/screen"])
async def test_include_meta_false_reads_rows_and_total_only(client_as, monkeypatch, path):
    """include_meta=false: rows·total·offset 는 기본 호출과 같고, 범위·draft 메타(count·facets·columns·관리자 stats)는 계산하지 않는다."""
    from app.features.admin.catalog.prompts import service as admin_svc
    from app.features.catalog.prompts.catalog import screen
    body = {"sort": "text", "asc": False, "offset": 1, "limit": 3}          # 기본 픽스처만으로 행이 있는 범위(다른 테스트 데이터에 기대지 않는다)
    async with client_as(ADMIN) as client:
        full = (await client.post(path, json=body)).json()["data"]

        def not_called(*a, **k):
            raise AssertionError("scope metadata must not be computed when include_meta=false")
        monkeypatch.setattr(screen, "fetch_one", not_called)            # 패싯·열·count 문장
        monkeypatch.setattr(admin_svc, "list_catalog", not_called)      # 관리자 통계(종전 경로)
        monkeypatch.setattr(admin_svc, "catalog_stats", not_called)     # 관리자 통계(B076 전용 집계)
        monkeypatch.setattr(admin_svc, "root_dim", not_called)
        response = await client.post(path, json={**body, "include_meta": False})
    assert response.status_code == 200, response.text
    rows = response.json()["data"]
    assert full["facets"] is not None and full["count"] is not None and full["total"] > 0
    assert {k: rows[k] for k in ("rows", "total", "offset", "limit")} == {k: full[k] for k in ("rows", "total", "offset", "limit")}
    assert (rows["count"], rows["facets"], rows["columns"], rows["stats"]) == (None, None, None, None)


@pytest.mark.parametrize("body", [{"limit": 0}, {"limit": 501}, {"offset": -1}, {"sort": "text; SELECT 1"}, {"collation": "x"},
                                  {"limit": 501, "include_meta": True}, {"limit": 5001, "include_meta": False}, {"row_fields": "all"}])
async def test_paging_parameters_are_bounded_and_sort_is_whitelisted(client_as, body):
    async with client_as(ADMIN) as client:
        response = await client.post("/v1/prompts/screen", json=body)
    assert response.status_code == 422


async def test_b076_admin_stats_equal_list_catalog_without_list_rows(client_as):
    """B076: 관리 카탈로그 화면 stats 는 목록 행(outbox 표시 상관 서브쿼리)·루트 재조회 없이 STATS·SCOPE_ORPHANS 로 낸다.
    값은 종전 경로(list_catalog, include_deleted=true)와 같다."""
    from tests.core.rcache_calls import Stmts

    async with client_as(ADMIN) as client:
        listed = await client.get("/v1/admin/catalog/prompts", params={"include_deleted": "true", "limit": 1})
        with Stmts() as st:
            screen = await client.post("/v1/admin/catalog/prompts/screen", json={})
    assert listed.status_code == 200 and screen.status_code == 200, screen.text
    assert screen.json()["data"]["stats"] == listed.json()["data"]["stats"]
    assert not any("app.scope_outbox" in q for q in st.seen)                     # 목록 행 문장(outbox EXISTS) 없음
    assert sum("kind = 'standard_root'" in q for q in st.seen) == 1              # 화면 자신의 루트 조회 한 번
    assert sum("count(*) FILTER (WHERE p.deleted_at IS NULL) AS total" in q for q in st.seen) == 1


_EQ_BODIES = [{}, {"sort": "text", "asc": False}, {"sort": "market", "market_labels": {"KR": "대한민국"}}, {"sort": "presence"},
              {"sort": "brand", "collation": "ko"}, {"search": "suv"}, {"sort": "status", "offset": 1, "limit": 3},
              {"filters": {"view": "deleted"}}]


@pytest.mark.parametrize("path,user", [("/v1/prompts/screen", KIA_US), ("/v1/prompts/screen", ADMIN),
                                       ("/v1/admin/catalog/prompts/screen", ADMIN)])
async def test_b077_list_row_fields_same_rows_and_order(client_as, path, user):
    """B077: row_fields=list 는 같은 행·순서·total·메타, 화면이 쓰지 않는 scopeText·promptType·category 만 null(rd.dim_prompt 조인 없음).
    정렬·검색·필터·collation 별로 full(기본, 종전)과 비교한다."""
    from tests.core.rcache_calls import Stmts

    drop = ("scopeText", "promptType", "category")
    async with client_as(user) as client:
        for body in _EQ_BODIES:
            full = await client.post(path, json=body)
            with Stmts() as st:
                lean = await client.post(path, json={**body, "row_fields": "list"})
            assert full.status_code == 200 and lean.status_code == 200, (body, lean.text)
            f, ln = full.json()["data"], lean.json()["data"]
            assert {k: v for k, v in ln.items() if k != "rows"} == {k: v for k, v in f.items() if k != "rows"}, body
            assert [{k: v for k, v in r.items() if k not in drop} for r in ln["rows"]] ==                 [{k: v for k, v in r.items() if k not in drop} for r in f["rows"]], body
            assert all(r[k] is None for r in ln["rows"] for k in drop)
            row_sql = [q for q in st.seen if "ORDER BY" in q and "OFFSET" in q]
            assert len(row_sql) == 1 and "rd.dim_prompt" not in row_sql[0] and "p.*" not in row_sql[0]
    assert any(r["scopeText"] is not None for r in (await _admin_full(client_as))["rows"])   # full 은 종전대로 채운다


async def _admin_full(client_as):
    async with client_as(ADMIN) as client:
        return (await client.post("/v1/admin/catalog/prompts/screen", json={"limit": 500})).json()["data"]


async def test_b078_rows_only_pages_up_to_5000_keep_server_order(client_as, seeded):
    """B078: include_meta=false(행·total 만) 는 한 번에 5,000 행까지 읽는다. 5,000 행 묶음을 이어 붙이면 500 행 페이지를
    이어 붙인 것과 같은 행·순서(내보내기). 메타를 계산하는 읽기는 종전대로 500 이 상한."""
    seed = Sql("""
      SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', true);
      INSERT INTO app.prompt (project_id, text, depth1, depth2, kind, regions, lang, created_by)
      SELECT (SELECT project_id FROM app.project WHERE kind='standard_root'),
             'b078-' || lpad(n::text, 5, '0'), 'b078-only', CASE WHEN n % 3 = 0 THEN 'x' ELSE 'y' END,
             'single', ARRAY['KR'], 'KO', app.actor() FROM generate_series(1, 6001) n;
    """)
    body = {"filters": {"depth1": "b078-only"}, "draft": {"depth1": "b078-only"}, "sort": "depth2", "include_meta": False}
    async with staged(seed), client_as(ADMIN) as client:
        for path in ("/v1/prompts/screen", "/v1/admin/catalog/prompts/screen"):
            small, big = [], []
            for offset in range(0, 6001, 500):
                r = await client.post(path, json={**body, "offset": offset, "limit": 500})
                assert r.status_code == 200, r.text
                small += [x["id"] for x in r.json()["data"]["rows"]]
            for offset in range(0, 6001, 5000):
                r = await client.post(path, json={**body, "offset": offset, "limit": 5000, "row_fields": "list"})
                assert r.status_code == 200, r.text
                d = r.json()["data"]
                assert d["total"] == 6001 and d["offset"] == offset and d["limit"] == 5000
                big += [x["id"] for x in d["rows"]]
            assert len(small) == 6001 and big == small, path
            r = await client.post(path, json={**body, "include_meta": True, "limit": 5000})
            assert r.status_code == 422
