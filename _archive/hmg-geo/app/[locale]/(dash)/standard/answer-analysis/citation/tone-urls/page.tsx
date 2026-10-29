import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { fetchStandardCitationToneSummary, fetchStandardCitationToneUrls } from "@/lib/scope/server";
import { getSession } from "@/lib/auth/session";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { CitationToneUrlsPage } from "../../_components/citation-tone-urls-page";

export const maxDuration = 120;

// 하위 페이지 — 긍정/부정 답변에 인용된 URL(디자인 585:1820).
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
  const filters = readStandardFilters(sp, session?.user.scope);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const tone = one(sp.tone) === "negative" ? "negative" : "positive";
  const page = Math.max(1, Number.parseInt(one(sp.page) || "1", 10) || 1);
  const q = one(sp.q);
  const byDomain = one(sp.by) === "domain";

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
