// 인용 화면(PR ④, 디자인 571:380)의 payload 타입·카테고리 상수·표 경로·빈 상태 키. 값은 인용 화면
// (back/bff/screens/citation.py)이 계산하고, 컴포넌트는 그리기만 한다.

import type { CitationTypeCategoryRow } from "@/lib/db/repositories/scope-aggregates";
import type { CitationCategorySlice, CitationDomainLive, CitationsLive } from "@/lib/scope/result-adapter";
import type {
  CitationCategoryTotals,
  CitationOwnedPromptPage,
  CitationToneSummary,
  CitationToneUrlPage,
} from "@/lib/db/repositories/scope-aggregates";
import type { OverviewCardDelta } from "@/lib/kpi/overview-card-values";
import type { PeriodDeltaView } from "@/lib/kpi/period-compare-view";
import type { FilterDatesView, PanelFilterOptions } from "@/lib/hgh/filter-types";
import {
  OFFICIAL_COMPETITOR_CATEGORY,
  OFFICIAL_HMG_CATEGORY,
} from "@/lib/citation-categorizer/taxonomy";

// 정본은 택소노미 — 필터 패널(components/dash)도 같은 값을 봐야 한다.
// (종전에는 여기서 "Official (HMG)" 를 따로 선언해 세 번째 사본이 됐다.)
export { OFFICIAL_COMPETITOR_CATEGORY, OFFICIAL_HMG_CATEGORY };
export const DEALER_CATEGORY = "Dealer & Marketplace";

/** One category bar of the 출처 카테고리 현황 (value desc, share of all citations). */
export interface CategoryBar {
  name: string;
  value: number;
  pct: number | null;
}

export interface TypeCategoryBar {
  type: CitationTypeCategoryRow["type"];
  total: number;
  /** 카테고리 시리즈 순서(전 유형 합 내림차순)대로 구성비. 합 100. */
  segments: Array<{ name: string; value: number; pct: number }>;
  officialPct: number | null;
}
/**
 * 카테고리 필터(?source=)가 걸린 상태에서 어떤 카테고리가 "포함"됐는가 — 필터가
 * 비었으면 전부 포함(디자인 주석: 공식(당사)/(경쟁사) 미포함 시 Disabled).
 */
export function categoryIncluded(active: readonly string[], name: string): boolean {
  return active.length === 0 || active.includes(name);
}

export interface PageWindow {
  page: number;
  pages: number;
  from: number;
  to: number;
}

// ── 도메인 드릴다운의 "빈 목록" 문구 ────────────────────────────────────────
// 미러 집계는 드릴다운을 세 단계로 싣는다(2026-09-16 고객 QA 대응):
//   · 상위 N 도메인          → urls + promptList
//   · 상위 N 밖 공식(HMG)    → urls 샘플만 (promptList 비움)
//   · 그 밖 / 상한 초과      → 둘 다 비움 (공식이면 drilldownOmitted: true)
// 그래서 "리스트가 비었다"의 의미가 행마다 다르고, 문구를 하나로 쓰면 거짓이
// 된다. 분기를 컴포넌트에 흩지 않고 여기 한 곳에 둔다 — 렌더 지점이 3곳이라
// 복붙하면 한 곳만 어긋난다.
export type CitationDrilldownEmptyKey =
  | "drilldown.noUrls"
  | "drilldown.noUrlsOfficial"
  | "drilldown.noPrompts"
  | "drilldown.promptsTopOnly";

