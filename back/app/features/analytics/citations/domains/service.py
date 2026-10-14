"""analytics.citations.domains 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

- 순위: 인용 수 내림차순, 동률은 skey 오름차순. 키셋 커서(generation 고정: 세대가 바뀌면 409 cursor_stale).
- limit=0: 요약·경쟁사 합만(대시보드 경쟁사 행). meta.page.total 은 limit 과 무관하게 q·skey[]·competitor[] 로 좁힌 행 수(검증 D4).
- mention_brand: 표시 브랜드명(rd.dim_brand_name.name, 대소문자 무시 bare 일치). 권한 축이 아니다(모듈-인용 §5).
  모르는 이름은 meta.dropped_filters.mention_brand 에 적고 빈 결과(fail-closed).
- BG-21 q·sort·dir, BG-20 skey[]·competitor[]: 행과 meta.page.total 만 좁힌다. 요약·경쟁사 합·share·coverage 분모는 전체 모집단이다(현행 표가 받은 전
  행을 클라이언트에서 거르고 정렬해도 점유율·커버리지 값이 그대로인 것과 같다). 정렬 동률 = 인용 순위 rank 오름차순.
  share·coverage 정렬은 표시값(반올림 퍼센트) 기준이다(검증 D3, 현행 표가 pctOf 값을 비교).
- 커서 필터 해시: skey[]·competitor[] 는 집합 의미라 sorted(set()) 로 정규화한 뒤 해시한다(순서·중복만 다른 요청 = 같은 커서, 검증 D5).
- BG-20 competitor_sources=true: 유효 카테고리(운영자 오버라이드 반영)가 공식(경쟁사)인 출처 목록(현행 competitorDomainOptions).
  competitor[]: 현행 경쟁사 선택(applyCompetitorPick: 공식(경쟁사) 행 중 고른 것만, 다른 카테고리 유지). rank 는 이 선택 뒤 번호.
- 순위 두 벌: rank = 경쟁사 선택 뒤·검색 전(현행 표준 표 '#'), match_rank = 선택·검색 뒤(현행 웹사이트·프로젝트 표 '#').
- BG-22 내보내기: 목록과 같은 모집단·검색·정렬·선택을 전량(상한 EXPORT_MAX_ROWS) 파일로. 열 = 현행 xlsx 7열(순위·도메인·카테고리·
  인용 수·점유율·프롬프트·커버리지), 점유율·커버리지는 퍼센트 소수 1자리(현행 toFixed(1) 과 같은 반올림: 0.5 올림).
  '#' 열 = rank_basis(기본: global 표면 = rank, website·project = match_rank). max_rows = 정렬 뒤 상위 N(현행 표준 표 = 100).
  파일 7열이 쓰지 않는 경쟁사 합·자사/타겟 인용 FILTER 는 세지 않는다(B011, 행·값은 같다).
- 읽지 않는 계산 끄기(B011, 기본 = 전부 계산): include_den=false 면 커버리지 분모 문장을 생략(summary.answers_den·행 coverage.den = 0,
  sort=coverage 는 정렬 키라 그대로 센다), include_competitor_totals=false 면 경쟁사 합 집계 생략(빈 목록). 두 값은 행·순서와 무관해 커서
  필터 해시에서 뺀다.
- 한 번 조회(B009): mention_brand 가 있으면 limit 을 2,000(MENTION_BRAND_MAX_LIMIT)까지 받는다(언급 드릴다운 인용 탭이 커서 10페이지를
  순차로 읽던 것을 한 요청으로).
- 대시보드 카드(card=true·limit=0)의 competitor_sources 는 상한 없이 전부 싣는다(B012): 카드는 출처를 브랜드로 접어 값을 내므로 상한이
  값의 무음 절단이 된다(현행 = 상한 없음). 잘림 표식은 false. 비카드 요청의 상한·meta.truncated 는 그대로.
"""
from __future__ import annotations

from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import Request
from fastapi.responses import StreamingResponse

from app.core.auth import Principal
from app.core.db import fetch_all, fetch_one
from app.core.envelope import Envelope, Page, build_meta, ratio
from app.core.export import export_response
from app.core.pagination import decode_cursor, filter_hash, keyset_page
from app.core.write import access_audit
from app.features.analytics.citations.domains import queries as q
from app.features.analytics.citations.domains.schemas import (
    COMPETITOR_SOURCES_MAX,
    EXPORT_MAX_ROWS,
    CompetitorSource,
    CompetitorTotal,
    DomainRow,
    DomainsData,
    DomainsExportQuery,
    DomainsListParams,
    DomainsQuery,
    DomainsSummary,
)
from app.features.analytics.citations.domains.shared import CitationRead, open_read

