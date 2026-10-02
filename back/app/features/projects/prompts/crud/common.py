"""projects.prompts 그룹(PJ-3) 공용: 라우터 게이트·프로젝트 접근·meta 인자·프롬프트 행 조회·직렬화.

후보·CRUD·라이프사이클·실행·가져오기·커스텀 필드 6기능이 같이 쓴다. 권한 판정은 전부 core.auth 에 위임한다.
- 라우터 공통: require_role(현행 PROJECT_VIEWERS = hq·region·country·admin·vendor) + require_menu_group('project').
- 프로젝트 접근: core.auth.resolve_project(없음·비가시 404, 등급 부족 403). 읽기 = active_member(admin ∨ 활성 멤버, 비멤버 404),
  쓰기 = owner, 비용 액션(실행·재개) = member 가시성 + core.auth.require_operator('run'). 결과 ProjectAccess.scope_project_id 를 outbox payload 에 쓴다.
- 읽기 멤버 전용(메인 정정 2026-09-28, pj-prompts §4·검증 D6): 목록·후보 목록·태그 목록·내보내기는 활성 멤버 또는 admin 만 읽는다.
  근거 = 현행 프롬프트 탭 페이지 front app/[locale]/(dash)/projects/[id]/prompt/page.tsx:43(비멤버 notFound). 앞선 '비멤버 스코프 열람
  유지' 기록은 Scope 게이트웨이 층(lib/scope/server.ts assertProjectInScope)만 본 판단이라 정정했다.
- PJ-3 은 공통 필터 축을 지원하지 않는다(단위 명세 filters.supported = []). 요청에 들어온 공통 필터 축은 조용히 버리지 않고
  meta.ignored_filters 에 적는다: core.envelope.crud_meta(request.query_params, surface="project", consumed=PJ3_CONSUMED)
  (support 생략 = 지원 축 없음, 목록은 cf.* 를 extra_supported=("custom",) 로 더한다. 헤더로 알리는 내보내기는 core.filters.ignored_axes).
"""
from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal, ProjectAccess, ProjectLevel, require_menu_group, require_operator, require_role, resolve_project
from app.core.codes import load_refs
from app.core.db import fetch_all, fetch_one, fetch_val
from app.features.projects.prompts.crud.schemas import PromptItem

ROUTER_DEPS = [require_role("hq", "region", "country", "admin", "vendor"), require_menu_group("project")]

# surface·project_id 는 무시 목록에 적지 않는다(기존 계약 유지: 프로젝트는 경로가 정하고 표면은 project 로 고정. core 는 둘 다 축 이름으로 적는다)
PJ3_CONSUMED = ("surface", "project_id")


async def project_gate(conn: AsyncConnection, p: Principal, project_id: uuid.UUID, level: ProjectLevel) -> ProjectAccess:
    """core.auth.resolve_project(api_ro). 없음·standard_root·비가시 404, 소유자 아님 403 owner_only."""
    refs = await load_refs(conn)
    return await resolve_project(conn, p, refs, project_id, level)


async def operate_gate(conn: AsyncConnection, p: Principal, project_id: uuid.UUID) -> ProjectAccess:
    """비용 액션(측정 실행·재개): 프로젝트가 보여야 하고(member 가시성) core.auth.require_operator('run') 통과."""
    acc = await project_gate(conn, p, project_id, "member")
    await require_operator(conn, p, "run", project_id)
    return acc


PROMPT_COLS = ("p.prompt_id, p.candidate_id, p.text, p.kind, p.status, p.brand_code, p.category, p.prompt_type, p.lang, p.regions, "
               "p.scope_prompt_id, p.created_at, p.updated_at")

_LOCK_SQL = f"""
SELECT {PROMPT_COLS}
  FROM app.prompt p
 WHERE p.project_id = :pid AND p.prompt_id = :id AND p.deleted_at IS NULL
   FOR UPDATE"""

_GET_SQL = f"""
SELECT {PROMPT_COLS}
  FROM app.prompt p
 WHERE p.project_id = :pid AND p.prompt_id = :id AND p.deleted_at IS NULL"""

_TAGS_SQL = """
SELECT v.prompt_id, v.field_id, v.value
  FROM app.prompt_custom_field_value v
 WHERE v.project_id = :pid AND v.prompt_id = ANY(CAST(:ids AS uuid[]))"""

_SHARED_SQL = """
SELECT count(*) AS n FROM app.prompt p
 WHERE p.scope_prompt_id = :sp AND p.prompt_id <> :id AND p.deleted_at IS NULL"""


async def lock_prompt(rw: AsyncConnection, project_id: uuid.UUID, prompt_id: uuid.UUID) -> dict[str, Any]:
    """쓰기 대상 프롬프트 1건 FOR UPDATE. 다른 프로젝트 id·삭제된 행은 404(IDOR 은폐)."""
    r = await fetch_one(rw, _LOCK_SQL, {"pid": project_id, "id": prompt_id})
    if r is None:
        raise errors.not_found("프롬프트 없음", code="prompt_not_found")
    return r


async def get_prompt(conn: AsyncConnection, project_id: uuid.UUID, prompt_id: uuid.UUID) -> dict[str, Any]:
    r = await fetch_one(conn, _GET_SQL, {"pid": project_id, "id": prompt_id})
    if r is None:
        raise errors.not_found("프롬프트 없음", code="prompt_not_found")
    return r


async def tags_for(conn: AsyncConnection, project_id: uuid.UUID, prompt_ids: list[uuid.UUID]) -> dict[str, dict[str, str]]:
    """페이지 프롬프트들의 태그값을 한 번에(N+1 방지). {prompt_id: {field_id: value}}."""
    if not prompt_ids:
        return {}
    out: dict[str, dict[str, str]] = {}
    for r in await fetch_all(conn, _TAGS_SQL, {"pid": project_id, "ids": [str(x) for x in prompt_ids]}):
        out.setdefault(str(r["prompt_id"]), {})[str(r["field_id"])] = r["value"]
    return out


async def count_shared(conn: AsyncConnection, scope_prompt_id: uuid.UUID | None, prompt_id: uuid.UUID) -> int:
    """같은 Scope 프롬프트를 쓰는 다른 카탈로그 행 수(현행 countOthersByScopePromptId, prompt_scope_idx). 전 프로젝트 대상."""
    if scope_prompt_id is None:
        return 0
    return int(await fetch_val(conn, _SHARED_SQL, {"sp": scope_prompt_id, "id": prompt_id}) or 0)


def prompt_item(r: Mapping[str, Any], tags: Mapping[str, dict[str, str]] | None = None) -> PromptItem:
    return PromptItem(prompt_id=r["prompt_id"], candidate_id=r["candidate_id"], text=r["text"], kind=r["kind"], status=r["status"],
                      brand_code=r["brand_code"], category=r["category"], prompt_type=r["prompt_type"], lang=r["lang"],
                      regions=list(r["regions"]) if r["regions"] is not None else None, scope_prompt_id=r["scope_prompt_id"],
                      created_at=r["created_at"], updated_at=r["updated_at"], tags=dict((tags or {}).get(str(r["prompt_id"]), {})))
