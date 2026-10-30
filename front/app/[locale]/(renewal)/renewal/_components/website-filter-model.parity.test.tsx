import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { appStructure, renewalStructure } from "./filter-parity-markup";

// ════════════════════════════════════════════════════════════════════════════
// Renewal filter panel with surface "website" = the app's Website filter panels
// ════════════════════════════════════════════════════════════════════════════
//
// The Website pages (2026-10-30) carry the app's Website filters: the Overview's WebsiteFilters
// (DimensionFilterPanel geoSurface "website") and the website Mention / Citation pages'
// AnalysisFilterBar with their WEBSITE_ONLY_GROUPS (+ brand for an admin, + 출처 카테고리 on Citation).
// As in overview-filter-model.parity.test.tsx, this renders the real panel and the renewal panel for
// the same scope, options and URL and compares section rows, axes, option labels in order, group
// headers, checked state, search boxes and time presets.
//
// One intended difference is left out of the cases: the app's website Mention / Citation panels saw the
// account scope as Global, the renewal pages see it as Website (overview-filter-model.ts
// WEBSITE_ONLY_GROUPS). They differ only for a dedicated-site account, whose case runs on the Overview.

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
  usePathname: () => "/ko/renewal/website",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { WebsiteFilters } = await import("@/components/dash/website-filters");
const { WebsitePromptFilters } = await import("@/app/[locale]/(dash)/website/prompts/_components/prompt-filters");
const { AnalysisFilterBar } = await import("@/app/[locale]/(dash)/standard/answer-analysis/_components/analysis-filter-bar");
const { deriveMatrixOptions } = await import("@/components/dash/dimension-filter-panel");
const { effectiveScopeCountries } = await import("@/lib/rhq");
const { RnFilterRuntime } = await import("./filter-runtime");
const { RnOverviewFilters, RnOverviewFilterPanel } = await import("./overview-filters");
const { WEBSITE_ONLY_GROUPS } = await import("./overview-filter-model");
type DimensionGroup = (typeof WEBSITE_ONLY_GROUPS)[number];

// ── fixture: website option data in the app's shapes (sites, virtual hubs, dedicated sites) ──
type Combo = { brand: string | null; region: string; lang: string | null };
const LANGS: Record<string, (string | null)[]> = {
  KR: ["ko"], US: ["en", "es"], CA: ["en", "fr"], DE: ["de"], FR: ["fr"], GB: ["en"], AE: ["ar", "en", null], SA: ["ar"],
  "SA-Riyadh": ["ar"], IL: ["he"], EU: ["en"], MIDDLEEAST: ["en"], worldwide: ["en"], CPO: ["ko"], "HYUNDAI-N": ["en"],
};
const MEASURED: Record<string, string[]> = {
  Hyundai: ["KR", "US", "CA", "DE", "FR", "GB", "AE", "SA", "SA-Riyadh", "EU", "MIDDLEEAST", "worldwide", "CPO", "HYUNDAI-N"],
  Kia: ["US", "DE", "AE", "IL", "KR", "worldwide"],
  Genesis: ["KR", "US", "DE", "worldwide"],
};
const MATRIX: Combo[] = Object.entries(MEASURED).flatMap(([brand, cs]) => cs.flatMap((region) => LANGS[region].map((lang) => ({ brand, region, lang }))));
const ROUNDS = ["2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02", "2026-10-09"];
type Scope = { all: boolean; brands?: string[]; regions?: string[]; countries?: string[] };
const SCOPES: Record<"admin" | "hq" | "region" | "country" | "site", Scope> = {
  admin: { all: true },
  hq: { all: false, brands: ["Hyundai"] },
  region: { all: false, brands: ["Hyundai"], regions: ["hyundai-europe"] },
  country: { all: false, brands: ["Hyundai"], countries: ["KR"] },
  site: { all: false, brands: ["Hyundai"], countries: ["HYUNDAI-N"] },
};

function optionsFor(role: keyof typeof SCOPES, url: string, opts: { noLanguages?: boolean } = {}) {
  const scope = SCOPES[role];
  const allowed = effectiveScopeCountries(scope);
  const matrix = MATRIX.filter(
    (r) => scope.all || ((!allowed || allowed.includes(r.region)) && (!scope.brands?.length || r.brand === null || scope.brands.includes(r.brand))),
  );
  const urlBrand = new URLSearchParams(url).get("brand")?.split("~") ?? null;
  const applied = deriveMatrixOptions(matrix, scope.all ? urlBrand : null, undefined);
  return {
    scope: { ...scope },
    geographyOptions: applied.regions,
    languageOptions: opts.noLanguages ? [] : applied.languages,
    optionMatrix: opts.noLanguages ? matrix.map((m) => ({ ...m, lang: null })) : matrix,
    collectionStartDay: "2026-08-28T12:00:00.000Z",
    latestAnchorDay: "2026-10-09",
    selectableDates: ROUNDS,
  };
}

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );

type Stage = "overview" | "mention" | "citation";
type Role = keyof typeof SCOPES;

