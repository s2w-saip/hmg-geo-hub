"""intent.keywords.research 인사이트·연관어·조회 라우터. 경로는 /v1 접두 포함 전체 경로.

GET 은 부수효과가 없다(외부 호출 없음, 수집 요청은 POST /v1/intent/fetches). 데이터가 없으면 200 + meta.suppressed{'*': source_pending}.
"""
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Page, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.kw import clean_term
from app.features.intent.keywords.research import service as svc
from app.features.intent.keywords.research.intent_common import TTL_LABEL, as_of_date, intent_meta
from app.features.intent.keywords.research.schemas import InsightEnvelope, LookupEnvelope, RelatedEnvelope, StandardKeywordEnvelope

router = APIRouter(tags=["intent.keywords"], responses=ERROR_RESPONSES)

_CONSUMED = frozenset({"term", "terms", "country", "project_id", "limit"})
Term = Annotated[str, Query(min_length=1, max_length=200, description="검색어(trim·NFC 후 비면 422)")]
Country = Annotated[str | None, Query(max_length=8, description="ISO2(프리셋 30개국). project_id 가 있으면 생략 시 프로젝트 국가")]
ProjectId = Annotated[uuid.UUID | None, Query(description="프로젝트 화면이면 지정(멤버 권한), 없으면 표준 화면 권한")]


@router.get("/v1/intent/insight", summary="12개월 검색량 + 최신 SERP(+초안) + freshness. 외부 호출 없음(표준 화면 겸용)",
            response_model=InsightEnvelope)
async def get_intent_insight_0(request: Request, p: CurrentUser, conn: RoConn, term: Term, country: Country = None,
                               project_id: ProjectId = None,
                               limit: Annotated[int, Query(ge=1, le=10, description="SERP 행 수(적재 depth 10)")] = svc.MAX_SERP_ROWS
                               ) -> InsightEnvelope:
    t = clean_term(term)
    preset, _ = await svc.resolve_access(conn, p, project_id, country)
    data, observed, fr = await svc.insight(conn, t, preset, limit)
    meta = intent_meta(request, mode="external", consumed=_CONSUMED, as_of=as_of_date(observed),
                       source={"freshness": fr, "observed_at": observed.isoformat() if observed else None, "ttl": TTL_LABEL["insight"]},
                       suppressed={"*": "source_pending"} if fr == "missing" else None)
    return InsightEnvelope(data=data, meta=meta)


@router.get("/v1/intent/related", summary="최신 연관 검색어(≤30) + freshness", response_model=RelatedEnvelope)
async def get_intent_related_1(request: Request, p: CurrentUser, conn: RoConn, term: Term, country: Country = None,
                               project_id: ProjectId = None) -> RelatedEnvelope:
    t = clean_term(term)
    preset, _ = await svc.resolve_access(conn, p, project_id, country)
    data, observed, fr = await svc.related(conn, t, preset)
    meta = intent_meta(request, mode="external", consumed=_CONSUMED, as_of=as_of_date(observed),
                       source={"freshness": fr, "observed_at": observed.isoformat() if observed else None, "ttl": TTL_LABEL["related"]},
                       suppressed={"*": "source_pending"} if fr == "missing" else None)
    return RelatedEnvelope(data=data, meta=meta)


@router.get("/v1/intent/lookup", summary="다건 term 조회, 없는 term 은 missing", response_model=LookupEnvelope)
async def get_intent_lookup_2(request: Request, p: CurrentUser, conn: RoConn,
                              terms: Annotated[list[str], Query(min_length=1, max_length=20, description="검색어(반복 파라미터, 1~20)")],
                              country: Country = None, project_id: ProjectId = None) -> LookupEnvelope:
    cleaned = list(dict.fromkeys(clean_term(t, field="terms") for t in terms))
    preset, _ = await svc.resolve_access(conn, p, project_id, country)
    data, observed, fr, stale = await svc.lookup(conn, cleaned, preset)
    missing = sum(1 for r in data.items if r.status == "missing")
    meta = intent_meta(request, mode="external", consumed=_CONSUMED, as_of=as_of_date(observed),
                       source={"freshness": fr, "observed_at": observed.isoformat() if observed else None, "ttl": TTL_LABEL["search"],
                               "missing_terms": missing, "stale_terms": stale},
                       suppressed={"*": "source_pending"} if missing == len(data.items) else None)
    return LookupEnvelope(data=data, meta=meta)



@router.get("/v1/intent/standard-keywords",
            summary="표준 열람자용 표준 키워드 목록(읽기 전용, 브랜드 스코프. 쓰기는 /v1/admin/interest/keywords)",
            response_model=StandardKeywordEnvelope)
async def get_intent_standard_keywords_3(
        request: Request, p: CurrentUser, conn: RoConn,
        source_type: Annotated[Literal["google_keyword", "community_voc"], Query(description="원천 종류(기본 구글 키워드 탭)")]
        = "google_keyword",
        brand: Annotated[list[str], Query(max_length=20, description="brand_code 로 좁히기(스코프 안, 공통 키워드는 항상 포함)")] = [],  # noqa: B006
        cursor: Annotated[str | None, Query(max_length=4096, description="직전 응답 meta.page.next_cursor(키셋: created_at DESC, keyword_id)")]
        = None,
        limit: Annotated[int | None, Query(ge=1, le=svc.MAX_STANDARD_KEYWORDS, description="한 페이지 행 수(기본·최대 500)")] = None,
) -> StandardKeywordEnvelope:
    data, total, dropped, nxt, lim = await svc.standard_keywords(conn, p, source_type, brand, cursor, limit)
    meta = crud_meta(request.query_params, mode="catalog", page=Page(next_cursor=nxt, limit=lim, total=total),
                     support=("brand",), consumed=("source_type", "cursor", "limit"))
    meta.dropped_filters = dropped
    return StandardKeywordEnvelope(data=data, meta=meta)
