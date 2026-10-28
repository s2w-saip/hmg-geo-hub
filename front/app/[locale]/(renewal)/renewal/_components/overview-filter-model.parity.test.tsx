import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";

// ════════════════════════════════════════════════════════════════════════════
// Renewal Overview filter panel = the app's Overview filter panel
// ════════════════════════════════════════════════════════════════════════════
//
// The renewal page must carry exactly the app's filters (product decision
// 2026-10-20: "필터의 종류와 데이터가 일치해야 한다"). This test renders the REAL
// OverviewFilters (DimensionFilterPanel) and the renewal panel for the same account
// scope, option data and URL, and compares what each shows: section rows, axis
// order, option labels in order, group headers, checked / disabled state, search
// boxes and time presets. Only the presentation (left panel vs dropdown chips) and
// the apply timing (instant vs 적용 button) may differ.
//
// Dropdown primitives are swapped for pass-through components (as in
// dimension-filter-panel.open-menu.test.tsx) so the app's menu contents render.

vi.mock("@/components/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Item = ({
    children,
    checked,
    disabled,
    onCheckedChange: _c,
    onSelect: _s,
    ...rest
  }: { children?: ReactNode; checked?: boolean; disabled?: boolean; onCheckedChange?: unknown; onSelect?: unknown } & Record<string, unknown>) => (
    <div role="menuitemcheckbox" aria-checked={checked ? "true" : "false"} aria-disabled={disabled ? "true" : undefined} {...rest}>
      {children}
    </div>
  );
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => <div data-testid="menu-content">{children}</div>,
    DropdownMenuCheckboxItem: Item,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuLabel: Pass,
    DropdownMenuGroup: Pass,
    DropdownMenuItem: ({ children }: { children?: ReactNode }) => <div data-clear-item="">{children}</div>,
    DropdownMenuPortal: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuRadioGroup: Pass,
    DropdownMenuRadioItem: Item,
    DropdownMenuShortcut: Pass,
  };
});

let SEARCH = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/dashboard",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { OverviewFilters } = await import("@/app/[locale]/(dash)/dashboard/_components/overview-filters");
const { deriveMatrixOptions } = await import("@/components/dash/dimension-filter-panel");
const { effectiveScopeCountries } = await import("@/lib/rhq");
const { RnFilterRuntime } = await import("./filter-runtime");
const { RnOverviewFilters, RnOverviewFilterPanel } = await import("./overview-filters");

// ── fixture: option data in the app's shapes ────────────────────────────────
type Combo = { brand: string | null; region: string; lang: string | null };
const LANGS: Record<string, string[]> = { KR: ["ko"], US: ["en", "es"], CA: ["en", "fr"], MX: ["es"], DE: ["de"], FR: ["fr"], GB: ["en"], AE: ["ar", "en"], SA: ["ar"], IL: ["he"], JP: ["ja"], worldwide: ["en"] };
const MEASURED: Record<string, string[]> = {
  Hyundai: ["KR", "US", "CA", "MX", "DE", "FR", "GB", "AE", "SA", "JP", "worldwide"],
  Kia: ["US", "DE", "AE", "IL", "KR"],
  Genesis: ["KR", "US", "DE"],
};
const MATRIX: Combo[] = Object.entries(MEASURED).flatMap(([brand, cs]) => cs.flatMap((region) => LANGS[region].map((lang) => ({ brand, region, lang }))));
const row = (brand: string, brandPresence: string, listType: string, depth1: string, depth2: string, depth3: string | null) => ({ brand, brandPresence, listType, depth1, depth2, depth3, depth4: null });
const CATALOG = [
  row("Hyundai", "branded", "Brand Message", "Innovation & Technology", "Autonomous car", null),
  row("Hyundai", "unbranded", "Brand Message", "Brand Image/key value", "Value Awareness", null),
  row("Hyundai", "unbranded", "Consumer base Response", "Car+Features", "Features_Size/Spec", "Size/Spec"),
  row("Kia", "branded", "Brand Message", "Human & Sustainable Mobility", "Social Responsibility", null),
  row("Kia", "unbranded", "Consumer base Response", "Compare+Car/Features", "Compare_Size/Spec", "Size/spec"),
  row("Genesis", "branded", "Consumer base Response", "Car Ownership", "Ownership_Support", "Support"),
];
const ROUNDS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"];
type Scope = { all: boolean; brands?: string[]; regions?: string[]; countries?: string[] };
const SCOPES: Record<"admin" | "hq" | "region" | "country", Scope> = {
  admin: { all: true },
  hq: { all: false, brands: ["Hyundai"] },
  region: { all: false, brands: ["Hyundai"], regions: ["hyundai-europe"] },
  country: { all: false, brands: ["Hyundai"], countries: ["KR"] },
};

function optionsFor(role: keyof typeof SCOPES, url: string) {
  const scope = SCOPES[role];
  // listMeasuredScopeMatrix gates by account scope only (never by the user's picks)
  const allowed = effectiveScopeCountries(scope);
  const matrix = MATRIX.filter(
    (r) => scope.all || ((!allowed || allowed.includes(r.region)) && (!scope.brands?.length || r.brand === null || scope.brands.includes(r.brand))),
  );
  const urlBrand = new URLSearchParams(url).get("brand")?.split("~") ?? null;
  // listMeasuredRegions / listMeasuredStandardLanguages: scope + applied brand
  const applied = deriveMatrixOptions(matrix, scope.all ? urlBrand : null, undefined);
  return {
    scope: { ...scope },
    catalogRows: CATALOG,
    geographyOptions: applied.regions,
    languageOptions: applied.languages,
    optionMatrix: matrix,
    collectionStartDay: "2026-09-07T12:00:00.000Z",
    latestAnchorDay: "2026-10-19",
    selectableDates: ROUNDS,
  };
}

