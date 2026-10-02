import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import {
  getNeighbors,
  getReview,
  getReviewAnswerDetail,
  listNotesForJob,
  type QaSectionKey,
} from "@/lib/db/repositories/qa-review";
import * as qaApi from "@/lib/hgh/adapters/qa";
import { throwForPage } from "@/lib/hgh/errors";
import { qaApiSource } from "@/lib/qa/auth";
import { parseQaFilter, qaFilterToQuery, type QaFilter } from "@/lib/qa/filters";
import type { QaSeverity, QaTargetKind } from "@/lib/qa/filters";
import { DetailShell } from "./_components/detail-shell";
import type { SerializedDetail, SerializedNote, SerializedReview } from "./_components/types";

// 검수 상세. 좌측은 사람이 읽는 답변 원문, 우측은 그 답변에 매달린 분석 낱알 전부.
// 이전/다음은 **목록과 같은 필터·정렬**을 따라간다 — 그래서 필터를 쿼리로 받는다.
//
// 데이터 원천은 둘(D8, HGH_SOURCE_G7): legacy = 미러 리포지토리(아래 loadLegacy, 롤백 경로로 보존),
// api = /v1/qa/answers/{id}·/review·/notes·/neighbors(lib/hgh/adapters/qa.ts). 화면에 넘기는 형태는 같다.
// 백엔드가 모르는 답변(404, 서버 검수 범위 밖 포함)은 현행처럼 notFound().

type DetailData = {
  detail: SerializedDetail;
  review: SerializedReview;
  notes: SerializedNote[];
  neighbors: { prev: string | null; next: string | null };
};

async function loadLegacy(jobId: string, filter: QaFilter): Promise<DetailData | null> {
  const detail = await getReviewAnswerDetail(jobId);
  if (!detail) return null;

  const [review, notes, neighbors] = await Promise.all([
    getReview(jobId),
    listNotesForJob(jobId),
    getNeighbors(filter, jobId),
  ]);

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

  return { detail: serialized, review: serializedReview, notes: serializedNotes, neighbors };
}

async function loadApi(jobId: string, filter: QaFilter, locale: string): Promise<DetailData | null> {
  try {
    const detail = await qaApi.getAnswerDetail(jobId);
    if (!detail) return null;
    const [review, notes, neighbors] = await Promise.all([
      qaApi.getReview(jobId),
      qaApi.listNotesForJob(jobId),
      qaApi.getNeighbors(filter, jobId),
    ]);
    return { detail, review, notes, neighbors };
  } catch (e) {
    return throwForPage(e, locale);
  }
}

export default async function AnswerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; jobId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, jobId } = await params;
  setRequestLocale(locale);

  const filter = parseQaFilter(await searchParams);
  const data = qaApiSource()
    ? await loadApi(jobId, filter, locale)
    : await loadLegacy(jobId, filter);
  if (!data) notFound();

  const qs = qaFilterToQuery(filter).toString();
  const suffix = qs ? `?${qs}` : "";
  const base = `/${locale}/raw-data-qa/answers`;
  const { neighbors } = data;

  return (
    <DetailShell
      detail={data.detail}
      review={data.review}
      initialNotes={data.notes}
      prevHref={neighbors.prev ? `${base}/${neighbors.prev}${suffix}` : null}
      nextHref={neighbors.next ? `${base}/${neighbors.next}${suffix}` : null}
      listHref={`${base}${suffix}`}
    />
  );
}
