import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { CitationToneUrlsScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { RnPageHeader, RnTag } from "@/components/renewal-ui";
import { RnCitationToneUrlsView } from "../../../../../standard/answer-analysis/citation/_components/citation-subpages";
import { RnPageFrame } from "../../../../../_components/filter-split";
import { TONE_URLS_RESET } from "../../../../../website/answer-analysis/citation/_shared/website-citation-filters";
import { RnProjectCitationSubFilters } from "../../../../_components/project-citation-filters";
import { projectPageSession, projectQuery } from "../../../../_components/project-filters-server";
import { shortId } from "../../../../_components/project-model";

export const maxDuration = 120;

// Renewal Project sub page — 긍정/부정 답변에 인용된 URL (2026-11-03, P3): the renewal sub page's view on the project's
// Citation filters (`citation/tone-urls` with ctx.surface=project; no service week on the project surface).
type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "answerAnalysis.citations.v2.toneUrlsPage" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("title")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectCitationToneUrlsRoute({ params, searchParams }: { params: Params; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const session = await projectPageSession(locale);
  const t = await getTranslations("answerAnalysis.citations.v2.toneUrlsPage");
  const tR = await getTranslations("renewal.citation");
  const sp = await searchParams;
  const header = (
    <RnPageHeader
      title={
        <>
          {t("title")}
          <RnTag className="ml-2 align-middle text-rn-11">{tR("beta")}</RnTag>
        </>
      }
      meta={<span className="text-rn-13 text-rn-muted">{t("description")}</span>}
    />
  );
  let s: CitationToneUrlsScreen;
  try {
    s = await screenGet<CitationToneUrlsScreen>("citation/tone-urls", {
      ...projectQuery(id, sp),
      "ctx.surface": "project",
      "ctx.client_nav": (await isClientNavigation()) ? "1" : null,
    });
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <RnPageFrame header={header}>
      <RnProjectCitationSubFilters id={id} sp={sp} scope={session.user.scope} userId={session.user.id} locale={locale} reset={TONE_URLS_RESET}>
        <RnCitationToneUrlsView tone={s.tone} page={s.page} q={s.q} byDomain={s.byDomain} counts={s.counts} weekEnd={s.weekEnd} />
      </RnProjectCitationSubFilters>
    </RnPageFrame>
  );
}

/** An in-page client transition (the router's fetch: Sec-Fetch-Dest "empty"), not a document request. */
async function isClientNavigation(): Promise<boolean> {
  return (await headers()).get("sec-fetch-dest") === "empty";
}
