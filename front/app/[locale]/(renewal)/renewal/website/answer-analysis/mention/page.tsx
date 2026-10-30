import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { AllowedScope } from "@/lib/auth/types";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import type { FilterDatesView, PanelFilterOptions } from "@/lib/hgh/filter-types";
import { throwForPage } from "@/lib/hgh/errors";
import { KPI_TAB_PARAM, resolveKpiTab, type KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import { RnCard, RnPageHeader, RnPill, RnSkeleton, RnTag } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../../../_components/filter-runtime";
import { loadSavedFilters } from "../../../_components/saved-filters-server";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
  type OverviewFilterProps,
} from "../../../_components/overview-filters";
import {
  MENTION_VIEW_PARAM,
  resolveMentionView,
  type MentionView,
  type RnMentionInput,
} from "../../../standard/answer-analysis/mention/_components/mention-input";
import type { RnAsOfVM, RnPageVM } from "../../../standard/answer-analysis/mention/_data/screen-types";
import { RnMentionBody } from "../../../standard/answer-analysis/mention/_components/mention-body";
import { RnMentionPageProvider, RnMentionTabsFallback } from "../../../standard/answer-analysis/mention/_components/mention-tabs";
import { RnSiteCards, type RnSiteCardsVM } from "./_components/site-cards";
import { RnWeeklyMentions, type RnWeeklyVM } from "./_components/weekly-mentions";

// Renewal Website Mention (2026-10-30, W2) — the redesigned /website/answer-analysis/mention: the renewal Global
// Mention (its body and screens "mention/rn-<section>") over the website surface. ctx.surface=website makes the
// screens read the website page's filters (back/bff/screens/mention_data.py website_filters: site country, language,
// engine, period; brand with ctx.admin) from the same loaders the original page's mention/view reads, so the values
// both pages show agree. Nothing the original showed is dropped (the user, 2026-10-30: a legacy KPI is reshaped,
// never dropped): its summary and signal counts sit under 이번 회차 요약 as the KPI breakdown, grouped by the KPI tab
// each explains (mention/view-cards; the 미언급 count opens its prompt list), and its weekly brand mentions close
// 브랜드 상세 (mention/view-weekly). Filters: the shared panel with surface "website"; its saved filters are its own.

export const maxDuration = 120;

/** The website page's axes (the original WEBSITE_ONLY_GROUPS; brand for an administrator). */
const WEBSITE_AXES = ["geography", "language", "engine", "time"] as const;
const KPI_TABS: readonly KpiTab[] = ["exposure", "sov", "favorability", "first-rank"];

type Sp = Record<string, string | string[] | undefined>;

export default async function RenewalWebsiteMentionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Sp>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.mention");
  const tw = await getTranslations("renewal.website.mention");
  const tPage = await getTranslations("answerAnalysis");
  const tOv = await getTranslations("dashboard.overview");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  // the panel offers the brand axis to an unrestricted account (overview-filter-model.ts); the screens read it then
  const admin = session.user.scope.all === true;
  const sp = await searchParams;
  const q: ScreenQuery = { ...urlParams(sp), "ctx.surface": "website", ...(admin ? { "ctx.admin": "true" } : {}) };
  // a website axis in the URL decides "결과 없음" vs "측정 대기" (the screens ignore the Global-only axes)
  const filtered = axes(admin).some((k) => sp[k] != null && sp[k] !== "");
  const head = await screenGet<RnPageVM>("mention/rn-page", q).catch((e) => throwForPage(e, locale));
  const period = head.period;
  const asOf = period ? null : screenGet<RnAsOfVM>("mention/rn-asof", q).then((v) => v.asOf);

  const header = (
    <RnPageHeader
      title={
        <>
          {tw("title")}
          <RnTag className="ml-2 align-middle text-rn-11">{t("beta")}</RnTag>
        </>
      }
      meta={
        <>
          <span className="text-rn-13 text-rn-muted">{tPage("mentions.description")}</span>
          <RnPill>
            <CalendarDays className="size-3 text-rn-muted" aria-hidden />
            {tOv("cadence")}
            <span aria-hidden className="h-3 w-px bg-rn-line-2" />
            <span className="font-semibold tabular-nums text-rn-ink-2">
              {period ? (
                t("periodRange", { from: period.from ?? "…", to: period.to ?? "…" })
              ) : (
                <Suspense fallback="…">
                  <AsOfText asOf={asOf!} />
                </Suspense>
              )}
            </span>
          </RnPill>
        </>
      }
      actions={<RnCopyLinkButton />}
    />
  );
  const body: RnMentionInput = {
    kpi: resolveKpiTab(sp[KPI_TAB_PARAM]),
    view: resolveMentionView(sp[MENTION_VIEW_PARAM]),
    ownLabel: head.ownLabel,
    period,
    filtered,
    afterSummary: <RnSiteCards cards={screenGet<RnSiteCardsVM>("mention/view-cards", q)} period={Boolean(period)} pageAsOf={asOf ? asOf.catch(() => null) : null} />,
    brandsExtra: <RnWeeklyMentions weekly={screenGet<RnWeeklyVM>("mention/view-weekly", q)} />,
    ...sectionReads(q, locale),
  };
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton header={header} kpi={body.kpi} view={body.view} />}>
        <RenewalWebsiteMention sp={sp} admin={admin} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} body={body} />
      </Suspense>
    </RnFilterRuntime>
  );
}

