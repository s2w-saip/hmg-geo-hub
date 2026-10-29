import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// 답변분석 > Mention 4-KPI 탭 집계 4종의 계약 고정.
//
// 여기서 지키는 것은 "SQL 이 무엇을 돌려주는가"가 아니라 **돌려준 것을 어떻게
// 접는가**다 — 회차 갭(측정 없음)과 진짜 0의 구분, 브랜드 cap 경계, 점유율 분모가
// cap 밖 브랜드까지 포함하는지, 순위 null 전파. 이 넷이 전부 화면에서 "조용히
// 틀린 수"로 나타나는 자리라, DB 없이 고정해 둔다.
//
// DB 는 answer-set-tx 테스트와 같은 방식으로 목킹한다: withAnswerSet 의
// 트랜잭션을 그대로 태우고, 문장 텍스트로 어느 쿼리인지 판별해 캔드 행을 준다.

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

// 문장 판별자 — 각 쿼리의 고유한 SELECT 지문.
const isBucketAnswers = (t: string) =>
  t.includes("FROM ans GROUP BY bucket ORDER BY bucket") && t.includes("AS answers");
const isBucketCoverageOnly = (t: string) =>
  t.includes("FROM ans GROUP BY bucket ORDER BY bucket") && !t.includes("AS answers");
const isBucketBrands = (t: string) =>
  t.includes("FROM per GROUP BY 1, 2") && t.includes("count(*)::int AS answers");
// 엔진 KPI 는 단계별로 **한 문장**이다 (2026-09-02 단일 패스 병합) — 답변 플래그와
// 언급 합계를 per_job CTE 하나로 접고 답변셋에 되붙인다. 두 단계를 가르는 지문은
// 되붙이는 대상: 스냅샷은 `_answer_set`, 추이는 셀 스냅샷 CTE `ans`.
const isSnapshotEngines = (t: string) => t.includes("FROM _answer_set a LEFT JOIN per_job pj");
const isTrendEngines = (t: string) => t.includes("FROM ans LEFT JOIN per_job pj");
const isTypeTotals = (t: string) => t.includes("count(*)::int AS answers FROM _answer_set");
const isTypeRows = (t: string) => t.includes("FROM per GROUP BY type");
const isPositionSnapshot = (t: string) =>
  t.includes("FROM per GROUP BY 1") && !t.includes("FROM per GROUP BY 1, 2");
const isPositionTrend = (t: string) =>
  t.includes("FROM per GROUP BY 1, 2") && t.includes("avg(pos)");
const isCreateAnswerSet = (t: string) => t.includes("CREATE TEMP TABLE _answer_set");

const W1 = "2026-08-03T00:00:00.000Z"; // 측정 있음
const W3 = "2026-08-17T00:00:00.000Z"; // 측정 있음 (W2 = 결측 회차)

