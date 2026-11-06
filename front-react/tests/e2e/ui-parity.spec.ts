import { test, expect } from "@playwright/test";

test("renewal uses the original sidebar, white frame, KPI hero and independent filter column", async ({ page }) => {
  await page.goto("/ko/renewal/dashboard");
  const side = page.locator("[data-rn-shell-side]");
  const frame = page.locator("[data-rn-frame]");
  await expect(frame).toBeVisible();
  await expect(side.locator('[data-rn-nav="/renewal/dashboard"]')).toHaveAttribute("aria-current", "page");
  await expect(side.locator("[data-rn-nav-group]").first()).toHaveText("Answer analysis");
  await expect(side.locator('[data-rn-sec="project"]')).toBeVisible();
  const s = await side.boundingBox(), f = await frame.boundingBox();
  expect(s!.width).toBe(232);
  expect(f!.x).toBe(232); expect(f!.y).toBe(10); expect(f!.height).toBe(895);
  const panel = page.locator('[data-rn-split] > div').first();
  expect((await panel.boundingBox())!.width).toBe(296);
  const hero = page.getByLabel("KPI 5종", { exact: true });
  await expect(hero).toHaveCSS("background-color", "rgb(17, 31, 138)");
  await expect(page.getByRole("heading", { name: "브랜드 비교", exact: true })).toBeVisible();
  await expect(page.locator("[data-rn-beta-toast]")).toBeVisible();
  const header = await page.locator("header").first().boundingBox();
  await page.locator("[data-rn-scroll]").evaluate(el => { el.scrollTop = 250; });
  expect((await page.locator("header").first().boundingBox())!.y).toBe(header!.y);
});

test("disconnected Mention renders the four original trend cards and keeps its tab and locale interactions", async ({ page }) => {
  await page.goto("/ko/renewal/standard/answer-analysis/mention");
  await expect(page.locator("[data-rn-gcard]")).toHaveCount(4);
  await expect(page.getByRole("tab", { name: "당사 지표", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "경쟁 비교", exact: true }).click();
  await expect(page).toHaveURL(/tab=cmp/);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/renewal\/standard\/answer-analysis\/mention\?tab=cmp/);
  await expect(page.locator('[data-rn-gtab="cmp"]')).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page.locator('[data-rn-gtab="cmp"]')).toHaveAttribute("aria-selected", "true");
});

test("preview shows the original project measurement form as read-only", async ({ page }) => {
  await page.goto("/ko/renewal/projects/preview/setting");
  const form = page.locator("[data-rn-project-measurement]");
  await expect(form.getByRole("textbox", { name: "측정 국가", exact: true })).toBeDisabled();
  await expect(form.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
});

test("original source-management tabs and search stay local in preview", async ({ page }) => {
  const api: string[] = [], errors: string[] = [];
  page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/")) api.push(r.url()); });
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  for (const tab of ["overrides", "seeds", "social", "codes"]) {
    await page.goto(`/ko/renewal/admin/standards/citation-sources?tab=${tab}`);
    await expect(page.locator("h1")).toHaveText("인용 출처 분류");
    await expect(page.locator("[data-rn-frame]")).toBeVisible();
  }
  await page.goto("/ko/renewal/admin");
  await page.getByPlaceholder("아이디 · 이름 · 이메일 검색").fill("검색");
  await expect(page).toHaveURL(/q=/);
  expect(api).toEqual([]); expect(errors).toEqual([]);
});

test("outside-account screens retain the original gate without sample measurements", async ({ page }) => {
  await page.goto("/ko/renewal/standard/ai-funnel/conversion");
  await expect(page.locator('[data-rn-account-gate="ga4"]')).toBeVisible();
  await expect(page.locator("[data-rn-waiting-layout]")).toBeVisible();
  await expect(page.getByText("측정값은 연결 후 표시됩니다.", { exact: true })).toBeVisible();
});

test("the original account controls preserve the session when sign-out fails", async ({ page }) => {
  const { mockHub } = await import("./hub-contract");
  const trace = await mockHub(page, (url, request) => url.pathname === "/api/hub/session" && request.method() === "DELETE" ? { status: 503, body: { error: { code: "source_unavailable" } } } : undefined);
  await page.goto("http://127.0.0.1:3335/ko/renewal/admin");
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.getByText("로그아웃하지 못했습니다. 다시 시도해 주세요.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/ko\/renewal\/admin$/);
  expect(trace.errors).toEqual([]);
});

test("the original password control opens the standalone password route with its return URL", async ({ page }) => {
  const { mockHub } = await import("./hub-contract");
  await mockHub(page);
  await page.goto("http://127.0.0.1:3335/ko/renewal/admin");
  await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await expect(page).toHaveURL(/\/ko\/change-password\?next=%2Fko%2Frenewal%2Fadmin$/);
  await expect(page.getByRole("heading", { name: "비밀번호 변경", exact: true })).toBeVisible();
});

test("citation preserves each surface's original KPI layout", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/ko/renewal/standard/answer-analysis/citation");
  await expect(page.locator("[data-rn-kpis]")).toBeVisible();
  await expect(page.getByText(/이 섹션을 집계하지 못했습니다|출처 필터/)).toHaveCount(0);
  await expect(page.locator("#sec-reach")).toHaveCount(0);
  await page.goto("/ko/renewal/website/answer-analysis/citation");
  await expect(page.locator("#sec-reach")).toBeVisible();
  await expect(page.locator("[data-rn-kpis]")).toHaveCount(0);
  await page.goto("/ko/renewal/projects/preview/analysis/citation");
  await expect(page.locator("#sec-summary")).toBeVisible();
  await expect(page.locator("#sec-reach")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the project sidebar shows server metadata and switches projects on the same menu", async ({ page }) => {
  const { mockHub } = await import("./hub-contract");
  const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
  const row = { prompts: 0, answers: 0, last_measured_day: null, countries: ["KR"], engines: [], languages: [], rounds: 0, custom_fields: 0, first_prompt: null };
  const trace = await mockHub(page, url => url.pathname === "/api/screens/projects/list" ? { body: { items: [{ ...row, id: first }, { ...row, id: second }] } } : undefined);
  await page.goto(`http://127.0.0.1:3335/ko/renewal/projects/${first}/member`);
  const card = page.locator(`[data-rn-project-card="${first}"]`);
  await expect(card).toContainText("11111111");
  await expect(card).toContainText("대한민국");
  await card.getByRole("button").click();
  await page.locator(`[data-rn-project-pick="${second}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${second}/member$`));
  await expect(page.locator(`[data-rn-project-card="${second}"]`)).toContainText("22222222");
  expect(trace.errors).toEqual([]); expect(trace.unhandled).toEqual([]);
});

test("a denied project route does not read the project directory for its sidebar", async ({ page }) => {
  const { mockHub } = await import("./hub-contract");
  const trace = await mockHub(page, url => url.pathname === "/api/hub/session" ? { body: { user: { id: "test-country", login: "test-country", email: null, displayName: null, role: "country", scope: { all: false, countries: ["KR"], brands: ["Kia"] }, mustChangePassword: false } } } : undefined);
  await page.goto("http://127.0.0.1:3335/ko/renewal/projects/11111111-1111-4111-8111-111111111111/member");
  await expect(page.getByRole("heading", { name: "접근할 수 없습니다", exact: true })).toBeVisible();
  expect(trace.requests).toEqual(["/api/hub/session"]);
});
