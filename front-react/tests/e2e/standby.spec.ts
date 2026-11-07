import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const routes = JSON.parse(readFileSync(new URL("../../src/app/source-routes.json", import.meta.url), "utf8")) as { path: string }[];
// Independent acceptance expectations: an arbitrary heading or fallback page is not a migrated route.
const screens: [string[], string, string][] = [
  [["dashboard", "website"], "Overview", "overview"],
  [["standard/prompts"], "글로벌 프롬프트", "prompts"],
  [["website/prompts"], "프롬프트", "website-prompts"],
  [["standard/answer-analysis/mention", "website/answer-analysis/mention", "projects/:id/analysis/mention"], "언급 분석베타", "mention"],
  [["standard/answer-analysis/citation", "website/answer-analysis/citation", "projects/:id/analysis/citation"], "인용 분석베타", "citation"],
  [["standard/answer-analysis/citation/prompts", "website/answer-analysis/citation/prompts", "projects/:id/analysis/citation/prompts"], "인용 프롬프트", "citation-prompts"],
  [["standard/answer-analysis/citation/tone-urls", "website/answer-analysis/citation/tone-urls", "projects/:id/analysis/citation/tone-urls"], "감정별 인용 URL", "citation-tone"],
  [["standard/ai-funnel/acr"], "AI 추천 전환율베타", "acr"],
  [["standard/ai-funnel/conversion", "website/ai-funnel/conversion", "projects/:id/ai-funnel/conversion"], "AI 유입 전환베타", "waiting"],
  [["standard/ai-funnel/visibility"], "AI 가시성베타", "waiting"],
  [["projects"], "프로젝트", "projects"],
  [["projects/:id"], "Dashboard", "overview"],
  [["projects/:id/prompt"], "프롬프트", "project-prompts"],
  [["projects/:id/setting"], "프로젝트 설정", "project-setting"],
  [["projects/:id/member"], "멤버", "member"],
  [["projects/:id/intent/google-keyword"], "키워드", "waiting"],
  [["projects/:id/intent/social-scraping"], "소셜 분석", "waiting"],
  [["admin"], "사용자 관리", "accounts"],
  [["admin/standards/prompts"], "글로벌 프롬프트 관리", "hub-prompts"],
  [["admin/standards/citation-sources"], "인용 출처 분류", "sources"],
  [["admin/standards/customer-interest"], "고객 관심 데이터 관리", "interest"],
  [["admin/standards/entities"], "엔티티 카탈로그", "entities"],
  [["admin/standards/measurement"], "측정 설정", "measurement"],
  [["admin/ga4"], "GA4 연동", "ga4"],
  [["admin/keyword-tools"], "키워드 도구", "waiting"],
];

