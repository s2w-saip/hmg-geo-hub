import { Suspense, use, useMemo } from "react";
import { useLocale, useTranslations } from "use-intl";
import { parseTimeRange } from "@/components/dash/filter-encoding";
import type { OverviewFilterProps } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import type { SavedFilterPage } from "@/app/[locale]/(renewal)/renewal/_components/saved-filters";
import type { FilterBarView, CardsView, CardTrendView, WebsiteSummaryView, OverviewGeoView, TilesView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import type { PanelFilterOptions, FilterDatesView } from "@/lib/hgh/filter-types";
import type { CitationFilterBarScreen, CitationAsOfScreen, CitationPromptsScreen, CitationToneUrlsScreen, StandardCitationScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { STANDARD_CITATION_V2_ONLY_GROUPS } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/filter-groups";
import { RnCard, RnEmpty, RnNote, RnSkeleton } from "@/components/renewal-ui";
import { RnServiceWeekEmptyLine } from "@/components/service-week/no-round";
import { SUPPORT } from "@/lib/support-contact";
import { RnOverviewBody } from "@/app/[locale]/(renewal)/renewal/dashboard/_components/overview-body";
import { RnWebsiteOverviewBody } from "@/app/[locale]/(renewal)/renewal/website/_overview/website-overview-body";
import { websiteFindings } from "@/app/[locale]/(renewal)/renewal/website/_overview/website-findings";
import { WebsiteFindingList } from "@/app/[locale]/(renewal)/renewal/website/_overview/website-findings-view";
import { engineLabel } from "@/app/[locale]/(renewal)/renewal/website/_overview/engine-label";
import type { WebsiteBrandsView, WebsiteEnginesView } from "@/app/[locale]/(renewal)/renewal/website/_overview/website-format";
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
import { RnBusyScope, RnFilterRuntime } from "@/app/[locale]/(renewal)/renewal/_components/filter-runtime";
import { RnOverviewApplied, RnOverviewFilters } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { showsGeoMap } from "@/lib/auth/scope-policy";
import type { PageDefinition } from "~/app/pages";
import type { Read } from "~/api/bundle";
import { CONNECTED } from "~/api/client";
import { pendingPreview, previewTiles } from "~/api/preview";
import { BodyLoading } from "~/app/states";
import { commonReads, derive, Frame, Load, screenRead, sectionRead, usePageContext, useReads, type PageContext, type Values } from "./load";

type Sp = PageContext["sp"];
const has = (sp: Sp, key: string) => sp[key] != null && sp[key] !== "";
const hasProjectAxis = (sp: Sp, axes: readonly string[]) => Object.keys(sp).some(k => (axes.includes(k) || k.startsWith("cf_")) && has(sp, k));

// The axes that decide "결과 없음" against "측정 대기": the screens ignore every other URL parameter.
const MENTION_AXES = ["brand", "geography", "language", "engine", "time", "promptContext", "brandPresence", "listType", "depth1", "depth2", "depth3", "depth4"];
const WEBSITE_AXES = ["geography", "language", "engine", "time"];
const PROJECT_AXES = ["geography", "engine", "time"];
const CITATION_AXES = ["brand", ...STANDARD_CITATION_V2_ONLY_GROUPS];
const WEBSITE_CITATION_AXES = ["brand", "geography", "language", "engine", "time", "source"];
const PROJECT_CITATION_AXES = ["geography", "engine", "time", "source"];

interface ProjectFiltersView { geographyOptions: string[]; engineOptions: string[]; dynamicAxes: NonNullable<OverviewFilterProps["dynamicAxes"]>; selectableDates: string[]; latestAnchorDay: string | null; collectionStartDay: string | null }
export function projectFilterProps(ctx: PageContext, v: ProjectFiltersView, stage: OverviewFilterProps["stage"]): OverviewFilterProps {
  return { stage, surface: "project", scope: ctx.user.scope, geographyOptions: v.geographyOptions, engineOptions: v.engineOptions, dynamicAxes: v.dynamicAxes, selectableDates: v.selectableDates, latestAnchorDay: v.latestAnchorDay, collectionStartDay: v.collectionStartDay };
}
function citationFilterProps(ctx: PageContext, bar: CitationFilterBarScreen, competitors?: Promise<string[]>): OverviewFilterProps {
  const shared = { stage: "citation" as const, scope: ctx.user.scope, catalogRows: bar.options.catalogRows, geographyOptions: bar.options.geographyOptions, languageOptions: bar.options.languageOptions, optionMatrix: bar.options.optionMatrix, collectionStartDay: bar.dates.collectionStartDay, latestAnchorDay: bar.dates.latestAnchorDay, selectableDates: bar.dates.selectableDates };
  return ctx.surface === "website" ? { ...shared, surface: "website", engineOptions: bar.options.engineOptions } : { ...shared, competitorOptions: competitors };
}

export default function AnalyticsPage({ page }: { page: PageDefinition }) {
  if (page.kind === "overview") return <Overview page={page} />;
  if (page.kind === "mention") return <Mention page={page} />;
  if (page.kind === "acr") return <Acr page={page} />;
  if (page.kind === "citation") return <Citation page={page} />;
  return <CitationSub page={page} />;
}

const DEGRADED_ENGINES: WebsiteEnginesView = { engines: [], consistency: {}, extremes: {}, widest: null, degraded: true };
const DEGRADED_SUMMARY = { state: "degraded" };

function Overview({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const savedPage: SavedFilterPage = ctx.surface === "global" ? "overview" : ctx.surface === "website" ? "website-overview" : "project-dashboard";
  const geo = showsGeoMap({ id: ctx.user.id, email: ctx.user.email ?? ctx.user.login, role: ctx.user.role, scope: ctx.user.scope, operator: "none", menuGroups: null });
  const global = ctx.surface === "global";
  const project = ctx.surface === "project";
  const prefix = project ? "projects/dash-" : "website/";
  const q = ctx.query;
  const reads: Record<string, Read> = { ...commonReads(ctx), filters: project ? screenRead("projects/filters", { ...q, "ctx.family": "mentions" }) : screenRead("overview/filters", q), asof: { ...screenRead(project ? "projects/as-of" : "overview/as-of", q, true), deferred: true }, ...(global ? {
    cards: { ...screenRead("overview/cards", q), fallback: DEGRADED_SUMMARY }, trend: sectionRead("overview/card-trend", q), matrix: sectionRead("overview/brand-matrix", q),
    ...(geo ? { geo: sectionRead("overview/geo", { ...q, "ctx.locale": ctx.locale, "ctx.view": "renewal" }) } : {}),
  } : {
    summary: { ...screenRead(prefix + "summary", q), fallback: DEGRADED_SUMMARY }, deferred: sectionRead(prefix + "summary-deferred", q, DEGRADED_SUMMARY),
    engines: sectionRead(prefix + "engines", q, DEGRADED_ENGINES), trend: sectionRead(prefix + "trend", q, "failed"), composition: sectionRead(prefix + "composition", q, { topics: [], sources: [], degraded: true }),
    ...(project ? { status: sectionRead(prefix + "status", q, "failed") } : { brands: sectionRead(prefix + "brands", q, "failed"), ...(geo ? { geo: sectionRead(prefix + "geo", { ...q, "ctx.locale": ctx.locale }, "failed") } : {}) }),
  }) };
  const result = useReads(reads);
  return <Load result={result}>{v => {
    let filters: OverviewFilterProps;
    if (project) filters = projectFilterProps(ctx, v.value<ProjectFiltersView>("filters"), "overview");
    else {
      const bar = v.value<FilterBarView>("filters");
      const shared = { scope: ctx.user.scope, geographyOptions: bar.geographyOptions, languageOptions: bar.languageOptions, optionMatrix: bar.optionMatrix, collectionStartDay: bar.collectionStartDay, latestAnchorDay: bar.latestAnchorDay, selectableDates: bar.selectableDates };
      filters = global ? { ...shared, catalogRows: bar.catalogRows } : { ...shared, stage: "overview", surface: "website", engineOptions: bar.engineOptions };
    }
    return <Frame page={page} ctx={ctx} values={v} filters={filters} savedPage={savedPage} bodyClass={global ? "flex flex-col gap-4" : "flex flex-col gap-2.5"}><Suspense fallback={<BodyLoading />}>
      {global ? <GlobalOverview values={v} ctx={ctx} geo={geo} /> : <OtherOverview values={v} ctx={ctx} geo={geo} />}
    </Suspense></Frame>;
  }}</Load>;
}
function NoCards({ degraded, weekLine }: { degraded: boolean; weekLine: boolean }) {
  const t = useTranslations("dashboard");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  return <RnCard className="p-6"><RnEmpty>{degraded ? tKpi("degraded", SUPPORT) : weekLine ? <RnServiceWeekEmptyLine>{t("empty")}</RnServiceWeekEmptyLine> : t("empty")}</RnEmpty></RnCard>;
}
/** A section whose answer says it degraded says so, instead of looking like "no data". */
function DegradeNote({ when, title }: { when: boolean | undefined; title: string }) {
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  return when ? <RnNote><b className="font-semibold">{title}</b><span>{tKpi("degraded", SUPPORT)}</span></RnNote> : null;
}
function GlobalOverview({ values: v, ctx, geo }: { values: Values; ctx: PageContext; geo: boolean }) {
  const t = useTranslations("dashboard");
  const view = v.value<CardsView>("cards");
  if (CONNECTED && view.state !== "ok") return <NoCards degraded={view.state === "degraded"} weekLine />;
  return <>
    <RnOverviewBody cards={view.state === "ok" ? view.cards : []} compareTitle={view.state === "ok" ? view.compareTitle : null} deferred={{ trend: v.promise("trend"), matrix: v.promise("matrix") }} geo={geo ? v.promise<OverviewGeoView>("geo") : null} qs={ctx.search} />
    <DegradeNote when={v.value<CardTrendView | undefined>("trend")?.degraded} title={t("trend.title")} />
    {geo ? <DegradeNote when={v.value<OverviewGeoView | undefined>("geo")?.degraded} title={t("overview.geo.title")} /> : null}
  </>;
}
/** 핵심 요약: restates values of the sections. It waits for the tiles' Δ and the breakdowns, and a part that failed only drops its line. */
function Findings({ deferred, values: v }: { deferred: Promise<TilesView>; values: Values }) {
  const locale = useLocale();
  const t = useTranslations("renewal.website.overview");
  const tUnit = useTranslations("metricUnit");
  const tS = useTranslations("renewal.overview.short");
  const tW = useTranslations("renewal.website.overview.short");
  const all = useMemo(() => {
    const settle = <T,>(p: Promise<T>) => p.catch(() => null);
    return Promise.all([settle(deferred), settle(v.promise<WebsiteEnginesView>("engines")), settle(v.promise<WebsiteBrandsView | "failed">("brands")), settle(v.promise<Parameters<typeof websiteFindings>[0]["composition"]>("composition"))]);
  }, [deferred, v.promise]);
  const [tiles, engines, brands, composition] = use(all);
  if (!tiles) return null;
  const items = websiteFindings({ tiles, engines, brands, composition }, (k, p) => t(k as "kpiTitle", p), {
    value: (unit, x) => (unit === "rank" ? tUnit("position", { n: x.toFixed(1) }) : `${x.toFixed(1)}%`),
    delta: (unit, d) => (unit === "rank" ? tUnit("position", { n: Math.abs(d).toFixed(1) }) : `${Math.abs(d).toFixed(1)}pp`),
    count: n => n.toLocaleString(locale),
    short: k => (tS.has(k) ? tS(k as "visibility") : tW(k as "ownedUrlRate")),
    engine: engineLabel,
  });
  return items.length ? <div className="@container/rnpage"><WebsiteFindingList items={items} /></div> : null;
}
function FindingsSkeleton() {
  return <div className="grid grid-cols-4 gap-2.5 px-6">{Array.from({ length: 4 }, (_, i) => <RnSkeleton key={i} className="h-[84px] rounded-[10px] bg-white/14" />)}</div>;
}
function OtherOverview({ values: v, ctx, geo }: { values: Values; ctx: PageContext; geo: boolean }) {
  const summary = v.value<WebsiteSummaryView>("summary");
  const tiles = summary.state === "ok" ? summary.tiles : previewTiles;
  // Δ and the engine badge: a transient failure keeps the tiles without them
  const deferred = derive(v.promise<WebsiteSummaryView>("deferred"), "tiles", d => (d.state === "ok" ? d.tiles : tiles));
  if (CONNECTED && summary.state !== "ok") return <NoCards degraded={summary.state === "degraded"} weekLine={ctx.surface !== "project"} />;
  if (ctx.surface === "project") return <RnProjectDashboardBody id={ctx.id} tiles={tiles} reads={{ deferred, engines: v.promise("engines"), trend: v.promise("trend"), composition: v.promise("composition"), status: v.promise("status") }} qs={ctx.search} />;
  return <RnWebsiteOverviewBody tiles={tiles} reads={{ deferred, engines: v.promise("engines"), trend: v.promise("trend"), composition: v.promise("composition"), brands: v.promise("brands"), geo: geo ? v.promise("geo") : null }} qs={ctx.search} isAdmin={ctx.user.role === "admin"}
    findings={<Suspense fallback={<FindingsSkeleton />}><Findings deferred={deferred} values={v} /></Suspense>} />;
}

const mentionSections = { shell: "rn-shell", compare: "rn-compare", rateValue: "rn-rate-value", rateHero: "rn-rate-hero", rateEngines: "rn-rate-engines", rateTypes: "rn-rate-types", favorHero: "rn-favor-hero", favorDist: "rn-favor-dist", favorMatrix: "rn-favor-matrix", rank: "rn-rank", bump: "rn-bump", ranking: "rn-ranking" } as const;
const kpis: KpiTab[] = ["exposure", "sov", "favorability", "first-rank"];
// the Website page draws no rank chart (the rivals sit under 0.2 % there)
const NO_BUMP = Promise.resolve({ trend: false, data: null, measured: 0, maxShare: 1 }) as unknown as RnMentionInput["bump"];
function Mention({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const q = ctx.query;
  const global = ctx.surface === "global";
  const website = ctx.surface === "website";
  const project = ctx.surface === "project";
  const admin = ctx.user.scope.all === true;
  const savedPage: SavedFilterPage = global ? "mention" : website ? "website-mention" : "project-mention";
  const axes = [...WEBSITE_AXES, ...(admin ? ["brand"] : [])];
  const filtered = global ? MENTION_AXES.some(k => has(ctx.sp, k)) : website ? axes.some(k => has(ctx.sp, k)) : hasProjectAxis(ctx.sp, PROJECT_AXES);
  const panelSp = website ? Object.fromEntries(Object.entries(ctx.sp).filter(([k]) => axes.includes(k))) : ctx.sp;
  const time = parseTimeRange(ctx.sp.time);
  const result = useReads({ ...commonReads(ctx),
    ...(project ? { filters: screenRead("projects/filters", { ...q, "ctx.family": "mentions" }) } : { filters: screenRead("shared/panel-options", { ...panelSp, surface: ctx.surface }), dates: screenRead("shared/filter-dates", { surface: ctx.surface, family: "mentions" }) }),
    head: screenRead("mention/rn-page", q),
    ...(time ? {} : { asof: { ...screenRead("mention/rn-asof", q, true), deferred: true } }),
    ...Object.fromEntries(Object.entries(mentionSections).filter(([key]) => !(website && key === "bump")).map(([key, name]) => [key, global && key === "shell" ? screenRead(`mention/${name}`, q) : sectionRead(`mention/${name}`, q)])),
    ...(global ? { engineExtra: sectionRead("mention/rn-engine-extra", q), presence: sectionRead("mention/rn-presence-split", q) } : {
      ...Object.fromEntries(kpis.map(kpi => [`tab-${kpi}`, sectionRead("mention/rn-tab-value", { ...q, "ctx.kpi": kpi })])),
      summary: sectionRead("mention/rn-summary", q), tabDeltas: sectionRead("mention/rn-tab-deltas", q),
    }),
    ...(website ? { siteCards: sectionRead("mention/view-cards", q), markets: sectionRead("mention/rn-markets", q), weekly: sectionRead("mention/view-weekly", q), siteCompare: sectionRead("mention/view-compare", q) } : {}),
  });
  return <Load result={result}>{v => {
    const head = v.value<RnPageVM>("head");
    const reads = Object.fromEntries(Object.keys(mentionSections).map(key => [key, key === "bump" && website ? NO_BUMP : v.promise(key)])) as Pick<RnMentionInput, keyof typeof mentionSections>;
    const pageAsOf = head.period || time ? null : derive(v.promise<{ asOf: string | null } | null>("asof"), "asOf", a => a?.asOf ?? null);
    const input: RnMentionInput = { ...reads, kpi: resolveKpiTab(ctx.sp.kpi), view: resolveMentionView(ctx.sp.view, global ? { kpi: ctx.sp.kpi } : undefined), ownLabel: head.ownLabel, period: head.period, filtered, ...(global ? { global: true, brandsFirst: true } : {}),
      ...(global ? { engineExtra: v.promise("engineExtra"), presence: v.promise("presence") } : { summary: v.promise("summary"), tabDeltas: v.promise("tabDeltas"), tabValue: Object.fromEntries(kpis.map(k => [k, v.promise(`tab-${k}`)])) as NonNullable<RnMentionInput["tabValue"]> }),
      ...(website ? { body: <RnWebsiteMentionBody reads={{ cards: v.promise("siteCards"), markets: v.promise("markets"), weekly: v.promise("weekly"), compare: v.promise("siteCompare") }} period={!!head.period} pageAsOf={pageAsOf} admin={admin} /> } : {}),
    };
    const shared = { scope: ctx.user.scope, stage: "mention" as const };
    let filters: OverviewFilterProps;
    if (project) filters = projectFilterProps(ctx, v.value<ProjectFiltersView>("filters"), "mention");
    else {
      const options = v.value<PanelFilterOptions>("filters");
      const dates = v.value<FilterDatesView>("dates");
      const common = { ...shared, geographyOptions: options.geographyOptions, languageOptions: options.languageOptions, optionMatrix: options.optionMatrix, collectionStartDay: dates.collectionStartDay, latestAnchorDay: dates.latestAnchorDay, selectableDates: dates.selectableDates };
      filters = global ? { ...common, catalogRows: options.catalogRows } : { ...common, surface: "website", engineOptions: options.engineOptions };
    }
    return <Frame page={page} ctx={ctx} values={v} filters={filters} savedPage={savedPage}><RnMentionPageProvider input={input}><Suspense fallback={<BodyLoading />}><RnMentionBody preview={!CONNECTED} /></Suspense></RnMentionPageProvider></Frame>;
  }}</Load>;
}

function Citation({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const q = ctx.query;
  const global = ctx.surface === "global";
  const project = ctx.surface === "project";
  const savedPage: SavedFilterPage = global ? "citation" : ctx.surface === "website" ? "website-citation" : "project-citation";
  const filtered = global ? CITATION_AXES.some(k => has(ctx.sp, k)) : project ? hasProjectAxis(ctx.sp, PROJECT_CITATION_AXES) : WEBSITE_CITATION_AXES.some(k => has(ctx.sp, k));
  const time = parseTimeRange(ctx.sp.time);
  const period = time?.from || time?.to ? { from: time.from ?? null, to: time.to ?? null } : null;
  const asOf = { ...screenRead("citation/as-of", q, true), deferred: true };
  const result = useReads({ ...commonReads(ctx),
    filters: project ? screenRead("projects/filters", { ...q, "ctx.family": "citations" }) : screenRead("citation/filter-bar", q),
    // Global's as-of also holds the 경쟁사 options: only that axis waits for this heavy read
    ...(global ? { meta: asOf } : !period ? { asof: asOf } : {}),
    ...(period ? { header: { ...screenRead("citation/renewal-header", q, true), deferred: true } } : {}),
    body: sectionRead(`citation/${global ? "standard" : ctx.surface}`, { ...q, "ctx.variant": "renewal" }),
  });
  return <Load result={result}>{v => {
    const screen = v.promise<StandardCitationScreen<RnCitationVm> & Partial<RnWebsiteCitationScreen>>("body");
    const input: RnCitationInput = { api: true, period, filtered,
      data: derive(screen, "live", s => s.live), dataDegraded: derive(screen, "dataDegraded", s => s.dataDegraded), sectionDegraded: derive(screen, "sectionDegraded", s => s.sectionDegraded), prevCategories: derive(screen, "prevCategories", s => s.prevCategories),
      toneSummary: CONNECTED ? derive(screen, "toneSummary", s => s.toneSummary) : pendingPreview, tableSource: derive(screen, "tableSource", s => s.tableSource), periodView: derive(screen, "periodView", s => s.periodView), rn: derive(screen, "rn", s => s.rn ?? null),
      ...(global ? { global: true } : {}), ...(ctx.surface === "website" ? { website: derive(screen, "website", s => ({ own: s.own!, reach: s.reach! })) } : {}) };
    const competitors = global ? derive(v.promise<CitationAsOfScreen | null>("meta"), "competitors", m => m?.competitorOptions ?? []) : undefined;
    const filters = project ? projectFilterProps(ctx, v.value<ProjectFiltersView>("filters"), "citation") : citationFilterProps(ctx, v.value<CitationFilterBarScreen>("filters"), competitors);
    return <Frame page={page} ctx={ctx} values={v} filters={filters} savedPage={savedPage}><Suspense fallback={<BodyLoading />}><RnCitationBody input={input} preview={!CONNECTED} /></Suspense></Frame>;
  }}</Load>;
}

/** The two citation sub pages. Global has no filters here; on Website and Project a failed filter read leaves the list alone. */
function CitationSub({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const tone = page.kind === "citation-tone";
  const global = ctx.surface === "global";
  const project = ctx.surface === "project";
  const result = useReads({ ...commonReads(ctx),
    body: screenRead(tone ? "citation/tone-urls" : "citation/prompts", { ...ctx.query, ...(tone && ctx.clientNav ? { "ctx.client_nav": "1" } : {}) }),
    ...(global ? {} : { filters: project ? screenRead("projects/filters", { ...ctx.query, "ctx.family": "citations" }, true) : screenRead("citation/filter-bar", ctx.query, true) }),
  });
  const reset = tone ? ["page", "cursor", "q"] : ["page", "cursor"];
  return <Load result={result}>{v => {
    const view = tone ? <RnCitationToneUrlsView {...v.value<CitationToneUrlsScreen>("body")} /> : <RnCitationPromptsView {...v.value<CitationPromptsScreen>("body")} />;
    const raw = global ? null : v.value<CitationFilterBarScreen | ProjectFiltersView | null>("filters");
    const props = !raw ? null : project ? projectFilterProps(ctx, raw as ProjectFiltersView, "citation") : citationFilterProps(ctx, raw as CitationFilterBarScreen);
    return <Frame page={page} ctx={ctx} values={v} reset={reset}>{props ? <RnFilterRuntime reset={reset} pending={v.updating}><RnOverviewFilters props={props} savedFilters={{ page: project ? "project-citation" : "website-citation", userId: ctx.user.id, initial: [] }}>
      <div className="flex flex-col gap-3"><RnOverviewApplied /><RnBusyScope className="flex flex-col gap-4">{view}</RnBusyScope></div>
    </RnOverviewFilters></RnFilterRuntime> : view}</Frame>;
  }}</Load>;
}

function Acr({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const result = useReads({ ...commonReads(ctx), body: screenRead("acr/renewal", ctx.sp), header: screenRead("acr/renewal-header", ctx.sp) });
  return <Load result={result}>{v => { const read = v.value<RnAcrScreen>("body"); return <Frame page={page} ctx={ctx} values={v} filters={{ ...read.props, scope: ctx.user.scope }} savedPage="acr"><RnAcrBody input={read.body} preview={!CONNECTED} /></Frame>; }}</Load>;
}
