import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { visibleRoutes } from "@/lib/auth/route-policy";
import type { Role } from "@/lib/auth/types";
import { draftOf, toBody, type HubOptions, type HubPrompt, type HubPromptPage } from "./hub-prompts-api";
import { DEFAULT_FILTER, axisOptions, filterToQuery, listSearch, patchFilter, pickedAxes, queryToFilter, visibleAxes } from "./hub-prompt-filter-model";
import { depthOptions, suggestLanguage } from "./hub-prompt-form";

// Global prompt editing (2026-10-27): the management list as first rendered (since 2026-10-28 in the
// Global prompts list's layout), its filter model, the form's body, and the renewal sidebar's HUB
// sign-in / sign-out in the local mode.

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
const { HubPromptForm } = await import("./hub-prompt-form");
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
const OPTIONS = {
  kinds: ["single", "acr"],
  language: [{ value: "ko", count: 2 }],
  regions: [{ value: "KR", count: 3 }],
  funnel: [{ value: "awareness", count: 3 }],
  brandPresence: [],
  listType: [{ value: "faq", count: 3 }, { value: "comparison", count: 0 }],
  depth1: [{ value: "ev", count: 3 }],
  depth2: [{ value: "cost", count: 0 }],
  depth3: [],
  depth4: [],
  taxonomy: [
    { field: "depth1", code: "ev", path: [] },
    { field: "depth1", code: "charging", path: [] },
    { field: "depth2", code: "range", path: ["ev"] },
    { field: "depth2", code: "cost", path: ["charging"] },
    { field: "depth3", code: "home", path: ["charging", "cost"] },
  ],
} as HubOptions;
const SAVED = { page: "hub-prompts" as const, userId: "u1", initial: [] };

