import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";

// A 국가 axis with nothing to offer is left out (2026-10-30): AI Conversion lists the markets with a GA4 property the
// account can read (back/bff/screens/conversion.py property_options), none before the first one is registered. A
// country still picked in the URL keeps the axis, so its clear stays reachable.

let SEARCH = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/ai-funnel/conversion",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { RnFilterRuntime } = await import("./filter-runtime");
const { RnOverviewFilters, RnOverviewFilterPanel } = await import("./overview-filters");

const G = ko.dashboard.filters.group;

function panel(geographyOptions: string[], url = "") {
  SEARCH = url;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnFilterRuntime>
        <RnOverviewFilters props={{ stage: "conversion", scope: { all: true }, geographyOptions }} savedFilters={{ page: "conversion", userId: "test", initial: [] }}>
          <RnOverviewFilterPanel onCollapse={() => {}} defaultOpen="all" />
        </RnOverviewFilters>
      </RnFilterRuntime>
    </NextIntlClientProvider>,
  );
}

describe("renewal filter panel: an empty 국가 axis", () => {
  it("is left out when there is no country to offer", () => {
    const html = panel([]);
    expect(html).not.toContain(`>${G.geography}<`);
    expect(html).toContain(`>${G.brand}<`);
  });

  it("shows its countries when there are some", () => {
    expect(panel(["IT"])).toContain(`>${G.geography}<`);
  });

  it("stays while the URL still picks a country, so it can be cleared", () => {
    expect(panel([], "geography=JP")).toContain(`>${G.geography}<`);
  });
});
