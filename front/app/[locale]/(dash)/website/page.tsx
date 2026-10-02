import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { hasPeriod } from "@/lib/period/period-mode";
import { showsGeoMap } from "@/lib/auth/scope-policy";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import {
  listMeasuredLanguages,
  listWebsiteCountries,
  listWebsiteScopeMatrix,
} from "@/lib/db/repositories/website-sites";
import { fetchWebsiteAggregates, wasDegraded } from "@/lib/scope/server";
import { AsOfChip, AsOfChipSkeleton } from "@/components/dash/as-of-chip";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import { WebsiteFilters } from "@/components/dash/website-filters";
import {
  SummaryTilesDeferredDeltas,
  type DeferredDeltaMap,
} from "../dashboard/_components/summary-tiles-deferred-deltas";
import { GeoSnapshot } from "../dashboard/_components/geo-snapshot";
import { GeoMapLazy } from "../dashboard/_components/geo-map-lazy";
import { PageHeader } from "@/components/page-header";
import {
  DashboardCompositionSkeleton,
  DashboardGeoSkeleton,
  DashboardSummarySkeleton,
  DashboardTrendSkeleton,
  FilterBarSkeleton,
} from "@/components/dash/section-skeleton";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { countOf, timedRead } from "@/lib/perf/read-timing";
import {
  readBucketParam,
  type BucketUnitParam,
} from "@/components/dash/measurement-basis";
import {
  getLiveWebsiteDashboard,
  getLiveWebsiteTrend,
  getLiveWebsiteGeo,
  getLiveWebsiteComposition,
  getLiveWebsiteSubKpis,
} from "./_data/live";
import { applyEngineConsistency, applyTrendDeltas } from "../dashboard/_data/live";
import { LiveTrendChart } from "../dashboard/_components/live-trend-chart";
import { CompositionPanel } from "../dashboard/_components/composition-panel";
import {
  fetchLatestAnchorDay,
  fetchPeriodCompare,
  fetchSelectableAnchorDates,
} from "@/lib/scope/server";
import { OVERVIEW_COMPARE_METRICS } from "@/components/dash/period-delta-metrics";
import { resolveRequestComparePeriodShape } from "@/lib/period/compare-shape";
import { kstToday } from "@/components/dash/selectable-dates";
import { isAnalysisApi, loadFilterDates, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { fetchPeriodCompareApi } from "@/lib/hgh/adapters/compare";
import { throwForPage } from "@/lib/hgh/errors";
import {
  afterFirstRender,
  loadDashboardAsOf,
  loadEssentialFilterDates,
  orNullOnTransient,
  type DashboardCtx,
} from "@/lib/hgh/adapters/dashboard";

// 원천 스위치(D8, 단위 U5): HGH_SOURCE_G3=api 면 필터바(옵션·달력)·기준일·기간 비교는 새 백엔드
// (lib/hgh/adapters/{filters,compare,dashboard}.ts, surface=website)로, 본문 섹션은 _data/live.ts 의
// 같은 함수들이 원천을 고른다. legacy(기본)는 종전 경로 그대로다. D6: 첫 렌더는 요약·브랜드·달력·옵션
// 4호출이 먼저 나가고, 추이·배지·구성·GEO·기간 비교는 그 뒤에 발행된다.
const websiteApi = () => isAnalysisApi("dashboard", "website");

// 웹사이트 Overview — 표준 통합 대시보드와 동일한 라이브 집계를 재사용하되, 권역별
// 공식 사이트 성격에 맞춘 WebsiteFilters(geography 1차 축 + admin 전용 brand 통합
// 축)로 구동한다. 데이터 소스는 당분간 표준과 공유 — prompt/ 권역 프롬프트 적재 후
// 웹사이트 전용 측정 집계로 교체 예정(scope-gateway 후속).
export default async function WebsiteDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  // 헤더 문구는 웹사이트 전용(오피셜 사이트 인용 현황); 본문 섹션 라벨은 표준
  // dashboard 네임스페이스를 그대로 재사용(동일 라이브 집계 컴포넌트).
  const tw = await getTranslations("website.dashboard");

  // 세션 없음 = 만료(예: 토큰 expiry + Supabase 미연결로 미들웨어 refresh 실패).
  // 표준 /dashboard 와 달리 웹사이트는 GNB 탭 클릭(soft nav)으로만 진입하는데,
  // soft nav 는 공유 (dash) 레이아웃을 재렌더하지 않아 레이아웃의 redirect 가드가
  // 돌지 않는다. 그래서 raw 에러를 던지는 대신 여기서 로그인으로 보낸다(미들웨어/
  // 레이아웃과 동일 동작).
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const showGeo = showsGeoMap(session.user);
  const isAdmin = session.user.role === "admin";
  const sp = await searchParams;
  // 노출 축(WebsiteFilters 의 onlyGroups 와 동일 구성)을 전달 — 숨은 축 URL
  // 파라미터가 데이터만 조용히 좁히는 누수 방지.
  const rawFilters = readStandardFilters(sp, session.user.scope, [
    "geography",
    "language",
    "engine",
    "time",
    ...(isAdmin ? (["brand"] as const) : []),
  ], "website");
  // website geography 축은 website_sites.country_code 기준 (scope_answers.region 아님).
  // readStandardFilters가 ?geography=를 region으로 파싱하므로 websiteCountry로 이식하고
  // region은 제거한다 (website 집계에서 scope_answers.region 필터는 무의미).
  // 기간이 걸리면 **그 기간 회차들의 합**을 보여준다(제품 책임자 2026-09-06).
  //
  // 종전에는 기간이 걸려도 스냅샷("기간 내 **최신 배치**", 2026-07-02 확정)이라
  // 달력을 어떻게 움직여도 그 안에 최신 회차만 들어 있으면 같은 숫자가 나왔다 —
  // 프리셋 주간·월간·연간이 전부 오늘 끝나는 트레일링 창이라 실질적으로 **항상**
  // 그랬다(실측 2026-09-06, 국가=KR: 셋 다 asOf 09-04 · 답변 910 · 언급 11,881).
  //
  // `cumulative` 는 배치 선택 대신 "기간 내 완료된 답변 전체 + measured_at 클리핑"
  // 경로를 탄다 = 회차 합. 실측 검산(국가=KR, 08-08~09-06 누적):
  //   답변 3,459 = 926(9/4) + 1,623(8/28) + 910(8/21)
  //   언급 42,380 = 11,881 + 22,280 + 8,219   → 구간별 합과 정확히 일치.
  //
  // 기간 미지정이면 종전대로 최신 회차 스냅샷이다(기본 화면 불변).
  const filters = {
    ...rawFilters,
    websiteCountry: rawFilters.region,
    region: undefined,
    // 판정 정본 = `lib/period/period-mode.ts::hasPeriod`(같은 식이 네 곳에 있었다).
    cumulative: hasPeriod(rawFilters),
  };
  const bucket = readBucketParam(sp.bucket);

  return (
    <div className="flex animate-fade-in flex-col gap-7">
      <PageHeader title={tw("title")} description={tw("subtitle")} />
      <FilterTransitionProvider>
        {/* 필터 옵션 3쿼리는 직렬 await(JSX props)로 셸 페인트를 막던 것을
            자체 Suspense 경계 + Promise.all 스트리밍으로 이동 (dashboard와 동일
            패턴). 경계는 re-key 하지 않으므로 필터 적용 중엔 기존 바가 유지된다. */}
        <Suspense fallback={<FilterBarSkeleton />}>
          {websiteApi() ? (
            <WebsiteFiltersSectionApi
              scope={session.user.scope}
              isAdmin={isAdmin}
              filters={filters}
              locale={locale}
            />
          ) : (
            <WebsiteFiltersSection
              scope={session.user.scope}
              isAdmin={isAdmin}
              filters={filters}
            />
          )}
        </Suspense>
        <FilterContentDim>
          {/* 본문은 섹션 단위 <Suspense> 로 쪼갠다(dashboard/page.tsx 와 동일 구조).
              2026-09-06 실측: 카드·도넛·서브KPI 는 summary table(사실표) 경로라 0.1~0.3s
              인데 추이 2개(KPI 추이·⑥ 추이)는 아직 미러 경로(admin 무필터 ~25s)라,
              한 Promise.all 에 묶여 있으면 가장 느린 추이가 카드까지 붙잡았다.
              read 프로미스는 여기서 만들어 섹션에 나눠 준다 — 같은 read 를 두 섹션이
              쓰면(대시보드 집계 → 카드·GEO) DB 를 두 번 치지 않게. */}
          <WebsiteDashboardSections
            showGeo={showGeo}
            filters={filters}
            bucket={bucket}
            apiCtx={websiteApi() ? { surface: "website", scope: session.user.scope } : null}
            locale={locale}
          />
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// Filter-bar options — three independent reads, parallel + streamed behind the
// bar's own Suspense boundary so the shell paints without waiting on them.
async function WebsiteFiltersSection({
  scope,
  isAdmin,
  filters,
}: {
  scope: import("@/lib/auth/types").AllowedScope;
  isAdmin: boolean;
  filters: StandardFilters;
}) {
  // 옵션 소스는 데이터 읽기(withWebsite)와 동일하게 브랜드 선택을 반영한 유효
  // 스코프로 좁힌다 — 안 그러면 admin이 브랜드=Hyundai를 골라도 국가/언어
  // 드롭다운에 다른 브랜드만 측정한 국가(예: Kia만 있는 ID)가 남는다.
  const optionScope = narrowScopeBrands(scope, filters.brand);
  const [catalogRows, geographyOptions, languageOptions, optionMatrix] = await Promise.all([
    listCatalogTaxonomy(),
    listWebsiteCountries(optionScope),
    listMeasuredLanguages(optionScope),
    // 옵션 의존 매트릭스 — 국가 draft 가 언어를 **즉시** 좁히도록(적용 대기 없음).
    listWebsiteScopeMatrix(optionScope),
  ]);
  return (
    <>
      <WebsiteFilters
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        languageOptions={languageOptions}
        optionMatrix={optionMatrix}
        isAdmin={isAdmin}
        // 기간 프리셋의 끝점 E — 최신 노출 회차 앵커일(GGMD-107 C2). 스위치 off 면
        // null 이고 프리셋은 오늘 기준 그대로다(종전 동작).
        latestAnchorDay={await fetchLatestAnchorDay("website", filters)}
        // 앵커 축(스펙 §5.1) — 회차가 있는 날짜만 달력에서 활성. 축 off 면
        // undefined 라 달력은 종전대로 전 날짜를 연다.
        // 계열은 이 화면의 카드와 같다 — website 카드도 7 KPI 묶음이라 `'all'`.
        selectableDates={await fetchSelectableAnchorDates("website", filters, "all")}
        // 측정 기준일 — 본문(getLiveWebsiteDashboard)과 **같은 집계의 asOf**.
        // 종전엔 getLatestMeasuredAt — 스코프 프로젝트 raw max이라 국가·언어·엔진
        // 필터와 배치 선택 규칙을 무시해, 같은 필터인데 화면마다 기준일이 달랐다
        // (2026-09-01 표준 대시보드와 동일 결함). 슬롯이라 필터바는 기다리지 않고,
        // 본문과 같은 read 라 요청단위 dedup 으로 DB 왕복은 늘지 않는다.
        asOfSlot={
          <Suspense fallback={<AsOfChipSkeleton />}>
            <AsOfSlot asOf={fetchWebsiteAggregates(filters).then((d) => d?.asOf ?? null)} />
          </Suspense>
        }
      />
      <SectionDoneMarker id="website:filters" />
    </>
  );
}

// api 원천(G3)의 필터바: 옵션·달력은 D6 필수 호출이다(합치기로 각 1회). 좁힘 규칙(적용 브랜드)과
// 모양은 U4 loadPanelOptions(website)가 종전 WS 리더들과 같게 만든다(DC-06 측정 기준 옵션).
async function WebsiteFiltersSectionApi({
  scope,
  isAdmin,
  filters,
  locale,
}: {
  scope: import("@/lib/auth/types").AllowedScope;
  isAdmin: boolean;
  filters: StandardFilters;
  locale: string;
}) {
  const ctx: DashboardCtx = { surface: "website", scope };
  let options: Awaited<ReturnType<typeof loadPanelOptions>>;
  let dates: Awaited<ReturnType<typeof loadFilterDates>> | null;
  try {
    [options, dates] = await Promise.all([
      loadPanelOptions({ surface: "website", scope, filters, dateFrom: filters.dateFrom, dateTo: filters.dateTo }),
      // D6 필수 달력 호출과 같은 보관 프로미스(요청 안 1회, 실패해도 다시 보내지 않는다).
      loadEssentialFilterDates(ctx),
    ]);
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <>
      <WebsiteFilters
        scope={scope}
        catalogRows={options.catalogRows}
        geographyOptions={options.geographyOptions}
        languageOptions={options.languageOptions}
        optionMatrix={options.optionMatrix}
        isAdmin={isAdmin}
        latestAnchorDay={dates?.latestAnchorDay ?? null}
        selectableDates={dates?.selectableDates}
        asOfSlot={
          <Suspense fallback={<AsOfChipSkeleton />}>
            <AsOfSlot
              asOf={orNullOnTransient(loadDashboardAsOf(filters, ctx)).catch((e: unknown) => throwForPage(e, locale))}
            />
          </Suspense>
        }
      />
      <SectionDoneMarker id="website:filters" />
    </>
  );
}

// 프로미스를 여기서만 await 한다 — 이 컴포넌트만 서스펜드하고 필터바는 이미 떠 있다.
async function AsOfSlot({ asOf }: { asOf: Promise<string | null> }) {
  const date = await asOf;
  return (
    <>
      {date ? <AsOfChip date={date} /> : null}
      <SectionDoneMarker id="website:as-of" />
    </>
  );
}

function WebsiteDashboardSections({
  showGeo,
  filters,
  bucket,
  apiCtx,
  locale,
}: {
  showGeo: boolean;
  filters: StandardFilters;
  bucket: BucketUnitParam;
  /** api 원천(G3)의 읽기 문맥, legacy 면 null. */
  apiCtx: DashboardCtx | null;
  locale: string;
}) {
  // await 하지 않는다 — 각 섹션이 자기 것만 await 해서 따로 서스펜드한다.
  // api(G3): 401·403·404 는 페이지 오류 매핑(로그인·no-access·404), 5xx 는 live.ts 가 degrade 로 흡수.
  const live = apiCtx
    ? getLiveWebsiteDashboard(filters).catch((e: unknown) => throwForPage(e, locale))
    : getLiveWebsiteDashboard(filters);
  // `handled` — 이 둘은 이제 요약 섹션이 **즉시 await 하지 않는다**(타일이 먼저 뜨고
  // 배지·Δ 가 뒤따른다). 아무도 안 기다리는 창에서 실패하면 Node 가
  // unhandledRejection 으로 프로세스를 죽이므로 거부 핸들러를 미리 붙인다
  // (dashboard/page.tsx 의 같은 헬퍼와 같은 계약 — 값·거부는 그대로 전파된다).
  //
  // A0(PR④): `website:summary-deltas` 는 이 **둘의 최댓값**이다(아래 요약 섹션의
  // `Promise.all([subKpis, trend])`). 7.0 s 가 누구 것인지 마커로는 안 갈리므로
  // read 당 한 줄을 남긴다 — `timedRead` 는 이미 만들어진 프로미스를 받으므로
  // 발행 시각은 종전과 같다(관측만 추가). `trend` 는 `degradeAware` 가 없어 `null`.
  const subKpis = handled(
    timedRead(
      "summary-deltas/subKpis",
      "websiteSubKpis",
      getLiveWebsiteSubKpis(filters),
      countOf.rows,
    ),
  );
  const trend = handled(
    timedRead(
      "summary-deltas/trend",
      null,
      getLiveWebsiteTrend(filters, bucket),
      countOf.points,
    ),
  );
  const composition = getLiveWebsiteComposition(filters);
  // GEO 는 showGeo 일 때만 집계를 발행한다 — 권한상 안 보이는 계정에서 돌리고 버리던
  // 표준 경로의 낭비(2026-08-28 주석)를 웹사이트에서 처음부터 안 만든다.
  const geo = showGeo ? getLiveWebsiteGeo(filters) : null;
  // 필터 적용/초기화(transition 내비게이션) 때도 섹션별로 갈리게 경계에 필터 키를 준다.
  // key 가 없으면 React 는 transition 중 이미 보이는 내용을 폴백으로 바꾸지 않고 새 트리 전체가
  // 준비될 때까지 기다린다 — 그러면 "재조회 중" 딤이 가장 느린 추이(미러 ~25s)까지 카드를 덮는다.
  // key 가 바뀌면 각 경계가 새로 마운트돼 즉시 스켈레톤을 보이고, 카드는 사실표 속도로 먼저 뜬다.
  // (filter-transition.tsx 의 "key 를 떼서 이전 결과를 딤 상태로 유지" 관례를 이 화면에서는 의도적으로
  // 뒤집는다 — 2026-09-06 제품 책임자: 카드 먼저, 추이는 천천히.)
  const key = JSON.stringify({ filters, bucket });
  return (
    <div className="flex flex-col gap-7">
      <Suspense key={`summary:${key}`} fallback={<DashboardSummarySkeleton />}>
        <WebsiteSummarySection
          live={live}
          subKpis={subKpis}
          trend={trend}
          filters={filters}
          apiCtx={apiCtx}
          locale={locale}
        />
      </Suspense>
      <Suspense key={`trend:${key}`} fallback={<DashboardTrendSkeleton />}>
        <WebsiteTrendSection trend={trend} />
      </Suspense>
      <Suspense key={`composition:${key}`} fallback={<DashboardCompositionSkeleton />}>
        <WebsiteCompositionSection composition={composition} />
      </Suspense>
      {geo ? (
        <Suspense key={`geo:${key}`} fallback={<DashboardGeoSkeleton />}>
          <WebsiteGeoSection live={live} geo={geo} />
        </Suspense>
      ) : null}
    </div>
  );
}

// ① KPI 카드 — 값은 **집계층 속도로 즉시**, 늦게 오는 둘(Δ 칩·엔진 일관성 배지)은
// 타일 안쪽 경계에서 채운다.
//
// ── 왜 이 섹션이 느렸나 (프로덕션 진짜 콜드 실측 2026-09-10, 게이트 ON `6beb6d8`) ──
// `website:summary` 마커가 **11.5~13.5 s**, 같은 페이지의 as-of·구성·GEO 는 0.80~0.88 s.
// 원인은 **추이가 아니다** — Δ 는 이미 `SummaryTilesDeferredDeltas` 안쪽 Suspense 뒤에
// 있었다. 범인은 `Promise.all([live, subKpis])` 의 **두 번째**다:
// `getLiveWebsiteSubKpis` → `fetchWebsiteSubKpis` 의 화면 키가 `S5.mention` 이었고,
// 라이브 `read_screens` = `["S4.dashboard","S1.dashboard","S3.citation","S6.citation"]`
// 라 **allowlist 밖 → `fallback:screen-not-allowed` → 미러**였다(§6-2 가 S5 를 T8 까지
// off 로 둔 그대로). 즉 집계층 타일(0.1~0.3 s)이 미러 Sub-KPI 에 묶여 있었다.
// 지금은 키를 갈랐지만(B6 — 배지는 `S4.subkpi`) **그 키도 off 로 머지**했으므로
// 배지는 여전히 미러다. 이 지연 경계가 없으면 타일이 다시 그것에 묶인다.
//
// 그래서 이 섹션이 **await 하는 것은 `live` 하나**다. Sub-KPI 는 엔진 일관성 배지에만
// 쓰이므로 Δ 와 같은 지연 경계로 내려보낸다(값·산식 무변경 — 도착 시각만 갈라진다).
// 마커도 갈랐다: `website:summary` = 타일 도착, `website:summary-deltas` = 배지·Δ 도착.
async function WebsiteSummarySection({
  live,
  subKpis,
  trend,
  filters,
  apiCtx,
  locale,
}: {
  live: ReturnType<typeof getLiveWebsiteDashboard>;
  subKpis: ReturnType<typeof getLiveWebsiteSubKpis>;
  trend: ReturnType<typeof getLiveWebsiteTrend>;
  filters: StandardFilters;
  apiCtx: DashboardCtx | null;
  locale: string;
}) {
  // 기간 비교 Δ (GGMD-107). 스위치 off·기간 미선택·적용일 이전이면 null = 종전 Δ 그대로.
  //
  // ⚠️ `kind` 를 여기서 고르지 않는다 — **4지면(대시보드·웹사이트·언급·인용)이 같은
  //    함수**로 판정해야 한다. 2026-09-19 프리뷰 실측: 대시보드만 `kind:"window"` 를
  //    박아 두어 같은 URL(`?time=2026-09-01..2026-09-13`)이 대시보드에서는 13일 트레일링
  //    (+8.6pp), 언급 페이지에서는 달력 월 전체 대비(+6.5pp)로 나왔다.
  const shape = await resolveRequestComparePeriodShape(filters.dateFrom, filters.dateTo, {
    area: "dashboard",
    surface: "website",
  });
  const t = await getTranslations("dashboard");
  // degrade 문구는 **글로벌 대시보드와 같은 키**를 쓴다(`dashboard/page.tsx` 의
  // `tKpi("degraded")`). 새 i18n 키를 만들지 않는다.
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  const dash = await live;
  if (!dash) {
    return (
      <>
        {/* 카드가 비는 이유는 두 가지다: "이 필터에 데이터가 없다" 와 "예산에 걸렸다".
            `getLiveWebsiteDashboard` 는 둘 다 `null` 로 내므로 값으로는 못 가른다:
            요청 스코프 표식(`lib/scope/degrade-registry.ts`)이 가른다. 라벨은
            `degradeAware("websiteAggregates")`(server.ts) 가 심는 것과 같은 문자열이다. */}
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-4 py-16 text-sm text-muted-foreground">
          {wasDegraded("websiteAggregates") ? tKpi("degraded") : t("empty")}
        </div>
        <SectionDoneMarker id="website:summary" />
      </>
    );
  }
  const items = dash.kpis;
  // 늦게 오는 둘을 한 맵으로 합친다. 어느 쪽이 실패해도 카드는 안 깨진다 —
  // 배지 없이/Δ 없이 그대로다(칩·배지 숨김). 병합은 `{...k, ...map[k.key]}`.
  const deferred: Promise<DeferredDeltaMap> = Promise.all([
    subKpis.then((sub) => applyEngineConsistency(items, sub.rows)).catch(() => items),
    trend.catch(() => null),
  ])
    .then(([withBadge, tr]) => {
      const merged = tr ? applyTrendDeltas(withBadge, tr) : withBadge;
      return Object.fromEntries(
        merged.map((k) => [
          k.key,
          { delta: k.delta, direction: k.direction, engineConsistency: k.engineConsistency },
        ]),
      ) as DeferredDeltaMap;
    })
    .catch(() => ({}) as DeferredDeltaMap);
  return (
    <section aria-label={t("summary.label")}>
      <SummaryTilesDeferredDeltas
        items={items}
        deltas={deferred}
        // 기간 비교 Δ (GGMD-107 지면 #4). 스위치 off·기간 미선택·적용일 이전이면 null = 종전 Δ 그대로.
        periodCompare={
          apiCtx
            ? await afterFirstRender(filters, apiCtx, () =>
                orNullOnTransient(
                  fetchPeriodCompareApi(filters, { ...apiCtx, kind: shape.kind, metrics: OVERVIEW_COMPARE_METRICS }),
                ),
              ).catch((e: unknown) => throwForPage(e, locale))
            : await fetchPeriodCompare(filters, {
                surface: "website",
                family: "mention",
                // 4지면 공통 판정(`resolveRequestComparePeriodShape`): 위 `shape` 주석 참조.
                kind: shape.kind,
                metrics: OVERVIEW_COMPARE_METRICS,
                ...(shape.months ? { months: shape.months } : {}),
                ...(shape.weeks ? { weeks: shape.weeks } : {}),
              })
        }
        periodDays={shape.days ?? undefined}
        // 라벨·억제 문구가 비교 **종류**를 알아야 한다(검증 W3·W4). `curLo` 는 달력 주에서
        // "이번 주" 와 "지난주" 를 가르는 입력이다.
        periodLabelCtx={{
          kind: shape.kind,
          curLo: shape.weeks?.cur.lo ?? shape.months?.cur.lo ?? filters.dateFrom,
          todayKst: kstToday(),
        }}
      />
      <SectionDoneMarker id="website:summary" />
      {/* 지면이 없는 마커 전용 경계 — **자기 Suspense 가 있어야** 이 await 가 섹션
          전체를 다시 붙잡지 않는다(대시보드 page.tsx 의 같은 패턴). */}
      <Suspense fallback={null}>
        <DeferredArrival wait={deferred}>
          <SectionDoneMarker id="website:summary-deltas" />
        </DeferredArrival>
      </Suspense>
    </section>
  );
}

/** 아직 아무도 await 하지 않는 프로미스에 거부 핸들러를 미리 붙인다. */
function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/** 프로미스가 풀리면 마커를 낸다(대시보드 page.tsx 의 같은 이름 헬퍼와 동일 계약). */
async function DeferredArrival({
  wait,
  children,
}: {
  wait: Promise<unknown>;
  children: React.ReactNode;
}) {
  await wait.catch(() => {});
  return <>{children}</>;
}

async function WebsiteTrendSection({ trend }: { trend: ReturnType<typeof getLiveWebsiteTrend> }) {
  const t = await getTranslations("dashboard");
  const data = await trend;
  return (
    <SectionCard title={t("trend.title")} description={t("trend.description")}>
      {data && data.points.length >= 2 ? (
        <LiveTrendChart trend={data} />
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          {t("trend.accruing")}
        </div>
      )}
      <SectionDoneMarker id="website:trend" />
    </SectionCard>
  );
}

async function WebsiteCompositionSection({
  composition,
}: {
  composition: ReturnType<typeof getLiveWebsiteComposition>;
}) {
  const t = await getTranslations("dashboard");
  const tw = await getTranslations("website.dashboard");
  const c = await composition;
  if (c.sources.length === 0) return <SectionDoneMarker id="website:composition" />;
  return (
    <SectionCard title={t("composition.title")} description={tw("compositionDescription")}>
      <CompositionPanel topics={c.topics} sources={c.sources} showTopics={false} />
      <SectionDoneMarker id="website:composition" />
    </SectionCard>
  );
}

// ④ GEO — 2026-09-10(PR② T5)부터 실제 집계다(종전 정적 빈 객체). 카드(① SUMMARY)와
// **별도 프로미스**라 요약이 GEO 집계를 기다리지 않는다.
async function WebsiteGeoSection({
  live,
  geo,
}: {
  live: ReturnType<typeof getLiveWebsiteDashboard>;
  geo: ReturnType<typeof getLiveWebsiteGeo>;
}) {
  const [dash, g] = await Promise.all([live, geo]);
  if (!dash) return <SectionDoneMarker id="website:geo" />;
  return (
    <div className="flex flex-col gap-4">
      <GeoMapLazy geo={g} />
      <GeoSnapshot geo={g} />
      <SectionDoneMarker id="website:geo" />
    </div>
  );
}
