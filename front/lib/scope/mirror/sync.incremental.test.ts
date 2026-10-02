import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 미러 싱크 **증분 읽기** (2026-09-28, 루트 크론 정지) 회귀 테스트.
 *
 * 사고: 루트(prompts ~12,446 · runs ~8,681)가 매 틱 listPrompts 50 + listMeasurementRuns 50
 * 페이지를 처음부터 다시 읽다가 데드라인에 걸려 쓰기 단계에 못 갔다.
 *
 * 싱크 경로 테스트는 **상태를 이어 가는 세계**에서 돈다 — 미러(replaceRun → mirroredRunStates)와
 * 워터마크(record* → syncWatermarks)가 패스 사이에 이어지고, Scope run status 는 코어 규칙
 * (lib/measurements/run-counts.ts deriveMeasurementRunStatus)을 복제한다. 패스마다 정적 mock
 * 을 주입하면 "첫 패스가 쓴 floor 가 다음 패스에서 무엇을 가리는가"가 안 보인다(검증 V1~V3).
 *
 * 못박는 계약:
 *   ① 프롬프트 워터마크는 upsert **성공 뒤에만**, 창을 **끝까지** 읽었을 때만 전진한다.
 *   ② 다음 창은 `updated_from = 워터마크 − 10분`. 한 틱 상한을 넘는 창은 커서로 이어 읽는다(V4).
 *   ③ run 목록은 floor 앵커를 지나 정착 run 이 연속 N(200) 개 나오면 멈춘다.
 *   ④ 예산 중단·run 상한으로 **못 처리한 오래된 run** 이 floor 를 붙잡는다.
 *   V1 completed 가 아닌 terminal run 은 재확인 창 동안 floor 를 붙잡는다(ACR 숨은 실패 전이).
 *   V2 floor 아래 N 개 안에 늦게 나타난 run 은 잡힌다(그보다 깊으면 전체 대조가 회수·계수).
 *   V3 낡은 목록 스냅샷의 floor 는 더 새 floor 를 덮지 못한다.
 *   (d) floor run 이 지워져도 아래 앵커로 경계를 지난다.
 *   ⑤ 워터마크 표가 없으면(0082 미적용) 종전 전량 읽기·쓰기 없음.
 *   ⑥ force(mirror:local-resync)는 증분·조기 종료를 쓰지 않는다.
 *   ⑦ 페이지 상한은 안전망으로 남는다.
 */

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

const h = vi.hoisted(() => ({
  recordSyncAttempt: vi.fn(),
  markSyncAttemptStarted: vi.fn(),
  replaceRun: vi.fn(),
  upsertPrompts: vi.fn(),
  listRunJobs: vi.fn(),
  listMeasurementRuns: vi.fn(),
  listPrompts: vi.fn(),
  mirroredRunStates: vi.fn(),
  syncWatermarks: vi.fn(),
  recordPromptWatermark: vi.fn(),
  recordPromptResume: vi.fn(),
  clearPromptResume: vi.fn(),
  recordRunFloor: vi.fn(),
}));

vi.mock("@/lib/db/repositories/scope-mirror", () => ({
  scopeMirrorRepository: {
    recordSyncAttempt: h.recordSyncAttempt,
    markSyncAttemptStarted: h.markSyncAttemptStarted,
    replaceRun: h.replaceRun,
    upsertPrompts: h.upsertPrompts,
    mirroredRunStates: () => h.mirroredRunStates(),
    syncWatermarks: () => h.syncWatermarks(),
    recordPromptWatermark: h.recordPromptWatermark,
    recordPromptResume: h.recordPromptResume,
    clearPromptResume: h.clearPromptResume,
    recordRunFloor: h.recordRunFloor,
    lastAttemptByProject: async () => new Map(),
    lastSyncedByProject: async () => new Map(),
  },
}));
vi.mock("@/lib/scope", () => ({
  getScopeClient: () => ({
    listPrompts: h.listPrompts,
    listMeasurementRuns: h.listMeasurementRuns,
    listRunJobs: h.listRunJobs,
    getQueryRun: async () => ({ result: null }),
  }),
}));
vi.mock("@/lib/scope/result-adapter", () => ({ getRootConfig: () => ({ projectId: ROOT }) }));
vi.mock("@/lib/db/repositories/projects", () => ({ projectRepository: { listAll: async () => [] } }));
vi.mock("@/lib/db/repositories/prompts", () => ({
  promptRepository: { updateStatusByScopePromptIds: async () => 0 },
}));
vi.mock("@/lib/db/repositories/website-sites", () => ({ getWebsiteScopeProjectIds: async () => [] }));
vi.mock("@/lib/db/repositories/project-tracked-dictionary", () => ({
  getProjectTrackedDictionary: async () => null,
}));

const {
  syncStandardMirror,
  planPromptRead,
  planRunScan,
  shouldStopRunScan,
  scanRunList,
  computeRunFloor,
  runHoldsFloor,
  PROMPT_WATERMARK_MARGIN_MS,
  PROMPT_TICK_MAX_PAGES,
  MIRROR_RUN_SETTLED_STREAK,
  MIRROR_RUN_FLOOR_ANCHORS,
  OPEN_RUN_FLOOR_MAX_AGE_MS,
  MIRROR_RUN_MAX_PAGES,
  mirrorJobCapacity,
} = await import("./sync");
const { PROMPT_MAX_PAGES } = await import("@/lib/scope/paging");
const { RUN_RECHECK_WINDOW_MS } = await import("./recheck-window");

// ── 세계 ───────────────────────────────────────────────────────────────────
type Job = { job_id: string; prompt_id: string; target: string; region: string; status: string; measured_at: string };
type Run = {
  measurement_run_id: string; project_id: string; trigger: string; status: string; targets: string[];
  regions: string[]; total_jobs: number; started_at: string; completed_at: string | null;
};
type Wm = {
  promptsSyncedThrough: Date | null;
  promptsResume: { cursor: string; from: Date | null; startedAt: Date } | null;
  runsFloorRunIds: string[] | null;
  runsFloorSnapshotAt: Date | null;
};
const HOURS = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
const emptyWm = (): Wm => ({ promptsSyncedThrough: null, promptsResume: null, runsFloorRunIds: null, runsFloorSnapshotAt: null });

