// Diagnostic: run the standard-dashboard result adapter against LIVE scope and
// print the aggregates + the dashboard view-model it produces. Bypasses the
// session/enforcement layer (like verify:scope) — drives HttpScopeClient off
// .env.local directly.
//   npx tsx --env-file=.env.local scripts/scope/peek-standard.ts
import { HttpScopeClient } from "../../lib/scope/http";
import { aggregateStandard, getRootConfig } from "../../lib/scope/result-adapter";

const base = process.env.SCOPE_API_BASE;
const key = process.env.SCOPE_API_KEY;
const root = getRootConfig();
if (!base || !key || !root) {
  throw new Error("need SCOPE_API_BASE, SCOPE_API_KEY, SCOPE_ROOT_PROJECT_ID");
}

const client = new HttpScopeClient(base, key);
const agg = await aggregateStandard(client, root);
if (!agg) {
  console.log("no data (null)");
  process.exit(0);
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
console.log(`root=${agg.rootProjectId}`);
console.log(`answers=${agg.totalAnswers} mentions=${agg.totalMentions}`);
console.log(`visibility=${pct(agg.trackedAnswerCount, agg.totalAnswers)}%  (tracked answers ${agg.trackedAnswerCount}/${agg.totalAnswers})`);
const trackedMentions = agg.brands.filter((b) => b.isTracked).reduce((s, b) => s + b.mentionCount, 0);
console.log(`shareOfVoice=${pct(trackedMentions, agg.totalMentions)}%`);
console.log("\n-- brand rankings (coverage) --");
for (const b of [...agg.brands].sort((a, c) => c.answerCount - a.answerCount).slice(0, 10)) {
  console.log(`  ${b.isTracked ? "★" : " "} ${b.name.padEnd(16)} coverage ${pct(b.answerCount, agg.totalAnswers)}%  mentions ${b.mentionCount}`);
}
console.log("\n-- geo (per region) --");
for (const r of agg.regions) {
  console.log(`  ${r.region}: visibility ${pct(r.trackedAnswerCount, r.answerCount)}%  n=${r.answerCount}`);
}
console.log("\n-- citations --");
console.log(`  sampled=${agg.citations.sampledAnswers} withCitation=${agg.citations.answersWithCitation} total=${agg.citations.totalCitations} owned=${agg.citations.ownedCitations} (ownedShare ${pct(agg.citations.ownedCitations, agg.citations.totalCitations)}%)`);
for (const d of agg.citations.domains.slice(0, 8)) {
  console.log(`  ${d.isOurs ? "★" : " "} ${d.host.padEnd(28)} coverage ${pct(d.citingAnswers, agg.citations.sampledAnswers)}%`);
}
