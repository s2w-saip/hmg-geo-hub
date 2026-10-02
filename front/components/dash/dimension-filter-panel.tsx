"use client";

import {
  Suspense,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Check, ChevronDown, Loader2, SlidersHorizontal } from "lucide-react";
import { AsOfChip } from "./as-of-chip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFilterTransition } from "@/components/dash/filter-transition";
import { createFilterDraftActions } from "@/components/dash/filter-draft-actions";
import { VIRTUAL_GEO_CODES, geoCodeLabel } from "@/lib/geo-catalog/geo-code-label";
import {
  joinFilterValues,
  splitFilterValues,
  FILTER_SEP,
  encodeTimeRange,
  parseTimeRange,
} from "@/components/dash/filter-encoding";
import { AccountScopeChips } from "@/components/dash/account-scope-chips";
import { scopeForGeoSurface } from "@/lib/scope/website-virtual-geo";
import { AnchorDateCalendar } from "@/components/dash/anchor-date-calendar";
import {
  countRounds,
  kstToday,
  normalizeSelectableDates,
  presetWindowKst,
  snapPresetWindow,
  suggestWeekWindow,
} from "@/components/dash/selectable-dates";
import { rhqForCountry, rhqLabel } from "@/lib/rhq";
import { pseudoCountryParent } from "@/lib/geo-catalog/pseudo-country";
import {
  isRegionSelected,
  toggleRhqRegion,
} from "@/components/dash/rhq-region-toggle";
import type { AllowedScope } from "@/lib/auth/types";
import { cn } from "@/lib/utils";
// taxonomy.ts only (not the categorizer index) — keeps geo-catalog/seed.json
// out of the client bundle; the panel needs just the 10 value strings + slugs.
import {
  CITATION_CATEGORIES,
  OFFICIAL_COMPETITOR_CATEGORY,
  citationCategorySlug,
} from "@/lib/citation-categorizer/taxonomy";

// 7 Dimension catalog (KPI ShortList v25). 사용자 결정 (2026-06-04):
// L1-L4 Layer 구분은 미개발 — 각 그룹은 단일 평면 옵션 리스트.
// URL search params: {group}=값,값 (콤마 다중값; Overview/Funnel/Analysis 공유).
//
// 이 컴포넌트는 4개 화면(Overview / AI Funnel / 답변 분석 mentions / citations)이
// 동일하게 재사용. F3=Yes 결정 반영.

// 2026-06-04: `vehicle` (브랜드/차종) dropped from the analysis filter
// set per planning decision — vehicle no longer narrows results from
// the panel. Competitor + engine + time + geography remain as the
// primary slicing axes. Lock chips for the project's own brand surface
// in the project header separately, not through this filter.
export type DimensionGroup =
  | "geography"
  // 프롬프트 언어 (BCP-47 소문자: en / fr / ko …). 한 국가가 여러 언어를 가질 수
  // 있어(캐나다 en+fr) 국가 안에서 더 좁히는 축이다. 옵션은 항상 실데이터이며
  // 표면마다 소스가 다르다 — website = DISTINCT website_prompts.lang_code
  // (website-sites::listMeasuredLanguages), 표준(글로벌) = DISTINCT
  // scope_prompts.lang (scope-aggregates::listMeasuredStandardLanguages,
  // 2026-09-03). 둘 다 languageOptions 로 주입된다.
  | "language"
  | "engine"
  | "promptContext"
  | "source"
  | "time"
  | "competitor"
  // Per-prompt catalog taxonomy (HMG framework) — narrow the measurement set by
  // the prompt's brand / list-type / depth, via prompts.scope_prompt_id.
  | "brand"
  // Branded vs unbranded prompt: does the prompt name a specific HMG marque
  // (Hyundai/Genesis/Kia) or is it brand-agnostic (umbrella HMG, e.g. "best car
  // brand?"). Derived from prompts.brand (umbrella = 'HMG'). See UMBRELLA_BRAND.
  | "brandPresence"
  | "listType"
  | "depth1"
  | "depth2"
  | "depth3"
  | "depth4"
  // GA4-derived axes (conversion / ai-funnel only). Unlike the scope axes
  // above, these map to real GA4 Data API dimensions — device→deviceCategory,
  // visitorType→newVsReturning — so selecting them re-queries GA4 (not the
  // demo signal). Probed 2026-06-23: both have ≥2 populated values in the
  // Kia/IT AI cohort. Not surfaced outside conversion (other stages have no
  // GA4 backing).
  | "device"
  | "visitorType";

// 가상 권역 코드(VIRTUAL_GEO_CODES)의 정본과 지역 코드 라벨 규칙은
// lib/geo-catalog/geo-code-label 로 옮겼다(2026-09-29) — 계정 스코프 칩이 같은
// 규칙을 써야 가상코드 계정에서 렌더가 죽지 않는다.

// 국가 드롭다운의 최상단 고정 국가 (2026-09-04 고객 요청 — 전 영역 공통).
// HMG 는 한국 기업이라 자국이 가장 자주 쓰이는데 ISO 알파벳 정렬로는 KR 이 목록
// 한가운데에 묻힌다. 가상 코드(월드와이드 등) 바로 다음 자리를 준다.
const HOME_COUNTRY = "KR";

/**
 * 국가 옵션 정렬의 정본 — `가상 코드 → 대한민국 → 나머지(원래 순서)`.
 *
 * 세 화면의 요구가 이 규칙 하나로 전부 나온다(권역 그룹 유무만 다르다):
 *  · Global   그룹 없음        → 대한민국이 목록 최상단
 *  · Website  가상 코드가 앞   → 월드와이드(글로벌) 아래 대한민국
 *  · Project  권역 그룹 있음   → FacetedFilter 의 그룹은 **첫 등장 순서**로 쌓이므로
 *    대한민국이 앞에 오면 아시아·태평양 그룹이 먼저 오고 그 안에서도 맨 위다
 *    (오스트레일리아 위 — 요청 문구 그대로).
 *
 * 나머지의 상대 순서는 건드리지 않는다(서버 ORDER BY 유지).
 */
export function orderGeographyOptions(codes: readonly string[]): string[] {
  const virtual: string[] = [];
  const home: string[] = [];
  const rest: string[] = [];
  for (const c of codes) {
    if (VIRTUAL_GEO_CODES.has(c)) virtual.push(c);
    else if (c === HOME_COUNTRY) home.push(c);
    else rest.push(c);
  }
  return [...virtual, ...home, ...rest];
}

// Option lists reflect what scope ACTUALLY measures for the root project
// (probed 2026-06-08): regions = US/KR, providers = chatgpt/gemini, funnel
// stages = discovery/evaluation/transactional, plus the real competitor brands.
// source/time stay illustrative — scope exposes no source-type or time-series
// axis yet, so those groups are not surfaced on the overview (see OverviewFilters).
export const DIMENSIONS: Record<DimensionGroup, readonly string[]> = {
  // geography 실제 옵션은 항상 geographyOptions(listMeasuredRegions = DISTINCT
  // scope_answers.region, scope-narrowed)로 주입된다 → 하드코딩 fallback 없음.
  geography: [],
  // ⚠️ 정적 폴백(소문자 BCP-47) — **스코프·국가와 무관한 값이라 신뢰하면 안 된다.**
  // 이것이 그대로 그려지면서 KR 국가 계정의 대시보드에 프랑스어가 떴다(2026-09-03
  // 고객 제보 → hmg-geo-filter-region-country-language-audit-2026-09-03.md §2-A).
  // 실옵션은 languageOptions 로 주입된다 — website = DISTINCT website_prompts
  // .lang_code, 표준 = DISTINCT scope_prompts.lang(소문자화). language 축을 새로
  // 노출하는 화면은 **반드시 languageOptions 를 함께 넘길 것**(안 넘기면 여기로 샌다).
  // geography 처럼 []로 비우지 않은 이유: ai-funnel visibility/acr 화면이 아직
  // 옵션을 안 넘긴 채 이 축을 노출하고 있어(범위 밖 잔여) 빈 드롭다운이 된다.
  language: ["en", "ko", "fr"],
  // Canonical = scope's target token (lowercase: chatgpt/gemini), so the URL
  // param matches scope_answers.target verbatim (no case bridging needed).
  // Display name comes from ENGINE_LABEL — same pattern as geography (ISO code
  // value + Intl display name).
  engine: ["chatgpt", "gemini"],
  // 2026-06-10 (D6): HMG 3-stage Korean vocab is canonical (인지/탐색 ·
  // 비교/검증 · 구매/사후관리). Replaces scope's legacy 5-stage
  // (discovery/evaluation/transactional/...). URL params carry these
  // strings verbatim; the catalog (prompts.funnel_stage) stores the same.
  promptContext: ["인지/탐색", "비교/검증", "구매/사후관리"],
  // 인용 출처 카테고리 (2026-07-02: owned/external placeholder → citation-
  // categorizer taxonomy로 실배선). URL param은 영문 카테고리 값 verbatim
  // (?source=…) — readStandardFilters가 filters.sourceCategory로 읽어 citation
  // 집계를 행 단위로 좁힌다. 라벨은 citationCategories.* i18n.
  source: CITATION_CATEGORIES,
  // time 은 옵션 리스트가 아니라 날짜 범위 축 — TimeRangeFilter 가 특수 렌더링
  // (프리셋 주간/월간/연간 + from/to). 정적 옵션은 사용되지 않는다.
  time: [],
  competitor: [
    "Toyota",
    "BMW",
    "Tesla",
    "Mercedes-Benz",
    "Honda",
    "Lexus",
    "Audi",
    "Volkswagen",
    "Ford",
    "Nissan",
  ],
  // Per-prompt catalog taxonomy (HMG framework, v0.4 final — regen via the
  // catalog distinct query if the prompt set changes). These filter the
  // measurement set through prompts.scope_prompt_id = scope_answers.prompt_id.
  // "HMG"(브랜드 무관/umbrella) 제외 — root 카탈로그에 현재 0개라 드롭다운에서
  // 뺌(2026-07-06). brandPresence="unbranded"가 동일 데이터(prompts.brand='HMG')를
  // 이미 커버하므로 기능 손실 없음. 나중에 브랜드 무관 프롬프트가 추가되면 재검토.
  brand: ["Genesis", "Hyundai", "Kia"],
  // Canonical URL values (locale-independent); labels via i18n value.branded/
  // value.unbranded. branded = prompt names a specific marque; unbranded =
  // umbrella HMG (brand-agnostic). Server maps these to prompts.brand.
  brandPresence: ["branded", "unbranded"],
  listType: ["Consumer base Response", "Brand Message"],
  depth1: [
    "Car+Features",
    "Action+Car",
    "Innovation & Technology",
    "Compare+Car/Features",
    "Review+Car/Features",
    "Car Ownership",
    "Brand Image/key value",
    "Human & Sustainable Mobility",
  ],
  depth2: [
    "Action_Pricing Plan",
    "EV,Hybrid Brand Awareness",
    "Value Awareness",
    "Ownership_Support",
    "Action_Insurance/Warranty",
    "Features_Size/Spec",
    "Features_Software/Connectivity",
    "Ownership_Issue/Problem",
    "Environmental Friendliness",
    "Features_Design/Color",
    "Features_Mileage/Efficiency",
    "Brand Awareness",
    "Compare_Size/Spec",
    "Compare_Software/Connectivity",
    "Review_Software/Connectivity",
    "Compare_Design/Color",
    "Compare_Mileage/Efficiency",
    "Features_Interior",
    "Human Centered Innovation",
    "Review_Design/Color",
    "Review_Mileage/Efficiency",
    "Review_Size/Spec",
    "Social Responsibility",
    "Review_Car/Brand",
    "Autonomous car",
    "Compare_Car/Brand",
    "Features_Accessories",
    "Features_driving Option",
    "Features_Engine Output/Oil",
    "Features_Technology",
    "Features_Vehicle Parts",
    "Features_Wheels/Tire",
    "Innovative Brand Awareness",
    "Relation with AI",
    "Software Technology",
  ],
  depth3: [
    "Software/Connectivity",
    "Price/deal/Financing",
    "Size/Spec",
    "Design/Color",
    "Support",
    "Mileage/Efficiency",
    "Issue/Problem",
    "Size/spec/seat",
    "Car/Brand",
    "Dealership/Configurator",
    "design",
    "EV range",
    "Used car/lease",
    "Warranty",
    "connected services",
    "Insurance",
    "Accessories",
    "color",
    "driving option",
    "Engine/output",
    "EV Battery",
    "EV Design",
    "EV Driving",
    "EV Efficiency",
    "EV Value",
    "EV, Hybrid Awareness",
    "hybrid efficiency",
    "Interior",
    "long distance/range",
    "Myhyundai",
    "parts",
    "recall",
    "remote start",
    "Self driving/FSD",
    "Size/spec",
    "software update",
    "Trunk space",
    "wheels",
    "Reliability",
  ],
  // depth4 — 미정의 placeholder (편집팀이 4차원 결정 후 채움). 현재 정적
  // 옵션은 빈 배열이지만, catalogRows prop 이 전달되면 그 안의 depth4 값으로
  // 채워짐 (cascading filter).
  depth4: [],
  // GA4 deviceCategory / newVsReturning — canonical values match the GA4 API
  // tokens verbatim (server passes them straight into dimensionFilter). Probed
  // 2026-06-23 on Kia/IT AI cohort: device = mobile/desktop (tablet absent but
  // kept for other markets), visitorType = new/returning.
  device: ["mobile", "desktop", "tablet"],
  visitorType: ["new", "returning"],
};

export const ALL_GROUPS: DimensionGroup[] = [
  "geography",
  "language",
  "engine",
  "promptContext",
  "source",
  "time",
  "competitor",
  "brand",
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
  "device",
  "visitorType",
];

// language 축만 뺀 전 축 — "이 화면은 언어로 데이터를 좁힐 수 없다"를 표현하는
// 정본 목록 (2026-09-03). 옵션 없이 축을 띄우면 정적 폴백(DIMENSIONS.language,
// 스코프 무관)이 그려지므로, 실옵션을 줄 수 없는 표면은 축 자체를 내려야 한다.
// 소비처: 대시보드(실측 언어 0건일 때) · AI Funnel Visibility(픽스처 화면).
export const ALL_GROUPS_EXCEPT_LANGUAGE: DimensionGroup[] = ALL_GROUPS.filter(
  (g) => g !== "language",
);

// 표면 공통 섹션(줄바꿈) 정본 — 디멘션 / 프롬프트 / 답변(인용 파생) 3행.
// 표준·웹사이트·프로젝트의 대시보드/언급/인용 화면이 전부 이 하나를 쓴다:
// 패널이 노출 축만 남기고 빈 행은 숨기므로(아래 sectionRows), 표면마다
// onlyGroups로 축을 줄여도 행 배정 규칙 자체는 항상 동일하다. 축을 새로
// 추가할 땐 여기 한 곳에만 행을 배정하면 전 화면에 같은 줄바꿈이 적용된다.
// (이전에는 이 배열이 5개 파일에 복붙돼 있어 화면마다 조금씩 달랐다.)
export const FILTER_SECTIONS: { id: string; groups: DimensionGroup[] }[] = [
  {
    id: "dimension",
    groups: ["brand", "geography", "language", "engine", "time", "device", "visitorType"],
  },
  {
    id: "prompt",
    groups: [
      "promptContext",
      "brandPresence",
      "listType",
      "depth1",
      "depth2",
      "depth3",
      "depth4",
    ],
  },
  // source(출처 카테고리)·competitor(경쟁사)는 답변의 인용에서 파생되는 축 —
  // 인용 화면에서만 onlyGroups에 포함되므로 다른 화면에서는 이 행이 자동으로 숨는다.
  // 2026-09-10 QA 2차 #2·#5: 표준 인용 화면의 칩·경쟁사 드롭다운을 이 행으로 되돌렸다
  // (칩은 클릭 즉시 URL 을 써서 서버 왕복이 끝나야 선택이 보였다 = "선택이 안 된다").
  // competitor 를 노출하는 다른 화면(ACR·visibility)은 sections 를 쓰지 않으므로 무영향.
  { id: "citation", groups: ["source", "competitor"] },
];

