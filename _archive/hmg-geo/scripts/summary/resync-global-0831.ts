// 글로벌 8/31 회차 run 재싱크 — v4.1 §8-1 전제(분석 갭 21.5% → ≤5%). 미러 replaceRun 은 run 단위
// delete+insert 라 멱등이다. 실행: bash (내부 작업 파일) <워크트리> npx tsx --env-file=.env.local --tsconfig scripts/summary/tsconfig.json scripts/summary/resync-global-0831.ts [--probe N | --yes]
// (DATABASE_URL 은 래퍼가 postgres 롤로 덮고, SCOPE_API_* 는 .env.local 에서 온다.)
import { syncStandardMirror } from "@/lib/scope/mirror/sync";
import { getDb } from "@/lib/db";
import { sql } from "drizzle-orm";

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
const args = process.argv.slice(2);
const probeIx = args.indexOf("--probe");
const maxRuns = probeIx >= 0 ? Number(args[probeIx + 1] ?? "3") : undefined;
const yes = args.includes("--yes");
if (!yes && maxRuns === undefined) { console.error("usage: --probe N | --yes"); process.exit(1); }

async function gap() {
  const rows = (await getDb().execute(sql`
    with cyc as (select a.job_id from scope_answers a join scope_runs r using(run_id)
      where a.status='completed' and r.project_id=${ROOT}::uuid and a.measured_at >= '2026-08-30' and a.measured_at < '2026-09-02')
    select count(*)::int answers,
      count(*) filter (where not exists (select 1 from scope_mentions m where m.job_id=cyc.job_id)
                         and not exists (select 1 from scope_citations c where c.job_id=cyc.job_id))::int gap
    from cyc`)) as unknown as Array<{ answers: number; gap: number }>;
  return rows[0];
}

const before = await gap();
console.log(`before: answers ${before.answers} gap ${before.gap} (${((100 * before.gap) / before.answers).toFixed(2)}%)`);
const t0 = Date.now();
const result = await syncStandardMirror({
  force: true,
  projectIds: [ROOT],
  runsSince: new Date("2026-08-30T00:00:00Z"),
  runsUntil: new Date("2026-09-02T00:00:00Z"),
  resyncBefore: new Date(),
  maxRuns,
});
console.log(`sync: ${JSON.stringify({ ...(result as object), ms: Date.now() - t0 })}`.slice(0, 600));
const after = await gap();
console.log(`after : answers ${after.answers} gap ${after.gap} (${((100 * after.gap) / after.answers).toFixed(2)}%)`);
process.exit(0);
