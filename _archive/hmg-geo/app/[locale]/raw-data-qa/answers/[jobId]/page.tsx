import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import {
  getNeighbors,
  getReview,
  getReviewAnswerDetail,
  listNotesForJob,
  type QaSectionKey,
} from "@/lib/db/repositories/qa-review";
import { parseQaFilter, qaFilterToQuery } from "@/lib/qa/filters";
import type { QaSeverity, QaTargetKind } from "@/lib/qa/filters";
import { DetailShell } from "./_components/detail-shell";
import type { SerializedDetail, SerializedNote, SerializedReview } from "./_components/types";

// 검수 상세. 좌측은 사람이 읽는 답변 원문, 우측은 그 답변에 매달린 분석 낱알 전부.
// 이전/다음은 **목록과 같은 필터·정렬**을 따라간다 — 그래서 필터를 쿼리로 받는다.

export default async function AnswerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; jobId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, jobId } = await params;
  setRequestLocale(locale);

  const detail = await getReviewAnswerDetail(jobId);
  if (!detail) notFound();

  const filter = parseQaFilter(await searchParams);
  const [review, notes, neighbors] = await Promise.all([
    getReview(jobId),
    listNotesForJob(jobId),
    getNeighbors(filter, jobId),
  ]);

  const qs = qaFilterToQuery(filter).toString();
  const suffix = qs ? `?${qs}` : "";
  const base = `/${locale}/raw-data-qa/answers`;

  // Date → ISO. 클라이언트 경계를 넘길 값의 형태를 여기서 고정한다.
  const serialized: SerializedDetail = {
    answer: { ...detail.answer, measuredAt: detail.answer.measuredAt?.toISOString() ?? null },
    prompt: detail.prompt,
    mentions: detail.mentions,
    citations: detail.citations,
    acr: detail.acr,
    derived: {
      anchor: detail.derived.anchor
        ? {
            anchor: detail.derived.anchor.anchor,
            sourceMeasuredAt: detail.derived.anchor.sourceMeasuredAt?.toISOString() ?? null,
            reason: detail.derived.anchor.reason,
          }
        : null,
      drop: detail.derived.drop
        ? {
            sourceMeasuredAt: detail.derived.drop.sourceMeasuredAt?.toISOString() ?? null,
            reason: detail.derived.drop.reason,
            droppedAt: detail.derived.drop.droppedAt?.toISOString() ?? null,
          }
        : null,
    },
  };

  const serializedReview: SerializedReview = review
    ? {
        status: review.status as "ok" | "issue",
        sectionFlags: (review.sectionFlags ?? {}) as Partial<
          Record<QaSectionKey, "ok" | "issue">
        >,
        reviewerName: review.reviewerName,
        reviewedAt: review.updatedAt?.toISOString() ?? null,
      }
    : null;

  const serializedNotes: SerializedNote[] = notes.map((n) => ({
    id: n.id,
    targetKind: n.targetKind as QaTargetKind,
    targetKey: n.targetKey,
    targetLabel: n.targetLabel,
    severity: n.severity as QaSeverity,
    body: n.body,
    reviewerName: n.reviewerName,
    createdAt: n.createdAt?.toISOString() ?? null,
    resolvedAt: n.resolvedAt?.toISOString() ?? null,
  }));

  return (
    <DetailShell
      detail={serialized}
      review={serializedReview}
      initialNotes={serializedNotes}
      prevHref={neighbors.prev ? `${base}/${neighbors.prev}${suffix}` : null}
      nextHref={neighbors.next ? `${base}/${neighbors.next}${suffix}` : null}
      listHref={`${base}${suffix}`}
    />
  );
}
