/**
 * S3(글로벌 인용 롤업 + 출처 도넛)이 **실제로 내는 문장**의 EXPLAIN census — 쓰기 0 (PR② T7).
 *
 * 두 경로를 같은 터널·같은 회차에서 나란히 잰다:
 *   · **전(미러)**  `aggregateCitationsFromMirror` + `aggregateSourceCompositionFromMirror`
 *   · **후(집계층)** `summaryGlobalCitationsFromTrend` + `summaryGlobalSourceCompositionFromTrend`
 *
 * 함께 확인하는 것(수용 기준):
 *   ② 2단 조회 문장이 `group_key = ANY(...)` 로 `summary_domain_key_idx` 를 타는가
 *   ③ 2단(세부층) 문장 합이 130 ms 이하인가
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/explain-s3.ts [--mirror]
 *   (`--mirror` 없이는 집계층만 잰다 — 미러 baseline 은 28 s 라 매번 돌릴 것이 아니다.)
 */
import { getDb } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  summaryGlobalCitationsFromTrend,
  summaryGlobalSourceComposition,
  summaryGlobalSourceCompositionFromTrend,
} from "@/lib/db/repositories/summary-global-aggregates";
import {
  aggregateCitationsFromMirror,
  aggregateSourceCompositionFromMirror,
} from "@/lib/db/repositories/scope-aggregates";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import type { TrendReadScope } from "@/lib/db/repositories/summary-trend-aggregates";

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
  FROM summary_cycles WHERE surface='global' AND active_generation_id IS NOT NULL
  ORDER BY cycle_anchor_at DESC LIMIT 1`)) as unknown as R[];
if (!rows.length) throw new Error("활성 generation 이 있는 global 회차가 없다");
const r = rows[0];
const set: CycleSet = {
  surface: "global", mode: "snapshot",
  cycles: [{
    cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week,
  }],
  cycleKey: `${r.cycle_id}:${r.generation_id}`,
  projectIds: [r.project_id], missingProjectIds: [],
  weeks: [r.cycle_week], anchorCount: 1,
};
log(`글로벌 회차 ${r.cycle_id.slice(0, 8)} · anchor ${r.cycle_anchor_at.slice(0, 10)}`);

const scope: TrendReadScope = {
  set, filters: {}, ownVariant: OWN_VARIANT_ALL, ownedBasePrefixes: globalBaseUniverse(),
};

captured = [];
if (MIRROR) {
  tag = "미러:citations"; await aggregateCitationsFromMirror({}, undefined, globalBaseUniverse());
  tag = "미러:sourceComp"; await aggregateSourceCompositionFromMirror({}, undefined, globalBaseUniverse());
  // 출처 도넛의 **전** 은 미러가 아니라 세부층이었다(`viaGlobalSummary` → S3.citation).
  tag = "세부층:sourceComp"; await summaryGlobalSourceComposition({
    cycle: set.cycles[0], rootProjectId: set.projectIds[0], filters: {},
    ownedBasePrefixes: globalBaseUniverse(),
  } as never);
}
tag = "집계층:citations"; const cit = await summaryGlobalCitationsFromTrend(scope);
tag = "집계층:sourceComp"; const src = await summaryGlobalSourceCompositionFromTrend(scope);
log(`집계층 read — citations ${cit.empty ? "EMPTY" : `도메인 ${cit.value.domains.length} · 카테고리 ${cit.value.categories?.length ?? 0} · 총 ${cit.value.summary.total}`}`);
log(`집계층 read — sourceComp ${src.empty ? "EMPTY" : `${src.value.length}행`}`);

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
  log(`[${i}] ${t.padEnd(20)} ${ms.toFixed(2).padStart(10)} ms  ${table.padEnd(26)}${twoStage ? " 2단" : "   "} idx=${idx.join(",") || "-"}`);
}
let mirrorMs = 0, mirrorN = 0, aggMs = 0, aggN = 0;
log("\n함수별 합");
for (const [t, v] of byTag) {
  log(`  ${t.padEnd(20)} 문장 ${v.n} · ${v.ms.toFixed(2)} ms`);
  if (t.startsWith("미러") || t.startsWith("세부층")) { mirrorMs += v.ms; mirrorN += v.n; } else { aggMs += v.ms; aggN += v.n; }
}
if (MIRROR) log(`\n=== S3 전(미러) DB 합 ${mirrorMs.toFixed(2)} ms · 문장 ${mirrorN}개 ===`);
log(`=== S3 후(집계층) DB 합 ${aggMs.toFixed(2)} ms · 문장 ${aggN}개 ===`);
log(`=== 2단 조회(세부층 group_key ANY) 합 ${enrichMs.toFixed(2)} ms — 수용 기준 ③ ≤ 130 ms: ${enrichMs <= 130 ? "PASS" : "FAIL"} ===`);
process.exit(0);
