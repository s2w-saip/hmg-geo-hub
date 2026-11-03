import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { CitationPromptsScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { RnPageHeader, RnTag } from "@/components/renewal-ui";
import { RnCitationPromptsView } from "../../../../../standard/answer-analysis/citation/_components/citation-subpages";
import { RnPageFrame } from "../../../../../_components/filter-split";
import { PROMPTS_RESET } from "../../../../../website/answer-analysis/citation/_shared/website-citation-filters";
import { RnProjectCitationSubFilters } from "../../../../_components/project-citation-filters";
import { projectPageSession, projectQuery } from "../../../../_components/project-filters-server";
import { shortId } from "../../../../_components/project-model";

export const maxDuration = 120;

// Renewal Project sub page — 자사 URL 인용 / 미인용 프롬프트 (2026-11-03, P3): the renewal sub page's view on the project's
// Citation filters (`citation/prompts` with ctx.surface=project; 자사 = Gold's project judgment, loc_owned).
type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "renewal.projects.citation.promptsPage" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("title")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectCitationPromptsRoute({ params, searchParams }: { params: Params; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const session = await projectPageSession(locale);
  const t = await getTranslations("renewal.projects.citation.promptsPage");
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
  let s: CitationPromptsScreen;
  try {
    s = await screenGet<CitationPromptsScreen>("citation/prompts", { ...projectQuery(id, sp), "ctx.surface": "project" });
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <RnPageFrame header={header}>
      <RnProjectCitationSubFilters id={id} sp={sp} scope={session.user.scope} userId={session.user.id} locale={locale} reset={PROMPTS_RESET}>
        <RnCitationPromptsView tab={s.tab} page={s.page} q={s.q} ownedCount={s.ownedCount} uncitedCount={s.uncitedCount} />
      </RnProjectCitationSubFilters>
    </RnPageFrame>
  );
}
