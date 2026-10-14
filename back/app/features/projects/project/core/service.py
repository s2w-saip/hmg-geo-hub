"""projects.project.core 업무 규칙(PJ-1). 권한은 core.auth, 쓰기는 core.write, 공용 도우미는 shared.

- 생성: core.auth.require_operator('create_project')(operator=global 또는 admin) + 생성 가능 브랜드·국가 검증
  (현행 projectCreationOptions scope-policy.ts:286 이식) → 한 트랜잭션에 project + owner 멤버 + owned base 시드 + 엔진 이력 첫 행
  + outbox(project:create) + outbox(schedule:set_targets).
- 수정: Owner/admin. brand_code 변경 시 옛 브랜드 추적 행 삭제 + 추적 브랜드 재구성, outbox(project:update).
  judgment_change('project_setting') 는 app.project 트리거가 남긴다(Q3, 앱은 넣지 않는다).
- 삭제: Owner/admin, FOR UPDATE 후 이름 대조(불일치 409 name_mismatch) → DELETE app.project(자식 FK CASCADE) →
  outbox(project:delete) → 접근 감사(data_access).
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Literal

from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import DataScope, Principal, require_operator, surface_denial
from app.core.codes import Refs, load_refs
from app.core.db import fetch_all, fetch_one
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.urls import canonical_http_url, normalize_url_for_match
from app.core.write import access_audit, enqueue_scope
from app.features.projects.project.core import queries as Q
from app.features.projects.project.core.shared import (
    PROJECT_COLS,
    default_engines,
    engine_vocab,
    normalize_engines,
    project_access,
    rebuild_tracked_brand,
    scope_project_payload,
)

LIST_DEFAULT, LIST_MAX = 50, 100
_SORT = "created_at"
_GA4 = re.compile(r"[0-9]+")
_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")


def seed_domain(raw: str | None) -> tuple[str | None, str | None]:
    """생성 domain 입력 → (owned base base_url, base_norm = project.domain). 빈 값이면 (None, None).
    owned_bases 추가(POST /settings/owned-bases)와 같은 불변식: base_url = canonical_http_url, base_norm = normalize_url_for_match.
    스킴 없는 호스트('kia.com')는 https:// 를 붙여 받는다(현행 생성 폼은 자유 텍스트). 'javascript:…' 같은 비 http(s) 는 422 invalid_url
    (검증 D4)."""
    s = (raw or "").strip()
    if not s:
        return None, None
    if not _SCHEME.match(s):
        s = "https://" + s
    url = canonical_http_url(s, field="domain")
    norm = normalize_url_for_match(url)
    if not norm:
        raise errors.unprocessable("도메인 형식 오류", code="invalid_url", details={"field": "domain"})
    return url, norm


def _effective(stored: list[str] | None, dflt: list[str]) -> list[str]:
    return list(dflt) if stored is None else list(stored)


def _project_out(r: dict[str, Any], dflt: list[str]) -> dict[str, Any]:
    out = {k: r[k] for k in ("project_id", "name", "description", "domain", "brand_code", "country_code", "scope_project_id",
                             "ga4_property_id", "ai_engines", "created_by", "created_at", "updated_at")}
    out["ai_engines"] = list(r["ai_engines"]) if r["ai_engines"] is not None else None
    out["effective_engines"] = _effective(out["ai_engines"], dflt)
    out["my_role"] = r.get("my_role")
    return out


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# ── 목록 ────────────────────────────────────────────────────────────────────────
async def list_projects(ro: AsyncConnection, p: Principal, q: str | None, cursor: str | None, limit: int | None
                        ) -> tuple[list[dict[str, Any]], str | None, int]:
    if limit is not None and limit > LIST_MAX:
        raise errors.unprocessable(f"limit 은 1~{LIST_MAX}", details={"field": "limit"})
    lim = clamp_limit(limit, LIST_DEFAULT)
    qn = (q or "").strip() or None
    fh = filter_hash({"q": qn, "admin": p.is_admin})
    cur = decode_cursor(cursor, sort=_SORT, dir="desc", fh=fh, types=("timestamptz", "uuid"))
    b = Binder("k")
    ks = keyset_predicate(Q.LIST_SORT_COLS, "desc", cur, b)
    params: dict[str, Any] = {"uid": p.user_id, "lim": lim + 1, **b.params}
    if qn:
        params["q"] = _like(qn)
    rows = await fetch_keyset(ro, Q.list_sql(admin=p.is_admin, has_q=qn is not None, keyset=ks), params)
    page, nxt = keyset_page(rows, lim, lambda r: (r["created_at"], r["project_id"]), sort=_SORT, dir="desc", fh=fh)
    dflt = await default_engines(ro)
    counts: dict[Any, dict[str, Any]] = {}
    if page:
        for c in await fetch_all(ro, Q.CARD_COUNTS, {"ids": [str(r["project_id"]) for r in page]}):
            counts[c["project_id"]] = c
    items = []
    for r in page:
        o = _project_out(r, dflt)
        c = counts.get(r["project_id"], {})
        o.update(active_member_count=int(c.get("active_members") or 0), prompt_count=int(c.get("prompts") or 0),
                 prompt_in_flight_count=int(c.get("in_flight") or 0))
        items.append(o)
    return items, nxt, lim


# ── 상세 ────────────────────────────────────────────────────────────────────────
DetailView = Literal["full", "gate"]

# view=gate 행: DETAIL 과 같은 행 + target_brand(지정 비교 브랜드, tracked_competitor_one_target 1행 색인 조회).
# 프로젝트 화면 게이트(front project-gate)는 이름·역할만 쓰지만, 언급 화면 getTargetBrand 가 같은 호출을 공유할 수 있게
# 같은 문장에서 이 한 값만 채운다(요약의 나머지 문장은 읽지 않는다).
GATE_DETAIL = f"""
SELECT {PROJECT_COLS}, me.role::text AS my_role,
       (SELECT t.brand_name FROM app.project_tracked_competitor t WHERE t.project_id = p.project_id AND t.is_target LIMIT 1) AS target_brand
  FROM app.project p
  LEFT JOIN app.project_member me ON me.project_id = p.project_id AND me.user_id = :uid AND me.status = 'active'
 WHERE p.project_id = :pid AND p.kind = 'customer'
