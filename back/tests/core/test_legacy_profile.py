"""현행 프로필 골격(core.profile, 제품 결정 19·23~25, 계획서 WU-1) 시험. DB 없음.

  1. 스위치 목록 = LegacyProfile 필드(한 벌), OFF·CURRENT 정규 표기, 해석 규칙(모르는 이름·구현 전 스위치 거부)
  2. 설정 HGH_LEGACY_PROFILE: 기본 off, 구현 전 스위치를 켜면 적재 실패. 결과 캐시 빌드 식별자는 off 면 도입 전과 같다
  3. 무변화: 기본 MeasureScope(프로필 생략) = 명시 OFF, 자리 함수가 도입 전 문자열을 낸다(도입 전 코드와의 바이트 대조는 WU-1 보고 참고)
  4. 자리 표식: core 자리가 있는 스위치를 켜면 그 빌더가 NotImplementedError(WU 이름 포함)로 막는다(조용히 옛 정의로 돌지 않는다)
  5. WU 시험 틀: 구현된 스위치(IMPLEMENTED)는 이 파일에 test_switch_<이름> 이 있어야 한다. 구현 전 스위치는 WU 자리로 건너뛴다
"""
from __future__ import annotations

import asyncio
import dataclasses
import pathlib
from datetime import date

import pytest

from app.core import measure as M
from app.core import profile as P
from app.core.config import load_settings, set_settings
from app.core.cycles import CycleRow, build_window, resolve_recent_window, resolve_window

ROWS = [CycleRow(10, 1, date(2026, 9, 28), 0), CycleRow(11, 1, date(2026, 9, 21), 2)]
WIN = build_window(surface="global", mode="cumulative", rows=ROWS, lo=date(2026, 9, 21), hi=date(2026, 9, 28), generation=1, project_keys=(1,))
WEB = build_window(surface="website", mode="snapshot", rows=ROWS[:1], lo=date(2026, 9, 28), hi=date(2026, 9, 28), generation=1, project_keys=(1,))
OWN = M.OwnerScope(keys=(1,), own_bits=(1,), countries=None, country_narrowed=False, lang_narrowed=False)


def _ms(sf: int = 1, profile: P.LegacyProfile | None = None) -> M.MeasureScope:
    kw = {} if profile is None else {"profile": profile}
    return M.MeasureScope(sf=sf, project_keys=(1,), own_bits=(1,), bgrps=(1,), pop_bits=(1, 8), owner=OWN if sf == 1 else None,
                          default_engine_keys=(1,), **kw)


# ════════════════════════════════════════════════════════════════════════════
# 1. 스위치 목록·표기·해석
# ════════════════════════════════════════════════════════════════════════════
def test_switch_registry_matches_profile_fields():
    assert [f.name for f in dataclasses.fields(P.LegacyProfile)] == list(P.SWITCHES)
    for name, sp in P.SWITCHES.items():
        assert sp.kind in ("read", "projection", "freeze"), name
        assert sp.tag and sp.wu and sp.summary and sp.slot, name
    assert P.IMPLEMENTED.issubset(P.SWITCHES)


def test_off_and_current_spec_roundtrip():
    assert P.OFF.is_off and P.OFF.spec == "off" and P.OFF.on == ()
    assert P.CURRENT.spec == "current" and P.CURRENT.on == tuple(P.SWITCHES)
    assert P.parse_profile(None) is P.OFF and P.parse_profile("") is P.OFF and P.parse_profile(" OFF ") is P.OFF
    assert P.parse_profile("current", require_implemented=False) == P.CURRENT
    two = P.parse_profile("m05_den_hostless, cell_rep", require_implemented=False)
    assert two.on == ("cell_rep", "m05_den_hostless") and two.spec == "cell_rep,m05_den_hostless"       # 정규 표기 = SWITCHES 순서
    assert P.parse_profile(two.spec, require_implemented=False) == two
    assert len({P.OFF.fingerprint, P.CURRENT.fingerprint, two.fingerprint}) == 3


def test_parse_rejects_unknown_and_unimplemented():
    with pytest.raises(ValueError, match="모르는 스위치"):
        P.parse_profile("cell_rep,nope", require_implemented=False)
    pending = [n for n in P.SWITCHES if n not in P.IMPLEMENTED]
    if pending:
        with pytest.raises(ValueError, match="아직 구현되지 않은"):
            P.parse_profile(pending[0])
        with pytest.raises(ValueError, match=P.SWITCHES[pending[0]].wu.split("(")[0]):
            P.parse_profile("current")


# ════════════════════════════════════════════════════════════════════════════
# 2. 설정·결과 캐시 키
# ════════════════════════════════════════════════════════════════════════════
def test_settings_default_off_and_validation():
    assert P.DEFAULT_SPEC == "off"                                          # 스위치가 전부 구현될 때까지(결정: 최종 기본값 = current)
    assert load_settings({}).legacy_profile == "off"
    assert load_settings({"HGH_LEGACY_PROFILE": "off"}).legacy_profile == "off"
    with pytest.raises(ValueError, match="모르는 스위치"):
        load_settings({"HGH_LEGACY_PROFILE": "cell_reps"})
    if set(P.SWITCHES) - P.IMPLEMENTED:
        with pytest.raises(ValueError, match="아직 구현되지 않은"):
            load_settings({"HGH_LEGACY_PROFILE": "current"})


def test_cache_build_id_unchanged_when_off(settings):
    from app.core import result_cache as rc

    try:
        set_settings(settings.model_copy(update={"build_id": "sha-x", "legacy_profile": "off"}))
        assert rc.build_id() == "sha-x"                                      # 도입 전 키와 같다
        set_settings(settings.model_copy(update={"build_id": "sha-x", "legacy_profile": "cell_rep"}))
        lp = P.parse_profile("cell_rep", require_implemented=False)
        assert rc.build_id() == f"sha-x+lp:{lp.fingerprint}"                  # 프로필만 바꾼 재기동이 옛 캐시를 쓰지 않는다
    finally:
        set_settings(settings)


def test_active_profile_reads_settings(settings):
    try:
        set_settings(settings.model_copy(update={"legacy_profile": "trend_grid"}))
        assert P.active_profile().on == ("trend_grid",)
        set_settings(settings.model_copy(update={"legacy_profile": "off"}))
        assert P.active_profile() is P.OFF
    finally:
        set_settings(settings)


# ════════════════════════════════════════════════════════════════════════════
# 3. 무변화(OFF)
# ════════════════════════════════════════════════════════════════════════════
def test_off_slots_emit_pre_skeleton_strings():
    ms = _ms()
    assert ms.profile is P.OFF
    assert M.mention_population(ms, "a") == "a.std_in" and M.mention_population(ms, "b") == "b.std_in"
    assert M.citation_population(ms, "c") == "c.cit_in"
    assert M.m05_den_col(ms, "a") == "a.cit_n"
    assert M.mention_family(ms) == "mentions"


@pytest.mark.parametrize("sf", [1, 2, 3])
def test_default_scope_equals_explicit_off(sf):
    for win in (WIN, WEB):
        a, b = _ms(sf), _ms(sf, P.OFF)
        pa = M.plan_counts(a, win, parts=M.ALL_PARTS, group_by=("round_date",))
        pb = M.plan_counts(b, win, parts=M.ALL_PARTS, group_by=("round_date",))
        assert [(r, q.text, q.params) for r, q in pa.statements] == [(r, q.text, q.params) for r, q in pb.statements]
        assert M.competitor_rows_sql(a, win).text == M.competitor_rows_sql(b, win).text
        assert M.citation_counts_sql(a, win).text == M.citation_counts_sql(b, win).text


# ════════════════════════════════════════════════════════════════════════════
# 4. 자리 표식(구현 전 스위치를 켜면 core 빌더가 막는다)
# ════════════════════════════════════════════════════════════════════════════
def _plan(ms):
    return M.plan_counts(ms, WIN, parts=M.ALL_PARTS)


# 스위치 → core 자리를 지나는 호출(계획서 6절 WU 가 여기서 분기를 쓴다)
CORE_SLOTS = {
    "cell_rep": _plan,
    "acr_iter_unfolded": _plan,
    "gap_in_population": _plan,
    "web_registered_only": _plan,
    "freeze_at_publish": _plan,
    "summary_all_engines": _plan,
    "m05_den_hostless": lambda ms: M.plan_counts(ms, WIN, parts=("citations",)),
    "catalog_incl_deleted": _plan,
    "brand_exposure_per_alias": lambda ms: M.competitor_rows_sql(ms, WIN),
    "web_url_rate": lambda ms: M.r09_reason(ms, WEB, by_round=False),
    "rep_round_date_cell": _plan,
    "card_slot_rep": lambda ms: asyncio.run(resolve_window(None, surface="global", project_keys=(1,), date_from=None, date_to=None,
                                                            profile=ms.profile, card=True)),
    "trend_grid": lambda ms: asyncio.run(resolve_recent_window(None, surface="global", project_keys=(1,), n=12, bucket="cycle",
                                                               profile=ms.profile)),
}


def test_core_slot_map_covers_core_switches():
    core = {n for n, sp in P.SWITCHES.items() if sp.slot.startswith("core.") or "core.measure" in sp.slot}
    assert core == set(CORE_SLOTS)


@pytest.mark.parametrize("name", sorted(CORE_SLOTS))
def test_unimplemented_core_slot_refuses(name):
    if name in P.IMPLEMENTED:
        pytest.skip("구현됨: test_switch_<이름> 이 값을 시험한다")
    ms = _ms(2 if name == "web_url_rate" else 1, P.LegacyProfile(**{name: True}))
    with pytest.raises(NotImplementedError, match=P.SWITCHES[name].wu.split("(")[0]):
        CORE_SLOTS[name](ms)


def test_slot_guard_rejects_unknown_name():
    with pytest.raises(ValueError, match="모르는 스위치 자리"):
        P.require_slot(P.OFF, "no_such_switch")


# ════════════════════════════════════════════════════════════════════════════
# 5. WU 시험 틀: 스위치를 구현한 WU 는 여기 test_switch_<이름>(켜짐 값 = 현행 산식 단위 시험)을 둔다
# ════════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize("name", list(P.SWITCHES))
def test_implemented_switch_has_unit_test(name):
    if name not in P.IMPLEMENTED:
        pytest.skip(f"{P.SWITCHES[name].wu} 자리({P.SWITCHES[name].tag}): 구현 시 test_switch_{name} 추가 + IMPLEMENTED 등록")
    assert callable(globals().get(f"test_switch_{name}")), f"구현된 스위치 {name} 의 단위 시험 test_switch_{name} 이 없다"


# ── WU-9(analytics.kpi.compare): 켜짐 값 = 현행 fetchPeriodCompare 분기. 조립·라우트 시험은 compare/tests/test_legacy_switches.py ──
def _compare_ctx(surface: str = "global", own_bits: tuple[int, ...] = (1,)):
    from app.core.filters import ReadContext
    return ReadContext(surface=surface, sf={"global": 1, "website": 2, "project": 3}[surface], principal=None, scope=None,  # type: ignore[arg-type]
                       refs=None, project_keys=(1,), own_brands=("Hyundai",), own_bits=own_bits, pop_bits=(1, 8), bgrps=(1, 9),  # type: ignore[arg-type]
                       geo_keys=None, countries=None, lang_keys=None, langs=None, engine_keys=None, prompt_keys=None,
                       source_category_keys=None, owner=None, date_from=None, date_to=None)


