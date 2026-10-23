import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CatalogPage } from "@/lib/standards/catalog-page";

// ════════════════════════════════════════════════════════════════════════════
// Renewal Global prompts filters = the original /standard/prompts filters
// ════════════════════════════════════════════════════════════════════════════
//
// Product decision 2026-10-20: the renewal page keeps the original filters 100% —
// same axes in the same order, single choice with "전체" first, the same option
// lists (server facets) and labels, the same hidden-when-empty rule. This renders the
// ORIGINAL list (Select primitives swapped for pass-through components so every item
// renders) and the renewal panel from the same catalog page, and compares them.

vi.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: ({ value, children }: { value?: string; children?: ReactNode }) => <div data-select-value={value}>{children}</div>,
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectGroup: Pass,
    SelectLabel: Pass,
    SelectSeparator: () => null,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
      <div role="option" aria-selected="false" data-value={value}>
        {children}
      </div>
    ),
  };
});
let SEARCH = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/prompts",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));
vi.mock("@/app/[locale]/(dash)/standard/prompts/_actions", () => ({ fetchPromptAuditTimeline: async () => ({ ok: true, value: [] }) }));

const { StandardPromptReadonlyList } = await import("@/app/[locale]/(dash)/standard/prompts/_components/prompt-list-readonly");
const { RnPromptsView } = await import("./prompts-view");
const { patchDraft, EMPTY_FILTER } = await import("./prompt-filter-model");

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: `prompt ${id}`,
  brand: "Hyundai",
  brandPresence: "branded",
  listType: "Brand Message",
  depth1: "Innovation & Technology",
  depth2: "Autonomous car",
  depth3: null,
  depth4: null,
  funnelStage: "인지/탐색",
  kind: "single",
  regions: ["KR"],
  lang: "KO",
  scopePromptId: "s1",
  ...over,
});
function page(facets: Record<string, string[]>, columns: string[]): CatalogPage {
  const rows = [row("a"), row("b", { kind: "acr", lang: "EN", regions: ["US", "x:WW"] }), row("c", { scopePromptId: null, regions: null })];
  return { rows: rows as unknown as CatalogPage["rows"], total: rows.length, count: rows.length, offset: 0, limit: 50, facets, columns, collation: "ko" };
}
const FULL = page(
  {
    listType: ["Brand Message", "Consumer base Response"],
    depth1: ["Brand Image/key value", "Car+Features", "Innovation & Technology"],
    depth2: ["Autonomous car", "Value Awareness"],
    depth3: ["Size/Spec"],
    depth4: [],
    funnel: ["구매/사후관리", "비교/검증", "인지/탐색"],
    market: ["KR", "US", "DE", "FR", "GB", "JP", "IN", "AU", "x:WW", "x:EU"],
    marketSort: ["KR", "US", "DE", "FR", "GB", "JP", "IN", "AU", "x:WW", "x:EU"],
    lang: ["EN", "KO", "DE"],
  },
  ["depth1", "depth2", "depth3"],
);
const SPARSE = page({ listType: [], depth1: [], depth2: [], depth3: [], depth4: [], funnel: [], market: [], lang: [] }, []);

// ── minimal parser for react-dom/server markup ──
type El = { tag: string; attrs: Record<string, string>; children: El[]; text?: string; parent?: El };
const VOID = new Set(["input", "hr", "br", "img", "meta", "link", "col", "source", "wbr"]);
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  let cur = root;
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (m[1]) {
      let n: El | undefined = cur;
      while (n && n.tag !== m[1].toLowerCase()) n = n.parent;
      if (n?.parent) cur = n.parent;
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? "");
      const el: El = { tag: m[2].toLowerCase(), attrs, children: [], parent: cur };
      cur.children.push(el);
      if (!m[4] && !VOID.has(el.tag)) cur = el;
    } else if (m[5]) cur.children.push({ tag: "#text", attrs: {}, children: [], text: decode(m[5]), parent: cur });
  }
  return root;
}
const all = (n: El, pred: (e: El) => boolean, out: El[] = []): El[] => {
  for (const c of n.children) {
    if (c.tag !== "#text" && pred(c)) out.push(c);
    all(c, pred, out);
  }
  return out;
};
const text = (n: El): string => (n.tag === "#text" ? n.text ?? "" : n.children.map(text).join("")).replace(/\s+/g, " ").trim();
type Axis = { label: string; options: [string, boolean][] };

