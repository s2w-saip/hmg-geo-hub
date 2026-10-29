import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { TrendAggregates, TrendOwnRow } from "./summary-trend-aggregates";
import type { WebsiteCyclePick } from "./summary-cycles";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

// 회차 버킷 추이(PR③)의 **화면 계약**을 고정한다. 라이브에는 아직 회차 주가 하나뿐이라
// (2026-09-10 실측: website `cycle_week` `2026-08-31` 1개) "회차 ≥ 2" 는 실 DB 로 확인할
// 수 없다 — 그 구간을 여기서 픽스처로 못 박는다. 값 동치(집계층 카드 대비 정수 0 오차)는
// 실DB 하네스 `scripts/summary/parity-website-trend.ts --card` 몫이다.
//
// ⚠️ 버킷 키는 `cycle_week` 다(검증자 D-1). 함대 회차는 프로젝트마다 anchor 가 다를 수
//    있어(실측: open 9/07주 66회차 = distinct anchor 66개) anchor 로 접으면 한 회차가
//    여러 점으로 갈린다 — 자정을 걸치는 케이스가 아래 회귀 테스트다.

const readTrendAggregates = vi.fn<[unknown, unknown], Promise<TrendAggregates>>();
vi.mock("./summary-trend-aggregates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./summary-trend-aggregates")>();
  return {
    ...actual,
    readTrendAggregates: (scope: unknown, opts: unknown) => readTrendAggregates(scope, opts),
  };
});

const execute = vi.fn<[SQL], Promise<unknown>>();
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: (q: SQL) => execute(q) }) }));
vi.mock("@/lib/summary/read/presence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/summary/read/presence")>();
  return { ...actual, presenceSetColumnAvailable: () => Promise.resolve(true) };
});

const {
  summaryWebsiteTrend,
  summaryWebsiteCitationAccuracyTrend,
  websiteTrendBucketsFrom,
} = await import("./summary-website-aggregates");

const dialect = new PgDialect();
const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const cyc = (n: number, project: string, anchor: string, week: string): WebsiteCyclePick => ({
  cycleId: `aaaaaaaa-0000-0000-0000-00000000000${n}`,
  generationId: `bbbbbbbb-0000-0000-0000-00000000000${n}`,
  projectId: project,
  cycleAnchorAt: anchor,
  cycleWeek: week,
});

// 회차 2개(9/4 · 9/11) × 프로젝트 2개 — 함대 형태를 최소로 줄인 것.
const CYCLES: WebsiteCyclePick[] = [
  cyc(1, P1, "2026-09-04T00:00:00.000Z", "2026-08-31"),
  cyc(2, P2, "2026-09-04T02:00:00.000Z", "2026-08-31"),
  cyc(3, P1, "2026-09-11T00:00:00.000Z", "2026-09-07"),
  cyc(4, P2, "2026-09-11T00:00:00.000Z", "2026-09-07"),
];
const SET: CycleSet = {
  surface: "website",
  mode: "period",
  cycles: CYCLES,
  cycleKey: CYCLES.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
  projectIds: [P1, P2],
  missingProjectIds: [],
  weeks: ["2026-08-31", "2026-09-07"],
  anchorCount: 2,
};
const scope = (over: Record<string, unknown> = {}) => ({
  set: SET,
  cycles: CYCLES,
  projectIds: [P1, P2],
  filters: {},
  ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/"],
  unitFlags: true,
  ...over,
}) as Parameters<typeof summaryWebsiteTrend>[0];

