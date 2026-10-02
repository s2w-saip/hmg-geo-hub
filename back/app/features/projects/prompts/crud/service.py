"""projects.prompts.crud 업무 규칙(현행 prompt/_actions.ts addManualPrompt·deletePrompt, lib/scope/server.ts listPrompts·updatePrompt 이식).

- 목록: 삭제(deleted_at) 제외, status[]·kind·q·커스텀 필드 값(cf.<field_id>) 필터, 키셋(created_at DESC, prompt_id DESC), 태그값 1회 조립.
- 수동 추가: 줄바꿈 분리 → 행당 draft 1건(빈 줄 무시).
- 수정: text·lang·regions 는 draft 만(409 prompt_not_draft). 분류 메타(brand_code·category·prompt_type)·kind 는 상태 무관.
- 단순 삭제: draft ∧ scope_prompt_id NULL 만(모듈-프로젝트 §2 결정, 그 외 409 prompt_not_deletable). 측정된 행은 lifecycle hard-delete 로.
- 판정 전파: app.prompt 는 DB 트리거(tg_catalog_change)가 감사·judgment_change 를 남긴다(Q3). 앱은 enqueue_change 를 부르지 않는다.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all, fetch_one, fetch_val
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page

from . import queries as q
from .common import get_prompt, lock_prompt, prompt_item, tags_for
from .schemas import CTRL_IN_BODY, MAX_LINES, MAX_TEXT, Created, PromptItem, PromptList

DRAFT_ONLY = ("text", "lang", "regions")


async def list_prompts(conn: AsyncConnection, project_id: uuid.UUID, *, statuses: list[str], kind: str | None, q_text: str | None,
                       custom: dict[str, list[str]], cursor: str | None, limit: int | None) -> tuple[PromptList, int, list[str]]:
    """(목록, 전체 건수, 프로젝트 밖 커스텀 필드 id = dropped). 프로젝트 밖 필드 필터는 빈 결과(fail-closed)."""
    lim = clamp_limit(limit, default=50)
    dropped: list[str] = []
    if custom:
        known = {str(r["field_id"]) for r in await fetch_all(conn, q.PROJECT_FIELD_IDS_SQL, {"pid": project_id, "ids": sorted(custom)})}
        dropped = sorted(set(custom) - known)
    fh = filter_hash({"status": sorted(set(statuses)), "kind": kind, "q": q_text, "cf": {k: sorted(v) for k, v in sorted(custom.items())}})
    cur = decode_cursor(cursor, sort=q.LIST_SORT, dir="desc", fh=fh, types=q.LIST_KEY_TYPES)
    sql, params = q.list_sql(project_id, statuses=statuses, kind=kind, q=q_text, custom=custom, cursor=cur, limit=lim)
    rows = await fetch_keyset(conn, sql, params)
    page, nxt = keyset_page(rows, lim, lambda r: (r["created_at"], r["prompt_id"]), sort=q.LIST_SORT, dir="desc", fh=fh)
    csql, cparams = q.count_sql(project_id, statuses=statuses, kind=kind, q=q_text, custom=custom)
    total = int(await fetch_val(conn, csql, cparams) or 0)
    tags = await tags_for(conn, project_id, [r["prompt_id"] for r in page])
    return PromptList(items=[prompt_item(r, tags) for r in page], next_cursor=nxt), total, dropped


def split_lines(text: str) -> list[str]:
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    if not lines:
        raise errors.unprocessable("프롬프트 내용이 비었다", code="empty_text", details={"field": "text"})
    if len(lines) > MAX_LINES:
        raise errors.unprocessable(f"한 번에 {MAX_LINES}줄까지", code="too_many_lines", details={"field": "text", "max": MAX_LINES})
    if any(CTRL_IN_BODY.search(ln) for ln in lines):          # 스키마 검증의 방어선(다른 호출 경로)
        raise errors.unprocessable("본문에 제어 문자가 있다", code="invalid_text", details={"field": "text"})
    if any(len(ln) > MAX_TEXT for ln in lines):
        raise errors.unprocessable(f"한 줄은 {MAX_TEXT}자까지", code="text_too_long", details={"field": "text", "max": MAX_TEXT})
    return lines


async def insert_texts(rw: AsyncConnection, project_id: uuid.UUID, texts: list[str]) -> list[uuid.UUID]:
    """draft 프롬프트 여러 건 INSERT(트리거가 'created' 감사). 가져오기(io)도 이 함수를 쓴다."""
    if not texts:
        return []
    rows = await fetch_all(rw, q.INSERT_SQL, {"pid": project_id, "texts": texts})
    return [uuid.UUID(str(r["prompt_id"])) for r in rows]


async def add_manual(rw: AsyncConnection, project_id: uuid.UUID, text: str) -> Created:
    ids = await insert_texts(rw, project_id, split_lines(text))
    return Created(created=len(ids), prompt_ids=ids)


async def patch_prompt(rw: AsyncConnection, project_id: uuid.UUID, prompt_id: uuid.UUID, changes: dict[str, Any]) -> PromptItem:
    if not changes:
        raise errors.unprocessable("바꿀 필드가 없다", code="empty_patch")
    for k in ("text", "kind"):
        if k in changes and changes[k] is None:
            raise errors.unprocessable(f"{k} 는 비울 수 없다", details={"field": k})
    if changes.get("lang") is not None:
        changes["lang"] = str(changes["lang"]).upper()          # DDL CHECK lang = upper(lang)
    cur = await lock_prompt(rw, project_id, prompt_id)
    touched = [k for k in DRAFT_ONLY if k in changes and changes[k] != cur[k] and not (k == "regions" and _same_list(changes[k], cur[k]))]
    if touched and cur["status"] != "draft":
        raise errors.conflict("prompt_not_draft", "측정에 들어간 프롬프트의 본문·언어·시장은 바꿀 수 없다", {"fields": touched, "status": cur["status"]})
    sql, params = q.patch_sql(project_id, prompt_id, changes)
    try:
        r = await fetch_one(rw, sql, params)
    except IntegrityError as e:          # brand_code FK(app.brand)·kind·lang CHECK
        raise errors.unprocessable("허용되지 않는 값", code="invalid_value", details={"fields": sorted(changes)}) from e
    assert r is not None
    tags = await tags_for(rw, project_id, [prompt_id])
    return prompt_item(r, tags)


def _same_list(a: Any, b: Any) -> bool:
    return (list(a) if a is not None else None) == (list(b) if b is not None else None)


async def delete_prompt(rw: AsyncConnection, project_id: uuid.UUID, prompt_id: uuid.UUID) -> None:
    cur = await lock_prompt(rw, project_id, prompt_id)
    if cur["status"] != "draft" or cur["scope_prompt_id"] is not None:
        raise errors.conflict("prompt_not_deletable", "측정에 들어간 프롬프트는 완전 삭제(hard-delete)로만 지운다",
                              {"status": cur["status"], "published": cur["scope_prompt_id"] is not None})
    await rw.execute(text(q.DELETE_SQL), {"pid": project_id, "id": prompt_id})


async def get_item(conn: AsyncConnection, project_id: uuid.UUID, prompt_id: uuid.UUID) -> PromptItem:
    r = await get_prompt(conn, project_id, prompt_id)
    return prompt_item(r, await tags_for(conn, project_id, [prompt_id]))