describe("aggregateBrandTrendFromMirror — 회차×브랜드", () => {
  it("결측 회차는 버킷 자체가 없고(갭), 측정된 회차의 무언급은 0으로 채운다", async () => {
    responders = [
      {
        when: isBucketAnswers,
        rows: [
          { bucket: W1, answers: 10, measured_days: 2, first_at: W1, last_at: W1 },
          { bucket: W3, answers: 8, measured_days: 1, first_at: W3, last_at: W3 },
        ],
      },
      {
        when: isBucketBrands,
        rows: [
          { bucket: W1, name: "Hyundai", mentions: 5, answers: 4, is_tracked: true },
          { bucket: W1, name: "Toyota", mentions: 5, answers: 3, is_tracked: false },
          { bucket: W3, name: "Toyota", mentions: 2, answers: 2, is_tracked: false },
        ],
      },
    ];
    const { aggregateBrandTrendFromMirror } = await load();
    const out = await aggregateBrandTrendFromMirror({}, undefined);

    // 결측 회차(W2)는 행 자체가 없다 — 직전값으로 잇지 않는다.
    expect(out.buckets.map((b) => b.bucketStart)).toEqual(["2026-08-03", "2026-08-17"]);

    const w1 = out.buckets[0]!;
    expect(w1.totalMentions).toBe(10);
    const hyundaiW1 = w1.brands.find((b) => b.brand === "Hyundai")!;
    expect(hyundaiW1.exposurePct).toBe(40); // 4/10
    expect(hyundaiW1.sharePct).toBe(50); // 5/10

    // W3 은 측정이 있었고 Hyundai 언급만 없다 → null(갭)이 아니라 0.
    const hyundaiW3 = out.buckets[1]!.brands.find((b) => b.brand === "Hyundai")!;
    expect(hyundaiW3.mentions).toBe(0);
    expect(hyundaiW3.exposurePct).toBe(0);
    expect(hyundaiW3.sharePct).toBe(0);
  });

  it("답변은 있는데 브랜드 언급이 전무한 회차는 점유율 분모가 0 → null", async () => {
    responders = [
      {
        when: isBucketAnswers,
        rows: [{ bucket: W1, answers: 4, measured_days: 1, first_at: W1, last_at: W1 }],
      },
      { when: isBucketBrands, rows: [] },
    ];
    const { aggregateBrandTrendFromMirror } = await load();
    const out = await aggregateBrandTrendFromMirror({}, undefined);
    expect(out.buckets).toHaveLength(1);
    expect(out.buckets[0]!.totalMentions).toBe(0);
    expect(out.brands).toEqual([]);
  });

  it("cap 은 비교 대상 상한이며 당사(tracked)는 cap 밖이어도 남는다", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      bucket: W1,
      name: `B${String(i + 1).padStart(2, "0")}`,
      mentions: 100 - i,
      answers: 1,
      is_tracked: false,
    }));
    rows.push({ bucket: W1, name: "Genesis", mentions: 1, answers: 1, is_tracked: true });
    responders = [
      {
        when: isBucketAnswers,
        rows: [{ bucket: W1, answers: 20, measured_days: 1, first_at: W1, last_at: W1 }],
      },
      { when: isBucketBrands, rows },
    ];
    const { aggregateBrandTrendFromMirror } = await load();

    const capped = await aggregateBrandTrendFromMirror({}, undefined, { topBrands: 10 });
    const names = capped.brands.map((b) => b.brand);
    expect(names).toHaveLength(11); // 상위 10 + 당사 1
    expect(names.slice(0, 10)).toEqual([
      "B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B09", "B10",
    ]);
    expect(names).toContain("Genesis");
    expect(names).not.toContain("B11");

    // 점유율 분모는 cap 밖 브랜드까지 포함한 전 브랜드 합이어야 한다 —
    // 자르면 분모가 함께 줄어 남은 브랜드의 점유율이 부풀려진다.
    const totalAll = rows.reduce((s, r) => s + r.mentions, 0);
    expect(capped.buckets[0]!.totalMentions).toBe(totalAll);

    const capZero = await aggregateBrandTrendFromMirror({}, undefined, { topBrands: 0 });
    expect(capZero.brands.map((b) => b.brand)).toEqual(["Genesis"]);
  });

  it("기본 cap 은 10 이고, 음수·NaN 은 0 으로 죈다", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      bucket: W1,
      name: `B${String(i + 1).padStart(2, "0")}`,
      mentions: 100 - i,
      answers: 1,
      is_tracked: false,
    }));
    responders = [
      {
        when: isBucketAnswers,
        rows: [{ bucket: W1, answers: 20, measured_days: 1, first_at: W1, last_at: W1 }],
      },
      { when: isBucketBrands, rows },
    ];
    const { aggregateBrandTrendFromMirror } = await load();
    expect((await aggregateBrandTrendFromMirror({}, undefined)).brands).toHaveLength(10);
    expect(
      (await aggregateBrandTrendFromMirror({}, undefined, { topBrands: -3 })).brands,
    ).toHaveLength(0);
    expect(
      (await aggregateBrandTrendFromMirror({}, undefined, { topBrands: Number.NaN })).brands,
    ).toHaveLength(0);
  });

  it("trendDays 는 정수·범위로 죄어 interval 리터럴에 합성된다", async () => {
    responders = [{ when: isBucketAnswers, rows: [] }];
    const { aggregateBrandTrendFromMirror } = await load();
    await aggregateBrandTrendFromMirror({}, undefined, { trendDays: 28 });
    expect(executed.find(isCreateAnswerSet)!).toContain("interval '28 days'");
    executed.length = 0;
    // 0·음수·NaN → 기본값, 상한 초과 → 365 로 클램프. 문자열이 SQL 로 새지 않는다.
    await aggregateBrandTrendFromMirror({}, undefined, { trendDays: 0 });
    expect(executed.find(isCreateAnswerSet)!).toContain("interval '120 days'");
    executed.length = 0;
    await aggregateBrandTrendFromMirror({}, undefined, { trendDays: 99999 });
    expect(executed.find(isCreateAnswerSet)!).toContain("interval '365 days'");
    executed.length = 0;
    await aggregateBrandTrendFromMirror({}, undefined, {
      trendDays: "30 days'; DROP TABLE scope_answers --" as unknown as number,
    });
    const create = executed.find(isCreateAnswerSet)!;
    expect(create).toContain("interval '120 days'");
    expect(create).not.toContain("DROP TABLE");
  });

  it("추이 답변셋은 allRuns + measured_at 존재 + 120일 바닥으로 좁힌다", async () => {
    responders = [{ when: isBucketAnswers, rows: [] }];
    const { aggregateBrandTrendFromMirror } = await load();
    await aggregateBrandTrendFromMirror({ region: ["KR"], engine: ["gemini"] }, undefined);
    const create = executed.find(isCreateAnswerSet)!;
    expect(create).toContain("a.run_id IN (SELECT run_id FROM scope_runs");
    expect(create).toContain("a.measured_at IS NOT NULL");
    expect(create).toContain("interval '120 days'");
    expect(create).toMatch(/a\.region IN/);
    expect(create).toMatch(/a\.target IN/);
    // 스냅샷(셀당 최신 1건) 접기가 아니어야 한다 — 회차가 하나로 붕괴한다.
    expect(create).not.toContain("DISTINCT ON (a.prompt_id, a.target, a.region) a.job_id");
  });

  it("버킷 단위는 주가 기본, day 만 허용 — 그 외 값은 주로 되돌린다(화이트리스트)", async () => {
    responders = [{ when: isBucketAnswers, rows: [] }];
    const { aggregateBrandTrendFromMirror } = await load();
    expect((await aggregateBrandTrendFromMirror({}, undefined)).unit).toBe("week");
    expect(
      (await aggregateBrandTrendFromMirror({}, undefined, { unit: "day" })).unit,
    ).toBe("day");
    expect(
      (await aggregateBrandTrendFromMirror({}, undefined, {
        // 사용자 입력이 date_trunc 필드 토큰으로 새지 않는지 — 타입을 뚫고 들어온 값.
        unit: "month; DROP TABLE" as unknown as "week",
      })).unit,
    ).toBe("week");
    // 어떤 경우에도 필드는 bind 파라미터로만 나간다(리터럴 합성 금지).
    expect(executed.filter(isCreateAnswerSet).every((c) => c.includes("date_trunc($"))).toBe(true);
  });
});

