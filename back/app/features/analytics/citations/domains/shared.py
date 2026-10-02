"""인용 기능(C-1·C-2) 공용 조각: 필터 지원 축, 읽기 문맥·창 해석, 공용 응답 모델.

도메인·드릴다운·출처 카테고리·톤 네 기능이 함께 쓴다(같은 그룹 an-cit-a 소유). 공통 술어는 전부 core 에서 온다:
- 표면 경로 게이트(route-policy 역할 천장 + menu_groups): core.filters.resolve_read_context → core.auth.require_surface
- 창 3술어·계열 숨김 배제: core.cycles.Window.where(…, 'citations')  (Q18: 인용 계열 배제 = hidden_scope {1, 2})
- 인용 모수·호스트 있는 인용·필터 축·출처 카테고리(source[]) 축: core.measure.citation_where(cit_in ∧ source_key <> 0 ∧ scope_where ∧
  source_where)
- 유효 카테고리(운영자 오버라이드 우선): core.measure.CATEGORY_EXPR·OVERRIDE_JOIN(적재기 category_of 와 같은 우선순위)
- 자사 판정: core.measure.own_expr  (표면별 하나, QUERY-FIXES C-1)
- 억제 사유: core.envelope.window_suppression(no_active_snapshot·hidden), 카테고리 표시 정보: core Refs.category_refs
이 파일이 더하는 것은 인용 전용 조각 하나: 경쟁사 표시(EFFECTIVE_COMPETITOR, 오버라이드가 카테고리를 바꾼 출처는 적재기 재판정 전까지
경쟁사 표시를 내린다).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import Request
from pydantic import BaseModel, Field

from app.core.auth import Principal
from app.core.cycles import Window
from app.core.envelope import window_suppression
from app.core.filters import TAXONOMY_AXES, CommonFilters, FilterSupport, ReadContext, parse_custom_fields, resolve_read_context
from app.core.pagination import filter_hash

# 필터 지원 축(모듈-인용 §2 필터 지원 표). website 는 카탈로그 축이 없다(ignored_filters). project 는 브랜드 축 대신 프로젝트 브랜드로 고정
# (core.filters 관점 규칙) 하고 커스텀 필드(cf.<field_id>)를 받는다.
CITATION_SUPPORT = FilterSupport.of(
    global_=("brand", "country", "lang", "engine", "period", *TAXONOMY_AXES, "source"),
    website=("brand", "country", "lang", "engine", "period", "source"),
    project=("country", "lang", "engine", "period", *TAXONOMY_AXES, "custom", "source"),
)

FAMILY = "citations"                          # 인용 계열(hidden_scope 1·2 배제, Q18)
# ds = rd.dim_source, o = app.citation_domain_override(core.measure.OVERRIDE_JOIN 별칭). 오버라이드가 카테고리를 바꾼 출처는 적재기가
# 경쟁사 키를 다시 판정하기 전까지 경쟁사 표시를 내리지 않는다(바꾸지 않은 행만 그대로)
EFFECTIVE_COMPETITOR = "CASE WHEN o.category_key IS NULL OR o.category_key = ds.category_key THEN ds.competitor_brand_key END"


# ════════════════════════════════════════════════════════════════════════════
# 공용 응답 모델
# ════════════════════════════════════════════════════════════════════════════
class CategoryRef(BaseModel):
    """출처 카테고리(app.citation_category). category_key 는 13행 코드표의 외부 식별자다."""
    category_key: int
    slug: str
    name: str


class AnswerRef(BaseModel):
    """답변 참조(본문은 답변 상세 API 가 job_id 로 지연 로드)."""
    job_id: str
    engine: str | None = Field(None, description="엔진 코드")
    country: str | None = Field(None, description="답변 국가 코드")
    citations: int = Field(description="이 답변 안의 해당 출처(또는 프롬프트) 인용 수")


# ════════════════════════════════════════════════════════════════════════════
# 읽기 문맥
# ════════════════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class CitationRead:
    """요청 하나의 해석 결과. empty 면 사실 표 질의를 건너뛰고 빈 응답을 낸다(suppressed 에 사유)."""
    ctx: ReadContext
    win: Window
    suppressed: dict[str, str]
    categories: dict[int, CategoryRef]
    engine_code: dict[int, str]

    @property
    def empty(self) -> bool:
        return self.win.lo is None or not self.win.cyc_keys(FAMILY)

    def category(self, key: int | None) -> CategoryRef | None:
        return None if key is None else self.categories.get(int(key))

    def country_code(self, geo_key: int | None) -> str | None:
        if geo_key is None:
            return None
        c = self.ctx.refs.country_by_key(int(geo_key))
        return c.code if c is not None and c.code else None

    def engines(self, keys: Any) -> list[str]:
        return sorted({self.engine_code[int(k)] for k in (keys or ()) if int(k) in self.engine_code})


async def open_read(conn: Any, principal: Principal, filters: CommonFilters, request: Request) -> CitationRead:
    """표면 게이트·스코프 ∩ 요청(core) → 창(core) → 억제 사유(core window_suppression: 스냅샷 회차 없음 = no_active_snapshot,
    창 회차가 인용 계열에서 전부 숨김 = hidden)."""
    custom = parse_custom_fields(request.query_params)
    ctx = await resolve_read_context(conn, principal, filters, support=CITATION_SUPPORT, custom_fields=custom or None)
    ctx, win = await ctx.card_window(conn, route="domains")                             # 동결 판정(S4): 구멍이면 비카드 문맥·창
    reason = window_suppression(win, FAMILY)
    suppressed: dict[str, str] = {"*": reason} if reason else {}
    cats = {k: CategoryRef(category_key=k, slug=c.slug, name=c.name)
            for k, c in sorted(ctx.refs.category_refs.items(), key=lambda kv: (kv[1].ord, kv[0]))}
    engine_code = {k: code for code, (k, _) in ctx.refs.engines.items() if code}
    return CitationRead(ctx=ctx, win=win, suppressed=suppressed, categories=cats, engine_code=engine_code)


def request_hash(params: CommonFilters, request: Request, *, exclude: frozenset[str] = frozenset()) -> str:
    """커서 필터 해시: 공통 필터 + 기능 추가 파라미터(쿼리 모델 전체에서 cursor·limit 제외) + 커스텀 필드(cf.*).
    exclude: 목록 모집단과 무관한 추가 파라미터(예: 톤 with_counts)를 해시에서 뺀다(기본 요청의 해시가 파라미터 추가 전과 같다)."""
    custom = {k: sorted(request.query_params.getlist(k)) for k in sorted(request.query_params) if k.startswith("cf.")}
    return filter_hash({"f": params.model_dump(mode="json", by_alias=True, exclude={"cursor", "limit", *exclude}), "cf": custom})
