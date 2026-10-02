import { defineConfig } from "@playwright/test";

// Local E2E (design 5.3). The stack must already be up: `bash e2e/stack.sh up`.
//   npx playwright test -c e2e/playwright.config.ts                 all screens
//   npx playwright test -c e2e/playwright.config.ts -g "qa-list"    one screen (ids in e2e/screens.json)
//
// One browser project (chromium, headless shell), one worker, 30 s per screen case. The
// "warmup" setup project logs every account in once (storage states in e2e/.run/state) and
// compiles each route in next dev, so a cold compile does not eat a screen's 30 s.
//
// The spec file is screens.e2e.ts, not *.spec.ts: vitest (npm test) collects *.spec.ts by
// default and would try to run a Playwright file.
const FRONT_PORT = process.env.E2E_FRONT_PORT || "3100";

export default defineConfig({
  testDir: ".",
  outputDir: ".out/pw",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${FRONT_PORT}`,
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 25_000,
  },
  projects: [
    { name: "warmup", testMatch: /warmup\.setup\.ts$/, timeout: 600_000 },
    { name: "chromium", testMatch: /screens\.e2e\.ts$/, dependencies: ["warmup"] },
  ],
});