export function citationDrilldownEmptyKey(
  row: Pick<CitationDomainLive, "category" | "urls" | "promptList" | "drilldownOmitted" | "skey">,
  tab: "urls" | "prompts",
): CitationDrilldownEmptyKey {
  // 우리가 **일부러 안 실은** 행은 어느 탭이든 종전 "미제공" 문구다.
  const official = row.category === OFFICIAL_HMG_CATEGORY && !row.drilldownOmitted;
  // API 원천 행(skey, unit U7)은 펼칠 때 상세를 통째로 받는다(상위 N 선정·꼬리 구분 없음):
  // 빈 목록은 정말로 없는 것이다(U7-N2).
  const apiRow = Boolean(row.skey);
  if (tab === "urls") {
    // 공식 행은 드릴다운을 순위와 무관하게 싣는다 → urls 0 = 정말로 없음.
    return official || apiRow ? "drilldown.noUrlsOfficial" : "drilldown.noUrls";
  }
  // 프롬프트 탭. 공식 꼬리(urls 는 실렸는데 promptList 만 빈 행)는 "프롬프트가
  // 없다"가 아니라 "상위 도메인에만 제공"이다 — 그 행은 실제로 프롬프트가 있다.
  if (official && !apiRow && (row.urls?.length ?? 0) > 0) return "drilldown.promptsTopOnly";
  return "drilldown.noPrompts";
}

// ── API 원천 표·드릴다운 경로(unit U7) ─────────────────────────────────────────
// 클라이언트 표가 읽는 BFF 경로(/api/citations/domains*)를 한 곳에서 만든다. `query` 는
// 페이지가 넘긴 화면 필터 파라미터(+ surface=website 또는 projectId)다.

/** 표의 정렬 키 → 백엔드 sort(BG-21). */
export const API_DOMAIN_SORT = {
  domain: "skey",
  citations: "citations",
  share: "share",
  prompts: "prompts",
  coverageRate: "coverage",
} as const;
export type DomainTableSortKey = keyof typeof API_DOMAIN_SORT;

/** 백엔드 페이지를 넘겨 읽는 데 필요한 것(페이지가 서버에서 만든다). */
export interface CitationTableSource {
  /** 화면 필터 파라미터 + surface=website | projectId (q·sort·cursor 없음). */
  query: string;
  /** 첫 페이지 다음 커서(null = 다 받음)와 전체 행 수(meta.page.total). */
  nextCursor: string | null;
  total: number | null;
}

/** 출처 키 → 경로 한 칸(base64url, UTF-8). 소셜 키의 "/" 가 경로를 가르지 않게 한다. */
export function encodeSkeyForPath(skey: string): string {
  const bytes = new TextEncoder().encode(skey);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const withQuery = (path: string, base: string, extra: Record<string, string | number | null | undefined>): string => {
  const params = new URLSearchParams(base);
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === undefined || v === "") params.delete(k);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
};

export interface DomainTableQuery {
  q: string;
  sortKey: DomainTableSortKey;
  asc: boolean;
}

/** 목록 페이지 요청 URL. */
export function domainListUrl(source: Pick<CitationTableSource, "query">, t: DomainTableQuery, limit: number, cursor?: string | null): string {
  return withQuery("/api/citations/domains", source.query, {
    q: t.q.trim(),
    sort: API_DOMAIN_SORT[t.sortKey],
    dir: t.asc ? "asc" : "desc",
    limit,
    cursor: cursor ?? null,
  });
}

/** 행 하나의 드릴다운 요청 URL. */
export function domainDetailUrl(query: string, skey: string): string {
  return withQuery(`/api/citations/domains/${encodeSkeyForPath(skey)}`, query, {});
}

/** 전체 목록 파일(BG-22) URL: 표와 같은 검색·정렬. */
export function domainExportUrl(source: Pick<CitationTableSource, "query">, t: DomainTableQuery, locale: string, maxRows?: number): string {
  return withQuery("/api/citations/domains/export", source.query, {
    q: t.q.trim(),
    sort: API_DOMAIN_SORT[t.sortKey],
    dir: t.asc ? "asc" : "desc",
    locale: locale === "en" ? "en" : "ko",
    max_rows: maxRows ?? null,
  });
}

/** 기본 순서(검색 없음·인용 수 내림차순)면 서버 첫 페이지를 그대로 쓴다. */
export function isDefaultDomainQuery(t: DomainTableQuery): boolean {
  return !t.q.trim() && t.sortKey === "citations" && !t.asc;
}

