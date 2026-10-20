"use client";

// 표준 > 답변 분석 > 인용 — 개편 화면(PR ④, 디자인 571:380). website/project 인용은
// 종전 CitationsView 그대로다.
//
// 섹션 순서(디자인): 인용 현황(공식(당사)·딜러·마켓 비중 + 인용/미인용 프롬프트 링크)
// → 출처 카테고리별 현황(막대 + 도넛) → 구성 추이 → 엔진별 · 멘션 유형별 구성 →
// 답변 우호도별 인용 도메인(링크 타일) → 인용 도메인(주별 Top10 + 순위 표, 탭 드릴다운).
//
// 스트리밍 규약은 mention 탭과 같다 — 각 prop 은 값 또는 프로미스(useAwaited).
// 인용 집계(data)는 하나의 큰 프로미스라 대부분 섹션이 그것을 기다리지만, 유형별
// 구성·우호도 요약은 별도 집계라 자기 경계에서 따로 도착한다.

import { Suspense, useDeferredValue, useMemo, useState } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { joinFilterValues } from "@/components/dash/filter-encoding";
import { ArrowUpRight, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useFilterTransition } from "@/components/dash/filter-transition";
import type { CitationCategoryTotals, CitationToneSummary, CitationTypeCategoryRow, StandardSubKpis } from "@/lib/db/repositories/scope-aggregates";
import type { OverviewCardDelta } from "@/lib/kpi/overview-card-values";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import { citationCategorySlug } from "@/lib/citation-categorizer/taxonomy";
import { dateStamp } from "@/lib/export/csv";
import { downloadXlsx } from "@/lib/export/xlsx";
import { cn } from "@/lib/utils";
import { KpiHeroSkeleton, KpiSectionSkeleton } from "@/components/dash/section-skeleton";
import {
  DEALER_CATEGORY,
  OFFICIAL_HMG_CATEGORY,
  applyCompetitorPick,
  applyCompetitorPickToCategories,
  categoryBars,
  categoryIncluded,
  categoryShare,
  OFFICIAL_COMPETITOR_CATEGORY,
  typeCategoryBars,
  type CitationSectionDegraded,
  type CitationTableSource,
} from "../_data/citation-view";
import { deltaPp } from "../_data/kpi-view";
import { DeltaBadge, pctText } from "./kpi/kpi-bits";
import { useAwaited, type Awaitable } from "./kpi/mention-kpi-tab";
import { EmptyState, PendingCard } from "./mentions-view";
import {
  CategoryCompositionTrend,
  CategoryDonut,
  CitationTrendChart,
  DomainRow,
  EngineCategoryChart,
  SortIcon,
  TableStatus,
  Th,
  categoryColor,
  useExportFailedNotice,
  useExportTask,
  useServerDomainTable,
  type RankedDomainRow,
} from "./citations-view";
import { useActiveCitationCategories, useActiveCompetitors } from "./citation-url-axes";
import { TypeCategoryChart } from "./type-category-chart";

