import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// 글로벌 **스냅샷 픽**이 같은 주 대표를 고른다 — 2026-09-18(제품 책임자 승인, 검증자 R1).
//
// 종전 `ORDER BY cycle_anchor_at DESC LIMIT 1` 은 중복 주에서 **패자**(결손·부분 재측정)를
// 골랐고, 그래서 카드·asOf 와 추이 끝점이 같은 주에서 갈렸다. 여기서 고정하는 것은 넷:
//   ① 최신 주가 중복 주면 **대표**를 고른다(앵커가 더 과거여도).
//   ② 단일 회차 주는 종전과 **완전히 같다**.
//   ③ 그 주에 대표가 없으면(숨김·미발행) **패자를 고른다** — 더 과거 주로 후퇴하지 않는다.
//   ④ 행 매핑: `fleet_visible` 이 `null`·부재면 **대표**로 접는다(`false` 만 패자).
//
// DB 는 안 본다 — `getDb().execute` 를 가로채 행을 주입하고 SQL 텍스트를 본다.

const dialect = new PgDialect();
const captured: string[] = [];
let rows: unknown[] = [];
const execute = vi.fn(async (q: SQL) => {
  captured.push(dialect.sqlToQuery(q).sql);
  return rows as unknown as never;
});
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

/** 프로덕션 실측(2026-09-18) 8/17 주 — 대표 08-18(9,068유닛) / 패자 08-19(906유닛). */
const REP = {
  cycle_id: "c-rep",
  generation_id: "g-rep",
  project_id: ROOT,
  cycle_anchor_at: "2026-08-18T12:46:00.000Z",
  cycle_week: "2026-08-17",
  fleet_visible: true,
};
const LOSER = {
  cycle_id: "c-loser",
  generation_id: "g-loser",
  project_id: ROOT,
  cycle_anchor_at: "2026-08-19T00:06:00.000Z",
  cycle_week: "2026-08-17",
  fleet_visible: false,
};

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
  rows = [];
});

describe("pickGlobalCycle — 최신 주의 대표", () => {
  it("① 중복 주에서는 대표를 고른다 — 앵커가 더 과거여도", async () => {
    const m = await import("./summary-cycles");
    // 본 조회는 앵커 내림차순이라 패자가 먼저 온다(= 종전 `[0]` 이 고르던 행).
    rows = [LOSER, REP];
    const pick = await m.pickGlobalCycle(ROOT);
    expect(pick?.cycleId).toBe("c-rep");
    expect(pick?.cycleAnchorAt).toBe("2026-08-18T12:46:00.000Z");
    expect(pick?.fleetVisible).toBe(true);
  });

  it("② 단일 회차 주는 종전과 같다", async () => {
    const m = await import("./summary-cycles");
    rows = [REP];
    const pick = await m.pickGlobalCycle(ROOT);
    expect(pick).toEqual({
      cycleId: "c-rep",
      generationId: "g-rep",
      projectId: ROOT,
      cycleAnchorAt: "2026-08-18T12:46:00.000Z",
      cycleWeek: "2026-08-17",
      fleetVisible: true,
    });
  });

  it("② 단일 회차가 패자여도 그대로 고른다 — 한 주에 하나뿐이면 그것이 그 주다", async () => {
    const m = await import("./summary-cycles");
    rows = [LOSER];
    expect((await m.pickGlobalCycle(ROOT))?.cycleId).toBe("c-loser");
  });

  it("③ 대표가 후보에 없으면(숨김·미발행) 패자를 고른다 — 과거 주로 후퇴하지 않는다", async () => {
    const m = await import("./summary-cycles");
    // 대표가 `hidden_reason` 또는 미발행이라 WHERE 에서 빠진 상태 = 패자만 실려 온다.
    rows = [LOSER, { ...LOSER, cycle_id: "c-loser2", cycle_anchor_at: "2026-08-19T00:00:00.000Z" }];
    const pick = await m.pickGlobalCycle(ROOT);
    // 둘 다 패자 → 하나도 안 뺀다 → 앵커 최신(= 종전 동작).
    expect(pick?.cycleId).toBe("c-loser");
    expect(pick?.fleetVisible).toBe(false);
  });

  it("③ 패자를 서빙하면 **관측 마커**를 남긴다 — 값이 결손 회차라는 사실이 로그에 있어야 한다", async () => {
    const m = await import("./summary-cycles");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      rows = [LOSER];
      await m.pickGlobalCycle(ROOT);
      expect(info).toHaveBeenCalledTimes(1);
      const line = String(info.mock.calls[0]?.[0] ?? "");
      // 게이트 로그와 **같은 어휘**여야 한 grep 에 잡힌다.
      expect(line).toContain("x-hmg-summary(global snapshot): fleet-loser-served");
      expect(line).toContain("week:2026-08-17");
      expect(line).toContain("anchor:2026-08-19T00:06:00.000Z");

      // 대표를 서빙할 때는 **조용하다**(상시 로그는 신호를 죽인다).
      info.mockClear();
      rows = [LOSER, REP];
      await m.pickGlobalCycle(ROOT);
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it("행이 없으면 null (전체 폴백) · uuid 가 아니면 DB 를 안 본다", async () => {
    const m = await import("./summary-cycles");
    rows = [];
    expect(await m.pickGlobalCycle(ROOT)).toBeNull();
    execute.mockClear();
    expect(await m.pickGlobalCycle("mock-root-project")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("④ `fleet_visible` 이 null·부재면 대표로 접는다", async () => {
    const m = await import("./summary-cycles");
    for (const v of [null, undefined]) {
      rows = [{ ...REP, fleet_visible: v }, LOSER];
      const pick = await m.pickGlobalCycle(ROOT);
      // 모르는 값이 패자로 접히면 그 주가 통째로 뒤집힌다(패자가 유일한 대표가 된다).
      expect(pick?.cycleId, String(v)).toBe("c-rep");
      expect(pick?.fleetVisible, String(v)).toBe(true);
    }
  });

  it("왕복은 **문장 하나**다 — 2단이지만 CTE 라 쿼리가 늘지 않는다", async () => {
    const m = await import("./summary-cycles");
    rows = [REP];
    execute.mockClear();
    await m.pickGlobalCycle(ROOT);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// ── 검증자 지적 (a): 행 매핑 단언 ───────────────────────────────────────────
describe("pickCyclesInRange — fleet_visible 행 매핑", () => {
  const rangeRow = (over: Record<string, unknown> = {}) => ({
    cycle_id: "c1",
    generation_id: "g1",
    project_id: ROOT,
    cycle_anchor_at: "2026-08-18T12:46:00.000Z",
    cycle_week: "2026-08-17",
    status: "published",
    renderable: true,
    pending: false,
    analysis_gap_ratio: "0",
    expected_units: 10,
    completed_units: 10,
    hidden: false,
    hidden_scope: "all",
    fleet_visible: true,
    ...over,
  });

  it("`false` 만 패자다 — `true`·`null`·부재는 전부 대표", async () => {
    const m = await import("./summary-cycles");
    const cases: Array<[unknown, boolean]> = [
      [true, true],
      [null, true],
      [undefined, true],
      [false, false],
    ];
    for (const [raw, want] of cases) {
      rows = [rangeRow({ fleet_visible: raw })];
      const out = await m.pickCyclesInRange({ surface: "global", projectIds: [ROOT] });
      expect(out?.[0]?.fleetVisible, String(raw)).toBe(want);
    }
  });
});
