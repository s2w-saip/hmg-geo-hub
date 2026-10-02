import { redirect } from "next/navigation";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { QA_PAGE_SIZE, countNotesByKind, listNotes } from "@/lib/db/repositories/qa-review";
import * as qaApi from "@/lib/hgh/adapters/qa";
import { throwForPage } from "@/lib/hgh/errors";
import { qaApiSource } from "@/lib/qa/auth";
import { parseQaNoteFilter, qaFilterToQuery, type QaNoteFilter } from "@/lib/qa/filters";
import { NoteSummary } from "./_components/note-summary";
import { NoteList, type NoteListRow } from "./_components/note-list";

// 노트 모아보기. 검수의 산출물은 "몇 건 봤나"가 아니라 **여기 쌓인 노트**다 —
// 개발팀에 넘길 CSV 가 이 화면에서 나온다.
//
// 데이터 원천은 둘(D8, HGH_SOURCE_G7): legacy = 미러 리포지토리(아래 loadLegacy, 롤백 경로로 보존),
// api = /v1/qa/notes·/notes/counts(lib/hgh/adapters/qa.ts). 낡은 커서는 첫 페이지로 다시 연다.

type NotesData = {
  rows: NoteListRow[];
  nextCursor: string | null;
  counts: Record<string, number>;
};

async function loadLegacy(filter: QaNoteFilter, cursor: string | undefined): Promise<NotesData> {
  const [page, counts] = await Promise.all([
    listNotes(filter, cursor, QA_PAGE_SIZE),
    countNotesByKind(filter),
  ]);

  const rows: NoteListRow[] = page.rows.map((n) => ({
    id: n.id,
    jobId: n.jobId,
    targetKind: n.targetKind,
    targetLabel: n.targetLabel,
    severity: n.severity,
    body: n.body,
    reviewerName: n.reviewerName,
    createdAt: n.createdAt?.toISOString() ?? null,
    resolvedAt: n.resolvedAt?.toISOString() ?? null,
    resolvedBy: n.resolvedBy,
    promptText: n.promptText,
    surface: n.surface,
  }));
  return { rows, nextCursor: page.nextCursor, counts };
}

async function loadApi(filter: QaNoteFilter, cursor: string | undefined, locale: string): Promise<NotesData> {
  try {
    const [page, counts] = await Promise.all([
      qaApi.listNotes(filter, cursor, QA_PAGE_SIZE),
      qaApi.countNotesByKind(filter),
    ]);
    return { rows: page.rows, nextCursor: page.nextCursor, counts };
  } catch (e) {
    if (cursor && qaApi.isCursorProblem(e)) {
      const qs = qaFilterToQuery(filter).toString();
      redirect(`/${locale}/raw-data-qa/notes${qs ? `?${qs}` : ""}`);
    }
    return throwForPage(e, locale);
  }
}

export default async function NotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("qaReview.notes");

  const sp = await searchParams;
  const filter = parseQaNoteFilter(sp);
  const cursor = typeof sp.cursor === "string" ? sp.cursor : undefined;

  const { rows, nextCursor, counts } = qaApiSource()
    ? await loadApi(filter, cursor, locale)
    : await loadLegacy(filter, cursor);

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4">
      <h1 className="sr-only">{t("heading")}</h1>
      <NoteSummary counts={counts} />
      <NoteList rows={rows} nextCursor={nextCursor} locale={locale} filter={filter} />
    </main>
  );
}
