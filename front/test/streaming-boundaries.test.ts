import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 회귀 가드 — "필터 재조회 시 조립된 섹션부터 보이게" 구조가 되돌아가지 않게.
//
// 2026-08-27 이전 상태: 페이지마다 본문 <Suspense> 가 **1개**였고, 그 안의 async
// 컴포넌트 하나가 독립 read 를 Promise.all 로 모은 뒤에야 전 섹션을 그렸다 —
// 가장 느린 read 하나가 화면 전체(필터바 포함)를 붙잡았다. 경계를 다시 하나로
// 합치는 리팩터는 이 파일이 잡는다.
//
// 여기 있는 것은 **구조 단언**이다. dedup 이 실제로 동작하는지(=DB 호출이 1회)는
// 행동 테스트가 따로 본다: app/[locale]/(dash)/dashboard/_data/live.dedupe.test.ts
// 와 lib/request-dedupe.test.ts.

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const DASHBOARD = "app/[locale]/(dash)/dashboard/page.tsx";
const WEBSITE = "app/[locale]/(dash)/website/page.tsx";
const PROJECT_DASHBOARD =
  "app/[locale]/(dash)/projects/[id]/_components/project-dashboard.tsx";
const ANALYSIS_PAGES = [
  "app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx",
  "app/[locale]/(dash)/standard/answer-analysis/citation/page.tsx",
  "app/[locale]/(dash)/website/answer-analysis/mention/page.tsx",
  "app/[locale]/(dash)/website/answer-analysis/citation/page.tsx",
];

const countSuspense = (src: string) => src.match(/<Suspense[\s>]/g)?.length ?? 0;

describe("스트리밍 경계 — 페이지당 <Suspense> 수", () => {
  it("대시보드(Overview): 필터바 1 + 본문 섹션 2 = 3개 이상", () => {
    // 2026-09-02 Overview 개편: 필터바 / ① 5-KPI 카드 / ② 국가별 GEO. 추이·구성 섹션은
    // 카드 스파크라인·상세 탭이 대신한다.
    expect(countSuspense(read(DASHBOARD))).toBeGreaterThanOrEqual(3);
  });

  it("대시보드: 본문을 한 덩어리로 모으던 DashboardBody 가 없다", () => {
    const src = read(DASHBOARD);
    expect(src).not.toMatch(/function DashboardBody\b/);
    for (const section of ["KpiCardsSection", "GeoSection"]) {
      expect(src).toContain(`function ${section}(`);
    }
  });

  it.each(ANALYSIS_PAGES)("%s: 필터바 + 본문 = 2개 이상", (rel) => {
    expect(countSuspense(read(rel))).toBeGreaterThanOrEqual(2);
  });
});

