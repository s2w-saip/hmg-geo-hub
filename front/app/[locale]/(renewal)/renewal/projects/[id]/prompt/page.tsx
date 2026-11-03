import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { screenGet } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import { aiEngineLabel } from "@/lib/scope/engines";
import { parseTimeRange, splitFilterValues } from "@/components/dash/filter-encoding";
import { countryName } from "@/lib/geo-catalog/country-name";
import { RnCard, RnPageHeader, RnPill, RnSkeleton } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../../../_components/filter-runtime";
import { loadSavedFilters } from "../../../_components/saved-filters-server";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
} from "../../../_components/overview-filters";
import { RnProjectPrompts, type ProjectPromptsView } from "../../_components/project-prompts";
import { projectFilterProps, projectPageSession, projectQuery } from "../../_components/project-filters-server";
import { shortId } from "../../_components/project-model";

// Renewal Project › Prompt (2026-11-03, P4): the project's prompts and their custom tag values as Gold holds them
// (screen projects/prompts → gold/projects/{id}?view=prompts), read only. The original page's writes (candidates,
// manual input, tag editing, run, delete, import) and its status (draft · queued · running …) live in the original
// operations DB only: the page says so (D-7 decides the write path). The panel: the project axes, where 측정 국가 ·
// AI 엔진 · 기간 are a lens (the answers a row counts) and the tags narrow the rows.

type SP = Record<string, string | string[] | undefined>;
type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "nav.projectDetail" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("prompt")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectPromptPage({ params, searchParams }: { params: Params; searchParams: Promise<SP> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const session = await projectPageSession(locale);
  const sp = await searchParams;
  const list = screenGet<ProjectPromptsView>("projects/prompts", projectQuery(id, sp));
  list.catch(() => undefined);
  const [t, tw, tNav, props, saved] = await Promise.all([
    getTranslations("renewal.projects.prompts"),
    getTranslations("renewal.website.prompts"),
    getTranslations("nav.projectDetail"),
    projectFilterProps(id, sp, session.user.scope, locale),
    loadSavedFilters("project-prompt"),
  ]);
  // the lens the sheet names: the picked countries, engines and period
  const range = parseTimeRange(sp.time);
  const lens = [
    ...splitFilterValues(sp.geography).map((c) => countryName(c, locale)),
    ...splitFilterValues(sp.engine).map((e) => aiEngineLabel(e.toLowerCase())),
    ...(range?.from || range?.to ? [`${range.from ?? "…"} ~ ${range.to ?? "…"}`] : []),
  ];
  return (
    <RnFilterRuntime>
      <RnOverviewFilters props={props} savedFilters={{ page: "project-prompt", userId: session.user.id, initial: saved }}>
        <RnFilterSplit
          header={
            <RnPageHeader
              title={tNav("prompt")}
              meta={
                <>
                  <span className="text-rn-13 text-rn-muted">{t("description")}</span>
                  <RnPill>
                    <CalendarDays className="size-3 text-rn-muted" aria-hidden />
                    <Suspense fallback={<RnSkeleton className="h-3 w-32" />}>
                      <LensRounds list={list} empty={t("noRound")} label={(from, to) => tw("basisRounds", { from, to })} />
                    </Suspense>
                  </RnPill>
                </>
              }
              actions={<RnCopyLinkButton />}
            />
          }
          panel={<RnOverviewFilterPanel axisHelp={{ geography: t("countryHelp"), engine: tw("engineHelp"), time: tw("timeHelp") }} hint={t("noPickHint")} />}
          rail={<RnOverviewFilterRail />}
        >
          <RnOverviewApplied />
          <RnBusyScope className="flex flex-col gap-4">
            <Suspense fallback={<BodySkeleton />}>
              <Body id={id} list={list} lens={lens} locale={locale} />
            </Suspense>
          </RnBusyScope>
        </RnFilterSplit>
      </RnOverviewFilters>
    </RnFilterRuntime>
  );
}

async function LensRounds({ list, empty, label }: { list: Promise<ProjectPromptsView>; empty: string; label: (from: string, to: string) => string }) {
  const rounds = await list.then((v) => v.rounds, () => null);
  return <span className="font-semibold tabular-nums text-rn-ink-2">{rounds?.length ? label(rounds[0], rounds[rounds.length - 1]) : rounds ? empty : "—"}</span>;
}

async function Body({ id, list, lens, locale }: { id: string; list: Promise<ProjectPromptsView>; lens: string[]; locale: string }) {
  let view: ProjectPromptsView;
  try {
    view = await list;
  } catch (e) {
    throwForPage(e, locale);
  }
  return <RnProjectPrompts id={id} view={view} lens={lens} />;
}

function BodySkeleton() {
  return (
    <RnCard className="p-6">
      <RnSkeleton className="mb-4 h-4 w-32" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 8 }, (_, i) => (
          <RnSkeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </RnCard>
  );
}
