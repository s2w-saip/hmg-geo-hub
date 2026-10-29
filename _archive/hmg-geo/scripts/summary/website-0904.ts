/**
 * summary_* 사실표 — 웹사이트 2026-09-04 회차 생성기 (1차 롤아웃).
 *
 *   npm run summary:website-0904                 # dry-run (읽기 전용, 기본값)
 *   npm run summary:website-0904 -- --yes        # 실제 INSERT + published 스왑
 *   npm run summary:website-0904 -- --yes --limit=3   # 앞 N개 프로젝트만
 *
 * 이 파일은 **회차 상수만 든 얇은 CLI** 다 — 표면 로직은 `surface-website.ts`, 표면 공통
 * 뼈대는 `lib/summary/generate/*` 코어. 다음 회차는 이 스크립트를 복제하지 말고
 * `npm run summary:generate -- --surface=website --cycle=<uuid>` 를 쓴다(PR① T9).
 */
process.env.DB_POOL_MAX ??= "4";

import { getDb } from "@/lib/db";
import { columnAvailable } from "@/lib/db/column-availability";
import { createRuntime, generatorVersion } from "@/lib/summary/generate/context";
import {
  cycleTotals,
  dryRun,
  generateProject,
  listProjects,
  loadCtx,
  type ProjectResult,
  type WebsiteCycleSpec,
} from "./surface-website";

// ── 회차 상수 (§8-1 + 2026-09-06 실측 정정) ─────────────────────────────────
const SPEC: WebsiteCycleSpec = {
  cycleAnchorAt: "2026-09-04T00:00:00Z",
  cycleWeek: "2026-08-31",
  // 멤버십 창 — 본 run(9/3 UTC) + 재시도(9/4~9/5 UTC). run 상태 술어 없음(부록 B5).
  window: { from: "2026-09-03T00:00:00Z", to: "2026-09-06T00:00:00Z" },
};

const argv = process.argv.slice(2);
const APPLY = argv.includes("--yes");
const LIMIT = (() => {
  const hit = argv.find((a) => a.startsWith("--limit="));
  return hit ? Number(hit.split("=")[1]) : 0;
})();
// `--project=<id>` 와 `--project <id>` 둘 다 받는다.
const ONLY_PROJECT = (() => {
  const eq = argv.find((a) => a.startsWith("--project="));
  if (eq) return eq.split("=")[1];
  const i = argv.indexOf("--project");
  return i >= 0 ? argv[i + 1] : undefined;
})();

async function main() {
  await columnAvailable("scope_citations", "url_norm"); // 0052 정규화 컬럼 사용 판정을 먼저 확정
  const rt = createRuntime({ db: getDb(), version: generatorVersion("website-0904-v1") });
  const ctx = await loadCtx(rt);
  rt.log(
    `명부 ${ctx.roster.length}개 · 선언 base prefix ${ctx.basePrefixes.length}개 · ` +
      `보고서 유닛 ${ctx.unitCount}개(프롬프트 ${[...ctx.unitsByProject.values()].reduce((a, b) => a + b.length, 0)}) · ${rt.version}`,
  );
  const projects = await listProjects(rt, SPEC, { limit: LIMIT, onlyProject: ONLY_PROJECT });
  rt.log(`대상 프로젝트 ${projects.length}개 · run ${projects.reduce((s, p) => s + p.runs.length, 0)}개`);

  if (!APPLY) {
    rt.log("── DRY-RUN (쓰기 없음). 실제 적재는 --yes ──");
    await dryRun(rt, ctx, SPEC, projects);
    return;
  }

  const results: ProjectResult[] = [];
  let i = 0;
  for (const p of projects) {
    i += 1;
    const r = await generateProject(rt, ctx, SPEC, p);
    results.push(r);
    if (i % 10 === 0 || !r.ok) rt.log(`${i}/${projects.length} ${r.pid} ok=${r.ok} ${r.reason ?? ""}`);
  }
  rt.log("표별 행수:", await cycleTotals(rt, SPEC));
  const failed = results.filter((r) => !r.ok);
  rt.log(`완료: ${results.length - failed.length}/${results.length}`, failed.length ? failed : "");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
