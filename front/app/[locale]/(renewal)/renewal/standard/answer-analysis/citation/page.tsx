import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { AllowedScope } from "@/lib/auth/types";
import { parseTimeRange } from "@/components/dash/filter-encoding";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type {
  CitationAsOfScreen,
  CitationFilterBarScreen,
  StandardCitationScreen,
} from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { STANDARD_CITATION_V2_ONLY_GROUPS } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/filter-groups";
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
import type { RnCitationInput, RnCitationVm } from "./_components/citation-input";
import { RnCitationBody } from "./_components/citation-body";

// Renewal Citation (2026-10-21) — the redesigned /standard/answer-analysis/citation, served side
// by side with the original. Data: the SAME screens as citation/page.tsx (`citation/as-of` for the
// header date and the 경쟁사 options, `citation/filter-bar` for the panel, `citation/standard`
// with ctx.variant=renewal for the body: the original's data plus the renewal model), handed to the
// client body as promises of that one answer.

export const maxDuration = 120;

const CITATION_AXES = ["brand", ...STANDARD_CITATION_V2_ONLY_GROUPS] as const;
type SearchParams = Record<string, string | string[] | undefined>;

export default async function RenewalCitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.citation");
  const tPage = await getTranslations("answerAnalysis");
  const tOv = await getTranslations("dashboard.overview");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  const query = { ...sp, "ctx.surface": "global" };
  // URL state: any citation filter axis set (empty result vs no measurement), the picked period
  const filtered = CITATION_AXES.some((k) => sp[k] != null && sp[k] !== "");
  const range = parseTimeRange(sp.time);
  const period = range?.from || range?.to ? { from: range.from ?? null, to: range.to ?? null } : null;
  const meta = screenGet<CitationAsOfScreen>("citation/as-of", query);
  const asOf = meta.then((m) => m.asOf);

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
          <span className="text-rn-13 text-rn-muted">{tPage("citations.description")}</span>
          <RnPill>
            <CalendarDays className="size-3 text-rn-muted" aria-hidden />
            {tOv("cadence")}
            <span aria-hidden className="h-3 w-px bg-rn-line-2" />
            <span className="font-semibold tabular-nums text-rn-ink-2">
              {period ? (
                t("periodRange", { from: period.from ?? "…", to: period.to ?? "…" })
              ) : (
                <Suspense fallback="…">
                  <AsOfText asOf={asOf} />
                </Suspense>
              )}
            </span>
          </RnPill>
        </>
      }
      actions={<RnCopyLinkButton />}
    />
  );
  const screen = screenGet<StandardCitationScreen<RnCitationVm>>("citation/standard", { ...query, "ctx.variant": "renewal" }).catch(
    (e: unknown) => throwForPage(e, locale),
  );
  const body: RnCitationInput = {
    api: true,
    period,
    filtered,
    data: screen.then((s) => s.live),
    dataDegraded: screen.then((s) => s.dataDegraded),
    sectionDegraded: screen.then((s) => s.sectionDegraded),
    prevCategories: screen.then((s) => s.prevCategories),
    toneSummary: screen.then((s) => s.toneSummary),
    tableSource: screen.then((s) => s.tableSource),
    periodView: screen.then((s) => s.periodView),
    rn: screen.then((s) => s.rn ?? null),
  };
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton header={header} />}>
        <RenewalCitation query={query} meta={meta} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} body={body} />
      </Suspense>
    </RnFilterRuntime>
  );
}

async function AsOfText({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const day = await asOf.catch(() => null);
  return <>{day ? t("lastMeasured", { date: day.slice(0, 10) }) : "—"}</>;
}

// Filter options: citation/page.tsx CitationsFilterBar (citation/filter-bar), awaited so the panel
// shows first; the 경쟁사 options stay a promise (the heavy citation read) so only that axis waits.
async function filterProps(query: SearchParams, meta: Promise<CitationAsOfScreen>, scope: AllowedScope, locale: string): Promise<OverviewFilterProps> {
  let bar: CitationFilterBarScreen;
  try {
    bar = await screenGet<CitationFilterBarScreen>("citation/filter-bar", query);
  } catch (e) {
    throwForPage(e, locale);
  }
  return {
    stage: "citation",
    scope,
    catalogRows: bar.options.catalogRows,
    geographyOptions: bar.options.geographyOptions,
    languageOptions: bar.options.languageOptions,
    optionMatrix: bar.options.optionMatrix,
    competitorOptions: meta.then((m) => m.competitorOptions).catch(() => []),
    collectionStartDay: bar.dates.collectionStartDay,
    latestAnchorDay: bar.dates.latestAnchorDay,
    selectableDates: bar.dates.selectableDates,
  };
}

async function RenewalCitation({
  query,
  meta,
  scope,
  userId,
  locale,
  header,
  body,
}: {
  query: SearchParams;
  meta: Promise<CitationAsOfScreen>;
  scope: AllowedScope;
  userId: string;
  locale: string;
  header: ReactNode;
  body: RnCitationInput;
}) {
  const [props, saved] = await Promise.all([filterProps(query, meta, scope, locale), loadSavedFilters("citation")]);
  return (
    <RnOverviewFilters props={props} savedFilters={{ page: "citation", userId, initial: saved }}>
      <RnFilterSplit header={header} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>
        <RnOverviewApplied />
        <RnBusyScope className="flex flex-col gap-4">
          <RnCitationBody input={body} />
        </RnBusyScope>
      </RnFilterSplit>
    </RnOverviewFilters>
  );
}

function PageSkeleton({ header }: { header: ReactNode }) {
  return (
    <RnFilterSplit header={header} panel={<RnCard className="h-[480px]" />} rail={<RnCard className="h-24" />}>
      <RnCard className="h-12" />
      <RnCard className="flex flex-col gap-3 p-6">
        <RnSkeleton className="h-4 w-40" />
        <RnSkeleton className="h-16 w-full" />
      </RnCard>
      <RnCard className="h-[320px]" />
    </RnFilterSplit>
  );
}
