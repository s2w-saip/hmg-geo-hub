import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { User } from "@/lib/auth/types";

// Renewal shell layout (S급, 2026-10-23): the same session redirect, route guard and page
// title as the (dash) layout, and the sidebar gets the routes this account may open.
// Components are stubbed; the test reads the props the layout hands to RnSidebar.

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
const req = vi.hoisted(() => ({ pathname: "/ko/renewal/dashboard", user: null as User | null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-pathname": req.pathname }) }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/perf/nocache-probe", () => ({ perfNoCacheActive: async () => false }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => (req.user ? { user: req.user } : null) }));
vi.mock("sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/dash/beta-notice", () => ({ BetaNoticeDialog: () => null }));
vi.mock("./_shell/rn-sidebar", () => ({
  RnSidebar: function RnSidebar() {
    return null;
  },
}));
vi.mock("./_shell/beta-toast", () => ({ RnBetaToast: () => null }));
vi.mock("./_shell/nav-pending", () => ({
  RnNavPendingProvider: ({ children }: { children: ReactNode }) => children,
  RnNavMain: ({ children }: { children: ReactNode }) => children,
}));

const { default: RenewalLayout, generateMetadata } = await import("./layout");
const { RnSidebar } = await import("./_shell/rn-sidebar");

function user(role: User["role"], menuGroups: User["menuGroups"] = null): User {
  return { id: "u1", email: `${role}@example.test`, role, scope: { all: true }, operator: "global", menuGroups } as User;
}

function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return find((node.props as { children?: ReactNode }).children, type);
}

async function render(pathname: string, u: User | null) {
  req.pathname = pathname;
  req.user = u;
  return RenewalLayout({ children: "page", params: Promise.resolve({ locale: "ko" }) });
}

beforeEach(() => {
  req.pathname = "/ko/renewal/dashboard";
  req.user = null;
});

describe("renewal layout", () => {
  it("sends a visitor without a session to login", async () => {
    await expect(render("/ko/renewal/dashboard", null)).rejects.toThrow("REDIRECT:/ko/login");
  });

  it("guards like the (dash) layout: a role outside the Global viewers gets no-access", async () => {
    await expect(render("/ko/renewal/dashboard", user("vendor"))).rejects.toThrow("REDIRECT:/ko/no-access");
  });

  it("guards on menuGroups: an account narrowed to website gets no-access", async () => {
    await expect(render("/ko/renewal/standard/prompts", user("hq", ["website"]))).rejects.toThrow("REDIRECT:/ko/no-access");
  });

  it.each(["/ko/renewal/dashboard", "/ko/renewal/standard/answer-analysis/citation/prompts", "/en/renewal/standard/ai-funnel/acr"])(
    "lets a country account open %s",
    async (path) => {
      const out = await render(path, user("country"));
      expect(find(out, RnSidebar)).not.toBeNull();
    },
  );

  it("hands the sidebar the visible routes: admin sees Admin, a country account does not", async () => {
    const admin = find(await render("/ko/renewal/dashboard", user("admin")), RnSidebar)!;
    const adminPaths = (admin.props.routes as Array<{ path: string }>).map((r) => r.path);
    expect(adminPaths).toContain("/renewal/dashboard");
    expect(adminPaths).toContain("/admin");
    expect(admin.props.user).toEqual({ email: "admin@example.test", role: "admin" });

    const country = find(await render("/ko/renewal/dashboard", user("country")), RnSidebar)!;
    const countryPaths = (country.props.routes as Array<{ path: string }>).map((r) => r.path);
    expect(countryPaths).toContain("/renewal/standard/ai-funnel/acr");
    expect(countryPaths.some((p) => p.startsWith("/admin"))).toBe(false);
    // hidden routes never reach the menu
    expect(countryPaths).not.toContain("/standard/ai-funnel/visibility");
  });

  it("titles the tab with the menu label, like the (dash) layout", async () => {
    req.pathname = "/ko/renewal/standard/prompts";
    const meta = await generateMetadata({ params: Promise.resolve({ locale: "ko" }) });
    expect(meta.title).toBe("renewalStandardPrompts · name");
  });
});
