"""intent.social.context_map 컨텍스트 맵 조회·내보내기 라우터. 경로는 /v1 접두 포함 전체 경로.

인증 사용자면 누구나(코퍼스 전역). 활성 스냅샷이 없으면 200 + meta.suppressed{'*': no_active_snapshot}(export 는 409 no_active_snapshot).
"""
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import StreamingResponse

from app.core import errors
from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Page
from app.core.errors import ERROR_RESPONSES
from app.core.export import XLSX_MEDIA, xlsx_response
from app.core.write import access_audit
from app.features.intent.keywords.research.intent_common import KST, as_of_date, intent_meta
from app.features.intent.social.context_map import service as svc
from app.features.intent.social.context_map.schemas import (
    CombinationList,
    CombinationListEnvelope,
    ConditionList,
    ConditionListEnvelope,
    ContextList,
    ContextListEnvelope,
    EntityEnvelope,
    StatsEnvelope,
)

router = APIRouter(tags=["intent.social"], responses=ERROR_RESPONSES)

# lang 은 export 에서만 자기 파라미터(시트 언어)다. 조회 5종에서는 공통 필터 축이라 meta.ignored_filters 로 드러낸다(검증 D2,
# CM-1 filters.ignored lang[]). export 는 xlsx 응답이라 meta 가 없다.
_CONSUMED = frozenset({"search", "sort", "dir", "cursor", "limit"})
Search = Annotated[str | None, Query(max_length=100, description="이름 부분 일치(ILIKE, %·_ 이스케이프)")]
SortQ = Annotated[Literal["name", "mentions"], Query(description="정렬 열")]
DirQ = Annotated[Literal["asc", "desc"], Query(description="정렬 방향")]
Cursor = Annotated[str | None, Query(max_length=4096, description="이전 응답 meta.page.next_cursor")]
Limit = Annotated[int, Query(ge=1, le=svc.MAX_PAGE, description="페이지 크기(1~200)")]
_NO_SNAP = {"*": "no_active_snapshot"}


def _meta(request: Request, snap, *, page: Page | None = None):
    return intent_meta(request, mode="catalog", consumed=_CONSUMED, as_of=as_of_date(snap["taken_at"]) if snap else None,
                       source=svc.snapshot_source(snap), suppressed=None if snap else _NO_SNAP, page=page)


@router.get("/v1/intent/social/context-map/stats", summary="활성 스냅샷 통계", response_model=StatsEnvelope)
async def get_intent_social_context_map_stats_0(request: Request, p: CurrentUser, conn: RoConn) -> StatsEnvelope:
    snap = await svc.active_snapshot(conn)
    data = await svc.stats(conn, int(snap["snapshot_id"])) if snap else None
    return StatsEnvelope(data=data, meta=_meta(request, snap))


async def _entities(request, conn, etype, search, sort, dir, cursor, limit):
    snap = await svc.active_snapshot(conn)
    if snap is None:
        return [], _meta(request, None, page=Page(next_cursor=None, limit=limit, total=0))
    items, page = await svc.list_entities(conn, int(snap["snapshot_id"]), etype, search=svc.clean_search(search), sort=sort, dir=dir,
                                          cursor=cursor, limit=limit)
    return items, _meta(request, snap, page=page)


@router.get("/v1/intent/social/context-map/contexts", summary="맥락 목록(검색·정렬·키셋), 감성 비율 분자·분모",
            response_model=ContextListEnvelope)
async def get_intent_social_context_map_contexts_1(request: Request, p: CurrentUser, conn: RoConn, search: Search = None,
                                                   sort: SortQ = "mentions", dir: DirQ = "desc", cursor: Cursor = None,
                                                   limit: Limit = svc.DEFAULT_PAGE) -> ContextListEnvelope:
    items, meta = await _entities(request, conn, "ConsumerContext", search, sort, dir, cursor, limit)
    return ContextListEnvelope(data=ContextList(items=items), meta=meta)


