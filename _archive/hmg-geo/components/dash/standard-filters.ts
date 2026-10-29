import "server-only";
import { STANDARD_FILTER_ARRAY_AXES, type StandardFilters } from "@/lib/scope/result-adapter";
import type { AllowedScope } from "@/lib/auth/types";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { splitFilterValues, parseTimeRange } from "@/components/dash/filter-encoding";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import { effectiveScopeCountries } from "@/lib/rhq";
import { WEBSITE_BRAND_GEO_CODES, isWebsiteBrandGeoCode } from "@/lib/scope/website-virtual-geo";

// 스코프의 "허용 국가(ISO)" 집합 — 정본은 lib/rhq::effectiveScopeCountries.
// 데이터 읽기 필터(여기)와 필터 드롭다운 옵션(scope-aggregates::
// listMeasuredRegions)이 같은 함수를 공유해, "데이터는 스코프대로 좁혀지는데
// 옵션엔 권한 밖 권역이 뜨는" 드리프트를 막는다. 가장 구체적인 축 우선:
// countries가 있으면 그것만(country=자국), 없으면 regions를 권역 국가로 펼침
// (region 계정 = countries=null). 상세 근거는 그 함수의 주석 참고.
const allowedScopeCountries = (scope?: AllowedScope) => effectiveScopeCountries(scope);

