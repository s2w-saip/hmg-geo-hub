import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { CalendarDays } from "lucide-react";
import { RnPageHeader, RnPill, RnTag } from "@/components/renewal-ui";
import { RnDaysPeriod, type RnDaysChoice } from "@/app/[locale]/(renewal)/renewal/_components/days-period";
import { RnBusyScope, RnFilterRuntime } from "@/app/[locale]/(renewal)/renewal/_components/filter-runtime";
import { RnCopyLinkButton, RnFilterSplit, RnOverviewApplied, RnOverviewFilterPanel, RnOverviewFilterRail, RnOverviewFilters, type OverviewFilterProps } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { RnAccountGate, RnSampleVeil } from "@/app/[locale]/(renewal)/renewal/_components/account-gate";
import { RnPageFrame } from "@/app/[locale]/(renewal)/renewal/_components/filter-split";
import type { SavedFilterPage } from "@/app/[locale]/(renewal)/renewal/_components/saved-filters";
import { RnConvBody } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/conversion/_components/conv-body";
import { RnConvSample } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/conversion/_components/conv-sample";
import type { RnConvScreen } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/conversion/_data/screen-types";
import { RnVisBody } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/visibility/_components/vis-body";
import { RnVisPageProvider, RnVisTabs } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/visibility/_components/vis-context";
import type { RnVisScreen, VisChoice } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/visibility/_data/screen-types";
import { tabOf } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/visibility/_data/tab";
import { KeywordSample } from "@/app/[locale]/(renewal)/renewal/admin/keyword-tools/_components/keyword-sample";
import { ProjectKeywordSample } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-keyword-sample";
import { ProjectSocialSample } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-social-sample";
import type { PageDefinition } from "~/app/pages";
import { Load, savedSource, screenRead, usePageContext, useReads, type PageContext } from "./load";

/** The period pill and copy-link header both funnel pages share. */
function FunnelHeader({ ns, title, choice }: { ns: "renewal.conversion" | "renewal.visibility"; title: string; choice: RnDaysChoice }) {
  const t = useTranslations(ns);
  return <RnPageHeader
    title={<>{title}<RnTag className="ml-2 align-middle text-rn-11">{t("beta")}</RnTag></>}
    meta={<><span className="text-rn-13 text-rn-muted">{t("subtitle")}</span><RnPill><CalendarDays className="size-3 text-rn-muted" aria-hidden />{t("cadence")}<span aria-hidden className="h-3 w-px bg-rn-line-2" /><span className="font-semibold tabular-nums text-rn-ink-2">{choice.preset != null || choice.days != null ? t("periodDays", { n: choice.preset ?? choice.days ?? 28 }) : t("range", { from: choice.from ?? "…", to: choice.to ?? "…" })}</span></RnPill></>}
    actions={<RnCopyLinkButton />}
  />;
}
const conversionQuery = (ctx: PageContext) => ctx.surface === "project" ? { ...ctx.sp, "ctx.surface": "project", "ctx.project_id": ctx.id } : ctx.sp;
const conversionSaved = (ctx: PageContext): SavedFilterPage => ctx.surface === "website" ? "website-conversion" : ctx.surface === "project" ? "project-conversion" : "conversion";

function Conversion({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const t = useTranslations("renewal.conversion");
  const tw = useTranslations("renewal.website.conversion");
  const result = useReads({ header: screenRead("conversion/renewal-header", ctx.sp), body: screenRead("conversion/renewal", conversionQuery(ctx)) });
  return <Load result={result}>{v => {
    const { props, body } = v.value<RnConvScreen>("body");
    const header = <FunnelHeader ns="renewal.conversion" title={ctx.surface === "website" ? tw("title") : t("title")} choice={v.value<RnDaysChoice>("header")} />;
    // no GA4 property yet: the page on sample data under the veil, filters included, and never sample next to measured values
    const sample = body.state === "noprop";
    const panel = <RnOverviewFilterPanel basis={<RnDaysPeriod choice={body.choice} period={body.period} />} axisHelp={{ engine: t("filters.engineHelp"), device: t("filters.deviceHelp"), visitorType: t("filters.visitorTypeHelp") }} hint={t("filters.hint")} />;
    return <RnFilterRuntime pending={v.updating}><RnOverviewFilters props={{ ...props, scope: ctx.user.scope } as OverviewFilterProps} savedFilters={savedSource(ctx, conversionSaved(ctx))}>
      <RnFilterSplit header={header} panel={sample ? <RnSampleVeil className="h-full">{panel}</RnSampleVeil> : panel} rail={<RnOverviewFilterRail />}>
        {sample ? <RnConvSample /> : <><RnOverviewApplied /><RnBusyScope className="flex flex-col gap-4"><RnConvBody input={body} /></RnBusyScope></>}
      </RnFilterSplit>
    </RnOverviewFilters></RnFilterRuntime>;
  }}</Load>;
}

function Visibility({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const t = useTranslations("renewal.visibility");
  const result = useReads({ header: screenRead("visibility/renewal-header", ctx.sp), body: screenRead("visibility/renewal", ctx.sp) });
  return <Load result={result}>{v => {
    const { props, body } = v.value<RnVisScreen>("body");
    return <RnFilterRuntime pending={v.updating}><RnVisPageProvider initialTab={tabOf(ctx.sp.view)}><RnOverviewFilters props={{ ...props, scope: ctx.user.scope } as OverviewFilterProps} savedFilters={savedSource(ctx, "visibility")}>
      <RnFilterSplit header={<FunnelHeader ns="renewal.visibility" title={t("title")} choice={v.value<VisChoice>("header")} />} top={body.state === "ok" ? <RnVisTabs view={body.view} /> : undefined}
        panel={<RnOverviewFilterPanel basis={<RnDaysPeriod choice={body.choice} period={body.period} />} axisHelp={{ engine: t("filters.engineHelp"), device: t("filters.deviceHelp") }} hint={t("filters.hint")} />} rail={<RnOverviewFilterRail />}>
        <RnOverviewApplied /><RnBusyScope className="flex flex-col gap-4"><RnVisBody input={body} /></RnBusyScope>
      </RnFilterSplit>
    </RnOverviewFilters></RnVisPageProvider></RnFilterRuntime>;
  }}</Load>;
}

/** Pages waiting on an outside account: the original screen on sample data under the account veil. They read nothing and call no paid API. */
function Sample({ page }: { page: PageDefinition }) {
  const tTools = useTranslations("keywordTools");
  const tIntent = useTranslations("renewal.projects.intent");
  const tNav = useTranslations("nav.projectDetail");
  const [title, meta, body]: [string, ReactNode, ReactNode] = page.kind === "keyword-tools" ? [tTools("title"), <span>{tTools("subtitle")}</span>, <KeywordSample />]
    : page.kind === "google-keyword" ? [tNav("intentGoogleKeyword"), <span className="text-rn-13 text-rn-muted">{tIntent("googleKeyword")}</span>, <ProjectKeywordSample />]
    : [tNav("intentSocialScraping"), <span className="text-rn-13 text-rn-muted">{tIntent("socialScraping")}</span>, <ProjectSocialSample />];
  return <RnPageFrame header={<RnPageHeader title={title} meta={meta} />}><RnAccountGate account="dataforseo"><div className="flex flex-col gap-2.5">{body}</div></RnAccountGate></RnPageFrame>;
}

export default function FunnelPage({ page }: { page: PageDefinition }) {
  if (page.kind === "conversion") return <Conversion page={page} />;
  if (page.kind === "visibility") return <Visibility page={page} />;
  return <Sample page={page} />;
}
