import { describe, it, expect } from "vitest";
import {
  brandKey,
  competitorValueOf,
  COMPETITOR_DELTA_KEYS,
  dedupeBrandRows,
  sortMinisByValue,
  type CompetitorMetricKey,
} from "./competitor-row";
import type { OverviewKpiKey } from "@/lib/kpi/overview-card-values";
import type { MentionsBrandLive } from "./result-adapter";

// 경쟁사 브랜드별 값(competitorValueOf)·Δ 키·브랜드 키 — 회차 축 경쟁사 Δ 읽기
// (lib/scope/server.ts → competitorDeltaBrands)가 쓰는 규칙.

/** 옛 식 ②: 언급 경쟁사 표의 값(`competitorKpiRows` 안 삼항식, 2026-09-20 이전 원문). */
function oldMentionPct(b: MentionsBrandLive, metric: "exposure" | "sov"): number | null {
  return b.mentions > 0 ? (metric === "exposure" ? b.mentionRate : b.share) : null;
}

const brand = (over: Partial<MentionsBrandLive> = {}): MentionsBrandLive => ({
  brand: "Tesla",
  mentions: 12,
  prompts: 5,
  share: 6.5,
  mentionRate: 30.1,
  avgPosition: 3.9,
  isTracked: false,
  sentiment: { positive: 7, neutral: 2, negative: 1, mixed: 0 },
  ...over,
});

describe("competitorValueOf — 지표별 값", () => {
  it("노출률·점유율은 언급이 0 이면 null (0% 와 구분)", () => {
    const b = brand({ mentions: 0 });
    expect(competitorValueOf(b, "visibility")).toBeNull();
    expect(competitorValueOf(b, "shareOfVoice")).toBeNull();
  });

  it("우호도 = 긍정 / (P+NE+NG+MX), 1자리", () => {
    expect(competitorValueOf(brand(), "sentiment")).toBe(70);
    expect(
      competitorValueOf(brand({ sentiment: { positive: 1, neutral: 1, negative: 1, mixed: 0 } }), "sentiment"),
    ).toBe(33.3);
  });

  it("감정 신호가 없으면(필드 부재·합 0) null", () => {
    expect(competitorValueOf(brand({ sentiment: undefined }), "sentiment")).toBeNull();
    expect(
      competitorValueOf(brand({ sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0 } }), "sentiment"),
    ).toBeNull();
  });

  it("우선 노출도는 그대로, 인용 점유율은 이 원천에 없다", () => {
    expect(competitorValueOf(brand(), "position")).toBe(3.9);
    expect(competitorValueOf(brand({ avgPosition: null }), "position")).toBeNull();
    expect(competitorValueOf(brand(), "citationShare")).toBeNull();
  });

  it("**옛 언급 화면 삼항식과 바이트 동일**하다 (미러 행에 걸었을 때)", () => {
    const cases: MentionsBrandLive[] = [
      brand(),
      brand({ mentions: 0, mentionRate: 0, share: 0 }),
      brand({ mentions: 1, mentionRate: 100, share: 0.1 }),
      brand({ mentions: 3, mentionRate: 0, share: 0 }),
    ];
    for (const b of cases) {
      expect(competitorValueOf(b, "visibility")).toBe(oldMentionPct(b, "exposure"));
      expect(competitorValueOf(b, "shareOfVoice")).toBe(oldMentionPct(b, "sov"));
    }
  });
});

describe("어휘 — 카드 키가 Overview 와 같다", () => {
  it("CompetitorMetricKey 와 OverviewKpiKey 가 서로 대입된다", () => {
    const a: CompetitorMetricKey = "citationShare" satisfies OverviewKpiKey;
    const b: OverviewKpiKey = "position" satisfies CompetitorMetricKey;
    expect([a, b]).toEqual(["citationShare", "position"]);
  });

  it("Δ 키는 셋 — 우호도·인용 점유율은 Δ 원천이 없다(지시 ⑤: 새로 만들지 않는다)", () => {
    expect([...COMPETITOR_DELTA_KEYS]).toEqual(["visibility", "shareOfVoice", "position"]);
  });
});

describe("brandKey", () => {
  it("대소문자·앞뒤 공백을 접는다", () => {
    expect(brandKey(" TESLA ")).toBe("tesla");
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
