"""엔티티 버전 반영(E1 오버레이·E5 엔진) × 현행 프로필(core.profile IMPLEMENTED 20개 스위치 전부 켬) 동치 시험(be/ecat-int 통합).

현행 프로필의 투영 스위치(rep_pick_latest_first·resub_phantom_exclude·cit_hostless_per_row·web_owned_target_base·display_name_latin)는
적재기 활성 프로필과 bulk 시드 psql 변수(rep_latest_first·attrib_member·cit_row_host·web_tgt_base)·세션 GUC(hgh.legacy_name)가 같은 규칙을
탄다. 엔티티 반영은 project() 로 영향 답변을 다시 투영하므로 이 열들(is_rep·cit_n_all·cit_c1..13·region_geo_key·elig_nc·std_in_nc·
cit_in_nc·rid_n·회차 귀속)을 같은 프로필로 다시 계산해야 한다. 각 단계 뒤 rd = 같은 프로필·같은 활성 버전·같은 회차 고정의 전량 bulk 시드.

흐름(전부 롤백 트랜잭션): v1 이관 + 프로필 켠 전량 증분 투영 → v2(제거 Apple·Tata·Ioniq, 병합 TOYOTA → Toyota, 관계 Fortwo → Kia, 차단·추가
표면) all 반영 → v3(= v2 + Toyota 숨김 + Creta → Hyundai 병합) unexposed 반영 → v3 되돌리기(v2 내용, unexposed). 단계마다 bulk 대조.
스냅샷(testkit EQ_TABLES)에 없는 v2.15 열(rd.answer cit_n_all·cit_c1..13·region_geo_key)은 따로 자연 키로 대조한다.
"""
from __future__ import annotations

import asyncpg
import pytest

from app.core.config import set_settings
from app.core.profile import IMPLEMENTED, OFF, parse_profile
from ingest.project.apply import ecat_engine as ee
from ingest.project.apply.tests.test_ecat_apply import (  # noqa: F401 (_engine_env = 자동 픽스처)
    ACTOR,
    PRODUCT_OWNER,
    _apply_row,
    _approve,
    _engine_env,
    _op,
    _request,
    _setup,
)
from ingest.project.apply.tests.test_ecat_overlay import CRETA, HYUNDAI, TOYOTA
from ingest.project.apply.tests.test_wu5_projection import SYNTH as WU5_SYNTH
from ingest.testkit import EQ_TABLES, bulk_seed, diff, referenced_extras, snapshot, strict_diff
from tests.support import DB_URL, needs_db

pytestmark = needs_db
PROFILE = ",".join(sorted(IMPLEMENTED))
EXTRA = """
SELECT j.job_id, a.cit_n_all, a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10,
       a.cit_c11, a.cit_c12, a.cit_c13, g.code AS region_geo
  FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
  LEFT JOIN rd.dim_country g ON g.geo_key = a.region_geo_key
 ORDER BY 1
"""


async def _bulk_check(c: asyncpg.Connection, label: str) -> None:
    """증분 rd(지금) = 같은 프로필 bulk 시드(롤백). 실패면 단계 이름과 차이 표."""
    got = await snapshot(c, EQ_TABLES)
    got_x = [tuple(r) for r in await c.fetch(EXTRA)]
    sp = c.transaction()
    await sp.start()
    await bulk_seed(c, profile=parse_profile(PROFILE))                             # 같은 프로필의 투영 스위치 전부(display_name_latin 포함)
    ref = await snapshot(c, EQ_TABLES)
    ref_x = [tuple(r) for r in await c.fetch(EXTRA)]
    await sp.rollback()
    d = diff(ref, got)
    sd = strict_diff(d)
    assert not sd and not await referenced_extras(c, d), (label, {t: (len(x) if hasattr(x, "__len__") else x) for t, x in sd.items()}, sd)
    assert got_x == ref_x, (label, "v2.15 인용 열·region_geo_key 차이", [a for a, b in zip(got_x, ref_x, strict=False) if a != b][:5])


async def _new_ver(c: asyncpg.Connection, base: int, *, origin: str = "admin") -> int:
    v = await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, origin, created_by) VALUES ($1, 'p', 'p', $2, $3) RETURNING ver",
                         base, origin, ACTOR)
    await c.execute("""INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id,
                                                    note, updated_by, updated_at)
                       SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by, updated_at
                         FROM app.ecat_entity WHERE ver = $2""", v, base)
    await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT $1, surface_id, action FROM app.ecat_surface WHERE ver = $2", v, base)
    return int(v)


async def _apply(c: asyncpg.Connection, ver: int, scope: str) -> int:
    aid = await _request(c, ver, scope)
    assert [o.status for o in await _op(c, aid, "preview")] == ["applied"]
    await _approve(c, aid, PRODUCT_OWNER)
    outs = await _op(c, aid, "apply")
    assert outs[-1].status == "applied", outs
    return aid


