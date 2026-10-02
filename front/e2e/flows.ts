import type { Page } from "@playwright/test";
import { readMessage } from "./harness";

// UI steps shared by the warmup and the screen cases. They drive the real forms (login server
// action, QA gate route) exactly as a user does; nothing here writes cookies by hand.

/** Submit the login form and wait for the server action answer and the navigation it triggers. */
export async function loginViaForm(page: Page, email: string, password: string, locale = "ko"): Promise<void> {
  await page.goto(`/${locale}/login`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  const action = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/${locale}/login`, {
    timeout: 20_000,
  });
  await page.locator("form button[type=submit]").click();
  // The action answer carries the redirect target's RSC payload: wait for the whole body, then
  // for the client router to commit the navigation.
  await action;
  // Success: the client router leaves the login page (the redirect target streams in the action
  // answer). Failure: the form shows its error. Whichever comes first, then let the page settle.
  await Promise.race([
    page.waitForURL((u) => u.pathname !== `/${locale}/login`, { timeout: 15_000, waitUntil: "commit" }),
    page.getByText(readMessage("login.error", locale), { exact: true }).waitFor({ timeout: 15_000 }),
  ]).catch(() => undefined);
  await settle(page);
}

/** Wait until the page path is `want` (client navigations commit after their RSC stream ends). */
export async function waitForPath(page: Page, want: string, timeout = 15_000): Promise<void> {
  await page.waitForURL((u) => u.pathname === want, { timeout, waitUntil: "commit" }).catch(() => undefined);
  await settle(page);
}

/** Enter the QA console through the gate form (name + shared password). */
export async function qaGateLogin(page: Page, reviewer: string, password: string, locale = "ko"): Promise<number> {
  await page.goto(`/${locale}/raw-data-qa`, { waitUntil: "domcontentloaded" });
  await settle(page); // controlled inputs: typing before hydration never reaches React state
  await page.locator("#qa-name").fill(reviewer);
  await page.locator("#qa-password").fill(password);
  const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/qa/session", {
    timeout: 20_000,
  });
  await page.locator("form button[type=submit]").click();
  const res = await answer;
  if (res.ok()) await waitForPath(page, `/${locale}/raw-data-qa/answers`);
  else await settle(page);
  return res.status();
}

/** Wait until the page stopped loading and the network went quiet (polling pages never go fully idle). */
export async function settle(page: Page, idleMs = 8_000): Promise<void> {
  await page.waitForLoadState("load").catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: idleMs }).catch(() => undefined);
  await page.waitForTimeout(300);
}

export const QA_ADD_NOTE = () => readMessage("qaReview.detail.addNote");
export const QA_SAVE = () => readMessage("qaReview.common.save");
export const QA_SIGN_OUT = () => readMessage("qaReview.common.signOut");