SORT = "citations"
KST = ZoneInfo("Asia/Seoul")      # 파일 이름 날짜(현행 dateStamp = 사용자 로컬 날짜, 주 사용자 기준 KST)
COMPETITOR_SLUG = "officialCompetitor"
# BG-21·BG-20 이전에 없던 목록 파라미터: 기본값이면 커서 필터 해시에서 뺀다(기본 요청의 커서 해시 = 이전과 같다)
_NEW_PARAMS: dict[str, Any] = {"q": None, "sort": "citations", "dir": None, "skey": [], "competitor": [], "competitor_sources": False,
                                "host_fold": False}
_SET_PARAMS = ("skey", "competitor")     # 목록 파라미터 중 집합 의미(커서 해시 정규화 대상, 검증 D5)
_SHAPE_PARAMS = {"include_den", "include_competitor_totals"}   # 응답에서 계산을 끄기만 하는 파라미터(B011): 행·순서와 무관해 해시에서 뺀다

# BG-22 내보내기 열(현행 citations-view.tsx·citations-standard-view.tsx onExport 7열, 열 이름 = front messages answerAnalysis.citations.table.col)
EXPORT_COLUMNS = ("rank", "domain", "category", "citations", "share", "prompts", "coverage")
EXPORT_LABELS = {
    "ko": ("#", "도메인", "카테고리", "인용 수", "점유율", "프롬프트", "커버리지"),
    "en": ("#", "Domain", "Category", "Citations", "Share %", "Prompts", "Coverage Rate"),
}
# 카테고리 표시(front messages citationCategories, slug 키). 목록에 없는 slug 는 카테고리 이름 그대로
CATEGORY_LABELS = {
    "ko": {"officialHmg": "공식 (HMG)", "officialCompetitor": "공식 (경쟁사)", "dealerMarketplace": "딜러·마켓플레이스",
           "automotiveMedia": "자동차 미디어", "newsMedia": "뉴스·미디어", "communityForums": "커뮤니티·포럼", "socialVideo": "소셜·영상",
           "blogsReviews": "블로그·리뷰", "wikiReference": "위키·백과", "governmentPublic": "정부·공공", "awardCertification": "권위(수상·인증)",
           "academicResearch": "학술·연구", "other": "기타"},
    "en": {"officialHmg": "Official (HMG)", "officialCompetitor": "Official (Competitor)", "dealerMarketplace": "Dealer & Marketplace",
           "automotiveMedia": "Automotive Media", "newsMedia": "News & Media", "communityForums": "Community & Forums",
           "socialVideo": "Social & Video", "blogsReviews": "Blogs & Reviews", "wikiReference": "Wiki & Reference",
           "governmentPublic": "Government & Public", "awardCertification": "Award & Certification",
           "academicResearch": "Academic & Research", "other": "Other"},
}


async def resolve_mention_brand(conn: Any, name: str | None) -> tuple[int | None, bool]:
    """(brand_key, 알 수 없음 여부)."""
    if name is None:
        return None, False
    r = await fetch_one(conn, q.BRAND_KEY_SQL, {"n": name.strip()})
    return (int(r["brand_key"]), False) if r else (None, True)


def _empty(summary_den: int = 0, with_competitors: bool = False) -> DomainsData:
    return DomainsData(summary=DomainsSummary(total_citations=0, unique_sources=0, own_share=ratio(0, 0), answers_den=summary_den),
                       items=[], competitor_totals=[], competitor_sources=[] if with_competitors else None)


def _search(params: DomainsListParams) -> str | None:
    return (params.q or "").strip() or None


def _request_hash(params: DomainsQuery, request: Request) -> str:
    """커서 필터 해시: 공통 필터 + 기능 파라미터(cursor·limit 제외, 새 파라미터는 기본값이면 제외) + 커스텀 필드(cf.*)."""
    drop = {"cursor", "limit"} | _SHAPE_PARAMS | {k for k, v in _NEW_PARAMS.items() if getattr(params, k) == v}
    if params.dir == ("asc" if params.sort == "skey" else "desc"):      # 기본 방향을 명시한 요청 = 생략한 요청(같은 커서)
        drop.add("dir")
    custom = {k: sorted(request.query_params.getlist(k)) for k in sorted(request.query_params) if k.startswith("cf.")}
    f = params.model_dump(mode="json", by_alias=True, exclude=drop)
    for k in _SET_PARAMS:              # 집합 의미(SQL 도 sorted(set()) 로 건다): 순서·중복만 다른 요청은 같은 해시
        if k in f:
            f[k] = sorted(set(f[k]))
    return filter_hash({"f": f, "cf": custom})


def _competitor_key(rd: CitationRead) -> int | None:
    return next((k for k, c in rd.categories.items() if c.slug == COMPETITOR_SLUG), None)


