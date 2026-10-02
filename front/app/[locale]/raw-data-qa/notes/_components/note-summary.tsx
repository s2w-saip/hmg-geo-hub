import { getTranslations } from "next-intl/server";
import { QA_TARGET_KINDS } from "@/lib/qa/filters";

// 대상 종류별 노트 수. "인용 분류가 유독 많이 틀린다" 같은 축별 편중이 여기서 드러난다 —
// 이것이 검수의 실제 산출물이다(어느 KPI가 아니라 어느 **분석 단계**가 틀리는가).
export async function NoteSummary({ counts }: { counts: Record<string, number> }) {
  const t = await getTranslations("qaReview.notes");
  const label: Record<string, string> = {
    answer: t("targetAnswer"),
    prompt: t("targetPrompt"),
    mention: t("targetMention"),
    citation: t("targetCitation"),
    acr: t("targetAcr"),
    meta: t("targetMeta"),
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-head text-base font-semibold tracking-tight text-foreground">
        {t("byKind")}
      </span>
      <span className="text-sm text-muted-foreground">{t("total", { count: total })}</span>
      <div className="flex flex-wrap gap-2">
        {QA_TARGET_KINDS.filter((k) => (counts[k] ?? 0) > 0).map((k) => (
          <span
            key={k}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-foreground"
          >
            {label[k]}{" "}
            <strong className="ml-0.5 font-medium tabular-nums">{counts[k]}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}
