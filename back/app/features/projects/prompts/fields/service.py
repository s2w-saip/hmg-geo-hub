"""projects.prompts.fields 업무 규칙(현행 prompt/_actions.ts 커스텀 태그 CRUD·assertFieldInProject/assertPromptInProject 이식).

- 텍스트 단일 타입(2026-07-08 결정). 예약어(고정 분류축 이름)는 API 상수(PJ-3 open ④: DB CHECK 아님) → 422 reserved_label.
- 같은 이름(대소문자 무시)은 409 duplicate. 가져오기(io)는 헤더 매칭을 대소문자 무시로 하므로 추가도 같은 기준으로 막는다.
- 모든 field_id·prompt_id 는 이 프로젝트 소속을 재검증한다(2026-07-06 QA 감사 IDOR). 소속이 아니면 404.
- 완전 삭제는 값까지(FK ON DELETE CASCADE). 보관(archived) 태그도 값 쓰기는 허용(현행 동일).
"""
from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all, fetch_one

from . import queries as q
from .schemas import BulkResult, FieldItem, FieldList, ValueResult

# 현행 RESERVED_FIELD_LABELS(_actions.ts:681-686): 영문 키 + 화면 한글 라벨. 비교는 소문자.
RESERVED_FIELD_LABELS = frozenset(s.lower() for s in ("brand", "category", "prompttype", "브랜드", "카테고리"))


def is_reserved(label: str) -> bool:
    return label.strip().lower() in RESERVED_FIELD_LABELS


async def list_fields(conn: AsyncConnection, project_id: uuid.UUID) -> FieldList:
    return FieldList(items=[FieldItem(**r) for r in await fetch_all(conn, q.LIST_SQL, {"pid": project_id})])


async def _get(conn: AsyncConnection, project_id: uuid.UUID, field_id: uuid.UUID) -> FieldItem:
    r = await fetch_one(conn, q.GET_SQL, {"pid": project_id, "fid": field_id})
    if r is None:
        raise errors.not_found("태그 없음", code="field_not_found")
    return FieldItem(**r)


async def create_field(rw: AsyncConnection, project_id: uuid.UUID, label: str) -> FieldItem:
    if is_reserved(label):
        raise errors.unprocessable("고정 분류축과 같은 이름은 쓸 수 없다", code="reserved_label", details={"field": "label"})
    if await fetch_one(rw, q.SAME_LABEL_SQL, {"pid": project_id, "label": label}) is not None:
        raise errors.conflict("duplicate", "이미 있는 태그", {"field": "label"})
    r = await fetch_one(rw, q.INSERT_SQL, {"pid": project_id, "label": label})
    if r is None:                                   # 동시 생성 경합(UNIQUE)
        raise errors.conflict("duplicate", "이미 있는 태그", {"field": "label"})
    return await _get(rw, project_id, r["field_id"])


async def set_archived(rw: AsyncConnection, project_id: uuid.UUID, field_id: uuid.UUID, archived: bool) -> FieldItem:
    if await fetch_one(rw, q.SET_ARCHIVED_SQL, {"pid": project_id, "fid": field_id, "a": archived}) is None:
        raise errors.not_found("태그 없음", code="field_not_found")
    return await _get(rw, project_id, field_id)


async def delete_field(rw: AsyncConnection, project_id: uuid.UUID, field_id: uuid.UUID) -> None:
    if await fetch_one(rw, q.DELETE_SQL, {"pid": project_id, "fid": field_id}) is None:
        raise errors.not_found("태그 없음", code="field_not_found")


async def _assert_field(rw: AsyncConnection, project_id: uuid.UUID, field_id: uuid.UUID) -> None:
    if await fetch_one(rw, q.LOCK_FIELD_SQL, {"pid": project_id, "fid": field_id}) is None:
        raise errors.not_found("태그 없음", code="field_not_found")


async def _assert_prompts(rw: AsyncConnection, project_id: uuid.UUID, prompt_ids: list[uuid.UUID]) -> None:
    rows = await fetch_all(rw, q.LIVE_PROMPTS_SQL, {"pid": project_id, "ids": [str(x) for x in prompt_ids]})
    if len(rows) != len(set(prompt_ids)):
        raise errors.not_found("프롬프트 없음", code="prompt_not_found")


async def set_values(rw: AsyncConnection, project_id: uuid.UUID, field_id: uuid.UUID, prompt_ids: list[uuid.UUID], value: str) -> int:
    """태그값 UPSERT(여러 프롬프트). 가져오기(io)도 이 함수를 쓴다. 소속 확인은 호출자 몫이 아니라 여기서 한다."""
    await _assert_field(rw, project_id, field_id)
    await _assert_prompts(rw, project_id, prompt_ids)
    await rw.execute(text(q.UPSERT_SQL), {"pid": project_id, "fid": field_id, "v": value, "ids": [str(x) for x in prompt_ids]})
    return len(set(prompt_ids))


async def set_value(rw: AsyncConnection, project_id: uuid.UUID, prompt_id: uuid.UUID, field_id: uuid.UUID, value: str) -> ValueResult:
    await set_values(rw, project_id, field_id, [prompt_id], value)
    return ValueResult(prompt_id=prompt_id, field_id=field_id, value=value)


async def bulk_set(rw: AsyncConnection, project_id: uuid.UUID, field_id: uuid.UUID, prompt_ids: list[uuid.UUID], value: str) -> BulkResult:
    return BulkResult(field_id=field_id, count=await set_values(rw, project_id, field_id, prompt_ids, value))


async def clear_value(rw: AsyncConnection, project_id: uuid.UUID, prompt_id: uuid.UUID, field_id: uuid.UUID) -> None:
    await _assert_field(rw, project_id, field_id)
    await _assert_prompts(rw, project_id, [prompt_id])
    await rw.execute(text(q.CLEAR_SQL), {"pid": project_id, "id": prompt_id, "fid": field_id})
