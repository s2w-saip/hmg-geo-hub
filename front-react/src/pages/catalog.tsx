import type { ComponentProps } from "react";
import type { PageDefinition } from "~/app/pages";
import { Frame, Load, commonReads, screenRead, savedSource, usePageContext, useReads } from "./load";
import { RnPromptsView } from "@/app/[locale]/(renewal)/renewal/standard/prompts/_components/prompts-view";
import { RnWebsitePrompts } from "@/app/[locale]/(renewal)/renewal/website/prompts/_components/website-prompts-view";
import type { PromptsHeader, PromptsHistory, PromptsPage } from "@/app/[locale]/(dash)/standard/prompts/_data/screen-types";
import type { WebsitePromptsPage, WebsitePromptInsights } from "@/app/[locale]/(renewal)/renewal/website/prompts/_components/website-prompt-model";
import type { OverviewFilterProps } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { effectiveScopeCountries } from "@/lib/rhq";

export default function CatalogPage({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const website = page.kind === "website-prompts";
  const savedPage = website ? "website-prompts" : "prompts";
  const result = useReads({ ...commonReads(ctx, savedPage), ...(website ? {
    catalog: screenRead("website/prompts-page", { ...ctx.sp, "ctx.admin": ctx.user.role === "admin" }),
    insights: screenRead("website/prompts-insights", { ...ctx.sp, "ctx.admin": ctx.user.role === "admin" }),
    options: screenRead("website/prompts-options", { ...ctx.sp, "ctx.admin": ctx.user.role === "admin" }),
  } : {
    catalog: screenRead("catalog/prompts-page", { collation: ctx.locale }), header: screenRead("catalog/prompts-header"), history: screenRead("catalog/prompts-history", { days: "90", event: "all" }),
  }) });
  return <Load result={result}>{v => {
    if (website) return <Frame page={page} ctx={ctx} values={v} savedPage={savedPage} filters={{ ...v.value<OverviewFilterProps>("options"), scope: ctx.user.scope, surface: "website", stage: "overview" }}><RnWebsitePrompts key={v.stamp} initial={v.value<WebsitePromptsPage>("catalog")} initialInsights={v.value<WebsitePromptInsights>("insights")} /></Frame>;
    return <RnPromptsView key={v.stamp} remote={{ initial: v.value<PromptsPage>("catalog") }} scopeAll={ctx.user.scope.all} scopeRole={ctx.user.role} scopeBrands={ctx.user.scope.brands ?? []} scopeRegions={ctx.user.scope.regions ?? []} scopeCountries={effectiveScopeCountries(ctx.user.scope) ?? []} period={v.value<PromptsHeader>("header").period} history={v.value<PromptsHistory>("history")} initialTab={ctx.sp.tab === "history" ? "history" : "catalog"} savedFilters={savedSource(ctx, v, savedPage)} />;
  }}</Load>;
}
