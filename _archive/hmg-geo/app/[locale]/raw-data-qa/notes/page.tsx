import { setRequestLocale, getTranslations } from "next-intl/server";
import { QA_PAGE_SIZE, countNotesByKind, listNotes } from "@/lib/db/repositories/qa-review";
import { parseQaNoteFilter } from "@/lib/qa/filters";
import { NoteSummary } from "./_components/note-summary";
import { NoteList, type NoteListRow } from "./_components/note-list";

// 노트 모아보기. 검수의 산출물은 "몇 건 봤나"가 아니라 **여기 쌓인 노트**다 —
// 개발팀에 넘길 CSV 가 이 화면에서 나온다.

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

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4">
      <h1 className="sr-only">{t("heading")}</h1>
      <NoteSummary counts={counts} />
      <NoteList rows={rows} nextCursor={page.nextCursor} locale={locale} filter={filter} />
    </main>
  );
}
