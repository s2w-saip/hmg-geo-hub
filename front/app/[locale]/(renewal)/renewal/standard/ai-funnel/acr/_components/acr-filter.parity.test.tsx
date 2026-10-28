import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { appStructure, renewalStructure } from "@/app/[locale]/(renewal)/renewal/_components/filter-parity-markup";

// ════════════════════════════════════════════════════════════════════════════
// Renewal ACR filter panel = the app's ACR filter panel
// ════════════════════════════════════════════════════════════════════════════
//
// Same rule as the renewal Overview ("필터의 종류와 데이터가 일치해야 한다"): this renders
// the REAL AcrLiveView (waiting state, so only its DimensionFilterPanel stage="acr" shows)
// and the renewal panel (stage "acr") for the same account scope, option data and URL,
// and compares section rows, axis order, option labels, checked / disabled state, search
// boxes and time presets. ACR has no 프롬프트 퍼널 / Depth 4, and its language options
// come from the ACR population (narrowed by the applied countries).

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
  usePathname: () => "/ko/renewal/standard/ai-funnel/acr",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { AcrLiveView, acrOnlyGroups } = await import("@/app/[locale]/(dash)/standard/ai-funnel/_components/acr-live-view");
const { deriveMatrixOptions } = await import("@/components/dash/dimension-filter-panel");
const { effectiveScopeCountries } = await import("@/lib/rhq");
const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters, RnOverviewFilterPanel } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");

// ── fixture: option data in the app's shapes ────────────────────────────────
type Combo = { brand: string | null; region: string; lang: string | null };
const LANGS: Record<string, string[]> = { KR: ["ko"], US: ["en", "es"], CA: ["en", "fr"], MX: ["es"], DE: ["de"], FR: ["fr"], GB: ["en"], AE: ["ar", "en"], SA: ["ar"], IL: ["he"], JP: ["ja"], worldwide: ["en"] };
const MEASURED: Record<string, string[]> = {
  Hyundai: ["KR", "US", "CA", "MX", "DE", "FR", "GB", "AE", "SA", "JP", "worldwide"],
  Kia: ["US", "DE", "AE", "IL", "KR"],
  Genesis: ["KR", "US", "DE"],
};
// ACR prompts run in fewer places (first language of the country) — scope_acr_rollups
const ACR: Record<string, string[]> = { Hyundai: ["KR", "US", "DE", "GB"], Kia: ["US", "DE"], Genesis: ["KR"] };
const MATRIX: Combo[] = Object.entries(MEASURED).flatMap(([brand, cs]) => cs.flatMap((region) => LANGS[region].map((lang) => ({ brand, region, lang }))));
const ACR_ROWS = Object.entries(ACR).flatMap(([brand, cs]) => cs.map((region) => ({ brand, region, lang: LANGS[region][0] })));
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

// The ACR page's option reads (acr/page.tsx AcrData): 국가 = answer population narrowed by the
// applied brand (listMeasuredRegions); 언어 = ACR population narrowed by brand + applied countries
// (listMeasuredAcrLanguages); dates = the round calendar. No option matrix, no anchor-day props.
function optionsFor(role: keyof typeof SCOPES, url: string) {
  const scope = SCOPES[role];
  const allowed = effectiveScopeCountries(scope);
  const inScope = (r: { brand: string | null; region: string }) =>
    scope.all || ((!allowed || allowed.includes(r.region)) && (!scope.brands?.length || r.brand === null || scope.brands.includes(r.brand)));
  const p = new URLSearchParams(url);
  const urlBrand = p.get("brand")?.split("~") ?? null;
  const urlGeo = p.get("geography")?.split("~") ?? null;
  const brands = scope.all ? urlBrand : scope.brands ?? null;
  const applied = deriveMatrixOptions(MATRIX.filter(inScope), scope.all ? urlBrand : null, undefined);
  const acrLangs = [
    ...new Set(
      ACR_ROWS.filter((r) => inScope(r) && (!brands || brands.includes(r.brand)) && (!urlGeo || urlGeo.includes(r.region)) && (!scope.countries?.length || scope.countries.includes(r.region))).map(
        (r) => r.lang,
      ),
    ),
  ].sort();
  return { scope: { ...scope }, catalogRows: CATALOG, geographyOptions: applied.regions, languageOptions: acrLangs, selectableDates: ROUNDS };
}

// The app's ACR view in its waiting state (screen acr/standard: measured false), panel props as the
// screen sends them (onlyGroups = the ACR axis rule over the ACR languages).
const WAITING = {
  measured: false,
  acrPromptCount: 69,
  brands: [],
  brandOrders: { brand: { asc: [], desc: [] }, top1: { asc: [], desc: [] }, coverage: { asc: [], desc: [] }, choices: { asc: [], desc: [] }, appearances: { asc: [], desc: [] } },
  kpi: { top1: null, top5: null, rank1: 0 },
  totals: { promptRuns: 0, prompts: 0, iterations: 0, engines: [] },
  trendBrands: [],
  trendRows: [],
  battle: [],
  battleVisible: 30,
  battleHidden: 0,
  models: [],
  modelOrders: { brand: { asc: [], desc: [] }, model: { asc: [], desc: [] }, conv: { asc: [], desc: [] }, shortlist: { asc: [], desc: [] }, top1: { asc: [], desc: [] } },
  territory: [],
};

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );

const CASES: ReadonlyArray<[label: string, role: keyof typeof SCOPES, url: string]> = [
  ["admin · no filter", "admin", ""],
  ["admin · one brand (권역 axis + RHQ groups)", "admin", "brand=Hyundai"],
  ["admin · brand + countries (ACR languages narrow)", "admin", "brand=Hyundai&geography=DE~GB"],
  ["admin · two brands (no 권역)", "admin", "brand=Hyundai~Kia"],
  ["admin · catalog cascade under brand", "admin", "brand=Kia&listType=Brand+Message"],
  ["admin · a country without ACR (no language axis)", "admin", "brand=Hyundai&geography=MX"],
  ["admin · monthly preset", "admin", "brand=Genesis&time=2026-09-20..2026-10-19"],
  ["HQ · no filter", "hq", ""],
  ["HQ · countries + language", "hq", "geography=KR~US&language=en"],
  ["권역담당 · 권역 hidden", "region", "engine=chatgpt"],
  ["국가담당 · 국가 hidden", "country", "brandPresence=branded"],
];

describe("renewal ACR filter panel shows exactly the app's ACR filters", () => {
  it.each(CASES)("%s", (_label, role, url) => {
    SEARCH = url;
    const opts = optionsFor(role, url);
    const app = appStructure(wrap(<AcrLiveView vm={WAITING} {...opts} onlyGroups={acrOnlyGroups(opts.languageOptions)} />));
    const renewal = renewalStructure(
      wrap(
        <RnFilterRuntime>
          <RnOverviewFilters props={{ ...opts, stage: "acr" }} savedFilters={{ page: "acr", userId: "test", initial: [] }}>
            <RnOverviewFilterPanel onCollapse={() => {}} defaultOpen="all" />
          </RnOverviewFilters>
        </RnFilterRuntime>,
      ),
    );
    expect(app.axes.length).toBeGreaterThan(4);
    expect(app.axes.map((a) => a.label)).not.toContain(ko.dashboard.filters.group.promptContext);
    expect(renewal.sections).toEqual(app.sections);
    expect(renewal.axes.map((a) => a.label)).toEqual(app.axes.map((a) => a.label));
    for (const a of app.axes) expect(renewal.axes.find((x) => x.label === a.label)).toEqual(a);
  });
});
