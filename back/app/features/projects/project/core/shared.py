"""프로젝트 모듈(pj-core 그룹) 공용 도우미: 멤버 전용 접근(project_access), 엔진 어휘, 프로젝트 Scope 페이로드,
추적 브랜드 재구성(rebuild_tracked_brand), 대표 도메인 재동기화(resync_project_domain).

이 파일은 PJ-1(project.core)·PJ-2(members.*)·PJ-4(settings.*) 기능이 함께 쓴다(모듈-프로젝트.json shared[10] 공유 리포지토리 함수).
core 로 옮긴 것(6라운드 pj-core R1·R4·R8 처분): URL 정규화 = core.urls(normalize_url_for_match·canonical_http_url),
입력 문자열 타입 = core.filters(PgText·PgLine), meta·무시 축 = core.envelope.crud_meta(core.filters.ignored_axes),
DB 오류 판별 = core.errors(db_error_info·from_db_error), 멤버 전용 게이트 = core.auth.resolve_project(active_member·members_only).
여기 남은 엔진 어휘·추적 브랜드 재구성·대표 도메인·Scope 페이로드는 프로젝트 도메인 로직이라 기능 안에 둔다
(메인 처분 2026-09-28: 소비자가 projects 모듈뿐이라 core 반영 안 함).

규칙
- 권한·스코프 판정은 core.auth(resolve_project·require_operator·DataScope)만 쓴다.
- 쓰기 SQL 은 api_rw(RwConn) 에서 app 만 쓴다. rd 를 읽어야 하는 값(엔진 어휘 rd.dim_engine, 프로젝트 키)은 api_ro 로 먼저 읽는다.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal, ProjectAccess, ProjectLevel, resolve_project
from app.core.codes import Refs, load_refs
from app.core.db import fetch_all, fetch_one
from app.core.write import DedupeMode, enqueue_scope

# ── meta ────────────────────────────────────────────────────────────────────────
# 프로젝트 CRUD 표면은 공통 필터 축을 하나도 지원하지 않는다(모듈-프로젝트.json consistency_fixes[20]). meta 는
# core.envelope.crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED) 로 만든다(들어온 축 = ignored_filters).
# project_id 는 경로가 대신하므로 무시 목록에 적지 않는다(기존 계약 유지: core 는 project_id 도 축 이름으로 적는다). surface 는 적는다.
CRUD_CONSUMED = ("project_id",)


# ── 판정 입력 변경 큐(judgment_change) 중복 모드 ────────────────────────────────────
# project_owned_base·project_target_url·project_setting(추적 대상) 편집은 매 편집 1행(off)을 넣는다.
# 대기 행 합치기(coalesce_pending)는 검토 뒤 쓰지 않기로 했다(2026-09-28 pj-core R2 처분):
# - 합쳐도 되는 쪽 근거: 적재기는 이 세 kind 의 payload 를 판정에 쓰지 않고 주체 프로젝트 답변 전부를 다시 판정한다
#   (ingest/project/apply/rejudge.py PROJECT_KINDS 분기). payload(op·base_norm 등)는 이력용이라 합쳐도 판정 결과는 같다.
# - 합치면 안 되는 근거(결정): 적재기 IG-2 처리(ingest/cycles/workers/service.py process_change)는 행을 FOR UPDATE SKIP LOCKED 로
#   잡은 한 트랜잭션에서 재판정하고 마지막에 applied 로 바꾼다. 처리 중에도 다른 트랜잭션에는 status='pending' 으로 보이므로
#   coalesce_pending 이 그 행을 재사용하면 이 편집은 이미 옛 상태를 읽은 재판정에 묻혀 반영되지 않는다(조용한 누락).
#   api_rw 는 app.judgment_change UPDATE 권한이 없어(DB-v2.x REVOKE) 기능이 후보 행을 잠가 거를 수도 없다.
# 다음 DB 패치 후보(api_rw 행 잠금 권한 또는 SECURITY DEFINER 잠금 함수, core.write 머리말·DECISIONS-API 6라운드)가 들어오면 "coalesce_pending" 으로 바꾼다.
JUDGMENT_DEDUPE: DedupeMode = "off"


# ── 접근 ────────────────────────────────────────────────────────────────────────
async def project_access(ro: AsyncConnection, p: Principal, project_id: uuid.UUID, level: ProjectLevel = "active_member",
                         refs: Refs | None = None) -> tuple[ProjectAccess, Refs]:
    """core.auth.resolve_project(members_only=True) + refs. ro = 요청의 api_ro 커넥션.

    pj-core 표면(상세·멤버·감사·설정·추적 URL·엔진)은 전부 "활성 멤버 또는 admin" 이고 비멤버는 존재를 흘리지 않게 404 다
    (모듈-프로젝트.md §2·§7, 현행 projects/[id]/page.tsx:49-50·member/page.tsx:38-40 notFound). 조회 = active_member,
    쓰기 = owner·operate·owner_and_operate. members_only=True 라 어느 수준이든 비멤버는 403 이 아니라 404(검증 D1),
    활성 viewer 의 쓰기는 403 owner_only 그대로다."""
    refs = refs or await load_refs(ro)
    return await resolve_project(ro, p, refs, project_id, level, members_only=True), refs


def clean_aliases(values: list[str] | None) -> list[str]:
    """별칭 목록: 앞뒤 공백 제거·빈 값 제거·중복 제거(첫 등장 순서 유지)."""
    return list(dict.fromkeys(v.strip() for v in (values or []) if v and v.strip()))


# ── 엔진 어휘(rd.dim_engine 코드 = Scope schedule targets 토큰, 현행 lib/scope/engines.ts) ─────
def engine_vocab(refs: Refs) -> list[str]:
    """허용 엔진 코드(engine_key 순 = 현행 카탈로그 순서). 빈 코드(키 0 예약)는 뺀다."""
    return [code for code, _ in sorted(refs.engines.items(), key=lambda kv: kv[1][0]) if code]


def normalize_engines(values: list[str], refs: Refs) -> list[str]:
    """중복 제거·카탈로그 순서 고정. 알 수 없는 코드는 422 unknown_engine(조용히 버리지 않는다)."""
    vocab = engine_vocab(refs)
    bad = sorted({v for v in values if v not in vocab})
    if bad:
        raise errors.unprocessable("알 수 없는 엔진", code="unknown_engine", details={"engines": bad, "allowed": vocab})
    got = set(values)
    return [c for c in vocab if c in got]


async def default_engines(conn: AsyncConnection) -> list[str]:
    """app.rule_param 'default_engines'(현행 DEFAULT_AI_ENGINES). ai_engines IS NULL 프로젝트가 실제로 측정되는 엔진."""
    r = await fetch_one(conn, "SELECT value FROM app.rule_param WHERE key = 'default_engines'")
    v = r["value"] if r else None
    return [str(x) for x in v] if isinstance(v, list) else []


# ── 프로젝트 행·Scope 아웃박스 ───────────────────────────────────────────────────
PROJECT_COLS = ("p.project_id, p.kind, p.name, p.description, p.domain, p.brand_code, p.country_code, p.scope_project_id, "
                "p.ga4_property_id, p.ai_engines, p.created_by, p.created_at, p.updated_at")


def scope_project_payload(row: dict[str, Any]) -> dict[str, Any]:
    """app.scope_outbox project:create·update 페이로드(워커 계약은 적재 모듈 소관, 모듈-프로젝트 §10-1 열린 질문)."""
    return {"project_id": str(row["project_id"]), "scope_project_id": str(row["scope_project_id"]) if row.get("scope_project_id") else None,
            "name": row["name"], "description": row.get("description"), "domain": row.get("domain"),
            "brand_code": row.get("brand_code"), "country_code": row["country_code"]}


async def enqueue_project_update(rw: AsyncConnection, project_id: uuid.UUID) -> int:
    """현재 프로젝트 행으로 outbox(project:update) 1건(미완료 같은 op 는 core.enqueue_scope 가 최신 페이로드로 합친다)."""
    row = await fetch_one(rw, f"SELECT {PROJECT_COLS} FROM app.project p WHERE p.project_id = :pid", {"pid": project_id})
    if row is None:
        raise errors.not_found("프로젝트 없음")
    return await enqueue_scope(rw, "project", project_id, "update", scope_project_payload(row))


# ── 대표 도메인 재동기화(현행 syncLegacyProjectDomain setting/_actions.ts:208) ─────────
async def resync_project_domain(rw: AsyncConnection, project_id: uuid.UUID) -> str | None:
    """domain = 가장 먼저 등록된 owned base 의 base_norm(없으면 NULL). 값이 바뀌면 app.project 트리거가
    judgment_change('project_setting') 를 남긴다(앱은 넣지 않는다, Q3)."""
    r = await fetch_one(rw, """
        UPDATE app.project p
           SET domain = (SELECT b.base_norm FROM app.project_owned_base b WHERE b.project_id = p.project_id
                          ORDER BY b.created_at, b.base_url LIMIT 1),
               updated_at = now()
         WHERE p.project_id = :pid
     RETURNING p.domain""", {"pid": project_id})
    if r is None:
        raise errors.not_found("프로젝트 없음")
    return r["domain"]


# ── 추적 브랜드 카탈로그 재구성(현행 syncTrackedBrandCatalog tracked-entities.ts:309 이식) ───
async def rebuild_tracked_brand(rw: AsyncConnection, project_id: uuid.UUID) -> list[dict[str, Any]]:
    """app.project_tracked_brand 를 프로젝트 브랜드·경쟁 브랜드(+별칭)·차종 브랜드에서 다시 만든다.
    기존 행의 별칭은 정본 이름이 살아 있을 때만 이어 붙이고, 사라진 정본은 지운다. 결과 행 목록을 돌려준다."""
    proj = await fetch_one(rw, "SELECT brand_code FROM app.project WHERE project_id = :pid", {"pid": project_id})
    if proj is None:
        raise errors.not_found("프로젝트 없음")
    comps = await fetch_all(rw, "SELECT brand_name, aliases FROM app.project_tracked_competitor WHERE project_id = :pid "
                                "ORDER BY brand_name", {"pid": project_id})
    vehs = await fetch_all(rw, "SELECT brand FROM app.project_tracked_vehicle WHERE project_id = :pid ORDER BY brand, model",
                           {"pid": project_id})
    existing = await fetch_all(rw, "SELECT canonical_name, aliases FROM app.project_tracked_brand WHERE project_id = :pid "
                                   "ORDER BY canonical_name", {"pid": project_id})
    merged: dict[str, dict[str, None]] = {}

    def push(canonical: str | None, aliases: list[str] | None) -> None:
        c = (canonical or "").strip()
        if not c:
            return
        s = merged.setdefault(c, {})
        s[c] = None
        for a in aliases or []:
            t = (a or "").strip()
            if t:
                s[t] = None

    push(proj["brand_code"], [])
    for r in comps:
        push(r["brand_name"], r["aliases"])
    for r in vehs:
        push(r["brand"], [])
    for r in existing:
        if r["canonical_name"] in merged:
            push(r["canonical_name"], r["aliases"])
    names = list(merged)
    if names:                          # 정본별 upsert 를 한 문장으로(현행은 행별 upsert). 별칭 목록은 길이가 달라 jsonb 배열로 넘긴다
        await rw.execute(_text(UPSERT_TRACKED_BRANDS),
                         {"pid": project_id, "rows": json.dumps([[n, list(merged[n])] for n in names], ensure_ascii=False)})
    await rw.execute(_text("DELETE FROM app.project_tracked_brand WHERE project_id = :pid AND NOT (canonical_name = ANY(CAST(:names AS text[])))"),
                     {"pid": project_id, "names": names})
    return [{"canonical_name": n, "aliases": list(merged[n])} for n in names]


# [[정본, [별칭…]], …] → 정본마다 1행 upsert(입력 순서·별칭 순서 유지, 정본은 merged 키라 중복 없음).
UPSERT_TRACKED_BRANDS = """
INSERT INTO app.project_tracked_brand (project_id, canonical_name, aliases)
SELECT :pid, r.value->>0,
       ARRAY(SELECT a.value FROM jsonb_array_elements_text(r.value->1) WITH ORDINALITY AS a(value, i) ORDER BY a.i)
  FROM jsonb_array_elements(CAST(:rows AS jsonb)) WITH ORDINALITY AS r(value, i)
 ORDER BY r.i
ON CONFLICT (project_id, canonical_name) DO UPDATE SET aliases = EXCLUDED.aliases"""


def _text(sql: str) -> Any:
    from sqlalchemy import text
    return text(sql)
