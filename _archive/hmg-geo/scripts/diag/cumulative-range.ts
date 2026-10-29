// 실측 — 기간을 걸었을 때 cumulative(기간 내 누적)가 "그 기간 회차들의 합" 이 되는가.
import { getDb } from "@/lib/db";
import { sql } from "drizzle-orm";
import {
  aggregateStandardFromMirror,
  websiteDeclaredOwnedBases,
} from "@/lib/db/repositories/scope-aggregates";
import type { StandardFilters } from "@/lib/scope/result-adapter";

const rows = (await getDb().execute(sql`
  SELECT scope_project_id::text AS id FROM website_sites WHERE scope_project_id IS NOT NULL`)) as unknown as Array<{ id: string }>;
const ids = [...new Set(rows.map((r) => r.id))];

async function run(label: string, f: StandardFilters) {
  const own = await websiteDeclaredOwnedBases(f, ids);
  const a = (await aggregateStandardFromMirror(f, ids, own.prefixes, own.universe, true)) as
    | Record<string, unknown>
    | null;
  console.log(
    `${label.padEnd(34)} asOf=${String(a?.asOf ?? "-").slice(0, 10)}  ` +
      `답변=${String(a?.totalAnswers ?? "-").padStart(6)}  언급=${String(a?.totalMentions ?? "-").padStart(7)}`,
  );
  return { answers: Number(a?.totalAnswers ?? 0), mentions: Number(a?.totalMentions ?? 0) };
}

const KR = { websiteCountry: ["KR"] };
console.log("── 스냅샷(현행) ─────────────────────────────");
await run("7일  08-31~09-06", { ...KR, dateFrom: "2026-08-31", dateTo: "2026-09-06" });
await run("30일 08-08~09-06", { ...KR, dateFrom: "2026-08-08", dateTo: "2026-09-06" });

console.log("── 누적(cumulative=true) ────────────────────");
const c1 = await run("7일  08-31~09-06", { ...KR, cumulative: true, dateFrom: "2026-08-31", dateTo: "2026-09-06" });
const c2 = await run("30일 08-08~09-06", { ...KR, cumulative: true, dateFrom: "2026-08-08", dateTo: "2026-09-06" });

console.log("── 회차 단건 누적(합 검산용) ─────────────────");
const parts = [] as Array<{ answers: number; mentions: number }>;
for (const [f0, t0] of [["2026-09-01", "2026-09-06"], ["2026-08-25", "2026-08-31"], ["2026-08-18", "2026-08-24"], ["2026-08-08", "2026-08-17"]] as const) {
  parts.push(await run(`회차창 ${f0}~${t0}`, { ...KR, cumulative: true, dateFrom: f0, dateTo: t0 }));
}
const sum = parts.reduce((a, p) => ({ answers: a.answers + p.answers, mentions: a.mentions + p.mentions }), { answers: 0, mentions: 0 });
console.log(`\n30일 누적       = 답변 ${c2.answers}  언급 ${c2.mentions}`);
console.log(`구간 4개 합계   = 답변 ${sum.answers}  언급 ${sum.mentions}`);
console.log(sum.answers === c2.answers && sum.mentions === c2.mentions
  ? "OK — 누적 = 기간 내 회차들의 합"
  : "차이 있음(경계 밖 회차 포함 여부 확인 필요)");
console.log(`7일 누적 vs 30일 누적: ${c1.mentions} vs ${c2.mentions} → ${c1.mentions === c2.mentions ? "동일(문제)" : "다름(정상)"}`);
process.exit(0);
