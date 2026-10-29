"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Lock, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QaSectionKey } from "./types";

// 하단 고정 바. 대량 검수의 속도가 곧 이 도구의 값이라, 저장과 이동이 한 자리에 있고
// 키보드로도 닿는다(J/K/O/N — DetailShell 이 바인딩).
export function VerdictBar({
  flags,
  onSave,
  onNote,
  prevHref,
  nextHref,
  readOnly,
  lockHolder,
  saving,
  savedAt,
  reviewedBy,
}: {
  flags: Partial<Record<QaSectionKey, "ok" | "issue">>;
  onSave: () => void;
  onNote: () => void;
  prevHref: string | null;
  nextHref: string | null;
  readOnly: boolean;
  lockHolder: string | null;
  saving: boolean;
  savedAt: string | null;
  reviewedBy: { name: string; at: string } | null;
}) {
  const t = useTranslations("qaReview");

  // 저장 버튼의 라벨은 **파생 상태**를 비춘다 — 하나라도 '이상'이면 '이상 있음'.
  // 두 버튼이 아니라 한 버튼인 이유: status 는 검수자가 고르는 값이 아니다(설계 §5).
  const hasIssue = Object.values(flags).includes("issue");

  return (
    <div className="sticky bottom-0 z-20 border-t border-border bg-card/95 px-4 py-2 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-3">
        <Button
          onClick={onSave}
          disabled={readOnly || saving}
          className={cn(hasIssue && "bg-destructive hover:bg-destructive/90")}
        >
          {saving
            ? t("common.saving")
            : hasIssue
              ? t("detail.markIssue")
              : t("detail.markReviewed")}
        </Button>

        <Button variant="outline" onClick={onNote} disabled={readOnly}>
          <MessageSquarePlus className="size-3.5" />
          {t("detail.addNote")}
        </Button>

        {readOnly && lockHolder ? (
          <span className="flex items-center gap-1.5 text-sm text-accent-gold">
            <Lock className="size-3.5" />
            {t("lock.held", { name: lockHolder })}
          </span>
        ) : null}

        {savedAt ? (
          <span className="text-sm text-brand-500">{t("detail.saved")}</span>
        ) : reviewedBy ? (
          <span className="text-sm text-muted-foreground">
            {t("detail.reviewedBy", { name: reviewedBy.name, at: reviewedBy.at })}
          </span>
        ) : null}

        <span className="hidden text-xs text-muted-foreground lg:inline">
          {t("detail.shortcuts")}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <NavButton href={prevHref} label={t("detail.prev")} dir="prev" />
          <NavButton href={nextHref} label={t("detail.next")} dir="next" />
        </div>
      </div>
    </div>
  );
}

function NavButton({
  href,
  label,
  dir,
}: {
  href: string | null;
  label: string;
  dir: "prev" | "next";
}) {
  const icon =
    dir === "prev" ? <ChevronLeft className="size-3.5" /> : <ChevronRight className="size-3.5" />;
  if (!href) {
    return (
      <Button variant="ghost" size="sm" disabled>
        {dir === "prev" ? icon : null}
        {label}
        {dir === "next" ? icon : null}
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href={href}>
        {dir === "prev" ? icon : null}
        {label}
        {dir === "next" ? icon : null}
      </Link>
    </Button>
  );
}