// Single source of truth mapping the DimensionFilterPanel's URL params onto the
// scope-honorable StandardFilters. Only the three axes scope can actually filter
// on are wired (geography → job.region, engine → target, promptContext →
// funnel_stage); source / time / competitor are illustrative and have no scope
// source, so they are ignored here (see docs/scope-requests + OverviewFilters).
// Shared by the overview dashboard and both 표준 답변 분석 pages so the param→
// filter contract can't drift between them.
//
// 2026-06-10 (D4): pass the caller's user.scope and the brand axis defaults to
// scope.brands when the URL doesn't carry it. Genesis HQ entering /dashboard
// without ?brand gets filters.brand=["Genesis"] automatically; admin/scope.all
// receives no default (sees everything). The user can still narrow further via
// the panel — the URL selection takes precedence over the scope default.
export function readStandardFilters(
  sp: Record<string, string | string[] | undefined>,
  scope?: AllowedScope,
  // 화면이 실제 노출하는 필터 축(DimensionGroup) 목록. 지정하면 목록 밖 축의
  // URL 파라미터는 무시된다 — 다른 화면에서 걸어둔 축이 URL 로 넘어와 보이지
  // 않는 채 데이터만 좁히는 누수 방지 (2026-08-06 고객 피드백 #2 부수 발견:
  // 표준에서 brandPresence 를 걸고 웹사이트 탭으로 이동하면 숨은 필터가 계속
  // 적용됐다). 미지정 = 전 축 수용(기존 동작). scope 유래 제약(브랜드 하드락·
  // 허용 국가)은 URL 이 아니라서 이 allowlist 와 무관하게 항상 적용된다.
  visibleGroups?: readonly DimensionGroup[],
): StandardFilters {
  const vis = visibleGroups ? new Set<DimensionGroup>(visibleGroups) : null;
  // 그룹명 == URL 파라미터명 (DimensionFilterPanel 직렬화 규약).
  const param = (group: DimensionGroup, v: string | string[] | undefined) =>
    vis && !vis.has(group) ? undefined : v;
  // A dimension param is a separator-joined value list (filter-encoding —
  // not comma, since depth values contain commas). Empty / "all" → undefined.
  const many = (v: string | string[] | undefined): string[] | undefined => {
    const arr = splitFilterValues(v);
    return arr.length ? arr : undefined;
  };
  const engine = many(param("engine", sp.engine));
  // 2026-06-10 (D4 hard-lock): brand-scoped users (Genesis HQ etc) cannot
  // override their assigned brand from the URL — scope.brands wins outright.
  // scope.all (admin) keeps the URL value (free to pick anything).
  // 2026-07-02: 락에 HMG 엄브렐러(공통/비브랜드 프롬프트 태그)를 함께 포함 —
  // standardPromptInScope의 "공통 = 전 브랜드 계정 가시" 정책과 집계를 일치시키고,
  // brandPresence=unbranded가 브랜드 계정에서 항상 0건이 되는 모순을 해소.
  // 우호도(sentimentTracked)는 TRACKED와의 교집합이라 엄브렐러에 영향받지 않는다.
  const scopeBrand =
    scope && !scope.all && scope.brands?.length
      ? [...scope.brands, UMBRELLA_BRAND]
      : undefined;
  const brand = scopeBrand ?? many(param("brand", sp.brand));
  // Allowed ISO countries = explicit scope.countries ∪ expanded scope.regions
  // (allowedScopeCountries). Inject as the base geography restriction so
  // region/country roles see only their markets. URL ?geography narrows further
  // (must be within scope); a value outside the allowed set is silently dropped
  // and the full allowed set is used instead (client cannot widen access).
  const scopeCountries = allowedScopeCountries(scope);
  const urlGeo = many(param("geography", sp.geography));
  let region: string[] | undefined;
  if (urlGeo && scopeCountries) {
    const allowed = new Set(scopeCountries);
    // 웹사이트 브랜드 가상 코드(HYUNDAI-N)는 국가 집합에 없다 — 그 브랜드가 스코프
    // 브랜드에 들면 통과시킨다(계정 17 = Hyundai N brand, countries=worldwide·KR).
    // 데이터 쪽은 어차피 getProjectIdsForScope 가 brand·country 로 한 번 더 좁힌다.
    const scopeBrandSet = new Set(scope?.brands ?? []);
    const intersected = urlGeo.filter(
      (c) =>
        allowed.has(c) ||
        (isWebsiteBrandGeoCode(c) && scopeBrandSet.has(WEBSITE_BRAND_GEO_CODES[c])),
    );
    region = intersected.length ? intersected : scopeCountries;
  } else {
    region = urlGeo ?? scopeCountries;
  }

  // 기간 축 — ?time=YYYY-MM-DD..YYYY-MM-DD (한쪽 생략 = open-ended). 잘못된
  // 형식은 조용히 무시(축 미적용). measured_at 기준으로 SQL/인메모리 양쪽에서
  // 좁혀진다 (scope-aggregates::answerWhere / result-adapter::makeJobPasses).
  const timeRange = parseTimeRange(param("time", sp.time));

  return {
    region,
    // engine values are now canonical lowercase (DIMENSIONS.engine = scope's
    // target token). toLowerCase is kept defensively so legacy bookmarks like
    // ?engine=ChatGPT still resolve to target=chatgpt.
    engine: engine?.map((e) => e.toLowerCase()),
    dateFrom: timeRange?.from,
    dateTo: timeRange?.to,
    // 2026-06-10 (D6): HMG 3-stage Korean canonical — 인지/탐색 ·
    // 비교/검증 · 구매/사후관리. SQL joins prompts.funnel_stage (catalog).
    funnelStage: many(param("promptContext", sp.promptContext)),
    // Per-prompt catalog taxonomy — resolved via prompts.scope_prompt_id.
    brand,
    // Branded vs unbranded prompt (brand-agnostic umbrella). Independent of the
    // brand axis / scope lock — narrows by the derived class, not a brand value.
    brandPresence: many(param("brandPresence", sp.brandPresence)),
    listType: many(param("listType", sp.listType)),
    depth1: many(param("depth1", sp.depth1)),
    depth2: many(param("depth2", sp.depth2)),
    depth3: many(param("depth3", sp.depth3)),
    // 인용 출처 카테고리 — DimensionFilterPanel의 source 그룹(택소노미 영문 값
    // verbatim). citation 집계에서만 소비된다 (분류는 집계 시점 파생).
    sourceCategory: many(param("source", sp.source)),
    // BCP-47 언어 코드 — DimensionFilterPanel의 language 그룹(?language=).
    // 2026-09-03: website 전용이 아니다. 표준(글로벌) 대시보드도 이 축을 노출하며,
    // 판정 컬럼만 표면별로 갈린다 (scope-aggregates::langAxisPred —
    // project=website_prompts.lang_code / standard=scope_prompts.lang).
    // **케이싱 정본은 여기**: URL·옵션·filters.lang 전부 소문자 BCP-47 로 통일하고,
    // 대문자로 저장된 scope_prompts.lang 은 술어가 upper() 로 맞춘다. 종전에는 정적
    // 폴백(소문자)·website(소문자)·미러(대문자) 세 갈래가 그대로 흘러다녔다.
    lang: many(param("language", sp.language))?.map((l) => l.toLowerCase()),
  };
}

// Stable cache/Suspense key for a filter set — re-keying the Suspense boundary
// on this string shows the skeleton while the narrowed aggregation reloads.
// Sort so equivalent selections key identically regardless of click order.
// Axis list derives from STANDARD_FILTER_ARRAY_AXES (result-adapter.ts) instead
// of a separately hand-maintained field list — see that manifest's comment for
// why (brandPresence/lang/websiteCountry/sourceCategory each silently drifted
// out of a sibling list before).
export function standardFilterKey(filters: StandardFilters): string {
  const axis = (a?: string[]) => [...(a ?? [])].sort().join(",");
  const dateRange = `${filters.dateFrom ?? ""}..${filters.dateTo ?? ""}`;
  return [dateRange, ...STANDARD_FILTER_ARRAY_AXES.map((k) => axis(filters[k]))].join("|");
}