describe("aggregateEngineKpiTrendFromMirror — 엔진별", () => {
  it("최신 스칼라는 스냅샷 창, 시계열은 allRuns 창에서 낸다", async () => {
    responders = [
      {
        when: isSnapshotEngines,
        rows: [
          {
            target: "chatgpt", answers: 100, tracked: 40, last_at: W3,
            total: 200, tracked_mentions: 60,
          },
          // 언급이 0건인 엔진 — 병합 후에는 LEFT JOIN 이 NULL 을 내고 SQL 의
          // COALESCE 가 0 으로 접는다.
          {
            target: "gemini", answers: 50, tracked: 10, last_at: W1,
            total: 0, tracked_mentions: 0,
          },
        ],
      },
      {
        when: isTrendEngines,
        rows: [
          {
            bucket: W1, target: "chatgpt", answers: 10, tracked: 5,
            measured_days: 2, first_at: W1, last_at: W1,
            total: 20, tracked_mentions: 8,
          },
          {
            bucket: W1, target: "gemini", answers: 8, tracked: 0,
            measured_days: 1, first_at: W1, last_at: W1,
            total: 0, tracked_mentions: 0,
          },
          {
            bucket: W3, target: "chatgpt", answers: 6, tracked: 3,
            measured_days: 1, first_at: W3, last_at: W3,
            total: 0, tracked_mentions: 0,
          },
        ],
      },
    ];
    const { aggregateEngineKpiTrendFromMirror } = await load();
    const out = await aggregateEngineKpiTrendFromMirror({}, undefined);

    const creates = executed.filter(isCreateAnswerSet);
    expect(creates).toHaveLength(2);
    expect(creates[0]).toContain("a.job_id IN"); // 스냅샷
    expect(creates[1]).toContain("a.run_id IN"); // 추이

    const chat = out.latest.find((e) => e.engine === "chatgpt")!;
    expect(chat.exposurePct).toBe(40); // 40/100
    expect(chat.sovPct).toBe(30); // 60/200
    // 언급이 0건인 엔진은 0% 가 아니라 null (분모 0 = 측정 없음)
    const gem = out.latest.find((e) => e.engine === "gemini")!;
    expect(gem.exposurePct).toBe(20);
    expect(gem.sovPct).toBeNull();
    expect(out.latestMeasuredAt).toBe(new Date(W3).toISOString());

    expect(out.engines).toEqual(["chatgpt", "gemini"]);
    expect(out.buckets.map((b) => b.bucketStart)).toEqual(["2026-08-03", "2026-08-17"]);
    const w1 = out.buckets[0]!;
    expect(w1.measuredDays).toBe(2);
    expect(w1.engines.find((e) => e.engine === "gemini")!.sovPct).toBeNull();
    expect(w1.engines.find((e) => e.engine === "chatgpt")!.sovPct).toBe(40); // 8/20
  });

  it("결측 회차는 버킷을 만들지 않는다", async () => {
    responders = [
      {
        when: isTrendEngines,
        rows: [
          {
            bucket: W3, target: "chatgpt", answers: 6, tracked: 3,
            measured_days: 1, first_at: W3, last_at: W3,
            total: 0, tracked_mentions: 0,
          },
        ],
      },
    ];
    const { aggregateEngineKpiTrendFromMirror } = await load();
    const out = await aggregateEngineKpiTrendFromMirror({}, undefined);
    expect(out.buckets.map((b) => b.bucketStart)).toEqual(["2026-08-17"]);
    expect(out.latest).toEqual([]);
  });
});

