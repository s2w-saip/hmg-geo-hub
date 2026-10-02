"""WU-12 답변분석 경로 셀 대표(DB-v2.19 P109·P110, 현행 프로필 rep_round_date_cell) DB 시험. 롤백 전용(staged, 소유자 연결).

현행(hmg-geo 2670a16) 대표 규칙 둘:
  답변분석(미러 앵커 축 scope-aggregates.ts:1820-1851 + cell-snapshot.ts:104-115) = round_date 마다 셀(프롬프트, 엔진, 답변 region) 1건,
    후보 = 완료·지역 스코핑(elig_nc) ∧ 기간 술어(서빙·노출·숨김 계열), 원본 시각 DESC, job_id DESC → rd.answer.is_rep(+ 인용 계열 보정 rd.rep_cit_delta)
  카드(집계층 생성기 surface-global.ts:464-478) = 회차 셀 최신 1건: 동결 스냅샷 층 결정 대기로 보류(카드 요청도 is_rep 을 읽는다)
픽스처 회차 11(09-14) 셀(prompt 01·chatgpt·US)을 복제해 같은 자리(round_date)에 회차 9911 을 두고(더 늦은 측정 J9'), 규칙·보정 표·조회 술어를 대조한다.
"""
from __future__ import annotations

import dataclasses
import uuid
from typing import Any

import pytest

from app.core import measure as M
from app.core import profile as P
from app.core.db import fetch_all
from tests.support import needs_db, staged

pytestmark = needs_db

J9 = uuid.UUID("90000000-0000-4000-8000-000000000009")          # 회차 11 셀 대표(09-14 05:00)
J9B = uuid.UUID("90000000-0000-4000-8000-0000000099b9")         # 복제: 같은 자리·같은 셀, 회차 9911, 09-14 06:00
CLONE = f"""
INSERT INTO rd.cycle SELECT (jsonb_populate_record(NULL::rd.cycle, to_jsonb(c) || jsonb_build_object(
    'cyc_key', 9911, 'cycle_id', '00000000-0000-4000-8000-000000009911'))).* FROM rd.cycle c WHERE c.cyc_key = 11;
INSERT INTO rd.job SELECT (jsonb_populate_record(NULL::rd.job, to_jsonb(j) || jsonb_build_object(
    'answer_key', 999001, 'job_id', '{J9B}', 'cyc_key', 9911, 'measured_at', '2026-09-14T06:00:00+00:00'))).* FROM rd.job j WHERE j.job_id = '{J9}';
"""


async def _clone(d: Any) -> None:
    """회차 11 을 9911 로, J9 답변을 J9'(answer_key 999001)로 복제. rd.answer 생성 열(acr_in·std_in 등)은 빼고 넣는다."""
    await d.execute(CLONE)
    cols = await d.fetchval("SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute "
                            "WHERE attrelid = 'rd.answer'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''")
    await d.execute(f"""INSERT INTO rd.answer ({cols}) SELECT {cols} FROM (
        SELECT (jsonb_populate_record(NULL::rd.answer, to_jsonb(a) || jsonb_build_object('answer_key', 999001, 'cyc_key', 9911, 'is_rep', false))).*
          FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key WHERE j.job_id = '{J9}') x""")
PROF = P.LegacyProfile(cell_rep=True, rep_pick_latest_first=True, rep_round_date_cell=True, freeze_at_publish=True,
                       catalog_incl_deleted=True, web_registered_only=True)   # rep_round_date_cell 은 동결 층과 함께(core.profile.REQUIRES)


async def _raw(conn: Any) -> Any:
    raw = await conn.get_raw_connection()
    return raw.driver_connection


async def _rules(d: Any) -> dict:
    rows = await d.fetch("""SELECT j.job_id, r.rep_ana, r.rep_ana_c FROM rd.rep_rules(ARRAY[1]::int2[], ARRAY[DATE '2026-09-14'], NULL, NULL) r
                              JOIN rd.job j ON j.answer_key = r.answer_key WHERE j.job_id = ANY($1::uuid[])""", [J9, J9B])
    return {r["job_id"]: (r["rep_ana"], r["rep_ana_c"]) for r in rows}


async def _pop(conn: Any, card: bool, family: str, keys: tuple[int, ...] = (11, 9911)) -> set:
    """조회 모수 술어(rep_term)가 고르는 대표(셀 두 답변 중). 소유자 연결에서 core.measure 문자열을 그대로 쓴다."""
    ms = M.MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=None, profile=PROF, card=card)
    term = M.rep_term(ms, "a", family)
    rows = await fetch_all(conn, f"""SELECT j.job_id FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
                                      WHERE a.surface = 1 AND a.round_date = DATE '2026-09-14' AND a.cyc_key = ANY(CAST(:k AS int4[]))
                                        AND j.job_id = ANY(CAST(:j AS uuid[])) AND {term}""", {"k": list(keys), "j": [J9, J9B]})
    return {r["job_id"] for r in rows}


