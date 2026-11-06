import { test, expect } from "@playwright/test";
import { mockHub, type Reply } from "./hub-contract";

const hub = "http://127.0.0.1:3335";
function heldReply() {
  let release!: (reply: Reply) => void;
  const promise = new Promise<Reply>(resolve => { release = resolve; });
  return { promise, release };
}
function overview(url: URL): Reply | undefined {
  if (url.pathname.endsWith("/overview/cards")) return { body: { state: "ok", cards: [], compareTitle: null } };
  if (url.pathname.endsWith("/overview/card-trend")) return { body: { degraded: false, cards: {} } };
  if (url.pathname.endsWith("/overview/geo")) return { body: { geo: null, degraded: false } };
}

test("filter changes keep the frame, panel and scroll mounted while only data is replaced", async ({ page }) => {
  const held = heldReply();
  let filteredRead = false, navigations = 0;
  page.on("request", request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  const trace = await mockHub(page, url => {
    if (url.pathname.endsWith("/overview/cards") && !url.searchParams.has("geography")) { filteredRead = true; return held.promise; }
    return overview(url);
  });
  try {
    await page.goto(`${hub}/ko/renewal/dashboard?geography=KR`);
    await expect(page.getByLabel("KPI 5종", { exact: true })).toBeVisible();
    const frame = page.locator("[data-rn-frame]");
    const panel = page.locator("#rn-filter-panel");
    const scroll = page.locator("[data-rn-scroll]");
    await frame.evaluate(el => el.setAttribute("data-test-preserved", "yes"));
    await panel.evaluate(el => { el.setAttribute("data-test-preserved", "yes"); el.scrollTop = 80; });
    // Empty contract fixtures need room to verify the independent content scroll position.
    await scroll.evaluate(el => { (el.firstElementChild as HTMLElement).style.minHeight = "1800px"; el.scrollTop = 100; });
    const panelTop = await panel.evaluate(el => el.scrollTop);
    const contentTop = await scroll.evaluate(el => el.scrollTop);
    await page.locator("[data-rn-reset]").click();
    await expect.poll(() => filteredRead).toBe(true);
    await expect(frame).toHaveAttribute("data-test-preserved", "yes");
    await expect(panel).toHaveAttribute("data-test-preserved", "yes");
    await expect(page.getByLabel("불러오는 중", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("KPI 5종", { exact: true })).toBeVisible();
    await expect(page.locator("[data-rn-busy]").first()).toHaveAttribute("aria-busy", "true");
    expect(await panel.evaluate(el => el.scrollTop)).toBe(panelTop);
    expect(await scroll.evaluate(el => el.scrollTop)).toBe(contentTop);
    await page.keyboard.press("[");
    await expect(page.locator("[data-rn-split]")).toHaveAttribute("data-rn-split", "closed");
    held.release({ body: { state: "empty" } });
    await expect(page.getByText("조회 조건에 해당하는 측정 데이터가 없습니다.", { exact: true })).toBeVisible();
    await expect(frame).toHaveAttribute("data-test-preserved", "yes");
    await expect(page.locator("[data-rn-split]")).toHaveAttribute("data-rn-split", "closed");
    await expect(page.locator("[data-rn-busy]")).toHaveCount(0);
    expect(navigations).toBe(1);
    expect(trace.errors).toEqual([]);
  } finally { held.release({ body: { state: "empty" } }); }
});

test("a late filter response cannot overwrite a newer selection", async ({ page }) => {
  const held = heldReply();
  let waiting = false;
  const trace = await mockHub(page, url => {
    if (url.pathname.endsWith("/overview/cards")) {
      if (!url.searchParams.has("geography")) { waiting = true; return held.promise; }
      if (url.searchParams.get("geography") === "US") return { body: { state: "empty" } };
    }
    return overview(url);
  });
  try {
    await page.goto(`${hub}/ko/renewal/dashboard?geography=KR`);
    await expect(page.getByLabel("KPI 5종", { exact: true })).toBeVisible();
    await page.locator("[data-rn-reset]").click();
    await expect.poll(() => waiting).toBe(true);
    // A back/forward query change can overtake an in-flight filter read as well.
    await page.evaluate(() => {
      window.history.pushState(window.history.state, "", "?geography=US");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    await expect(page.getByText("조회 조건에 해당하는 측정 데이터가 없습니다.", { exact: true })).toBeVisible();
    held.release({ body: { state: "ok", cards: [], compareTitle: null } });
    await expect(page).toHaveURL(/geography=US/);
    await expect(page.getByLabel("KPI 5종", { exact: true })).toHaveCount(0);
    expect(trace.errors).toEqual([]);
  } finally { held.release({ body: { state: "empty" } }); }
});

test("retained data is cleared immediately when the account scope changes", async ({ page }) => {
  const held = heldReply();
  let narrowed = false, scopedRead = false;
  await mockHub(page, url => {
    if (url.pathname === "/api/hub/session" && narrowed) return { body: { user: { id: "test-admin", login: "test-admin", email: null, displayName: null, role: "country", scope: { all: false, countries: ["KR"] }, mustChangePassword: false } } };
    if (url.pathname.endsWith("/overview/cards") && narrowed) { scopedRead = true; return held.promise; }
    return overview(url);
  });
  try {
    await page.goto(`${hub}/ko/renewal/dashboard`);
    await expect(page.getByLabel("KPI 5종", { exact: true })).toBeVisible();
    narrowed = true;
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => scopedRead).toBe(true);
    await expect(page.getByLabel("KPI 5종", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("불러오는 중", { exact: true })).toBeVisible();
    held.release({ body: { state: "empty" } });
    await expect(page.getByText("조회 조건에 해당하는 측정 데이터가 없습니다.", { exact: true })).toBeVisible();
  } finally { held.release({ body: { state: "empty" } }); }
});

test("a failed filter read shows the real error instead of retaining previous measurements", async ({ page }) => {
  await mockHub(page, url => {
    if (url.pathname.endsWith("/overview/cards") && !url.searchParams.has("geography")) return { status: 503, body: { error: { code: "source_unavailable" } } };
    return overview(url);
  });
  await page.goto(`${hub}/ko/renewal/dashboard?geography=KR`);
  await expect(page.getByLabel("KPI 5종", { exact: true })).toBeVisible();
  await page.locator("[data-rn-reset]").click();
  await expect(page.getByRole("heading", { name: "데이터를 준비하고 있습니다", exact: true })).toBeVisible();
  await expect(page.getByLabel("KPI 5종", { exact: true })).toHaveCount(0);
});
