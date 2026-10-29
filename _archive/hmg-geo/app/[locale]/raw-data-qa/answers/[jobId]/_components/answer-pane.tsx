"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { MarkdownAnswer } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/markdown-answer";
import { SectionVerdict } from "./section-verdict";
import type { SerializedDetail, QaSectionKey } from "./types";

// 좌측 — 사람이 실제로 읽는 것. 프롬프트를 user turn, 답변을 assistant turn 으로 놓고
// 기존 답변분석 화면과 **같은 하이라이터**(MarkdownAnswer)를 쓴다. 검수자가 우측
// 낱알 테이블과 대조할 때 두 화면의 색이 다르면 그것부터 의심하게 된다.
export function AnswerPane({
  detail,
  flags,
  onFlag,
  onNote,
  readOnly,
}: {
  detail: SerializedDetail;
  flags: Partial<Record<QaSectionKey, "ok" | "issue">>;
  onFlag: (key: QaSectionKey, value: "ok" | "issue") => void;
  onNote: () => void;
  readOnly: boolean;
}) {
  const t = useTranslations("qaReview");

  // 자사 엔티티는 브랜드 색, 나머지는 모델 색으로 칠한다 — 자사/경쟁을 눈으로 가른다.
  const { brandTerms, modelTerms } = useMemo(() => {
    const own: string[] = [];
    const other: string[] = [];
    for (const m of detail.mentions) {
      const forms = [...(m.surfaces ?? []), ...(m.brand ? [m.brand] : [])];
      (m.isOwn ? own : other).push(...forms);
    }
    return { brandTerms: [...new Set(own)], modelTerms: [...new Set(other)] };
  }, [detail.mentions]);

  const { anchor, drop } = detail.derived;

  return (
    <section className="flex flex-col gap-3">
      {/* 이 답변이 접혔거나 제외됐다면 그 사실이 먼저다 — "왜 집계에 안 잡히지"의 답이다. */}
      {anchor ? (
        <Notice>
          {t("detail.anchorFolded", {
            source: anchor.sourceMeasuredAt?.slice(0, 10) ?? t("common.none"),
            anchor: anchor.anchor,
          })}
        </Notice>
      ) : null}
      {drop ? <Notice>{t("detail.dropped", { reason: drop.reason })}</Notice> : null}

      <div className="rounded-lg border border-border bg-card">
        <header className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 className="font-head text-sm font-semibold text-foreground">
            {t("sections.answer")}
          </h2>
          <SectionVerdict
            value={flags.answer}
            onChange={(v) => onFlag("answer", v)}
            onNote={onNote}
            disabled={readOnly}
          />
        </header>

        <div className="flex flex-col gap-4 p-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t("detail.userTurn")}
            </p>
            <p className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">
              {detail.prompt.text ?? t("common.none")}
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t("detail.assistantTurn")}
            </p>
            {detail.answer.answerText ? (
              <MarkdownAnswer
                text={detail.answer.answerText}
                brandTerms={brandTerms}
                modelTerms={modelTerms}
                className="text-sm leading-relaxed text-foreground"
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("detail.noAnswerBody")}</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-accent-gold/40 bg-accent-gold/10 px-3 py-2 text-xs text-accent-gold">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      {children}
    </p>
  );
}