def _compare_short(profile, lo: str, hi: str, surface: str = "global", own_bits: tuple[int, ...] = (1,), **q):
    from app.features.analytics.kpi.compare import service as svc
    from app.features.analytics.kpi.compare.logic import windows_from_range
    from app.features.analytics.kpi.compare.schemas import CompareQuery
    w = windows_from_range(date.fromisoformat(lo), date.fromisoformat(hi))
    query = CompareQuery(surface=surface, **{"from": lo, "to": hi}, **q)
    return svc._legacy_short_circuit(_compare_ctx(surface, own_bits), query, w, ["visibility", "position"], [], profile)


def test_switch_compare_epoch_gate():
    """현행 server.ts:5959: cur.hi < 2026-09-08 이면 null(종전 Δ) → 허브는 data [] + meta.suppressed['*'] before_epoch. 경계 포함."""
    on = P.LegacyProfile(compare_epoch_gate=True)
    gated = _compare_short(on, "2026-08-09", "2026-09-07")
    assert gated.data == [] and gated.meta.suppressed == {"*": "before_epoch"}
    assert _compare_short(on, "2026-08-10", "2026-09-08") is None                 # 적용일 당일부터 비교(새 경로로 계속)
    assert _compare_short(P.OFF, "2026-08-09", "2026-09-07") is None


def test_switch_compare_suppress():
    """현행 planTrendRead ok:false(depth2·depth3·다중 브랜드) → 전 지표 unsupported, 정수 쌍·원장 0(emptyCompare)."""
    on = P.LegacyProfile(compare_suppress=True)
    for kw in ({"depth2": ["x"]}, {"depth3": ["x"]}, {"own_bits": (1, 4)}):
        r = _compare_short(on, "2026-09-01", "2026-09-14", **kw)
        assert [(i.metric, i.reason, i.delta, i.planned_cur) for i in r.data] == [("visibility", "unsupported", None, 0),
                                                                                   ("position", "unsupported", None, 0)]
    assert _compare_short(on, "2026-09-01", "2026-09-14", own_bits=(1, 2, 4)) is None      # 명부 전부 = ALL 변형
    assert _compare_short(on, "2026-09-01", "2026-09-14", surface="project", depth2=["x"]) is None
    assert _compare_short(P.OFF, "2026-09-01", "2026-09-14", depth2=["x"]) is None


# ── WU-6(core.cycles 추이 격자): 켜짐 값 = 현행 X.trendGrid 자리·대표·갭. DB·라우트 시험은 analytics/trend/series/tests/test_trend_grid.py ──
def test_switch_trend_grid():
    """현행 trend-grid-slots.ts:192-229 + trend-grid.ts:125-161·288-331 + cycle-set.ts:267-346(대표)·:126-162(완결성) + trend-gaps.ts ② 표식."""
    from app.core import cycles as C

    def gc(k, d, *, pk=1, ad=None, hid=0, why=0, cand=True, exp=None, comp=None, ans=1, cid=None):
        return C.GridCycle(k, cid or f"{k:08d}-0000-0000-0000-000000000000", pk, d, ad or d, hid, why, cand, exp, comp, ans)

    mon = [date.fromordinal(date(2026, 6, 1).toordinal() + 7 * i) for i in range(17)]
    cyc = [gc(100 + i, d) for i, d in enumerate(mon)]
    cyc[3] = gc(103, mon[3], cand=False)                                  # 06-22 발행 전·귀속 있음 → 갭(미발행)
    cyc[4] = gc(104, mon[4], cand=False, ans=None)                        # 06-29 귀속 없음·서빙 불가 → 자리 아님
    cyc[5] = gc(105, mon[5], hid=1, why=1)                                # 07-06 수집 오류 전체 숨김뿐 → 갭(수집 오류)
    cyc[6] = gc(106, mon[6], hid=1, why=2)                                # 07-13 운영 숨김뿐 → 자리 아님
    cyc[16] = gc(116, mon[16], cand=False)                                # 09-21 진행 중(귀속 있음) → 끝쪽 미발행 절단
    slots = C.grid_slots(cyc)
    keys = [s.round_date for s in slots]
    assert len(keys) == C.TREND_GRID_SLOTS == 13 and keys[-1] == mon[15]                       # 끝 절단 뒤 최신 13자리
    assert mon[4] not in keys and mon[6] not in keys and mon[16] not in keys
    assert keys[0] == mon[1]                                              # 자리 아닌 둘을 건너 06-08 부터(06-01 은 창 밖)
    gap = {s.round_date: s.gap for s in slots}
    assert gap[mon[3]] == "not_published" and gap[mon[5]] == "collection_error" and gap[mon[7]] is None
    # 기간: 안으로 좁힌 뒤 13자리 상한, 끝쪽 미발행 절단은 기간 안에서
    assert [s.round_date for s in C.grid_slots(cyc, date_from=mon[2], date_to=mon[4])] == [mon[2]]    # 06-22 미발행이 끝 → 절단
    assert len(C.grid_slots(cyc, date_from=date(2026, 1, 1), date_to=date(2026, 12, 31))) == 13

    g = C.GRID_RULES["global"]
    w = C.GRID_RULES["website"]
    d = mon[10]
    # 자리 대표: 합산이 아니라 하나(늦은 앵커), 완결성 통과가 먼저, 인용 대표는 인용 숨김 회차를 뺀다
    early = gc(201, d, ad=date(2026, 8, 3))
    late_cit_hidden = gc(202, d, ad=date(2026, 8, 9), hid=2, why=1)
    p = C.pick_slot(C.GridSlot(d, (early, late_cit_hidden), None), g)
    assert [c.cyc_key for c in p.mention] == [202] and [c.cyc_key for c in p.citation] == [201]
    assert p.gaps == {"citations": "collection_error"}                   # 수집 오류 인용 숨김 → 인용 표식(⑥ accuracy 는 아님)
    op = C.pick_slot(C.GridSlot(d, (early, gc(203, d, ad=date(2026, 8, 9), hid=2, why=2)), None), g)
    assert op.gaps == {} and [c.cyc_key for c in op.mention] == [203]    # 운영 인용 숨김은 표식 없음(trend-gaps.ts GAP_REASONS)
    wide = C.pick_slot(C.GridSlot(d, (early, late_cit_hidden, gc(204, d, hid=1, why=1)), None), g)
    assert wide.gaps == {}                                               # 같은 자리 전체 숨김 수집 오류가 'all' 로 이긴다(widen)
    part = gc(205, d, ad=date(2026, 8, 10), exp=10, comp=5)
    full = gc(206, d, ad=date(2026, 8, 3), exp=10, comp=10)
    assert [c.cyc_key for c in C.pick_slot(C.GridSlot(d, (part, full), None), g).mention] == [206]   # 완결성이 늦은 앵커보다 먼저
    tie = C.pick_slot(C.GridSlot(d, (gc(207, d, cid="a"), gc(208, d, cid="b")), None), g)
    assert [c.cyc_key for c in tie.mention] == [208]                     # 같은 앵커 = cycle_id 최대
    # 완결성 갭: 글로벌만(0.9 미만, 모르면 갭 아님), 웹사이트는 보지 않는다
    low = gc(209, d, exp=1000, comp=899)
    assert C.pick_slot(C.GridSlot(d, (low,), None), g).gaps == {"mentions": "collection_error", "citations": "collection_error",
                                                                  "accuracy": "collection_error"}
    assert C.pick_slot(C.GridSlot(d, (gc(210, d, exp=1000, comp=900),), None), g).gaps == {}
    assert C.pick_slot(C.GridSlot(d, (gc(211, d, exp=None, comp=None),), None), g).gaps == {}
    assert C.pick_slot(C.GridSlot(d, (low,), None), w).gaps == {}
    # 웹사이트 대표 그룹 = (프로젝트, 자리)
    web = C.pick_slot(C.GridSlot(d, (gc(301, d, pk=2), gc(302, d, pk=2, ad=date(2026, 8, 20)), gc(303, d, pk=3)), None), w)
    assert sorted(c.cyc_key for c in web.mention) == [302, 303]
    # 창: 계열 키 = 대표만, lo·hi = 첫·끝 자리(갭 자리 포함), 서빙 불가 자리는 대표 없음
    tg = C.build_trend_grid(surface="global", cycles=[*cyc[:10], *cyc[11:], early, late_cit_hidden], date_from=None, date_to=None, generation=5,
                            project_keys=(1,))
    assert tg.window.lo == mon[1] and tg.window.hi == mon[15] and tg.window.generation == 5
    ment = set(tg.window.cyc_keys("mentions"))
    assert 202 in ment and 201 not in ment and 110 not in ment and 201 in tg.window.cyc_keys("citations")
    assert 103 not in ment and 105 not in ment
    assert 202 not in tg.window.cyc_keys("any") and 202 in tg.window.cyc_keys("row")                  # any = 숨김 없는 언급 대표
    assert [p.gaps for p in tg.picks if p.slot.round_date == mon[3]] == [{"mentions": "hidden", "citations": "hidden", "accuracy": "hidden"}]
    assert "trend_grid" in P.IMPLEMENTED       # resolve_recent_window 위임(DB)은 test_trend_grid.py::test_recent_window_delegates_to_grid

# ── WU-2 (A1·A15·A16): 모수 술어. 값 대조(DB)는 tests/core/test_cell_rep.py ───────────────
CR = P.LegacyProfile(cell_rep=True)
CR15 = P.LegacyProfile(cell_rep=True, acr_iter_unfolded=True)
CR16 = P.LegacyProfile(cell_rep=True, gap_in_population=True)
CR_ALL = P.LegacyProfile(cell_rep=True, acr_iter_unfolded=True, gap_in_population=True)


def _texts(ms) -> str:
    plan = M.plan_counts(ms, WIN, parts=M.ALL_PARTS, group_by=("round_date",))
    return "\n".join([q.text for _, q in plan.statements] + [M.competitor_rows_sql(ms, WIN).text, M.citation_counts_sql(ms, WIN).text])


def test_switch_cell_rep():
    ms = _ms(1, CR)
    assert M.mention_population(ms, "a") == "(a.is_rep AND a.std_in)"
    assert M.mention_population(ms, "b", "brand") == "(b.is_rep AND b.std_in)"
    assert M.mention_population(ms, "s", "stance") == "(s.is_rep AND s.std_in)"
    assert M.citation_population(ms, "a") == "(a.is_rep AND a.cit_in)"
    assert M.citation_population(ms, "c", "citation") == "(c.is_rep AND c.cit_in)"
    with pytest.raises(ValueError):
        M.mention_population(ms, "c", "citation")
    with pytest.raises(ValueError):
        M.citation_population(ms, "b", "brand")
    t = _texts(ms)
    # 자식 표도 불리언 술어만(부모 rd.answer 세미조인 없음): 경쟁 행 문장은 rd.answer_brand 한 표, 인용 원소 스캔은 rd.citation 한 표
    comp = M.competitor_rows_sql(ms, WIN).text
    assert "(b.is_rep AND b.std_in)" in comp and "rd.answer " not in comp and "EXISTS" not in comp
    cc = M.citation_counts_sql(ms, WIN).text
    assert "(c.is_rep AND c.cit_in)" in cc and "rd.answer " not in cc
    assert "a.is_rep" in t
    # 규칙 스위치(projection)는 조회 문장을 바꾸지 않는다
    assert _texts(_ms(1, P.LegacyProfile(cell_rep=True, rep_pick_latest_first=True))) == t
    for sf in (1, 2, 3):
        assert _texts(_ms(sf, CR)) != _texts(_ms(sf))


def test_switch_acr_iter_unfolded():
    with pytest.raises(ValueError, match="cell_rep"):
        P.LegacyProfile(acr_iter_unfolded=True)
    ms = _ms(1, CR15)
    assert M.mention_population(ms, "a") == "(a.is_rep AND NOT a.gap)"          # ACR 순번 술어(acr_in)를 뺀다
    assert M.mention_population(ms, "b", "brand") == "(b.is_rep AND b.std_in)"  # 자식은 A16 꺼짐이면 std_in(acr_in 은 is_rep 이 함의)
    assert M.citation_population(ms, "a") == "a.is_rep"
    assert M.citation_population(ms, "c", "citation") == "c.is_rep"


