import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import type { AllowedScope } from "@/lib/auth/types";
import { parseTimeRange } from "@/components/dash/filter-encoding";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import type { CitationAsOfScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { RnCard, RnPageHeader, RnPill, RnSkeleton, RnTag } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../../../../_components/filter-runtime";
import { loadSavedFilters } from "../../../../_components/saved-filters-server";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
} from "../../../../_components/overview-filters";
import type { RnCitationInput, RnCitationVm } from "../../../../standard/answer-analysis/citation/_components/citation-input";
import type { StandardCitationScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { RnCitationBody } from "../../../../standard/answer-analysis/citation/_components/citation-body";
import { RnCitationPeriodText, type RnCitationHeader } from "../../../../standard/answer-analysis/citation/_components/citation-period";
import { projectFilterProps, projectPageSession, projectQuery } from "../../../_components/project-filters-server";
import { shortId } from "../../../_components/project-model";

// Renewal Project › Analysis › Citation (2026-11-03, P3): the renewal Citation body on the project surface. Data:
// `citation/project` with ctx.variant=renewal (back/bff/screens/citation.py project_renewal: citation/standard's renewal
// answer on the project's 기간 · 측정 국가 · AI 엔진 · 출처 · custom tags), `citation/as-of` for the header date and
// `citation/renewal-header` in period mode, both with ctx.surface=project. Project 자사 is Gold's project judgment
// (loc_owned); no 경쟁사 axis (the original project page had none). The table, drawer and sub pages read the project.

export const maxDuration = 120;

/** The project Citation's axes (overview-filter-model PROJECT_ONLY_GROUPS + 출처) — a custom tag (cf_*) counts too. */
const PROJECT_CITATION_AXES = ["geography", "engine", "time", "source"] as const;
type SearchParams = Record<string, string | string[] | undefined>;
type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "nav.projectDetail" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("analysisCitation")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectCitationPage({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const session = await projectPageSession(locale);
  const t = await getTranslations("renewal.citation");
  const tPage = await getTranslations("answerAnalysis");
  const sp = await searchParams;
  const query: ScreenQuery = { ...projectQuery(id, sp), "ctx.surface": "project" };
  // URL state: any citation filter axis set (empty result vs no measurement), the picked period (the body's mode)
  const filtered = Object.keys(sp).some((k) => ((PROJECT_CITATION_AXES as readonly string[]).includes(k) || k.startsWith("cf_")) && sp[k] != null && sp[k] !== "");
  const range = parseTimeRange(sp.time);
  const period = range?.from || range?.to ? { from: range.from ?? null, to: range.to ?? null } : null;
  const head = period ? screenGet<RnCitationHeader>("citation/renewal-header", query) : null;
  const asOf = head ? null : screenGet<CitationAsOfScreen>("citation/as-of", query).then((m) => m.asOf);

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
            <span className="font-semibold tabular-nums text-rn-ink-2">
              <Suspense fallback="…">{head ? <RnCitationPeriodText head={head} /> : <AsOfText asOf={asOf!} />}</Suspense>
            </span>
          </RnPill>
        </>
      }
      actions={<RnCopyLinkButton />}
    />
  );
  const screen = screenGet<StandardCitationScreen<RnCitationVm>>("citation/project", { ...query, "ctx.variant": "renewal" }).catch((e: unknown) =>
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
  };
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton header={header} />}>
        <ProjectCitation id={id} sp={sp} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} body={body} />
      </Suspense>
    </RnFilterRuntime>
  );
}

async function AsOfText({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const day = await asOf.catch(() => null);
  return <>{day ? t("lastMeasured", { date: day.slice(0, 10) }) : "—"}</>;
}

async function ProjectCitation({
  id,
  sp,
  scope,
  userId,
  locale,
  header,
  body,
}: {
  id: string;
  sp: SearchParams;
  scope: AllowedScope;
  userId: string;
  locale: string;
  header: ReactNode;
  body: RnCitationInput;
}) {
  const [props, saved] = await Promise.all([projectFilterProps(id, sp, scope, locale, "citation", "citations"), loadSavedFilters("project-citation")]);
  return (
    <RnOverviewFilters props={props} savedFilters={{ page: "project-citation", userId, initial: saved }}>
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
