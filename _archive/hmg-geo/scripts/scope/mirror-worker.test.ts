import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  delay: vi.fn(), process: vi.fn(), discovery: vi.fn(), recheck: vi.fn(), enqueue: vi.fn(), listAll: vi.fn(), websites: vi.fn(), client: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: (...args: unknown[]) => h.delay(...args),
}));

vi.mock("@/lib/scope/mirror/bulk-worker", () => ({
  processBulkQueue: (...args: unknown[]) => h.process(...args),
  enqueueBulkRun: (...args: unknown[]) => h.enqueue(...args),
}));
vi.mock("@/lib/scope/mirror/bulk-discovery", () => ({
  discoverBulkRuns: (...args: unknown[]) => h.discovery(...args),
}));
vi.mock("@/lib/scope/mirror/bulk-recheck", () => ({
  processBulkRechecks: (...args: unknown[]) => h.recheck(...args),
}));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { listAll: (...args: unknown[]) => h.listAll(...args) },
}));
vi.mock("@/lib/db/repositories/website-sites", () => ({
  getWebsiteScopeProjectIds: (...args: unknown[]) => h.websites(...args),
}));
vi.mock("@/lib/scope", () => ({
  getScopeClient: () => h.client(),
}));
vi.mock("@/lib/db/repositories/scope-mirror-bulk-cycles", () => ({
  createBulkCycleVisibility: vi.fn((invalidate: unknown) => ({
    prepare: vi.fn(), assertHeld: vi.fn(), publish: vi.fn(), invalidate,
  })),
}));