describe("스트리밍 경계 — 섹션이 소유한 read", () => {
  it("대시보드: 무거운 read 가 섹션 밖(공용 Promise.all)으로 다시 올라가지 않았다", () => {
    const src = read(DASHBOARD);
    // 각 read 는 자기 섹션 함수 안에서만 호출된다. 섹션 경계 밖에서 부르면
    // 다시 "다 모일 때까지 빈 화면"이 된다.
    const sections = src.split(/^async function /m);
    const owner = (call: string) =>
      sections.filter((s) => s.includes(call)).map((s) => s.slice(0, s.indexOf("(")));
    // 2026-08-28: ④ GEO 는 전용 페처(getLiveGeo)를 소유한다 — 종전에는 ① 과 같은
    // getLiveDashboard 를 불렀고, 그 안에 GEO 집계가 묶여 있어 **① SUMMARY 가
    // 자기가 안 쓰는 GEO 집계를 기다렸다**. 둘이 다시 한 페처로 합쳐지면 여기서 깨진다.
    expect(owner("getLiveDashboard(")).toEqual(["KpiCardsSection"]);
    expect(owner("getLiveGeo(")).toEqual(["GeoSection"]);
    // 카드의 스파크라인·경쟁사 read 도 카드 섹션이 소유한다(다른 섹션이 기다리지 않는다).
    expect(owner("getLiveTrend(")).toEqual(["KpiCardsSection"]);
    // PR④ B2: 넷의 조립이 읽기 계층으로 내려갔다(`fetchStandardCompetitorSources`).
    // 이 가드가 지키는 것은 "무거운 read 를 **어느 섹션이 기다리는가**" 이고, 그
    // 소유권은 그대로 카드 섹션이다 — 이름만 바뀐다.
    expect(owner("fetchStandardCompetitorSources(")).toEqual(["KpiCardsSection"]);
  });

  it.each(ANALYSIS_PAGES)("%s: 필터바는 옵션 read 만 소유하고 본문과 분리됐다", (rel) => {
    const src = read(rel);
    // 본문은 필터 패널을 **스스로 그리지 않는다** — 필터바는 페이지의 별도 경계다.
    // 뷰 통짜(MentionsView/CitationsView)를 쓰는 표면은 hideFilterPanel 로 끄고,
    // 구획 컴포넌트를 직접 쓰는 표면(표준 언급, 2026-09-03 분할)은 애초에 패널을
    // 그리지 않는 컴포넌트를 쓴다. 어느 쪽이든 본문에 패널이 살아나면 안 된다.
    expect(src).not.toMatch(/<DimensionFilterPanel/); // 주석의 언급은 허용
    // 뷰 통짜(MentionsView/CitationsView)를 쓰는 표면은 hideFilterPanel 로 끄고,
    // 구획·개편 컴포넌트를 직접 쓰는 표면(표준 언급·인용)은 애초에 패널을 그리지
    // 않는 컴포넌트를 쓴다.
    expect(src).toMatch(
      /hideFilterPanel|MentionsSummarySection|MentionsPromptsSection|CitationsStandardView/,
    );
    expect(src).toContain("AnalysisFilterBar");
    // 옵션 read 가 본문 컴포넌트로 돌아가지 않았는지: 필터바 함수가 소유한다.
    const bar = src.slice(src.indexOf("FilterBar({"));
    expect(bar).toContain("listCatalogTaxonomy()");
  });
});