def test_switch_gap_in_population():
    with pytest.raises(ValueError, match="cell_rep"):
        P.parse_profile("gap_in_population")
    ms = _ms(1, CR16)
    assert M.mention_population(ms, "a") == "(a.is_rep AND a.acr_in)"          # 결손(analysis_state ≥ 2) 대표도 모수
    assert M.mention_population(ms, "b", "brand") == "b.is_rep"
    assert M.mention_population(ms, "s", "stance") == "s.is_rep"               # 결손 답변 스탠스(분석 대기)도 든다
    assert M.citation_population(ms, "a") == "(a.is_rep AND a.cit_in)"        # 인용 모수는 원래 결손 포함
    cur = _ms(1, CR_ALL)
    assert {M.mention_population(cur, "a"), M.mention_population(cur, "b", "brand"), M.mention_population(cur, "s", "stance"),
            M.citation_population(cur, "a"), M.citation_population(cur, "c", "citation")} == {"a.is_rep", "b.is_rep", "s.is_rep", "c.is_rep"}
    # 현행(A1·A15·A16)은 M01 분모 FILTER 와 WHERE 가 같은 술어(결손 대표 = 답변 수에 들고 언급 0)
    t = _texts(cur)
    assert "count(*) FILTER (WHERE a.is_rep AND a.cyc_key" in t and "a.std_in" not in t and "a.cit_in" not in t


def test_switch_rep_pick_latest_first():
    from ingest.project.apply import queries as q

    hub, cur = q.REP_UPDATE, q.REP_UPDATE_LATEST_FIRST
    assert "c.geo_key, c.elig\n" in hub and "c.measured_at DESC NULLS LAST, c.answer_key DESC" in hub
    # 현행 규칙 게이트 = 카탈로그 무관 elig_nc(DB-v2.15 P89, WU-4 병합: 현행 선정은 카탈로그를 보지 않고 카탈로그는 조회 때 건다)
    assert "c.geo_key\n" in cur and "c.measured_at DESC NULLS FIRST, c.job_id" in cur and "c.elig_nc AND row_number()" in cur
    assert "c.elig AND" not in cur
    assert P.parse_profile("rep_pick_latest_first").on == ("rep_pick_latest_first",)
    assert P.SWITCHES["rep_pick_latest_first"].kind == "projection"


def test_switch_rep_round_date_cell():
    """WU-12: is_rep = 답변분석 경로 규칙(round_date 셀), 답변분석 인용 계열만 rd.rep_cit_delta 보정. 카드 경로는 is_rep(결정 31: 동결 스냅샷 층).
    규칙·보정 표·경로 대응표 DB 시험은 tests/core/test_rep_seat.py."""
    import inspect

    from ingest.project.apply import queries as q
    from ingest.project.apply import service as svc

    seat = q.REP_UPDATE_SEAT
    assert "rd.reselect_rep_seat(s.sf, s.rd, s.pk, s.ek)" in seat and "FROM _ig_cellu" in seat
    assert "ARRAY[]::int2[]" in seat                                   # 범위가 비면 빈 배열(NULL = 전체 범위를 막는다)
    src = inspect.getsource(svc._write_facts)
    assert "q.REP_UPDATE_SEAT if prof.rep_round_date_cell" in src                     # 회차 셀 규칙보다 우선
    assert "rep_mirror_time" not in P.SWITCHES and not hasattr(q, "REP_UPDATE_LATEST_FIRST_MIRROR")   # 미러 시각은 is_rep 에 쓰지 않는다
    assert P.REQUIRES["rep_round_date_cell"] == ("rep_pick_latest_first", "freeze_at_publish")
    with pytest.raises(ValueError, match="rep_pick_latest_first"):
        P.LegacyProfile(rep_round_date_cell=True)
    with pytest.raises(ValueError, match="freeze_at_publish"):
        P.LegacyProfile(cell_rep=True, rep_pick_latest_first=True, rep_round_date_cell=True)
    on = P.LegacyProfile(cell_rep=True, rep_pick_latest_first=True, rep_round_date_cell=True, freeze_at_publish=True, catalog_incl_deleted=True,
                         web_registered_only=True)
    ana, card = _ms(1, on), dataclasses.replace(_ms(1, on), card=True)
    assert "rep_cit_delta" in M.citation_population(ana, "a") and "rep_cit_delta" not in M.mention_population(ana, "a")
    assert "rep_cit_delta" in M.citation_population(card, "a") and "rep_cit_delta" not in M.mention_population(card, "a")   # 카드 인용도 보정(int2 반례)
    assert "rep_cit_delta" in M.citation_population(card, "a", analysis_path=True)
    assert "rep_cit_delta" not in _texts(_ms(1, P.LegacyProfile(cell_rep=True, rep_pick_latest_first=True)))
    assert P.SWITCHES["rep_round_date_cell"].kind == "projection" and "rep_round_date_cell" in P.IMPLEMENTED


# ════════════════════════════════════════════════════════════════════════════
# 6. WU-4 스위치 단위 시험(A41·NAME·G20). DB 값 시험은 tests/core/test_wu4_switches.py
# ════════════════════════════════════════════════════════════════════════════
def _all_sql(ms: M.MeasureScope, win) -> list[str]:
    out = [q.text for _, q in M.plan_counts(ms, win, parts=M.ALL_PARTS, group_by=("round_date",)).statements]
    out.append(M.competitor_rows_sql(ms, win).text)
    out.append(M.citation_counts_sql(ms, win).text)
    return out


def test_switch_catalog_incl_deleted():
    from app.core.sqlguard import fact_guard

    on = P.LegacyProfile(catalog_incl_deleted=True)
    g_off, g_on = _all_sql(_ms(1), WIN), _all_sql(_ms(1, on), WIN)
    semi = "prompt_key IN (SELECT d.prompt_key FROM rd.dim_prompt d WHERE d.cat_mask_all = ANY("
    for off_t, on_t in zip(g_off, g_on, strict=True):
        assert ".bgrp = ANY(" not in on_t and semi in on_t                 # 글로벌 브랜드·카탈로그 술어 = 삭제 포함 카탈로그 세미조인
        assert ".std_in " not in on_t.replace(".std_in_nc", "") and ".cit_in " not in on_t.replace(".cit_in_nc", "")
        assert on_t.replace("std_in_nc", "std_in").replace("cit_in_nc", "cit_in") != off_t
        assert fact_guard(on_t) == [], on_t                                   # 경계 가드(비트 연산 없음·사실 표 3술어) 통과
    ms = _ms(1, on)
    assert M.mention_population(ms, "b") == "b.std_in_nc" and M.citation_population(ms, "c") == "c.cit_in_nc"
    b = M.Binder("t")
    assert M.catalog_all_pred(ms, "a", b).startswith("a.prompt_key IN (SELECT d.prompt_key FROM rd.dim_prompt d WHERE d.cat_mask_all = ANY(")
    nb = dataclasses.replace(ms, bgrps=None)                                   # 글로벌에서 bgrps 가 없어도 카탈로그 게이트는 선다(fail-closed)
    assert "d.in_root_catalog_all" in " ".join(M.scope_where(nb, "a", M.Binder("t")))
    for sf in (2, 3):                                                          # 웹사이트·프로젝트 elig 에는 카탈로그 항이 없다 → 무변화
        assert _all_sql(_ms(sf), WIN) == _all_sql(_ms(sf, on), WIN)
        assert M.mention_population(_ms(sf, on), "a") == "a.std_in"


def test_switch_display_name_latin():
    from ingest.project.apply import queries as Q

    on = P.LegacyProfile(display_name_latin=True)
    assert P.name_collation(P.OFF) == "" and P.name_collation(on) == ' COLLATE "en-US-x-icu"'
    marked = [Q.PRIOR_NAMES, Q.PAIRS, Q.NAME_CHANGED]
    assert [t.count(Q.NAME_COLL_MARK) for t in marked] == [1, 1, 2]           # 대표 표기를 고르는 네 정렬 전부
    for t in marked:
        off_t, on_t = Q.name_sql(t, P.OFF), Q.name_sql(t, on)
        assert Q.NAME_COLL_MARK not in off_t and "COLLATE" not in off_t      # 꺼짐 = 표식만 지운 도입 전 문장
        assert on_t.count('display_name COLLATE "en-US-x-icu"') == t.count(Q.NAME_COLL_MARK)
        assert on_t.replace(' COLLATE "en-US-x-icu"', "") == off_t
    seed = (pathlib.Path(Q.__file__).resolve().parents[3] / "migration" / "seed" / "seed-3x-common.sql").read_text(encoding="utf-8")
    assert "current_setting('hgh.legacy_name', true) = '1' THEN display_name END) COLLATE \"en-US-x-icu\"" in seed


def test_switch_brand_exposure_per_alias(monkeypatch):
    on = P.LegacyProfile(brand_exposure_per_alias=True)
    off_t, on_t = M.competitor_rows_sql(_ms(1), WIN).text, M.competitor_rows_sql(_ms(1, on), WIN).text
    assert "count(*) AS exposure_answers" in off_t and "rid_n" not in off_t
    assert "coalesce(sum(b.rid_n), 0) AS exposure_answers" in on_t and "count(*) FILTER (WHERE b.rid_n IS NULL) AS rid_n_missing" in on_t
    assert on_t.replace("coalesce(sum(b.rid_n), 0) AS exposure_answers, count(*) FILTER (WHERE b.rid_n IS NULL) AS rid_n_missing",
                        "count(*) AS exposure_answers") == off_t                # 노출 열만 바뀐다(언급·순위·톤 합 불변)
    import app.core.db as D

    async def fake(_conn, _t, _p):
        return [{"brand_key": 7, "exposure_answers": 3, "rid_n_missing": 0}]
    monkeypatch.setattr(D, "fetch_all", fake)
    rows = asyncio.run(M.brand_rows(None, _ms(1, on), WIN))
    assert rows == [{"brand_key": 7, "exposure_answers": 3}]                  # 점검 열은 결과에서 뺀다

    async def fake_missing(_conn, _t, _p):
        return [{"brand_key": 7, "exposure_answers": 3, "rid_n_missing": 2}]
    monkeypatch.setattr(D, "fetch_all", fake_missing)
    with pytest.raises(RuntimeError, match="rid_n 이 비어 있다"):
        asyncio.run(M.brand_rows(None, _ms(1, on), WIN))
# ── WU-8(analytics.filters.options): 켜짐 값 = 현행 옵션 규칙(순수 함수). 라우트·권한 레드팀은 options/tests/test_legacy_switch.py ──
def _options_refs():
    from app.core.codes import Brand, Country, Refs
    brands = (Brand("Hyundai", 1, False, None, 1), Brand("Kia", 2, False, None, 2), Brand("Genesis", 4, False, None, 3),
              Brand("HMG", 8, True, None, 4), Brand("Hyundai N", 16, False, "Hyundai", 5))
    cs = [Country(1, "US", "iso", 1, None, False), Country(2, "KR", "iso", 2, None, False), Country(3, "DE", "iso", 3, None, False),
          Country(4, "ID", "iso", 2, None, True), Country(5, "HYUNDAI-N", "virtual_brand", None, 16, False),
          Country(6, "worldwide", "pseudo", None, None, False)]
    return Refs(brands=brands, owned_bases=(), engines={"chatgpt": (1, True), "gemini": (2, True), "deepseek": (3, False)},
                countries={c.code.upper(): c for c in cs}, langs={"en": 1, "ko": 2, "de": 3}, rhq={}, categories={}, projects=(),
                areas={1: "North America", 2: "Asia", 3: "Europe"})


