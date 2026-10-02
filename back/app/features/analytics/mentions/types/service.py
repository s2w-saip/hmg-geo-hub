"""analytics.mentions.types 업무 규칙(M-2). 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

- answers_total = core.measure.fetch_counts(parts=mentions).answers(M-1 과 같은 분모).
- 유형·매트릭스 = types_sql 결과의 당사/비교 두 행. all 스코프 = 당사 + 비교 합(서비스 층).
- 스탠스(A3) = stance_sql(rd.answer_stance ⋈ rd.answer, 두 표 모두 창 3술어). 창이 비거나 언급 숨김이면 0 쌍.
- split_own(D13): 관점 비트가 둘 이상이면 비트마다 그 비트만 당사로 둔 스코프(core.measure.split_own_scopes, common.own_splits)로
  types_sql·stance_sql 을 한 번씩 더 돌려 by_own_brand 블록을 낸다. 행 키 own_brand_code 는 mentions/brands·trend 와 같은 규칙.
  분모 answers_total 은 합친 관점과 같다(모수·필터 축은 가르지 않는다).
"""
from __future__ import annotations

from typing import Any

from app.core.codes import STANCE_CODE
from app.core.cycles import Window
from app.core.db import fetch_all
from app.core.envelope import ratio
from app.core.filters import ReadContext
from app.core.measure import MeasureScope, fetch_counts
from app.features.analytics.mentions.brands.common import own_splits, runnable
from app.features.analytics.mentions.types.queries import SENT_COLS, TYPE_COLS, stance_sql, types_sql
from app.features.analytics.mentions.types.schemas import OwnTypes, SentimentCell, StanceCounts, TypeRow, TypesData


def _side(rows: list[dict[str, Any]], own: bool) -> dict[str, int]:
    r = next((x for x in rows if bool(x["own"]) is own), None)
    return {k: int(v or 0) for k, v in r.items() if k != "own"} if r else {}


def _assemble(rows: list[dict[str, Any]], answers_total: int) -> tuple[list[TypeRow], list[SentimentCell]]:
    """types_sql 두 행(당사/비교) → 유형 5행 + 매트릭스 10행."""
    own, other = _side(rows, True), _side(rows, False)
    by_type, matrix = [], []
    for i, t in enumerate(TYPE_COLS):
        on, xn = own.get(f"n{i}", 0), other.get(f"n{i}", 0)
        oa, xa = own.get(f"a{i}", 0), other.get(f"a{i}", 0)
        by_type.append(TypeRow(type=t, own_mentions=on, other_mentions=xn, own_answers=oa, other_answers=xa,  # type: ignore[arg-type]
                               own_exposure=ratio(oa, answers_total), other_exposure=ratio(xa, answers_total),
                               own_share=ratio(on, on + xn)))
        for scope, sides in (("own", (own,)), ("all", (own, other))):
            cell = {name: sum(s.get(f"s{i}_{j}", 0) for s in sides) for j, name in enumerate(SENT_COLS)}
            matrix.append(SentimentCell(type=t, scope=scope, rows=sum(s.get(f"r{i}", 0) for s in sides), **cell))  # type: ignore[arg-type]
    return by_type, matrix


async def _stance(conn: Any, ms: MeasureScope, win: Window, run: bool) -> StanceCounts:
    if not run:
        return StanceCounts(positive=0, neutral=0, mixed=0, negative=0, pairs=0)
    q = stance_sql(ms, win)
    got = {int(r["stance"]): int(r["n"]) for r in await fetch_all(conn, q.text, q.params)}
    c = {name: got.get(code, 0) for name, code in STANCE_CODE.items()}
    return StanceCounts(**c, pairs=sum(c.values()))


async def _rows(conn: Any, ms: MeasureScope, win: Window, run: bool) -> list[dict[str, Any]]:
    if not run:
        return []
    q = types_sql(ms, win)
    return await fetch_all(conn, q.text, q.params)


async def mention_types(conn: Any, ctx: ReadContext, win: Window, *, split_own: bool = False) -> tuple[TypesData, dict[str, str]]:
    ms = ctx.measure()
    run = runnable(win)
    suppressed: dict[str, str] = {}
    answers_total = int((await fetch_counts(conn, ms, win, parts=("mentions",)))[0]["answers"]) if run else 0
    by_type, matrix = _assemble(await _rows(conn, ms, win, run), answers_total)
    stance = await _stance(conn, ms, win, run)

    by_own: list[OwnTypes] | None = None
    if split_own:
        by_own = []
        for sp in own_splits(ctx, ms):
            bt, mx = _assemble(await _rows(conn, sp.ms, win, run), answers_total)
            by_own.append(OwnTypes(own_brand_code=sp.code, by_type=bt, sentiment_matrix=mx, stance=await _stance(conn, sp.ms, win, run)))
    return TypesData(answers_total=answers_total, by_type=by_type, sentiment_matrix=matrix, stance=stance, by_own_brand=by_own), suppressed
