import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import type { AllowedScope } from "@/lib/auth/types";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import { KPI_TAB_PARAM, resolveKpiTab, type KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
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
import { MENTION_VIEW_PARAM, resolveMentionView, type MentionView, type RnMentionInput } from "../../../../standard/answer-analysis/mention/_components/mention-input";
import type { RnAsOfVM, RnPageVM } from "../../../../standard/answer-analysis/mention/_data/screen-types";
import { RnMentionBody } from "../../../../standard/answer-analysis/mention/_components/mention-body";
import { RnMentionPageProvider, RnMentionTabsFallback } from "../../../../standard/answer-analysis/mention/_components/mention-tabs";
import { projectFilterProps, projectPageSession, projectQuery } from "../../../_components/project-filters-server";
import { shortId } from "../../../_components/project-model";

// Renewal Project › Analysis › Mention (2026-11-03, P3): the renewal Mention's screens "mention/rn-<section>" with
// ctx.surface=project (back/bff/screens/mention_data.py surface_filters: the project's 기간 · 측정 국가 · AI 엔진 · custom
// tags), drawn by the Global Mention body — project prompts ask about the market as Global's do (rivals lead them:
// Toyota 941 · 당사 611 mentions on 35ae7ec0), unlike the website's own-page prompts. 당사 is Gold's default perspective
// HMG, as on the original project page (mention/view). Project reads are live only: no service week; a period compares
// with Gold's period before. The drawers read the original project routes (the path's project id, mention-brands.tsx).

export const maxDuration = 120;

/** The project page's axes (overview-filter-model PROJECT_ONLY_GROUPS) — a custom tag (cf_*) counts too. */
const PROJECT_AXES = ["geography", "engine", "time"] as const;
const KPI_TABS: readonly KpiTab[] = ["exposure", "sov", "favorability", "first-rank"];

type Sp = Record<string, string | string[] | undefined>;
type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "nav.projectDetail" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("analysisMention")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectMentionPage({ params, searchParams }: { params: Params; searchParams: Promise<Sp> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const session = await projectPageSession(locale);
  const t = await getTranslations("renewal.mention");
  const tPage = await getTranslations("answerAnalysis");
  const sp = await searchParams;
  const q: ScreenQuery = { ...projectQuery(id, urlParams(sp)), "ctx.surface": "project" };
  // a project axis in the URL decides "결과 없음" vs "측정 대기"
  const filtered = Object.keys(sp).some((k) => ((PROJECT_AXES as readonly string[]).includes(k) || k.startsWith("cf_")) && sp[k] != null && sp[k] !== "");
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
    ...sectionReads(q, locale),
  };
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton header={header} kpi={body.kpi} view={body.view} />}>
        <ProjectMention id={id} sp={sp} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} body={body} />
      </Suspense>
    </RnFilterRuntime>
  );
}

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

/** One screen read per section, all started now (the Global Mention page's reads, on the project). */
function sectionReads(q: ScreenQuery, locale: string): Reads {
  const get = <T,>(name: string, extra?: ScreenQuery) => screenGet<T>(`mention/${name}`, extra ? { ...q, ...extra } : q);
  return {
    tabValue: Object.fromEntries(KPI_TABS.map((k) => [k, get("rn-tab-value", { "ctx.kpi": k })])) as Reads["tabValue"],
    tabDeltas: get("rn-tab-deltas"),
    // the body aggregate decides the page; its 401/403/404 are the page's
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

async function ProjectMention({
  id,
  sp,
  scope,
  userId,
  locale,
  header,
  body,
}: {
  id: string;
  sp: Sp;
  scope: AllowedScope;
  userId: string;
  locale: string;
  header: ReactNode;
  body: RnMentionInput;
}) {
  const [props, saved] = await Promise.all([projectFilterProps(id, sp, scope, locale, "mention"), loadSavedFilters("project-mention")]);
  return (
    <RnOverviewFilters props={props} savedFilters={{ page: "project-mention", userId, initial: saved }}>
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