def test_switch_filter_options():
    """현행 옵션(hmg-geo 2670a16 + 14키):
    글로벌 = 국가 listMeasuredRegions(상태 무관) ⊇ 매트릭스 listMeasuredScopeMatrix(completed), 엔진 = 정적 기본 엔진(deepseek 없음), 숨김 국가 제외.
    웹사이트 = 등록 사이트 국가(프롬프트 없어도)·가상 코드·전용 사이트 계정 좁힘(모 브랜드), 매트릭스·언어 = 사이트 프롬프트 lang_code."""
    from types import SimpleNamespace

    from app.features.analytics.filters.options.service import build_legacy_global, build_legacy_website, default_engines
    refs = _options_refs()
    assert [(e.code, e.is_default) for e in default_engines(refs)] == [("chatgpt", True), ("gemini", True)]

    g = SimpleNamespace(surface="global", refs=refs, own_brands=("Hyundai", "Kia", "Genesis", "Hyundai N"))
    row = {"project_key": 1, "lang_key": 1, "engine_key": 1}
    rows = [{**row, "geo_key": 1, "cat_mask": 5, "served": True},
            {**row, "geo_key": 3, "cat_mask": 2, "served": False},              # DE 실패만 → 국가 목록에만
            {**row, "geo_key": 4, "cat_mask": 1, "served": True}]               # ID 숨김
    m, regions, langs, engines = build_legacy_global(g, rows)
    assert {(x.brand, x.region, x.lang) for x in m} == {("Hyundai", "US", "en"), ("Genesis", "US", "en")}
    assert [r.code for r in regions] == ["DE", "US"] and langs == ["en"] and [e.code for e in engines] == ["chatgpt", "gemini"]
    m, regions, _, _ = build_legacy_global(SimpleNamespace(surface="global", refs=refs, own_brands=("Hyundai",)), rows)
    assert [r.code for r in regions] == ["US"] and {x.brand for x in m} == {"Hyundai"}   # 브랜드 스코프: Kia 실패 국가 DE 가 새지 않는다

    sites = [{"site_id": "a", "brand_code": "Kia", "country_code": "DE"}, {"site_id": "b", "brand_code": "Hyundai", "country_code": "US"},
             {"site_id": "c", "brand_code": "Hyundai N", "country_code": "worldwide"}]
    langs_in = [{"site_id": "a", "lang_code": "de"}, {"site_id": "c", "lang_code": "en"}]
    w = SimpleNamespace(surface="website", refs=refs, scope=None)
    m, regions, langs = build_legacy_website(w, sites, langs_in)
    assert {(x.brand, x.region, x.lang) for x in m} == {("Kia", "DE", "de"), ("Hyundai N", "worldwide", "en"), ("Hyundai N", "HYUNDAI-N", "en")}
    assert [(r.code, r.kind, r.area) for r in regions] == [("DE", "iso", "Europe"), ("HYUNDAI-N", "virtual_brand", None),
                                                           ("US", "iso", "North America"), ("worldwide", "pseudo", None)]
    assert langs == ["de", "en"]
    n_acct = SimpleNamespace(surface="website", refs=refs, scope=SimpleNamespace(all=False, countries=("HYUNDAI-N",)))
    m, regions, _ = build_legacy_website(n_acct, sites[2:], langs_in)      # 현대 N 전용 계정: 가상 코드만, 브랜드는 모 브랜드
    assert [(x.brand, x.region, x.lang) for x in m] == [("Hyundai", "HYUNDAI-N", "en")] and [r.code for r in regions] == ["HYUNDAI-N"]
    hid = SimpleNamespace(surface="website", refs=dataclasses.replace(refs, hidden_markets={"website": frozenset({"US"})}), scope=None)
    assert "US" not in [r.code for r in build_legacy_website(hid, sites, langs_in)[1]]


# ── WU-7(웹사이트 A2·GEOAX·WEBREG16): 켜짐 값 = 현행 X.reportTruth 발행값 선택·웹 집계층 보고서 유닛 모수. DB 시험은 tests/core/test_db_v216.py ──
def _pub(fs, brand, cc, lang, pool, t, m, o, rd=date(2026, 9, 11), slug="vol2"):
    return {"round_date": rd, "file_seq": fs, "brand": brand, "country_code": cc, "lang_code": lang, "in_headline_pool": pool,
            "target_hit_prompts": t, "measured_prompts": m, "owned_prompts": o, "owned_prompts_den": m, "slug": slug}


# 09-11 발행물 축소판(WU-10 R3): fs 40·41 은 발행물 어휘 Hyundai/HYUNDAI-N, 런타임 어휘 Hyundai N/KR·worldwide. fs 71 = 헤드라인 풀 밖(Kia CN)
PUB = [_pub(1, "Hyundai", "MX", "es", True, 30, 50, 40), _pub(40, "Hyundai", "HYUNDAI-N", "ko", True, 49, 89, 64),
       _pub(41, "Hyundai", "HYUNDAI-N", "en", True, 60, 100, 72), _pub(60, "Kia", "DE", "de", True, 20, 40, 30),
       _pub(71, "Kia", "CN", "zh", False, 3, 91, 32)]
RUNTIME = [{"file_seq": 1, "brand": "Hyundai", "country_code": "MX", "lang_codes": ["es"]},
           {"file_seq": 40, "brand": "Hyundai N", "country_code": "KR", "lang_codes": ["ko"]},
           {"file_seq": 41, "brand": "Hyundai N", "country_code": "worldwide", "lang_codes": ["en"]},
           {"file_seq": 60, "brand": "Kia", "country_code": "DE", "lang_codes": ["de"]},
           {"file_seq": 71, "brand": "Kia", "country_code": "CN", "lang_codes": ["zh"]}]


def _sel(**kw):
    sel, why = M.decide_published_selection(PUB, RUNTIME, M.R09Request(**kw))
    return (sorted(p["file_seq"] for p in sel) if sel is not None else None), why


def test_switch_web_url_rate(monkeypatch):
    """현행 server.ts:5452-5518 + truth-axes.ts:81-364(resolveReportTruthRoute·decidePublishedSelection·publishedSubtotal).
    허브 기본(report_values_sql)과 가르는 WU-10 R3: brand=Hyundai 발행값 = 발행물 어휘 Hyundai 전부(fs 40·41 포함, 런타임은 Hyundai N)."""
    on = P.LegacyProfile(web_url_rate=True)
    web = _ms(2, on)
    # ① 라우팅(resolveReportTruthRoute): 폴백 축·기간 원값(한쪽만·구간·하루)·기간 없음 = 창 회차
    route = lambda **kw: M.legacy_r09_route(web, WEB, M.R09Request(**kw), by_round=False)      # noqa: E731
    assert route(fallback_axis="engine") == ("engine_axis", None)
    assert route(fallback_axis="funnel") == ("unsupported_axis", None) and route(fallback_axis="custom")[0] == "unsupported_axis"
    assert route(date_from=date(2026, 9, 11)) == ("period_open_ended", None)
    assert route(date_from=date(2026, 9, 1), date_to=date(2026, 9, 11)) == ("period_range", None)
    assert route(date_from=date(2026, 9, 11), date_to=date(2026, 9, 11)) == (None, date(2026, 9, 11))
    assert route() == (None, WEB.lo)
    assert M.legacy_r09_route(_ms(3, on), WEB, M.R09Request(), by_round=False) == ("not_website", None)
    assert M.legacy_r09_route(web, WEB, M.R09Request(date_from=date(2026, 9, 1), date_to=date(2026, 9, 11)), by_round=True) == (None, None)
    with pytest.raises(ValueError, match="R09Request"):
        M.r09_reason(web, WEB, by_round=False)                          # 켜짐인데 요청 입력이 없으면 조용히 허브 규칙으로 돌지 않는다
    assert M.r09_reason(_ms(2), WEB, by_round=False) is None            # 꺼짐 = 종전
    # ② 선택(decidePublishedSelection): 권한 게이트 → 브랜드 = 발행물 어휘 → 어휘 분기 → 축 선택
    assert _sel(brands=("Hyundai",)) == ([1, 40, 41], None)                                   # R3: fs 40·41 포함(런타임 Hyundai N)
    assert _sel(brands=("hyundai",)) == ([1, 40, 41], None)                                   # 대소문자 무시
    assert _sel(brands=("Hyundai N",)) == (None, "brand_not_in_publication")                  # 런타임 전용 브랜드
    assert _sel(countries=("MX",)) == ([1], None)                                             # 어휘 분기 유닛에 닿지 않는 국가
    assert _sel(countries=("KR",)) == (None, "vocabulary_split")                              # 런타임 KR(fs 40)에 닿음
    assert _sel(countries=("HYUNDAI-N",)) == (None, "vocabulary_split")                       # 발행물 HYUNDAI-N 에 닿음
    assert _sel(langs=("ko",)) == (None, "vocabulary_split") and _sel(langs=("de",)) == ([60], None)
    assert _sel(countries=("FR",)) == (None, "no_published_sites")
    sel, why = M.decide_published_selection(PUB, RUNTIME[:-1], M.R09Request())                 # 계정 스코프가 fs 71 을 못 본다
    assert (sel, why) == (None, "scope_narrower")
    assert M.decide_published_selection([], RUNTIME, M.R09Request()) == (None, "no_publication")
    dup = RUNTIME + [{"file_seq": 60, "brand": "Kia", "country_code": "AT", "lang_codes": ["de"]}]     # 한 file_seq 두 사이트 = 무조건 분기
    assert M.decide_published_selection(PUB, dup, M.R09Request(langs=("de",)))[1] == "vocabulary_split"
    assert M.decide_published_selection(PUB, dup, M.R09Request(brands=("Kia",)))[1] is None          # 국가·언어 축이 없으면 분기 무관
    # ③ 부분합(publishedSubtotal): 선택 ∩ 헤드라인 풀, 비면 선택 전체
    sub = M.published_subtotal([p for p in PUB if p["brand"] == "Hyundai"])
    assert (sub["target_hit"], sub["measured"], sub["owned"], sub["site_count"], sub["pool_applied"]) == (139, 239, 176, 3, False)
    allp = M.published_subtotal(PUB)
    assert (allp["measured"], allp["site_count"], allp["pool_applied"]) == (279, 4, True)          # fs 71(풀 밖) 제외
    only71 = M.published_subtotal([PUB[-1]])
    assert (only71["target_hit"], only71["measured"], only71["pool_applied"]) == (3, 91, False)   # 풀 밖만 고르면 그 값(CPO 3/91 류)

    # ④ url_rates 접기: 카드 = 발행값(프롬프트 단위)·site_count·회차, 거부 사유는 라이브 사유로
    async def fake_fetch_all(conn, text, params=None):
        if "report_unit_value" in text:
            return [dict(p) for p in PUB]
        if "p.slug = ANY" in text:
            return [{"slug": "vol2", "cycle_label": "Vol.2", "cycle_label_en": None, "manifest_verified": True}]
        return [dict(r) for r in RUNTIME]
    monkeypatch.setattr("app.core.db.fetch_all", fake_fetch_all)
    live = [{"tgt_hits": 5, "own_url_hits": 6, "url_den": 9, "tgt_own_hits": 4,
             "url_measured_prompts": 4, "url_target_prompts": 2, "url_owned_prompts": 3}]
    win = build_window(surface="website", mode="snapshot", rows=[CycleRow(30, 2, date(2026, 9, 11), 0)], lo=date(2026, 9, 11),
                       hi=date(2026, 9, 11), generation=1, project_keys=(1,))
    ms = M.MeasureScope(sf=2, project_keys=(1,), own_bits=(1,), bgrps=(1,), default_engine_keys=(1,), profile=on)

    def rates(**kw):
        return asyncio.run(M.url_rates(None, ms, win, brands=("Hyundai",), countries=None, langs=None, live=live, prompt_units=True,
                                       req=M.R09Request(account_project_keys=(1,), **kw)))[None]
    card = rates(brands=("Hyundai",))
    assert card["origin"] == "report" and card["target"] == (139, 239) and card["prompts"] == (239, 139, 176)
    assert card["site_count"] == 3 and card["round_date"] == date(2026, 9, 11) and card["accuracy"] == (4, 6)
    assert rates(countries=("KR",))["reason"] == "vocabulary_split" and rates(countries=("KR",))["prompts"] == (4, 2, 3)
    assert rates(fallback_axis="source")["reason"] == "unsupported_axis"
    assert rates(date_from=date(2026, 9, 12), date_to=date(2026, 9, 12))["reason"] == "no_publication"   # 그 날짜 발행 행 없음(창 회차와 다름)
    assert asyncio.run(M.url_rates(None, ms, win, brands=(), countries=None, langs=None, live=live, prompt_units=True,
                                   req=M.R09Request()))[None]["reason"] == "scope_narrower"      # 계정 사이트 없음 = 런타임 0 = 권한 게이트
    pubs = asyncio.run(M.report_publications(None, ms, win, brands=(), countries=None, langs=None, req=M.R09Request(account_project_keys=(1,))))
    assert pubs == [{"round_date": date(2026, 9, 11), "slug": "vol2", "cycle_label": "Vol.2", "cycle_label_en": None, "manifest_verified": True,
                     "site_count": 4, "headline_pool_applied": True}]


