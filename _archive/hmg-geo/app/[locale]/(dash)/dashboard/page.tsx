import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { formatAsOfDate } from "@/lib/as-of-date";
import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  DegradeNotice,
  EXTRAS_LABELS,
  COMPETITOR_LABELS,
} from "./_components/degrade-notice";
// degrade 표식은 `DegradeNotice` 와 **같은 출처**에서 읽는다(재수출 경유) — 두 지면이
// 다른 모듈을 보면 라벨 계약이 조용히 갈린다.
import { wasDegraded } from "@/lib/scope/server";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { showsGeoMap } from "@/lib/auth/scope-policy";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import {
  listMeasuredRegions,
  listMeasuredStandardLanguages,
  listMeasuredScopeMatrix,
  standardCollectionDates,
} from "@/lib/db/repositories/scope-aggregates";
import {
  fetchStandardAggregates,
  fetchStandardCompetitorSources,
} from "@/lib/scope/server";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import { OverviewFilters } from "./_components/overview-filters";
import { OverviewKpiCards } from "./_components/overview-kpi-cards";
import { GeoOverview } from "./_components/geo-overview";
import { PageHeader } from "@/components/page-header";
import {
  DashboardGeoSkeleton,
  DashboardSummarySkeleton,
  FilterBarSkeleton,
} from "@/components/dash/section-skeleton";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";
import type { AllowedScope } from "@/lib/auth/types";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import {
  getLiveDashboard,
  getLiveGeo,
  getLiveTrend,
  applyTrendDeltas,
  deltaTrendFilters,
  DELTA_TREND_BUCKET,
} from "./_data/live";

