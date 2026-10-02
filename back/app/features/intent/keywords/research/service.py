"""intent.keywords.research 업무 규칙: term+country 기반 키워드 조회(외부 호출 없음, 수집된 rd.kw_* 만).

권한(모듈-고객-관심 §5, Q13)
- project_id 가 있으면 메뉴 project + core.auth.resolve_project(member): 없음·비가시 404, 국가 기본값 = 프로젝트 국가.
  국가가 프로젝트 국가·추적 키워드 국가 밖이면 표준 화면 규칙을 적용한다(검증 D5).
- 없으면 표준 화면: 메뉴 standard + 표준 열람 역할(hq·region·country·admin) + country 가 계정 국가 스코프 안(DataScope).
  밖이면 403(메뉴 menu_forbidden, 역할 role_forbidden, 국가 country_forbidden, 검증 D3).
신선도: insight = 검색량·SERP 최신 관측 중 오래된 쪽 기준 24시간, 한쪽만 있으면 stale.
        related·lookup = 최신 연관어 호출의 rd.kw_suggestion.observed_at(DB-v2.6 P43) 기준 7일(related·search TTL).
        lookup 은 term 마다 판정하고 meta 는 찾은 term 중 가장 나쁜 값(하나라도 stale 이면 stale, 찾은 term 이 없으면 missing).
표준 키워드 목록(BG-41): 표준 화면 키워드 탭 원천. 표준 열람자(표면 게이트 global) 읽기 전용, 브랜드 스코프(공통 NULL 포함).
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import auth, errors
from app.core.auth import Principal
from app.core.codes import Refs, load_refs
from app.core.db import fetch_all
from app.core.filters import SAFE_TEXT
from app.core.kw import Preset, db_term_norms, preset_by_id, preset_of
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page
from app.features.intent.keywords.research import queries as q
from app.features.intent.keywords.research.intent_common import Freshness, freshness, require_standard_country
from app.features.intent.keywords.research.schemas import (
    Insight,
    Lookup,
    LookupRow,
    Related,
    RelatedItem,
    SerpRow,
    StandardKeyword,
    StandardKeywordList,
    TermObserved,
    TrendPoint,
)

MAX_SERP_ROWS = 8          # 현행 lib/keyword/insight.ts:52 (적재 depth 10, 표시 8)
MAX_RELATED = 30
MAX_STANDARD_KEYWORDS = 500    # 표준 키워드 목록 한 페이지 상한(기본 limit). 넘치면 meta.page.next_cursor 로 이어 받는다(수정 라운드 검증 D2)
_STD_KW_SORT = "created_at_desc_keyword_id_asc"   # 커서 정렬 표식(키 = created_at, keyword_id)
_BRAND_VALUE = re.compile(SAFE_TEXT)


async def project_tracked(conn: AsyncConnection, acc: auth.ProjectAccess) -> list[tuple[str, Preset]]:
    """프로젝트 추적 키워드 (term_norm = DB 생성 열(app.term_norm), 유효 국가 프리셋). 프리셋을 모르는 국가 행은 뺀다."""
    rows = await fetch_all(conn, q.PROJECT_TRACKED, {"pid": acc.project_id})
    out = []
    for r in rows:
        pr = preset_by_id(r["country_code"] or acc.country_code)
        if pr is not None:
            out.append((r["term_norm"], pr))
    return out


async def project_countries(conn: AsyncConnection, acc: auth.ProjectAccess) -> set[str]:
    """프로젝트에 묶인 국가 = 프로젝트 국가 ∪ 추적 키워드 국가(프리셋 id)."""
    own = preset_by_id(acc.country_code)
    return ({own.id} if own else set()) | {pr.id for _, pr in await project_tracked(conn, acc)}


async def resolve_access(conn: AsyncConnection, p: Principal, project_id: uuid.UUID | None, country: str | None,
                         refs: Refs | None = None) -> tuple[Preset, auth.ProjectAccess | None]:
    """project_id 있음 = 메뉴 project + resolve_project(member). 국가가 그 프로젝트에 묶이지 않으면(프로젝트 국가·추적 키워드 국가 밖)
    표준 화면 규칙을 그대로 적용한다(검증 D5: 프로젝트 id 를 붙여 표준 화면 국가 스코프를 우회하지 못하게).
    project_id 없음 = 표준 화면(메뉴 standard + 표준 열람 역할 + 국가 스코프, 검증 D3)."""
    refs = refs or await load_refs(conn)
    if project_id is not None:
        auth.require_surface(p, "project")          # 역할 천장 PROJECT_VIEWERS + 메뉴 project(검증 m-7)
        acc = await auth.resolve_project(conn, p, refs, project_id, "member")
        preset = preset_of(country if country else acc.country_code)
        if preset.id not in await project_countries(conn, acc):
            require_standard_country(p, refs, preset)
        return preset, acc
    auth.check_menu_group(p, "standard")
    preset = preset_of(country)
    require_standard_country(p, refs, preset)
    return preset, None


async def kw_keys(conn: AsyncConnection, norms: list[str]) -> dict[str, int]:
    if not norms:
        return {}
    rows = await fetch_all(conn, q.KW_KEYS, {"norms": norms})
    return {r["term_norm"]: int(r["kw_key"]) for r in rows}


async def insight(conn: AsyncConnection, term: str, preset: Preset, limit: int) -> tuple[Insight, datetime | None, str]:
    """(응답, 관측 시각, 신선도)."""
    norm = (await db_term_norms(conn, [term]))[term]
    keys = await kw_keys(conn, [norm])
    base = Insight(term=term, country=preset.id, location_code=preset.location_code, language_code=preset.language_code,
                   trend=[], serp_call_id=None, serp=[])
    kw = keys.get(norm)
    if kw is None:
        return base, None, "missing"
    prm = {"kw": kw, "loc": preset.location_code, "lang": preset.language_code}
    trend_rows = await fetch_all(conn, q.TREND, prm)
    serp_rows = await fetch_all(conn, q.SERP_LATEST, {**prm, "limit": limit})
    base.trend = [TrendPoint(month=r["month"], search_volume=r["search_volume"], competition_index=r["competition_index"],
                             cpc=float(r["cpc"]) if r["cpc"] is not None else None) for r in reversed(trend_rows)]
    base.serp = [SerpRow(rank=r["rank"], url=r["url"], domain=r["domain"], title=r["title"], snippet=r["snippet"],
                         suggested_prompt=r["prompt"], draft_model=r["model"], draft_gen=r["gen"]) for r in serp_rows]
    base.serp_call_id = int(serp_rows[0]["call_id"]) if serp_rows else None
    vol_at = max((r["observed_at"] for r in trend_rows), default=None)
    serp_at = max((r["observed_at"] for r in serp_rows), default=None)
    parts = [t for t in (vol_at, serp_at) if t is not None]
    if not parts:
        return base, None, "missing"
    observed = min(parts)
    fr = freshness(observed, "insight") if len(parts) == 2 else "stale"
    return base, max(parts), fr


def _items(rows: list[dict[str, Any]]) -> list[RelatedItem]:
    return [RelatedItem(term=r["term"], search_volume=r["search_volume"], intent=r["intent"]) for r in rows if not r["is_seed"]]


def _latest_at(rows: list[dict[str, Any]]) -> datetime | None:
    return max((r["observed_at"] for r in rows), default=None)


def _total(rows: list[dict[str, Any]]) -> int | None:
    """호출 단위 total_count(행마다 같은 값, DB-v2.9 P62). 값이 없던 호출은 None."""
    return next((int(r["total_count"]) for r in rows if r.get("total_count") is not None), None)


async def related(conn: AsyncConnection, term: str, preset: Preset) -> tuple[Related, datetime | None, Freshness]:
    """(응답, 최신 연관어 호출 관측 시각, 신선도 related 7일)."""
    norm = (await db_term_norms(conn, [term]))[term]
    kw = (await kw_keys(conn, [norm])).get(norm)
    rows = [] if kw is None else await fetch_all(conn, q.SUGGEST_LATEST,
                                                   {"kw": kw, "loc": preset.location_code, "lang": preset.language_code})
    items = _items(rows)[:MAX_RELATED]
    observed = _latest_at(rows)
    return (Related(term=term, country=preset.id, found_count=len(items), total_count=_total(rows), items=items), observed,
            freshness(observed, "related"))


async def lookup(conn: AsyncConnection, terms: list[str], preset: Preset) -> tuple[Lookup, datetime | None, Freshness, int]:
    """(응답, 찾은 term 중 최신 관측 시각, 종합 신선도, stale term 수). term 별 신선도 = 최신 연관어 호출 observed_at 기준 search 7일."""
    nm = await db_term_norms(conn, terms)                  # 정규화 정본 = DB app.term_norm(검증 m-5)
    norms = [nm[t] for t in terms]
    keys = await kw_keys(conn, sorted(set(norms)))
    out: list[LookupRow] = []
    seen: list[Freshness] = []
    latest: datetime | None = None
    for t, n in zip(terms, norms, strict=True):
        kw = keys.get(n)
        rows = [] if kw is None else await fetch_all(conn, q.SUGGEST_LATEST,
                                                       {"kw": kw, "loc": preset.location_code, "lang": preset.language_code})
        if not rows:
            out.append(LookupRow(term=t, status="missing", search_volume=None, intent=None, related=[]))
            continue
        at = _latest_at(rows)
        seen.append(freshness(at, "search"))
        latest = at if latest is None or (at is not None and at > latest) else latest
        seed = next((r for r in rows if r["is_seed"]), None)
        out.append(LookupRow(term=t, status="found", search_volume=seed["search_volume"] if seed else None,
                             intent=seed["intent"] if seed else None, related=_items(rows)[:MAX_RELATED], total_count=_total(rows)))
    stale = sum(1 for f in seen if f != "fresh")
    overall: Freshness = "missing" if not seen else ("stale" if stale else "fresh")
    return Lookup(country=preset.id, items=out), latest, overall, stale


async def observed_by_term(conn: AsyncConnection, norms: list[str], preset: Preset) -> dict[str, TermObserved]:
    """fetches 신선도 판정용 term_norm → 관측 시각."""
    if not norms:
        return {}
    rows = await fetch_all(conn, q.LATEST_OBSERVED, {"norms": norms, "loc": preset.location_code, "lang": preset.language_code})
    return {r["term_norm"]: TermObserved(**r) for r in rows}


async def standard_keywords(conn: AsyncConnection, p: Principal, source_type: str, brands: list[str],
                            cursor: str | None = None, limit: int | None = None
                            ) -> tuple[StandardKeywordList, int, dict[str, list[str]], str | None, int]:
    """표준 열람자용 표준 키워드 목록(BG-41, customer-interest/google-keywords 키워드 탭 원천).
    반환 = (응답, 필터 전체 행 수, dropped, 다음 커서, 적용 limit).

    권한: 표준 화면 게이트(역할 hq·region·country·admin + 메뉴 standard, core.auth.require_surface 'global'). 쓰기는 admin 경로 그대로.
    스코프: brand_code NULL(공통)은 모든 계정에 보인다(DataScope.brand_allowed, scope-policy isInScope D5). 그 밖은 계정 스코프 브랜드 안.
    brand(공통 필터 축): 볼 수 있는 브랜드로 좁힌다(그 브랜드 + 공통). 알 수 없는·스코프 밖 값은 meta.dropped_filters.brand,
    남는 값이 없으면 스코프 전체(core.filters 관점 브랜드 규칙과 같다). 국가 축은 원천에 국가가 없어 지원하지 않는다(ignored).
    term 합치기(수정 라운드 검증 D4): 가시 행을 app.term_norm(term) 으로 묶어 한 항목(대표 keyword_id + keyword_ids + brand_codes)으로 준다.
    total·limit·커서 단위는 행이 아니라 항목(묶음)이다."""
    auth.require_surface(p, "global")
    for v in brands:
        if not (1 <= len(v) <= 100 and _BRAND_VALUE.match(v)):
            raise errors.unprocessable("brand 값 형식 오류", details={"field": "brand"})
    refs = await load_refs(conn)
    scope = auth.DataScope.of(p, refs)
    visible = {b.code for b in refs.brands if scope.brand_allowed(b.code)}
    keep: list[str] = []
    dropped: dict[str, list[str]] = {}
    for c in dict.fromkeys(brands):
        if c in visible:
            keep.append(c)
        else:
            dropped.setdefault("brand", []).append(c)
    lim = clamp_limit(limit, MAX_STANDARD_KEYWORDS)
    if lim > MAX_STANDARD_KEYWORDS:
        raise errors.unprocessable(f"limit 은 1~{MAX_STANDARD_KEYWORDS}", details={"field": "limit"})
    # 커서 필터 해시 = 결과 집합을 정하는 입력(source_type, 좁히기 브랜드). 스코프는 SQL 이 매 요청 다시 건다.
    fh = filter_hash({"source_type": source_type, "narrow": sorted(keep)})
    cur = decode_cursor(cursor, sort=_STD_KW_SORT, dir="desc", fh=fh, types=("timestamptz", "uuid"))
    rows = await fetch_keyset(conn, q.STANDARD_KEYWORDS, {
        "source_type": source_type, "scope_all": scope.brands is None, "scope_brands": sorted(scope.brands or ()),
        "narrow": sorted(keep) or None, "limit": lim + 1,
        "c_at": cur.key[0] if cur else None, "c_id": cur.key[1] if cur else None}, cursor=cur)
    total = int(rows[0]["total"]) if rows else 0
    rows = [r for r in rows if r["keyword_id"] is not None]        # 커서 뒤가 빈 페이지면 total 만 담은 한 행(LEFT JOIN LATERAL)
    page, nxt = keyset_page(rows, lim, lambda r: (r["created_at"], r["keyword_id"]), sort=_STD_KW_SORT, dir="desc", fh=fh)
    items = [StandardKeyword(keyword_id=r["keyword_id"], keyword_ids=list(r["keyword_ids"]), term=r["term"], source_type=r["source_type"],
                             brand_codes=list(r["brand_codes"]), created_at=r["created_at"], updated_at=r["updated_at"]) for r in page]
    return StandardKeywordList(source_type=source_type, items=items), total, dropped, nxt, lim
