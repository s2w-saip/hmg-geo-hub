import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  answerWhere,
  detailAnswerWhere,
  snapshotRunFilter,
  optionWindowPredicate,
  acrWhere,
  latestAcrPromptRunIds,
  catalogPromptCountWhere,
  mentionBrandDayCountsQuery,
  type TrendWeekKey,
} from "./scope-aggregates";
import { __testables as websiteTestables } from "./website-sites";
import { __testables as cycleTestables } from "./summary-cycles";
import { __testables as compareTestables } from "./summary-period-compare";
import { dateRangeReason } from "@/lib/summary/read/cycle-set";
import { mirrorCumulative } from "@/lib/summary/read/gate";
import { hasPeriod } from "@/lib/summary/read/period-route-flag";
import {
  buildWeeklyTrend,
  weeklyTopNUnion,
  type StandardFilters,
} from "@/lib/scope/result-adapter";

// ─────────────────────────────────────────────────────────────────────────────
// 기간·앵커 산재 코드 통합(A1~A7)의 **값 무변경 잠금장치**.
//
// 이 파일은 계약을 새로 세우지 않는다 — 리팩터 **직전** 상태의 컴파일 SQL 텍스트와
// 파라미터를 통째로 박아 둔다. 통합 커밋마다 이 스냅샷이 **수정 없이** 통과해야
// 하고, 고쳐야만 통과한다면 그 커밋은 값 무변경이 아니다(되돌린다).
//
// 왜 텍스트인가: 이 리포의 기존 관례가 "SQL 텍스트 검증"이다
// (`scope-aggregates.option-window.test.ts`·`website-sites.sql.test.ts` 등).
// 의미론 단언은 무엇이 바뀌었는지 못 잡지만, 텍스트는 공백 한 칸까지 잡는다 —
// `pg_stat_statements` 정규화 텍스트도 공백을 보존하므로 배포 전후 비교가
// 성립하려면 실제로 바이트가 같아야 한다(`trendWeekKey` 머리 주석의 근거와 동일).
//
// 주의: 이 파일은 **DB 에 접속하지 않는다**. 전부 순수 SQL 빌더다.
// ─────────────────────────────────────────────────────────────────────────────

const dialect = new PgDialect();
const compile = (q: SQL) => {
  const { sql: text, params } = dialect.sqlToQuery(q);
  return { text, params };
};

// 대표 필터 조합 — 기간 축이 갈라지는 모든 분기를 한 번씩 밟는다.
const NONE: StandardFilters = {};
const RANGE: StandardFilters = { dateFrom: "2026-08-20", dateTo: "2026-09-04" };
const FROM_ONLY: StandardFilters = { dateFrom: "2026-08-20" };
const TO_ONLY: StandardFilters = { dateTo: "2026-09-04" };
const CUMULATIVE: StandardFilters = { ...RANGE, cumulative: true };
const CUMULATIVE_NO_RANGE: StandardFilters = { cumulative: true };

const ONE_PROJECT = ["11111111-1111-4111-8111-111111111111"];
const TWO_PROJECTS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

const CASES: Array<[string, StandardFilters]> = [
  ["기간 없음", NONE],
  ["dateFrom+dateTo", RANGE],
  ["dateFrom 만", FROM_ONLY],
  ["dateTo 만", TO_ONLY],
  ["cumulative+기간", CUMULATIVE],
  ["cumulative 기간 없음", CUMULATIVE_NO_RANGE],
];

describe("answerWhere — 표준(루트) 표면", () => {
  for (const [name, f] of CASES) {
    it(name, () => expect(compile(answerWhere(f))).toMatchSnapshot());
  }
  it("추이(allRuns) + 기간", () =>
    expect(compile(answerWhere(RANGE, undefined, { allRuns: true }))).toMatchSnapshot());
  it("추이(allRuns) + cumulative — allRuns 가 이긴다", () =>
    expect(
      compile(answerWhere(CUMULATIVE, undefined, { allRuns: true })),
    ).toMatchSnapshot());
});

describe("answerWhere — 프로젝트 컨텍스트", () => {
  for (const [name, f] of CASES) {
    it(`단일 · ${name}`, () =>
      expect(compile(answerWhere(f, ONE_PROJECT))).toMatchSnapshot());
  }
  it("여럿 · dateFrom+dateTo", () =>
    expect(compile(answerWhere(RANGE, TWO_PROJECTS))).toMatchSnapshot());
  it("여럿 · cumulative", () =>
    expect(compile(answerWhere(CUMULATIVE, TWO_PROJECTS))).toMatchSnapshot());
  it("여럿 · 추이(allRuns)", () =>
    expect(
      compile(answerWhere(RANGE, TWO_PROJECTS, { allRuns: true })),
    ).toMatchSnapshot());
});

