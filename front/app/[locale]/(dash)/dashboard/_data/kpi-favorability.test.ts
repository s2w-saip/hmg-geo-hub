import { describe, expect, it, vi } from "vitest";

// live.ts 는 server-only 게이트웨이/GA4 를 import 한다 — 여기서는 순수 view-model
// (buildMirrorKpis / applyEngineConsistency) 만 검증하므로 전송 계층은 스텁.
vi.mock("@/lib/scope/server", () => ({
  fetchStandardAggregates: vi.fn(),
  fetchStandardGeoCompetition: vi.fn(),
  fetchStandardTrend: vi.fn(),
  fetchStandardSubKpis: vi.fn(),
  fetchStandardPromptTopics: vi.fn(),
  fetchStandardSourceComposition: vi.fn(),
  fetchProjectTrend: vi.fn(),
  fetchProjectSubKpis: vi.fn(),
  fetchProjectPromptTopics: vi.fn(),
  fetchProjectSourceComposition: vi.fn(),
}));

import type { StandardAggregates } from "@/lib/scope/result-adapter";
import type { SubKpiEngineRow } from "@/lib/db/repositories/scope-aggregates";
import { buildMirrorKpis, applyEngineConsistency } from "./live";
import { buildMentionSubKpis } from "../../standard/answer-analysis/_data/sub-kpis";

// Core KPI ③ 우호도의 뷰모델 계약 (언급 단위, 2026-07-29 Scope 정본 정렬):
// 카드 값·ratio(분자/분모)·엔진 간 일관성·서브KPI(긍정·부정 키워드 언급 수)가
// 모두 같은 언급 단위 신호 합을 쓴다.

function aggregates(sentiment: StandardAggregates["sentiment"]): StandardAggregates {
  return {
    rootProjectId: "root",
    totalAnswers: 100,
    totalMentions: 200,
    trackedAnswerCount: 60,
    brands: [{ name: "Hyundai", mentionCount: 80, answerCount: 60, isTracked: true }],
    regions: [],
    citations: {
      sampledAnswers: 100,
      answersWithCitation: 40,
      totalCitations: 120,
      ownedCitations: 30,
      domains: [],
    },
    position: { avgPosition: 2.5, sampledAnswers: 60 },
    sentiment,
  };
}

function kpiSentiment(agg: StandardAggregates) {
  return buildMirrorKpis(agg).find((k) => k.key === "sentiment")!;
}

function engineRow(
  engine: string,
  s: { sentMentions: number; positiveMentions: number; negativeMentions: number },
): SubKpiEngineRow {
  return {
    engine,
    answers: 50,
    tracked: 30,
    multi: 10,
    top1: 5,
    top3: 12,
    avgPosition: 2.4,
    totalMentions: 100,
    trackedMentions: 40,
    citTotal: 60,
    citOwned: 15,
    ...s,
  };
}

describe("③ KPI 카드 — 언급 단위 값·ratio", () => {
  it("ratio 는 신호 합 분자/분모를 그대로 싣는다", () => {
    const k = kpiSentiment(
      aggregates({ positiveRate: 88.8, positiveMentions: 6510, sampledMentions: 7327 }),
    );
    expect(k.value).toBe(88.8);
    expect(k.ratio).toEqual({ numerator: 6510, denominator: 7327 });
  });

  it("신호 합 0 → 값 null + ratio 미표시 (측정 대기)", () => {
    const k = kpiSentiment(
      aggregates({ positiveRate: null, positiveMentions: 0, sampledMentions: 0 }),
    );
    expect(k.value).toBeNull();
    expect(k.ratio).toBeUndefined();
  });

  it("긍정 0 은 0% 로 표시되고 ratio 도 남는다 (측정 대기와 구분)", () => {
    const k = kpiSentiment(
      aggregates({ positiveRate: 0, positiveMentions: 0, sampledMentions: 12 }),
    );
    expect(k.value).toBe(0);
    expect(k.ratio).toEqual({ numerator: 0, denominator: 12 });
  });
});

describe("③ 엔진 간 일관성 — 카드와 같은 언급 단위 정의", () => {
  it("엔진별 언급 단위 긍정률의 min ÷ max", () => {
    const kpis = buildMirrorKpis(
      aggregates({ positiveRate: 50, positiveMentions: 10, sampledMentions: 20 }),
    );
    const rows = [
      engineRow("chatgpt", { sentMentions: 100, positiveMentions: 40, negativeMentions: 10 }), // 40%
      engineRow("gemini", { sentMentions: 50, positiveMentions: 40, negativeMentions: 5 }), // 80%
    ];
    const k = applyEngineConsistency(kpis, rows).find((x) => x.key === "sentiment")!;
    expect(k.engineConsistency).toBe(50); // 0.4 / 0.8
  });

  it("신호가 있는 엔진이 1개뿐이면 배지 없음", () => {
    const kpis = buildMirrorKpis(
      aggregates({ positiveRate: 50, positiveMentions: 10, sampledMentions: 20 }),
    );
    const rows = [
      engineRow("chatgpt", { sentMentions: 100, positiveMentions: 40, negativeMentions: 10 }),
      engineRow("gemini", { sentMentions: 0, positiveMentions: 0, negativeMentions: 0 }),
    ];
    const k = applyEngineConsistency(kpis, rows).find((x) => x.key === "sentiment")!;
    expect(k.engineConsistency).toBeUndefined();
  });
});

describe("서브 KPI — 감정 신호 합산과 당사 언급률", () => {
  const rows = [
    engineRow("chatgpt", { sentMentions: 60, positiveMentions: 30, negativeMentions: 12 }),
    engineRow("gemini", { sentMentions: 40, positiveMentions: 10, negativeMentions: 8 }),
  ];

  it("긍정·부정 키워드 언급 수는 신호 합의 분자를 그대로 싣는다", () => {
    const sub = buildMentionSubKpis({ rows, promptsWithoutBrand: 3 })!;
    expect(sub.positiveKeywords).toBe(40); // #17 = 분자 P 와 동일 값
    expect(sub.negativeKeywords).toBe(20); // #18 = 부정 분자와 동일 값
  });

  it("신호 합 0 → 감정 파생 2종 모두 null (측정 대기)", () => {
    const sub = buildMentionSubKpis({
      rows: [engineRow("chatgpt", { sentMentions: 0, positiveMentions: 0, negativeMentions: 0 })],
      promptsWithoutBrand: 0,
    })!;
    expect(sub.positiveKeywords).toBeNull();
    expect(sub.negativeKeywords).toBeNull();
  });

  it("당사 언급률은 답변 단위 DISTINCT — 브랜드별 합산이 아니다", () => {
    // engineRow 기본값: 엔진당 answers 50 / tracked 30 → 60/100 = 60.0%
    const sub = buildMentionSubKpis({ rows, promptsWithoutBrand: 3 })!;
    expect(sub.ownMentionRate).toBe(60);
  });
});
