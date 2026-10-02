import { describe, expect, it } from "vitest";
import type { MentionsBrandLive } from "@/lib/scope/result-adapter";
import type { CitationDomainLive } from "@/lib/scope/result-adapter";
import {
  competitorCitationShares,
  competitorMinis,
  dedupeBrandRows,
  overviewCardState,
  sortMinisByValue,
} from "./overview-kpi-cards";

// GGMD "KPI 고도화 QA" #23·#3(측정 대기 불일치) · #22(Δ 미표기·Tesla 2행) ·
// #15(경쟁사 상위 4 정렬) 회귀 고정. 전부 순수 함수 — 렌더 단언은
// overview.render.test.tsx 가 갖는다.

describe("overviewCardState — 측정 대기 판정과 Δ 노출 (QA #23·#3)", () => {
  it("값이 null 이면 측정 대기 — Δ 를 함께 내린다", () => {
    // 이미지: 'AI 우호도 = 측정 대기' 밑에 '↘44.4pp', 'AI 우선 노출도 = 측정 대기'
    // 밑에 '↘1.0위' 가 동시에 찍혔다.
    expect(overviewCardState({ value: null, delta: -44.4 })).toEqual({
      value: null,
      pending: true,
      delta: null,
    });
    expect(overviewCardState({ value: null, delta: -1 })).toEqual({
      value: null,
      pending: true,
      delta: null,
    });
    expect(overviewCardState(undefined)).toEqual({ value: null, pending: true, delta: null });
  });

  it("값 0 인데 모수(ratio.denominator)가 0/부재면 측정 대기로 취급한다", () => {
    // live.ts 의 pct(n, 0) = 0 이 그대로 카드로 샌 경우. buildMirrorKpis 는 분모가
    // 0 일 때 ratio 자체를 만들지 않는다(② 점유율·③ 우호도) → 둘 다 대기.
    expect(overviewCardState({ value: 0, delta: null, ratio: { numerator: 0, denominator: 0 } }).pending).toBe(true);
    expect(overviewCardState({ value: 0, delta: 1.2 }).pending).toBe(true);
  });

  it("모수가 있는 진짜 0 은 값 0 으로 남긴다", () => {
    const s = overviewCardState({ value: 0, delta: null, ratio: { numerator: 0, denominator: 120 } });
    expect(s.pending).toBe(false);
    expect(s.value).toBe(0);
  });

  it("모수가 있는 진짜 0 의 하락 Δ 는 참값이라 그대로 둔다 (-100pp)", () => {
    // 답변 120건 감시·당사 언급 0 → 0% 이고 직전 회차 대비 -100pp 는 실제 하락이다.
    const s = overviewCardState({ value: 0, delta: -100, ratio: { numerator: 0, denominator: 120 } });
    expect(s).toEqual({ value: 0, pending: false, delta: -100 });
  });

  it("이미지의 '0.0% ↘100.0pp' 는 분모 0 이라 측정 대기로 접힌다", () => {
    const s = overviewCardState({ value: 0, delta: -100, ratio: { numerator: 0, denominator: 0 } });
    expect(s).toEqual({ value: null, pending: true, delta: null });
  });

  it("정상 값은 Δ 를 그대로 통과시킨다", () => {
    expect(overviewCardState({ value: 73.1, delta: -4.4, ratio: { numerator: 88, denominator: 120 } })).toEqual({
      value: 73.1,
      pending: false,
      delta: -4.4,
    });
  });
});

describe("dedupeBrandRows — 같은 브랜드 2행 방지 (QA #22 부수)", () => {
  it("대소문자·앞뒤 공백만 다른 표기를 접고 언급 수가 큰 쪽을 남긴다", () => {
    // 미러 집계는 표시명 문자열로 GROUP BY 하므로(scope-aggregates rollupDisplayName
    // + GROUP BY 1) alias 사전 밖 표기 흔들림은 별도 행으로 남는다.
    const rows = [
      { brand: "Tesla", value: 79.6, mentions: 120 },
      { brand: "TESLA ", value: 72.4, mentions: 40 },
      { brand: "BMW", value: 20.9, mentions: 30 },
    ];
    expect(dedupeBrandRows(rows).map((r) => r.brand)).toEqual(["Tesla", "BMW"]);
  });
});

describe("sortMinisByValue — 경쟁사 상위 4 정렬 (QA #15)", () => {
  const minis = [
    { brand: "Tesla", value: 29.7 },
    { brand: "Toyota", value: 24.9 },
    { brand: "Kia", value: 27.5 },
    { brand: "BMW", value: null },
  ];
  it("비율 지표는 내림차순, null 은 뒤로", () => {
    expect(sortMinisByValue(minis, "visibility").map((m) => m.brand)).toEqual([
      "Tesla",
      "Kia",
      "Toyota",
      "BMW",
    ]);
  });
  it("순위(우선 노출도)는 오름차순", () => {
    expect(sortMinisByValue(minis, "position").map((m) => m.brand)).toEqual([
      "Toyota",
      "Kia",
      "Tesla",
      "BMW",
    ]);
  });
});

describe("competitorMinis — 후보는 언급 수, 표시는 값 순", () => {
  const b = (brand: string, mentions: number, mentionRate: number): MentionsBrandLive => ({
    brand,
    mentions,
    prompts: 1,
    share: mentionRate,
    mentionRate,
    avgPosition: null,
    isTracked: false,
  });
  it("언급 1건짜리 100% 브랜드가 카드를 채우지 않는다 (가드 유지)", () => {
    const rows = [
      b("Fringe", 1, 100),
      b("Tesla", 500, 29.7),
      b("Kia", 400, 27.5),
      b("Toyota", 300, 24.9),
      b("BMW", 200, 20.9),
    ];
    // 상위 4 = 언급 수 기준(Fringe 제외) → 그 4개를 값 내림차순으로 표시.
    expect(competitorMinis(rows, "visibility").map((m) => m.brand)).toEqual([
      "Tesla",
      "Kia",
      "Toyota",
      "BMW",
    ]);
  });
  it("표기가 흔들린 같은 브랜드는 한 번만 나온다", () => {
    const rows = [b("Tesla", 500, 79.6), b("tesla ", 100, 72.4), b("BMW", 200, 20.9)];
    expect(competitorMinis(rows, "visibility").map((m) => m.brand)).toEqual(["Tesla", "BMW"]);
  });
});

describe("competitorCitationShares — 브랜드 표기 흔들림 합산", () => {
  const d = (domain: string, share: number): CitationDomainLive =>
    ({ domain, share, citations: 1, prompts: 1, coverageRate: 0, category: "Official (Competitor)" }) as CitationDomainLive;
  it("같은 경쟁사 브랜드의 도메인 점유율을 하나로 합친다", () => {
    const rows = competitorCitationShares([d("tesla.com", 4), d("tesla.co.kr", 2), d("bmw.com", 3)]);
    // competitorBrandOfDomain 의 매핑 결과가 같은 브랜드면 한 행으로 접힌다.
    const keys = rows.map((r) => r.brand.trim().toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});
