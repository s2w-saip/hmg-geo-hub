import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { loginViaForm, settle } from "../flows";
import { E2E_DIR, readMessage } from "../harness";

// E7 acceptance (design 8절 E7 row): list first response p50 <= 1 s on the default window, and the
// flow edit -> lint -> preview -> apply -> rollback through the real screens. Config and usage:
// e2e/ecat/playwright.ecat.config.ts. Results go to e2e/.out/ecat/*.json (git-ignored).
//
// Env: ECAT_BASE_URL, ECAT_ADMIN_EMAIL, ECAT_ADMIN_PASSWORD (required), ECAT_LOCALE (ko),
// ECAT_SAMPLES (list requests, default 7), ECAT_WRITE=1 (flow only), ECAT_PROBE_SURFACE (the
// surface the flow blocks globally; default a nonsense token that matches no answer, so the
// applies touch no KPI), ECAT_WAIT_MIN (minutes to wait for each preview / apply, default 15).

const LOCALE = process.env.ECAT_LOCALE || "ko";
const BASE = `/${LOCALE}/admin/standards/entities`;
const OUT = join(E2E_DIR, ".out", "ecat");
const WAIT_MS = Number(process.env.ECAT_WAIT_MIN || 15) * 60_000;
const msg = (k: string) => readMessage(`adminEcat.${k}`, LOCALE);

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function save(name: string, doc: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), JSON.stringify(doc, null, 2));
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};

async function login(page: Page) {
  await loginViaForm(page, need("ECAT_ADMIN_EMAIL"), need("ECAT_ADMIN_PASSWORD"), LOCALE);
  expect(new URL(page.url()).pathname).not.toBe(`/${LOCALE}/login`);
}

test("list p50: first response of the entity list page", async ({ page }) => {
  need("ECAT_BASE_URL");
  await login(page);
  const n = Math.max(3, Number(process.env.ECAT_SAMPLES || 7));
  const samples: { ms: number; status: number; bytes: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await page.request.get(BASE, { headers: { "cache-control": "no-cache" } });
    const body = await r.body();
    samples.push({ ms: Math.round(performance.now() - t0), status: r.status(), bytes: body.length });
  }
  // browser view of the same page: navigation timing of one real load
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByTestId("ecat-entity-list").waitFor({ timeout: 60_000 });
  const nav = await page.evaluate(() => {
    const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return e ? { ttfb: Math.round(e.responseStart - e.requestStart), domContentLoaded: Math.round(e.domContentLoadedEventEnd - e.startTime) } : null;
  });
  const warm = samples.slice(1).map((s) => s.ms);
  const result = {
    at: new Date().toISOString(),
    target: BASE,
    cold_ms: samples[0].ms,
    p50_ms: pct(warm, 50),
    p95_ms: pct(warm, 95),
    samples,
    browser: nav,
    criterion: "p50 <= 1000 ms (warm samples, full HTML response)",
  };
  save(`list-p50-${Date.now()}.json`, result);
  console.log(`[ecat] list p50=${result.p50_ms}ms p95=${result.p95_ms}ms cold=${result.cold_ms}ms n=${warm.length}`);
  expect(samples.every((s) => s.status === 200)).toBe(true);
  expect(result.p50_ms).toBeLessThanOrEqual(1000);
});

async function waitStatus(page: Page, status: string) {
  await page.locator(`[data-testid="ecat-apply-detail"][data-status="${status}"]`).waitFor({ timeout: WAIT_MS });
}

async function applyIdOf(page: Page): Promise<number> {
  await page.waitForURL(/\/applies\/\d+$/, { timeout: 60_000 });
  return Number(new URL(page.url()).pathname.split("/").pop());
}

async function approve(page: Page) {
  await page.getByTestId("ecat-apply-approve").click();
  await page.getByTestId("ecat-apply-step-reason").fill("e7 e2e");
  await page.getByTestId("ecat-apply-step-confirm").click();
}