def test_switch_web_registered_only():
    """현행 summary-website-aggregates.ts:226-240 unitWhere + summary-trend-aggregates.ts:718-727: 웹 집계층 모수 = 보고서 유닛 소속 ∧ 제외 유닛 아님.
    URL 인용률 프롬프트 단위(url_prompts, :1244-1271 sharedWhere 만)와 답변 분석(비카드, 현행 미러 cumulative) 요청은 게이트 없음.
    게이트는 카드 경로(MeasureScope.card = CommonFilters.card, 현행 집계층 호출)에만. 글로벌·프로젝트 무관."""
    on = P.LegacyProfile(web_registered_only=True)
    pred = M.web_unit_pred("a")
    assert "rd.web_report_prompt" in pred and "app.website_report_excluded" in pred
    web = dataclasses.replace(_ms(2, on), card=True)
    plan = M.plan_counts(web, WIN, parts=M.ALL_PARTS)
    by_role = {role: q.text for role, q in plan.statements}
    assert by_role["main"].count(pred) >= 2                           # WHERE 의 인용 모수 + 언급 FILTER
    assert pred in by_role["prompts"]                                 # M12 측정 프롬프트(언급 모수)
    assert pred not in by_role["url_prompts"]                         # URL 인용률 프롬프트 단위는 게이트 없음(현행)
    assert M.web_unit_pred("b") in M.competitor_rows_sql(web, WIN).text                   # 경쟁 행(answer_brand)
    assert M.web_unit_pred("c") in M.citation_counts_sql(web, WIN).text                   # 원소 스캔(rd.citation)
    for table in ("answer", "brand", "stance"):
        assert M.mention_population(web, "x", table).endswith(M.web_unit_pred("x") + ")")
    # 게이트가 걸리지 않는 곳: 꺼짐·글로벌(카드여도)·프로젝트·답변 분석(비카드)
    for ms in (dataclasses.replace(_ms(2), card=True), dataclasses.replace(_ms(1, on), card=True), _ms(3, on), _ms(2, on)):
        assert "web_report_prompt" not in " ".join(q.text for _, q in M.plan_counts(ms, WIN, parts=M.ALL_PARTS).statements)
    # cell_rep 과 함께면 대표 술어 뒤에 붙는다(A1·WEBREG16 합성)
    both = dataclasses.replace(_ms(2, P.LegacyProfile(web_registered_only=True, cell_rep=True)), card=True)
    assert M.citation_population(both, "a") == f"(a.is_rep AND a.cit_in AND {pred})"
    assert M.citation_population(both, "a", unit_gate=False) == "(a.is_rep AND a.cit_in)"


def test_switch_web_geo_answer_region():
    """현행 14키 웹사이트 국가 축 = 집계층 국가 COALESCE(ws.country_code, a.region)(surface-website.ts:302-305). 기간도 S4.periodRoute 로
    집계층을 읽어 답변 region(미러 scope-aggregates.ts:7424)은 쓰지 않는다(WU-0 r2 C11 F05 path summary·키에 CN-BJ·CPO·EU 유사 코드).
    보고서 유닛 모수 위에서 허브 geo_key = 사이트 국가 = 현행(stg 216,783/216,783) → 조회 식 불변, web_registered_only 필수."""
    with pytest.raises(ValueError, match="web_registered_only"):
        P.LegacyProfile(web_geo_answer_region=True)
    with pytest.raises(ValueError, match="web_registered_only"):
        P.parse_profile("web_geo_answer_region")
    both = P.LegacyProfile(web_geo_answer_region=True, web_registered_only=True)
    only = P.LegacyProfile(web_registered_only=True)
    for card in (True, False):          # 카드 경로(GEO 는 card=true: 현행 S4.dashboard)·비카드 모두 web_registered_only 와 같은 문장
        ma, mb = dataclasses.replace(_ms(2, both), card=card), dataclasses.replace(_ms(2, only), card=card)
        a = M.plan_counts(ma, WIN, group_by=("geo",), parts=M.ALL_PARTS)
        b = M.plan_counts(mb, WIN, group_by=("geo",), parts=M.ALL_PARTS)
        assert [q.text for _, q in a.statements] == [q.text for _, q in b.statements]
        assert "a.geo_key AS geo_key" in a.statements[0][1].text and "region_geo_key" not in a.statements[0][1].text
        assert ("web_report_prompt" in a.statements[0][1].text) == card
        assert M.competitor_rows_sql(ma, WIN, group_by=("geo",)).text == M.competitor_rows_sql(mb, WIN, group_by=("geo",)).text


# ── WU-3(R04CIT·DFLT): 카드 경로(card=true) 기간 창 자리 대표·전 엔진. 값 대조(DB)는 tests/core/test_card_path.py ─────────────
def _card_rows():
    """stg hmg_r2 글로벌 원장 모양(2026-10-01 읽기 전용 프로브): 06-08 완결성 0.49933(1498/748), 08-24 자리에 정상 회차 413(앵커 08-18,
    9071/9068)과 수집 오류 인용 숨김 회차 551(앵커 08-25, 9652/9652), 08-31 단독 회차 655."""
    def r(k, d, ad, hid=0, why=0, exp=None, comp=None):
        return {"cyc_key": k, "project_key": 1, "round_date": d, "hidden_scope": hid, "hidden_reason": why, "generation": 7,
                "anchor_date": ad, "cycle_id": f"{k:08d}-0000-0000-0000-000000000000", "expected_units": exp, "completed_units": comp,
                "completed_answers": comp}
    return [r(1, date(2026, 6, 8), date(2026, 6, 7), exp=1498, comp=748),
            r(413, date(2026, 8, 24), date(2026, 8, 18), exp=9071, comp=9068),
            r(551, date(2026, 8, 24), date(2026, 8, 25), hid=2, why=1, exp=9652, comp=9652),
            r(655, date(2026, 8, 31), date(2026, 8, 31), exp=38748, comp=38748),
            {"cyc_key": None, "project_key": None, "round_date": None, "hidden_scope": None, "hidden_reason": None, "generation": 7,
             "anchor_date": None, "cycle_id": None, "expected_units": None, "completed_units": None, "completed_answers": None}]


def test_switch_card_slot_rep(monkeypatch):
    """현행 viaGlobalS1(server.ts:1945-1958) → restrictToTrendSlotSet(cycle-set.ts:883): 기간 카드 = 자리마다 대표 회차 하나."""
    from app.core import cycles as C
    from app.core import db as D

    seen: list[str] = []

    async def fake(conn, sql, params):
        seen.append(sql)
        rows = _card_rows()
        if "c.anchor_date" not in sql:        # 종전 _RANGE_SQL: 사다리 열 없음
            rows = [{k: v for k, v in x.items() if k in ("cyc_key", "project_key", "round_date", "hidden_scope", "hidden_reason", "generation")}
                    for x in rows]
        return rows

    monkeypatch.setattr(D, "fetch_all", fake)
    on = P.LegacyProfile(card_slot_rep=True)
    lo, hi = date(2026, 6, 1), date(2026, 9, 1)

    def win(profile, card, surface="global"):
        return asyncio.run(C.resolve_window(None, surface=surface, project_keys=(1,), date_from=lo, date_to=hi, profile=profile, card=card))

    base = win(P.OFF, True)
    assert base.cyc_keys("mentions") == (1, 413, 551, 655) and base.cyc_keys("citations") == (1, 413, 655) and base.hidden_basis is None
    assert win(on, False) == base and "c.anchor_date" not in seen[-1]         # 카드 요청이 아니면 종전 창·종전 문장
    w = win(on, True)
    assert "c.anchor_date" in seen[-1]
    # 06-08: 언급 대표 완결성 0.49933 < 0.9 → 자리 전체 제외. 08-24: 언급 대표 = 늦은 앵커 551(인용 숨김은 언급 사다리가 안 본다),
    # 인용 대표 = 인용 숨김을 뺀 413. 08-31: 단독
    assert w.cyc_keys("mentions") == (551, 655) and w.cyc_keys("citations") == (413, 655)
    assert w.cyc_keys("any") == (655,) and w.cyc_keys("row") == (413, 551, 655)
    assert (w.lo, w.hi, w.mode, w.generation) == (lo, hi, "cumulative", 7)
    # 억제 판정은 좁히기 전 키: 자리 대표는 숨김이 아니다(현행 카드는 대표 밖 회차를 조용히 뺀다)
    assert w.hidden_basis == base.keys
    assert not w.partially_hidden("mentions") and w.partially_hidden("citations") == base.partially_hidden("citations")
    assert not w.hidden("mentions") and not w.empty
    # SQL 은 창 키 바인드 값만 바뀐다(술어 모양 동일)
    from app.core.sqlb import Binder
    bw, bb = Binder(), Binder()
    assert w.where("a", "mentions", bw) == base.where("a", "mentions", bb)
    assert bw.params["p3"] == [551, 655] and bb.params["p3"] == [1, 413, 551, 655]
    # 스냅샷(기간 없음)은 좁히지 않는다(현행 스냅샷은 회차 하나: pickGlobalCycle)
    snap = asyncio.run(C.resolve_window(None, surface="global", project_keys=(1,), date_from=None, date_to=None, profile=on, card=True))
    assert snap.hidden_basis is None
    # 전 자리가 완결성 갭이면 계열 키가 비고(값 없음 = 현행 onSlotGap null), 억제 판정은 그대로
    only_gap = C.card_period_keys("global", [C.GridCycle(1, "a", 1, date(2026, 6, 8), date(2026, 6, 7), 0, 0, True, 1498, 748, 748)])
    assert only_gap == {"mentions": (), "citations": (), "any": (), "row": ()}
    # 웹사이트: 그룹 = (프로젝트, 자리), 완결성은 보지 않는다(server.ts:4894 websiteSlotRestrictedSet)
    web = C.card_period_keys("website", [
        C.GridCycle(21, "a", 2, date(2026, 9, 18), date(2026, 9, 14), 0, 0, True, 10, 1, 1),
        C.GridCycle(22, "b", 2, date(2026, 9, 18), date(2026, 9, 18), 0, 0, True, 10, 10, 10),
        C.GridCycle(23, "c", 3, date(2026, 9, 18), date(2026, 9, 14), 0, 0, True, 10, 1, 1)])
    assert web["mentions"] == (22, 23) and web["citations"] == (22, 23)
    assert "card_slot_rep" in P.IMPLEMENTED