describe("측정 기준일(asOf) — 화면 간 일관성", () => {
  // 2026-09-01 회귀 가드: 대시보드 필터바 배지가 getLatestMeasuredAt(스코프 단위
  // raw max — 국가·엔진 필터와 full-cycle 게이트를 무시)로 되돌아가면, 같은 필터
  // (예: 현대·한국)인데 답변분석(언급/인용)과 기준일이 어긋난다. 실측 당시
  // 전 지역 max = 09-01(CZ) vs KR max = 08-31.
  it("getLatestMeasuredAt(스코프 raw max) 은 어디에서도 부활하지 않는다", () => {
    // 이 함수는 ① 필터를 무시하고 ② 답변/런 status 를 안 봐서 **실패 답변의
    // measured_at 까지** 집었다 (2026-09-01 실측: 웹사이트 프로젝트 completed 최신
    // 08-29 vs failed 최신 08-31 — 화면마다 이틀 차이). 소비자 0 으로 삭제됨.
    for (const rel of [
      "lib/db/repositories/scope-aggregates.ts",
      DASHBOARD,
      WEBSITE,
      PROJECT_DASHBOARD,
      ...ANALYSIS_PAGES,
    ]) {
      expect(read(rel)).not.toMatch(/getLatestMeasuredAt\(/);
    }
  });

  // 2026-09-02 피그마 2행 정합(제품 결정): 글로벌 화면은 기준일을 필터바 행이 아니라
  // Overview 헤더 pill(LastMeasured) / 측정 개요 카드 첫 행에 그린다. 웹사이트·프로젝트
  // 대시보드는 피그마 범위 밖이라 종전 asOfSlot 그대로. 어느 쪽이든 **본문과 같은 집계**.
  it.each([
    [DASHBOARD, "fetchStandardAggregates(filters)", "LastMeasured"],
    [WEBSITE, "fetchWebsiteAggregates(filters)", "asOfSlot"],
    [PROJECT_DASHBOARD, "fetchProjectStandardAggregates(projectId, filters)", "asOfSlot"],
  ])("%s 기준일은 본문과 같은 집계의 asOf 를 쓴다", (rel, call, sink) => {
    const src = read(rel);
    // 호출이 남아 있으면 안 된다(주석의 언급은 허용 — 왜 바꿨는지의 기록이다).
    expect(src).not.toMatch(/getLatestMeasuredAt\(/);
    expect(src).toContain(call);
    expect(src).toContain(sink);
  });

  it("답변분석도 같은 규칙 — 글로벌은 헤더 pill 로, 웹사이트는 필터바 슬롯으로", () => {
    // 2026-09-09 QA 2차 #3(제품 결정): 글로벌 답변분석의 기준일은 측정 개요 카드
    // 첫 행이 아니라 **대시보드 Overview 와 같은 헤더 pill**(LastMeasuredPill)이다.
    // 측정 개요 카드는 기준일을 더 이상 그리지 않는다(#10 으로 필터 박스 우측 이동).
    for (const rel of ANALYSIS_PAGES) {
      const src = read(rel);
      expect(src).not.toMatch(/getLatestMeasuredAt\(/);
      if (rel.includes("/standard/")) {
        // `[^>]*` = 그 JSX 여는 태그 안에서만 본다(파일 뒤쪽 다른 asOf= 에 걸리지 않게).
        expect(src).not.toMatch(/<AnalysisFilterBar[^>]*asOf=/);
        expect(src).not.toMatch(/<MeasurementOverviewCard[^>]*asOf=\{/);
        // api 원천 분기(HGH_SOURCE_G2)가 pill 의 asOf 안에서 삼항으로 갈려도 legacy 쪽은 같은 집계의 fetch*(filters).then 이어야 한다
        expect(src).toMatch(/<LastMeasuredPill\s+asOf=\{[^}]{0,200}?fetch\w+\(filters\)\.then/);
      } else {
        expect(src).toMatch(/asOf=\{fetch\w+\(filters\)\.then/);
      }
    }
  });
});

describe("스트리밍 경계 — 깨지 말아야 할 UX 성질", () => {
  it.each([DASHBOARD, ...ANALYSIS_PAGES])("%s: 어떤 경계도 re-key 하지 않는다", (rel) => {
    // 경계에 key 가 붙으면 필터 적용 시 이전 결과가 스켈레톤으로 플래시하고,
    // 필터바 경계라면 마운트된 바가 날아가 Apply 스피너까지 사라진다.
    expect(read(rel)).not.toMatch(/<Suspense[^>]*\skey=/);
  });
});

describe("요청단위 dedup — 배선", () => {
  it("dedup 저장소는 React cache() 위에 있다 (요청 스코프)", () => {
    const src = read("lib/request-dedupe.ts");
    expect(src).toMatch(/import \{ cache \} from "react"/);
    expect(src).toMatch(/cache\(\(\): Map<string, Promise<unknown>> => new Map\(\)\)/);
  });

  it.each([
    "getLiveDashboard",
    "getLiveTrend",
    "getLiveSubKpis",
    "getLiveTopicComposition",
    "getLiveComposition",
  ])("대시보드 페처 %s 가 requestDeduped 로 감싸져 있다", (name) => {
    const src = read("app/[locale]/(dash)/dashboard/_data/live.ts");
    expect(src).toMatch(
      new RegExp(`export const ${name} = requestDeduped\\(\\s*"${name}",`, "s"),
    );
    // 래핑을 우회하는 export 가 남아 있으면 안 된다.
    expect(src).not.toMatch(new RegExp(`export async function ${name}\\b`));
  });

  it.each([
    "fetchStandardMentions",
    "fetchStandardCitations",
    "fetchWebsiteMentions",
    "fetchWebsiteCitations",
    // 대시보드 필터바(측정 기준일 슬롯)와 본문(SummarySection → getLiveDashboard)이
    // 같은 집계를 부른다 (2026-09-01).
    "fetchStandardAggregates",
    "fetchWebsiteAggregates",
    "fetchProjectStandardAggregates",
    // 2026-09-03 표준 언급 본문 구획 분할 — 구획이 늘어도 DB 왕복이 늘지 않게.
    "fetchStandardSubKpis",
    "fetchStandardSubKpisPrev",
  ])("답변분석 페처 %s 가 requestDeduped 로 감싸져 있다", (name) => {
    // 필터바(측정 기준일 슬롯)와 본문이 같은 read 를 부르므로 필수.
    const src = read("lib/scope/server.ts");
    expect(src).toMatch(new RegExp(`export const ${name} = requestDeduped\\(\\s*"${name}",`, "s"));
    expect(src).not.toMatch(new RegExp(`export async function ${name}\\b`));
  });
});

// ─── 표준 언급 본문 구획 분할 (2026-09-03) ───────────────────────────────────
// 종전: 본문 <Suspense> 1개 안에서 MentionsData 가 언급 집계 + Sub KPI(현재/직전)
// 를 Promise.all 로 모은 뒤에야 지면 전체를 그렸다 — **가장 느린 Sub KPI 하나가
// 추이·순위표까지 붙잡았다**. 다시 한 경계로 합치는 리팩터는 여기서 깨진다.
// dedup 이 실제로 접히는지는 lib/scope/server.mention-sections.dedupe.test.ts.
const STANDARD_MENTION = "app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx";

describe("표준 언급 — 본문 구획 분할", () => {
  it("필터바 1 + 본문 구획 3 = 4개 이상의 경계", () => {
    expect(countSuspense(read(STANDARD_MENTION))).toBeGreaterThanOrEqual(4);
  });

  // 2026-09-02 4-KPI 개편: 표준 언급 화면의 지면은 **KPI 탭 본문 + 공통 하단**이다
  // (요약·추이·순위표 3구획은 website/project 표면이 계속 쓴다 — 아래 마지막 테스트).
  // 지켜야 할 성질은 그대로다: 무거운 read 하나가 다른 지면을 붙잡지 않는다.
  it("KPI 탭 본문과 공통 하단은 서로 다른 경계다", () => {
    const src = read(STANDARD_MENTION);
    for (const section of ["MentionsKpiBody", "MentionsData"]) {
      expect(src).toContain(`function ${section}(`);
    }
  });

  it("전량 Sub KPI 는 어느 구획도 부르지 않는다 — 공통 하단은 언급 집계만 기다린다", () => {
    const src = read(STANDARD_MENTION);
    const sections = src.split(/^async function /m);
    const owner = (call: string) =>
      sections.filter((s) => s.includes(call)).map((s) => s.slice(0, s.indexOf("(")));
    // 전량(Q1~Q5)의 유일한 소비자였던 측정 개요 카드는 2026-09-28 제거됐다. KPI
    // 히어로는 파트를 좁힌 전용 페처(fetchStandardKpiHeroSubKpis*)를 쓰므로 전량을
    // 기다리지 않는다 — 전량을 다시 끌어오는 구획이 생기면 여기서 깨진다.
    expect(owner("fetchStandardSubKpis(")).toEqual([]);
    expect(owner("fetchStandardKpiHeroSubKpis(")).toEqual(["MentionsKpiBody"]);
    // 공통 하단은 언급 집계만 — Sub KPI 를 다시 끌어오면 여기서 깨진다.
    const body = src.slice(src.indexOf("async function MentionsData("));
    expect(body).not.toContain("SubKpis");
    expect(body).toContain("fetchStandardMentions(");
  });

  it("구획 컴포넌트는 각자 렌더 가능하다 — 뷰 통짜에 다시 묶이지 않았다", () => {
    const view = read(
      "app/[locale]/(dash)/standard/answer-analysis/_components/mentions-view.tsx",
    );
    for (const name of [
      "MentionsSummarySection",
      "MentionsTrendSection",
      "MentionsRankSection",
    ]) {
      expect(view).toMatch(new RegExp(`export function ${name}\\(`));
    }
  });
});
