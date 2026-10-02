"""analytics.citations.tone 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

- 톤 = 답변 단위 관점 브랜드 감정 신호 비교(core.measure.tone_expr, P1 예외 '관점별 톤 비교'). 요약 타일(/sources tone)과 같은 모집단.
- source[] 를 드릴다운에도 적용한다(요약 타일과 같은 모집단: 모듈-인용 §8 열린 질문 1·2 권장안).
- 검색 q 는 현행처럼 % _ 를 이스케이프하지 않는다(현행 citationToneUrlSearchSql 동작 유지).
- 전체 행 수(검색 반영)는 meta.page.total. 키셋 커서는 generation 고정(세대가 바뀌면 409 cursor_stale).
- BG-27 with_counts: 두 톤 탭 카운트(DISTINCT URL, q·group_by 무관). with_counts 는 커서 필터 해시에 넣지 않는다(목록 모집단과 무관).
"""
from __future__ import annotations

from typing import Any

from fastapi import Request

from app.core.auth import Principal
from app.core.db import fetch_one
from app.core.envelope import Envelope, Page, build_meta
from app.core.pagination import decode_cursor, fetch_keyset, keyset_page
from app.features.analytics.citations.domains.shared import open_read, request_hash
from app.features.analytics.citations.tone import queries as q
from app.features.analytics.citations.tone.schemas import ToneCounts, ToneData, ToneQuery, ToneRow

SORT = "citations"


async def get_tone_rows(conn: Any, principal: Principal, params: ToneQuery, request: Request) -> Envelope[ToneData]:
    rd = await open_read(conn, principal, params, request)
    fh = request_hash(params, request, exclude=frozenset({"with_counts"}))
    cur = decode_cursor(params.cursor, sort=SORT, dir="asc", fh=fh, types=("int8", "text"), generation=rd.win.generation)
    items: list[ToneRow] = []
    page = Page(next_cursor=None, limit=params.limit, total=0)
    counts = ToneCounts(positive=0, negative=0) if params.with_counts else None
    if not rd.empty:
        search = (params.q or "").strip() or None
        s = q.tone_rows_sql(rd.ctx, rd.win, tone=params.tone, group_by=params.group_by, q=search, limit=params.limit, cursor=cur)
        rows = await fetch_keyset(conn, s.text, s.params, cursor=cur)
        total = int(rows[0]["total"]) if rows else 0
        page_rows, nxt = keyset_page(rows, params.limit, lambda r: (-int(r["citations"]), r["k"]), sort=SORT, dir="asc", fh=fh,
                                     generation=rd.win.generation)
        items = [ToneRow(key=r["k"], display=r["display"], url=r["url"], skey=r["skey"], domain=r["domain"], title=r["title"], citations=int(r["citations"]),
                         engines=rd.engines(r["engines"]), category=rd.category(r["category_key"]), prompt_text=r["prompt_text"])
                 for r in page_rows]
        if cur is not None and not rows:
            total = await _total(conn, rd, params, search)
        page = Page(next_cursor=nxt, limit=params.limit, total=total)
        if params.with_counts:
            c = q.tone_counts_sql(rd.ctx, rd.win)
            cr = await fetch_one(conn, c.text, c.params) or {}
            counts = ToneCounts(positive=int(cr.get("positive") or 0), negative=int(cr.get("negative") or 0))
    meta = build_meta(mode=rd.win.mode, ctx=rd.ctx, window=rd.win, suppressed=rd.suppressed, page=page)
    return Envelope[ToneData](data=ToneData(items=items, counts=counts), meta=meta)


async def _total(conn: Any, rd: Any, params: ToneQuery, search: str | None) -> int:
    """커서가 마지막 행 뒤를 가리켜 빈 페이지면 total 을 첫 페이지 조회(커서 없이 limit 1)로 다시 센다."""
    s = q.tone_rows_sql(rd.ctx, rd.win, tone=params.tone, group_by=params.group_by, q=search, limit=1, cursor=None)
    rows = await fetch_keyset(conn, s.text, s.params)
    return int(rows[0]["total"]) if rows else 0
