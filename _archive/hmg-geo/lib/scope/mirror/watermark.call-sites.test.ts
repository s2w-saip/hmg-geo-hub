/**
 * **워터마크가 실제 싱크 루프에 배선돼 있는지**를 실행으로 확인한다.
 *
 * ── 왜 이 파일이 따로 필요한가 ────────────────────────────────────────────
 * `shouldSkipResyncedRun` 자체는 `sync.test.ts` 가 돌연변이 4종으로 지킨다
 * (경계 `>=`→`>` · null 처리 · 워터마크 부재). 하지만 그 테스트들은 **순수
 * 함수를 직접 호출**하므로, `syncOneProject` 안에서 **그 함수를 부르는 줄을
 * 통째로 지우는** 돌연변이는 하나도 잡지 못한다 — 36개가 전부 통과한다.
 *
 * 그 배선은 2026-08-30 에 **프로덕션 실측으로만** 확인됐다(같은 `resyncBefore`
 * 로 두 패스: 루트 run 랭크 1~20 → 21~40 으로 분리 전진). 실측은 리팩터 때
 * 다시 돌지 않으므로, 여기서 **결과로** 같은 성질을 고정한다.
 *
 * 형식은 `lib/scope/paging.call-sites.test.ts` 의 자세를 따른다 — 스텁을 물려
 * 실제 호출부를 돌리고, **무엇을 당겼는지**를 단언한다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock 팩토리는 파일 최상단으로 호이스트되므로 일반 top-level 변수를 닫을 수
// 없다. vi.hoisted 로 함께 끌어올린다.
const h = vi.hoisted(() => ({
  listMeasurementRuns: vi.fn(),
  listRunJobs: vi.fn(),
  listPrompts: vi.fn(),
  replaceRun: vi.fn(),
  mirroredRunStates: vi.fn(),
}));
const { listMeasurementRuns, listRunJobs, listPrompts, replaceRun, mirroredRunStates } = h;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/scope", () => ({
  getScopeClient: () => ({
    listMeasurementRuns: h.listMeasurementRuns,
    listRunJobs: h.listRunJobs,
    listPrompts: h.listPrompts,
  }),
}));
vi.mock("@/lib/scope/result-adapter", () => ({
  getRootConfig: () => ({ projectId: "root", scopeApiKey: "k", baseUrl: "u" }),
}));
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { listAll: async () => [] },
}));
vi.mock("@/lib/db/repositories/website-sites", () => ({
  getWebsiteScopeProjectIds: async () => [],
}));
vi.mock("@/lib/db/repositories/prompts", () => ({
  promptRepository: { setStatusesByScopeIds: async () => 0 },
}));
vi.mock("@/lib/db/repositories/project-tracked-dictionary", () => ({
  getProjectTrackedDictionary: async () => null,
}));
vi.mock("@/lib/db/repositories/scope-mirror", () => ({
  scopeMirrorRepository: {
    mirroredRunStates: h.mirroredRunStates,
    replaceRun: h.replaceRun,
    upsertPrompts: async () => {},
    lastAttemptByProject: async () => new Map(),
    lastSyncedByProject: async () => new Map(),
    markAttempt: async () => {},
    recordSyncAttempt: async () => {},
    markSyncAttemptStarted: async () => {},
  },
}));

import { syncStandardMirror } from "./sync";

const T = new Date("2026-08-30T11:17:22Z");
/** 미러 run 목록은 newest-first 다 (2026-08-30 실측으로 확인된 scope 응답 순서). */
const RUNS = Array.from({ length: 6 }, (_, i) => ({
  measurement_run_id: `r${i}`,
  project_id: "root",
  status: "completed",
  started_at: "2026-01-01T00:00:00Z",
  completed_at: "2026-01-01T01:00:00Z",
}));

beforeEach(() => {
  vi.clearAllMocks();
  listPrompts.mockResolvedValue({ data: [], next_cursor: null });
  listMeasurementRuns.mockResolvedValue({ data: RUNS, next_cursor: null });
  listRunJobs.mockResolvedValue({ data: [], next_cursor: null });
  replaceRun.mockResolvedValue(undefined);
});

/** 이번 호출에서 실제로 job 을 당긴 run id 들 = 재싱크된 run. */
function pulledRunIds(): string[] {
  return listRunJobs.mock.calls.map((c) => String(c[1]));
}

describe("force 재싱크 워터마크가 싱크 루프에 배선돼 있다", () => {
  it("워터마크 없이는 매 패스가 같은 앞의 N 개를 다시 당긴다 (결함 재현)", async () => {
    mirroredRunStates.mockResolvedValue(new Map());

    await syncStandardMirror({ force: true, maxRuns: 2 });
    const first = pulledRunIds();
    listRunJobs.mockClear();
    await syncStandardMirror({ force: true, maxRuns: 2 });
    const second = pulledRunIds();

    expect(first).toEqual(["r0", "r1"]);
    // 진도 0 — 이것이 2026-08-30 프로덕션에서 관측된 멱등이다.
    expect(second).toEqual(first);
  });

  it("워터마크가 있으면 이미 재싱크된 run 을 건너뛰고 전진한다", async () => {
    // r0·r1 은 T 이후 이미 재싱크됨 → 건너뛰어야 한다.
    mirroredRunStates.mockResolvedValue(
      new Map([
        ["r0", state("2026-08-30T11:20:00Z")],
        ["r1", state("2026-08-30T11:20:00Z")],
      ]),
    );

    const res = await syncStandardMirror({
      force: true,
      maxRuns: 2,
      resyncBefore: T,
    });

    // 배선이 빠지면 여기서 r0·r1 이 나온다 — 그게 이 테스트가 잡는 돌연변이다.
    expect(pulledRunIds()).toEqual(["r2", "r3"]);
    expect(res.resyncSkipped).toBe(2);
  });

  it("건너뛴 run 은 maxRuns 예산을 소모하지 않는다 — 그래야 패스가 전진한다", async () => {
    mirroredRunStates.mockResolvedValue(
      new Map([
        ["r0", state("2026-08-30T11:20:00Z")],
        ["r1", state("2026-08-30T11:20:00Z")],
        ["r2", state("2026-08-30T11:20:00Z")],
      ]),
    );

    await syncStandardMirror({ force: true, maxRuns: 2, resyncBefore: T });

    // skip 이 N 을 먹으면 여기가 빈 배열이 되고 캠페인이 영영 안 끝난다.
    expect(pulledRunIds()).toEqual(["r3", "r4"]);
  });

  it("T 이전에 싱크된 run 은 재풀 대상이다", async () => {
    mirroredRunStates.mockResolvedValue(
      new Map([["r0", state("2026-07-01T00:00:00Z")]]),
    );

    await syncStandardMirror({ force: true, maxRuns: 1, resyncBefore: T });

    expect(pulledRunIds()).toEqual(["r0"]);
  });

  it("워터마크를 쓰면 force 여도 미러 상태를 반드시 읽는다", async () => {
    mirroredRunStates.mockResolvedValue(new Map());

    await syncStandardMirror({ force: true, maxRuns: 1, resyncBefore: T });

    // 안 읽으면 무엇을 이미 재싱크했는지 알 수 없어 워터마크가 무력해진다.
    expect(mirroredRunStates).toHaveBeenCalled();
  });
});

function state(syncedAtIso: string) {
  return {
    status: "completed",
    hasUnresolved: false,
    recheckable: false,
    syncedAt: new Date(syncedAtIso),
  };
}