const own = (o: Partial<TrendOwnRow>): TrendOwnRow => ({
  axis: "total", bucket: null, cycleAnchorAt: null, keyRows: 1, monitored: 0, trackedAnswers: 0,
  multiAnswers: 0, top1Answers: 0, top3Answers: 0, rankSum: 0, rankedAnswers: 0, ownMentions: 0,
  ownPositive: 0, ownSignals: 0, compMentions: 0, allCitations: 0, ownCitations: 0,
  ownFallbackCitations: 0, tileOwnMentions: 0, citingAnswers: 0, ...o,
});
const agg = (o: Partial<TrendAggregates>): TrendAggregates => ({
  own: [], answers: [], brands: [], domains: [], empty: false, ...o,
});
const compiled = (i = 0) => dialect.sqlToQuery(execute.mock.calls[i][0]).sql.toLowerCase();

beforeEach(() => {
  readTrendAggregates.mockReset();
  execute.mockReset();
});

describe("summaryWebsiteTrend — 회차 축 → 화면 버킷", () => {
  it("`own` 1문장만 · 회차 축 켜짐 (문장 수는 회차 수와 무관하다)", async () => {
    readTrendAggregates.mockResolvedValue(agg({ own: [own({ axis: "total", monitored: 1 })] }));
    await summaryWebsiteTrend(scope());
    const [readScope, opts] = readTrendAggregates.mock.calls[0] as [
      { axes?: { cycle?: boolean }; set: CycleSet },
      { only?: readonly string[] },
    ];
    expect(opts.only).toEqual(["own"]);
    expect(readScope.axes?.cycle).toBe(true);
    expect(readScope.set.cycles).toHaveLength(4);
    // 세부층은 건드리지 않는다 — 이 경로의 DB 문장은 리더가 내는 1개뿐이다.
    expect(execute).not.toHaveBeenCalled();
  });

  it("회차 2개 → 점 2개, 오름차순 · 같은 UTC 일의 anchor 는 한 점으로 합쳐진다", () => {
    const buckets = websiteTrendBucketsFrom(
      agg({
        own: [
          // 합계·엔진·국가 축은 추이가 아니다 — 섞이면 안 된다.
          own({ axis: "total", monitored: 999 }),
          own({ axis: "engine", bucket: "chatgpt", monitored: 999 }),
          own({ axis: "country", bucket: "KR", monitored: 999 }),
          own({
            axis: "cycle", cycleAnchorAt: "2026-09-11T00:00:00.000Z",
            monitored: 40, trackedAnswers: 30, compMentions: 200, tileOwnMentions: 150,
            ownSignals: 100, ownPositive: 25, rankSum: 6, rankedAnswers: 4,
            allCitations: 80, ownCitations: 20,
          }),
          // 같은 9/4 인데 anchor 가 2시간 갈린 두 프로젝트 — UTC 일로 접힌다.
          own({
            axis: "cycle", cycleAnchorAt: "2026-09-04T02:00:00.000Z",
            monitored: 4, trackedAnswers: 3, compMentions: 20, tileOwnMentions: 15,
            ownSignals: 10, ownPositive: 2, rankSum: 2, rankedAnswers: 1,
            allCitations: 8, ownCitations: 2,
          }),
          own({
            axis: "cycle", cycleAnchorAt: "2026-09-04T00:00:00.000Z",
            monitored: 6, trackedAnswers: 5, compMentions: 30, tileOwnMentions: 25,
            ownSignals: 20, ownPositive: 8, rankSum: 4, rankedAnswers: 3,
            allCitations: 12, ownCitations: 6,
          }),
          // 회차 축이지만 집계층 행이 0 = 그 회차를 안 읽었다는 뜻 → 점 없음.
          own({ axis: "cycle", cycleAnchorAt: "2026-08-28T00:00:00.000Z", keyRows: 0 }),
        ],
      }),
      SET,
    );
    expect(buckets.map((b) => b.bucketStart)).toEqual(["2026-09-04", "2026-09-11"]);
    expect(buckets[0]).toEqual({
      bucketStart: "2026-09-04",
      // 그 날의 **가장 이른** anchor — 라벨·정렬 기준.
      cycleAnchorAt: "2026-09-04T00:00:00.000Z",
      answers: 10,
      trackedAnswers: 8,
      totalMentions: 50,
      trackedMentions: 40,
      sentMentions: 30,
      positiveMentions: 10,
      avgPosition: 1.5, // (2+4)/(1+3)
      totalCitations: 20,
      ownedCitations: 8,
      measuredDays: 1,
      // 그 주 함대의 min/max anchor — 자정을 걸치면 날짜까지 갈릴 수 있다.
      firstAt: "2026-09-04T00:00:00.000Z",
      lastAt: "2026-09-04T02:00:00.000Z",
    });
  });

  it("④ 분모 0 이면 avgPosition = null (0 이 아니다)", () => {
    const [b] = websiteTrendBucketsFrom(
      agg({ own: [own({ axis: "cycle", cycleAnchorAt: "2026-09-04T00:00:00.000Z", monitored: 5 })] }),
      SET,
    );
    expect(b.avgPosition).toBeNull();
  });

  it("회차 축 행이 없으면 빈 배열 — 화면은 '누적 중'", () => {
    expect(websiteTrendBucketsFrom(agg({ own: [own({ axis: "total", monitored: 9 })] }), SET)).toEqual([]);
  });

  // 검증자 D-1 재현 케이스 — 함대 앵커가 UTC 자정을 걸친 **단일 회차**.
  // anchor 로 접으면 점 2개(각각 함대 부분집합, vis 90%/50%)가 되고 회차 수 하한까지
  // 통과한다. `cycle_week` 로 접으면 점 1개·함대 합이다.
  it("함대 앵커가 자정을 걸쳐도 **한 회차 = 한 점**, 값은 함대 합", () => {
    const straddle: CycleSet = {
      ...SET,
      cycles: [
        cyc(5, P1, "2026-09-10T23:30:00.000Z", "2026-09-07"),
        cyc(6, P2, "2026-09-11T00:30:00.000Z", "2026-09-07"),
      ],
      projectIds: [P1, P2],
      weeks: ["2026-09-07"],
      anchorCount: 2, // ← anchor 로 세면 2. 하한이 이 값을 보면 안 되는 이유.
    };
    const buckets = websiteTrendBucketsFrom(
      agg({
        own: [
          own({ axis: "cycle", cycleAnchorAt: "2026-09-10T23:30:00.000Z", monitored: 10, trackedAnswers: 9 }),
          own({ axis: "cycle", cycleAnchorAt: "2026-09-11T00:30:00.000Z", monitored: 10, trackedAnswers: 5 }),
        ],
      }),
      straddle,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].bucketStart).toBe("2026-09-10"); // 대표일 = min anchor 의 UTC 일
    expect(buckets[0].answers).toBe(20);
    expect(buckets[0].trackedAnswers).toBe(14); // 90%/50% 로 갈리지 않고 70% 한 점
    expect(buckets[0].firstAt).toBe("2026-09-10T23:30:00.000Z");
    expect(buckets[0].lastAt).toBe("2026-09-11T00:30:00.000Z");
  });

  it("postgres-js 가 timestamptz 를 Date 로 줘도 같은 ISO 로 수렴한다", () => {
    const [b] = websiteTrendBucketsFrom(
      agg({
        own: [
          own({
            axis: "cycle",
            cycleAnchorAt: new Date("2026-09-04T00:00:00.000Z") as unknown as string,
            monitored: 5,
          }),
        ],
      }),
      SET,
    );
    expect(b.bucketStart).toBe("2026-09-04");
    expect(b.cycleAnchorAt).toBe("2026-09-04T00:00:00.000Z");
  });
});

