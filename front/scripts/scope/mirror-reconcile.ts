/**
 * 미러 **하루 1회 전체 대조** — 크론(`/api/cron/sync-mirror`)의 증분 읽기 안전망.
 *
 *   npm run mirror:reconcile -- [projectId] [--prompt-max-pages N] [--run-max-pages N]
 *
 * 크론은 프롬프트를 `updated_from` 워터마크 이후만, run 목록은 정착 경계(floor)까지만
 * 읽는다(lib/scope/mirror/sync.ts). 이 스크립트는 Vercel 300s 밖(러너 박스)에서 목록을
 * **전량** 읽어 ① 증분이 못 잡는 변경(수정 시각이 안 바뀐 프롬프트 · 재확인 창을 지난
 * run 의 상태 전이 · 크론이 놓친 run)을 회수하고 ② 두 워터마크를 새로 세운다.
 * 루트처럼 전량이 크론 페이지 상한(5,000)을 넘는 프로젝트의 **첫 워터마크**는 여기서만
 * 생긴다 — 0082 적용·배포 직후 한 번은 반드시 돌린다(프롬프트 워터마크는 크론의 이어 읽기로도
 * 몇 틱 안에 서지만, run floor 는 목록 전량을 한 번에 읽어야 선다).
 *
 * 쓰기 작업이다(미러 upsert·replaceRun·워터마크). 운영 절차: docs/mirror-incremental-sync.md.
 * 종료 코드: 0 완결 · 2 인자/환경 오류 · 3 미완결(절단·예산·오류·오버사이즈 — 출력 JSON 확인) · 1 예외.
 * 오버사이즈 run 이 있는 프로젝트는 3 이 영구다 — `incompleteOnlyOversized: true` 면 그 밖은 완결.
 */
import { MIRROR_RECONCILE_USAGE, parseMirrorReconcileOptions, reconcileVerdict } from "./mirror-reconcile-options";
import { localResyncReport } from "./local-resync-options";

async function main(): Promise<number> {
  if (process.argv.slice(2).includes("--help")) {
    console.log(MIRROR_RECONCILE_USAGE);
    return 0;
  }
  let options: ReturnType<typeof parseMirrorReconcileOptions>;
  try {
    options = parseMirrorReconcileOptions(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments");
    return 2;
  }
  // 값은 출력하지 않는다 — 키 존재만(secrets-handling).
  const required = ["DATABASE_URL", "SCOPE_API_BASE", "SCOPE_API_KEY", "SCOPE_ROOT_PROJECT_ID"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (process.env.SCOPE_MODE !== "live" || missing.length) {
    console.error(`Live configuration required: SCOPE_MODE=live; missing keys: ${missing.join(", ") || "none"}`);
    return 2;
  }
  const { syncStandardMirror, MIRROR_JOB_MAX_PAGES, mirrorJobCapacity } = await import(
    "@/lib/scope/mirror/sync"
  );
  console.error(
    `[mirror-reconcile] fullScan · promptMaxPages=${options.promptMaxPages} · ` +
      `runMaxPages=${options.runMaxPages} · MIRROR_JOB_MAX_PAGES=${MIRROR_JOB_MAX_PAGES} ` +
      `(jobs/run cap ${mirrorJobCapacity()}) · budgetMs=${options.budgetMs} · ` +
      `projects=${options.projectIds?.join(",") ?? "all"}`,
  );
  const startedAt = Date.now();
  const result = await syncStandardMirror(options);
  // 완결 판정은 로컬 회수 도구와 같은 규칙 — 절단·예산·오류가 하나라도 있으면 3.
  const report = localResyncReport(result, new Date(startedAt));
  // ⚠️ 이 스크립트는 오버사이즈 run 을 **큐에 넣지 않는다**(queueBulkRun 미배선 — 대량 경로는
  // hmg-mirror.service 의 discovery 소관). 루트처럼 오버사이즈 run(회차 8, 66,144 잡)이 목록에
  // 있는 프로젝트는 종료 코드가 **영구히 3** 이다. 재실행으로 풀리지 않으므로, 판정은
  // `incompleteOnlyOversized` 로 한다 — 참이면 오버사이즈 외에는 완결이다.
  const { incompleteOnlyOversized, pulledBelowFloor } = reconcileVerdict(result);
  console.log(
    JSON.stringify({
      mode: "reconcile",
      projectIds: options.projectIds,
      ...report,
      // 로컬 회수 도구 보고 형식을 재사용하지만 force 워터마크는 이 모드에 없다.
      resyncBefore: undefined,
      incompleteOnlyOversized,
      // 크론 floor 아래(증분이 안 보는 구간)였는데 이번 대조가 다시 당긴 run 수. 0 이 아니면
      // 그만큼 증분이 놓쳤다 — 반복되면 사각(문서) 가운데 어느 것인지 조사한다.
      pulledBelowFloor,
      perProject: result.perProject.map((p) => ({
        projectId: p.projectId,
        runs: p.runs,
        answers: p.answers,
        promptPages: p.promptPages,
        runPages: p.runPages,
        pulledBelowFloor: p.pulledBelowFloor,
        openRunsReleased: p.openRunsReleased,
        error: p.error,
      })),
      ms: Date.now() - startedAt,
    }),
  );
  return report.exitCode;
}

main().then((code) => process.exit(code)).catch((error: unknown) => {
  // SQL 파라미터·답변 본문을 덤프하지 않는다.
  console.error("Mirror reconcile failed", error instanceof Error ? error.name : "UnknownError");
  process.exit(1);
});