test("all original renewal routes open without API calls or browser errors", async ({ page }) => {
  const errors: string[] = [];
  const api: string[] = [];
  test.setTimeout(120_000);
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/")) api.push(r.url()); });
  for (const route of routes) {
    const path = route.path.replace(":locale", "ko").replace(":id", "preview").replace("*", "not-built");
    await page.goto(path);
    const routeName = route.path.replace("/:locale/renewal/", "");
    if (routeName.includes("*")) {
      await expect(page.locator("h1")).toHaveText("준비되지 않은 화면입니다");
      await expect(page.locator("[data-page-kind]")).toHaveCount(0);
    } else {
      const expected = screens.find(([paths]) => paths.includes(routeName));
      expect(expected, `No acceptance expectation for ${route.path}`).toBeDefined();
      await expect(page.locator("h1")).toHaveText(expected![1]);
      await expect(page.locator("[data-page-kind]")).toHaveAttribute("data-page-kind", expected![2]);
    }
    await expect(page.locator(".rn-connection-indicator")).toContainText("서버 연결 전");
  }
  expect(api).toEqual([]);
  expect(errors).toEqual([]);
});
test("an unregistered route is explicitly unavailable", async ({ page }) => {
  await page.goto("/ko/renewal/route-that-does-not-exist");
  await expect(page.locator("h1")).toHaveText("준비되지 않은 화면입니다");
  await expect(page.locator("[data-page-kind]")).toHaveCount(0);
});
test("navigation, filter collapse, locale switch, and direct URL refresh work", async ({ page }) => {
  await page.goto("/ko/renewal/dashboard");
  await expect(page.locator("[data-rn-split]")).toBeVisible();
  await page.keyboard.press("[");
  await expect(page.locator("[data-rn-split]")).toHaveAttribute("data-rn-split", "closed");
  await page.locator('[data-rn-nav="/renewal/standard/answer-analysis/mention"]').click();
  await expect(page).toHaveURL(/standard\/answer-analysis\/mention/);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/renewal\/standard\/answer-analysis\/mention/);
  await expect(page.locator("h1")).toHaveText("Mention analysisBeta");
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Mention analysisBeta");
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
});
test("the original overview UI has no measured values and preview cannot submit a login", async ({ page }) => {
  await page.goto("/ko/renewal/dashboard");
  await expect(page.getByLabel("KPI 5종").getByText("데이터 없음", { exact: true })).toHaveCount(5);
  await page.screenshot({ path: "test-results/standby-overview.png" });
  await page.goto("/ko/login");
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeDisabled();
});
test("connected mode denies an unauthenticated deep link without requesting screen data", async ({ page }) => {
  const screens: string[] = [];
  await page.route("**/api/**", route => {
    if (!new URL(route.request().url()).pathname.startsWith("/api/")) return route.continue();
    if (route.request().url().includes("/api/screens/")) screens.push(route.request().url());
    return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"unauthorized"}}' });
  });
  await page.goto("http://127.0.0.1:3335/ko/renewal/admin");
  await expect(page).toHaveURL(/\/ko\/login\?next=/);
  expect(screens).toEqual([]);
});
test("connected mode applies role checks before admin data reads", async ({ page }) => {
  const adminReads: string[] = [];
  await page.route("**/api/**", route => {
    if (!new URL(route.request().url()).pathname.startsWith("/api/")) return route.continue();
    if (!route.request().url().endsWith("/api/hub/session")) adminReads.push(route.request().url());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { id: "test-country-user", login: "test-user", email: null, displayName: null, role: "country", scope: { all: false, brands: ["Kia"], countries: ["KR"] }, mustChangePassword: false } }) });
  });
  await page.goto("http://127.0.0.1:3335/ko/renewal/admin");
  await expect(page.getByRole("heading", { name: "접근할 수 없습니다" })).toBeVisible();
  expect(adminReads).toEqual([]);
});
test("connected mode renders the migrated account manager with the browser contract", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const body = url.pathname.endsWith("/session")
      ? { user: { id: "test-admin", login: "test-admin", email: null, displayName: null, role: "admin", scope: { all: true }, mustChangePassword: false } }
      : url.pathname.endsWith("/accounts") ? { data: { items: [], roles: ["hq", "region", "country"] } } : { data: { items: [] } };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("http://127.0.0.1:3335/ko/renewal/admin");
  await expect(page.getByRole("heading", { name: "사용자 관리", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "새 계정", exact: true })).toBeVisible();
  await page.getByPlaceholder("아이디 · 이름 · 이메일 검색").fill("Kia");
  await expect(page).toHaveURL(/q=Kia/);
  expect(errors).toEqual([]);
});
test("a failed rollup displays an error rather than previously loaded values", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", route => {
    if (!new URL(route.request().url()).pathname.startsWith("/api/")) return route.continue();
    if (new URL(route.request().url()).pathname.endsWith("/session")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { id: "test-admin", login: "test-admin", email: null, displayName: null, role: "admin", scope: { all: true }, mustChangePassword: false } }) });
    return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":{"code":"source_unavailable"}}' });
  });
  await page.goto("http://127.0.0.1:3335/ko/renewal/dashboard");
  await expect(page.getByRole("heading", { name: "데이터를 준비하고 있습니다" })).toBeVisible();
  await expect(page.getByRole("button", { name: "다시 조회", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("the migrated Mention view consumes its promised screen responses in a browser", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", message => { if (/uncached promise|async Client Component/i.test(message.text())) errors.push(message.text()); });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    let body: unknown = null;
    if (path.endsWith("/session")) body = { user: { id: "test-admin", login: "test-admin", email: null, displayName: null, role: "admin", scope: { all: true }, mustChangePassword: false } };
    else if (path.endsWith("/saved-filters")) body = { data: { items: [] } };
    else if (path.endsWith("/panel-options")) body = { geographyOptions: [], languageOptions: [], catalogRows: [], engineOptions: [] };
    else if (path.endsWith("/filter-dates")) body = { selectableDates: [], collectionStartDay: null, latestAnchorDay: null };
    else if (path.endsWith("/service-week")) body = { state: "unconfigured", week: null, delay: null, checkedAt: null, recordedAt: null, notes: [] };
    else if (path.endsWith("/rn-page")) body = { ownLabel: "HMG", period: null };
    else if (path.endsWith("/rn-shell")) body = { measured: false, degraded: false, ownBrands: [], ownSum: [], drawer: [] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("http://127.0.0.1:3335/ko/renewal/standard/answer-analysis/mention");
  await expect(page.locator("h1")).toContainText("언급 분석");
  await expect(page.getByText("측정 데이터가 아직 없습니다", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