SEAT = "ARRAY[1]::int2[], ARRAY[DATE '2026-09-14'], NULL, NULL"


async def _delta(d: Any) -> set:
    return {r["job_id"] for r in await d.fetch(
        "SELECT j.job_id FROM rd.rep_cit_delta x JOIN rd.job j ON j.answer_key = x.answer_key WHERE j.job_id = ANY($1::uuid[])", [J9, J9B])}


async def test_seat_rule_delta_and_query_terms():
    async with staged(role=None) as conn:
        d = await _raw(conn)
        await _clone(d)
        # 같은 자리 두 회차: 답변분석 = 자리 셀 최신 1건(J9'), 인용 계열 = 언급과 같다(숨김 없음)
        assert await _rules(d) == {J9: (False, False), J9B: (True, True)}
        flipped = {r["answer_key"] for r in await d.fetch(f"SELECT * FROM rd.reselect_rep_seat({SEAT})")}
        assert 999001 in flipped and len(flipped) >= 2                 # J9 내려가고 J9' 올라감
        await d.execute("SELECT rd.propagate_answer_gates($1::int4[])", sorted(flipped))
        assert await d.fetchval(f"SELECT rd.assert_rep_seat({SEAT})") > 0
        assert await _delta(d) == set()
        assert await _pop(conn, False, "m") == {J9B} == await _pop(conn, False, "c")
        assert await _pop(conn, True, "m") == {J9B} == await _pop(conn, True, "c")          # 숨김 없음: 보정 행 없음 = is_rep

        # 회차 9911 을 인용 숨김(수집 오류)으로: 언급 후보는 그대로, 인용 후보에서 빠짐 → 인용 계열 대표 = J9(보정 한 행).
        # 숨긴 회차의 답변(J9')은 인용 창 키에서 빠지므로(core.codes.HIDDEN_EXCLUDE citations) 인용 대표를 따로 두지 않는다(= 언급 대표)
        await d.execute("UPDATE rd.cycle SET hidden_scope = 2, hidden_reason = 1 WHERE cyc_key = 9911")
        assert await _rules(d) == {J9: (False, True), J9B: (True, True)}
        await d.fetch(f"SELECT * FROM rd.reselect_rep_seat({SEAT})")
        assert await d.fetchval(f"SELECT rd.assert_rep_seat({SEAT})") > 0
        assert await _delta(d) == {J9}
        assert await _pop(conn, False, "m") == {J9B} and await _pop(conn, False, "c", (11,)) == {J9}   # 인용 창 = 숨김 아닌 회차 11
        assert await _pop(conn, True, "c", (11,)) == {J9}                                               # 카드 인용 창(회차 11)도 보정(int2 반례)

        # 서빙 아닌 회차(9911): 후보 밖 → 답변분석은 J9, 9911 자기 셀은 종전 회차 셀 규칙(J9' 대표 유지, 창 후보가 아니라 값 영향 없음)
        await d.execute("UPDATE rd.cycle SET hidden_scope = 0, hidden_reason = 0, servable = false WHERE cyc_key = 9911")
        assert await _rules(d) == {J9: (True, True), J9B: (True, True)}
        await d.fetch(f"SELECT * FROM rd.reselect_rep_seat({SEAT})")
        assert await _delta(d) == set()                                 # 보정 행이 기대값으로 교체된다(남은 J9 행 삭제)

        # 단언이 어긋남을 잡는다
        await d.execute("UPDATE rd.answer SET is_rep = NOT is_rep WHERE surface = 1 AND round_date = DATE '2026-09-14' AND answer_key = 999001")
        with pytest.raises(Exception, match="규칙 불일치 1"):
            async with d.transaction():                                 # 저장점: 예외 뒤에도 바깥 트랜잭션을 이어 쓴다
                await d.fetchval(f"SELECT rd.assert_rep_seat({SEAT})")
        await d.execute("UPDATE rd.answer SET is_rep = NOT is_rep WHERE surface = 1 AND round_date = DATE '2026-09-14' AND answer_key = 999001")
        await d.execute("INSERT INTO rd.rep_cit_delta SELECT 999001, 1, DATE '2026-09-14'")
        with pytest.raises(Exception, match="보정 표 불일치 1"):
            async with d.transaction():
                await d.fetchval(f"SELECT rd.assert_rep_seat({SEAT})")


