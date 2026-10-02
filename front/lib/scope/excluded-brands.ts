// 엔티티 명부 제외(entity_registry role='excluded'): **표시 전용** 필터 (2026-09-30).
//
// 무엇을 하는가: admin 이 명부에서 '제외'로 등록한 엔티티를 브랜드·경쟁사 **순위와 목록,
// 경쟁사 선정**에서 뺀다. HMG QA 제보(기아 인도·어드민 계정 브랜드 순위에 LG전자·
// LG Energy Solution·Facebook·"지역 농가")가 계기다: 명부에 등록해도 읽기 경로가
// role='own' 만 읽어 화면에서 안 빠졌다.
//
// 무엇을 하지 **않는가**: KPI 값(분모 포함)은 바꾸지 않는다. 전체 언급 수·SOV 분모·
// 노출률 분모·우호도 신호 합·버킷 `totalMentions`·유형 `totals`·고유 브랜드 수는 제외
// 엔티티를 **포함한 채** 그대로다(값 변경은 별도 결정 대상). 그래서 이 모듈은 집계 SQL 을
// 건드리지 않고, 게이트웨이(`lib/scope/server.ts`)가 **캐시된 결과를 꺼낸 뒤** 표시 행만
// 거른다. 캐시 셀 키·값은 종전과 같다(명부 변경은 명부 셀 하나만 무효화하면 반영된다).
//
// ── 판정 키 ────────────────────────────────────────────────────────────────
// 순위 행은 entity_id 가 아니라 **표시명**으로 GROUP BY 된다(`scope-aggregates.ts::
// canonBrandNameSql`: 경쟁사는 정본 id 를 코드에 둘 수 없어 이름으로 접는다). 행의 이름 =
// `canonBrandNameSql(COALESCE(ROLLUP_NAMES.brand, m.brand))`, 즉 **롤업 엔티티**
// (`brand_rollup_entity_id` 를 `canonRollupSql` 로 접은 id)의 대표 Brand 표기(라틴 우선 +
// 사전순)를 표시명 사전으로 정본화한 것이다. 사실표(`summary_*`)의 `brand_name` 도 같은 식이다
// (`lib/summary/generate/context.ts::brandExprs`).
//
// 따라서 제외 키 = 제외 엔티티의 **대표 표기 → `canonicalBrandDisplayName`**. 명부 로드가
// 대표 표기를 같은 규칙으로 함께 읽는다(`entity-registry.ts::listRoster`). 제외 엔티티가
// Brand 이면 롤업 = 자기 자신이라 "엔티티 자신 또는 롤업이 제외" 가 곧 "그 롤업 행" 이다 :
// 그 아래 Product 언급도 같은 행에 합산돼 있으므로 행 하나를 빼면 함께 빠진다.
//
// ⚠️ 안전장치: **자사(isTracked) 행은 절대 빼지 않는다.** 명부 오등록(자사 알리아스를
//    제외로 등록)이 당사 행을 지우는 사고를 막는다.
// ⚠️ 한계: 이름으로 접힌 행이라, 제외 엔티티의 대표 표기가 다른 브랜드 표기와 **같으면**
//    그 행 전체가 빠진다(SQL 이 이미 한 행으로 합쳤으므로 분리 불가).
//
// `server-only` 를 붙이지 않는다(순수 함수, 짝 테스트가 직접 import). 입력을 변경하지 않는다.

import { canonicalBrandDisplayName } from "./brand-display-aliases";
import { rankFirstPositionRows } from "@/lib/kpi/first-position-rank";
import type {
  BrandTrendResult,
  EngineKpiTrend,
  FirstPositionResult,
  StandardAcr,
} from "@/lib/db/repositories/scope-aggregates";
import type {
  CompetitorBrandValue,
  MentionsLive,
  StandardAggregates,
} from "./result-adapter";

/** 명부의 제외 행: `listRoster` 가 대표 표기(`rankName`)를 함께 싣는다. */
export interface ExcludedEntity {
  id: string;
  /** admin 화면 표기(명부 저장값). */
  name: string;
  /** 미러 대표 Brand 표기(순위 행 이름의 원천). 미러에 행이 없으면 null. */
  rankName: string | null;
}

/** 제외 표시명 집합. 비어 있으면 모든 필터가 입력을 그대로 돌려준다. */
export type ExcludedBrandSet = ReadonlySet<string>;

const norm = (s: string): string => s.trim();

/**
 * 제외 엔티티 → 순위 행 표시명 목록(정렬·중복 제거). **문자열 배열**이라 캐시 셀에
 * 그대로 담을 수 있다(Set·Map 금지: `unstable_cache` 셀 규약).
 */