describe("Global prompt management", () => {
  it("lists HUB and Gold prompts in the Global prompts list's layout, with the not-measured notice", () => {
    const out = html(<HubPromptsManager initial={PAGE} initialSearch="" options={OPTIONS} loginHref="/ko/login" savedFilters={SAVED} />);
    expect(out).toContain("글로벌 프롬프트 관리");
    expect(out).toContain("측정 미연결");
    // the left filter panel: saved filters, then the axes the catalog has values for (상태 = 사용 중 by default)
    expect(out).toContain('id="rn-filter-panel"');
    expect(out).toContain("저장한 필터");
    for (const axis of ["상태", "출처", "리스트 유형", "Depth1", "퍼널", "측정 종류", "대상 시장", "언어"]) expect(out).toContain(`<span>${axis}</span>`);
    expect(out).not.toContain("<span>Depth2</span>");
    expect(out).toContain("선택 없음");
    expect(out).toContain("표시 120 / 전체 12014");
    expect(out.match(/data-hub-prompt-row=/g)).toHaveLength(3);
    // a Gold prompt that left Gold: its own status label, muted like an archived one
    expect(out).toMatch(/text-rn-muted"><i aria-hidden="true" class="[^"]*border-dashed[^"]*"><\/i><span class="truncate">Gold에서 빠짐<\/span>/);
    expect(out).toContain(">HUB<");
    expect(out).toContain(">Gold<");
    // the taxonomy cell starts at Depth1; the tip names every level
    expect(out).toContain('data-rn-tip="리스트 유형: faq\nDepth1: ev"');
    expect(out).toContain("1–3 / 120");
    expect(out).toContain("data-hub-create");
    expect(out).toContain("링크 복사");
  });

  it("filter model: 사용 중 by default, picks in the URL, a parent resets its children, the BFF query", () => {
    expect(pickedAxes(DEFAULT_FILTER)).toEqual([]);
    expect(filterToQuery(DEFAULT_FILTER, "")).toBe("");
    const picked = patchFilter(patchFilter(patchFilter(DEFAULT_FILTER, { depth1: "ev" }), { depth2: "cost" }), { status: "all", origin: "hub" });
    expect(pickedAxes(picked)).toEqual(["status", "origin", "depth1", "depth2"]);
    expect(patchFilter(picked, { listType: "faq" })).toMatchObject({ listType: "faq", depth1: "all", depth2: "all" });
    const q = filterToQuery(picked, " ev ");
    expect(q).toBe("status=all&origin=hub&depth1=ev&depth2=cost&q=ev");
    expect(queryToFilter(q)).toEqual({ filters: picked, search: "ev" });
    expect(listSearch({ filters: picked, search: "ev", sort: "changed", asc: false, page: 3, pageSize: 25 })).toBe(
      "status=all&origin=hub&depth1=ev&depth2=cost&q=ev&sort=changed&order=desc&limit=25&offset=50",
    );
    expect(listSearch({ filters: DEFAULT_FILTER, search: "", sort: "text", asc: true, page: 1, pageSize: 50 })).toBe("status=active&origin=all&sort=text&order=asc&limit=50&offset=0");
    // used codes only; an axis without any is hidden
    expect(axisOptions("listType", OPTIONS)).toEqual(["faq"]);
    expect(axisOptions("region", OPTIONS)).toEqual(["KR"]);
    expect(visibleAxes(OPTIONS)).toEqual(["status", "origin", "listType", "depth1", "funnel", "kind", "region", "language"]);
  });

  it("form body: trimmed text, the picked codes or null", () => {
    const d = { ...draftOf(prompt({})), text: "  고친 본문 ", regions: ["KR", "x:WW"], funnel: "", depth2: "range" };
    expect(toBody(d)).toEqual({
      text: "고친 본문", kind: "single", language: "ko", regions: ["KR", "x:WW"],
      funnel: null, brandPresence: null, listType: "faq", depth1: "ev", depth2: "range", depth3: null, depth4: null,
    });
    expect(draftOf(null)).toMatchObject({ text: "", kind: "single", regions: [], funnel: "" });
  });

  it("form: the sheet's attribute rows, codes picked by name, the depth cascade, markets by continent", () => {
    const out = html(<HubPromptForm item={null} options={OPTIONS} loginHref="/ko/login" onSaved={() => {}} onCancel={() => {}} />);
    // the same labels as the sheet's 속성, in a 112px label column
    for (const label of ["브랜드 포함 여부", "언어", "리스트 유형", "Depth1", "Depth2", "Depth3", "퍼널", "대상 시장", "측정 종류"]) expect(out).toContain(`>${label}</`);
    expect(out).toContain("grid-cols-[112px_minmax(0,1fr)]");
    expect(out).toContain(">한국어 (KO)</option>");
    // Depth2 waits for Depth1; the Depth1 list is Gold's tree in natural order
    expect(out).toMatch(/<select id="hub-depth2" disabled=""[^>]*><option value=""[^>]*>Depth1 선택 후 고를 수 있습니다<\/option>/);
    expect(out).toMatch(/<select id="hub-depth1"[^>]*><option value=""[^>]*>지정 안 함<\/option><option value="charging"[^>]*>charging<\/option><option value="ev"/);
    // no market picked = 전체 (inherited); the list groups the catalog's markets by continent
    expect(out).toContain("대상 시장 미지정");
    expect(out).toContain(">아시아<");
    expect(out).toContain(">대한민국<");
    expect(out).toContain("만들고 계속 추가");
    expect(out).not.toContain("<datalist");
  });

  it("form helpers: depth codes under the picked parents, a language from the text's script", () => {
    expect(depthOptions(OPTIONS, "depth1", [])).toEqual(["charging", "ev"]);
    expect(depthOptions(OPTIONS, "depth2", ["ev"])).toEqual(["range"]);
    expect(depthOptions(OPTIONS, "depth2", [""])).toBeNull();
    expect(depthOptions(OPTIONS, "depth3", ["charging", "cost"])).toEqual(["home"]);
    // no recorded taxonomy: the codes the catalog uses
    expect(depthOptions({ ...OPTIONS, taxonomy: [] }, "depth2", [""])).toEqual(["cost"]);
    expect(suggestLanguage("현대 GENESIS 충전 요금은?", ["ko", "en"])).toBe("ko");
    expect(suggestLanguage("日本で人気のEVは?", ["ja", "zh"])).toBe("ja");
    expect(suggestLanguage("Which EV is best?", ["en"])).toBeNull();
    expect(suggestLanguage("ما هي", ["en"])).toBeNull();
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
