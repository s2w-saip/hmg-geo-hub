import { test, expect } from "@playwright/test";
import { mockHub } from "./hub-contract";
const project = "11111111-1111-4111-8111-111111111111";
const path = `http://127.0.0.1:3335/ko/renewal/projects/${project}/setting`;
const item = { version: 1, brands: [], countries: ["KR"], engines: [], cadence: "weekly", acrRepeats: null, webUnits: [], ownedUrls: [], trackedUrls: [], trackedTargets: [], origin: "hub", recordedAt: null };
function screen(value = item, editing = true) {
  return { identity: { projectId: project, scopeProjectId: null, regions: null }, measured: null, fields: [], targets: 0, measurement: { item: value, options: { brands: [], countries: ["KR", "US"], engines: [] }, editing } };
}
test("Project settings keeps the edit's original version across a concurrent update and recovers explicitly", async ({ page }) => {
  let latest = item, reads = 0;
  const writes: { expectedVersion: number; countries: string[]; cadence: string | null }[] = [];
  const trace = await mockHub(page, (url, request) => {
    if (url.pathname.endsWith("/projects/settings")) { reads++; return { body: screen(latest) }; }
    if (url.pathname.endsWith(`/projects/${project}/measurement`)) {
      if (request.method() === "GET") return { body: { data: screen(latest).measurement } };
      const body = request.postDataJSON(); writes.push(body);
      if (body.expectedVersion !== latest.version) return { status: 409, body: { error: { code: "version_conflict" } } };
      latest = { ...latest, version: latest.version + 1, countries: body.countries };
      return { body: { data: { item: latest, changed: true } } };
    }
  });
  await page.goto(path);
  const form = page.locator("[data-rn-project-measurement]");
  const countries = form.getByRole("textbox", { name: "측정 국가", exact: true });
  await countries.fill("US");
  latest = { ...item, version: 2, cadence: "monthly" };
  const before = reads;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(countries).toHaveValue("US");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].expectedVersion).toBe(1);
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(countries).toHaveValue("US");
  await form.getByRole("button", { name: "최신 설정 불러오기", exact: true }).click();
  await expect(countries).toHaveValue("KR");
  await countries.fill("US");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].expectedVersion).toBe(2);
  expect(writes[1].cadence).toBe("monthly");
  await expect(form.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(countries).toHaveValue("US");
  expect(trace.errors).toEqual([]);
  expect(trace.unhandled).toEqual([]);
});
test("Project settings adopts a fresh server version when no local edits exist", async ({ page }) => {
  let latest = item;
  await mockHub(page, url => url.pathname.endsWith("/projects/settings") ? { body: screen(latest) } : undefined);
  await page.goto(path);
  const form = page.locator("[data-rn-project-measurement]");
  const countries = form.getByRole("textbox", { name: "측정 국가", exact: true });
  await expect(countries).toHaveValue("KR");
  latest = { ...item, version: 2, countries: ["US"] };
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect(countries).toHaveValue("US");
  await expect(form.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
});
test("Project settings cannot submit when the server disables editing", async ({ page }) => {
  await mockHub(page, url => url.pathname.endsWith("/projects/settings") ? { body: screen(item, false) } : undefined);
  await page.goto(path);
  const form = page.locator("[data-rn-project-measurement]");
  await expect(form.getByRole("textbox", { name: "측정 국가", exact: true })).toBeDisabled();
  await expect(form.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
});
test("Project settings preserves unsaved input after a failed write or failed reload", async ({ page }) => {
  let writes = 0;
  const trace = await mockHub(page, (url, request) => {
    if (url.pathname.endsWith("/projects/settings")) return { body: screen() };
    if (url.pathname.endsWith(`/projects/${project}/measurement`)) {
      if (request.method() === "POST") writes++;
      return { status: 503, body: { error: { code: "source_unavailable" } } };
    }
  });
  await page.goto(path);
  const form = page.locator("[data-rn-project-measurement]");
  const countries = form.getByRole("textbox", { name: "측정 국가", exact: true });
  await countries.fill("US");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(countries).toHaveValue("US");
  await form.getByRole("button", { name: "최신 설정 불러오기", exact: true }).click();
  await expect(form.getByRole("button", { name: "최신 설정 불러오기", exact: true })).toBeEnabled();
  await expect(countries).toHaveValue("US");
  expect(writes).toBe(1);
  expect(trace.errors).toEqual([]);
});
test("Project settings rejects a malformed success without losing the draft", async ({ page }) => {
  const trace = await mockHub(page, url => {
    if (url.pathname.endsWith("/projects/settings")) return { body: screen() };
    if (url.pathname.endsWith(`/projects/${project}/measurement`)) return { body: { data: { item: { version: 2, countries: ["US"] } } } };
  });
  await page.goto(path);
  const form = page.locator("[data-rn-project-measurement]");
  const countries = form.getByRole("textbox", { name: "측정 국가", exact: true });
  await countries.fill("US");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(countries).toHaveValue("US");
  await expect(form.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  expect(trace.errors).toEqual([]);
});
test("an expired session during a write redirects to sign-in", async ({ page }) => {
  await mockHub(page, url => {
    if (url.pathname.endsWith("/projects/settings")) return { body: screen() };
    if (url.pathname.endsWith(`/projects/${project}/measurement`)) return { status: 401, body: { error: { code: "unauthorized" } } };
  });
  await page.goto(path);
  const form = page.locator("[data-rn-project-measurement]");
  await form.getByRole("textbox", { name: "측정 국가", exact: true }).fill("US");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page).toHaveURL(/\/ko\/login\?next=/);
  await expect(page.locator("[data-rn-project-measurement]")).toHaveCount(0);
});
