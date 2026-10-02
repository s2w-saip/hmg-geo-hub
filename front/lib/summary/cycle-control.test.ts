import { describe, it, expect, vi, beforeEach } from "vitest";

// 회차 관제 오케스트레이션 — DB 없이 계약만 본다.
//   · 프로브 false 면 **아무것도 하지 않는다**(0059 미적용 배포 내성, §7-6)
//   · dryRun 은 **쓰기 경로를 아예 부르지 않는다**(파티션 생성 포함)
//   · 적용 실패는 던지지 않는다 — 크론이 미러 동기화까지 끌고 죽으면 안 된다

const probe = vi.fn<[], Promise<boolean>>();
const readPlan = vi.fn();
const apply = vi.fn();
const ensurePartitions = vi.fn();

vi.mock("@/lib/db/repositories/summary-settings", () => ({
  summaryLedgerAvailable: () => probe(),
}));
vi.mock("@/lib/db/repositories/summary-cycles", () => ({
  DEFAULT_COMPLETE_QUIET_HOURS: 36,
  APPLY_STATEMENT_COUNT: 5,
  APPLY_STATEMENT_TIMEOUT_MS: 15_000,
  readCycleControlPlan: (...a: unknown[]) => readPlan(...a),
  applyCycleControl: (...a: unknown[]) => apply(...a),
  ensureSummaryWeekPartitions: (...a: unknown[]) => ensurePartitions(...a),
}));
vi.mock("@/lib/db/repositories/scope-mirror", () => ({ RUN_RECHECK_WINDOW_DAYS: 3 }));

const { runCycleControl, PARTITION_LOOKAHEAD_DAYS, CYCLE_COMPLETE_QUIET_HOURS } =
  await import("./cycle-control");

const EMPTY_PLAN = {
  open: [],
  attribution: { scope: 0, derived: 0, late: 0, unattributed: 0, projects: 0 },
  close: [],
  counters: [],
  judgeMs: 1,
};

beforeEach(() => {
  probe.mockReset().mockResolvedValue(true);
  readPlan.mockReset().mockResolvedValue(EMPTY_PLAN);
  apply.mockReset().mockResolvedValue({
    opened: 0, attributed: 0, late: 0, staleMarked: 0,
    countersUpdated: 0, closed: 0, fleetChanged: 0,
  });
  ensurePartitions.mockReset().mockResolvedValue({ created: 0 });
});