// Stage-aware Primary dimension config (Confluence v44 결정 매트릭스 §6,
// updated 2026-06-04 to drop vehicle). Vehicle slot replaced with
// competitor (acr / mentions — peer comparison) or geography
// (conversion — regional reach).
export const STAGE_PRIMARY: Record<
  "overview" | "visibility" | "acr" | "conversion" | "mentions" | "citations",
  DimensionGroup[]
> = {
  overview: ["time", "geography", "engine", "promptContext"],
  visibility: ["time", "geography", "engine", "promptContext"],
  acr: ["time", "engine", "competitor", "promptContext"],
  // conversion axes are GA4-backed only (see ConversionView onlyGroups).
  // geography matters at region/HQ rollup (country split); engine/device/
  // visitorType slice the AI cohort on a single property. Scope axes
  // (promptContext/competitor/brand/depth) have no GA4 conversion mapping.
  conversion: ["geography", "engine", "device", "visitorType"],
  mentions: ["time", "engine", "competitor", "promptContext"],
  citations: ["time", "source", "engine", "promptContext"],
};

export type DimensionStage = keyof typeof STAGE_PRIMARY;

export type DimensionFilterPanelProps = {
  /**
   * Stage. Controls which 4 dimensions are exposed by default; rest go
   * under "+ More". 'overview' shows all 7 always (legacy behavior).
   */
  stage?: DimensionStage;
  /**
   * Groups that are locked to a fixed value (e.g. Project's brand/country).
   * These groups are NOT rendered as filter cards — surface them via
   * <DimensionLockChip> in the page header instead (F4=B decision).
   */
  lockedGroups?: DimensionGroup[];
  /**
   * Override which groups appear as Primary (always-expanded). Falls back
   * to STAGE_PRIMARY[stage] when omitted.
   */
  primaryGroups?: DimensionGroup[];
  /**
   * Restrict the panel to exactly these groups (everything else is hidden, no
   * "+ More"). Use to surface only the dimensions a screen actually filters by
   * — e.g. the overview wires geography/engine/promptContext into live scope.
   */
  onlyGroups?: DimensionGroup[];
  /**
   * Right-aligned slot in the toolbar — e.g. the per-view brand/domain
   * search input. Keeps search state in the view while unifying the bar.
   */
  trailing?: ReactNode;
  /**
   * 2026-06-18 — top-of-panel slot for the measurement-basis control
   * (MeasurementBasisControl). Rendered on its own row above the scope chips
   * + filter axes so the time-series bucket basis (주/일) is the first thing
   * read, separate from the value filters. Omitted → no basis row.
   */
  basis?: ReactNode;
  /**
   * 2026-07-24 — 측정 기준일(마지막 측정 시각, YYYY-MM-DD) 배지. 필터 최상단
   * (basis 행 위)에 단독 행으로 렌더 — 고객요구로 대시보드/웹사이트/프로젝트
   * 공통. 스코프의 max(measured_at); null/omit → 배지 숨김.
   */
  asOf?: string | null;
  /**
   * 2026-08-27 — 측정 기준일을 **스트리밍**으로 채우기 위한 슬롯. 답변분석
   * 화면들은 필터바를 무거운 집계 read 밖으로 꺼내(자기 <Suspense> 경계) 즉시
   * 그리는데, 기준일만은 그 집계에서 나온다. 슬롯이 주어지면 asOf 값 유무와
   * 무관하게 **행을 항상 그린다** — 값이 늦게 도착해도 행 높이가 그대로라
   * 레이아웃이 튀지 않는다. 슬롯 미지정(기존 호출부) 시 동작 불변.
   */
  asOfSlot?: ReactNode;
  /**
   * 2026-09-09 QA 2차 #2 — 필터 박스 **안쪽 맨 아래 행** 슬롯. 인용 화면의 도메인
   * 카테고리 칩이 여기로 들어온다(박스 밖 별도 카드였던 것을 필터 박스 내부 2행으로).
   * 미지정(기존 호출부) 시 행 자체가 없다 — 동작 불변.
   */
  footerSlot?: ReactNode;
  /**
   * 피그마 2행 레이아웃(2026-09-02 제품 결정): 측정 기준일·측정 기준·내 권한 행을
   * 그리지 않는다. 측정 기준일은 측정 개요 카드(답변분석)·헤더 칩(Overview)이 맡는다.
   */
  compact?: boolean;
  /**
   * Pin the bar under the app chrome (top-24 = header h-14 + beta banner h-10)
   * so it drives the content as a persistent header filter. The page/window is
   * the scroll container.
   *
   * ⚠️ sticky 는 **부모(포함 블록)가 자기보다 높을 때만** 움직인다. 패널을 자기
   * 높이와 같은 컨테이너(예: `items-stretch` grid 행)의 직접 자식으로 두면 이동거리가
   * 0 이 되어 그냥 스크롤돼 사라진다 — 그때는 이 prop 을 false 로 주고 **그 컨테이너**가
   * sticky 를 소유해야 한다(답변분석 언급·인용 화면이 그 경우). 층은 z-20 고정 —
   * 크롬(헤더·배너)은 z-30 이라 본문 패널이 그 위로 올라가지 않는다.
   */
  sticky?: boolean;
  /**
   * 2026-06-10 — caller's authorization scope. When provided, AccountScopeChips
   * render at the start of the toolbar so the user sees the data boundary
   * alongside the dimensions they can narrow. Pages thread session.user.scope.
   */
  scope?: AllowedScope;
  /**
   * 2026-09-29 — 계정 국가 스코프를 어느 표면 규칙으로 **표시**할지(스코프 칩·국가 축
   * 잠금). 전용 사이트 코드(worldwide·CPO·HYUNDAI-N)를 가진 계정은 웹사이트에서 그
   * 사이트만, 글로벌에서는 그 코드를 뺀 국가로 보인다(lib/scope/website-virtual-geo).
   * 웹사이트 필터만 "website" 를 넘긴다. 데이터 게이트는 서버가 같은 규칙으로 따로 건다.
   */
  geoSurface?: "standard" | "website";
  /**
   * 2026-06-11 — DISTINCT (listType, depth1-4) rows from the prompts catalog
   * (lib/db/repositories/standards::listCatalogTaxonomy). When provided, the
   * cascading filter narrows children by their parent's selection: listType
   * → depth1 → depth2 → depth3 → depth4. When absent, the static DIMENSIONS
   * list is used (every option available regardless of siblings).
   */
  catalogRows?: CatalogTaxonomyRow[];
  /**
   * 2026-06-11 — ISO country codes the mirror has actually measured + the
   * caller's scope can read (lib/db/repositories/scope-aggregates::
   * listMeasuredRegions). Replaces the static DIMENSIONS.geography hardcode
   * so the dropdown grows automatically as new countries get measured, and
   * scope-restricted users only see countries they have read access to.
   */
  geographyOptions?: string[];
  /**
   * 2026-08-18 — scope target 토큰 중 이 화면의 모집단이 **선택 기간 안에 실제로
   * 답변을 수집한** 엔진(lib/db/repositories/scope-aggregates::listMeasuredEngines).
   * 프로젝트 답변 분석이 주입한다(project-ai-engine-selection) — 엔진 설정을
   * 바꾼 프로젝트에서 기간 내 수집이 없는 엔진이 죽은 필터로 뜨지 않도록.
   * 미전달 시 정적 DIMENSIONS.engine 폴백(글로벌·웹사이트 표면 종전 동작).
   */
  engineOptions?: string[];
  /**
   * 브랜드 축(brand)의 실제 옵션. 정적 `DIMENSIONS.brand` 는 HMG 3사 고정인데,
   * **웹사이트 표면의 브랜드 술어는 `website_sites.brand`** 다
   * (website-sites.ts::websitePromptRowWhere) — 그 값 공간에는 '현대 N'
   * (`Hyundai N`)처럼 3사에 없는 사이트 브랜드가 있다. 정적 목록만 쓰면 그
   * 브랜드는 **어느 축에서도 고를 수 없다.**
   * 미전달 시 정적 DIMENSIONS.brand 폴백(표준·프로젝트 표면 종전 동작).
   * ⚠️ 웹사이트 **Overview** 에는 넘기지 말 것 — 그쪽 브랜드 술어는
   * `prompts.brand`(HMG 카탈로그, scope-aggregates.ts:1194)라 값 공간이 다르다.
   */
  brandOptions?: string[];
  /**
   * 경쟁사 축(competitor)의 실제 옵션. 표준 인용 화면은 **인용 도메인**(공식(경쟁사)로
   * 분류된 도메인)이라 정적 DIMENSIONS.competitor(브랜드명 10개)와 의미가 다르다.
   *
   * 값이 무거운 집계(fetchStandardCitations)에서 오므로 **프로미스**도 받는다 — 그때는
   * 그 facet 하나만 <Suspense> 로 감싼다. 필터바 전체가 집계를 기다리면 안 된다는
   * analysis-filter-bar.tsx 헤더 주석의 설계 의도를 지키기 위해서다(칩 시절의
   * footerSlot 경계가 하던 일과 같은 값, 같은 요청단위 dedup — DB 왕복은 그대로 1회).
   *
   * 빈 목록이면 축 자체를 그리지 않는다 — 값 없는 드롭다운은 죽은 필터다(language 축과
   * 같은 규칙). 미전달이면 종전대로 정적 폴백(ACR·visibility 화면).
   */
  competitorOptions?: string[] | Promise<string[]>;
  /**
   * BCP-47 소문자 언어 코드 — 이 화면의 모집단이 **실제로 측정한** 언어.
   * 정적 DIMENSIONS.language 폴백을 대체한다(그 폴백은 스코프와 무관해 신뢰 불가).
   *
   * - website (2026-07-01): DISTINCT website_prompts.lang_code, 스코프로 좁힘
   *   (lib/db/repositories/website-sites::listMeasuredLanguages) — 캐나다 en/fr 처럼
   *   한 국가 안의 공식 사이트 언어.
   * - 표준/글로벌 (2026-09-03): DISTINCT scope_prompts.lang 소문자화, 루트 카탈로그
   *   게이트 + 스코프 국가·브랜드로 좁힘
   *   (scope-aggregates::listMeasuredStandardLanguages).
   *
   * 술어도 같은 표면 규칙으로 갈린다(scope-aggregates::langAxisPred) — 옵션 소스와
   * 술어 컬럼이 어긋나면 "옵션엔 있는데 고르면 0건"이 된다(2026-09-03 결함의 정체).
   */
  languageOptions?: string[];
  /**
   * 2026-09-04 — 표준(글로벌) 표면의 **옵션 의존 매트릭스** (브랜드 × 국가 × 언어).
   * scope-aggregates::listMeasuredScopeMatrix 가 스코프·루트 게이트만 걸고 **사용자
   * 선택으로는 좁히지 않은** 조합표를 내려주면, 이 패널이 draft 로 좁힌다.
   *
   * 왜 — geographyOptions/languageOptions 는 서버가 **적용된 필터** 기준으로 좁혀
   * 내려준다. 그런데 상위 축(브랜드·국가) 선택은 클라이언트 draft 다. 두 축이 다른
   * 시점을 보므로 "고르는 중"과 "적용 후"가 어긋났다(2026-09-04 고객 검수):
   * 브랜드 draft 직후 권역 중동을 누르면 브랜드 미적용 시점의 국가가 채워지고,
   * 국가를 draft 로 8개 채워도 언어는 직전 적용 국가 기준으로 남았다.
   * 매트릭스가 오면 두 축 모두 draft 에서 파생되므로 정의상 어긋날 수 없다.
   * 미전달(웹사이트·프로젝트 표면) 시 기존 목록 prop 으로 폴백 — 동작 불변.
   */
  optionMatrix?: MeasuredScopeCombo[];
  /**
   * 2026-09-08 (QA #19·#20) — 데이터 **수집 시작 시각**(ISO 8601 instant, 서버가
   * `Date.toISOString()` 으로 넘긴다). 브라우저 로컬 일자로 접어(`isoDay`) 기간 축
   * 캘린더의 `min` 이 되고, 프리셋(특히 연간)의 시작일도 이 날로 클램프된다.
   * 서버(UTC)에서 YYYY-MM-DD 로 잘라 보내면 KST 자정 부근에 프리셋(로컬 일자)과
   * 하루 어긋난다 — 그래서 instant 를 넘기고 클라이언트가 접는다. 수집 이전
   * 구간은 어차피 빈 창이라 고를 수 있는 것 자체가 오해를 만든다.
   * 정본은 scope-aggregates::standardCollectionDates.firstMeasuredAt.
   * 미전달 시 제한 없음(종전 동작).
   */
  collectionStartDay?: string | null;
  /**
   * 2026-09-18 (GGMD-107 C2) — 그 표면의 **최신 노출 회차 앵커일 `E`**(YYYY-MM-DD,
   * UTC 일). 기간 프리셋의 **끝점**이 된다: 값의 창과 Δ 의 현재 창이 같은 날짜쌍에서
   * 나와야 하기 때문이다(스펙 `period-comparison-delta`).
   *
   * `collectionStartDay` 와 **같은 배선**(서버 페이지 → 필터바 → 패널)이지만 형태가
   * 다르다: 수집 시작일은 instant 를 넘겨 클라이언트가 로컬 일자로 접는 반면,
   * `E` 는 서버가 이미 **UTC 일**로 확정한 값이라 그대로 쓴다(접으면 어긋난다).
   *
   * 미전달·해소 불가(원장 미적용·DB 오류·그 표면에 노출 회차 0)면 **오늘**로 폴백 =
   * 종전 동작.
   */
  latestAnchorDay?: string | null;
  /**
   * 2026-09-19 (앵커 축 전환, 스펙 §5.1) — 그 표면에서 **회차가 있는 날짜** 목록
   * (KST `YYYY-MM-DD`, 오름차순). 서버 로더
   * `lib/calendar/selectable-anchor-dates.ts::loadSelectableAnchorDates` 가 만든다.
   *
   * · `undefined` = **종전 동작 그대로**(네이티브 날짜 입력, 모든 날짜 선택 가능).
   * · 빈 배열도 종전 동작이다 — 리더는 "모른다"(마이그레이션 미적용·DB 오류)를
   *   빈 배열로 표현하므로, 그걸 "고를 수 있는 날이 없다"로 읽으면 적용 전 창에
   *   달력이 통째로 잠긴다(`scope-answer-anchors.ts` 의 반환 계약 주석).
   * · 값이 있으면 그 날짜만 활성이고 나머지는 비활성이며, 프리셋·URL 값도 목록
   *   안의 날짜로 스냅된다(스냅 사실은 화면에 표시한다).
   *
   * 글로벌 화면에는 월요일들이, 웹사이트 화면에는 금요일들이 들어온다(§9.2 정규
   * 요일). 프로젝트 화면은 임의 날짜다.
   */
  selectableDates?: string[];
  /**
   * 2026-07-01 — brand context that drives the geography 권역→국가 2-depth
   * cascade, independent of the caller's auth `scope`. RHQ (권역) mapping is
   * brand-specific, so the 권역 pre-filter is normally gated to single-brand
   * scopes. On a project screen the project itself fixes the brand, so pass it
   * here to enable 권역 grouping for any viewer (incl. admin) without conflating
   * it with the auth scope chips. Overrides the scope-derived active brand.
   */
  regionBrand?: string;
  /**
   * 2026-07-02 (피드백 2-c) — 순수 시각적 섹션 구분. 지정하면 필터 축이 섹션별
   * 행으로 나뉘고 각 행 앞에 라벨(i18n `section.{id}`)이 붙는다. draft/적용/URL
   * 상태·버튼은 패널 단위 하나 그대로. 섹션에 배정되지 않은 노출 축(예: admin
   * 자동 삽입 brand)은 첫 섹션 행의 앞에 붙는다. 미지정 = 기존 단일 행.
   */
  sections?: { id: string; groups: DimensionGroup[] }[];
  /**
   * 2026-07-31 — 프로젝트별 커스텀 태그를 필터 축으로 동적 주입. 컴파일타임
   * DimensionGroup enum과 별개(런타임·프로젝트마다 다름)라 별도 채널로 받는다.
   * 각 축은 URL 파라미터 `cf_<id>`로 커밋되며(서버 readProjectCustomFieldFilters와
   * 동일 키), 고정 축과 같은 draft→적용 흐름·다중값(체크박스) 선택을 탄다. 빈
   * 배열이면(표준/웹사이트) 아무 것도 렌더/커밋하지 않아 기존 동작 불변.
   */
  dynamicAxes?: DynamicAxis[];
  /**
   * 2026-09-29 (결정 D4·Q7, U4): 옵션을 **패널이 열릴 때** 불러온다. 주면 축 드롭다운을
   * 처음 여는 순간 `GET /api/filters/options` 를 한 번 부르고, 그 전에는 한 번도 부르지
   * 않는다. 받아 온 값은 위 옵션 prop 중 **호출부가 넘기지 않은 것만** 채운다. 명시한
   * prop 이 언제나 이긴다. URL 의 기간·브랜드(프로젝트는 엔진까지, 옵션을 좁히는 값)가
   * 바뀌면 받아 둔 값을 버리고 다음에 열 때 다시 부른다. 미지정 = 종전 동작.
   *
   * 채우는 prop(기본 `fields`): catalogRows·geographyOptions·languageOptions·optionMatrix·
   * engineOptions. **dynamicAxes 는 기본에서 빠진다**: 커스텀 필드 축은 받아 오기 전에는
   * 그려지지 않고, 전체 초기화(resetAll)가 모르는 축의 `cf_` 파라미터를 지우지 못하며,
   * 서버가 `cf_` URL 을 읽는 데도 축 목록이 필요하다. 그래서 프로젝트 화면은 dynamicAxes 를
   * 서버에서 계속 넘긴다(굳이 지연시키려면 `fields` 에 명시).
   *
   * ⚠️ catalogRows 를 지연시키면 **축 구성이 받아 온 뒤 바뀔 수 있다**: 받기 전에는 카탈로그
   * 축(brandPresence·listType·depth1~4)이 전부 보이고(정적 목록 대신 불러오는 중 행), 받은
   * 뒤에는 그 모집단에 값이 없는 축이 숨는다(catalogAxisHasValues). 축 구성을 첫 렌더부터
   * 고정해야 하는 화면은 catalogRows 를 서버에서 넘긴다.
   */
  lazyOptions?: LazyFilterOptions;
};