export function excludedBrandNames(entries: ReadonlyArray<ExcludedEntity>): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    const raw = e.rankName ?? e.name;
    if (!raw || !raw.trim()) continue;
    out.add(norm(canonicalBrandDisplayName(raw)));
  }
  return [...out].sort();
}

export function toExcludedBrandSet(names: ReadonlyArray<string>): ExcludedBrandSet {
  return new Set(names.map(norm));
}

/** 이 행을 뺄 것인가: 자사 행은 언제나 남긴다. */
export function isExcludedBrand(
  ex: ExcludedBrandSet,
  brand: string | null | undefined,
  isTracked: boolean,
): boolean {
  if (isTracked || !brand || ex.size === 0) return false;
  return ex.has(norm(brand));
}

/** `{ brand, isTracked }` 행 목록에서 제외 행을 뺀다. 뺄 것이 없으면 같은 배열. */
export function dropExcludedBrands<T extends { brand: string; isTracked: boolean }>(
  rows: T[],
  ex: ExcludedBrandSet,
): T[] {
  if (ex.size === 0) return rows;
  const kept = rows.filter((r) => !isExcludedBrand(ex, r.brand, r.isTracked));
  return kept.length === rows.length ? rows : kept;
}

/**
 * top-N 캡(`capBrandSeries`·`pickSeriesBrands` 와 같은 규칙)을 **제외 후** 다시 건다.
 * 입력 순서 = 캡 선정 순서(창 언급 내림차순)여야 한다. 자사는 캡과 무관하게 남는다.
 *
 * 호출부는 캡을 `cap + 제외 수` 로 넉넉히 받아 온 뒤 이 함수로 `cap` 까지 줄인다: 제외
 * 행이 캡 안에 있었어도 다음 순위 브랜드가 그 자리를 채운다(제외가 없었던 것과 같은 결과).
 */
export function recapBrands<T>(
  ordered: ReadonlyArray<T>,
  isTracked: (x: T) => boolean,
  cap: number | undefined,
): T[] {
  if (cap == null) return [...ordered];
  const picked: T[] = [];
  for (const x of ordered) {
    if (isTracked(x) || picked.length < cap) picked.push(x);
  }
  return picked;
}

/** 언급 화면 묶음: 순위표·유형×브랜드·주별 추이 시리즈·드릴다운 키. 분모·요약은 그대로. */
export function filterMentionsLive(live: MentionsLive, ex: ExcludedBrandSet): MentionsLive {
  if (ex.size === 0) return live;
  const tracked = new Set(live.brands.filter((b) => b.isTracked).map((b) => b.brand));
  const typesTracked = new Set(
    (live.typesByBrand?.brands ?? []).filter((b) => b.isTracked).map((b) => b.brand),
  );
  const drop = (name: string) =>
    isExcludedBrand(ex, name, tracked.has(name) || typesTracked.has(name));
  const brands = dropExcludedBrands(live.brands, ex);
  const typesByBrand = live.typesByBrand
    ? { ...live.typesByBrand, brands: dropExcludedBrands(live.typesByBrand.brands, ex) }
    : live.typesByBrand;
  const series = live.trend?.series.filter((s) => !drop(s));
  const trend =
    live.trend && series && series.length !== live.trend.series.length
      ? { ...live.trend, series }
      : live.trend;
  const promptKeys = Object.keys(live.perBrandPrompts);
  const droppedPromptKey = promptKeys.some(drop);
  const perBrandPrompts = droppedPromptKey
    ? Object.fromEntries(Object.entries(live.perBrandPrompts).filter(([k]) => !drop(k)))
    : live.perBrandPrompts;
  if (
    brands === live.brands &&
    typesByBrand?.brands === live.typesByBrand?.brands &&
    trend === live.trend &&
    !droppedPromptKey
  ) {
    return live;
  }
  return { ...live, brands, typesByBrand, trend, perBrandPrompts };
}

/** Overview 경쟁사 줄·언급 탭 경쟁사 값. */
export function filterCompetitorValues(
  rows: CompetitorBrandValue[],
  ex: ExcludedBrandSet,
): CompetitorBrandValue[] {
  return dropExcludedBrands(rows, ex);
}

/**
 * 카드 집계의 브랜드 목록: `applyCompetitorSov` 의 **SOV 1위 경쟁사 자동 선정** 입력.
 * 카드 값(①~⑤)은 자사 행 합과 `totalMentions` 등 스칼라에서 오므로 비자사 행을 빼도
 * 값이 바뀌지 않는다.
 */