describe("aggregateTypeKpiFromMirror — 유형 5종 × 브랜드군", () => {
  const typeRow = (type: string, over: Record<string, number> = {}) => ({
    type,
    own_mentions: 0, other_mentions: 0,
    own_answers: 0, other_answers: 0,
    own_rows: 0, all_rows: 0,
    own_p: 0, own_ne: 0, own_ng: 0, own_mx: 0,
    all_p: 0, all_ne: 0, all_ng: 0, all_mx: 0,
    ...over,
  });

  it("SQL 이 일부 유형만 돌려줘도 5종이 모두(0으로) 나온다", async () => {
    responders = [
      { when: isTypeTotals, rows: [{ answers: 200 }] },
      {
        when: isTypeRows,
        rows: [
          typeRow("recommendation", {
            own_mentions: 30, other_mentions: 70,
            own_answers: 20, other_answers: 50,
            own_rows: 25, all_rows: 90,
            own_p: 18, own_ne: 5, own_ng: 2, own_mx: 0,
            all_p: 40, all_ne: 30, all_ng: 15, all_mx: 5,
          }),
        ],
      },
    ];
    const { aggregateTypeKpiFromMirror, MENTION_TYPE_KEYS } = await load();
    const out = await aggregateTypeKpiFromMirror({}, undefined);

    expect(out.rows.map((r) => r.type)).toEqual([...MENTION_TYPE_KEYS]);
    expect(out.sentimentMatrix.own.map((r) => r.type)).toEqual([...MENTION_TYPE_KEYS]);
    expect(out.sentimentMatrix.all.map((r) => r.type)).toEqual([...MENTION_TYPE_KEYS]);

    const rec = out.rows.find((r) => r.type === "recommendation")!;
    expect(rec.totalMentions).toBe(100);
    expect(rec.ownSharePct).toBe(30); // 30/100
    expect(rec.ownExposurePct).toBe(10); // 20/200
    expect(rec.otherExposurePct).toBe(25); // 50/200

    // 신호가 전무한 유형은 분모 0 → null (0% 로 찍으면 "측정했는데 0" 이 된다)
    const def = out.rows.find((r) => r.type === "definition")!;
    expect(def.ownSharePct).toBeNull();
    expect(def.ownExposurePct).toBe(0); // 분모(전체 답변)는 있으므로 진짜 0

    // 당사 매트릭스와 전체 매트릭스는 분리돼 있어야 한다 (토글용)
    const ownRec = out.sentimentMatrix.own.find((r) => r.type === "recommendation")!;
    const allRec = out.sentimentMatrix.all.find((r) => r.type === "recommendation")!;
    expect(ownRec.positive).toBe(18);
    expect(allRec.positive).toBe(40);
    expect(ownRec.rows).toBe(25);
    expect(allRec.rows).toBe(90);

    expect(out.totalAnswers).toBe(200);
    expect(out.ownMentions).toBe(30);
    expect(out.totalMentions).toBe(100);
  });

  it("모집단이 비면 노출률 분모가 0 → 전부 null", async () => {
    responders = [
      { when: isTypeTotals, rows: [{ answers: 0 }] },
      { when: isTypeRows, rows: [] },
    ];
    const { aggregateTypeKpiFromMirror } = await load();
    const out = await aggregateTypeKpiFromMirror({}, undefined);
    expect(out.totalAnswers).toBe(0);
    expect(out.rows.every((r) => r.ownExposurePct === null)).toBe(true);
    expect(out.rows.every((r) => r.ownSharePct === null)).toBe(true);
  });

  it("모집단 술어는 스냅샷 detailAnswerWhere 그대로 (필터가 답변셋에 실린다)", async () => {
    responders = [{ when: isTypeTotals, rows: [{ answers: 0 }] }];
    const { aggregateTypeKpiFromMirror } = await load();
    await aggregateTypeKpiFromMirror({ region: ["US"] }, undefined);
    const create = executed.find(isCreateAnswerSet)!;
    expect(create).toContain("a.job_id IN");
    expect(create).toMatch(/a\.region IN/);
  });
});

