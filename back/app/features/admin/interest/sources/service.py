"""admin.interest.sources 업무 규칙(AD-1b). 고객 관심 출처 원천(app.standard_source) CRUD.

- 판정 입력이 아니라 judgment_change 를 쓰지 않고, 감사 표도 없다(모듈-관리자 §2.2, 현행 동일). 삭제는 물리 삭제.
- 읽기 소비자 = intent 모듈. brand_code 는 app.brand FK 라 쓰기 전에 검증해 422 로 돌려준다.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all, fetch_one
from app.core.sqlb import Binder
from app.features.admin.catalog.prompts.admin_common import brand_codes, clean_text, like_pattern
from app.features.admin.interest.sources import queries as q
from app.features.admin.interest.sources.schemas import Source, SourceCreate, SourcePatch


async def list_sources(ro: AsyncConnection, *, channel: str | None, brands: list[str], enabled: bool | None,
                        q_text: str | None) -> list[Source]:
    b = Binder()
    where = []
    if channel:
        where.append(f"k.channel = {b.v(channel)}")
    if brands:
        where.append(f"k.brand_code = ANY({b.v(sorted(set(brands)), 'text[]')})")
    if enabled is not None:
        where.append(f"k.enabled = {b.v(enabled)}")
    if q_text:
        where.append(f"k.url ILIKE {b.v(like_pattern(q_text))}")
    sql = q.LIST_SELECT + (" WHERE " + " AND ".join(where) if where else "") + q.LIST_ORDER
    return [Source(**r) for r in await fetch_all(ro, sql, b.params)]


async def _check_brand(ro: AsyncConnection, code: str | None) -> None:
    if code is not None and code not in await brand_codes(ro):
        raise errors.unprocessable("알 수 없는 브랜드", code="unknown_brand", details={"field": "brand_code"})


async def create(ro: AsyncConnection, rw: AsyncConnection, body: SourceCreate) -> Source:
    vals: dict[str, Any] = {
        "url": clean_text(body.url, field="url", max_len=2000, required=True), "channel": body.channel,
        "brand_code": clean_text(body.brand_code, field="brand_code", max_len=100),
        "notes": clean_text(body.notes, field="notes", max_len=2000), "enabled": body.enabled}
    await _check_brand(ro, vals["brand_code"])
    r = await fetch_one(rw, q.INSERT_SQL, vals)
    return Source(**r)  # type: ignore[arg-type]


async def update(ro: AsyncConnection, rw: AsyncConnection, source_id: uuid.UUID, body: SourcePatch) -> Source:
    given = body.model_fields_set & q.UPDATABLE
    if not given:
        raise errors.unprocessable("바꿀 필드가 없다", details={"field": "body"})
    patch: dict[str, Any] = {}
    for f in sorted(given):
        v = getattr(body, f)
        if f in ("url", "channel", "enabled") and v is None:
            raise errors.unprocessable(f"{f} 는 null 불가", details={"field": f})
        if f == "url":
            v = clean_text(v, field="url", max_len=2000, required=True)
        elif f in ("brand_code", "notes"):
            v = clean_text(v, field=f, max_len=100 if f == "brand_code" else 2000)
        patch[f] = v
    if "brand_code" in patch:
        await _check_brand(ro, patch["brand_code"])
    b = Binder()
    sets = [f"{k} = {b.v(v)}" for k, v in patch.items()] + ["updated_at = now()"]
    sql = f"UPDATE app.standard_source AS k SET {', '.join(sets)} WHERE k.source_id = {b.v(source_id)} RETURNING {q.COLS}"
    r = await fetch_one(rw, sql, b.params)
    if r is None:
        raise errors.not_found("표준 소스 없음")
    return Source(**r)


async def delete(rw: AsyncConnection, source_id: uuid.UUID) -> None:
    if await fetch_one(rw, q.DELETE_SQL, {"id": source_id}) is None:
        raise errors.not_found("표준 소스 없음")