/**
 * 내려받은 파일의 이름 — 브라우저가 링크 이동 다운로드에서 쓰던 규칙 그대로(P6 B049):
 * `filename*=UTF-8''…`(RFC 5987, 한글 이름)이 있으면 그것, 없으면 `filename="…"`. 둘 다 없으면 null.
 * 백엔드(core/export.py export_headers)는 늘 ASCII `filename` 을 싣고, 비 ASCII 이름이면 `filename*` 를 더한다.
 */
export function contentDispositionFilename(value: string | null | undefined): string | null {
  if (!value) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
  if (star && (!star[1] || star[1].trim().toLowerCase() === "utf-8")) {
    try {
      const name = decodeURIComponent(star[2].trim().replace(/^"|"$/g, ""));
      if (name) return name;
    } catch {
      // 깨진 퍼센트 인코딩 — 아래 ASCII 이름으로 넘어간다(브라우저도 filename* 을 버린다).
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(value);
  const name = (plain?.[1] ?? plain?.[2] ?? "").trim();
  return name || null;
}

/**
 * API 원천 인용 화면의 보조 블록이 일시 실패(5xx·시간 초과·중단)로 비었는가(P6 B041·B042).
 * 서버가 요청 스코프의 degrade 표식(`lib/hgh/adapters/citations.ts::citationsDegraded`)을 읽어
 * 넘긴다. 켜진 블록은 '준비 중'·숨김 대신 기존 지연 안내(answerAnalysis.mentions.kpi.degraded)를 낸다.
 * 없으면(legacy·정상) 종전 그대로다.
 */
export interface CitationSectionDegraded {
  /** 주별 상위 도메인 추이 */
  trend?: boolean;
  /** 출처 카테고리 구성 추이 */
  categoryTrend?: boolean;
  /** 자사 인용/미인용 프롬프트 분할 */
  split?: boolean;
}

// ── BFF screen payloads (back/bff/screens/citation.py) ──────────────────────
// The citation pages read finished view models from GET /v1/screens/citation/*; the numbers the
// components used to compute arrive precomputed next to the data they came from.

/** A domain table row with its '#' (global: rank, website/project: matchRank or the loaded position). */
export type NumberedDomainRow = CitationDomainLive & { rank?: number; matchRank?: number; no: number };

/** The table's category select views (renewal): row indices of the first 100 rows and the bar scales. */
export type DomainTableViews = Record<string, { idx: number[]; maxCit: number; maxCov: number }>;

/** /api/citations/domains answer (screen citation/domains). */
export interface DomainListPageView {
  rows: NumberedDomainRow[];
  nextCursor: string | null;
  total: number | null;
  views?: DomainTableViews;
}

/** /api/citations/domains/[skey] answer (screen citation/domain-detail). */
export interface DomainDetailView {
  urls: CitationDomainLive["urls"];
  promptList: (CitationDomainLive["promptList"][number] & { share?: number | null })[];
  urlTotal?: number;
  promptTotal?: number;
  /** Row orders of the prompt table per sort header (prompt = localeCompare, citations / share = citations). */
  promptOrders?: Record<"prompt" | "citations" | "share", { asc: number[]; desc: number[] }>;
}

export interface CitationDegradedFlags {
  data: boolean;
  trend: boolean;
  categoryTrend: boolean;
  split: boolean;
}

/** The dash engine chart (EngineCategoryChart): series by total desc, one 0-filled row per engine. */
export interface EngineChartView {
  series: string[];
  rows: Array<{ engine: string } & Record<string, number | string>>;
}

/** CitationsStandardView numbers. */
export interface CitationStandardVm {
  status: {
    officialOwn: number | null;
    dealer: number | null;
    officialDelta: number | null;
    dealerDelta: number | null;
    ownIncluded: boolean;
    splitDegraded: boolean;
    tilesDisabled: boolean;
    ownedCount: number | null;
    uncitedCount: number | null;
    /** The Δ basis line: card = own round + category round, category = the category round. */
    basis: { kind: "card"; ownDate: string; categoryDate: string } | { kind: "category"; categoryDate: string } | null;
  };
  category: {
    competitorPicked: boolean;
    bars: (CategoryBar & { delta: number | null })[];
    /** The donut slices (Official (Competitor) = the picked competitors' sum while a pick is on). */
    categories: CitationCategorySlice[] | null;
    officialPct: number | null;
    /** One source category picked: absolute counts instead of 100% stacks. */
    single: boolean;
  };
  engineChart: EngineChartView | null;
  /** The table's first rows after the competitor pick, numbered. */
  domains: NumberedDomainRow[];
}

/** The mention type composition bars (TypeCategoryChart) + whether any type has citations. */
export interface CitationTypeChart {
  series: string[];
  bars: TypeCategoryBar[];
  hasAny: boolean;
}

/** CitationsView (website / project) numbers. */
export interface CitationsViewVm {
  /** Dealer tile share (unrounded; the tile prints toFixed(1)), null = "—". */
  dealerShare: number | null;
  officialPct: number | null;
  engineChart: EngineChartView | null;
  domains: NumberedDomainRow[];
}

/** Screen citation/standard: the standard body (and with variant=renewal the renewal model, typed there). */
export interface StandardCitationScreen<Rn = unknown> {
  live: CitationsLive | null;
  dataDegraded: boolean;
  sectionDegraded: CitationDegradedFlags;
  officialDelta: OverviewCardDelta | null;
  prevCategories: { totals: CitationCategoryTotals; asOf: string; current?: CitationCategoryTotals } | null;
  typeCategories: CitationTypeCategoryRow[] | null;
  /** typeCategoryBars of typeCategories (null when that read failed). */
  typeChart: CitationTypeChart | null;
  toneSummary: CitationToneSummary | null;
  tableSource: CitationTableSource | null;
  periodView: PeriodDeltaView | null;
  vm: CitationStandardVm | null;
  rn?: Rn | null;
}

/** Screen citation/website. */
export interface WebsiteCitationScreen {
  live: CitationsLive | null;
  targetHitRate: {
    hitPrompts: number;
    ownedPrompts: number;
    measuredPrompts: number;
    rate: number | null;
    ownedRate: number | null;
    source?: "published" | "live";
    publication?: { cycleLabel: string | null; cycleLabelEn: string | null; roundDate: string; siteCount: number };
    unit?: "measurement";
  };
  tableSource: CitationTableSource | null;
  dataDegraded: boolean;
  degradedSections: CitationDegradedFlags;
  vm: CitationsViewVm | null;
}

/** Screen citation/project. */
export interface ProjectCitationScreen {
  live: CitationsLive | null;
  options: Pick<PanelFilterOptions, "catalogRows" | "engineOptions"> & { dynamicAxes: NonNullable<PanelFilterOptions["dynamicAxes"]> };
  selectableDates: string[] | undefined;
  tableSource: CitationTableSource | null;
  dataDegraded: boolean;
  degradedSections: CitationDegradedFlags;
  vm: CitationsViewVm | null;
}

/** Screen citation/filter-bar. */
export interface CitationFilterBarScreen {
  options: PanelFilterOptions;
  dates: FilterDatesView;
}

/** Screen citation/as-of: the header pill date and the filter bar's competitor options. */
export interface CitationAsOfScreen {
  asOf: string | null;
  competitorOptions: string[];
}

type SubpageWindow = { win: PageWindow; nextCursor: string | null };

/** Screen citation/prompts. */
export interface CitationPromptsScreen {
  tab: "owned" | "uncited";
  q: string;
  page: (CitationOwnedPromptPage & SubpageWindow) | null;
  ownedCount: number | null;
  uncitedCount: number | null;
}

/** Screen citation/tone-urls. */
export interface CitationToneUrlsScreen {
  tone: "positive" | "negative";
  q: string;
  byDomain: boolean;
  page: (CitationToneUrlPage & SubpageWindow) | null;
  counts: { positive: number | null; negative: number | null } | null;
}
