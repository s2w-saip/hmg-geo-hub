/**
 * summary_* 사실표 — 글로벌(루트 프로젝트) 2026-08-31 회차 생성기 (1차 롤아웃).
 *
 *   npm run summary:global-0831                        # dry-run (읽기 전용, 기본값)
 *   npm run summary:global-0831 -- --yes               # 실제 INSERT + published 스왑
 *   npm run summary:global-0831 -- --yes --allow-gap   # 분석 갭 5% 초과여도 적재
 *   npm run summary:global-0831 -- --yes --batch=20    # run 배치 크기(기본 20)
 *
 * 이 파일은 **회차 상수만 든 얇은 CLI** 다 — 표면 로직은 `surface-global.ts`, 표면 공통
 * 뼈대는 `lib/summary/generate/*` 코어. 다음 회차는 이 스크립트를 복제하지 말고
 * `npm run summary:generate -- --surface=global --cycle=<uuid>` 를 쓴다(PR① T9).
 */
process.env.DB_POOL_MAX ??= "3";

import { getDb } from "@/lib/db";
import { columnAvailable } from "@/lib/db/column-availability";
import { createRuntime, generatorVersion } from "@/lib/summary/generate/context";
import {
  ANALYSIS_GAP_MAX,
  dryRun,
  generate,
  listRuns,
  loadCtx,
  memCte,
  observe,
  type GlobalCycleSpec,
} from "./surface-global";
import { hiddenStandardRegions } from "@/lib/summary/tenant/hmg";

// ── 회차 상수 (§8-1) ────────────────────────────────────────────────────────
const SPEC: GlobalCycleSpec = {
  cycleAnchorAt: "2026-08-31T00:00:00Z",
  cycleAnchorDate: "2026-08-31",
  cycleWeek: "2026-08-31", // date_trunc('week', anchor AT TIME ZONE 'UTC')
  // 멤버십 창 — 회차 run 이 만든 답변의 measured_at 범위(§8-1, 실측 8 로 재현 확정).
  window: { from: "2026-08-30T00:00:00Z", to: "2026-09-02T00:00:00Z" },
};

const argv = process.argv.slice(2);
const APPLY = argv.includes("--yes");
const ALLOW_GAP = argv.includes("--allow-gap");
const RUN_BATCH = (() => {
  const hit = argv.find((a) => a.startsWith("--batch="));
  const v = hit ? Number(hit.split("=")[1]) : 20;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 20;
})();

async function main() {
  // 0052(url_norm/url_base_norm)·0046(is_korean)·0048(regions) 존재를 먼저 확정한다 —
  // 판정식이 컬럼 유무로 갈리므로 프로브가 끝난 뒤에 SQL 을 만들어야 한다.
  await Promise.all([
    columnAvailable("scope_citations", "url_norm"),
    columnAvailable("scope_prompts", "is_korean"),
    columnAvailable("scope_prompts", "regions"),
  ]);
  const rt = createRuntime({ db: getDb(), version: generatorVersion("global-0831-v1") });
  const ctx = await loadCtx(rt);
  rt.log(
    `명부 ${ctx.roster.length}개 · owned base universe ${ctx.basePrefixes.length}개 · ` +
      `숨김 국가 [${hiddenStandardRegions().join(",")}] · ${rt.version}`,
  );

  const runs = await listRuns(rt, SPEC);
  const runIds = runs.map((r) => r.run_id);
  const byStatus = runs.reduce<Record<string, number>>((acc, r) => {
    acc[r.status ?? "null"] = (acc[r.status ?? "null"] ?? 0) + 1;
    return acc;
  }, {});
  rt.log(
    `회차 run ${runIds.length}개 (${JSON.stringify(byStatus)}) · scope anchor 보유 ${runs.filter((r) => r.anchored).length}개`,
  );

  const obs = await observe(rt, memCte(SPEC));
  const gapAnswers = obs.answers_completed > 0 ? obs.gap_answers / obs.answers_completed : 0;
  const gapCells = obs.completed_units > 0 ? obs.gap_cells / obs.completed_units : 0;
  rt.log("회차 관측:", {
    answers_all: obs.answers_all,
    answers_completed: obs.answers_completed,
    expected_units: obs.expected_units,
    completed_units: obs.completed_units,
    prompts: obs.prompts,
    measured_from: obs.measured_from,
    measured_to: obs.measured_to,
  });
  rt.log(
    `분석 갭: 답변 ${obs.gap_answers}/${obs.answers_completed} = ${(gapAnswers * 100).toFixed(2)}% · ` +
      `셀 ${obs.gap_cells}/${obs.completed_units} = ${(gapCells * 100).toFixed(2)}% (임계 ${ANALYSIS_GAP_MAX * 100}%)`,
  );
  const gapOver = gapAnswers > ANALYSIS_GAP_MAX;
  if (gapOver) {
    console.warn(
      `⚠️  분석 갭 ${(gapAnswers * 100).toFixed(2)}% > ${ANALYSIS_GAP_MAX * 100}% — 미러 분석 미싱크 지문(§8-1).\n` +
        `    먼저 /api/cron/sync-mirror?force=1&projectIds=<root>&resyncBefore=<now> 로 재싱크할 것.\n` +
        `    그래도 적재하려면 --allow-gap 을 명시한다.`,
    );
  }

  if (!APPLY) {
    rt.log("── DRY-RUN (쓰기 없음). 실제 적재는 --yes ──");
    await dryRun(rt, ctx, SPEC, runIds);
    return;
  }
  if (gapOver && !ALLOW_GAP) {
    throw new Error(
      `분석 갭 ${(gapAnswers * 100).toFixed(2)}% 가 임계 ${ANALYSIS_GAP_MAX * 100}% 를 넘는다 — --allow-gap 없이는 적재하지 않는다(§2-1).`,
    );
  }
  const rc = await generate(rt, ctx, SPEC, runIds, obs, { runBatch: RUN_BATCH });
  rt.log("완료:", rc.counts);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