@router.get("/v1/intent/social/context-map/conditions", summary="조건 목록(같은 핸들러)", response_model=ConditionListEnvelope)
async def get_intent_social_context_map_conditions_2(request: Request, p: CurrentUser, conn: RoConn, search: Search = None,
                                                     sort: SortQ = "mentions", dir: DirQ = "desc", cursor: Cursor = None,
                                                     limit: Limit = svc.DEFAULT_PAGE) -> ConditionListEnvelope:
    items, meta = await _entities(request, conn, "ConsumerRequirement", search, sort, dir, cursor, limit)
    return ConditionListEnvelope(data=ConditionList(items=items), meta=meta)


@router.get("/v1/intent/social/context-map/combinations", summary="조건×조건 동시출현 목록", response_model=CombinationListEnvelope)
async def get_intent_social_context_map_combinations_3(request: Request, p: CurrentUser, conn: RoConn, search: Search = None,
                                                       dir: DirQ = "desc", cursor: Cursor = None,
                                                       limit: Limit = svc.DEFAULT_PAGE) -> CombinationListEnvelope:
    snap = await svc.active_snapshot(conn)
    if snap is None:
        return CombinationListEnvelope(data=CombinationList(items=[], max_co_count=0),
                                       meta=_meta(request, None, page=Page(next_cursor=None, limit=limit, total=0)))
    items, mx, page = await svc.list_combinations(conn, int(snap["snapshot_id"]), search=svc.clean_search(search), dir=dir,
                                                  cursor=cursor, limit=limit)
    return CombinationListEnvelope(data=CombinationList(items=items, max_co_count=mx), meta=_meta(request, snap, page=page))


@router.get("/v1/intent/social/context-map/entities/{entity_id}", summary="엔티티 상세(근거 ≤8, 도메인, 연결 엔티티)",
            response_model=EntityEnvelope)
async def get_intent_social_context_map_entities_by_id_4(request: Request, p: CurrentUser, conn: RoConn,
                                                         entity_id: Annotated[uuid.UUID, Path()]) -> EntityEnvelope:
    snap = await svc.active_snapshot(conn)
    if snap is None:
        raise errors.not_found("엔티티 없음(활성 스냅샷 없음)", code="no_active_snapshot")
    data = await svc.entity_detail(conn, int(snap["snapshot_id"]), entity_id)
    return EntityEnvelope(data=data, meta=_meta(request, snap))


@router.get("/v1/intent/social/context-map/export", summary="3시트 내보내기(형식은 열린 질문: 서버 xlsx 스트림 기본)",
            response_class=StreamingResponse, responses={200: {"content": {XLSX_MEDIA: {}}, "description": "xlsx 3시트(맥락·조건·조합)"}})
async def get_intent_social_context_map_export_5(request: Request, p: CurrentUser, conn: RoConn,
                                                 lang: Annotated[Literal["ko", "en"], Query(description="시트명·헤더 언어")] = "ko"
                                                 ) -> StreamingResponse:
    snap = await svc.active_snapshot(conn)
    if snap is None:
        raise errors.conflict("no_active_snapshot", "활성 컨텍스트 맵 스냅샷 없음(준비 중)")
    sheets = await svc.export_sheets(conn, int(snap["snapshot_id"]), lang)
    stamp = datetime.now(KST).strftime("%Y%m%d")
    access_audit(p, "download", "intent.context_map.export", target=f"ctx_snapshot:{snap['snapshot_id']}",
                 detail={"lang": lang, "rows": [len(list(s.rows)) for s in sheets]})
    # core.export: Content-Disposition(비ASCII 이름은 filename*)·Cache-Control no-store, 행은 흘려 쓴다
    return xlsx_response(sheets, filename=f"{svc.EXPORT_LABELS[lang]['file']}-{stamp}.xlsx", ascii_fallback=f"context-map-{stamp}.xlsx")