let W: {
  runs: Run[];
  jobs: Map<string, Job[]>;
  mirror: Map<string, { status: string; answers: string[]; startedAt: string | null }>;
  wm: Map<string, Wm>;
  /** true = 0082 미적용(syncWatermarks → null). */
  disabled: boolean;
  prompts: Array<{ prompt_id: string; updated: number; v: number }>;
  upserted: Map<string, number>;
  pause?: { runId: string; hit: () => void; gate: Promise<void> };
};
function derive(jobs: Job[]): string {
  const c = { total: jobs.length, completed: 0, failed: 0, running: 0, queued: 0 };
  for (const j of jobs) if (j.status in c) (c as Record<string, number>)[j.status]++;
  if (c.total === 0) return "queued";
  if (c.completed === c.total) return "completed";
  if (c.failed === c.total) return "failed";
  if (c.running > 0) return "running";
  if (c.failed > 0 && c.completed + c.failed === c.total) return "partial_failed";
  return "queued";
}
let seq = 0;
const job = (runId: string, status: string, prompt = "p1"): Job => ({
  job_id: `${runId}-j${seq++}`, prompt_id: prompt, target: "chatgpt", region: "KR", status, measured_at: HOURS(1),
  // ACR 반복: 완주 job 에만 분석(acr_summary.prompt_run_id)이 붙는다 — 실패 반복은 셀 키로 여기에 접힌다.
  ...(status === "completed"
    ? { analysis: { status: "completed", acr_summary: { prompt_run_id: `pr-${runId}-${prompt}`, rows: [] } } }
    : {}),
} as Job);
function mkRun(id: string, jobs: Job[], startedAt = HOURS(2)): Run {
  W.jobs.set(id, jobs);
  return {
    measurement_run_id: id, project_id: ROOT, trigger: "scheduled", status: derive(jobs),
    targets: ["chatgpt"], regions: ["KR"], total_jobs: jobs.length, started_at: startedAt, completed_at: null,
  };
}
function setJobs(runId: string, jobs: Job[]) {
  W.jobs.set(runId, jobs);
  const r = W.runs.find((x) => x.measurement_run_id === runId);
  if (r) { r.status = derive(jobs); r.total_jobs = jobs.length; }
}
const mirrorAs = (id: string, status: string, answers: string[], startedAt = HOURS(2)) =>
  W.mirror.set(id, { status, answers, startedAt });
/** 미러에 정착한 run n 개(completed · 답변 completed). */
function settledRuns(prefix: string, n: number): Run[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `${prefix}${i}`;
    mirrorAs(id, "completed", ["completed"]);
    return mkRun(id, [job(id, "completed")]);
  });
}
/** 미러에 없는 신규 completed run. */
const freshRun = (id: string) => mkRun(id, [job(id, "completed")]);
const setWm = (patch: Partial<Wm>) => W.wm.set(ROOT, { ...(W.wm.get(ROOT) ?? emptyWm()), ...patch });
const wm = () => W.wm.get(ROOT) ?? emptyWm();
const TERMINAL = ["completed", "failed", "partial_failed"];
const lastPromptQuery = () => h.listPrompts.mock.calls.at(-1)?.[1];
const quiet = () => {
  const a = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => a.mockRestore();
};

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  W = { runs: [], jobs: new Map(), mirror: new Map(), wm: new Map(), disabled: false, prompts: [], upserted: new Map() };
  h.recordSyncAttempt.mockResolvedValue(undefined);
  h.markSyncAttemptStarted.mockResolvedValue(undefined);
  h.mirroredRunStates.mockImplementation(async () => new Map(
    [...W.mirror].filter(([, m]) => TERMINAL.includes(m.status)).map(([id, m]) => [id, {
      status: m.status,
      hasUnresolved: m.answers.some((s) => s !== "completed"),
      recheckable: m.startedAt == null || new Date(m.startedAt).getTime() >= Date.now() - RUN_RECHECK_WINDOW_MS,
      syncedAt: new Date(),
    }])));
  // `runsFloorRunId`(단수)는 ddcc14c 형태 — 수정 전 코드에서도 floor 가 실제로 작동하게 해 두어야
  // "수정 전 실패" 대조가 형태 차이가 아니라 동작 차이를 잰다.
  h.syncWatermarks.mockImplementation(async () =>
    W.disabled ? null : new Map([...W.wm].map(([k, v]) => [k, {
      ...v, runsFloorRunIds: v.runsFloorRunIds && [...v.runsFloorRunIds], runsFloorRunId: v.runsFloorRunIds?.[0] ?? null,
    }])));
  // 저장 쪽 규칙을 그대로 흉내 낸다: 프롬프트 워터마크는 GREATEST + 이어 읽기 비움,
  // floor 는 **더 새 스냅샷일 때만** 덮는다(repository recordRunFloor 의 setWhere).
  h.recordPromptWatermark.mockImplementation(async (pid: string, d: Date) => {
    const cur = W.wm.get(pid) ?? emptyWm();
    const next = cur.promptsSyncedThrough && cur.promptsSyncedThrough > d ? cur.promptsSyncedThrough : d;
    W.wm.set(pid, { ...cur, promptsSyncedThrough: next, promptsResume: null });
  });
  h.recordPromptResume.mockImplementation(async (pid: string, r: Wm["promptsResume"]) => {
    W.wm.set(pid, { ...(W.wm.get(pid) ?? emptyWm()), promptsResume: r });
  });
  h.clearPromptResume.mockImplementation(async (pid: string) => {
    W.wm.set(pid, { ...(W.wm.get(pid) ?? emptyWm()), promptsResume: null });
  });
  h.recordRunFloor.mockImplementation(async (pid: string, idsOrId: string[] | string | null, snap?: Date) => {
    const ids = typeof idsOrId === "string" ? [idsOrId] : idsOrId; // ddcc14c 는 단일 id·스냅샷 없음
    const cur = W.wm.get(pid) ?? emptyWm();
    if (snap && cur.runsFloorSnapshotAt && !(cur.runsFloorSnapshotAt < snap)) return false;
    W.wm.set(pid, { ...cur, runsFloorRunIds: ids, runsFloorSnapshotAt: snap ?? cur.runsFloorSnapshotAt });
    return true;
  });
  h.replaceRun.mockImplementation(async (meta: { runId: string; status: string; startedAt: Date | null }, answers: Array<{ status: string }>) => {
    W.mirror.set(meta.runId, { status: meta.status, answers: answers.map((a) => a.status), startedAt: meta.startedAt?.toISOString() ?? null });
  });
  h.upsertPrompts.mockImplementation(async (rows: Array<{ promptId: string; text: string }>) => {
    for (const r of rows) W.upserted.set(r.promptId, Number(String(r.text).slice(1)));
  });
  h.listMeasurementRuns.mockImplementation(async (_p: string, q: { cursor?: string }) => {
    const start = q?.cursor ? Number(q.cursor) : 0;
    const snap = W.runs.map((r) => ({ ...r }));
    return { data: snap.slice(start, start + 100), next_cursor: start + 100 < snap.length ? String(start + 100) : null };
  });
  h.listRunJobs.mockImplementation(async (_p: string, runId: string) => {
    if (W.pause && W.pause.runId === runId) { const p = W.pause; W.pause = undefined; p.hit(); await p.gate; }
    return { data: (W.jobs.get(runId) ?? []).map((j) => ({ ...j })), next_cursor: null };
  });
  h.listPrompts.mockImplementation(async (_p: string, q: { cursor?: string; updated_from?: string; updated_to?: string }) => {
    const from = q?.updated_from ? new Date(q.updated_from).getTime() : -Infinity;
    const to = q?.updated_to ? new Date(q.updated_to).getTime() : Infinity;
    const rows = W.prompts.filter((p) => p.updated >= from && p.updated <= to); // created desc 순서
    const start = q?.cursor ? Number(q.cursor) : 0;
    return {
      data: rows.slice(start, start + 100).map((p) => ({ prompt_id: p.prompt_id, text: `v${p.v}`, funnel_stage: null })),
      next_cursor: start + 100 < rows.length ? String(start + 100) : null,
    };
  });
});

