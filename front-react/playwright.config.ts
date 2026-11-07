import { defineConfig } from "@playwright/test";
// E2E_PORT: another port for the disconnected server when the usual dev server holds 3334.
const port = process.env.E2E_PORT ?? "3334";
// the first-visit beta notice covers the page; the tests start as a visitor who closed it today
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const closedNotice = (origin: string) => ({ origin, localStorage: [{ name: "ggmd-beta-notice-hide-date", value: today }] });
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1920, height: 915 }, trace: "retain-on-failure", storageState: { cookies: [], origins: [closedNotice(`http://127.0.0.1:${port}`), closedNotice("http://127.0.0.1:3335")] } },
  webServer: [
    { command: `npm run dev -- --port ${port}`, url: `http://127.0.0.1:${port}`, timeout: 60_000, reuseExistingServer: false, env: { VITE_HUB_CONNECTED: "false" } },
    { command: "npm run dev -- --port 3335", url: "http://127.0.0.1:3335", timeout: 60_000, reuseExistingServer: false, env: { VITE_HUB_CONNECTED: "true", HUB_PROXY_TARGET: "http://127.0.0.1:9" } },
  ],
});