type Props = {
  data: Awaitable<CitationsLive | null>;
  /**
   * @deprecated 2026-09-29 — 공식(HMG) 인용 비중의 Δ 가 더 이상 이 값을 읽지 않는다
   * (종전 base URL 정의의 엔진 분해행 합이라 카테고리 정의와 다른 양이다). 호출부 호환을
   * 위해 받기만 한다.
   */
  prevSubKpis?: Awaitable<StandardSubKpis | null>;
  /** @deprecated 2026-09-29 — `prevSubKpis` 와 같은 이유로 읽지 않는다. */
  prevBasisDate?: Awaitable<string | null>;
  /**
   * 공식(HMG) 인용 비중의 **카드 Δ 정본**(`lib/kpi/overview-card-values.ts::overviewCardDelta`)
   * — Overview ⑤ 카드 Δ 와 같은 함수·같은 입력이다. ⑤ 의 글로벌 분자가 공식(HMG) 카테고리로
   * 바뀌어(제품 책임자 2026-09-29) 이 Δ 도 카테고리 기준이다.
   *
   * `null` 이면(격자 키 off · 조회 실패 · 자리가 2개 미만) **직전 회차 카테고리 합계**
   * (`prevCategories`)으로 낸다 — 딜러·카테고리 바 Δ 와 같은 기준이다. 종전 폴백
   * (`prevSubKpis` = base URL 정의의 엔진 분해행 합)은 정의가 달라 쓰지 않는다.
   */
  officialDelta?: Awaitable<OverviewCardDelta | null>;
  typeCategories: Awaitable<CitationTypeCategoryRow[] | null>;
  toneSummary: Awaitable<CitationToneSummary | null>;
  /**
   * **직전 회차 자리**의 카테고리별 인용 수 — 딜러 비중 Δ·카테고리 바 Δ(피그마 D13).
   * 자리는 Overview 카드 Δ 와 같다(`server.ts::citationCategoriesPrevRound`). 없으면 Δ 생략.
   */
  prevCategories?: Awaitable<{ totals: CitationCategoryTotals; asOf: string; current?: CitationCategoryTotals } | null>;
  /**
   * `data` 의 `null` 이 **예산 초과**인가(= 데이터 없음이 아니라 지연).
   * 판정은 서버의 요청 스코프 표식(`wasDegraded("standardCitations")`)이라 이 클라이언트
   * 뷰에서 직접 못 읽는다 — 페이지가 같은 집계 뒤에 이어 붙여 넘긴다. 없으면 종전대로
   * `null` = "데이터 없음".
   */
  dataDegraded?: Awaitable<boolean>;
  /**
   * API 원천(P6 B041): 보조 블록(주별 도메인 추이·카테고리 구성 추이·인용/미인용 프롬프트 분할)이
   * 일시 실패(5xx·시간 초과)로 비었는가 — `dataDegraded` 와 같은 요청 스코프 표식(`citationsDegraded`)을
   * 페이지가 같은 집계 뒤에 이어 붙여 넘긴다. 켜진 블록은 '준비 중'·숨김·빈 타일 대신 기존 지연
   * 안내(answerAnalysis.mentions.kpi.degraded)를 낸다. 없으면 종전 그대로.
   */
  sectionDegraded?: Awaitable<CitationSectionDegraded | null>;
  /** 렌더 테스트 seam. */
  initialCompetitors?: string[];
  /**
   * API 원천(unit U7)일 때만: 도메인 표의 검색·정렬(전 출처 대상, BG-21)과 행 드릴다운을 읽을
   * BFF 조건. 없거나 null 이면 종전 그대로(받은 행을 클라이언트에서 검색·정렬, 인라인 드릴다운).
   */
  tableSource?: Awaitable<CitationTableSource | null>;
};

export const DOMAIN_RANK_LIMIT = 100;

export function CitationsStandardView(props: Props) {
  // 경쟁사 선택은 클라이언트 state 가 아니라 **URL 축(`?competitor=`)** 이다(QA #12) —
  // 카테고리 칩·필터 적용으로 서버 렌더가 돌아도 유지되고, 하위 페이지 링크에도
  // 다른 필터와 함께 실려 나간다. initialCompetitors 는 렌더 테스트 seam.
  const urlCompetitors = useActiveCompetitors();
  const competitorKey = urlCompetitors.join("~");
  const picked = useMemo(
    () => new Set<string>(props.initialCompetitors ?? urlCompetitors),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.initialCompetitors, competitorKey],
  );
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-6">
        {/* QA 2차 #2(2026-09-10) — 출처 카테고리·경쟁사는 칩이 아니라 **필터 패널 축**이다
            (DimensionFilterPanel 의 `답변 필터` 행). 이 본문은 URL 축을 읽기만 한다. */}
        <Suspense fallback={<KpiHeroSkeleton />}>
          <StatusBlock
            data={props.data}
            officialDelta={props.officialDelta ?? null}
            prevCategories={props.prevCategories ?? null}
            dataDegraded={props.dataDegraded ?? false}
            sectionDegraded={props.sectionDegraded ?? null}
          />
        </Suspense>
        <Suspense fallback={<KpiSectionSkeleton />}>
          <CategoryBlock data={props.data} prevCategories={props.prevCategories ?? null} picked={picked} sectionDegraded={props.sectionDegraded ?? null} />
        </Suspense>
        <div className="grid gap-6 lg:grid-cols-2">
          <Suspense fallback={<KpiSectionSkeleton />}>
            <EngineBlock data={props.data} />
          </Suspense>
          <Suspense fallback={<KpiSectionSkeleton />}>
            <TypeBlock typeCategories={props.typeCategories} />
          </Suspense>
        </div>
        <Suspense fallback={<KpiSectionSkeleton />}>
          <ToneBlock toneSummary={props.toneSummary} />
        </Suspense>
        <Suspense fallback={<KpiSectionSkeleton />}>
          <DomainsBlock data={props.data} picked={picked} tableSource={props.tableSource ?? null} sectionDegraded={props.sectionDegraded ?? null} />
        </Suspense>
      </div>
    </TooltipProvider>
  );
}

