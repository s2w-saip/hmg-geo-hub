import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sync } = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("@/lib/scope/mirror/sync", () => ({
  syncStandardMirror: sync, MIRROR_JOB_MAX_PAGES: 50, MIRROR_RUN_MAX_PAGES: 50,
  mirrorJobCapacity: () => 10000,
}));
const argv = process.argv;

beforeEach(() => {
  vi.resetModules();
  sync.mockReset().mockResolvedValue({
    runs: 50, answers: 0, skipped: 0, resyncSkipped: 0,
    oversizedRuns: [], truncatedRuns: [], budgetStoppedProjects: ["root"],
    pageCapHits: [], recheckCapHits: [], projectIdsNotFound: [], runLimitHits: [], deferred: 0,
    perProject: [{ projectId: "root", error: "budget stop inside run loop" }],
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("actual local resync entrypoint", () => {
  it("exits 3 for project errors and budget stops, passing the configured run limit", async () => {
    vi.stubEnv("SCOPE_MODE", "live");
    for (const key of ["DATABASE_URL", "SCOPE_API_BASE", "SCOPE_API_KEY", "SCOPE_ROOT_PROJECT_ID"]) vi.stubEnv(key, "test-only-no-connection");
    process.argv = ["node", "local-resync-window.ts", "2026-09-13T15:00:00Z", "2026-09-13T16:00:00Z", "--max-runs=400"];
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await import("./local-resync-window");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ maxRuns: 400, force: true, resyncBefore: expect.any(Date) }));
    expect(exit).not.toHaveBeenCalledWith(0);
  });

  it("rejects bad input before importing or calling the sync implementation", async () => {
    process.argv = ["node", "local-resync-window.ts", "2026-09-13T16:00:00Z", "2026-09-13T15:00:00Z"];
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await import("./local-resync-window");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(sync).not.toHaveBeenCalled();
  });

  it("rejects mock or missing live configuration instead of reporting zero-row success", async () => {
    vi.stubEnv("SCOPE_MODE", "mock");
    process.argv = ["node", "local-resync-window.ts", "2026-09-13T15:00:00Z", "2026-09-13T16:00:00Z"];
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await import("./local-resync-window");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(sync).not.toHaveBeenCalled();
  });
});