// ── minimal parser for react-dom/server markup (quoted attributes, void tags) ──
type El = { tag: string; attrs: Record<string, string>; children: El[]; text?: string; parent?: El };
const VOID = new Set(["input", "hr", "br", "img", "meta", "link", "area", "col", "source", "wbr"]);
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let cur = root;
  for (const m of html.matchAll(re)) {
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
const hasClass = (e: El, c: string) => (e.attrs.class ?? "").split(/\s+/).includes(c);
const ownText = (n: El) => n.children.filter((c) => c.tag === "#text").map((c) => c.text).join("").trim();

type Axis = { label: string; search?: boolean; groups?: { header: string; items: [string, string][] }[]; presets?: [string, string, boolean][] };

function appStructure(html: string): { sections: string[]; axes: Axis[] } {
  const root = parse(html);
  const sections = all(root, (e) => "data-section-label" in e.attrs).map(text);
  const axes: Axis[] = [];
  for (const btn of all(root, (e) => e.tag === "button" && hasClass(e, "facet-chip"))) {
    const label = text(all(btn, (e) => hasClass(e, "truncate"))[0]);
    const content = all(btn.parent!.parent!, (e) => e.attrs["data-testid"] === "menu-content")[0];
    if (label === ko.dashboard.filters.group.time) {
      axes.push({
        label,
        presets: all(content, (e) => "data-preset" in e.attrs).map((e) => [text(e), e.attrs["aria-checked"], e.attrs["aria-disabled"] === "true"]),
      });
      continue;
    }
    const groups: { header: string; items: [string, string][] }[] = [{ header: "", items: [] }];
    for (const e of all(content, (x) => x.tag === "button" || x.attrs.role === "menuitemcheckbox")) {
      if (e.tag === "button") groups.push({ header: text(e), items: [] });
      else groups[groups.length - 1].items.push([text(e), e.attrs["aria-checked"]]);
    }
    axes.push({ label, search: all(content, (e) => e.tag === "input" && e.attrs.type === "text").length > 0, groups: groups.filter((g) => g.header || g.items.length) });
  }
  return { sections, axes };
}

function renewalStructure(html: string): { sections: string[]; axes: Axis[] } {
  const root = parse(html);
  const blocks = all(root, (e) => "data-rn-section" in e.attrs);
  const sections = blocks.map((b) => text(b.children[0]));
  const axes: Axis[] = [];
  for (const sec of blocks.flatMap((b) => b.children.filter((c) => c.tag === "section"))) {
    const head = sec.children[0];
    const label = text(head.children.filter((c) => c.tag === "span")[0]);
    const rows = all(sec, (e) => e.attrs.role === "checkbox");
    const rowLabel = (r: El) => text(r.children.filter((c) => c.tag === "span")[1]);
    if (label === ko.dashboard.filters.group.time) {
      axes.push({ label, presets: rows.map((r) => [rowLabel(r), r.attrs["aria-checked"], r.attrs["aria-disabled"] === "true"]) });
      continue;
    }
    const groups: { header: string; items: [string, string][] }[] = [{ header: "", items: [] }];
    for (const e of all(sec, (x) => (x.tag === "button" && "aria-pressed" in x.attrs) || x.attrs.role === "checkbox")) {
      if (e.tag === "button") groups.push({ header: ownText(e) || text(e), items: [] });
      else groups[groups.length - 1].items.push([rowLabel(e), e.attrs["aria-checked"]]);
    }
    axes.push({ label, search: all(sec, (e) => e.tag === "input" && e.attrs.type !== "date").length > 0, groups: groups.filter((g) => g.header || g.items.length) });
  }
  return { sections, axes };
}

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );

const CASES: ReadonlyArray<[label: string, role: keyof typeof SCOPES, url: string]> = [
  ["admin · no filter", "admin", ""],
  ["admin · one brand (권역 axis + RHQ groups)", "admin", "brand=Hyundai"],
  ["admin · brand + countries (languages narrow)", "admin", "brand=Hyundai&geography=DE~FR"],
  ["admin · two brands (no 권역)", "admin", "brand=Hyundai~Kia"],
  ["admin · catalog cascade under brand", "admin", "brand=Kia&listType=Brand+Message"],
  ["admin · weekly preset + language", "admin", "brand=Genesis&language=en&time=2026-10-13..2026-10-19"],
  ["HQ · no filter", "hq", ""],
  ["HQ · countries + custom period", "hq", "geography=KR~US&time=2026-09-20..2026-10-19"],
  ["권역담당 · 권역 hidden", "region", "engine=chatgpt"],
  ["국가담당 · 국가 hidden", "country", "promptContext=%EB%B9%84%EA%B5%90%2F%EA%B2%80%EC%A6%9D"],
];

describe("renewal Overview filter panel shows exactly the app's filters", () => {
  it.each(CASES)("%s", (_label, role, url) => {
    SEARCH = url;
    const opts = optionsFor(role, url);
    const app = appStructure(wrap(<OverviewFilters {...opts} />));
    const renewal = renewalStructure(
      wrap(
        <RnFilterRuntime>
          <RnOverviewFilters props={opts} savedFilters={{ page: "overview", userId: "test", initial: [] }}>
            <RnOverviewFilterPanel onCollapse={() => {}} defaultOpen="all" />
          </RnOverviewFilters>
        </RnFilterRuntime>,
      ),
    );
    expect(app.axes.length).toBeGreaterThan(5);
    expect(renewal.sections).toEqual(app.sections);
    expect(renewal.axes.map((a) => a.label)).toEqual(app.axes.map((a) => a.label));
    for (const a of app.axes) expect(renewal.axes.find((x) => x.label === a.label)).toEqual(a);
  });
});