describe("summaryWebsiteCitationAccuracyTrend — ⑥(세부층 1문장, 회차 축)", () => {
  it("유닛 경로: `summary_answers` 만 · job 조인 없음 · cycle_id 그룹핑", async () => {
    execute.mockResolvedValue([]);
    await summaryWebsiteCitationAccuracyTrend(scope());
    expect(execute).toHaveBeenCalledTimes(1);
    const q = compiled();
    expect(q).toContain("from summary_answers");
    expect(q).toContain("group by cycle_id");
    // 카드(⑥)와 같은 판정 — 굳힌 유닛 플래그.
    expect(q).toContain("unit_owned");
    expect(q).toContain("unit_target");
    // 세부층 job 세미조인이 있으면 이 경로의 의미가 사라진다.
    expect(q).not.toContain("job_id in (");
    expect(q).not.toContain("summary_target_hits");
    // 회차 술어는 쌍 + 주 파티션 프루닝.
    expect(q).toContain("cycle_week = any(");
    expect(q).toContain("(cycle_id, generation_id) in (");
  });

  it("cycle_id → anchor UTC 일 버킷 · 같은 날 회차는 합산 · 분모 0 은 rate null", async () => {
    execute.mockResolvedValue([
      { cycle_id: CYCLES[2].cycleId, owned_answers: 10, target_answers: 9 },
      { cycle_id: CYCLES[3].cycleId, owned_answers: 10, target_answers: 6 },
      { cycle_id: CYCLES[0].cycleId, owned_answers: 0, target_answers: 0 },
      { cycle_id: CYCLES[1].cycleId, owned_answers: 0, target_answers: 0 },
      // 집합 밖 회차는 버린다(술어가 이미 걸렀어야 하는 행).
      { cycle_id: "cccccccc-0000-0000-0000-000000000009", owned_answers: 5, target_answers: 5 },
    ]);
    const out = await summaryWebsiteCitationAccuracyTrend(scope());
    expect(out).toEqual([
      {
        bucketStart: "2026-09-04", ownedAnswers: 0, targetAnswers: 0, rate: null,
        measuredDays: 1, firstAt: "2026-09-04T00:00:00.000Z", lastAt: "2026-09-04T02:00:00.000Z",
      },
      {
        bucketStart: "2026-09-11", ownedAnswers: 20, targetAnswers: 15, rate: 75,
        measuredDays: 1, firstAt: "2026-09-11T00:00:00.000Z", lastAt: "2026-09-11T00:00:00.000Z",
      },
    ]);
  });

  it("① 추이와 **같은 bucketStart** 를 낸다 — 화면 병합 키", async () => {
    readTrendAggregates.mockResolvedValue(
      agg({
        own: [
          own({ axis: "cycle", cycleAnchorAt: "2026-09-04T02:00:00.000Z", monitored: 4 }),
          own({ axis: "cycle", cycleAnchorAt: "2026-09-11T00:00:00.000Z", monitored: 5 }),
        ],
      }),
    );
    execute.mockResolvedValue([
      { cycle_id: CYCLES[0].cycleId, owned_answers: 4, target_answers: 2 },
      { cycle_id: CYCLES[2].cycleId, owned_answers: 5, target_answers: 5 },
    ]);
    const [trend, acc] = await Promise.all([
      summaryWebsiteTrend(scope()),
      summaryWebsiteCitationAccuracyTrend(scope()),
    ]);
    expect(acc.map((b) => b.bucketStart)).toEqual(trend.map((b) => b.bucketStart));
  });

  it("유닛 플래그가 없으면 카드와 같은 `summary_target_hits` 경로로 간다", async () => {
    execute.mockResolvedValue([]);
    await summaryWebsiteCitationAccuracyTrend(scope({ unitFlags: false }));
    // ① 타겟 키 조회 + ② 본 문장.
    const qs = execute.mock.calls.map((c) => dialect.sqlToQuery(c[0]).sql.toLowerCase());
    const main = qs[qs.length - 1];
    expect(main).toContain("from summary_target_hits");
    expect(main).toContain("group by cycle_id, job_id");
  });

  it("회차 집합이 비면 문장을 아예 안 낸다", async () => {
    const out = await summaryWebsiteCitationAccuracyTrend(
      scope({ set: { ...SET, cycles: [] }, cycles: [] }),
    );
    expect(out).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
