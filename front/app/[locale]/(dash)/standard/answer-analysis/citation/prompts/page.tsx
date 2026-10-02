import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { fetchStandardCitationOwnedPrompts, fetchStandardCitations } from "@/lib/scope/server";
import { getSession } from "@/lib/auth/session";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { CitationPromptsPage } from "../../_components/citation-prompts-page";
import { throwForPage } from "@/lib/hgh/errors";
import { readCursorParam } from "@/lib/hgh/paginate";
import { isCitationsApi, loadOwnedPromptPage } from "@/lib/hgh/adapters/citations";

export const maxDuration = 120;

// 하위 페이지 — 공식 도메인 인용/미인용 프롬프트(디자인 580:1146). 라우트 정책은
// 부모 `/standard/answer-analysis/citation` 의 접두 매칭으로 통과한다(route-policy).
//
// Data source (unit U7, D8): HGH_SOURCE_G2 = api -> loadOwnedPromptPage (GET /v1/citations/prompts,
// rows and both tab counts in one answer, keyset cursor in the URL: D5, U7-N7); legacy (default)
// -> the readers below, unchanged.
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
  // 부모 화면(`../page.tsx:67`)과 **같은 기간 의미론**이어야 한다 — 이 페이지의
  // 탭 카운트는 부모와 같은 `fetchStandardCitations` 에서 나온다. 부모만 누적이면
  // 같은 숫자가 두 화면에서 갈린다(2026-09-16).
  const filters = { ...readStandardFilters(sp, session?.user.scope), cumulative: true };
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const tab = one(sp.tab) === "uncited" ? "uncited" : "owned";
  const page = Math.max(1, Number.parseInt(one(sp.page) || "1", 10) || 1);
  const q = one(sp.q);

  if (isCitationsApi("global")) {
    let res: Awaited<ReturnType<typeof loadOwnedPromptPage>>;
    try {
      res = await loadOwnedPromptPage(
        filters,
        { surface: "global", scope: session?.user.scope ?? null },
        { owned: tab === "owned", q, page, cursor: readCursorParam(sp.cursor) },
      );
    } catch (e) {
      throwForPage(e, locale);
    }
    return (
      <div className="flex animate-fade-in flex-col gap-6">
        <PageHeader title={t("title")} description={t("description")} />
        <CitationPromptsPage tab={tab} page={res.page} q={q} ownedCount={res.ownedCount} uncitedCount={res.uncitedCount} />
      </div>
    );
  }
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
