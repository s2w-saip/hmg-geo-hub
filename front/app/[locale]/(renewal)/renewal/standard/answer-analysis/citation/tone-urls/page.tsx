import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { CitationToneUrlsScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { RnPageHeader, RnTag } from "@/components/renewal-ui";
import { RnCitationToneUrlsView } from "../_components/citation-subpages";
import { RnPageFrame } from "../../../../_components/filter-split";

export const maxDuration = 120;

// Renewal sub page — 긍정/부정 답변에 인용된 URL. The SAME screen as
// /standard/answer-analysis/citation/tone-urls/page.tsx (`citation/tone-urls`: rows, tab counts,
// the page window, the cursor and the B045 count reuse on an in-page move).
export default async function RenewalCitationToneUrlsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("answerAnalysis.citations.v2.toneUrlsPage");
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
  let s: CitationToneUrlsScreen;
  try {
    s = await screenGet<CitationToneUrlsScreen>("citation/tone-urls", {
      ...sp,
      "ctx.surface": "global",
      "ctx.client_nav": (await isClientNavigation()) ? "1" : null,
    });
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <RnPageFrame header={header}>
      <RnCitationToneUrlsView tone={s.tone} page={s.page} q={s.q} byDomain={s.byDomain} counts={s.counts} />
    </RnPageFrame>
  );
}

/** An in-page client transition (the router's fetch: Sec-Fetch-Dest "empty"), not a document request. */
async function isClientNavigation(): Promise<boolean> {
  return (await headers()).get("sec-fetch-dest") === "empty";
}
