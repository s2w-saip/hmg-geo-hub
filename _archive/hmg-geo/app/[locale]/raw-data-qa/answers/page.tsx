import { setRequestLocale } from "next-intl/server";
import {
  QA_PAGE_SIZE,
  getProgress,
  listFilterOptions,
  listReviewAnswers,
} from "@/lib/db/repositories/qa-review";
import { parseQaFilter } from "@/lib/qa/filters";
import { ProgressHeader } from "./_components/progress-header";
import { QaFilterBar } from "./_components/qa-filter-bar";
import { AnswerList, type AnswerListRow } from "./_components/answer-list";

// 검수 목록. 필터는 전부 URL 쿼리이므로 이 페이지는 searchParams 만 읽으면 되고,
// 필터가 걸린 링크를 복사해 주는 것이 곧 일감 분배다(설계 §8.2).
//
// 인증은 layout.tsx 가 이미 막는다 — 페이지마다 반복하면 한 곳만 빠뜨려도 열린다.

export default async function AnswersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const sp = await searchParams;
  const filter = parseQaFilter(sp);
  const cursor = typeof sp.cursor === "string" ? sp.cursor : undefined;

  const [page, progress, options] = await Promise.all([
    listReviewAnswers(filter, cursor, QA_PAGE_SIZE),
    getProgress(filter),
    listFilterOptions(),
  ]);

  // Date → ISO 문자열. 클라이언트 컴포넌트 경계를 넘길 값은 직렬화 형태를 고정한다.
  const rows: AnswerListRow[] = page.rows.map((r): AnswerListRow => ({
    jobId: r.jobId,
    promptText: r.promptText,
    surface: r.surface,
    brand: r.brand,
    country: r.country,
    engine: r.engine,
    lang: r.lang,
    measuredAt: r.measuredAt ? r.measuredAt.toISOString() : null,
    mentionCount: r.mentionCount,
    citationCount: r.citationCount,
    noteCount: r.noteCount,
    reviewStatus: r.reviewStatus,
    reviewerName: r.reviewerName,
    lock: r.lock ? { reviewerName: r.lock.reviewerName } : null,
  }));

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4">
      <ProgressHeader progress={progress} />
      <QaFilterBar filter={filter} options={options} />
      <AnswerList
        rows={rows}
        nextCursor={page.nextCursor}
        locale={locale}
        filter={filter}
      />
    </main>
  );
}
