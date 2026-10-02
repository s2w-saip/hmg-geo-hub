"""WU-4 현행 프로필 스위치(A41 catalog_incl_deleted · NAME display_name_latin · G20 brand_exposure_per_alias) DB 값 시험.

근거: 계획서 notes/hgh-impl/revert-to-current-plan-20261001.md 5.3·5.5절·2절 G20, 제품 결정 19·23~25(현행 값 재현, 예외 없음).
모든 준비는 롤백 전용(staged): 소유자로 app·ing 입력을 바꾸고 같은 트랜잭션에서 bulk 시드(seed-30·40, 적재 경로와 동치: test_equivalence)를
다시 돌려 rd 를 그 입력의 투영으로 만든 뒤, api_ro 로 core 빌더를 읽는다.

  A41  현행 정의 = 소프트 삭제 카탈로그 행을 거르지 않는다. 그래서 "삭제 뒤 A41 켜짐 값 = 삭제 전 값"이 정확한 수용 기준이다
       (삭제는 카탈로그 행의 deleted_at 만 바꾸므로 현행 값은 그대로다). 전부 삭제(프롬프트가 카탈로그에서 사라짐)와
       부분 삭제(다브랜드 프롬프트의 한 브랜드 행) 둘 다. 꺼짐은 삭제분이 빠진다(새 정의).
  G20  같은 표시 브랜드로 풀리는 롤업 id 가 둘인 언급 → 켜짐 노출 = 꺼짐 + 1(그 답변이 두 번), 언급 수·순위는 불변.
  NAME 같은 롤업 엔티티의 표기 'KGM'·'KG모빌리티' → 켜짐(ICU en-US) = 'KGM', 꺼짐(DB 기본 콜레이션) = DB 에 따라 다름(로컬 libc = 'KG모빌리티').
"""
from __future__ import annotations

import dataclasses
import json
import uuid
from typing import Any

import pytest

from app.core import measure as M
from app.core import profile as P
from app.core.codes import brand_masks, load_refs
from app.core.filters import KPI_SUPPORT, CommonFilters, resolve_read_context
from tests.support import ADMIN, HQ_HYUNDAI, TODAY, needs_db, principal, raw_fetch, stage, staged

pytestmark = needs_db

ACTOR = uuid.UUID("5eed0000-0000-4000-8000-000000000001")
P1 = "b0000000-0000-4000-8000-000000000001"          # 루트 카탈로그 Genesis·Hyundai 두 행, 회차 11 std_in 답변 2(k1·k2)
A41 = P.LegacyProfile(catalog_incl_deleted=True)
G20 = P.LegacyProfile(brand_exposure_per_alias=True)


async def _driver(conn: Any) -> Any:
    raw = await conn.get_raw_connection()
    return raw.driver_connection


def _reseed(*sql: str, guc: dict[str, str] | None = None, latest_first: bool = False):
    """준비 단계: 소유자로 입력 SQL → (세션 GUC) → bulk 시드(seed-30·40, latest_first = 현행 대표 규칙) 재실행. 같은 트랜잭션(끝에 롤백)."""
    async def step(conn: Any) -> None:
        from ingest.testkit import bulk_seed

        d = await _driver(conn)
        await d.execute(f"SELECT set_config('app.actor_id', '{ACTOR}', true)")        # app.prompt 감사 트리거(DB-v2.3 P31)
        for s in sql:
            await d.execute(s)
        for k, v in (guc or {}).items():
            await d.execute("SELECT set_config($1, $2, true)", k, v)
        await bulk_seed(d, profile=P.OFF, rep_latest_first=latest_first)   # 시험이 프로필을 고정한다(세션 프로필 무관)
    return step


async def _scope(conn: Any, uid: uuid.UUID, profile: P.LegacyProfile, *, own_bit: int | None = None):
    ctx = await resolve_read_context(conn, await principal(conn, uid), CommonFilters.model_validate({"surface": "global"}), support=KPI_SUPPORT)
    ms = dataclasses.replace(ctx.measure(), profile=profile)
    if own_bit is not None:                          # 관점 브랜드 하나(계정 스코프와 무관하게 빌더 입력만 좁힌다: 카탈로그 브랜드 술어 시험용)
        refs = await load_refs(conn)
        pop = own_bit | refs.umbrella_bit
        ms = dataclasses.replace(ms, own_bits=(own_bit,), pop_bits=(own_bit, refs.umbrella_bit), bgrps=tuple(brand_masks(pop, refs.bit_universe)))
    return ms, await ctx.window(conn, today=TODAY)