async def _scan(conn: Any, rd: CitationRead, params: DomainsListParams, *, limit: int, cursor: Any, spec: q.SortSpec, brand_key: int | None,
                competitors: bool, competitor_cap: int | None = None, with_den: bool = True, competitor_totals: bool = True,
                own_target: bool = True) -> tuple[dict[str, Any], int]:
    """competitor_cap: 경쟁사 출처 상한(None = 상한 없음, 대시보드 카드 B012). with_den·competitor_totals·own_target = 읽지 않는 계산 끄기(B011).
    기본값이 아닌 것만 domains_sql 에 넘긴다(기본 요청의 호출 모양 = 종전)."""
    den = 0
    if with_den:      # 분모를 먼저 센다: coverage 정렬 키(반올림 천분율, 검증 D3)가 분모를 쓴다
        den_q = q.answers_den_sql(rd.ctx, rd.win, mention_brand_key=brand_key)
        den = int((await fetch_one(conn, den_q.text, den_q.params) or {}).get("answers") or 0)
    extra: dict[str, Any] = {}
    if not competitor_totals:
        extra["competitor_totals"] = False
    if not own_target:
        extra["own_target"] = False
    s = q.domains_sql(rd.ctx, rd.win, limit=limit, cursor=cursor, mention_brand_key=brand_key, spec=spec, q=_search(params),
                      skeys=tuple(params.skey), competitor_category_key=_competitor_key(rd),
                      competitor_limit=competitor_cap if competitors else 0, competitor_pick=tuple(params.competitor),
                      answers_den=den, host_fold=params.host_fold, **extra)
    rows = await fetch_all(conn, s.text, s.params)
    return rows[0], den


async def get_domains(conn: Any, principal: Principal, params: DomainsQuery, request: Request) -> Envelope[DomainsData]:
    limit, cursor, mention_brand = params.limit, params.cursor, params.mention_brand
    spec = q.sort_spec(params.sort, params.dir)
    rd = await open_read(conn, principal, params, request)
    fh = _request_hash(params, request)
    cur = decode_cursor(cursor, sort=spec.cursor_sort, dir=spec.dir, fh=fh, types=spec.types, generation=rd.win.generation) if limit > 0 else None
    brand_key, unknown = await resolve_mention_brand(conn, mention_brand)
    meta_extra: dict[str, list[str]] = {"mention_brand": [mention_brand]} if unknown and mention_brand is not None else {}
    page = Page(next_cursor=None, limit=limit, total=0)
    if rd.empty or unknown:
        return _envelope(rd, _empty(with_competitors=params.competitor_sources), page, meta_extra,
                         {"competitor_sources": False} if params.competitor_sources else None)

    # 대시보드 카드(card=true·limit=0)는 경쟁사 출처를 브랜드로 접어 값을 낸다: 상한 없이 전부(B012). 그 밖은 상한 + 잘림 표식
    cap = None if (params.card and limit == 0) else COMPETITOR_SOURCES_MAX
    r0, den = await _scan(conn, rd, params, limit=limit, cursor=cur, spec=spec, brand_key=brand_key, competitors=params.competitor_sources,
                          competitor_cap=cap, with_den=params.include_den or params.sort == "coverage",
                          competitor_totals=params.include_competitor_totals)
    summ = r0["summary"] or {}
    total, own, n_sources = int(summ.get("citations") or 0), int(summ.get("own") or 0), int(summ.get("sources") or 0)
    items_raw: list[dict[str, Any]] = list(r0["rows"] or [])
    page_rows, nxt = keyset_page(items_raw, limit, spec.key, sort=spec.cursor_sort, dir=spec.dir, fh=fh,
                                 generation=rd.win.generation) if limit > 0 else ([], None)
    items = [_row(rd, r, total, den) for r in page_rows]
    comp = None
    truncated: dict[str, bool] | None = None
    if params.competitor_sources:              # 쿼리는 상한 + 1 행까지 싣는다(넘친 1행 = 잘림, core 9 U7-2)
        raw_comp = list(r0["competitor_sources"] or [])
        truncated = {"competitor_sources": cap is not None and len(raw_comp) > cap}
        comp = [CompetitorSource(skey=x["skey"], domain=x["domain"], brand=x.get("brand"), citations=int(x["citations"]))
                for x in (raw_comp if cap is None else raw_comp[:cap])]
    data = DomainsData(
        summary=DomainsSummary(total_citations=total, unique_sources=n_sources, own_share=ratio(own, total), answers_den=den),
        items=items,
        competitor_totals=[CompetitorTotal(brand=x["brand"], citations=int(x["citations"]), sources=int(x["sources"]))
                           for x in (r0["competitors"] or [])],
        competitor_sources=comp)
    matched = int(r0["matched"] or 0)          # 검증 D4: limit=0 이어도 q·skey[]·competitor[] 로 좁힌 행 수
    return _envelope(rd, data, Page(next_cursor=nxt, limit=limit, total=matched), meta_extra, truncated)


