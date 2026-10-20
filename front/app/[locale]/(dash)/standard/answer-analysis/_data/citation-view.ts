// 인용 개편(PR ④, 디자인 571:380)의 view-model — 순수 함수만. kpi-view.ts 와 같은
// 방침: 분기·산식은 여기 한 곳에, 컴포넌트는 그리기만.

import type {
  CitationTypeCategoryRow,
  StandardSubKpis,
} from "@/lib/db/repositories/scope-aggregates";
import type { CitationCategorySlice, CitationDomainLive } from "@/lib/scope/result-adapter";
import {
  OFFICIAL_COMPETITOR_CATEGORY,
  OFFICIAL_HMG_CATEGORY,
} from "@/lib/citation-categorizer/taxonomy";

const round1 = (n: number) => Math.round(n * 10) / 10;
// 정본은 택소노미 — 필터 패널(components/dash)도 같은 값을 봐야 한다.
// (종전에는 여기서 "Official (HMG)" 를 따로 선언해 세 번째 사본이 됐다.)
export { OFFICIAL_COMPETITOR_CATEGORY, OFFICIAL_HMG_CATEGORY };
export const DEALER_CATEGORY = "Dealer & Marketplace";

/** 카테고리 슬라이스의 비중(%). 합 0 → null. */
export function categoryShare(
  categories: CitationCategorySlice[] | null | undefined,
  name: string,
): number | null {
  if (!categories) return null;
  const total = categories.reduce((s, c) => s + c.value, 0);
  if (total <= 0) return null;
  const v = categories.find((c) => c.name === name)?.value ?? 0;
  return round1((100 * v) / total);
}

/**
 * 직전 스냅샷의 공식(당사) 인용 비중 — Sub KPI `citations` 파트(Q4) 엔진 행 합.
 * 현재 값(CitationsLive.summary.officialOwnShare)과 같은 분자·분모 규칙(KPI ⑤).
 */
export function officialOwnShareFromSub(sub: StandardSubKpis | null): number | null {
  const rows = sub?.rows ?? [];
  const total = rows.reduce((s, r) => s + r.citTotal, 0);
  const owned = rows.reduce((s, r) => s + r.citOwned, 0);
  return total > 0 ? round1((100 * owned) / total) : null;
}

export interface CategoryBar {
  name: string;
  value: number;
  pct: number | null;
}
/** 카테고리별 인용 수 막대 — 값 내림차순, 비중은 전체 합 대비. */
export function categoryBars(
  categories: CitationCategorySlice[] | null | undefined,
  // 비중의 분모. 생략 = 입력 합. 경쟁사 선택(`applyCompetitorPickToCategories`)은 공식(경쟁사)
  // 값만 줄이는데, 분모까지 줄면 공식(HMG) 비중이 올라가 인용 현황 카드·Overview ⑤ 와
  // 갈린다 → 선택 중에도 **전체 인용 수**를 분모로 넘긴다(제품 책임자 2026-09-29).
  totalOverride?: number,
): CategoryBar[] {
  if (!categories) return [];
  const total = totalOverride ?? categories.reduce((s, c) => s + c.value, 0);
  return [...categories]
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .map((c) => ({ name: c.name, value: c.value, pct: total > 0 ? round1((100 * c.value) / total) : null }));
}

export interface TypeCategoryBar {
  type: CitationTypeCategoryRow["type"];
  total: number;
  /** 카테고리 시리즈 순서(전 유형 합 내림차순)대로 구성비. 합 100. */
  segments: Array<{ name: string; value: number; pct: number }>;
  officialPct: number | null;
}
/**
 * 멘션 유형별 출처 카테고리 구성(100% 스택). 시리즈(색·범례) 순서는 전 유형 합
 * 내림차순으로 고정 — 유형마다 순서가 바뀌면 색이 어긋난다(EngineCategoryChart 규칙).
 */
export function typeCategoryBars(rows: CitationTypeCategoryRow[] | null | undefined): {
  series: string[];
  bars: TypeCategoryBar[];
} {
  if (!rows || rows.length === 0) return { series: [], bars: [] };
  const totals = new Map<string, number>();
  for (const r of rows) for (const [c, v] of Object.entries(r.byCategory)) totals.set(c, (totals.get(c) ?? 0) + v);
  const series = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  const bars = rows.map((r) => {
    const total = r.total;
    const values = series.map((name) => r.byCategory[name] ?? 0);
    const tenths = largestRemainderTenths(values);
    const segments = series
      .map((name, i) => ({ name, value: values[i], pct: tenths[i] / 10 }))
      .filter((s) => s.value > 0 || s.pct > 0);
    const official = r.byCategory[OFFICIAL_HMG_CATEGORY] ?? 0;
    return { type: r.type, total, segments, officialPct: total > 0 ? round1((100 * official) / total) : null };
  });
  return { series, bars };
}

