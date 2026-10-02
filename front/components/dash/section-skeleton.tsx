// Visual-only loading placeholders streamed in via <Suspense> while a route's
// live scope data resolves. Each heavy page renders its static shell (header)
// synchronously and wraps the slow data region in <Suspense fallback={…}> so a
// menu click shows a skeleton IMMEDIATELY — the shared (dash) loading.tsx does
// not re-trigger on sibling navigation (React keeps already-revealed content
// during a transition), so the per-page boundary is what gives instant feedback.
//
// Pure markup: no text (so no i18n) and token-only classes (no hex). Mirrors the
// look of app/[locale]/(dash)/loading.tsx.

// Placeholder blocks are filled `bg-ink-100` and sweep a lighter band across
// themselves. They used to be `bg-card` + animate-pulse — but bg-card is white
// and the page surface is bg-soft (#f6f3f2), so a loading route rendered as a
// grid of empty bordered boxes with an almost imperceptible opacity throb. It
// read as "the page is blank", not "the page is loading". The fill has to be
// darker than the surface, and the motion has to travel.
const BLOCK = "overflow-hidden rounded-lg border border-border bg-ink-100 animate-shimmer";

export function KpiTilesSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`h-24 ${BLOCK}`} />
      ))}
    </div>
  );
}

function PanelSkeleton({ className = "h-72" }: { className?: string }) {
  return <div className={`${className} ${BLOCK}`} />;
}

// The page-level "working" cue. This lives in the skeleton — not on a <Link> —
// because loading.tsx renders for exactly the window the user is waiting on.
//
// (An earlier attempt drove a bar off `useLinkStatus` in the layout instead.
// That cannot work here: the Next docs are explicit that pending is skipped once
// the route is prefetched or has a loading.js, and every (dash) route now has
// both — so the bar never fired. Hence: indicator where the wait actually is.)
// h-1 and at the top of the content region, not hairline-thin under the header
// divider — at h-0.5 it sat directly above the header's border-b and read as
// part of that rule rather than as a moving indicator.
function LoadingBar() {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-ink-100">
      {/* w-2/5 is load-bearing — the keyframes translate by % of THIS element. */}
      <div className="animate-loading-bar h-full w-2/5 rounded-full bg-brand-700" />
    </div>
  );
}

// Page header placeholder — title + subtitle over the same divider PageHeader
// draws, with the loading bar sitting where the content will appear.
function PageHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-2 border-b border-border/70 pb-5">
      <div className="h-7 w-56 max-w-full animate-pulse rounded-md bg-brand-700/15" />
      <div className="h-4 w-80 max-w-full animate-pulse rounded bg-ink-300/35" />
    </div>
  );
}

/** Rough shape of the route being waited on — see PageSkeleton. */
export type PageSkeletonVariant = "dashboard" | "analysis" | "funnel" | "table";

// Whole-route fallback for a segment's `loading.tsx`.
//
// Why per-route loading.tsx at all, when some pages already stream via an
// in-page <Suspense>: that inner boundary only helps once the page component is
// rendering. A page still awaits session + params + its own lookups BEFORE it
// returns any JSX, and every (dash) route is force-dynamic — so that window
// showed nothing at all. This covers it, then the page's real shell replaces it
// and any inner boundary streams the body. The two are complementary.
//
// These live at the LEAF segment on purpose. A boundary only re-shows its
// fallback when its segment is re-keyed, so a shared parent boundary (the
// (dash)/loading.tsx above) stays silent when only a child segment swaps — the
// exact reason sibling menu clicks looked frozen.
//
// `variant` is the page's rough shape, not its exact layout: a skeleton that
// tracks every page pixel-for-pixel becomes a second copy of the UI to maintain.
// Matching the block rhythm is enough to avoid a jarring swap.
export function PageSkeleton({
  variant = "table",
}: {
  variant?: PageSkeletonVariant;
}) {
  return (
    <div className="flex animate-fade-in flex-col gap-6" aria-busy="true" aria-hidden="true">
      <LoadingBar />
      <PageHeaderSkeleton />
      {variant === "dashboard" ? (
        <>
          <KpiTilesSkeleton count={4} />
          <KpiTilesSkeleton count={3} />
          <PanelSkeleton className="h-40" />
          <PanelSkeleton className="h-72" />
        </>
      ) : variant === "analysis" ? (
        <>
          <KpiTilesSkeleton count={4} />
          <PanelSkeleton className="h-96" />
        </>
      ) : variant === "funnel" ? (
        <>
          <KpiTilesSkeleton count={3} />
          <PanelSkeleton className="h-72" />
          <PanelSkeleton className="h-56" />
        </>
      ) : (
        <>
          {/* toolbar / filter row above a list */}
          <PanelSkeleton className="h-11" />
          <PanelSkeleton className="h-96" />
        </>
      )}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

// Body fallback for the answer-analysis (mention / citation) pages — the page
// already rendered <PageHeader>, so this covers only the summary + table region.
export function AnswerAnalysisSkeleton() {
  return (
    <div className="flex animate-fade-in flex-col gap-6" aria-busy="true" aria-hidden="true">
      <KpiTilesSkeleton count={4} />
      <PanelSkeleton className="h-96" />
    </div>
  );
}

// Fallback for the dimension filter bar (Overview / Website) while its option
// queries (catalog taxonomy / measured regions / languages) stream in. Mirrors
// DimensionFilterPanel's outer card (rounded border + px-3 py-2.5) with two
// chip rows so the swap-in causes no layout jump.
export function FilterBarSkeleton() {
  return (
    <div
      // h-full: 답변분석 화면에서 이 스켈레톤은 측정 개요 카드와 **같은 grid 행**의
      // 한 열이다(items-stretch) — 늘어난 행 높이를 그대로 채워야 두 박스가 같다.
      className="flex h-full flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 shadow-soft"
      aria-busy="true"
      aria-hidden="true"
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-8 w-24 animate-pulse rounded-md bg-muted" />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 w-28 animate-pulse rounded-md bg-muted" />
        ))}
      </div>
    </div>
  );
}

