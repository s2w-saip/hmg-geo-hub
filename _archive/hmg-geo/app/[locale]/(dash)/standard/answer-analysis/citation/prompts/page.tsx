import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { fetchStandardCitationOwnedPrompts, fetchStandardCitations } from "@/lib/scope/server";
import { getSession } from "@/lib/auth/session";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { CitationPromptsPage } from "../../_components/citation-prompts-page";

export const maxDuration = 120;

// 하위 페이지 — 공식 도메인 인용/미인용 프롬프트(디자인 580:1146). 라우트 정책은
// 부모 `/standard/answer-analysis/citation` 의 접두 매칭으로 통과한다(route-policy).
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
  const session = await getSession();
  const sp = await searchParams;
  const filters = readStandardFilters(sp, session?.user.scope);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const tab = one(sp.tab) === "uncited" ? "uncited" : "owned";
  const page = Math.max(1, Number.parseInt(one(sp.page) || "1", 10) || 1);
  const q = one(sp.q);

  const [list, live] = await Promise.all([
    fetchStandardCitationOwnedPrompts(filters, { owned: tab === "owned", page, q, pageSize: 50 }),
    // 탭 카운트는 기존 인용 집계의 promptSplit(전량 정확 카운트)에서 — 캐시 공유.
    fetchStandardCitations(filters),
  ]);
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <CitationPromptsPage
        tab={tab}
        page={list}
        q={q}
        ownedCount={live?.promptSplit?.ownedCount ?? null}
        uncitedCount={live?.promptSplit?.uncitedCount ?? null}
      />
    </div>
  );
}
