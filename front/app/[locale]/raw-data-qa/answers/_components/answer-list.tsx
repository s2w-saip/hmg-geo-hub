"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { qaFilterToQuery, type QaFilter, type QaSurface } from "@/lib/qa/filters";
import { LockBadge, ReviewStateBadge, SurfaceBadge } from "../../_components/qa-badges";

// 목록 행 — 서버 타입을 그대로 쓰지 않고 직렬화된 형태를 받는다
// (Date 는 서버 컴포넌트 경계를 넘으며 문자열이 될 수 있다).
export type AnswerListRow = {
  jobId: string;
  promptText: string | null;
  surface: QaSurface;
  brand: string | null;
  country: string | null;
  engine: string;
  lang: string | null;
  measuredAt: string | null;
  mentionCount: number;
  citationCount: number;
  noteCount: number;
  reviewStatus: "unreviewed" | "ok" | "issue";
  reviewerName: string | null;
  lock: { reviewerName: string } | null;
};

const POLL_MS = 10_000;

export function AnswerList({
  rows,
  nextCursor,
  locale,
  filter,
}: {
  rows: AnswerListRow[];
  nextCursor: string | null;
  locale: string;
  filter: QaFilter;
}) {
  const t = useTranslations("qaReview");
  const router = useRouter();
  const [live, setLive] = useState(rows);

  useEffect(() => setLive(rows), [rows]);

  // 10초 폴링 — 락과 검수 상태만 갱신한다. 페이지 전체를 다시 렌더하면 스크롤과
  // 필터 조작이 튄다. 탭이 백그라운드면 건너뛴다(설계 §6.4).
  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const ids = rows.map((r) => r.jobId);
    if (ids.length === 0) return;
    try {
      const res = await fetch(`/api/qa/answers?jobIds=${ids.join(",")}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        locks: Array<{ jobId: string; reviewerName: string }>;
        reviews: Array<{ jobId: string; status: string; reviewerName: string }>;
      };
      const lockBy = new Map(data.locks.map((l) => [l.jobId, l]));
      const reviewBy = new Map(data.reviews.map((r) => [r.jobId, r]));
      setLive((prev) =>
        prev.map((r) => {
          const rv = reviewBy.get(r.jobId);
          return {
            ...r,
            lock: lockBy.get(r.jobId) ?? null,
            reviewStatus: (rv?.status ?? "unreviewed") as AnswerListRow["reviewStatus"],
            reviewerName: rv?.reviewerName ?? null,
          };
        }),
      );
    } catch {
      // 폴링 실패는 조용히 넘긴다 — 다음 주기에 다시 시도한다.
    }
  }, [rows]);

  useEffect(() => {
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const qs = qaFilterToQuery(filter).toString();
  const href = (jobId: string) =>
    `/${locale}/raw-data-qa/answers/${jobId}${qs ? `?${qs}` : ""}`;

  function loadMore() {
    const sp = qaFilterToQuery(filter);
    if (nextCursor) sp.set("cursor", nextCursor);
    router.push(`?${sp.toString()}`, { scroll: false });
  }

  if (live.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
        {t("common.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[22rem]">{t("list.colPrompt")}</TableHead>
              <TableHead>{t("list.colSurface")}</TableHead>
              <TableHead>{t("list.colBrand")}</TableHead>
              <TableHead>{t("list.colCountry")}</TableHead>
              <TableHead>{t("list.colEngine")}</TableHead>
              <TableHead>{t("list.colLang")}</TableHead>
              <TableHead>{t("list.colMeasuredAt")}</TableHead>
              <TableHead className="text-right">{t("list.colMentions")}</TableHead>
              <TableHead className="text-right">{t("list.colCitations")}</TableHead>
              <TableHead>{t("list.colState")}</TableHead>
              <TableHead>{t("list.colReviewer")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {live.map((r) => (
              <TableRow key={r.jobId} className="hover:bg-muted/50">
                <TableCell className="max-w-[32rem] py-2">
                  <Link href={href(r.jobId)} className="block">
                    <span className="line-clamp-2 text-sm text-foreground">
                      {r.promptText ?? t("common.none")}
                    </span>
                    {r.noteCount > 0 ? (
                      <span className="mt-0.5 inline-block text-xs text-accent-gold">
                        {t("detail.noteCount", { count: r.noteCount })}
                      </span>
                    ) : null}
                  </Link>
                </TableCell>
                <TableCell>
                  <SurfaceBadge surface={r.surface} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {r.brand ?? t("common.none")}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {r.country ?? t("common.none")}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">{r.engine}</TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {r.lang ?? t("common.none")}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm tabular-nums">
                  {r.measuredAt ? r.measuredAt.slice(0, 10) : t("common.none")}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {r.mentionCount}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {r.citationCount}
                </TableCell>
                <TableCell>
                  <ReviewStateBadge state={r.reviewStatus} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {r.lock ? (
                    <LockBadge reviewerName={r.lock.reviewerName} />
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {r.reviewerName ?? t("common.none")}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore}>
            {t("common.more")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
