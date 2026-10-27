"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  MessageCircle,
  BarChart3,
  Target,
  Smile,
  Layers,
  Clock,
  Swords,
  EyeOff,
  Trophy,
} from "lucide-react";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ColInfo } from "@/components/dash/col-info";
import {
  DimensionFilterPanel,
  FILTER_SECTIONS,
  type DimensionGroup,
} from "@/components/dash/dimension-filter-panel";
import { cn } from "@/lib/utils";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import {
  GapAwareTooltip,
  trendGapAreas,
  trendGapBridgeLines,
} from "@/components/dash/trend-gap-overlay";
import { planTrendGaps } from "@/lib/viz/trend-gap";
import type { MentionsLive, MentionTrend } from "@/lib/scope/result-adapter";
import {
  OWN_ROW,
  type BrandTableView,
  type ComparePartsScreen,
  type CompareRow,
  type ComparisonView,
  type MentionSubKpisView,
  type MentionViewScreen,
  type SummaryDelta,
  type TrendSeriesSplit,
  type TypeShareView,
} from "../_data/mention-screen";
import { composeGroups } from "./filter-groups";
import { BrandRankTable } from "./brand-rank-table";
import { SignalPromptsDialog } from "./signal-prompts-dialog";

// 표준 > 답변 분석 > 언급 분석 (Brand Mentions) — LIVE only.
//
// Fed by the root scope project (fetchStandardMentions → aggregateMentions).
// NO sample fallback: null → EmptyState. Per-mention sentiment / position /
// type come from scope's classification pass (change measurement-llm-sentiment-
// citation-classification); until that backfill lands the fields are absent and
// those widgets show a "준비 중" placeholder, lighting up automatically once
// scope reanalyses. The daily trend remains a scope gap (no time series yet).


// 표준 기본 축 구성 — geography + engine/promptContext + HMG 카탈로그 분류
// (brandPresence/listType/depth). 웹사이트 뷰는 onlyGroups/primaryGroups 를
// override 해 language 를 넣고 카탈로그 축(태깅 없어 무의미)을 숨긴다.

/**
 * 본문 집계 — `MentionsLive` 그대로이되 API 원천(lib/hgh/adapters/mentions.ts)의 두 가지를
 * 받는다(legacy 값은 그대로 들어맞는다):
 *   · `summary.totalPrompts` null — 요약 조회가 일시 실패했다. 0 을 지어내지 않고 "—"(B035).
 *   · `brandsTotal` — 전량 목록이 서버 상한(10,000)에서 잘렸을 때만, 잘리기 전 브랜드 수(B039).
 */
export type MentionsViewData = Omit<MentionsLive, "summary"> & {
  summary: Omit<MentionsLive["summary"], "totalPrompts"> & { totalPrompts: number | null };
  brandsTotal?: number;
};

/**
 * 어느 읽기가 **일시 실패**했는가(B035). 판정은 서버의 요청 스코프 표식
 * (`lib/scope/degrade-registry`)이라 이 클라이언트 뷰가 직접 못 읽고, 페이지가 집계가 끝난
 * 뒤에 읽어 넘긴다. 참인 자리는 "데이터 없음"·"준비 중" 대신 기존 `kpi.degraded` 문구를
 * 낸다. 미전달이면 종전 그대로다.
 */
export interface MentionsDegradedView {
  /** 본문(브랜드 행) — `data` 의 null 이 "데이터 없음"이 아니라 지연. */
  data?: boolean;
  /** 유형 집계 — 유형 카드의 '준비 중' 자리. */
  types?: boolean;
  /** Sub KPI·직전 Sub KPI(Δ)·측정 프롬프트 수 — 카드 그리드 아래 캡션 자리. */
  subKpis?: boolean;
}

/** Where the head-to-head fetches a picked target (the page's surface; project id on the project page). */
export interface CompareSource {
  surface: "website" | "project";
  projectId?: string;
  admin?: boolean;
}

