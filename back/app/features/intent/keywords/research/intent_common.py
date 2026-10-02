"""고객 관심(intent) 기능 공용 도우미: 신선도·meta 조립·표준 화면 권한.

이 파일은 intent 7개 기능(keywords.tracked·research·fetches·serp_drafts, candidates.submit, social.context_map·prompts)이
함께 쓰는 기능 전용 도우미만 둔다. 기능 경로 밖에 공용 파일을 둘 수 없어 research 아래 두었다.
term_norm·국가 프리셋·검색어 정리는 core.kw(적재기와 한 벌), 공통 필터 무시 기록은 core.filters.ignored_axes(core.envelope.crud_meta),
메뉴·역할 판정은 core.auth.check_menu_group·check_role 이 정본이다.

- 신선도: 현행 TTL(lib/keyword/cache.ts:41-44) insight 24시간, related·search 7일. fresh|stale|missing(관측 시각 = rd.kw_*.observed_at).
- 공통 필터: intent 는 공통 필터 축을 하나도 지원하지 않는다(FilterSupport 빈 선언). 들어오면 meta.ignored_filters 에 적는다.
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from starlette.requests import Request

from app.core import errors
from app.core.auth import SURFACE_ROLES, DataScope, Principal, check_menu_group, check_role
from app.core.codes import Refs
from app.core.envelope import Meta, Mode, Page, crud_meta
from app.core.filters import FilterSupport
from app.core.kw import Preset

KST = ZoneInfo("Asia/Seoul")

# intent 전 엔드포인트: 공통 필터 축 미지원(모듈-고객-관심 §1 "공통 필터 모델의 축은 전부 지원하지 않는다")
INTENT_SUPPORT = FilterSupport.of()

FreshKind = Literal["insight", "related", "search"]
Freshness = Literal["fresh", "stale", "missing"]
FRESHNESS_TTL: dict[str, timedelta] = {"insight": timedelta(hours=24), "related": timedelta(days=7), "search": timedelta(days=7)}
TTL_LABEL: dict[str, str] = {"insight": "24h", "related": "7d", "search": "7d"}


def freshness(observed_at: datetime | None, kind: FreshKind, *, now: datetime | None = None) -> Freshness:
    if observed_at is None:
        return "missing"
    t = now or datetime.now(UTC)
    return "fresh" if t - observed_at <= FRESHNESS_TTL[kind] else "stale"


def as_of_date(ts: datetime | None) -> date | None:
    return ts.astimezone(KST).date() if ts is not None else None


def intent_meta(request: Request, *, mode: Mode, consumed: Iterable[str] = (), as_of: date | None = None,
                source: dict[str, Any] | None = None, suppressed: dict[str, str] | None = None, page: Page | None = None) -> Meta:
    """intent 응답 meta: surface·cycles·generation 없음(측정 표면 개념 없음), 확장 정보는 meta.source 에 싣는다.
    ignored_filters 는 core.envelope.crud_meta(core.filters.ignored_axes)가 계산한다. consumed = 이 엔드포인트가 자기 파라미터로 쓰는
    이름(예: research 의 country 는 공통 필터가 아니라 단일 국가 파라미터, project_id 는 프로젝트 화면 키)."""
    m = crud_meta(request.query_params, mode=mode, page=page, source=source, support=INTENT_SUPPORT, consumed=tuple(consumed))
    m.as_of = as_of
    if suppressed:
        m.suppressed.update(suppressed)
    return m


# ── 권한: project_id 없는 표준 화면 키워드 열람·운영(모듈-고객-관심 §5) ──
STANDARD_VIEWERS = SURFACE_ROLES["global"]     # 현행 lib/auth/route-policy.ts:28 STANDARD_VIEWERS(hq·region·country·admin)


def require_standard_country(p: Principal, refs: Refs, preset: Preset) -> None:
    """표준 화면(project_id 없음) 키워드 열람: 메뉴 standard + 표준 열람 역할 + 국가가 계정 국가 스코프 안(DataScope, default-deny).
    research·fetches·serp_drafts 는 project_id 유무로 표준 화면·프로젝트 화면이 갈려 라우터 dependencies 로 걸 수 없어
    핸들러 안에서 조건부로 건다(현행 route-policy.ts:55-56 STANDARD_VIEWERS × group 'standard' 짝)."""
    check_menu_group(p, "standard")
    check_role(p, *STANDARD_VIEWERS)
    if not DataScope.of(p, refs).country_allowed(preset.id.upper()):
        raise errors.forbidden("국가 스코프 밖", code="country_forbidden")


def require_global_operator(p: Principal, refs: Refs, preset: Preset | None) -> None:
    """project_id 없는(또는 프로젝트에 묶이지 않은) 유료·생성 액션: 메뉴 standard + admin 또는 전역 운영자만
    (canOperateProject 에 프로젝트가 없을 때의 규칙), 국가는 스코프 안."""
    check_menu_group(p, "standard")
    if not (p.is_admin or p.operator == "global"):
        raise errors.forbidden("프로젝트 없는 운영 액션은 admin·전역 운영자만", code="operator_forbidden")
    if preset is not None and not DataScope.of(p, refs).country_allowed(preset.id.upper()):
        raise errors.forbidden("국가 스코프 밖", code="country_forbidden")