function appHtml(stage: Stage, role: Role, opts: ReturnType<typeof optionsFor>) {
  const admin = SCOPES[role].all;
  if (stage === "overview") return wrap(<WebsiteFilters {...opts} isAdmin={admin} />);
  // the app's website answer-analysis pages: WEBSITE_ONLY_GROUPS (+ 출처 on Citation), brand for an admin
  const groups: DimensionGroup[] = stage === "citation" ? [...WEBSITE_ONLY_GROUPS, "source"] : [...WEBSITE_ONLY_GROUPS];
  return wrap(
    <AnalysisFilterBar
      stage={stage === "mention" ? "mentions" : "citations"}
      onlyGroups={groups}
      primaryGroups={groups}
      extraGroups={admin ? ["brand"] : []}
      sticky={false}
      {...opts}
    />,
  );
}

const renewalHtml = (stage: Stage, opts: ReturnType<typeof optionsFor>) =>
  wrap(
    <RnFilterRuntime>
      <RnOverviewFilters props={{ ...opts, stage, surface: "website" }} savedFilters={{ page: `website-${stage}`, userId: "test", initial: [] }}>
        <RnOverviewFilterPanel onCollapse={() => {}} defaultOpen="all" />
      </RnOverviewFilters>
    </RnFilterRuntime>,
  );

const COMMON: ReadonlyArray<[label: string, role: Role, url: string, opts?: { noLanguages?: boolean }]> = [
  ["admin · no filter", "admin", ""],
  ["admin · one brand (권역 axis + RHQ groups)", "admin", "brand=Hyundai"],
  ["admin · brand + countries (languages narrow)", "admin", "brand=Hyundai&geography=DE~FR"],
  ["admin · two brands (no 권역)", "admin", "brand=Hyundai~Kia"],
  ["admin · weekly preset + language", "admin", "brand=Genesis&language=en&time=2026-10-03..2026-10-09"],
  ["HQ · no filter", "hq", ""],
  ["HQ · countries + custom period", "hq", "geography=KR~US&time=2026-09-11..2026-10-09"],
  ["권역담당 · 권역 hidden", "region", "engine=chatgpt"],
  ["국가담당 · 국가 hidden", "country", ""],
];

type Case = [stage: Stage, label: string, role: Role, url: string, opts?: { noLanguages?: boolean }];
const on = (stage: Stage) => COMMON.map(([l, r, u, o]): Case => [stage, l, r, u, o]);
const CASES: readonly Case[] = [
  ...on("overview"),
  ["overview", "전용 사이트 계정 · 국가 hidden (Website scope)", "site", ""],
  ...on("mention"),
  ["mention", "admin · no measured language (axis dropped)", "admin", "", { noLanguages: true }],
  ...on("citation"),
  ["citation", "admin · 출처 picked", "admin", "source=Official+%28HMG%29~Automotive+Media"],
  ["citation", "admin · no measured language (axis dropped)", "admin", "", { noLanguages: true }],
];

const G = ko.dashboard.filters.group;

describe("renewal filter panel with surface website shows exactly the app's Website filters", () => {
  it.each(CASES)("%s · %s", (stage, _label, role, url, o) => {
    SEARCH = url;
    const opts = optionsFor(role, url, o);
    const app = appStructure(appHtml(stage, role, opts));
    const renewal = renewalStructure(renewalHtml(stage, opts));
    expect(app.axes.length).toBeGreaterThan(2);
    expect(renewal.sections).toEqual(app.sections);
    expect(renewal.axes.map((a) => a.label)).toEqual(app.axes.map((a) => a.label));
    for (const a of app.axes) expect(renewal.axes.find((x) => x.label === a.label)).toEqual(a);
  });

  // Renewal audit 13-4 (2026-10-31): the Website Prompts page passes the brands of its options read
  // (website/prompts-options brandOptions), as the original WebsitePromptFilters does, not the static HMG three.
  it("lists the page's brand options on the administrator's brand axis (Website Prompts)", () => {
    SEARCH = "";
    const opts = { ...optionsFor("admin", ""), brandOptions: ["Hyundai", "Kia"] };
    const brandAxis = (html: string, read: typeof appStructure) => read(html).axes.find((a) => a.label === G.brand);
    const app = brandAxis(wrap(<WebsitePromptFilters {...opts} isAdmin />), appStructure);
    const renewal = brandAxis(renewalHtml("overview", opts), renewalStructure);
    expect(app?.groups?.flatMap((g) => g.items.map(([l]) => l))).toEqual(["Hyundai", "Kia"]);
    expect(renewal).toEqual(app);
    // without brand options the axis keeps the static HMG three (the other Website pages)
    const plain = brandAxis(renewalHtml("overview", optionsFor("admin", "")), renewalStructure);
    expect(plain?.groups?.flatMap((g) => g.items.map(([l]) => l))).toEqual(["Genesis", "Hyundai", "Kia"]);
  });

  it("carries no catalog or 경쟁사 axis, and 출처 only on Citation", () => {
    SEARCH = "";
    const labels = (stage: Stage) => renewalStructure(renewalHtml(stage, optionsFor("admin", ""))).axes.map((a) => a.label);
    for (const stage of ["overview", "mention", "citation"] as const) {
      expect(labels(stage)).toEqual(expect.arrayContaining([G.brand, G.geography, G.language, G.engine, G.time]));
      expect(labels(stage)).not.toContain(G.listType);
      expect(labels(stage)).not.toContain(G.competitor);
    }
    expect(labels("citation")).toContain(G.source);
    expect(labels("overview")).not.toContain(G.source);
    expect(labels("mention")).not.toContain(G.source);
  });
});
