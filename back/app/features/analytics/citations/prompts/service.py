"""analytics.citations.prompts 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

C-3 프롬프트별 인용(자사 owned / 자사 미인용 uncited 버킷)
- 모집단: 창(core.cycles, 인용 계열 숨김 {1,2} 배제) 안 cit_in 답변 중 호스트 있는 인용이 1건 이상인 프롬프트.
  'uncited' 는 '인용 없음'이 아니라 '인용은 있으나 자사 0'이다(모듈-인용 §2 C-3 버킷 정의).
- 자사 판정은 인용 행 단위(표면별 own_expr 와 같은 식의 답변 열 합, G-25). 도메인 단위 판정(구 페이지 함수)은 계승하지 않는다.
- 필터 지원(FilterSupport): 명세 supported 그대로(source[] 포함). source[] 는 core MeasureScope.source_category_keys 로 인용 원소에
  걸린다(core 가 원소 스캔 문장으로 바꾸고, 유효 카테고리 = 운영자 오버라이드 우선).
- 억제(meta.suppressed): 스냅샷 회차 없음 '*': no_active_snapshot, 창의 회차가 전부 인용 숨김 'citations': hidden.
- BG-01: global 도 lang[] 을 받는다(같은 화면의 /domains·/sources 와 같은 모집단). 답변 언어 축이라 rd.answer·rd.citation 의 lang_key 로
  좁히고, 글로벌 자사 판정은 core OwnerScope 가 언어로 허용 배열을 좁혀 원소 스캔(scan 모드)으로 센다(core plan_counts 가 고른다).
- 선택 파라미터(P12 B099, 기본 = 종전): include_refs=false 면 답변 표본 문장 생략(answers = []), fields=text 면 퍼널·엔진 생략
  (funnel = null, providers = []), both_buckets=true 면 같은 문장 1 이 반대 버킷 첫 페이지를 함께 내고(other_bucket) 답변 표본은 두 페이지
  프롬프트를 한 문장으로 센다(행당 표본은 프롬프트별 창 함수라 다른 프롬프트와 섞여도 같다).
"""
from __future__ import annotations

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from app.core import errors
from app.core.cycles import Window
from app.core.db import fetch_all
from app.core.envelope import SUPPRESS_HIDDEN, SUPPRESS_NO_SNAPSHOT, Envelope, Page, build_meta
from app.core.filters import TAXONOMY_AXES, CommonFilters, FilterSupport, ReadContext
from app.core.measure import plan_counts
from app.core.pagination import decode_cursor, fetch_keyset, filter_hash, keyset_page

from .queries import answer_refs_sql, bucket_page_sql
from .schemas import ANSWER_SAMPLE_MAX, AnswerRef, CitationPromptsData, PromptCounts, PromptRow

SUPPORT = FilterSupport.of(
    global_=("brand", "country", "lang", "engine", "period", *TAXONOMY_AXES, "source"),
    website=("brand", "country", "lang", "engine", "period", "source"),
    project=("country", "lang", "engine", "period", *TAXONOMY_AXES, "custom", "source"),
)
SORT = "-citations,prompt_id"
_Q_RE = re.compile(r"[^\x00-\x1f\x7f]*\Z")     # 검색어: 제어 문자 금지(공통 필터 값 규칙과 같은 문자 집합, 길이는 schemas.Q_MAX)
KEY_TYPES = ("int8", "uuid")


@dataclass(frozen=True)
class PageRequest:
    owned: bool
    q: str | None
    limit: int
    cursor: str | None
    fh: str
    include_refs: bool = True        # P12 B099 선택 파라미터(기본 = 종전)
    fields: str = "all"
    both: bool = False


def request_hash(filters: CommonFilters, owned: bool, q: str | None, custom: dict[str, list[str]]) -> str:
    """커서 필터 해시: 공통 필터 원문 + 버킷 + 검색어 + 커스텀 필드. 다른 조건으로 커서를 재사용하면 422 cursor_invalid."""
    return filter_hash({"f": filters.model_dump(mode="json", by_alias=True), "owned": owned, "q": q,
                        "cf": {k: sorted(v) for k, v in sorted(custom.items())}})


def normalize_q(q: str | None) -> str | None:
    """검색어 검증·정규화. 제어 문자(\\x00-\\x1f, \\x7f)가 있으면 422 unprocessable details.field='q'(검증 D4: 전에는 DB 입력 오류가
    키셋 최후 방어에 걸려 cursor_invalid 로 잘못 보고됐다). 앞뒤 공백을 걷어 비면 None."""
    if q is None:
        return None
    if not _Q_RE.match(q):
        raise errors.unprocessable("검색어에 제어 문자를 쓸 수 없음", details={"field": "q"})
    return q.strip() or None


