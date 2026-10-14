"""analytics.kpi.compare 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

흐름(문장 수: 스냅샷 끝점 1~2 + 스캔 창 1 + 계열별 첫 발행 2 + 요청 지표 계열의 원장 1~2(B091) + 측정 1~2)
  1. 창: kind 별 순수 수식(logic). 끝점 E = to, 없으면 함대 최신 노출 round_date(core.cycles.resolve_window 스냅샷, Q1).
     cycle 은 스냅샷 offset 0·1 두 날.
  2. 스캔 창: core.cycles.resolve_window(기간 [스캔 시작, 스캔 끝]). 전 이력 첫 발행 F 는 core.cycles.first_published(계열 필수)가 낸다
     (스캔 끝보다 늦으면 None: 창이 이력 전체보다 이르다). 발행·F 는 계열별이다(M4). 언급 계열 = 숨김 {1,3} 제외(인용 숨김 회차는 발행:
     현행 hiddenGatesFor 계승), 인용 계열 = 숨김 {1,2} 제외(언급 숨김 회차는 발행). 지표는 자기 계열의 원장·F 로 억제를 판정한다.
  3. 원장(누락 비중, Q2 가중, 계열별): core.cycles.ledger_rows(진행 중(open ∧ 비서빙)·노출일 전·그 계열 숨김은 원장 밖, published =
     창 후보 술어). 원장은 함대 기준이다(필터·스코프 무관, 현행 CompareLedger 계승, M3): meta.source.ledger = "fleet".
  4. 측정: 창 회차만 담은 파생 Window 로 core.measure.fetch_counts(group_by cycle) 1회 스캔 → 회차 round_date 로 구간 배정.
     입력 합은 K-1 과 같은 빌더라 D6(카드 = 버킷 합)이 구조적으로 성립한다.
  5. 억제·Δ: logic.suppression_of·delta_of. data_cycles 는 계열별(언급 = std_in 답변 있는 날, 인용 = 인용 있는 날).
  답변당 언급·인용 수(BG-05, 요청할 때만): mentions_per_answer = 관점 언급 합 ÷ std_in 답변(M02 분자 ÷ M01 분모, 같은 스캔),
  citations_per_answer = 인용 합(M05 분모) ÷ 인용 계열 cit_in 답변 수. 그 분모는 같은 스캔의 gap_base(회차별 cit_in 답변,
  언급 계열 회차)이고, 언급만 숨긴 회차(인용 계열에는 있음)만 보조 문장 cit_answers_sql 로 센다(대개 0 문장).
현행 프로필(WU-9, logic 머리 주석): 창을 정한 뒤 1·2 단계보다 먼저 판정한다(현행 fetchPeriodCompare 순서: 적용일 → 집계층 억제 → 읽기).
  compare_epoch_gate 이고 cur.hi < 적용일이면 data = [] · meta.suppressed['*'] = 'before_epoch'(어댑터가 null = 종전 Δ 로 바꾼다).
  compare_suppress 이고 현행 집계층이 표현 못 하는 조합이면 전 지표 unsupported(정수 쌍 0, 원장 0, 첫 발행 null = 현행 emptyCompare).
  둘 다 원장·측정 문장을 돌리지 않는다(현행도 읽지 않는다). 스위치가 꺼져 있으면 응답은 도입 전과 바이트 같다.
  compare_cycle_set(WU-12)이고 글로벌이면 2·3·4 단계의 창 회차·원장 발행·첫 발행을 함대 가시성 무관 발행 회차로 센다(core.cycles fleet_any).
  현행 readComparePeriods(summary-period-compare.ts:536-699)는 자리 대표로 좁히지 않고 창 안 발행 회차를 전부 더한다: 자리 병합으로
  비서빙(fleet_visible 거짓)이 된 글로벌 회차(08-10 자리 343·356·396, 08-17 자리 365·414)도 직전 창 값에 들어간다.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import date
from typing import Any

from app.core import errors
from app.core.cycles import Window, build_window, first_published, frz_eligible, ledger_rows, resolve_window
from app.core.db import fetch_all
from app.core.envelope import RankAvg, Ratio, build_meta
from app.core.filters import ReadContext
from app.core.measure import fetch_counts, ratios
from app.core.profile import LegacyProfile, active_profile

from .logic import (
    EPOCH_GATED,
    METRIC_FAMILY,
    METRIC_UNIT,
    METRICS,
    Ledger,
    Windows,
    calendar_months,
    calendar_months_of,
    calendar_weeks,
    calendar_weeks_of,
    cycle_windows,
    delta_of,
    legacy_unsupported_reason,
    period_compare_applies,
    resolve_windows,
    suppression_of,
    windows_from_range,
)
from .queries import cit_answers_sql
from .schemas import CompareInfo, CompareItem, CompareMeta, CompareQuery, CompareResponse, CompareWindows, Span

FAMILY_CORE = {"mention": "mentions", "citation": "citations"}   # 비교 계열 → core 창 계열(발행 키·숨김 제외 집합)
DEFAULT_DAYS = 30
_SUM_KEYS = ("answers", "tracked", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked",
             "cit_total", "cit_owned", "cit_target", "cit_m05", "cit_answers")   # cit_m05 = M05 분자(core.measure.ratios)
# 답변당 지표(BG-05): 지표 → (분자 합 키, 분모 합 키)
PER_ANSWER_PAIR = {"mentions_per_answer": ("own_mentions", "answers"), "citations_per_answer": ("cit_total", "cit_answers")}


async def _snapshot(conn: Any, ctx: ReadContext, offset: int, today: date | None) -> Window:
    """끝점 회차. 동결 층(freeze_at_publish, S4)이면 최신 동결 회차(현행 resolveWindowEndInfo = 노출 가능 ∧ 세대 있음, summary-period-compare.ts:301-330)."""
    if frz_eligible(active_profile(), surface=ctx.surface, card=ctx.card):
        return await resolve_window(conn, surface=ctx.surface, project_keys=ctx.project_keys, date_from=None, date_to=None,
                                    offset=offset, today=today, project_ids=ctx.project_ids, profile=active_profile(), card=True)
    return await resolve_window(conn, surface=ctx.surface, project_keys=ctx.project_keys, date_from=None, date_to=None,
                                offset=offset, today=today, project_ids=ctx.project_ids)


def _period_error(kind: str, message: str) -> errors.ApiError:
    return errors.unprocessable(message, code="invalid_compare_period", details={"field": "from", "kind": kind})


def windows_for_range(kind: str, lo: date, hi: date) -> Windows:
    """from/to → 창(순수). 형식이 틀리면 422, 비교 창(직전·전전 구간)이 달력 범위(0001~9999년) 밖이면 422(D2: 500 방지)."""
    try:
        if kind == "window":
            return windows_from_range(lo, hi)
        w = calendar_months(lo, hi) if kind == "calendarMonth" else calendar_weeks(lo, hi)
    except (OverflowError, ValueError) as e:
        raise _period_error(kind, "비교 창이 날짜 범위(0001-01-01~9999-12-31)를 벗어난다") from e
    if w is None:
        rule = "from = 1일, to 는 같은 달 안" if kind == "calendarMonth" else "from = 월요일, to 는 그 주 안"
        raise _period_error(kind, f"{kind} 기간 형식: {rule}")
    return w


async def resolve_compare_windows(conn: Any, ctx: ReadContext, q: CompareQuery, today: date | None,
                                  ignored: list[str]) -> Windows | None:
    """kind·from/to·days → 창. 끝점이 없으면(노출 회차 없음) None."""
    lo, hi = ctx.date_from, ctx.date_to
    if q.kind == "cycle":
        if lo is not None:
            ignored.append("period")            # cycle 은 노출 회차 두 날이라 기간을 쓰지 않는다
        if q.days is not None:
            ignored.append("days")
        w0 = await _snapshot(conn, ctx, 0, today)
        if w0.lo is None:
            return None
        w1 = await _snapshot(conn, ctx, 1, today)
        return cycle_windows(w0.lo, w1.lo)
    if lo is not None and hi is not None:
        if q.days is not None:
            ignored.append("days")              # from/to 가 이긴다
        return windows_for_range(q.kind, lo, hi)
    if q.kind != "window" and q.days is not None:
        ignored.append("days")
    w0 = await _snapshot(conn, ctx, 0, today)
    if w0.lo is None:
        return None
    try:
        if q.kind == "window":
            return resolve_windows(w0.lo, q.days or DEFAULT_DAYS)
        return calendar_months_of(w0.lo) if q.kind == "calendarMonth" else calendar_weeks_of(w0.lo)
    except (OverflowError, ValueError) as e:  # 끝점은 DB 노출 회차라 실제로는 닿지 않는다(방어)
        raise _period_error(q.kind, "비교 창이 날짜 범위를 벗어난다") from e


def _pair(metric: str, row: dict[str, int]) -> Ratio | RankAvg:
    if metric in PER_ANSWER_PAIR:
        nk, dk = PER_ANSWER_PAIR[metric]
        return Ratio(num=int(row[nk]), den=int(row[dk]))
    num, den = ratios(row)[metric]
    return RankAvg(sum=int(num), count=int(den)) if metric == "position" else Ratio(num=int(num), den=int(den))


def _pair_tuple(p: Ratio | RankAvg) -> tuple[int, int]:
    return (p.sum, p.count) if isinstance(p, RankAvg) else (p.num, p.den)


def _empty_row() -> dict[str, int]:
    return dict.fromkeys(_SUM_KEYS, 0)


def _compare_info(kind: str, w: Windows | None, first: dict[str, date | None]) -> CompareInfo:
    wins = None
    if w is not None:
        wins = CompareWindows(prev=Span(lo=w.prev.lo, hi=w.prev.hi) if w.prev is not None else None, cur=Span(lo=w.cur.lo, hi=w.cur.hi),
                              before=Span(lo=w.before.lo, hi=w.before.hi) if w.before is not None else None)
    return CompareInfo(kind=kind, windows=wins, first_published=first.get("mention"),  # type: ignore[arg-type]
                       first_published_citation=first.get("citation"))


def _legacy_short_circuit(ctx: ReadContext, q: CompareQuery, w: Windows, metrics: list[str], ignored: list[str],
                          profile: LegacyProfile) -> CompareResponse | None:
    """현행 프로필 분기(WU-9). 해당 없으면 None(새 정의 경로로 계속)."""
    if profile.compare_epoch_gate and not period_compare_applies(w.cur.hi):
        base = build_meta(mode="cumulative", ctx=ctx, suppressed={"*": EPOCH_GATED}, source={"ledger": "fleet"})
        base.ignored_filters += ignored
        return CompareResponse(data=[], meta=CompareMeta(**base.model_dump(), compare=_compare_info(q.kind, w, {})))
    if not (profile.compare_suppress and legacy_unsupported_reason(ctx.surface, depth2=bool(q.depth2), depth3=bool(q.depth3),
                                                                   own_bits=ctx.own_bits)):
        return None
    blank = Ledger()
    reason = suppression_of(w, blank, blank, before=blank, unsupported=True)      # = "unsupported"(우선순위 맨 앞)
    items = [CompareItem(metric=m, family=METRIC_FAMILY[m], unit=METRIC_UNIT[m], prev=_pair(m, _empty_row()),  # type: ignore[arg-type]
                         cur=_pair(m, _empty_row()), delta=None, suppressed=True, reason=reason, cycles_prev=0, cycles_cur=0,
                         planned_prev=0, planned_cur=0, missing_share_prev=0.0, missing_share_cur=0.0) for m in metrics]
    base = build_meta(mode="cumulative", ctx=ctx, suppressed={m: reason for m in metrics}, source={"ledger": "fleet"})  # type: ignore[misc]
    base.ignored_filters += ignored
    return CompareResponse(data=items, meta=CompareMeta(**base.model_dump(), compare=_compare_info(q.kind, w, {})))


async def get_compare(conn: Any, ctx: ReadContext, q: CompareQuery, *, today: date | None,
                      profile: LegacyProfile | None = None) -> CompareResponse:
    metrics = list(dict.fromkeys(q.metrics)) or list(METRICS)
    ignored: list[str] = []
    w = await resolve_compare_windows(conn, ctx, q, today, ignored)
    prof = profile if profile is not None else active_profile()
    if w is not None and not prof.is_off:
        short = _legacy_short_circuit(ctx, q, w, metrics, ignored, prof)
        if short is not None:
            return short

    labels = ("prev", "cur", "before")
    fams = tuple(FAMILY_CORE)
    sums = {k: _empty_row() for k in labels}
    ledgers = {(k, f): Ledger() for k in labels for f in fams}
    data_days: dict[tuple[str, str], set[date]] = {(k, f): set() for k in labels for f in fams}
    first: dict[str, date | None] = dict.fromkeys(fams)
    dwin: Window | None = None

    if w is not None:
        scan = w.scan
        # 현행 프로필 compare_cycle_set(WU-12): 글로벌 창 회차·원장·첫 발행 = 발행 회차 전부(함대 가시성 무관). 꺼짐이면 인자 자체를 넘기지 않는다
        fa: dict[str, bool] = {"fleet_any": True} if prof.compare_cycle_set and ctx.surface == "global" else {}
        # 동결 층(freeze_at_publish, S4): 현행 기간 비교는 구멍으로 폴백하지 않는다(구멍을 누락 비중으로 센다, summary-period-compare.ts:57-62).
        # 값 = 세대 있는 회차의 생성 값(동결 뷰는 동결 회차 행만 낸다), 발행·첫 발행 = 세대 있는 회차(publishedExpr :184-185)
        fzc = frz_eligible(active_profile(), surface=ctx.surface, card=ctx.card)
        if fzc:
            ctx = replace(ctx, frz_ok=True)
        fl = {**fa, "frz": True} if fzc else fa
        swin = await resolve_window(conn, surface=ctx.surface, project_keys=ctx.project_keys, date_from=scan.lo, date_to=scan.hi,
                                    today=today, project_ids=ctx.project_ids, **fa)
        # 원장(함대 기준, 필터 무관): 계열별 계획·미발행 단위, 발행 회차(round_date) 수. 전 이력 첫 발행 F(계열별)
        # B091: 원장은 요청 지표의 계열만 읽는다(다른 계열 원장은 어느 항목에도 쓰이지 않는다). 첫 발행 F 는 meta.compare 에 두 계열 모두 실리므로 그대로
        pub_days: dict[tuple[str, str], set[date]] = {(k, f): set() for k in labels for f in fams}
        used = {METRIC_FAMILY[m] for m in metrics}
        for f in fams:
            fp = await first_published(conn, surface=ctx.surface, project_keys=ctx.project_keys, family=FAMILY_CORE[f], today=today, **fl)
            first[f] = fp if fp is not None and fp <= scan.hi else None
            if f not in used:
                continue
            for r in await ledger_rows(conn, surface=ctx.surface, project_keys=ctx.project_keys, lo=scan.lo, hi=scan.hi,
                                       family=FAMILY_CORE[f], today=today, **fl):
                lab = w.label_of(r.round_date)
                if lab is None:
                    continue
                ledgers[(lab, f)].planned_units += r.expected_units
                if r.published:
                    pub_days[(lab, f)].add(r.round_date)
                else:
                    ledgers[(lab, f)].missing_units += r.expected_units
        for key, days in pub_days.items():
            ledgers[key].published_cycles = len(days)

        # 측정(필터 적용): 창 회차만 담은 파생 창으로 한 번 스캔
        rows = [r for r in swin.cycles if w.label_of(r.round_date) is not None]
        dwin = build_window(surface=ctx.surface, mode="cumulative", rows=rows, lo=scan.lo, hi=scan.hi, generation=swin.generation,
                            project_keys=ctx.project_keys, project_ids=ctx.project_ids)
        rd_of = {r.cyc_key: r.round_date for r in rows}
        if fzc:
            ctx = replace(ctx, frz_keys=dwin.all_keys())                        # 동결 옆 표 술어를 측정 창 회차로 좁힌다(S4 지연)
            ctx = await ctx.frozen_drops(conn)                                  # 택소노미 버림 = 동결 축 기준(S4b)
        cpa = "citations_per_answer" in metrics
        parts = (("mentions",) if any(METRIC_FAMILY[m] == "mention" for m in metrics) else ()) + \
                (("citations",) if any(METRIC_FAMILY[m] == "citation" for m in metrics) else ()) + \
                (("gap",) if cpa else ())
        ms = ctx.measure()
        m_keys, c_keys = set(dwin.cyc_keys("mentions")), set(dwin.cyc_keys("citations"))
        extra: dict[int, int] = {}
        only_cit = tuple(sorted(c_keys - m_keys))
        if cpa and only_cit and not dwin.empty:     # 언급만 숨긴 회차의 cit_in 답변(gap_base 가 언급 계열 FILTER 라 못 센다)
            ca = cit_answers_sql(ms, dwin, only_cit)
            extra = {int(r["cyc_key"]): int(r["cit_answers"] or 0) for r in await fetch_all(conn, ca.text, ca.params)}
        for c in await fetch_counts(conn, ms, dwin, group_by=("cycle",), parts=parts):
            d = rd_of.get(c["cyc_key"])
            lab = w.label_of(d) if d is not None else None
            if lab is None:
                continue
            k = int(c["cyc_key"])
            c = {**c, "cit_answers": (int(c.get("gap_base") or 0) if k in m_keys else extra.get(k, 0)) if cpa and k in c_keys else 0}
            for key in _SUM_KEYS:
                sums[lab][key] += int(c.get(key) or 0)
            if int(c.get("answers") or 0) > 0:
                data_days[(lab, "mention")].add(d)  # type: ignore[arg-type]
            if int(c.get("cit_total") or 0) > 0:
                data_days[(lab, "citation")].add(d)  # type: ignore[arg-type]

    items: list[CompareItem] = []
    sup: dict[str, str] = {}
    for m in metrics:
        fam = METRIC_FAMILY[m]

        def led(k: str, fam: str = fam) -> Ledger:
            x = ledgers[(k, fam)]
            return Ledger(x.planned_units, x.missing_units, x.published_cycles, len(data_days[(k, fam)]), first[fam])

        lp, lc = led("prev"), led("cur")
        reason = suppression_of(w, lp, lc, before=led("before")) if w is not None else "no_prev"
        pp, pc = _pair(m, sums["prev"]), _pair(m, sums["cur"])
        unit = METRIC_UNIT[m]
        items.append(CompareItem(
            metric=m, family=fam, unit=unit, prev=pp, cur=pc,  # type: ignore[arg-type]
            delta=None if reason else delta_of(unit, _pair_tuple(pp), _pair_tuple(pc)),
            suppressed=reason is not None, reason=reason,
            cycles_prev=lp.published_cycles, cycles_cur=lc.published_cycles,
            planned_prev=lp.planned_units, planned_cur=lc.planned_units,
            missing_share_prev=lp.missing_share, missing_share_cur=lc.missing_share))
        if reason:
            sup[m] = reason
    if w is None:
        sup["*"] = "no_active_snapshot"

    base = build_meta(mode="cumulative", ctx=ctx, window=dwin, suppressed=sup, source={"ledger": "fleet"})
    base.ignored_filters += ignored
    meta = CompareMeta(**base.model_dump(), compare=_compare_info(q.kind, w, first))
    return CompareResponse(data=items, meta=meta)
