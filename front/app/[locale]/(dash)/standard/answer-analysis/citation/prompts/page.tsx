import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { CitationPromptsPage } from "../../_components/citation-prompts-page";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { CitationPromptsScreen } from "../../_data/citation-view";

export const maxDuration = 120;

// 하위 페이지 — 공식 도메인 인용/미인용 프롬프트(디자인 580:1146). 라우트 정책은
// 부모 `/standard/answer-analysis/citation` 의 접두 매칭으로 통과한다(route-policy).
//
// Data (BFF): `citation/prompts` with the page's URL params (the parent's filters and period
// semantics, tab / q / page / cursor): rows and both tab counts from one answer, the page window,
// the keyset cursor (D5, U7-N7).
export default async function CitationPromptsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("answerAnalysis.citations.v2.promptsPage");
  const sp = await searchParams;
  let s: CitationPromptsScreen;
  try {
    s = await screenGet<CitationPromptsScreen>("citation/prompts", { ...sp, "ctx.surface": "global" });
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <CitationPromptsPage tab={s.tab} page={s.page} q={s.q} ownedCount={s.ownedCount} uncitedCount={s.uncitedCount} />
    </div>
  );
}