async def window_for(ctx: ReadContext, conn: Any) -> Window:
    """창 해석(테스트가 인용 노출 회차를 주입할 수 있게 한 곳에 둔다)."""
    return await ctx.window(conn)


def _empty(ctx: ReadContext, win: Window, req: PageRequest, suppressed: dict[str, str]) -> Envelope[CitationPromptsData]:
    return Envelope[CitationPromptsData](
        data=CitationPromptsData(items=[], counts=PromptCounts(owned=0, uncited=0), other_bucket=[] if req.both else None),
        meta=build_meta(mode=win.mode, window=win, ctx=ctx, suppressed=suppressed, page=Page(next_cursor=None, limit=req.limit, total=0)))


async def list_prompts(conn: Any, ctx: ReadContext, win: Window, req: PageRequest) -> Envelope[CitationPromptsData]:
    cur = decode_cursor(req.cursor, sort=SORT, dir="asc", fh=req.fh, types=KEY_TYPES, generation=win.generation)
    if win.empty:
        return _empty(ctx, win, req, {"*": SUPPRESS_NO_SNAPSHOT} if win.mode == "snapshot" else {})
    if win.hidden("citations"):
        return _empty(ctx, win, req, {"citations": SUPPRESS_HIDDEN})
    ms = ctx.measure()
    # 인용 수 = 호스트 있는 인용(현행 인용 화면 프롬프트 목록도 도메인 NULL 인용을 뺀다): ⑤ 분모가 아니므로 m05_den=False(G21A, WU-5)
    plan = plan_counts(ms, win, group_by=("prompt", "engine"), parts=("citations",), m05_den=False)
    q1 = bucket_page_sql(plan, owned=req.owned, q=req.q, cursor=cur, limit=req.limit, ms=ms, fields=req.fields, both=req.both)
    res = await fetch_keyset(conn, q1.text, q1.params, cursor=cur)   # 커서 값이 DB 입력 오류를 내면 422 cursor_invalid(최후 방어)
    head = res[0] if res else {"n_owned": 0, "n_uncited": 0, "total": 0, "rows": [], "rows_other": []}
    rows: list[dict[str, Any]] = list(head["rows"] or [])
    page, nxt = keyset_page(rows, req.limit, lambda r: (-int(r["cites"]), uuid.UUID(str(r["prompt_id"]))),
                            sort=SORT, dir="asc", fh=req.fh, generation=win.generation)
    other = list(head.get("rows_other") or [])[:req.limit] if req.both else []     # 반대 버킷 첫 페이지(다음 커서 없음)

    engine_code = {k: code for code, (k, _) in ctx.refs.engines.items()}
    geo_code = {c.geo_key: c.code for c in ctx.refs.countries.values()}
    refs_by: dict[int, list[AnswerRef]] = defaultdict(list)
    if (page or other) and req.include_refs:
        q2 = answer_refs_sql(ms, win, [int(r["prompt_key"]) for r in [*page, *other]], ANSWER_SAMPLE_MAX)
        for r in await fetch_all(conn, q2.text, q2.params):
            refs_by[int(r["prompt_key"])].append(AnswerRef(job_id=r["job_id"], provider=engine_code.get(int(r["engine_key"]), ""),
                                                           region=geo_code.get(int(r["geo_key"])) or None, citations_in_answer=int(r["cites"])))

    def row_of(r: dict[str, Any]) -> PromptRow:
        return PromptRow(prompt_id=r["prompt_id"], text=r["text"] or "", funnel=r["funnel"], citations=int(r["cites"]),
                         providers=sorted({engine_code.get(int(k), "") for k in (r["engine_keys"] or [])} - {""}),
                         answers=refs_by.get(int(r["prompt_key"]), []))

    items = [row_of(r) for r in page]
    data = CitationPromptsData(items=items, counts=PromptCounts(owned=int(head["n_owned"] or 0), uncited=int(head["n_uncited"] or 0)),
                               other_bucket=[row_of(r) for r in other] if req.both else None)
    meta = build_meta(mode=win.mode, window=win, ctx=ctx,
                      page=Page(next_cursor=nxt, limit=req.limit, total=int(head["total"] or 0)))
    return Envelope[CitationPromptsData](data=data, meta=meta)