// 통합 대시보드 Overview.
//   ① SUMMARY — 7 L2 KPI 타일 (① 노출률 ~ ⑦ 유입전환율; 미측정 KPI는 "측정 대기")
//   ② 차원 필터 (geography / engine / promptContext — 라이브 집계에 연결)
//   ③ GEO 스냅샷 (조건부 — HQ 이상 권한만; region/country 스코프는 숨김)
//   ④ 경쟁 가시성 랭킹 (도메인 인용 / 브랜드 언급)
// 추이/상세 테이블은 단일 측정 스냅샷이라 시계열이 없어 생략(런 누적 시 추가).
//
// The dimension filters above the sections write URL params (geography / engine
// / promptContext); readStandardFilters maps them onto the three scope-backed
// axes (shared with the 표준 답변 분석 pages) — the rest are flagged in docs.
// 콜드 로드(미러 캐시 미적중) 시 라이브 집계 병렬 실행이 ~10초대까지 걸릴 수
// 있다(2026-08-27 수정). 이 값은 상한을 **올린 게 아니라 내린 것**이다 —
// 이 프로젝트의 플랫폼 기본 함수 시간제한은 300s(Fluid compute Pro)이고,
// 실측상 미지정 라우트(언급·인용·website)의 타임아웃 메시지는 "Task timed out
// after 300 seconds", 대시보드만 "after 120 seconds"다. 120s 안에 안 끝나는
// 콜드 집계는 어차피 실패로 보는 게 맞아 조기 실패시키는 안전판으로 둔다 —
// 다른 라우트에 "기본값이 짧아서" 같은 이유로 복사하지 말 것.
export const maxDuration = 120;

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");

  const session = await getSession();
  if (!session) throw new UnauthorizedError();

  const showGeo = showsGeoMap(session.user);
  // D4: scope.brands는 URL이 비어있을 때 filter.brand의 기본값으로 자동 주입.
  const sp = await searchParams;
  const filters = readStandardFilters(sp, session.user.scope);

  // The header renders as soon as the filter-bar lookups resolve; the live-scope
  // dashboard streams in behind a Suspense boundary so a menu click shows the
  // skeleton instantly. On a filter apply the boundary is NOT re-keyed, so the
  // previous result stays on screen (dimmed by FilterContentDim) while the
  // narrowed aggregation reloads — the shared FilterTransitionProvider drives
  // both the Apply spinner and the dim.
  return (
    <div className="flex animate-fade-in flex-col gap-7">
      <PageHeader
        title={t("overview.title")}
        description={t("subtitle")}
        className="border-b-0 pb-0"
        // 피그마 611:135 헤더 우측 pill: "주 1회 측정 · 측정 회차 … 기준". 기준일은
        // 답변분석과 같은 집계의 asOf(요청단위 dedup) — 헤더는 기다리지 않고 슬롯만 서스펜드.
        // 문구가 "최근 측정일" 이 아닌 이유: 이 asOf 는 `max(measured_at)` 이 아니라
        // 회차 앵커(`CYCLE_AS_OF_SQL`, scope-aggregates.ts:1305)다 — 회차 꼬리 측정이
        // 다음 날로 넘어가도 화면은 그 회차의 날짜를 말해야 한다(PR① B5).
        actions={
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
            <span>{t("overview.cadence")}</span>
            <span aria-hidden className="h-3 w-px bg-border" />
            <Suspense fallback={<span className="inline-block h-3 w-24 animate-pulse rounded bg-muted" />}>
              <LastMeasured asOf={fetchStandardAggregates(filters).then((d) => d?.asOf ?? null)} />
            </Suspense>
          </div>
        }
      />
      <FilterTransitionProvider>
        {/* Filter bar — directly under the header; the single data driver for
            all content below. Stays mounted while the aggregation reloads.
            Its two option queries (catalog taxonomy + measured regions) used to
            be serial awaits in JSX props OUTSIDE any Suspense boundary — they
            blocked the whole shell's first paint. Streamed in behind its own
            boundary instead: the header + skeletons paint immediately and the
            bar swaps in when the (now parallel) queries land. The boundary is
            not re-keyed, so on a filter apply the mounted bar stays visible. */}
        <Suspense fallback={<FilterBarSkeleton />}>
          <OverviewFiltersSection scope={session.user.scope} filters={filters} />
        </Suspense>
        <FilterContentDim>
          {/* 본문은 섹션 단위 <Suspense> 로 쪼갠다 — 예전에는 DashboardBody 하나가
              독립 read 6개를 Promise.all 로 모은 뒤에야 네 섹션을 한꺼번에 그려,
              **가장 느린 read 하나가 화면 전체를 붙잡았다**. 이제 각 섹션이 자기
              read 만 소유하고 조립되는 대로 순서대로 나타난다.
              중복 계산(herd)은 요청단위 dedup 이 막는다 — ④ GEO 의 getLiveGeo 가
              빈 상태 판정에 getLiveDashboard 를 참조하지만 DB 는 1회다
              (_data/live.ts 하단). ④ 는 showGeo 인 역할에서만 집계를 돈다.
              gap-7 은 페이지 래퍼의 리듬 — FilterContentDim 은 plain <div> 라
              여기서 다시 세워준다(기존 DashboardBody 래퍼가 하던 일). */}
          <div className="flex flex-col gap-7">
            {/* Overview(2026-09-02, 디자인 611:135): 5-KPI 카드 + 국가별 GEO 현황.
                종전 7타일·KPI 추이·구성 분석은 이 화면에서 빠졌다 — 추이는 카드의
                스파크라인·상세 탭이, 구성은 답변분석 인용 화면이 담당한다. */}
            {/* 마커는 KpiCardsSection 이 반환하는 JSX 안에 있다 — 경계의 형제로 두면
                React 19 가 완성된 형제만 자리표시(<template id="P:n">)와 함께 먼저
                내보내, 마커가 셸 시각(0.7 s)을 보고한다(T12 실측). */}
            <Suspense fallback={<DashboardSummarySkeleton />}>
              <KpiCardsSection filters={filters} locale={locale} qs={qsFrom(sp)} />
            </Suspense>
            {showGeo ? (
              <Suspense fallback={<DashboardGeoSkeleton />}>
                <GeoSection filters={filters} />
              </Suspense>
            ) : null}
          </div>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// Filter-bar options — two independent reads, fetched in parallel and streamed
// behind the filter bar's own Suspense boundary (shell paint doesn't wait).
async function OverviewFiltersSection({
  scope,
  filters,
}: {
  scope: AllowedScope;
  filters: StandardFilters;
}) {
  // 브랜드 선택(filters.brand)을 반영한 유효 스코프로 옵션을 좁힌다 — admin이
  // 브랜드를 고르면 그 브랜드로 측정된 국가·언어만 드롭다운에 남는다.
  const optionScope = narrowScopeBrands(scope, filters.brand);
  // 옵션의 측정 창 = 화면의 기간 필터. 데이터와 같은 창을 봐야 죽은 옵션이 안 생긴다.
  const dateRange = { dateFrom: filters.dateFrom, dateTo: filters.dateTo };
  const [catalogRows, geographyOptions, languageOptions, optionMatrix, collection] = await Promise.all([
    listCatalogTaxonomy(),
    listMeasuredRegions(optionScope, undefined, true, dateRange),
    // 언어 축 옵션 (2026-09-03) — 종전 정적 폴백 en/ko/fr 를 실데이터로 교체.
    // 적용된 국가(filters.region)까지 넘겨 국가→언어 캐스케이드를 만든다: 한국만
    // 보는 계정에는 한국에서 측정된 언어만 뜬다. 옵션이 비면 OverviewFilters 가
    // 축 자체를 숨긴다(죽은 필터 방지).
    // 2026-09-04: 국가(filters.region)로 **좁히지 않는다**. 축 노출 여부만 이 목록이
    // 정하고, 실제 드롭다운 내용은 optionMatrix 를 draft 로 좁혀 만든다 — 종전에는
    // 적용된 국가로 좁힌 목록이라 "국가를 고르는 중"에는 직전 적용 기준이 남았다
    // (실측: 태국만 적용된 상태에서 APAC 8개국을 draft 로 채워도 언어는 en·th).
    listMeasuredStandardLanguages(optionScope, undefined, dateRange),
    // 옵션 의존 매트릭스 (브랜드 × 국가 × 언어) — 사용자 선택으로 좁히지 않은 조합표.
    // 패널이 draft 로 좁히므로 "고르는 중"과 "적용 후"가 정의상 같아진다(실측 138행).
    listMeasuredScopeMatrix(optionScope, dateRange),
    // 수집 시작일 — 기간 축 캘린더 min·프리셋 클램프(QA #19·#20). min/max 1행
    // 쿼리라 옵션 read 와 병렬로 붙여도 비용이 사실상 없다. 실패해도 필터바를
    // 깨뜨리지 않는다 — 값이 없으면 캘린더 제한이 없을 뿐이다(종전 동작).
    standardCollectionDates(scope).catch(() => null),
  ]);
  return (
    <>
      <OverviewFilters
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        languageOptions={languageOptions}
        optionMatrix={optionMatrix}
        collectionStartDay={collection?.firstMeasuredAt?.toISOString() ?? null}
        // 측정 기준일은 이 행이 아니라 헤더 pill(LastMeasured)이 그린다 — 2026-09-02
        // 피그마 2행 정합(운영 결정). 같은 집계의 asOf 라 dedup 으로 접힌다.
      />
      <SectionDoneMarker id="dashboard:filters" />
    </>
  );
}

// 측정 기준일(고객요구) — 답변분석(언급/인용)과 **같은 집계의 asOf** 를 쓴다.
// 종전엔 getLatestMeasuredAt — 스코프 단위 raw max — 이라서 국가·엔진 필터와
// full-cycle 게이트를 무시했고, 그래서 같은 필터(예: 현대·한국)인데 대시보드와
// 멘션/인용의 기준일이 달랐다(2026-09-01: 전 지역 max 09-01 CZ vs KR 08-31).
// 2026-09-02 피그마 2행 정합(운영 결정): 필터바 행이 아니라 헤더 pill 에 산다.
// 프로미스를 여기서만 await 한다 — 이 컴포넌트만 서스펜드하고 헤더는 이미 떠 있다.
async function LastMeasured({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const date = await asOf;
  return (
    <>
      <span className="tabular-nums">{date ? t("lastMeasured", { date: formatAsOfDate(date) }) : "—"}</span>
      <SectionDoneMarker id="dashboard:last-measured" />
    </>
  );
}

// ─── 섹션들 (각자 자기 read 만 소유) ─────────────────────────────────────────
// Live scope data for the ROOT/표준 project (env SCOPE_ROOT_PROJECT_ID).
// LIVE-ONLY: no sample fallback — getLiveDashboard 가 null(mock / 측정 없음)이면
// ① SUMMARY 가 EmptyState 를 그리고 나머지 섹션은 **스스로 사라진다**(아래 참조).
//
// 빈 상태 재배치(2026-08-27): 예전엔 `if (!live) return <empty>` 하나가 본문
// 전체를 한 read 로 판정했다. 섹션이 갈라진 지금은 "데이터 없음" 문구의 지면을
// ① 이 소유하고, ②③④ 는 자기 read 가 비면 섹션 자체를 생략한다. 그래서
// 무측정 상태의 화면은 예전과 동일하게 **빈 상태 박스 하나**로 보인다.

// ① 5-KPI 카드 — 카드 **본체**(①~⑤ 값·모수·측정 대기 판정)만 이 경계에서 기다린다.
//
// 종전에는 네 read — getLiveDashboard · Δ 전용 day 롤업 · 주 버킷 추이 · 언급 집계 —
// 를 한 Promise.all 로 모은 뒤에야 카드를 그렸다. 그래서 **가장 느린 read 하나가
// 값까지 붙잡았다**: T12 프리뷰 진짜 콜드 실측에서 셸이 0.87 s 에 떴는데 본문은
// 32.9 s 까지 통째로 비었고, 그 뒤 경쟁사 행이 44.5 s 에 왔다.
//
// E-1(2026-09-10) 이후의 경계 구조 — 값·산식·순서는 무변경, 도착 시각만 갈라진다:
//   dashboard:kpi-cards       ← getLiveDashboard (①~⑤ 값·모수)
//   dashboard:kpi-extras      ← Δ 전용 day 롤업 + 주 버킷 추이 (Δ 배지·스파크라인)
//   dashboard:kpi-competitors ← 언급 집계 + 경쟁사 Δ 3종 (카드 하단 경쟁사 행)
// 뒤의 둘은 카드 안에서 각자 <Suspense> 스켈레톤 자리를 잡고 있다가 채워진다
// (_components/overview-kpi-cards.tsx `OverviewDeferred`).
async function KpiCardsSection({
  filters,
  locale,
  qs,
}: {
  filters: StandardFilters;
  locale: string;
  qs: string;
}) {
  const t = await getTranslations("dashboard");
  // 기존 키 재사용 — 새 i18n 키를 만들지 않는다(문구 정본은 답변분석 언급 탭).
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  // ⚠️ 발행 시점은 종전과 같다 — 모든 read 를 **여기서 한꺼번에** 띄우고, 바뀌는 것은
  // "어느 경계가 무엇을 기다리는가"뿐이다. `await` 뒤로 발행을 미루면 카드 본체는
  // 빨라져도 나머지가 그만큼 통째로 밀린다(로컬 실측 2026-09-10: 경쟁사 행 42→57 s,
  // Δ·스파크 60→74 s). "도착 시각만 바꾼다" 는 발행 시각을 안 바꾼다는 뜻이기도 하다.
  //
  // Δ 의 출처 규칙은 _data/live.ts 가 소유한다(deltaTrendFilters · DELTA_TREND_BUCKET
  // 머리 주석 — 왜 화면 추이와 다른 롤업인지, 통합이 왜 운영 결정인지가 거기 있다).
  // 2026-09-03 #181 이 "Δ 를 화면 추이에서 파생"을 되돌렸으므로, 카드 Δ 는 그대로
  // day 롤업에서 내고 **스파크라인만** 주 버킷 추이를 쓴다(둘은 다른 축이다).
  const livePromise = getLiveDashboard(filters);
  const deltaTrend = handled(getLiveTrend(deltaTrendFilters(filters), DELTA_TREND_BUCKET));
  const weeklyTrend = handled(getLiveTrend(filters, "week"));
  // 경쟁사 행이 쓰는 read 를 한 프로미스로 묶는다(전부 30분 캐시·요청단위 dedup —
  // 답변분석과 공유). 카드 본체도, 스파크라인도 이것을 기다리지 않는다.
  //
  // **묶음의 모양이 화면 키에 달려 있어서** 조립은 읽기 계층이 소유한다
  // (`lib/scope/server.ts::fetchStandardCompetitorSources`): `S1.competitors` 가 꺼져
  // 있으면 종전대로 넷을 한 번에 발행하고, 켜져 있으면 값 read 가 고른 브랜드 이름으로만
  // 회차 축을 읽는 **2단**이 된다. 그 분기를 여기 두면 페이지가 읽기 계층의 캐시 구조를
  // 알아야 한다 — 발행 시점은 종전과 같다(이 줄에서 한 번).
  const competitors = handled(fetchStandardCompetitorSources(filters));
  // 카드 본체가 기다리는 유일한 read.
  const live = await livePromise;
  const deferred = live
    ? {
        deltas: deltaTrend.then((d) => applyTrendDeltas(live.kpis, d)),
        trend: weeklyTrend,
        competitors,
      }
    : null;
  return (
    <>
      {live && deferred ? (
        <section aria-label={t("summary.label")}>
          <OverviewKpiCards kpis={live.kpis} locale={locale} qs={qs} deferred={deferred} />
        </section>
      ) : (
        // 카드가 비는 이유는 **두 가지**다 — "이 필터에 데이터가 없다" 와 "예산에 걸렸다".
        // 값으로는 구분할 수 없어(둘 다 null) 요청 스코프 표식으로 가른다
        // (`lib/scope/degrade-registry.ts` — 추가 조회 없음). 문구는 기존 `kpi.degraded`
        // 재사용이고, 새 i18n 키를 만들지 않는다.
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-4 py-16 text-sm text-muted-foreground">
          {wasDegraded("standardAggregates") ? tKpi("degraded") : t("empty")}
        </div>
      )}
      <SectionDoneMarker id="dashboard:kpi-cards" />
      {deferred ? (
        <>
          {/* 마커 + **degrade 고지**를 함께 내는 경계. 카드 안의 지연 슬롯과 같은
              프로미스를 기다리므로 그 슬롯이 채워지는 시각을 그대로 잰다.
              예산 초과(`degradeAware`)는 값이 `null`/빈 배열로 오므로 화면에서
              "데이터 없음" 과 구분되지 않는다 — `wasDegraded` 로 갈라 지연 문구를 낸다
              (검증 D: 라벨을 만들어 놓고 읽는 지면이 없어 degrade 가 위장됐다). */}
          <Suspense fallback={null}>
            <DeferredArrival wait={Promise.all([deferred.deltas, deferred.trend])}>
              <DegradeNotice labels={EXTRAS_LABELS} title={t("trend.title")} />
              <SectionDoneMarker id="dashboard:kpi-extras" />
            </DeferredArrival>
          </Suspense>
          <Suspense fallback={null}>
            <DeferredArrival wait={deferred.competitors}>
              <DegradeNotice labels={COMPETITOR_LABELS} title={t("summary.label")} />
              <SectionDoneMarker id="dashboard:kpi-competitors" />
            </DeferredArrival>
          </Suspense>
        </>
      ) : null}
    </>
  );
}

// 아직 아무도 await 하지 않는 프로미스에 거부 핸들러를 미리 붙인다 — 그 창(카드 본체가
// 도착하기 전)에 실패하면 Node 가 unhandledRejection 으로 프로세스를 죽인다. 값·거부는
// 그대로 전파되고(같은 프로미스를 돌려준다), 소비처의 에러 처리는 종전과 동일하다.
function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

// 프로미스가 풀리면 children(마커)을 낸다. `catch` 는 마커가 예외를 이 경계 밖으로
// 새로 던지지 않게 하는 것뿐 — 진짜 실패는 그 프로미스를 소비하는 카드 슬롯이 든다.
async function DeferredArrival({
  wait,
  children,
}: {
  wait: Promise<unknown>;
  children: React.ReactNode;
}) {
  await wait.catch(() => null);
  return <>{children}</>;
}

// ④ GEO — 시장별 경쟁 위치. 시장 지도(코로플레스)와 GeoSnapshot 테이블을 같이
// 노출(호출부가 showsGeoMap 으로 게이트). 지도는 측정 국가에 fitExtent 되어
// 권역 담당은 자기 권역으로 자동 줌. 둘 다 동일한 geo 를 읽는다.
// 2026-08-28: 전용 페처(getLiveGeo)로 분리 — ① SUMMARY 가 자기가 안 쓰는 GEO
// 집계를 기다리지 않고, showsGeoMap=false 인 역할에서는 아예 돌지 않는다.
// 빈 상태 판정에 쓰는 getLiveDashboard 는 ① 과 dedup 되어 DB 추가 호출 0.
async function GeoSection({ filters }: { filters: StandardFilters }) {
  const geo = await getLiveGeo(filters);
  // 마커는 빈 상태에서도 낸다 — "이 섹션의 read 가 끝났다"가 이 표식의 뜻이다.
  if (!geo) return <SectionDoneMarker id="dashboard:geo" />;
  return (
    <>
      <GeoOverview geo={geo} />
      <SectionDoneMarker id="dashboard:geo" />
    </>
  );
}

// 현재 필터 파라미터를 카드 상세 링크에 실어 나른다(탭 파라미터 등은 없다).
function qsFrom(sp: Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, one);
  }
  return params.toString();
}