function useCatLabel() {
  const tCat = useTranslations("citationCategories");
  return (name: string) => {
    const slug = citationCategorySlug(name);
    return slug ? tCat(slug) : name;
  };
}

/** 현재 URL 의 필터 파라미터를 하위 페이지로 그대로 넘긴다(+추가 파라미터). */
function useSubpageHref() {
  const pathname = usePathname();
  const sp = useSearchParams();
  return (sub: string, extra: Record<string, string>) => {
    const params = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    const qs = params.toString();
    return `${pathname}/${sub}${qs ? `?${qs}` : ""}`;
  };
}

// ─── 인용 현황 ────────────────────────────────────────────────────────────────
/** 직전 스냅샷의 카테고리 비중(%) — Δ(pp) 계산용. */
function prevCategoryShare(prev: { totals: CitationCategoryTotals } | null | undefined, name: string): number | null {
  if (!prev || prev.totals.total <= 0) return null;
  return Math.round((1000 * (prev.totals.byCategory[name] ?? 0)) / prev.totals.total) / 10;
}

function StatusBlock({
  data,
  officialDelta,
  prevCategories,
  dataDegraded,
  sectionDegraded,
}: Pick<Props, "data" | "officialDelta" | "prevCategories" | "dataDegraded" | "sectionDegraded">) {
  const t = useTranslations("answerAnalysis.citations.v2.status");
  const tRoot = useTranslations("answerAnalysis");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const live = useAwaited(data);
  const degraded = useAwaited(dataDegraded ?? false);
  const sections = useAwaited(sectionDegraded ?? null);
  const active = useActiveCitationCategories();
  const href = useSubpageHref();
  // `live == null` 은 두 뜻이다 — ① 이 필터에 데이터가 없다 ② 집계가 예산에 걸렸다.
  // 값으로는 구분이 안 돼(둘 다 null) 종전에는 ②를 "데이터 없음"으로 오독했다.
  // 유형별 구성 블록(TypeBlock)이 이미 쓰는 문구를 그대로 재사용한다(새 문자열 없음).
  if (!live)
    return (
      <>
        {degraded ? (
          <PendingCard title={t("title")} label={tKpi("degraded")} />
        ) : (
          <EmptyState label={tRoot("empty")} />
        )}
        <SectionDoneMarker id="standard-citation:status" />
      </>
    );
  // 공식(HMG) 인용 비중 = 아래 "출처 카테고리별 현황" 의 Official (HMG) 비중과 **같은 값**
  // (제품 책임자 2026-09-29) — 같은 `live.categories`(같은 분류·같은 오버라이드·같은 `?source=`
  // 모집단)에서 같은 함수로 낸다. 종전의 `live.summary.officialOwnShare`(base URL prefix
  // 행 단위 매칭)는 website·project 인용 화면(`CitationsView`)에서만 쓴다.
  const officialOwn = categoryShare(live.categories, OFFICIAL_HMG_CATEGORY);
  const dealer = categoryShare(live.categories, DEALER_CATEGORY);
  const ownIncluded = categoryIncluded(active, OFFICIAL_HMG_CATEGORY);
  const split = live.promptSplit ?? null;
  // 분할 조회가 일시 실패(P6 B041)면 빈('—') 비활성 타일 대신 기존 지연 안내 — 아래 우호도 블록이
  // 요약 실패 때 타일 자리에 내는 것과 같은 문단이다. 공식(HMG) 미포함이면 종전대로 비활성 타일.
  const splitDegraded = ownIncluded && !split && Boolean(sections?.split);
  return (
    <>
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <header className="flex flex-col gap-0.5">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </header>
        {/* 피그마 571:380 인용 현황: 3등분, 라벨 14px medium, 값 28px bold. */}
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="flex min-h-[110px] flex-col justify-center gap-1.5 rounded-lg border border-border p-5">
            <div className="text-sm font-medium text-ink-700/80">{t("officialOwn")}</div>
            <div className="flex items-baseline gap-2">
              <span className="text-[28px] leading-none font-bold tracking-tight tabular-nums">{pctText(officialOwn)}</span>
              <Suspense fallback={null}>
                <OfficialDelta officialDelta={officialDelta ?? null} prevCategories={prevCategories} current={officialOwn} />
              </Suspense>
            </div>
          </div>
          <div className="flex min-h-[110px] flex-col justify-center gap-1.5 rounded-lg border border-border p-5">
            <div className="text-sm font-medium text-ink-700/80">{t("dealer")}</div>
            <div className="flex items-baseline gap-2">
              <span className="text-[28px] leading-none font-bold tracking-tight tabular-nums">{pctText(dealer)}</span>
              <Suspense fallback={null}>
                <CategoryDelta prevCategories={prevCategories} name={DEALER_CATEGORY} current={dealer} />
              </Suspense>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {splitDegraded ? (
              <p className="py-4 text-center text-xs text-muted-foreground">{tKpi("degraded")}</p>
            ) : (
              <>
                <LinkTile
                  label={t("ownedPrompts")}
                  count={split?.ownedCount ?? null}
                  href={href("prompts", { tab: "owned" })}
                  disabled={!ownIncluded || !split}
                  disabledHint={t("requiresOwn")}
                  tone="brand"
                />
                <LinkTile
                  label={t("uncitedPrompts")}
                  count={split?.uncitedCount ?? null}
                  href={href("prompts", { tab: "uncited" })}
                  disabled={!ownIncluded || !split}
                  disabledHint={t("requiresOwn")}
                  tone="warn"
                />
              </>
            )}
          </div>
        </div>
      </section>
      <Suspense fallback={null}>
        <StatusBasis prevCategories={prevCategories} officialDelta={officialDelta ?? null} />
      </Suspense>
      <SectionDoneMarker id="standard-citation:status" />
    </>
  );
}

