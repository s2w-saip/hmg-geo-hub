// 인용 개편(PR ④, 디자인 571:380)의 view-model — 순수 함수만. kpi-view.ts 와 같은
// 방침: 분기·산식은 여기 한 곳에, 컴포넌트는 그리기만.

import type {
  CitationTypeCategoryRow,
  StandardSubKpis,
} from "@/lib/db/repositories/scope-aggregates";
import type { CitationCategorySlice, CitationDomainLive } from "@/lib/scope/result-adapter";
import { OFFICIAL_COMPETITOR_CATEGORY } from "@/lib/citation-categorizer/taxonomy";

const round1 = (n: number) => Math.round(n * 10) / 10;
export const OFFICIAL_HMG_CATEGORY = "Official (HMG)";
// 정본은 택소노미 — 필터 패널(components/dash)도 같은 값을 봐야 한다.
export { OFFICIAL_COMPETITOR_CATEGORY };
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
export function categoryBars(categories: CitationCategorySlice[] | null | undefined): CategoryBar[] {
  if (!categories) return [];
  const total = categories.reduce((s, c) => s + c.value, 0);
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
    let acc = 0;
    const segments = series
      .map((name, i) => {
        const value = r.byCategory[name] ?? 0;
        // 마지막 세그먼트는 잔여로 — 개별 반올림 합이 100.1 이 되지 않게.
        const pct = total > 0 ? (i === series.length - 1 ? round1(100 - acc) : round1((100 * value) / total)) : 0;
        acc += i === series.length - 1 ? 0 : pct;
        return { name, value, pct: Math.max(0, pct) };
      })
      .filter((s) => s.value > 0 || s.pct > 0);
    const official = r.byCategory[OFFICIAL_HMG_CATEGORY] ?? 0;
    return { type: r.type, total, segments, officialPct: total > 0 ? round1((100 * official) / total) : null };
  });
  return { series, bars };
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
 * 표까지(운영 결정 D6) — 서버 축으로 승격하면 엔진별·유형별까지 전부 좁혀져 고객이
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
