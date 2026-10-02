import { describe, it, expect } from "vitest";
import {
  aggregateStandard,
  aggregateMentionsFrom,
  aggregateMentionsFromPublic,
} from "./result-adapter";
import type { ScopeClient } from "./client";
import type {
  BrandMention,
  MeasurementJob,
  MeasurementRunSummary,
  ResolvedMention,
} from "./types";

// Core KPI ③ 우호도 — 언급(멘션 sentiment 신호) 단위 긍정률 (2026-07-29 Scope
// 정본 정렬). 이 파일이 고정하는 계약:
//   ① 분모(신호 합) 0 → positiveRate === null ("측정 대기", 0% 아님)
//   ② mixed 는 분모에 포함된다
//   ③ p == ng 동률 답변에서 긍정·부정 이중계상이 존재하지 않는다
//      (구 답변 단위 우세 분류의 SQL FILTER vs JS else-if 비대칭이 소멸)
//   ④ parity — 감정 분포의 긍정 세그먼트 비율 == 우호도(동일 입력·동일 산식)
// 미러 SQL 경로는 같은 산식을 SQL 로 표현한 것이라 여기서는 순수 어댑터
// (HTTP 폴백 · 미러 mentions 어댑터 · 공개 API 폴백)로 계약을 고정한다.

type Sent = { positive: number; neutral: number; negative: number; mixed: number };

// 당사 판정은 entity_id(자사 명부) 기준 — HMG 3사는 실 entity id 를 쓴다.
const ENTITY_ID: Record<string, string> = {
  Hyundai: "00000000-0000-0000-0000-000000000301",
  Kia: "00000000-0000-0000-0000-000000000302",
  Genesis: "00000000-0000-0000-0000-000000000304",
};

function mention(name: string, count: number, sentiment?: Sent): ResolvedMention {
  return {
    entity_id: ENTITY_ID[name] ?? `e-${name}`,
    entity_type: "Brand",
    display_name: name,
    rollups: { product_entity_id: null, brand_entity_id: null, company_entity_id: null },
    surfaces: [name],
    mention_count: count,
    ...(sentiment ? { sentiment } : {}),
  } as ResolvedMention;
}

function job(id: string, mentions: ResolvedMention[]): MeasurementJob {
  return {
    job_id: id,
    prompt_id: `p-${id}`,
    target: "chatgpt",
    region: "KR",
    status: "completed",
    measured_at: "2026-07-27T00:00:00Z",
    analysis: { status: "completed", resolved_mentions: mentions },
  } as MeasurementJob;
}

function clientFor(jobs: MeasurementJob[]): ScopeClient {
  const runs: MeasurementRunSummary[] = [
    {
      measurement_run_id: "run-1",
      project_id: "root",
      trigger: "manual",
      status: "completed",
      targets: ["chatgpt"],
      regions: ["KR"],
      total_jobs: jobs.length,
      started_at: "2026-07-27T00:00:00Z",
      completed_at: "2026-07-27T01:00:00Z",
    } as MeasurementRunSummary,
  ];
  return {
    listMeasurementRuns: async () => ({ data: runs }),
    listRunJobs: async () => ({ data: jobs }),
    listPrompts: async () => ({ data: [] }),
    listResults: async () => ({ results: [] }),
  } as unknown as ScopeClient;
}

const ROOT = { projectId: "root" } as Parameters<typeof aggregateStandard>[1];

async function sentimentOf(jobs: MeasurementJob[]) {
  const agg = await aggregateStandard(clientFor(jobs), ROOT);
  return agg!.sentiment;
}