export function MentionsView({
  vm,
  compareSource,
  lockedGroups = [],
  extraGroups = [],
  onlyGroups,
  primaryGroups,
  isWebsite = false,
  selectableDates,
  hideFilterPanel = false,
  lazyPrompts = false,
  scope,
  catalogRows,
  geographyOptions,
  engineOptions,
  languageOptions,
  dynamicAxes,
}: {
  /** mention/view — every value of the four sections, computed by the screen. */
  vm: MentionViewScreen;
  compareSource: CompareSource;
  lockedGroups?: DimensionGroup[];
  // Appended to onlyGroups/primaryGroups — 웹사이트 뷰가 admin 에게 brand(브랜드
  // 통합) 축을 추가 노출하기 위해 사용. 비어 있으면 표준 필터 구성 그대로.
  extraGroups?: DimensionGroup[];
  // 축 구성 override — 웹사이트 뷰가 표준 카탈로그 축 대신 geography/language/
  // engine 만 노출하기 위해 사용. 미지정 시 표준 기본값. extraGroups 는 여기에도
  // 추가로 append 된다.
  onlyGroups?: DimensionGroup[];
  primaryGroups?: DimensionGroup[];
  // 인용출처 드릴다운 탭이 표준 루트 대신 website 전용 데이터 소스를 쓰도록
  // 신호(2026-07-06) — /api/scope/brand-citations?surface=website 로 라우팅.
  isWebsite?: boolean;
  // 2026-08-27 — 필터바를 이 뷰 밖(페이지의 별도 <Suspense> 경계)에서 그릴 때 켠다.
  hideFilterPanel?: boolean;
  /**
   * 앵커 축(스펙 §5.1) — 회차가 있는 KST 날짜 목록. `undefined`(축 off·미적용)면
   * 달력은 종전대로 전 날짜를 연다. 계열은 그 지면의 것이다(D1).
   */
  selectableDates?: string[];
  // 드릴다운 프롬프트를 클릭 시 lazy fetch 한다(API 원천은 perBrandPrompts 가 비어 있다).
  lazyPrompts?: boolean;
  scope?: import("@/lib/auth/types").AllowedScope;
  catalogRows?: import("@/components/dash/dimension-filter-panel").CatalogTaxonomyRow[];
  geographyOptions?: string[];
  // 기간 내 실제 수집 엔진(프로젝트 표면 주입) — DimensionFilterPanel.engineOptions.
  engineOptions?: string[];
  languageOptions?: string[];
  // 프로젝트 커스텀 태그를 필터 패널의 동적 축으로 주입(프로젝트 mention만).
  dynamicAxes?: import("@/components/dash/dimension-filter-panel").DynamicAxis[];
}) {
  const t = useTranslations("answerAnalysis.mentions");
  const tRoot = useTranslations("answerAnalysis");
  const data = vm.data;

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <EmptyState label={vm.degraded.data ? t("kpi.degraded") : tRoot("empty")} />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex flex-col gap-6">
      {/* (a) Single header filter bar — dimensions + brand search are the
          one data driver for all content below (geography/engine/promptContext
          are the only scope-honorable axes; time/source/competitor have no
          scope source — see OverviewFilters). */}
      {hideFilterPanel ? null : (
        <DimensionFilterPanel
          stage="mentions"
          selectableDates={selectableDates}
          lockedGroups={lockedGroups}
          scope={scope}
          catalogRows={catalogRows}
          geographyOptions={geographyOptions}
          engineOptions={engineOptions}
          languageOptions={languageOptions}
          dynamicAxes={dynamicAxes}
          onlyGroups={composeGroups("mentions", { onlyGroups, primaryGroups, extraGroups, languageOptions }).only}
          primaryGroups={
            composeGroups("mentions", { onlyGroups, primaryGroups, extraGroups, languageOptions }).primary
          }
          sections={FILTER_SECTIONS}
          sticky
          asOf={data.asOf}
        />
      )}
      {/* 본문 3구획 — website/project 표면용 조립본이라 세 구획을 그대로 이어 붙인다. */}
      <MentionsSummarySection vm={vm} compareSource={compareSource} />
      <MentionsTrendSection data={data} trendSeries={vm.trendSeries ?? null} />
      {vm.table ? (
        <MentionsRankSection data={data} table={vm.table} isWebsite={isWebsite} lazyPrompts={lazyPrompts} />
      ) : null}
    </div>
    </TooltipProvider>
  );
}

// ─── 본문 구획 (2026-09-03 섹션 스트리밍 분할) ────────────────────────────────
//
// 표준 언급 화면은 이 세 구획을 각각 자기 <Suspense> 경계에서 그린다. 갈라 놓은
// 기준은 **read 소유권**이다:
//
//   ① MentionsSummarySection — fetchStandardMentions + fetchStandardSubKpis(+Prev)
//   ② MentionsTrendSection   — fetchStandardMentions 만
//   ③ MentionsRankSection    — fetchStandardMentions 만
//
// Sub KPI 집계는 언급 집계보다 훨씬 무겁다(Q1~Q5 전량). 예전엔 셋이 한 경계에
// 묶여 있어 **가장 느린 Sub KPI 하나가 추이·순위표까지 붙잡았다**. 이제 ②③ 는
// 언급 집계가 끝나는 즉시 나타나고 ① 만 뒤늦게 채워진다. 같은 언급 집계를 세
// 경계가 나눠 불러도 DB 왕복은 1회다(fetchStandardMentions = requestDeduped).
//
// 빈 상태의 지면은 ① 이 소유한다 — ②③ 는 데이터가 없으면 스스로 사라진다
// (dashboard/page.tsx 의 섹션 규약과 동일).

/**
 * The head-to-head target the user picked: the screen recomputes the comparison and the type stack
 * for it (mention/view-compare through /api/scope/mention-compare). Until it answers, the previous
 * comparison stays on screen.
 */