/**
 * 구성비를 0.1%p 단위로 나눠 합이 정확히 100.0(= 1000 칸)이 되게 한다 — 최대잉여(largest remainder) 배분.
 * 각 값의 정확한 비율을 0.1 단위로 내림하고, 모자란 0.1 들을 내림에서 버려진 나머지가 큰 값부터 하나씩 준다.
 * 그래서 칸마다 정확한 비율과의 차이가 0.1%p 미만이고, 0 건 칸은 나머지가 0 이라 받지 않는다(빈 시리즈가 그려지지 않는다).
 * 나머지가 같으면 뒤 칸이 먼저 받는다(종전 '마지막 칸이 잔여를 받는다' 규칙과 같은 쪽).
 * 분모 = 값의 합. 두 원천 모두 유형 total 이 카테고리 합이라(API back sources/service.py, legacy scope-aggregates.ts) total 과 같다.
 */
function largestRemainderTenths(values: number[]): number[] {
  const den = values.reduce((s, v) => s + v, 0);
  if (!(den > 0)) return values.map(() => 0);
  const out = values.map((v) => Math.floor((1000 * v) / den));
  const rem = values.map((v, i) => 1000 * v - out[i] * den);   // 정수 건수면 정확한 정수 나머지
  let left = 1000 - out.reduce((s, x) => s + x, 0);
  const order = values.map((_, i) => i).sort((a, b) => rem[b] - rem[a] || b - a);
  for (const i of order) {
    if (left <= 0 || rem[i] <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/** "경쟁사" 드롭다운 옵션 — 공식(경쟁사)로 분류된 도메인(인용 수 내림차순). */
export function competitorDomainOptions(domains: CitationDomainLive[]): string[] {
  return domains
    .filter((d) => d.category === OFFICIAL_COMPETITOR_CATEGORY)
    .sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain))
    .map((d) => d.domain);
}

/**
 * 경쟁사 선택 적용 — 공식(경쟁사) 행 중 선택된 도메인만 남기고, 다른 카테고리 행은
 * 그대로. 선택이 비었으면 전부.
 */
export function applyCompetitorPick<T extends { domain: string; category: string | null }>(
  rows: T[],
  picked: ReadonlySet<string>,
): T[] {
  if (picked.size === 0) return rows;
  return rows.filter((r) => r.category !== OFFICIAL_COMPETITOR_CATEGORY || picked.has(r.domain));
}

/**
 * 경쟁사 선택을 **카테고리 합계**에 반영한다 — 공식(경쟁사) 행의 값만 선택 도메인의
 * 인용 수 합으로 대체하고 나머지 행은 그대로 둔다(비중은 소비처가 새 합으로 재산출).
 *
 * QA 2차 #5-(c): `?competitor=` 는 도메인 표에만 걸려 있어 "출처 카테고리별 현황"의
 * 공식(경쟁사) 값이 선택과 무관하게 전량이었다. 반영 범위는 카테고리 현황 + 도메인
 * 표까지(제품 결정 D6) — 서버 축으로 승격하면 엔진별·유형별까지 전부 좁혀져 고객이
 * 요구하지 않은 화면이 바뀌고 캐시키·집계 SQL 까지 건드려야 한다.
 *
 * 선택이 비면 **입력 배열 그대로**(같은 참조) 돌려준다 — useMemo 소비처가 불필요한
 * 리렌더를 하지 않도록.
 *
 * 전제(2026-09-10 라이브 미러 실측): 도메인 → 카테고리는 1:1 이므로 대체값이 카테고리
 * 합계와 같은 척도다. `result-adapter` 는 같은 루프에서 `categoryTotals[cat]++` 와
 * `domain.citations++` 를 함께 올리고, `cat` 은 그룹키의 순수 함수다 —
 * `scope_citations.category` 는 3,243,442 행 중 656 행만 비어 있지 않고 그 5개 값
 * (`뉴스/미디어`·`커뮤니티/UGC`·`백과사전`·`정부/공공` 등)은 전부 택소노미 **밖**이라
 * `resolveCitationCategory` 가 버린다. 그래서 한 도메인의 행이 서로 다른 카테고리로
 * 갈리지 않는다.
 */
export function applyCompetitorPickToCategories(
  categories: CitationCategorySlice[] | null | undefined,
  domains: readonly CitationDomainLive[],
  picked: ReadonlySet<string>,
): CitationCategorySlice[] | null {
  if (!categories) return null;
  if (picked.size === 0) return categories;
  const value = domains
    .filter((d) => d.category === OFFICIAL_COMPETITOR_CATEGORY && picked.has(d.domain))
    .reduce((s, d) => s + d.citations, 0);
  return categories.map((c) =>
    c.name === OFFICIAL_COMPETITOR_CATEGORY ? { ...c, value } : c,
  );
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
export function pageWindow(total: number, page: number, pageSize: number): PageWindow {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (p - 1) * pageSize + 1;
  const to = Math.min(total, p * pageSize);
  return { page: p, pages, from, to };
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
