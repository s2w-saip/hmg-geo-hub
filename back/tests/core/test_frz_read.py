"""동결 층 S3·S4 읽기 치환(현행 프로필 freeze_at_publish, DB-v2.23 카드·격자 뷰 + DB-v2.24 웹 셀 판정·택소노미 축·브랜드 표시명) API 시험.
롤백 전용(staged), 합성 픽스처.

시나리오(픽스처 발행 회차: 글로벌 10·11, 웹 21 을 S2 생성기 frz.freeze_cycle 로 동결):
  GEN    동결 뒤 같은 셀에서 다른 답변이 대표가 된다(is_rep 이동 = 현행 생성 뒤 재측정): 카드 값 = 동결 셀, 라이브(스위치 끔) 값은 바뀐다
  보관   동결 답변의 언급이 바뀐다(rd 재적재 모양): 카드 값 = 동결 시점, 라이브는 새 값
  게이트 동결 프롬프트 축 in_full_cycle 거짓 → 카드 모수에서 그 셀이 빠진다(현행 trendWhere in_full_cycle = 1)
  구멍   창에 세대 없는 발행 회차가 있으면 요청 전체가 비카드(현행 cycle-set.ts:336-357 미러 폴백) = card=false 응답과 같다(S4)
  스냅샷 최신 발행 회차에 동결 세대가 없으면 직전 동결 회차를 낸다(현행 픽 active_generation_id IS NOT NULL), 동결 회차가 하나도 없으면 비카드
  웹     보고 유닛 소속·⑥ 유닛 flat 타겟 = 생성 시점 셀 판정(frz.card_web). 동결 뒤 유닛 명세·타겟이 바뀌어도 카드 값은 그대로, 제외 유닛은 조회 시점
  축     택소노미 필터 = 생성 시점 축(frz.card_axis, 현행 summary_prompt_dim 최근 수정 행 값). depth2·3 기간 = 비카드(현행 미러)
  이름   브랜드 표시명 = 생성 시점 이름(frz.card_brand_name)
  끔     스위치 끔 응답 = 동결 층이 있어도 라이브(바이트 비교는 응답 지문 하네스, 여기서는 값)
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

import pytest
from sqlalchemy import text

from app.core.config import set_settings
from app.core.cycles import CycleRow, frz_judge
from tests.core.test_web_accuracy import PREP as WEB_PREP
from tests.core.test_web_accuracy import _fetch as web_recount
from tests.support import ADMIN, KIA_EU, Sql, needs_db, resolve_test_profile, staged

pytestmark = needs_db
ON = "freeze_at_publish,cell_rep,catalog_incl_deleted,rep_pick_latest_first,web_registered_only"
WEB_ON = ON + ",summary_all_engines,web_accuracy_flat"
FREEZE = """
SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key IN (10, 11, 21) ORDER BY cyc_key;
"""
SUMMARY = "/v1/kpi/summary"
PERIOD = {"from": "2026-09-01", "to": "2026-09-30"}


def _profile(settings: Any, spec: str) -> None:
    set_settings(settings.model_copy(update={"legacy_profile": resolve_test_profile(spec)}))


async def _get(client_as: Any, path: str, who: Any = ADMIN, **params: Any) -> dict:
    async with client_as(who) as c:
        r = await c.get(path, params=params)
    assert r.status_code == 200, r.text
    d = r.json()
    return {"data": d["data"], "as_of": d["meta"].get("as_of")}


async def _both(client_as: Any, settings: Any, path: str, **params: Any) -> tuple[dict, dict]:
    _profile(settings, ON)
    on = await _get(client_as, path, card="true", **params)
    _profile(settings, "off")
    off = await _get(client_as, path, card="true", **params)
    return on, off


def _diff(a: Any, b: Any, path: str = "") -> list[str]:
    """다른 경로(실패 메시지용)."""
    if isinstance(a, dict) and isinstance(b, dict):
        return [p for k in sorted(set(a) | set(b)) for p in _diff(a.get(k), b.get(k), f"{path}.{k}")]
    return [] if a == b else [f"{path}: {a!r} != {b!r}"]


async def _owner(conn: Any, sql: str, *args: Any) -> Any:
    """요청 롤(api_ro) 연결에서 소유자로 한 문장(준비 단계 뒤 변경용)."""
    await conn.execute(text("RESET ROLE").execution_options(hgh_sql_guard=False))
    try:
        return (await conn.execute(text(sql).execution_options(hgh_sql_guard=False), *args))
    finally:
        await conn.execute(text("SET ROLE api_ro").execution_options(hgh_sql_guard=False))


CARD_QUERIES = [
    (SUMMARY, {"surface": "global"}),
    (SUMMARY, {"surface": "global", **PERIOD}),
    ("/v1/mentions/brands", {"surface": "global", "top_n": "20"}),
    ("/v1/geo", {"surface": "global"}),
    ("/v1/citations/domains", {"surface": "global"}),
    ("/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none", "metrics": ["visibility", "share_of_voice", "citation_share"]}),
    (SUMMARY, {"surface": "website"}),
]


def test_frz_judge_rule():
    """현행 classifyCycleRange 대응(순수): 구멍 = 숨김 아님 ∧ 세대 없음 → 거짓, 숨김 회차는 면제, 쓸 회차(세대 ∧ 전체 숨김 아님)가 없으면 거짓."""
    d = date(2026, 9, 7)

    def r(k: int, hid: int = 0) -> CycleRow:
        return CycleRow(k, 1, d, hid)
    assert frz_judge([r(1), r(2)], frozenset({1, 2}))
    assert not frz_judge([r(1), r(2)], frozenset({1}))                 # 구멍
    assert frz_judge([r(1), r(2, hid=2)], frozenset({1}))              # 인용 숨김 회차의 세대 없음 = 면제(집합에서만 빠진다)
    assert frz_judge([r(1), r(2, hid=1)], frozenset({1}))              # 전체 숨김 = 면제
    assert not frz_judge([r(1, hid=1)], frozenset({1}))                # 쓸 회차 없음(전체 숨김뿐) = 현행 빈 집합
    assert not frz_judge([], frozenset())
    assert not frz_judge([r(2, hid=2)], frozenset())                   # 숨김뿐 ∧ 세대 없음 = 쓸 회차 없음


async def test_frozen_values_survive_rep_move_and_mention_change(client_as, settings):
    """GEN·보관: 동결 뒤 rd 의 대표 이동·언급 변경은 카드(켬) 값에 들어가지 않고, 끔(라이브)에는 들어간다."""
    async with staged(Sql(FREEZE)) as conn:
        before = {i: await _both(client_as, settings, p, **q) for i, (p, q) in enumerate(CARD_QUERIES)}
        # 대표 이동: 회차 11 셀 대표 하나를 내리고 같은 셀 다른 답변을 올린다(대표만 바뀐 UPDATE = 보관 없음, 동결 셀이 그대로 이긴다)
        mv = (await _owner(conn, """
            WITH c AS (SELECT a.answer_key, a.prompt_key, a.engine_key, a.geo_key FROM rd.answer a
                        WHERE a.surface = 1 AND a.cyc_key = 11 AND a.is_rep AND EXISTS (
                              SELECT 1 FROM rd.answer b WHERE b.surface = 1 AND b.cyc_key = 11 AND NOT b.is_rep AND b.prompt_key = a.prompt_key
                                 AND b.engine_key = a.engine_key AND b.geo_key = a.geo_key) LIMIT 1)
            SELECT answer_key FROM c""")).scalar()
        assert mv is not None, "전제: 회차 11 에 대표가 아닌 답변이 있는 셀"
        await _owner(conn, f"""UPDATE rd.answer x SET is_rep = (x.answer_key <> {int(mv)})
                                FROM rd.answer a WHERE a.answer_key = {int(mv)} AND x.surface = 1 AND x.cyc_key = 11
                                 AND x.prompt_key = a.prompt_key AND x.engine_key = a.engine_key AND x.geo_key = a.geo_key""")
        # 언급 변경: 회차 11 동결 답변 하나의 브랜드 언급 +3. 적재 관문(_write_facts)과 같은 순서로 보관 관문을 지난다(DB-v2.21 P117:
        # keep_rewrite → 다시 쓰기 → keep_settle). 관문 밖 직접 SQL 은 보관하지 않는다(설계 12.11)
        ch = (await _owner(conn, """SELECT b.answer_key FROM rd.answer_brand b JOIN frz.cell c ON c.answer_key = b.answer_key AND c.cyc_key = 11
                                    WHERE b.competitive ORDER BY b.answer_key LIMIT 1""")).scalar()
        await _owner(conn, f"SELECT frz.keep_rewrite(ARRAY[{int(ch)}], 'apply')")
        await _owner(conn, f"UPDATE rd.answer_brand SET mention_count = mention_count + 3 WHERE answer_key = {int(ch)} AND competitive")
        await _owner(conn, f"UPDATE rd.answer SET ment_total = ment_total + 3 WHERE answer_key = {int(ch)}")
        await _owner(conn, f"SELECT frz.keep_settle(ARRAY[{int(ch)}], 'apply')")
        assert (await _owner(conn, "SELECT count(*) FROM frz.kept")).scalar() >= 1
        after = {i: await _both(client_as, settings, p, **q) for i, (p, q) in enumerate(CARD_QUERIES)}
        for i, (p, q) in enumerate(CARD_QUERIES):
            assert after[i][0] == before[i][0], (p, q, "카드(켬) 값이 동결 뒤 rd 변경을 따라갔다")
        changed = [i for i in after if after[i][1] != before[i][1]]
        assert changed, "전제: 라이브(끔) 값은 rd 변경을 따라간다"


async def test_full_cycle_gate_drops_cells_on_card_only(client_as, settings):
    trend = {"surface": "global", "bucket": "cycle", "dimension": "none", "metrics": ["visibility", "share_of_voice"], "card": "true"}
    async with staged(Sql(FREEZE)) as conn:
        on0, off0 = await _both(client_as, settings, SUMMARY, surface="global")
        _profile(settings, ON + ",trend_grid")
        tr0 = await _get(client_as, "/v1/trend", **trend)
        _profile(settings, ON)
        tc0 = await _get(client_as, "/v1/trend", **trend)
        pk = (await _owner(conn, """SELECT p.prompt_key FROM frz.prompt p JOIN frz.generation g ON g.gen_key = p.gen_key AND g.state = 'active'
                                     WHERE p.cyc_key = 11 ORDER BY p.prompt_key LIMIT 1""")).scalar()
        cnt = ("SELECT count(*) FROM frz.{v} WHERE surface = 1 AND round_date BETWEEN '2026-09-01' AND '2026-09-30' "
               "AND cyc_key = ANY(ARRAY[10, 11])")
        gate0, grid0 = (await _owner(conn, cnt.format(v="card_answer"))).scalar(), (await _owner(conn, cnt.format(v="grid_answer"))).scalar()
        await _owner(conn, f"UPDATE frz.prompt SET in_full_cycle = false WHERE cyc_key = 11 AND prompt_key = {int(pk)}")
        on1, off1 = await _both(client_as, settings, SUMMARY, surface="global")
        _profile(settings, ON + ",trend_grid")
        assert await _get(client_as, "/v1/trend", **trend) == tr0, "글로벌 추이 격자는 in_full_cycle 게이트가 없다(격자 뷰)"
        _profile(settings, ON)
        assert await _get(client_as, "/v1/trend", **trend) != tc0, "격자 밖 카드 추이는 게이트가 걸린다(카드 뷰)"
        assert off1 == off0, "끔(라이브)은 동결 축을 보지 않는다"
        assert on1 != on0, "켬: in_full_cycle 거짓 프롬프트 셀이 카드 모수에서 빠진다"
        assert on1["data"]["params"]["measured_prompts"] == on0["data"]["params"]["measured_prompts"] - 1 or \
            json.dumps(on1["data"]) != json.dumps(on0["data"])
        gate1, grid1 = (await _owner(conn, cnt.format(v="card_answer"))).scalar(), (await _owner(conn, cnt.format(v="grid_answer"))).scalar()
        n_cells = (await _owner(conn, f"SELECT count(*) FROM frz.cell WHERE cyc_key = 11 AND prompt_key = {int(pk)}")).scalar()
        assert gate0 - gate1 == n_cells > 0 and grid1 == grid0


HOLE_QUERIES = [
    (SUMMARY, {"surface": "global", **PERIOD}),
    ("/v1/mentions/brands", {"surface": "global", "top_n": "20", **PERIOD}),
    ("/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none", "metrics": ["visibility", "share_of_voice"]}),
]


async def _close_cycle(conn: Any, cyc: int, *, completed: int, gap: int, ops: tuple[str | None, str] | None = None) -> None:
    """원장 회차 cyc 를 닫힘(미발행)으로: ing.cycle·rd.cycle 카운터(갭 = gap / completed)와 이관 현행 갭(ops = (갭 원값, 현행 상태))을 쓰고
    창 판정 기초(rd.cycle_pick_basis)를 다시 계산한다(적재기 원장 투영 ingest.cycles.ledger.service.project_cycles 와 같은 호출)."""
    await _owner(conn, f"UPDATE ing.cycle SET status = 'closed', closed_by = 'operator', closed_at = now(), completed_answers = {completed}, "
                       f"gap_answers = {gap} WHERE cyc_key = {cyc}")
    await _owner(conn, f"UPDATE rd.cycle SET status = 1, servable = false, view_date = NULL, completed_answers = {completed}, "
                       f"gap_answers = {gap} WHERE cyc_key = {cyc}")
    await _owner(conn, f"DELETE FROM ing.cycle_ops_gap WHERE cycle_id = (SELECT cycle_id FROM ing.cycle WHERE cyc_key = {cyc})")
    if ops is not None:
        await _owner(conn, f"INSERT INTO ing.cycle_ops_gap (cycle_id, analysis_gap_ratio, ops_status) SELECT cycle_id, "
                           f"{ops[0] or 'NULL'}, '{ops[1]}' FROM ing.cycle WHERE cyc_key = {cyc}")
    await _owner(conn, f"SELECT rd.refresh_cycle_pick_basis(ARRAY(SELECT cycle_id FROM ing.cycle WHERE cyc_key = {cyc}))")


async def test_closed_unpublished_cycle_hole_and_skip(client_as, settings):
    """현행 judgeCycleRange(cycle-set.ts:345-357·400-401)의 닫힌 미발행 회차: 갭 ≤ 0.05(생성기 --pending 이 뽑을 회차, generate/cycle.ts:288)
    ∧ 세대 없음 = 구멍(요청 전체 미러), 갭 초과·NULL = isGeneratorSkipped(:967-971) 면제. 허브 창 후보(servable ∧ 노출일)에는 오지 않으므로
    core.cycles.pick_holes 가 rd.cycle_pick_basis 로 따로 판정한다(DB-v2.30). 판정 갭 = 이관 회차는 현행 원값(ing.cycle_ops_gap),
    아니면 허브 카운터. 현행 상태 generating(이관 투영이 closed 로 접은 재생성 중)은 구멍 아님.
    회차 12(글로벌 09-21, 창 안, 세대 없음, 픽스처 open)를 닫아 본다. 글로벌 현행 기간 행은 함대 가시 술어가 없다(summary-cycles.ts:558)."""
    q = {"surface": "global", **PERIOD}
    async with staged(Sql(FREEZE)) as conn:
        _profile(settings, ON)
        await _live_change(conn, 11)                                             # 동결 값 ≠ 라이브 값(판별 전제: 비카드로 내려가면 값이 바뀐다)
        base = await _get(client_as, SUMMARY, card="true", **q)
        plain = await _get(client_as, SUMMARY, **q)
        assert base != plain
        await _close_cycle(conn, 12, completed=10, gap=5)                        # 허브 갭 0.5 > 0.05 = 면제(현행 지문: 갭 초과 19건)
        assert await _get(client_as, SUMMARY, card="true", **q) == base, "갭 초과 닫힌 회차(현행 면제)가 구멍으로 세였다"
        await _close_cycle(conn, 12, completed=0, gap=0)                         # 갭 NULL(완료 답변 0) = 면제(3값 논리)
        assert await _get(client_as, SUMMARY, card="true", **q) == base, "갭 NULL 닫힌 회차(현행 면제)가 구멍으로 세였다"
        await _close_cycle(conn, 12, completed=20, gap=1)                        # 허브 갭 0.05 = 생성 대기 = 구멍(현행 81b57005·43125e03 유형)
        assert await _get(client_as, SUMMARY, card="true", **q) == plain, "생성 대기 회차(현행 구멍)가 있는데 동결 읽기를 했다"
        await _close_cycle(conn, 12, completed=180, gap=5, ops=("0.05556", "closed"))   # 허브 0.028 이지만 현행 원값 0.05556(fca32e3e 유형) = 면제
        assert await _get(client_as, SUMMARY, card="true", **q) == base, "이관 회차는 현행 갭으로 판정해야 한다"
        await _close_cycle(conn, 12, completed=20, gap=0, ops=("0.00000", "generating"))  # 현행 재생성 중 = 구멍 아님
        assert await _get(client_as, SUMMARY, card="true", **q) == base
        await _close_cycle(conn, 12, completed=20, gap=0, ops=("0.00000", "closed"))
        assert await _get(client_as, SUMMARY, card="true", **q) == plain
        # 숨김(전체·인용 무관) = 면제(cycle-set.ts:345 hidden)
        await _owner(conn, "UPDATE rd.cycle SET hidden_scope = 2, hidden_reason = 2 WHERE cyc_key = 12")
        assert await _get(client_as, SUMMARY, card="true", **q) == base
        # 대조: 발행·노출일 지남(세대 없음)이면 후보 구멍(frz_judge)
        await _owner(conn, "UPDATE rd.cycle SET hidden_scope = 0, hidden_reason = 0, status = 2, servable = true, view_date = DATE '2026-09-23' WHERE cyc_key = 12")
        assert await _get(client_as, SUMMARY, card="true", **q) == await _get(client_as, SUMMARY, **q)   # 비카드 창에 회차 12 가 든다


async def _add_web_cycle(conn: Any, anchor: str, *, expected: int) -> int:
    """웹 프로젝트(회차 21 의 프로젝트)에 닫힌 미발행 회차를 원장에 열고(ing.cycle) 적재기 투영 문장으로 rd.cycle·창 판정 기초를 맞춘다."""
    from ingest.cycles.ledger.queries import PROJECT_CYCLES, REFRESH_PICK_BASIS

    cid = (await _owner(conn, f"""
        INSERT INTO ing.cycle (surface, scope_project_id, cycle_anchor_at, anchor_source, anchor_date, round_date, status, closed_by, closed_at,
                               expected_units, completed_units, completed_answers, gap_answers)
        SELECT 'website', c.scope_project_id, TIMESTAMPTZ '{anchor}', 'scope', (TIMESTAMPTZ '{anchor}' AT TIME ZONE 'Asia/Seoul')::date,
               (TIMESTAMPTZ '{anchor}' AT TIME ZONE 'Asia/Seoul')::date, 'closed', 'operator', now(), {expected}, {expected}, 20, 0
          FROM ing.cycle c WHERE c.cyc_key = 21 RETURNING cycle_id""")).scalar()
    await _owner(conn, PROJECT_CYCLES.replace("$1::uuid[]", f"ARRAY['{cid}']::uuid[]"))
    await _owner(conn, REFRESH_PICK_BASIS.replace("$1::uuid[]", f"ARRAY['{cid}']::uuid[]"))
    return int((await _owner(conn, f"SELECT cyc_key FROM ing.cycle WHERE cycle_id = '{cid}'")).scalar())


async def test_web_pick_hole_follows_fleet_visible(client_as, settings):
    """웹 현행 기간 행은 함대 가시 술어(summary-cycles.ts:558)라 같은 (프로젝트, UTC 주)의 패자 회차는 행 자체가 없다 = 구멍 아님. 함대 가시는
    현행 cycleFleetSql(summary-cycles.ts:1577-1597: 지금 노출 → 노출 앵커 → expected 큰 쪽 → 앵커 늦은 쪽) 재계산(rd.cycle_pick_basis).
    stg 실측(2026-10-02): 닫힘·갭 이하 웹 회차 중 함대 비가시 7건(현행 행 밖)은 구멍이 아니고, 함대 가시 2건(81b57005·43125e03)만 구멍."""
    q = {"surface": "website", **PERIOD}
    try:
        _profile(settings, WEB_ON)
        async with staged(*WEB_PREP) as conn:
            await _owner(conn, "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key = 21")
            await _live_change(conn, 21)
            base = await _get(client_as, SUMMARY, KIA_EU, card="true", **q)
            plain = await _get(client_as, SUMMARY, KIA_EU, **q)
            assert base != plain                                                 # 판별 전제
            anchor21 = (await _owner(conn, "SELECT cycle_anchor_at FROM ing.cycle WHERE cyc_key = 21")).scalar()
            # 회차 21 과 같은 UTC 주, expected 더 큼: 21 은 노출 중이라 이긴다(1단) → 새 회차는 함대 비가시 = 구멍 아님
            same = await _add_web_cycle(conn, (anchor21 + timedelta(hours=30)).isoformat(), expected=999)
            vis = (await _owner(conn, f"SELECT p.cyc_key, p.fleet_visible FROM rd.cycle_pick_basis p WHERE p.cyc_key IN (21, {same})")).all()
            assert dict((int(k), v) for k, v in vis) == {21: True, same: False}, vis
            assert await _get(client_as, SUMMARY, KIA_EU, card="true", **q) == base, "함대 비가시 닫힌 회차가 구멍으로 세였다"
            # 다른 주(창 안) 혼자 = 함대 가시 → 생성 대기 구멍 = 요청 전체 비카드
            other = await _add_web_cycle(conn, (anchor21 + timedelta(days=7)).isoformat(), expected=10)
            assert (await _owner(conn, f"SELECT fleet_visible FROM rd.cycle_pick_basis WHERE cyc_key = {other}")).scalar() is True
            assert await _get(client_as, SUMMARY, KIA_EU, card="true", **q) == await _get(client_as, SUMMARY, KIA_EU, **q)
    finally:
        set_settings(settings)


async def test_hole_in_window_goes_live_and_snapshot_pick(client_as, settings):
    """구멍·스냅샷(S4): 창에 세대 없는 발행 회차가 있으면 요청 전체 = 비카드(card=false 응답과 같다), 다 동결되면 동결 값.
    스냅샷 = 최신 동결 회차(없으면 비카드)."""
    async with staged() as conn:
        _profile(settings, ON)
        snap_none = await _get(client_as, SUMMARY, surface="global", card="true")              # 동결 회차 없음 → 비카드(최신 11)
        assert snap_none == await _get(client_as, SUMMARY, surface="global")
        # 픽스처 회차 10 답변은 전부 분석 갭(analysis_state 2 → std_in 거짓)이라 언급 계열 모수 밖이다. 그대로면 아래 언급 변경이 어느 투영에서도
        # 화면 값에 안 나타나 '동결 = 옛 값' 단언이 공허하다(끔 투영의 full != hole 은 회차 11 셀 차이로 우연히 성립했다). 동결 전에 분석 완료로 둔다
        # (std_in_nc 는 answer_nc_rule 이 analysis_state 와 묶는다)
        await _owner(conn, "UPDATE rd.answer SET analysis_state = 0, std_in_nc = cit_in_nc WHERE cyc_key = 10")
        await _owner(conn, "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key = 10")
        snap10 = await _get(client_as, SUMMARY, surface="global", card="true")
        assert snap10["as_of"] == "2026-09-07" and snap_none["as_of"] == "2026-09-14", (snap10["as_of"], snap_none["as_of"])
        # 동결 회차 10 의 값을 적재 관문 순서로 바꾼다(keep_rewrite → 다시 쓰기 → keep_settle = 옛 행 보관): 구멍 창은 바뀐 라이브 값, 다 동결되면 옛 값
        ch = (await _owner(conn, "SELECT c.answer_key FROM frz.cell c WHERE c.cyc_key = 10 ORDER BY c.answer_key LIMIT 1")).scalar()
        await _owner(conn, f"SELECT frz.keep_rewrite(ARRAY[{int(ch)}], 'apply')")
        await _owner(conn, f"UPDATE rd.answer SET ment_total = ment_total + 5 WHERE answer_key = {int(ch)}")
        await _owner(conn, f"SELECT frz.keep_settle(ARRAY[{int(ch)}], 'apply')")
        hole = {i: await _get(client_as, p, card="true", **q) for i, (p, q) in enumerate(HOLE_QUERIES)}
        plain = {i: await _get(client_as, p, **q) for i, (p, q) in enumerate(HOLE_QUERIES)}
        for i, (p, q) in enumerate(HOLE_QUERIES):
            assert hole[i] == plain[i], (p, q, "구멍 창 카드 요청 = 비카드 요청(현행 요청 전체 미러 폴백)")
        await _owner(conn, "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key = 11")
        full = await _get(client_as, SUMMARY, card="true", surface="global", **PERIOD)
        assert full != hole[0], "다 동결되면 동결 값(회차 10 의 바뀐 언급은 들어가지 않는다)"
        # 투영(끔·켬)과 무관한 독립 재계산: 바뀐 셀은 동결 카드 모수 안이고, 카드 뷰는 옛 행(보관)을 읽으며, 응답 = 동결 카드 행 재계산
        pop = "surface = 1 AND cyc_key = ANY(ARRAY[10, 11]) AND std_in AND dflt AND bgrp <> 0"
        in_pop = (await _owner(conn, f"SELECT count(*) FROM frz.card_answer WHERE {pop} AND answer_key = {int(ch)}")).scalar()
        old_m = (await _owner(conn, f"SELECT ment_total FROM frz.card_answer WHERE answer_key = {int(ch)}")).scalar()
        new_m = (await _owner(conn, f"SELECT ment_total FROM rd.answer WHERE answer_key = {int(ch)}")).scalar()
        assert in_pop == 1 and new_m == old_m + 5, (in_pop, old_m, new_m)
        rc = (await _owner(conn, f"SELECT count(*), coalesce(sum(ment_total), 0) FROM frz.card_answer WHERE {pop}")).one()
        sov = full["data"]["share_of_voice"]
        assert (full["data"]["params"]["answers"], sov["den"]) == (rc[0], rc[1]), (full["data"]["params"], sov, tuple(rc))
        await _owner(conn, f"UPDATE rd.answer SET ment_total = ment_total - 5 WHERE answer_key = {int(ch)}")   # 관문 밖(보관 그대로)
        assert await _get(client_as, SUMMARY, card="true", surface="global", **PERIOD) == full
        n = (await _owner(conn, "SELECT count(*) FROM frz.card_answer WHERE surface = 1 AND cyc_key = ANY(ARRAY[10, 11])")).scalar()
        assert n > 0
        # 카드 뷰에는 비동결 회차 갈래가 없다(P126): 회차 11 세대를 풀면 그 회차 행이 뷰에서 사라진다
        await _owner(conn, "SELECT frz.release(gen_key, 'test') FROM frz.generation WHERE cyc_key = 11 AND state = 'active'")
        assert (await _owner(conn, "SELECT count(*) FROM frz.card_answer WHERE cyc_key = 11")).scalar() == 0


async def test_web_unit_and_accuracy_are_generation_time(client_as, settings):
    """웹(S4): 동결 회차 21 의 ⑥(유닛 flat)·유닛 모수 = 생성 시점 판정. 기대값 = rd 행 재계산(test_web_accuracy 의 현행 식). 동결 뒤 유닛 명세를
    지우고 타겟을 바꿔도 카드 값은 그대로, 제외 유닛(현행도 조회 시점)은 바로 빠진다."""
    params = {"surface": "website", "card": "true"}
    try:
        _profile(settings, WEB_ON)
        async with staged(*WEB_PREP) as conn:
            unit, _, _ = await web_recount(conn)
            await _owner(conn, "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key = 21")
            flags = (await _owner(conn, "SELECT count(*) FILTER (WHERE unit_owned), count(*) FILTER (WHERE unit_owned AND unit_target), "
                                        "count(*) FILTER (WHERE report_fs IS NOT NULL) FROM frz.card_web WHERE cyc_key = 21")).one()
            assert (flags[1], flags[0]) == unit and flags[2] > 0, (flags, unit)
            b0 = await _get(client_as, SUMMARY, KIA_EU, **params)
            acc = b0["data"]["citation_accuracy"]
            assert (acc["num"], acc["den"]) == unit == (2, 2)
            # 동결 뒤: 유닛 명세·타겟 변경(조회 시점 판정이면 모수 0·분자 0)
            await _owner(conn, "DELETE FROM rd.web_report_prompt")
            await _owner(conn, "UPDATE rd.dim_prompt SET targets = '{}' WHERE surface = 2")
            b1 = await _get(client_as, SUMMARY, KIA_EU, **params)
            assert b1 == b0, "카드 값이 동결 뒤 유닛·타겟 변경을 따라갔다"
            _profile(settings, "cell_rep,summary_all_engines,web_registered_only")             # 동결 없는 유닛 게이트 = 조회 시점(대조)
            live = await _get(client_as, SUMMARY, KIA_EU, **params)
            assert live["data"]["params"]["answers"] == 0 != b0["data"]["params"]["answers"]
            _profile(settings, WEB_ON)
            fs = (await _owner(conn, "SELECT min(report_fs) FROM frz.card_web WHERE cyc_key = 21 AND report_fs IS NOT NULL")).scalar()
            await _owner(conn, f"INSERT INTO app.website_report_excluded (file_seq) VALUES ({int(fs)})")
            b2 = await _get(client_as, SUMMARY, KIA_EU, **params)
            assert b2["data"]["params"]["answers"] < b0["data"]["params"]["answers"], "제외 유닛은 조회 시점(현행 summary_settings)"
    finally:
        set_settings(settings)


async def test_taxonomy_filter_uses_generation_axis(client_as, settings):
    """축(S4): 동결 회차의 퍼널 필터 = 생성 시점 축(현행 summary_prompt_dim.funnel_catalog = 루트 카탈로그 최근 수정 행 값). 동결 뒤 카탈로그
    퍼널이 바뀌어도 카드 값은 그대로(끔은 따라간다). 축 값은 app.prompt 를 파이썬으로 다시 풀어 대조한다."""
    q = {"surface": "global", "funnel": ["F1"]}
    async with staged(Sql(FREEZE)) as conn:
        rows = (await _owner(conn, """SELECT d.prompt_key, p.funnel_stage, p.updated_at, p.prompt_id::text FROM app.prompt p
                                        JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
                                        JOIN rd.dim_prompt d ON d.prompt_id = p.scope_prompt_id""")).all()
        axis = dict((await _owner(conn, """SELECT x.prompt_key, t.code FROM frz.card_axis x LEFT JOIN rd.dim_taxon t ON t.taxon_key = x.funnel_key
                                             WHERE x.cyc_key = 11""")).all())
        for pk, code in axis.items():
            if not any(r[0] == pk for r in rows):
                assert code is None, (pk, code)                                     # 루트 카탈로그 행 없음 = 축 없음(현행 funnel_catalog NULL)
                continue
            ts_max = max(r[2] for r in rows if r[0] == pk)
            cands = sorted({r[1] for r in rows if r[0] == pk and r[2] == ts_max})
            assert code in cands, (pk, code, cands)
        on0, off0 = await _both(client_as, settings, SUMMARY, **q)
        # 독립 재계산: 스냅샷(회차 11) 동결 카드 셀 중 언급 모수(셀 대표 ∧ std_in_nc, 동결 카탈로그 비트 ≠ 0)이고 생성 시점 퍼널 = F1 인 프롬프트 수
        want = (await _owner(conn, """SELECT count(DISTINCT a.prompt_key) FROM frz.card_answer a
                                        JOIN frz.card_axis x ON x.cyc_key = a.cyc_key AND x.prompt_key = a.prompt_key
                                        JOIN rd.dim_taxon t ON t.taxon_key = x.funnel_key AND t.code = 'F1'
                                       WHERE a.cyc_key = 11 AND a.std_in_nc AND a.bgrp <> 0""")).scalar()
        assert on0["data"]["params"]["measured_prompts"] == want > 0, (on0["data"]["params"], want)
        f1 = "(SELECT taxon_key FROM rd.dim_taxon WHERE axis = 'funnel' AND code = 'F1')"
        f2 = "(SELECT taxon_key FROM rd.dim_taxon WHERE axis = 'funnel' AND code = 'F2')"
        # 동결 뒤 카탈로그 퍼널 변경(조회 시점 해석 rd.catalog_entry): 회차 11 측정 프롬프트 하나의 F1 행을 F2 로(값 F1 은 다른 행에 남는다)
        pk = (await _owner(conn, f"""SELECT ce.prompt_key FROM rd.catalog_entry ce JOIN frz.card_axis x ON x.prompt_key = ce.prompt_key AND x.cyc_key = 11
                                     WHERE ce.funnel_key = {f1} AND x.funnel_key = {f1} ORDER BY 1 LIMIT 1""")).scalar()
        assert pk is not None
        await _owner(conn, f"UPDATE rd.catalog_entry SET funnel_key = {f2} WHERE prompt_key = {int(pk)}")
        assert (await _owner(conn, f"SELECT count(*) FROM rd.catalog_entry WHERE funnel_key = {f1}")).scalar() > 0
        on1, off1 = await _both(client_as, settings, SUMMARY, **q)
        # 적용 프롬프트(params.applied_prompts)는 현행도 카탈로그 카운트(조회 시점, server.ts:3795 "미러 아님")라 동결 대상이 아니다
        assert _diff(on0, on1) == [".data.params.applied_prompts: 3 != 2"], ("카드 값이 동결 뒤 카탈로그 퍼널 변경을 따라갔다", _diff(on0, on1))
        assert off1 != off0, "전제: 끔(조회 시점 해석)은 따라간다"
        # F1 이 지금 카탈로그에서 사라져도(조회 시점 해석 = 버림) 동결 회차는 생성 시점 축으로 거른다
        await _owner(conn, f"UPDATE rd.catalog_entry SET funnel_key = {f2} WHERE funnel_key = {f1}")
        on2, _ = await _both(client_as, settings, SUMMARY, **q)
        assert [d for d in _diff(on0, on2) if "applied_prompts" not in d] == []
        # depth2 기간 = 현행 미러(planTrendRead depth2 → 기간이면 미러): 켬 카드 요청 = 비카드 요청
        _profile(settings, ON)
        d2 = {"surface": "global", "depth2": ["D2a"], **PERIOD}
        assert await _get(client_as, SUMMARY, card="true", **d2) == await _get(client_as, SUMMARY, **d2)


async def test_brand_display_name_is_generation_time(client_as, settings):
    """이름(S4): 동결 뒤 브랜드 표시명이 바뀌어도 카드 브랜드 목록은 생성 시점 이름, 끔은 새 이름."""
    async with staged(Sql(FREEZE)) as conn:
        on0, _ = await _both(client_as, settings, "/v1/mentions/brands", surface="global", top_n="20")
        comp = sorted(i["name"] for i in on0["data"]["brands"] if not i.get("is_own") and i.get("brand_key"))
        assert comp, on0["data"]["brands"]
        old = comp[0]
        await _owner(conn, f"UPDATE rd.dim_brand_name SET name = '{old} Renamed' WHERE name = '{old}'")
        on1, off1 = await _both(client_as, settings, "/v1/mentions/brands", surface="global", top_n="20")
        assert on1 == on0
        assert f"{old} Renamed" in {i["name"] for i in off1["data"]["brands"]}


async def _dropped(client_as: Any, path: str, **params: Any) -> dict:
    async with client_as(ADMIN) as c:
        r = await c.get(path, params=params)
    assert r.status_code == 200, r.text
    return r.json()["meta"].get("dropped_filters") or {}


async def test_dropped_filters_follow_frozen_axis(client_as, settings):
    """버림 메타(S4b): 동결 읽기는 창 동결 회차의 생성 시점 축으로 '없음'을 판정한다. 지금 카탈로그에서 사라졌지만 동결 축에 있는 값은 버림이
    아니고(그 값으로 거른다), 동결 축에 없는 값(F9 = 루트 밖 프로젝트 행에만)은 버림. 비동결(끔)은 조회 시점 관점 카탈로그 판정 그대로."""
    q = {"surface": "global", "funnel": ["F1", "F9"]}
    async with staged(Sql(FREEZE)) as conn:
        f1 = "(SELECT taxon_key FROM rd.dim_taxon WHERE axis = 'funnel' AND code = 'F1')"
        f2 = "(SELECT taxon_key FROM rd.dim_taxon WHERE axis = 'funnel' AND code = 'F2')"
        await _owner(conn, f"UPDATE rd.catalog_entry SET funnel_key = {f2} WHERE funnel_key = {f1}")
        _profile(settings, ON)
        on = await _dropped(client_as, SUMMARY, card="true", **q)
        on_trend = await _dropped(client_as, "/v1/trend", card="true", bucket="cycle", dimension="none", metrics=["visibility"], **q)
        _profile(settings, "off")
        off = await _dropped(client_as, SUMMARY, card="true", **q)
    assert off.get("funnel") == ["F1", "F9"], off
    assert on.get("funnel") == ["F9"] and on_trend.get("funnel") == ["F9"], (on, on_trend)


async def test_renamed_brand_splits_by_generation_name(client_as, settings):
    """이름(S4b): 회차 10 동결 뒤 브랜드 표시명이 바뀌고 회차 11 이 새 이름으로 동결되면, 두 회차 기간 카드에서 그 브랜드는 세대 이름별 두 행
    (현행 summary_trend_brands 키 = brand_name). 두 행 합 = 개명 없는 기간 값(가산), 추이 브랜드 계열도 이름별 두 계열."""
    brands_q = {"surface": "global", "top_n": "50", **PERIOD}
    trend_q = {"surface": "global", "bucket": "cycle", "dimension": "brand", "metrics": ["share_of_voice"], "top": "50", **PERIOD}
    async with staged(Sql(FREEZE)) as conn:
        # 전제: 회차 11 의 경쟁 브랜드 행 하나를 회차 10 동결 셀 답변에도 둔다(픽스처 회차 10 에는 브랜드 행이 없다)
        k = (await _owner(conn, """SELECT b.brand_key FROM rd.answer_brand b JOIN rd.dim_brand_name n ON n.brand_key = b.brand_key
                                    WHERE b.surface = 1 AND b.cyc_key = 11 AND b.is_rep AND b.competitive AND n.own_bit = 0 ORDER BY 1 LIMIT 1""")).scalar()
        cols = (await _owner(conn, "SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute "
                                   "WHERE attrelid = 'rd.answer_brand'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''")).scalar()
        await _owner(conn, f"""INSERT INTO rd.answer_brand ({cols}) SELECT {cols} FROM (
            SELECT (jsonb_populate_record(NULL::rd.answer_brand, to_jsonb(b) || jsonb_build_object('answer_key', a.answer_key, 'cyc_key', a.cyc_key,
                    'round_date', a.round_date, 'prompt_key', a.prompt_key, 'engine_key', a.engine_key, 'geo_key', a.geo_key, 'bgrp', a.bgrp,
                    'is_rep', true, 'std_in', true, 'std_in_nc', true))).*
              FROM (SELECT * FROM rd.answer_brand WHERE surface = 1 AND cyc_key = 11 AND brand_key = {int(k)} AND competitive LIMIT 1) b
             CROSS JOIN (SELECT x.* FROM frz.card_answer x WHERE x.surface = 1 AND x.cyc_key = 10 ORDER BY x.answer_key LIMIT 1) a) z""")
        # 회차 10 세대 이름을 그 행까지 포함해 다시 굽는다(세대가 처음부터 그 브랜드를 가졌던 상태)
        await _owner(conn, "DELETE FROM frz.brand_name WHERE gen_key = (SELECT gen_key FROM frz.generation WHERE cyc_key = 10 AND state = 'active')")
        await _owner(conn, "SELECT frz._bake_names(gen_key) FROM frz.generation WHERE cyc_key = 10 AND state = 'active'")
        _profile(settings, ON)
        b0 = await _get(client_as, "/v1/mentions/brands", card="true", **brands_q)
        old = (await _owner(conn, f"SELECT name FROM rd.dim_brand_name WHERE brand_key = {int(k)}")).scalar()
        # 회차 11 만 새 이름으로 다시 동결(세대 이름 = 굽는 시점 rd 이름)
        await _owner(conn, f"UPDATE rd.dim_brand_name SET name = name || ' New' WHERE brand_key = {int(k)}")
        await _owner(conn, "SELECT frz.release(gen_key, 'test') FROM frz.generation WHERE cyc_key = 11 AND state = 'active'")
        await _owner(conn, "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key = 11")
        b1 = await _get(client_as, "/v1/mentions/brands", card="true", **brands_q)
        t1 = await _get(client_as, "/v1/trend", card="true", **trend_q)
    rows0 = [i for i in b0["data"]["brands"] if i.get("brand_key") == k]
    rows1 = [i for i in b1["data"]["brands"] if i.get("brand_key") == k]
    assert len(rows0) == 1 and sorted(i["name"] for i in rows1) == sorted([old, old + " New"]), (rows0, rows1)
    assert sum(i["mentions"] for i in rows1) == rows0[0]["mentions"]
    ser = [x for x in t1["data"]["series"] if x.get("brand_key") == k]
    assert sorted(x["label"] for x in ser) == sorted([old, old + " New"]), ser


async def _card_eq_plain(client_as: Any, path: str, who: Any = ADMIN, **q: Any) -> tuple[dict, dict]:
    return await _get(client_as, path, who, card="true", **q), await _get(client_as, path, who, **q)


async def _live_change(conn: Any, cyc: int) -> str | None:
    """동결 회차 cyc 의 답변을 적재 관문 순서로 바꾼다(옛 행 보관): 동결 값 ≠ 라이브 값이 되게(경쟁 브랜드가 있는 답변 = 언급 합·경쟁 언급 +5,
    호스트 인용이 있는 답변 = 인용 하나 삭제). 반환 = 지운 인용의 출처 카테고리 slug(없으면 None)."""
    ch = (await _owner(conn, f"""SELECT c.answer_key FROM frz.cell c WHERE c.cyc_key = {cyc}
                                  ORDER BY EXISTS (SELECT 1 FROM rd.answer_brand b WHERE b.answer_key = c.answer_key AND b.competitive) DESC,
                                           c.answer_key LIMIT 1""")).scalar()
    cc = (await _owner(conn, f"""SELECT x.answer_key FROM frz.card_citation x WHERE x.cyc_key = {cyc} AND x.source_key <> 0
                                  ORDER BY x.answer_key LIMIT 1""")).scalar()
    keys = ",".join(str(int(k)) for k in {ch, cc} if k is not None)
    await _owner(conn, f"SELECT frz.keep_rewrite(ARRAY[{keys}], 'apply')")
    await _owner(conn, f"UPDATE rd.answer SET ment_total = ment_total + 5 WHERE answer_key = {int(ch)}")
    await _owner(conn, f"UPDATE rd.answer_brand SET mention_count = mention_count + 5 WHERE answer_key = {int(ch)} AND competitive")
    slug = None
    if cc is not None:
        slug = (await _owner(conn, f"""SELECT g.slug FROM rd.citation c JOIN rd.dim_source ds ON ds.source_key = c.source_key
                                        JOIN app.citation_category g ON g.category_key = ds.category_key
                                       WHERE c.answer_key = {int(cc)} AND c.source_key <> 0 ORDER BY c.ord LIMIT 1""")).scalar()
        await _owner(conn, f"""DELETE FROM rd.citation WHERE answer_key = {int(cc)}
                                 AND ord = (SELECT min(ord) FROM rd.citation WHERE answer_key = {int(cc)} AND source_key <> 0)""")
    await _owner(conn, f"SELECT frz.keep_settle(ARRAY[{keys}], 'apply')")
    return slug


async def test_ops_fallback_reasons_go_live(client_as, settings):
    """현행 사실표 이탈 사유(S4b, FrozenRoute 표): 동결 회차뿐인 창이어도 현행이 미러로 보내는 요청은 비카드 응답과 같다(동결 뒤 라이브 변경을
    넣어 동결 값 ≠ 라이브 값인 상태에서). 출처 필터(게이트 G2) · depth2(브랜드 카드는 스냅샷도 미러) · 당사 변형 없음(관점 브랜드 둘, 브랜드·GEO)
    · GEO depth2(GEO 는 스냅샷도 미러) · 추이 점 하나 · 빈 집계(기간: 동결 프롬프트 축 in_full_cycle 거짓 = 동결 카드 행 0).
    출처 필터는 웹 도메인 카드 시험(test_source_filter_goes_live)에서: 픽스처 글로벌 동결 회차에는 호스트 인용이 없다."""
    async with staged(Sql(FREEZE)) as conn:
        await _live_change(conn, 11)
        _profile(settings, ON)
        cases = [
            ("/v1/mentions/brands", {"surface": "global", "top_n": "20", "depth2": ["D2a"]}),
            ("/v1/mentions/brands", {"surface": "global", "top_n": "20", "brand": ["Hyundai", "Kia"]}),
            ("/v1/geo", {"surface": "global", "brand": ["Hyundai"], "depth2": ["D2a"]}),
            ("/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none", "metrics": ["visibility", "share_of_voice"],
                           "from": "2026-09-14", "to": "2026-09-14"}),
        ]
        bad = []
        for path, q in cases:
            card, plain = await _card_eq_plain(client_as, path, **q)
            if card != plain:
                bad.append((path, sorted(q), _diff(card, plain)[:3]))
        await _owner(conn, "UPDATE frz.prompt SET in_full_cycle = false WHERE cyc_key IN (10, 11)")
        card, plain = await _card_eq_plain(client_as, SUMMARY, surface="global", **PERIOD)
        if card != plain or not plain["data"]["params"]["answers"] > 0:
            bad.append(("empty-period", [], _diff(card, plain)[:3]))
        assert bad == [], [(p, q) for p, q, _ in bad]


async def test_source_filter_goes_live(client_as, settings):
    """출처 필터(현행 게이트 G2 unsupported-filter:source-category, gate.ts:200-204) = 미러: 웹 도메인 카드(인용 지원 축)에 전 카테고리를 걸면
    값은 무필터와 같고 축만 걸린다. 동결 뒤 인용 하나를 지운 상태에서 비카드 응답과 같다."""
    async with staged(*WEB_PREP, Sql(FREEZE)) as conn:
        assert await _live_change(conn, 21) is not None
        slugs = list((await _owner(conn, "SELECT array_agg(slug ORDER BY slug) FROM app.citation_category")).scalar())
        _profile(settings, WEB_ON)
        frozen = await _get(client_as, "/v1/citations/domains", KIA_EU, card="true", surface="website")
        card, plain = await _card_eq_plain(client_as, "/v1/citations/domains", KIA_EU, surface="website", source=slugs)
    assert card == plain, _diff(card, plain)
    assert frozen["data"]["summary"] != plain["data"]["summary"], "전제: 동결 값 ≠ 라이브 값"


async def test_ops_detail_reasons_stay_frozen(client_as, settings):
    """같은 사유라도 현행 목적지가 세부층(생성 시점 값)이면 동결 읽기 그대로(S4b): 글로벌 KPI 스냅샷의 depth2·빈 집계."""
    async with staged(Sql(FREEZE)) as conn:
        _profile(settings, ON)
        d2 = {"surface": "global", "depth2": ["D2a"]}
        on0 = await _get(client_as, SUMMARY, card="true", **d2)
        empty0 = await _get(client_as, SUMMARY, card="true", surface="global", engine=["deepseek"])
        ch = (await _owner(conn, "SELECT c.answer_key FROM frz.cell c WHERE c.cyc_key = 11 ORDER BY c.answer_key LIMIT 1")).scalar()
        await _owner(conn, f"SELECT frz.keep_rewrite(ARRAY[{int(ch)}], 'apply')")
        await _owner(conn, f"UPDATE rd.answer SET ment_total = ment_total + 5 WHERE answer_key = {int(ch)}")
        await _owner(conn, f"SELECT frz.keep_settle(ARRAY[{int(ch)}], 'apply')")
        assert await _get(client_as, SUMMARY, card="true", **d2) == on0
        assert await _get(client_as, SUMMARY, card="true", surface="global", engine=["deepseek"]) == empty0


async def test_website_duplicate_week_goes_live(client_as, settings):
    """같은 (프로젝트, 주)에 동결 웹 회차 둘이면 현행 duplicate-cycle-in-week(cycle-set.ts:412-419) = 미러: 비카드 응답과 같다."""
    async with staged(*WEB_PREP, Sql(FREEZE)) as conn:
        await _owner(conn, """
            INSERT INTO ing.cycle (cycle_id, surface, scope_project_id, cycle_anchor_at, anchor_source, anchor_date, round_date, status, closed_by, closed_at,
                                   view_anchor_at, published_at)
            VALUES ('f0000000-0000-4000-8000-0000000000d2', 'website', 'a0000000-0000-4000-8000-000000000002', '2026-09-16 01:00+00', 'scope',
                    '2026-09-16', '2026-09-16', 'published', 'complete', '2026-09-17', '2026-09-17', '2026-09-17')""")
        await _owner(conn, """
            INSERT INTO rd.cycle SELECT (jsonb_populate_record(NULL::rd.cycle, to_jsonb(t) || jsonb_build_object(
                     'cyc_key', c.cyc_key, 'cycle_id', c.cycle_id, 'round_date', c.round_date, 'anchor_date', c.anchor_date,
                     'view_date', c.anchor_date + 1, 'hidden_scope', 0, 'hidden_reason', 0, 'servable', true, 'status', 2))).*
              FROM ing.cycle c CROSS JOIN (SELECT * FROM rd.cycle WHERE cyc_key = 21) t WHERE c.cycle_id = 'f0000000-0000-4000-8000-0000000000d2'""")
        await _owner(conn, "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cycle_id = 'f0000000-0000-4000-8000-0000000000d2'")
        await _live_change(conn, 21)
        _profile(settings, WEB_ON)
        card, plain = await _card_eq_plain(client_as, SUMMARY, KIA_EU, surface="website", **PERIOD)
        assert card == plain, _diff(card, plain)


async def test_url_rates_uncovered_go_live_alone(client_as, settings):
    """URL 인용률(S4b): 창 세대 중 url_hits 없는 이관 세대가 있으면 현행은 자사·타겟 URL 인용률 2장만 미러(server.ts:5527-5542). 허브 = 그 계열만
    비카드 값, ⑥(동결 유닛 플래그)·나머지 카드는 동결 그대로."""
    try:
        _profile(settings, WEB_ON)
        async with staged(*WEB_PREP) as conn:
            unit, _, _ = await web_recount(conn)
            await _owner(conn, "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key = 21")
            # 발행값(현행 reportTruth 우선)이 없는 상태: URL 인용률 = 라이브 값 경로(사실표 또는 미러)
            await _owner(conn, "UPDATE app.report_publication SET status = 'superseded' WHERE status = 'active'")
            covered = await _get(client_as, SUMMARY, KIA_EU, surface="website", card="true")
            # 동결 뒤 라이브 URL 플래그 변경(관문 순서): 답변 22 의 자기 프롬프트 타겟 적중을 끈다(동결 값 ≠ 라이브 값)
            await _owner(conn, "SELECT frz.keep_rewrite(ARRAY[22], 'apply')")
            await _owner(conn, "UPDATE rd.answer SET tgt_cited = false, cit_tgt = 0 WHERE answer_key = 22")
            await _owner(conn, "SELECT frz.keep_settle(ARRAY[22], 'apply')")
            frozen_flags = await _get(client_as, SUMMARY, KIA_EU, surface="website", card="true")
            assert frozen_flags == covered, "덮인 세대: URL 인용률도 동결 값"
            await _owner(conn, "UPDATE frz.generation SET source = 'ops', ops_generation_id = gen_random_uuid(), "
                               "judgment = judgment || '{\"url_hits_covered\": false}'::jsonb WHERE cyc_key = 21 AND state = 'active'")
            card, plain = await _card_eq_plain(client_as, SUMMARY, KIA_EU, surface="website")
    finally:
        set_settings(settings)
    for k in ("target_url_rate", "owned_url_rate", "url_prompts"):
        assert card["data"][k] == plain["data"][k], (k, card["data"][k], plain["data"][k])
    assert card["data"]["url_prompts"] != covered["data"]["url_prompts"], "전제: 라이브 URL 값이 동결 값과 다르다"
    acc = card["data"]["citation_accuracy"]
    assert (acc["num"], acc["den"]) == unit and card["data"]["citation_accuracy"] == covered["data"]["citation_accuracy"]
    assert card["data"]["visibility"] == covered["data"]["visibility"]


async def test_compare_counts_unfrozen_cycle_as_missing(client_as, settings):
    """기간 비교(S4): 현행은 구멍으로 폴백하지 않고 세대 없는 회차를 미발행(누락 비중)으로 센다(summary-period-compare.ts:57-62·184-185).
    값 = 동결 회차만. 회차 11 을 동결하면 그 회차가 발행·값에 들어온다."""
    q = {"surface": "global", "kind": "window", "metrics": ["visibility"], **PERIOD}
    async with staged() as conn:
        await _owner(conn, "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key = 10")
        _profile(settings, ON)
        one = (await _get(client_as, "/v1/kpi/compare", card="true", **q))["data"][0]
        n10 = (await _owner(conn, "SELECT count(*) FROM frz.card_answer WHERE surface = 1 AND cyc_key = 10")).scalar()
        await _owner(conn, "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key = 11")
        two = (await _get(client_as, "/v1/kpi/compare", card="true", **q))["data"][0]
        _profile(settings, "off")
        off = (await _get(client_as, "/v1/kpi/compare", card="true", **q))["data"][0]
    assert one["cycles_cur"] == 1 and two["cycles_cur"] == 2 == off["cycles_cur"], (one, two, off)
    assert one["missing_share_cur"] > 0 and two["missing_share_cur"] == 0, (one, two)
    assert one["cur"]["den"] <= n10 and one["cur"]["den"] < two["cur"]["den"], json.dumps([one, two, off, n10])   # 값 = 동결 회차 행만


@pytest.mark.parametrize("path,params", CARD_QUERIES[:3])
async def test_switch_off_ignores_frozen_layer(client_as, settings, path, params):
    async with staged():
        _profile(settings, "off")
        a = await _get(client_as, path, card="true", **params)
    async with staged(Sql(FREEZE)) as conn:
        await _owner(conn, "UPDATE frz.prompt SET in_full_cycle = false")
        _profile(settings, "off")
        b = await _get(client_as, path, card="true", **params)
    assert a == b