/** 지연 로드로 채울 수 있는 옵션 prop 이름. dynamicAxes 는 `fields` 에 명시할 때만. */
export type LazyOptionField =
  | "catalogRows"
  | "geographyOptions"
  | "languageOptions"
  | "optionMatrix"
  | "engineOptions"
  | "dynamicAxes";

/** `lazyOptions` 설정: 원천 스위치 좌표(D8)와 표면. */
export interface LazyFilterOptions {
  /** 화면 영역(원천 스위치 HGH_SOURCE_<그룹> 판정): dashboard·analysis·funnel·prompts. */
  area: "dashboard" | "analysis" | "funnel" | "prompts";
  surface: "global" | "website" | "project";
  /** surface=project 필수. */
  projectId?: string;
  /** 받아 온 값 중 쓸 prop. 미지정 = LAZY_DEFAULT_FIELDS(dynamicAxes 제외). */
  fields?: readonly LazyOptionField[];
}

/** `/api/filters/options` 응답의 옵션(서버 페이지가 넘기던 prop 과 같은 모양). */
export interface LoadedFilterOptions {
  catalogRows?: CatalogTaxonomyRow[];
  geographyOptions?: string[];
  languageOptions?: string[];
  optionMatrix?: MeasuredScopeCombo[];
  engineOptions?: string[];
  dynamicAxes?: DynamicAxis[];
}

/** `fields` 미지정 때 채우는 prop. dynamicAxes 는 뺀다(lazyOptions prop 주석). */
export const LAZY_DEFAULT_FIELDS: readonly LazyOptionField[] = [
  "catalogRows",
  "geographyOptions",
  "languageOptions",
  "optionMatrix",
  "engineOptions",
];

/**
 * 옵션을 좁히는 URL 값만 싣는 조회 URL(같은 URL 상태면 같은 문자열): 기간·브랜드, 프로젝트는
 * 엔진까지(옛 프로젝트 엔진 목록이 엔진 선택에 따라 달라진다: 선택 없음 = 기본 엔진만).
 */
export function lazyOptionsUrl(
  cfg: LazyFilterOptions,
  sp: { get(name: string): string | null },
): string {
  const q = new URLSearchParams();
  q.set("area", cfg.area);
  q.set("surface", cfg.surface);
  if (cfg.projectId) q.set("project_id", cfg.projectId);
  for (const key of cfg.surface === "project" ? ["time", "brand", "engine"] : ["time", "brand"]) {
    const v = sp.get(key);
    if (v) q.set(key, v);
  }
  return `/api/filters/options?${q.toString()}`;
}

/**
 * URL 하나당 **한 번만** 부르는 요청기. 같은 URL 로 다시 요청하면 null(이미 진행 중이거나
 * 끝났다). 실패하면 그 URL 을 잊어 다음 열림에서 다시 시도한다.
 */
