"use client";

// AI 우선 노출도 탭 (PR ③, 디자인 327:1140).
//
// ① 히어로 — 좌측 당사 평균 등장 순위("12.2위" + Δ), 경쟁사 미니 카드 4장.
//    우측 브랜드별 평균 순위 시계열 — **y축 반전**(1위가 위, 디자이너 주석).
// ② 순위 섹션 — 좌측 "순위별 보기" 래더 카드(기본 펼침, 토글로 접기) + 우측 순위 표
//    (브랜드 · 순위 "1위 · 16.9위"+바 · 직전 4회차 스파크라인 · WoW). "경쟁사 선택"은
//    표와 래더를 당사 + 그 브랜드로 좁힌다.
//
// 산식(스펙 SHALL): 답변 내 평균 등장 순위(avg_position)의 회차 평균 — 제목 옆 ⓘ 툴팁.
// 언급이 없는 브랜드는 0위가 아니라 "측정 없음"(null 전파).
//
// 값의 출처: 순위·평균 순위 = 스냅샷(latest), 추이·WoW·히어로 Δ = 회차 집계.
// 히어로 Δ 만 회차 기반인 이유는 firstRankHero 주석 — 직전 스냅샷에 순위 모수가 없다.
//
// 2026-09-02 피그마 1:1(운영 결정): 래더 기본 ON(디자인 프레임이 펼친 상태), 마커는
// 당사 + 선택 경쟁사(미선택 시 최상위 경쟁사 1개), 헤더 30px·행 38px·스크롤.
//
// 2026-09-11 정렬 수정(운영 요청): 표는 **5열**(브랜드·순위·순위 막대·추이·WoW).
// 종전 4열 헤더 아래에 5요소를 그려 막대·스파크가 헤더와 어긋났다 — RANK_COL_CLASS 주석.
// 래더 값 라벨도 브랜드 라벨과 겹쳐 찍혀 좌/우 칸으로 분리했다 — RankLadder 주석.

import { Suspense, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { TrendingDown, TrendingUp } from "lucide-react";
import type { FirstPositionResult } from "@/lib/db/repositories/scope-aggregates";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ColInfo } from "@/components/dash/col-info";
import { KpiChartSlotSkeleton, KpiHeroSkeleton, KpiSectionSkeleton } from "@/components/dash/section-skeleton";
import {
  firstRankCompetitorCards,
  firstRankHero,
  positionText,
  rankLadder,
  rankTableRows,
  rankTrendChart,
  type RankTableRow,
} from "../../_data/kpi-view";
import { brandColor } from "./series-colors";
import { ladderLabelTops } from "./rank-ladder-layout";
import { SparkLine } from "./spark-line";
import { useAwaited, type Awaitable } from "./mention-kpi-tab";
import { RankTrendChart } from "./rank-trend-chart";

const ALL = "__all__";
const SPARK_CYCLES = 4;

/**
 * 순위 표의 **열 정본**(2026-09-11 운영 요청로 4열 → 5열).
 *
 * 종전에는 헤더가 4칸인데 행은 5요소(브랜드 · "1위·18.3위" · 막대 · 스파크 · WoW)였다 —
 * 순위 셀 하나에 텍스트(w-24=96px)와 막대(max 148px)를 같이 넣어 놓고 `<col>` 폭은
 * 233px 을 줬으니, 셀 고유 폭(96+10+148=254px)이 선언 폭을 넘겨 열이 밀렸고
 * 막대는 "순위" 헤더 밖에, 스파크는 "추이" 헤더 왼쪽 가장자리에 걸쳐 찍혔다.
 * (`min-w-[34rem]`=544px 도 고정 열 합 563px 보다 작아 무의미했다.)
 *
 * 규칙: **헤더 th 와 행 td 가 이 배열을 같이 쓴다.** 열 정렬·패딩을 한 곳에서만
 * 정의해야 다시 어긋나지 않는다(렌더 가드 = first-rank-table-columns.render.test).
 * 폭은 `table-fixed` + `<colgroup>` 으로 못 박아 내용이 열을 밀지 못하게 한다.
 */
