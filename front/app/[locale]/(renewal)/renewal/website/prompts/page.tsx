import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import type { AllowedScope } from "@/lib/auth/types";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import { RnCard, RnPageHeader, RnPill, RnSkeleton } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../../_components/filter-runtime";
import { loadSavedFilters } from "../../_components/saved-filters-server";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
  type OverviewFilterProps,
} from "../../_components/overview-filters";
import { RnWebsitePrompts } from "./_components/website-prompts-view";
import type { WebsitePromptInsights, WebsitePromptsPage } from "./_components/website-prompt-model";

// Renewal Website › Prompts (2026-10-30, W4) — the redesigned /website/prompts, served side by side with the
// original. Data: the original's filter options (website/prompts-options), its list query
// (back/bff/screens/website_prompts.py) cut into numbered pages (website/prompts-page) and the list's
// insights (website/prompts-insights: counts of the listed rows' Gold values). The filter panel is
// the Website panel of the other Website pages (surface "website", stage "overview": 국가 · 언어 · AI 엔진 ·
// 기간, 브랜드 for administrators = the original's axes). Engine and period are a lens: they choose the
// answers a row counts, never the rows (the panel says so on those axes).

type SP = Record<string, string | string[] | undefined>;

interface PromptOptionsView {
  geographyOptions: string[];
  languageOptions: string[];
  brandOptions: string[];
  selectableDates: string[] | null;
}

export default async function RenewalWebsitePromptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SP>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (same as the original page).
  if (!canAccessRoute(session.user.role, "/renewal/website/prompts")) redirect(`/${locale}/renewal/dashboard`);
  const sp = await searchParams;
  const ctx = { "ctx.admin": session.user.role === "admin" };
  // The list's first page leaves with the panel's options; the page number never comes from the URL
  // (the list keeps it, and a new query starts at page 1).
  const { page: _page, ...listParams } = sp;
  // one Gold read serves both (api.get runs identical reads once)
  const list = screenGet<WebsitePromptsPage>("website/prompts-page", { ...(listParams as ScreenQuery), ...ctx });
  const insights = screenGet<WebsitePromptInsights>("website/prompts-insights", { ...(listParams as ScreenQuery), ...ctx });
  // awaited in the body section; the page may fail on the options first
  list.catch(() => undefined);
  insights.catch(() => undefined);
  const [t, tOv, props, saved] = await Promise.all([
    getTranslations("website.prompts"),
    getTranslations("dashboard.overview"),
    filterOptions(session.user.scope, sp, ctx, locale),
    loadSavedFilters("website-prompts"),
  ]);
  const tw = await getTranslations("renewal.website.prompts");
  return (
    <RnFilterRuntime>
      <RnOverviewFilters props={props} savedFilters={{ page: "website-prompts", userId: session.user.id, initial: saved }}>
        <RnFilterSplit
          header={
            <RnPageHeader
              title={t("title")}
              meta={
                <>
                  <span className="text-rn-13 text-rn-muted">{t("subtitle")}</span>
                  <RnPill>
                    <CalendarDays className="size-3 text-rn-muted" aria-hidden />
                    {tOv("cadence")}
                    <span aria-hidden className="h-3 w-px bg-rn-line-2" />
                    <Suspense fallback={<RnSkeleton className="h-3 w-32" />}>
                      <LensRounds list={list} />
                    </Suspense>
                  </RnPill>
                </>
              }
              actions={<RnCopyLinkButton />}
            />
          }
          panel={<RnOverviewFilterPanel axisHelp={{ engine: tw("engineHelp"), time: tw("timeHelp") }} hint={tw("noPickHint")} />}
          rail={<RnOverviewFilterRail />}
        >
          <RnOverviewApplied />
          <RnBusyScope className="flex flex-col gap-4">
            <Suspense fallback={<BodySkeleton />}>
              <PromptsBody list={list} insights={insights} locale={locale} bodyKey={keyOf(listParams)} />
            </Suspense>
          </RnBusyScope>
        </RnFilterSplit>
      </RnOverviewFilters>
    </RnFilterRuntime>
  );
}

// The header's basis chip (the other Website pages' 측정 회차 chip): the rounds the list's measured columns count —
// the lens (기간 axis) or, unpicked, every round. The list's own read; its failure leaves the body to say so.
async function LensRounds({ list }: { list: Promise<WebsitePromptsPage> }) {
  const tw = await getTranslations("renewal.website.prompts");
  const axis = await list.then((v) => v.roundAxis).catch(() => null);
  return (
    <span className="font-semibold tabular-nums text-rn-ink-2">
      {axis?.length ? tw("basisRounds", { from: axis[0].slice(0, 10), to: axis[axis.length - 1].slice(0, 10) }) : "—"}
    </span>
  );
}

// The original page's filter options (website/prompts-options): its 국가 · 언어 · 브랜드 lists and round calendar.
async function filterOptions(scope: AllowedScope, sp: SP, ctx: ScreenQuery, locale: string): Promise<OverviewFilterProps> {
  let v: PromptOptionsView;
  try {
    v = await screenGet<PromptOptionsView>("website/prompts-options", { ...(sp as ScreenQuery), ...ctx });
  } catch (e) {
    throwForPage(e, locale);
  }
  return {
    scope,
    surface: "website",
    stage: "overview",
    geographyOptions: v.geographyOptions,
    languageOptions: v.languageOptions,
    // the brands of the options read, as the original's WebsitePromptFilters (renewal audit 13-4)
    brandOptions: v.brandOptions,
    selectableDates: v.selectableDates ?? undefined,
  };
}

// A new server answer (the panel applied a pick) replaces the body's state: keyed by the query it answers.
async function PromptsBody({ list, insights, locale, bodyKey }: { list: Promise<WebsitePromptsPage>; insights: Promise<WebsitePromptInsights>; locale: string; bodyKey: string }) {
  let initial: [WebsitePromptsPage, WebsitePromptInsights];
  try {
    initial = await Promise.all([list, insights]);
  } catch (e) {
    throwForPage(e, locale);
  }
  return <RnWebsitePrompts key={bodyKey} initial={initial[0]} initialInsights={initial[1]} />;
}

function keyOf(sp: SP): string {
  return JSON.stringify(Object.entries(sp).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function BodySkeleton() {
  return (
    <>
      <RnSkeleton className="h-[92px] w-full rounded-rn-card" />
      <div className="grid grid-cols-4 gap-3">
        <RnSkeleton className="col-span-2 h-[200px] rounded-rn-card" />
        <RnSkeleton className="h-[200px] rounded-rn-card" />
        <RnSkeleton className="h-[200px] rounded-rn-card" />
      </div>
      <RnCard className="flex flex-col gap-3 p-5">
        <RnSkeleton className="h-9 w-full" />
        {Array.from({ length: 8 }, (_, i) => (
          <RnSkeleton key={i} className="h-10 w-full" />
        ))}
      </RnCard>
    </>
  );
}