export function createLazyOptionsRequester(load: (url: string) => Promise<LoadedFilterOptions>) {
  let current: string | null = null;
  return {
    request(url: string): Promise<LoadedFilterOptions> | null {
      if (current === url) return null;
      current = url;
      return load(url).catch((e: unknown) => {
        if (current === url) current = null;
        throw e;
      });
    },
  };
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** `GET /api/filters/options` → LoadedFilterOptions. 모양이 어긋난 필드는 버린다. */
export async function fetchLazyFilterOptions(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedFilterOptions> {
  const res = await fetchImpl(url, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`filter options ${res.status}`);
  const body = (await res.json()) as { options?: Record<string, unknown> } | null;
  const o = body?.options ?? {};
  const out: LoadedFilterOptions = {};
  if (Array.isArray(o.catalogRows)) out.catalogRows = o.catalogRows as CatalogTaxonomyRow[];
  if (isStringArray(o.geographyOptions)) out.geographyOptions = o.geographyOptions;
  if (isStringArray(o.languageOptions)) out.languageOptions = o.languageOptions;
  if (Array.isArray(o.optionMatrix)) out.optionMatrix = o.optionMatrix as MeasuredScopeCombo[];
  if (isStringArray(o.engineOptions)) out.engineOptions = o.engineOptions;
  if (Array.isArray(o.dynamicAxes)) out.dynamicAxes = o.dynamicAxes as DynamicAxis[];
  return out;
}

/** 이 설정이 지연 로드로 채우는 prop 인가(`fields` 미지정 = LAZY_DEFAULT_FIELDS). */
export function lazyFieldWanted(cfg: LazyFilterOptions | undefined, key: LazyOptionField): boolean {
  return !!cfg && (cfg.fields ?? LAZY_DEFAULT_FIELDS).includes(key);
}

/** 받아 온 값에서 이 설정이 쓰는 prop 하나. 쓰지 않는 prop 은 undefined(호출부 prop·폴백 유지). */
export function pickLazyField<K extends LazyOptionField>(
  cfg: LazyFilterOptions | undefined,
  loaded: LoadedFilterOptions | undefined,
  key: K,
): LoadedFilterOptions[K] | undefined {
  return loaded && lazyFieldWanted(cfg, key) ? loaded[key] : undefined;
}

type LazyStatus = "off" | "idle" | "loading" | "done" | "error";

/**
 * 패널의 지연 옵션 상태. `request()` 는 축 드롭다운이 열릴 때만 불린다(렌더 중 호출 0).
 * URL(기간·브랜드)이 바뀌면 이전 값은 `pick` 에서 사라진다.
 */
function useLazyFilterOptions(
  cfg: LazyFilterOptions | undefined,
  sp: { get(name: string): string | null },
) {
  const url = cfg ? lazyOptionsUrl(cfg, sp) : null;
  const [requester] = useState(() => createLazyOptionsRequester((u) => fetchLazyFilterOptions(u)));
  const [state, setState] = useState<{
    url: string;
    status: "loading" | "done" | "error";
    data?: LoadedFilterOptions;
  } | null>(null);
  const current = state && state.url === url ? state : null;
  const status: LazyStatus = !url ? "off" : (current?.status ?? "idle");
  const request = () => {
    if (!url) return;
    const pending = requester.request(url);
    if (!pending) return;
    setState({ url, status: "loading" });
    pending.then(
      (data) => setState((cur) => (cur?.url === url ? { url, status: "done", data } : cur)),
      () => setState((cur) => (cur?.url === url ? { url, status: "error" } : cur)),
    );
  };
  const wants = (key: LazyOptionField): boolean => lazyFieldWanted(cfg, key);
  function pick<K extends LazyOptionField>(key: K): LoadedFilterOptions[K] | undefined {
    return pickLazyField(cfg, current?.status === "done" ? current.data : undefined, key);
  }
  return { status, request, pick, wants };
}

// 옵션 의존 매트릭스의 한 행 — scope-aggregates::MeasuredScopeCombo 의 클라이언트
// 쌍둥이(server-only 모듈을 클라이언트 번들로 끌고 오지 않기 위해 형태만 복제).
// brand=null 은 **공통(브랜드 무관)** 이라 어느 브랜드를 골라도 남는다.
// lang=null 은 언어 태그 없는 프롬프트 — 국가 옵션에는 기여하고 언어 옵션에는 안 한다.
/**
 * 옵션 매트릭스에서 (국가, 언어) 옵션을 파생한다 — **순수 함수**(테스트로 고정).
 *
 * 규칙 세 가지가 전부다:
 *  ① 브랜드 선택이 있으면 그 브랜드 행만. 단 `brand: null`(공통 프롬프트)은 언제나 남는다.
 *  ② 언어는 ①에 더해 **국가 draft** 로 좁힌다. 국가 draft 가 비면 브랜드 범위 전체.
 *  ③ `lang: null`(언어 태그 없음)은 국가 옵션에만 기여한다 — 언어 옵션에 넣으면 죽은 값이 된다.
 *
 * 둘을 한 함수에서 내는 이유: 국가와 언어가 같은 draft 스냅샷을 봐야 "권역을 눌러
 * 국가가 채워진 순간 언어도 따라온다"가 성립한다(2026-09-04 검수의 요지).
 */
export function deriveMatrixOptions(
  matrix: readonly MeasuredScopeCombo[],
  brandFilter: readonly string[] | null,
  geographyDraft: readonly string[] | undefined,
): { regions: string[]; languages: string[] } {
  const geo = geographyDraft?.length ? new Set(geographyDraft) : null;
  const regions = new Set<string>();
  const languages = new Set<string>();
  for (const r of matrix) {
    if (brandFilter && r.brand !== null && !brandFilter.includes(r.brand)) continue;
    regions.add(r.region);
    if (r.lang && (!geo || geo.has(r.region))) languages.add(r.lang);
  }
  return { regions: [...regions].sort(), languages: [...languages].sort() };
}

export interface MeasuredScopeCombo {
  brand: string | null;
  region: string;
  lang: string | null;
}

// 런타임 동적 필터 축 (프로젝트 커스텀 태그). options = 그 태그에 실제 배정된
// 서로 다른 값들(서버가 distinct로 계산). 값이 없으면 렌더에서 제외된다.
export interface DynamicAxis {
  id: string;
  label: string;
  options: string[];
}

// URL 파라미터 키 — 서버 readProjectCustomFieldFilters와 반드시 동일(`cf_<id>`).
const dynParam = (id: string) => `cf_${id}`;

// Mirrors lib/db/repositories/standards::CatalogTaxonomyRow without dragging
// in a server-only import.
export interface CatalogTaxonomyRow {
  brand: string | null;
  brandPresence: string | null;
  listType: string | null;
  depth1: string | null;
  depth2: string | null;
  depth3: string | null;
  depth4: string | null;
}

// 카탈로그 축(브랜드 유형 + listType/depth 캐스케이드) — catalogRows(프로젝트·
// 스코프별 실데이터)가 오면 그 모집단에 값이 없는 축은 죽은 필터라 숨긴다.
const CATALOG_AXES = new Set<DimensionGroup>([
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
]);
function catalogAxisHasValues(
  g: DimensionGroup,
  rows: CatalogTaxonomyRow[],
): boolean {
  if (g === "brandPresence") return rows.some((r) => r.brandPresence != null);
  if (CASCADE_FIELDS.has(g)) return catalogOptionsFor(g, rows, {}).length > 0;
  return true;
}

// Cascading depth axes (parent chain). promptContext/region/etc. are not
// cascading — kept as static DIMENSIONS lists.
// brand → listType: depth1 (and below) use a different per-brand vocabulary
// under the same numbered slots (2026-07-08 feedback — e.g. depth1 "2." means
// "Human Centered Innovative Luxury" for Genesis but "Innovation & Technology"
// for Hyundai). Without brand as the root ancestor, every brand's variant of
// "2." showed up flattened together with no way to tell them apart. Selecting
// a brand now narrows listType/depth1-4 to just that brand's own values.
const CASCADE_PARENT: Partial<Record<DimensionGroup, DimensionGroup>> = {
  listType: "brand",
  depth1: "listType",
  depth2: "depth1",
  depth3: "depth2",
  depth4: "depth3",
};
const CASCADE_FIELDS = new Set<DimensionGroup>([
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
]);

// 상위 축 → 그 축에 종속된 하위 축들 (2026-09-04 고객 검수).
//
// "상위 카테고리 선택을 취소하면 하위 카테고리 선택도 남으면 안 된다". 카탈로그
// 축(listType/depth)은 pruneCascade 가 **옵션 목록**으로 정리하지만 그것만으로는
// 부족하다 — 부모를 비우면 하위 옵션이 오히려 전부 열리므로 선택이 그대로 살아
// 남는다. 지오/언어 축은 아예 pruneCascade 대상도 아니었다: 브랜드를 고르고
// 권역(중동)을 눌러 국가를 채운 뒤 브랜드를 취소하면, 브랜드도 권역도 없는데
// **국가만 임의로 선택된 채** 남았다(이번 리포트의 직접 증상 — 브랜드가 없으면
// 권역 드롭다운도 사라져 되돌릴 방법조차 없었다).
//
// 그래서 "부모의 선택이 비면 자식 선택도 비운다"를 축 트리로 명시한다.
export const AXIS_CHILDREN: Partial<Record<DimensionGroup, DimensionGroup[]>> = {
  // 브랜드 → 권역·국가(geography) · 언어 · 카탈로그 택소노미 전 계층
  brand: ["geography", "language", "listType", "depth1", "depth2", "depth3", "depth4"],
  // 국가 → 언어 (한 국가가 여러 언어를 갖고, 언어는 국가 안에서만 의미가 있다)
  geography: ["language"],
  listType: ["depth1", "depth2", "depth3", "depth4"],
  depth1: ["depth2", "depth3", "depth4"],
  depth2: ["depth3", "depth4"],
  depth3: ["depth4"],
};

// 한 축의 선택을 **현재 옵션 목록 안**으로 좁힌 draft 를 돌려준다 (2026-09-04
// 고객 검수 2차). clearDescendantsIfEmpty 는 부모가 *비었을 때*만 걸린다 —
// 부모가 비지 않고 **다른 값으로 바뀌는** 경우가 이 함수의 자리다.
//
// 직접 증상: 언어를 고른 뒤 국가를 바꾸면 언어 옵션이 그 국가 것만 남는데 이전
// 언어 선택은 draft 에 그대로 살아, **배지는 "언어 2"인데 드롭다운에는 1개만**
// 보이는 유령 선택이 됐다(해제할 방법도 없다 — 목록에 없으니 클릭할 대상이 없다).
// 카탈로그 축은 pruneCascade 가 같은 일을 하지만 국가·언어는 카탈로그가 아니라
// 측정 매트릭스에서 옵션이 나오므로 그 경로를 못 탄다.
//
// 지울 것이 없으면 **같은 객체**를 돌려준다(불필요한 리렌더 방지).
export function pruneToOptions(
  draft: Draft,
  group: DimensionGroup,
  options: readonly string[] | null | undefined,
): Draft {
  if (!options) return draft; // 옵션을 모르면 건드리지 않는다 (서버 목록 미도착 등)
  const sel = draft[group];
  if (!sel?.length) return draft;
  const allowed = new Set(options);
  const kept = sel.filter((v) => allowed.has(v));
  if (kept.length === sel.length) return draft;
  const next = { ...draft };
  if (kept.length) next[group] = kept;
  else delete next[group];
  return next;
}

// 부모 축의 선택이 비었으면 그 하위 축 선택을 전부 지운 draft 를 돌려준다.
// 비어 있지 않으면 원본 그대로 — 부분 변경은 pruneCascade 가 옵션 기준으로 정리한다.
// 지울 것이 없으면 **같은 객체**를 돌려준다(불필요한 리렌더 방지).
export function clearDescendantsIfEmpty(draft: Draft, group: DimensionGroup): Draft {
  if ((draft[group]?.length ?? 0) > 0) return draft;
  const kids = AXIS_CHILDREN[group];
  if (!kids?.length) return draft;
  let next = draft;
  for (const k of kids) {
    if ((next[k]?.length ?? 0) === 0) continue;
    if (next === draft) next = { ...draft };
    delete next[k];
  }
  return next;
}

// Compute the option list for one cascade axis given catalog rows + the
// active draft of all ancestor selections. Empty parent selection = no
// narrowing (every value visible).
function catalogOptionsFor(
  group: DimensionGroup,
  rows: CatalogTaxonomyRow[],
  draft: Partial<Record<DimensionGroup, string[]>>,
): string[] {
  if (!CASCADE_FIELDS.has(group)) return [];
  const ancestors: DimensionGroup[] = [];
  let p: DimensionGroup | undefined = CASCADE_PARENT[group];
  while (p) {
    ancestors.push(p);
    p = CASCADE_PARENT[p];
  }
  const filtered = rows.filter((r) =>
    ancestors.every((a) => {
      const sel = draft[a] ?? [];
      if (sel.length === 0) return true;
      const v = r[a as keyof CatalogTaxonomyRow];
      return v !== null && sel.includes(v);
    }),
  );
  const seen = new Set<string>();
  for (const r of filtered) {
    const v = r[group as keyof CatalogTaxonomyRow];
    if (v) seen.add(v);
  }
  return [...seen].sort();
}

// Re-prune children whose ancestor selections no longer match. Returns a
// possibly-modified draft (same identity if nothing pruned).
function pruneCascade(
  draft: Partial<Record<DimensionGroup, string[]>>,
  rows: CatalogTaxonomyRow[],
): Partial<Record<DimensionGroup, string[]>> {
  let next = draft;
  let changed = false;
  // listType 도 포함 — 부모(brand)가 바뀌면 그 브랜드에 없는 리스트 타입이
  // 남아 있었다(2026-09-04 검수: "상위 카테고리 취소 시 하위가 남는다").
  for (const lvl of ["listType", "depth1", "depth2", "depth3", "depth4"] as DimensionGroup[]) {
    const sel = next[lvl];
    if (!sel?.length) continue;
    const allowed = new Set(catalogOptionsFor(lvl, rows, next));
    const pruned = sel.filter((v) => allowed.has(v));
    if (pruned.length !== sel.length) {
      if (!changed) {
        next = { ...next };
        changed = true;
      }
      if (pruned.length === 0) delete next[lvl];
      else next[lvl] = pruned;
    }
  }
  return next;
}

// 2026-06-09 redesign (faceted multi-select + Apply): every axis collapses to a
// single compact dropdown button holding a checkbox list, so the bar stays tidy
// no matter how many dimensions show. Selections build up in a LOCAL draft and
// only commit to the URL (→ re-query) when the user presses 적용 — so changing
// several filters issues one navigation, not one per click. URL encodes a value
// list per group: ?geography=US,KR&engine=gemini.

// Option values that read poorly raw (English / lowercase) get a friendly label
// in the checkbox list; the URL still stores the canonical value. Others (US/KR,
// 2026, brand names, and the new HMG 3-stage Korean funnel values like 인지/탐색
// — already readable) display as-is.
const LABELED_VALUES = new Set([
  "owned",
  "external",
  "branded",
  "unbranded",
  // GA4 device / visitor axes — canonical token (matches GA4 API) → i18n label.
  "mobile",
  "desktop",
  "tablet",
  "new",
  "returning",
]);

// Engine: canonical value = scope target token (lowercase); display = proper
// product name. Locale-independent proper nouns (like the geography Intl path),
// so a static map rather than an i18n key. Mirrors result-adapter's TARGET_LABEL.
const ENGINE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  claude: "Claude",
  "claude-web": "Claude",
  "claude-sonnet": "Claude",
  "claude-opus": "Claude",
};

export type Draft = Partial<Record<DimensionGroup, string[]>>;

/**
 * 경쟁사 축이 유효한가 — 출처 카테고리(`?source=`)에 **공식(경쟁사)**가 남아 있을 때만.
 *
 * 2026-09-10 QA 2차 #5(제품 결정 D4): 칩 시절의 규칙(citation-category-chips 의
 * `competitorEnabled`)을 그대로 옮긴 것이다. 미선택(=전체 카테고리)은 공식(경쟁사)를
 * **포함**하므로 활성이다 — 그래서 AXIS_CHILDREN(부모가 비면 자식을 지운다)에
 * `source: ["competitor"]` 를 넣으면 안 된다. 규칙이 정반대다.
 */
export function competitorAxisEnabled(sourceSelection: readonly string[] | undefined): boolean {
  return !sourceSelection?.length || sourceSelection.includes(OFFICIAL_COMPETITOR_CATEGORY);
}

/**
 * 비활성이 된 축의 선택을 draft 에서 걷어낸다 — 드롭다운이 잠긴 채 필터만 남아
 * 되돌릴 수단이 없는 상태를 막는다(칩 시절 `write()` 의 `params.delete("competitor")`).
 * 지울 것이 없으면 **같은 객체**를 돌려준다(불필요한 리렌더 방지).
 */
export function clearAxesDisabledBy(draft: Draft): Draft {
  if (!draft.competitor?.length || competitorAxisEnabled(draft.source)) return draft;
  const next = { ...draft };
  delete next.competitor;
  return next;
}

function parseDraft(
  sp: ReturnType<typeof useSearchParams>,
  groups: DimensionGroup[],
): Draft {
  const d: Draft = {};
  for (const g of groups) {
    const arr = splitFilterValues(sp.get(g));
    if (arr.length) d[g] = arr;
  }
  return d;
}

function draftKey(d: Draft, groups: DimensionGroup[]): string {
  return groups
    .map((g) => `${g}:${[...(d[g] ?? [])].sort().join(FILTER_SEP)}`)
    .join("|");
}

/** 한 축의 선택이 같은가 — 클릭 순서 무관(정렬 후 비교). */
function sameAxis(a?: string[], b?: string[]): boolean {
  return [...(a ?? [])].sort().join(FILTER_SEP) === [...(b ?? [])].sort().join(FILTER_SEP);
}

/**
 * URL(적용본)이 바뀌었을 때 **미적용 draft 를 통째로 버리지 않고 축 단위로 병합**한다
 * (2026-09-08 QA #4·#12).
 *
 * 종전에는 `appliedKey !== baseline` 이면 `setDraft(appliedDraft)` 로 draft 를 URL
 * 값으로 **되돌렸다**. 그래서 패널 밖에서 URL 이 바뀌는 순간(인용 화면의 도메인
 * 카테고리 칩·도넛 조각이 `router.replace` 로 `?source=` 를 쓴다, 축 목록이 늦게
 * 도착해 visibleGroups 가 바뀐다) 사용자가 방금 **해제한 국가가 URL 값으로 다시
 * 선택된 채** 돌아오고("국가 해제 후 재노출"), 고르던 필터를 잃은 채 "적용"을 눌러도
 * 아무 일도 일어나지 않았다("칩 선택 후 적용 불가").
 *
 * 규칙: 그 축의 **URL 값이 실제로 바뀐 축만** 새 값을 받는다. 나머지 축은 사용자가
 * 편집 중인 draft 를 그대로 둔다. 바꿀 것이 없으면 같은 객체를 돌려준다.
 */
export function mergeAppliedDraft(
  draft: Draft,
  prevApplied: Draft,
  nextApplied: Draft,
  groups: readonly DimensionGroup[],
): Draft {
  let next: Draft | null = null;
  for (const g of groups) {
    if (sameAxis(prevApplied[g], nextApplied[g])) continue; // URL 미변경 축 → draft 유지
    if (sameAxis(draft[g], nextApplied[g])) continue; // 이미 같은 값
    next ??= { ...draft };
    const v = nextApplied[g];
    if (v?.length) next[g] = [...v];
    else delete next[g];
  }
  return next ?? draft;
}

// 동적 축(커스텀 태그) draft — fieldId → 선택값들. URL `cf_<id>` 에서 파싱.
type DynDraft = Record<string, string[]>;

function parseDynDraft(
  sp: ReturnType<typeof useSearchParams>,
  axes: DynamicAxis[],
): DynDraft {
  const d: DynDraft = {};
  for (const a of axes) {
    const arr = splitFilterValues(sp.get(dynParam(a.id)));
    if (arr.length) d[a.id] = arr;
  }
  return d;
}

function dynDraftKey(d: DynDraft, axes: DynamicAxis[]): string {
  return axes
    .map((a) => `${a.id}:${[...(d[a.id] ?? [])].sort().join(FILTER_SEP)}`)
    .join("|");
}

/**
 * 적용(commit) 시 URL 에 실릴 쿼리 문자열 — **한 번의 호출이 곧 한 번의 왕복**이다.
 *
 * QA 2차 #5-(b): 종전 인용 화면은 칩·경쟁사 드롭다운이 각자 `router.replace` 를 때려
 * 클릭 수만큼 RSC 왕복이 났다. 축을 패널로 되돌리면 선택은 draft(로컬)에 쌓이고
 * URL 은 `적용` 때 이 함수가 만든 문자열 하나로 한 번만 바뀐다. 순수 함수로 떼어
 * 두어 그 계약을 테스트가 고정한다.
 */
export function buildCommitParams(
  current: URLSearchParams,
  groups: readonly DimensionGroup[],
  draft: Draft,
  axes: readonly DynamicAxis[],
  dyn: DynDraft,
): string {
  const params = new URLSearchParams(current.toString());
  for (const g of groups) {
    const vals = draft[g] ?? [];
    if (vals.length) params.set(g, joinFilterValues(vals));
    else params.delete(g);
  }
  for (const a of axes) {
    const vals = dyn[a.id] ?? [];
    if (vals.length) params.set(dynParam(a.id), joinFilterValues(vals));
    else params.delete(dynParam(a.id));
  }
  return params.toString();
}

/** 동적 축 기본값: 렌더마다 새 배열을 만들면 useMemo 의존성이 매번 바뀐다. */
const EMPTY_DYNAMIC_AXES: DynamicAxis[] = [];

/** 프로미스로 온 축 옵션을 그 facet 하나만 서스펜드시켜 그린다 (competitorOptions). */
function AsyncAxisOptions({
  options,
  render,
}: {
  options: Promise<string[]>;
  render: (options: string[]) => ReactNode;
}) {
  return <>{render(use(options))}</>;
}

const isThenable = (v: unknown): v is Promise<string[]> =>
  typeof (v as { then?: unknown } | null | undefined)?.then === "function";

export function DimensionFilterPanel({
  stage = "overview",
  lockedGroups = [],
  primaryGroups,
  onlyGroups,
  trailing,
  basis,
  asOf,
  asOfSlot,
  footerSlot,
  compact = false,
  sticky = false,
  scope,
  geoSurface = "standard",
  catalogRows: catalogRowsProp,
  geographyOptions: geographyOptionsProp,
  engineOptions: engineOptionsProp,
  brandOptions,
  competitorOptions,
  languageOptions: languageOptionsProp,
  optionMatrix: optionMatrixProp,
  collectionStartDay,
  latestAnchorDay,
  selectableDates,
  regionBrand,
  sections,
  dynamicAxes: dynamicAxesProp,
  lazyOptions,
}: DimensionFilterPanelProps) {
  const t = useTranslations("dashboard.filters");
  // 출처 카테고리 값 라벨 — 화면 전반(뱃지/파이/차트)과 같은 사전을 공유한다.
  const tCat = useTranslations("citationCategories");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // 지연 옵션(D4): 호출부가 넘긴 prop 이 언제나 이기고, 빈 자리만 받아 온 값으로 채운다.
  const lazy = useLazyFilterOptions(lazyOptions, sp);
  const catalogRows = catalogRowsProp ?? lazy.pick("catalogRows");
  const geographyOptions = geographyOptionsProp ?? lazy.pick("geographyOptions");
  const engineOptions = engineOptionsProp ?? lazy.pick("engineOptions");
  const languageOptions = languageOptionsProp ?? lazy.pick("languageOptions");
  const optionMatrix = optionMatrixProp ?? lazy.pick("optionMatrix");
  const dynamicAxes = dynamicAxesProp ?? lazy.pick("dynamicAxes") ?? EMPTY_DYNAMIC_AXES;
  // 아직 안 받아 온(또는 실패한) 지연 옵션이 그 축의 옵션 원천인가. 그 드롭다운은 정적
  // 폴백 목록 대신 불러오는 중·실패 행을 보인다(목록이 도착한 뒤 바뀌어 보이지 않게).
  const lazyPending = lazy.status === "idle" || lazy.status === "loading" || lazy.status === "error";
  const lazyFeeds = (group: DimensionGroup): boolean => {
    if (!lazyPending) return false;
    // 국가·언어는 목록 prop 이나 매트릭스 prop 중 하나라도 넘어왔으면 그 값으로 그린다.
    if (group === "geography")
      return !geographyOptionsProp && !optionMatrixProp && (lazy.wants("geographyOptions") || lazy.wants("optionMatrix"));
    if (group === "language")
      return !languageOptionsProp && !optionMatrixProp && (lazy.wants("languageOptions") || lazy.wants("optionMatrix"));
    if (group === "engine") return !engineOptionsProp && lazy.wants("engineOptions");
    if (CATALOG_AXES.has(group)) return !catalogRowsProp && lazy.wants("catalogRows");
    return false;
  };
  const lazyStatusLabel = (group: DimensionGroup): string | null =>
    lazyFeeds(group) ? (lazy.status === "error" ? t("optionsFailed") : t("optionsLoading")) : null;
  // BCP-47 code → localized language name (en → English / 영어 / …). URL param
  // stays as the raw code so it matches website_prompts.lang_code verbatim.
  const langFmt = useMemo(
    () => new Intl.DisplayNames([locale], { type: "language" }),
    [locale],
  );
  // brand axis policy (2026-06-11):
  // - non-admin: brand IS the user's authorization scope (shown as
  //   AccountScopeChips, server-applied via readStandardFilters from
  //   session.user.scope.brands) → auto-locked out of the dropdowns, even if a
  //   caller passes it in onlyGroups by accident.
  // - admin (scope.all): no brand restriction, so brand is a real selectable
  //   axis. readStandardFilters honors ?brand only for scope.all, so the URL
  //   selection actually narrows the query. Surface it even when a caller's
  //   onlyGroups omits brand (those lists were trimmed when brand became a
  //   fixed per-user scope for everyone).
  const isAdmin = scope?.all === true;
  // 표면별로 본 계정 스코프 — 국가 축 잠금과 스코프 칩만 이것을 본다(geoSurface 주석).
  const viewScope = useMemo(
    () => (scope ? scopeForGeoSurface(scope, geoSurface) : scope),
    [scope, geoSurface],
  );
  const lockSet = useMemo(() => {
    const s = new Set<DimensionGroup>(lockedGroups);
    if (!isAdmin) s.add("brand");
    // 2026-09-04 (GGMD 권한 매트릭스, page 4981000 v16 — 고객 검수): 계정 스코프가
    // 이미 단일 국가로 고정된 계정(국가 담당)에게는 국가 축을 노출하지 않는다 —
    // 고를 것이 하나뿐인 죽은 필터이고, 그 값은 AccountScopeChips 가 이미 보여준다.
    // (권역 담당은 countries 가 비어 있어 국가 축이 그대로 남는다 — 기대 동작.)
    //   HQ      → 권역 · 국가 · 언어 · AI 엔진 · 기간
    //   권역담당 → 국가 · 언어 · AI 엔진 · 기간
    //   국가담당 → 언어 · AI 엔진 · 기간
    if (!isAdmin && viewScope?.countries?.length === 1) s.add("geography");
    return s;
  }, [lockedGroups, isAdmin, viewScope?.countries]);
  const base = useMemo<DimensionGroup[]>(() => {
    const b = onlyGroups ?? ALL_GROUPS;
    if (!isAdmin || b.includes("brand")) return b;
    // Slot brand right after promptContext (the last primary axis) when
    // present; otherwise append.
    const i = b.indexOf("promptContext");
    return i === -1
      ? [...b, "brand"]
      : [...b.slice(0, i + 1), "brand", ...b.slice(i + 1)];
  }, [onlyGroups, isAdmin]);
  const visibleGroups = base.filter((g) => {
    if (lockSet.has(g)) return false;
    // catalogRows(프로젝트·스코프별 실데이터)가 오면 값 없는 카탈로그 축은
    // 죽은 필터라 숨긴다. 미전달(표준 정적 폴백) 시엔 종전대로 전 축 노출.
    if (catalogRows && CATALOG_AXES.has(g)) return catalogAxisHasValues(g, catalogRows);
    return true;
  });
  const visKey = visibleGroups.join(",");

  const stagePrimary = (primaryGroups ?? STAGE_PRIMARY[stage]).filter(
    (g) => visibleGroups.includes(g) && !lockSet.has(g),
  );
  // admin: 브랜드를 최우선(맨 앞) 축으로 노출 — 브랜드→권역→국가 순으로 좁히는
  // 진입점. 비-admin은 브랜드가 lockSet(권한 스코프)이라 애초에 축이 없다.
  const primary: DimensionGroup[] =
    isAdmin && visibleGroups.includes("brand")
      ? ["brand", ...stagePrimary.filter((g) => g !== "brand")]
      : stagePrimary;
  const secondary = visibleGroups.filter((g) => !primary.includes(g));
  const shownGroups = [...primary, ...secondary];

  // Applied (committed-to-URL) state vs. local draft (pending) state.
  const appliedDraft = useMemo(
    () => parseDraft(sp, visibleGroups),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp, visKey],
  );
  const appliedKey = useMemo(
    () => draftKey(appliedDraft, visibleGroups),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appliedDraft, visKey],
  );

  const [draft, setDraft] = useState<Draft>(appliedDraft);
  // 마지막으로 반영한 URL 스냅샷. 키가 아니라 **draft 자체**를 들고 있어야 "어느 축의
  // URL 이 바뀌었는지"를 축 단위로 가릴 수 있다 (mergeAppliedDraft 주석 참고).
  const [applied, setApplied] = useState<Draft>(appliedDraft);
  const baseline = useMemo(
    () => draftKey(applied, visibleGroups),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applied, visKey],
  );
  // Re-sync the draft when the URL changes externally (apply, reset, back nav,
  // 인용 화면의 카테고리 칩). 바뀐 축만 받아 미적용 선택을 잃지 않는다.
  useEffect(() => {
    if (appliedKey !== baseline) {
      setDraft((d) => mergeAppliedDraft(d, applied, appliedDraft, ALL_GROUPS));
      setApplied(appliedDraft);
    }
  }, [appliedKey, baseline, appliedDraft, applied]);

  // 동적 축(커스텀 태그) — 값이 하나라도 배정된 축만 노출/커밋 대상.
  const dynAxes = useMemo(
    () => dynamicAxes.filter((a) => a.options.length > 0),
    [dynamicAxes],
  );
  const dynKey = dynAxes.map((a) => a.id).join(",");
  const appliedDynDraft = useMemo(
    () => parseDynDraft(sp, dynAxes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp, dynKey],
  );
  const appliedDynKey = dynDraftKey(appliedDynDraft, dynAxes);
  const [dynDraft, setDynDraft] = useState<DynDraft>(appliedDynDraft);
  const [dynBaseline, setDynBaseline] = useState(appliedDynKey);
  useEffect(() => {
    if (appliedDynKey !== dynBaseline) {
      setDynDraft(appliedDynDraft);
      setDynBaseline(appliedDynKey);
    }
  }, [appliedDynKey, dynBaseline, appliedDynDraft]);

  const dirty =
    draftKey(draft, visibleGroups) !== appliedKey ||
    dynDraftKey(dynDraft, dynAxes) !== appliedDynKey;
  const appliedActiveCount =
    visibleGroups.filter((g) => (appliedDraft[g]?.length ?? 0) > 0).length +
    dynAxes.filter((a) => (appliedDynDraft[a.id]?.length ?? 0) > 0).length;

  // ISO code → RHQ 권역 group header (활성 브랜드 기준). geography 필터 드롭다운이
  // HQ/region 스코프(40~80 ISO)를 권역으로 묶어 스캔 가능하게 한다. 권역은 brand
  // 의존이라 단일 활성 브랜드일 때만 그룹핑(admin 미선택 → null = 그룹 없음).
  // regionBrand(프로젝트 화면의 고정 브랜드)가 오면 scope와 무관하게 그 브랜드로
  // 권역을 구동 — admin/다중브랜드 뷰어도 프로젝트 안에서는 2-depth를 얻는다.
  // admin(scope.all)은 고정 브랜드가 없으므로, 브랜드 필터에서 단일 브랜드를 적용
  // 하면 그 브랜드가 권역 매핑을 구동한다(브랜드→권역→국가 캐스케이딩).
  // 2026-07-06 피드백: draft(적용 전 선택)를 읽는다 — appliedDraft(URL 커밋본)를
  // 읽으면 "적용"을 눌러야만 권역이 나타나 한 박자 늦었다. 드롭다운에서 체크하는
  // 즉시 반응하도록 draft.brand 기준으로 판정(순수 표시 헬퍼일 뿐 쿼리 필터가
  // 아니므로 draft 단계에서 반응해도 무해하다).
  const adminAppliedBrand = draft.brand ?? [];
  const activeBrand =
    regionBrand ??
    (scope && !scope.all && scope.brands?.length === 1 ? scope.brands[0] : null) ??
    (scope?.all === true && adminAppliedBrand.length === 1
      ? adminAppliedBrand[0]
      : null);
  const regionGroupLabel = (code: string): string | null => {
    // 가상 코드(worldwide/EU/MIDDLEEAST)는 어느 권역에도 안 속해 헤더 없는 빈
    // 그룹으로 목록 맨끝에 밀렸었다(2026-07-29 "worldwide가 안 보인다" 원인) —
    // 전용 그룹 헤더를 줘서 최상단(VIRTUAL_GEO_CODES 정렬과 함께)에 노출한다.
    if (VIRTUAL_GEO_CODES.has(code)) return t("group.globalHub");
    if (!activeBrand) return null;
    // 의사 코드(SA-Dammam 등)는 RHQ 맵에 없다 — 모국(SA)의 권역으로 묶는다.
    const id = rhqForCountry(activeBrand, pseudoCountryParent(code));
    return id ? rhqLabel(id, locale === "en" ? "en" : "ko") ?? null : null;
  };

  // ── 옵션 의존 매트릭스에서 draft 로 파생한 국가·언어 옵션 (2026-09-04) ─────────
  // 서버가 좁혀 준 geographyOptions/languageOptions 는 **적용된 필터** 기준이라
  // draft 와 시점이 어긋난다(prop 주석 참조). 매트릭스가 오면 두 축을 draft 에서
  // 함께 파생시켜 "고르는 중"과 "적용 후"가 같아지게 한다.
  //
  // 브랜드: 비-admin 은 draft.brand 가 늘 비어 있으므로 activeBrand(스코프 유래
  // 단일 브랜드)로 대신 좁힌다 — 카탈로그 캐스케이드가 쓰는 규칙과 같다.
  // brand=null 행(공통 프롬프트)은 어떤 브랜드 선택에서도 남긴다.
  const matrixBrandFilter = useMemo<string[] | null>(() => {
    const picked = draft.brand?.length ? draft.brand : activeBrand ? [activeBrand] : [];
    return picked.length ? picked : null;
  }, [draft.brand, activeBrand]);

  const matrixOptions = useMemo(
    () =>
      optionMatrix?.length
        ? deriveMatrixOptions(optionMatrix, matrixBrandFilter, draft.geography)
        : null,
    [optionMatrix, matrixBrandFilter, draft.geography],
  );
  const matrixGeographyOptions = matrixOptions?.regions ?? null;
  const matrixLanguageOptions = matrixOptions?.languages ?? null;

  // 국가를 바꾸면 언어 옵션이 그 국가 것만 남는다 — 그때 목록 밖으로 밀려난 언어
  // 선택을 draft 에서 함께 지운다 (2026-09-04 고객 검수 2차: 배지는 "언어 2"인데
  // 드롭다운엔 1개만 보이던 유령 선택). 매트릭스가 있을 때만 돈다 — 서버 목록
  // (languageOptions)은 *적용된* 필터 기준이라 draft 와 시점이 어긋나, 그것으로
  // 자르면 아직 적용 전인 정상 선택까지 지워진다.
  //
  // 무한 루프가 아닌 이유: matrixLanguageOptions 는 draft.geography(와 브랜드)에만
  // 의존하고 draft.language 에는 의존하지 않는다.
  useEffect(() => {
    if (!matrixLanguageOptions) return;
    setDraft((d) => pruneToOptions(d, "language", matrixLanguageOptions));
  }, [matrixLanguageOptions]);

  // 국가 축에도 같은 정리 (2026-09-08 QA #4). 브랜드를 바꾸면 측정 국가 목록이
  // 달라지는데(Hyundai 중동 = AE·SA / Kia 중동 = AE·IL) 종전 국가 선택이 draft 에
  // 그대로 남아 **목록에 없는 국가가 선택된 채** 필터에 실려 나갔다 — 드롭다운에
  // 없으니 해제할 방법도 없다(언어 축에서 PR #196 이 고친 것과 같은 결함).
  //
  // 매트릭스가 있을 때만 돈다. 서버 목록(geographyOptions)은 *적용된* 필터 기준이라
  // draft 와 시점이 어긋나 아직 적용 전인 정상 선택까지 지운다.
  // 무한 루프가 아닌 이유: matrixGeographyOptions 는 브랜드에만 의존하고
  // draft.geography 에는 의존하지 않는다(deriveMatrixOptions 의 regions).
  useEffect(() => {
    if (!matrixGeographyOptions) return;
    setDraft((d) => pruneToOptions(d, "geography", matrixGeographyOptions));
  }, [matrixGeographyOptions]);

  // 아래 로직(권역 그룹핑·토글·드롭다운)이 전부 이 하나를 본다 — 목록이 두 벌이면
  // 권역 토글이 채우는 국가와 드롭다운에 보이는 국가가 갈라진다.
  const effectiveGeographyOptions = matrixGeographyOptions ?? geographyOptions;

  // 권역 nav — 어떤 권역을 "펼쳐 보는 중"인지. 국가 드롭다운 목록을 그 권역 하위로
  // 좁히는 데 쓴다. URL 파라미터 없이 로컬 상태만 사용(목록 표시용).
  // 선택 자체는 geography draft 가 갖는다 — handleRhqRegionToggle 주석 참고.
  const [rhqRegionNav, setRhqRegionNav] = useState<string[]>([]);

  // geographyOptions에서 실제로 측정된 권역만 추출 (단일 활성 브랜드 기준).
  // 의사 코드(SA-Dammam 등)는 RHQ 맵에 없으므로 모국(SA)으로 판정한다 — 아래 세 곳
  // (권역 목록·권역 토글의 국가→권역 맵·권역 nav 좁히기) 전부 같은 규칙. 2026-09-05
  // 도시 사이트 분리 직후 "권역 중동을 골라도 사우디가 안 나온다"의 원인이었다.
  const availableRhqRegions = useMemo(() => {
    if (!activeBrand || !effectiveGeographyOptions?.length) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const iso of effectiveGeographyOptions) {
      const id = rhqForCountry(activeBrand, pseudoCountryParent(iso));
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }, [activeBrand, effectiveGeographyOptions]);

  // 활성 브랜드가 바뀌면(예: admin이 브랜드 필터를 교체·해제) 권역 id는 브랜드
  // 접두어(kia-… / hyundai-…)라 이전 선택이 무효 — 권역 nav를 비워 stale 필터를 막는다.
  //
  // 2026-09-04: nav 만 비우는 것으로는 부족했다. 브랜드 → 권역(중동) → 언어 순으로
  // 고른 뒤 **브랜드를 취소하면**, 권역 토글이 채워 넣은 국가들이 geography draft
  // 에 그대로 남아 "고른 적 없는 국가가 임의로 선택된" 상태가 됐다(브랜드가 없으니
  // 권역 드롭다운도 사라져 되돌릴 방법조차 없었다). 브랜드가 **실제로 바뀐 경우에만**
  // 하위 축(국가·언어)을 함께 비운다 — 첫 렌더(URL 복원)에서는 건드리지 않는다.
  const prevActiveBrand = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevActiveBrand.current;
    prevActiveBrand.current = activeBrand;
    setRhqRegionNav([]);
    if (prev === undefined || prev === activeBrand) return; // 첫 렌더 / 변화 없음
    setDraft((d) => {
      if (!(d.geography?.length || d.language?.length)) return d;
      const next = { ...d };
      delete next.geography;
      delete next.language;
      return next;
    });
  }, [activeBrand]);

  const rhqRegionValueLabel = (id: string) =>
    rhqLabel(id, locale === "en" ? "en" : "ko") ?? id;

  // 측정된 ISO → 권역 id (활성 브랜드 기준). 권역 토글 로직의 입력.
  const countryToRhq = useMemo(() => {
    const m = new Map<string, string>();
    if (!activeBrand) return m;
    for (const iso of effectiveGeographyOptions ?? []) {
      const id = rhqForCountry(activeBrand, pseudoCountryParent(iso));
      if (id) m.set(iso, id);
    }
    return m;
  }, [activeBrand, effectiveGeographyOptions]);

  // 권역 토글 = 그 권역의 측정 국가를 geography draft 에 통째로 추가/제거.
  //
  // 2026-07-16: 이전엔 국가 목록을 좁히기만 하고(nav) 선택은 하지 않아서, 권역을
  // 눌러도 geography draft 가 비어 있으면 실제 필터가 안 걸렸다 — 권역을 골랐는데
  // 전 국가 데이터가 그대로 나왔다. 권역을 누르는 의도는 "이 권역으로 보겠다"이지
  // "이 권역 국가 목록을 구경하겠다"가 아니므로, 토글이 곧 선택이 되게 한다.
  //
  // 전이 규칙은 rhq-region-toggle.ts 의 순수 함수가 갖는다(테스트로 고정).
  function handleRhqRegionToggle(regionId: string) {
    // 전이를 먼저 계산하고 두 state 를 각각 set 한다 — setDraft 업데이터 안에서
    // setRhqRegionNav 를 부르면 StrictMode 가 업데이터를 두 번 돌릴 때 nav 도 두 번
    // 토글돼 제자리로 돌아온다(업데이터는 순수해야 한다).
    const next = toggleRhqRegion(
      regionId,
      { nav: rhqRegionNav, geography: draft.geography ?? [] },
      countryToRhq,
    );
    setRhqRegionNav(next.nav);
    // 권역을 끄면 그 권역 국가가 빠진다 — 국가가 전부 비면 하위(언어)도 함께 비운다.
    setDraft((prev) =>
      clearDescendantsIfEmpty({ ...prev, geography: next.geography }, "geography"),
    );
  }

  // Share the apply transition with the page (so the content below dims) when a
  // FilterTransitionProvider wraps us; otherwise fall back to a local one so the
  // Apply button still shows its loading state on standalone screens.
  const shared = useFilterTransition();
  const [localPending, localStart] = useTransition();
  const isPending = shared?.isPending ?? localPending;
  const startTransition = shared?.startTransition ?? localStart;

  // valueLabel resolves a raw URL/draft value to its display string.
  // - geography: ISO 2-letter code → full country name (Germany / 독일 / …)
  //   via Intl.DisplayNames. URL param stays as the ISO code.
  // - engine: canonical token (chatgpt) → product name (ChatGPT) via ENGINE_LABEL.
  // - LABELED_VALUES: translated via i18n dashboard.filters.value.* (owned/external).
  // - everything else (catalog labels, brand names, 인지/탐색 …) is already
  //   display-ready and returns as-is.
  function valueLabel(v: string, group?: DimensionGroup) {
    if (group === "geography") {
      // 가상 코드 → i18n 라벨, 의사 코드 → 정본 라벨, 그 외 → Intl(비표준은 원문).
      // 규칙 정본은 geo-code-label — 계정 스코프 칩과 공유한다. URL 값은 원문 그대로.
      return geoCodeLabel(v, locale, (c) => t(`value.${c}` as "value.worldwide"));
    }
    if (group === "language") {
      try {
        return langFmt.of(v) ?? v;
      } catch {
        return v; // 비표준 코드(예: 지역 슬러그)는 원문 유지
      }
    }
    if (group === "engine") return ENGINE_LABEL[v] ?? v;
    if (group === "source") {
      const slug = citationCategorySlug(v);
      return slug ? tCat(slug) : v;
    }
    return LABELED_VALUES.has(v) ? t(`value.${v}`) : v;
  }

  function commit(next: Draft, nextDyn: DynDraft) {
    const qs = buildCommitParams(sp, visibleGroups, next, dynAxes, nextDyn);
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  // 드래프트 핸들러 — 본문은 filter-draft-actions.ts 가 갖는다. "적용 전에는 URL 왕복
  // 0" 을 렌더러 없이 테스트로 고정하기 위한 분리다(2026-09-11 검증 B3: toggle 안에
  // commit 을 심는 뮤테이션이 37/37 통과했다). 여기서 `commit` 은 **넘겨주기만** 하고
  // 직접 부르지 않는다 — 호출권은 팩토리의 `apply` 하나뿐이다.
  const { toggleValue, clearGroup, toggleDyn, clearDyn, apply } = createFilterDraftActions<
    Draft,
    DynDraft
  >({
    setDraft,
    setDynDraft,
    // 축 하나가 바뀐 뒤의 정규화 — 캐스케이드 prune(부모 축 변경 시 유효하지 않게 된
    // 하위 선택 제거) → 부모가 비면 하위 축도 비움(AXIS_CHILDREN) → 축이 통째로
    // 비활성이 된 경우(출처 카테고리에서 공식(경쟁사) 제외)의 선택 회수. 마지막 것은
    // AXIS_CHILDREN 과 방향이 반대라 별도 규칙이다.
    normalizeDraft: (next, group) => {
      const g = group as DimensionGroup;
      const pruned =
        catalogRows && (CASCADE_FIELDS.has(g) || g === "brand")
          ? pruneCascade(next, catalogRows)
          : next;
      return clearAxesDisabledBy(clearDescendantsIfEmpty(pruned, g));
    },
    readDraft: () => ({ draft, dyn: dynDraft }),
    commit,
  });

  function resetAll() {
    setDraft({});
    setDynDraft({});
    // 권역 nav 도 함께 비운다 — 안 그러면 전체 초기화 후에도 국가 드롭다운이 이전
    // 권역 하위로 좁혀진 채 남는다(필터는 비었는데 고를 수 있는 국가는 일부뿐).
    setRhqRegionNav([]);
    const params = new URLSearchParams(sp.toString());
    for (const g of ALL_GROUPS) params.delete(g);
    for (const a of dynAxes) params.delete(dynParam(a.id));
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  // Renders one filter axis (dropdown / date-range control). Extracted from the
  // toolbar so the sectioned layout (sections prop) reuses the same rendering.
  function renderGroup(group: DimensionGroup) {
    // 기간(time) 축 — 값 리스트가 아닌 날짜 범위 선택 (프리셋 + from/to).
    // 같은 draft/적용 흐름을 타고 ?time=YYYY-MM-DD..YYYY-MM-DD 로 커밋된다.
    if (group === "time") {
      return [
        <TimeRangeFilter
          key={group}
          label={t(`group.${group}`)}
          clearLabel={t("clearAxis")}
          minDay={collectionStartDay ? isoDay(new Date(collectionStartDay)) : null}
          endDay={latestAnchorDay ?? null}
          selectableDates={selectableDates}
          value={draft.time?.[0] ?? null}
          onChange={(encoded) =>
            setDraft((prev) => ({ ...prev, time: encoded ? [encoded] : [] }))
          }
        />,
      ];
    }
    // 경쟁사 축 — 호출부가 실옵션을 준 화면(표준 인용)만 이 경로를 탄다. 옵션이
    // 프로미스면 그 facet 하나만 서스펜드시킨다(필터바 전체가 집계를 기다리지 않게).
    if (group === "competitor" && competitorOptions !== undefined) {
      const enabled = competitorAxisEnabled(draft.source);
      // 옵션은 **적용된** `?source=` 를 태운 인용 집계에서 온다(citation/page.tsx).
      // 그래서 공식(경쟁사)를 빼고 적용하면 옵션이 빈 배열로 도착하는데, 그때도
      // "빈 옵션 → 축 제거" 를 적용하면 D4 의 비활성+힌트가 **드래프트 창에서만**
      // 보이고 적용·새로고침 후에는 축이 통째로 사라진다(2026-09-11 검증 B1 실측).
      //   → 제거 규칙은 **적용된 출처가 경쟁사 도메인을 허용할 때만** 쓴다. 그 경우의
      //     빈 옵션은 진짜 죽은 필터(인용 데이터 없음)다. 반대로 사용자가 스스로
      //     제외한 경우는 이유를 읽을 수 있게 비활성으로 남긴다.
      //   → 판정을 draft 가 아니라 applied 로 하는 이유: 드래프트에서 공식(경쟁사)를
      //     다시 체크하면 enabled 는 즉시 true 가 되지만 옵션은 적용 전까지 빈 채라,
      //     draft 로 판정하면 체크하는 순간 축이 사라졌다 적용 후 돌아온다.
      // 기각한 대안 — 옵션을 소스 필터 없는 별도 집계로 뽑아 "옵션이 비지 않게" 하기:
      // sourceCategory 는 집계 캐시 키(STANDARD_FILTER_ARRAY_AXES)라 `?source=` 가
      // 걸릴 때마다 무거운 인용 집계가 한 번 더 돈다(maxDuration 120 화면). 성능 회귀.
      const keepAsDisabledAxis = !competitorAxisEnabled(appliedDraft.source);
      const facetFor = (options: string[]) =>
        options.length === 0 && !keepAsDisabledAxis ? null : (
          <FacetedFilter
            key={group}
            label={t(`group.${group}`)}
            options={options}
            selected={draft[group] ?? []}
            // 값이 도메인 문자열이라 번역하지 않는다(칩 시절과 동일).
            valueLabel={(v) => v}
            clearLabel={t("clearAxis")}
            searchPlaceholder={t("searchPlaceholder")}
            onToggle={(v) => toggleValue(group, v)}
            onClear={() => clearGroup(group)}
            disabled={!enabled}
            disabledHint={t("competitorNeedsOfficialCompetitor")}
            onOpen={lazy.request}
          />
        );
      if (isThenable(competitorOptions)) {
        return [
          <Suspense
            key={group}
            fallback={<div key="skeleton" className="facet-chip h-8 w-24 shrink-0 animate-pulse rounded-md bg-muted" />}
          >
            <AsyncAxisOptions options={competitorOptions} render={facetFor} />
          </Suspense>,
        ];
      }
      const el = facetFor(competitorOptions);
      return el ? [el] : [];
    }
    // Option source per axis:
    // - cascade (listType / depth1-4): catalogRows narrowed by parent draft.
    // - geography: geographyOptions (DISTINCT scope_answers.region, scope-narrowed),
    //   further narrowed by rhqRegionNav when a 권역 is selected.
    // - everything else: static DIMENSIONS.
    let opts: readonly string[];
    if (catalogRows && CASCADE_FIELDS.has(group)) {
      // brand-locked users (non-admin) never touch a "brand" FacetedFilter —
      // draft.brand stays empty for them — so fall back to activeBrand (their
      // scope-derived or admin-applied single brand) to still narrow
      // listType/depth1-4 to that brand's own vocabulary.
      const catalogDraft = activeBrand ? { ...draft, brand: [activeBrand] } : draft;
      opts = catalogOptionsFor(group, catalogRows, catalogDraft);
    } else if (group === "geography" && effectiveGeographyOptions) {
      const narrowed =
        rhqRegionNav.length > 0 && activeBrand
          ? effectiveGeographyOptions.filter((iso) => {
              const id = rhqForCountry(activeBrand, pseudoCountryParent(iso));
              return id ? rhqRegionNav.includes(id) : false;
            })
          : effectiveGeographyOptions;
      // 가상 코드 → 대한민국 → 나머지. 가상 코드를 앞으로 빼는 이유는 알파벳
      // 정렬로는 worldwide 가 목록 맨끝(사실상 안 보이는 위치)에 밀리기 때문이고
      // (regionGroupLabel 의 글로벌·허브 헤더와 세트), 대한민국은 2026-09-04
      // 고객 요청이다. 규칙 정본은 orderGeographyOptions.
      opts = orderGeographyOptions(narrowed);
    } else if (group === "language" && (matrixLanguageOptions ?? languageOptions)) {
      opts = matrixLanguageOptions ?? languageOptions!;
    } else if (group === "engine" && engineOptions) {
      opts = engineOptions;
    } else if (group === "brand" && brandOptions) {
      opts = brandOptions;
    } else {
      opts = DIMENSIONS[group];
    }
    // 지연 옵션이 이 축의 원천인데 아직 없으면 정적 폴백을 보이지 않는다(불러오는 중 행).
    const statusLabel = lazyStatusLabel(group);
    if (statusLabel) opts = [];

    // 권역 pre-filter: 측정된 권역이 2개 이상이고 단일 브랜드 스코프일 때
    // 국가 드롭다운 앞에 권역 필터를 삽입해 캐스케이딩 UX 제공.
    // 권역 체크 표시 = 국가 draft 파생. nav(펼침)가 아니라 실제 선택을 바라본다
    // (2026-08-12 피드백 — 표시·토글·데이터가 전부 국가 집합 하나를 본다).
    // 2026-09-01: 선택/해제 2단계 — 국가가 하나라도 선택된 권역은 체크(✓)로 보이고
    // 다시 누르면 해제된다. 직전엔 완전 선택=✓ / 부분 선택=indeterminate(–) 라
    // 사용자가 전체선택 → 일부선택 → 해제의 3단계를 겪었다(제품 결정로 2단계화).
    // 부분 선택을 "관여 중"으로 유지한다는 2026-08-31 의도는 체크 표시로 흡수된다.
    const geoDraftSel = group === "geography" ? (draft.geography ?? []) : [];
    const selectedRegions =
      group === "geography"
        ? availableRhqRegions.filter((id) =>
            isRegionSelected(id, geoDraftSel, countryToRhq),
          )
        : [];
    // 권역 담당(스코프 권역 1개)에게는 권역 축도 죽은 필터 — 숨긴다. 보통
    // availableRhqRegions 가 이미 1개라 아래 조건에서 걸러지지만, 스코프에서
    // 직접 판정해 두면 옵션 파생 경로가 바뀌어도 노출 규칙이 흔들리지 않는다.
    const rhqAxisPinned = !isAdmin && (scope?.regions?.length ?? 0) === 1;
    const rhqFilterEl =
      group === "geography" && !rhqAxisPinned && availableRhqRegions.length > 1 ? (
        <FacetedFilter
          key="__rhqRegion"
          label={t("group.rhqRegion")}
          options={availableRhqRegions}
          selected={selectedRegions}
          valueLabel={rhqRegionValueLabel}
          clearLabel={t("clearAxis")}
          searchPlaceholder={t("searchPlaceholder")}
          onToggle={handleRhqRegionToggle}
          // 권역 토글이 곧 국가 선택이므로, 권역 지우기도 그 선택을 함께 걷어낸다.
          // nav 만 비우면 목록은 전 국가로 넓어지는데 필터엔 이전 권역 국가가 남아
          // "권역을 지웠는데 그 권역만 나온다"가 된다.
          onClear={() => {
            setRhqRegionNav([]);
            clearGroup("geography");
          }}
          onOpen={lazy.request}
        />
      ) : null;

    const countryEl = (
      <FacetedFilter
        key={group}
        label={t(`group.${group}`)}
        options={opts}
        selected={draft[group] ?? []}
        valueLabel={(v) => valueLabel(v, group)}
        clearLabel={t("clearAxis")}
        searchPlaceholder={t("searchPlaceholder")}
        // 권역이 선택된 경우 이미 단일 권역 국가만 표시되므로 그룹핑 불필요.
        // 미선택 시 HQ/region 스코프(40~80개 ISO)를 권역 헤더로 묶어 스캔 가능하게.
        groupBy={group === "geography" && rhqRegionNav.length === 0 ? regionGroupLabel : undefined}
        onToggle={(v) => toggleValue(group, v)}
        // 그룹 헤더 클릭 = 그 권역(또는 글로벌·허브) 국가 일괄 토글. 권역
        // 드롭다운(handleRhqRegionToggle)과 동일하게 국가 draft 하나만 수정한다 —
        // 이전엔 헤더가 클릭해도 무반응인 라벨이라 "중동을 눌렀는데 아무 일도
        // 없다"는 혼란이 있었다(2026-08-21 사용자 리포트).
        onToggleMany={
          group === "geography" && rhqRegionNav.length === 0
            ? (values, select) =>
                setDraft((prev) => {
                  const cur = new Set(prev.geography ?? []);
                  values.forEach((v) => (select ? cur.add(v) : cur.delete(v)));
                  return clearDescendantsIfEmpty(
                    { ...prev, geography: [...cur] },
                    "geography",
                  );
                })
            : undefined
        }
        onClear={() => clearGroup(group)}
        onOpen={lazy.request}
        statusLabel={statusLabel}
        statusBusy={lazy.status !== "error"}
      />
    );

    return rhqFilterEl ? [rhqFilterEl, countryEl] : [countryEl];
  }

  // 동적 축(커스텀 태그) 하나 렌더 — 고정 축과 같은 FacetedFilter(다중 선택).
  // 값은 태그 원문이라 라벨 변환 없음.
  function renderDynAxis(axis: DynamicAxis) {
    return (
      <FacetedFilter
        key={`dyn:${axis.id}`}
        label={axis.label}
        options={axis.options}
        selected={dynDraft[axis.id] ?? []}
        valueLabel={(v) => v}
        clearLabel={t("clearAxis")}
        searchPlaceholder={t("searchPlaceholder")}
        onToggle={(v) => toggleDyn(axis.id, v)}
        onClear={() => clearDyn(axis.id)}
        onOpen={lazy.request}
      />
    );
  }
  const hasDyn = dynAxes.length > 0;

  const applyResetEl = (
    <div className="flex shrink-0 items-center gap-2">
      <Button
        type="button"
        size="sm"
        onClick={apply}
        disabled={!dirty || isPending}
        className="h-8"
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Check className="h-3.5 w-3.5" aria-hidden />
        )}
        {isPending ? t("applying") : t("apply")}
      </Button>
      {appliedActiveCount > 0 || dirty ? (
        <button
          type="button"
          onClick={resetAll}
          className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("reset")}
        </button>
      ) : null}
    </div>
  );
  const trailingEl = trailing ? (
    <div className="ml-auto w-full sm:w-auto">{trailing}</div>
  ) : null;

  // 섹션 행 (sections prop) — 노출 축만 남기고, 어느 섹션에도 배정되지 않은
  // 노출 축(예: admin 자동 삽입 brand)은 첫 행 앞에 붙인다. 빈 행은 숨김.
  const sectionRows = (() => {
    if (!sections?.length) return null;
    const assigned = new Set(sections.flatMap((s) => s.groups));
    const rows = sections.map((s) => ({
      id: s.id,
      groups: s.groups.filter((g) => shownGroups.includes(g)),
    }));
    const unassigned = shownGroups.filter((g) => !assigned.has(g));
    if (unassigned.length && rows.length) {
      rows[0] = { ...rows[0], groups: [...unassigned, ...rows[0].groups] };
    }
    return rows.filter((r) => r.groups.length > 0);
  })();

  return (
    <div
      aria-label={t("groupLabel")}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 shadow-soft",
        // top-24 = header h-14 + beta-notice banner h-10 (see beta-notice.tsx).
        // z-20 = 본문 레이어 — 크롬(z-30)보다 항상 아래다.
        sticky && "sticky top-24 z-20",
        // 피그마 2행: 행 라벨·칩 여백을 줄여 프롬프트 필터 6칩 + 적용 버튼이 한 줄에 든다
        // (프리뷰 실측: 기본 여백이면 적용이 3번째 줄로 wrap). 칩 클래스는 facet-chip.
        compact && "[&_.facet-chip]:px-2 [&_.facet-chip]:gap-1 [&_[data-section-label]]:w-24 [&_[data-section-row]]:gap-1.5",
      )}
    >
      {/* 2026-07-24: 측정 기준일 — 필터 최상단 단독 행(고객요구). basis 행보다
          위. 스코프에 측정이 있을 때만 노출. */}
      {compact ? null : asOfSlot ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-2">
          {asOfSlot}
        </div>
      ) : asOf ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-2">
          <AsOfChip date={asOf} />
        </div>
      ) : null}

      {/* 2026-06-18: measurement-basis row — the time-series bucket basis
          (주/일) sits at the very top, above scope + value filters. Hidden
          when no basis slot is passed (non-timeseries callers). */}
      {basis && !compact ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-2">
          {basis}
        </div>
      ) : null}

      {/* 2026-06-11: scope strip — own row above the filter axes so the
          toolbar never wraps to two lines on narrower screens. read-only,
          informational. Hidden when scope omitted (legacy callers). */}
      {scope && !compact ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-2">
          <AccountScopeChips scope={viewScope ?? scope} />
        </div>
      ) : null}

      {sectionRows ? (
        <>
          {sectionRows.map((row, i) => (
            <div
              key={row.id}
              data-section-row
              className={cn(
                "flex flex-wrap items-center gap-2",
                i > 0 && "border-t border-border/60 pt-2",
              )}
            >
              <span data-section-label className="inline-flex w-28 shrink-0 items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {i === 0 ? (
                  <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                ) : null}
                {t(`section.${row.id}`)}
              </span>
              {row.groups.flatMap(renderGroup)}
              {/* apply/reset ride the last row (태그 행이 있으면 그쪽으로 넘김) */}
              {i === sectionRows.length - 1 && !hasDyn ? applyResetEl : null}
              {i === 0 ? trailingEl : null}
            </div>
          ))}
          {/* 동적 축(커스텀 태그) 전용 행 — 프로젝트마다 다른 태그를 동적으로 노출 */}
          {hasDyn ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
              <span className="inline-flex w-28 shrink-0 items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {sectionRows.length === 0 ? (
                  <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                ) : null}
                {t("section.tag")}
              </span>
              {dynAxes.map(renderDynAxis)}
              {applyResetEl}
              {sectionRows.length === 0 ? trailingEl : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            {t("filterLabel")}
          </span>

          {shownGroups.flatMap(renderGroup)}
          {dynAxes.map(renderDynAxis)}
          {applyResetEl}
          {trailingEl}
        </div>
      )}

      {/* 박스 내부 추가 행 — 필터 행들과 같은 구분선 규약(border-t border-border/60 pt-2). */}
      {footerSlot ? (
        <div className="border-t border-border/60 pt-2">{footerSlot}</div>
      ) : null}

      {/* 기본 조회 범위 안내 — 필터 미선택 시 무엇이 조회되는지 명시
          (2026-08-06 고객 피드백: 기본 조회 범위 불명확). 권한 범위 자체는 위
          scope strip(AccountScopeChips)이 보여주므로 여기서는 규칙만 서술.
          2026-09-10 QA 2차 #5-(b) 고객 요청 — **박스의 가장 마지막 요소**여야 한다
          (다른 필터 행·슬롯보다 아래). 이 블록을 늘 마지막 자식으로 유지할 것. */}
      {appliedActiveCount === 0 && !dirty ? (
        <p className="text-xs text-muted-foreground">{t("defaultScopeHint")}</p>
      ) : null}
    </div>
  );
}

