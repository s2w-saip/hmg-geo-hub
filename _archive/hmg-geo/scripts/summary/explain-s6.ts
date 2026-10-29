/**
 * S6(웹사이트 인용 롤업)이 **실제로 내는 문장**의 EXPLAIN census — 쓰기 0 (PR② T7).
 *
 * 글로벌판(`explain-s3.ts`)의 웹사이트 대응. 함대(노출 가능한 회차 전부)를 기본으로 잰다.
 *   · **전(미러)**  `aggregateCitationsFromMirror`(projectIds = 함대)
 *   · **후(집계층)** `summaryWebsiteCitationsFromTrend`
 *
 * ⚠️ 웹사이트의 2단 조회는 **job 세미조인을 남긴다**(모수 게이트 `report_fs` 가
 *    `summary_answers` 에만 있다 — `summary-website-aggregates.ts` 머리 주석).
 *    그래서 수용 기준 ③(≤ 130 ms)의 판정이 글로벌과 다를 수 있고, 이 스크립트가
 *    그 실측을 낸다.
 *
 * 사용:
 *   bash (내부 작업 파일) <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/explain-s6.ts [--mirror]
 */
import { getDb } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { summaryWebsiteCitationsFromTrend } from "@/lib/db/repositories/summary-website-aggregates";
import { aggregateCitationsFromMirror } from "@/lib/db/repositories/scope-aggregates";
import { summaryUnitFlagsAvailable, websiteExcludedUnits } from "@/lib/db/repositories/summary-settings";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const MIRROR = process.argv.includes("--mirror");
const db = getDb();
const orig = db.execute.bind(db);
let captured: Array<{ tag: string; q: SQL }> = [];
let tag = "";
(db as unknown as { execute: unknown }).execute = async (q: SQL) => {
  captured.push({ tag, q });
  return orig(q);
};
/* eslint-disable no-console */
const log = console.log;

type R = {
  cycle_id: string; generation_id: string; project_id: string;
  cycle_anchor_at: string; cycle_week: string;
};
const rows = (await orig(sql`
  SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
         cycle_anchor_at::text, cycle_week::text
  FROM summary_cycles WHERE surface='website' AND active_generation_id IS NOT NULL
    AND view_anchor_at IS NOT NULL AND view_anchor_at <= now()`)) as unknown as R[];
if (!rows.length) throw new Error("노출 가능한 website 회차가 없다");
const cycles = rows.map((r) => ({
  cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id,
  cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week,
}));
const set: CycleSet = {
  surface: "website", mode: "snapshot", cycles,
  cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
  projectIds: [...new Set(cycles.map((c) => c.projectId))], missingProjectIds: [],
  weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
  anchorCount: new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10))).size,
};
log(`웹사이트 함대 — 회차 ${cycles.length} · 프로젝트 ${set.projectIds.length}`);

const scope = {
  set, cycles, projectIds: set.projectIds, filters: {},
  ownedBasePrefixes: globalBaseUniverse(),
  unitFlags: await summaryUnitFlagsAvailable(),
  excludedUnits: await websiteExcludedUnits(),
};

captured = [];
if (MIRROR) {
  tag = "미러:citations";
  await aggregateCitationsFromMirror({}, set.projectIds, globalBaseUniverse(), undefined, true);
}
tag = "집계층:citations";
const cit = await summaryWebsiteCitationsFromTrend(scope as never);
log(`집계층 read — ${cit.empty ? "EMPTY" : `도메인 ${cit.value.domains.length} · 카테고리 ${cit.value.categories?.length ?? 0} · 총 ${cit.value.summary.total}`}`);

const dialect = new PgDialect();
const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: "require", idle_timeout: 5 });
const byTag = new Map<string, { n: number; ms: number }>();
let enrichMs = 0;
for (const [i, { tag: t, q }] of captured.entries()) {
  const { sql: text, params } = dialect.sqlToQuery(q);
  const plan = (await raw.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, params as never[])) as unknown as Array<Record<string, string>>;
  const lines = plan.map((row) => Object.values(row)[0]).join("\n");
  const ms = Number(/Execution Time: ([\d.]+)/.exec(lines)?.[1] ?? 0);
  const one = text.replace(/\s+/g, " ");
  const table = /(?:FROM|on)\s+(scope_\w+|summary_\w+)/.exec(one)?.[1] ?? "?";
  const idx = [...new Set([...lines.matchAll(/Index (?:Only )?Scan using (\w+)/g)].map((m) => m[1]))];
  const twoStage = /group_key = ANY/.test(one);
  if (twoStage) enrichMs += ms;
  const e = byTag.get(t) ?? { n: 0, ms: 0 };
  byTag.set(t, { n: e.n + 1, ms: e.ms + ms });
  log(`[${i}] ${t.padEnd(20)} ${ms.toFixed(2).padStart(10)} ms  ${table.padEnd(26)}${twoStage ? " 2단" : "   "} idx=${idx.slice(0, 2).join(",") || "-"}`);
}
let mirrorMs = 0, mirrorN = 0, aggMs = 0, aggN = 0;
log("\n함수별 합");
for (const [t, v] of byTag) {
  log(`  ${t.padEnd(20)} 문장 ${v.n} · ${v.ms.toFixed(2)} ms`);
  if (t.startsWith("미러")) { mirrorMs += v.ms; mirrorN += v.n; } else { aggMs += v.ms; aggN += v.n; }
}
if (MIRROR) log(`\n=== S6 전(미러) DB 합 ${mirrorMs.toFixed(2)} ms · 문장 ${mirrorN}개 ===`);
log(`=== S6 후(집계층) DB 합 ${aggMs.toFixed(2)} ms · 문장 ${aggN}개 ===`);
log(`=== 2단 조회(세부층 group_key ANY) 합 ${enrichMs.toFixed(2)} ms — 수용 기준 ③ ≤ 130 ms: ${enrichMs <= 130 ? "PASS" : "FAIL"} ===`);
process.exit(0);
