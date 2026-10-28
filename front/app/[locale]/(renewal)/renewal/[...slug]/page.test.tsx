import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The renewal "not implemented" page (2026-10-28): a menu item without a renewal page shows the notice
// under its menu label, a menu parent opens its first child, and any other path is a 404.

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => {},
  getTranslations: async (ns: string) => (k: string) => `${ns}:${k}`,
}));

const { default: Page } = await import("./page");
const render = async (path: string) =>
  renderToStaticMarkup(await Page({ params: Promise.resolve({ locale: "ko", slug: path.split("/").filter(Boolean) }) }));

describe("renewal not-implemented page", () => {
  it.each([
    ["/website/prompts", "nav:websitePrompts"],
    ["/standard/ai-funnel/conversion", "nav:aiFunnelConversion"],
    ["/projects", "nav:projects"],
    ["/admin/credits", "nav:adminCredits"],
  ])("shows the notice for %s under its menu label", async (path, title) => {
    const html = await render(path);
    expect(html).toContain("data-rn-unimplemented");
    expect(html).toContain(title);
    expect(html).toContain("unimplemented:label");
  });

  it("opens a menu parent's first child", async () => {
    await expect(render("/website/ai-funnel")).rejects.toThrow("REDIRECT:/ko/renewal/website/ai-funnel/conversion");
    await expect(render("/admin/standards")).rejects.toThrow("REDIRECT:/ko/renewal/admin/standards/prompts");
  });

  it.each(["/website/prompts/x", "/customer-interest", "/projects/new", "/renewal/dashboard"])("is a 404 for %s (not a menu item)", async (path) => {
    await expect(render(path)).rejects.toThrow("NOT_FOUND");
  });
});
