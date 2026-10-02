import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SummaryCyclePick,
  CycleRangeRow,
  WebsiteCyclePickResult,
  CycleRangeQuery,
} from "@/lib/db/repositories/summary-cycles";

// 글로벌 **추이** 회차 집합에서 같은 주 패자(`fleet_visible=false`)를 뺀다 — 2026-09-18
// 제품 확정. 여기서 고정하는 것은 넷이다:
//   ① 추이 집합에서 패자가 빠지고, 파생값(cycleKey·weeks·anchorCount·projectIds)이
//      **거른 뒤 집합** 기준으로 다시 선다.
//   ② 누적·스냅샷 경로의 회차 집합은 **종전과 동일**하다(`judgeCycleRange` 는 안 거른다).
//   ③ 패자만 있는 주는 통째로 남는다(관제 결함으로 주 하나가 사라지면 안 된다).
//   ④ `undefined`(값이 안 실린 경로)는 대표로 본다 — 점이 조용히 사라지는 방향 금지.
//
// DB 는 보지 않는다: 리포지터리 세 함수를 모킹하고 순수 판정만 본다.

const pickWebsiteCycles = vi.fn<[string[]], Promise<WebsiteCyclePickResult | null>>();
const pickGlobalCycle = vi.fn<[string], Promise<SummaryCyclePick | null>>();
const pickCyclesInRange = vi.fn<[CycleRangeQuery], Promise<CycleRangeRow[] | null>>();

vi.mock("@/lib/db/repositories/summary-cycles", () => ({
  pickWebsiteCycles: (ids: string[]) => pickWebsiteCycles(ids),
  pickGlobalCycle: (root: string) => pickGlobalCycle(root),
  pickCyclesInRange: (q: CycleRangeQuery) => pickCyclesInRange(q),
}));

const { judgeCycleRange, restrictToFleetVisible, resolveCycleSet } = await import("./cycle-set");
const { dropFleetLosers } = await import("@/lib/summary/fleet-visible");
type CycleSet = ReturnType<typeof setOf>;

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
const P2 = "22222222-2222-2222-2222-222222222222";

/** 프로덕션 실측(2026-09-18) 형태의 행 — 주·앵커·대표 여부만 바꿔 쓴다. */
const row = (over: Partial<CycleRangeRow> = {}): CycleRangeRow => ({
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: ROOT,
  cycleAnchorAt: "2026-08-04T06:46:00.000Z",
  cycleWeek: "2026-08-03",
  status: "published",
  renderable: true,
  pending: false,
  analysisGapRatio: 0,
  expectedUnits: 3505,
  completedUnits: 3505,
  hidden: false,
  hiddenScope: "all",
  fleetVisible: true,
  ...over,
});

