import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { appStructure, renewalStructure } from "@/app/[locale]/(renewal)/renewal/_components/filter-parity-markup";

// ════════════════════════════════════════════════════════════════════════════
// Renewal Citation filter panel = the app's Citation filter bar
// ════════════════════════════════════════════════════════════════════════════
//
// Same rule as the renewal Overview / ACR / Mention ("필터의 종류와 데이터가 일치해야 한다"): this
// renders the REAL AnalysisFilterBar stage="citations" with STANDARD_CITATION_V2_ONLY_GROUPS
// (citation/page.tsx CitationsFilterBar props) and the renewal panel (stage "citation") for the
// same account scope, option data and URL, and compares section rows, axis order, option labels,
// checked state, search boxes and time presets — including the 답변 필터 row: 출처 카테고리
// (13 taxonomy values, translated) and 경쟁사 (cited 공식(경쟁사) domains; disabled while the
// 출처 selection leaves 공식(경쟁사) out; dropped when it has no options and is not user-excluded).

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
  usePathname: () => "/ko/renewal/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { AnalysisFilterBar } = await import("@/app/[locale]/(dash)/standard/answer-analysis/_components/analysis-filter-bar");
const { STANDARD_CITATION_V2_ONLY_GROUPS } = await import("@/app/[locale]/(dash)/standard/answer-analysis/_components/filter-groups");
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

// citation/page.tsx CitationsFilterBar (legacy): 국가·언어 = scope + applied brand
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

// 경쟁사 options = competitorDomainOptions of the citation read with the APPLIED ?source= —
// none when the applied 출처 leaves 공식(경쟁사) out.
const COMPETITORS = ["toyota.com", "tesla.com", "bmw.com", "volkswagen.de", "honda.com", "byd.com", "ford.com", "nissan-global.com", "mercedes-benz.com"];
const competitorsFor = (url: string, none = false) => {
  const src = new URLSearchParams(url).get("source")?.split("~") ?? [];
  return none || (src.length > 0 && !src.includes("Official (Competitor)")) ? [] : COMPETITORS;
};
/** A promise React's use() reads synchronously (static render cannot wait for Suspense). */
const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });

const CASES: ReadonlyArray<[label: string, role: keyof typeof SCOPES, url: string, opts?: { noLanguages?: boolean; noCompetitors?: boolean }]> = [
  ["admin · no filter (출처 13 + 경쟁사 domains)", "admin", ""],
  ["admin · 출처 picked incl. 공식(경쟁사) + a competitor", "admin", "source=Official+%28Competitor%29~Automotive+Media&competitor=toyota.com"],
  ["admin · 출처 without 공식(경쟁사) → 경쟁사 disabled, kept", "admin", "source=Automotive+Media~News+%26+Media"],
  ["admin · no competitor citations → 경쟁사 dropped", "admin", "", { noCompetitors: true }],
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

const G = ko.dashboard.filters.group;

describe("renewal Citation filter panel shows exactly the app's Citation filters", () => {
  it.each(CASES)("%s", (_label, role, url, o) => {
    SEARCH = url;
    const opts = optionsFor(role, url, o);
    const competitors = competitorsFor(url, o?.noCompetitors);
    const appHtml = wrap(<AnalysisFilterBar stage="citations" onlyGroups={STANDARD_CITATION_V2_ONLY_GROUPS} competitorOptions={competitors} sticky={false} {...opts} />);
    const renewalHtml = wrap(
      <RnFilterRuntime>
        <RnOverviewFilters props={{ ...opts, stage: "citation", competitorOptions: settled(competitors) }} savedFilters={{ page: "citation", userId: "test", initial: [] }}>
          <RnOverviewFilterPanel onCollapse={() => {}} defaultOpen="all" />
        </RnOverviewFilters>
      </RnFilterRuntime>,
    );
    const app = appStructure(appHtml);
    const renewal = renewalStructure(renewalHtml);
    expect(app.axes.map((a) => a.label)).toContain(G.source);
    expect(app.sections).toContain(ko.dashboard.filters.section.citation);
    if (o?.noLanguages) expect(app.axes.map((a) => a.label)).not.toContain(G.language);
    expect(renewal.sections).toEqual(app.sections);
    expect(renewal.axes.map((a) => a.label)).toEqual(app.axes.map((a) => a.label));
    for (const a of app.axes) expect(renewal.axes.find((x) => x.label === a.label)).toEqual(a);
    // 출처 카테고리: all 13 taxonomy values, translated
    expect(renewal.axes.find((a) => a.label === G.source)?.groups?.[0].items).toHaveLength(13);
    // 경쟁사: present unless it has no options and the applied 출처 allows competitors
    const competitorShown = renewal.axes.some((a) => a.label === G.competitor);
    expect(competitorShown).toBe(!(o?.noCompetitors && !url.includes("source=")));
    const disabledHint = ko.dashboard.filters.competitorNeedsOfficialCompetitor;
    const excluded = url.includes("source=") && !url.includes("Official+%28Competitor%29");
    expect(renewalHtml.includes(disabledHint)).toBe(excluded);
  });
});
