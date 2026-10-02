import { defineConfig } from "@playwright/test";

// E7 entity versioning: flow check and list latency against a DEPLOYED front (stg), not the local
// stack. Nothing here starts a server. Credentials come from the environment only and are never
// printed.
//
//   ECAT_BASE_URL=https://<stg front> ECAT_ADMIN_EMAIL=... ECAT_ADMIN_PASSWORD=... \
//     npx playwright test -c e2e/ecat/playwright.ecat.config.ts -g "list p50"      # read only
//   ... same env ... ECAT_WRITE=1 \
//     npx playwright test -c e2e/ecat/playwright.ecat.config.ts -g "flow"          # writes stg
//
// The flow WRITES to the target: it creates a draft, blocks one probe surface globally, applies it
// to unexposed rounds only, then rolls the apply back (two new versions). It refuses to run
// without ECAT_WRITE=1 and when a draft is already open. One run = one measured execution; the
// acceptance budget is at most 6 runs.
export default defineConfig({
  testDir: ".",
  testMatch: /\.ecat\.ts$/,
  outputDir: "../.out/ecat/pw",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 45 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.ECAT_BASE_URL,
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    headless: true,
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
});
