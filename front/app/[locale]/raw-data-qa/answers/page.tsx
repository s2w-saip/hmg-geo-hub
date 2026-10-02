import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import {
  QA_PAGE_SIZE,
  getProgress,
  listFilterOptions,
  listReviewAnswers,
} from "@/lib/db/repositories/qa-review";
import * as qaApi from "@/lib/hgh/adapters/qa";
import { throwForPage } from "@/lib/hgh/errors";
import { qaApiSource } from "@/lib/qa/auth";
import { parseQaFilter, qaFilterToQuery, type QaFilter } from "@/lib/qa/filters";
import { ProgressHeader } from "./_components/progress-header";
import { QaFilterBar } from "./_components/qa-filter-bar";
import { AnswerList, type AnswerListRow } from "./_components/answer-list";

// 검수 목록. 필터는 전부 URL 쿼리이므로 이 페이지는 searchParams 만 읽으면 되고,
// 필터가 걸린 링크를 복사해 주는 것이 곧 일감 분배다(설계 §8.2).
//
// 인증은 layout.tsx 가 이미 막는다 — 페이지마다 반복하면 한 곳만 빠뜨려도 열린다.
//
// 데이터 원천은 둘(D8, HGH_SOURCE_G7): legacy = 미러 리포지토리(아래 loadLegacy, 롤백 경로로 보존),
// api = /v1/qa/answers·progress·filters(lib/hgh/adapters/qa.ts). 화면에 넘기는 형태는 같다.
// API 원천에서 커서가 낡았거나(409 cursor_stale) 다른 원천의 커서면(422 cursor_invalid) 첫 페이지로 다시 연다.

type PageData = {
  rows: AnswerListRow[];
  nextCursor: string | null;
  progress: Awaited<ReturnType<typeof qaApi.getProgress>>;
  options: Awaited<ReturnType<typeof qaApi.getFilterOptions>>;
};

async function loadLegacy(filter: QaFilter, cursor: string | undefined): Promise<PageData> {
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
  return { rows, nextCursor: page.nextCursor, progress, options };
}

async function loadApi(filter: QaFilter, cursor: string | undefined, locale: string): Promise<PageData> {
  try {
    const [page, progress, options] = await Promise.all([
      qaApi.listAnswers(filter, cursor, QA_PAGE_SIZE),
      qaApi.getProgress(filter),
      qaApi.getFilterOptions(),
    ]);
    return { rows: page.rows, nextCursor: page.nextCursor, progress, options };
  } catch (e) {
    if (cursor && qaApi.isCursorProblem(e)) {
      const qs = qaFilterToQuery(filter).toString();
      redirect(`/${locale}/raw-data-qa/answers${qs ? `?${qs}` : ""}`);
    }
    return throwForPage(e, locale);
  }
}

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

  const { rows, nextCursor, progress, options } = qaApiSource()
    ? await loadApi(filter, cursor, locale)
    : await loadLegacy(filter, cursor);

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4">
      <ProgressHeader progress={progress} />
      <QaFilterBar filter={filter} options={options} />
      <AnswerList
        rows={rows}
        nextCursor={nextCursor}
        locale={locale}
        filter={filter}
      />
    </main>
  );
}
