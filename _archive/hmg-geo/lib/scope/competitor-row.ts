// 대시보드 KPI 카드 **경쟁사 행**의 순수 규칙 — 후보 선정·값 산출·표기 중복 접기.
//
// **중립 모듈**(`"server-only"`/`"use client"` 없음). 두 곳이 같은 규칙을 써야 하기
// 때문이다:
//   · 화면(`dashboard/_components/overview-kpi-cards.tsx`) — 어느 4개를 어떤 값으로 그릴지.
//   · 읽기(`lib/scope/server.ts`) — 경쟁사 Δ 2단 조회에서 **어느 브랜드의 회차 축만
//     읽을지**(PR④ B2). 이름이 화면 규칙과 어긋나면 Δ 가 통째로 비거나, 안 그리는
//     브랜드의 회차 축을 읽어 2단의 이득이 사라진다.
//
// 규칙을 두 곳에 적으면 조용히 갈린다(CLAUDE.md "수치를 두 곳에 적지 말 것") — 그래서
// 여기가 정본이고, 화면은 여기에 정렬만 얹는다.
//
// 코어/테넌트: 이 파일은 **코어**다(PR④ 플랜 부록 A — "경쟁사 top-4 선택 규칙 = 코어").
// 테넌트 상수(TRACKED 브랜드 사전·자사 도메인)는 들어오지 않는다 — `isTracked` 는
// 호출부가 이미 판정해 행에 실어 온다.

import type { CompetitorBrandValue } from "./result-adapter";

/**
 * 카드 5종의 키. `dashboard/_data/overview-metrics.ts::OverviewKpiKey` 와 **같은 어휘**여야
 * 하고, `competitor-row.test.ts` 가 그것을 단언한다(둘이 갈리면 Δ 가 조용히 빈다).
 */
export type CompetitorMetricKey =
  | "visibility"
  | "shareOfVoice"
  | "sentiment"
  | "position"
  | "citationShare";

/**
 * Δ 를 그리는 지표 — 셋. `citationShare` 는 경쟁사 값이 인용 도메인에서 오고
 * (`competitorCitationShares`), `sentiment` 는 Δ 원천이 없다
 * (`overview-kpi-cards.tsx::competitorDeltas` 가 이 셋만 처리한다).
 */
export const COMPETITOR_DELTA_KEYS: readonly CompetitorMetricKey[] = [
  "visibility",
  "shareOfVoice",
  "position",
];

/** 표기 흔들림(대소문자·앞뒤 공백)까지 접는 브랜드 키 — 중복 행 판정의 정본. */
export const brandKey = (b: string): string => b.trim().toLowerCase();

/**
 * 같은 브랜드가 두 번 뜨는 것을 막는다 (QA #22 부수 — 이미지의 Tesla 2행).
 * 미러 집계의 브랜드 GROUP BY 는 **표시명 문자열 그대로**라(scope-aggregates.ts
 * `rollupDisplayName` + `GROUP BY 1`), 정본 alias 사전에 없는 표기 흔들림
 * (`Tesla` vs `TESLA` vs 뒤 공백)은 서로 다른 행으로 남는다 — 화면에서는 같은
 * 이름 두 줄로 보인다. 언급 수가 큰 쪽을 대표로 남긴다(카드는 상위 N 만 쓴다).
 */
export function dedupeBrandRows<T extends { brand: string; mentions?: number }>(rows: T[]): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const key = brandKey(r.brand);
    const cur = out.get(key);
    if (!cur || (r.mentions ?? 0) > (cur.mentions ?? 0)) out.set(key, r);
  }
  return [...out.values()];
}

/** 지표별 경쟁사 값. `null` = 이 지표로는 그릴 수 없는 행(후보에서 빠진다). */
export function competitorValueOf(
  b: CompetitorBrandValue,
  key: CompetitorMetricKey,
): number | null {
  switch (key) {
    case "visibility":
      return b.mentions > 0 ? b.mentionRate : null;
    case "shareOfVoice":
      return b.mentions > 0 ? b.share : null;
    case "position":
      return b.avgPosition;
    case "sentiment": {
      const s = b.sentiment;
      if (!s) return null;
      const total = s.positive + s.neutral + s.negative + s.mixed;
      return total > 0 ? Math.round((1000 * s.positive) / total) / 10 : null;
    }
    case "citationShare":
      return null;
  }
}

/**
 * 그 지표의 경쟁사 후보 top-N — **언급 수 상위**다(값 상위가 아니다).
 *
 * 후보를 값으로 뽑으면 언급 1건짜리 소수 브랜드가 100% 로 카드를 채운다
 * (2026-09-02 로컬 실측) — 그 가드가 이 함수의 존재 이유다. **어떤 순서로 보이는가**는
 * 화면이 값 기준으로 다시 정한다(QA #15, `sortMinisByValue`).
 */
export function competitorCandidates(
  brands: CompetitorBrandValue[],
  key: CompetitorMetricKey,
  limit = 4,
): Array<{ brand: string; value: number | null; mentions: number }> {
  const rows = brands
    .filter((b) => !b.isTracked)
    .map((b) => ({ brand: b.brand, value: competitorValueOf(b, key), mentions: b.mentions }))
    .filter((r) => r.value != null)
    .sort((a, b) => b.mentions - a.mentions || a.brand.localeCompare(b.brand));
  return dedupeBrandRows(rows).slice(0, limit);
}

/**
 * Δ 2단 조회(PR④ B2)가 회차 축을 읽을 브랜드 이름 — **Δ 지표 셋의 후보 합집합**.
 *
 * 왜 한 지표의 top-4 가 아니라 합집합인가: 후보 필터가 지표마다 다르다
 * (`position` 은 `avgPosition != null` 을 요구한다). 한 지표 것만 넘기면 다른 카드의
 * 경쟁사 행이 값은 있는데 Δ 만 `−` 로 비는 **부분 결손**이 된다 — 화면으로는
 * "그 브랜드는 변화가 없었다" 로 읽힌다.
 *
 * 상한: 지표 3개 × `limit` = 최대 12개(현실적으로 4~6). 2단의 이득은 회차 축을
 * 브랜드 전량(≈1,000개)에서 이만큼으로 줄이는 데서 나오므로 이 상한이 곧 계약이다.
 * 순서는 언급 수 상위 우선(결정적) — 캐시 키에 들어가므로 흔들리면 셀이 갈린다.
 */
export function competitorDeltaBrands(
  brands: CompetitorBrandValue[],
  limit = 4,
): string[] {
  const byName = new Map<string, number>();
  for (const key of COMPETITOR_DELTA_KEYS) {
    for (const c of competitorCandidates(brands, key, limit)) {
      byName.set(c.brand, Math.max(byName.get(c.brand) ?? 0, c.mentions));
    }
  }
  return [...byName.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}
