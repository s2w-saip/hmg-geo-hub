import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_URL, E2E_DIR, FRONT_URL, OUT_ROOT, RUN_DIR, TAP_URL, buildTraceSelect, loadScreens } from "./harness";

// Runs once before the projects: the stack must be up, the trace selection file is rebuilt from
// screens.json (next dev re-reads it per call, so edits apply without restarting the stack), the
// mock auth counters are reset and a run directory is created for captures and results.
export default async function globalSetup(): Promise<void> {
  const probes: Array<[string, string]> = [
    ["mock auth", `${AUTH_URL}/__e2e/health`],
    ["backend via tap", `${TAP_URL}/healthz`],
    ["next dev", `${FRONT_URL}/ko/login`],
  ];
  for (const [name, url] of probes) {
    let status = 0;
    try {
      status = (await fetch(url, { signal: AbortSignal.timeout(60_000) })).status;
    } catch {
      status = 0;
    }
    if (status !== 200) {
      throw new Error(`E2E stack is not up (${name} ${url} -> ${status || "no answer"}). Run: bash e2e/stack.sh up`);
    }
  }

  const doc = loadScreens();
  writeFileSync(join(RUN_DIR, "trace-select.json"), `${JSON.stringify(buildTraceSelect(doc), null, 2)}\n`);
  await fetch(`${AUTH_URL}/__e2e/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });

  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const runId = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  mkdirSync(join(OUT_ROOT, runId), { recursive: true });
  mkdirSync(join(RUN_DIR, "state"), { recursive: true, mode: 0o700 });
  process.env.E2E_RUN_ID = runId;
  writeFileSync(join(OUT_ROOT, "latest"), `${runId}\n`);
  console.log(`[e2e] run ${runId}: captures and results in ${join(E2E_DIR, ".out", runId)}`);
}
