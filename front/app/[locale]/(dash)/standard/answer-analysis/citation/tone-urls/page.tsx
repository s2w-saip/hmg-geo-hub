import { headers } from "next/headers";
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
//
// B045: 탭 카운트는 검색어·커서·탭·도메인 보기와 무관하다(같은 필터면 같은 값, BG-27). 화면 안의
// 커서·검색 이동(클라이언트 전이)은 카운트를 다시 세지 않고(with_counts 생략 → counts null) 화면이
// 이미 받은 카운트를 다시 쓴다(CitationToneUrlsPage). 문서 요청(새로고침·직접 연 URL)은 화면에
// 받아 둔 값이 없을 수 있으므로 종전대로 함께 센다. URL 계약은 그대로다.
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
    const cursor = readCursorParam(sp.cursor);
    // B045: 커서·검색 이동이 화면 안의 전이일 때만 카운트를 생략한다(화면이 받은 값을 다시 쓴다).
    const reuseCounts = Boolean(cursor || q.trim()) && (await isClientNavigation());
    let res: Awaited<ReturnType<typeof loadToneUrlPage>>;
    try {
      res = await loadToneUrlPage(
        filters,
        { surface: "global", scope: session?.user.scope ?? null },
        { tone, byDomain, q, page, cursor, withCounts: !reuseCounts },
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

/**
 * 이 렌더가 화면 안의 클라이언트 전이(라우터의 fetch: Sec-Fetch-Dest "empty")인가. 문서 요청
 * (navigate·document)이거나 헤더가 없으면(구형 브라우저 등) false — 그때는 종전대로 카운트를 센다.
 */
async function isClientNavigation(): Promise<boolean> {
  return (await headers()).get("sec-fetch-dest") === "empty";
}