/** 원장 실측 3주 — 주마다 (대표, 패자) 둘. 마지막 주의 패자가 "08-19 87.0%" 다. */
const LIVE_ROWS: CycleRangeRow[] = [
  row({ cycleId: "c1", generationId: "g1", cycleWeek: "2026-08-03",
    cycleAnchorAt: "2026-08-04T06:46:00.000Z", fleetVisible: true }),
  row({ cycleId: "c2", generationId: "g2", cycleWeek: "2026-08-03",
    cycleAnchorAt: "2026-08-09T13:36:00.000Z", fleetVisible: false }),
  row({ cycleId: "c3", generationId: "g3", cycleWeek: "2026-08-10",
    cycleAnchorAt: "2026-08-11T03:56:00.000Z", fleetVisible: true }),
  row({ cycleId: "c4", generationId: "g4", cycleWeek: "2026-08-10",
    cycleAnchorAt: "2026-08-12T06:56:00.000Z", fleetVisible: false }),
  row({ cycleId: "c5", generationId: "g5", cycleWeek: "2026-08-17",
    cycleAnchorAt: "2026-08-18T12:46:00.000Z", fleetVisible: true }),
  row({ cycleId: "c6", generationId: "g6", cycleWeek: "2026-08-17",
    cycleAnchorAt: "2026-08-19T00:06:00.000Z", fleetVisible: false }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

function setOf(rows: CycleRangeRow[], projectIds: string[] = [ROOT]) {
  const r = judgeCycleRange("global", projectIds, rows);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.set;
}

// ── ② 누적·스냅샷은 안 바뀐다 ──────────────────────────────────────────────
describe("judgeCycleRange — 패자 회차를 거르지 않는다(누적 경로 보존)", () => {
  it("한 주 두 회차가 **둘 다** 집합에 남는다 — 합산이 정당한 경로의 모수", () => {
    const set = setOf(LIVE_ROWS);
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(set.anchorCount).toBe(6);
    expect(set.weeks).toEqual(["2026-08-03", "2026-08-10", "2026-08-17"]);
  });

  it("`fleetVisible` 을 픽에 실어 보낸다(판정에는 안 쓴다)", () => {
    const set = setOf(LIVE_ROWS);
    expect(set.cycles.map((c) => c.fleetVisible))
      .toEqual([true, false, true, false, true, false]);
  });

  it("패자 회차도 구멍·빈 집합 판정의 모수다 — 패자만 있어도 폴백하지 않는다", () => {
    const set = setOf([row({ cycleId: "only", generationId: "g", fleetVisible: false })]);
    expect(set.cycles).toHaveLength(1);
  });
});

// ── ① 추이 집합 ───────────────────────────────────────────────────────────
describe("restrictToFleetVisible — 추이 점은 대표 회차만", () => {
  it("주마다 대표 하나만 남는다(프로덕션 실측 3주 × 2회차)", () => {
    const set = restrictToFleetVisible(setOf(LIVE_ROWS));
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["c1", "c3", "c5"]);
    // "2026-08-19 87.0%" 단독 점이 사라지는 것이 이 수정의 목적이다.
    expect(set.cycles.map((c) => c.cycleAnchorAt.slice(0, 10)))
      .toEqual(["2026-08-04", "2026-08-11", "2026-08-18"]);
  });

  it("파생값은 **거른 뒤 집합** 기준으로 다시 선다(캐시 키·회차 하한이 이걸 본다)", () => {
    const full = setOf(LIVE_ROWS);
    const set = restrictToFleetVisible(full);
    expect(set.anchorCount).toBe(3);
    expect(set.cycleKey).toBe(["c1:g1", "c3:g3", "c5:g5"].join(","));
    expect(set.cycleKey).not.toBe(full.cycleKey);
    expect(set.weeks).toEqual(["2026-08-03", "2026-08-10", "2026-08-17"]);
    expect(set.projectIds).toEqual([ROOT]);
    expect(set.surface).toBe("global");
    expect(set.mode).toBe("period");
  });

  it("관측값(`skippedCount`)은 보존된다 — 거르기와 다른 명제다", () => {
    const rows = [
      ...LIVE_ROWS,
      // 생성기가 영원히 안 뽑는 회차 = skipped 1.
      row({ cycleId: "c7", generationId: null, renderable: false, status: "closed",
        cycleWeek: "2026-08-24", cycleAnchorAt: "2026-08-25T00:00:00.000Z",
        analysisGapRatio: 0.31 }),
    ];
    const full = setOf(rows);
    expect(full.skippedCount).toBe(1);
    expect(restrictToFleetVisible(full).skippedCount).toBe(1);
  });

  it("뺄 것이 없으면 **입력 객체 그대로** — 캐시 키가 이유 없이 바뀌지 않는다", () => {
    const full = setOf([LIVE_ROWS[0], LIVE_ROWS[2], LIVE_ROWS[4]]);
    expect(restrictToFleetVisible(full)).toBe(full);
  });

  it("주가 다르면 둘 다 남는다 — 거르는 단위는 `(프로젝트, 주)` 다", () => {
    const full = setOf([
      row({ cycleId: "w1", generationId: "g1", cycleWeek: "2026-08-03",
        cycleAnchorAt: "2026-08-04T00:00:00.000Z", fleetVisible: true }),
      row({ cycleId: "w2", generationId: "g2", cycleWeek: "2026-08-10",
        cycleAnchorAt: "2026-08-11T00:00:00.000Z", fleetVisible: false }),
    ]);
    const set = restrictToFleetVisible(full);
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["w1", "w2"]);
    expect(set.anchorCount).toBe(2);
  });

  it("프로젝트가 다르면 서로의 대표를 지우지 않는다(같은 주여도)", () => {
    const full = setOf([
      row({ cycleId: "p1a", generationId: "g1", projectId: ROOT, fleetVisible: true }),
      row({ cycleId: "p2a", generationId: "g2", projectId: P2, fleetVisible: false,
        cycleAnchorAt: "2026-08-05T00:00:00.000Z" }),
    ], [ROOT, P2]);
    const set = restrictToFleetVisible(full);
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["p1a", "p2a"]);
    expect(set.projectIds).toEqual([ROOT, P2]);
  });

  // ── ③ 병리 방어 ────────────────────────────────────────────────────────
  it("패자만 있는 주는 **통째로 남긴다** — 주 하나가 사라지는 것이 더 큰 거짓말", () => {
    const full = setOf([
      row({ cycleId: "c1", generationId: "g1", cycleWeek: "2026-08-03",
        cycleAnchorAt: "2026-08-04T00:00:00.000Z", fleetVisible: true }),
      // 관제가 대표를 못 찍은 주 — 둘 다 false.
      row({ cycleId: "x1", generationId: "gx1", cycleWeek: "2026-08-10",
        cycleAnchorAt: "2026-08-11T00:00:00.000Z", fleetVisible: false }),
      row({ cycleId: "x2", generationId: "gx2", cycleWeek: "2026-08-10",
        cycleAnchorAt: "2026-08-12T00:00:00.000Z", fleetVisible: false }),
    ]);
    const set = restrictToFleetVisible(full);
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["c1", "x1", "x2"]);
    expect(set.weeks).toEqual(["2026-08-03", "2026-08-10"]);
    // 앵커 일이 다르므로 3 — 그 주는 리더(`toSeries`)의 일 단위 fold 가 두 점으로 낸다.
    expect(set.anchorCount).toBe(3);
  });

  it("전 회차가 패자면 하나도 안 뺀다(빈 집합을 만들지 않는다)", () => {
    const full = setOf([
      row({ cycleId: "x1", generationId: "gx1", fleetVisible: false }),
      row({ cycleId: "x2", generationId: "gx2", fleetVisible: false,
        cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-11T00:00:00.000Z" }),
    ]);
    expect(restrictToFleetVisible(full).cycles).toHaveLength(2);
  });

  // ── ④ 모르는 값 ────────────────────────────────────────────────────────
  it("`undefined` 는 대표로 본다 — 값이 안 실린 경로에서 점이 사라지면 안 된다", () => {
    const unknown = { ...row({ cycleId: "u1", generationId: "gu1" }) } as CycleRangeRow;
    delete (unknown as { fleetVisible?: boolean }).fleetVisible;
    const full = setOf([
      unknown,
      row({ cycleId: "u2", generationId: "gu2", cycleAnchorAt: "2026-08-09T00:00:00.000Z",
        fleetVisible: false }),
    ]);
    const set = restrictToFleetVisible(full);
    // 같은 주에 대표(=undefined)가 있으므로 명시적 패자만 빠진다.
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["u1"]);
  });

  it("전부 `undefined` 면 아무것도 안 뺀다(종전 동작 유지)", () => {
    const rows = [
      row({ cycleId: "u1", generationId: "gu1" }),
      row({ cycleId: "u2", generationId: "gu2", cycleAnchorAt: "2026-08-09T00:00:00.000Z" }),
    ].map((r) => {
      const copy = { ...r } as CycleRangeRow;
      delete (copy as { fleetVisible?: boolean }).fleetVisible;
      return copy;
    });
    const full = setOf(rows);
    expect(restrictToFleetVisible(full)).toBe(full);
  });

  it("빈 집합은 그대로 통과한다(호출이 폭발하지 않는다)", () => {
    const empty = { ...setOf([LIVE_ROWS[0]]), cycles: [] } as CycleSet;
    expect(restrictToFleetVisible(empty)).toBe(empty);
  });
});