async def _values(conn: Any, uid: uuid.UUID, profile: P.LegacyProfile, **kw) -> dict[str, Any]:
    ms, w = await _scope(conn, uid, profile, **kw)
    counts = await M.fetch_counts(conn, ms, w, parts=M.ALL_PARTS, group_by=("round_date",))
    brands = sorted(tuple(sorted(r.items())) for r in await M.brand_rows(conn, ms, w))
    cits = M.citation_counts_sql(ms, w)
    from app.core.db import fetch_all
    cit = sorted(tuple(sorted(r.items())) for r in await fetch_all(conn, cits.text, cits.params))
    return {"counts": counts, "brands": brands, "cit": cit}


async def test_a41_full_delete_on_equals_before(seeded):
    async with staged(actor=ACTOR) as conn:
        # 기준값도 같은 bulk 투영(끔)에서 잰다: 복제본이 세션 프로필 NAME 으로 투영됐으면 표시 브랜드 키가 _reseed(끔) 뒤와 달라 비교가 키 번호로 갈린다
        await stage(conn, _reseed())
        before = await _values(conn, HQ_HYUNDAI, P.OFF)
        assert before == await _values(conn, HQ_HYUNDAI, A41)                # 픽스처의 삭제 행(P5)은 답변이 없다 → 켜짐 = 꺼짐
        assert before["counts"][0]["answers"] > 0
        await stage(conn, _reseed(f"UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = '{P1}' AND deleted_at IS NULL"))
        d = (await raw_fetch(conn, "SELECT in_root_catalog, in_root_catalog_all, cat_mask, cat_mask_all FROM rd.dim_prompt WHERE prompt_id = $1",
                             uuid.UUID(P1)))[0]
        assert d == {"in_root_catalog": False, "in_root_catalog_all": True, "cat_mask": 0, "cat_mask_all": 5}
        n = (await raw_fetch(conn, """SELECT count(*) FILTER (WHERE a.std_in) AS std, count(*) FILTER (WHERE a.std_in_nc) AS std_nc
                                         FROM rd.answer a JOIN rd.dim_prompt d ON d.prompt_key = a.prompt_key WHERE d.prompt_id = $1""",
                                  uuid.UUID(P1)))[0]
        assert n["std"] == 0 and n["std_nc"] == 2                              # 전부 삭제 = elig 거짓(새 정의), 카탈로그 항 뺀 모수는 그대로
        off, on = await _values(conn, HQ_HYUNDAI, P.OFF), await _values(conn, HQ_HYUNDAI, A41)
        assert off["counts"][0]["answers"] < before["counts"][0]["answers"]   # 꺼짐 = 삭제된 프롬프트 답변이 빠진다
        assert on == before                                                    # 켜짐 = 현행(삭제 행도 카탈로그) = 삭제 전 값


async def test_a41_partial_delete_brand_row(seeded):
    async with staged(actor=ACTOR) as conn:
        await stage(conn, _reseed())                                            # 기준값도 같은 bulk 투영(끔, 위 시험과 같은 이유)
        before = await _values(conn, ADMIN, P.OFF, own_bit=4)                  # 제네시스 관점: P1 은 Genesis 행으로 카탈로그 안
        await stage(conn, _reseed(f"UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = '{P1}' AND brand_code = 'Genesis'"))
        d = (await raw_fetch(conn, "SELECT cat_mask, cat_mask_all, in_root_catalog FROM rd.dim_prompt WHERE prompt_id = $1", uuid.UUID(P1)))[0]
        assert d == {"cat_mask": 1, "cat_mask_all": 5, "in_root_catalog": True}
        off, on = await _values(conn, ADMIN, P.OFF, own_bit=4), await _values(conn, ADMIN, A41, own_bit=4)
        assert off["counts"][0]["answers"] < before["counts"][0]["answers"]   # 새 정의: 제네시스 관점 모수에서 P1 이 빠진다
        assert on == before
        assert await _values(conn, ADMIN, A41, own_bit=1) == await _values(conn, ADMIN, P.OFF, own_bit=1)   # 현대 관점은 삭제와 무관