// Body fallback for the overview dashboard — KPI tile groups + filter + rankings.
export function DashboardBodySkeleton() {
  return (
    <div className="flex animate-fade-in flex-col gap-7" aria-busy="true" aria-hidden="true">
      <KpiTilesSkeleton count={4} />
      <KpiTilesSkeleton count={3} />
      <PanelSkeleton className="h-40" />
      <PanelSkeleton className="h-72" />
    </div>
  );
}

// ─── 섹션 단위 폴백 (2026-08-27 스트리밍 분할) ────────────────────────────────
// 본문 하나를 통째로 덮던 폴백(DashboardBodySkeleton / AnswerAnalysisSkeleton)을
// 섹션별로 쪼갠 것. 각 섹션이 자기 <Suspense> 를 갖게 되면서, 먼저 도착한 섹션은
// 실물로 그려지고 아직인 섹션만 이 자리표시자가 남는다.
//
// 높이는 실물의 **대략치**다(SectionCard 헤더 + 콘텐츠). 픽셀 단위로 맞추면
// 스켈레톤이 UI 의 두 번째 사본이 되어 유지비가 붙는다 — 블록 리듬만 맞춘다.

/** ① SUMMARY — Core KPI 타일 2행(4 + 3). */
export function DashboardSummarySkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-busy="true" aria-hidden="true">
      <KpiTilesSkeleton count={4} />
      <KpiTilesSkeleton count={3} />
    </div>
  );
}

/** ② 추이 — SectionCard(헤더) + h-72 차트. */
export function DashboardTrendSkeleton() {
  return <PanelSkeleton className="h-[26rem]" />;
}

/** ③ 구성 분석 — SectionCard(헤더) + h-40 도넛 2개. */
export function DashboardCompositionSkeleton() {
  return <PanelSkeleton className="h-72" />;
}

/** ④ GEO — 시장 지도 + 스냅샷 테이블. */
export function DashboardGeoSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-hidden="true">
      <PanelSkeleton className="h-96" />
      <PanelSkeleton className="h-64" />
    </div>
  );
}

// ─── 4-KPI 탭 섹션 폴백 (2026-09-02 섹션별 스트리밍) ─────────────────────────
// 탭 본문을 하나의 Promise.all 로 묶던 것을 섹션별 경계로 쪼갠 뒤의 자리표시자.
// 각 집계의 속도가 다르므로(스냅샷 ~1s · 유형 ~4s · 브랜드추이 ~7s · 엔진 ~11s)
// 먼저 온 섹션은 실물로 그려지고 아직인 섹션만 이 블록이 남는다.

/** 히어로 카드 — 좌측 스칼라(w-72) + 우측 추이. */
export function KpiHeroSkeleton() {
  return <PanelSkeleton className="h-64" />;
}

/** 히어로/유형 섹션 안의 **차트 자리**만 — 카드 테두리는 실물이 이미 그렸다. */
export function KpiChartSlotSkeleton({ className = "h-56" }: { className?: string }) {
  return (
    <div className={`flex-1 ${className} ${BLOCK}`} aria-busy="true" aria-hidden="true" />
  );
}

/** 경쟁사 KPI 테이블 — 헤더 + 도넛 + 행. */
export function KpiCompetitorTableSkeleton() {
  return <PanelSkeleton className="h-80" />;
}

/** AI 엔진별 / 멘션 유형별 섹션 — 좌측 바 + 우측 차트 2단. */
export function KpiSectionSkeleton() {
  return <PanelSkeleton className="h-72" />;
}

// 답변분석(언급 / 인용) **본문** 폴백 — 필터바가 자기 경계로 분리된 뒤의 자리.
// AnswerAnalysisSkeleton 과 블록은 같지만 이름을 나눈 이유: 저건 아직 "필터바
// 포함 본문 전체"를 덮는 화면들(ai-funnel/acr, website/prompts)이 쓴다.
export function AnswerAnalysisBodySkeleton() {
  return (
    <div className="flex animate-fade-in flex-col gap-6" aria-busy="true" aria-hidden="true">
      <KpiTilesSkeleton count={4} />
      <PanelSkeleton className="h-96" />
    </div>
  );
}

// ─── 표준 언급 화면 본문 구획 폴백 (2026-09-03 섹션 스트리밍 분할) ────────────
// 본문 하나를 덮던 AnswerAnalysisBodySkeleton 을 세 구획으로 쪼갠 것. 높이는
// 실물의 대략치다(픽셀 단위로 맞추면 스켈레톤이 UI 의 두 번째 사본이 된다).

/** ① 요약 카드 6장(sm 3열 / lg 6열) + 헤드투헤드 + 감정·유형 카드 2장. */
export function MentionsSummarySkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-hidden="true">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={`h-24 ${BLOCK}`} />
        ))}
      </div>
      <PanelSkeleton className="h-56" />
      <div className="grid gap-3 md:grid-cols-2">
        <PanelSkeleton className="h-56" />
        <PanelSkeleton className="h-56" />
      </div>
    </div>
  );
}

/** ② 추이 — 카드 헤더 + 라인 차트. */
export function MentionsTrendSkeleton() {
  return <PanelSkeleton className="h-[22rem]" />;
}

/** ③ 브랜드 언급 순위표 — 헤더(검색·내보내기) + 표. */
export function MentionsRankSkeleton() {
  return <PanelSkeleton className="h-96" />;
}