const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  h.process.mockReset();
  h.delay.mockReset().mockResolvedValue(undefined);
  h.discovery.mockReset();
  h.recheck.mockReset();
  h.enqueue.mockReset();
  h.listAll.mockReset().mockResolvedValue([]);
  h.websites.mockReset().mockResolvedValue([]);
  h.client.mockReset().mockReturnValue({});
  vi.stubEnv("SCOPE_MODE", "live");
  for (const key of ["DATABASE_URL", "SCOPE_API_BASE", "SCOPE_API_KEY", "SCOPE_ROOT_PROJECT_ID", "HMG_INTERNAL_BASE_URL", "CRON_SECRET"]) {
    vi.stubEnv(key, `test-${key.toLowerCase()}`);
  }
  vi.stubEnv("DATABASE_URL", "postgresql://worker:fixture@localhost:5432/mirror_test");
  process.argv = ["node", "mirror-worker", "--once"];
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("mirror worker CLI", () => {
  it("returns exit code 3 once when blocked work remains", async () => {
    h.process.mockResolvedValue({
      steps: 0, completed: 0, failures: [], remaining: 0, blocked: 1,
      oldestReadyAgeMs: null,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
    expect(h.process).toHaveBeenCalledWith(expect.objectContaining({ budgetMs: 60_000 }));
    expect(h.discovery).not.toHaveBeenCalled();
  });

  it("runs lightweight run discovery only when explicitly enabled", async () => {
    process.argv = ["node", "mirror-worker", "--once", "--discover"];
    h.discovery.mockResolvedValue({ projects: 3, pages: 3, runsSeen: 2, registrationAttempts: 1, failures: [], budgetStopped: false });
    h.process.mockResolvedValue({ steps: 1, completed: 1, failures: [], remaining: 0, blocked: 0, oldestReadyAgeMs: null });
    h.listAll.mockResolvedValue([{ id: "local-1", scopeProjectId: "linked-1" }]);
    h.websites.mockResolvedValue(["website-1"]);
    h.client.mockReturnValue({ listMeasurementRuns: vi.fn() });
    vi.stubEnv("SCOPE_ROOT_PROJECT_ID", "root-1");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(h.discovery).toHaveBeenCalledWith(expect.objectContaining({
      budgetMs: 10_000,
      maxConcurrency: 4,
      targets: [
        { projectId: "root-1", localProjectId: null },
        { projectId: "linked-1", localProjectId: "local-1" },
        { projectId: "website-1", localProjectId: null },
      ],
    }));
    expect(h.process).toHaveBeenCalledTimes(1);
    expect(h.recheck).not.toHaveBeenCalled();
  });

  it("runs retained rechecks only in the discover watch loop", async () => {
    process.argv = ["node", "mirror-worker", "--watch", "--discover"];
    h.discovery.mockResolvedValue({ projects: 1, pages: 1, runsSeen: 0, registrationAttempts: 0, failures: [], budgetStopped: false });
    h.recheck.mockResolvedValue({ pages: 1, changed: 0, failures: 0, budgetStopped: false });
    h.process.mockImplementation(async () => {
      process.emit("SIGTERM");
      return { steps: 0, completed: 0, failures: [], remaining: 0, blocked: 0, oldestReadyAgeMs: null };
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(h.recheck).toHaveBeenCalledWith(expect.objectContaining({ budgetMs: 10_000 }));
  });

  it("sets worker SQL timeouts while preserving connection settings and explicit queue budget", async () => {
    process.argv = ["node", "mirror-worker", "--once", "--budget-ms=180000"];
    vi.stubEnv("DATABASE_URL", "postgresql://worker:fixture@localhost:5432/mirror_test?application_name=mirror-test&statement_timeout=0");
    h.process.mockResolvedValue({ steps: 0, completed: 0, failures: [], remaining: 0, blocked: 0 });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    const url = new URL(process.env.DATABASE_URL!);
    expect(url.hostname).toBe("localhost");
    expect(url.pathname).toBe("/mirror_test");
    expect(url.searchParams.get("application_name")).toBe("mirror-test");
    expect(url.searchParams.get("statement_timeout")).toBe("30000");
    expect(url.searchParams.get("lock_timeout")).toBe("5000");
    expect(h.process).toHaveBeenCalledWith(expect.objectContaining({ budgetMs: 180_000 }));
  });

  it.each(["invalid", "postgres:foo", "postgresql://", "postgresql://localhost"])("rejects malformed DB configuration %s before queue work", async (databaseUrl) => {
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(h.process).not.toHaveBeenCalled();
  });

  it.each([
    { label: "productive pending work", steps: 1, remaining: 1, failures: [], waits: 0 },
    { label: "idle queue", steps: 1, remaining: 0, failures: [], waits: 1 },
    { label: "no progress", steps: 0, remaining: 1, failures: [], waits: 1 },
    { label: "failed pass", steps: 1, remaining: 1, failures: [{ runId: "r", code: "timeout" }], waits: 1 },
  ])("retains appropriate watch polling for $label", async ({ steps, remaining, failures, waits }) => {
    process.argv = ["node", "mirror-worker", "--watch"];
    h.process.mockResolvedValueOnce({ steps, remaining, failures, completed: 0, blocked: 0 });
    h.process.mockImplementationOnce(async () => {
      process.emit("SIGTERM");
      return { steps: 0, remaining: 0, failures: [], completed: 0, blocked: 0 };
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(h.process).toHaveBeenCalledTimes(2);
    expect(h.delay).toHaveBeenCalledTimes(waits);
    if (waits) expect(h.delay).toHaveBeenCalledWith(10_000);
  });

  it("preserves help and missing-live-config exits", async () => {
    process.argv = ["node", "mirror-worker", "--help"];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--discover"));
    expect(h.process).not.toHaveBeenCalled();

    vi.resetModules();
    process.argv = ["node", "mirror-worker", "--once"];
    vi.stubEnv("SCOPE_MODE", "mock");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Live configuration required"));
  });

  it("continues queue processing after discovery state failure and reports once incompleteness", async () => {
    process.argv = ["node", "mirror-worker", "--once", "--discover"];
    h.discovery.mockRejectedValue(new Error("checkpoint unreadable"));
    h.process.mockResolvedValue({ steps: 1, completed: 1, failures: [], remaining: 0, blocked: 0, oldestReadyAgeMs: null });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
    expect(h.process).toHaveBeenCalledTimes(1);
  });

  it("returns once code 3 when discovery budget leaves projects for a later pass", async () => {
    process.argv = ["node", "mirror-worker", "--once", "--discover"];
    h.discovery.mockResolvedValue({ projects: 1, pages: 1, runsSeen: 0, registrationAttempts: 0, failures: [], budgetStopped: true });
    h.process.mockResolvedValue({ steps: 0, completed: 0, failures: [], remaining: 0, blocked: 0, oldestReadyAgeMs: null });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
  });

  it("preserves unexpected queue failures as subprocess exit 1", async () => {
    process.argv = ["node", "mirror-worker", "--once"];
    h.process.mockRejectedValue(new Error("queue failed"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await import("./mirror-worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
