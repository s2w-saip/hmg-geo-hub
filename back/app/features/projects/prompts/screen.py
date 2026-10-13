"""Paged reads for existing project prompt/candidate screens, with project-wide column metadata."""
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core import errors
from app.core.db import fetch_all, fetch_one, fetch_val
from app.core.sqlb import Binder
from app.features.projects.prompts.candidates.schemas import CandidateItem
from app.features.projects.prompts.crud.common import PROMPT_COLS, prompt_item, tags_for
from app.features.projects.prompts.crud.schemas import PromptItem


class ProjectScreenQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    offset: int = Field(0, ge=0, le=10_000_000)
    limit: int = Field(200, ge=1, le=500)
    sort: str = Field("", max_length=36)
    direction: Literal["asc", "desc"] | None = None
    collation: Literal["ko", "en"] = "en"
    ids_only: bool = False
    include_values: bool = Field(True, description=(
        "false = 태그 값 제안(values) 집계를 건너뛰고 null. values 는 프로젝트 전체 값이라 페이지·정렬과 무관하므로 "
        "화면이 첫 응답 값을 재사용한다"))


class ProjectScreenPage[T](BaseModel):
    rows: list[T]
    ids: list[uuid.UUID] = Field(default_factory=list)
    total: int
    offset: int
    limit: int
    show_brand: bool = False
    show_category: bool = False
    draft_count: int = 0
    values: dict[str, list[str]] | None = Field(default_factory=dict, description="태그별 사용 값(include_values=false 면 null)")


async def prompt_screen(conn, project_id: uuid.UUID, query: ProjectScreenQuery) -> ProjectScreenPage[PromptItem]:
    b = Binder()
    pid = b.v(project_id, "uuid")
    where = f"p.project_id = {pid} AND p.deleted_at IS NULL"
    meta = await fetch_one(conn, "SELECT count(*) AS total, coalesce(bool_or(p.brand_code IS NOT NULL AND p.brand_code <> ''), false) AS show_brand,"
                           " coalesce(bool_or(p.category IS NOT NULL AND p.category <> ''), false) AS show_category,"
                           " count(*) FILTER (WHERE p.status = 'draft' OR (p.status = 'queued' AND p.scope_prompt_id IS NULL)) AS draft_count"
                           f" FROM app.prompt p WHERE {where}", b.params)
    total = int(meta["total"])
    offset = min(query.offset, max(0, (total - 1) // query.limit * query.limit))
    order = "p.created_at ASC, p.prompt_id ASC"
    if query.direction:
        if query.sort == "status":
            expr = "CASE p.status WHEN 'draft' THEN 0 WHEN 'queued' THEN 1 WHEN 'running' THEN 2 WHEN 'done' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END"
            order = f"{expr} {query.direction.upper()}, " + order
        else:
            columns = {"text": "p.text", "brand": "p.brand_code", "category": "p.category"}
            if query.sort in columns:
                expr = f"lower(coalesce({columns[query.sort]}, ''))"
            else:
                try:
                    field = uuid.UUID(query.sort)
                except ValueError as exc:
                    raise errors.unprocessable("Invalid sort field") from exc
                exists = await fetch_val(conn, "SELECT field_id FROM app.project_custom_field WHERE project_id = :pid AND field_id = :fid", {"pid": project_id, "fid": field})
                if exists is None:
                    raise errors.not_found("태그 없음")
                expr = f"lower(coalesce((SELECT v.value FROM app.prompt_custom_field_value v WHERE v.project_id = {pid} AND v.prompt_id = p.prompt_id AND v.field_id = {b.v(field, 'uuid')}), ''))"
            order = f"({expr} = '') ASC, {expr} COLLATE \"C\" {query.direction.upper()}, " + order
    select = "p.prompt_id" if query.ids_only else PROMPT_COLS
    rows = await fetch_all(conn, f"SELECT {select} FROM app.prompt p WHERE {where} ORDER BY {order} LIMIT {b.v(query.limit, 'int4')} OFFSET {b.v(offset, 'int4')}", b.params)
    values: dict[str, list[str]] = {}
    if not query.ids_only and query.include_values:
        for row in await fetch_all(conn, "SELECT v.field_id, array_agg(DISTINCT v.value) AS values FROM app.prompt_custom_field_value v"
                                   " JOIN app.prompt p ON p.prompt_id = v.prompt_id AND p.project_id = v.project_id"
                                   f" WHERE {where} AND v.value <> '' GROUP BY v.field_id", b.params):
            values[str(row["field_id"])] = row["values"]
    tags = {} if query.ids_only else await tags_for(conn, project_id, [row["prompt_id"] for row in rows])
    return ProjectScreenPage(rows=[] if query.ids_only else [prompt_item(row, tags) for row in rows], ids=[row["prompt_id"] for row in rows] if query.ids_only else [],
                             total=total, offset=offset, limit=query.limit, values=values if query.include_values or query.ids_only else None,
                             show_brand=meta["show_brand"], show_category=meta["show_category"], draft_count=meta["draft_count"])


async def candidate_screen(conn, project_id: uuid.UUID, query: ProjectScreenQuery) -> ProjectScreenPage[CandidateItem]:
    sorts = {"": "c.created_at DESC", "newest": "c.created_at DESC", "oldest": "c.created_at ASC", "text": "c.text", "source": "c.source"}
    if query.sort not in sorts:
        raise errors.unprocessable("Invalid candidate sort")
    order = sorts[query.sort]
    if query.sort in ("text", "source"):
        order += ' COLLATE "ko-x-icu"' if query.collation == "ko" else ' COLLATE "en-x-icu"'
        order += " ASC"
    order += ", c.created_at DESC, c.candidate_id DESC"
    params = {"pid": project_id, "limit": query.limit}
    total = int(await fetch_val(conn, "SELECT count(*) FROM app.prompt_candidate WHERE project_id = :pid", params))
    offset = min(query.offset, max(0, (total - 1) // query.limit * query.limit))
    params["offset"] = offset
    rows = await fetch_all(conn, "SELECT c.candidate_id, c.source, c.source_keyword, c.text, c.created_at FROM app.prompt_candidate c"
                           f" WHERE c.project_id = :pid ORDER BY {order} LIMIT :limit OFFSET :offset", params)
    return ProjectScreenPage(rows=[CandidateItem(**row) for row in rows], total=total, offset=offset, limit=query.limit)
