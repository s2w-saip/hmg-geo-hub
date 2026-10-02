import { test as setup } from "@playwright/test";
import { blockExternal, latestTraceValue, loadAccounts, loadScreens, newBrowserLog, prepareContext, qaPassword, statePath } from "./harness";
import { loginViaForm, qaGateLogin, settle } from "./flows";

// Setup project (not a screen check). 1) Logs every account the screens use in through the real
// login form once and keeps the browser storage state (e2e/.run/state/<KEY>.json, local only).
// "QA" = ADMIN's Supabase session plus a QA reviewer cookie from the real gate. 2) Visits every
// screen path once so next dev compiles it here and not inside a screen's 30 s budget.
setup("warmup: account sessions and route compile", async ({ browser }) => {
  const doc = loadScreens();
  const { password, accounts } = loadAccounts();
  const byKey = new Map(accounts.map((a) => [a.key, a]));
  const active = doc.screens.filter((s) => s.cases.length > 0);

  const needed = new Set<string>(["ADMIN"]);
  for (const s of active) for (const c of s.cases) if (c.account && c.account !== "QA") needed.add(c.account);

  for (const key of needed) {
    const account = byKey.get(key);
    if (!account) throw new Error(`screens.json uses unknown account ${key}`);
    const context = await browser.newContext();
    await blockExternal(context, newBrowserLog());
    await prepareContext(context);
    const page = await context.newPage();
    await loginViaForm(page, account.email, password);
    await context.storageState({ path: statePath(key) });
    console.log(`[warmup] ${key} -> ${new URL(page.url()).pathname}`);
    await context.close();
  }

  {
    const context = await browser.newContext({ storageState: statePath("ADMIN") });
    await blockExternal(context, newBrowserLog());
    await prepareContext(context);
    const page = await context.newPage();
    const status = await qaGateLogin(page, "e2e-warmup", qaPassword());
    if (status !== 200) throw new Error(`QA gate login failed in warmup (${status})`);
    await context.storageState({ path: statePath("QA") });
    console.log(`[warmup] QA -> ${new URL(page.url()).pathname}`);
    await context.close();
  }

  const visits = new Map<string, string>();
  for (const s of active) {
    for (const c of s.cases) {
      const path = c.path ?? s.path;
      if (path.includes("{") && !c.resolve) continue;
      const account = c.account === null ? "ADMIN" : c.account;
      if (!visits.has(path)) visits.set(path, account);
      if (c.resolve && !visits.has(c.resolve.from)) visits.set(c.resolve.from, account);
    }
  }
  for (const [rawPath, account] of visits) {
    const context = await browser.newContext({ storageState: statePath(account) });
    await blockExternal(context, newBrowserLog());
    await prepareContext(context);
    const page = await context.newPage();
    let path = rawPath;
    const m = rawPath.match(/\{(\w+)\}/);
    if (m) {
      const s = active.find((x) => x.cases.some((c) => c.resolve?.var === m[1]));
      const r = s?.cases.find((c) => c.resolve?.var === m[1])?.resolve;
      const v = r ? latestTraceValue(r.route, r.jsonPath) : null;
      if (v === null) {
        await context.close();
        continue;
      }
      path = rawPath.replace(`{${m[1]}}`, encodeURIComponent(String(v)));
    }
    const t0 = Date.now();
    const res = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 180_000 }).catch(() => null);
    await settle(page);
    console.log(`[warmup] compiled ${rawPath} as ${account}: ${res?.status() ?? "no response"} in ${Date.now() - t0} ms`);
    if (/\/raw-data-qa\/answers\/[^/?]+/.test(path)) {
      // The detail page took an answer lock: leave it so the pagehide beacon releases it.
      const released = page
        .waitForResponse((r) => new URL(r.url()).pathname === "/api/qa/lock" && new URL(r.url()).searchParams.get("release") === "1", { timeout: 5_000 })
        .catch(() => null);
      await page.goto("about:blank").catch(() => undefined);
      await released;
    }
    await context.close();
  }
});
