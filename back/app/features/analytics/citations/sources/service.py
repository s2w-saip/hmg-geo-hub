"""analytics.citations.sources 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

- M09 카테고리 분포 = 카테고리별 인용 행 / 전체 인용 행(가산형). 카테고리 = 적재 시 확정된 rd.dim_source 분류 + 운영자 오버라이드.
- 톤: 답변 단위 관점 브랜드 감정 신호 비교(core.measure.tone_expr). 동률·둘 다 0 은 어느 쪽도 아니다.
- source[]: 분포·엔진×카테고리·톤 타일·유형 전부에 같은 모집단으로 적용한다(모듈-인용 §8 열린 질문 1 권장안: 톤 타일 미적용은
  현행이 JS 분류라 생긴 제약이었고 이유가 사라졌다. A4 고지 대상).
- /sources/types 는 Q19 에 따라 /sources 응답(types)에 합쳤다. 경로는 taxonomy 정본이라 남기고 같은 계산의 types 부분만 낸다.
"""
from __future__ import annotations

from typing import Any

from fastapi import Request

from app.core.auth import Principal
from app.core.db import PARALLEL_GATHER_HINT, fetch_all, fetch_one, planner_hint
from app.core.envelope import Envelope, build_meta, ratio
from app.core.filters import CommonFilters
from app.features.analytics.citations.domains.shared import CitationRead, open_read
from app.features.analytics.citations.sources import queries as q
from app.features.analytics.citations.sources.schemas import (
    MENTION_TYPES,
    CategoryCount,
    EngineCategories,
    EngineCategoryCount,
    SourcesData,
    ToneSummary,
    ToneTile,
    TypeCategories,
    TypesData,
)


def _zero_tone() -> ToneSummary:
    return ToneSummary(positive=ToneTile(urls=0, citations=0, answers=0), negative=ToneTile(urls=0, citations=0, answers=0))


def _empty_types() -> list[TypeCategories]:
    return [TypeCategories(type=t, total=0, categories=[]) for t in MENTION_TYPES]


def _cat_sort(rd: CitationRead, key: int) -> tuple[int, int]:
    return (list(rd.categories).index(key) if key in rd.categories else 10_000, key)


def _fold_types(rd: CitationRead, rows: list[dict[str, Any]]) -> list[TypeCategories]:
    """카테고리별 유형 인용 수 행(types_sql 행 또는 sources_sql 의 카테고리 단독 행) → 유형 5종."""
    out = []
    for t in MENTION_TYPES:
        col = q.TYPE_COLS[t]
        cats = [EngineCategoryCount(category_key=int(r["category_key"]), citations=int(r[col] or 0)) for r in rows if int(r[col] or 0) > 0]
        cats.sort(key=lambda x: (-x.citations, _cat_sort(rd, x.category_key)))
        out.append(TypeCategories(type=t, total=sum(x.citations for x in cats), categories=cats))
    return out


async def _category_rows(conn: Any, rd: CitationRead) -> list[dict[str, Any]]:
    """카테고리·엔진×카테고리·유형 행(sources_sql 모양). 답변 열 경로(cit_c1..13, 인용 성능 수정안 B·WU-5)를 먼저 쓰고, 미채움 답변이나
    재판정 전 오버라이드가 있으면 원소 경로(sources_sql)로 되돌린다(두 경로 결과 동치: tests/test_sources_equiv.py).
    유형 플래그는 답변 열 t_own(DB-v2.18 P105)으로 세고, 모수에 t_own 미채움 답변이 있으면 종전 jt(answer_brand 답변별 접기)로 다시 센다
    (두 방식 결과 동치: tests/test_t_own_path.py)."""
    types = "col" if q.t_own_usable(rd.ctx) else "jt"
    s = q.sources_ans_sql(rd.ctx, rd.win, types=types)
    rows = await fetch_all(conn, s.text, s.params)
    if types == "col" and q.t_own_unfilled(rows):
        s = q.sources_ans_sql(rd.ctx, rd.win, types="jt")
        rows = await fetch_all(conn, s.text, s.params)
    if q.ans_path_usable(rows):
        return q.fold_ans_rows(rows, rd.ctx.source_category_keys)
    s = q.sources_sql(rd.ctx, rd.win)
    return await fetch_all(conn, s.text, s.params)


