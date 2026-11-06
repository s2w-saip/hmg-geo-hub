import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3334", viewport: { width: 1920, height: 915 }, trace: "retain-on-failure" },
  webServer: [
    { command: "npm run dev", url: "http://127.0.0.1:3334", timeout: 60_000, reuseExistingServer: false, env: { VITE_HUB_CONNECTED: "false" } },
    { command: "npm run dev -- --port 3335", url: "http://127.0.0.1:3335", timeout: 60_000, reuseExistingServer: false, env: { VITE_HUB_CONNECTED: "true", HUB_PROXY_TARGET: "http://127.0.0.1:9" } },
  ],
});