describe("detailAnswerWhere", () => {
  for (const [name, f] of CASES) {
    it(`루트 · ${name}`, () => expect(compile(detailAnswerWhere(f))).toMatchSnapshot());
  }
  it("프로젝트 · cumulative", () =>
    expect(compile(detailAnswerWhere(CUMULATIVE, ONE_PROJECT))).toMatchSnapshot());
  it("프로젝트 · 추이(allRuns)", () =>
    expect(
      compile(detailAnswerWhere(RANGE, ONE_PROJECT, { allRuns: true })),
    ).toMatchSnapshot());
});

describe("snapshotRunFilter — JS 미러 경로(드릴다운)", () => {
  it("루트 · 기간 없음", () =>
    expect(compile(snapshotRunFilter(undefined, NONE))).toMatchSnapshot());
  it("루트 · cumulative+기간", () =>
    expect(compile(snapshotRunFilter(undefined, CUMULATIVE))).toMatchSnapshot());
  it("프로젝트 · dateFrom+dateTo", () =>
    expect(compile(snapshotRunFilter(ONE_PROJECT, RANGE))).toMatchSnapshot());
  it("프로젝트 · cumulative+기간", () =>
    expect(compile(snapshotRunFilter(ONE_PROJECT, CUMULATIVE))).toMatchSnapshot());
});

describe("optionWindowPredicate — 필터 옵션 창", () => {
  it("기간 없음(기본 7일)", () =>
    expect(compile(optionWindowPredicate())).toMatchSnapshot());
  it("빈 객체", () => expect(compile(optionWindowPredicate({}))).toMatchSnapshot());
  it("dateFrom+dateTo", () =>
    expect(
      compile(optionWindowPredicate({ dateFrom: "2026-08-20", dateTo: "2026-09-04" })),
    ).toMatchSnapshot());
  it("dateFrom 만", () =>
    expect(compile(optionWindowPredicate({ dateFrom: "2026-08-20" }))).toMatchSnapshot());
  it("dateTo 만", () =>
    expect(compile(optionWindowPredicate({ dateTo: "2026-09-04" }))).toMatchSnapshot());
});

describe("acrWhere / latestAcrPromptRunIds — ACR 경로", () => {
  for (const [name, f] of CASES) {
    it(`acrWhere · ${name}`, () => expect(compile(acrWhere(f))).toMatchSnapshot());
  }
  for (const [name, f] of CASES) {
    it(`latestAcrPromptRunIds · ${name}`, () =>
      expect(compile(latestAcrPromptRunIds(f))).toMatchSnapshot());
  }
});

describe("catalogPromptCountWhere — 카탈로그 축", () => {
  it("루트 · 기간 없음", () =>
    expect(compile(catalogPromptCountWhere(NONE))).toMatchSnapshot());
  it("프로젝트 · 기간", () =>
    expect(compile(catalogPromptCountWhere(RANGE, ONE_PROJECT))).toMatchSnapshot());
});

// 주 격자 dedup — `trendWeekKey` 는 DB 프로브를 타므로 그 **산출물 형태**를 직접
// 만들어 넣는다(측정 주 / 원장 회차 주 두 분기 모두).
const WK_MEASURED: TrendWeekKey = {
  join: sql``,
  key: sql`date_trunc('week', a.measured_at)`,
  applied: "measured",
};
const WK_CYCLE: TrendWeekKey = {
  join: sql` LEFT JOIN (
        SELECT cr.run_id, c.cycle_week
        FROM summary_cycle_runs cr JOIN summary_cycles c ON c.cycle_id = cr.cycle_id
      ) _cw ON _cw.run_id = a.run_id`,
  key: sql`COALESCE(_cw.cycle_week, (date_trunc('week', a.measured_at))::date)`,
  applied: "cycle",
};

describe("mentionBrandDayCountsQuery — 셀당 최신 1건(주 버킷)", () => {
  const build = (wk: TrendWeekKey, filters: StandardFilters) =>
    mentionBrandDayCountsQuery({
      filters,
      wk,
      trendFloor: sql`a.measured_at >= now() - interval '120 days'`,
      answerWhere: answerWhere(filters, undefined, { allRuns: true }),
      notHidden: sql`true`,
      seriesClause: sql`true`,
    });
  it("measured 주 격자", () =>
    expect(compile(build(WK_MEASURED, RANGE))).toMatchSnapshot());
  it("cycle 주 격자", () => expect(compile(build(WK_CYCLE, RANGE))).toMatchSnapshot());
});

