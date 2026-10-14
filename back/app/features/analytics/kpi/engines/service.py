"""analytics.kpi.engines 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

- 창: K-1 과 같다(스냅샷 cycle_offset 0|1 · 기간 누적). 엔진 필터가 없으면 기본 엔진(dflt), 있으면 그 엔진들만 행이 된다.
- 행: fetch_counts(group_by engine). multi = 관점 언급 2회 이상, top1·top3 = 순위 있는 답변의 대표 순위(core.measure own_cols).
- total: 행 합(평균은 화면이 합에서 재계산). 계산하지 않은 part 필드는 null.
- 엔진 간 일관성: round1(100 × min ÷ max), 유효 엔진(분모 > 0) 2개 미만이면 null(현행 live.ts:831 consistency 이식).
  citation_share 분자 = 행 cit_owned = core.measure cit_m05(M05 분자, 카드와 같다). global 은 출처 카테고리 Official (HMG)(동기화 S1 BE-B,
  제품 책임자 Q1 (a)): 현행 live.ts:880 배지는 base URL 자사(citOwned)라 글로벌 배지 값이 현행과 다르다(DECISIONS-API 동기화 S1 BE-B 고지).
  순위는 평균 순위(rank_sum ÷ ranked)의 min ÷ max. 현행은 소수 1자리로 반올림한 평균을 썼고 여기서는 반올림 전 값을 쓴다.
- 억제: 숨김 계열(언급 {1,3} · 인용 {1,2})이면 그 계열 필드 null + meta.suppressed[지표] = hidden. 스냅샷 회차 없음 '*'.
- parts(B090): part 여럿의 합집합으로 core part 를 고른다(예: sov+citation = 일관성 배지 열만, rank_detail 없음). 비우면 [part](종전).
  스캔은 그대로 rd.answer 한 번이고 열만 준다. 계산한 열의 값은 part=all 의 같은 열과 같다.
"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import Any

from app.core.envelope import SUPPRESS_HIDDEN, SUPPRESS_NO_SNAPSHOT, Envelope, build_meta
from app.core.filters import ReadContext
from app.core.measure import fetch_counts, round1
from app.features.analytics.kpi.summary.service import ignored_offset
from app.features.analytics.kpi.summary.shared import engine_codes

from .queries import FIELDS_BY_PART, PART_MAP
from .schemas import EngineConsistency, EngineItem, EngineRow, EnginesData

MENTION_METRICS = ("visibility", "share_of_voice", "sentiment", "position")
ALL_FIELDS = tuple(EngineRow.model_fields)


def consistency(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    lo, hi = min(values), max(values)
    return round1(100 * lo / hi) if hi > 0 else None


def _vals(rows: list[EngineItem], num: str, den: str) -> list[float]:
    out = []
    for r in rows:
        n, d = getattr(r, num), getattr(r, den)
        if n is not None and d:
            out.append(n / d)
    return out


def engine_consistency(rows: list[EngineItem]) -> EngineConsistency:
    def f(num: str, den: str) -> float | None:
        return consistency(_vals(rows, num, den))
    return EngineConsistency(visibility=f("tracked", "answers"), share_of_voice=f("tracked_mentions", "total_mentions"),
                             sentiment=f("positive_mentions", "sent_mentions"), position=f("rank_sum", "ranked"),
                             citation_share=f("cit_owned", "cit_total"))


def requested_parts(part: str, parts: Sequence[str] = ()) -> tuple[str, ...]:
    """요청 part(들) → core part(순수 함수). parts 를 주면 그 합집합(B090), 비우면 PART_MAP[part](종전)."""
    return tuple(dict.fromkeys(cp for p in (parts or (part,)) for cp in PART_MAP[p]))


async def get_engines(conn: Any, ctx: ReadContext, *, part: str, cycle_offset: int, today: date | None,
                      parts: Sequence[str] = ()) -> Envelope[EnginesData]:
    ctx, win = await ctx.card_window(conn, route="engines", offset=cycle_offset if ctx.date_from is None else 0, today=today)   # 동결 판정(S4)
    sup: dict[str, str] = {}
    hidden = {"mentions": win.hidden("mentions"), "rank_detail": win.hidden("mentions"), "citations": win.hidden("citations")}
    want = requested_parts(part, parts)
    parts = tuple(p for p in want if not hidden[p])
    if hidden["mentions"] and any(p in want for p in ("mentions", "rank_detail")):
        sup.update(dict.fromkeys(MENTION_METRICS, SUPPRESS_HIDDEN))
    if hidden["citations"] and "citations" in want:
        sup["citation_share"] = SUPPRESS_HIDDEN

    counts = await fetch_counts(conn, ctx.measure(), win, group_by=("engine",), parts=parts) if parts else []   # 빈 창은 core 가 단락
    code_of = engine_codes(ctx)
    filled = {fld: col for p in parts for fld, col in FIELDS_BY_PART[p].items()}
    rows: list[EngineItem] = []
    for c in counts:
        vals = {fld: (int(c.get(filled[fld]) or 0) if fld in filled else None) for fld in ALL_FIELDS}
        rows.append(EngineItem(engine=code_of.get(int(c["engine_key"]), str(c["engine_key"])), **vals))
    rows.sort(key=lambda r: r.engine)
    total = EngineRow(**{fld: (sum(int(getattr(r, fld) or 0) for r in rows) if fld in filled else None) for fld in ALL_FIELDS})
    cons = engine_consistency(rows)
    if win.mode == "snapshot" and win.empty:
        sup["*"] = SUPPRESS_NO_SNAPSHOT
    meta = build_meta(mode=win.mode, ctx=ctx, window=win, suppressed=sup)
    meta.ignored_filters += ignored_offset(ctx, cycle_offset)
    return Envelope[EnginesData](data=EnginesData(rows=rows, total=total, engine_consistency=cons), meta=meta)