describe("③ 우호도 — 언급 단위 긍정률 (HTTP 폴백)", () => {
  it("신호 합이 0이면 positiveRate 는 null (측정 대기 — 0% 아님)", async () => {
    // 당사 언급은 있으나 sentiment 가 하나도 붙지 않은 상태.
    const s = await sentimentOf([job("j1", [mention("Hyundai", 3)])]);
    expect(s.positiveRate).toBeNull();
    expect(s.sampledMentions).toBe(0);
    expect(s.positiveMentions).toBe(0);
  });

  it("신호는 있으나 긍정이 0이면 0% (측정 대기가 아니다)", async () => {
    const s = await sentimentOf([
      job("j1", [mention("Hyundai", 2, { positive: 0, neutral: 3, negative: 1, mixed: 0 })]),
    ]);
    expect(s.positiveRate).toBe(0);
    expect(s.sampledMentions).toBe(4);
  });

  it("신호 카운트 합으로 산출한다 (답변 수 아님)", async () => {
    // 스펙 시나리오: P=6510 NE=604 NG=4 MX=209 → round1(100×6510÷7327) = 88.8
    const s = await sentimentOf([
      job("j1", [mention("Hyundai", 10, { positive: 6510, neutral: 604, negative: 4, mixed: 209 })]),
    ]);
    expect(s.positiveMentions).toBe(6510);
    expect(s.sampledMentions).toBe(7327);
    expect(s.positiveRate).toBe(88.8);
  });

  it("mixed 는 분모에 포함된다 — 분자 불변, 분모 증가로 값이 내려간다", async () => {
    const withoutMixed = await sentimentOf([
      job("j1", [mention("Hyundai", 1, { positive: 3, neutral: 1, negative: 0, mixed: 0 })]),
    ]);
    const withMixed = await sentimentOf([
      job("j1", [mention("Hyundai", 1, { positive: 3, neutral: 1, negative: 0, mixed: 4 })]),
    ]);
    expect(withoutMixed.positiveRate).toBe(75); // 3/4
    expect(withMixed.positiveMentions).toBe(withoutMixed.positiveMentions);
    expect(withMixed.sampledMentions).toBe(8);
    expect(withMixed.positiveRate).toBe(37.5); // 3/8
    expect(withMixed.positiveRate!).toBeLessThan(withoutMixed.positiveRate!);
  });

  it("경쟁사 언급의 sentiment 는 계상하지 않는다 (tracked 한정)", async () => {
    const s = await sentimentOf([
      job("j1", [
        mention("Hyundai", 1, { positive: 2, neutral: 0, negative: 0, mixed: 0 }),
        mention("Toyota", 1, { positive: 100, neutral: 0, negative: 0, mixed: 0 }),
      ]),
    ]);
    expect(s.positiveMentions).toBe(2);
    expect(s.sampledMentions).toBe(2);
  });

  it("답변 경계와 무관하게 합산된다 (여러 답변·여러 당사 멘션)", async () => {
    const s = await sentimentOf([
      job("j1", [
        mention("Hyundai", 1, { positive: 1, neutral: 1, negative: 0, mixed: 0 }),
        mention("Kia", 1, { positive: 2, neutral: 0, negative: 1, mixed: 0 }),
      ]),
      job("j2", [mention("Genesis", 1, { positive: 1, neutral: 0, negative: 2, mixed: 1 })]),
    ]);
    // P=1+2+1=4, 신호 합=2+3+4=9 → round1(100×4÷9) = 44.4
    expect(s.positiveMentions).toBe(4);
    expect(s.sampledMentions).toBe(9);
    expect(s.positiveRate).toBe(44.4);
  });
});