describe("프로브 (§7-6 내성)", () => {
  it("원장 표가 없으면 통째로 no-op 이고 skipped 를 남긴다", async () => {
    probe.mockResolvedValue(false);
    const r = await runCycleControl();
    expect(r.skipped).toBe("ledger-unavailable");
    expect(readPlan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(ensurePartitions).not.toHaveBeenCalled();
  });

  it("프로브 자체가 던져도 no-op 으로 수렴한다", async () => {
    probe.mockRejectedValue(new Error("relation does not exist"));
    const r = await runCycleControl();
    expect(r.skipped).toBe("ledger-unavailable");
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("dryRun — 쓰기 0", () => {
  it("판정만 부르고 적용·파티션 생성은 부르지 않는다", async () => {
    const r = await runCycleControl({ dryRun: true });
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(ensurePartitions).not.toHaveBeenCalled();
    expect(r.dryRun).toBe(true);
    expect(r.table).not.toBeNull();
  });

  it("표의 수를 요약으로 옮긴다 — blockedBy 는 '종결됨'으로 세지 않는다", async () => {
    readPlan.mockResolvedValue({
      ...EMPTY_PLAN,
      open: [{ projectId: "p1", surface: "global", anchorAt: "x", cycleWeek: "w", runs: 3 }],
      attribution: { scope: 10, derived: 2, late: 1, unattributed: 99, projects: 4 },
      close: [
        { cycleId: null, projectId: "p1", surface: "global", anchorAt: "x", status: "open", closedBy: "complete" },
        { cycleId: "c2", projectId: "p2", surface: "global", anchorAt: "y", status: "published", closedBy: "next_anchor", blockedBy: "status=published" },
      ],
    });
    const r = await runCycleControl({ dryRun: true });
    expect(r.opened).toBe(1);
    expect(r.closed).toBe(1); // blocked 1건 제외
    expect(r.attributed).toBe(13); // scope + derived + late
    expect(r.late).toBe(1);
    expect(r.unattributed).toBe(99);
  });
});

describe("적용 경로", () => {
  it("파티션을 4주 앞까지 밀고 적용한다", async () => {
    const now = new Date("2026-09-10T00:00:00.000Z");
    await runCycleControl({ now });
    expect(ensurePartitions).toHaveBeenCalledTimes(1);
    const [from, to] = ensurePartitions.mock.calls[0] as [Date, Date];
    expect(from.toISOString()).toBe(now.toISOString());
    expect(to.getTime() - from.getTime()).toBe(PARTITION_LOOKAHEAD_DAYS * 86_400_000);
    expect(apply).toHaveBeenCalledTimes(1);
    // 적용 경로는 같은 판정을 두 번 돌리지 않는다.
    expect(readPlan).not.toHaveBeenCalled();
  });

  it("0064 미적용(함수 없음)이어도 적용은 계속된다", async () => {
    ensurePartitions.mockResolvedValue({ created: null });
    const r = await runCycleControl();
    expect(r.partitionsCreated).toBeNull();
    expect(r.partitionsError).toBeNull();
    expect(r.errors).toEqual([]);
    expect(apply).toHaveBeenCalled();
  });

  it("파티션 타임아웃은 partitionsError 로 표면화되고 적용은 계속된다 (D2)", async () => {
    // 리포지터리는 던지지 않고 error 를 돌려준다 — 관제 본체는 파티션과 무관하다.
    ensurePartitions.mockResolvedValue({ created: null, error: "canceling statement due to statement timeout" });
    const r = await runCycleControl();
    expect(r.partitionsError).toContain("statement timeout");
    expect(r.errors[0]).toContain("partitions:");
    expect(apply).toHaveBeenCalled();
  });

  it("파티션 생성이 던져도 errors 로만 남고 적용을 막지 않는다", async () => {
    ensurePartitions.mockRejectedValue(new Error("lock timeout"));
    const r = await runCycleControl();
    expect(r.errors[0]).toContain("partitions:");
    expect(r.partitionsError).toContain("lock timeout");
    expect(apply).toHaveBeenCalled();
  });

  it("적용 실패를 던지지 않는다 — 크론 응답은 살아야 한다", async () => {
    apply.mockRejectedValue(new Error("statement timeout"));
    const r = await runCycleControl();
    expect(r.errors[0]).toContain("statement timeout");
    expect(r.opened).toBe(0);
    expect(r.skipped).toBeNull();
  });

  it("재확인 창은 미러 상수(RUN_RECHECK_WINDOW_DAYS)를 그대로 쓴다", async () => {
    await runCycleControl();
    expect(apply.mock.calls[0][0]).toMatchObject({ recheckWindowDays: 3 });
  });

  it("정온 창을 리포지터리에 그대로 넘긴다 — 상수는 한 벌이다", async () => {
    // CYCLE_COMPLETE_QUIET_HOURS 는 DEFAULT_COMPLETE_QUIET_HOURS 의 재수출이다.
    // 두 벌로 갈라지면 한쪽만 고치는 결함이 생긴다.
    expect(CYCLE_COMPLETE_QUIET_HOURS).toBe(36);
    await runCycleControl();
    expect(apply.mock.calls[0][0]).toMatchObject({ completeQuietHours: 36 });
    apply.mockClear();
    await runCycleControl({ completeQuietHours: 24 });
    expect(apply.mock.calls[0][0]).toMatchObject({ completeQuietHours: 24 });
  });

  it("파티션 문장 상한은 남은 예산의 절반이다 (T16 D2/6-①)", async () => {
    await runCycleControl({ budgetMs: 40_000 });
    const [, , o] = ensurePartitions.mock.calls[0] as [Date, Date, { statementTimeoutMs: number }];
    // 남은 예산(≈40s)의 절반. 프로브 시간 때문에 정확히 20,000 은 아니다.
    expect(o.statementTimeoutMs).toBeGreaterThan(15_000);
    expect(o.statementTimeoutMs).toBeLessThanOrEqual(20_000);
  });

  it("적용 문장 상한 = 남은 예산 / 문장 수, DB 천장(15s) 이하", async () => {
    // 예산이 넉넉하면 천장에 걸린다.
    await runCycleControl({ budgetMs: 300_000 });
    expect(apply.mock.calls[0][0].statementTimeoutMs).toBe(15_000);
    // 빠듯하면 예산이 이긴다 — 5문장 × 상한 ≤ 남은 예산.
    apply.mockClear();
    await runCycleControl({ budgetMs: 30_000 });
    const t = apply.mock.calls[0][0].statementTimeoutMs;
    expect(t).toBeLessThan(15_000);
    expect(t * 5).toBeLessThanOrEqual(30_000);
  });

  it("예산이 바닥이면 적용을 건너뛴다 — 다음 틱이 이어받는다(멱등)", async () => {
    const r = await runCycleControl({ budgetMs: 3_000 });
    expect(r.skipped).toBe("budget");
    expect(apply).not.toHaveBeenCalled();
    // 파티션도 건너뛴다(예산 절반이 2s 미만).
    expect(r.partitionsError).toContain("budget");
    expect(ensurePartitions).not.toHaveBeenCalled();
  });

  /**
   * 해소는 `lib/scope/anchor-root.ts::anchorRootProjectId()` 한 곳이다(N-4).
   * 그 함수는 **uuid 모양이 아닌 값을 거부**한다 — 잘못된 값이 그대로 내려가면
   * `22P02 invalid input syntax for type uuid` 로 미러 싱크 트랜잭션이 통째로 죽는다.
   */
  it("rootProjectId 미지정이면 env 를 읽고, env 도 없으면 null 이다", async () => {
    const prev = process.env.SCOPE_ROOT_PROJECT_ID;
    const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
    process.env.SCOPE_ROOT_PROJECT_ID = ROOT;
    await runCycleControl();
    expect(apply.mock.calls[0][0]).toMatchObject({ rootProjectId: ROOT });
    delete process.env.SCOPE_ROOT_PROJECT_ID;
    apply.mockClear();
    await runCycleControl();
    expect(apply.mock.calls[0][0]).toMatchObject({ rootProjectId: null });
    if (prev !== undefined) process.env.SCOPE_ROOT_PROJECT_ID = prev;
  });

  /**
   * N-14 — env 가 **설정돼 있는데 형식이 틀린** 경우.
   *
   * 여기서 `rootProjectId` 를 조용히 `null` 로 떨구면 원장 `surfaceExpr` 의 global 팔이
   * 생략되어 **루트 프로젝트의 새 회차가 `surface='project'` 로 기록된다**(그 회차는
   * `pickGlobalCycle` 에서 빠져 글로벌 대시보드가 폴백한다). 수리 전에는 `'…'::uuid`
   * 바인드가 22P02 로 던져 트랜잭션이 롤백됐고 원장은 무변경이었다.
   * "아무 일도 안 일어남" 을 그대로 유지한다: 적용을 건너뛰고 `errors[]` 에 남긴다.
   */
  it("uuid 모양이 아닌 env 면 원장에 **아무것도 쓰지 않는다** (N-14)", async () => {
    const prev = process.env.SCOPE_ROOT_PROJECT_ID;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.SCOPE_ROOT_PROJECT_ID = "root-from-env";
    const r = await runCycleControl();
    expect(apply).not.toHaveBeenCalled();
    expect(r.errors.join(" ")).toContain("SCOPE_ROOT_PROJECT_ID");
    expect(r.opened).toBe(0);
    err.mockRestore();
    if (prev !== undefined) process.env.SCOPE_ROOT_PROJECT_ID = prev;
    else delete process.env.SCOPE_ROOT_PROJECT_ID;
  });

  it("호출부가 rootProjectId 를 명시하면 env 형식과 무관하게 진행한다", async () => {
    const prev = process.env.SCOPE_ROOT_PROJECT_ID;
    const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
    process.env.SCOPE_ROOT_PROJECT_ID = "root-from-env";
    await runCycleControl({ rootProjectId: ROOT });
    expect(apply.mock.calls[0][0]).toMatchObject({ rootProjectId: ROOT });
    if (prev !== undefined) process.env.SCOPE_ROOT_PROJECT_ID = prev;
    else delete process.env.SCOPE_ROOT_PROJECT_ID;
  });
});
