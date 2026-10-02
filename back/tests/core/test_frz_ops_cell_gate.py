"""동결 층 셀 게이트 회귀(be/int3-frztrend): 현행 셀 집합(summary_cycle_jobs)은 게이트 없이 (프롬프트, 엔진, 지역)마다 최신 completed 답변을
굳히고(scripts/summary/surface-global.ts:465-477) run_status·in_tagged_region·숨김 국가는 조회 때 건다(summary-trend-aggregates.ts:674-753
trendWhere). 허브 동결 셀도 같은 규칙이다(이관 = 운영 셀 그대로, 생성 = frz.freeze_cycle 의 같은 셀 선정). 동결 뷰는 is_rep 을 참으로 고정하므로
동결 읽기 모수가 그 게이트를 다시 걸어야 한다(core.measure.frozen_gate). 롤백 전용(staged), 합성 픽스처.

stg 증상(대조 키트 kit-b4d, 끔 = 구인데 켬만 다름 154키):
  C01·C03·C05  7월 주 점 값이 약 6배(C01 07-06 가시성 분모 켬 2,136 대 끔·구 356): 7월 회차 셀의 42%가 게이트 밖(한국어 비-KR 태깅 전 측정)
  C02·C06      끔·구에 없는 과거 주 점이 켬에만(기아 US 7월 동결 셀 416 전부 게이트 밖)
시나리오:
  게이트   픽스처 회차 10·11 동결. 생성기가 셀로 굳힌 게이트 밖 답변(3 = 한국어 프롬프트 US 태깅 전, 5 = 태깅 {US} 프롬프트의 DE, 7 = 숨김 ID)에
           과거 자리(회차 10, 09-07) 게이트 밖 셀 하나를 더한다. 켬 값 = 그 셀들을 동결 층에서 지운 켬 값(오라클: 게이트 안 셀만의 동결 층).
           끔(라이브)은 동결 셀과 무관하게 불변. 기아 DE 추이는 동결 셀이 게이트 밖뿐이라 어느 자리에도 값이 없다(점이 켬에만 생기지 않는다)
  같은 주  같은 round_date 에 동결 회차가 둘(앵커가 이른 형제 회차)이고 퇴역 세대가 같은 셀을 들고 있어도 자리 대표 활성 세대만 센다(기각 가설 H2)
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import text

from app.core.config import set_settings
from tests.support import ADMIN, Sql, needs_db, resolve_test_profile, staged

pytestmark = needs_db
# 켬 = stg 배포 프로필(구현된 스위치 전부: acr_iter_unfolded·gap_in_population 이 켜져 언급 모수가 is_rep 하나뿐인 형, 회귀가 난 형).
# 끔 = 대조 키트 live(같은 프로필에서 동결 스위치와 그에 딸린 스위치만 뺀 것: frz-s4/stg/drive-frz.py)
ON = "implemented"
FRZ_ONLY = ("freeze_at_publish", "rep_round_date_cell", "web_accuracy_flat", "brand_card_fold")
LIVE = ",".join(n for n in resolve_test_profile("implemented").split(",") if n not in FRZ_ONLY)
FREEZE = "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key IN (10, 11) ORDER BY cyc_key"
TREND_M = ["visibility", "share_of_voice", "sentiment", "position", "citation_share"]
KIA_DE = 2
QUERIES = [
    ("/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none", "metrics": TREND_M, "brand": ["Hyundai"]}),
    ("/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none", "metrics": TREND_M, "brand": ["Kia"]}),
    ("/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none", "metrics": TREND_M, "brand": ["Kia"], "country": ["DE"]}),
    ("/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none", "metrics": TREND_M, "country": ["US"]}),
    ("/v1/kpi/summary", {"surface": "global"}),
    ("/v1/kpi/summary", {"surface": "global", "from": "2026-09-01", "to": "2026-09-30"}),
    ("/v1/mentions/brands", {"surface": "global", "top_n": "20"}),
    ("/v1/geo", {"surface": "global"}),
    ("/v1/citations/domains", {"surface": "global"}),
]
# 자리 대표 규칙(현행 restrictToSlotRepresentative)이 있는 질의: 추이 격자·기간 카드. 스냅샷 카드는 최신 round_date 의 회차 전부를 창에 넣는다
# (켬·끔 같은 동작, 현행 pickGlobalCycle 은 회차 하나: 같은 round_date 형제 회차가 있으면 다르다 = 이 회귀 밖 기록 과제)
SLOT_REP = (0, 1, 2, 3, 5)
OUTSIDE = (3, 5, 7)                               # 생성기가 셀로 굳힌 게이트 밖 답변(회차 11)
PAST_KEY = 9005                                   # 과거 자리(회차 10, 09-07)에 더할 게이트 밖 답변(답변 5 사본)
CELLS = "surface = 1 AND cyc_key = ANY(ARRAY[10, 11])"


async def _owner(conn: Any, sql: str) -> Any:
    await conn.execute(text("RESET ROLE").execution_options(hgh_sql_guard=False))
    r = await conn.execute(text(sql).execution_options(hgh_sql_guard=False))     # 실패면 그 오류를 그대로(복원 문장이 가리지 않게)
    await conn.execute(text("SET ROLE api_ro").execution_options(hgh_sql_guard=False))
    return r


async def _get(client_as: Any, settings: Any, spec: str, path: str, params: dict) -> dict:
    set_settings(settings.model_copy(update={"legacy_profile": resolve_test_profile(spec)}))
    async with client_as(ADMIN) as c:
        r = await c.get(path, params={**params, "card": "true"})
    assert r.status_code == 200, (path, params, r.text)
    d = r.json()
    return {"data": d["data"], "as_of": d["meta"].get("as_of")}


async def _all(client_as: Any, settings: Any, spec: str) -> list[dict]:
    try:
        return [await _get(client_as, settings, spec, p, q) for p, q in QUERIES]
    finally:
        set_settings(settings)


def _points(resp: dict) -> dict[tuple[str, str], Any]:
    """추이 응답 → (지표, 버킷) → 값(갭이면 'gap', 값 없음이면 None)."""
    return {(s["metric"], p["bucket"]): ("gap" if p.get("gap") else (p.get("ratio") or p.get("rank")))
            for s in resp["data"]["series"] for p in s["points"]}


async def _count(conn: Any, view: str, where: str) -> int:
    return int((await _owner(conn, f"SELECT count(*) FROM frz.{view} WHERE {where}")).scalar())


async def _answer_cols(conn: Any) -> list[str]:
    return [r[0] for r in (await _owner(conn, """SELECT attname FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attnum > 0
                                                  AND NOT attisdropped AND attgenerated = '' ORDER BY attnum""")).all()]


async def _add_past_outside_cell(conn: Any) -> None:
    """과거 자리(회차 10)에 게이트 밖 셀: 답변 5(태깅 {US} 프롬프트 6 의 DE 답변) 사본 rd 행 + 회차 10 활성 세대 셀·프롬프트 축(운영 셀 모양)."""
    cols = await _answer_cols(conn)
    sub = {"answer_key": str(PAST_KEY), "round_date": "DATE '2026-09-07'", "anchor_date": "DATE '2026-09-07'", "cyc_key": "10", "is_rep": "false"}
    await _owner(conn, f"INSERT INTO rd.answer ({', '.join(cols)}) SELECT {', '.join(sub.get(c, 'a.' + c) for c in cols)} "
                       "FROM rd.answer a WHERE a.surface = 1 AND a.answer_key = 5")
    await _owner(conn, """INSERT INTO frz.prompt (gen_key, prompt_key, cyc_key, in_full_cycle, expected_cells, window_cells, in_root_catalog,
                                                  catalog_deleted, cat_mask, regions, is_korean)
                          SELECT g.gen_key, d.prompt_key, 10, true, 1, 1, true, false, d.cat_mask_all, d.regions, d.is_korean
                            FROM rd.dim_prompt d JOIN frz.generation g ON g.cyc_key = 10 AND g.state = 'active'
                           WHERE d.prompt_key = (SELECT prompt_key FROM rd.answer WHERE surface = 1 AND answer_key = 5)
                          ON CONFLICT (gen_key, prompt_key) DO NOTHING""")
    await _owner(conn, f"""INSERT INTO frz.cell (gen_key, answer_key, surface, cyc_key, round_date, prompt_key, engine_key, geo_key)
                           SELECT g.gen_key, a.answer_key, a.surface, a.cyc_key, a.round_date, a.prompt_key, a.engine_key, a.geo_key
                             FROM rd.answer a JOIN frz.generation g ON g.cyc_key = a.cyc_key AND g.state = 'active'
                            WHERE a.surface = 1 AND a.answer_key = {PAST_KEY}""")
    # 회차 11 의 DE 셀(답변 5)도 카드 뷰 게이트(in_full_cycle) 안으로: 운영 이관 축은 그 프롬프트가 full-cycle 이면 참이다
    await _owner(conn, """UPDATE frz.prompt SET in_full_cycle = true, cat_mask = 2
                           WHERE cyc_key = ANY(ARRAY[10, 11]) AND prompt_key = (SELECT prompt_key FROM rd.answer WHERE surface = 1 AND answer_key = 5)""")


async def test_ops_cells_outside_gate_do_not_count(client_as, settings):
    """게이트: 게이트 밖 동결 셀(현재·과거 자리)은 켬 값에 들어가지 않는다. 켬 = 게이트 안 셀만의 동결 층 켬 값, 끔 불변."""
    async with staged(Sql(FREEZE)) as conn:
        await _add_past_outside_cell(conn)
        keys = [*OUTSIDE, PAST_KEY]
        # 전제(판별력): 게이트 밖 셀이 격자·카드 뷰에 보이고(게이트가 없으면 켬 값에 들어간다) 브랜드·인용 행도 있다
        assert await _count(conn, "grid_answer", f"{CELLS} AND answer_key = ANY(ARRAY{keys}) AND NOT cit_in_nc") == len(keys)
        assert await _count(conn, "card_answer", f"{CELLS} AND answer_key = ANY(ARRAY{keys}) AND NOT cit_in_nc") == len(keys)
        assert await _count(conn, "grid_answer_brand", "answer_key = 3 AND NOT std_in_nc") > 0
        assert await _count(conn, "grid_citation", "answer_key = 5 AND NOT cit_in_nc") > 0
        assert await _count(conn, "grid_answer", f"{CELLS} AND cyc_key = 10 AND geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'DE')") == 1
        on_with = await _all(client_as, settings, ON)
        live_with = await _all(client_as, settings, LIVE)
        # 오라클: 게이트 밖 셀을 동결 층에서 지운 켬 값(게이트 안 셀만 = 현행 trendWhere 를 지난 행만)
        await _owner(conn, f"DELETE FROM frz.cell WHERE answer_key = ANY(ARRAY{keys})")
        assert await _count(conn, "grid_answer", f"{CELLS} AND NOT cit_in_nc") == 0
        on_without = await _all(client_as, settings, ON)
        live_without = await _all(client_as, settings, LIVE)
        for i, (p, q) in enumerate(QUERIES):
            assert on_with[i] == on_without[i], (p, q, "켬: 게이트 밖 동결 셀이 값에 들어갔다")
            assert live_with[i] == live_without[i], (p, q, "끔(라이브)은 동결 셀과 무관해야 한다")
        # 과거 주 경계(C02·C06 모양): 기아 DE 동결 셀은 게이트 밖뿐 → 어느 자리(과거 09-07 포함)에도 값이 없다
        kde = _points(on_with[KIA_DE])
        assert {b for _, b in kde} >= {"2026-09-07", "2026-09-14"} and all(v in ("gap", None) for v in kde.values()), kde


async def test_sibling_cycle_and_retired_generation_do_not_double(client_as, settings):
    """같은 주: 같은 round_date(09-14)에 앵커가 이른 형제 회차 13 이 동결 세대를 갖고, 회차 11 의 퇴역 세대가 같은 셀을 들고 있어도
    추이 자리·카드 값은 자리 대표(회차 11) 활성 세대만 센다(현행 자리 대표: 늦은 앵커, cycle-set.ts:189-192)."""
    async with staged(Sql(FREEZE)) as conn:
        on0 = await _all(client_as, settings, ON)
        live0 = await _all(client_as, settings, LIVE)
        cols = await _answer_cols(conn)
        sub = {"answer_key": "a.answer_key + 8000", "cyc_key": "13"}
        await _owner(conn, """INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable,
                                                    view_date, hidden_scope, generation, hidden_reason, expected_units, completed_units,
                                                    completed_answers, gap_answers)
                              SELECT 13, 'f0000000-0000-4000-8000-000000000013', surface, project_key, ledger_backed, round_date, anchor_date - 1,
                                     status, servable, view_date, hidden_scope, generation, hidden_reason, expected_units, completed_units,
                                     completed_answers, gap_answers FROM rd.cycle WHERE cyc_key = 11""")
        await _owner(conn, f"INSERT INTO rd.answer ({', '.join(cols)}) SELECT {', '.join(sub.get(c, 'a.' + c) for c in cols)} "
                           "FROM rd.answer a WHERE a.surface = 1 AND a.cyc_key = 11")
        g11 = int((await _owner(conn, "SELECT gen_key FROM frz.generation WHERE cyc_key = 11 AND state = 'active'")).scalar())
        for cyc, state, akey in ((13, "active", "answer_key + 8000"), (11, "retired", "answer_key")):
            retired = state == "retired"
            gk = int((await _owner(conn, f"""
                INSERT INTO frz.generation (cyc_key, surface, source, state, activated_at, retired_at, retired_reason)
                VALUES ({cyc}, 1, 'hub', '{state}', now(), {"now()" if retired else "NULL"}, {"'test'" if retired else "NULL"})
                RETURNING gen_key""")).scalar())
            await _owner(conn, f"""INSERT INTO frz.prompt (gen_key, prompt_key, cyc_key, in_full_cycle, expected_cells, window_cells, in_root_catalog,
                                                           catalog_deleted, cat_mask, funnel_key, regions, is_korean)
                                   SELECT {gk}, prompt_key, {cyc}, in_full_cycle, expected_cells, window_cells, in_root_catalog, catalog_deleted,
                                          cat_mask, funnel_key, regions, is_korean FROM frz.prompt WHERE gen_key = {g11}""")
            await _owner(conn, f"""INSERT INTO frz.cell (gen_key, answer_key, surface, cyc_key, round_date, prompt_key, engine_key, geo_key)
                                   SELECT {gk}, {akey}, surface, {cyc}, round_date, prompt_key, engine_key, geo_key FROM frz.cell WHERE gen_key = {g11}""")
        n11 = await _count(conn, "grid_answer", "surface = 1 AND cyc_key = 11")
        assert n11 > 0 and await _count(conn, "grid_answer", "surface = 1 AND cyc_key = 13") == n11, "전제: 형제 회차 동결 셀이 격자 뷰에 보인다"
        assert await _count(conn, "grid_answer", "surface = 1 AND round_date = DATE '2026-09-14'") == 2 * n11
        on1 = await _all(client_as, settings, ON)
        live1 = await _all(client_as, settings, LIVE)
        for i in SLOT_REP:
            p, q = QUERIES[i]
            assert on1[i] == on0[i], (p, q, "켬: 같은 주 형제 회차·퇴역 세대가 값에 들어갔다")
            assert live1[i] == live0[i], (p, q, "끔: 형제 회차 rd 행은 자리 대표가 아니다")
