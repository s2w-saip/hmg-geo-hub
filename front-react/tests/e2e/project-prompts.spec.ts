import { test, expect } from "@playwright/test";
import { mockHub, testProject } from "./hub-contract";

const hub = "http://127.0.0.1:3335";
const prompt = "33333333-3333-4333-8333-333333333333";
const row = { id: prompt, text: "Which SUV has the best range?", kind: "single", lang: "en", custom: {}, status: "active", state: "applied", version: 3, origin: "hub", funnel: null, regions: null, targets: [], answers: 0, firstMeasured: null, lastMeasured: null, rounds: [], countries: [], engineAnswers: {} };
const view = (status: string, version: number) => ({ rows: [{ ...row, status, version }], listed: 1, fields: [], editable: true, languages: ["en"], rounds: [] });
const filters = { geographyOptions: [], engineOptions: [], dynamicAxes: [], selectableDates: [], latestAnchorDay: null, collectionStartDay: null };

test("deleting a project prompt asks once, sends its version, and moves it to the deleted tab; restoring brings it back", async ({ page }) => {
  let status = "active", version = 3;
  const writes: { path: string; body: unknown }[] = [];
  const trace = await mockHub(page, async (url, request) => {
    if (url.pathname === "/api/screens/projects/prompts") return { body: view(status, version) };
    if (url.pathname === "/api/screens/projects/filters") return { body: filters };
    if (url.pathname === `/api/hub/projects/${testProject}/prompts/${prompt}/history`) return { body: { data: { history: [] } } };
    const action = url.pathname.match(new RegExp(`/api/hub/projects/${testProject}/prompts/${prompt}/(archive|restore)$`))?.[1];
    if (action && request.method() === "POST") {
      writes.push({ path: action, body: request.postDataJSON() });
      status = action === "archive" ? "archived" : "active";
      version += 1;
      return { body: { data: { changed: true } } };
    }
  });
  await page.goto(`${hub}/ko/renewal/projects/${testProject}/prompt`);
  const line = page.locator(`[data-rn-project-prompt-row="${prompt}"]`);
  await line.locator("td").nth(2).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('[data-rn-prompt-action="archive"]').click();

  // the first press only asks; cancelling sends nothing
  await expect(dialog.getByRole("alertdialog")).toBeVisible();
  await dialog.getByRole("alertdialog").getByRole("button").first().click();
  await expect(dialog.getByRole("alertdialog")).toHaveCount(0);
  expect(writes).toEqual([]);

  await dialog.locator('[data-rn-prompt-action="archive"]').click();
  await dialog.locator("[data-rn-prompt-archive-confirm]").click();
  await expect.poll(() => writes).toEqual([{ path: "archive", body: { expectedVersion: 3 } }]);
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: /^삭제됨/ }).click();
  await expect(line).toBeVisible();

  await line.locator("td").nth(2).click();
  await page.getByRole("dialog").locator('[data-rn-prompt-action="restore"]').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ path: "restore", body: { expectedVersion: 4 } });
  expect(trace.errors).toEqual([]);
});
