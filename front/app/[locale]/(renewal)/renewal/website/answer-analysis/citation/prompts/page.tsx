import { getTranslations, setRequestLocale } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { CitationPromptsScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { RnPageHeader, RnTag } from "@/components/renewal-ui";
import { RnCitationPromptsView } from "../../../../standard/answer-analysis/citation/_components/citation-subpages";
import { RnPageFrame } from "../../../../_components/filter-split";
import { PROMPTS_RESET, RnWebsiteCitationSubFilters } from "../_shared/website-citation-filters";

export const maxDuration = 120;

// Renewal Website sub page — 공식(당사) URL 인용/미인용 프롬프트 (2026-10-30, W3). The standard renewal sub page's
// view on the website filters: `citation/prompts` with ctx.surface=website reads what the website page's prompt
// tiles counted.
export default async function RenewalWebsiteCitationPromptsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("answerAnalysis.citations.v2.promptsPage");
  const tR = await getTranslations("renewal.citation");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
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
  const query = { ...sp, "ctx.surface": "website", "ctx.role": session.user.role };
  let s: CitationPromptsScreen;
  try {
    s = await screenGet<CitationPromptsScreen>("citation/prompts", query);
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <RnPageFrame header={header}>
      <RnWebsiteCitationSubFilters query={query} scope={session.user.scope} userId={session.user.id} reset={PROMPTS_RESET}>
        <RnCitationPromptsView tab={s.tab} page={s.page} q={s.q} ownedCount={s.ownedCount} uncitedCount={s.uncitedCount} />
      </RnWebsiteCitationSubFilters>
    </RnPageFrame>
  );
}