"""


async def get_project(ro: AsyncConnection, p: Principal, project_id: uuid.UUID, view: DetailView = "full") -> dict[str, Any]:
    """상세. view=full(기본) = 일반 설정 + 요약(detail_summary). view=gate = 게이트용 경량 조회: 접근 판정 + 프로젝트 행(+ target_brand)만,
    기본 엔진(effective_engines)·요약 필드는 null(같은 게이트·같은 404)."""
    await project_access(ro, p, project_id, "active_member")   # 없음·루트·비가시·비멤버(admin 제외) 404(검증 D1)
    if view == "gate":
        r = await fetch_one(ro, GATE_DETAIL, {"pid": project_id, "uid": p.user_id})
        if r is None:
            raise errors.not_found("프로젝트 없음")
        o = _project_out(r, [])
        o["effective_engines"] = None
        o["scope_linked"] = r["scope_project_id"] is not None
        o["target_brand"] = r["target_brand"]
        return o
    r = await fetch_one(ro, Q.DETAIL, {"pid": project_id, "uid": p.user_id})
    if r is None:
        raise errors.not_found("프로젝트 없음")
    o = _project_out(r, await default_engines(ro))
    o["scope_linked"] = r["scope_project_id"] is not None
    o.update(await detail_summary(ro, project_id))
    return o


_PROMPT_STATUSES = ("draft", "queued", "running", "done", "failed", "paused")
RECENT_PROMPTS_N = 5                       # 현행 recentPrompts .slice(0, 5)(project-dashboard.tsx:120-122)


async def detail_summary(ro: AsyncConnection, project_id: uuid.UUID) -> dict[str, Any]:
    """상세 요약(BG-38): 프롬프트 상태별 수·후보 수·활성 멤버 수·최근 실행 시각·지정 비교 브랜드·최근 수정 프롬프트 5건(검증 D4).
    현행 /projects/[id] 가 전량 목록 3개를 읽어 세던 값(project-dashboard.tsx:100-122)과 언급 화면 getTargetBrand(tracked-entities.ts:101).
    호출자가 이미 접근 게이트(active_member)를 통과한 뒤에만 부른다."""
    s = await fetch_one(ro, Q.DETAIL_SUMMARY, {"pid": project_id})
    assert s is not None                   # 집계 1행은 항상 나온다
    recent = await fetch_all(ro, Q.RECENT_PROMPTS, {"pid": project_id, "lim": RECENT_PROMPTS_N})
    return {"prompt_counts": {k: int(s[f"n_{k}"] or 0) for k in _PROMPT_STATUSES},
            "candidate_count": int(s["candidate_count"] or 0), "active_member_count": int(s["active_member_count"] or 0),
            "last_run_at": s["last_run_at"], "target_brand": s["target_brand"],
            "recent_prompts": [dict(r) for r in recent]}


# ── Scope 프로젝트 id 해석(BG-36) ────────────────────────────────────────────────
def website_site_visible(p: Principal, refs: Refs, brand: str, country: str) -> bool:
    """웹사이트 사이트 가시성: 웹사이트 표면 게이트(역할·메뉴) ∧ 분석 읽기 문맥(core.filters.resolve_read_context website)과 같은
    사이트 선택 규칙. 관점 브랜드 = 스코프 브랜드(전체면 엄브렐러 제외 전 브랜드)에 사이트 브랜드가 있고, 계정 국가 스코프가 있으면
    사이트 국가가 그 안이어야 한다(국가 스코프의 브랜드 가상 코드는 사이트 브랜드로 통과: DataScope.site_allowed, 현대 N 계정 → Hyundai N 사이트,
    동기화 S1 BE-8). 국가 스코프가 국가로 안 풀리면(빈 집합) 거부(default-deny)."""
    if surface_denial(p, "website") is not None:
        return False
    scope = DataScope.of(p, refs).for_surface("website")          # 분석 읽기 website 와 같은 사이트 규칙(도시 의사 코드 scopeParent)
    if scope.countries == ():
        return False
    base = [b.code for b in refs.real_brands] if scope.brands is None else [c for c in scope.brands if refs.brand(c)]
    if brand not in base:
        return False
    b = refs.brand(brand)
    return scope.site_allowed(refs, b.bit if b is not None else None, country)


async def resolve_by_scope(ro: AsyncConnection, p: Principal, scope_project_id: uuid.UUID) -> dict[str, Any]:
    """scope_project_id → 이동 대상(현행 by-scope/[scopeId]/page.tsx: 프로젝트 먼저, 없으면 웹사이트 사이트, 둘 다 없으면 404).
    - 프로젝트 행이 있으면 거기서 끝난다(현행과 같이 사이트로 넘어가지 않는다). 상세와 같은 게이트(admin ∨ 활성 멤버)를 못 넘거나
      standard_root 면 404(현행은 redirect 뒤 상세가 404 였다: 결과 동일, 존재를 흘리지 않는다).
    - 사이트는 website_site_visible 을 넘을 때만 brand·country 를 준다(스코프 밖은 404)."""
    row = await fetch_one(ro, Q.PROJECT_BY_SCOPE, {"spid": scope_project_id})
    if row is not None:
        pid = uuid.UUID(str(row["project_id"]))
        try:
            await project_access(ro, p, pid, "active_member")  # 루트·비가시·비멤버(admin 제외)
        except errors.ApiError as e:
            if e.status in (403, 404):
                # 검증 D1: project_access 의 '프로젝트 없음' 을 그대로 내보내면 미지 id('대상 없음')와 본문이 갈려
                # "로컬 프로젝트로 매핑되는 Scope id 인가" 가 드러난다. 모든 거부를 같은 404 본문으로 접는다.
                raise _by_scope_not_found() from None
            raise
        return {"kind": "project", "project_id": pid}
    site = await fetch_one(ro, Q.SITE_BY_SCOPE, {"spid": scope_project_id})
    if site is None or not website_site_visible(p, await load_refs(ro), site["brand_code"], site["country_code"]):
        raise _by_scope_not_found()
    return {"kind": "website", "brand_code": site["brand_code"], "country_code": site["country_code"]}


def _by_scope_not_found() -> errors.ApiError:
    """by-scope 의 유일한 404 본문(미지 id·standard_root·비멤버 프로젝트·스코프 밖 사이트 전부 같다: 존재 은닉)."""
    return errors.not_found("대상 없음")


# ── 생성 ────────────────────────────────────────────────────────────────────────
def brand_scope_covers_all(p: Principal, refs: Refs) -> bool:
    """계정 브랜드 스코프가 app.brand 전 코드(엄브렐러 포함)를 담는가 = 현행의 "브랜드 스코프 없음"(빈 brands)과 같은 뜻.
    계정 이관 R1(account-migration.md §5)이 현행 빈 brands 계정(scope_all 거짓, 비 vendor)을 ua_scope_nonempty 때문에 전 코드 목록으로
    옮겼다. 현행 관리 화면은 GEO_BRANDS(권역 정본 브랜드 3개)만 고를 수 있어 엄브렐러 HMG 를 담은 목록을 만들 수 없으므로, 전 코드 목록은
    이관이 채운 '무제한' 표식으로 읽는다. 조회 가시성(DataScope)은 이 판정을 쓰지 않는다: 전 코드 목록의 가시성은 이미 무제한과 같다."""
    if not p.scope_brands:
        return False
    codes = {b.code for b in refs.brands}
    return bool(codes) and codes <= set(p.scope_brands)


def creation_options(p: Principal, refs: Refs) -> tuple[list[str], list[str]]:
    """생성 가능 브랜드·국가(현행 projectCreationOptions 이식).
    brands = 계정 브랜드(전체면 RHQ 정본에 등장하는 브랜드). countries = 허용 브랜드별 권역(계정 권역이 있으면 그 브랜드 권역만)
    국가의 합 ∩ 계정 국가(국가 스코프가 있고, 권역 전개가 비지 않았을 때).
    계정 브랜드가 전 코드 목록(brand_scope_covers_all, 이관 R1)이면 현행 빈 brands 분기(scope-policy.ts:288-289 GEO_BRANDS)처럼
    권역 정본 브랜드만 준다(결정 13, 2026-09-30: Hyundai N 을 생성 선택지에 더하지 않는다). 결과는 늘 계정 목록의 부분집합이라 넓히지 않는다."""
    scope = DataScope.of(p, refs)
    rhq_brands = {b for b, _ in refs.rhq.values()}
    # 순서(검증 D2): 계정 브랜드 스코프가 있으면 그 저장 순서(현행 scope.brands 그대로). 전체면 app.brand.sort_order 순
    # (refs.brands 가 sort_order 순, qa 옵션과 같은 DB 표시 순). 현행 GEO_BRANDS(카탈로그 첫 등장 순)는 DB 에 없는 순서라
    # 화면 순서 동일은 어댑터가 front 상수로 재정렬한다(README '선택지 순서', CORE-REQUESTS/bg-projects.md R1).
    geo_brands = [b.code for b in refs.brands if b.code in rhq_brands]
    unrestricted = scope.all or scope.brands is None or brand_scope_covers_all(p, refs)
    brands = geo_brands if unrestricted else [b for b in scope.brands or () if refs.brand(b)]
    regions = [] if scope.all else list(p.scope_regions)
    by_region: set[str] = set()
    for brand in brands:
        brand_rids = [rid for rid, (bc, _) in refs.rhq.items() if bc == brand]
        rids = brand_rids if not regions else [r for r in regions if r in brand_rids]
        by_region.update(refs.region_countries(rids))
    # 순서(검증 D3): 계정 국가 스코프가 있으면 그 저장 순서(현행 scope.countries.filter 그대로, 중복만 첫 등장으로 접는다).
    # 스코프가 없으면 권역 전개 합집합을 코드 순으로 준다. 현행 권역 정의 순(rhq-map.json 삽입 순)은 app.rhq_region·
    # app.rhq_region_country 에 순서 열이 없어 서버가 재현할 수 없다(어댑터 재정렬, CORE-REQUESTS/bg-projects.md R1).
    raw = [] if scope.all else list(dict.fromkeys(c.upper() for c in p.scope_countries))
    countries = sorted(by_region) if not raw else [c for c in raw if not by_region or c in by_region]
    return brands, countries


async def get_creation_options(ro: AsyncConnection, p: Principal) -> dict[str, Any]:
    """생성 폼 선택지(BG-37). 게이트·어휘가 create_project 와 같다: 비생성자 403 operator_forbidden, 브랜드·국가 = creation_options,
    엔진 = engine_vocab(normalize_engines 가 받는 코드), 기본 엔진 = default_engines(현행 DEFAULT_AI_ENGINES) 중 어휘 안 값."""
    await require_operator(ro, p, "create_project")
    refs = await load_refs(ro)
    brands, countries = creation_options(p, refs)
    vocab = engine_vocab(refs)
    dflt = [e for e in await default_engines(ro) if e in vocab]
    locked = not DataScope.of(p, refs).all and len(brands) == 1
    return {"brands": brands, "countries": countries, "engines": vocab, "default_engines": dflt, "brand_locked": locked}


async def create_project(ro: AsyncConnection, rw: AsyncConnection, p: Principal, body: Any) -> dict[str, Any]:
    await require_operator(ro, p, "create_project")
    refs = await load_refs(ro)
    brands, countries = creation_options(p, refs)
    country = body.country_code.strip().upper()
    if country not in countries:
        raise errors.forbidden("선택한 국가에 대한 권한이 없다", code="country_forbidden")
    brand = (body.brand_code or "").strip() or None
    if brand is not None:
        # 실재·비엄브렐러를 먼저 본다(PATCH 와 같은 입력 = 같은 코드, 검증 D9). 권한 밖일 때만 403
        b = refs.brand(brand)
        if b is None or b.is_umbrella:
            raise errors.unprocessable("알 수 없는 브랜드", code="unknown_brand", details={"field": "brand_code"})
        if brand not in brands:
            raise errors.forbidden("선택한 브랜드에 대한 권한이 없다", code="brand_forbidden")
    engines = normalize_engines(body.ai_engines, refs)
    if not engines:
        raise errors.unprocessable("AI 엔진을 1개 이상 선택해야 한다", code="engines_required")
    base_url, domain = seed_domain(body.domain)
    row = await fetch_one(rw, Q.INSERT_PROJECT, {"name": body.name, "description": (body.description or "").strip() or None,
                                                 "domain": domain, "brand": brand, "country": country, "engines": engines,
                                                 "uid": p.user_id})
    assert row is not None
    pid = row["project_id"]
    await rw.execute(_t(Q.INSERT_OWNER), {"pid": pid, "uid": p.user_id})
    if domain:            # 생성 직후 owned base 0개 + domain 만 있는 상태를 막는다(현행 new/_actions.ts:97-104)
        await rw.execute(_t(Q.INSERT_OWNED_BASE), {"pid": pid, "url": base_url, "norm": domain, "uid": p.user_id})
    await rw.execute(_t(Q.INSERT_ENGINE_HISTORY), {"pid": pid, "engines": engines, "uid": p.user_id})
    if brand:
        await rebuild_tracked_brand(rw, pid)
    await enqueue_scope(rw, "project", pid, "create", scope_project_payload(row))
    await enqueue_scope(rw, "schedule", pid, "set_targets", {"project_id": str(pid), "engines": engines, "reenable": False})
    o = _project_out({**row, "my_role": "owner"}, engines)
    o["scope_linked"] = False
    return o


# ── 수정 ────────────────────────────────────────────────────────────────────────
async def patch_project(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, body: Any) -> dict[str, Any]:
    acc, refs = await project_access(ro, p, project_id, "owner")
    given = body.model_fields_set
    if not given:
        raise errors.unprocessable("수정할 필드가 없다", code="empty_patch")
    before = await fetch_one(rw, Q.LOCK_PROJECT, {"pid": project_id})
    if before is None:
        raise errors.not_found("프로젝트 없음")
    sets: list[str] = []
    params: dict[str, Any] = {"pid": project_id}
    if "name" in given:
        name = (body.name or "").strip()
        if not name:
            raise errors.unprocessable("프로젝트 이름은 비울 수 없다", code="name_required", details={"field": "name"})
        sets.append("name = :name")
        params["name"] = name
    if "description" in given:
        sets.append("description = :description")
        params["description"] = (body.description or "").strip() or None
    new_brand = before["brand_code"]
    if "brand_code" in given:
        new_brand = (body.brand_code or "").strip() or None
        if new_brand is not None:
            b = refs.brand(new_brand)
            if b is None or b.is_umbrella:
                raise errors.unprocessable("알 수 없는 브랜드", code="unknown_brand", details={"field": "brand_code"})
            if not DataScope.of(p, refs).brand_allowed(new_brand):
                raise errors.forbidden("브랜드는 본인 권한 안에서만 고를 수 있다", code="brand_forbidden")
        sets.append("brand_code = :brand")
        params["brand"] = new_brand
    if "ga4_property_id" in given:
        raw = (body.ga4_property_id or "").strip()
        if raw and not _GA4.fullmatch(raw):          # 현행 /^\d+$/(ASCII). str.isdigit 는 '١٢'·'²³' 도 통과(검증 D5)
            raise errors.unprocessable("GA4 속성 ID 는 숫자만", code="invalid_ga4_property_id", details={"field": "ga4_property_id"})
        sets.append("ga4_property_id = :ga4")
        params["ga4"] = raw or None
    try:
        row = await fetch_one(rw, Q.update_sql(sets), params)
    except DBAPIError as e:
        if errors.db_error_info(e)[0] == "23503":         # 브랜드 FK(검사 뒤 동시 삭제): 전역 처리기의 constraint_violation 대신 필드 코드
            raise errors.unprocessable("알 수 없는 브랜드", code="unknown_brand", details={"field": "brand_code"}) from e
        raise
    assert row is not None
    if new_brand != before["brand_code"]:
        if before["brand_code"]:
            await rw.execute(_t(Q.DELETE_TRACKED_BRAND), {"pid": project_id, "name": before["brand_code"]})
        await rebuild_tracked_brand(rw, project_id)
    if any(row[k] != before[k] for k in ("name", "description", "brand_code")):
        await enqueue_scope(rw, "project", project_id, "update", scope_project_payload(row))
    o = _project_out({**row, "my_role": acc.member_role}, await default_engines(rw))
    o["scope_linked"] = row["scope_project_id"] is not None
    return o


# ── 삭제 ────────────────────────────────────────────────────────────────────────
async def delete_project(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, confirm_name: str) -> None:
    await project_access(ro, p, project_id, "owner")
    row = await fetch_one(rw, Q.LOCK_PROJECT, {"pid": project_id})
    if row is None:
        raise errors.not_found("프로젝트 없음")
    if confirm_name.strip() != row["name"]:
        raise errors.conflict("name_mismatch", "입력한 이름이 프로젝트 이름과 다르다")
    await rw.execute(_t(Q.DELETE_PROJECT), {"pid": project_id})
    await enqueue_scope(rw, "project", project_id, "delete",
                        {"project_id": str(project_id),
                         "scope_project_id": str(row["scope_project_id"]) if row["scope_project_id"] else None})
    access_audit(p, "data_access", "project.delete", target=str(project_id), detail={"name": row["name"]})


def _t(sql: str) -> Any:
    from sqlalchemy import text
    return text(sql)