export const RANK_COL_CLASS = [
  "pl-5 pr-3 text-left", // 브랜드
  "px-3 text-left", // 순위("1위 · 18.3위")
  "px-3 text-left", // 순위 막대(헤더 = "평균 순위")
  "px-3 text-left", // 추이(스파크라인)
  "pl-3 pr-5 text-left", // WoW
] as const;

/** colgroup 폭 — 합(602px) + WoW 최소폭이 표 `min-w`(44rem=704px) 안에 들어간다. */
const RANK_COL_WIDTH = ["w-[150px]", "w-[120px]", "w-[172px]", "w-[160px]", ""] as const;

/** 래더 트랙 높이·라벨 높이(브랜드 1줄 + 서열 1줄) — 라벨 겹침 회피 계산의 입력. */
const LADDER_TRACK_PX = 375;
const LADDER_LABEL_PX = 26;

type TabProps = {
  /** null = 집계 degrade → 지면 전체가 대체 문구(이 탭의 유일한 원천). */
  firstPosition: Awaitable<FirstPositionResult | null>;
  /** 렌더 테스트 seam — 래더 분기. 화면 기본은 **펼침**(피그마 프레임). */
  initialLadder?: boolean;
  initialCompetitor?: string | null;
};

export function FirstRankKpiTab({ firstPosition, initialLadder, initialCompetitor }: TabProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-6">
        <Suspense fallback={<KpiHeroSkeleton />}>
          <RankHero firstPosition={firstPosition} />
        </Suspense>
        <Suspense fallback={<KpiSectionSkeleton />}>
          <RankSection
            firstPosition={firstPosition}
            initialLadder={initialLadder}
            initialCompetitor={initialCompetitor}
          />
        </Suspense>
      </div>
    </TooltipProvider>
  );
}