async def test_a41_population_columns_match_recompute():
    """적재·시드가 쓴 std_in_nc·cit_in_nc = rd.answer_elig_nc 재계산(단언 함수), 전부 채워짐, 비글로벌은 std_in 과 같다."""
    async with staged(role=None) as conn:
        d = await _driver(conn)
        n = await d.fetchval("SELECT count(*) FROM rd.answer")
        assert await d.fetchval("SELECT rd.assert_answer_nc(NULL)") == n
        assert await d.fetchval("SELECT count(*) FROM rd.answer WHERE surface <> 1 AND (std_in_nc, cit_in_nc) IS DISTINCT FROM (std_in, cit_in)") == 0
        assert await d.fetchval("SELECT count(*) FROM rd.answer_brand WHERE std_in_nc IS NULL OR rid_n IS NULL") == 0


async def test_g20_exposure_counts_each_rollup_id(seeded):
    x, y = uuid.UUID("7a000000-0000-4000-8000-0000000000c1"), uuid.UUID("7a000000-0000-4000-8000-0000000000c2")
    add = ("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, "
           "brand_rollup_entity_id, type_mention) VALUES "
           f"('2026-09-01', '90000000-0000-4000-8000-000000000001', 91, '{x}', 'Zorbex', 'Brand', 2, 3.0, '{x}', 2), "
           f"('2026-09-01', '90000000-0000-4000-8000-000000000001', 92, '{y}', 'Zorbex', 'Brand', 1, 4.0, '{y}', 1)")
    async with staged(actor=ACTOR) as conn:
        await stage(conn, _reseed(add))
        r = (await raw_fetch(conn, """SELECT ab.rid_n, ab.entity_rows, ab.mention_count FROM rd.answer_brand ab
                                        JOIN rd.dim_brand_name b ON b.brand_key = ab.brand_key WHERE b.bare = 'zorbex'"""))
        assert r == [{"rid_n": 2, "entity_rows": 2, "mention_count": 3}]      # 한 답변 × 한 표시 브랜드, 롤업 id 2개
        ms, w = await _scope(conn, HQ_HYUNDAI, P.OFF)
        key = (await raw_fetch(conn, "SELECT brand_key FROM rd.dim_brand_name WHERE bare = 'zorbex'"))[0]["brand_key"]
        off = {r["brand_key"]: r for r in await M.brand_rows(conn, ms, w)}[key]
        on = {r["brand_key"]: r for r in await M.brand_rows(conn, dataclasses.replace(ms, profile=G20), w)}[key]
        assert (off["exposure_answers"], on["exposure_answers"]) == (1, 2)   # 현행 = (답변, 롤업 id) 단위(fold.ts:468,486)
        assert {k: v for k, v in on.items() if k != "exposure_answers"} == {k: v for k, v in off.items() if k != "exposure_answers"}


async def test_name_latin_first_uses_production_collation():
    e = uuid.UUID("7a000000-0000-4000-8000-0000000000d1")
    add = ("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, "
           "brand_rollup_entity_id, type_mention) VALUES "
           f"('2026-09-01', '90000000-0000-4000-8000-000000000001', 93, '{e}', 'KG모빌리티', 'Brand', 1, 5.0, '{e}', 1), "
           f"('2026-09-01', '90000000-0000-4000-8000-000000000002', 93, '{e}', 'KGM', 'Brand', 1, 5.0, '{e}', 1)")
    q = """SELECT b.name FROM rd.answer_brand ab JOIN rd.dim_brand_name b ON b.brand_key = ab.brand_key
            JOIN rd.dim_prompt d ON d.prompt_key = ab.prompt_key WHERE lower(b.bare) IN ('kgm', 'kg모빌리티') GROUP BY 1"""
    async with staged(actor=ACTOR, role=None) as conn:
        d = await _driver(conn)
        icu_first = await d.fetchval("SELECT 'KGM' < 'KG모빌리티' COLLATE \"en-US-x-icu\"")
        db_first = await d.fetchval("SELECT 'KGM' < 'KG모빌리티'")
        assert icu_first is True                                               # 운영(ICU en-US) 순서
        await stage(conn, _reseed(add, guc={"hgh.legacy_name": "1"}))
        assert await raw_fetch(conn, q) == [{"name": "KGM"}]                  # 켜짐 = 운영 표시명
    async with staged(actor=ACTOR, role=None) as conn:
        await stage(conn, _reseed(add))
        assert await raw_fetch(conn, q) == [{"name": "KGM" if db_first else "KG모빌리티"}]   # 꺼짐 = DB 기본 콜레이션(stg libc = KG모빌리티)
    # 적재기 경로(queries.name_sql)도 같은 정렬: 표식 자리에 같은 콜레이션 절
    async with staged(role=None) as conn:
        d = await _driver(conn)
        from ingest.project.apply import queries as Q
        pick = ("SELECT DISTINCT ON (entity_id) display_name FROM (VALUES (1, 'KG모빌리티'), (1, 'KGM')) v(entity_id, display_name)"
                " ORDER BY entity_id, (display_name ~ '^[A-Za-z]') DESC, display_name" + Q.NAME_COLL_MARK)
        assert await d.fetchval(Q.name_sql(pick, P.LegacyProfile(display_name_latin=True))) == "KGM"
        assert await d.fetchval(Q.name_sql(pick, P.OFF)) == ("KGM" if db_first else "KG모빌리티")