def test_switch_summary_all_engines():
    """현행 집계층 리더(summary-trend-aggregates.ts:730): 엔진 필터 없음 = 전 엔진. 카드 경로(ms.card)의 사실 표 술어만 바뀐다."""
    from app.core.sqlb import Binder

    on = P.LegacyProfile(summary_all_engines=True)
    card_on = dataclasses.replace(_ms(1, on), card=True)
    assert "a.dflt" not in M.scope_where(card_on, "a", Binder())
    assert "a.dflt" in M.scope_where(_ms(1, on), "a", Binder())                              # 카드 요청이 아니면 기본 엔진
    assert "a.dflt" in M.scope_where(dataclasses.replace(_ms(1), card=True), "a", Binder())  # 스위치 꺼짐이면 기본 엔진
    picked = dataclasses.replace(card_on, engine_keys=(3,))
    bp = Binder()
    assert M.scope_where(picked, "a", bp)[-1] == "a.engine_key = ANY(CAST(:p2 AS int2[]))" and bp.params["p2"] == [3]   # 고르면 그 엔진
    # rd.acr_cell(dflt 열 없음)은 카드 경로가 아니다: 기본 엔진 배열 그대로
    assert any(t.startswith("a.engine_key = ANY(") for t in M.scope_where(card_on, "a", Binder(), dflt_column=False))
    # 빌더 전체: 카드 경로 문장에서 dflt 술어만 빠진다
    txt_on = "\n".join(q.text for _, q in M.plan_counts(card_on, WIN, parts=M.ALL_PARTS).statements)
    txt_off = "\n".join(q.text for _, q in M.plan_counts(_ms(1), WIN, parts=M.ALL_PARTS).statements)
    assert ".dflt" in txt_off and ".dflt" not in txt_on
    assert "summary_all_engines" in P.IMPLEMENTED


# ── WU-3b RESUB(투영 스위치): 답변 회차 = run 원장 멤버십. DB 값 시험은 ingest/project/apply/tests/test_attrib_member.py ──
def test_switch_resub_phantom_exclude():
    from ingest.project.apply import queries as Q

    sp = P.SWITCHES["resub_phantom_exclude"]
    assert sp.kind == "projection" and not sp.slot.startswith("core.") and "resub_phantom_exclude" in P.IMPLEMENTED
    assert P.parse_profile("resub_phantom_exclude").on == ("resub_phantom_exclude",)
    on = P.LegacyProfile(resub_phantom_exclude=True)
    assert Q.runc_sql(P.OFF) == Q.RUNC and Q.runc_sql(on) == Q.RUNC.replace(Q.ATTRIB_MARK, "/*attrib_member*/true")
    upd = Q.RUNC[Q.RUNC.index("UPDATE _ig_runc"):]
    assert "ing.cycle_run cr JOIN ing.cycle m" in upd and "NOT rc.op_pin_kept" in upd and Q.ATTRIB_MARK in upd
    seed = pathlib.Path(Q.__file__).resolve().parents[3] / "migration" / "seed"
    s40 = (seed / "seed-40-facts.sql").read_text(encoding="utf-8")
    blk = s40[s40.index("\\if :attrib_member"):]
    assert blk.index("UPDATE _run_c rc SET cyc_key = m.cyc_key") < blk.index("\\endif") and "NOT rc.op_pin_kept" in blk
    s20 = (seed / "seed-20-ing.sql").read_text(encoding="utf-8")
    assert "WHEN :'attrib_member' = '1'" in s20 and "min(x.round_date) FROM mig_src.scope_answer_cycle_anchors x WHERE x.cycle_id = c.cycle_id" in s20

# ════════════════════════════════════════════════════════════════════════════
# 8. WU-5 스위치 단위 시험(G21A·OWN4). 값 시험(적재 = bulk, 원소 = 답변 열)은 ingest/tests/test_wu5_projection.py
# ════════════════════════════════════════════════════════════════════════════
def test_switch_m05_den_hostless():
    """현행 ⑤ 분모 = 도메인 NULL 인용 포함(context.ts:205-231). 답변 열 경로 = cit_n_all, 원소 스캔 = 호스트 술어를 FILTER 로. 목록 소비자는 제외 유지."""
    on = P.LegacyProfile(m05_den_hostless=True)
    ms = _ms(1, on)
    assert M.m05_den_col(ms, "a") == "a.cit_n_all" and M.m05_den_col(_ms(1), "a") == "a.cit_n"
    main = dict(M.plan_counts(ms, WIN, parts=("citations",)).statements)["main"].text
    assert "sum(a.cit_n_all)" in main and "sum(a.cit_n)" not in main
    # 인용 화면 프롬프트 목록(m05_den=False)은 호스트 있는 인용 수(현행 목록도 도메인 NULL 제외)
    lst = dict(M.plan_counts(ms, WIN, parts=("citations",), m05_den=False).statements)["main"].text
    assert "sum(a.cit_n)" in lst and "cit_n_all" not in lst
    # 원소 스캔(글로벌 언어 좁힘 = scan 모드): WHERE 에서 호스트 술어를 빼고 cit_total 밖 열은 호스트 있는 인용만
    scan_ms = dataclasses.replace(ms, owner=dataclasses.replace(OWN, lang_narrowed=True))
    scan = dict(M.plan_counts(scan_ms, WIN, parts=("citations",)).statements)["scan"].text
    where = scan.split("WHERE", 1)[1] if "\n WHERE " not in scan else scan.split("\n WHERE ", 1)[1]
    assert "c.source_key <> 0" not in where and "count(*) AS cit_total" in scan
    assert "FILTER (WHERE c.source_key <> 0 AND c.owner_key" in scan and "FILTER (WHERE c.source_key <> 0 AND c.tgt_hit)" in scan
    # 출처 카테고리 축(source[])이 있으면 호스트 없는 인용은 카테고리가 없어 원래 빠진다: 종전 식 그대로
    src_ms = dataclasses.replace(ms, source_category_keys=(3,))
    src = dict(M.plan_counts(src_ms, WIN, parts=("citations",)).statements)["scan"].text
    assert src == M.citation_counts_sql(dataclasses.replace(src_ms, profile=P.OFF), WIN).text
    # 출처·URL 단위 소비자(도메인 목록 C-1, 기본 m05_den=False)는 스위치와 무관(현행 도메인 목록은 도메인 NULL 제외)
    for g in ((), ("source",), ("url",)):
        assert M.citation_counts_sql(ms, WIN, group_by=g).text == M.citation_counts_sql(_ms(1), WIN, group_by=g).text
        assert M.citation_counts_sql(ms, WIN, group_by=g, m05_den=bool(g)).text == M.citation_counts_sql(_ms(1), WIN, group_by=g).text
    assert "m05_den_hostless" in P.IMPLEMENTED


def test_switch_cit_hostless_per_row():
    """현행 호스트 없는 인용 = 행 자신의 도메인 NULL·빈 값(citation-group-key.ts:57). 적재기 FACT_SRC 표식과 seed-40 psql 변수가 같은 규칙."""
    from ingest.project.apply import queries as q

    off = q.fact_src_sql(q.FACT_SRC, P.OFF)
    on = q.fact_src_sql(q.FACT_SRC, P.LegacyProfile(cit_hostless_per_row=True))
    assert "coalesce(u.source_key, 0) AS source_key" in off and "domain_label" not in off
    assert q.ROW_SRC_ON + " AS source_key" in on and "/*" not in on
    seed = (pathlib.Path(__file__).parents[2] / "migration" / "seed" / "seed-40-facts.sql").read_text(encoding="utf-8")
    assert "\\if :cit_row_host\n" in seed and "UPDATE _cr SET source_key = 0 WHERE coalesce(row_domain, '') = '' AND source_key <> 0;" in seed
    assert P.SWITCHES["cit_hostless_per_row"].kind == "projection" and "cit_hostless_per_row" in P.IMPLEMENTED


def test_switch_web_owned_target_base():
    """현행 웹사이트 자사 타겟 항 = base NORM ∈ 유닛 타겟 base NORM(unitOwnedSql surface-website.ts:244-256). 허브 기본 = tracked NORM ∈ turls."""
    from ingest.project.apply import queries as q

    off = q.fact_src_sql(q.FACT_SRC, P.OFF)
    on = q.fact_src_sql(q.FACT_SRC, P.LegacyProfile(web_owned_target_base=True))
    tb = "c.url_base_norm = ANY (ARRAY(SELECT rtrim(split_part(t, '?', 1), '/') FROM unnest(w.turls) t))"
    assert "c.url_norm = ANY (w.turls)" in off and tb not in off
    assert "c.url_norm = ANY (w.turls)" not in on and tb in on
    # 꺼짐 = 표식만 지운 도입 전 문장
    stripped = q.FACT_SRC
    for mk in ("/*row_src*/", "/*row_src_end*/", "/*web_tgt*/", "/*web_tgt_end*/"):
        stripped = stripped.replace(mk, "")
    assert off == stripped
    seed = (pathlib.Path(__file__).parents[2] / "migration" / "seed" / "seed-40-facts.sql").read_text(encoding="utf-8")
    assert "\\if :web_tgt_base\n" in seed and tb in seed
    assert P.SWITCHES["web_owned_target_base"].kind == "projection" and "web_owned_target_base" in P.IMPLEMENTED


def test_catalog_all_pred_correction_set():
    """A41 보정 집합 형(WU-5 성능): cat_diff 를 알면 사실 표 bgrp + 작은 상수 배열, 모르면 세미조인(정의). D 가 비면 끔과 같은 술어."""
    from app.core.sqlguard import fact_guard

    on = P.LegacyProfile(catalog_incl_deleted=True)
    ms = dataclasses.replace(_ms(1, on), bgrps=(1, 3, 5), cat_diff=((7, 5), (8, 0), (9, None), (10, 2)))
    b = M.Binder("t")
    pred = M.catalog_all_pred(ms, "a", b)
    assert pred == ("((a.bgrp = ANY(CAST(:t0 AS int2[])) AND NOT (a.prompt_key = ANY(CAST(:t1 AS int4[])))) "
                    "OR a.prompt_key = ANY(CAST(:t2 AS int4[])))")
    assert b.params == {"t0": [1, 3, 5], "t1": [7, 8, 9, 10], "t2": [7]}       # D = 삭제 영향 프롬프트, D_ok = 그중 cat_mask_all ∈ 관점
    none_ok = dataclasses.replace(ms, cat_diff=((8, 0), (10, 2)))
    assert M.catalog_all_pred(none_ok, "a", M.Binder("t")) == "(a.bgrp = ANY(CAST(:t0 AS int2[])) AND NOT (a.prompt_key = ANY(CAST(:t1 AS int4[]))))"
    empty = dataclasses.replace(ms, cat_diff=())
    assert M.catalog_all_pred(empty, "a", M.Binder("t")) == "a.bgrp = ANY(CAST(:t0 AS int2[]))"
    assert M.catalog_all_pred(dataclasses.replace(ms, cat_diff=None), "a", M.Binder("t")).startswith("a.prompt_key IN (SELECT d.prompt_key")
    for t in _all_sql(ms, WIN):
        assert fact_guard(t) == [], t