// ── 순수 함수 ───────────────────────────────────────────────────────────────
describe("planPromptRead — 프롬프트 읽기 방식", () => {
  const base = { watermarksEnabled: true, explicitWindow: false, force: false, fullScan: false };
  const wmAt = new Date("2026-09-28T03:00:00.000Z");

  it("워터마크가 있으면 증분 — updated_from = 워터마크 − 10분, 이어 읽기 가능", () => {
    const p = planPromptRead({ ...base, syncedThrough: wmAt });
    expect(p).toMatchObject({ mode: "incremental", updatedFrom: "2026-09-28T02:50:00.000Z", resumable: true, canAdvance: true });
    expect(PROMPT_WATERMARK_MARGIN_MS).toBe(10 * 60 * 1000);
  });

  it("이어 읽기 상태가 있으면 같은 창·같은 커서로 — 전진값은 그 창의 첫 읽기 시각", () => {
    const resume = { cursor: "c40", from: new Date("2026-09-28T02:00:00.000Z"), startedAt: new Date("2026-09-28T02:10:00.000Z") };
    const p = planPromptRead({ ...base, syncedThrough: wmAt, resume });
    expect(p).toMatchObject({
      mode: "resume", updatedFrom: "2026-09-28T02:00:00.000Z", startCursor: "c40",
      windowStartedAt: resume.startedAt, resumable: true, canAdvance: true,
    });
  });

  it("첫 실행(워터마크 없음)은 하한 없는 창을 이어 읽기로 끝까지 — 루트도 몇 틱 안에 워터마크가 선다", () => {
    expect(planPromptRead({ ...base, syncedThrough: null })).toMatchObject({ mode: "full", resumable: true, canAdvance: true });
  });

  it("force·fullScan 은 증분·이어 읽기를 쓰지 않는다(강제 재싱크를 막지 않는다)", () => {
    const resume = { cursor: "c", from: null, startedAt: wmAt };
    for (const p of [
      planPromptRead({ ...base, force: true, syncedThrough: wmAt, resume }),
      planPromptRead({ ...base, fullScan: true, syncedThrough: wmAt, resume }),
    ]) expect(p).toMatchObject({ mode: "full", resumable: false, canAdvance: true });
  });

  it("호출자 창은 종전 그대로 + 전진 금지 / 표 미적용이면 전량 + 전진 없음", () => {
    expect(planPromptRead({ ...base, explicitWindow: true, syncedThrough: wmAt })).toMatchObject({ mode: "window", canAdvance: false, resumable: false });
    expect(planPromptRead({ ...base, watermarksEnabled: false, syncedThrough: wmAt })).toMatchObject({ mode: "full", canAdvance: false, resumable: false });
  });
});

describe("planRunScan — run 목록 조기 종료·floor 기록 허용", () => {
  const base = { watermarksEnabled: true, force: false, fullScan: false, floorRunIds: ["f"] };
  it("정규 크론 + floor 있음 → 둘 다 / floor 없음 → 기록만 / fullScan → 기록만", () => {
    expect(planRunScan(base)).toEqual({ recordFloor: true, earlyStop: true });
    expect(planRunScan({ ...base, floorRunIds: null })).toEqual({ recordFloor: true, earlyStop: false });
    expect(planRunScan({ ...base, floorRunIds: [] })).toEqual({ recordFloor: true, earlyStop: false });
    expect(planRunScan({ ...base, fullScan: true })).toEqual({ recordFloor: true, earlyStop: false });
  });
  it("force·resyncBefore·runsSince·runsUntil(local-resync 계열)·표 미적용은 둘 다 끈다", () => {
    const off = { recordFloor: false, earlyStop: false };
    expect(planRunScan({ ...base, force: true })).toEqual(off);
    expect(planRunScan({ ...base, resyncBefore: new Date() })).toEqual(off);
    expect(planRunScan({ ...base, runsSince: new Date() })).toEqual(off);
    expect(planRunScan({ ...base, runsUntil: new Date() })).toEqual(off);
    expect(planRunScan({ ...base, watermarksEnabled: false })).toEqual(off);
  });
});

