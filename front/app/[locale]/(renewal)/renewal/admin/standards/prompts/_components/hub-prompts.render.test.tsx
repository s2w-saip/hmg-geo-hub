import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { visibleRoutes } from "@/lib/auth/route-policy";
import type { Role } from "@/lib/auth/types";
import { draftOf, listSearch, toBody, type HubOptions, type HubPrompt, type HubPromptPage } from "./hub-prompts-api";

// Global prompt editing (2026-10-27): the management list as first rendered, the form's body, and the
// renewal sidebar's HUB sign-in / sign-out in the local mode.

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("tab=x") }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => "/renewal/dashboard",
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));
vi.mock("@/lib/auth/actions", () => ({ logout: async () => {} }));

const { HubPromptsManager } = await import("./hub-prompts-manager");
const { RnSidebar } = await import("@/app/[locale]/(renewal)/_shell/rn-sidebar");

const html = (ui: ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );

const prompt = (over: Partial<HubPrompt>): HubPrompt => ({
  id: "8f6f0c1e-2b7a-4c1e-9d2a-1b2c3d4e5f60",
  origin: "hub",
  editable: true,
  version: 2,
  text: "EV 충전 요금은?",
  kind: "single",
  language: "ko",
  regions: ["KR"],
  status: "active",
  recordedAt: "2026-10-27T03:00:00Z",
  registeredAt: "2026-10-27T03:00:00Z",
  funnel: "awareness",
  brandPresence: null,
  listType: "faq",
  depth1: "ev",
  depth2: null,
  depth3: null,
  depth4: null,
  ...over,
});
const PAGE: HubPromptPage = {
  items: [
    prompt({}),
    prompt({ id: "0000122c-6880-476f-986a-5004d76eee97", origin: "gold", editable: false, version: 1, text: "Gold prompt", kind: "acr" }),
    prompt({ id: "0000122c-6880-476f-986a-5004d76eee98", origin: "gold", editable: false, version: 3, text: "Left Gold", status: "removed" }),
  ],
  page: { total: 120, limit: 50, offset: 0 },
  counts: { total: 12014, hub: 1, gold: 12013, archived: 0, removed: 1 },
};
const OPTIONS = { kinds: ["single", "acr"], language: [], regions: [], funnel: [], brandPresence: [], listType: [], depth1: [], depth2: [], depth3: [], depth4: [] } as HubOptions;

describe("Global prompt management", () => {
  it("lists HUB and Gold prompts with their source, status, version and the not-measured notice", () => {
    const out = html(<HubPromptsManager initial={PAGE} options={OPTIONS} loginHref="/ko/login" />);
    expect(out).toContain("글로벌 프롬프트 관리");
    expect(out).toContain("측정 미연결");
    expect(out).toContain("전체 12,014 · HUB 1 · Gold 12,013 · 보관 0 · Gold에서 빠짐 1");
    expect(out.match(/data-hub-prompt-row=/g)).toHaveLength(3);
    // a Gold prompt that left Gold: its own status label, muted like an archived one
    expect(out).toContain('<span class="text-rn-muted">Gold에서 빠짐</span>');
    expect(out).toContain(">HUB<");
    expect(out).toContain(">Gold<");
    expect(out).toContain("faq › ev");
    expect(out).toContain("1–50 / 120");
    expect(out).toContain("data-hub-create");
  });

  it("form body: trimmed text, codes or null, markets split on commas and spaces", () => {
    const d = { ...draftOf(prompt({})), text: "  고친 본문 ", regions: "kr, US  x:ww,", funnel: " ", depth2: "charging" };
    expect(toBody(d)).toEqual({
      text: "고친 본문", kind: "single", language: "ko", regions: ["kr", "US", "x:ww"],
      funnel: null, brandPresence: null, listType: "faq", depth1: "ev", depth2: "charging", depth3: null, depth4: null,
    });
    expect(draftOf(null)).toMatchObject({ text: "", kind: "single", regions: "", funnel: "" });
    expect(listSearch({ q: " ev ", status: "all", origin: "hub", offset: 50 })).toBe("status=all&origin=hub&limit=50&offset=50&q=ev");
  });
});

describe("renewal sidebar · HUB login (local mode)", () => {
  const sidebar = (role: Role, local?: boolean) => html(<RnSidebar routes={visibleRoutes(role)} user={{ email: role === "admin" ? "admin" : "geo_readonly", role, local }} locale="ko" />);

  const logout = `aria-label="${ko.nav.logout}"`;

  it("gives the signed-in administrator the HUB sign-out and the admin menu; elsewhere the Supabase form stays", () => {
    const local = sidebar("admin", true);
    expect(local).toContain(logout);
    expect(local).not.toContain("<form");
    expect(local).toContain('href="/renewal/admin/standards/prompts"');
    // every local page is behind the HUB login (2026-10-28): no sign-in link in the shell
    expect(local).not.toContain("/ko/login");
    expect(sidebar("admin")).toContain("<form");
  });
});