test("flow: edit -> lint -> preview -> apply -> rollback", async ({ page }) => {
  need("ECAT_BASE_URL");
  test.skip(process.env.ECAT_WRITE !== "1", "writes the target: set ECAT_WRITE=1");
  const probe = process.env.ECAT_PROBE_SURFACE || `zzecatprobe${Date.now().toString(36)}`;
  const t: Record<string, number> = {};
  const mark = (k: string, t0: number) => (t[k] = Math.round(performance.now() - t0));
  await login(page);

  // 1. list + a fresh draft (never reuse someone's open draft)
  let t0 = performance.now();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByTestId("ecat-entity-list").waitFor({ timeout: 60_000 });
  mark("list", t0);
  const create = page.getByTestId("ecat-draft-create");
  if (!(await create.isVisible())) throw new Error("a draft is already open on the target: finish or discard it first");
  await create.click();
  await page.locator("#ecat-draft-title").fill(`E7 e2e ${new Date().toISOString().slice(0, 16)}`);
  await page.getByTestId("ecat-draft-create-confirm").click();
  await expect(page.getByTestId("ecat-draft-bar")).toContainText(msg("draftBar.open"));

  // 2. edit: block the probe surface globally
  t0 = performance.now();
  await page.goto(`${BASE}/draft`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("ecat-global-surface").fill(probe);
  await page.getByTestId("ecat-global-submit").click();
  await expect(page.getByTestId("ecat-diff")).toContainText(probe);
  mark("edit", t0);

  // 3. lint (+ confirm the ordinary L2 warnings if any; escalated ones stop the run)
  t0 = performance.now();
  await page.getByTestId("ecat-lint-run").click();
  await expect(page.getByTestId("ecat-lint")).not.toContainText(msg("lint.never"));
  await settle(page, 3_000);
  if (await page.getByTestId("ecat-lint-ack-all").isVisible()) {
    await page.getByTestId("ecat-lint-ack-all").click();
    const saveAcks = page.getByTestId("ecat-lint-ack-save");
    if (await saveAcks.isEnabled()) await saveAcks.click();
    await settle(page, 3_000);
  }
  mark("lint", t0);

  // 4. apply request: unexposed rounds only
  await page.getByTestId("ecat-scope-unexposed").check();
  await page.getByTestId("ecat-apply-reason").fill("E7 e2e probe (global block of a nonsense surface)");
  await expect(page.getByTestId("ecat-apply-submit")).toBeEnabled();
  t0 = performance.now();
  await page.getByTestId("ecat-apply-submit").click();
  const applyId = await applyIdOf(page);

  // 5. preview (the page polls) -> approve -> applied
  await waitStatus(page, "previewed");
  mark("preview", t0);
  await expect(page.getByTestId("ecat-preview")).toBeVisible();
  await expect(page.getByTestId("ecat-preview-unexposed")).toBeVisible();
  t0 = performance.now();
  await approve(page);
  await waitStatus(page, "applied");
  mark("apply", t0);

  // 6. rollback -> its own preview -> approve -> applied
  t0 = performance.now();
  await page.getByTestId("ecat-apply-rollback").click();
  await page.getByTestId("ecat-apply-step-reason").fill("E7 e2e rollback");
  await page.getByTestId("ecat-apply-step-confirm").click();
  await page.waitForURL((u) => /\/applies\/\d+$/.test(u.pathname) && !u.pathname.endsWith(`/${applyId}`), { timeout: 60_000 });
  const rollbackId = Number(new URL(page.url()).pathname.split("/").pop());
  await waitStatus(page, "previewed");
  await approve(page);
  await waitStatus(page, "applied");
  mark("rollback", t0);

  // 7. the versions page lists both applies
  await page.goto(`${BASE}/versions`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("ecat-applies")).toContainText(`#${applyId}`);
  await expect(page.getByTestId("ecat-applies")).toContainText(`#${rollbackId}`);

  save(`flow-${Date.now()}.json`, { at: new Date().toISOString(), applyId, rollbackId, probeLength: probe.length, ms: t });
  console.log(`[ecat] flow ok apply=${applyId} rollback=${rollbackId} ms=${JSON.stringify(t)}`);
});