# ── WU-2 병합(2026-10-01): A41 과 셀 대표(A1) 함께 = 현행 프로필 전체 ─────────────────────────────────────────────
CUR = P.LegacyProfile(cell_rep=True, rep_pick_latest_first=True, acr_iter_unfolded=True, gap_in_population=True,
                      catalog_incl_deleted=True)
REPS = """SELECT count(*) FILTER (WHERE a.is_rep) AS reps, count(*) AS n FROM rd.answer a JOIN rd.dim_prompt d ON d.prompt_key = a.prompt_key
           WHERE d.prompt_id = $1"""


def test_a41_with_cell_rep_requires_current_rule():
    """hub 대표 규칙(elig 후보)은 전부 삭제된 프롬프트 셀에 대표를 두지 않는다 → A41 + cell_rep 은 현행 규칙(latest_first)과만 켤 수 있다."""
    with pytest.raises(ValueError, match="rep_pick_latest_first"):
        P.LegacyProfile(catalog_incl_deleted=True, cell_rep=True)
    assert P.LegacyProfile(catalog_incl_deleted=True, cell_rep=True, rep_pick_latest_first=True).cell_rep
    assert P.CURRENT.catalog_incl_deleted and P.CURRENT.rep_pick_latest_first


async def test_a41_deleted_prompt_cells_stay_rep_and_population_current(seeded):
    """현행 대표 선정은 카탈로그를 보지 않는다: 루트 카탈로그 행을 전부 지워도(현행 = 삭제 행도 카탈로그) 그 프롬프트 셀의 대표가 그대로 남고,
    현행 프로필 전체(A41 + cell_rep + A15 + A16 + latest_first) 값 = 삭제 전 값. hub 규칙으로 투영하면 그 셀 대표가 사라진다(가드의 이유)."""
    delete = f"UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = '{P1}' AND deleted_at IS NULL"
    async with staged(actor=ACTOR) as conn:
        await stage(conn, _reseed(latest_first=True))
        reps0 = (await raw_fetch(conn, REPS, uuid.UUID(P1)))[0]
        before = await _values(conn, HQ_HYUNDAI, CUR)
        await stage(conn, _reseed(delete, latest_first=True))
        reps1 = (await raw_fetch(conn, REPS, uuid.UUID(P1)))[0]
        assert reps0["reps"] > 0 and reps1 == reps0                             # 대표가 그대로(카탈로그 무관 elig_nc 게이트)
        assert (await raw_fetch(conn, "SELECT count(*) AS n FROM rd.answer a JOIN rd.dim_prompt d ON d.prompt_key = a.prompt_key "
                                      "WHERE d.prompt_id = $1 AND a.is_rep AND NOT a.elig", uuid.UUID(P1)))[0]["n"] == reps1["reps"]
        after = await _values(conn, HQ_HYUNDAI, CUR)
        assert after == before and before["counts"][0]["answers"] > 0           # 현행 프로필 값 = 삭제 전 값
        rep_off = dataclasses.replace(CUR, catalog_incl_deleted=False)          # A41 만 끄면(새 정의) 삭제 프롬프트가 빠진다
        assert (await _values(conn, HQ_HYUNDAI, rep_off))["counts"][0]["answers"] < before["counts"][0]["answers"]
        checked: list[int] = []

        async def assert_rep(c: Any) -> None:                                   # 단언 함수는 소유자·loader 전용(api_ro 실행 권한 없음)
            checked.append(await (await _driver(c)).fetchval("SELECT rd.assert_rep(NULL, true)"))
        await stage(conn, assert_rep)
        assert checked[0] > 0                                                   # 단언: is_rep ⇒ elig_nc(현행 규칙), 셀당 ≤ 1, 자식 = 부모
    async with staged(actor=ACTOR) as conn:
        await stage(conn, _reseed(delete))                                      # hub 규칙 투영: 삭제 프롬프트 셀 대표 없음
        assert (await raw_fetch(conn, REPS, uuid.UUID(P1)))[0]["reps"] == 0


