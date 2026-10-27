import { getTranslations, setRequestLocale } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { CitationPromptsScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { RnPageHeader, RnTag } from "@/components/renewal-ui";
import { RnCitationPromptsView } from "../_components/citation-subpages";
import { RnPageFrame } from "../../../../_components/filter-split";

export const maxDuration = 120;

// Renewal sub page — 공식(당사) URL 인용/미인용 프롬프트. The SAME screen as
// /standard/answer-analysis/citation/prompts/page.tsx (`citation/prompts`: rows, both tab counts,
// the page window, the keyset cursor); the route policy passes it through the parent's prefix
// (/renewal/standard/answer-analysis/citation).
export default async function RenewalCitationPromptsRoute({
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
  let s: CitationPromptsScreen;
  try {
    s = await screenGet<CitationPromptsScreen>("citation/prompts", { ...sp, "ctx.surface": "global" });
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <RnPageFrame header={header}>
      <RnCitationPromptsView tab={s.tab} page={s.page} q={s.q} ownedCount={s.ownedCount} uncitedCount={s.uncitedCount} />
    </RnPageFrame>
  );
}