# ── WU-12 (BRANDCAP): 카드 경로 브랜드 상한. 값 시험(DB)은 analytics/mentions/brands/tests/test_mentions_brands_card_cap.py ──
def test_switch_card_brand_cap():
    from app.features.analytics.mentions.brands import service as svc

    comps = [{"brand_key": k, "name": f"b{k:03d}", "mentions": 1000 - k, "is_own": False} for k in range(1, 251)]
    comps.append({"brand_key": 999, "name": "a-tie", "mentions": 1000 - 199, "is_own": False})   # 199위와 동률, 이름이 앞 → 199위
    on = dataclasses.replace(_ms(1, P.LegacyProfile(card_brand_cap=True)), card=True)
    kept = svc._card_kept(on, comps, 1)
    assert svc.CARD_BRAND_CAP == 200 and len(kept) == 199                            # 당사 1행 + 경쟁 199행 = 200
    assert 999 in kept and 199 not in kept and 198 in kept                           # 동률은 이름 순(rank_brand_items)
    assert svc._card_kept(dataclasses.replace(on, card=False), comps, 1) is None     # 언급 화면(card=false) 은 절단 없음
    assert svc._card_kept(dataclasses.replace(_ms(1), card=True), comps, 1) is None  # 스위치 꺼짐
    assert len(svc._card_kept(on, comps, 3)) == 197                                  # 관점 브랜드 3(admin) = 당사 3행
    assert P.SWITCHES["card_brand_cap"].kind == "read" and "card_brand_cap" in P.IMPLEMENTED


# ── WU-12(analytics.citations.domains): 대시보드 도메인 목록 = 도메인(호스트) 단위. 값 시험은 domains/tests/test_wu12_host_fold.py ──
def test_switch_domains_card_by_host(monkeypatch):
    from app.features.analytics.citations.domains import queries as dq

    ctx = _compare_ctx("global")
    win = WIN
    texts = {}
    for name, prof, card, hf in (("off", P.OFF, True, True), ("on_plain", P.LegacyProfile(domains_card_by_host=True), False, False),
                                 ("on_card", P.LegacyProfile(domains_card_by_host=True), True, False),
                                 ("on_hf", P.LegacyProfile(domains_card_by_host=True), False, True)):
        c = dataclasses.replace(ctx, card=card)
        monkeypatch.setattr(type(c), "measure", lambda self, _p=prof: _ms(1, _p))
        texts[name] = (dq.domains_sql(c, win, limit=20, cursor=None, mention_brand_key=None, host_fold=hf).text,
                       dq.domains_sql(c, win, limit=0, cursor=None, mention_brand_key=None, host_fold=hf).text)
    off_list, off_tot = texts["off"]
    assert "WITH fm AS (" not in off_list and "WITH fm AS (" not in off_tot                  # 꺼짐 = 카드·host_fold 여도 그룹 키 단위
    assert texts["on_plain"] == texts["off"]                                                 # 켜짐이어도 인용 화면(카드·host_fold 없음)은 그대로
    for k in ("on_card", "on_hf"):
        lst, tot = texts[k]
        assert lst.startswith("\nWITH fm AS (") and "\ngp AS (\n" in lst and "\ngf AS (\n" in lst and "FROM gf g JOIN rd.dim_source ds" in lst
        assert tot.startswith("\nWITH fm AS (") and "\ngs AS (\n" in tot and "FROM gs JOIN fk ON fk.k = gs.source_key GROUP BY fk.hk" in tot
        # 인용 스캔 문장은 그대로(접기는 접은 CTE 위에서만: 스캔 병렬 계획 유지)
        scan = off_list.split("g0 AS (", 1)[1].split("\ns AS MATERIALIZED", 1)[0]
        assert scan in lst and off_tot.split("g AS (", 1)[1].split("),\ns AS MATERIALIZED", 1)[0] in tot
    assert P.SWITCHES["domains_card_by_host"].kind == "read" and "domains_card_by_host" in P.IMPLEMENTED


# ── WU-12(analytics.kpi.compare): compare_cycle_set. 라우트·값 시험은 compare/tests/test_compare_cycle_set.py ──
def test_switch_compare_cycle_set(monkeypatch):
    """켜짐 ∧ 글로벌이면 compare 가 core.cycles 세 함수에 fleet_any=True 를 넘긴다(발행 = status published, 함대 가시성 무관).
    꺼짐·웹사이트는 인자 자체를 넘기지 않는다(도입 전 호출과 같다)."""
    from app.core import cycles as C
    from app.features.analytics.kpi.compare import service as svc
    from app.features.analytics.kpi.compare.schemas import CompareQuery

    seen: list[tuple[str, dict]] = []

    async def rw(conn, **kw):
        seen.append(("resolve_window", kw))
        return C.build_window(surface=kw["surface"], mode="cumulative", rows=[], lo=kw["date_from"], hi=kw["date_to"], generation=1,
                              project_keys=(1,))

    async def lr(conn, **kw):
        seen.append(("ledger_rows", kw))
        return []

    async def fp(conn, **kw):
        seen.append(("first_published", kw))
        return None

    monkeypatch.setattr(svc, "resolve_window", rw)
    monkeypatch.setattr(svc, "ledger_rows", lr)
    monkeypatch.setattr(svc, "first_published", fp)

    async def fc(conn, ms, win, **kw):
        return []

    monkeypatch.setattr(svc, "fetch_counts", fc)
    for surface, prof, want in (("global", P.LegacyProfile(compare_cycle_set=True), True), ("global", P.OFF, False),
                                ("website", P.LegacyProfile(compare_cycle_set=True), False)):
        seen.clear()
        q = CompareQuery(surface=surface, **{"from": "2026-09-08", "to": "2026-09-14"})
        cx = dataclasses.replace(_compare_ctx(surface), date_from=date(2026, 9, 8), date_to=date(2026, 9, 14))
        asyncio.run(svc.get_compare(None, cx, q, today=date(2026, 9, 27), profile=prof))
        assert {n for n, _ in seen} == {"resolve_window", "ledger_rows", "first_published"}
        assert all(kw.get("fleet_any", False) is want for _, kw in seen), (surface, prof.spec)
        assert all(("fleet_any" in kw) is want for _, kw in seen)
    assert C._RANGE_SQL_FLEET_ANY != C._RANGE_SQL and "(c.servable OR c.status = 2)" in C._RANGE_SQL_FLEET_ANY


# ── WU-12(CACC6): 웹 ⑥ 인용 정확도 현행 정의. DB 대조는 tests/core/test_web_accuracy.py ──
def test_switch_web_accuracy_flat():
    """현행 ⑥ 두 경로: 카드·기간 없음·추이 = 집계층 유닛 flat 타겟(surface-website.ts:805-820 ut, summary-website-aggregates.ts:1164-1180),
    기간 카드·비카드 = 미러(scope-aggregates.ts:8970-9010: 화면 사이트 전체 타겟, 분모 = 자사 ∨ 타겟, 유닛 게이트 없는 모수).
    S4: 카드 몫(unit)은 동결 층 생성 시점 셀 판정(frz.card_web)이라 freeze_at_publish 를 요구하고, 창 판정(frz_ok)을 거친 스코프에서만 성립한다."""
    with pytest.raises(ValueError, match="web_registered_only"):
        P.LegacyProfile(web_accuracy_flat=True)
    with pytest.raises(ValueError, match="freeze_at_publish"):
        P.LegacyProfile(web_accuracy_flat=True, web_registered_only=True)
    assert P.REQUIRES["web_accuracy_flat"] == ("web_registered_only", "freeze_at_publish")
    on = P.LegacyProfile(web_accuracy_flat=True, web_registered_only=True, freeze_at_publish=True, cell_rep=True, catalog_incl_deleted=True,
                         rep_pick_latest_first=True)
    assert M.accuracy_mode(True, False) == "unit" and M.accuracy_mode(True, True) == "screen" and M.accuracy_mode(False, False) == "screen"
    assert M.legacy_accuracy(_ms(2, on)) and not M.legacy_accuracy(_ms(1, on)) and not M.legacy_accuracy(_ms(3, on))
    assert not M.legacy_accuracy(_ms(2))
    card = dataclasses.replace(_ms(2, on), card=True)
    with pytest.raises(ValueError, match="동결 읽기"):
        M.accuracy_counts_sql(card, WEB, mode="unit")                                 # 창 판정을 거치지 않은 카드 스코프 = 유닛 경로 없음
    frz = dataclasses.replace(card, frz_ok=True)
    unit = M.accuracy_counts_sql(frz, WEB, mode="unit").text
    assert "FROM frz.card_answer_w a" in unit                                         # 웹 카드 읽기 뷰(카드 뷰 열 + 웹 셀 판정 열, DB-v2.24 P127)
    assert "count(*) FILTER (WHERE a.unit_owned) AS own_url_hits" in unit and "FILTER (WHERE a.unit_owned AND a.unit_target) AS tgt_own_hits" in unit
    assert "a.unit_in" in unit                                                        # 모수 = 생성 시점 유닛 소속 ∧ 제외 유닛 아님(뷰 열)
    assert "rd.web_report_prompt" not in unit and "a.web_reg" not in unit and "rd.dim_url" not in unit   # 조회 시점 유닛·타겟 해석 없음
    screen = M.accuracy_counts_sql(frz, WEB, mode="screen").text
    assert "web_report_prompt" not in screen and "a.web_reg" not in screen and "frz." not in screen   # 미러 모수: card 를 끈 rd 읽기
    assert "FILTER (WHERE (a.own_url_cited OR a.answer_key IN (SELECT answer_key FROM hit))) AS own_url_hits" in screen
    lang = M.accuracy_counts_sql(dataclasses.replace(frz, lang_keys=(3,)), WEB, mode="screen")
    assert "t.lang_key = ANY(" in lang.text                                           # 타겟 집합은 언어 축으로 좁힌다(websiteTargetSetSelect)
    assert "FROM rd.web_target_url t WHERE t.project_key = ANY(" in screen and "c.url_key IN (SELECT url_key FROM tg)" in screen
    assert "rd.dim_url" not in screen                                                # 사전 해석 표(DB-v2.20): 인용은 url_key 만 본다
    g = M.accuracy_counts_sql(frz, WIN, mode="unit", group_by=("round_date",)).text
    assert "GROUP BY 1" in g
    from app.core.sqlguard import fact_guard
    assert fact_guard(unit) == [] and fact_guard(screen) == [] and fact_guard(g) == []
    with pytest.raises(ValueError):
        M.accuracy_counts_sql(frz, WEB, mode="x")  # type: ignore[arg-type]


