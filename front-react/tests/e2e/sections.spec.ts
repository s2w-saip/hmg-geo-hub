import { test, expect } from "@playwright/test";
import { mockHub, type Reply } from "./hub-contract";
const hub = "http://127.0.0.1:3335";
const unavailable: Reply = { status: 503, body: { error: { code: "source_unavailable" } } };
function heldReply() {
  let release!: (reply: Reply) => void;
  const promise = new Promise<Reply>(resolve => { release = resolve; });
  return { promise, release };
}
function overview(url: URL): Reply | undefined {
  // No measured numbers: these responses exercise layout and loading contracts only.
  if (url.pathname.endsWith("/overview/cards")) return { body: { state: "ok", cards: [], compareTitle: null } };
  if (url.pathname.endsWith("/overview/card-trend")) return { body: { degraded: false, cards: {} } };
  if (url.pathname.endsWith("/overview/geo")) return { body: { geo: null, degraded: false } };
}
test("Overview displays its primary cards while the comparison section is still loading", async ({ page }) => {
  const held = heldReply();
  const trace = await mockHub(page, url => url.pathname.endsWith("/overview/brand-matrix") ? held.promise : overview(url));
  try {
    await page.goto(`${hub}/ko/renewal/dashboard`);
    await expect(page.getByLabel("KPI 5종", { exact: true })).toBeVisible();
    await expect(page.locator('[data-read-loading="matrix"]')).toBeVisible();
    held.release({ body: null });
    await expect(page.locator('[data-read-loading="matrix"]')).toHaveCount(0);
    expect(trace.errors).toEqual([]);
  } finally { held.release({ body: null }); }
});
test("Overview retries a failed comparison without reloading successful cards", async ({ page }) => {
  let failed = true, comparisons = 0;
  const trace = await mockHub(page, url => {
    if (url.pathname.endsWith("/overview/brand-matrix")) { comparisons++; return failed ? unavailable : { body: null }; }
    return overview(url);
  });
  await page.goto(`${hub}/ko/renewal/dashboard`);
  await expect(page.getByLabel("KPI 5종", { exact: true })).toBeVisible();
  const error = page.locator('[data-read-error="matrix"]');
  await expect(error).toBeVisible();
  const before = comparisons;
  const cards = trace.requests.filter(p => p.endsWith("/overview/cards")).length;
  failed = false;
  await error.getByRole("button").click();
  await expect(error).toHaveCount(0);
  expect(comparisons).toBe(before + 1);
  expect(trace.requests.filter(p => p.endsWith("/overview/cards")).length).toBe(cards);
  expect(trace.errors).toEqual([]);
});
test("a forbidden deferred section still denies the entire page", async ({ page }) => {
  await mockHub(page, url => url.pathname.endsWith("/overview/brand-matrix") ? { status: 403, body: { error: { code: "forbidden" } } } : overview(url));
  await page.goto(`${hub}/ko/renewal/dashboard`);
  await expect(page.getByText("접근 가능한 메뉴가 없습니다", { exact: true })).toBeVisible();
  await expect(page.getByLabel("KPI 5종", { exact: true })).toHaveCount(0);
});
test("Mention's empty result does not wait for unrelated section reads", async ({ page }) => {
  const held = heldReply();
  const trace = await mockHub(page, url => /\/mention\/rn-/.test(url.pathname) && !/rn-(page|asof|shell)$/.test(url.pathname) ? held.promise : undefined);
  try {
    await page.goto(`${hub}/ko/renewal/standard/answer-analysis/mention`);
    await expect(page.getByText("측정 데이터가 아직 없습니다", { exact: true })).toBeVisible();
    held.release(unavailable);
    await expect(page.getByRole("heading", { name: "데이터를 불러오지 못했습니다", exact: true })).toHaveCount(0);
    expect(trace.errors).toEqual([]);
  } finally { held.release(unavailable); }
});
test("Mention keeps its tabs and other sections available after a sentiment failure", async ({ page }) => {
  const held = heldReply();
  let failed = true;
  const trace = await mockHub(page, url => {
    if (url.pathname.endsWith("/rn-shell")) return { body: { measured: true, degraded: false, ownBrands: [], ownSum: [], drawer: [] } };
    if (url.pathname.endsWith("/rn-favor-dist")) return failed ? unavailable : { body: { segments: [], total: 0 } };
    if (/\/mention\/rn-/.test(url.pathname) && !/rn-(page|asof)$/.test(url.pathname)) return held.promise;
  });
  try {
    await page.goto(`${hub}/ko/renewal/standard/answer-analysis/mention`);
    await expect(page.getByRole("tab", { name: "당사 지표", exact: true })).toBeEnabled();
    const error = page.locator('[data-read-error="favorDist"]');
    await expect(error).toBeVisible();
    failed = false;
    await error.getByRole("button").click();
    await expect(error).toHaveCount(0);
    await page.getByRole("tab", { name: "경쟁 비교", exact: true }).click();
    await expect(page).toHaveURL(/tab=cmp/);
    expect(trace.errors).toEqual([]);
  } finally { held.release(unavailable); }
});
