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
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
  type OverviewFilterProps,
} from "../../../_components/overview-filters";
import type { RnMentionInput } from "./_components/mention-input";
import type { RnAsOfVM, RnPageVM } from "./_data/screen-types";
import { RnMentionBody } from "./_components/mention-body";
import { RnMentionPageProvider, RnMentionTabs, RnMentionTabsFallback } from "./_components/mention-tabs";

// Renewal Mention (2026-10-21) — the redesigned /standard/answer-analysis/mention, served side
// by side with the original. Data: the screens "mention/rn-<section>" of the API (one read per
// section, back/bff/screens/mention_renewal.py) — they compute every number from the same reads
// as mention/page.tsx. This page shows the four KPIs together (product decision 2026-10-21), so it
// starts every section's read at once; each card resolves its own promise.

export const maxDuration = 120;

const MENTION_AXES = ["brand", "geography", "language", "engine", "time", "promptContext", "brandPresence", "listType", "depth1", "depth2", "depth3", "depth4"] as const;
const KPI_TABS: readonly KpiTab[] = ["exposure", "sov", "favorability", "first-rank"];

export default async function RenewalMentionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.mention");
  const tPage = await getTranslations("answerAnalysis");
  const tOv = await getTranslations("dashboard.overview");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  const q: ScreenQuery = { ...urlParams(sp), "ctx.surface": "global" };
  // any filter axis in the URL decides "결과 없음" vs "측정 대기" (URL state)
  const filtered = MENTION_AXES.some((k) => sp[k] != null && sp[k] !== "");
  const head = await screenGet<RnPageVM>("mention/rn-page", q).catch((e) => throwForPage(e, locale));
  const period = head.period;
  const asOf = period ? null : screenGet<RnAsOfVM>("mention/rn-asof", q).then((v) => v.asOf);

  const header = (
    <RnPageHeader
      title={
        <>
          {t("title")}
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
    ownLabel: head.ownLabel,
    period,
    filtered,
    ...sectionReads(q, locale),
  };
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton header={header} top={<RnMentionTabsFallback kpi={body.kpi} />} />}>
        <RenewalMention sp={sp} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} body={body} />
      </Suspense>
    </RnFilterRuntime>
  );
}

/** The page's URL params as given (screens parse them like the page did). */
function urlParams(sp: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(sp)) if (v !== undefined) out[k] = v;
  return out;
}

async function AsOfText({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const day = await asOf.catch(() => null);
  return <>{day ? t("lastMeasured", { date: day.slice(0, 10) }) : "—"}</>;
}

type Reads = Omit<RnMentionInput, "kpi" | "ownLabel" | "period" | "filtered">;

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

// Filter options: the shared panel screens (global surface, mention dates), awaited here so the
// panel shows first; the body streams after it.
async function filterProps(sp: Record<string, string | string[] | undefined>, scope: AllowedScope, locale: string): Promise<OverviewFilterProps> {
  try {
    const [options, dates] = await Promise.all([
      screenGet<PanelFilterOptions>("shared/panel-options", { ...urlParams(sp), surface: "global" }),
      screenGet<FilterDatesView>("shared/filter-dates", { surface: "global", family: "mentions" }),
    ]);
    return {
      stage: "mention",
      scope,
      catalogRows: options.catalogRows,
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

async function RenewalMention({
  sp,
  scope,
  userId,
  locale,
  header,
  body,
}: {
  sp: Record<string, string | string[] | undefined>;
  scope: AllowedScope;
  userId: string;
  locale: string;
  header: ReactNode;
  body: RnMentionInput;
}) {
  const props = await filterProps(sp, scope, locale);
  return (
    <RnOverviewFilters props={props} storageKey={`rn:saved-filters:v1:mention:${userId}`}>
      {/* the KPI tabs head the content column, right of the filter panel (2026-10-27): the filters
          cover every tab; one provider feeds the tabs and the body */}
      <RnMentionPageProvider input={body}>
        <RnFilterSplit
          header={header}
          top={<RnMentionTabs />}
          panel={<RnOverviewFilterPanel />}
          rail={<RnOverviewFilterRail />}
        >
          <RnOverviewApplied />
          <RnBusyScope className="flex flex-col gap-4">
            <RnMentionBody />
          </RnBusyScope>
        </RnFilterSplit>
      </RnMentionPageProvider>
    </RnOverviewFilters>
  );
}

function PageSkeleton({ header, top }: { header: ReactNode; top: ReactNode }) {
  return (
    <RnFilterSplit header={header} top={top} panel={<RnCard className="h-[480px]" />} rail={<RnCard className="h-24" />}>
      <RnCard className="h-12" />
      <RnCard className="flex flex-col gap-3 p-6">
        <RnSkeleton className="h-4 w-40" />
        <RnSkeleton className="h-16 w-full" />
      </RnCard>
      <RnCard className="h-[320px]" />
    </RnFilterSplit>
  );
}
