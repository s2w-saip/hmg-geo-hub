import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { AllowedScope } from "@/lib/auth/types";
import { parseTimeRange } from "@/components/dash/filter-encoding";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import type { CitationAsOfScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
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
import type { RnCitationInput, RnWebsiteCitationScreen } from "../../../standard/answer-analysis/citation/_components/citation-input";
import { RnCitationBody } from "../../../standard/answer-analysis/citation/_components/citation-body";
import { websiteCitationFilterProps } from "./_shared/website-citation-filters";

// Renewal Website › Citation (2026-10-30, W3) — the renewal Citation body on the website surface, next to
// /website/answer-analysis/citation. Data: the SAME screens as the original website page (`citation/as-of`
// for the header date, `citation/filter-bar` for the panel, `citation/website` for the body) with
// ctx.surface=website; the body reads `citation/website` with ctx.variant=renewal: the renewal model on the
// website data, the 공식(당사) tile and the URL funnel (the original's URL rate cards, per engine and with Δ).

export const maxDuration = 120;

// The website citation axes (the original page's WEBSITE_ONLY_GROUPS + the admin brand slot): no catalog axes,
// no 경쟁사 (the website read has no competitor options).
const WEBSITE_CITATION_AXES = ["brand", "geography", "language", "engine", "time", "source"] as const;
type SearchParams = Record<string, string | string[] | undefined>;

export default async function RenewalWebsiteCitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.citation");
  const tw = await getTranslations("renewal.website.citation");
  const tPage = await getTranslations("answerAnalysis");
  const tOv = await getTranslations("dashboard.overview");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  const query: ScreenQuery = { ...sp, "ctx.surface": "website", "ctx.role": session.user.role };
  // URL state: any citation filter axis set (empty result vs no measurement), the picked period
  const filtered = WEBSITE_CITATION_AXES.some((k) => sp[k] != null && sp[k] !== "");
  const range = parseTimeRange(sp.time);
  const period = range?.from || range?.to ? { from: range.from ?? null, to: range.to ?? null } : null;
  const asOf = screenGet<CitationAsOfScreen>("citation/as-of", query).then((m) => m.asOf);

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
  const screen = screenGet<RnWebsiteCitationScreen>("citation/website", { ...query, "ctx.variant": "renewal" }).catch((e: unknown) =>
    throwForPage(e, locale),
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
    website: screen.then((s) => ({ own: s.own, reach: s.reach })),
  };
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton header={header} />}>
        <RenewalWebsiteCitation query={query} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} body={body} />
      </Suspense>
    </RnFilterRuntime>
  );
}

async function AsOfText({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const day = await asOf.catch(() => null);
  return <>{day ? t("lastMeasured", { date: day.slice(0, 10) }) : "—"}</>;
}

// Filter options: the original website page's filter bar (_shared/website-citation-filters.tsx, also the sub pages').
async function filterProps(query: ScreenQuery, scope: AllowedScope, locale: string): Promise<OverviewFilterProps> {
  try {
    return await websiteCitationFilterProps(query, scope);
  } catch (e) {
    throwForPage(e, locale);
  }
}

async function RenewalWebsiteCitation({
  query,
  scope,
  userId,
  locale,
  header,
  body,
}: {
  query: ScreenQuery;
  scope: AllowedScope;
  userId: string;
  locale: string;
  header: ReactNode;
  body: RnCitationInput;
}) {
  const [props, saved] = await Promise.all([filterProps(query, scope, locale), loadSavedFilters("website-citation")]);
  return (
    <RnOverviewFilters props={props} savedFilters={{ page: "website-citation", userId, initial: saved }}>
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