function originalFilters(html: string): Axis[] {
  return all(parse(html), (e) => e.tag === "label" && (e.attrs.for ?? "").startsWith("sp-view-")).map((label) => {
    const select = all(label.parent!, (e) => "data-select-value" in e.attrs)[0];
    return { label: text(label), options: all(select, (e) => e.attrs.role === "option").map((o) => [text(o), o.attrs["data-value"] === select.attrs["data-select-value"]]) };
  });
}
function renewalFilters(html: string): Axis[] {
  const block = all(parse(html), (e) => e.attrs["data-rn-section"] === "prompt")[0];
  return block.children
    .filter((c) => c.tag === "section")
    .map((sec) => ({
      label: text(sec.children[0].children.filter((c) => c.tag === "span")[0]),
      options: all(sec, (e) => e.attrs.role === "radio").map((r) => [text(r.children.filter((c) => c.tag === "span")[1]), r.attrs["aria-checked"] === "true"]),
    }));
}
const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
const remote = (p: CatalogPage) => ({ initial: p, load: async () => p, rows: async () => p });

describe("renewal Global prompts filters = the original filters", () => {
  it.each([
    ["full facets", FULL],
    ["sparse facets (empty axes hide)", SPARSE],
  ] as const)("%s", (_l, p) => {
    SEARCH = "";
    const original = originalFilters(
      wrap(<StandardPromptReadonlyList rows={p.rows as never} remote={remote(p)} scopeAll scopeRole="admin" scopeBrands={[]} scopeRegions={[]} scopeCountries={[]} />),
    );
    const renewal = renewalFilters(
      wrap(
        <RnPromptsView
          remote={remote(p)}
          scopeAll
          scopeRole="admin"
          scopeBrands={[]}
          scopeRegions={[]}
          scopeCountries={[]}
          period={null}
          auditRows={[]}
          initialTab="catalog"
          storageKey="test"
          defaultOpen="all"
        />,
      ),
    );
    expect(original.length).toBeGreaterThanOrEqual(3);
    expect(renewal).toEqual(original);
  });

  it("a parent pick resets its children (the original updateDraft)", () => {
    const d = { ...EMPTY_FILTER, listType: "A", depth1: "B", depth2: "C", depth3: "D", depth4: "E", funnel: "F" };
    expect(patchDraft(d, { depth1: "X" })).toEqual({ ...d, depth1: "X", depth2: "all", depth3: "all", depth4: "all" });
    expect(patchDraft(d, { listType: "Y" })).toEqual({ ...d, listType: "Y", depth1: "all", depth2: "all", depth3: "all", depth4: "all" });
    expect(patchDraft(d, { funnel: "G" })).toEqual({ ...d, funnel: "G" });
  });

  it("picks from the URL show as checked (and only those)", () => {
    SEARCH = "kind=acr&lang=EN";
    const renewal = renewalFilters(
      wrap(
        <RnPromptsView remote={remote(FULL)} scopeAll scopeRole="admin" scopeBrands={[]} scopeRegions={[]} scopeCountries={[]} period={null} auditRows={[]} initialTab="catalog" storageKey="test" defaultOpen="all" />,
      ),
    );
    const checked = renewal.flatMap((a) => a.options.filter(([, on]) => on).map(([l]) => `${a.label}=${l}`));
    expect(checked).toContain(`${ko.standardPromptsView.kindLabel}=${ko.standardPromptsView.kindAcr}`);
    expect(checked.filter((c) => !c.endsWith(`=${ko.standardPromptsView.filterAll}`))).toHaveLength(2);
  });
});