function CategoryDelta({ prevCategories, name, current, size = "md" }: { prevCategories: Props["prevCategories"]; name: string; current: number | null; size?: "sm" | "md" }) {
  const prev = useAwaited(prevCategories ?? null);
  const previous = prevCategoryShare(prev, name);
  if (previous == null) return null;
  // 두 값은 같은 단위(회차 하나)여야 한다. API 원천은 직전 회차와 같은 추이의 마지막 회차(`current`)를 싣는다 — 기간이면 카드는
  // 기간 누적이라 카드 − 직전 회차는 증감이 아니다(공식(HMG) Δ 정본도 추이 마지막 − 직전). 없으면(legacy) 종전대로 카드 값.
  const base = prev?.current ? prevCategoryShare({ totals: prev.current }, name) : current;
  return <DeltaBadge value={deltaPp(base, previous)} unit="pp" size={size} />;
}

/**
 * 공식(HMG) 인용 비중의 Δ. **카드 Δ 정본이 있으면 그것을 그대로 쓴다** — 계산하지 않는다
 * (`Props.officialDelta` 머리 주석). 없으면 직전 회차 카테고리 합계 대비다(딜러와 같은 기준).
 */
function OfficialDelta({ officialDelta, prevCategories, current }: {
  officialDelta: Awaitable<OverviewCardDelta | null> | null;
  prevCategories: Props["prevCategories"];
  current: number | null;
}) {
  const card = useAwaited(officialDelta ?? null);
  if (card) return <DeltaBadge value={card.delta} unit="pp" size="md" />;
  return <CategoryDelta prevCategories={prevCategories} name={OFFICIAL_HMG_CATEGORY} current={current} />;
}
/** Δ 기준일 — 본문 문단이 아니라 배지 title(툴팁)로만(제품 결정: 오독 방지용 외 ⓘ). */
function StatusBasis({ prevCategories, officialDelta }: Pick<Props, "prevCategories"> & {
  officialDelta: Awaitable<OverviewCardDelta | null> | null;
}) {
  const t = useTranslations("answerAnalysis.citations.v2.status");
  const card = useAwaited(officialDelta ?? null);
  const prev = useAwaited(prevCategories ?? null);
  // 카드 Δ 정본을 쓰는 동안 공식(HMG)의 기준은 **직전 회차**다 — 날짜도 그 Δ 가 실어 온 자리 날짜.
  if (card) {
    return (
      <p className="sr-only">
        {t("deltaBasisOwnRound", { date: card.basisDate })}{" "}
        {t("deltaBasisCategory", { date: prev?.asOf ?? card.basisDate })}
      </p>
    );
  }
  // 폴백에서는 공식(HMG)·딜러·카테고리 Δ 가 **같은 기준**(직전 회차 카테고리 합계)이라
  // 한 문장이면 된다.
  if (!prev) return null;
  return <p className="sr-only">{t("deltaBasisCategory", { date: prev.asOf })}</p>;
}

