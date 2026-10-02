import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { fetchStandardCitationToneSummary, fetchStandardCitationToneUrls } from "@/lib/scope/server";
import { getSession } from "@/lib/auth/session";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { CitationToneUrlsPage } from "../../_components/citation-tone-urls-page";
import { throwForPage } from "@/lib/hgh/errors";
import { readCursorParam } from "@/lib/hgh/paginate";
import { isCitationsApi, loadToneUrlPage } from "@/lib/hgh/adapters/citations";

export const maxDuration = 120;

// 하위 페이지 — 긍정/부정 답변에 인용된 URL(디자인 585:1820).
//
// Data source (unit U7, D8): HGH_SOURCE_G2 = api -> loadToneUrlPage (GET /v1/citations/sources/tone
// with with_counts: rows and both tab counts in one answer, BG-27; keyset cursor in the URL: D5,
// U7-N7); legacy (default) -> the readers below, unchanged. DC-10: the tone lists and counts apply
// the source category filter.
export default async function CitationToneUrlsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("answerAnalysis.citations.v2.toneUrlsPage");
  const session = await getSession();
  const sp = await searchParams;
  // 부모 화면(`../page.tsx:67`)과 **같은 기간 의미론** — 톤 카운트(`fetchStandard
  // CitationToneSummary`)가 부모 카드와 같은 집계라, 한쪽만 누적이면 갈린다(2026-09-16).
  const filters = { ...readStandardFilters(sp, session?.user.scope), cumulative: true };
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const tone = one(sp.tone) === "negative" ? "negative" : "positive";
  const page = Math.max(1, Number.parseInt(one(sp.page) || "1", 10) || 1);
  const q = one(sp.q);
  const byDomain = one(sp.by) === "domain";

  if (isCitationsApi("global")) {
    let res: Awaited<ReturnType<typeof loadToneUrlPage>>;
    try {
      res = await loadToneUrlPage(
        filters,
        { surface: "global", scope: session?.user.scope ?? null },
        { tone, byDomain, q, page, cursor: readCursorParam(sp.cursor) },
      );
    } catch (e) {
      throwForPage(e, locale);
    }
    return (
      <div className="flex animate-fade-in flex-col gap-6">
        <PageHeader title={t("title")} description={t("description")} />
        <CitationToneUrlsPage tone={tone} page={res.page} q={q} byDomain={byDomain} counts={res.counts} />
      </div>
    );
  }
  const [list, summary] = await Promise.all([
    fetchStandardCitationToneUrls(filters, { tone, page, q, pageSize: 50, groupBy: byDomain ? "domain" : "url" }),
    fetchStandardCitationToneSummary(filters),
  ]);
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <CitationToneUrlsPage
        tone={tone}
        page={list}
        q={q}
        byDomain={byDomain}
        counts={{ positive: summary?.positive.urls ?? null, negative: summary?.negative.urls ?? null }}
      />
    </div>
  );
}