describe("website 프롬프트 표 — 측정 렌즈와 투영", () => {
  it("렌즈 · 기간 없음", () =>
    expect(compile(websiteTestables.websitePromptLens({}))).toMatchSnapshot());
  it("렌즈 · dateFrom+dateTo", () =>
    expect(
      compile(
        websiteTestables.websitePromptLens({
          dateFrom: "2026-08-20",
          dateTo: "2026-09-04",
        }),
      ),
    ).toMatchSnapshot());
  it("렌즈 · dateFrom 만", () =>
    expect(
      compile(websiteTestables.websitePromptLens({ dateFrom: "2026-08-20" })),
    ).toMatchSnapshot());
  it("렌즈 · dateTo 만", () =>
    expect(
      compile(websiteTestables.websitePromptLens({ dateTo: "2026-09-04" })),
    ).toMatchSnapshot());
  it("투영 + 렌즈 조인", () =>
    expect(
      compile(
        websiteTestables.websitePromptSelect(
          sql`true`,
          websiteTestables.websitePromptLens({
            dateFrom: "2026-08-20",
            dateTo: "2026-09-04",
          }),
        ),
      ),
    ).toMatchSnapshot());
});

describe("원장(summary_cycles) 표면·주 키 식", () => {
  it("surfaceExpr · 루트 있음", () =>
    expect(
      compile(
        cycleTestables.surfaceExpr(
          sql`r.project_id`,
          "33333333-3333-4333-8333-333333333333",
        ),
      ),
    ).toMatchSnapshot());
  it("surfaceExpr · 루트 없음", () =>
    expect(compile(cycleTestables.surfaceExpr(sql`r.project_id`, null))).toMatchSnapshot());
  it("cycleWeekExpr", () =>
    expect(compile(cycleTestables.cycleWeekExpr(sql`c.cycle_anchor_at`))).toMatchSnapshot());
});

// 루트 프로젝트가 **주소 지정 가능한** 경우(라이브) — `rootScope` 가 `true` 가 아니라
// `project_id = $n` 이 되는 분기. mock 기본값에서는 절대 밟히지 않으므로 따로 건다.
describe("루트 주소 지정 가능(SCOPE_MODE=live)", () => {
  const prevMode = process.env.SCOPE_MODE;
  const prevRoot = process.env.SCOPE_ROOT_PROJECT_ID;
  beforeAll(() => {
    process.env.SCOPE_MODE = "live";
    process.env.SCOPE_ROOT_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
  });
  afterAll(() => {
    if (prevMode === undefined) delete process.env.SCOPE_MODE;
    else process.env.SCOPE_MODE = prevMode;
    if (prevRoot === undefined) delete process.env.SCOPE_ROOT_PROJECT_ID;
    else process.env.SCOPE_ROOT_PROJECT_ID = prevRoot;
  });
  for (const [name, f] of CASES) {
    it(`answerWhere · ${name}`, () => expect(compile(answerWhere(f))).toMatchSnapshot());
  }
  it("answerWhere · 추이(allRuns)", () =>
    expect(compile(answerWhere(RANGE, undefined, { allRuns: true }))).toMatchSnapshot());
  it("detailAnswerWhere · cumulative", () =>
    expect(compile(detailAnswerWhere(CUMULATIVE))).toMatchSnapshot());
  it("snapshotRunFilter · cumulative", () =>
    expect(compile(snapshotRunFilter(undefined, CUMULATIVE))).toMatchSnapshot());
  it("acrWhere · 기간 없음", () => expect(compile(acrWhere(NONE))).toMatchSnapshot());
  it("acrWhere · 기간", () => expect(compile(acrWhere(RANGE))).toMatchSnapshot());
  it("acrWhere · cumulative", () =>
    expect(compile(acrWhere(CUMULATIVE))).toMatchSnapshot());
});

