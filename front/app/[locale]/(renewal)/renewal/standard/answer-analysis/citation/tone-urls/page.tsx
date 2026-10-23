import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { fetchStandardCitationToneSummary, fetchStandardCitationToneUrls } from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { throwForPage } from "@/lib/hgh/errors";
import { readCursorParam } from "@/lib/hgh/paginate";
import { isCitationsApi, loadToneUrlPage } from "@/lib/hgh/adapters/citations";
import { RnPageHeader, RnTag } from "@/components/renewal-ui";
import { RnCitationToneUrlsView } from "../_components/citation-subpages";
import { RnPageFrame } from "../../../../_components/filter-split";

export const maxDuration = 120;

// Renewal sub page — 긍정/부정 답변에 인용된 URL. The SAME reads as
// /standard/answer-analysis/citation/tone-urls/page.tsx (legacy readers, HGH_SOURCE_G2=api
// loadToneUrlPage with the cursor and the B045 count reuse). Keep the reads in step with the original.
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
  // the parent's period semantics — the tone counts are the parent card's read
  const filters = { ...readStandardFilters(sp, session.user.scope), cumulative: true };
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const tone = one(sp.tone) === "negative" ? "negative" : "positive";
  const page = Math.max(1, Number.parseInt(one(sp.page) || "1", 10) || 1);
  const q = one(sp.q);
  const byDomain = one(sp.by) === "domain";
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

  if (isCitationsApi("global")) {
    const cursor = readCursorParam(sp.cursor);
    // B045: an in-page cursor / search move reuses the counts the page already holds
    const reuseCounts = Boolean(cursor || q.trim()) && (await isClientNavigation());
    let res: Awaited<ReturnType<typeof loadToneUrlPage>>;
    try {
      res = await loadToneUrlPage(filters, { surface: "global", scope: session.user.scope ?? null }, { tone, byDomain, q, page, cursor, withCounts: !reuseCounts });
    } catch (e) {
      throwForPage(e, locale);
    }
    return (
      <RnPageFrame header={header}>
        <RnCitationToneUrlsView tone={tone} page={res.page} q={q} byDomain={byDomain} counts={res.counts} />
      </RnPageFrame>
    );
  }
  const [list, summary] = await Promise.all([
    fetchStandardCitationToneUrls(filters, { tone, page, q, pageSize: 50, groupBy: byDomain ? "domain" : "url" }),
    fetchStandardCitationToneSummary(filters),
  ]);
  return (
    <RnPageFrame header={header}>
      <RnCitationToneUrlsView tone={tone} page={list} q={q} byDomain={byDomain} counts={{ positive: summary?.positive.urls ?? null, negative: summary?.negative.urls ?? null }} />
    </RnPageFrame>
  );
}

/** An in-page client transition (the router's fetch: Sec-Fetch-Dest "empty"), not a document request. */
async function isClientNavigation(): Promise<boolean> {
  return (await headers()).get("sec-fetch-dest") === "empty";
}
