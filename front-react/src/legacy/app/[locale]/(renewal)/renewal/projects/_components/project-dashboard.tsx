"use client";

// Renewal Project › Dashboard (2026-11-03, P2) — the original project Dashboard's information on Gold values, laid
// out with the renewal Website Overview's sections (the same KPIs on the project surface):
//   KPI              the tiles by category, round Δ and the engine badge       website-kpis.tsx (project copy · links)
//   엔진별 비교       the engine rows behind 엔진 간 일관성                      website-breakdowns.tsx
//   출처별 구성비     top domains + 기타 (no topics: project prompts carry no catalog)   website-sources.tsx
//   KPI 추이         every series on its own axis (two rounds or more)          website-trend.tsx
//   프로젝트 현황     the project's Gold facts and its latest measured prompts; the original tiles Gold does not have
//                    (후보 · 멤버 · 프롬프트 상태) say 데이터 없음
// Screens: projects/dash-* (back/bff/screens/project_dashboard.py). The tiles and links stay in the project tab.

import { Suspense, use } from "react";
import { useLocale, useTranslations } from "use-intl";
import { ArrowRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { RnCard, RnCardHeader, RnEmpty } from "@/components/renewal-ui";
import type { KpiKey } from "@/app/[locale]/(dash)/dashboard/_data/model";
import type { CompositionView, TilesView, WebsiteTrendView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { useRnEngineOptions, useRnFilterToggle } from "../../_components/overview-filters";
import { RnKpiCardVariant, RnWebsiteKpis, type KpiCardVariant } from "../../website/_overview/website-kpis";
import { RnWebsiteEngines } from "../../website/_overview/website-breakdowns";
import { RnWebsiteSources } from "../../website/_overview/website-sources";
import { RnWebsiteTrend } from "../../website/_overview/website-trend";
import { CardSkeleton } from "../../website/_overview/website-overview-body";
import type { Failed, WebsiteEnginesView } from "../../website/_overview/website-format";
import { projectHref } from "./project-model";
import { SUPPORT } from "@/lib/support-contact";

/** projects/dash-status */
export interface ProjectStatusView {
  facts: {
    prompts: number;
    measuredPrompts: number;
    answers: number;
    rounds: number;
    countries: string[];
    engines: string[];
    customFields: number;
    lastMeasuredDay: string | null;
  } | null;
  recent: { promptId: string; text: string; answers: number; lastMeasuredDay: string | null }[];
}

export interface ProjectDashboardReads {
  /** projects/dash-summary-deferred: the tiles with Δ and the engine badge (the card-speed tiles when it failed). */
  deferred: Promise<TilesView>;
  engines: Promise<WebsiteEnginesView>;
  trend: Promise<WebsiteTrendView | Failed>;
  composition: Promise<CompositionView>;
  status: Promise<ProjectStatusView | Failed>;
}

/** The project page a KPI opens (the website Overview's rule on the project pages), with the page's filters. */
export function projectDetailHref(id: string, key: KpiKey, qs: string): string {
  const page =
    key === "visibility" ? "analysis/mention?kpi=exposure"
    : key === "shareOfVoice" ? "analysis/mention?kpi=sov"
    : key === "sentiment" ? "analysis/mention?kpi=favorability"
    : key === "position" ? "analysis/mention?kpi=first-rank"
    : key === "trafficConversion" ? "ai-funnel/conversion"
    : "analysis/citation";
  const href = projectHref(id, page);
  return qs ? `${href}${href.includes("?") ? "&" : "?"}${qs}` : href;
}

export function RnProjectDashboardBody({ id, tiles, reads, qs }: { id: string; tiles: TilesView; reads: ProjectDashboardReads; qs: string }) {
  const locale = useLocale();
  const t = useTranslations("renewal.projects.dashboard");
  const toggle = useRnFilterToggle();
  const engines = useRnEngineOptions();
  const variant: KpiCardVariant = {
    href: (key) => `/${locale}${projectDetailHref(id, key, qs)}`,
    newTab: false,
    // ⑤ on the project counts the project's own URLs (Gold: project 자사 = loc_owned), not the website's own-or-target
    copy: (k) => (t.has(`copy.${k}`) ? t(`copy.${k}` as "copy.definition.citationShare") : null),
  };
  return (
    <>
      <RnKpiCardVariant value={variant}>
        <RnWebsiteKpis tiles={tiles} deferred={reads.deferred} qs={qs} />
      </RnKpiCardVariant>
      <div className="@container/rnwrow">
        <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-stretch gap-2.5 @max-[1100px]/rnwrow:grid-cols-1">
          <Suspense fallback={<CardSkeleton rows={5} />}>
            <RnWebsiteEngines engines={reads.engines} onPick={(code) => toggle("engine", code)} pickable={(code) => engines.includes(code)} />
          </Suspense>
          <Suspense fallback={<CardSkeleton rows={8} />}>
            <RnWebsiteSources composition={reads.composition} citationHref={`/${locale}${projectDetailHref(id, "citationShare", qs)}`} newTab={false} />
          </Suspense>
        </div>
      </div>
      <Suspense fallback={<CardSkeleton rows={6} />}>
        <RnWebsiteTrend trend={reads.trend} />
      </Suspense>
      <Suspense fallback={<CardSkeleton rows={6} />}>
        <RnProjectStatus id={id} status={reads.status} />
      </Suspense>
    </>
  );
}

/** 프로젝트 현황: the project's Gold facts (not narrowed by the filters) and its latest measured prompts. */
export function RnProjectStatus({ id, status }: { id: string; status: Promise<ProjectStatusView | Failed> }) {
  const t = useTranslations("renewal.projects.dashboard");
  const locale = useLocale();
  const v = use(status);
  const num = (n: number) => n.toLocaleString(locale);
  const none = t("noData");
  const facts = v === "failed" ? null : v.facts;
  const cells: { key: string; label: string; value: string; sub?: string; missing?: boolean }[] = facts
    ? [
        { key: "prompts", label: t("facts.prompts"), value: num(facts.prompts), sub: t("facts.measured", { count: num(facts.measuredPrompts) }) },
        { key: "answers", label: t("facts.answers"), value: num(facts.answers), sub: t("facts.rounds", { count: num(facts.rounds) }) },
        { key: "last", label: t("facts.last"), value: facts.lastMeasuredDay ?? "—" },
        { key: "candidates", label: t("facts.candidates"), value: none, missing: true },
        { key: "members", label: t("facts.members"), value: none, missing: true },
        { key: "status", label: t("facts.status"), value: none, missing: true },
      ]
    : [];
  return (
    <RnCard aria-label={t("statusTitle")} className="min-w-0" data-rn-project-status="">
      <RnCardHeader title={t("statusTitle")} hint={t("statusHint")} />
      {v === "failed" ? (
        <RnEmpty className="mx-6 mb-5">{t("statusFailed", SUPPORT)}</RnEmpty>
      ) : (
        <>
          <dl className="m-0 grid grid-cols-6 border-y border-rn-line">
            {cells.map((c) => (
              <div key={c.key} data-rn-fact={c.key} className="flex min-w-0 flex-col gap-0.5 border-l border-rn-line px-5 py-3 first:border-l-0">
                <dt className="truncate text-rn-12 text-rn-muted">{c.label}</dt>
                <dd className={c.missing ? "m-0 text-rn-13 text-rn-faint" : "m-0 text-rn-20 font-bold tracking-[-0.02em] text-rn-ink tabular-nums"}>{c.value}</dd>
                {c.sub ? <dd className="m-0 text-rn-12 text-rn-muted tabular-nums">{c.sub}</dd> : null}
              </div>
            ))}
          </dl>
          <div className="flex items-center justify-between gap-3 px-6 pt-3.5 pb-1.5">
            <h3 className="m-0 text-rn-13 font-bold text-rn-ink-2">{t("recentTitle")}</h3>
            <Link prefetch={false} href={projectHref(id, "prompt")} className="inline-flex items-center gap-0.5 text-rn-12 font-semibold text-rn-navy hover:underline">
              {t("recentAll")}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
          {v.recent.length === 0 ? (
            <RnEmpty className="mx-6 mb-5">{t("recentEmpty")}</RnEmpty>
          ) : (
            <ol className="m-0 list-none px-6 pb-3" data-rn-recent-prompts="">
              {v.recent.map((p) => (
                <li key={p.promptId} className="flex items-baseline gap-4 border-t border-rn-line py-2 first:border-t-0">
                  <span className="min-w-0 flex-1 truncate text-rn-13 text-rn-ink" title={p.text}>{p.text}</span>
                  <span className="shrink-0 text-rn-12 text-rn-muted tabular-nums">{t("recentAnswers", { count: num(p.answers) })}</span>
                  <span className="w-[84px] shrink-0 text-right text-rn-12 text-rn-muted tabular-nums">{p.lastMeasuredDay ?? "—"}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="m-0 border-t border-rn-line px-6 py-2.5 text-rn-12 text-rn-muted">{t("statusFoot")}</p>
        </>
      )}
    </RnCard>
  );
}