function LinkTile({ label, count, href, disabled, disabledHint, tone, size = "md" }: {
  label: string; count: number | null; href: string; disabled: boolean; disabledHint: string; tone: "brand" | "warn" | "good" | "bad";
  /** 우호도 타일(피그마 571:380 하단)은 큰 타일 — 라벨 14px semibold, 배지 11px, 화살표 24px. */
  size?: "md" | "lg";
}) {
  // 피그마: 배지는 연한 틴트 + 진한 글자(당사 navy 15%·경고 amber 30%·긍정/부정 감정 토큰).
  const badge =
    tone === "brand" ? "bg-brand-700/15 text-foreground"
    : tone === "warn" ? "bg-amber-400/30 text-foreground"
    : tone === "good" ? "bg-sentiment-positive/15 text-sentiment-positive-ink"
    : "bg-sentiment-negative/15 text-sentiment-negative-ink";
  const inner = (
    <>
      <span className={cn("inline-flex items-center gap-2 text-foreground", size === "lg" ? "text-sm font-semibold" : "text-[13px] font-medium")}>
        {label}
        <span className={cn("rounded-full px-2 py-0.5 font-semibold tabular-nums", badge, size === "lg" ? "text-[11px]" : "text-[10px]")}>
          {count == null ? "—" : count.toLocaleString()}
        </span>
      </span>
      <ArrowUpRight className={cn("text-muted-foreground", size === "lg" ? "h-6 w-6" : "h-5 w-5")} aria-hidden />
    </>
  );
  const cls = "flex items-center justify-between rounded-md border border-border bg-card px-3 py-2";
  if (disabled) {
    return (
      <div className={cn(cls, "opacity-50")} title={disabledHint} aria-disabled data-link-tile-disabled>
        {inner}
      </div>
    );
  }
  return (
    <Link href={href} className={cn(cls, "hover:bg-muted")} data-link-tile>
      {inner}
    </Link>
  );
}

// ─── 출처 카테고리별 현황 ────────────────────────────────────────────────────
/** 도넛 조각 클릭 = 칩과 같은 `?source=` 토글(피그마 1:1, 제품 결정 Q39). */
function useSourceToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const active = useActiveCitationCategories();
  // QA 2차 #5-(a): 칩·조각 클릭이 **자기만의** 로컬 전이를 쓰면 FilterContentDim 의
  // 흐림·"재조회 중" 필이 안 뜬다 — 수 초간 화면상 변화가 0 이라 "선택이 안 된다"로
  // 읽혔다. 필터 패널과 같은 공유 전이를 타야 같은 피드백을 받는다(칩은 제거됐지만
  // 도넛 조각 클릭은 즉시 커밋을 유지하므로 이 경로가 남는다).
  const [, localStart] = useTransition();
  const shared = useFilterTransition();
  const startTransition = shared?.startTransition ?? localStart;
  return (name: string) => {
    const next = active.includes(name) ? active.filter((v) => v !== name) : [...active, name];
    const params = new URLSearchParams(sp.toString());
    if (next.length) params.set("source", joinFilterValues(next));
    else params.delete("source");
    // 공식(경쟁사)가 빠지면 경쟁사 선택도 함께 걷어낸다 — 축이 비활성이 되어 되돌릴
    // 수단이 없는 채 필터만 남는 것을 막는다(칩 시절 write() 와 같은 규칙, 패널 쪽은
    // clearAxesDisabledBy 가 같은 일을 한다).
    if (!categoryIncluded(next, OFFICIAL_COMPETITOR_CATEGORY)) params.delete("competitor");
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };
}

