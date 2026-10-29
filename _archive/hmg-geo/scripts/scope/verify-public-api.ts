/**
 * Live verification of scope's public API surface (scope-gateway spec).
 *
 * Runs HttpScopeClient directly against staging — it does NOT go through the
 * session/role enforcement layer (lib/scope/server.ts). The workspace key
 * already scopes to HMG; this proves the TRANSPORT contract (paths, auth, shapes)
 * works, which is the handoff goal. Reference: scope repo scripts/verify-public-api.ts.
 *
 * Run:  npm run verify:scope        (reads SCOPE_API_BASE + SCOPE_API_KEY from .env.local)
 *
 * Expectations (docs/scope-integration-handoff.md):
 *   - projects/prompts CRUD            → real 2xx
 *   - overview/scores/mentions/citations/usage → 200 (empty arrays OK; data not seeded)
 *   - reports                          → 404 for now (scope redeploy pending) = KNOWN, not a failure
 */
import { HttpScopeClient, ScopeHttpError } from "../../lib/scope/http";

const base = process.env.SCOPE_API_BASE;
const key = process.env.SCOPE_API_KEY;

if (!base || !key) {
  const missing = [!base && "SCOPE_API_BASE", !key && "SCOPE_API_KEY"]
    .filter(Boolean)
    .join(" + ");
  console.error(
    `✗ ${missing} not set in .env.local. The workspace key arrives via secure ` +
      "channel (scope_live_<token>); paste it as SCOPE_API_KEY and rerun.",
  );
  process.exit(2);
}

const client = new HttpScopeClient(base, key);

let passed = 0;
let failed = 0;
const known: string[] = [];

type Outcome = "pass" | "fail" | "known";

async function step(
  name: string,
  fn: () => Promise<unknown>,
  opts?: { knownFail?: (e: ScopeHttpError) => boolean; check?: (v: unknown) => string | null },
): Promise<{ outcome: Outcome; value?: unknown }> {
  try {
    const value = await fn();
    const problem = opts?.check?.(value) ?? null;
    if (problem) {
      failed++;
      console.error(`✗ ${name} — shape: ${problem}`);
      return { outcome: "fail", value };
    }
    passed++;
    console.log(`✓ ${name}`);
    return { outcome: "pass", value };
  } catch (e) {
    if (e instanceof ScopeHttpError && opts?.knownFail?.(e)) {
      known.push(`${name} (${e.status} ${e.code ?? ""})`);
      console.warn(`◐ ${name} — known pending: ${e.status} ${e.code ?? ""}`);
      return { outcome: "known" };
    }
    failed++;
    console.error(`✗ ${name} — ${e instanceof Error ? e.message : String(e)}`);
    return { outcome: "fail" };
  }
}

const isPaginated = (v: unknown): string | null =>
  v && typeof v === "object" && Array.isArray((v as { data?: unknown }).data)
    ? null
    : "expected { data: [] }";

async function main() {
  console.log(`\nscope public API verification → ${base}/api/v1\n`);

  // 0. health (unauthenticated readiness)
  await step("GET /health", () => client.health(), {
    check: (v) => ((v as { status?: string })?.status === "ok" ? null : "status != ok"),
  });

  // 1. create project (write → 2xx)
  const created = await step(
    "POST /projects",
    () =>
      client.createProject({
        name: `verify-${base!.length}-${passed}`,
        domain: "hyundai.com",
        tracked_brands: [{ brand_name: "현대" }, { brand_name: "기아" }],
        regions: ["KR", "US"],
      }),
    { check: (v) => ((v as { project_id?: string })?.project_id ? null : "no project_id") },
  );
  const projectId = (created.value as { project_id?: string } | undefined)?.project_id;

  if (!projectId) {
    console.error("\n✗ project creation failed — cannot exercise project-scoped reads.");
    summarize();
    return;
  }

  // 2. project reads + full project/prompt CRUD (C·R·U·D)
  await step("GET /projects", () => client.listProjects({ limit: 5 }), { check: isPaginated });
  await step("GET /projects/{id}", () => client.getProject(projectId));
  await step("PATCH /projects/{id}", () =>
    client.updateProject(projectId, { domain: "genesis.com" }),
  );

  const promptCreated = await step("POST /projects/{id}/prompts", () =>
    client.createPrompt(projectId, {
      text: "전기차 보조금 많이 주는 SUV 추천",
      funnel_stage: "consideration",
      keywords: ["전기차", "SUV"],
    }),
  );
  const promptId = (promptCreated.value as { prompt_id?: string } | undefined)?.prompt_id;

  await step("GET /projects/{id}/prompts", () => client.listPrompts(projectId), {
    check: isPaginated,
  });
  if (promptId) {
    await step("PATCH /projects/{id}/prompts/{pid}", () =>
      client.updatePrompt(projectId, promptId, { funnel_stage: "evaluation", enabled: false }),
    );
    await step("DELETE /projects/{id}/prompts/{pid}", () =>
      client.deletePrompt(projectId, promptId),
    );
  } else {
    failed++;
    console.error("✗ prompt update/delete — skipped: POST returned no prompt_id");
  }

  // 3. result reads (200, empty arrays acceptable)
  await step("GET /projects/{id}/overview", () => client.getOverview(projectId));
  await step("GET /projects/{id}/brand-scores", () => client.listBrandScores(projectId), {
    check: isPaginated,
  });
  await step("GET /projects/{id}/brand-mentions", () => client.listBrandMentions(projectId), {
    check: isPaginated,
  });
  await step("GET /projects/{id}/citations", () => client.listCitations(projectId), {
    check: isPaginated,
  });
  await step("GET /projects/{id}/citations/by-domain", () =>
    client.listCitationsByDomain(projectId),
  );

  // reports — KNOWN 404 until scope redeploys (not an HMG bug)
  await step("GET /projects/{id}/reports", () => client.listReports(projectId), {
    knownFail: (e) => e.status === 404,
    check: isPaginated,
  });

  // 4. workspace usage
  await step("GET /usage", () => client.getUsage());

  // 5. cleanup (soft-delete the verification project)
  await step("DELETE /projects/{id}", () => client.deleteProject(projectId));

  summarize();
}

function summarize() {
  console.log(`\n── summary ──`);
  console.log(`  pass:  ${passed}`);
  console.log(`  fail:  ${failed}`);
  if (known.length) console.log(`  known pending: ${known.join(", ")}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("unexpected:", e);
  process.exit(1);
});