describe("shouldStopRunScan", () => {
  it("floor 를 지나고 연속 정착이 N 이상일 때만 멈춘다", () => {
    const b = { earlyStop: true, passedFloor: true, streakTarget: 200 };
    expect(shouldStopRunScan({ ...b, settledStreak: 200 })).toBe(true);
    expect(shouldStopRunScan({ ...b, settledStreak: 199 })).toBe(false);
    expect(shouldStopRunScan({ ...b, passedFloor: false, settledStreak: 500 })).toBe(false);
    expect(shouldStopRunScan({ ...b, earlyStop: false, settledStreak: 500 })).toBe(false);
  });
  it("기본값: 연속 200(보장 폭 floor 아래 최소 200) · 앵커 5 · 프롬프트 틱 상한 20", () => {
    expect(MIRROR_RUN_SETTLED_STREAK).toBe(200);
    expect(MIRROR_RUN_FLOOR_ANCHORS).toBe(5);
    expect(PROMPT_TICK_MAX_PAGES).toBe(20);
  });
});

describe("computeRunFloor — 불변식: floor 보다 오래된 run 은 전부 정착", () => {
  const runs = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"].map((id) => ({ measurement_run_id: id }));
  it("완결이 아니면 이전 floor 유지(미확인 구간을 올릴 근거가 없다)", () => {
    expect(computeRunFloor({ runs, holdsFloor: () => false, scanComplete: false, previousFloorRunIds: ["old"] }))
      .toEqual({ floorRunIds: ["old"], changed: false });
  });
  it("붙잡는 run 중 가장 오래된 것 + 그 아래 run 들이 앵커(최대 K)", () => {
    const hold = new Set(["r2", "r3"]);
    expect(computeRunFloor({ runs, holdsFloor: (id) => hold.has(id), scanComplete: true, previousFloorRunIds: ["r1"] }))
      .toEqual({ floorRunIds: ["r3", "r4", "r5", "r6", "r7"], changed: true });
  });
  it("붙잡는 run 이 없으면 맨 앞부터 K 개 / 목록 끝이면 남은 만큼", () => {
    expect(computeRunFloor({ runs, holdsFloor: () => false, scanComplete: true, previousFloorRunIds: null }).floorRunIds)
      .toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(computeRunFloor({ runs, holdsFloor: (id) => id === "r7", scanComplete: true, previousFloorRunIds: null }).floorRunIds)
      .toEqual(["r7", "r8"]);
  });
  it("빈 목록이면 null", () => {
    expect(computeRunFloor({ runs: [], holdsFloor: () => true, scanComplete: true, previousFloorRunIds: null }))
      .toEqual({ floorRunIds: null, changed: false });
  });
});

describe("runHoldsFloor", () => {
  const now = Date.parse("2026-09-28T00:00:00.000Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const r = (status: string, msAgo: number, jobs = 2) => ({ status, started_at: at(msAgo), total_jobs: jobs });
  it("정착한 completed run 은 붙잡지 않는다 / 정착 안 한 terminal run 은 붙잡는다", () => {
    expect(runHoldsFloor(r("completed", 3600_000), true, now)).toBe(false);
    expect(runHoldsFloor(r("completed", 3600_000), false, now)).toBe(true);
  });
  it("V1: completed 가 아닌 terminal run 은 **정착했어도** 재확인 창 동안 붙잡는다", () => {
    expect(runHoldsFloor(r("partial_failed", 3600_000), true, now)).toBe(true);
    expect(runHoldsFloor(r("failed", RUN_RECHECK_WINDOW_MS - 1000), true, now)).toBe(true);
    expect(runHoldsFloor(r("partial_failed", RUN_RECHECK_WINDOW_MS + 1000), true, now)).toBe(false);
  });
  it("최근 비종결 run 은 붙잡고, 7일 넘은 좀비는 붙잡지 않는다", () => {
    expect(runHoldsFloor(r("running", 3600_000), false, now)).toBe(true);
    expect(runHoldsFloor(r("running", OPEN_RUN_FLOOR_MAX_AGE_MS + 1000), false, now)).toBe(false);
  });
  it("이번 패스가 **처리하지 못한** 비정착 run 은 나이와 무관하게 붙잡는다(7일 규칙은 처리해 본 run 에만)", () => {
    const old = OPEN_RUN_FLOOR_MAX_AGE_MS + 86400_000;
    expect(runHoldsFloor(r("running", old), false, now, false)).toBe(true);
    expect(runHoldsFloor(r("completed", 60 * 86400_000), false, now, false)).toBe(true);
    expect(runHoldsFloor(r("running", old), false, now, true)).toBe(false);
    expect(runHoldsFloor(r("completed", 60 * 86400_000), true, now, false)).toBe(false); // 정착은 그대로 놓는다
  });
  it("오버사이즈 run 은 붙잡지 않는다(크론이 미러할 수 없다)", () => {
    expect(runHoldsFloor(r("partial_failed", 3600_000, mirrorJobCapacity() + 1), false, now)).toBe(false);
  });
});

describe("scanRunList — 조기 종료와 안전망", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ measurement_run_id: `r${i}`, status: "completed" }) as unknown as Run);
  const fetcher = (runs: Run[]) => vi.fn(async (cursor?: string) => {
    const start = cursor ? Number(cursor) : 0;
    return { data: runs.slice(start, start + 100), next_cursor: start + 100 < runs.length ? String(start + 100) : null };
  });
  const base = { maxPages: 50, label: "t", earlyStop: true, streakTarget: 200, isSettled: () => true };

  it("floor 를 지나 정착 200 연속이면 그 페이지에서 멈춘다", async () => {
    const f = fetcher(ids(800));
    const res = await scanRunList(f, { ...base, floorRunIds: ["r5"] });
    expect(f).toHaveBeenCalledTimes(3); // 94 → 194 → 294
    expect(res).toMatchObject({ stoppedEarly: true, truncated: false, passedFloor: true, floorIndex: 5, pages: 3 });
  });

  it("(d) floor run 이 지워져도 아래 앵커 하나로 경계를 지난다", async () => {
    const runs = ids(800).filter((r) => r.measurement_run_id !== "r5");
    const f = fetcher(runs);
    const res = await scanRunList(f, { ...base, floorRunIds: ["r5", "r6", "r7", "r8", "r9"] });
    expect(res).toMatchObject({ stoppedEarly: true, truncated: false, passedFloor: true });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("floor 가 마지막 페이지에 있어도 통과로 기록한다(목록 끝 = 완결)", async () => {
    const res = await scanRunList(fetcher(ids(150)), { ...base, floorRunIds: ["r140"] });
    expect(res).toMatchObject({ passedFloor: true, reachedEnd: true, stoppedEarly: false, truncated: false, floorIndex: 140 });
  });

  it("⑦ 앵커를 하나도 못 만나면 상한에서 절단(안전망)", async () => {
    const f = fetcher(ids(1000));
    const restore = quiet();
    const res = await scanRunList(f, { ...base, maxPages: 3, floorRunIds: ["gone"] });
    restore();
    expect(res).toMatchObject({ truncated: true, stoppedEarly: false, passedFloor: false, reachedEnd: false });
  });
});

