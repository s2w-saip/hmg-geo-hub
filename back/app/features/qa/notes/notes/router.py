"""qa.notes.notes 노트 작성·조회·내보내기 라우터. 경로는 /v1 접두 포함 전체 경로.
인증: 검수 게이트(Q17, core.auth.QaUser·QaLiveConn: 쿠키 + 세션 행 확인).
정적 경로(/notes/counts·/notes/export)를 경로 변수(/notes/{note_id}) 보다 먼저 등록한다.
내보내기는 core.export CSV(BOM·CRLF·수식 무력화·no-store·X-Export-Truncated)이고, 다운로드는 core.write.access_audit_qa(kind download)로 감사한다(Q4)."""
import json
import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from app.core.auth import QaLiveConn, QaUser
from app.core.envelope import Envelope, ListData
from app.core.errors import ERROR_RESPONSES
from app.core.export import export_response
from app.core.write import access_audit_qa
from app.features.qa.answers.list.scope import QaNoteFilter, QaNoteListQuery, qa_filter, qa_meta
from app.features.qa.notes.notes import service
from app.features.qa.notes.notes.schemas import QaNote, QaNoteDeleted, QaNoteIn, QaNotePatch, QaNoteRow

router = APIRouter(tags=["qa.notes"], responses=ERROR_RESPONSES)


@router.get("/v1/qa/answers/{job_id}/notes", summary="해당 job 노트 전체", response_model=Envelope[ListData[QaNote]])
async def get_qa_answers_by_id_notes_0(job_id: uuid.UUID, conn: QaLiveConn) -> Envelope[ListData[QaNote]]:
    return Envelope(data=ListData(items=await service.job_notes(conn, job_id)), meta=qa_meta())


@router.post("/v1/qa/answers/{job_id}/notes", summary="낱알 노트 생성", status_code=201, response_model=Envelope[QaNote])
async def post_qa_answers_by_id_notes_1(job_id: uuid.UUID, body: QaNoteIn, reviewer: QaUser, conn: QaLiveConn) -> Envelope[QaNote]:
    return Envelope(data=await service.create(conn, reviewer, job_id, body), meta=qa_meta())


@router.get("/v1/qa/notes", summary="노트 목록(답변 필터 + 노트 축, 키셋)", response_model=Envelope[ListData[QaNoteRow]])
async def get_qa_notes_2(conn: QaLiveConn, filters: Annotated[QaNoteListQuery, Depends(qa_filter(QaNoteListQuery))]) -> Envelope[ListData[QaNoteRow]]:
    items, meta = await service.list_notes(conn, filters, filters.cursor, filters.limit)
    return Envelope(data=ListData(items=items), meta=meta)


@router.get("/v1/qa/notes/counts", summary="target_kind 별 노트 건수", response_model=Envelope[dict[str, int]])
async def get_qa_notes_counts_3(conn: QaLiveConn, filters: Annotated[QaNoteFilter, Depends(qa_filter(QaNoteFilter))]) -> Envelope[dict[str, int]]:
    data, meta = await service.counts(conn, filters)
    return Envelope(data=data, meta=meta)


@router.get("/v1/qa/notes/export", summary="CSV(상한 10,000행, 넘으면 X-Export-Truncated)", response_class=Response,
            responses={200: {"content": {"text/csv": {}}, "description": "UTF-8 BOM CSV"}})
async def get_qa_notes_export_4(reviewer: QaUser, conn: QaLiveConn,
                                filters: Annotated[QaNoteFilter, Depends(qa_filter(QaNoteFilter))]) -> Response:
    rows, truncated, meta = await service.export_rows(conn, filters)
    resp = export_response("csv", service.CSV_COLUMNS, rows, basename=f"qa-notes-{date.today().isoformat()}", truncated=truncated)
    resp.headers["X-Row-Count"] = str(len(rows))
    if meta.ignored_filters:
        resp.headers["X-Ignored-Filters"] = ",".join(meta.ignored_filters)
    # CSV 는 봉투가 없어 목록 API 의 meta.dropped_filters·meta.suppressed 를 헤더로 알린다(D6). 값은 ASCII JSON(헤더 latin-1 안전)
    if meta.dropped_filters:
        resp.headers["X-Dropped-Filters"] = json.dumps(meta.dropped_filters, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    if meta.suppressed:
        resp.headers["X-Suppressed"] = json.dumps(meta.suppressed, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    access_audit_qa(reviewer, "download", "qa.notes.export", detail={"rows": len(rows), "truncated": truncated})
    return resp


@router.patch("/v1/qa/notes/{note_id}", summary="본문·severity 수정, resolved 토글", response_model=Envelope[QaNote])
async def patch_qa_notes_by_id_5(note_id: uuid.UUID, body: QaNotePatch, reviewer: QaUser, conn: QaLiveConn) -> Envelope[QaNote]:
    return Envelope(data=await service.patch(conn, reviewer, note_id, body), meta=qa_meta())


@router.delete("/v1/qa/notes/{note_id}", summary="노트 삭제", response_model=Envelope[QaNoteDeleted])
async def delete_qa_notes_by_id_6(note_id: uuid.UUID, reviewer: QaUser, conn: QaLiveConn) -> Envelope[QaNoteDeleted]:
    return Envelope(data=await service.delete(conn, reviewer, note_id), meta=qa_meta())