# ── 엔드포인트 변성 대조(WU-2 test_cell_rep 3절과 같은 호출 목록): 삭제 뒤 A41 켜짐 응답 = 삭제 전 응답 ──────────────────────
#   A41 은 core 자리(scope_where·mention_population·citation_population)로 기능 파일 전부에 전달된다(WU-2 가 옮긴 11개 포함).
#   적용 프롬프트 수(kpi summary params.applied_prompts)는 A41 이 rd.dim_prompt.cat_mask_all 로 센다(core.measure.applied_prompts_sql).
#   미측정 프롬프트 목록·택소노미 옵션·카탈로그 목록(rd.catalog_entry 행 단위)은 A41 밖(비삭제 카탈로그 그대로)이라 목록에서 뺀다.
CATALOG_META = ("/v1/kpi/unmeasured-prompts", "/v1/catalog/", "/v1/filters/")


def _strip_is_rep(out: dict) -> dict:
    res = {}
    for k, (st, body) in out.items():
        if "/v1/answers" in k and isinstance(body, dict) and isinstance(body.get("items"), list):
            body = {**body, "items": [{f: v for f, v in it.items() if f != "is_rep"} for it in body["items"]]}
        res[k] = (st, body)
    return res


def _differs(a: dict, b: dict) -> dict:
    return {k: (a[k], b[k]) for k in a if a[k] != b[k] and not any(m in k for m in CATALOG_META)}


@pytest.mark.parametrize("spec,latest_first", [
    ("catalog_incl_deleted", False),
    ("cell_rep,rep_pick_latest_first,acr_iter_unfolded,gap_in_population,catalog_incl_deleted", True),
])
@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI])
async def test_endpoints_a41_after_delete_equals_before(client_as, settings, uid, spec, latest_first):
    from app.core.config import set_settings
    from tests.core.test_cell_rep import _collect

    delete = f"UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = '{P1}' AND deleted_at IS NULL"
    try:
        set_settings(settings.model_copy(update={"legacy_profile": spec}))
        async with staged(_reseed(latest_first=latest_first)):
            before = await _collect(client_as, uid)
        async with staged(_reseed(delete, latest_first=latest_first)):
            after = await _collect(client_as, uid)
        set_settings(settings.model_copy(update={"legacy_profile": "off"}))
        async with staged(_reseed(delete, latest_first=latest_first)):
            off_after = await _collect(client_as, uid)
    finally:
        set_settings(settings)
    ok = [k for k in before if before[k][0] == 200]
    assert len(ok) >= 30, {k: v for k, v in before.items() if v[0] != 200}
    if not latest_first:
        # A41 만(hub 대표 규칙 투영): /v1/answers 행의 is_rep 표시값은 대표 투영 규칙을 따른다. hub 규칙은 전부 삭제된 프롬프트 셀에 대표를
        # 두지 않아(elig 후보) 그 답변의 표시값만 거짓이 된다. 모수·값은 같다. 현행 규칙 조합(아래 매개변수)은 표시값까지 같다
        after, before = _strip_is_rep(after), _strip_is_rep(before)
    diff = _differs(after, before)
    assert not diff, json.dumps({k: [str(a)[:300], str(b)[:300]] for k, (a, b) in list(diff.items())[:3]}, ensure_ascii=False)
    assert _differs(off_after, before)                                          # 새 정의(꺼짐)는 삭제분이 빠진다: 대조가 비어 있지 않다