// Faceted filter — one compact dropdown button per axis. The button shows the
// group name + a count badge when values are selected; clicking opens a checkbox
// list (stays open on pick for fast multi-select) with a "선택 해제" footer.
//
// Two scale knobs (added for HQ/region scopes where geography reaches ~80 ISO
// codes — flat dropdown overflows and finding a country becomes painful):
//  - `groupBy(v)` → optional header label. Items are bucketed by header in
//    the order they first appear. Used by the geography axis to group ISO
//    codes by 권역.
//  - search input — auto-shown when `options.length >= 8`. Filters by both
//    raw value and `valueLabel(v)` (so "Germany"/"독일"/"DE" all match).
// biweekly = 2주간(최근 14일) — GGMD-54(2026-09-16). 주간·월간과 같은 트레일링 창 규칙.
//
// 프리셋은 **트레일링 창 4종뿐**이다(제품 책임자 2026-09-20). 달력 프리셋 넷(이번 달·지난달·
// 이번 주·지난주)은 선택지에서 내렸다. 달력 월·주 **비교**(MoM·WoW)는 그대로 살아 있다:
// 비교 모양은 프리셋 이름이 아니라 **URL 날짜쌍의 모양**으로 판정하기 때문이다
// (`lib/kpi/period-compare-week.ts::resolveComparePeriodShape`). 고객이 달력에서 1일~말일
// 이나 월~일을 직접 고르면, 그리고 그렇게 공유된 옛 URL 도, 여전히 MoM·WoW 를 받는다.
export type TimePreset = "weekly" | "biweekly" | "monthly" | "yearly";