/** 순위 변화 배지 — 단위 "위", **음수 = 개선**(순위가 앞으로). */
export function RankDelta({
  value,
  size = "sm",
  className,
}: {
  value: number | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi.firstRank");
  if (value == null) return null;
  const improved = value < 0;
  const Icon = improved ? TrendingUp : TrendingDown;
  // 부호 없음 — 글리프가 방향(DeltaBadge 와 같은 규약). 개선 = positive 토큰.
  return (
    <span
      className={cn(
        // whitespace-nowrap — 좁은 칸(히어로 경쟁사 타일)에서 한국어 "1.6위" 가
        // "1.6"/"위" 로 꺾이던 것을 금지한다(QA 2차 #3). 표·히어로도 같은 규약.
        "inline-flex items-center gap-0.5 tabular-nums whitespace-nowrap",
        size === "md" ? "text-sm font-normal" : "text-xs font-medium",
        value === 0 ? "text-muted-foreground" : improved ? "text-positive" : "text-destructive",
        className,
      )}
    >
      <Icon className={size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"} aria-hidden />
      {t("unit", { n: Math.abs(value).toFixed(1) })}
    </span>
  );
}

// ─── ① 히어로 ────────────────────────────────────────────────────────────────
function RankHero({ firstPosition }: Pick<TabProps, "firstPosition">) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const fp = useAwaited(firstPosition);
  const hero = useMemo(() => firstRankHero(fp), [fp]);
  const rows = useMemo(() => rankTableRows(fp, { sparkCycles: SPARK_CYCLES }), [fp]);
  const cards = useMemo(() => firstRankCompetitorCards(rows), [rows]);
  const chart = useMemo(() => rankTrendChart(fp, rows), [fp, rows]);

  return (
    <>
      {/* 피그마 327:1140 히어로: 바깥 p-5·gap-3, 좌열 267px, 스칼라 카드 p-5·최소 123px(다른 탭과 동일). */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 lg:flex-row lg:items-stretch">
        <div className="flex shrink-0 flex-col gap-3 lg:w-[267px]">
          <div className="flex min-h-[123px] flex-col justify-center gap-1.5 rounded-lg border border-border p-5">
            <div className="text-sm font-medium text-muted-foreground">{t("firstRank.title")}</div>
            <div className="flex items-baseline gap-2">
              <span className="text-[34px] leading-none font-semibold tracking-tight tabular-nums">
                {hero.avgPosition == null ? t("firstRank.noRank") : t("firstRank.unit", { n: positionText(hero.avgPosition) })}
              </span>
              <RankDelta value={hero.delta} size="md" />
            </div>
            {/* 순위 답변 모수는 카드가 아니라 우측 차트 툴팁("순위 답변 N개")에서 본다(피그마 1:1). */}
          </div>
          {/* QA 2차 #3 — 좌열은 `lg:w-[267px]` 고정이라 1280·1440 둘 다 같은 폭이다.
              종전: 타일 (267−gap 10)/2 = 128.5px 에 px-5(40) → 콘텐츠 88.5px,
              필요 폭은 "19.9위"(약 47) + gap 4 + Δ(아이콘 12 + gap 2 + "1.6위" 약 28.5
              = 42.5) = 약 94px → 넘쳐서 한국어가 "위" 앞에서 꺾였다.
              현재: gap-2(8) → 타일 129.5px, px-2.5(20) → 콘텐츠 109.5px 이상 94px.
              그래도 안 들어가는 로케일·브랜드는 flex-wrap 이 Δ 를 통째로 내린다. */}
          {cards.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {cards.map((c) => (
                <div key={c.brand} data-rank-competitor-tile className="flex flex-col gap-1 rounded-lg border border-border bg-card px-2.5 py-3.5">
                  <div className="truncate text-[10px] text-muted-foreground">{c.brand}</div>
                  <div className="flex flex-wrap items-end gap-x-1 gap-y-0.5">
                    <span className="text-[15px] leading-none font-semibold tabular-nums whitespace-nowrap">
                      {t("firstRank.unit", { n: positionText(c.avgPosition) })}
                    </span>
                    <RankDelta value={c.wow} />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {fp == null ? (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-4 py-10 text-xs text-muted-foreground">
            {t("degraded")}
          </div>
        ) : (
          <Suspense fallback={<KpiChartSlotSkeleton className="h-52" />}>
            <RankTrendChart data={chart} />
          </Suspense>
        )}
      </div>
      <p className="-mt-4 text-[11px] text-muted-foreground">{t("firstRank.deltaBasis")}</p>
    </>
  );
}

// ─── ② 순위 섹션 ─────────────────────────────────────────────────────────────
function RankSection({
  firstPosition,
  initialLadder = true,
  initialCompetitor = null,
}: TabProps) {
  const t = useTranslations("answerAnalysis.mentions.kpi.firstRank");
  const fp = useAwaited(firstPosition);
  const rows = useMemo(() => rankTableRows(fp, { sparkCycles: SPARK_CYCLES }), [fp]);
  const [ladder, setLadder] = useState(initialLadder);
  const [picked, setPicked] = useState<string | null>(initialCompetitor);
  const competitors = rows.filter((r) => !r.isTracked);
  const visible = useMemo(
    () => (picked == null ? rows : rows.filter((r) => r.isTracked || r.brand === picked)),
    [rows, picked],
  );
  // 래더 마커 = 당사 + 선택 경쟁사(미선택 시 순위 최상위 경쟁사 1개) — 피그마의 2마커 구성.
  const ladderRows = useMemo(() => {
    const own = rows.filter((r) => r.isTracked);
    const comp = picked
      ? rows.filter((r) => r.brand === picked)
      : competitors.filter((r) => r.avgPosition != null).slice(0, 1);
    return [...own, ...comp];
  }, [rows, competitors, picked]);
  const marks = useMemo(() => rankLadder(ladderRows), [ladderRows]);
  // 바 축 — 관측 최대 순위 기준. 순위가 낮을수록(좋을수록) 막대가 길다.
  const worst = Math.max(1, ...rows.map((r) => r.avgPosition ?? 0));
  const cycles = rows[0]?.spark.length ?? SPARK_CYCLES;
  // 추이 스파크라인의 **표 공유 y 축**(2026-09-11 검증자 2차 지적으로 설계 변경).
  //  · 도메인은 **지금 표시하는 행들이 실제로 그리는 값**(과거 회차 포함)에서 나온다
  //    → 축과 값의 모수가 같아, 종전 `worst + 1 - v`(축=최신 스냅샷 / 값=과거 회차)가
  //      만들던 음수·viewBox 이탈이 원천적으로 불가능하다.
  //  · 행마다 자기 범위로 정규화하면 모든 행이 트랙을 꽉 채워 **진폭 비교가 죽는다**
  //    (실브라우저 10행 전부 2~32). 한 축을 공유해야 "누가 더 많이 움직였나"가 보인다.
  const sparkDomain = useMemo<[number, number]>(() => {
    const vs = visible.flatMap((r) => r.spark).filter((v): v is number => v != null);
    return vs.length === 0 ? [0, 0] : [Math.min(...vs), Math.max(...vs)];
  }, [visible]);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-2">
          <h3 className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-foreground">
            {t("title")}
            {/* 산식은 본문이 아니라 ⓘ(운영 결정: 오독 방지용만 본문, 나머지 ⓘ). 스펙 SHALL 은 유지. */}
            <ColInfo title={t("formulaTitle")} definition={t("formula")} />
          </h3>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2.5 text-[13px] font-medium text-foreground">
            {t("table.ladderToggle")}
            <button
              type="button"
              role="switch"
              aria-checked={ladder}
              onClick={() => setLadder((v) => !v)}
              className={cn(
                "relative h-[18px] w-[34px] rounded-full transition-colors",
                ladder ? "bg-brand-700" : "bg-ink-300",
              )}
            >
              <span
                className={cn(
                  "absolute top-[2px] left-[2px] h-3.5 w-3.5 rounded-full bg-card shadow transition-transform",
                  ladder && "translate-x-4",
                )}
              />
            </button>
          </label>
          {competitors.length > 0 ? (
            <Select value={picked ?? undefined} onValueChange={(v) => setPicked(v === ALL ? null : v)}>
              <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("table.competitor")}>
                <SelectValue placeholder={t("table.competitor")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("table.all")}</SelectItem>
                {competitors.map((c) => (
                  <SelectItem key={c.brand} value={c.brand}>
                    {c.brand}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t("table.empty")}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {/* 상위 % 의 분모는 표의 전 브랜드 — 순위 없는 브랜드는 뒤에 선다. */}
          {ladder ? <RankLadder marks={marks} total={rows.length} /> : null}
          <div className="min-w-0 flex-1 overflow-auto max-h-[439px] rounded-[5px] border border-border">
            <table className="w-full min-w-[44rem] table-fixed text-xs">
              <colgroup>
                {RANK_COL_WIDTH.map((w, i) => (
                  <col key={i} className={w || undefined} />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-10 bg-bg-soft">
                <tr className="h-[30px] border-b border-border text-[11px] text-muted-foreground">
                  <th scope="col" className={cn(RANK_COL_CLASS[0], "font-medium")}>{t("table.brand")}</th>
                  <th scope="col" className={cn(RANK_COL_CLASS[1], "font-medium")}>{t("table.rank")}</th>
                  {/* 막대 열 — 헤더를 비우면 막대가 "순위" 칸 오른쪽에 **헤더 없이 떠 있는**
                      것처럼 보인다(운영 피드백 원문). 막대가 그리는 값이 곧 평균 순위이므로
                      이미 있는 `table.avgPosition` 키로 이름을 붙인다. */}
                  <th scope="col" className={cn(RANK_COL_CLASS[2], "font-medium")}>{t("table.avgPosition")}</th>
                  <th scope="col" className={cn(RANK_COL_CLASS[3], "font-medium")}>{t("table.trend", { n: cycles })}</th>
                  <th scope="col" className={cn(RANK_COL_CLASS[4], "font-medium")}>{t("table.wow")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <RankRow key={r.brand} row={r} worst={worst} cycles={cycles} sparkDomain={sparkDomain} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function RankRow({
  row: r,
  worst,
  cycles,
  sparkDomain,
}: {
  row: RankTableRow;
  worst: number;
  cycles: number;
  /** 표 전체가 공유하는 스파크 y 도메인 — RankSection 이 표시 행 전체에서 계산한다. */
  sparkDomain: readonly [number, number];
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi.firstRank");
  const color = brandColor(r.brand, r.isTracked, r.colorIndex);
  // 막대 길이 = 좋을수록 길게. 1위 = 100%, 관측 최악 = 최소 8%.
  const barPct =
    r.avgPosition == null ? 0 : worst <= 1 ? 100 : Math.max(8, 100 - ((r.avgPosition - 1) / (worst - 1)) * 92);
  // 스파크라인 축은 **표가 공유하는 `sparkDomain`** 이다(RankSection). 호출부에서
  // 뒤집던 `worst + 1 - v` 는 제거했다 — `worst` 는 **최신 스냅샷**의 최악 순위라
  // 그보다 나빴던 과거 회차가 음수가 됐고, 그 점이 viewBox 밖으로 나가 잘렸다
  // (verifier 지적). `worst` 는 이제 막대(barPct) 전용이다.
  return (
    <tr className={cn("h-[38px] border-b border-border/60", r.isTracked && "bg-brand-25")}>
      <th
        scope="row"
        title={r.brand}
        className={cn(RANK_COL_CLASS[0], "truncate text-foreground", r.isTracked ? "font-semibold" : "font-normal")}
      >
        {r.brand}
      </th>
      {/* 순위 = "1위 · 16.9위"(서열 · 평균 순위). 값이 글자 중간에서 꺾이지 않게 nowrap. */}
      <td className={cn(RANK_COL_CLASS[1], "tabular-nums whitespace-nowrap")}>
        {r.rank == null ? (
          <span className="text-muted-foreground">{t("noRank")}</span>
        ) : (
          t("table.rankCell", { rank: r.rank, avg: positionText(r.avgPosition) })
        )}
      </td>
      {/* 막대는 **자기 열**에 있다 — 순위 셀에 같이 넣으면 셀 고유 폭이 선언 폭을
          넘겨 뒤 열을 통째로 민다(2026-09-11 결함). */}
      <td className={RANK_COL_CLASS[2]}>
        <span
          className="flex h-[9px] w-full overflow-hidden rounded-full bg-ink-100"
          role="img"
          aria-label={`${r.brand} ${positionText(r.avgPosition)}`}
        >
          <span
            className="h-full rounded-full"
            style={{ width: `${barPct}%`, background: r.isTracked ? "var(--color-brand-700)" : "var(--color-ink-300)" }}
          />
        </span>
      </td>
      <td className={RANK_COL_CLASS[3]}>
        {/* 순위는 **낮을수록 좋다** → `invert`(작은 값이 위). 종전에는 호출부에서
            `worst + 1 - v` 로 뒤집었는데, `worst` 가 최신 스냅샷 기준이라 그보다
            나빴던 과거 회차가 음수가 되어 선이 viewBox 아래로 잘렸다(verifier 지적).
            축은 표 전체가 공유한다(`sparkDomain`) — 행마다 다른 축을 쓰면 모든 행이
            트랙을 꽉 채워 진폭 비교가 죽는다. */}
        <SparkLine
          values={r.spark}
          domain={sparkDomain}
          invert
          color={color}
          label={`${r.brand} ${t("table.trend", { n: cycles })}`}
        />
      </td>
      <td className={RANK_COL_CLASS[4]}>
        {r.wow == null ? <span className="text-muted-foreground">—</span> : <RankDelta value={r.wow} />}
      </td>
    </tr>
  );
}

/**
 * 순위별 보기 — 카드 안 세로 트랙(1위 위) 위에 브랜드 마커.
 *
 * 2026-09-11 수정(운영 요청): 종전에는 **값 라벨을 트랙 오른쪽 별도 칸에 min/max 2개**만
 * 그렸는데, 그 두 값의 y 가 정의상 최상·최하 마커의 y 와 같아서 브랜드 라벨과 정확히
 * 겹쳤다(스크린샷: "Hyundai 1위 상위 10%" 위에 "18.3위"). 게다가 브랜드 라벨이
 * `left-full` 로 트랙 밖으로 흘러 그 칸을 덮었다.
 *   → 값은 **마커마다** 트랙 왼쪽 칸에, 브랜드·서열은 오른쪽 칸에 둔다(열이 다르므로
 *     좌우 겹침은 구조적으로 불가능). 세로 겹침은 `ladderLabelTops` 가 막는다.
 *   → 별도 min/max 축 칸은 제거했다 — 축 양 끝값 = 최상·최하 마커의 값이라 중복이었다
 *     (`rankLadder` 의 offsetPct 도 같은 min/max 로 정규화한다).
 */
function RankLadder({
  marks,
  total,
}: {
  marks: ReturnType<typeof rankLadder>;
  total: number;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi.firstRank");
  const tops = useMemo(
    () =>
      ladderLabelTops(
        marks.map((m) => m.offsetPct),
        { trackPx: LADDER_TRACK_PX, labelPx: LADDER_LABEL_PX },
      ),
    [marks],
  );
  if (marks.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-3 rounded-lg border border-border p-4 lg:w-[271px]" data-rank-ladder>
      <h4 className="text-[13px] font-medium text-foreground">{t("ladderCard")}</h4>
      {/* 좌 값(46px) · gap 8 · 트랙(41px) · gap 8 · 브랜드 라벨(나머지). */}
      <div className="relative" style={{ height: `${LADDER_TRACK_PX}px` }}>
        <div className="absolute inset-y-0 left-[54px] w-[41px] rounded-[5px] bg-bg-subtle" aria-hidden />
        {marks.map((m, i) => (
          <div key={m.brand} data-rank-ladder-mark={m.brand}>
            {/* 마커는 **데이터 위치 그대로**. 미는 것은 라벨뿐이다. */}
            <span
              className="absolute left-[54px] h-[3.5px] w-[41px] rounded-[5px]"
              style={{ top: `calc(${m.offsetPct}% - 2px)`, background: brandColor(m.brand, m.isTracked, m.colorIndex) }}
              aria-hidden
            />
            <span
              data-rank-ladder-value
              className="absolute left-0 flex w-[46px] items-center justify-end text-[10px] tabular-nums text-muted-foreground"
              style={{ top: `${tops[i]}px`, height: `${LADDER_LABEL_PX}px` }}
            >
              {t("unit", { n: positionText(m.avgPosition) })}
            </span>
            <span
              data-rank-ladder-label
              className="absolute right-0 left-[103px] flex flex-col justify-center leading-tight"
              style={{ top: `${tops[i]}px`, height: `${LADDER_LABEL_PX}px` }}
            >
              <span
                className={cn(
                  "truncate text-[11px]",
                  m.isTracked ? "font-semibold text-foreground" : "text-foreground",
                )}
              >
                {m.brand}
              </span>
              <span className="truncate text-[10px] text-muted-foreground">
                {m.rank == null ? null : t("unit", { n: m.rank })}
                {m.isTracked && m.rank != null && total > 0 ? (
                  <span className="ml-1">{t("topPct", { pct: Math.max(1, Math.round((100 * m.rank) / total)) })}</span>
                ) : null}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
