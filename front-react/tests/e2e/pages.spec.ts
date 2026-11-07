import { test, expect } from "@playwright/test";
import { mockHub, testProject } from "./hub-contract";

const hub = "http://127.0.0.1:3335";
const noData = { status: 404, body: { error: { code: "not_found" } } };

test("a listed project with no measured data opens the no-data page", async ({ page }) => {
  await mockHub(page, url => url.pathname.startsWith("/api/screens/projects/") && url.pathname !== "/api/screens/projects/list" ? noData : undefined);
  await page.goto(`${hub}/ko/renewal/projects/${testProject}`);
  await expect(page.getByRole("heading", { name: "아직 측정 데이터가 없습니다", exact: true })).toBeVisible();
});
test("a project nobody holds and an unknown project page are told apart", async ({ page }) => {
  await mockHub(page);
  await page.goto(`${hub}/ko/renewal/projects/22222222-2222-4222-8222-222222222222`);
  await expect(page.locator("h1")).toHaveText("준비되지 않은 화면입니다");
  await page.goto(`${hub}/ko/renewal/projects/${testProject}/no-such`);
  await expect(page.getByRole("heading", { name: "아직 측정 데이터가 없습니다", exact: true })).toBeVisible();
});
test("a menu parent opens its first child", async ({ page }) => {
  const trace = await mockHub(page);
  await page.goto(`${hub}/ko/renewal/admin/standards`);
  await expect(page).toHaveURL(/\/ko\/renewal\/admin\/standards\/prompts$/);
  await page.goto(`${hub}/ko/renewal/projects/${testProject}/analysis`);
  await expect(page).toHaveURL(new RegExp(`/projects/${testProject}/analysis/mention$`));
  expect(trace.errors).toEqual([]);
});
test("the browser tab names the page and, on a project page, the project", async ({ page }) => {
  await mockHub(page);
  await page.goto(`${hub}/ko/renewal/dashboard`);
  await expect(page).toHaveTitle("Overview (Renewal) · HMG GEO 모니터링");
  await page.goto(`${hub}/ko/renewal/projects/${testProject}/member`);
  await expect(page).toHaveTitle("Member · 11111111 · HMG GEO 모니터링");
});
test("a signed-in visitor leaves the login page, and a login failure says why", async ({ page }) => {
  await mockHub(page);
  await page.goto(`${hub}/ko/login?next=${encodeURIComponent("/ko/renewal/website")}`);
  await expect(page).toHaveURL(/\/ko\/renewal\/website$/);
});
test("the login form tells a limit from a wrong password", async ({ page }) => {
  let status = 401;
  await mockHub(page, (url, request) => {
    if (url.pathname !== "/api/hub/session") return undefined;
    return request.method() === "POST" ? { status, body: { error: { code: "x" } } } : { status: 401, body: { error: { code: "unauthorized" } } };
  });
  await page.goto(`${hub}/ko/login`);
  await page.getByRole("textbox", { name: "아이디" }).fill("a");
  await page.getByLabel("비밀번호", { exact: true }).fill("b");
  await page.getByRole("button", { name: "로그인" }).click();
  const first = await page.getByRole("alert").innerText();
  status = 429;
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("alert")).not.toHaveText(first);
});
test("a list that cannot be read says so in its own frame", async ({ page }) => {
  await mockHub(page, url => url.pathname === "/api/hub/accounts" ? { status: 503, body: { error: { code: "source_unavailable" } } } : undefined);
  await page.goto(`${hub}/ko/renewal/admin`);
  await expect(page.locator('[data-hub-page-error="source_unavailable"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "사용자 관리", exact: true })).toBeVisible();
});
