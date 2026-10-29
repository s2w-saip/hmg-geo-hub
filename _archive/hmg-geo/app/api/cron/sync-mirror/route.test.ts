import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// sync 크론의 회차 관제(PR① A1/T7) 배선 계약.
//   · 관제는 미러 동기화 **앞** 에 돈다 (2026-09-14 이슈 #262 — 뒷단이면 동기화가
//     300s 로 죽을 때 같이 죽는다. 실측 16틱 연속 관제 0회 실행)
//   · 관제가 죽어도 라우트는 200 이고 동기화 결과는 그대로 나간다
//   · 원장 표가 없는 배포(`skipped`)도 200 이다
//   · 동기화 예산은 **관제가 쓰고 남은 시간**에서 감시 몫을 뺀 값이다

const syncStandardMirror = vi.fn();
const runCycleControl = vi.fn();
const scanOrphanProjects = vi.fn();

vi.mock("@/lib/cron-auth", () => ({ requireCronSecret: () => null }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/scope/server", () => ({ MIRROR_AGGREGATE_TAG: "mirror" }));
vi.mock("@/lib/scope/mirror/sync", () => ({
  syncStandardMirror: (...a: unknown[]) => syncStandardMirror(...a),
  MIRROR_SYNC_BUDGET_MS: 250_000,
}));
vi.mock("@/lib/summary/cycle-control", () => ({
  runCycleControl: (...a: unknown[]) => runCycleControl(...a),
}));
vi.mock("@/lib/scope/orphan-health", () => ({
  scanOrphanProjects: () => scanOrphanProjects(),
  buildOrphanIssueBody: () => "",
  ORPHAN_ISSUE_TITLE: "orphan",
}));
vi.mock("@/lib/scope/truncation-health", () => ({
  hasTruncation: () => false,
  buildTruncationIssueBody: () => "",
  TRUNCATION_ISSUE_TITLE: "trunc",
  TRUNCATION_ALERT_COOLDOWN_HOURS: 12,
}));
vi.mock("@/lib/alerts/github-issue", () => ({
  reportIssue: vi.fn(),
  isIssueSinkConfigured: () => false,
}));

const { GET } = await import("./route");

const REQ = new Request("https://x/api/cron/sync-mirror");
const SYNC_RESULT = { runs: 0, pageCapHits: [], recheckCapHits: [] };
const OK_CONTROL = {
  dryRun: false, opened: 2, closed: 1, attributed: 40, late: 3,
  unattributed: 0, partitionsCreated: 6, skipped: null, errors: [], table: null, ms: 1234,
};

beforeEach(() => {
  syncStandardMirror.mockReset().mockResolvedValue(SYNC_RESULT);
  runCycleControl.mockReset().mockResolvedValue(OK_CONTROL);
  scanOrphanProjects.mockReset().mockResolvedValue({ mode: "mock", orphans: [], graceHeld: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("회차 관제 배선", () => {
  it("응답에 cycleControl 이 실린다", async () => {
    const body = await (await GET(REQ)).json();
    expect(body.ok).toBe(true);
    expect(body.cycleControl).toEqual({
      opened: 2, closed: 1, attributed: 40, late: 3,
      partitionsCreated: 6, skipped: null, errors: [], ms: 1234,
    });
  });

  // ⚠️ 2026-09-14 (#262) 로 계약이 **뒤집혔다.** 종전 계약은 "동기화 뒤"였다 —
  // 이번 패스가 당긴 run 까지 같은 틱에 회차로 굳히기 위해서다(설계 §2-7).
  // 그러나 동기화가 300s 로 죽으면 뒷단은 **한 번도 안 돈다**(16틱 실측). 귀속이
  // 한 틱 늦는 것(멱등·20분)이 몇 시간 정지보다 싸므로 앞으로 옮겼다.
  it("미러 동기화 **앞** 에 돈다 — 뒷단이면 동기화 타임아웃에 같이 죽는다", async () => {
    const order: string[] = [];
    syncStandardMirror.mockImplementation(async () => {
      order.push("sync");
      return SYNC_RESULT;
    });
    runCycleControl.mockImplementation(async () => {
      order.push("control");
      return OK_CONTROL;
    });
    await GET(REQ);
    expect(order).toEqual(["control", "sync"]);
  });

  it("동기화가 300s 로 죽어도(=throw) 관제는 이미 돌았다", async () => {
    syncStandardMirror.mockRejectedValue(new Error("Task timed out after 300 seconds"));
    await expect(GET(REQ)).rejects.toThrow();
    // 라우트 자체는 전파하지만, 관제는 그 전에 완료됐다 — 이것이 #262 의 핵심.
    expect(runCycleControl).toHaveBeenCalledTimes(1);
  });

  it("관제가 던져도 200 이고 동기화 결과는 그대로 나간다", async () => {
    runCycleControl.mockRejectedValue(new Error("boom"));
    syncStandardMirror.mockResolvedValue({ ...SYNC_RESULT, runs: 7 });
    const res = await GET(REQ);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.runs).toBe(7);
    expect(body.cycleControl.errors).toEqual(["boom"]);
    expect(body.cycleControl.opened).toBe(0);
  });

  it("원장 표가 없는 DB(프로브 false)에서도 200 이다", async () => {
    runCycleControl.mockResolvedValue({ ...OK_CONTROL, opened: 0, closed: 0, attributed: 0, late: 0, partitionsCreated: null, skipped: "ledger-unavailable" });
    const res = await GET(REQ);
    expect(res.status).toBe(200);
    expect((await res.json()).cycleControl.skipped).toBe("ledger-unavailable");
  });

  it("종전 두 감시의 응답 필드는 그대로다 (회귀 방지)", async () => {
    const body = await (await GET(REQ)).json();
    expect(body.orphanWatch).toBeDefined();
    expect(body.truncationWatch).toBeDefined();
  });

  it("bulk flag가 꺼져 있으면 discovery callback을 넘기지 않는다", async () => {
    vi.stubEnv("MIRROR_BULK_ENABLED", "0");

    await GET(REQ);

    expect(syncStandardMirror).toHaveBeenCalledWith(
      expect.not.objectContaining({ queueBulkRun: expect.any(Function) }),
    );
  });
});

describe("예산 배분 (2026-09-14 #262)", () => {
  it("관제에 고정 선행 예산(≤45s)을 넘긴다 — 남은 요청 시간을 넘지 않는다", async () => {
    await GET(REQ);
    const budget = (runCycleControl.mock.calls[0]?.[0] as { budgetMs: number }).budgetMs;
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(45_000);
  });

  it("동기화 예산은 관제가 쓰고 남은 시간에서 감시 몫(35s)을 뺀 값이다", async () => {
    // 관제가 40s 를 쓰면 동기화는 300 − 40 − 35 = 225s 를 넘길 수 없다.
    runCycleControl.mockImplementation(async () => {
      const t = Date.now();
      // 시계를 실제로 40s 흘릴 수는 없으므로 타이머를 가짜로 민다.
      vi.setSystemTime(t + 40_000);
      return OK_CONTROL;
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    try {
      const body = await (await GET(REQ)).json();
      expect(body.syncBudgetMs).toBeLessThanOrEqual(225_000);
      expect(body.syncBudgetMs).toBeGreaterThan(200_000);
      const passed = (syncStandardMirror.mock.calls[0]?.[0] as { budgetMs: number }).budgetMs;
      expect(passed).toBe(body.syncBudgetMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it("평시(관제 즉시 반환)에는 동기화가 250s 상한을 그대로 받는다", async () => {
    const body = await (await GET(REQ)).json();
    expect(body.syncBudgetMs).toBe(250_000);
  });

  // ★ 예산은 관제가 **스스로 볼 때만** 유효하다. 커넥션 획득 대기처럼 remaining()
  //   검사 사이에서 멈추면 예산은 아무것도 집행하지 않고, 관제를 앞으로 옮긴 만큼
  //   이번엔 sync 가 굶는다 — 그래서 하드 월클럭 race 를 건다(검증 지적 5).
  it("★ 관제가 행업해도 예산에서 끊고 sync 로 넘어간다 (lead-timeout)", async () => {
    runCycleControl.mockImplementation(
      () => new Promise(() => {}), // 영원히 안 끝난다
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const p = GET(REQ);
      await vi.advanceTimersByTimeAsync(46_000);
      const body = await (await p).json();
      expect(body.ok).toBe(true);
      expect(body.cycleControl.skipped).toBe("lead-timeout");
      expect(body.cycleControl.errors[0]).toContain("lead budget");
      // 관제가 안 끝나도 동기화는 돌았다 — 이것이 race 의 목적이다.
      expect(syncStandardMirror).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("예산이 음수가 될 상황에서도 0 아래로 내려가지 않는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    runCycleControl.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 400_000); // maxDuration 을 이미 넘긴 상태
      return OK_CONTROL;
    });
    try {
      const body = await (await GET(REQ)).json();
      expect(body.syncBudgetMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