function usePickedCompare(source: CompareSource, manualTarget: string | null): ComparePartsScreen | null {
  const searchParams = useSearchParams();
  const spStr = searchParams?.toString() ?? "";
  const [picked, setPicked] = useState<{ key: string; parts: ComparePartsScreen } | null>(null);
  const reqKey = manualTarget == null ? null : `${spStr}|${manualTarget}`;
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (reqKey == null || manualTarget == null) return;
    last.current = reqKey;
    const params = new URLSearchParams(spStr);
    params.set("target", manualTarget);
    params.set("surface", source.surface);
    if (source.projectId) params.set("projectId", source.projectId);
    if (source.admin) params.set("admin", "1");
    const ctrl = new AbortController();
    fetch(`/api/scope/mention-compare?${params.toString()}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<ComparePartsScreen>) : null))
      .then((parts) => {
        if (parts && last.current === reqKey) setPicked({ key: reqKey, parts });
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [reqKey, manualTarget, spStr, source.surface, source.projectId, source.admin]);
  return reqKey != null && picked?.key === reqKey ? picked.parts : null;
}

export function MentionsSummarySection({
  vm,
  compareSource,
}: {
  vm: MentionViewScreen;
  compareSource: CompareSource;
}) {
  const t = useTranslations("answerAnalysis.mentions");
  const tRoot = useTranslations("answerAnalysis");
  const { data, subKpis, prevSubKpis, prevBasisDate, degraded } = vm;
  // 감정·유형 세그먼트 드릴다운 대상 (null = 닫힘).
  const [signal, setSignal] = useState<{ signal: string; label: string } | null>(null);
  // 4.1.7: 헤드투헤드 비교 대상 빠른 전환 — 이미 측정된 외부 브랜드 중 하나를
  // 직접 골라 비교한다. null = 기본(지정 브랜드 or 자동 SOV 1위, 화면이 고른다).
  const [manualTarget, setManualTarget] = useState<string | null>(null);
  const picked = usePickedCompare(compareSource, manualTarget);
  // 고른 대상의 결과가 오기 전에는 직전 결과(기본 또는 직전 선택)를 그대로 둔다.
  const shown = useRef<ComparePartsScreen>({ comparison: vm.comparison ?? null, typeShare: vm.typeShare ?? null });
  if (manualTarget == null) shown.current = { comparison: vm.comparison ?? null, typeShare: vm.typeShare ?? null };
  else if (picked) shown.current = picked;
  const { comparison, typeShare } = shown.current;
  const deltas = vm.deltas;

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <EmptyState label={degraded.data ? t("kpi.degraded") : tRoot("empty")} />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {/* (b) Summary cards — live. 뒤 3개는 Sub KPI (미언급 프롬프트 / 복수언급 /
          Top3). subKpis 가 없으면 앞 3개만 남고 그리드가 그대로 접힌다. */}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryCard
          icon={MessageCircle}
          label={t("summary.total")}
          value={data.summary.total.toLocaleString()}
          // Δ는 현재/직전 모두 subKpis 총계에서 계산 — 표시값(data.summary)과
          // 산출 경로가 달라도 증감 자체는 동일 기준끼리 비교된다.
          delta={deltas?.total ?? null}
          info={{
            title: t("summary.total"),
            definition: t("def.total.definition"),
            formula: t("def.total.formula"),
          }}
        />
        <SummaryCard
          icon={Target}
          label={t("summary.uniqueBrands")}
          value={data.summary.uniqueBrands.toLocaleString()}
          info={{
            title: t("summary.uniqueBrands"),
            definition: t("def.uniqueBrands.definition"),
            formula: t("def.uniqueBrands.formula"),
          }}
        />
        <SummaryCard
          icon={BarChart3}
          label={t("summary.totalPrompts")}
          // null = 요약 조회 일시 실패(B035) — 0 을 지어내지 않는다(미언급 프롬프트 카드와 같은 "—").
          value={data.summary.totalPrompts != null ? data.summary.totalPrompts.toLocaleString() : "—"}
          delta={deltas?.totalPrompts ?? null}
          info={{
            title: t("summary.totalPrompts"),
            definition: t("def.totalPrompts.definition"),
            formula: t("def.totalPrompts.formula"),
          }}
        />
        {subKpis ? (
          <>
            <SummaryCard
              icon={EyeOff}
              label={t("summary.missingPrompts")}
              value={subKpis.missingPrompts != null ? subKpis.missingPrompts.toLocaleString() : "—"}
              delta={deltas?.missingPrompts ?? null}
              info={{
                title: t("summary.missingPrompts"),
                definition: t("def.missingPrompts.definition"),
                formula: t("def.missingPrompts.formula"),
              }}
            />
            <SummaryCard
              icon={Layers}
              label={t("summary.multiMention")}
              value={subKpis.multiMentionAnswers.toLocaleString()}
              delta={deltas?.multiMention ?? null}
              info={{
                title: t("summary.multiMention"),
                definition: t("def.multiMention.definition"),
                formula: t("def.multiMention.formula"),
              }}
            />
            <SummaryCard
              icon={Trophy}
              label={t("summary.top3Rate")}
              value={subKpis.top3Rate != null ? `${subKpis.top3Rate.toFixed(1)}%` : "—"}
              delta={deltas?.top3Rate ?? null}
              detail={
                subKpis.top3Count != null && subKpis.top3Base != null
                  ? t("summary.ratioAnswers", {
                      num: subKpis.top3Count.toLocaleString(),
                      den: subKpis.top3Base.toLocaleString(),
                    })
                  : undefined
              }
              info={{
                title: t("summary.top3Rate"),
                definition: t("def.top3Rate.definition"),
                formula: t("def.top3Rate.formula"),
              }}
            />
          </>
        ) : null}
      </div>

      {/* 증감 비교 기준 — "전주인지 전월인지" 모호함을 없애기 위해 비교한 측정일을
          그대로 명시 (2026-08-06 고객 피드백). prevSubKpis 없으면(측정 1회뿐)
          배지도 캡션도 없다. */}
      {subKpis && prevSubKpis && prevBasisDate ? (
        <p className="-mt-3 text-[11px] text-muted-foreground">
          {t("summary.deltaBasis", { date: prevBasisDate })}
        </p>
      ) : null}
      {/* Sub KPI·직전 Sub KPI(Δ)·측정 프롬프트 수 조회가 일시 실패했으면(B035) 빠진 카드·배지·"—" 가
          "측정 없음"으로 읽히지 않게 같은 캡션 자리에 기존 degraded 문구를 둔다. */}
      {degraded.subKpis ? (
        <p className="-mt-3 text-[11px] text-muted-foreground">{t("kpi.degraded")}</p>
      ) : null}

      {/* (b-1) 당사 vs 경쟁사 헤드투헤드 — comparison is null when there's no
          own or no external brand in the current filtered slice. */}
      {comparison ? (
        <CompetitorHeadToHead
          comparison={comparison}
          manualTarget={manualTarget}
          onTargetChange={setManualTarget}
        />
      ) : (
        <PendingCard title={t("compare.title")} label={t("compare.empty")} />
      )}

      {/* (b-2) 감정·유형 집계 — live once scope's classification backfill lands.
          세그먼트/행 클릭 시 그 신호가 발생한 프롬프트 목록 → 답변 원문
          (2026-08-06 고객 피드백: 상세 분석 기능 부족). */}
      <div className="grid gap-3 md:grid-cols-2">
        {vm.sentiment ? (
          <SentimentBreakdown
            segments={vm.sentiment}
            sub={subKpis}
            onSignalClick={(signal, label) => setSignal({ signal, label })}
          />
        ) : (
          <PendingCard title={t("breakdown.sentimentTitle")} label={tRoot("pending")} />
        )}
        {vm.typeAbs ? (
          <TypeBreakdown
            typeAbs={vm.typeAbs}
            typeShare={typeShare}
            onSignalClick={(signal, label) => setSignal({ signal, label })}
          />
        ) : (
          // 유형 조회가 일시 실패했으면(B035) '준비 중' 대신 기존 degraded 문구.
          <PendingCard title={t("breakdown.typesTitle")} label={degraded.types ? t("kpi.degraded") : tRoot("pending")} />
        )}
      </div>
      <SignalPromptsDialog
        signal={signal?.signal ?? null}
        title={t("signalDrilldown.title", { signal: signal?.label ?? "" })}
        onOpenChange={(o) => {
          if (!o) setSignal(null);
        }}
      />
    </div>
    </TooltipProvider>
  );
}

// ② 추이 — 언급 집계만 읽는다. 데이터가 없으면 스스로 사라진다(빈 상태는 ①).
export function MentionsTrendSection({
  data,
  trendSeries,
}: {
  data: MentionsViewData | null;
  /** 시리즈 구분(당사 브랜드 · 경쟁사) — 화면이 계산해 보낸다. */
  trendSeries: TrendSeriesSplit | null;
}) {
  const t = useTranslations("answerAnalysis.mentions");
  const tRoot = useTranslations("answerAnalysis");
  if (!data) return null;
  return (
    <>
      {/* (c) Trend chart — weekly Top-10 brand mention lines. Needs ≥2 dated
          weeks (data.trend is null otherwise → 준비 중 placeholder). */}
      {data.trend && trendSeries ? (
        <MentionTrendChart title={t("trend.title")} trend={data.trend} series={trendSeries} />
      ) : (
        // null 의 두 사유를 구분한다 — 시간 초과·일시 실패(degrade)와 "2주 미만"(측정 대기).
        // 표준 공통 하단(mentions-prompts-section.tsx)과 같은 판정·같은 문구다(B035).
        <PendingCard
          title={t("trend.title")}
          label={data.trendDegraded ? t("kpi.degradedTrend") : tRoot("pending")}
        />
      )}
    </>
  );
}

// ③ 브랜드 언급 순위표 + 드릴다운 — 언급 집계만 읽는다. 검색·정렬·펼침 상태는
// 이 구획이 소유한다(다른 구획을 리렌더시키지 않는다).
export function MentionsRankSection({
  data,
  table,
  isWebsite = false,
  lazyPrompts = false,
}: {
  data: MentionsViewData | null;
  /** 브랜드 표의 화면 값(순번·값·정렬 순서). */
  table: BrandTableView;
  isWebsite?: boolean;
  lazyPrompts?: boolean;
}) {
  if (!data) return null;

  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex flex-col gap-6">
      {/* (d) Main brands table + drilldown — live. 표(검색·정렬·내보내기·드릴다운)는
          brand-rank-table.tsx 로 추출(2026-09-02, 표준 공통 하단과 공유). 이 표면
          (website/project)의 마크업·동작은 종전과 동일하다 — 토글·순위 열은 꺼져 있다. */}
      <BrandRankTable
        brands={data.brands}
        table={table}
        perBrandPrompts={data.perBrandPrompts}
        isWebsite={isWebsite}
        lazyPrompts={lazyPrompts}
        total={data.brandsTotal}
      />
    </div>
    </TooltipProvider>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  info,
  detail,
  delta,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  // 지표 정의 툴팁 — 기본 3개 카드에도 제공 (2026-08-06 고객 피드백: 정의·산식
  // 설명 부족).
  info?: { title: string; definition: string; formula?: string };
  // 비율 지표의 분자·분모 병기(예: "128 / 1,024 답변") — 표본 규모 판단용.
  detail?: string;
  // 직전 측정 대비 증감 — 비교 기준일은 카드 그리드 하단 캡션에 1회 명시.
  delta?: SummaryDelta | null;
}) {
  const deltaText =
    delta && delta.diff !== 0
      ? `${delta.diff > 0 ? "▲" : "▼"} ${Math.abs(delta.diff).toLocaleString()}${delta.unit === "pp" ? "%p" : ""}`
      : delta
        ? "—"
        : null;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
      <Icon className="h-5 w-5 text-brand-700" aria-hidden />
      <div className="flex min-w-0 flex-col">
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
          {info ? <ColInfo {...info} /> : null}
        </span>
        {/* 값 + Δ는 한 줄이 기본이고, 자리가 모자라면 Δ가 "통째로" 다음 줄로
            내려간다 — flex-wrap(줄바꿈 단위 = 자식) + Δ 내부 whitespace-nowrap.
            (2026-09-05: 큰 수에서 "▲"만 남고 숫자가 다음 줄로 갈라지던 문제) */}
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-head text-xl font-semibold tracking-tight tabular-nums text-foreground">
            {value}
          </span>
          {deltaText ? (
            <span
              className={cn(
                "text-[10px] font-semibold whitespace-nowrap tabular-nums",
                delta!.tone === "good" && "text-emerald-600 dark:text-emerald-500",
                delta!.tone === "bad" && "text-destructive",
                delta!.tone === "neutral" && "text-muted-foreground",
              )}
            >
              {deltaText}
            </span>
          ) : null}
        </span>
        {detail ? (
          <span className="text-[10px] tabular-nums text-muted-foreground">{detail}</span>
        ) : null}
      </div>
    </div>
  );
}

// Brand-color palette for the weekly mention trend lines (HMG BI + accents).
// 당사 3사는 인덱스 순환이 아니라 브랜드 고정색 — 필터로 시리즈 구성이 바뀌어도
// 당사 색이 흔들리지 않는다 ("색은 순위가 아니라 엔티티를 따른다").
const OWN_TREND_COLORS: Record<string, string> = {
  Hyundai: "#002c5f",
  Kia: "#e63312",
  Genesis: "#a36b4f",
};
const COMPETITOR_TREND_COLORS = [
  "#00aad2", "#6b89b3", "#1a4d8e", "#0d6e2f", "#fbbf24", "#f97316", "#a855f7",
];

// Weekly Top-N brand mention trend — one line per series brand over ISO
// week-starts. Replaces the "준비 중" placeholder once ≥2 dated weeks exist.
// 당사 강조(2026-08-06 고객 피드백): 당사 = 굵은 실선 + 브랜드 고정색, 경쟁사 =
// 가는 점선 저채도 — 색 외에 굵기·대시로도 구분(색각 이상 대비 이중 부호화).
// 당사 라인을 마지막에 선언해 겹침에서 항상 위에 그린다.
// 주간 버킷 라벨: ISO 월요일 주-시작("2026-08-03")을 "8/3"로. 문자열 파싱이라
// TZ/로케일 무관·하이드레이션 안전. 실제 축 라벨은 "{md} 주"로 i18n 조합해,
// 원시 날짜("2026-08-03")를 측정일로 오해하던 혼란을 없앤다(2026-08 고객 피드백).
export function weekStartMD(iso: string): string {
  const p = String(iso).split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : String(iso);
}

export function MentionTrendChart({
  title,
  trend,
  series,
}: {
  title: string;
  trend: MentionTrend;
  /** 시리즈 구분(당사 브랜드 · 경쟁사) — 화면이 계산해 보낸다(시리즈 순서 유지). */
  series: TrendSeriesSplit;
}) {
  const tRoot = useTranslations("answerAnalysis");
  const weekLabel = (v: unknown) => tRoot("weekAxis", { md: weekStartMD(String(v)) });
  const { competitors, own } = series;
  const trackedBrands = new Set(own);
  // 수집 오류 주 — 값 대신 음영 + 안내 문구(lib/viz/trend-gap.ts).
  const gapPlan = planTrendGaps(trend.points, { xKey: "week", seriesKeys: trend.series, family: "mention" });
  const strokeOf = (b: string): string =>
    trackedBrands.has(b)
      ? (OWN_TREND_COLORS[b] ?? OWN_TREND_COLORS.Hyundai)
      : COMPETITOR_TREND_COLORS[competitors.indexOf(b) % COMPETITOR_TREND_COLORS.length];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      <div className="h-72 min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 288 }}>
          <LineChart data={gapPlan.rows} margin={{ left: -16, right: 8, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            {trendGapAreas(gapPlan.areas)}
            <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
            <YAxis tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" allowDecimals={false} />
            {/* 툴팁: 값(언급 수) 내림차순 = 그 주의 순위 순(기본은 시리즈 등록
                순이라 몇 위인지 읽기 어려웠음) + zIndex 로 라벨 위 겹침 해소.
                labelFormatter 로 헤더도 "M/D 주" 표기(축과 동일). */}
            <RTooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              labelFormatter={weekLabel}
              itemSorter={(item) => -Number(item.value ?? 0)}
              wrapperStyle={{ zIndex: 50 }}
              // 갭 슬롯은 전 시리즈 null — filterNull 기본값이면 payload 가 비어
              // content 가 마커를 못 본다. 마커를 본 GapAwareTooltip 은 **아무것도
              // 안 낸다**(2026-09-11 제품 책임자 "다른 차트에도 갭 툴팁 지워줘"). null
              // 걷어내기도 GapAwareTooltip 이 대신하므로 갭 아닌 칸은 종전 그대로다.
              filterNull={false}
              content={<GapAwareTooltip />}
            />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value: string) =>
                trackedBrands.has(value) ? (
                  <span className="font-semibold text-foreground">{value}</span>
                ) : (
                  value
                )
              }
            />
            {competitors.map((b, i) => (
              <Line
                key={b}
                type="monotone"
                dataKey={b}
                name={b}
                stroke={COMPETITOR_TREND_COLORS[i % COMPETITOR_TREND_COLORS.length]}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.55}
                dot={{ r: 2.5 }}
              />
            ))}
            {own.map((b) => (
              <Line
                key={b}
                type="monotone"
                dataKey={b}
                name={b}
                stroke={OWN_TREND_COLORS[b] ?? "#002c5f"}
                strokeWidth={3}
                dot={{ r: 2.5 }}
              />
            ))}
            {/* 이웃 잇기 — 갭 슬롯 양옆 값만 실은 보조 라인(원 시리즈와 같은 부호). */}
            {trendGapBridgeLines(gapPlan.bridges, (b) => {
              if (!trend.series.includes(b)) return null;
              const isOwn = trackedBrands.has(b);
              return {
                stroke: strokeOf(b),
                strokeWidth: isOwn ? 3 : 1.5,
                strokeDasharray: isOwn ? undefined : "4 3",
                strokeOpacity: isOwn ? undefined : 0.55,
              };
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type ComparisonRole = "ours" | "target" | "peer";
// 측정된 외부 브랜드 목록(SOV 내림차순, options)과 '당사'에 합산된 브랜드 목록(ownBrands)을 함께 받는다.
type ComparisonData = ComparisonView;

// 비교 대상 드롭다운의 "기본값(지정/자동)" 옵션 sentinel — Radix Select는 빈
// 문자열 value를 허용하지 않아 별도 토큰을 쓴다.
const DEFAULT_TARGET = "__default__";

// 당사 vs 경쟁사 헤드투헤드 — 색상은 역할(당사/비교 대상/참고)에 고정되고
// 지정/자동 전환과 무관하게 유지된다(전체 브랜드 표 필터가 바뀌어도 생존 항목이
// 재도색되지 않도록). 참고 브랜드는 최대 2곳까지만, 회색으로 강등.
function CompetitorHeadToHead({
  comparison,
  manualTarget,
  onTargetChange,
}: {
  comparison: ComparisonData;
  manualTarget: string | null;
  onTargetChange: (brand: string | null) => void;
}) {
  const t = useTranslations("answerAnalysis.mentions.compare");
  const { own, target, peers, mode, options, ownBrands } = comparison;
  const rows: Array<{ row: CompareRow; role: ComparisonRole }> = [
    { row: own, role: "ours" },
    { row: target, role: "target" },
    ...peers.map((row) => ({ row, role: "peer" as const })),
  ];

  const posValues = rows
    .map((r) => r.row.avgPosition)
    .filter((v): v is number => v != null);
  const posWorst = posValues.length ? Math.max(...posValues) : 1;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Swords className="h-4 w-4 text-brand-700" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{t("title")}</h3>
            <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
            {/* '당사' 포함 범위 명시 — 계정/프로젝트 컨텍스트에 따라 1~3사가
                합산되므로 실제 합산 대상을 그대로 나열 (2026-08-06 고객 피드백). */}
            {ownBrands.length > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {t("oursScope", { brands: ownBrands.join(" · ") })}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">{t("selectLabel")}</span>
            <Select
              value={manualTarget ?? DEFAULT_TARGET}
              onValueChange={(v) => onTargetChange(v === DEFAULT_TARGET ? null : v)}
            >
              <SelectTrigger size="sm" className="h-7 min-w-[9rem] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_TARGET}>{t("useDefault")}</SelectItem>
                {options.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold",
              mode === "designated"
                ? "border-accent-gold text-accent-gold"
                : mode === "manual"
                  ? "border-accent-info text-accent-info"
                  : "border-border text-foreground",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                mode === "designated" ? "bg-accent-gold" : "bg-accent-info",
              )}
              aria-hidden
            />
            {mode === "designated"
              ? t("designatedBadge", { brand: target.brand })
              : mode === "manual"
                ? t("manualBadge", { brand: target.brand })
                : t("autoBadge", { brand: target.brand })}
          </span>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {mode === "designated"
          ? t("designatedNote")
          : mode === "manual"
            ? t("manualNote")
            : t("autoNote")}
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {/* 점유율·언급률은 그 자체가 백분율이므로 **0–100 절대 스케일**로 그린다.
            종전에는 화면 내 최댓값으로 나눠서 1위 브랜드가 점유율이 얼마든 항상
            꽉 찬 막대였다 — 71.3% 인데 100% 로 보이는 것(GEO-3).
            ⚠️ 노출 순위(position)는 백분율이 아니므로 아래처럼 상대 스케일을 유지한다. */}
        <CompareMetric title={t("metric.share")} rows={rows} valueKey="share" max={100} suffix="%" oursLabel={t("ours")} />
        <CompareMetric title={t("metric.rate")} rows={rows} valueKey="mentionRate" max={100} suffix="%" oursLabel={t("ours")} />
        <CompareMetric
          title={t("metric.position")}
          hint={t("positionHint")}
          rows={rows}
          valueKey="avgPosition"
          max={posWorst}
          invert
          oursLabel={t("ours")}
        />
      </div>
    </div>
  );
}

function CompareMetric({
  title,
  hint,
  rows,
  valueKey,
  max,
  invert = false,
  suffix = "",
  oursLabel,
}: {
  title: string;
  hint?: string;
  rows: Array<{ row: CompareRow; role: ComparisonRole }>;
  /** The own row's name (`compare.ours`): the screen sends it as the OWN_ROW sentinel. */
  oursLabel: string;
  valueKey: "share" | "mentionRate" | "avgPosition";
  max: number;
  invert?: boolean;
  suffix?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {hint ? <span className="ml-1 font-normal normal-case text-muted-foreground/70">({hint})</span> : null}
      </h4>
      <div className="flex flex-col gap-2">
        {rows.map(({ row, role }) => {
          const value = row[valueKey];
          const raw = value == null ? 0 : invert ? Math.max(0, max - value) : value;
          const pct = Math.max(2, Math.min(100, (raw / max) * 100));
          const display = value == null ? "—" : value.toFixed(1) + suffix;
          const name = row.brand === OWN_ROW ? oursLabel : row.brand;
          return (
            <div key={row.brand} className="grid grid-cols-[70px_1fr_44px] items-center gap-2">
              <span
                className={cn(
                  "truncate text-[11px] font-medium",
                  role === "ours"
                    ? "font-bold text-brand-700"
                    : role === "target"
                      ? "font-bold text-accent-info"
                      : "text-muted-foreground",
                )}
                title={name}
              >
                {name}
              </span>
              <div className="relative h-2.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "absolute top-0 left-0 h-full rounded-full",
                    role === "ours"
                      ? "bg-brand-700"
                      : role === "target"
                        ? "bg-accent-info"
                        : "bg-muted-foreground/40",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-right text-[11px] font-semibold tabular-nums text-foreground">{display}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SentimentBreakdown({
  segments,
  sub,
  onSignalClick,
}: {
  /** 4분류 세그먼트 — 값과 그 비율(화면이 계산해 보낸다). */
  segments: NonNullable<MentionViewScreen["sentiment"]>;
  // Sub KPI 2종(긍정·부정 키워드 언급 수) — 같은 sentiment 신호에서 나오므로
  // 별도 패널을 만들지 않고 이 패널 하단 행으로 붙인다.
  sub?: MentionSubKpisView | null;
  // 범례 클릭 → 그 감정 신호가 발생한 프롬프트 목록 (2026-08-06 피드백).
  onSignalClick: (signal: string, label: string) => void;
}) {
  const t = useTranslations("answerAnalysis.mentions.breakdown");
  // 짧은 칩 문구는 KPI 사전의 "측정 대기" — answerAnalysis.pending 은 빈 패널용
  // 안내문(한 문장)이라 인라인 칩에는 길다.
  const tKpi = useTranslations("dashboard.kpi");
  const segs = segments.map((sg) => ({ key: sg.key, value: sg.value, share: sg.share, cls: sg.cls, label: t(sg.key) }));
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Smile className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{t("sentimentTitle")}</h3>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("sentimentHint")}</p>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {segs.map((s) => (
          <div key={s.key} className={cn("h-full", s.cls)} style={{ width: `${s.share}%` }} aria-hidden />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px]">
        {segs.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              disabled={s.value === 0}
              onClick={() => onSignalClick(s.key, s.label)}
              className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground enabled:hover:bg-muted/40 enabled:hover:text-foreground disabled:cursor-default"
            >
              <span className={cn("h-2.5 w-2.5 rounded-[2px]", s.cls)} aria-hidden />
              <span className="text-foreground">{s.label}</span>
              <span className="tabular-nums">{s.share.toFixed(1)}%</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="-mt-1 text-[10px] text-muted-foreground">{t("drilldownHint")}</p>
      {/* Sub KPI — sentiment 신호에서 파생되는 2종. 값이 없으면(백필 전) 0 을
          지어내지 않고 "측정 대기" 칩으로 둔다. (부정 언급 비율은 상단 분포의
          부정 세그먼트와 동일 값이라 제거 — 2026-08-06 고객 피드백) */}
      {sub ? (
        <dl className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
          {(
            [
              { key: "positiveKeywords", value: sub.positiveKeywords },
              { key: "negativeKeywords", value: sub.negativeKeywords },
            ] as const
          ).map((row) => (
            <div key={row.key} className="flex items-baseline justify-between gap-2">
              <dt className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                {t(`sub.${row.key}`)}
                <ColInfo
                  title={t(`sub.${row.key}`)}
                  definition={t(`sub.def.${row.key}.definition`)}
                  formula={t(`sub.def.${row.key}.formula`)}
                />
              </dt>
              <dd>
                {row.value == null ? (
                  <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {tKpi("pending")}
                  </span>
                ) : (
                  <span className="text-[11px] font-semibold tabular-nums text-foreground">
                    {row.value.toLocaleString()}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}


function TypeBreakdown({
  typeAbs,
  typeShare,
  onSignalClick,
}: {
  /** 당사 유형 구성(절대 건수)과 막대 폭 — 화면이 계산해 보낸다. */
  typeAbs: NonNullable<MentionViewScreen["typeAbs"]>;
  /** 유형별 구성비 스택(당사 · 비교 대상 · 상위 3 · 그 외)과 범례 — 헤드투헤드 대상에 따라 화면이 계산한다. */
  typeShare: TypeShareView | null;
  onSignalClick: (signal: string, label: string) => void;
}) {
  const t = useTranslations("answerAnalysis.mentions.breakdown");
  const labelOf = (x: { label?: string; labelKey?: "ours" | "others" }) => (x.labelKey ? t(x.labelKey) : (x.label ?? ""));
  const shareRows = typeShare?.rows ?? null;
  const legendItems = (typeShare?.legend ?? []).map((item) => ({ color: item.color, label: labelOf(item) }));

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Layers className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{t("typesTitle")}</h3>
        <ColInfo
          title={t("typesTitle")}
          definition={t("typesShareDef.definition")}
          formula={t("typesShareDef.formula")}
        />
      </div>

      {shareRows ? (
        <>
          <p className="text-[11px] text-muted-foreground">{t("typesShareHint")}</p>
          <ul className="flex flex-col gap-2.5">
            {shareRows.map((r) => (
              <li key={r.type} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-[11px] text-foreground">{t(`type.${r.type}`)}</span>
                <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                  {r.total > 0 ? (
                    r.segs.map((s) => (
                      <div
                        key={s.key}
                        className={s.color}
                        style={{ width: `${s.width}%` }}
                        title={`${labelOf(s)}: ${s.val.toLocaleString()}`}
                      />
                    ))
                  ) : null}
                </div>
                <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-foreground">
                  {t("oursShare", { pct: r.trackedShare.toFixed(1) })}
                </span>
              </li>
            ))}
          </ul>
          {/* 범례 — **막대 구간에서 파생**한다 (2026-08-31, GEO-5).
              종전에는 당사·비교·기타 3개가 하드코딩돼 있었는데 막대는 최대 6구간을
              그려서, 이름 없는 색 덩어리가 최대 3개 남았다. 실제로 그려진 세그먼트만
              (색 기준 중복 제거) 나열하면 막대와 범례가 구조적으로 어긋날 수 없다. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            {legendItems.map((item) => (
              <span key={item.color} className="inline-flex items-center gap-1">
                <span className={cn("h-2 w-2 rounded-sm", item.color)} />
                {item.label}
              </span>
            ))}
          </div>
        </>
      ) : null}

      {/* 보조 — 당사 유형 구성(절대 건수). 클릭 시 그 유형 프롬프트 드릴다운. */}
      <details className="group" {...(shareRows ? {} : { open: true })}>
        <summary className="cursor-pointer list-none text-[11px] font-medium text-muted-foreground hover:text-foreground">
          {t("typesAbsToggle")}
        </summary>
        <ul className="mt-2 flex flex-col gap-1.5">
          {typeAbs.map(({ key, value, width }) => {
            return (
              <li key={key}>
                <button
                  type="button"
                  disabled={value === 0}
                  onClick={() => onSignalClick(key, t(`type.${key}`))}
                  className="flex w-full items-center gap-3 rounded-md px-1 py-0.5 text-left enabled:hover:bg-muted/40 disabled:cursor-default"
                >
                  <span className="w-16 shrink-0 text-[11px] text-foreground">{t(`type.${key}`)}</span>
                  <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="absolute top-0 left-0 h-full rounded-full bg-brand-700" style={{ width: `${width}%` }} aria-hidden />
                  </div>
                  <span className="w-12 shrink-0 text-right text-[11px] font-semibold tabular-nums text-foreground">
                    {value.toLocaleString()}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-[10px] text-muted-foreground">{t("drilldownHint")}</p>
      </details>
    </div>
  );
}

// Placeholder for a metric scope can't yet supply (daily trend, or sentiment/
// type before the classification backfill). Fills in automatically once the
// field appears — see docs/scope-requests/answer-analysis-data-gaps.md.
export function PendingCard({ title, label }: { title: string; label: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-card p-4">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      <div className="flex items-center justify-center gap-2 rounded-md bg-muted/20 px-4 py-8 text-xs text-muted-foreground">
        <Clock className="h-4 w-4" aria-hidden />
        {label}
      </div>
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-4 py-16 text-sm text-muted-foreground">
      {label}
    </div>
  );
}