// ── 규칙은 한 곳이다 — `dropFleetLosers` (2026-09-18 후속) ──────────────────
describe("dropFleetLosers — 공유 규칙", () => {
  type It = { g: string; v?: boolean; id: string };
  const run = (items: It[]) =>
    [...dropFleetLosers(items, (i) => i.g, (i) => i.v)].map((i) => i.id);

  it("그룹에 대표가 있으면 패자를 뺀다", () => {
    expect(run([{ g: "w1", v: true, id: "a" }, { g: "w1", v: false, id: "b" }])).toEqual(["a"]);
  });

  it("그룹이 다르면 서로의 패자를 지우지 않는다", () => {
    expect(run([{ g: "w1", v: true, id: "a" }, { g: "w2", v: false, id: "b" }]))
      .toEqual(["a", "b"]);
  });

  it("패자만 있는 그룹은 통째로 남는다", () => {
    expect(run([{ g: "w1", v: false, id: "a" }, { g: "w1", v: false, id: "b" }]))
      .toEqual(["a", "b"]);
  });

  it("`undefined` 는 대표다 — 모르는 값을 패자로 접지 않는다", () => {
    expect(run([{ g: "w1", id: "a" }, { g: "w1", v: false, id: "b" }])).toEqual(["a"]);
    expect(run([{ g: "w1", id: "a" }, { g: "w1", id: "b" }])).toEqual(["a", "b"]);
  });

  it("입력 순서를 보존하고, 뺄 것이 없으면 **같은 배열**을 돌려준다", () => {
    const items: It[] = [{ g: "w1", v: true, id: "a" }, { g: "w2", v: true, id: "b" }];
    expect(dropFleetLosers(items, (i) => i.g, (i) => i.v)).toBe(items);
    const mixed: It[] = [
      { g: "w1", v: false, id: "x" }, { g: "w1", v: true, id: "y" }, { g: "w2", v: true, id: "z" },
    ];
    expect(run(mixed)).toEqual(["y", "z"]);
  });

  it("빈 배열은 그대로", () => {
    const empty: It[] = [];
    expect(dropFleetLosers(empty, (i) => i.g, (i) => i.v)).toBe(empty);
  });
});