async def _types(conn: Any, rd: CitationRead) -> list[TypeCategories]:
    async with planner_hint(conn, PARALLEL_GATHER_HINT):
        rows = await _category_rows(conn, rd)
    return _fold_types(rd, [r for r in rows if int(r["grp"]) == 2])


async def get_sources(conn: Any, principal: Principal, filters: CommonFilters, request: Request) -> Envelope[SourcesData]:
    rd = await open_read(conn, principal, filters, request)
    data = SourcesData(total_citations=0, categories=[], by_engine=[], tone=_zero_tone(), types=_empty_types())
    if not rd.empty:
        # 두 무거운 문장(답변 열·톤)은 Gather 비용 힌트 안에서(core.db.PARALLEL_GATHER_HINT: 계획만 바뀌고 값은 같다, be/web-card-perf)
        t = q.tone_sql(rd.ctx, rd.win)
        async with planner_hint(conn, PARALLEL_GATHER_HINT):
            rows = await _category_rows(conn, rd)                 # 카테고리·엔진×카테고리·유형(답변 열 합, 폴백 = 인용 1회 스캔)
            tr = await fetch_one(conn, t.text, t.params) or {}
        total = next((int(r["citations"]) for r in rows if int(r["grp"]) == 3), 0)
        cats = [r for r in rows if int(r["grp"]) == 2]            # GROUPING: 엔진 제외(카테고리 단독) = 0b10
        cats.sort(key=lambda r: (-int(r["citations"]), _cat_sort(rd, int(r["category_key"]))))
        categories = [CategoryCount(category=rd.categories[int(r["category_key"])], citations=int(r["citations"]),
                                    share=ratio(int(r["citations"]), total)) for r in cats if int(r["category_key"]) in rd.categories]
        by_eng: dict[str, list[EngineCategoryCount]] = {}
        for r in rows:
            if int(r["grp"]) != 0:
                continue
            code = rd.engine_code.get(int(r["engine_key"]))
            if code is None:
                continue
            by_eng.setdefault(code, []).append(EngineCategoryCount(category_key=int(r["category_key"]), citations=int(r["citations"])))
        engines = []
        for code, lst in by_eng.items():
            lst.sort(key=lambda x: (-x.citations, _cat_sort(rd, x.category_key)))
            engines.append(EngineCategories(engine=code, total=sum(x.citations for x in lst), categories=lst))
        engines.sort(key=lambda e: (-e.total, e.engine))
        tone = ToneSummary(
            positive=ToneTile(urls=int(tr.get("pos_urls") or 0), citations=int(tr.get("pos_citations") or 0), answers=int(tr.get("pos_answers") or 0)),
            negative=ToneTile(urls=int(tr.get("neg_urls") or 0), citations=int(tr.get("neg_citations") or 0), answers=int(tr.get("neg_answers") or 0)))
        data = SourcesData(total_citations=total, categories=categories, by_engine=engines, tone=tone, types=_fold_types(rd, cats))
    meta = build_meta(mode=rd.win.mode, ctx=rd.ctx, window=rd.win, suppressed=rd.suppressed)
    return Envelope[SourcesData](data=data, meta=meta)


async def get_types(conn: Any, principal: Principal, filters: CommonFilters, request: Request) -> Envelope[TypesData]:
    rd = await open_read(conn, principal, filters, request)
    items = _empty_types() if rd.empty else await _types(conn, rd)
    meta = build_meta(mode=rd.win.mode, ctx=rd.ctx, window=rd.win, suppressed=rd.suppressed)
    return Envelope[TypesData](data=TypesData(items=items), meta=meta)
