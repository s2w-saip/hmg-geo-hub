import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Production Admin items without a page here (2026-10-28): the notice under the menu label; any other path a 404.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => {},
  getTranslations: async (ns: string) => (k: string) => `${ns}:${k}`,
}));

const { default: Page } = await import("./page");
const render = async (slug: string[]) => renderToStaticMarkup(await Page({ params: Promise.resolve({ locale: "ko", slug }) }));

describe("admin not-implemented page", () => {
  it.each([
    [["analysis"], "nav:adminAnalysis"],
    [["reports"], "nav:adminReports"],
    [["credits"], "nav:adminCredits"],
  ])("shows the notice for /admin/%s", async (slug, title) => {
    const html = await render(slug);
    expect(html).toContain("data-unimplemented");
    expect(html).toContain(title);
    expect(html).toContain("unimplemented:body");
  });

  it.each([["credits", "x"], ["standards", "nope"], ["nope"]])("is a 404 for /admin/%s (not a menu item)", async (...slug) => {
    await expect(render(slug)).rejects.toThrow("NOT_FOUND");
  });
});