// ── 스냅샷 경로 — 픽이 대표를 낸 뒤의 집합 (2026-09-18 후속) ────────────────
//
// `pickGlobalCycle` 의 선택 자체는 `summary-cycles.fleet-visible.test.ts` 가 본다.
// 여기서 고정하는 것은 **그 뒤**다: 집합이 대표 하나로 서고, 기간 판정이 그 대표의
// 날짜로 내려진다(= 창이 패자만 덮으면 폴백한다 — 종전엔 hit 이었다).
describe("resolveCycleSet — 글로벌 스냅샷", () => {
  const REP_DAY = "2026-08-18";
  const repPick: SummaryCyclePick = {
    cycleId: "c-rep",
    generationId: "g-rep",
    projectId: ROOT,
    cycleAnchorAt: "2026-08-18T12:46:00.000Z",
    cycleWeek: "2026-08-17",
    fleetVisible: true,
  };

  it("집합은 대표 하나 — 회차 수도 1이다", async () => {
    pickGlobalCycle.mockResolvedValue(repPick);
    const r = await resolveCycleSet({ surface: "global", mode: "snapshot", projectIds: [ROOT] });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.set.cycles).toEqual([repPick]);
    expect(r.set.anchorCount).toBe(1);
    expect(r.set.weeks).toEqual(["2026-08-17"]);
    // 범위 조회는 안 부른다(스냅샷은 DB 왕복이 늘면 안 된다).
    expect(pickCyclesInRange).not.toHaveBeenCalled();
  });

  it("기간이 대표의 날을 덮으면 hit", async () => {
    pickGlobalCycle.mockResolvedValue(repPick);
    const r = await resolveCycleSet({
      surface: "global", mode: "snapshot", projectIds: [ROOT],
      dateFrom: "2026-08-17", dateTo: "2026-08-19",
    });
    expect(r.ok).toBe(true);
  });

  it("⚠️ 기간이 **패자의 날만** 덮으면 폴백한다 — 종전엔 패자로 hit 이었다", async () => {
    pickGlobalCycle.mockResolvedValue(repPick);
    const r = await resolveCycleSet({
      surface: "global", mode: "snapshot", projectIds: [ROOT],
      dateFrom: "2026-08-19", dateTo: "2026-08-19",
    });
    // 폴백은 미러다(값이 틀리는 것보다 낡은 것이 싸다). 보고 대상인 **의도된** 변화다.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("range-outside-cycle");
    expect(REP_DAY < "2026-08-19").toBe(true);
  });

  it("웹사이트 스냅샷은 무변경 — 픽이 술어로 이미 대표만 낸다", async () => {
    pickWebsiteCycles.mockResolvedValue({
      cycles: [{
        cycleId: "w1", generationId: "wg1", projectId: P2,
        cycleAnchorAt: "2026-08-18T00:00:00.000Z", cycleWeek: "2026-08-17",
      }],
      missingProjectIds: [],
    });
    const r = await resolveCycleSet({ surface: "website", mode: "snapshot", projectIds: [P2] });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    // `fleetVisible` 이 없는 픽도 그대로 통과한다(집합이 비지 않는다).
    expect(r.set.cycles).toHaveLength(1);
    expect(r.set.cycles[0].fleetVisible).toBeUndefined();
  });
});
