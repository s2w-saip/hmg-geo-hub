"""admin.entities.registry 통합 테스트(로컬 개발 DB 복제본 ad_content, 합성 픽스처).

픽스처(손계산 근거): rd.dim_entity Brand 8행(Hyundai·Kia·Toyota·TOYOTA·Apple·Tata·smart·기아), Product 2·Feature 1.
global 서빙 회차 = 10(09-07)·11(09-14)(12 는 비서빙), 최신 노출 = 09-14.
수치(5차 항목 1, B안·결정 25) = 엔티티별 전 기간 합계 rd.entity_mention_total. 기대값은 운영 listDiscoveredBrands 식을 그대로 옮긴 독립 SQL
(entity_totals.pgsql prod_definition, ing.mention 직접 집계)로 낸다. 기간·표면·게이트와 무관하고, 같은 표시 브랜드의 엔티티도 각자 값이다.
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from app.features.admin.entities.versions.tests.test_ad_entities_versions import (  # noqa: F401  (ecat 픽스처 재사용)
    CLEANUP,
    _x,
    ecat,
)
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, load_named_sql, needs_db

U = "/v1/admin/entities"
SQL = load_named_sql(__import__("pathlib").Path(__file__).with_name("entity_totals.pgsql"))
KIA_KO = uuid.UUID("ed4b8012-4a73-4174-9b43-4cb696934b25")          # '기아' Brand(brand_key 2 = Kia)
CRETA = uuid.UUID("71000000-0000-4000-8000-000000000004")           # Product 'Hyundai Creta'
TOYOTA = uuid.UUID("71000000-0000-4000-8000-000000000001")
pytestmark = needs_db


async def _fetch(sql: str, *args):
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetch(sql, *args)
    finally:
        await c.close()


async def _val(sql: str, *args):
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetchval(sql, *args)
    finally:
        await c.close()


async def _reset(*ids: uuid.UUID) -> None:
    """이전 실행이 남긴 등재·대기 요청 정리(테스트 준비, 소유자 접속)."""
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute("UPDATE app.judgment_change SET status = 'applied' WHERE kind = 'entity' AND subject_uuids && $1::uuid[] "
                        "AND status IN ('pending', 'running')", list(ids))
        await c.execute("DELETE FROM app.entity_registry WHERE entity_id = ANY($1::uuid[])", list(ids))
    finally:
        await c.close()


async def _expected() -> dict[str, tuple[int, int]]:
    """운영 정의 독립 재계산(Brand 엔티티만 목록에 나온다). 합계 0(언급 없음) 엔티티는 목록에서 (0, 0)."""
    rows = await _fetch(SQL["prod_definition"])
    return {str(r["entity_id"]): (int(r["answers"]), int(r["mentions"])) for r in rows}


@pytest.mark.parametrize("uid,status", [(ADMIN, 200), (HQ_HYUNDAI, 403), (KIA_US, 403), (VENDOR, 403), (KIA_EU, 403),
                                        (SUSPENDED, 401), (None, 401)])
async def test_access(client_as, uid, status):
    async with client_as(uid) as c:
        r = await c.get(U, params={"surface": "global"})
    assert r.status_code == status


async def test_entity_counts_match_prod_definition(client_as):
    """목록 수치 = 운영 listDiscoveredBrands 정의의 엔티티 단위 전 기간 합계(독립 재계산과 일치). 같은 표시 브랜드(Toyota·TOYOTA)도 각자 값."""
    async with client_as(ADMIN) as c:
        r = await c.get(U, params={"surface": "global", "limit": 500})
    assert r.status_code == 200, r.text
    body = r.json()
    m = body["meta"]
    assert m["source"]["count_grain"] == "entity_all_time" and m["suppressed"] == {} and m["source"]["pool"] == "api_ro"
    exp = await _expected()
    items = [i for i in body["data"]["items"] if i["entity_type"] == "Brand"]
    got = {i["entity_id"]: (i["answers"], i["mentions"]) for i in items}
    assert len(got) == 8 and got == {k: exp.get(k, (0, 0)) for k in got}
    assert sum(v[0] for v in got.values()) > 0
    assert got[str(TOYOTA)] != got["71000000-0000-4000-8000-000000000002"]              # 표시 브랜드가 같아도 엔티티별(이전엔 같은 값)
    counts = [i["answers"] for i in body["data"]["items"]]
    assert counts == sorted(counts, reverse=True)
    assert not {"brand_answers", "brand_mentions"} & set(body["data"]["items"][0])     # 표시 브랜드 단위 수치 열은 없다


async def test_drop_excluded_and_incremental_equals_full(client_as):
    """드롭 등록 → 트리거 차분 → flush(적재 마무리와 같은 함수) 뒤 목록 = 운영 정의 독립 재계산(드롭 답변 제외) = 전체 재계산 단언."""
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute(SQL["drop_one"])
        await c.fetchval(SQL["flush"])
        assert await c.fetchval("SELECT rd.assert_entity_mention_total()") == 7     # 드롭 답변이 Tata 의 유일한 답변 → Tata 행 없음(합계 0)
    finally:
        await c.close()
    try:
        async with client_as(ADMIN) as cl:
            r = await cl.get(U, params={"surface": "global", "limit": 500})
        got = {i["entity_id"]: (i["answers"], i["mentions"]) for i in r.json()["data"]["items"] if i["entity_type"] == "Brand"}
        exp = await _expected()
        assert got == {k: exp.get(k, (0, 0)) for k in got}
    finally:
        c = await asyncpg.connect(DB_URL)
        try:
            await c.execute(SQL["undrop"])
            await c.fetchval(SQL["flush"])
            assert await c.fetchval("SELECT rd.assert_entity_mention_total()") >= 8
        finally:
            await c.close()


async def test_range_and_surfaces(client_as):
    """수치는 기간·표면과 무관(운영과 같다): 어느 표면·기간이든 같은 엔티티 합계. 창은 키셋 세대·meta 에만 쓴다."""
    async with client_as(ADMIN) as c:
        rg = await c.get(U, params={"surface": "global", "from": "2026-09-01", "to": "2026-09-30", "limit": 500})
        web = await c.get(U, params={"surface": "website", "limit": 500})
        prj = await c.get(U, params={"surface": "project", "limit": 500})
        none = await c.get(U, params={"surface": "global", "from": "2020-01-01", "to": "2020-01-31"})
    assert rg.json()["meta"]["source"]["pool"] == "admin_long" and none.json()["meta"]["source"]["pool"] == "admin_long"
    exp = await _expected()
    for resp in (rg, web, prj, none):
        assert resp.status_code == 200 and resp.json()["meta"]["suppressed"] == {}
        got = {i["entity_id"]: (i["answers"], i["mentions"]) for i in resp.json()["data"]["items"] if i["entity_type"] == "Brand"}
        assert got == {k: exp.get(k, (0, 0)) for k in got} and len(got) == 8


@pytest.mark.parametrize("params,code", [({}, "unprocessable"), ({"surface": "mars"}, "unprocessable"),
                                         ({"surface": "global", "from": "2026-09-01"}, "unprocessable"),
                                         ({"surface": "global", "from": "2026-09-10", "to": "2026-09-01"}, "unprocessable"),
                                         ({"surface": "global", "from": "2025-09-01", "to": "2026-09-02"}, "period_too_long"),
                                         ({"surface": "global", "sort": "random"}, "unprocessable"),
                                         ({"surface": "global", "role": "friend"}, "unprocessable"),
                                         ({"surface": "global", "limit": 0}, "unprocessable"),
                                         ({"surface": "global", "cursor": "xx"}, "cursor_invalid")])
async def test_422(client_as, params, code):
    async with client_as(ADMIN) as c:
        r = await c.get(U, params=params)
    assert r.status_code == 422 and r.json()["error"]["code"] == code, r.text


async def test_366_days_is_allowed(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(U, params={"surface": "global", "from": "2025-09-01", "to": "2026-09-01"})    # 366일(윤년 없음 → 366 포함)
    assert r.status_code == 200


async def test_filters_empty_and_ignored(client_as):
    async with client_as(ADMIN) as c:
        toy = await c.get(U, params={"surface": "global", "q": "toy", "country": "US", "engine": "gemini"})
        empty = await c.get(U, params={"surface": "global", "q": "zz-없음-zz"})
    names = sorted(i["name"] for i in toy.json()["data"]["items"])
    assert names == ["TOYOTA", "Toyota"]
    assert toy.json()["meta"]["ignored_filters"] == ["country", "engine"]
    assert empty.status_code == 200 and empty.json()["data"]["items"] == []


@pytest.mark.parametrize("sort", ["answers_desc", "name_asc"])
async def test_pagination(client_as, sort):
    async with client_as(ADMIN) as c:
        full = (await c.get(U, params={"surface": "global", "sort": sort, "limit": 500})).json()["data"]["items"]
        got, cursor = [], None
        for _ in range(30):
            p = {"surface": "global", "sort": sort, "limit": 3, **({"cursor": cursor} if cursor else {})}
            body = (await c.get(U, params=p)).json()
            got += body["data"]["items"]
            cursor = body["meta"]["page"]["next_cursor"]
            if not cursor:
                break
        reuse = await c.get(U, params={"surface": "website", "sort": sort, "limit": 3,
                                       "cursor": (await c.get(U, params={"surface": "global", "sort": sort, "limit": 3})).json()["meta"]["page"]["next_cursor"]})
    assert [i["entity_id"] for i in got] == [i["entity_id"] for i in full] and len(full) >= 8
    assert reuse.status_code == 422 and reuse.json()["error"]["code"] == "cursor_invalid"


# ── 역할 설정 ──
async def test_set_role_own_then_competitor(client_as):
    await _reset(KIA_KO)
    async with client_as(ADMIN) as c:
        r = await c.put(f"{U}/{KIA_KO}", json={"role": "own", "brand_code": "Kia"})
        same = await c.put(f"{U}/{KIA_KO}", json={"role": "own", "brand_code": "Kia"})
        dup = await c.put(f"{U}/{KIA_KO}", json={"role": "excluded"})           # 대기 중 요청이 있어 409, 쓰기 롤백
        lst = await c.get(U, params={"surface": "global", "role": "own", "limit": 500})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["applied"] is True and d["propagation"] == "pending" and d["warnings"] == ["full_rebuild"] and d["name"] == "기아"
    ch = await _fetch("SELECT kind, subject_uuids, payload, requested_by FROM app.judgment_change WHERE change_id = $1", d["change_id"])
    assert ch[0]["kind"] == "entity" and ch[0]["subject_uuids"] == [KIA_KO] and ch[0]["requested_by"] == ADMIN
    assert '"op": "upsert"' in ch[0]["payload"] and '"old": null' in ch[0]["payload"]
    reg = await _fetch("SELECT role, brand_code, name, updated_by FROM app.entity_registry WHERE entity_id = $1", KIA_KO)
    assert dict(reg[0]) == {"role": "own", "brand_code": "Kia", "name": "기아", "updated_by": ADMIN}
    assert same.json()["data"]["applied"] is False and same.json()["data"]["propagation"] == "none"
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "duplicate_pending"
    assert await _val("SELECT role FROM app.entity_registry WHERE entity_id = $1", KIA_KO) == "own"
    row = next(i for i in lst.json()["data"]["items"] if i["entity_id"] == str(KIA_KO))
    assert row["role"] == "own" and row["registered"] is True and row["brand_code"] == "Kia"
    await _val("UPDATE app.judgment_change SET status = 'applied' WHERE change_id = $1", d["change_id"])   # 적재기 반영 가정
    async with client_as(ADMIN) as c:
        back = await c.put(f"{U}/{KIA_KO}", json={"role": "competitor"})
    bd = back.json()["data"]
    assert back.status_code == 200 and bd["applied"] is True
    assert await _val("SELECT count(*) FROM app.entity_registry WHERE entity_id = $1", KIA_KO) == 0
    pl = await _val("SELECT payload::text FROM app.judgment_change WHERE change_id = $1", bd["change_id"])
    assert '"op": "delete"' in pl and '"new": null' in pl
    await _reset(KIA_KO)


async def test_registry_only_entity_listed(client_as):
    """Brand 가 아닌 엔티티(Product)도 등재되면 목록에 붙는다(현행: 명부에만 있는 엔티티 포함)."""
    await _reset(CRETA)
    async with client_as(ADMIN) as c:
        r = await c.put(f"{U}/{CRETA}", json={"role": "excluded", "name": " Creta 제외 "})
        lst = await c.get(U, params={"surface": "global", "q": "Creta", "limit": 500})
    assert r.status_code == 200
    items = lst.json()["data"]["items"]
    assert [(i["entity_id"], i["entity_type"], i["name"], i["role"]) for i in items] == [(str(CRETA), "Product", "Creta 제외", "excluded")]
    await _reset(CRETA)


@pytest.mark.parametrize("body,code", [({"role": "own"}, "brand_required"), ({"role": "own", "brand_code": "HMG"}, "invalid_brand"),
                                       ({"role": "own", "brand_code": "Nope"}, "invalid_brand"),
                                       ({"role": "boss"}, "unprocessable"), ({"role": "own", "brand_code": "Kia", "x": 1}, "unprocessable")])
async def test_set_role_422_writes_nothing(client_as, body, code):
    await _reset(TOYOTA)
    before = await _val("SELECT count(*) FROM app.judgment_change WHERE kind = 'entity'")
    async with client_as(ADMIN) as c:
        r = await c.put(f"{U}/{TOYOTA}", json=body)
    assert r.status_code == 422 and r.json()["error"]["code"] == code
    assert await _val("SELECT count(*) FROM app.entity_registry WHERE entity_id = $1", TOYOTA) == 0
    assert await _val("SELECT count(*) FROM app.judgment_change WHERE kind = 'entity'") == before


async def test_set_role_404_and_forbidden(client_as):
    async with client_as(ADMIN) as c:
        nf = await c.put(f"{U}/{uuid.uuid4()}", json={"role": "excluded", "name": "x"})
        bad = await c.put(f"{U}/not-a-uuid", json={"role": "excluded"})
    async with client_as(HQ_HYUNDAI) as c:
        fb = await c.put(f"{U}/{TOYOTA}", json={"role": "excluded"})
    assert nf.status_code == 404 and bad.status_code == 422 and fb.status_code == 403


# ── B081 메뉴 게이트 · B088 fields=names · B083 활성 스냅샷 메모 ──
async def test_list_menu_gate(client_as):
    """B081: 목록 GET 은 legacy 페이지 게이트(route-policy /admin = group admin)와 같게 메뉴 그룹 admin 도 본다(롤백 전용 준비).
    admin 메뉴 없는 admin = 403 menu_forbidden(본문에 행 없음), admin 메뉴 admin = 200. 역할 PUT 은 legacy 액션처럼 role 만(본문 검증 422 까지 간다)."""
    from tests.support import Sql, Update, staged

    actor = Sql("SELECT set_config('app.actor_id', $1, true)", (str(ADMIN),))      # 계정 쓰기 = 감사 트리거 행위자 필수
    async with staged(actor, Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["standard"]})), client_as(ADMIN) as c:
        r = await c.get(U, params={"surface": "global"})
        w = await c.put(f"{U}/{TOYOTA}", json={})
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden" and "items" not in r.text
    assert w.status_code == 422
    async with staged(actor, Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["admin"]})), client_as(ADMIN) as c:
        r = await c.get(U, params={"surface": "global"})
    assert r.status_code == 200 and "items" in r.json()["data"]


def _no_own(rows: list[dict]) -> list[dict]:
    return [{k: v for k, v in r.items() if k != "own_brand"} for r in rows]


async def _pages(c, params: dict) -> tuple[list[dict], int]:
    got, cursor, n = [], None, 0
    for _ in range(30):
        body = (await c.get(U, params={**params, **({"cursor": cursor} if cursor else {})})).json()
        got += body["data"]["items"]
        n += 1
        cursor = body["meta"]["page"]["next_cursor"]
        if not cursor:
            break
    return got, n


async def test_fields_names_skips_attribution_only(client_as, monkeypatch):
    """B088: fields=names(검토함 병합 후보) = 행·순서·이름·유형·역할·수치·커서는 full 과 같고, 유효 귀속 판정(active_own_brands)은 돌지 않는다
    (own_brand null). 기본(full)은 종전 그대로 귀속을 붙인다."""
    from app.features.admin.entities.versions import service as vsvc

    async with client_as(ADMIN) as c:
        full = (await c.get(U, params={"surface": "global", "limit": 500})).json()["data"]["items"]

        async def boom(*_a, **_k):
            raise AssertionError("fields=names 는 귀속 판정을 하지 않는다")
        monkeypatch.setattr(vsvc, "active_own_brands", boom)
        names = (await c.get(U, params={"surface": "global", "limit": 500, "fields": "names"})).json()["data"]["items"]
        paged, _ = await _pages(c, {"surface": "global", "limit": 3, "fields": "names"})
        bad = await c.get(U, params={"surface": "global", "fields": "all"})
    assert len(full) >= 8 and any(r["own_brand"] for r in full)
    assert _no_own(names) == _no_own(full) and _no_own(paged) == _no_own(full)
    assert all(r["own_brand"] is None for r in names + paged)
    assert bad.status_code == 422


async def test_active_snapshot_read_once_across_pages(ecat, client_as, monkeypatch):  # noqa: F811  (ecat 픽스처)
    """B083: 활성 버전 내용(ENTITIES_OF·SURFACES_OF)은 버전 키 메모라 페이지마다 다시 읽지 않는다(버전 행 VERSIONS 만 페이지마다).
    페이지로 나눠 받은 행·귀속 = 한 번에 받은 것. 같은 번호로 다시 만든 버전(정리 뒤 재이관)은 키가 갈려 다시 읽는다."""
    from app.features.admin.entities.versions import queries as vq
    from app.features.admin.entities.versions import service as vsvc

    seen: list[str] = []
    real = vsvc.fetch_all

    async def spy(conn, sql, params=None):
        seen.append(sql)
        return await real(conn, sql, params)
    monkeypatch.setattr(vsvc, "fetch_all", spy)
    vsvc._ACTIVE_SNAPSHOT.clear()
    async with client_as(ADMIN) as c:
        full = (await c.get(U, params={"surface": "global", "limit": 500})).json()["data"]["items"]
        paged, pages = await _pages(c, {"surface": "global", "limit": 3})
    assert pages >= 3 and paged == full
    assert seen.count(vq.ENTITIES_OF) == 1 and seen.count(vq.SURFACES_OF) == 1          # 첫 페이지 한 번뿐(종전 = 페이지마다)
    assert seen.count(vq.VERSIONS) == 1 + pages
    await _x(CLEANUP)
    await _x("SELECT app.ecat_cutover_v1($1, 'E6 시험')", ADMIN)                         # 같은 v1, 다른 created_at·activated_at
    async with client_as(ADMIN) as c:
        again = (await c.get(U, params={"surface": "global", "limit": 500})).json()["data"]["items"]
    assert seen.count(vq.ENTITIES_OF) == 2 and again == full
