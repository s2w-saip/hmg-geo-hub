/**
 * S4(웹사이트 대시보드) **한 렌더가 내는 모든 문장**의 EXPLAIN census — 쓰기 0 (PR② T5).
 *
 * `db.execute` 를 가로채 함수별로 문장을 모으고, 각각을 `EXPLAIN (ANALYZE, BUFFERS)` 로
 * 태워 ① 어느 표를 읽는가 ② **job 조인이 있는가**(수용 기준 ②) ③ 페이지 DB 합을 낸다.
 * 리더가 발행하는 SQL 을 그대로 잡으므로 "코드에 이렇게 써 있다" 가 아니라 실측이다.
 *
 * 사용:
 *   npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/explain-s4.ts [--fleet]
 *     기본  = 집계층에 접혀 있는 단일 회차(a3204f07)
 *     --fleet = 노출 가능한 웹사이트 회차 전부(함대 95) — 세부층 문장의 실제 비용
 *
 * ── 기간(회차 집합) 확장: 2026-09-18, W5.2 ────────────────────────────────
 *   --from=YYYY-MM-DD [--to=YYYY-MM-DD]  창 안의 노출 가능 회차 전부(함대 × 주)
 *   --week=YYYY-MM-DD                    그 주 하나만(= 1회차 대조군)
 *   --brand=Hyundai --country=KR         필터 조합(W5.3 의 (b)·(c))
 * 값은 안 바꾼다: `cycleScope` 의 회차 술어는 `mode` 가 아니라 **회차 목록**이
 * 정하므로, 목록을 창으로 넓히는 것이 곧 기간 모드의 문장이다.
 */
import { getDb } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { websiteExcludedUnits, summaryUnitFlagsAvailable } from "@/lib/db/repositories/summary-settings";
import { globalBaseUniverse } from "@/lib/summary/tenant/hmg";
import {
  summaryWebsiteDashboard, summaryWebsiteSubKpis, summaryWebsitePromptTopics,
  summaryWebsiteSourceComposition, summaryWebsiteCitationAccuracy,
} from "@/lib/db/repositories/summary-website-aggregates";

const db = getDb();
const orig = db.execute.bind(db);
let captured: Array<{ tag: string; q: SQL }> = [];
let tag = "";
(db as unknown as { execute: unknown }).execute = async (q: SQL) => { captured.push({ tag, q }); return orig(q); };

const CYCLE = "a3204f07-5747-4263-b9a2-f5ca3a3248db";
const FLEET = process.argv.includes("--fleet");
const argOf = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const FROM = argOf("from");
const TO = argOf("to");
const WEEK = argOf("week");
const BRAND = argOf("brand");
const COUNTRY = argOf("country");
const WINDOWED = Boolean(FROM || WEEK);
type R = { cycle_id: string; generation_id: string; project_id: string; cycle_anchor_at: string; cycle_week: string };
const rows = (await orig(sql`
  SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
         cycle_anchor_at::text, cycle_week::text
  FROM summary_cycles WHERE surface='website' AND active_generation_id IS NOT NULL
    AND view_anchor_at IS NOT NULL AND view_anchor_at <= now()
    ${WEEK ? sql`AND cycle_week = ${WEEK}::date` : sql``}
    ${FROM ? sql`AND cycle_anchor_at::date >= ${FROM}::date` : sql``}
    ${TO ? sql`AND cycle_anchor_at::date <= ${TO}::date` : sql``}
    ${FLEET || WINDOWED ? sql`` : sql`AND cycle_id = ${CYCLE}::uuid`}`)) as unknown as R[];
const cycles = rows.map((r) => ({ cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id, cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week }));
console.log(`회차 ${cycles.length} · 프로젝트 ${new Set(cycles.map((c) => c.projectId)).size}`
  + ` · 주 ${new Set(cycles.map((c) => c.cycleWeek)).size}`
  + (BRAND || COUNTRY ? ` · 필터 ${[BRAND, COUNTRY].filter(Boolean).join("/")}` : " · 무필터"));
