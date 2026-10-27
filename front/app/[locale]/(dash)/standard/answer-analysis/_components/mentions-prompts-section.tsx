"use client";

// 표준 언급 화면의 공통 하단 "프롬프트 및 답변" (디자인 327:116 하단, 2026-09-02).
// 4-KPI 탭 아래에 탭과 무관하게 놓인다: 주별 상위 10 브랜드 언급 수 라인 → 브랜드
// 언급 순위 상위 100(복수 언급 토글·검색·Excel) → 행 클릭 드릴다운(프롬프트/인용 출처,
// 순위 열·TOP 3 배지). 종전 MentionsView 의 요약 카드·헤드투헤드·감정/유형 카드는
// 이제 탭이 담당하므로 이 표면에서 빠졌다. website/project 는 MentionsView 그대로.

import { useTranslations } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmptyState, MentionTrendChart, PendingCard, type MentionsViewData } from "./mentions-view";
import { BrandRankTable } from "./brand-rank-table";
import type { BrandTableView, TrendSeriesSplit } from "../_data/mention-screen";

export const BRAND_RANK_LIMIT = 100;

export function MentionsPromptsSection({
  data,
  table,
  trendSeries = null,
  initialMulti,
  degraded = false,
}: {
  data: MentionsViewData | null;
  /** 브랜드 표의 화면 값(순번·값·정렬 순서) — `data` 가 있을 때 함께 온다. */
  table?: BrandTableView;
  /** 주별 차트의 시리즈 구분(당사 · 경쟁사) — 추이가 있을 때 함께 온다. */
  trendSeries?: TrendSeriesSplit | null;
  /** 렌더 테스트 seam. */
  initialMulti?: boolean;
  /**
   * `data` 의 null 이 **일시 실패**인가(B034, 요청 스코프 표식 `globalMentions` — 페이지가
   * 집계 뒤에 읽어 넘긴다). 참이면 "데이터 없음" 대신 기존 degraded 문구. 기본은 종전 그대로.
   */
  degraded?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions");
  const tRoot = useTranslations("answerAnalysis");
  if (!data || !table) {
    return degraded ? (
      <PendingCard title={t("prompts.title")} label={t("kpi.degraded")} />
    ) : (
      <EmptyState label={tRoot("empty")} />
    );
  }
  return (
    <TooltipProvider delayDuration={200}>
      <section className="flex flex-col gap-4" aria-labelledby="mentions-prompts-heading">
        <h2 id="mentions-prompts-heading" className="text-lg font-medium tracking-tight text-foreground">
          {t("prompts.title")}
        </h2>
        {data.trend && trendSeries ? (
          <MentionTrendChart title={t("trend.title")} trend={data.trend} series={trendSeries} />
        ) : (
          // null 의 두 사유를 구분한다 — 시간 초과(degrade)와 "2주 미만"(측정 대기).
          <PendingCard
            title={t("trend.title")}
            label={data.trendDegraded ? t("kpi.degradedTrend") : tRoot("pending")}
          />
        )}
        <BrandRankTable
          brands={data.brands}
          table={table}
          perBrandPrompts={data.perBrandPrompts}
          lazyPrompts
          multiToggle
          showRank
          limit={BRAND_RANK_LIMIT}
          initialMulti={initialMulti}
          total={data.brandsTotal}
        />
      </section>
    </TooltipProvider>
  );
}
