import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Sub KPI 파트 선택(`opts.parts`)의 계약 고정 — 2026-09-02.
//
// 지키는 명제는 둘이다:
//   1) **미지정 = 전량**. 문장 5개가 그대로 발행되고 산출도 종전과 동일하다.
//      (KPI 탭이 아닌 기존 호출부 — 언급 본문·측정 개요·대시보드 — 의 불변식)
//   2) 좁히면 **그 문장이 실제로 안 나간다**. "필드를 나중에 버린다"가 아니라
//      DB 왕복 자체가 줄어야 이 변경의 목적(히어로 31.0s)이 달성된다.
//
// DB 는 kpi-tabs 테스트와 같은 방식으로 목킹한다 — withAnswerSet 의 트랜잭션을
// 그대로 태우고 문장 텍스트로 어느 쿼리인지 판별해 캔드 행을 준다.

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q).sql;
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

type Responder = { when: (text: string) => boolean; rows: unknown[] };

const executed: string[] = [];
let responders: Responder[] = [];

const tx = {
  execute: vi.fn(async (q: SQL) => {
    const text = flat(compile(q));
    executed.push(text);
    const hit = responders.find((r) => r.when(text));
    return (hit?.rows ?? []) as unknown[];
  }),
};
const transaction = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
vi.mock("@/lib/db", () => ({ getDb: () => ({ transaction, execute: tx.execute }) }));

beforeEach(() => {
  executed.length = 0;
  responders = [];
  tx.execute.mockClear();
  transaction.mockClear();
});

const load = () => import("./scope-aggregates");

// 문장 지문 — 각 파트가 발행하는 SELECT 의 고유 조각.
const Q = {
  answers: (t: string) => t.includes("FROM ans GROUP BY target"),
  mentions: (t: string) => t.includes("GROUP BY x.target"),
  sentiment: (t: string) => t.includes("sum(m.sentiment_positive)"),
  citations: (t: string) => t.includes("GROUP BY c2.target"),
  prompts: (t: string) => t.includes('AS missing'),
} as const;

type Part = keyof typeof Q;
const ALL: Part[] = ["answers", "mentions", "sentiment", "citations", "prompts"];
const issued = (): Part[] => ALL.filter((p) => executed.some((t) => Q[p](t)));

// 캔드 행 — 엔진 2개, 파트마다 다른 값. 좁혔을 때 어떤 필드가 0 이 되는지 보인다.
function candRows(): Responder[] {
  return [
    {
      when: Q.answers,
      rows: [
        { target: "chatgpt", answers: 100, tracked: 80, multi: 70, top1: 5, top3: 12, avg_position: "3.4" },
        { target: "gemini", answers: 90, tracked: 40, multi: 30, top1: 2, top3: 6, avg_position: "5.1" },
      ],
    },
    {
      when: Q.mentions,
      rows: [
        { target: "chatgpt", total: 400, tracked: 100 },
        { target: "gemini", total: 600, tracked: 50 },
      ],
    },
    {
      when: Q.sentiment,
      rows: [{ target: "chatgpt", p: 30, ne: 10, ng: 5, mx: 2 }],
    },
    {
      when: Q.citations,
      rows: [{ target: "chatgpt", total: 900, owned: 120 }],
    },
    { when: Q.prompts, rows: [{ missing: 3, prompts: 230 }] },
  ];
}

const ROOT = { SCOPE_MODE: "mock" };

describe("aggregateSubKpisFromMirror — opts.parts", () => {
  beforeEach(() => {
    process.env.SCOPE_MODE = ROOT.SCOPE_MODE;
  });

  it("미지정이면 5문장 전부 발행하고 종전 산출을 낸다", async () => {
    responders = candRows();
    const { aggregateSubKpisFromMirror } = await load();
    const out = await aggregateSubKpisFromMirror({}, "p1", []);

    expect(issued()).toEqual(ALL);
    expect(out.measuredPrompts).toBe(230);
    expect(out.promptsWithoutBrand).toBe(3);
    expect(out.rows[0]).toMatchObject({
      engine: "chatgpt",
      answers: 100,
      tracked: 80,
      totalMentions: 400,
      trackedMentions: 100,
      sentMentions: 47,
      positiveMentions: 30,
      negativeMentions: 5,
      citTotal: 900,
      citOwned: 120,
    });
  });

  it("좁히면 그 문장이 실제로 안 나간다 (노출률 히어로 = answers 만)", async () => {
    responders = candRows();
    const { aggregateSubKpisFromMirror } = await load();
    const out = await aggregateSubKpisFromMirror({}, "p1", [], undefined, false, {
      parts: ["answers"],
    });

    expect(issued()).toEqual(["answers"]);
    // 요청한 파트는 전량과 같은 값.
    expect(out.rows.map((r) => [r.engine, r.answers, r.tracked])).toEqual([
      ["chatgpt", 100, 80],
      ["gemini", 90, 40],
    ]);
    // 계산하지 않은 파트는 0 / null — "측정 없음"과 구분되지 않는다(그래서 그
    // 필드를 읽는 지면에 이 결과를 흘리면 안 된다).
    expect(out.rows[0]!.totalMentions).toBe(0);
    expect(out.rows[0]!.citTotal).toBe(0);
    expect(out.measuredPrompts).toBeNull();
  });

  it("점유율 히어로 = answers + mentions 두 문장만", async () => {
    responders = candRows();
    const { aggregateSubKpisFromMirror } = await load();
    const out = await aggregateSubKpisFromMirror({}, "p1", [], undefined, false, {
      parts: ["answers", "mentions"],
    });

    expect(issued()).toEqual(["answers", "mentions"]);
    expect(out.rows.map((r) => [r.totalMentions, r.trackedMentions])).toEqual([
      [400, 100],
      [600, 50],
    ]);
    expect(out.rows[0]!.sentMentions).toBe(0);
  });

  it("좁힌 결과의 해당 필드는 전량과 완전히 같다 (필드별 대조)", async () => {
    const { aggregateSubKpisFromMirror } = await load();
    responders = candRows();
    const full = await aggregateSubKpisFromMirror({}, "p1", []);
    executed.length = 0;
    responders = candRows();
    const part = await aggregateSubKpisFromMirror({}, "p1", [], undefined, false, {
      parts: ["answers", "mentions"],
    });

    const pick = (s: typeof full) =>
      s.rows.map((r) => ({
        engine: r.engine,
        answers: r.answers,
        tracked: r.tracked,
        multi: r.multi,
        top1: r.top1,
        top3: r.top3,
        avgPosition: r.avgPosition,
        totalMentions: r.totalMentions,
        trackedMentions: r.trackedMentions,
      }));
    expect(pick(part)).toEqual(pick(full));
  });

  it("answers 를 빼도 Q1 은 돈다 — rows 가 통째로 비면 '측정 없음' 위장이 된다", async () => {
    responders = candRows();
    const { aggregateSubKpisFromMirror } = await load();
    const out = await aggregateSubKpisFromMirror({}, "p1", [], undefined, false, {
      parts: ["sentiment"],
    });

    expect(issued()).toEqual(["answers", "sentiment"]);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]!.positiveMentions).toBe(30);
  });

  it("빈 배열도 행 골격은 남긴다(결과가 요청보다 비지 않는다)", async () => {
    responders = candRows();
    const { aggregateSubKpisFromMirror } = await load();
    const out = await aggregateSubKpisFromMirror({}, "p1", [], undefined, false, { parts: [] });
    expect(issued()).toEqual(["answers"]);
    expect(out.rows).toHaveLength(2);
  });
});