def _row(rd: CitationRead, r: dict[str, Any], total: int, den: int) -> DomainRow:
    cit, own = int(r["citations"]), int(r["own_citations"])
    return DomainRow(skey=r["skey"], domain=r["domain"], is_social=bool(r["is_social"]), category=rd.category(r["category_key"]),
                     citations=cit, share=ratio(cit, total), citing_answers=int(r["citing_answers"]),
                     coverage=ratio(int(r["citing_answers"]), den), own_citations=own, is_own=own > 0,
                     is_target=int(r["target_citations"]) > 0, competitor_brand=r.get("competitor_brand"),
                     citing_prompts=int(r["citing_prompts"]), rank=int(r["rank"]), match_rank=int(r["match_rank"]))


def _envelope(rd: CitationRead, data: DomainsData, page: Page, dropped_extra: dict[str, list[str]],
              truncated: dict[str, bool] | None = None) -> Envelope[DomainsData]:
    meta = build_meta(mode=rd.win.mode, ctx=rd.ctx, window=rd.win, suppressed=rd.suppressed, page=page, truncated=truncated)
    meta.dropped_filters.update(dropped_extra)
    return Envelope[DomainsData](data=data, meta=meta)


# ════════════════════════════════════════════════════════════════════════════
# BG-22 내보내기
# ════════════════════════════════════════════════════════════════════════════
def pct1(num: int, den: int) -> float:
    """퍼센트 소수 1자리(분모 0 이면 0: 현행 표 pctOf 규칙). 반올림은 0.5 올림(현행 Math.round(n/d*1000)/10)."""
    if den <= 0:
        return 0.0
    return float((Decimal(num) * 100 / Decimal(den)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def rank_basis(params: DomainsExportQuery) -> str:
    """'#' 열 기준: 명시값, 아니면 표면별 현행 규칙(global = 표준 표 검색 전 번호, website·project = citations-view 검색 뒤 번호)."""
    return params.rank_basis or ("global" if params.surface == "global" else "match")


def export_rows(rd: CitationRead, raw: list[dict[str, Any]], total: int, den: int, locale: str, basis: str = "global") -> list[dict[str, Any]]:
    labels = CATEGORY_LABELS[locale]
    rank_col = "rank" if basis == "global" else "match_rank"
    out = []
    for r in raw:
        cat = rd.category(r["category_key"])
        out.append({"rank": int(r[rank_col]), "domain": r["skey"], "category": (labels.get(cat.slug, cat.name) if cat else ""),
                    "citations": int(r["citations"]), "share": pct1(int(r["citations"]), total), "prompts": int(r["citing_prompts"]),
                    "coverage": pct1(int(r["citing_answers"]), den)})
    return out


async def export_domains(conn: Any, principal: Principal, params: DomainsExportQuery, request: Request) -> StreamingResponse:
    spec = q.sort_spec(params.sort, params.dir)
    rd = await open_read(conn, principal, params, request)
    brand_key, unknown = await resolve_mention_brand(conn, params.mention_brand)
    rows: list[dict[str, Any]] = []
    truncated = False
    if not (rd.empty or unknown):
        cap = min(params.max_rows or EXPORT_MAX_ROWS, EXPORT_MAX_ROWS)
        # 파일 7열(순위·도메인·카테고리·인용 수·점유율·프롬프트·커버리지)이 쓰지 않는 경쟁사 합·자사/타겟 FILTER 는 세지 않는다(B011)
        r0, den = await _scan(conn, rd, params, limit=cap, cursor=None, spec=spec, brand_key=brand_key, competitors=False,
                              competitor_totals=False, own_target=False)
        raw = list(r0["rows"] or [])
        # X-Export-Truncated 는 서버 상한으로 잘렸을 때만(요청한 max_rows 로 자른 것은 요청대로다)
        truncated = len(raw) > cap and (params.max_rows is None or params.max_rows >= EXPORT_MAX_ROWS)
        rows = export_rows(rd, raw[:cap], int((r0["summary"] or {}).get("citations") or 0), den, params.locale, rank_basis(params))
    fh = filter_hash({"f": params.model_dump(mode="json", by_alias=True),
                      "cf": {k: sorted(request.query_params.getlist(k)) for k in sorted(request.query_params) if k.startswith("cf.")}})
    access_audit(principal, "download", "citations.domains.export", target=params.surface,
                 detail={"format": params.format, "rows": len(rows), "truncated": truncated, "rank_basis": rank_basis(params), "fh": fh})
    return export_response(params.format, EXPORT_COLUMNS, rows, basename=f"citation-sources-{datetime.now(KST):%Y%m%d}", truncated=truncated,
                           labels=EXPORT_LABELS[params.locale], sheet="citation-sources")