# ── NAME 표시 브랜드 키 = 정본 표시명 문자열(2026-10-02 frz 4차: 'Smart'·'vivo' 40 회차) ───────────────────────────────────────
#   운영 생성기는 (brand_id, brand_name = canonBrandNameSql(COALESCE(names[rid], m.brand))) 로 접고 리더가 brand_name 으로 합산한다
#   (2670a16 lib/summary/generate/context.ts:134-145·load.ts:79-98, summary-trend-aggregates.ts:966-999). 그래서
#   ① 대소문자만 다른 두 롤업(Vivo·vivo)은 두 행, ② 경쟁사 도메인 토큰 정본('smart')이 언급 표기('Smart')를 덮지 않는다.
VA, VB, SM = (uuid.UUID(f"7a000000-0000-4000-8000-0000000000e{i}") for i in (1, 2, 3))
CASE_SQL = ("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, "
            "brand_rollup_entity_id, type_mention) VALUES "
            f"('2026-09-01', '90000000-0000-4000-8000-000000000001', 94, '{VA}', 'Zivo', 'Brand', 2, 6.0, '{VA}', 1), "
            f"('2026-09-01', '90000000-0000-4000-8000-000000000002', 94, '{VB}', 'zivo', 'Brand', 1, 6.0, '{VB}', 1), "
            f"('2026-09-01', '90000000-0000-4000-8000-000000000001', 95, '{SM}', 'Zmart', 'Brand', 3, 7.0, '{SM}', 1)",
            "INSERT INTO app.competitor_domain_token (token, brand_name) VALUES ('zmartzz', 'zmart')")
CASE_Q = """SELECT n.name, n.bare, n.kind, count(ab.answer_key) AS answers, coalesce(sum(ab.mention_count), 0) AS mentions
              FROM rd.dim_brand_name n LEFT JOIN rd.answer_brand ab ON ab.brand_key = n.brand_key
             WHERE lower(n.name) IN ('zivo', 'zmart') GROUP BY 1, 2, 3 ORDER BY 1"""


async def test_name_key_keeps_case_variants_like_production():
    async with staged(actor=ACTOR, role=None) as conn:
        await stage(conn, _reseed(*CASE_SQL, guc={"hgh.legacy_name": "1"}))
        on = await raw_fetch(conn, CASE_Q)
    async with staged(actor=ACTOR, role=None) as conn:
        await stage(conn, _reseed(*CASE_SQL))
        off = await raw_fetch(conn, CASE_Q)
    # 켜짐 = 운영: 표기마다 키, 표시명 = 그 문자열, 토큰 정본 'zmart' 는 언급 없는 별도 키(경쟁사 도메인 표시용)
    on, off = sorted(on, key=lambda r: r["name"].encode()), sorted(off, key=lambda r: r["name"].encode())   # 바이트 순(콜레이션 무관)
    assert [(r["name"], r["bare"], r["answers"], r["mentions"]) for r in on] == [
        ("Zivo", "Zivo", 1, 2), ("Zmart", "Zmart", 1, 3), ("zivo", "zivo", 1, 1), ("zmart", "zmart", 0, 0)]
    assert {r["kind"] for r in on} == {2}                                   # 경쟁 판정은 소문자 bare 로(자사·비경쟁 아님)
    # 꺼짐 = 새 정의: bare(소문자) 한 키로 접고 대표 표기 = 정본(토큰 'zmart') 우선
    assert [(r["name"].lower(), r["bare"], r["answers"], r["mentions"]) for r in off] == [("zivo", "zivo", 2, 3), ("zmart", "zmart", 1, 3)]
    assert next(r for r in off if r["bare"] == "zmart")["name"] == "zmart"   # 토큰 정본 우선(새 정의) = frz 4차 'smart' 의 원인


async def test_name_key_function_off_is_previous_bare():
    """name_key 꺼짐 = 종전 bare 식 lower(js_trim(x)) 와 같은 값(끔 바이트 동일), 켜짐 = 문자열 그대로(트림 뒤 빈 값만 '')."""
    from ingest.common.rules import ensure_session_rules

    async with staged(role=None) as conn:
        d = await _driver(conn)
        await ensure_session_rules(d)
        vals = ["Smart", "  vivo ", "ＫＧＭ", "", "   ", "기아", "Mercedes-Benz", None]
        q = "SELECT pg_temp.name_key(x), lower(pg_temp.js_trim(x)) FROM unnest($1::text[]) WITH ORDINALITY u(x, i) ORDER BY i"
        await d.execute("SELECT set_config('hgh.legacy_name', '', true)")
        off = await d.fetch(q, vals)
        assert all(r[0] == r[1] for r in off)
        await d.execute("SELECT set_config('hgh.legacy_name', '1', true)")
        on = [r[0] for r in await d.fetch(q, vals)]
        assert on == ["Smart", "  vivo ", "ＫＧＭ", "", "", "기아", "Mercedes-Benz", None]


