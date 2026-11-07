import { useTranslations } from "use-intl";
import type { PageDefinition } from "~/app/pages";
import { Frame, PageWeek, Load, commonReads, derive, screenRead, savedSource, usePageContext, useReads } from "./load";
import { RnPromptsView } from "@/app/[locale]/(renewal)/renewal/standard/prompts/_components/prompts-view";
import { RnWebsitePrompts } from "@/app/[locale]/(renewal)/renewal/website/prompts/_components/website-prompts-view";
import type { PromptsHeader, PromptsHistory, PromptsPage } from "@/app/[locale]/(dash)/standard/prompts/_data/screen-types";
import type { WebsitePromptsPage, WebsitePromptInsights } from "@/app/[locale]/(renewal)/renewal/website/prompts/_components/website-prompt-model";
import { effectiveScopeCountries } from "@/lib/rhq";
import { parseTimeRange } from "@/components/dash/filter-encoding";
import type { ServiceWeekPagePeriod } from "@/lib/service-week";

interface PromptOptionsView { geographyOptions: string[]; languageOptions: string[]; brandOptions: string[]; engineOptions?: string[]; selectableDates: string[] | null }
const roundRange = (v: WebsitePromptsPage): ServiceWeekPagePeriod => {
  const axis = v.roundAxis ?? [];
  return axis.length ? { from: axis[0].slice(0, 10), to: axis[axis.length - 1].slice(0, 10) } : null;
};

export default function CatalogPage({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const tw = useTranslations("renewal.website.prompts");
  const website = page.kind === "website-prompts";
  const savedPage = website ? "website-prompts" : "prompts";
  const admin = { "ctx.admin": ctx.user.role === "admin" };
  // the list's page stays in the view's own state, the address carries it for the panel only
  const { page: _page, ...listSp } = ctx.sp;
  const result = useReads({ ...commonReads(ctx), ...(website ? {
    catalog: screenRead("website/prompts-page", { ...listSp, ...admin }),
    insights: screenRead("website/prompts-insights", { ...listSp, ...admin }),
    options: screenRead("website/prompts-options", { ...ctx.sp, ...admin }),
  } : {
    catalog: screenRead("catalog/prompts-page", { collation: ctx.locale }), header: screenRead("catalog/prompts-header"), history: screenRead("catalog/prompts-history", { days: "90", event: "all" }),
  }) });
  return <Load result={result}>{v => {
    if (website) {
      const o = v.value<PromptOptionsView>("options");
      return <Frame page={page} ctx={ctx} values={v} savedPage={savedPage}
        filters={{ scope: ctx.user.scope, surface: "website", stage: "overview", geographyOptions: o.geographyOptions, languageOptions: o.languageOptions, brandOptions: o.brandOptions, engineOptions: o.engineOptions, selectableDates: o.selectableDates ?? undefined }}
        panel={{ axisHelp: { engine: tw("engineHelp"), time: tw("timeHelp") }, hint: tw("noPickHint") }}
        notesPeriod={parseTimeRange(ctx.sp.time) ? undefined : derive(v.promise<WebsitePromptsPage>("catalog"), "rounds", roundRange)}>
        <RnWebsitePrompts key={v.stamp} initial={v.value<WebsitePromptsPage>("catalog")} initialInsights={v.value<WebsitePromptInsights>("insights")} />
      </Frame>;
    }
    return <PageWeek ctx={ctx} values={v}><RnPromptsView key={v.stamp} remote={{ initial: v.value<PromptsPage>("catalog") }} scopeAll={ctx.user.scope.all} scopeRole={ctx.user.role} scopeBrands={ctx.user.scope.brands ?? []} scopeRegions={ctx.user.scope.regions ?? []} scopeCountries={effectiveScopeCountries(ctx.user.scope) ?? []} period={v.value<PromptsHeader>("header").period} history={v.value<PromptsHistory>("history")} initialTab={ctx.sp.tab === "history" ? "history" : "catalog"} savedFilters={savedSource(ctx, savedPage)} /></PageWeek>;
  }}</Load>;
}
