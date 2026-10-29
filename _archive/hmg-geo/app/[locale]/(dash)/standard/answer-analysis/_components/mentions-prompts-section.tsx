"use client";

// 표준 언급 화면의 공통 하단 "프롬프트 및 답변" (디자인 327:116 하단, 2026-09-02).
// 4-KPI 탭 아래에 탭과 무관하게 놓인다: 주별 상위 10 브랜드 언급 수 라인 → 브랜드
// 언급 순위 상위 100(복수 언급 토글·검색·Excel) → 행 클릭 드릴다운(프롬프트/인용 출처,
// 순위 열·TOP 3 배지). 종전 MentionsView 의 요약 카드·헤드투헤드·감정/유형 카드는
// 이제 탭이 담당하므로 이 표면에서 빠졌다. website/project 는 MentionsView 그대로.

import { useTranslations } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MentionsLive } from "@/lib/scope/result-adapter";
import { EmptyState, MentionTrendChart, PendingCard } from "./mentions-view";
import { BrandRankTable } from "./brand-rank-table";

export const BRAND_RANK_LIMIT = 100;

export function MentionsPromptsSection({
  data,
  initialMulti,
}: {
  data: MentionsLive | null;
  /** 렌더 테스트 seam. */
  initialMulti?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions");
  const tRoot = useTranslations("answerAnalysis");
  if (!data) return <EmptyState label={tRoot("empty")} />;
  const tracked = new Set(data.brands.filter((b) => b.isTracked).map((b) => b.brand));
  return (
    <TooltipProvider delayDuration={200}>
      <section className="flex flex-col gap-4" aria-labelledby="mentions-prompts-heading">
        <h2 id="mentions-prompts-heading" className="text-lg font-medium tracking-tight text-foreground">
          {t("prompts.title")}
        </h2>
        {data.trend ? (
          <MentionTrendChart title={t("trend.title")} trend={data.trend} trackedBrands={tracked} />
        ) : (
          // null 의 두 사유를 구분한다 — 시간 초과(degrade)와 "2주 미만"(측정 대기).
          <PendingCard
            title={t("trend.title")}
            label={data.trendDegraded ? t("kpi.degradedTrend") : tRoot("pending")}
          />
        )}
        <BrandRankTable
          brands={data.brands}
          perBrandPrompts={data.perBrandPrompts}
          lazyPrompts
          multiToggle
          showRank
          limit={BRAND_RANK_LIMIT}
          totalAnswers={data.summary.totalAnswers ?? null}
          initialMulti={initialMulti}
        />
      </section>
    </TooltipProvider>
  );
}