def test_rep_path_table_matches_measure_branch():
    """경로 대응표(core.measure.REP_PATH) = rep_term 분기: 인용 계열(답변분석·카드) = is_rep XOR rd.rep_cit_delta, 언급 계열 = is_rep.
    카드 요청 안의 미러 읽기 자리(analysis_path, 웹 URL 인용률 기간)는 답변분석. 스위치 끔 = 전부 is_rep."""
    assert M.REP_PATH == {(True, "m"): "is_rep", (True, "c"): "is_rep^cit_delta", (False, "m"): "is_rep", (False, "c"): "is_rep^cit_delta"}
    for card in (False, True):
        for fam in ("m", "c"):
            for ap in (False, True):
                ms = M.MeasureScope(sf=2, project_keys=(1,), own_bits=(1,), bgrps=(1,), profile=PROF, card=card)
                t = M.rep_term(ms, "x", fam, analysis_path=ap)
                rule = M.REP_PATH[(card and not ap, fam)]
                assert (t == "x.is_rep") == (rule == "is_rep")
                if rule != "is_rep":
                    src = "rd.rep_cit_delta d WHERE d.surface = 2"
                    assert t == (f"(CASE WHEN x.round_date = ANY((SELECT ARRAY(SELECT DISTINCT d.round_date FROM {src}))::date[]) "
                                 f"THEN (x.is_rep <> (x.answer_key IN (SELECT d.answer_key FROM {src}))) ELSE x.is_rep END)")
                off = dataclasses.replace(ms, profile=P.LegacyProfile(cell_rep=True, rep_pick_latest_first=True))
                assert M.rep_term(off, "x", fam, analysis_path=ap) == "x.is_rep"
    # 모수 함수가 계열대로 쓴다
    card = M.MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=(1,), profile=PROF, card=True)
    ana = dataclasses.replace(card, card=False)
    assert "rep_cit_delta" not in M.mention_population(card, "b", "brand") and "rep_cit_delta" in M.citation_population(card, "c", "citation")
    assert "rep_cit_delta" not in M.mention_population(ana, "b", "brand") and "rep_cit_delta" in M.citation_population(ana, "c", "citation")
    # url_prompts: 기간(cumulative) 창이면 카드 요청이어도 답변분석 대표(현행 URL 인용률 기간 = 미러 창 안 적중)
    import inspect
    assert "citation_population(ms4, a, unit_gate=False, analysis_path=win.mode == \"cumulative\")" in inspect.getsource(M.plan_counts)


# ════════════════════════════════════════════════════════════════════════════
# int2 검증자 반례(v-int2/.tmp-verify/probe_card.py): 카드 경로 인용 계열 + 같은 round_date 의 인용 숨김 형제 회차
# ════════════════════════════════════════════════════════════════════════════
# 회차 CY2(09-14 자리, 인용 숨김 operator)에 회차 11 셀(prompt 01·chatgpt·US)과 같은 셀의 더 늦은 측정 JX 를 둔다(ing 층 → 프로필 bulk 재투영).
# 자리 규칙(rep_round_date_cell)이면 is_rep 이 JX 로 넘어간다. 카드 인용 창(card_slot_rep)은 인용 숨김 CY2 를 빼고 회차 11 을 고르므로,
# 카드 인용 모수가 보정 표를 보지 않으면 그 셀이 카드 인용 분모에서 빠진다(반례: answers_den 4, 스위치 끄면 5).
CY2 = "f0000000-0000-4000-8000-0000000000c2"
R2 = "e0000000-0000-4000-8000-0000000000c2"
JX = "90000000-0000-4000-8000-0000000000c2"
SIBLING_SQL = f"""
INSERT INTO ing.cycle (cycle_id, surface, scope_project_id, cycle_anchor_at, anchor_source, anchor_date, round_date, status, closed_by, closed_at,
                       expected_units, completed_units, completed_answers, gap_answers, fleet_visible, view_anchor_at, hidden_scope, hidden_reason, hidden_at, origin)
VALUES ('{CY2}', 'global', 'a0000000-0000-4000-8000-000000000001', '2026-09-14 10:00+00', 'scope', '2026-09-14', '2026-09-14', 'published', 'next_anchor',
        '2026-09-21 00:30+00', 1, 1, 1, 0, true, '2026-09-15 15:00+00', 'citations', 'operator', '2026-09-20 00:00+00', 'summary_cycles');
INSERT INTO ing.run (run_id, scope_project_id, run_month, status, total_jobs, started_at, cycle_anchor_at, sync_state)
VALUES ('{R2}', 'a0000000-0000-4000-8000-000000000001', '2026-09-01', 'completed', 1, '2026-09-14 12:00+00', '2026-09-14 10:00+00', 'loaded');
INSERT INTO ing.cycle_run (run_id, cycle_id, attributed_by) VALUES ('{R2}', '{CY2}', 'scope');
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{JX}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions,
                        n_citations, content_hash, load_id)
SELECT '2026-09-01', '{JX}', k.answer_key, '{R2}', 'b0000000-0000-4000-8000-000000000001', 'chatgpt', 'US', 'completed', '2026-09-14 13:00+00',
       'completed', 1, 1, '\\x08', 1
  FROM ing.answer_key_map k WHERE k.job_id = '{JX}';
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, brand_rollup_entity_id, type_mention)
VALUES ('2026-09-01', '{JX}', 1, '00000000-0000-0000-0000-000000000301', 'Hyundai', 'Brand', 1, 1.0, '00000000-0000-0000-0000-000000000301', 1);
INSERT INTO ing.citation (run_month, job_id, ord, url, host, domain_label)
VALUES ('2026-09-01', '{JX}', 1, 'https://www.hyundaiusa.com/us/en/suv', 'hyundaiusa.com', 'hyundaiusa.com');
"""
# 일련번호를 픽스처 최대값 위로(새 키가 픽스처 키와 겹치지 않게. 시퀀스 진행은 롤백되지 않지만 시험 DB 전용)
SEQ_SQL = [f"SELECT setval(pg_get_serial_sequence('{t}', '{c}'), greatest((SELECT max({c}) FROM {t}), 1000))" for t, c in
           (("ing.run", "run_key"), ("ing.answer_key_map", "answer_key"), ("ing.cycle", "cyc_key"), ("ing.acr_prompt_run", "acr_cell_key"),
            ("ing.load", "load_id"))]