export function filterAggregatesBrands(
  agg: StandardAggregates,
  ex: ExcludedBrandSet,
): StandardAggregates {
  if (ex.size === 0) return agg;
  const brands = agg.brands.filter((b) => !isExcludedBrand(ex, b.name, b.isTracked));
  return brands.length === agg.brands.length ? agg : { ...agg, brands };
}

/** KPI 탭 브랜드 추이(주별 상위 N 라인·경쟁사 스파크). 버킷 `totalMentions`(분모)는 그대로. */
export function filterBrandTrend(
  res: BrandTrendResult,
  ex: ExcludedBrandSet,
  cap?: number,
): BrandTrendResult {
  if (ex.size === 0) return res;
  const kept = recapBrands(
    res.brands.filter((b) => !isExcludedBrand(ex, b.brand, b.isTracked)),
    (b) => b.isTracked,
    cap,
  );
  if (kept.length === res.brands.length) return res;
  const keep = new Set(kept.map((b) => b.brand));
  return {
    ...res,
    brands: kept,
    buckets: res.buckets.map((bk) => ({
      ...bk,
      brands: bk.brands.filter((p) => keep.has(p.brand)),
    })),
  };
}

/**
 * 우선 노출도: 순위표(`latest`)·시리즈·버킷. 행을 빼면 **순위 열을 다시 매긴다**
 * (`rankFirstPositionRows`: 클라이언트 재순위와 같은 규칙). `avgPosition`(답변 안
 * 경쟁 순위 값)은 KPI 값이라 그대로다.
 */
export function filterFirstPosition(
  res: FirstPositionResult,
  ex: ExcludedBrandSet,
  cap?: number,
): FirstPositionResult {
  if (ex.size === 0) return res;
  const trackedOf = new Map<string, boolean>();
  for (const r of res.latest) trackedOf.set(r.brand, r.isTracked);
  for (const bk of res.buckets) {
    for (const p of bk.brands) if (p.isTracked) trackedOf.set(p.brand, true);
  }
  const isTr = (name: string) => trackedOf.get(name) === true;
  const kept = recapBrands(
    res.brands.filter((name) => !isExcludedBrand(ex, name, isTr(name))),
    isTr,
    cap,
  );
  const keep = new Set(kept);
  const latestKept = res.latest.filter((r) => keep.has(r.brand));
  if (kept.length === res.brands.length && latestKept.length === res.latest.length) return res;
  return {
    ...res,
    brands: kept,
    latest: rankFirstPositionRows(latestKept),
    buckets: res.buckets.map((bk) => ({
      ...bk,
      brands: bk.brands.filter((p) => keep.has(p.brand)),
    })),
  };
}

/** 엔진×브랜드 스냅샷(경쟁사 선택 드롭다운·경쟁사 평균 막대의 모수). 엔진 KPI 는 그대로. */
export function filterEngineKpiTrend(res: EngineKpiTrend, ex: ExcludedBrandSet): EngineKpiTrend {
  if (ex.size === 0) return res;
  const latestBrands = dropExcludedBrands(res.latestBrands, ex);
  return latestBrands === res.latestBrands ? res : { ...res, latestBrands };
}

/**
 * GEO 행은 **빼지 않고 표식만** 단다: 시장 SOV 분모가 이 행들의 언급 합이라
 * (`overview-metrics.ts::marketMetrics`·`live.ts::marketStats`), 빼면 분모가 바뀐다.
 * 소비자는 경쟁사 목록·최대 경쟁사·순위 모수에서만 `excluded` 행을 건너뛴다.
 */
export function markExcludedGeo<T extends { brand: string; isTracked: boolean; excluded?: boolean }>(
  rows: T[],
  ex: ExcludedBrandSet,
): T[] {
  if (ex.size === 0) return rows;
  if (!rows.some((r) => isExcludedBrand(ex, r.brand, r.isTracked))) return rows;
  return rows.map((r) => (isExcludedBrand(ex, r.brand, r.isTracked) ? { ...r, excluded: true } : r));
}

/** ACR 브랜드 목록(선택 점유율 표). 값(`choiceShare` 등)은 서버 계산 그대로. */
export function filterAcr(acr: StandardAcr, ex: ExcludedBrandSet): StandardAcr {
  if (ex.size === 0) return acr;
  const brands = acr.brands.filter((b) => !isExcludedBrand(ex, b.brand, b.isOurs));
  return brands.length === acr.brands.length ? acr : { ...acr, brands };
}
