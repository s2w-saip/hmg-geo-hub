// Small helpers for stack.sh (kept out of the shell script: JSON parsing and comparisons).
//
//   node e2e/lib/stack-helper.mjs flags            print HGH_SOURCE_<group>=api lines from screens.json sourceFlags
//   node e2e/lib/stack-helper.mjs check-accounts   stdin "user_id|email|status" rows vs accounts.json (exit 1 on drift)
//   node e2e/lib/stack-helper.mjs select <out>     write the HGH_API_TRACE_SELECT file from screens.json values
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const E2E = fileURLToPath(new URL("..", import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(`${E2E}/${name}`, "utf8"));

const GROUPS = new Set(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "SESSION"]);

function flags() {
  const doc = readJson("screens.json");
  const list = Array.isArray(doc.sourceFlags) ? doc.sourceFlags : [];
  for (const g of list) {
    if (!GROUPS.has(g)) {
      console.error(`screens.json sourceFlags: unknown group ${g}`);
      process.exit(1);
    }
    console.log(`HGH_SOURCE_${g}=api`);
  }
}

function checkAccounts() {
  const rows = readFileSync(0, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, email, status] = l.split("|");
      return { id, email, status };
    });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const problems = [];
  for (const a of readJson("accounts.json").accounts) {
    const r = byId.get(a.id);
    if (!r) problems.push(`${a.key}: no app.user_account row`);
    else if (r.email !== a.email) problems.push(`${a.key}: email differs (db ${r.email})`);
    else if (r.status !== a.status) problems.push(`${a.key}: status differs (db ${r.status})`);
  }
  if (problems.length) {
    console.error(`accounts.json vs app.user_account drift:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`accounts ok (${rows.length} rows)`);
}

function select(out) {
  const doc = readJson("screens.json");
  const sel = {};
  for (const s of doc.screens) {
    for (const v of s.values ?? []) {
      const list = (sel[v.route] ??= []);
      if (!list.includes(v.jsonPath)) list.push(v.jsonPath);
    }
    for (const c of s.cases ?? []) {
      const r = c.resolve;
      if (r) {
        const list = (sel[r.route] ??= []);
        if (!list.includes(r.jsonPath)) list.push(r.jsonPath);
      }
    }
  }
  writeFileSync(out, `${JSON.stringify(sel, null, 2)}\n`);
  console.log(`trace select: ${Object.keys(sel).length} routes`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "flags") flags();
else if (cmd === "check-accounts") checkAccounts();
else if (cmd === "select" && arg) select(arg);
else {
  console.error("usage: flags | check-accounts | select <out>");
  process.exit(2);
}