# ── NAME 롤업 대표 표기 원장(DB-v2.26 P138): Brand 행이 원천에서 사라진 롤업 엔티티(frz 4차 Wahl·Sharp·Arrival, Scope S5 정리) ──────────
#   운영 names(ROLLUP_NAMES scope-aggregates.ts:238-254)는 생성 시점 미러 Brand 행이라 동결 세대 이름은 'Wahl'. 허브는 지금 원천에 Brand 행이
#   없으면 제품 행 표기로 떨어졌다. 켜짐 = 원장의 'Wahlx' 로 접고 비경쟁 명부(wahlx)로 경쟁에서 뺀다. 꺼짐 = 종전(제품 표기, 경쟁).
WX, WXP = uuid.UUID("7a000000-0000-4000-8000-0000000000f1"), uuid.UUID("7a000000-0000-4000-8000-0000000000f2")
LEDGER_SQL = ("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, "
              "brand_rollup_entity_id, type_mention) VALUES "
              f"('2026-09-01', '90000000-0000-4000-8000-000000000001', 96, '{WXP}', 'Opel Zed Motor', 'Product', 2, 8.0, '{WX}', 1)",
              f"INSERT INTO ing.entity_brand_name (entity_id, display_name, first_job) VALUES ('{WX}', 'Wahlx', '90000000-0000-4000-8000-000000000002')",
              "INSERT INTO app.non_competitor_name (name, bare_only_pattern) VALUES ('wahlx', NULL)")
LEDGER_Q = """SELECT n.name, n.kind, ab.competitive, ab.mention_count FROM rd.answer_brand ab JOIN rd.dim_brand_name n ON n.brand_key = ab.brand_key
               JOIN rd.job j ON j.answer_key = ab.answer_key
              WHERE j.job_id = '90000000-0000-4000-8000-000000000001' AND n.name IN ('Wahlx', 'Opel Zed Motor')"""


async def test_name_ledger_keeps_rollup_name_after_brand_rows_vanish():
    async with staged(actor=ACTOR, role=None) as conn:
        await stage(conn, _reseed(*LEDGER_SQL, guc={"hgh.legacy_name": "1"}))
        on = await raw_fetch(conn, LEDGER_Q)
        ent = await raw_fetch(conn, "SELECT rep_name FROM rd.dim_entity WHERE entity_id = $1", WX)
    async with staged(actor=ACTOR, role=None) as conn:
        await stage(conn, _reseed(*LEDGER_SQL))
        off = await raw_fetch(conn, LEDGER_Q)
    assert on == [{"name": "Wahlx", "kind": 3, "competitive": False, "mention_count": 2}]          # 운영 = 엔티티 이름, 비경쟁
    assert ent == [] or ent[0]["rep_name"] == "Wahlx"
    assert off == [{"name": "Opel Zed Motor", "kind": 2, "competitive": True, "mention_count": 2}]  # 꺼짐 = 종전(제품 표기로 대체)


async def test_name_ledger_trigger_and_refresh():
    """적재 쓰기(ing.mention INSERT·UPDATE)가 Brand 표기를 원장에 더하고 지워도 남는다. refresh 는 없는 쌍만 넣는다(멱등)."""
    e = uuid.UUID("7a000000-0000-4000-8000-0000000000f3")
    async with staged(role=None) as conn:
        d = await _driver(conn)
        assert await d.fetchval("SELECT count(*) FROM ing.mention m WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL AND NOT EXISTS "
                                "(SELECT 1 FROM ing.entity_brand_name b WHERE b.entity_id = m.entity_id AND b.display_name = m.display_name)") == 0
        await d.execute("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, brand_rollup_entity_id) "
                        f"VALUES ('2026-09-01', '90000000-0000-4000-8000-000000000001', 97, '{e}', 'Qwerty', 'Brand', 1, '{e}')")
        await d.execute(f"UPDATE ing.mention SET display_name = 'Qwertz' WHERE entity_id = '{e}'")
        await d.execute(f"DELETE FROM ing.mention WHERE entity_id = '{e}'")
        got = await d.fetch("SELECT display_name, first_job::text FROM ing.entity_brand_name WHERE entity_id = $1 ORDER BY 1", e)
        assert [tuple(r) for r in got] == [("Qwerty", "90000000-0000-4000-8000-000000000001"), ("Qwertz", "90000000-0000-4000-8000-000000000001")]
        assert await d.fetchval("SELECT rd.refresh_entity_brand_name()") == 0
