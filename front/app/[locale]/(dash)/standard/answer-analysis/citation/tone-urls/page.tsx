import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { CitationToneUrlsPage } from "../../_components/citation-tone-urls-page";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { CitationToneUrlsScreen } from "../../_data/citation-view";

export const maxDuration = 120;

// 하위 페이지 — 긍정/부정 답변에 인용된 URL(디자인 585:1820).
//
// Data (BFF): `citation/tone-urls` with the page's URL params (tone / q / page / by / cursor):
// rows, the two tab counts (BG-27) and the page window; keyset cursor in the URL (D5, U7-N7).
// DC-10: the tone lists and counts apply the source category filter.
//
// B045: 탭 카운트는 검색어·커서·탭·도메인 보기와 무관하다(같은 필터면 같은 값, BG-27). 화면 안의
// 커서·검색 이동(클라이언트 전이)은 카운트를 다시 세지 않고(counts null) 화면이 이미 받은 카운트를
// 다시 쓴다(CitationToneUrlsPage). 문서 요청(새로고침·직접 연 URL)은 화면에 받아 둔 값이 없을 수
// 있으므로 종전대로 함께 센다(ctx.client_nav 를 보내지 않는다). URL 계약은 그대로다.
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
  const sp = await searchParams;
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
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <CitationToneUrlsPage tone={s.tone} page={s.page} q={s.q} byDomain={s.byDomain} counts={s.counts} />
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