function CategoryBlock({
  data,
  prevCategories,
  picked,
  sectionDegraded,
}: Pick<Props, "data" | "prevCategories" | "sectionDegraded"> & { picked: ReadonlySet<string> }) {
  const t = useTranslations("answerAnalysis.citations.v2.categoryStatus");
  const tCit = useTranslations("answerAnalysis.citations");
  const tComp = useTranslations("answerAnalysis.citations.v2.competitor");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const live = useAwaited(data);
  const sections = useAwaited(sectionDegraded ?? null);
  const label = useCatLabel();
  const active = useActiveCitationCategories();
  const toggleSource = useSourceToggle();
  // QA 2차 #5-(c): 경쟁사 선택(`?competitor=`)이 도메인 표에만 걸려 있어 공식(경쟁사)
  // 값이 늘 전량이었다. 반영 범위는 이 섹션 + 도메인 표까지(제품 결정 D6) — 서버 축
  // 승격은 엔진별·유형별까지 좁혀 고객이 요구하지 않은 화면이 전부 바뀐다.
  // 막대·도넛·공용 범례가 **같은 배열**을 봐야 서로 어긋나지 않는다.
  const categories = useMemo(
    () => applyCompetitorPickToCategories(live?.categories, live?.domains ?? [], picked),
    [live, picked],
  );
  // 분모 = 경쟁사 선택 **전** 전체 인용 수(제품 책임자 2026-09-29). 선택은 공식(경쟁사) 값만 줄이고
  // 다른 카테고리 비중은 그대로 둔다 — 공식(HMG) 이 인용 현황 카드·Overview ⑤ 와 같은 값을 유지한다.
  const fullTotal = useMemo(
    () => (live?.categories ?? []).reduce((s, c) => s + c.value, 0),
    [live],
  );
  const bars = useMemo(() => categoryBars(categories, fullTotal), [categories, fullTotal]);
  const single = active.length === 1;
  // Δ 는 직전 회차 **전량** 기준이다. 분모를 전체로 유지하므로 선택 중에도 다른 카테고리 Δ 는
  // 그대로 유효하고, 값이 선택분으로 줄어든 공식(경쟁사) 막대 Δ 만 숨긴다(제품 결정 D5 의 범위 축소).
  const competitorPicked = picked.size > 0;
  if (!live) return null;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
        {/* 반영 범위 명시(제품 결정 D6) — 왜 이 섹션만 바뀌는지 화면에서 읽히게. */}
        {competitorPicked ? (
          <p className="text-xs text-brand-700">{tComp("scopeNote")}</p>
        ) : null}
      </header>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="rounded-md border border-border p-3">
          <h4 className="mb-2 text-[15px] font-medium text-ink-700">{t("countsTitle")}</h4>
          {bars.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{tCit("table.empty")}</p>
          ) : (
            <ul className="grid grid-cols-1 items-start gap-x-6 gap-y-1.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              {bars.map((b) => (
                <li
                  key={b.name}
                  className="grid h-[30px] min-w-0 grid-cols-[8px_minmax(72px,110px)_minmax(80px,130px)_auto_auto] items-center gap-x-3 overflow-hidden text-xs"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: categoryColor(b.name) }} aria-hidden />
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-foreground">{label(b.name)}</span>
                  {/* 피그마: 두께 14px, 트랙 연회색·채움 남색(카테고리색은 점만). 폭은 minmax 로 줄어든다 —
                      고정 130px 은 1130px 뷰포트에서 옆 열과 겹쳤다(2026-09-09 제품 책임자 캡처). 2열은 xl 부터. */}
                  <span className="flex h-[14px] w-full min-w-0 overflow-hidden rounded-full bg-slate-100">
                    <span className="h-full rounded-full" style={{ width: `${b.pct ?? 0}%`, background: "var(--color-brand-700)" }} />
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-right tabular-nums text-foreground">{b.value.toLocaleString()}</span>
                  <span className="shrink-0 whitespace-nowrap text-right">
                    {competitorPicked && b.name === OFFICIAL_COMPETITOR_CATEGORY ? null : (
                      <Suspense fallback={null}>
                        <CategoryDelta prevCategories={prevCategories} name={b.name} current={b.pct} size="sm" />
                      </Suspense>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {categories ? (
          <CategoryDonut
            title={t("shareTitle")}
            centerLabel={t("officialCenter")}
            data={categories}
            total={fullTotal}
            activeCategories={active}
            onSliceClick={toggleSource}
            label={label}
            variant="standard"
          />
        ) : null}
      </div>
      {live.categoryTrend ? (
        <>
          <CategoryCompositionTrend
            title={tCit("categoryTrend.title")}
            trend={live.categoryTrend}
            label={label}
            hideLegend
            absolute={single}
            variant="standard"
          />
          {/* 공용 범례 — 막대 목록·도넛·구성 추이가 같은 카테고리 색을 쓴다(피그마 571:380 하단 한 줄). */}
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {bars.map((b) => (
              <li key={b.name} className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: categoryColor(b.name) }} aria-hidden />
                {label(b.name)}
              </li>
            ))}
          </ul>
        </>
      ) : sections?.categoryTrend ? (
        // 구성 추이 조회가 일시 실패(P6 B041) — 숨기지 않고 기존 지연 안내.
        <PendingCard title={tCit("categoryTrend.title")} label={tKpi("degraded")} />
      ) : null}
      <SectionDoneMarker id="standard-citation:category" />
    </section>
  );
}

