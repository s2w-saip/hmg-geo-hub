"""analytics.geo.markets 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(GEO-1 명세 metrics_rules·query_design, 결정 Q8, QUERY-FIXES §3)
- 범위(Q8 현행 유지): 표면 global·website 만(project 는 422 surface_not_supported). 웹사이트는 언급 수 지표만.
- 지원 축(BG-01·BG-02 보강): global = brand·country·lang·engine·period + 택소노미 6축, website = brand·country·lang·engine·period.
  권역 트리는 관점 브랜드가 하나일 때만(brand[] 단일 선택 또는 스코프 단일 브랜드), 아니면 markets=[].
- 화면 게이트(현행 lib/auth/scope-policy.ts showsGeoMap = core.auth.shows_geo_map): scope_all 이거나 역할 admin·hq·region.
  표면 경로 게이트(역할 천장 + menu_groups)는 core.filters.resolve_read_context 가 건다.
- 창: 기간 미지정 = 함대 스냅샷(Q1, core.cycles.resolve_window), 기간 지정 = D1 누적.
- 당사 값(M01~M05)은 core.measure.fetch_counts(group_by=geo): rd.answer 당사 열(G-03), M05 는 답변 인용 수 열(G-25). M05 분자 =
  출처 카테고리 Official (HMG) 인용 수(cit_m05 = Σ cit_off, 동기화 S1 BE-4 = hmg-geo #321 feddea7: Overview GEO 국가별 ⑤ 도 카드와 같은 분자).
  카드와 같은 빌더라 국가 합 = 카드(D6).
- 웹사이트(언급 수 지표만, B094): 사실 집계를 점유율이 쓰는 열로 좁힌다. fetch_counts part 'sov'(답변 수·당사 언급·전체 언급)와
  brand_rows(mentions_only=True)(경쟁 행 언급 수)만 읽고 노출·감성·순위 열은 계산하지 않는다(meta.suppressed website_mentions_only 와 같은
  범위). 남는 열은 'mentions'·기본 경쟁 행과 같은 식이라 응답이 같다.
- 경쟁사는 core.measure.brand_rows(group_by=geo, hmg_siblings=False)(competitive ∧ std_in ∧ own_bit = 0): 권한 밖 형제 HMG 브랜드는
  경쟁사 목록·순위에 없고 분모(시장 전체 언급 ment_total)에는 남는다(브랜드 격리, 현행 marketStats 계승).
- 국가 표시명(명세 GeoCountryRow.country_name)은 싣지 않는다(DECISIONS-API GEO-1): rd.dim_country 에 표시명 열이 없고, 현행도 표시명을
  프론트 정적 카탈로그(lib/geo-catalog geoLocateByCode, 로케일 의존)에서 붙인다. 프론트 유지 원칙대로 code 만 싣는다.
  최대 경쟁사 = {brand, metrics}(현행 marketStats 모양, 명세 {brand, share_of_voice} 와의 차이는 DECISIONS-API GEO-1 에 기록).
- 권역 값은 소속 국가 원시값을 합산한 뒤 다시 계산한다(P3). 국가는 관점 브랜드의 RHQ 권역(app.rhq_region·rhq_region_country)에
  속한 ISO 코드만(가상·유사 코드는 권역이 없어 빠진다). pending = 관점 브랜드 권역 중 측정 국가가 없는 권역.
- 명부 제외(동기화 S1 BE-5, 현행 hmg-geo 2670a16 excluded-brands.ts markExcludedGeo·dashboard/_data/live.ts:140 marketStats·
  overview-metrics.ts:44 marketMetrics, 키 = core.entities): 제외 키 경쟁 행은 경쟁사 집계(rivals)에 넣지 않는다 → 순위(our)·순위 모수
  (field_size)·최대 경쟁사(top_rival)에서 빠지고 다음 경쟁사가 최대 경쟁사가 된다. 분모(시장 전체 언급 total_mentions·답변 수)는
  rd.answer 원천이라 그대로다(현행 total = 제외 행 포함 전 브랜드 합).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Any

from app.core import errors
from app.core.auth import Principal, shows_geo_map
from app.core.db import fetch_all
from app.core.entities import excluded_brand_keys
from app.core.envelope import SUPPRESS_HIDDEN, SUPPRESS_NO_SNAPSHOT, Envelope, RankAvg, Ratio, build_meta
from app.core.filters import TAXONOMY_AXES, CommonFilters, FilterSupport, ReadContext, resolve_read_context
from app.core.measure import brand_rows, fetch_counts, frozen_brand_names, rank_brand_items, ratios

from . import queries as q
from .schemas import GeoCountryRow, GeoData, GeoMetrics, GeoOwnBrand, GeoRank, GeoRegionRow, GeoRival

GEO_SURFACES = ("global", "website")
# BG-01·BG-02: 글로벌에 lang[](답변 언어 축, 글로벌 M05 는 언어로 좁힌 자사 허용 배열이면 core 원소 스캔)과 택소노미 6축
# (rd.catalog_entry 로 푼 prompt_keys 를 core 빌더가 사실 표 prompt_key 술어로 건다, KPI_SUPPORT 와 같은 해석)을 더한다.
GEO_SUPPORT = FilterSupport.of(global_=("brand", "country", "lang", "engine", "period", *TAXONOMY_AXES),
                               website=("brand", "country", "lang", "engine", "period"))
COUNT_COLS = ("answers", "tracked", "own_mentions", "total_mentions", "sent_pos", "sent_all", "rank_sum", "ranked",
              "cit_total", "cit_owned", "cit_m05")      # cit_m05 = M05 분자(글로벌 = 공식(HMG) 카테고리, core.measure.ratios 가 읽는다)
BRAND_COLS = ("mentions", "exposure_answers", "rank_sum", "ranked", "s_pos", "s_neu", "s_neg", "s_mix")
MENTION_ONLY_SUPPRESSED = ("visibility", "sentiment", "position", "citation_share")


def own_label(ctx: ReadContext) -> str:
    """BG-48: GET /v1/mentions/brands own.vp_label·/v1/trend own_label 과 같은 규칙. 관점 하나 = brand_code, 여럿 = 엄브렐러 brand_code."""
    if len(ctx.own_brands) == 1:
        return ctx.own_brands[0]
    return ctx.refs.brand_code_of_bit(ctx.refs.umbrella_bit) or "+".join(ctx.own_brands)


def geo_gate(p: Principal) -> None:
    """시장 지도 화면 게이트(core.auth.shows_geo_map: scope_all ∨ admin·hq·region). 표면 경로 게이트는 core resolve_read_context."""
    if not shows_geo_map(p):
        raise errors.forbidden("역할 권한 없음", code="role_forbidden")


# ════════════════════════════════════════════════════════════════════════════
# 지표 조립(순수 함수)
# ════════════════════════════════════════════════════════════════════════════
def _ratio(pair: tuple[int, int] | None) -> Ratio | None:
    if not pair or not pair[1]:
        return None
    return Ratio(num=int(pair[0]), den=int(pair[1]))


def own_metrics(c: dict[str, int], website: bool) -> GeoMetrics:
    r = ratios(c)
    if website:
        return GeoMetrics(share_of_voice=_ratio(r.get("share_of_voice")))
    pos = r.get("position")
    return GeoMetrics(visibility=_ratio(r.get("visibility")), share_of_voice=_ratio(r.get("share_of_voice")),
                      sentiment=_ratio(r.get("sentiment")),
                      position=RankAvg(sum=int(pos[0]), count=int(pos[1])) if pos and pos[1] else None,
                      citation_share=_ratio(r.get("citation_share")))


def rival_metrics(b: dict[str, int], c: dict[str, int], website: bool) -> GeoMetrics:
    sov = _ratio((b["mentions"], c["total_mentions"]))
    if website:
        return GeoMetrics(share_of_voice=sov)
    s_all = b["s_pos"] + b["s_neu"] + b["s_neg"] + b["s_mix"]                  # A3: mixed 분모 포함·긍정 제외
    return GeoMetrics(visibility=_ratio((b["exposure_answers"], c["answers"])), share_of_voice=sov,
                      sentiment=_ratio((b["s_pos"], s_all)),
                      position=RankAvg(sum=b["rank_sum"], count=b["ranked"]) if b["ranked"] else None)


def market_row(c: dict[str, int], rivals: dict[str, dict[str, int]], active: str, website: bool) -> dict[str, Any]:
    """국가·권역 공통: 당사 값 + 순위 + 선두 자사 브랜드 + 최대 경쟁사. rivals = 경쟁사명 → 합산 브랜드 값."""
    present = [{"name": n, "mentions": v["mentions"]} for n, v in rivals.items() if v["mentions"] > 0]
    ranked = rank_brand_items(present)
    own_m = c["own_mentions"]
    top = ranked[0]["name"] if ranked else None
    return {
        "answers": c["answers"],
        "own": own_metrics(c, website),
        "rank": GeoRank(our=1 + sum(1 for x in present if x["mentions"] > own_m), field_size=1 + len(present)),
        "top_own_brand": GeoOwnBrand(brand=active, share_of_voice=_ratio((own_m, c["total_mentions"]))) if own_m > 0 else None,
        "top_rival": GeoRival(brand=top, metrics=rival_metrics(rivals[top], c, website)) if top else None,
    }


def _sov_key(own: GeoMetrics) -> float:
    s = own.share_of_voice
    return s.num / s.den if s is not None and s.den else -1.0


# ════════════════════════════════════════════════════════════════════════════
# 진입점
# ════════════════════════════════════════════════════════════════════════════
async def get_geo(conn: Any, principal: Principal, filters: CommonFilters, *, today: date | None = None) -> Envelope[GeoData]:
    if filters.surface not in GEO_SURFACES:
        raise errors.unprocessable("국가별 현황은 global·website 표면만(Q8: 프로젝트 표면 제외)", code="surface_not_supported",
                                   details={"field": "surface"})
    geo_gate(principal)
    ctx = await resolve_read_context(conn, principal, filters, support=GEO_SUPPORT)
    ctx, win = await ctx.card_window(conn, route="geo", today=today)              # 동결 판정(S4)
    website = ctx.surface == "website"
    label = own_label(ctx)
    active = ctx.own_brands[0] if len(ctx.own_brands) == 1 else None
    suppressed: dict[str, str] = {k: "website_mentions_only" for k in MENTION_ONLY_SUPPRESSED} if website else {}

    def done(markets: list[GeoRegionRow], pending: list[str]) -> Envelope[GeoData]:
        meta = build_meta(mode=win.mode, window=win, ctx=ctx, suppressed=suppressed)   # 글로벌 project_id 는 core 가 ignored 로 싣는다
        return Envelope[GeoData](data=GeoData(active_brand=active, own_label=label, markets=markets, pending=pending), meta=meta)

    if win.empty:
        suppressed["*"] = SUPPRESS_NO_SNAPSHOT
        return done([], [])
    if active is None:                       # Q8: 권역 뷰는 관점 브랜드 하나 필수(현행 activeBrandFor, 결정 C5 계승)
        suppressed["markets"] = "brand_required"
        return done([], [])
    if win.hidden("mentions"):
        for k in ("visibility", "share_of_voice", "sentiment", "position"):
            suppressed[k] = SUPPRESS_HIDDEN
    if not website and win.hidden("citations"):
        suppressed["citation_share"] = SUPPRESS_HIDDEN

    # ── 사실 집계(core 빌더) ──
    ms = ctx.measure()
    # B094: 웹사이트는 점유율·순위·최대 경쟁사 점유율만 그린다 → 당사 'sov' 3열·경쟁 행 언급 수만(없는 열은 0 으로 읽고 쓰지 않는다)
    counts = await fetch_counts(conn, ms, win, group_by=("geo",), parts=("sov",) if website else ("mentions", "citations"))
    comp = await brand_rows(conn, ms, win, group_by=("geo",), hmg_siblings=False,    # HMG 브랜드(형제 포함)는 경쟁사가 아니다
                            mentions_only=website)
    excluded = await excluded_brand_keys(conn) if comp else frozenset()
    comp = [r for r in comp if int(r["brand_key"]) not in excluded]                # 명부 제외: 순위·모수·최대 경쟁사에서만 빠진다
    keys = sorted({int(r["brand_key"]) for r in comp if int(r["brand_key"]) != 0})
    names = {int(r["brand_key"]): r for r in await fetch_all(conn, q.BRAND_NAMES_SQL, {"keys": keys})} if keys else {}
    for k, nm in (await frozen_brand_names(conn, ms, win, list(names))).items():   # 동결 읽기: 생성 시점 표시명(S4, 이름으로 묶기 전)
        names[k] = {**names[k], "name": nm}

    # ── 권역(관점 브랜드의 RHQ) ──
    labels = {r["region_id"]: r["label"] for r in await fetch_all(conn, q.REGION_LABELS_SQL, {"brand": active})}
    regions = [rid for rid, (b, _) in ctx.refs.rhq.items() if b == active]
    region_of: dict[str, str] = {}
    for rid in regions:
        for cc in ctx.refs.rhq[rid][1]:
            region_of.setdefault(cc.upper(), rid)

    # ── 국가 행 ──
    rivals_by_geo: dict[int, dict[str, dict[str, int]]] = defaultdict(dict)
    for r in comp:
        n = names.get(int(r["brand_key"]))
        if n is None:                                    # 이름 없음(0)
            continue
        # 개명 브랜드(동결 읽기, 회차마다 세대 이름이 다른 키)는 core.measure.brand_rows 가 세대 이름별 행으로 나눠 준다(frz_name, S4b)
        cur = rivals_by_geo[int(r["geo_key"])].setdefault(r.get("frz_name") or n["name"], dict.fromkeys(BRAND_COLS, 0))
        for k in BRAND_COLS:
            cur[k] += int(r.get(k) or 0)

    region_counts: dict[str, dict[str, int]] = {}
    region_rivals: dict[str, dict[str, dict[str, int]]] = defaultdict(dict)
    region_countries: dict[str, list[GeoCountryRow]] = defaultdict(list)
    for row in counts:
        if row.get("geo_key") is None or int(row.get("answers") or 0) == 0:
            continue
        ref = ctx.refs.country_by_key(int(row["geo_key"]))
        if ref is None or ref.kind != "iso":
            continue
        rid = region_of.get(ref.code.upper())
        if rid is None:                                  # 관점 브랜드 권역 밖 코드는 표시하지 않는다(현행 buildGeo)
            continue
        c = {k: int(row.get(k) or 0) for k in COUNT_COLS}
        rv = rivals_by_geo.get(int(row["geo_key"]), {})
        region_countries[rid].append(GeoCountryRow(code=ref.code, **market_row(c, rv, active, website)))
        acc = region_counts.setdefault(rid, dict.fromkeys(COUNT_COLS, 0))
        for k in COUNT_COLS:
            acc[k] += c[k]
        for name, v in rv.items():
            cur = region_rivals[rid].setdefault(name, dict.fromkeys(BRAND_COLS, 0))
            for k in BRAND_COLS:
                cur[k] += v[k]

    markets: list[GeoRegionRow] = []
    pending: list[str] = []
    for rid in regions:
        if rid not in region_counts:
            pending.append(rid)
            continue
        cs = sorted(region_countries[rid], key=lambda x: (-_sov_key(x.own), x.code))
        markets.append(GeoRegionRow(region_id=rid, region_label=labels.get(rid, rid), country_count=len(cs), countries=cs,
                                    **market_row(region_counts[rid], region_rivals[rid], active, website)))
    markets.sort(key=lambda m: (-_sov_key(m.own), m.region_id))
    return done(markets, pending)