// JS 주 월요일 산술(`weekStartUTC`)은 비공개다 — 그것을 쓰는 **공개 함수**의 출력을
// 고정해 간접적으로 잠근다. 경계 표본은 UTC 일 경계(22:35Z)와 주 경계(일/월)다:
// 산술이 로컬 달력으로 새면 이 표본들이 먼저 한 칸 밀린다.
const WEEK_SAMPLES = [
  // 2026-08-30 은 일요일 → 주 시작은 08-24. KST 로 읽으면 08-31(월) → 08-31.
  { date: "2026-08-30T22:35:00Z", key: "a", count: 3 },
  { date: "2026-08-31T01:10:00Z", key: "a", count: 2 },
  { date: "2026-08-31T00:00:00Z", key: "b", count: 7 },
  { date: "2026-09-06T23:59:59Z", key: "a", count: 1 },
  { date: "2026-09-07T00:00:00Z", key: "b", count: 4 },
  { date: null, key: "a", count: 99 },
  { date: "not-a-date", key: "b", count: 99 },
];

describe("JS 주 월요일 산술 — 공개 함수 출력으로 고정", () => {
  it("weeklyTopNUnion", () =>
    expect(weeklyTopNUnion(WEEK_SAMPLES, 2, 10)).toMatchSnapshot());
  it("buildWeeklyTrend", () =>
    expect(buildWeeklyTrend(WEEK_SAMPLES, ["a", "b"])).toMatchSnapshot());
});

describe("기간 비교 리더 — 일자 경계 조각", () => {
  it("dayStart", () =>
    expect(compile(compareTestables.dayStart("2026-08-17"))).toMatchSnapshot());
  it("dayAfter", () =>
    expect(compile(compareTestables.dayAfter("2026-09-13"))).toMatchSnapshot());
  it("anchorDayExpr · 별칭 있음", () =>
    expect(
      compile(compareTestables.anchorDayExpr(sql`c.cycle_anchor_at`)),
    ).toMatchSnapshot());
  it("anchorDayExpr · bare", () =>
    expect(compile(compareTestables.anchorDayExpr(sql`cycle_anchor_at`))).toMatchSnapshot());
});

// `cycle-set.ts::utcDay`(ISO 앞 10자)는 비공개다 — 그것만 쓰는 공개 판정 함수의
// 진리표로 잠근다. 앞 10자 규칙이 Date 파싱으로 바뀌면 오프셋 표기 표본이 먼저 깨진다.
describe("회차 일자 판정 — dateRangeReason 진리표", () => {
  const cyc = (anchor: string) => ({
    cycleId: `c-${anchor}`,
    generationId: `g-${anchor}`,
    projectId: "p",
    cycleAnchorAt: anchor,
    cycleWeek: "2026-08-24",
  });
  it("진리표", () =>
    expect(
      [
        { name: "기간 없음", f: {}, c: [cyc("2026-08-30T22:35:00Z")] },
        {
          name: "회차 1개 · 범위 안",
          f: { dateFrom: "2026-08-24", dateTo: "2026-08-31" },
          c: [cyc("2026-08-30T22:35:00Z")],
        },
        {
          name: "회차 2개 · 날짜 2개",
          f: { dateFrom: "2026-08-24", dateTo: "2026-09-07" },
          c: [cyc("2026-08-30T22:35:00Z"), cyc("2026-09-06T01:00:00Z")],
        },
        {
          name: "범위 밖",
          f: { dateFrom: "2026-09-01", dateTo: "2026-09-07" },
          c: [cyc("2026-08-30T22:35:00Z")],
        },
        {
          name: "오프셋 표기(+09:00) — 앞 10자 규칙",
          f: { dateFrom: "2026-08-31", dateTo: "2026-08-31" },
          c: [cyc("2026-08-31T07:35:00+09:00")],
        },
      ].map((r) => ({
        name: r.name,
        reason: dateRangeReason(r.f, r.c as never),
      })),
    ).toMatchSnapshot());
});

describe("기간 모드 판정 — 현행 진리표", () => {
  const rows = [
    { name: "기간 없음", f: {} },
    { name: "dateFrom 만", f: { dateFrom: "2026-08-20" } },
    { name: "dateTo 만", f: { dateTo: "2026-09-04" } },
    { name: "기간", f: { dateFrom: "2026-08-20", dateTo: "2026-09-04" } },
    { name: "cumulative 만", f: { cumulative: true } },
    {
      name: "cumulative + 기간",
      f: { cumulative: true, dateFrom: "2026-08-20", dateTo: "2026-09-04" },
    },
  ] as const;
  it("hasPeriod / mirrorCumulative", () =>
    expect(
      rows.map((r) => ({
        name: r.name,
        hasPeriod: hasPeriod(r.f),
        mirrorCumulative: mirrorCumulative(r.f),
      })),
    ).toMatchSnapshot());
});
