// 웹사이트 사실표 두 느린 문장의 EXPLAIN — 실행되는 SQL 을 가로채 그대로 분석한다.
import { getDb } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { pickWebsiteCycles } from "@/lib/db/repositories/summary-cycles";
import { websiteExcludedUnits, summaryUnitFlagsAvailable } from "@/lib/db/repositories/summary-settings";
import {
  summaryWebsiteAggregates,
  summaryWebsiteSubKpis,
} from "@/lib/db/repositories/summary-website-aggregates";

const db = getDb();
const origExecute = db.execute.bind(db);
const captured: SQL[] = [];
(db as unknown as { execute: unknown }).execute = async (q: SQL) => {
  captured.push(q);
  return origExecute(q);
};

const rows = (await origExecute(sql`
  SELECT scope_project_id::text AS id FROM website_sites WHERE scope_project_id IS NOT NULL`)) as unknown as Array<{ id: string }>;
const ids = [...new Set(rows.map((r) => r.id))];
const pick = await pickWebsiteCycles(ids);
if (!pick) { console.log("cycles null"); process.exit(1); }
const scope = {
  cycles: pick.cycles,
  projectIds: pick.cycles.map((c) => c.projectId),
  filters: {},
  ownedBasePrefixes: [] as string[],
  unitFlags: await summaryUnitFlagsAvailable(),
  excludedUnits: await websiteExcludedUnits(),
};

const target = process.argv[2] ?? "aggregates";
captured.length = 0;
const t0 = Date.now();
try {
  if (target === "subkpis") await summaryWebsiteSubKpis(scope as never);
  else await summaryWebsiteAggregates(scope as never);
  console.log(`${target}: ${Date.now() - t0} ms · 캡처한 문장 ${captured.length}개`);
} catch (e) {
  console.log(`${target}: ${Date.now() - t0} ms FAIL(${(e as Error).message.slice(0, 60)}) · 캡처 ${captured.length}개`);
}

const dialect = new PgDialect();
const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: "require", idle_timeout: 5 });
await raw`SET statement_timeout = '900s'`;
for (const [i, q] of captured.entries()) {
  const { sql: text, params } = dialect.sqlToQuery(q);
  const head = text.replace(/\s+/g, " ").slice(0, 110);
  const t = Date.now();
  try {
    const plan = (await raw.unsafe(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${text}`, params as never[])) as unknown as Array<Record<string, string>>;
    const lines = plan.map((r) => Object.values(r)[0]);
    const ms = Number(/Execution Time: ([\d.]+)/.exec(lines.join("\n"))?.[1] ?? 0);
    console.log(`\n[${i}] ${ms.toFixed(0)}ms  ${head}…`);
    // 가장 비싼 노드 위주로 — actual time 이 큰 줄만
    if (ms > 5000) {
      console.log("--- 전체 플랜 ---");
      for (const l of lines) console.log("   " + l.slice(0, 190));
      console.log("--- SQL ---");
      console.log(text.replace(/\(\$\d+::uuid, \$\d+::uuid\), /g, "").slice(0, 2200));
    }
    console.log(`   ${lines.filter((l) => /Execution Time|Planning Time/.test(l)).join(" | ")}`);
  } catch (e) {
    console.log(`\n[${i}] EXPLAIN 실패 ${(e as Error).message.slice(0, 120)}  ${head}…`);
  }
  if (Date.now() - t > 300000) break;
}
await raw.end();
process.exit(0);
