"""intent.keywords.fetches 업무 규칙: DataForSEO 수집 요청(Q13 운영자 전용·비동기).

흐름(core.db 규약: rd 를 읽는 쓰기 핸들러 = api_ro 로 먼저 읽고 api_rw 에서 app 만 쓴다)
  1) 권한: project_id 가 있으면 메뉴 project + core.auth.resolve_project(operate)(국가가 프로젝트 국가·추적 키워드 국가 밖이면
     아래 규칙), 없으면 메뉴 standard + admin·전역 운영자 + 국가 스코프(검증 D3·D5).
  2) 신선도(api_ro, force 면 건너뜀): term 별 최신 관측. insight = 검색량·SERP 둘 다 24시간 안, related = 최신 연관어 호출이 7일 안,
     search = seed 행을 포함한 최신 연관어 호출이 7일 안(rd.kw_suggestion.observed_at, DB-v2.6 P43). 신선한 term 은 빠진다.
  3) 신선하지 않은 term 만 app.judgment_change('dfs_fetch') 1행(core.write.enqueue_change_result, 같은 트랜잭션).
     payload = core.contracts DfsFetch{fetch, terms, location_code, language_code, country, depth, project_id, force},
     subject_texts = 정렬된 DB 정본 정규화(app.term_norm, core.kw.db_term_norms). 같은 요청 = 같은 (fetch, location_code, language_code, subject_texts)의 pending·running 행
     (dedupe="coalesce_active" + dedupe_key: 국가·종류가 다른 대기 행에 묻히지 않는다, 검증 D1). 동시 요청은 core 가 advisory 잠금으로
     직렬화한다. 재사용 후보는 요청자가 상태 조회로 볼 수 있는 행만(reusable = _visible, 검증 D4). 재사용이면 202 pending + 기존 change_id.
적재기(ingest dfs_fetch 빠른 경로)가 claim → ext.dfs_call·rd.kw_* 적재 → status 전이. API 는 외부 서비스를 부르지 않는다.
상태 조회: 단건(GET …/{change_id})과 일괄(GET …?ids=, 화면 폴링이 대기 id 를 한 요청으로)은 같은 가시성 규칙(_visible)·같은 응답 행이다.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import auth, errors
from app.core.auth import Principal
from app.core.codes import load_refs
from app.core.db import fetch_one
from app.core.kw import Preset, clean_term, db_term_norms, preset_of
from app.core.write import enqueue_change_result
from app.features.intent.keywords.fetches import queries as q
from app.features.intent.keywords.fetches.schemas import FetchAccepted, FetchIn, FetchKind, FetchStatus
from app.features.intent.keywords.research.intent_common import freshness, require_global_operator
from app.features.intent.keywords.research.schemas import TermObserved
from app.features.intent.keywords.research.service import observed_by_term, project_countries

SERP_DEPTH = 10


async def _access(conn: AsyncConnection, p: Principal, body: FetchIn) -> Preset:
    """project_id 있음 = 메뉴 project + resolve_project(operate). 국가가 그 프로젝트에 묶이지 않으면(프로젝트 국가·추적 키워드 국가 밖)
    프로젝트 없는 규칙(메뉴 standard + admin·전역 운영자 + 국가 스코프)을 적용한다(검증 D5). 없음 = 그 규칙(검증 D3)."""
    refs = await load_refs(conn)
    if body.project_id is not None:
        auth.require_surface(p, "project")          # 역할 천장 PROJECT_VIEWERS + 메뉴 project(검증 m-7)
        acc = await auth.resolve_project(conn, p, refs, body.project_id, "operate")
        preset = preset_of(body.country or acc.country_code)
        if preset.id not in await project_countries(conn, acc):
            require_global_operator(p, refs, preset)
        return preset
    auth.check_menu_group(p, "standard")
    preset = preset_of(body.country)
    require_global_operator(p, refs, preset)
    return preset


async def _visible(conn: AsyncConnection, p: Principal, row: dict[str, Any]) -> bool:
    """수집 요청 행 가시성: 요청자 본인, admin, 또는 그 요청의 프로젝트를 운영할 수 있는 운영자(프로젝트 없는 요청은 전역 운영자)."""
    if p.is_admin or (row["requested_by"] is not None and uuid.UUID(str(row["requested_by"])) == p.user_id):
        return True
    if not auth.is_operator(p):
        return False
    pid = (row["payload"] or {}).get("project_id")
    if not pid:
        return p.operator == "global"
    try:
        await auth.resolve_project(conn, p, await load_refs(conn), uuid.UUID(str(pid)), "operate")
    except errors.ApiError:
        return False
    return True


def is_fresh(o: TermObserved | None, kind: FetchKind) -> bool:
    """term 이 이 수집 종류로 신선한가(insight = 검색량·SERP 둘 다 24시간, related·search = 연관어 관측 7일)."""
    if o is None:
        return False
    at: datetime | None
    if kind == "insight":
        if o.volume_at is None or o.serp_at is None:
            return False
        at = min(o.volume_at, o.serp_at)
    else:
        at = o.related_at if kind == "related" else o.search_at
    return freshness(at, kind) == "fresh"


async def accept(conn: AsyncConnection, rw: AsyncConnection, p: Principal, body: FetchIn) -> tuple[FetchAccepted, int]:
    """(응답, HTTP 상태): 신선하면 200, 큐에 넣었거나 이미 대기 중이면 202."""
    preset = await _access(conn, p, body)
    terms = list(dict.fromkeys(clean_term(t, field="terms") for t in body.terms))
    norms = await db_term_norms(conn, terms)               # 정규화 정본 = DB app.term_norm(검증 m-5): 신선도 조회·중복 주체 모두
    fresh: list[str] = []
    if not body.force:
        obs = await observed_by_term(conn, sorted(set(norms.values())), preset)
        fresh = [t for t in terms if is_fresh(obs.get(norms[t]), body.kind)]
    targets = [t for t in terms if t not in fresh]
    if not targets:
        return FetchAccepted(status="fresh", change_id=None, terms=[], fresh_terms=fresh), 200
    payload: dict[str, Any] = {"fetch": body.kind, "terms": targets, "location_code": preset.location_code,
                               "language_code": preset.language_code, "country": preset.id, "depth": SERP_DEPTH,
                               "project_id": str(body.project_id) if body.project_id else None, "force": body.force}
    subjects = sorted({norms[t] for t in targets})

    async def reusable(row: dict[str, Any]) -> bool:
        return await _visible(conn, p, row)
    res = await enqueue_change_result(
        rw, "dfs_fetch", payload=payload, subject_texts=subjects, dedupe="coalesce_active",
        dedupe_key={"fetch": body.kind, "location_code": preset.location_code, "language_code": preset.language_code},
        reusable=reusable)
    return FetchAccepted(status="queued" if res.created else "pending", change_id=res.change_id, terms=targets, fresh_terms=fresh), 202


async def status(conn: AsyncConnection, p: Principal, change_id: int) -> FetchStatus:
    """요청자 본인, admin, 또는 그 요청의 프로젝트를 운영할 수 있는 운영자(프로젝트 없는 요청은 전역 운영자)만. 밖이면 404(IDOR 은폐)."""
    r = await fetch_one(conn, q.CHANGE, {"cid": change_id})
    if r is None or not await _visible(conn, p, r):
        raise errors.not_found("수집 요청 없음")
    pl: dict[str, Any] = r["payload"] or {}
    pid = pl.get("project_id")
    return FetchStatus(change_id=int(r["change_id"]), status=r["status"], kind=pl.get("fetch"), country=pl.get("country"),
                       terms=list(pl.get("terms") or r["subject_texts"] or []), project_id=uuid.UUID(pid) if pid else None,
                       requested_at=r["requested_at"], claimed_at=r["claimed_at"], applied_at=r["applied_at"],
                       error=(r["error"] or None) and str(r["error"])[:500])


async def statuses(conn: AsyncConnection, p: Principal, change_ids: list[int]) -> list[FetchStatus]:
    """일괄 상태 조회: id 마다 status 와 같은 판정(요청 순서, 중복 id 는 한 번). 하나라도 없거나 볼 수 없으면 404(단건 조회와 같은
    응답이라 어느 id 인지 드러내지 않는다, IDOR 은폐)."""
    return [await status(conn, p, cid) for cid in dict.fromkeys(change_ids)]