// ── 싱크 경로 (세계) ────────────────────────────────────────────────────────
describe("① 프롬프트 워터마크 전진·미전진", () => {
  it("upsert 성공 + 끝까지 → 읽기 **시작** 시각으로 전진(끝 시각이 아니다)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = new Date("2026-09-28T03:00:00.000Z");
      vi.setSystemTime(t0);
      W.prompts = [{ prompt_id: "p1", updated: t0.getTime(), v: 1 }];
      const inner = h.listPrompts.getMockImplementation()!;
      h.listPrompts.mockImplementation(async (...a: unknown[]) => {
        vi.setSystemTime(new Date(t0.getTime() + 60_000)); // 읽는 동안 시계가 흐른다
        return inner(...(a as [string, object]));
      });
      await syncStandardMirror({});
      expect(wm().promptsSyncedThrough?.toISOString()).toBe(t0.toISOString());
      expect(h.upsertPrompts.mock.invocationCallOrder[0]).toBeLessThan(h.recordPromptWatermark.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("upsert 실패 → 전진하지 않는다", async () => {
    W.prompts = [{ prompt_id: "p1", updated: Date.now(), v: 1 }];
    h.upsertPrompts.mockRejectedValue(new Error("db down"));
    const restore = quiet();
    const r = await syncStandardMirror({});
    restore();
    expect(h.recordPromptWatermark).not.toHaveBeenCalled();
    expect(r.perProject[0].error).toContain("db down");
  });

  it("run 단계가 실패해도 프롬프트 워터마크는 이미 전진했다 · floor 는 안 쓴다", async () => {
    h.listMeasurementRuns.mockRejectedValue(new Error("runs 500"));
    const restore = quiet();
    await syncStandardMirror({});
    restore();
    expect(h.recordPromptWatermark).toHaveBeenCalledTimes(1);
    expect(h.recordRunFloor).not.toHaveBeenCalled();
  });
});

describe("② 증분 창", () => {
  it("워터마크가 있으면 updated_from = 워터마크 − 10분", async () => {
    setWm({ promptsSyncedThrough: new Date("2026-09-28T03:00:00.000Z") });
    const r = await syncStandardMirror({});
    expect(lastPromptQuery()).toMatchObject({ updated_from: "2026-09-28T02:50:00.000Z", limit: 100 });
    expect(r.perProject[0].promptRead).toBe("incremental");
  });

  it("⑤ 표 미적용(null)·조회 실패 → 종전 전량 읽기(상한 50), 워터마크 쓰기 0", async () => {
    W.disabled = true;
    W.runs = [freshRun("n1")];
    await syncStandardMirror({});
    expect(lastPromptQuery()).not.toHaveProperty("updated_from");
    h.syncWatermarks.mockRejectedValue(new Error("relation does not exist"));
    const restore = quiet();
    await syncStandardMirror({});
    restore();
    for (const f of [h.recordPromptWatermark, h.recordPromptResume, h.recordRunFloor]) expect(f).not.toHaveBeenCalled();
  });

  it("promptsUpdatedFrom(백필 창)은 워터마크를 무시·전진시키지 않는다", async () => {
    setWm({ promptsSyncedThrough: new Date("2026-09-28T03:00:00.000Z") });
    await syncStandardMirror({ promptsUpdatedFrom: "2026-06-01T00:00:00Z" });
    expect(lastPromptQuery()).toMatchObject({ updated_from: "2026-06-01T00:00:00Z" });
    expect(h.recordPromptWatermark).not.toHaveBeenCalled();
  });
});

describe("V4 한 창에서 한 틱 상한을 넘게 갱신된 프롬프트 — 커서로 이어 읽어 전진한다", () => {
  it("같은 시각 일괄 편집 6,000건: 20·20·20 페이지로 3틱에 완주, 워터마크는 첫 틱 시작 시각으로", async () => {
    const now = Date.now();
    W.prompts = Array.from({ length: 12_446 }, (_, i) => ({ prompt_id: `p${i}`, updated: now - 30 * 86400_000, v: 0 }));
    const wm0 = new Date(now - 60 * 60_000);
    setWm({ promptsSyncedThrough: wm0 });
    // 일괄분은 첫 틱보다 여유(10분) 이상 앞 — 그래야 완주 뒤 다음 창에서 빠진다(여유 안이면 한 번 더 읽는다).
    for (let i = 3_000; i < 9_000; i++) { W.prompts[i].updated = now - 30 * 60_000; W.prompts[i].v = 1; }
    const restore = quiet();
    const pages: number[] = [];
    let firstStart: Date | undefined;
    for (let pass = 0; pass < 3; pass++) {
      const r = await syncStandardMirror({});
      pages.push(r.perProject[0].promptPages ?? -1);
      expect(r.pageCapHits).toEqual([]); // 이어 읽기는 절단이 아니다
      firstStart ??= wm().promptsResume?.startedAt;
      expect(r.perProject[0].promptResumePending).toBe(pass < 2);
    }
    restore();
    expect(pages).toEqual([20, 20, 20]);
    expect(wm().promptsResume).toBeNull();
    expect(wm().promptsSyncedThrough?.getTime()).toBe(firstStart!.getTime());
    expect(W.prompts.slice(3_000, 9_000).filter((p) => W.upserted.get(p.prompt_id) !== 1)).toHaveLength(0);
    // 다음 틱은 새 창(첫 틱 시작 − 10분)에서 다시 한 페이지만 읽는다 — 일괄분 6,000 은 창 밖.
    const r = await syncStandardMirror({});
    expect(r.perProject[0]).toMatchObject({ promptRead: "incremental", promptPages: 1 });
  });

  it("첫 실행 루트(12,446): 7틱에 걸쳐 전량을 읽고 워터마크를 세운다(전체 대조 없이도)", async () => {
    W.prompts = Array.from({ length: 12_446 }, (_, i) => ({ prompt_id: `p${i}`, updated: Date.now() - 86400_000, v: 2 }));
    const restore = quiet();
    let passes = 0;
    while (!wm().promptsSyncedThrough && passes < 10) { await syncStandardMirror({}); passes++; }
    restore();
    expect(passes).toBe(Math.ceil(125 / PROMPT_TICK_MAX_PAGES));
    expect(W.upserted.size).toBe(12_446);
  });

  it("저장된 커서가 거절되면 이어 읽기 상태를 비운다(매 틱 같은 자리에서 죽지 않는다)", async () => {
    setWm({ promptsSyncedThrough: new Date(), promptsResume: { cursor: "bad", from: null, startedAt: new Date() } });
    h.listPrompts.mockRejectedValueOnce(new Error("400 invalid cursor"));
    const restore = quiet();
    await syncStandardMirror({});
    restore();
    expect(h.clearPromptResume).toHaveBeenCalledWith(ROOT);
    expect(wm().promptsResume).toBeNull();
  });

  it("비이어 읽기(force) 절단은 종전처럼 pageCapHits 로 표면화하고 전진하지 않는다", async () => {
    W.prompts = Array.from({ length: 6_000 }, (_, i) => ({ prompt_id: `p${i}`, updated: Date.now(), v: 1 }));
    const restore = quiet();
    const r = await syncStandardMirror({ force: true });
    restore();
    expect(h.listPrompts).toHaveBeenCalledTimes(PROMPT_MAX_PAGES);
    expect(r.pageCapHits).toContainEqual({ projectId: ROOT, kind: "prompts" });
    expect(h.recordPromptWatermark).not.toHaveBeenCalled();
  });
});

describe("③ run 조기 종료", () => {
  it("floor 를 지나 정착 200 연속 → 목록 3페이지, 신규 run 은 쓴다, 새 floor = 맨 앞 앵커", async () => {
    W.runs = [freshRun("new-1"), freshRun("new-2"), ...settledRuns("s", 8_000)];
    setWm({ promptsSyncedThrough: new Date(), runsFloorRunIds: ["s0", "s1", "s2", "s3", "s4"], runsFloorSnapshotAt: new Date(0) });
    const r = await syncStandardMirror({});
    expect(h.listMeasurementRuns).toHaveBeenCalledTimes(3);
    expect(h.replaceRun.mock.calls.map((c) => c[0].runId)).toEqual(["new-1", "new-2"]);
    expect(r.pageCapHits).toEqual([]);
    expect(r.perProject[0]).toMatchObject({ runPages: 3, runScanStoppedEarly: true, runs: 2 });
    expect(wm().runsFloorRunIds).toEqual(["new-1", "new-2", "s0", "s1", "s2"]);
  });

  it("floor 아래의 비종결 run 은 연속을 끊고, 다시 당겨지며, floor 를 붙잡는다", async () => {
    W.runs = settledRuns("s", 600);
    W.runs[250] = mkRun("open", [job("open", "running")]);
    setWm({ runsFloorRunIds: ["s0"], runsFloorSnapshotAt: new Date(0) });
    await syncStandardMirror({});
    expect(h.listMeasurementRuns).toHaveBeenCalledTimes(5); // 3페이지 리셋 → 5페이지에서 249 ≥ 200
    expect(h.replaceRun.mock.calls.map((c) => c[0].runId)).toEqual(["open"]);
    expect(wm().runsFloorRunIds?.[0]).toBe("open");
  });

  it("(d) 저장된 floor run 이 Scope 에서 지워져도 아래 앵커로 멈춘다(상한 절단 복귀 없음)", async () => {
    W.runs = settledRuns("s", 8_000);
    setWm({ runsFloorRunIds: ["gone", "s0", "s1", "s2", "s3"], runsFloorSnapshotAt: new Date(0) });
    const r = await syncStandardMirror({});
    expect(r.pageCapHits).toEqual([]);
    expect(r.perProject[0].runScanStoppedEarly).toBe(true);
  });

  it("⑦ 앵커가 전부 사라졌으면 상한까지 읽고 floor 는 **그대로**", async () => {
    W.runs = settledRuns("s", 800);
    setWm({ runsFloorRunIds: ["gone"], runsFloorSnapshotAt: new Date(0) });
    const restore = quiet();
    const r = await syncStandardMirror({ runMaxPages: 4 });
    restore();
    expect(h.listMeasurementRuns).toHaveBeenCalledTimes(4);
    expect(r.pageCapHits).toContainEqual({ projectId: ROOT, kind: "runs" });
    expect(h.recordRunFloor).not.toHaveBeenCalled();
  });
});

describe("④ 못 처리한 오래된 run 이 floor 를 붙잡는다 (연속-N 단독의 구멍)", () => {
  it("run 상한으로 끊긴 패스 → 남은 신규 run 이 floor → 다음 패스가 그 run 까지 읽고 쓴다", async () => {
    W.runs = [freshRun("new-1"), freshRun("new-2"), freshRun("new-3"), ...settledRuns("s", 600)];
    await syncStandardMirror({ maxRuns: 1 });
    expect(wm().runsFloorRunIds?.[0]).toBe("new-3");
    // 그 사이 신규 run 200개가 더 쌓여도(연속-N 만 보면 여기서 멈춘다) floor 까지 간다.
    W.runs = [...settledRuns("t", 250), ...W.runs];
    await syncStandardMirror({});
    expect(W.mirror.has("new-2")).toBe(true);
    expect(W.mirror.has("new-3")).toBe(true);
  });

  it("재확인 대상(terminal + 실패 답변)으로 쓴 run 은 floor 를 붙잡는다", async () => {
    W.runs = [freshRun("ok"), mkRun("pf", [job("pf", "completed", "a"), job("pf", "failed", "b")])];
    await syncStandardMirror({});
    expect(wm().runsFloorRunIds?.[0]).toBe("pf");
  });
});

describe("재검증 부수 발견 1 — 이번 패스가 **처리하지 못한** run 은 나이와 무관하게 floor 를 붙잡는다", () => {
  function world(ageDays: number) {
    const started = HOURS(24 * ageDays);
    W.runs = [freshRun("new-1"), mkRun("old-open", [job("old-open", "running")], started), ...settledRuns("s", 600)];
    // 미러에 없음 + maxRuns 로 이번 패스 미처리
  }
  it.each([8, 6])("미러에 없는 %i일 된 running run 이 run 상한으로 밀려도 다음 패스들이 회수한다", async (days) => {
    world(days);
    await syncStandardMirror({ maxRuns: 1 });
    expect(W.mirror.has("old-open")).toBe(false);
    expect(wm().runsFloorRunIds?.[0]).toBe("old-open"); // 종전(결함, 8일): new-1 로 올라가 묻힘
    W.runs = [...settledRuns("t", 250), ...W.runs]; // 그 사이 신규 250개 정착
    for (let i = 0; i < 2; i++) await syncStandardMirror({});
    expect(W.mirror.get("old-open")?.status).toBe("running");
  });
  it("한 번 처리(여전히 running)한 7일 초과 좀비는 floor 를 놓고 openRunsReleased 로 센다", async () => {
    world(8);
    const r = await syncStandardMirror({});
    expect(W.mirror.get("old-open")?.status).toBe("running");
    expect(wm().runsFloorRunIds?.[0]).toBe("new-1");
    expect(r.perProject[0].openRunsReleased).toBe(1);
  });
});

describe("V1 ACR 숨은 실패(대표 답변 completed) run 의 partial_failed → completed 전이 — 재확인 창 안", () => {
  it("첫 패스 floor 가 그 run 을 붙잡고, 전이 뒤 다음 패스가 다시 당긴다", async () => {
    W.runs = settledRuns("s", 300);
    W.runs[250] = mkRun("acr", [job("acr", "completed"), job("acr", "failed")]);
    expect(W.runs[250].status).toBe("partial_failed");
    const restore = quiet();
    await syncStandardMirror({});
    expect(W.mirror.get("acr")).toMatchObject({ status: "partial_failed", answers: ["completed"] });
    expect(wm().runsFloorRunIds?.[0]).toBe("acr"); // 종전(결함): s0
    setJobs("acr", [job("acr", "completed"), job("acr", "completed")]);
    await syncStandardMirror({});
    restore();
    expect(W.mirror.get("acr")?.status).toBe("completed");
  });
});

describe("V2 floor 아래로 늦게 나타난 run — 보장 폭은 floor 아래 최소 N(200)", () => {
  function world(lateIndex: number) {
    W.runs = settledRuns("s", 600);
    setWm({ promptsSyncedThrough: new Date(), runsFloorRunIds: ["s0"], runsFloorSnapshotAt: new Date(0) });
    W.runs.splice(lateIndex, 0, freshRun("late"));
  }
  it.each([199, 200])("floor 아래 %i 번째(≤ N)는 잡힌다", async (idx) => {
    world(idx);
    await syncStandardMirror({});
    expect(W.mirror.has("late")).toBe(true);
  });
  it("그보다 깊으면(여기서는 300) 크론은 못 보고, 전체 대조가 회수하며 pulledBelowFloor 로 센다", async () => {
    world(300);
    await syncStandardMirror({});
    expect(W.mirror.has("late")).toBe(false);
    const r = await syncStandardMirror({ fullScan: true, runMaxPages: 1_000, promptMaxPages: 1_000 });
    expect(W.mirror.has("late")).toBe(true);
    expect(r.perProject[0].pulledBelowFloor).toBe(1);
  });
});

describe("V3 긴 패스(전체 대조)의 낡은 목록 스냅샷은 더 새 floor 를 덮지 못한다", () => {
  it("reconcile 스냅샷 뒤 전이한 run 을 크론이 붙잡은 floor 가 살아남아 다음 틱에 회수된다", async () => {
    W.runs = settledRuns("s", 500);
    W.runs[0] = freshRun("N0"); W.mirror.delete("s0");
    // Y: ACR 숨은 실패지만 재확인 창 **밖**(V1 규칙으로 붙잡히지 않게) — 정착.
    const old = HOURS(24 * 4);
    W.runs[250] = mkRun("Y", [job("Y", "completed"), job("Y", "failed")], old);
    mirrorAs("Y", "partial_failed", ["completed"], old);
    // D: 미러는 실패 답변(재확인 대상), Scope 는 이미 회수 — floor 를 붙잡고 있다.
    W.runs[300] = mkRun("D", [job("D", "completed")]);
    mirrorAs("D", "partial_failed", ["failed"]);
    setWm({ promptsSyncedThrough: new Date(), runsFloorRunIds: ["D"], runsFloorSnapshotAt: new Date(0) });
    let hit!: () => void; const reached = new Promise<void>((r) => { hit = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    W.pause = { runId: "N0", hit, gate };
    const restore = quiet();
    const A = syncStandardMirror({ fullScan: true, runMaxPages: 1000, promptMaxPages: 1000 });
    await reached; // A: 목록 전량을 읽고 첫 run 에서 멈춤
    await new Promise((r) => setTimeout(r, 5)); // B 의 스냅샷 시각이 A 보다 확실히 늦게
    setJobs("Y", [job("Y", "completed"), job("Y", "completed")]); // A 스냅샷 이후 전이
    const b = await syncStandardMirror({ maxRuns: 1 }); // B: Y 를 보지만 run 상한으로 미처리
    expect(b.runLimitHits.length).toBe(1);
    const bFloor = wm().runsFloorRunIds?.[0];
    release(); await A; // A 가 끝나며 자기 낡은 스냅샷으로 floor 를 쓰려 한다 → 거절
    expect(wm().runsFloorRunIds?.[0]).toBe(bFloor);
    expect(bFloor).not.toBe("N0");
    for (let i = 0; i < 2; i++) await syncStandardMirror({}); // 정규 틱
    restore();
    expect(W.mirror.get("Y")?.status).toBe("completed"); // 종전(결함): partial_failed 로 24h 누락
  });
});

describe("V3 보조 — floor 값이 그대로여도 매 패스 스냅샷을 올린다", () => {
  it("안 올리면 그 사이 목록을 읽은 긴 패스가 낡은 floor 로 덮을 수 있다", async () => {
    W.runs = settledRuns("s", 300);
    await syncStandardMirror({});
    const first = wm();
    await new Promise((r) => setTimeout(r, 5));
    await syncStandardMirror({});
    expect(wm().runsFloorRunIds).toEqual(first.runsFloorRunIds); // 값은 같다
    expect(wm().runsFloorSnapshotAt!.getTime()).toBeGreaterThan(first.runsFloorSnapshotAt!.getTime());
  });
});

describe("⑥ 강제 재싱크(mirror:local-resync 계열)는 종전 동작", () => {
  it("force + runsSince/Until: updated_from 없음 · run 목록 전량 · floor 안 씀 · 정착 run 도 다시 당김", async () => {
    setWm({ promptsSyncedThrough: new Date("2026-09-28T03:00:00.000Z"), runsFloorRunIds: ["s1"], runsFloorSnapshotAt: new Date(0) });
    W.runs = [freshRun("new-1"), ...settledRuns("s", 401)];
    await syncStandardMirror({
      force: true, maxRuns: 1, resyncBefore: new Date(),
      runsSince: new Date("2026-01-01T00:00:00Z"), runsUntil: new Date("2099-01-01T00:00:00Z"),
    });
    expect(lastPromptQuery()).not.toHaveProperty("updated_from");
    expect(h.listMeasurementRuns).toHaveBeenCalledTimes(5);
    expect(h.recordRunFloor).not.toHaveBeenCalled();
    expect(h.replaceRun).toHaveBeenCalledTimes(1);
  });

  it("fullScan(전체 대조): 증분·조기 종료 없이 전량, 워터마크·floor 를 세운다", async () => {
    setWm({ promptsSyncedThrough: new Date("2026-09-28T03:00:00.000Z"), runsFloorRunIds: ["s0"], runsFloorSnapshotAt: new Date(0) });
    W.runs = settledRuns("s", 401);
    W.prompts = Array.from({ length: 12_446 }, (_, i) => ({ prompt_id: `p${i}`, updated: 0, v: 0 }));
    await syncStandardMirror({ fullScan: true, promptMaxPages: 1_000, runMaxPages: 1_000 });
    expect(lastPromptQuery()).not.toHaveProperty("updated_from");
    expect(h.listPrompts).toHaveBeenCalledTimes(125);
    expect(h.listMeasurementRuns).toHaveBeenCalledTimes(5);
    expect(h.recordRunFloor).toHaveBeenCalledTimes(1);
    expect(h.replaceRun).not.toHaveBeenCalled();
  });
});

describe("API 호출 수 — 루트 규모 모의(prompts 12,446 · runs 8,681)", () => {
  it("종전(표 미적용): 목록 100 왕복 + 둘 다 절단 / 증분 평시: 목록 4 왕복", async () => {
    const now = Date.now();
    W.prompts = Array.from({ length: 12_446 }, (_, i) => ({ prompt_id: `p${i}`, updated: now - 86400_000, v: 0 }));
    W.runs = [...Array.from({ length: 5 }, (_, i) => freshRun(`new-${i}`)), ...settledRuns("s", 8_676)];
    const restore = quiet();
    W.disabled = true;
    const before = await syncStandardMirror({});
    expect(h.listPrompts).toHaveBeenCalledTimes(PROMPT_MAX_PAGES);
    expect(h.listMeasurementRuns).toHaveBeenCalledTimes(MIRROR_RUN_MAX_PAGES);
    expect(before.pageCapHits.map((p) => p.kind).sort()).toEqual(["prompts", "runs"]);

    // 증분 평시 — 최근 30분 갱신 40개, floor = 지난 패스 최신 run 앵커
    for (const f of [h.listPrompts, h.listMeasurementRuns]) f.mockClear();
    W.disabled = false;
    for (let i = 0; i < 40; i++) W.prompts[i].updated = now - 5 * 60_000;
    W.mirror.clear();
    W.runs = [...Array.from({ length: 5 }, (_, i) => freshRun(`n2-${i}`)), ...settledRuns("s", 8_676)];
    setWm({ promptsSyncedThrough: new Date(now - 20 * 60_000), runsFloorRunIds: ["s0", "s1", "s2", "s3", "s4"], runsFloorSnapshotAt: new Date(0) });
    const after = await syncStandardMirror({});
    restore();
    expect(h.listPrompts).toHaveBeenCalledTimes(1);
    expect(h.listMeasurementRuns).toHaveBeenCalledTimes(3);
    expect(after.pageCapHits).toEqual([]);
    expect(after.runs).toBe(5);
  });
});
