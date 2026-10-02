"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { QaSurface } from "@/lib/qa/filters";

// 목록·노트·상세가 공유하는 배지들. 색은 전부 @theme 토큰 — hex 리터럴 금지.

export function SurfaceBadge({ surface }: { surface: QaSurface }) {
  const t = useTranslations("qaReview.list");
  const label = {
    standard: t("surfaceStandard"),
    website: t("surfaceWebsite"),
    project: t("surfaceProject"),
  }[surface];
  return (
    <Badge variant="outline" className="border font-normal">
      {label}
    </Badge>
  );
}

export function ReviewStateBadge({
  state,
}: {
  state: "unreviewed" | "ok" | "issue";
}) {
  const t = useTranslations("qaReview.list");
  if (state === "unreviewed") {
    return (
      <Badge variant="outline" className="border font-normal text-muted-foreground">
        {t("stateUnreviewed")}
      </Badge>
    );
  }
  if (state === "issue") {
    return <Badge variant="destructive">{t("stateIssue")}</Badge>;
  }
  // '완료'는 브랜드 블루 — 이 화면에서 가장 자주 보게 될 상태라 조용해야 한다.
  return (
    <Badge className="bg-brand-50 font-normal text-brand-700 hover:bg-brand-50">
      {t("stateOk")}
    </Badge>
  );
}

export function LockBadge({ reviewerName, mine }: { reviewerName: string; mine?: boolean }) {
  const t = useTranslations("qaReview.lock");
  return (
    <Badge
      className={cn(
        "font-normal",
        mine
          ? "bg-accent-info/15 text-brand-700 hover:bg-accent-info/15"
          : "bg-accent-gold/15 text-accent-gold hover:bg-accent-gold/15",
      )}
      title={mine ? t("mine") : t("held", { name: reviewerName })}
    >
      {t("badge")} · {reviewerName}
    </Badge>
  );
}