@pytest.fixture
def current_profile(settings):
    set_settings(settings.model_copy(update={"legacy_profile": PROFILE}))
    yield
    set_settings(settings)


async def test_ecat_apply_hidden_removed_merge_rollback_equals_bulk_under_current_profile(current_profile, monkeypatch):
    from app.core.profile import active_profile
    assert len(IMPLEMENTED) >= 20 and set(active_profile().on) == set(IMPLEMENTED)   # 하한(스위치는 WU 가 늘린다): 구현 스위치 전부 켬
    monkeypatch.setenv("HGH_ECAT_CHUNK", "3")
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(WU5_SYNTH)                                # G21A·OWN4 가 갈리는 인용 2행(J21)
        # 출발 상태 = 같은 프로필로 재투영된 rd(stg 절차와 같다). NAME(display_name_latin)은 표시 브랜드 키 자체를 바꾸는 투영 스위치라
        # 템플릿(끈 프로필 시드)의 차원 위에서 증분만 켜면 혼합 상태가 된다(be/int3-name, 2026-10-02)
        await bulk_seed(c, profile=parse_profile(PROFILE))
        await c.execute("DISCARD TEMP")                           # 시드 임시 객체(소유자 = 슈퍼유저)를 지운다: 뒤 적재는 loader 롤로 같은 이름을 만든다
        v2, _ = await _setup(c)                                   # v1 이관 + 프로필 켠 전량 증분 투영, 초안 v2
        await _bulk_check(c, "v1(프로필 켠 전량 증분)")
        # 대조가 자명하지 않음: 같은 입력의 프로필 끈 bulk 는 지금(프로필 켠 증분)과 다르다
        got = await snapshot(c, EQ_TABLES)
        sp = c.transaction()
        await sp.start()
        await bulk_seed(c, profile=OFF)                           # 끈 bulk(be/incr-parity 뒤 기본값 = 활성 프로필이라 명시)
        off = strict_diff(diff(await snapshot(c, EQ_TABLES), got))
        await sp.rollback()
        sensitive = sorted(off)
        a2 = await _apply(c, v2, "all")
        await _bulk_check(c, "v2 all(제거·병합·관계·차단·추가)")
        v3 = await _new_ver(c, v2)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Toyota', 'Brand', 'hidden', $3) "
                        "ON CONFLICT (ver, entity_id) DO UPDATE SET role = 'hidden', merge_into = NULL", v3, TOYOTA, ACTOR)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, merge_into, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Creta', 'Product', 'competitor', $3, $4)", v3, CRETA, HYUNDAI, ACTOR)
        a3 = await _apply(c, v3, "unexposed")
        pins3 = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        await _bulk_check(c, "v3 unexposed(숨김·병합, 노출 회차 v2 고정)")
        rv = await _new_ver(c, v2, origin="rollback")
        r = await _apply(c, rv, "unexposed")
        st = {k: (await _apply_row(c, k))["status"] for k in (a2, a3, r)}
        await _bulk_check(c, "v3 되돌리기(v2 내용)")
        vers = {row[0] for row in await c.fetch("SELECT DISTINCT ecat_ver FROM rd.answer")}
        await tr.rollback()
    finally:
        await c.close()
    assert {"rd.answer", "rd.citation"} <= set(sensitive), sensitive
    assert pins3[10] == v2 and st == {a2: "applied", a3: "rolled_back", r: "applied"}, (pins3, st)
    assert vers <= {v2, rv}, vers
    assert ee.KPI_METRICS                                        # 엔진 모듈이 프로필 켠 모수 식으로 적재됐다(미리보기 kpi_sql)


def test_projection_markers_live_where_fact_src_sql_runs():
    """통합 회귀(be/ecat-int): 엔티티 분할(FACT_SRC → ECAT_IN → FACT_MR)과 WU-5 인용 투영 표식이 겹쳐 표식이 FACT_MR 로 가면 프로필이
    조용히 무시됐다. 표식은 FACT_SRC 에 있고, 켠 프로필이 실제로 SQL 을 바꾼다. 다른 투영 SQL 상수에는 표식이 없다."""
    from app.core.profile import OFF, LegacyProfile
    from ingest.project.apply import queries as q
    on = LegacyProfile(cit_hostless_per_row=True, web_owned_target_base=True)
    assert q.fact_src_sql(q.FACT_SRC, on) != q.fact_src_sql(q.FACT_SRC, OFF)
    for name in dir(q):
        v = getattr(q, name)
        if name != "FACT_SRC" and isinstance(v, str):
            assert "/*row_src*/" not in v and "/*web_tgt*/" not in v, name
