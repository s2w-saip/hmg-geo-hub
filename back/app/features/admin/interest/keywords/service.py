"""admin.interest.keywords 업무 규칙(AD-1b). 고객 관심 키워드 원천(app.standard_keyword) CRUD.

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
from app.features.admin.interest.keywords import queries as q
from app.features.admin.interest.keywords.schemas import Keyword, KeywordCreate, KeywordPatch


async def list_keywords(ro: AsyncConnection, *, source_type: str | None, brands: list[str], enabled: bool | None,
                        q_text: str | None) -> list[Keyword]:
    b = Binder()
    where = []
    if source_type:
        where.append(f"k.source_type = {b.v(source_type)}")
    if brands:
        where.append(f"k.brand_code = ANY({b.v(sorted(set(brands)), 'text[]')})")
    if enabled is not None:
        where.append(f"k.enabled = {b.v(enabled)}")
    if q_text:
        where.append(f"k.term ILIKE {b.v(like_pattern(q_text))}")
    sql = q.LIST_SELECT + (" WHERE " + " AND ".join(where) if where else "") + q.LIST_ORDER
    return [Keyword(**r) for r in await fetch_all(ro, sql, b.params)]


async def _check_brand(ro: AsyncConnection, code: str | None) -> None:
    if code is not None and code not in await brand_codes(ro):
        raise errors.unprocessable("알 수 없는 브랜드", code="unknown_brand", details={"field": "brand_code"})


async def create(ro: AsyncConnection, rw: AsyncConnection, body: KeywordCreate) -> Keyword:
    vals: dict[str, Any] = {
        "term": clean_text(body.term, field="term", max_len=200, required=True), "source_type": body.source_type,
        "brand_code": clean_text(body.brand_code, field="brand_code", max_len=100),
        "notes": clean_text(body.notes, field="notes", max_len=2000), "enabled": body.enabled}
    await _check_brand(ro, vals["brand_code"])
    r = await fetch_one(rw, q.INSERT_SQL, vals)
    return Keyword(**r)  # type: ignore[arg-type]


async def update(ro: AsyncConnection, rw: AsyncConnection, keyword_id: uuid.UUID, body: KeywordPatch) -> Keyword:
    given = body.model_fields_set & q.UPDATABLE
    if not given:
        raise errors.unprocessable("바꿀 필드가 없다", details={"field": "body"})
    patch: dict[str, Any] = {}
    for f in sorted(given):
        v = getattr(body, f)
        if f in ("term", "source_type", "enabled") and v is None:
            raise errors.unprocessable(f"{f} 는 null 불가", details={"field": f})
        if f == "term":
            v = clean_text(v, field="term", max_len=200, required=True)
        elif f in ("brand_code", "notes"):
            v = clean_text(v, field=f, max_len=100 if f == "brand_code" else 2000)
        patch[f] = v
    if "brand_code" in patch:
        await _check_brand(ro, patch["brand_code"])
    b = Binder()
    sets = [f"{k} = {b.v(v)}" for k, v in patch.items()] + ["updated_at = now()"]
    sql = f"UPDATE app.standard_keyword AS k SET {', '.join(sets)} WHERE k.keyword_id = {b.v(keyword_id)} RETURNING {q.COLS}"
    r = await fetch_one(rw, sql, b.params)
    if r is None:
        raise errors.not_found("키워드 없음")
    return Keyword(**r)


async def delete(rw: AsyncConnection, keyword_id: uuid.UUID) -> None:
    if await fetch_one(rw, q.DELETE_SQL, {"id": keyword_id}) is None:
        raise errors.not_found("키워드 없음")