// ─── 엔진별 · 유형별 ─────────────────────────────────────────────────────────
function EngineBlock({ data }: Pick<Props, "data">) {
  const tCit = useTranslations("answerAnalysis.citations");
  const tRoot = useTranslations("answerAnalysis");
  const live = useAwaited(data);
  const label = useCatLabel();
  const active = useActiveCitationCategories();
  const done = <SectionDoneMarker id="standard-citation:engine" />;
  if (!live) return done;
  return (
    <>
      {live.engineCategories?.length ? (
        <EngineCategoryChart
          title={tCit("engineCategory.title")}
          hint={tCit("engineCategory.hint")}
          data={live.engineCategories}
          label={label}
          absolute={active.length === 1}
          variant="standard"
        />
      ) : (
        <PendingCard title={tCit("engineCategory.title")} label={tRoot("pending")} />
      )}
      {done}
    </>
  );
}
function TypeBlock({ typeCategories }: Pick<Props, "typeCategories">) {
  const t = useTranslations("answerAnalysis.citations.v2.typeCategory");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const rows = useAwaited(typeCategories);
  const label = useCatLabel();
  const vm = useMemo(() => typeCategoryBars(rows), [rows]);
  const done = <SectionDoneMarker id="standard-citation:type" />;
  if (rows == null)
    return (
      <>
        <PendingCard title={t("title")} label={tKpi("degraded")} />
        {done}
      </>
    );
  return (
    <>
      <TypeCategoryChart series={vm.series} bars={vm.bars} label={label} />
      {done}
    </>
  );
}