/** 로컬 캘린더 기준 YYYY-MM-DD (toISOString 은 UTC라 KST 자정 부근에 하루 밀린다). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` → 로컬 캘린더 Date. `new Date("2026-09-13")` 은 UTC 파싱이라 KST 에서 하루 밀린다. */
function dayToLocalDate(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * 기간 프리셋의 실제 범위 — **끝점까지** 최근 7일 / 14일 / 30일 / 1년. 순수 함수(테스트 대상).
 *
 * ── 끝점 (GGMD-107 C2) ─────────────────────────────────────────────────────
 * 끝점은 브라우저의 오늘이 아니라 **그 표면의 최신 노출 회차 앵커일 `E`** 다
 * (스펙 `period-comparison-delta`「기간 비교 창은 최신 노출 회차 앵커일을 끝점으로
 * 삼는다」). 값의 창과 Δ 의 현재 창이 같은 `(dateFrom,dateTo)` 에서 나와야 하기
 * 때문이다 — 끝점만 오늘로 두면 카드 값(오늘 기준)과 Δ(앵커 기준)가 서로를 설명하지
 * 못한다(design §1-3 B 안 기각 근거: 76.27% vs 74.57%).
 *
 * `end` 는 `YYYY-MM-DD`(서버가 해소한 `E`) 또는 `Date`(폴백용 오늘)를 받는다.
 * **해소할 수 없으면(`null`) 오늘로 폴백** = 종전 동작 그대로.
 *
 * `minDay`(데이터 수집 시작일)가 주어지면 시작일을 그 날로 **클램프**한다(QA #19·#20):
 * 수집 이전 구간을 요구해 봐야 빈 창이고, 캘린더 `min` 과도 어긋난다. 다만 수집
 * 시작일이 종료일 이후면(=창이 무너지면) 클램프하지 않는다 — 시작일과 종료일이
 * 같아지는 퇴화 범위를 만들지 않기 위해서다.
 * (클램프는 **현재 창에만** 적용된다. 직전 창에 걸면 길이가 달라져 비교가 깨진다 —
 *  그 판정은 순수 계층 `resolveWindows`/`start_window` 소관이다.)
 */
export function presetRange(
  preset: TimePreset,
  end: Date | string | null | undefined,
  minDay?: string | null,
  now: Date = new Date(),
): { from: string; to: string } {
  const endDate =
    typeof end === "string" ? dayToLocalDate(end) : end instanceof Date ? end : null;
  const to = new Date(endDate ?? now);
  const from = new Date(to);
  if (preset === "weekly") from.setDate(to.getDate() - 6);
  else if (preset === "biweekly") from.setDate(to.getDate() - 13);
  else if (preset === "monthly") from.setDate(to.getDate() - 29);
  else from.setFullYear(to.getFullYear() - 1);
  const toDay = isoDay(to);
  let fromDay = isoDay(from);
  if (minDay && fromDay < minDay && minDay < toDay) fromDay = minDay;
  return { from: fromDay, to: toDay };
}

/**
 * 드롭다운에 그리는 프리셋 순서: 트레일링 창 4종. **앵커 축 on/off 가 같은 목록**이다.
 *
 * 종전에는 축이 켜진 화면에만 달력 주 둘이 더 붙는 별도 목록(`ANCHORED_TIME_PRESET_ORDER`)
 * 이 있었다. 달력 프리셋을 전부 내린 뒤로는 두 목록이 같아져 분기를 지웠다.
 */
export const TIME_PRESET_ORDER: readonly TimePreset[] = [
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
];

export interface TimeRangeView {
  /**
   * 화면에 보여 주고 커밋할 범위 = **URL 원 범위 그대로**.
   *
   * ⚠️ 종전에는 여기가 스냅된 값이었다(검증 B1·B2·W2). 그 설계의 대가가 셋이었다:
   *   · 서버 술어는 원 범위로 도는데 칩은 스냅값을 보여 줘 **고르지도 않은 회차가
   *     선택된 것처럼** 읽혔다
   *   · 달력 월·주 프리셋이 스냅되면서 `2026-08-01..08-31` 이 `08-24..08-31` 이 되고,
   *     비교 모양 판정이 `calendarMonth`/`calendarWeek` 를 못 읽었다(MoM·WoW 소실)
   * 기간 술어는 `round_date BETWEEN` 이라 원 범위로도 **같은 회차 집합**을 고른다.
   * 스냅은 정확성에 기여하지 않는다.
   */
  range: { from?: string; to?: string };
  /** URL·입력으로 들어온 원래 값. 지금은 `range` 와 같다(계약을 남겨 둔다). */
  requested: { from?: string; to?: string };
  /** 원 범위가 회차 격자 위에 있지 않다(= 스냅을 **제안**할 수 있다). */
  didSnap: boolean;
  /** 가장 가까운 회차로 맞춘 범위. 제안용이고 자동 적용하지 않는다. `null` = 제안 없음. */
  suggested: { from?: string; to?: string } | null;
  /** 선택 가능한 날짜 목록이 있는가(= 앵커 축 경로인가). */
  anchored: boolean;
  /** 실효 범위 안의 회차 수. 종전 경로에서는 `null`(셀 수 없다). */
  rounds: number | null;
  /**
   * **기간 미선택일 때 화면이 보는 회차** = 목록의 가장 최신 날짜.
   *
   * 축이 켜지면 기간 없는 기본 화면이 "노출 가능한 가장 최신 `round_date` 한 회차"
   * 다(집계층 `anchorLatestRoundClause`). 달력이 그 날을 표시해야 카드의 숫자와
   * 화면이 서로를 설명한다. 선택이 있으면 `null`(그 선택이 정본).
   * 종전 경로에서도 `null` 이다 — 기본 화면의 정의가 다르다(run 창).
   */
  defaultDay: string | null;
  /** 프리셋별 커밋값. `null` = 그 창에 회차가 없다 → 비활성 + 사유 툴팁. */
  presets: { preset: TimePreset; encoded: string | null }[];
}

/**
 * 기간 축 드롭다운의 **순수 뷰 모델** — 라딕스 메뉴는 닫혀 있으면 내용을 렌더하지
 * 않아 정적 마크업으로 검사할 수 없다. 그래서 분기를 전부 여기로 모아 테스트한다.
 *
 * `selectableDates` 가 비면(`undefined`·빈 배열) **종전 계산을 그대로** 돌려준다:
 * 스냅 없음 · 프리셋은 `presetRange(preset, endDay ?? now, minDay)` · `rounds` 는 null.
 */
export function resolveTimeRangeView(args: {
  value: string | null;
  minDay?: string | null;
  endDay?: string | null;
  selectableDates?: readonly string[];
  /** 앵커 축의 "오늘"(KST). 종전 경로에서는 쓰이지 않는다. */
  todayKst: string;
  /** 종전 경로의 끝점 폴백 — 브라우저 로컬 달력의 오늘. */
  now: Date;
}): TimeRangeView {
  const { value, minDay, endDay, todayKst, now } = args;
  const requested = parseTimeRange(value) ?? {};
  const dates = normalizeSelectableDates(args.selectableDates ?? []);
  const anchored = dates.length > 0;

  if (!anchored) {
    return {
      range: requested,
      requested,
      didSnap: false,
      suggested: null,
      anchored: false,
      rounds: null,
      defaultDay: null,
      presets: TIME_PRESET_ORDER.map((preset) => ({
        preset,
        encoded: encodeTimeRange(presetRange(preset, endDay ?? now, minDay))!,
      })),
    };
  }

  // 원 범위를 **그대로** 쓴다.
  const range = requested;
  const rounds = countRounds(dates, range.from, range.to);
  // ⚠️ 제안은 **그 범위에 회차가 하나도 없을 때만** 한다(검증 N4). 종전에는 "양 끝이
  //    회차 날짜가 아니다" 만 보고 제안했는데, 그러면 달력 월 범위(1일~말일)를 고르는
  //    순간 매번 배너가 뜨고 그 버튼을 누르면 회차 날짜쌍이 되어 **방금 고른 MoM 이
  //    창 비교로 떨어졌다**. 회차가 하나라도 걸리면 화면은 정상이므로 말을 걸지 않는다.
  const empty = Boolean(range.from || range.to) && rounds === 0;
  // ⚠️ 제안은 **하루가 아니라 그 회차가 속한 주**다(2026-09-20 프리뷰 실측). 하루 창을
  //    적용하면 직전 구간도 하루가 되어 카드 5개의 증감이 전부 `―` 가 된다. 주 창이면
  //    `calendarWeek` 으로 읽혀 WoW 가 산다. 정본은 `suggestWeekWindow` 머리 주석.
  const suggested = empty ? suggestWeekWindow(requested, dates) : null;
  return {
    range,
    requested,
    didSnap: suggested !== null,
    suggested,
    anchored: true,
    rounds,
    // 아무것도 안 골랐을 때만. 목록은 오름차순이라 마지막이 최신 회차다.
    defaultDay: range.from || range.to ? null : (dates[dates.length - 1] ?? null),
    // ⚠️ **프리셋은 종류를 불문하고 스냅하지 않는다**(검증 B1·B2·N3). 원본 창을 그대로
    //    URL 에 싣는다. 기간 술어가 `round_date BETWEEN` 이라 원본 창으로도 **같은 회차
    //    집합**을 고르므로 스냅은 정확성에 기여하지 않는데, 대가는 셋이나 됐다:
    //      · 달력 월·주 프리셋이 경계 리터럴(월 1일 / 월요일)을 잃어 MoM·WoW 가 죽었다
    //        (그 프리셋들은 2026-09-20 에 내렸지만, 스냅이 경계를 먹는 성질은 그대로다:
    //         사용자가 달력에서 직접 고른 1일~말일·월~일도 같은 대가를 치른다)
    //      · 웹사이트(금요일 귀속)의 "주간(최근 7일)" 이 **금요일 하루**로 붕괴해
    //        직전 창이 1일이 되고 Δ 가 `no_prev` 로 억제된다
    //      · 글로벌(월요일 귀속)에서 "주간" 과 "이번 주" 가 **같은 URL** 이 되어
    //        드롭다운에 체크가 둘 붙고, 그 URL 이 `calendarWeek` 으로 읽혀 축 off 에는
    //        없던 누락 30% 임계가 새로 걸렸다(= Δ 가 숫자에서 "―" 로 바뀐다)
    //    스냅은 이제 "URL 범위에 회차가 **하나도 없을 때**의 이동 제안" 에만 남는다.
    //
    //    비활성 판정은 그대로다 — 창 안에 회차가 없으면 고를 수 없다(고르면 빈 화면).
    presets: TIME_PRESET_ORDER.map((preset) => {
      const raw = presetWindowKst(preset, endDay, minDay, todayKst);
      const hasRound = snapPresetWindow(raw, dates) !== null;
      return { preset, encoded: hasRound ? encodeTimeRange(raw) : null };
    }),
  };
}

// 기간(time) 축 드롭다운 — 프리셋(주간/2주간/월간/연간 = 오늘까지 최근 7일/14일/30일/1년)
// 또는 직접 from/to 날짜 선택. 값은 encodeTimeRange 한 단일 문자열로 draft.time
// 에 담겨 다른 축과 같은 적용/초기화 흐름을 탄다. 한쪽만 채우면 open-ended.
function TimeRangeFilter({
  label,
  clearLabel,
  value,
  onChange,
  minDay,
  endDay,
  selectableDates,
}: {
  label: string;
  clearLabel: string;
  value: string | null;
  onChange: (encoded: string | null) => void;
  /**
   * 회차가 있는 날짜 목록(KST, 오름차순). `undefined`·빈 배열이면 **종전 동작**
   * (네이티브 날짜 입력 · 모든 날짜 선택 가능 · 프리셋 스냅 없음).
   */
  selectableDates?: readonly string[];
  /** 데이터 수집 시작일(YYYY-MM-DD) — 그 이전은 고를 수 없다(QA #20). 없으면 무제한. */
  minDay?: string | null;
  /**
   * 프리셋의 **끝점** `E` = 그 표면의 최신 노출 회차 앵커일(YYYY-MM-DD, UTC 일).
   * 없으면 오늘 = 종전 동작 (GGMD-107 C2).
   */
  endDay?: string | null;
}) {
  const t = useTranslations("dashboard.filters.timeRange");

  // ── 앵커 축 경로 (스펙 §5.1) ───────────────────────────────────────────────
  // 분기는 전부 순수 뷰 모델(`resolveTimeRangeView`)에 있다. 목록이 비면 그 함수가
  // 종전 계산을 그대로 돌려주므로 아래 렌더도 종전 경로만 탄다.
  const dates = useMemo(
    () => normalizeSelectableDates(selectableDates ?? []),
    [selectableDates],
  );
  // KST 의 오늘. 종전 경로의 `new Date()`(브라우저 로컬 달력)와 달리 시계가 하나다.
  const todayKst = useMemo(() => kstToday(), []);
  const view = resolveTimeRangeView({
    value,
    minDay,
    endDay,
    selectableDates: dates,
    todayKst,
    now: new Date(),
  });
  const { range, requested, didSnap, suggested, anchored, rounds, defaultDay } = view;
  const active = !!(range.from || range.to);
  // 고른 범위에 회차가 하나도 없다 — 화면이 조용히 비는 상태다. 칩과 드롭다운 둘 다에서
  // 말하고, 가장 가까운 회차로 가는 동작을 **제안**한다(자동으로 옮기지 않는다: 서버
  // 술어는 URL 원 범위를 쓰므로 표시와 데이터가 갈리면 안 된다 — 검증 W2).
  const emptyWindow = anchored && active && (rounds ?? 0) === 0;

  // 종료일 입력의 하한 = 시작일과 수집 시작일 중 **늦은** 쪽.
  const toMin = [range.from, minDay].filter(Boolean).sort().pop() ?? undefined;

  const setSide = (side: "from" | "to", day: string) => {
    onChange(encodeTimeRange({ ...range, [side]: day || undefined }));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-time-snapped={didSnap ? "1" : undefined}
          data-time-empty={emptyWindow ? "1" : undefined}
          title={emptyWindow ? t("noRoundInWindow") : undefined}
          className={cn(
            "facet-chip inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
            active
              ? "border-brand-700 bg-brand-700/5 font-medium text-foreground"
              : "border-input bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="truncate">{label}</span>
          {active ? (
            <span
              className={cn(
                "text-[11px] tabular-nums",
                emptyWindow ? "text-muted-foreground line-through" : "text-brand-700",
              )}
            >
              {range.from ?? "…"} ~ {range.to ?? "…"}
            </span>
          ) : null}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {/* 회차가 0개일 때만 말을 건다(N4). **맨 위**에 둔다 — 달력 그리드 뒤에 두면
            팝오버가 세로로 스크롤돼야 보인다(2026-09-20 프리뷰에서 "버튼이 안 보인다"로
            관찰됐다). 빈 결과 안내는 제일 먼저 읽혀야 한다. */}
        {emptyWindow ? (
          <div
            data-time-empty-notice=""
            className="flex flex-col items-start gap-1 px-2 pb-1.5 text-[11px] leading-snug text-brand-700"
          >
            <span>{t("noRoundInWindow")}</span>
            {suggested ? (
              <>
                <span data-time-snap-notice="">
                  {t("snappedToRound", {
                    from: suggested.from ?? "…",
                    to: suggested.to ?? "…",
                  })}
                </span>
                {/* 제안일 뿐이다 — 누르기 전에는 URL·서버 술어가 원 범위 그대로다.
                    빈 화면에서만 뜨므로 이 이동이 MoM·WoW 를 깨뜨릴 여지가 없다. */}
                <button
                  type="button"
                  data-time-snap-apply=""
                  onClick={() => onChange(encodeTimeRange(suggested))}
                  className="rounded-sm border border-brand-700/40 px-1.5 py-0.5 font-medium transition-colors hover:bg-brand-700/10"
                >
                  {t("goToNearestRound", {
                    from: suggested.from ?? "…",
                    to: suggested.to ?? "…",
                  })}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {/* 목록·순서는 **뷰 모델**이 정한다(`resolveTimeRangeView`). 축 on/off 가 같은
            `TIME_PRESET_ORDER` 이고, 축 on 에서는 창에 회차가 없는 항목이 비활성된다. */}
        {view.presets.map(({ preset, encoded }) => {
          return (
            <DropdownMenuCheckboxItem
              key={preset}
              // 창 안에 회차가 없는 프리셋은 고를 수 없다(고르면 빈 화면이 된다).
              disabled={encoded === null}
              title={encoded === null ? t("noRoundInWindow") : undefined}
              // 사유를 **접근 이름**에도 싣는다. `title` 은 읽지 않는 보조기술이 있고,
              // 비활성 프리셋은 축이 켜진 화면에서만 생긴다(축 off 는 항상 값이 있다)
              // — 그래서 축 off 마크업은 그대로다.
              aria-label={encoded === null ? `${t(preset)} (${t("noRoundInWindow")})` : undefined}
              data-preset={preset}
              data-preset-empty={encoded === null ? "1" : undefined}
              checked={encoded !== null && value === encoded}
              onCheckedChange={() => encoded !== null && onChange(encoded)}
              onSelect={(e) => e.preventDefault()}
            >
              {t(preset)}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <div className="flex flex-col gap-1.5 px-2 py-1.5">
          <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("custom")}
          </span>
          {anchored ? (
            <div className="flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
              <span>{range.from ?? "…"}</span>
              <span aria-hidden>~</span>
              <span>{range.to ?? "…"}</span>
            </div>
          ) : (
            (["from", "to"] as const).map((side) => (
              <label key={side} className="flex items-center gap-2 text-xs">
                <span className="w-12 shrink-0 text-muted-foreground">{t(side)}</span>
                <input
                  type="date"
                  value={range[side] ?? ""}
                  max={side === "from" ? range.to : undefined}
                  // 수집 시작일 이전은 고를 수 없다(QA #20). 종료일은 시작일과 수집
                  // 시작일 중 늦은 쪽이 하한.
                  min={side === "to" ? toMin : (minDay ?? undefined)}
                  onChange={(e) => setSide(side, e.target.value)}
                  className="h-7 w-full rounded-sm border border-input bg-background px-2 text-xs focus:border-brand-700 focus:outline-none"
                />
              </label>
            ))
          )}
        </div>
        {anchored ? (
          <AnchorDateCalendar
            selectableDates={dates}
            value={range}
            onChange={(next) => onChange(encodeTimeRange(next))}
            todayKst={todayKst}
            minDay={minDay ?? null}
            defaultDay={defaultDay}
          />
        ) : null}
        {anchored && active ? (
          <div
            data-time-round-count={String(rounds ?? 0)}
            className="px-2 pb-1.5 text-[11px] text-muted-foreground"
          >
            {t("roundCount", { count: rounds ?? 0 })}
          </div>
        ) : null}
        {active ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                onChange(null);
              }}
              className="justify-center text-xs text-muted-foreground"
            >
              {clearLabel}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FacetedFilter({
  label,
  options,
  selected,
  valueLabel,
  clearLabel,
  searchPlaceholder,
  onToggle,
  onClear,
  groupBy,
  onToggleMany,
  disabled = false,
  disabledHint,
  onOpen,
  statusLabel,
  statusBusy = false,
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  valueLabel: (v: string) => string;
  clearLabel: string;
  searchPlaceholder: string;
  onToggle: (v: string) => void;
  onClear: () => void;
  /** 축이 지금 유효하지 않다(예: 경쟁사 ← 출처 카테고리에서 공식(경쟁사) 제외). */
  disabled?: boolean;
  disabledHint?: string;
  groupBy?: (v: string) => string | null;
  // 그룹 헤더 클릭 = 그 그룹(현재 검색으로 보이는 항목)의 일괄 선택/해제.
  // 권역 드롭다운(handleRhqRegionToggle)과 같은 "국가 집합 하나" 규칙 — 헤더는
  // 별도 상태가 아니라 항목 선택의 파생이며, 하나라도 선택되면 체크로 표시한다
  // (2026-09-01 선택/해제 2단계).
  onToggleMany?: (values: string[], select: boolean) => void;
  /** 드롭다운이 열릴 때(지연 옵션 요청, D4). */
  onOpen?: () => void;
  /** 옵션 대신 보일 상태 행(지연 옵션 불러오는 중·실패). null·미지정 = 옵션 목록. */
  statusLabel?: string | null;
  /** 상태 행에 스피너를 붙인다(불러오는 중). */
  statusBusy?: boolean;
}) {
  const count = selected.length;
  const active = count > 0;
  const [query, setQuery] = useState("");
  const showSearch = options.length >= 8;

  // Filter by both raw value (ISO codes) and localized label.
  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter(
      (o) => o.toLowerCase().includes(q) || valueLabel(o).toLowerCase().includes(q),
    );
  }, [options, query, valueLabel]);

  // Group items by header label. groupBy(undefined) or no groupBy → single
  // anonymous bucket. Order is first-occurrence in `filtered`.
  const grouped = useMemo(() => {
    const order: string[] = [];
    const buckets = new Map<string, string[]>();
    for (const v of filtered) {
      const key = (groupBy?.(v) ?? "") || "";
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(v);
    }
    return order.map((k) => ({ header: k, items: buckets.get(k)! }));
  }, [filtered, groupBy]);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setQuery("");
        else onOpen?.();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={disabled ? disabledHint : undefined}
          className={cn(
            "facet-chip inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
            active
              ? "border-brand-700 bg-brand-700/5 font-medium text-foreground"
              : "border-input bg-card text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <span className="truncate">{label}</span>
          {active ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-700 px-1 text-[10px] font-semibold tabular-nums text-white">
              {count}
            </span>
          ) : null}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {showSearch ? (
          <div className="px-2 py-1.5">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-7 w-full rounded-sm border border-input bg-background px-2 text-xs placeholder:text-muted-foreground focus:border-brand-700 focus:outline-none"
              onKeyDown={(e) => {
                // Keep typing inside the input; the dropdown shouldn't try to
                // jump-select an item on space / arrow keys.
                e.stopPropagation();
              }}
            />
          </div>
        ) : null}
        <div className="max-h-72 overflow-y-auto">
          {statusLabel ? (
            <div
              data-lazy-options-status={statusBusy ? "loading" : "error"}
              className="flex items-center justify-center gap-1.5 px-2 py-3 text-[11px] text-muted-foreground"
            >
              {statusBusy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
              {statusLabel}
            </div>
          ) : grouped.length === 0 ? (
            <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              —
            </div>
          ) : (
            grouped.map((g, gi) => (
              <div key={`g${gi}-${g.header}`}>
                {g.header ? (
                  onToggleMany ? (
                    (() => {
                      const anyIn = g.items.some((i) => selected.includes(i));
                      return (
                        <button
                          type="button"
                          onClick={() => onToggleMany(g.items, !anyIn)}
                          className={cn(
                            "flex w-full items-center gap-1 px-2 pt-2 pb-1 text-left text-[10px] font-semibold tracking-wide uppercase transition-colors",
                            anyIn
                              ? "text-brand-700"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {g.header}
                          {anyIn ? <Check className="h-3 w-3" aria-hidden /> : null}
                        </button>
                      );
                    })()
                  ) : (
                    <div className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      {g.header}
                    </div>
                  )
                ) : null}
                {g.items.map((opt) => (
                  <DropdownMenuCheckboxItem
                    key={opt}
                    checked={selected.includes(opt)}
                    onCheckedChange={() => onToggle(opt)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {valueLabel(opt)}
                  </DropdownMenuCheckboxItem>
                ))}
              </div>
            ))
          )}
        </div>
        {active ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                onClear();
              }}
              className="justify-center text-xs text-muted-foreground"
            >
              {clearLabel}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