const axes = (admin: boolean): string[] => [...WEBSITE_AXES, ...(admin ? ["brand"] : [])];

/** The page's URL params as given (screens parse them like the page did). */
function urlParams(sp: Sp): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(sp)) if (v !== undefined) out[k] = v;
  return out;
}

async function AsOfText({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const day = await asOf.catch(() => null);
  return <>{day ? t("lastMeasured", { date: day.slice(0, 10) }) : "—"}</>;
}

type Reads = Omit<RnMentionInput, "kpi" | "view" | "ownLabel" | "period" | "filtered">;

/** One screen read per section, all started now (the tabs switch in place, every section is needed). */
function sectionReads(q: ScreenQuery, locale: string): Reads {
  const get = <T,>(name: string, extra?: ScreenQuery) => screenGet<T>(`mention/${name}`, extra ? { ...q, ...extra } : q);
  return {
    tabValue: Object.fromEntries(KPI_TABS.map((k) => [k, get("rn-tab-value", { "ctx.kpi": k })])) as Reads["tabValue"],
    tabDeltas: get("rn-tab-deltas"),
    // the body aggregate decides the page; its 401/403/404 are the page's (original MentionsData)
    shell: get<Awaited<Reads["shell"]>>("rn-shell").catch((e) => throwForPage(e, locale)),
    compare: get("rn-compare"),
    summary: get("rn-summary"),
    rateValue: get("rn-rate-value"),
    rateHero: get("rn-rate-hero"),
    rateEngines: get("rn-rate-engines"),
    rateTypes: get("rn-rate-types"),
    favorHero: get("rn-favor-hero"),
    favorDist: get("rn-favor-dist"),
    favorMatrix: get("rn-favor-matrix"),
    rank: get("rn-rank"),
    bump: get("rn-bump"),
    ranking: get("rn-ranking"),
  };
}

// Filter options: the shared panel screens on the website surface (the original page's reads: the panel narrows by
// the website axes only), awaited here so the panel shows first; the body streams after it.
async function filterProps(sp: Sp, admin: boolean, scope: AllowedScope, locale: string): Promise<OverviewFilterProps> {
  const keys = axes(admin);
  const panelSp = Object.fromEntries(Object.entries(urlParams(sp)).filter(([k]) => keys.includes(k)));
  try {
    const [options, dates] = await Promise.all([
      screenGet<PanelFilterOptions>("shared/panel-options", { ...panelSp, surface: "website" }),
      screenGet<FilterDatesView>("shared/filter-dates", { surface: "website", family: "mentions" }),
    ]);
    return {
      stage: "mention",
      surface: "website",
      scope,
      geographyOptions: options.geographyOptions,
      languageOptions: options.languageOptions,
      optionMatrix: options.optionMatrix,
      collectionStartDay: dates.collectionStartDay,
      latestAnchorDay: dates.latestAnchorDay,
      selectableDates: dates.selectableDates,
    };
  } catch (e) {
    throwForPage(e, locale);
  }
}

async function RenewalWebsiteMention({
  sp,
  admin,
  scope,
  userId,
  locale,
  header,
  body,
}: {
  sp: Sp;
  admin: boolean;
  scope: AllowedScope;
  userId: string;
  locale: string;
  header: ReactNode;
  body: RnMentionInput;
}) {
  const [props, saved] = await Promise.all([filterProps(sp, admin, scope, locale), loadSavedFilters("website-mention")]);
  return (
    <RnOverviewFilters props={props} savedFilters={{ page: "website-mention", userId, initial: saved }}>
      <RnMentionPageProvider input={body}>
        <RnFilterSplit header={header} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>
          <RnOverviewApplied />
          <RnBusyScope className="flex flex-col gap-4">
            <RnMentionBody />
          </RnBusyScope>
        </RnFilterSplit>
      </RnMentionPageProvider>
    </RnOverviewFilters>
  );
}

function PageSkeleton({ header, kpi, view }: { header: ReactNode; kpi: KpiTab; view: MentionView }) {
  return (
    <RnFilterSplit header={header} panel={<RnCard className="h-[480px]" />} rail={<RnCard className="h-24" />}>
      <RnCard className="h-12" />
      <RnCard className="flex min-h-[214px] flex-col gap-3 p-6">
        <RnSkeleton className="h-4 w-40" />
        <RnSkeleton className="h-16 w-full" />
      </RnCard>
      <RnMentionTabsFallback kpi={kpi} view={view} />
      <RnCard className="h-[320px]" />
    </RnFilterSplit>
  );
}
