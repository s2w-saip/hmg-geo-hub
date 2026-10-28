import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { appStructure, renewalStructure } from "@/app/[locale]/(renewal)/renewal/_components/filter-parity-markup";

// ════════════════════════════════════════════════════════════════════════════
// Renewal Mention filter panel = the app's Mention filter bar
// ════════════════════════════════════════════════════════════════════════════
//
// Same rule as the renewal Overview / ACR ("필터의 종류와 데이터가 일치해야 한다"): this renders
// the REAL AnalysisFilterBar stage="mentions" (mention/page.tsx MentionsFilterBar props) and
// the renewal panel (stage "mention") for the same account scope, option data and URL, and
// compares section rows, axis order, option labels, checked / disabled state, search boxes
// and time presets. Mention carries 프롬프트 퍼널 and Depth 4; no languages → no language axis.

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
  usePathname: () => "/ko/renewal/standard/answer-analysis/mention",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { AnalysisFilterBar } = await import("@/app/[locale]/(dash)/standard/answer-analysis/_components/analysis-filter-bar");
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
const MATRIX: Combo[] = Object.entries(MEASURED).flatMap(([brand, cs]) => cs.flatMap((region) => LANGS[region].map((lang) => ({ brand, region, lang }))));
const row = (brand: string, brandPresence: string, listType: string, depth1: string, depth2: string, depth3: string | null, depth4: string | null = null) => ({ brand, brandPresence, listType, depth1, depth2, depth3, depth4 });
const CATALOG = [
  row("Hyundai", "branded", "Brand Message", "Innovation & Technology", "Autonomous car", null),
  row("Hyundai", "unbranded", "Brand Message", "Brand Image/key value", "Value Awareness", null),
  row("Hyundai", "unbranded", "Consumer base Response", "Car+Features", "Features_Size/Spec", "Size/Spec", "Cargo"),
  row("Kia", "branded", "Brand Message", "Human & Sustainable Mobility", "Social Responsibility", null),
  row("Kia", "unbranded", "Consumer base Response", "Compare+Car/Features", "Compare_Size/Spec", "Size/spec", "Seats"),
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

// mention/page.tsx MentionsFilterBar (legacy): 국가·언어 = scope + applied brand
// (listMeasuredRegions / listMeasuredStandardLanguages); option matrix = account scope only.
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
    catalogRows: CATALOG,
    geographyOptions: applied.regions,
    languageOptions: opts.noLanguages ? [] : applied.languages,
    optionMatrix: opts.noLanguages ? matrix.map((m) => ({ ...m, lang: null })) : matrix,
    collectionStartDay: "2026-09-07T12:00:00.000Z",
    latestAnchorDay: "2026-10-19",
    selectableDates: ROUNDS,
  };
}

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );

const CASES: ReadonlyArray<[label: string, role: keyof typeof SCOPES, url: string, opts?: { noLanguages?: boolean }]> = [
  ["admin · no filter", "admin", ""],
  ["admin · one brand (권역 axis + RHQ groups)", "admin", "brand=Hyundai"],
  ["admin · brand + countries (languages narrow)", "admin", "brand=Hyundai&geography=DE~FR"],
  ["admin · two brands (no 권역)", "admin", "brand=Hyundai~Kia"],
  ["admin · catalog cascade down to depth 4", "admin", "brand=Hyundai&listType=Consumer+base+Response&depth1=Car%2BFeatures"],
  ["admin · weekly preset + language", "admin", "brand=Genesis&language=en&time=2026-10-13..2026-10-19"],
  ["admin · no measured language (axis dropped)", "admin", "", { noLanguages: true }],
  ["HQ · no filter", "hq", ""],
  ["HQ · countries + custom period", "hq", "geography=KR~US&time=2026-09-20..2026-10-19"],
  ["HQ · prompt funnel", "hq", "promptContext=%EB%B9%84%EA%B5%90%2F%EA%B2%80%EC%A6%9D"],
  ["권역담당 · 권역 hidden", "region", "engine=chatgpt"],
  ["국가담당 · 국가 hidden", "country", "brandPresence=branded"],
];

describe("renewal Mention filter panel shows exactly the app's Mention filters", () => {
  it.each(CASES)("%s", (_label, role, url, o) => {
    SEARCH = url;
    const opts = optionsFor(role, url, o);
    const app = appStructure(wrap(<AnalysisFilterBar stage="mentions" sticky={false} {...opts} />));
    const renewal = renewalStructure(
      wrap(
        <RnFilterRuntime>
          <RnOverviewFilters props={{ ...opts, stage: "mention" }} savedFilters={{ page: "mention", userId: "test", initial: [] }}>
            <RnOverviewFilterPanel onCollapse={() => {}} defaultOpen="all" />
          </RnOverviewFilters>
        </RnFilterRuntime>,
      ),
    );
    expect(app.axes.length).toBeGreaterThan(4);
    expect(app.axes.map((a) => a.label)).toContain(ko.dashboard.filters.group.promptContext);
    if (o?.noLanguages) expect(app.axes.map((a) => a.label)).not.toContain(ko.dashboard.filters.group.language);
    expect(renewal.sections).toEqual(app.sections);
    expect(renewal.axes.map((a) => a.label)).toEqual(app.axes.map((a) => a.label));
    for (const a of app.axes) expect(renewal.axes.find((x) => x.label === a.label)).toEqual(a);
  });
});
