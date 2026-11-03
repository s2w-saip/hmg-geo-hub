import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Role } from "@/lib/auth/types";

// A project tab's pages (menu option D, 2026-11-03): the original project menu's paths, each "not implemented" yet under
// its menu label; a menu parent opens its first child, any other path is a 404; the administrator's only. The browser
// tab's title names the project.

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
  getTranslations: async (ns: string | { namespace: string }) => (k: string) => `${typeof ns === "string" ? ns : ns.namespace}:${k}`,
}));
let ROLE: Role = "admin";
vi.mock("@/lib/auth/session", () => ({ getSession: async () => ({ user: { role: ROLE } }) }));

const { default: Page, generateMetadata } = await import("./page");
const ID = "843ecb1b-39ff-4a7c-9b3a-0c3f7f8a9e10";
const params = (sub: string) => Promise.resolve({ locale: "ko", id: ID, sub: sub.split("/") });
const render = async (sub: string) => renderToStaticMarkup(await Page({ params: params(sub) }));

describe("project tab page", () => {
  it.each([
    ["analysis/mention", "nav.projectDetail:analysisMention"],
    ["ai-funnel/conversion", "nav.projectDetail:aiFunnelConversion"],
    ["setting", "nav.projectDetail:general"],
    ["member", "nav.projectDetail:member"],
  ])("shows the notice for '%s' under its menu label", async (sub, title) => {
    const html = await render(sub);
    expect(html).toContain("data-rn-unimplemented");
    expect(html).toContain(title);
    expect(html).toContain("unimplemented:label");
  });

  it("opens a menu parent's first child", async () => {
    await expect(render("intent")).rejects.toThrow(`REDIRECT:/ko/renewal/projects/${ID}/intent/google-keyword`);
    await expect(render("analysis")).rejects.toThrow(`REDIRECT:/ko/renewal/projects/${ID}/analysis/mention`);
  });

  it.each(["ai-funnel/acr", "ai-funnel/visibility", "analysis/mention/x", "new"])("is a 404 for '%s' (not in the menu)", async (sub) => {
    await expect(render(sub)).rejects.toThrow("NOT_FOUND");
  });

  it("is the administrator's", async () => {
    ROLE = "hq";
    try {
      await expect(render("analysis/mention")).rejects.toThrow("REDIRECT:/ko/no-access");
    } finally {
      ROLE = "admin";
    }
  });

  it("names the project in the browser tab's title", async () => {
    expect((await generateMetadata({ params: params("analysis/citation") })).title).toBe("nav.projectDetail:analysisCitation · 843ecb1b · app:name");
  });
});
