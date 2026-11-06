import { Suspense } from "react";
import type { ComponentProps } from "react";
import { useLocale } from "use-intl";
import { parseTimeRange } from "@/components/dash/filter-encoding";
import type { OverviewFilterProps } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import type { SavedFilterPage } from "@/app/[locale]/(renewal)/renewal/_components/saved-filters";
import type { FilterBarView, CardsView, WebsiteSummaryView, OverviewGeoView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import type { PanelFilterOptions, FilterDatesView } from "@/lib/hgh/filter-types";
import type { CitationFilterBarScreen, CitationAsOfScreen, CitationPromptsScreen, CitationToneUrlsScreen, StandardCitationScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { RnOverviewBody } from "@/app/[locale]/(renewal)/renewal/dashboard/_components/overview-body";
import { RnWebsiteOverviewBody } from "@/app/[locale]/(renewal)/renewal/website/_overview/website-overview-body";
import { RnProjectDashboardBody } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-dashboard";
import { RnMentionBody } from "@/app/[locale]/(renewal)/renewal/standard/answer-analysis/mention/_components/mention-body";
import { RnMentionPageProvider } from "@/app/[locale]/(renewal)/renewal/standard/answer-analysis/mention/_components/mention-tabs";
import { resolveMentionView, type RnMentionInput } from "@/app/[locale]/(renewal)/renewal/standard/answer-analysis/mention/_components/mention-input";
import type { RnPageVM } from "@/app/[locale]/(renewal)/renewal/standard/answer-analysis/mention/_data/screen-types";
import { RnWebsiteMentionBody } from "@/app/[locale]/(renewal)/renewal/website/answer-analysis/mention/_components/website-mention-body";
import { resolveKpiTab, type KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import { RnCitationBody } from "@/app/[locale]/(renewal)/renewal/standard/answer-analysis/citation/_components/citation-body";
import type { RnCitationInput, RnCitationVm, RnWebsiteCitationScreen } from "@/app/[locale]/(renewal)/renewal/standard/answer-analysis/citation/_components/citation-input";
import { RnCitationPromptsView, RnCitationToneUrlsView } from "@/app/[locale]/(renewal)/renewal/standard/answer-analysis/citation/_components/citation-subpages";
import { RnAcrBody } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/acr/_components/acr-body";
import type { RnAcrScreen } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/acr/_data/screen-types";
import { showsGeoMap } from "@/lib/auth/scope-policy";
import type { PageDefinition } from "~/app/pages";
import type { Read } from "~/api/bundle";
import { HghApiError } from "@/lib/hgh/errors";
import { CONNECTED } from "~/api/client";
import { pendingPreview, previewTiles } from "~/api/preview";
import { PageLoading } from "~/app/states";
import { commonReads, Frame, Load, NoMeasurement, screenRead, sectionRead, usePageContext, useReads, type PageContext, type Values } from "./load";

function filterReads(ctx: PageContext, family: "overview" | "mention" | "citation"): Record<string, Read> {
  if (ctx.surface === "project") return { filters: screenRead("projects/filters", { ...ctx.query, "ctx.family": family === "citation" ? "citations" : "mentions" }) };
  if (family === "overview") return { filters: screenRead("overview/filters", ctx.query) };
  if (family === "citation") return { filters: screenRead("citation/filter-bar", ctx.query), meta: screenRead("citation/as-of", ctx.query) };
  return { filters: screenRead("shared/panel-options", { ...ctx.sp, surface: ctx.surface }), dates: screenRead("shared/filter-dates", { surface: ctx.surface, family: "mentions" }) };
}
function filters(ctx: PageContext, values: Values, stage: OverviewFilterProps["stage"]): OverviewFilterProps {
  if (ctx.surface === "project") return { ...values.value<OverviewFilterProps>("filters"), scope: ctx.user.scope, surface: "project", stage };
  if (stage === "citation") {
    const bar = values.value<CitationFilterBarScreen>("filters");
    return { ...bar.options, ...bar.dates, scope: ctx.user.scope, surface: ctx.surface === "global" ? "standard" : ctx.surface, stage, ...(ctx.surface === "global" ? { competitorOptions: Promise.resolve(values.value<CitationAsOfScreen>("meta").competitorOptions) } : {}) };
  }
  return { ...values.value<FilterBarView>("filters"), ...(stage === "mention" ? values.value<FilterDatesView>("dates") : {}), scope: ctx.user.scope, surface: ctx.surface === "global" ? "standard" : ctx.surface, stage };
}
export default function AnalyticsPage({ page }: { page: PageDefinition }) {
  if (page.kind === "overview") return <Overview page={page} />;
  if (page.kind === "mention") return <Mention page={page} />;
  if (page.kind === "acr") return <Acr page={page} />;
  return <Citation page={page} />;
}
function Overview({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const savedPage: SavedFilterPage = ctx.surface === "global" ? "overview" : ctx.surface === "website" ? "website-overview" : "project-dashboard";
  const geo = showsGeoMap({ id: ctx.user.id, email: ctx.user.email ?? ctx.user.login, role: ctx.user.role, scope: ctx.user.scope, operator: "none", menuGroups: null });
  const global = ctx.surface === "global";
  const prefix = ctx.surface === "project" ? "projects/dash-" : "website/";
  const result = useReads({ ...commonReads(ctx), ...filterReads(ctx, "overview"), asof: screenRead(ctx.surface === "project" ? "projects/as-of" : "overview/as-of", ctx.query, true), ...(global ? {
    cards: screenRead("overview/cards", ctx.query), trend: sectionRead("overview/card-trend", ctx.query), matrix: sectionRead("overview/brand-matrix", ctx.query),
    ...(geo ? { geo: sectionRead("overview/geo", { ...ctx.query, "ctx.locale": ctx.locale, "ctx.view": "renewal" }) } : {}),
  } : {
    summary: screenRead(prefix + "summary", ctx.query), deferred: screenRead(prefix + "summary-deferred", ctx.query),
    engines: screenRead(prefix + "engines", ctx.query), trend: screenRead(prefix + "trend", ctx.query), composition: screenRead(prefix + "composition", ctx.query),
    ...(ctx.surface === "project" ? { status: screenRead(prefix + "status", ctx.query) } : { brands: screenRead(prefix + "brands", ctx.query), ...(geo ? { geo: screenRead(prefix + "geo", { ...ctx.query, "ctx.locale": ctx.locale }) } : {}) }),
  }) });
  return <Load result={result}>{v => <Frame page={page} ctx={ctx} values={v} filters={filters(ctx, v, "overview")} savedPage={savedPage}><Suspense fallback={<PageLoading />}>
    {global ? <GlobalOverview values={v} ctx={ctx} geo={geo} /> : <OtherOverview values={v} ctx={ctx} geo={geo} />}
  </Suspense></Frame>}</Load>;
}
function GlobalOverview({ values: v, ctx, geo }: { values: Values; ctx: PageContext; geo: boolean }) {
  const view = v.value<CardsView>("cards");
  if (view.state === "degraded") throw new HghApiError(503, "source_unavailable");
  if (view.state !== "ok" && CONNECTED) return <NoMeasurement />;
  return <RnOverviewBody cards={view.state === "ok" ? view.cards : []} compareTitle={view.state === "ok" ? view.compareTitle : null} deferred={{ trend: v.promise("trend"), matrix: v.promise("matrix") }} geo={geo ? v.promise<OverviewGeoView>("geo") : null} qs={ctx.search} />;
}
function OtherOverview({ values: v, ctx, geo }: { values: Values; ctx: PageContext; geo: boolean }) {
  const summary = v.value<WebsiteSummaryView>("summary");
  const deferred = v.value<WebsiteSummaryView>("deferred");
  if (summary.state === "degraded" || deferred.state === "degraded") throw new HghApiError(503, "source_unavailable");
  if (CONNECTED && (summary.state !== "ok" || deferred.state !== "ok")) return <NoMeasurement />;
  const tiles = summary.state === "ok" ? summary.tiles : previewTiles;
  const later = deferred.state === "ok" ? deferred.tiles : previewTiles;
  if (ctx.surface === "project") return <RnProjectDashboardBody id={ctx.id} tiles={tiles} reads={{ deferred: Promise.resolve(later), engines: v.promise("engines"), trend: v.promise("trend"), composition: v.promise("composition"), status: v.promise("status") }} qs={ctx.search} />;
  return <RnWebsiteOverviewBody tiles={tiles} reads={{ deferred: Promise.resolve(later), engines: v.promise("engines"), trend: v.promise("trend"), composition: v.promise("composition"), brands: v.promise("brands"), geo: geo ? v.promise("geo") : null }} qs={ctx.search} isAdmin={ctx.user.role === "admin"} />;
}
const mentionSections = { shell: "rn-shell", compare: "rn-compare", rateValue: "rn-rate-value", rateHero: "rn-rate-hero", rateEngines: "rn-rate-engines", rateTypes: "rn-rate-types", favorHero: "rn-favor-hero", favorDist: "rn-favor-dist", favorMatrix: "rn-favor-matrix", rank: "rn-rank", bump: "rn-bump", ranking: "rn-ranking" } as const;
const kpis: KpiTab[] = ["exposure", "sov", "favorability", "first-rank"];
function Mention({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const global = ctx.surface === "global";
  const savedPage: SavedFilterPage = global ? "mention" : ctx.surface === "website" ? "website-mention" : "project-mention";
  const result = useReads({ ...commonReads(ctx), ...filterReads(ctx, "mention"), head: screenRead("mention/rn-page", ctx.query), asof: screenRead("mention/rn-asof", ctx.query, true),
    ...Object.fromEntries(Object.entries(mentionSections).map(([key, name]) => [key, (global && key !== "shell" ? sectionRead : screenRead)(`mention/${name}`, ctx.query)])),
    ...(global ? { engineExtra: sectionRead("mention/rn-engine-extra", ctx.query), presence: sectionRead("mention/rn-presence-split", ctx.query) } : {
      ...Object.fromEntries(kpis.map(kpi => [`tab-${kpi}`, screenRead("mention/rn-tab-value", { ...ctx.query, "ctx.kpi": kpi })])),
      summary: screenRead("mention/rn-summary", ctx.query), tabDeltas: screenRead("mention/rn-tab-deltas", ctx.query),
    }),
    ...(ctx.surface === "website" ? { siteCards: screenRead("mention/view-cards", ctx.query), markets: screenRead("mention/rn-markets", ctx.query), weekly: screenRead("mention/view-weekly", ctx.query), siteCompare: screenRead("mention/view-compare", ctx.query) } : {}),
  });
  return <Load result={result}>{v => {
    const head = v.value<RnPageVM>("head");
    const reads = Object.fromEntries(Object.keys(mentionSections).map(key => [key, v.promise(key)])) as Pick<RnMentionInput, keyof typeof mentionSections>;
    const input: RnMentionInput = { ...reads, kpi: resolveKpiTab(ctx.sp.kpi), view: resolveMentionView(ctx.sp.view, global ? { kpi: ctx.sp.kpi } : undefined), ownLabel: head.ownLabel, period: head.period, filtered: Object.keys(ctx.sp).some(k => !["tab", "view", "kpi"].includes(k)), global, brandsFirst: global,
      ...(global ? { engineExtra: v.promise("engineExtra"), presence: v.promise("presence") } : { summary: v.promise("summary"), tabDeltas: v.promise("tabDeltas"), tabValue: Object.fromEntries(kpis.map(k => [k, v.promise(`tab-${k}`)])) as NonNullable<RnMentionInput["tabValue"]> }),
      ...(ctx.surface === "website" ? { body: <RnWebsiteMentionBody reads={{ cards: v.promise("siteCards"), markets: v.promise("markets"), weekly: v.promise("weekly"), compare: v.promise("siteCompare") }} period={!!head.period} pageAsOf={Promise.resolve(v.value<{ asOf: string | null } | null>("asof")?.asOf ?? null)} admin={ctx.user.scope.all} /> } : {}),
    };
    return <Frame page={page} ctx={ctx} values={v} filters={filters(ctx, v, "mention")} savedPage={savedPage}><RnMentionPageProvider input={input}><Suspense fallback={<PageLoading />}><RnMentionBody preview={!CONNECTED} /></Suspense></RnMentionPageProvider></Frame>;
  }}</Load>;
}
function Citation({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const sub = page.kind !== "citation";
  const savedPage: SavedFilterPage = ctx.surface === "global" ? "citation" : ctx.surface === "website" ? "website-citation" : "project-citation";
  const name = page.kind === "citation-prompts" ? "citation/prompts" : page.kind === "citation-tone" ? "citation/tone-urls" : `citation/${ctx.surface === "global" ? "standard" : ctx.surface}`;
  const result = useReads({ ...commonReads(ctx), ...filterReads(ctx, "citation"), body: screenRead(name, { ...ctx.query, ...(!sub ? { "ctx.variant": "renewal" } : {}) }),
    ...(!sub && parseTimeRange(ctx.sp.time) ? { header: screenRead("citation/renewal-header", ctx.query, true) } : {}),
    ...(!sub && ctx.surface !== "global" ? { asof: screenRead("citation/as-of", ctx.query, true) } : {}),
  });
  return <Load result={result}>{v => {
    if (page.kind === "citation-prompts") return <Frame page={page} ctx={ctx} values={v} reset={["page", "cursor"]}><RnCitationPromptsView {...v.value<CitationPromptsScreen>("body")} /></Frame>;
    if (page.kind === "citation-tone") return <Frame page={page} ctx={ctx} values={v} reset={["page", "cursor", "q"]}><RnCitationToneUrlsView {...v.value<CitationToneUrlsScreen>("body")} /></Frame>;
    const body = v.value<StandardCitationScreen<RnCitationVm> | RnWebsiteCitationScreen>("body");
    const time = parseTimeRange(ctx.sp.time);
    const input: RnCitationInput = { api: true, period: time ? { from: time.from ?? null, to: time.to ?? null } : null, filtered: Object.keys(ctx.sp).some(k => !["tab", "page"].includes(k)), data: Promise.resolve(body.live), dataDegraded: Promise.resolve(body.dataDegraded), sectionDegraded: Promise.resolve(body.sectionDegraded), prevCategories: Promise.resolve(body.prevCategories), toneSummary: CONNECTED ? Promise.resolve(body.toneSummary) : pendingPreview, tableSource: Promise.resolve(body.tableSource), periodView: Promise.resolve(body.periodView), rn: Promise.resolve(body.rn ?? null), global: ctx.surface === "global", ...("reach" in body ? { website: Promise.resolve({ own: body.own, reach: body.reach }) } : {}) };
    return <Frame page={page} ctx={ctx} values={v} filters={filters(ctx, v, "citation")} savedPage={savedPage}><Suspense fallback={<PageLoading />}><RnCitationBody input={input} preview={!CONNECTED} /></Suspense></Frame>;
  }}</Load>;
}
function Acr({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const result = useReads({ ...commonReads(ctx), body: screenRead("acr/renewal", ctx.sp), header: screenRead("acr/renewal-header", ctx.sp, true) });
  return <Load result={result}>{v => { const read = v.value<RnAcrScreen>("body"); return <Frame page={page} ctx={ctx} values={v} filters={{ ...read.props, scope: ctx.user.scope }} savedPage="acr"><RnAcrBody input={read.body} preview={!CONNECTED} /></Frame>; }}</Load>;
}
