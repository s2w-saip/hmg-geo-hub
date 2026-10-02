import { describe, it, expect } from "vitest";
import { aggregateMentionsFrom } from "./result-adapter";
import type {
  MeasurementJob,
  ResolvedMention,
  MentionTypeBreakdown,
} from "./types";

// 멘션 유형 × 브랜드 점유율 (2026-08-12). 순수 어댑터(JS 경로)로 계약 고정:
//  - totals = 전 브랜드 합(컷 전 = 점유율 분모), 비경쟁 브랜드 제외
//  - 불변식: 전 브랜드 types 합 == totals; typeTotals(당사 절대) == tracked 합
//  - null 규약: 유형 신호 0 → typesByBrand === null (0% 바 아님)
// SQL 헤드라인 경로는 같은 규칙을 SQL 로 표현한 것(design D3) — dev 실데이터로 대조.

// 당사 판정은 entity_id 기준 — HMG 3사는 실 entity id(무필터 기본 로스터에 포함).
const ENTITY_ID: Record<string, string> = {
  Hyundai: "00000000-0000-0000-0000-000000000301",
  Kia: "00000000-0000-0000-0000-000000000302",
};

const tb = (o: Partial<MentionTypeBreakdown> = {}): MentionTypeBreakdown => ({
  mention: 0,
  recommendation: 0,
  comparison: 0,
  definition: 0,
  final_choice: 0,
  ...o,
});

function m(name: string, count: number, types?: MentionTypeBreakdown): ResolvedMention {
  return {
    entity_id: ENTITY_ID[name] ?? `e-${name}`,
    entity_type: "Brand",
    display_name: name,
    rollups: { product_entity_id: null, brand_entity_id: null, company_entity_id: null },
    surfaces: [name],
    mention_count: count,
    ...(types ? { type_breakdown: types } : {}),
  } as ResolvedMention;
}

function job(id: string, mentions: ResolvedMention[]): MeasurementJob {
  return {
    job_id: id,
    prompt_id: `p-${id}`,
    target: "chatgpt",
    region: "KR",
    status: "completed",
    measured_at: "2026-08-01T00:00:00Z",
    analysis: { status: "completed", resolved_mentions: mentions },
  } as MeasurementJob;
}

describe("멘션 유형 × 브랜드 점유율 (JS 경로)", () => {
  it("totals = 전 브랜드 합, 비경쟁(Apple) 제외, 당사 판정", () => {
    const jobs = [
      job("j1", [
        m("Hyundai", 10, tb({ recommendation: 8, comparison: 2 })),
        m("Toyota", 20, tb({ recommendation: 12, comparison: 8 })),
        m("Apple", 5, tb({ recommendation: 5 })), // 비경쟁 → totals·brands 에서 제외
      ]),
    ];
    const t = aggregateMentionsFrom(jobs, new Map())!.typesByBrand!;
    expect(t.totals.recommendation).toBe(20); // 8 + 12 (Apple 5 제외)
    expect(t.totals.comparison).toBe(10); // 2 + 8
    expect(t.brands.some((b) => b.brand === "Apple")).toBe(false);
    const hy = t.brands.find((b) => b.brand === "Hyundai")!;
    expect(hy.isTracked).toBe(true);
    expect(hy.types.recommendation).toBe(8);
    const to = t.brands.find((b) => b.brand === "Toyota")!;
    expect(to.isTracked).toBe(false);
  });

  it("불변식: 전 브랜드 types 합 == totals", () => {
    const jobs = [
      job("j1", [
        m("Hyundai", 10, tb({ recommendation: 8 })),
        m("Toyota", 20, tb({ recommendation: 12 })),
        m("Ford", 4, tb({ recommendation: 3 })),
      ]),
    ];
    const t = aggregateMentionsFrom(jobs, new Map())!.typesByBrand!;
    const seg = t.brands.reduce((s, b) => s + b.types.recommendation, 0);
    expect(seg).toBe(t.totals.recommendation); // 23
  });

  it("불변식: typeTotals(당사 절대 건수) == tracked 브랜드 types 합", () => {
    const jobs = [
      job("j1", [
        m("Hyundai", 10, tb({ recommendation: 8, comparison: 2 })),
        m("Kia", 6, tb({ recommendation: 4 })),
        m("Toyota", 20, tb({ recommendation: 12 })),
      ]),
    ];
    const res = aggregateMentionsFrom(jobs, new Map())!;
    const tracked = res.typesByBrand!.brands.filter((b) => b.isTracked);
    const recSum = tracked.reduce((s, b) => s + b.types.recommendation, 0);
    const cmpSum = tracked.reduce((s, b) => s + b.types.comparison, 0);
    expect(res.typeTotals!.recommendation).toBe(recSum); // 8 + 4 = 12
    expect(res.typeTotals!.comparison).toBe(cmpSum); // 2
  });

  it("null 규약: 유형 신호 0 → typesByBrand === null (0% 바 아님)", () => {
    const jobs = [job("j1", [m("Hyundai", 10), m("Toyota", 20)])]; // type_breakdown 없음
    expect(aggregateMentionsFrom(jobs, new Map())!.typesByBrand).toBeNull();
  });
});