SIB_Q = {"surface": "global", "from": "2026-09-14", "to": "2026-09-14"}
SIB_CALLS: tuple[tuple[str, dict[str, Any]], ...] = (
    ("/v1/citations/domains", {"limit": "0", "competitor_sources": "true"}),
    ("/v1/kpi/summary", {}),
    ("/v1/mentions/brands", {"top_n": "5", "sort": "mentions", "include": "hmg"}),
)


def _impl_spec(with_seat_rule: bool) -> str:
    return ",".join(n for n in P.SWITCHES if n in P.IMPLEMENTED and (with_seat_rule or n != "rep_round_date_cell"))


async def _sibling_values(client_as, settings, spec: str) -> dict[tuple[str, bool], Any]:
    """spec 프로필로 형제 회차 상태를 bulk 재투영(롤백 전용)하고 카드·비카드 응답을 모은다."""
    from app.core.config import set_settings
    from ingest.testkit import bulk_seed_profile
    from tests.support import ADMIN

    prof = P.parse_profile(spec)

    async def prepare(conn: Any) -> None:
        d = await _raw(conn)
        for s in [*SEQ_SQL, SIBLING_SQL]:
            await d.execute(s)
        await bulk_seed_profile(d, prof)
        # S4: freeze_at_publish 카드 요청은 창 회차가 전부 동결이어야 카드 경로다(구멍이면 비카드 = 현행 미러 폴백). 발행 회차를 S2 생성기로 동결한다
        await d.execute("SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE status = 'published' AND surface IN ('global', 'website')")
        # 독립 재계산: 09-14 자리의 인용 계열 회차(인용 숨김 CY2 제외 = 회차 11) 동결 카드 셀 중 루트 카탈로그(동결 비트 ≠ 0).
        # 현행 프로필은 acr_iter_unfolded 라 인용 모수 = 셀 대표 전부(cit_in 게이트 없음, core.measure.citation_population)
        out["frz_cit_cells"] = await d.fetchval(
            "SELECT count(*) FROM frz.card_answer a JOIN rd.cycle c ON c.cyc_key = a.cyc_key "
            "WHERE a.surface = 1 AND c.round_date = DATE '2026-09-14' AND c.hidden_scope = 0 AND a.bgrp <> 0")
        out["frz_host_cits"] = await d.fetchval(
            "SELECT count(*) FROM frz.card_citation x JOIN rd.cycle c ON c.cyc_key = x.cyc_key "
            "WHERE x.surface = 1 AND c.round_date = DATE '2026-09-14' AND c.hidden_scope = 0 AND x.source_key <> 0")

    out: dict[Any, Any] = {}
    set_settings(settings.model_copy(update={"legacy_profile": spec}))
    try:
        async with staged(prepare), client_as(ADMIN) as cl:
            for path, params in SIB_CALLS:
                for card in (False, True):
                    r = await cl.get(path, params={**SIB_Q, **params, **({"card": "true"} if card else {})})
                    assert r.status_code == 200, (path, card, r.text[:300])
                    out[(path, card)] = r.json()["data"]
    finally:
        set_settings(settings)
    return out


