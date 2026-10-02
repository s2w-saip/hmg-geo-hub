"""analytics.funnel.conversion 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(모듈-AI-퍼널 §2.2·§5, FU-2, DECISIONS-API Q12)
- 원천 = 적재된 GA4 보고서 원본 그레인 rd.ga4_row 만(실시간 GA4 호출 없음). Scope 측정과 조인하지 않는다.
- 시장 카탈로그 = 코드 상수(MARKET_CATALOG, 현행 property-map.ts MAP 의 레거시 시장) ∪ app.ga4_property(brand·country 있는 행). app.ga4_market 신설 없음(Q12).
  시장 = (브랜드, 국가). 스코프 게이트: 관점 브랜드(계정 브랜드 스코프 ∩ brand[]) × 유효 국가(계정 국가 스코프 ∩ country[]).
  스코프 밖 시장은 coverage 에도 나오지 않는다.
- 실데이터 = rd.ga4_dim_property 중 출처 registry·env 이고 status = active 인 속성(브랜드 비트·국가 키로 시장에 매칭). 나머지 시장은
  coverage 에만(A12). project_override 출처는 프로젝트 자체 속성이라 global·website 에서 읽지 않는다.
  시장당 속성 하나: active 우선, 같은 상태면 prop_key 가 작은 것(레지스트리 행은 property_id 순). 물리 순서와 무관하다.
  상태 = 적재 투영(rd) 이 있으면 그 값, 없으면 레지스트리(app) 값, 둘 다 없으면 unmapped.
- 빈 결과의 억제: 스코프 안 시장이 있는데 요청 필터가 다 걸러냈으면 억제 없는 빈 집합, 그 밖(스코프 안 active 없음)은 source_pending.
- 날짜 = GA4 보고서 날짜(속성 시간대). from/to 가 없으면 to = 최신 적재일(report 1), from = to - 89.
- engine[] = AI 유입 sessionSource 엔진(rd.dim_engine 코드 공간). 비면 전 AI 엔진. AI 코호트만 좁힌다.
- device[]·visitor_type[] = 두 코호트 공통(rd.ga4_dim_value device·nvr). 적재 차원에 없는 값은 dropped 이고 결과는 빈 집합.
- 분모 = 세션(G-12 a, activeUsers → sessions 정의 변경). 비율은 Ratio(정수 쌍)만, lift 는 프론트가 두 Ratio 로 계산한다.
- 표면: global·website 같은 원천(속성은 브랜드 × 국가 단위). website 의 가상 지역 코드(HYUNDAI-N 등)는 core 가 사이트 브랜드 비트로 풀어
  ctx.virtual_brand_bits 에 싣고, 시장도 그 비트의 브랜드로 좁힌다.
- project 표면(BG-28, 현행 projects/[id]/ai-funnel/conversion/page.tsx:52-55): 시장 = 프로젝트 (브랜드, 국가) 하나. 속성 = 프로젝트 직접
  지정(app.project.ga4_property_id) 우선, 없으면 그 시장의 레지스트리·env 속성(global 과 같은 선택 규칙). 브랜드 없는(엄브렐러) 프로젝트는
  직접 지정이 없으면 unmapped. 게이트 = 활성 멤버 ∨ admin(현행 auth-and-locks.ts:34-35 notFound).
  직접 지정은 '프로젝트 몫' 속성일 때만 쓴다(검증 D1, 현행과 다름): 적재 투영·레지스트리 행이 다른 시장에 귀속돼 있으면(브랜드·국가 불일치,
  또는 레지스트리·env 출처인데 시장 미귀속) 읽지 않고 unmapped(property_id 없음)로 낸다. 그래야 Owner 가 설정만으로 다른 시장 GA4 수치를
  읽거나 그 시장 추적 이벤트(전역 판정)를 바꾸지 못한다. 귀속 없는 행(적재 전, project_override 출처 미귀속, 레지스트리 brand·country 없음)은
  프로젝트 몫으로 본다.
  직접 지정 속성이 active 로 적재되기 전이면 상태와 무관하게 pending_grant(현행은 속성 id 가 있으면 대기 안내를 띄운다, 검증 D2).
  property_source=market 이면 직접 지정을 건너뛰고 시장 속성만 쓴다(프로젝트 대시보드 ⑦ live.ts:219-231 용, 검증 D3).
- 상대 창 days(BG-30): 최신 적재일 기준 N일(7·28·90). from/to 와 배타. 둘 다 없으면 90.
- 엔진 비교 by_engine_all(BG-31): engine[] 을 적용하지 않은 엔진별 분해(기기·방문자 유형·시장·기간은 적용). by_engine 의미는 그대로.
- 전환 이벤트 비관리자 경로(BG-29, 현행 lib/ga4/tracked-events-actions.ts:67-93 authorize 이식):
  표면 경로 게이트(require_surface) → 속성 소속 검증. 프로젝트 맥락 = 활성 멤버 ∧ 속성 = 그 프로젝트가 해석하는 속성(IDOR), 쓰기 = 활성 Owner.
  프로젝트가 해석하는 속성은 위 '프로젝트 몫' 규칙을 거친 것이라, 다른 시장 속성을 직접 지정해도 비관리자는 404(검증 D1).
  레지스트리 상태 unmapped 시장의 속성은 소속 집합에 없다(현행 resolveProperties 는 상태를 보지 않는다: 의도된 축소, 검증 D4 known_diff).
  비프로젝트 맥락 = 속성 ∈ 계정 스코프 시장이 해석하는 속성, 쓰기 = 역할 country·region·hq. admin 은 알려진 속성(레지스트리·적재 투영) 전부.
  소속 밖은 404(IDOR 은폐), 보이지만 편집 권한 없음은 403. 목록·교체 본체는 admin.integrations.ga4 service(같은 규칙·같은 재판정 큐).
- 사용자 수(users_window, BG-32)는 내지 않는다: 창 사용자 수는 행 합산으로 만들 수 없고(G-12) 창 합계 적재 원천이 없다(CORE-REQUESTS/bg-funnel.md).
- 표면 경로 게이트(역할 천장 + menu_groups)는 core.filters.resolve_read_context 가 건다.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from app.core import errors
from app.core.auth import DataScope, Principal
from app.core.codes import Refs
from app.core.db import fetch_all, fetch_one, get_db
from app.core.envelope import Envelope, Meta, build_meta, ratio
from app.core.filters import CommonFilters, FilterSupport, ReadContext, resolve_read_context
from app.features.admin.integrations.ga4 import service as ga4_service
from app.features.admin.integrations.ga4.schemas import EventsPut
from app.features.analytics.funnel.conversion import queries as q
from app.features.analytics.funnel.conversion.schemas import (
    AiSummary,
    CohortSessions,
    ConversionData,
    ConversionEventItem,
    ConversionEventsData,
    ConversionEventsParams,
    ConversionEventsWritten,
    ConversionParams,
    CountryRow,
    Coverage,
    EngineRow,
    HumanSummary,
    Market,
    PageRow,
    Period,
    Summary,
    TrendPoint,
)

# 표면별 지원 축. 카탈로그 축·lang·source 는 GA4 차원이 없어 ignored 로 드러낸다. project 는 브랜드가 프로젝트로 고정(brand ignored).
SUPPORT = FilterSupport.of(
    global_=("brand", "country", "engine", "period"),
    website=("brand", "country", "engine", "period"),
    project=("country", "engine", "period"),
)
EVENTS_SUPPORT = FilterSupport()          # 전환 이벤트 경로: 공통 필터 축 없음(표면·프로젝트만 쓴다)
WRITE_ROLES = frozenset({"country", "region", "hq"})   # 비프로젝트 맥락 편집 역할(현행 tracked-events-actions.ts:30, admin 은 별도)
# 레거시 시장 카탈로그(현행 lib/ga4/property-map.ts MAP). 레지스트리에 property_id 가 없는 시장도 커버리지 분모에 넣기 위한 코드 상수(Q12).
MARKET_CATALOG: tuple[tuple[str, str], ...] = (("Kia", "IT"),)
DEFAULT_DAYS = 90
_STATUS_ORDER = {"active": 0, "pending_grant": 1, "unmapped": 2}
_WITH_PROPERTY = frozenset({"active", "pending_grant"})     # coverage.markets[].property_id 를 싣는 상태(BG-29)


def _pick(rows: list[dict[str, Any]], key: Any) -> dict[str, Any] | None:
    """한 시장 후보 중 하나: 상태 우선순위(active 먼저) → key 오름차순. 입력 순서와 무관하다(검증 D2)."""
    return min(rows, key=lambda r: (_STATUS_ORDER.get(r["status"], 9), key(r)), default=None)


def _markets(refs: Refs, registry: list[dict[str, Any]], props: list[dict[str, Any]], *, brands: set[str],
             bits: set[int] | None, countries: tuple[str, ...] | None) -> list[dict[str, Any]]:
    """(브랜드, 국가) 시장 목록(순수 함수). brands·bits·countries 는 허용 집합(None = 제약 없음).

    시장당 속성 하나: 적재 투영(레지스트리·env 출처) 후보 중 active 우선, 같은 상태면 prop_key 가 작은 것.
    한 시장에 active 속성이 둘 이상이면 합치지 않고 하나만 쓴다(같은 사이트의 옛·새 속성 이중 계상 방지, 현행은
    ga4_properties_brand_country_idx 로 시장당 1행). 적재 투영이 없으면 레지스트리 행 중 같은 우선순위로 상태를 고른다."""
    reg: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for r in registry:
        reg.setdefault((r["brand_code"], r["country_code"].upper()), []).append(r)
    out = []
    for brand, country in sorted(set(MARKET_CATALOG) | set(reg)):
        b = refs.brand(brand)
        if b is None or brand not in brands or (bits is not None and b.bit not in bits):
            continue
        if countries is not None and country not in countries:
            continue
        gk = refs.geo_key(country)
        cands = [p for p in props if gk is not None and int(p["brand_bit"]) == b.bit and int(p["geo_key"]) == gk]
        rd = _pick(cands, lambda p: int(p["prop_key"]))
        rg = _pick(reg.get((brand, country), []), lambda r: r["property_id"])
        status = rd["status"] if rd else (rg["status"] if rg else "unmapped")
        pid = (rd.get("property_id") if rd else rg["property_id"] if rg else None) if status in _WITH_PROPERTY else None
        out.append({"brand": brand, "country": country, "status": status,
                    "prop_key": int(rd["prop_key"]) if rd and rd["status"] == "active" else None, "property_id": pid})
    return out


def account_scope(ctx: ReadContext) -> DataScope:
    """GA4 시장의 계정 스코프 = 계정 원값(DataScope.of: Q10 국가·계정 브랜드), 표면 값(for_surface)이 아니다. 현행 lib/ga4/property-map.ts
    resolveProperties·tracked-events-actions.ts scopePropertyIds 는 계정 scope.countries·scope.brands 를 쓰고 hmg-geo #326·#328 은 이 경로를
    바꾸지 않았다(동기화 S1 검증 F1: 전용 사이트 계정의 글로벌 시장 US·KR 이나 website 사이트 국가 KR·worldwide 로 GA4 시장을 열지 않는다)."""
    return DataScope.of(ctx.principal, ctx.refs)


def _meet(a: tuple[str, ...] | None, b: tuple[str, ...] | None) -> tuple[str, ...] | None:
    """국가 허용 집합의 교집합(None = 제약 없음)."""
    if a is None:
        return b
    if b is None:
        return a
    keep = {c.upper() for c in b}
    return tuple(c for c in a if c.upper() in keep)


def resolve_markets(ctx: ReadContext, registry: list[dict[str, Any]], props: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """스코프 ∩ 요청 안 시장 목록. 각 시장 = {brand, country, status, prop_key(active 만)}.
    국가 = 요청 국가(스코프 검사를 거친 ctx.countries) ∩ 계정 원값 국가(account_scope), 요청이 없으면 계정 원값 국가(현행 resolveProperties
    pickSet(geography, scope.countries)). 브랜드 = 관점 브랜드 ∩ 계정 브랜드(website 사이트 브랜드 확장 'Hyundai N' 은 GA4 시장을 열지 않는다:
    현행은 계정 scope.brands). 표면 스코프(전용 사이트 계정의 글로벌 시장, website 사이트 국가)로 넓히지 않는다.

    website 표면의 요청 가상 지역 코드(예: HYUNDAI-N)는 core 가 국가가 아니라 사이트 브랜드 비트로 푼다(ReadContext.virtual_brand_bits).
    GA4 시장도 같은 비트로 좁힌다(검증 D1). 가상 코드가 없으면 None(관점 브랜드 brands 로만 좁힌다)."""
    acct = account_scope(ctx)
    bits = set(ctx.virtual_brand_bits) if ctx.surface == "website" and ctx.virtual_brand_bits else None
    brands = {b for b in ctx.own_brands if acct.brands is None or b in acct.brands}
    countries = acct.countries if ctx.geo_from_scope else _meet(ctx.countries, acct.countries)
    return _markets(ctx.refs, registry, props, brands=brands, bits=bits, countries=countries)


def scope_markets(ctx: ReadContext, registry: list[dict[str, Any]], props: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """요청 필터 없이 계정 스코프만으로 본 시장 목록(계정 원값: account_scope). 빈 결과가 '원천 준비 중' 인지 '필터가 다 걸러냄' 인지
    가르고(검증 D4), 비프로젝트 전환 이벤트 인가(authorize_events: 현행 scopePropertyIds)의 속성 소속 집합이다."""
    scope = account_scope(ctx)
    brands = {b.code for b in ctx.refs.real_brands} if scope.brands is None else set(scope.brands)
    return _markets(ctx.refs, registry, props, brands=brands, bits=None, countries=scope.countries)


def _override_owned(rd: dict[str, Any] | None, rg: dict[str, Any] | None, *, brand: str | None, bit: int | None,
                    gk: int | None, country: str) -> bool:
    """직접 지정 속성이 프로젝트 몫인지(검증 D1). 적재 투영(rd)·레지스트리(rg) 중 시장에 귀속된 행이 하나라도 프로젝트 시장과 다르면 아니다.

    - rd: brand_bit·geo_key 가 있으면 프로젝트 (브랜드 비트, 국가 키)와 같아야 한다. 없으면(시장 미귀속) project_override 출처만 허용
      (레지스트리·env 출처의 미귀속 적재 행은 출처 사이트를 알 수 없다).
    - rg: brand_code·country_code 가 있으면 프로젝트 (브랜드, 국가)와 같아야 한다. 둘 다 없는 행(매핑 전 레지스트리)은 허용.
    - 둘 다 없음(적재 전·레지스트리 밖) = 프로젝트 몫(대기)."""
    if rd is not None:
        rb, rk = rd.get("brand_bit"), rd.get("geo_key")
        if (rb is not None and int(rb) != bit) or (rk is not None and int(rk) != gk):
            return False
        if (rb is None or rk is None) and rd.get("source") != "project_override":
            return False
    if rg is not None:
        cb, cc = rg.get("brand_code"), rg.get("country_code")
        if (cb is not None and cb != brand) or (cc is not None and cc.upper() != country):
            return False
    return True


async def project_markets(conn: Any, ctx: ReadContext, registry: list[dict[str, Any]], props: list[dict[str, Any]], *,
                          apply_country: bool = True, use_override: bool = True) -> list[dict[str, Any]]:
    """project 표면 시장(BG-28): 프로젝트 (브랜드, 국가) 하나. 직접 지정 속성 우선(프로젝트 몫일 때만, 검증 D1), 없으면 시장 속성
    (global 과 같은 선택 규칙). apply_country=True 면 요청 국가 축(ctx.countries)이 프로젝트 국가를 빼면 빈 목록(억제 없는 빈 집합).
    use_override=False 면 직접 지정을 건너뛴다(property_source=market, 대시보드 ⑦, 검증 D3)."""
    pa = ctx.project
    if pa is None:
        return []
    refs = ctx.refs
    country = pa.country_code.upper()
    if apply_country and ctx.countries is not None and country not in ctx.countries:
        return []
    label = pa.brand_code or refs.brand_code_of_bit(refs.umbrella_bit) or "HMG"
    pj = q.project_property_sql(pa.project_id)
    row = await fetch_one(conn, pj.text, pj.params)
    override = row["ga4_property_id"] if row and use_override else None
    if override:
        dq, gq = q.props_by_id_sql([override]), q.registry_by_id_sql([override])
        rd = _pick(await fetch_all(conn, dq.text, dq.params), lambda p: int(p["prop_key"]))
        rg = next(iter(await fetch_all(conn, gq.text, gq.params)), None)
        own = refs.brand(label)
        if not _override_owned(rd, rg, brand=label, bit=own.bit if own else None, gk=refs.geo_key(country), country=country):
            # 다른 시장 속성 지정: 읽지 않는다(라벨과 다른 시장 수치 차단). 이벤트 경로도 property_id 가 없어 비관리자는 404.
            return [{"brand": label, "country": country, "status": "unmapped", "prop_key": None, "property_id": None}]
        # 직접 지정했으면 active 적재 전까지 상태와 무관하게 대기(현행 page.tsx:89-100 속성 id 있음 = 대기 안내, 검증 D2)
        status = "active" if rd and rd["status"] == "active" else "pending_grant"
        return [{"brand": label, "country": country, "status": status,
                 "prop_key": int(rd["prop_key"]) if status == "active" else None, "property_id": override}]
    if pa.brand_code:
        found = _markets(refs, registry, props, brands={pa.brand_code}, bits=None, countries=(country,))
        if found:
            return found[:1]
    return [{"brand": label, "country": country, "status": "unmapped", "prop_key": None, "property_id": None}]


def _engine_code(ctx: ReadContext, key: int) -> str:
    if key == 0:
        return "other"
    for code, (k, _) in ctx.refs.engines.items():
        if k == key:
            return code
    return "other"


def _empty(period: Period, coverage: Coverage) -> ConversionData:
    z = ratio(0, 0)
    return ConversionData(period=period, summary=Summary(ai=AiSummary(sessions=0, conversions=0, page_views=0, conv=z),
                                                         human=HumanSummary(sessions=0, conversions=0, conv=z)),
                          trend=[], by_engine=[], pages=[], by_country=None, coverage=coverage)


async def _dim_keys(conn: Any, params: ConversionParams, dropped: dict[str, list[str]]) -> tuple[tuple[int, ...] | None, tuple[int, ...] | None]:
    """device·visitor_type 값 → rd.ga4_dim_value 키. 없는 값은 dropped, 축을 줬는데 남는 키가 없으면 빈 집합(fail-closed)."""
    want = [("device", v) for v in params.device] + [("nvr", v) for v in params.visitor_type]
    if not want:
        return None, None
    dq = q.dim_values_sql([k for k, _ in want], [v for _, v in want])
    have = {(r["kind"], r["value"]): int(r["value_key"]) for r in await fetch_all(conn, dq.text, dq.params)}
    out: dict[str, tuple[int, ...] | None] = {"device": None, "nvr": None}
    for kind, name, vals in (("device", "device", params.device), ("nvr", "visitor_type", params.visitor_type)):
        if not vals:
            continue
        ks = []
        for v in vals:
            k = have.get((kind, v))
            if k is None:
                dropped.setdefault(name, []).append(v)
            else:
                ks.append(k)
        out[kind] = tuple(sorted(set(ks)))
    return out["device"], out["nvr"]


async def build(conn: Any, ctx: ReadContext, params: ConversionParams) -> Envelope[ConversionData]:
    dropped: dict[str, list[str]] = {}

    def meta(as_of: date | None = None, **suppressed: str) -> Meta:
        m = build_meta(mode="cumulative", surface=ctx.surface, ctx=ctx, suppressed=suppressed or None)
        m.as_of = as_of
        for k, v in dropped.items():
            m.dropped_filters.setdefault(k, []).extend(v)
        return m

    registry, props = await _registry_and_props(conn)
    if ctx.surface == "project":
        markets = await project_markets(conn, ctx, registry, props, use_override=params.property_source != "market")
    else:
        markets = resolve_markets(ctx, registry, props)
    active = sorted({m["prop_key"] for m in markets if m["prop_key"] is not None})
    as_of: dict[int, date] = {}
    if active:
        aq = q.as_of_sql(active)
        as_of = {int(r["prop_key"]): r["as_of"] for r in await fetch_all(conn, aq.text, aq.params)}
    coverage = Coverage(measured_markets=len(active), total_markets=len(markets),
                        markets=[Market(brand=m["brand"], country=m["country"], status=m["status"],
                                        as_of=as_of.get(m["prop_key"]) if m["prop_key"] is not None else None,
                                        property_id=m.get("property_id"))
                                 for m in sorted(markets, key=lambda m: (_STATUS_ORDER.get(m["status"], 9), m["brand"], m["country"]))])
    latest = max(as_of.values()) if as_of else None
    if ctx.date_from is not None and ctx.date_to is not None:
        lo, hi = ctx.date_from, ctx.date_to
        shown_as_of = min(latest, hi) if latest else None
    elif latest is not None:
        days = params.days or DEFAULT_DAYS                                     # BG-30: 최신 적재일 기준 상대 창
        lo, hi, shown_as_of = latest - timedelta(days=days - 1), latest, latest
    else:
        lo = hi = shown_as_of = None
    period = Period(from_=lo, to=hi)
    if not active:
        # 원천 준비 중 = 스코프 안 시장이 있는데 active 가 없거나, 스코프 안에 시장이 아예 없음.
        # 스코프 안 시장은 있는데 요청 필터(국가 전부 dropped·가상 지역 코드 등)가 다 걸러낸 경우는 빈 집합일 뿐 억제가 아니다(검증 D4).
        # project 표면 시장은 늘 하나라, 비었다면 국가 축이 프로젝트 국가를 거른 것뿐이다(억제 아님).
        filtered_out = not markets and (ctx.surface == "project" or bool(scope_markets(ctx, registry, props)))
        return Envelope(data=_empty(period, coverage), meta=meta() if filtered_out else meta(**{"*": "source_pending"}))
    if lo is None or hi is None:
        return Envelope(data=_empty(period, coverage), meta=meta())

    dev, nvr = await _dim_keys(conn, params, dropped)
    ek = ctx.engine_keys
    args = {"engine_keys": ek, "device_keys": dev, "nvr_keys": nvr}

    sq = q.sessions_sql(active, lo, hi, **args)
    cq = q.conversions_sql(active, lo, hi, **args)
    pq = q.pages_sql(active, lo, hi, **args, limit=params.page_limit)
    srows = await fetch_all(conn, sq.text, sq.params)
    crows = await fetch_all(conn, cq.text, cq.params)
    prows = await fetch_all(conn, pq.text, pq.params)

    # (코호트, 묶음 종류, 키) → 값. 코호트 ai = report 2 / is_ai, human = report 1 / NOT is_ai
    sess: dict[tuple[str, int, Any], int] = {}
    pv = 0
    for r in srows:
        cohort = "ai" if int(r["report"]) == 2 else "human"
        g = int(r["g"])
        key = {3: r["date"], 5: r["prop_key"], 6: r["engine_key"], 7: None}[g]
        sess[(cohort, g, key)] = int(r["sessions"])
        if cohort == "ai" and g == 7:
            pv = int(r["page_views"])
    conv: dict[tuple[str, int, Any], int] = {}
    for r in crows:
        cohort = "ai" if r["is_ai"] else "human"
        g = int(r["g"])
        key = {3: r["date"], 5: r["prop_key"], 6: r["engine_key"], 7: None}[g]
        conv[(cohort, g, key)] = int(r["conv"])

    def s(c: str, g: int, k: Any) -> int:
        return sess.get((c, g, k), 0)

    def cv(c: str, g: int, k: Any) -> int:
        return conv.get((c, g, k), 0)

    summary = Summary(
        ai=AiSummary(sessions=s("ai", 7, None), conversions=cv("ai", 7, None), page_views=pv,
                     conv=ratio(cv("ai", 7, None), s("ai", 7, None))),
        human=HumanSummary(sessions=s("human", 7, None), conversions=cv("human", 7, None),
                           conv=ratio(cv("human", 7, None), s("human", 7, None))))
    dates = sorted({k for (_, g, k) in list(sess) + list(conv) if g == 3})
    trend = [TrendPoint(date=d, ai_sessions=s("ai", 3, d), ai_conversions=cv("ai", 3, d), human_sessions=s("human", 3, d),
                        human_conversions=cv("human", 3, d)) for d in dates]
    engine_keys = sorted({int(k) for (c, g, k) in list(sess) + list(conv) if c == "ai" and g == 6})
    by_engine = sorted((EngineRow(engine=_engine_code(ctx, k), sessions=s("ai", 6, k), conversions=cv("ai", 6, k),
                                  conv=ratio(cv("ai", 6, k), s("ai", 6, k))) for k in engine_keys),
                       key=lambda e: (-e.sessions, -e.conversions, e.engine))
    pages = [PageRow(url=r["url"], ai_sessions=int(r["ai_sessions"]), ai_conversions=int(r["ai_conversions"]),
                     human_sessions=int(r["human_sessions"]), human_conversions=int(r["human_conversions"])) for r in prows]
    by_country = None
    if len(active) >= 2:
        by_country = [CountryRow(brand=m["brand"], country=m["country"],
                                 ai=CohortSessions(sessions=s("ai", 5, m["prop_key"]), conversions=cv("ai", 5, m["prop_key"])),
                                 human=CohortSessions(sessions=s("human", 5, m["prop_key"]), conversions=cv("human", 5, m["prop_key"])))
                      for m in markets if m["prop_key"] is not None]
    # BG-31: 엔진 비교(engine[] 무시). 축이 없으면 by_engine 과 같은 값이라 추가 문장 없이 복사한다.
    if ek is None:
        by_engine_all = [e.model_copy() for e in by_engine]
    else:
        eq = q.engine_sessions_sql(active, lo, hi, device_keys=dev, nvr_keys=nvr)
        fq = q.engine_conversions_sql(active, lo, hi, device_keys=dev, nvr_keys=nvr)
        es = {int(r["engine_key"]): int(r["sessions"]) for r in await fetch_all(conn, eq.text, eq.params)}
        ec = {int(r["engine_key"]): int(r["conv"]) for r in await fetch_all(conn, fq.text, fq.params)}
        by_engine_all = sorted((EngineRow(engine=_engine_code(ctx, k), sessions=es.get(k, 0), conversions=ec.get(k, 0),
                                          conv=ratio(ec.get(k, 0), es.get(k, 0))) for k in sorted(set(es) | set(ec))),
                               key=lambda e: (-e.sessions, -e.conversions, e.engine))
    data = ConversionData(period=period, summary=summary, trend=trend, by_engine=by_engine, pages=pages, by_country=by_country,
                          coverage=coverage, by_engine_all=by_engine_all)
    return Envelope(data=data, meta=meta(shown_as_of))


async def _registry_and_props(conn: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    mq, pq = q.markets_sql(), q.props_sql()
    return await fetch_all(conn, mq.text, mq.params), await fetch_all(conn, pq.text, pq.params)


# ════════════════════════════════════════════════════════════════════════════
# 전환 이벤트 비관리자 경로(BG-29): GET·PUT /v1/funnel/conversion/events
# ════════════════════════════════════════════════════════════════════════════
async def authorize_events(conn: Any, user: Principal, params: ConversionEventsParams) -> tuple[ReadContext, bool, bool]:
    """표면 게이트 → 속성 소속 검증. 반환 = (ctx, can_edit, registered). 소속 밖·모르는 속성은 404, 편집 판정은 호출자가 쓴다.

    현행 authorize(tracked-events-actions.ts:78-93) 와 같은 규칙에 표면 경로 게이트(require_surface: resolve_read_context 첫 줄)를 더했다.
    프로젝트 맥락은 활성 멤버만(비멤버 스코프 열람 불가: 현행 projectPropertyId memberActive)."""
    f = CommonFilters(surface=params.effective_surface, project_id=params.project_id)   # type: ignore[call-arg]
    ctx = await resolve_read_context(conn, user, f, support=EVENTS_SUPPORT, project_level="active_member")
    pid = params.property_id
    registry, props = await _registry_and_props(conn)
    gq = q.registry_by_id_sql([pid])
    registered = bool(await fetch_all(conn, gq.text, gq.params))
    if ctx.surface == "project":
        ms = await project_markets(conn, ctx, registry, props, apply_country=False)
        target = ms[0]["property_id"] if ms else None
        allowed = target == pid
        can_edit = user.is_admin or (ctx.project is not None and ctx.project.member_role == "owner")
    else:
        allowed = pid in {m["property_id"] for m in scope_markets(ctx, registry, props) if m.get("property_id")}
        can_edit = user.is_admin or user.role in WRITE_ROLES
    if user.is_admin and not allowed:
        # admin 은 맥락과 무관하게 알려진 속성(레지스트리 ∨ 적재 투영)이면 연다(현행 authorize: admin 무조건 허용)
        dq = q.props_by_id_sql([pid])
        allowed = registered or bool(await fetch_all(conn, dq.text, dq.params))
    if not allowed:
        raise errors.not_found("GA4 속성 없음")
    return ctx, can_edit, registered


async def list_events(conn: Any, user: Principal, params: ConversionEventsParams) -> ConversionEventsData:
    _, can_edit, registered = await authorize_events(conn, user, params)
    d = await ga4_service.load_events(conn, params.property_id)
    return ConversionEventsData(property_id=d.property_id, window_from=d.window_from, window_to=d.window_to, loaded=d.loaded,
                                conv_basis=d.conv_basis, registered=registered, can_edit=can_edit and registered,
                                items=[ConversionEventItem(event_name=i.event_name, count=i.count, tracked=i.tracked) for i in d.items])


async def put_events(conn: Any, user: Principal, params: ConversionEventsParams, body: EventsPut) -> ConversionEventsWritten:
    """권한 판정(읽기 트랜잭션) 뒤 쓰기 트랜잭션에서 admin 과 같은 교체(집합이 바뀌면 judgment_change('ga4_tracked_event')).
    레지스트리 밖 속성(env·프로젝트 직접 지정만)은 추적 이벤트 FK 가 없어 404(admin 경로와 같다, 갭 G13)."""
    ctx, can_edit, _ = await authorize_events(conn, user, params)
    if not can_edit:
        if ctx.surface == "project":
            raise errors.forbidden("프로젝트 소유자 전용", code="owner_only")
        raise errors.forbidden("전환 이벤트 편집 역할 아님(country·region·hq)", code="role_forbidden")
    async with get_db().write(user.user_id) as rw:
        w = await ga4_service.put_events(rw, params.property_id, body)
    return ConversionEventsWritten(property_id=w.property_id, event_names=w.event_names, change_id=w.change_id,
                                   propagation=w.propagation)
