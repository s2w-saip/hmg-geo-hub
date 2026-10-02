/**
 * `mirror:reconcile` 인자 파싱 (순수 함수, 테스트 대상). 실행부는 mirror-reconcile.ts.
 *
 * 하루 1회 **전체 대조** — 크론의 증분 읽기가 구조적으로 못 잡는 변경을 회수하고
 * 증분 워터마크를 새로 세운다. 상세·운영 절차는 docs/mirror-incremental-sync.md.
 *
 * force 가 **아니다.** 목록은 전량 읽지만 run 워터마크(`shouldSkipMirroredRun`)는 그대로
 * 돌아서, 이미 정착한 run 은 다시 당기지 않는다 — 비용은 목록 왕복이 대부분이다.
 * 코어 재분석처럼 run status 가 안 바뀌는 변경까지 다시 당기려면 기존
 * `mirror:local-resync`(force + 기간 창)를 쓴다.
 */
import type { MirrorSyncResult } from "@/lib/scope/mirror/sync";
import { localResyncReport } from "./local-resync-options";

export const MIRROR_RECONCILE_USAGE =
  "mirror:reconcile [projectId] [--prompt-max-pages N] [--run-max-pages N]";

/** 전체 대조의 목록 페이지 상한 기본값 — 100건/페이지 × 1,000 = 10만. 루트(프롬프트 ~1.2만·run ~0.9만)의 약 8배. */
export const RECONCILE_DEFAULT_MAX_PAGES = 1_000;
/** 전체 대조의 기본 벽시계 예산 — 로컬 회수 도구(local-resync)와 같은 6시간. */
export const RECONCILE_DEFAULT_BUDGET_MS = 6 * 60 * 60 * 1000;

function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

export function parseMirrorReconcileOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const [key, inline] = value.split(/=(.*)/s);
    if (!["--prompt-max-pages", "--run-max-pages"].includes(key) || flags.has(key)) {
      throw new Error("Unknown or duplicate option");
    }
    const flagValue = inline ?? argv[++i];
    if (!flagValue || flagValue.startsWith("--")) throw new Error(`Missing value for ${key}`);
    flags.set(key, flagValue);
  }
  if (positional.length > 1) throw new Error(MIRROR_RECONCILE_USAGE);
  const [project] = positional;
  if (project && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(project)) {
    throw new Error("projectId must be a UUID");
  }
  const budgetMs = positiveInteger(
    env.MIRROR_LOCAL_BUDGET_MS ?? String(RECONCILE_DEFAULT_BUDGET_MS),
    "MIRROR_LOCAL_BUDGET_MS",
  );
  return {
    // ⚠️ force 를 넣지 않는다 — 넣으면 워터마크 판정이 꺼져 floor 를 못 세우고,
    // 전 run 을 다시 당겨 비용이 수십 배가 된다(파일 헤더).
    fullScan: true as const,
    promptMaxPages: positiveInteger(
      flags.get("--prompt-max-pages") ?? String(RECONCILE_DEFAULT_MAX_PAGES),
      "promptMaxPages",
    ),
    runMaxPages: positiveInteger(
      flags.get("--run-max-pages") ?? String(RECONCILE_DEFAULT_MAX_PAGES),
      "runMaxPages",
    ),
    budgetMs,
    // 한 프로젝트가 예산 전부를 쓸 수 있다 — 루트 한 곳의 목록만 수백 왕복이다.
    projectBudgetMs: budgetMs,
    projectIds: project ? [project] : undefined,
  };
}

/**
 * 전체 대조 결과 판정 (순수 함수, 테스트 대상).
 *
 * `incompleteOnlyOversized` — 미완결 사유가 **오버사이즈 run 뿐**인가. 이 스크립트는 오버사이즈
 * run 을 큐에 넣지 않으므로(대량 경로는 hmg-mirror.service discovery 소관) 그런 run 이 있는
 * 프로젝트는 종료 코드가 영구히 3 이다 — 재실행 대신 이 값으로 판정한다.
 * `pulledBelowFloor` — 크론 floor 아래에서 다시 당긴 run 수의 합(증분 누락 지표).
 */
export function reconcileVerdict(result: MirrorSyncResult): {
  incompleteOnlyOversized: boolean;
  pulledBelowFloor: number;
} {
  const epoch = new Date(0);
  const complete = localResyncReport(result, epoch).complete;
  const withoutOversized = localResyncReport({ ...result, oversizedRuns: [] }, epoch).complete;
  return {
    incompleteOnlyOversized: !complete && result.oversizedRuns.length > 0 && withoutOversized,
    pulledBelowFloor: result.perProject.reduce((n, p) => n + (p.pulledBelowFloor ?? 0), 0),
  };
}