def _den(v: dict[tuple[str, bool], Any], card: bool) -> tuple[int, int, int]:
    return (v[("/v1/citations/domains", card)]["summary"]["answers_den"], v[("/v1/kpi/summary", card)]["params"]["answers"],
            v[("/v1/mentions/brands", card)]["totals"]["answers"])


async def test_card_citation_den_keeps_cell_with_citation_hidden_sibling(client_as, settings):
    """반례: 자리 규칙을 켜도 카드 인용 분모는 스위치를 끈 값과 같아야 한다(카드 인용 창 회차 11 의 셀이 빠지지 않는다).
    S4: 발행 회차를 동결한 뒤라 카드 요청은 동결 셀을 읽는다(rd is_rep·보정과 무관 → 켬 = 끔, 값 = 동결 셀 재계산).
    카드 언급 계열은 원래 같고, 비카드(답변분석) 값은 이 수정 전과 같다(반례 실행 로그의 수정 전 값: 도메인 분모 4·카드 요약 답변 4·브랜드 답변 4)."""
    on = await _sibling_values(client_as, settings, _impl_spec(True))
    off = await _sibling_values(client_as, settings, _impl_spec(False))
    assert _den(on, True) == _den(off, True), (_den(on, True), _den(off, True))          # 수정 전: (4, 1, 1) 대 (5, 1, 1)
    # S4: 카드 요청은 동결 회차를 읽는다(셀 = S2 생성기 셀 집합, rd is_rep·보정과 무관). 카드 인용 분모 = 회차 11 동결 셀 재계산 값
    assert on["frz_cit_cells"] == off["frz_cit_cells"] > 0
    # S4b: 동결 회차 11 에 호스트 인용이 0 이라 현행 도메인 위젯은 빈 집계로 미러에 간다(summary-citation-read.ts:219-236 이름 그룹·인용 합 0,
    # server.ts:2066-2069). 허브 = 창 판정 agg-empty → 비카드. 그래서 카드 도메인 분모 = 비카드 분모(동결 셀 수 아님)
    assert on["frz_host_cits"] == off["frz_host_cits"] == 0
    assert _den(on, True)[0] == _den(on, False)[0] == 4, (_den(on, True), _den(on, False))
    assert _den(on, False) == (4, 4, 4)                                                  # 비카드: 수정 전과 같다(자리 규칙 = JX 대표, 인용 창 = 회차 11 보정)


def test_card_citation_fix_leaves_non_card_sql_unchanged(monkeypatch):
    """int2 반례 수정은 카드 요청의 인용 계열만 바꾼다: 비카드(card 없음) 문장은 수정 전 대응표(카드 인용 = is_rep)와 바이트 같다.
    카드 요청 문장은 인용 계열만 달라진다(언급 계열 문장 = 같다)."""
    from tests.core.test_legacy_profile import WEB, WIN, _ms

    on = P.parse_profile(_impl_spec(True))

    def texts(card: bool) -> dict[str, str]:
        out: dict[str, str] = {}
        for sf, win in ((1, WIN), (2, WEB), (1, WEB)):
            ms = dataclasses.replace(_ms(sf, on), card=card)
            plan = M.plan_counts(ms, win, parts=M.ALL_PARTS, group_by=("round_date",))
            for name, q in plan.statements:
                out[f"{sf}:{win.mode}:{name}"] = q.text
            out[f"{sf}:{win.mode}:competitor"] = M.competitor_rows_sql(ms, win).text
            out[f"{sf}:{win.mode}:citation_counts"] = M.citation_counts_sql(ms, win).text
            out[f"{sf}:{win.mode}:mention_pop"] = M.mention_population(ms, "a")
        return out

    new_plain, new_card = texts(False), texts(True)
    monkeypatch.setitem(M.REP_PATH, (True, "c"), "is_rep")                       # 수정 전 대응표
    old_plain, old_card = texts(False), texts(True)
    assert new_plain == old_plain
    changed = {k for k in new_card if new_card[k] != old_card[k]}
    assert changed and all("rep_cit_delta" in new_card[k] and "rep_cit_delta" not in old_card[k] for k in changed), sorted(changed)
    assert not any(k.endswith(":mention_pop") for k in changed)
