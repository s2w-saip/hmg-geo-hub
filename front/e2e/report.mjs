// Summary of one E2E run: node e2e/report.mjs [runId]   (default: the latest run)
// Reads e2e/.out/<run>/results.jsonl; prints one row per case and the failed checks.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("./.out/", import.meta.url));
const runId = process.argv[2] || (existsSync(`${OUT}latest`) ? readFileSync(`${OUT}latest`, "utf8").trim() : "");
if (!runId || !existsSync(`${OUT}${runId}/results.jsonl`)) {
  console.error("no results (run the screens first)");
  process.exit(2);
}
const rows = readFileSync(`${OUT}${runId}/results.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

console.log(`run ${runId}: ${rows.length} cases, ${rows.filter((r) => r.checks.every((c) => c.ok)).length} passed\n`);
console.log("| screen | case | result | final | doc | server API calls (status ms) | in flight (peak) | first render calls | console allowed | legacy leaf |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const ok = r.checks.every((c) => c.ok);
  const apis = (r.apis ?? []).map((a) => `${a.api} ${a.status} ${a.ms}`).join("; ");
  const allowed = (r.extra?.console?.allowed ?? []).map((a) => a.id).join(",");
  console.log(
    `| ${r.screen} | ${r.case} | ${ok ? "pass" : "FAIL"} | ${r.finalUrl ?? ""} | ${r.docStatus ?? ""} | ${apis} | ${r.extra?.backendPeak ?? ""} | ${r.extra?.firstRenderServerCalls ?? ""} | ${allowed} | ${r.extra?.legacyLeaf ?? ""} |`,
  );
}
const failed = rows.filter((r) => !r.checks.every((c) => c.ok));
if (failed.length) {
  console.log("\nfailed checks:");
  for (const r of failed) for (const c of r.checks.filter((x) => !x.ok)) console.log(`- ${r.screen} ${r.case}: ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
}