describe("aggregateFirstPositionFromMirror — 우선 노출도", () => {
  it("언급 0건 브랜드는 0위·0% 가 아니라 null (측정 없음)", async () => {
    responders = [
      {
        when: isPositionSnapshot,
        rows: [
          { name: "Hyundai", avg_position: "2.5", ranked_answers: 40, mentions: 90, is_tracked: true },
          { name: "Toyota", avg_position: "1.2", ranked_answers: 30, mentions: 70, is_tracked: false },
        ],
      },
      {
        when: isBucketCoverageOnly,
        rows: [{ bucket: W1, measured_days: 2, first_at: W1, last_at: W1 }],
      },
      {
        when: isPositionTrend,
        rows: [
          { bucket: W1, name: "Hyundai", avg_position: "2.5", ranked_answers: 10, mentions: 20, is_tracked: true },
          { bucket: W1, name: "Toyota", avg_position: "1.2", ranked_answers: 8, mentions: 15, is_tracked: false },
          // 추이 창에는 있었지만 스냅샷 창에는 없는 브랜드 — 순위 테이블에 남되 null.
          { bucket: W1, name: "Ford", avg_position: null, ranked_answers: 0, mentions: 3, is_tracked: false },
        ],
      },
    ];
    const { aggregateFirstPositionFromMirror } = await load();
    const out = await aggregateFirstPositionFromMirror({}, undefined);

    const ford = out.latest.find((r) => r.brand === "Ford")!;
    expect(ford.avgPosition).toBeNull();
    expect(ford.rank).toBeNull();
    expect(ford.rankedAnswers).toBe(0);
    // 순위 없는 행은 표 끝으로 밀린다
    expect(out.latest[out.latest.length - 1]!.brand).toBe("Ford");

    // 순위는 avgPosition 오름차순 (1위가 가장 앞)
    expect(out.latest.map((r) => r.brand)).toEqual(["Toyota", "Hyundai", "Ford"]);
    expect(out.latest[0]!.rank).toBe(1);
    expect(out.latest[1]!.rank).toBe(2);

    // 버킷 안에서 순위가 없는 브랜드도 null 전파 (0 으로 채우면 1위보다 앞선 값이 된다)
    const fordPoint = out.buckets[0]!.brands.find((b) => b.brand === "Ford")!;
    expect(fordPoint.avgPosition).toBeNull();
  });

  it("동률은 공동 순위이고 다음 순위를 건너뛴다", async () => {
    responders = [
      {
        when: isPositionSnapshot,
        rows: [
          { name: "A", avg_position: "1.5", ranked_answers: 5, mentions: 10, is_tracked: false },
          { name: "B", avg_position: "1.5", ranked_answers: 5, mentions: 9, is_tracked: false },
          { name: "C", avg_position: "3.0", ranked_answers: 5, mentions: 8, is_tracked: false },
        ],
      },
      { when: isBucketCoverageOnly, rows: [] },
      { when: isPositionTrend, rows: [] },
    ];
    const { aggregateFirstPositionFromMirror } = await load();
    const out = await aggregateFirstPositionFromMirror({}, undefined);
    expect(out.latest.map((r) => [r.brand, r.rank])).toEqual([
      ["A", 1],
      ["B", 1],
      ["C", 3],
    ]);
  });

  it("결측 회차는 버킷을 만들지 않고, cap 은 당사를 보존한다", async () => {
    const trendRows = Array.from({ length: 12 }, (_, i) => ({
      bucket: W1,
      name: `B${String(i + 1).padStart(2, "0")}`,
      avg_position: "2.0",
      ranked_answers: 3,
      mentions: 100 - i,
      is_tracked: false,
    }));
    trendRows.push({
      bucket: W1, name: "Kia", avg_position: "9.0",
      ranked_answers: 1, mentions: 1, is_tracked: true,
    });
    responders = [
      { when: isPositionSnapshot, rows: [] },
      {
        when: isBucketCoverageOnly,
        rows: [
          { bucket: W1, measured_days: 1, first_at: W1, last_at: W1 },
          { bucket: W3, measured_days: 1, first_at: W3, last_at: W3 },
        ],
      },
      { when: isPositionTrend, rows: trendRows },
    ];
    const { aggregateFirstPositionFromMirror } = await load();
    const out = await aggregateFirstPositionFromMirror({}, undefined, { topBrands: 10 });

    expect(out.buckets.map((b) => b.bucketStart)).toEqual(["2026-08-03", "2026-08-17"]);
    expect(out.brands).toHaveLength(11);
    expect(out.brands).toContain("Kia");
    // 스냅샷이 비었으니 순위 테이블은 전부 "측정 없음"
    expect(out.latest.every((r) => r.avgPosition === null && r.rank === null)).toBe(true);
    // 측정은 있었으나 그 회차 데이터가 없는 W3 도 브랜드 점은 null (0 아님)
    expect(out.buckets[1]!.brands.every((b) => b.avgPosition === null)).toBe(true);
  });

  it("스냅샷/추이 두 창을 각각 연다 (모집단 술어는 detailAnswerWhere 하나)", async () => {
    responders = [];
    const { aggregateFirstPositionFromMirror } = await load();
    await aggregateFirstPositionFromMirror({ engine: ["chatgpt"] }, undefined);
    const creates = executed.filter(isCreateAnswerSet);
    expect(creates).toHaveLength(2);
    expect(creates[0]).toContain("a.job_id IN");
    expect(creates[1]).toContain("a.run_id IN");
    expect(creates.every((c) => /a\.target IN/.test(c))).toBe(true);
  });
});