// ─── 답변 우호도별 인용 도메인 ───────────────────────────────────────────────
function ToneBlock({ toneSummary }: Pick<Props, "toneSummary">) {
  const t = useTranslations("answerAnalysis.citations.v2.tone");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const sum = useAwaited(toneSummary);
  const href = useSubpageHref();
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 lg:w-1/2">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </header>
      {sum == null ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{tKpi("degraded")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <LinkTile label={t("positive")} count={sum.positive.urls} href={href("tone-urls", { tone: "positive" })} disabled={sum.positive.urls === 0} disabledHint="" tone="good" size="lg" />
          <LinkTile label={t("negative")} count={sum.negative.urls} href={href("tone-urls", { tone: "negative" })} disabled={sum.negative.urls === 0} disabledHint="" tone="bad" size="lg" />
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{t("note")}</p>
      <SectionDoneMarker id="standard-citation:tone" />
    </section>
  );
}

// ─── 인용 도메인: 주별 Top10 + 순위 표 ───────────────────────────────────────
type SortKey = "domain" | "citations" | "share" | "coverageRate";

function DomainsBlock({
  data,
  picked,
  tableSource,
  sectionDegraded,
}: {
  data: Props["data"];
  picked: Set<string>;
  tableSource: Awaitable<CitationTableSource | null>;
  sectionDegraded: Awaitable<CitationSectionDegraded | null>;
}) {
  const t = useTranslations("answerAnalysis.citations");
  const tV2 = useTranslations("answerAnalysis.citations.v2");
  const tRoot = useTranslations("answerAnalysis");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const tFilter = useTranslations("answerAnalysis.filters");
  const live = useAwaited(data);
  const source = useAwaited(tableSource);
  const sections = useAwaited(sectionDegraded);
  // 엑셀 생성은 한 번에 하나(버튼 비활성), 실패는 기존 문구 토스트(P6 B048).
  const exportTask = useExportTask(useExportFailedNotice());
  const label = useCatLabel();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [sortKey, setSortKey] = useState<SortKey>("citations");
  const [asc, setAsc] = useState(false);
  const [expanded, setExpanded] = useState<{ domain: string; mode: "urls" | "prompts" } | null>(null);

  const legacySorted = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const base = applyCompetitorPick(live?.domains ?? [], picked).map((r, i) => ({ ...r, rank: i + 1 }));
    const arr = base.filter((r) => !q || r.domain.toLowerCase().includes(q));
    arr.sort((a, b) => {
      const dir = asc ? 1 : -1;
      if (sortKey === "domain") return dir * a.domain.localeCompare(b.domain);
      return dir * (a[sortKey] - b[sortKey]);
    });
    return arr.slice(0, DOMAIN_RANK_LIMIT);
  }, [live, picked, deferredSearch, sortKey, asc]);
  // API 원천: 검색·정렬은 서버가 전 출처에서 하고(U7-N5), '#' 은 경쟁사 선택 뒤·검색 전 인용
  // 순위(rank)다. 현행이 선택 뒤 번호를 매기고 검색한 것과 같은 규칙이다. 표는 여전히 상위 100.
  const table = useServerDomainTable({
    source,
    initial: applyCompetitorPick((live?.domains ?? []) as RankedDomainRow[], picked),
    q: deferredSearch,
    sortKey,
    asc,
    pageSize: DOMAIN_RANK_LIMIT,
  });
  const sorted = table.active
    ? table.rows.slice(0, DOMAIN_RANK_LIMIT).map((r, i) => ({ ...r, rank: r.rank ?? i + 1 }))
    : legacySorted;

  if (!live) return null;
  function clickHeader(k: SortKey) {
    if (sortKey === k) setAsc((v) => !v);
    else { setSortKey(k); setAsc(k === "domain"); }
  }
  function onExport() {
    const rows = sorted.map((r) => [r.rank, r.domain, r.category ? label(r.category) : "", r.citations, r.share.toFixed(1), r.prompts, r.coverageRate.toFixed(1)]);
    void exportTask.run(() =>
      downloadXlsx(
        `citation-sources-${dateStamp()}`,
        [t("table.col.rank"), t("table.col.domain"), t("table.col.category"), t("table.col.citations"), t("table.col.share"), t("table.col.prompts"), t("table.col.coverage")],
        rows,
      ),
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="citation-domains-heading">
      <h2 id="citation-domains-heading" className="text-lg font-medium tracking-tight text-foreground">{tV2("domainsHeading")}</h2>
      {/* 추이 조회가 일시 실패(P6 B041)면 '준비 중'이 아니라 기존 지연 안내. */}
      {live.trend ? (
        <CitationTrendChart title={t("trend.title")} trend={live.trend} />
      ) : (
        <PendingCard title={t("trend.title")} label={sections?.trend ? tKpi("degraded") : tRoot("pending")} />
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{t("table.title")}</h3>
            <p className="text-[11px] text-muted-foreground">{t("table.hint")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="relative w-full sm:w-56">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input id="c-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tFilter("domainSearchPlaceholder")} aria-label={tFilter("domainSearch")} className="h-8 pl-8 text-xs" />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onExport}
              disabled={sorted.length === 0 || exportTask.busy}
              aria-busy={exportTask.busy || undefined}
              className="shrink-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {tRoot("exportExcel")}
            </Button>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2 w-12">{t("table.col.rank")}</th>
              <Th onClick={() => clickHeader("domain")}>{t("table.col.domain")} <SortIcon active={sortKey === "domain"} asc={asc} /></Th>
              <th className="px-3 py-2">{t("table.col.category")}</th>
              <Th onClick={() => clickHeader("citations")} align="right" info={{ title: t("table.col.citations"), definition: t("table.colDefinition.citations"), formula: t("table.colFormula.citations") }}>
                {t("table.col.citations")} <SortIcon active={sortKey === "citations"} asc={asc} />
              </Th>
              <Th onClick={() => clickHeader("share")} align="right" info={{ title: t("table.col.share"), definition: t("table.colDefinition.share"), formula: t("table.colFormula.share") }}>
                {t("table.col.share")} <SortIcon active={sortKey === "share"} asc={asc} />
              </Th>
              <Th onClick={() => clickHeader("coverageRate")} align="right" info={{ title: t("table.col.coverage"), definition: t("table.colDefinition.coverage"), formula: t("table.colFormula.coverage") }}>
                {t("table.col.coverage")} <SortIcon active={sortKey === "coverageRate"} asc={asc} />
              </Th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground"><TableStatus table={table} empty={t("table.empty")} /></td></tr>
            ) : (
              sorted.map((r) => (
                <DomainRow
                  key={r.domain}
                  row={r}
                  rank={r.rank}
                  detailQuery={source?.query}
                  openMode={expanded?.domain === r.domain ? expanded.mode : null}
                  onToggle={(mode) => setExpanded((cur) => (cur && cur.domain === r.domain ? null : { domain: r.domain, mode }))}
                  drilldownTabs
                  hidePromptsCell
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <SectionDoneMarker id="standard-citation:domains" />
    </section>
  );
}
