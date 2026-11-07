import { test, expect } from "@playwright/test";
import { mockHub, week } from "./hub-contract";
const hub = "http://127.0.0.1:3335";

test("background refresh preserves an unsaved account form even when server data changes", async ({ page }) => {
  let reads = 0;
  const trace = await mockHub(page, url => url.pathname === "/api/hub/accounts" ? { body: { data: { items: [], roles: ++reads > 2 ? ["region", "hq", "country"] : ["hq", "region", "country"] } } } : undefined);
  await page.goto(`${hub}/ko/renewal/admin`);
  await page.getByRole("button", { name: "새 계정", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const login = dialog.getByRole("textbox").first();
  await login.fill("unsaved-login");
  const before = reads;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(login).toHaveValue("unsaved-login");
  expect(trace.errors).toEqual([]);
});
test("saved-filter failures leave successful analytics and the local retry visible", async ({ page }) => {
  const trace = await mockHub(page, url => url.pathname === "/api/hub/saved-filters" ? { status: 503, body: { error: { code: "source_unavailable" } } } : undefined);
  await page.goto(`${hub}/ko/renewal/dashboard`);
  await expect(page.getByRole("heading", { name: "AI 답변 성과 요약", exact: true })).toBeVisible();
  await expect(page.getByText("측정 데이터가 아직 없습니다", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "데이터를 불러오지 못했습니다" })).toHaveCount(0);
  const retry = page.getByRole("button", { name: "다시 시도", exact: true });
  await expect(retry).toBeVisible();
  const before = trace.requests.filter(p => p === "/api/hub/saved-filters").length;
  await retry.click();
  await expect.poll(() => trace.requests.filter(p => p === "/api/hub/saved-filters").length).toBeGreaterThan(before);
  expect(trace.errors).toEqual([]);
  expect(trace.unhandled).toEqual([]);
});
test("Global prompts shows the service week and synchronizes a newly published week", async ({ page }) => {
  let latest = week;
  const trace = await mockHub(page, url => url.pathname.endsWith("/service-week") ? { body: latest } : undefined);
  await page.goto(`${hub}/ko/renewal/standard/prompts`);
  await expect(page.getByRole("heading", { name: "글로벌 프롬프트", exact: true })).toBeVisible();
  await expect(page.locator("[data-rn-service-week]")).toContainText("11월 1주차");
  await expect.poll(() => trace.requests.filter(p => p === "/api/service-week").length).toBeGreaterThan(0);
  const search = page.getByRole("textbox").first();
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/api/standard/prompts/page") && r.url().includes("week-filter")),
    search.fill("week-filter"),
  ]);
  await expect(page).toHaveURL(/q=week-filter/);
  // The current filter read has answered; require another read when the week changes.
  const before = trace.requests.filter(p => p === "/api/standard/prompts/page").length;
  latest = { ...week, week: { start: "2026-11-09", end: "2026-11-15", month: 11, nth: 2 } };
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect(page.locator("[data-rn-service-week]")).toContainText("11월 2주차");
  await expect.poll(() => trace.requests.filter(p => p === "/api/standard/prompts/page").length).toBeGreaterThan(before);
  await expect(search).toHaveValue("week-filter");
  expect(trace.errors).toEqual([]);
  expect(trace.unhandled).toEqual([]);
});
test("a failed critical refresh replaces the old analytics view with an explicit error", async ({ page }) => {
  let failed = false;
  const trace = await mockHub(page, url => failed && url.pathname === "/api/screens/overview/cards" ? { status: 503, body: { error: { code: "source_unavailable" } } } : undefined);
  await page.goto(`${hub}/ko/renewal/dashboard`);
  await expect(page.getByRole("heading", { name: "AI 답변 성과 요약", exact: true })).toBeVisible();
  failed = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect(page.getByText(/이 구간의 집계에 실패했습니다/)).toBeVisible();
  await expect(page.getByText("측정 데이터가 아직 없습니다", { exact: true })).toHaveCount(0);
  expect(trace.errors).toEqual([]);
});
test("service-week metadata failure does not hide successfully loaded analytics", async ({ page }) => {
  const trace = await mockHub(page, url => url.pathname.endsWith("/service-week") ? { status: 503, body: { error: { code: "source_unavailable" } } } : undefined);
  await page.goto(`${hub}/ko/renewal/dashboard`);
  await expect(page.getByRole("heading", { name: "AI 답변 성과 요약", exact: true })).toBeVisible();
  await expect(page.getByText("측정 데이터가 아직 없습니다", { exact: true })).toBeVisible();
  expect(trace.errors).toEqual([]);
});
test("Mention header displays the server's effective period separately from the service week", async ({ page }) => {
  const trace = await mockHub(page, url => url.pathname.endsWith("/rn-page") ? { body: { ownLabel: "HMG", period: { from: "2026-08-01", to: "2026-08-21" } } } : undefined);
  await page.goto(`${hub}/ko/renewal/standard/answer-analysis/mention?time=2026-08-01..2026-08-31`);
  const header = page.locator("header").first();
  await expect(header).toContainText("2026-08-01");
  await expect(header).toContainText("2026-08-21");
  await expect(header).not.toContainText("2026-08-31");
  await expect(header).toContainText("11월 1주차");
  expect(trace.errors).toEqual([]);
  expect(trace.unhandled).toEqual([]);
});
test("Mention header displays the measurement date without a selected period", async ({ page }) => {
  const trace = await mockHub(page);
  await page.goto(`${hub}/ko/renewal/standard/answer-analysis/mention`);
  await expect(page.locator("header").first()).toContainText("2026-11-05");
  expect(trace.errors).toEqual([]);
  expect(trace.unhandled).toEqual([]);
});
test("Website prompts refreshes the current list and insights when the week advances", async ({ page }) => {
  let latest = week;
  const catalog = { rows: [], total: 0, listed: 0, page: 1, pages: 0, pageSize: 50, rangeFrom: 0, rangeTo: 0, sort: "lastMeasuredAt", dir: "desc", roundAxis: [] };
  const insights = { prompts: 0, engines: [], rounds: [], engineSets: [], brands: [], markets: [], langCount: 0, siteCount: 0 };
  const trace = await mockHub(page, url => {
    if (url.pathname.endsWith("/service-week")) return { body: latest };
    if (url.pathname === "/api/screens/website/prompts-options") return { body: { catalogRows: [], geographyOptions: [], languageOptions: [], engineOptions: [], optionMatrix: [], selectableDates: [], collectionStartDay: null, latestAnchorDay: null } };
    if (["/api/screens/website/prompts-page", "/api/website/prompts/page"].includes(url.pathname)) return { body: catalog };
    if (["/api/screens/website/prompts-insights", "/api/website/prompts/insights"].includes(url.pathname)) return { body: insights };
  });
  await page.goto(`${hub}/ko/renewal/website/prompts`);
  await expect(page.locator("[data-rn-service-week]")).toContainText("11월 1주차");
  const search = page.locator("#rn-website-prompt-search");
  await Promise.all([
    page.waitForResponse(r => r.url().includes("/api/website/prompts/page") && r.url().includes("week-filter")),
    page.waitForResponse(r => r.url().includes("/api/website/prompts/insights") && r.url().includes("week-filter")),
    search.fill("week-filter"),
  ]);
  // a moved week loads the page again (the search stays in the address)
  const beforePage = trace.requests.filter(p => p === "/api/screens/website/prompts-page").length;
  const beforeInsights = trace.requests.filter(p => p === "/api/screens/website/prompts-insights").length;
  latest = { ...week, week: { start: "2026-11-09", end: "2026-11-15", month: 11, nth: 2 } };
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect(page.locator("[data-rn-service-week]")).toContainText("11월 2주차");
  await expect.poll(() => trace.requests.filter(p => p === "/api/screens/website/prompts-page").length).toBeGreaterThan(beforePage);
  await expect.poll(() => trace.requests.filter(p => p === "/api/screens/website/prompts-insights").length).toBeGreaterThan(beforeInsights);
  await expect(search).toHaveValue("week-filter");
  expect(trace.errors).toEqual([]);
  expect(trace.unhandled).toEqual([]);
});