# ── 리팩터 #13(DC-23): 프로젝트 ⑥ 현행 미러 정의. DB 대조는 tests/core/test_project_accuracy.py ──
def test_switch_project_accuracy_single_base(settings):
    """현행 프로젝트 ⑥(scope-aggregates.ts:8392-8559, projects/[id]/_data/live.ts:225-268): 유효 owned base 하나의 normalizeUrlForMatch 접두 P 로
    자사(정규형 = P ∨ LIKE P || '/%'), 분모 = 자사 답변, 분자 = 자사 ∧ 추적 URL 답변. 판정 입력이 없으면 값 없음. 모수는 허브 ⑥ 과 같다."""
    on = P.LegacyProfile(project_accuracy_single_base=True)
    sp = P.SWITCHES["project_accuracy_single_base"]
    assert sp.kind == "read" and "project_accuracy_single_base" in P.IMPLEMENTED and "project_accuracy_single_base" not in P.REQUIRES
    assert M.project_accuracy(_ms(3, on)) and not M.project_accuracy(_ms(2, on)) and not M.project_accuracy(_ms(1, on))
    assert not M.project_accuracy(_ms(3))
    base, B = M.project_accuracy_base, M.ProjectAccuracyBase
    # 유효 base: 설정 1개 = 그것(domain 무시), 설정 0개 = domain, 설정 2개 이상·둘 다 없음 = 값 없음. 추적 URL 0개 = 값 없음
    assert base("kia.com/it", ["https://www.Kia.com/de/"], ["https://kia.com/de/ev9?utm_source=x#top"]) == B("kia.com/de", ("kia.com/de/ev9",))
    assert base("https://www.kia.com/it/", [], ["https://kia.com/it/a"]) == B("kia.com/it", ("kia.com/it/a",))
    assert base("a.com", ["https://a.com/", "https://b.com/"], ["https://a.com/x"]) is None
    assert base(None, [], ["https://a.com/x"]) is None and base("a.com", [], []) is None
    # 추적 URL: 원문을 정규화(중복 제거·정렬·빈 값 제외). 정규화 뒤 모두 비어도 값은 있다(분자 0 = 현행 targetClause false)
    assert base("a.com", [], ["https://www.a.com/x/", "http://a.com/x", "https://a.com/b?v=1&utm_medium=y"]).targets == ("a.com/b?v=1", "a.com/x")
    assert base("a.com", [], ["   "]) == B("a.com", ())
    assert base("https://", [], ["https://a.com/x"]) is None                       # 빈 접두(허브 쓰기 불변식상 없음) = 값 없음
    prj = build_window(surface="project", mode="snapshot", rows=ROWS[:1], lo=date(2026, 9, 28), hi=date(2026, 9, 28), generation=1,
                       project_keys=(1,))
    ms = dataclasses.replace(_ms(3, on), bgrps=None)
    q = M.project_accuracy_counts_sql(ms, prj, B("kia.com/de", ("kia.com/de/ev9",)))
    t = q.text
    assert "FROM rd.citation c JOIN rd.dim_url u ON u.url_key = c.url_key" in t and "GROUP BY c.answer_key" in t
    assert "bool_or(u.url_norm = CAST(:y0 AS text) OR u.url_norm LIKE CAST(:y0 AS text) || '/%') AS owned" in t   # 현행 LIKE 그대로
    assert "bool_or(u.url_norm = ANY(CAST(:y1 AS text[]))) AS target" in t and q.params["y0"] == "kia.com/de" and q.params["y1"] == ["kia.com/de/ev9"]
    assert "count(*) FILTER (WHERE h.owned) AS own_url_hits" in t and "count(*) FILTER (WHERE h.owned AND h.target) AS tgt_own_hits" in t
    assert "FROM rd.answer a JOIN hit h ON h.answer_key = a.answer_key" in t and "a.cit_in" in t and "a.dflt" in t   # 모수 = 허브 ⑥ 과 같은 술어
    assert not any(x in t for x in ("own_url_cited", "tgt_cited", "loc_owned", "tgt_hit", "source_key"))         # 적재 판정·호스트 게이트 없음
    assert "GROUP BY" not in t.split("\nSELECT ")[-1]
    g = M.project_accuracy_counts_sql(ms, prj, B("kia.com/de", ()), group_by=("round_date", "engine")).text
    assert "GROUP BY 1, 2" in g
    from app.core.sqlguard import fact_guard
    assert fact_guard(t) == [] and fact_guard(g) == []
    # 결과 캐시 끝점 추가 키: 꺼짐·다른 표면·uuid 아닌 project_id 는 문장 없이 None
    from starlette.datastructures import QueryParams
    try:
        set_settings(settings.model_copy(update={"legacy_profile": "off"}))
        pid = "c0000000-0000-4000-8000-000000000003"
        assert asyncio.run(M.project_accuracy_cache_key(None, QueryParams({"surface": "project", "project_id": pid}))) is None
        set_settings(settings.model_copy(update={"legacy_profile": "project_accuracy_single_base"}))
        assert asyncio.run(M.project_accuracy_cache_key(None, QueryParams({"surface": "website", "project_id": "x"}))) is None
        assert asyncio.run(M.project_accuracy_cache_key(None, QueryParams({"surface": "project", "project_id": "x"}))) is None
    finally:
        set_settings(settings)


# ════════════════════════════════════════════════════════════════════════════
# 동결 층 S3(freeze_at_publish): 카드 요청 ∧ global·website 만 카드 뷰, 글로벌 격자 = 격자 뷰, 카탈로그 = 동결 비트(사실 행 bgrp). DB 값 시험은
# tests/core/test_frz_read.py
# ════════════════════════════════════════════════════════════════════════════
def test_switch_freeze_at_publish():
    from app.core import facts as F
    from app.core.sqlb import Binder

    on = P.LegacyProfile(freeze_at_publish=True, cell_rep=True, catalog_incl_deleted=True, rep_pick_latest_first=True, web_registered_only=True)
    assert P.REQUIRES["freeze_at_publish"] == ("cell_rep", "catalog_incl_deleted", "web_registered_only")
    with pytest.raises(ValueError, match="cell_rep"):
        P.LegacyProfile(freeze_at_publish=True)
    assert P.SWITCHES["freeze_at_publish"].kind == "read" and "freeze_at_publish" in P.IMPLEMENTED
    for sf in (1, 2, 3):
        card, ana = dataclasses.replace(_ms(sf, on), card=True, frz_ok=True), _ms(sf, on)
        assert F.fact_tables(ana) == F.LIVE
        assert F.fact_tables(card) == {1: F.CARD, 2: F.CARD_WEB}.get(sf, F.LIVE)
        assert F.fact_tables(dataclasses.replace(card, frz_ok=False)) == F.LIVE      # S4: 창 판정을 거치지 않은 카드 스코프 = 라이브
        assert F.fact_tables(dataclasses.replace(card, frz_grid=True)) == (F.GRID if sf in (1, 2) else F.LIVE)
        assert F.fact_tables(dataclasses.replace(card, profile=P.OFF)) == F.LIVE
    card = dataclasses.replace(_ms(1, on), card=True, frz_ok=True)
    texts = _all_sql(card, WIN)
    # URL 인용률 프롬프트 단위(url_prompts)의 기간 창은 현행 미러 자리(analysis_path)라 동결 뷰가 아니라 rd 를 읽는다(S4)
    url_p = [t for t in texts if "url_measured_prompts" in t]
    assert url_p and all("FROM rd.answer a" in t for t in url_p)
    texts = [t for t in texts if "url_measured_prompts" not in t]
    assert all("rd.answer " not in t and "rd.citation " not in t and "rd.answer_brand " not in t for t in texts), texts
    assert any("frz.card_answer" in t for t in texts) and any("frz.card_citation" in t for t in texts)
    assert M.catalog_all_pred(card, "a", Binder()).startswith("a.bgrp = ANY(")
    assert "rd.dim_prompt" not in " ".join(texts)                       # 동결 카탈로그 = 사실 행 bgrp(dim_prompt 세미조인 없음)
    ana_texts = _all_sql(_ms(1, on), WIN)
    assert not any("frz." in t for t in ana_texts)                    # 카드가 아니면 그대로
    # S4 택소노미 축: 동결 읽기면 조회 시점 prompt_keys 대신 frz.card_axis(생성 시점 축). 존재 축은 집합 겹침, 그 밖은 등호
    tx = dataclasses.replace(card, prompt_keys=(5, 6), taxon=(("brand_presence", (31,)), ("funnel", (11, 12))))
    w = " AND ".join(M.scope_where(tx, "a", Binder()))
    assert "frz.card_axis x WHERE " in w and "x.presence_keys && " in w and "x.funnel_key = ANY(" in w and "a.prompt_key = ANY(" not in w
    assert "a.prompt_key = ANY(" in " AND ".join(M.scope_where(dataclasses.replace(tx, frz_ok=False), "a", Binder()))
    assert "a.prompt_key = ANY(" in " AND ".join(M.scope_where(dataclasses.replace(tx, taxon=None), "a", Binder()))   # depth4 = 조회 시점
    assert "frz." not in " AND ".join(M.scope_where(dataclasses.replace(tx, taxon=()), "a", Binder()))       # 축 없음(존재 양쪽) = 무필터
    # S4 웹 유닛 게이트: 동결 읽기면 생성 시점 유닛(frz.card_web), 아니면 조회 시점(rd.web_report_prompt)
    web = dataclasses.replace(_ms(2, on), card=True, frz_ok=True)
    assert M.mention_population(web, "a").endswith("a.unit_in)") and "frz.card_web w WHERE w.report_fs IS NOT NULL" in \
        M.mention_population(web, "s", "stance")                                       # 스탠스(웹 읽기 뷰 밖)는 반조인형
    assert "rd.web_report_prompt" in M.mention_population(dataclasses.replace(web, frz_ok=False), "a")
    assert M.unit_gate_of(dataclasses.replace(web, card=False), "a") == []
    # 동결 읽기 셀 대표 = 동결 셀(is_rep 참): rd 대표 보정(rep_cit_delta, rep_round_date_cell)을 걸지 않는다. 미러 자리(analysis_path)는 건다
    rr = P.LegacyProfile(freeze_at_publish=True, cell_rep=True, catalog_incl_deleted=True, rep_pick_latest_first=True, web_registered_only=True,
                         rep_round_date_cell=True)
    fc = dataclasses.replace(_ms(1, rr), card=True, frz_ok=True)
    assert "rep_cit_delta" not in M.citation_population(fc, "c", "citation")
    assert "rep_cit_delta" in M.citation_population(dataclasses.replace(fc, frz_ok=False), "c", "citation")
    assert "rep_cit_delta" in M.citation_population(dataclasses.replace(fc, frz_ok=False), "c", "citation", analysis_path=True)
    assert F.fact_tables(None) == F.LIVE


# ════════════════════════════════════════════════════════════════════════════
# brand_card_fold(G01CF, be/int3-smartfold): 동결 층 answer_brand = 운영 summary 접기. 투영 시점이 아니라 동결(발행·이관) 시점 보관이고
# rd·미러 화면은 그대로다. DB 값 시험은 ingest/frz/tests/test_fold.py
# ════════════════════════════════════════════════════════════════════════════
def test_switch_brand_card_fold(monkeypatch):
    from ingest.frz import fold as FD

    assert P.REQUIRES["brand_card_fold"] == ("freeze_at_publish", "display_name_latin")
    with pytest.raises(ValueError, match="freeze_at_publish"):
        P.LegacyProfile(brand_card_fold=True, display_name_latin=True)
    assert P.SWITCHES["brand_card_fold"].kind == "freeze" and "brand_card_fold" in P.IMPLEMENTED     # 동결 시점(bulk 시드 입력 아님)
    # 운영 접기 식(2670a16 load.ts:78-98·fold.ts:319-323): 경쟁 = (답변, 브랜드 키, 롤업 id) 그룹 bool_or, tp = 그룹 전 언급 min(avg_position)
    # (경쟁 필터 없음), 순위 = 경쟁 행 rank() by tp
    sql = " ".join(FD.FOLD.split())
    assert "bool_or(r.competitive) OVER (PARTITION BY r.answer_key, r.brand_key, r.rid) AS cg" in sql
    assert "min(avg_position) AS tp FROM m GROUP BY 1, 2, 3" in sql
    assert "rank() OVER (PARTITION BY answer_key ORDER BY tp)::int2 AS rk FROM f WHERE competitive AND brand_key <> 0 AND tp IS NOT NULL" in sql
    # 꺼짐이면 DB 를 건드리지 않는다(연결 객체에 아무 호출도 없다)
    monkeypatch.setattr(FD, "enabled", lambda: False)

    class _NoConn:
        def __getattr__(self, name):
            raise AssertionError(f"꺼짐인데 연결 호출: {name}")

    assert asyncio.run(FD.keep_generation(_NoConn(), 1)) == {"candidates": 0, "kept": 0}