describe("③ 우호도 — 동률(p == ng) 이중계상 소멸", () => {
  // 구 답변 단위 우세 분류: SQL 은 pos/neg FILTER 를 독립 계상해 p==ng>0 답변을
  // 양쪽 분자에 동시에 셌고, JS 는 else-if 배타라 긍정만 셌다(비대칭). 언급 단위
  // 에서는 신호가 각 세그먼트에 정확히 1회씩만 들어간다.
  const tiedJobs = [
    job("j1", [mention("Hyundai", 1, { positive: 3, neutral: 0, negative: 3, mixed: 0 })]),
    job("j2", [mention("Kia", 1, { positive: 1, neutral: 2, negative: 1, mixed: 1 })]),
  ];

  it("세그먼트 합 == 신호 총합 (어떤 신호도 두 분자에 동시 계상되지 않는다)", () => {
    const m = aggregateMentionsFrom(tiedJobs, new Map());
    const t = m!.sentimentTotals!;
    expect(t).toEqual({ positive: 4, neutral: 2, negative: 4, mixed: 1 });
    expect(t.positive + t.neutral + t.negative + t.mixed).toBe(11);
  });

  it("동률 입력에서도 긍정률 + 부정률 ≤ 100 (구 산식은 동시 계상으로 초과 가능)", async () => {
    const s = await sentimentOf(tiedJobs);
    const t = aggregateMentionsFrom(tiedJobs, new Map())!.sentimentTotals!;
    const denom = t.positive + t.neutral + t.negative + t.mixed;
    const negativeRate = (100 * t.negative) / denom;
    expect(s.positiveRate! + negativeRate).toBeLessThanOrEqual(100);
  });
});

describe("③ 우호도 — parity (감정 분포 긍정 세그먼트 == 우호도)", () => {
  const jobs = [
    job("j1", [
      mention("Hyundai", 2, { positive: 7, neutral: 2, negative: 1, mixed: 1 }),
      mention("Toyota", 5, { positive: 50, neutral: 0, negative: 0, mixed: 0 }),
    ]),
    job("j2", [mention("Genesis", 1, { positive: 2, neutral: 1, negative: 4, mixed: 2 })]),
    job("j3", [mention("Kia", 1)]), // sentiment 미채점 답변 — 분모에 기여하지 않음
  ];

  it("같은 입력에서 두 값이 반올림 자리까지 일치한다", async () => {
    const s = await sentimentOf(jobs);
    const t = aggregateMentionsFrom(jobs, new Map())!.sentimentTotals!;
    const denom = t.positive + t.neutral + t.negative + t.mixed;
    const positiveSegmentShare = Math.round((1000 * t.positive) / denom) / 10;

    expect(denom).toBe(s.sampledMentions);
    expect(t.positive).toBe(s.positiveMentions);
    expect(positiveSegmentShare).toBe(s.positiveRate);
  });

  it("당사 언급의 sentiment 가 전무하면 감정 분포는 null (측정 대기)", () => {
    const m = aggregateMentionsFrom([job("j1", [mention("Hyundai", 3)])], new Map());
    expect(m!.sentimentTotals).toBeNull();
  });
});

describe("공개 API 폴백 — tracked 한정 + mixed 분기", () => {
  function row(brand: string, sentiment: BrandMention["brand_sentiment"]): BrandMention {
    return {
      brand_mention_id: `${brand}-${sentiment}`,
      brand_name: brand,
      query_run_id: `q-${brand}-${sentiment}`,
      brand_sentiment: sentiment,
      measured_at: "2026-07-27T00:00:00Z",
      prompt_id: `p-${brand}`,
      target: "chatgpt",
    } as BrandMention;
  }

  it("경쟁사 행은 감정 분포에서 제외되고 mixed 는 mixed 로 분류된다", () => {
    const live = aggregateMentionsFromPublic([
      row("Hyundai", "positive"),
      row("Hyundai", "mixed"),
      row("Kia", "negative"),
      row("Toyota", "positive"), // 경쟁사 — 계상 금지
      row("Toyota", "mixed"),
    ]);
    expect(live!.sentimentTotals).toEqual({
      positive: 1,
      neutral: 0,
      negative: 1,
      mixed: 1,
    });
  });

  it("당사 행에 감정이 하나도 없으면 null (측정 대기)", () => {
    const live = aggregateMentionsFromPublic([
      row("Hyundai", undefined),
      row("Toyota", "positive"),
    ]);
    expect(live!.sentimentTotals).toBeNull();
  });
});