describe("detailAnswerWhere — allRuns 모드 (신규 3번째 인자)", () => {
  it("인자 2개 호출의 SQL 은 종전과 완전히 동일하다 (기존 호출부 무영향)", async () => {
    const { detailAnswerWhere } = await load();
    const a = compile(detailAnswerWhere({ region: ["KR"] }, "p1"));
    const b = compile(detailAnswerWhere({ region: ["KR"] }, "p1", {}));
    const c = compile(detailAnswerWhere({ region: ["KR"] }, "p1", { allRuns: false }));
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toContain("a.job_id IN");
  });

  it("allRuns 는 셀당 최신 접기를 버리고 런 스코프 + completed 로 좁힌다", async () => {
    const { detailAnswerWhere } = await load();
    const text = flat(compile(detailAnswerWhere({}, undefined, { allRuns: true })));
    expect(text).toContain("a.status = 'completed'");
    expect(text).toContain("a.run_id IN (SELECT run_id FROM scope_runs");
    expect(text).not.toContain("a.job_id IN");
  });

  it("allRuns 프로젝트 경로는 run→project_id 로 좁힌다", async () => {
    const { detailAnswerWhere } = await load();
    const q = dialect.sqlToQuery(
      detailAnswerWhere({}, ["p1", "p2"], { allRuns: true }),
    );
    // 프로젝트 id 는 배열 바인드 1개다(PR① B4-b) — `IN ($1,$2,…)` 인라인 아님.
    expect(flat(q.sql)).toContain("SELECT run_id FROM scope_runs WHERE project_id = ANY(");
    expect(q.params).toContainEqual(["p1", "p2"]);
  });

  it("allRuns 는 기간을 measured_at 행 범위로 클리핑한다 (추이 시맨틱)", async () => {
    const { detailAnswerWhere } = await load();
    const snap = flat(compile(detailAnswerWhere({ dateFrom: "2026-08-01", dateTo: "2026-08-20" }, "p1")));
    const all = flat(
      compile(detailAnswerWhere({ dateFrom: "2026-08-01", dateTo: "2026-08-20" }, "p1", { allRuns: true })),
    );
    expect(all).toContain("a.measured_at >=");
    expect(all).toContain("a.measured_at <");
    // 스냅샷은 **사용자 기간**을 런(started_at)에 걸고 행 클리핑을 하지 않는다.
    // (#217 이후 스냅샷에도 `a.measured_at >= pm.floor_at` 이 있지만 그건 "측정이
    //  끊긴 셀 제외"용 셀 신선도 바닥이지 사용자 기간이 아니다 — 파라미터 바인딩이
    //  붙는 사용자 기간 클리핑만 없어야 한다.)
    expect(snap).toContain("r.started_at >=");
    expect(snap).not.toMatch(/a\.measured_at >= \$/);
  });

  it("allRuns 에서도 카탈로그·website 축 술어는 그대로 걸린다", async () => {
    const { detailAnswerWhere } = await load();
    const text = flat(
      compile(
        detailAnswerWhere(
          { brand: ["Kia"], websiteCountry: ["IN"], funnelStage: ["인지/탐색"] },
          ["p1"],
          { allRuns: true },
        ),
      ),
    );
    expect(text).toContain("SELECT scope_prompt_id FROM prompts WHERE");
    expect(text).toContain("JOIN website_sites");
    // 퍼널은 카탈로그(prompts.funnel_stage) 우선 + scope 값 폴백(#197).
    expect(text).toContain("COALESCE(pc.funnel_stage, sp.funnel_stage) IN");
  });
});
