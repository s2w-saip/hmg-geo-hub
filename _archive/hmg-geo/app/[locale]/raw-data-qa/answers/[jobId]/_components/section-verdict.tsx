"use client";

import { useTranslations } from "next-intl";
import { MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";

// 블록 헤더의 판정 토글. "이상 없음 / 이상" 두 상태 + 미판정(아무것도 안 눌림).
//
// 낱알 행마다 체크박스를 두지 않는 이유: 인용이 20개인 답변에서 클릭이 20번이 되고,
// 검수 속도가 곧 이 도구의 값이다. 대신 문제가 있는 행에는 노트를 단다(설계 §9).
export function SectionVerdict({
  value,
  onChange,
  onNote,
  disabled,
}: {
  value: "ok" | "issue" | undefined;
  onChange: (v: "ok" | "issue") => void;
  onNote?: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations("qaReview.sections");
  const tDetail = useTranslations("qaReview.detail");

  return (
    <div className="flex items-center gap-1">
      <div className="flex overflow-hidden rounded-md border border-border">
        <Segment
          on={value === "ok"}
          tone="ok"
          label={t("ok")}
          disabled={disabled}
          onClick={() => onChange("ok")}
        />
        <Segment
          on={value === "issue"}
          tone="issue"
          label={t("issue")}
          disabled={disabled}
          onClick={() => onChange("issue")}
        />
      </div>
      {onNote ? (
        <button
          type="button"
          onClick={onNote}
          disabled={disabled}
          title={tDetail("addNote")}
          aria-label={tDetail("addNote")}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <MessageSquarePlus className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function Segment({
  on,
  tone,
  label,
  disabled,
  onClick,
}: {
  on: boolean;
  tone: "ok" | "issue";
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={cn(
        "px-2 py-1 text-xs transition-colors disabled:opacity-40",
        on
          ? tone === "ok"
            ? "bg-brand-700 text-white"
            : "bg-destructive text-white"
          : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
