import { describe, expect, it } from "vitest";
import type { MirrorSyncResult } from "@/lib/scope/mirror/sync";
import {
  parseMirrorReconcileOptions,
  reconcileVerdict,
  RECONCILE_DEFAULT_BUDGET_MS,
  RECONCILE_DEFAULT_MAX_PAGES,
} from "./mirror-reconcile-options";

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

describe("mirror:reconcile 인자", () => {
  it("기본값: fullScan · force 아님 · 상한 1,000페이지 · 6시간 · 전 프로젝트", () => {
    const o = parseMirrorReconcileOptions([], {});
    expect(o).toEqual({
      fullScan: true,
      promptMaxPages: RECONCILE_DEFAULT_MAX_PAGES,
      runMaxPages: RECONCILE_DEFAULT_MAX_PAGES,
      budgetMs: RECONCILE_DEFAULT_BUDGET_MS,
      projectBudgetMs: RECONCILE_DEFAULT_BUDGET_MS,
      projectIds: undefined,
    });
    // force 가 끼면 워터마크 판정이 꺼져 floor 를 못 세운다 — 절대 넣지 않는다.
    expect(o).not.toHaveProperty("force");
  });

  it("프로젝트 하나로 좁히고 상한을 덮어쓴다", () => {
    const o = parseMirrorReconcileOptions([ROOT, "--prompt-max-pages", "200", "--run-max-pages=150"], {
      MIRROR_LOCAL_BUDGET_MS: "60000",
    });
    expect(o).toMatchObject({
      projectIds: [ROOT],
      promptMaxPages: 200,
      runMaxPages: 150,
      budgetMs: 60_000,
      projectBudgetMs: 60_000,
    });
  });

  it("잘못된 입력은 거절한다(조용히 기본값으로 돌지 않는다)", () => {
    expect(() => parseMirrorReconcileOptions(["not-a-uuid"], {})).toThrow(/UUID/);
    expect(() => parseMirrorReconcileOptions([ROOT, ROOT], {})).toThrow();
    expect(() => parseMirrorReconcileOptions(["--force"], {})).toThrow(/Unknown/);
    expect(() => parseMirrorReconcileOptions(["--run-max-pages", "0"], {})).toThrow(/positive/);
    expect(() => parseMirrorReconcileOptions(["--run-max-pages"], {})).toThrow(/Missing/);
    expect(() =>
      parseMirrorReconcileOptions(["--run-max-pages", "2", "--run-max-pages", "3"], {}),
    ).toThrow(/duplicate/);
    expect(() => parseMirrorReconcileOptions([], { MIRROR_LOCAL_BUDGET_MS: "abc" })).toThrow();
  });
});

describe("reconcileVerdict — 루트는 오버사이즈 run 때문에 종료 코드 3 이 영구", () => {
  const base: MirrorSyncResult = {
    runs: 0, answers: 0, skipped: 0, resyncSkipped: 0, recheckCapHits: [], recheckDeferredHeavy: [],
    usedFallback: false, catalogUpdated: 0, deferred: 0, pageCapHits: [], oversizedRuns: [], truncatedRuns: [],
    budgetStoppedProjects: [], runLimitHits: [], projectIdsNotFound: [],
    perProject: [{ projectId: ROOT, pulledBelowFloor: 2 }, { projectId: "x", pulledBelowFloor: 1 }],
  };
  const big = [{ projectId: ROOT, runId: "r8", totalJobs: 66_144 }];
  it("오버사이즈뿐이면 incompleteOnlyOversized=true (재실행으로 안 풀린다)", () => {
    expect(reconcileVerdict({ ...base, oversizedRuns: big })).toEqual({ incompleteOnlyOversized: true, pulledBelowFloor: 3 });
  });
  it("다른 미완결이 섞이면 false, 완결이면 false", () => {
    expect(reconcileVerdict({ ...base, oversizedRuns: big, budgetStoppedProjects: [ROOT] }).incompleteOnlyOversized).toBe(false);
    expect(reconcileVerdict(base).incompleteOnlyOversized).toBe(false);
  });
});