// 웹사이트 표면의 브랜드 축은 상류(withWebsite)가 project_id 로 흡수하므로, 여기서는
// 국가(websiteCountry)만 술어로 들어간다. 브랜드는 프로젝트 목록을 좁히는 형태로 쓴다.
const filters = COUNTRY ? { websiteCountry: [COUNTRY] } : {};
const scope = {
  cycles, projectIds: [...new Set(cycles.map((c) => c.projectId))], filters,
  ownedBasePrefixes: globalBaseUniverse(),
  unitFlags: await summaryUnitFlagsAvailable(), excludedUnits: await websiteExcludedUnits(),
};

captured = [];
// ⚠️ **EXPLAIN census 의 사각** (2026-09-18 발견): 집계층 리더(`readTrendAggregates`)는
//    `budgetedMirrorDb(getDb(), …)` 로 감싼 핸들로 문장을 낸다. 이 스크립트가 가로채는
//    것은 `getDb().execute` 라서 **집계층 3문장(own·brands·domains)이 census 에 안 잡힌다**
//: `dashboard(카드+GEO)` 줄의 0.x ms 는 `ensureColumnAvailability` 한 문장이지 카드가
//    아니다. 그래서 각 함수의 **왕복 벽시계**를 따로 찍는다(아래 `ms`). 카드 경로의
//    문장별 EXPLAIN 이 필요하면 리더를 감싸지 않는 하네스를 따로 만들어야 한다.
const wall = new Map<string, number>();
for (const [name, fn] of [
  // 카드 + GEO 는 한 read 를 나눠 쓴다(server.ts 의 `cachedSummaryWebsiteDashboard`).
  ["dashboard(카드+GEO)", () => summaryWebsiteDashboard(scope as never)],
  ["promptTopics", () => summaryWebsitePromptTopics(scope as never)],
  ["sourceComposition", () => summaryWebsiteSourceComposition(scope as never)],
  ["citationAccuracy", () => summaryWebsiteCitationAccuracy(scope as never)],
  ["subKpis", () => summaryWebsiteSubKpis(scope as never)],
] as Array<[string, () => Promise<unknown>]>) {
  tag = name;
  const t0 = performance.now();
  const out = await fn();
  wall.set(name, performance.now() - t0);
  if (name === "dashboard(카드+GEO)") {
    const empty = (out as { empty?: boolean } | null)?.empty === true;
    console.log(`  · dashboard read ${empty ? "**empty**(폴백 신호)" : "값 있음"}`);
  }
}
console.log("\n왕복 벽시계(터널 RTT 포함 · 캐시 없음)");
for (const [k, v] of wall) console.log(`  ${k.padEnd(18)} ${v.toFixed(1)} ms`);

const dialect = new PgDialect();
const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: "require", idle_timeout: 5 });
const byTag = new Map<string, { n: number; ms: number }>();
for (const [i, { tag: t, q }] of captured.entries()) {
  const { sql: text, params } = dialect.sqlToQuery(q);
  const plan = (await raw.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, params as never[])) as unknown as Array<Record<string, string>>;
  const lines = plan.map((r) => Object.values(r)[0]).join("\n");
  const ms = Number(/Execution Time: ([\d.]+)/.exec(lines)?.[1] ?? 0);
  const table = /(?:on|FROM)\s+(summary_\w+)/.exec(text.replace(/\s+/g, " "))?.[1] ?? "?";
  const join = /JOIN[\s\S]{0,60}job_id/i.test(text) || /job_id IN \(/.test(text);
  const e = byTag.get(t) ?? { n: 0, ms: 0 };
  byTag.set(t, { n: e.n + 1, ms: e.ms + ms });
  console.log(`[${i}] ${t.padEnd(18)} ${ms.toFixed(2).padStart(9)} ms  ${table.padEnd(24)} job조인=${join ? "예" : "아니오"}`);
}
let total = 0, n = 0;
console.log("\n함수별 합");
for (const [t, v] of byTag) { console.log(`  ${t.padEnd(18)} 문장 ${v.n} · ${v.ms.toFixed(2)} ms`); total += v.ms; n += v.n; }
console.log(`\n=== S4 페이지 DB 합 ${total.toFixed(2)} ms · 문장 ${n}개 ===`);
process.exit(0);
