import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  answerWhere,
  detailAnswerWhere,
  acrWhere,
  latestAcrPromptRunIds,
  mentionBrandDayCountsQuery,
  snapshotRunFilter,
  type TrendWeekKey,
} from "./scope-aggregates";
import { __testables as websiteTestables } from "./website-sites";
import {
  resetAnchorAxisForTests,
  setAnchorAxisForTests,
} from "@/lib/period/anchor-axis-state";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";

// ─────────────────────────────────────────────────────────────────────────────
// 앵커 축이 **켜졌을 때**의 SQL 텍스트 잠금.
//
// 짝이 되는 파일이 `period-axis.snapshot.test.ts` 다 — 그쪽이 **꺼진** 상태의 78건을
// 들고 있고(전환 커밋마다 무수정 통과가 첫 번째 수용 기준), 이 파일이 켜진 상태를 든다.
// 두 파일이 같은 필터 조합을 쓰므로 스냅샷을 나란히 놓으면 "축이 바뀌면 무엇이
// 바뀌는가" 가 diff 로 읽힌다.
//
// 이 파일도 **DB 에 접속하지 않는다** — 판정을 `setAnchorAxisForTests` 로 고정하고
// 순수 빌더만 컴파일한다(계약 §5: 테이블이 아직 어떤 DB 에도 없다).
// ─────────────────────────────────────────────────────────────────────────────

const dialect = new PgDialect();
const compile = (q: SQL) => {
  const { sql: text, params } = dialect.sqlToQuery(q);
  return { text, params };
};

// 대표 필터 조합 — 앵커 축의 분기를 한 번씩 밟는다.
const NONE: StandardFilters = {};
/** 한 회차 = 시작일과 종료일이 같은 날(그 회차 하나만 들어온다). */
const ONE_ROUND: StandardFilters = { dateFrom: "2026-09-04", dateTo: "2026-09-04" };
/** 여러 회차 = 창 안에 회차가 여럿 — 회차마다 대표 1건을 고른 뒤 합산한다. */
const MANY_ROUNDS: StandardFilters = { dateFrom: "2026-08-20", dateTo: "2026-09-04" };
const FROM_ONLY: StandardFilters = { dateFrom: "2026-08-20" };
/** 엔진 선택 — `is_default_engine` 기본 범위가 **빠지고** 사용자 선택이 이긴다. */
const ENGINE_PICKED: StandardFilters = { ...MANY_ROUNDS, engine: ["deepseek"] };
/** 기간 + cumulative 선언 — 앵커 축에서는 선언과 무관하게 같은 회차 집합 모드다. */
const CUMULATIVE: StandardFilters = { ...MANY_ROUNDS, cumulative: true };

const ONE_PROJECT = ["11111111-1111-4111-8111-111111111111"];
const TWO_PROJECTS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

const rawTrue = sql`true`;

/**
 * 함대 게이트(원장이 서빙을 허락한 회차인가)의 **실제 모양**. 프로덕션에서는
 * `anchorLedgerServableSql` 이 이것을 만든다 — 여기서는 DB 를 안 보므로 같은 텍스트를
 * 주입해 스냅샷이 `AND true` 가 아니라 진짜 술어를 들게 한다.
 * 두 텍스트가 같은지는 `scope-answer-anchors.fleet-gate.test.ts` 가 대조한다.
 */
const fleetGate = (alias: string): SQL =>
  sql`(${sql.raw(alias)}.surface = 'project' OR EXISTS (
    SELECT 1 FROM summary_cycles sc
     WHERE sc.cycle_id = ${sql.raw(alias)}.cycle_id
       AND sc.fleet_visible
       AND sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()
       AND sc.active_generation_id IS NOT NULL
  ))`;

beforeEach(() =>
  setAnchorAxisForTests(true, undefined, undefined, {
    ca: fleetGate("ca"),
    ca2: fleetGate("ca2"),
  }),
);
afterEach(() => resetAnchorAxisForTests());

describe("answerWhere(앵커 축 on) — 글로벌(루트) 표면", () => {
  it("기간 없음 — 노출 가능한 최신 회차 하나", () =>
    expect(compile(answerWhere(NONE))).toMatchSnapshot());
  it("한 회차", () => expect(compile(answerWhere(ONE_ROUND))).toMatchSnapshot());
  it("여러 회차", () => expect(compile(answerWhere(MANY_ROUNDS))).toMatchSnapshot());
  it("dateFrom 만", () => expect(compile(answerWhere(FROM_ONLY))).toMatchSnapshot());
  it("엔진 선택", () => expect(compile(answerWhere(ENGINE_PICKED))).toMatchSnapshot());
  it("cumulative 선언 — 여러 회차와 같은 모드", () =>
    expect(compile(answerWhere(CUMULATIVE))).toMatchSnapshot());
  it("추이(allRuns) — 창만 앵커 축, 회차 dedup 은 버킷이 맡는다", () =>
    expect(compile(answerWhere(MANY_ROUNDS, undefined, { allRuns: true }))).toMatchSnapshot());
});

describe("answerWhere(앵커 축 on) — project / website 표면", () => {
  it("project(단일) · 여러 회차", () =>
    expect(compile(answerWhere(MANY_ROUNDS, ONE_PROJECT))).toMatchSnapshot());
  it("website(함대 = 프로젝트 여럿) · 여러 회차", () =>
    expect(compile(answerWhere(MANY_ROUNDS, TWO_PROJECTS))).toMatchSnapshot());
  it("website · 추이(allRuns)", () =>
    expect(
      compile(answerWhere(MANY_ROUNDS, TWO_PROJECTS, { allRuns: true })),
    ).toMatchSnapshot());
  it("project · 기간 없음 — 최신 회차 하나", () =>
    expect(compile(answerWhere(NONE, ONE_PROJECT))).toMatchSnapshot());
  it("website(함대) · 기간 없음 — 함대 전체가 한 날짜를 본다", () =>
    expect(compile(answerWhere(NONE, TWO_PROJECTS))).toMatchSnapshot());
});

describe("website 프롬프트 표(앵커 축 on) — 기간과 '마지막 측정일'이 한 축", () => {
  it("렌즈 · 여러 회차", () =>
    expect(compile(websiteTestables.websitePromptLens(MANY_ROUNDS))).toMatchSnapshot());
  it("렌즈 · 기간 없음 — 노출 게이트만 남는다", () =>
    expect(compile(websiteTestables.websitePromptLens({}))).toMatchSnapshot());
  it("투영 + 렌즈 조인", () =>
    expect(
      compile(
        websiteTestables.websitePromptSelect(
          rawTrue,
          websiteTestables.websitePromptLens(MANY_ROUNDS),
        ),
      ),
    ).toMatchSnapshot());

  it("두 축이 하나로 합쳐졌다 — 기간도 '마지막 측정일'도 round_date", () => {
    const projection = compile(
      websiteTestables.websitePromptSelect(
        rawTrue,
        websiteTestables.websitePromptLens(MANY_ROUNDS),
      ),
    ).text;
    expect(projection).toContain(
      "to_char(max(ca.round_date), 'YYYY-MM-DD') AS last_measured_at",
    );
    expect(projection).toContain("ca.round_date >= $");
    // 종전의 두 번째 축(run 앵커 폴백)은 SQL 에서 사라져야 한다 — 주석에는 남는다.
    expect(projection).not.toContain("max(COALESCE(r.cycle_anchor_at, a.measured_at))");
  });
});

describe("detailAnswerWhere(앵커 축 on) — 상세·누적 경로", () => {
  it("기간 없음 — 최신 회차 하나", () =>
    expect(compile(detailAnswerWhere(NONE))).toMatchSnapshot());
  it("여러 회차", () => expect(compile(detailAnswerWhere(MANY_ROUNDS))).toMatchSnapshot());
  it("cumulative + 기간 — run 앵커 창이 아니라 round_date", () =>
    expect(compile(detailAnswerWhere(CUMULATIVE))).toMatchSnapshot());
  it("추이(allRuns) + 기간 — 행 클리핑 대신 round_date", () =>
    expect(
      compile(detailAnswerWhere(MANY_ROUNDS, undefined, { allRuns: true })),
    ).toMatchSnapshot());
  it("project · cumulative + 기간", () =>
    expect(compile(detailAnswerWhere(CUMULATIVE, ONE_PROJECT))).toMatchSnapshot());

  it("누적에서 cycle_anchor_at 폴백 창(cumulativeRunWindow)이 사라진다", () => {
    const t = compile(detailAnswerWhere(CUMULATIVE)).text;
    expect(t).toContain("ca.round_date");
    expect(t).not.toContain("cycle_anchor_at IS NOT NULL");
    expect(t).not.toContain("cycle_anchor_at IS NULL");
  });

  it("추이에서 measured_at 행 클리핑이 사라진다", () => {
    const t = compile(detailAnswerWhere(MANY_ROUNDS, undefined, { allRuns: true })).text;
    expect(t).toContain("ca.round_date");
    expect(t).not.toMatch(/a\.measured_at >= \$\d+::date/);
  });
});

describe("snapshotRunFilter(앵커 축 on) — JS 드릴다운의 답변셋", () => {
  it("루트 · 기간 없음", () =>
    expect(compile(snapshotRunFilter(undefined, NONE))).toMatchSnapshot());
  it("프로젝트 · 여러 회차", () =>
    expect(compile(snapshotRunFilter(ONE_PROJECT, MANY_ROUNDS))).toMatchSnapshot());

  // 카드(answerWhere)와 드릴다운(snapshotRunFilter)이 **같은 회차**를 봐야 한다.
  it("카드와 같은 dedup 키·대표 규칙을 쓴다", () => {
    const t = compile(snapshotRunFilter(ONE_PROJECT, NONE)).text;
    expect(t).toContain("DISTINCT ON (ca.round_date, a.prompt_id, a.target, a.region)");
    expect(t).toContain("ca.measured_at_orig DESC");
    expect(t).toContain("ca.round_date = (SELECT max(ca2.round_date)");
  });
});

describe("추이 버킷·dedup(앵커 축 on)", () => {
  // `trendWeekKey` 는 DB 프로브를 타므로 그 **산출물 형태**를 직접 만들어 넣는다.
  const WK_ANCHOR: TrendWeekKey = {
    join: sql` JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id`,
    key: sql.raw("ca.anchor_week"),
    applied: "anchor",
  };
  const build = (wk: TrendWeekKey) =>
    mentionBrandDayCountsQuery({
      filters: MANY_ROUNDS,
      wk,
      trendFloor: sql`a.measured_at >= now() - interval '120 days'`,
      answerWhere: sql`true`,
      notHidden: sql`true`,
      seriesClause: sql`true`,
    });

  it("언급 브랜드 일별 — 주 버킷은 anchor_week, dedup 은 회차", () =>
    expect(compile(build(WK_ANCHOR))).toMatchSnapshot());

  it("버킷(주)보다 dedup 키(회차)가 잘다", () => {
    const t = compile(build(WK_ANCHOR)).text;
    // 버킷은 주, DISTINCT ON 선두는 회차 — 한 주에 회차가 둘이면 합산되고,
    // 앞 회차가 뒤 회차에 밀려 소멸하지 않는다.
    expect(t).toContain("ca.anchor_week AS wk");
    expect(t).toContain("DISTINCT ON (ca.round_date, a.prompt_id, a.target, a.region)");
    expect(t).toContain("ca.measured_at_orig DESC");
    expect(t).not.toContain("date_trunc");
  });
});

describe("ACR(앵커 축 on) — job_id 가 없어 run 축으로 붙는다", () => {
  it("acrWhere · 기간 없음", () => expect(compile(acrWhere(NONE))).toMatchSnapshot());
  it("acrWhere · 여러 회차", () =>
    expect(compile(acrWhere(MANY_ROUNDS))).toMatchSnapshot());
  it("latestAcrPromptRunIds · 기간 없음", () =>
    expect(compile(latestAcrPromptRunIds(NONE))).toMatchSnapshot());

  it("run 축 semi-join 이고 cumulativeRunWindow 가 아니다", () => {
    const t = compile(acrWhere(MANY_ROUNDS)).text;
    expect(t).toContain("x.run_id IN (SELECT ca.run_id FROM scope_answer_cycle_anchors ca");
    expect(t).toContain("ca.round_date >= $");
    expect(t).not.toContain("cycle_anchor_at IS NULL");
  });

  it("기간이 없으면 최신 회차 하나", () => {
    expect(compile(acrWhere(NONE)).text).toContain(
      "ca.round_date = (SELECT max(ca2.round_date)",
    );
  });

  // 기본 엔진 범위는 **답변 단위**라 run 축에 넣으면 의미가 없다(run 에 기본 엔진
  // 답변이 하나라도 있으면 참). 넣지 않은 것이 의도다.
  it("run 축에는 is_default_engine 을 걸지 않는다", () => {
    expect(compile(acrWhere(NONE)).text).not.toContain("ca.is_default_engine");
  });
});

// 스냅샷은 "무엇이 나왔는가" 를 박을 뿐 "왜 맞는가" 를 말하지 않는다. 계약 §3 의
// 규칙마다 직접 단언을 하나씩 둔다 — 스냅샷을 갱신하며 규칙을 잃는 것을 막는다.
describe("계약 §3 의 규칙별 단언", () => {
  const textOf = (f: StandardFilters, ctx?: string[]) => compile(answerWhere(f, ctx)).text;

  it("기간 키는 round_date 다 — anchor_date 는 어디에도 없다", () => {
    const t = textOf(MANY_ROUNDS);
    expect(t).toContain("ca.round_date");
    expect(t).not.toContain("ca.anchor_date");
  });

  it("회차는 양 끝 포함 — 상한이 `< (…+ 1)` 이 아니다", () => {
    const t = textOf(MANY_ROUNDS);
    expect(t).toContain("ca.round_date <= $");
    expect(t).not.toMatch(/ca\.round_date < \(/);
  });

  it("회차마다 셀당 대표 1건 — DISTINCT ON 선두가 회차 키, 동점은 measured_at_orig", () => {
    const t = textOf(MANY_ROUNDS);
    expect(t).toContain(
      "DISTINCT ON (ca.round_date, a.prompt_id, a.target, a.region)",
    );
    expect(t).toContain("ca.measured_at_orig DESC");
  });

  it("노출 시간 게이트가 함께 걸린다", () => {
    expect(textOf(MANY_ROUNDS)).toContain("ca.view_anchor_date <= hmg_anchor_today()");
  });

  it("엔진 필터가 비면 기본 엔진 범위, 고르면 그 선택이 이긴다", () => {
    expect(textOf(MANY_ROUNDS)).toContain("ca.is_default_engine");
    const picked = textOf(ENGINE_PICKED);
    expect(picked).not.toContain("ca.is_default_engine");
    expect(picked).toContain("a.target IN (");
  });

  it("앵커 축은 세션 TZ 의존 date_trunc 를 기간 경로에 쓰지 않는다", () => {
    expect(textOf(MANY_ROUNDS)).not.toContain("date_trunc");
  });

  it("기간을 앵커로 걸었으면 measured_at 으로 또 자르지 않는다", () => {
    const trend = compile(answerWhere(MANY_ROUNDS, undefined, { allRuns: true })).text;
    expect(trend).toContain("ca.round_date");
    expect(trend).not.toMatch(/a\.measured_at >= \$\d+::date/);
  });

  it("상관 서브쿼리가 아니다 — 앵커 절이 바깥 별칭을 참조하지 않는다", () => {
    // 스냅샷 경로는 기간 술어가 dedup 서브쿼리 안에 있어 semi-join 을 안 낸다 —
    // semi-join 형태가 나오는 것은 추이(allRuns) 경로다.
    const t = compile(answerWhere(MANY_ROUNDS, undefined, { allRuns: true })).text;
    // semi-join 안쪽(`SELECT ca.job_id FROM … WHERE …`)에 `a.` 참조가 없어야 한다.
    const m = /IN \(SELECT ca\.job_id FROM scope_answer_cycle_anchors ca WHERE ([^)]*)/i.exec(t);
    expect(m, "앵커 semi-join 을 찾지 못했다").not.toBeNull();
    // `ca.` 의 `a.` 에 걸리지 않게 앞 글자를 본다 — 바깥 답변 별칭은 `a.` 하나뿐이다.
    expect(m![1], `상관 참조: ${m![1]}`).not.toMatch(/(^|[^c])a\./);
  });

  // ── 기간 미지정 기본 화면 = 노출 가능한 최신 회차 하나 (제품 결정 2026-09-20)
  it("기간이 없으면 최신 round_date 한 회차로 좁힌다", () => {
    const t = textOf(NONE);
    expect(t).toContain("ca.round_date = (SELECT max(ca2.round_date)");
    // 표면 단위 **단일 날짜** — 프로젝트별로 나누지 않는다(GROUP BY 없음).
    expect(t).not.toMatch(/GROUP BY\s+ca2\./i);
  });

  it("최신 회차를 고르는 서브쿼리에도 노출 게이트가 걸린다", () => {
    const t = textOf(NONE);
    // 안 걸면 아직 안 열린 회차가 기준으로 뽑혀 화면이 통째로 빈다.
    expect(t).toContain("ca2.view_anchor_date IS NOT NULL");
    expect(t).toContain("ca2.view_anchor_date <= hmg_anchor_today()");
  });

  it("최신 회차 서브쿼리는 비상관이다 — 바깥 별칭을 참조하지 않는다", () => {
    const inner = /SELECT max\(ca2\.round_date\) FROM scope_answer_cycle_anchors ca2 WHERE ([^)]*)/.exec(
      textOf(NONE),
    );
    expect(inner, "최신 회차 서브쿼리를 찾지 못했다").not.toBeNull();
    expect(inner![1], `상관 참조: ${inner![1]}`).not.toMatch(/(^|[^c])a\./);
  });

  it("범위는 표면별로 다르다 — 루트는 표면/루트 id, 프로젝트는 project_id 목록", () => {
    // mock 기본값에서는 루트 id 가 주소 지정 불가라 표면으로 좁힌다.
    expect(textOf(NONE)).toContain("ca2.surface = 'standard'");
    expect(textOf(NONE, ONE_PROJECT)).toContain("ca2.project_id = ANY(");
  });

  // ── B1 회귀: 축이 대체하는 것은 full-cycle 게이트뿐이다 ────────────────────
  //
  // 축 on 의 루트 분기가 `rootFullCycleAnswerIds` 를 우회하면서, 그 안에 같이 있던
  // **지역 스코핑 술어 2종**까지 사라졌던 적이 있다. 그 둘은 2026-08-20 사고
  // (한국어 프롬프트 208/208 전량 탈락) 대응으로 들어온 것이고, 빠지면 "한국어
  // 프롬프트가 비-KR 시장에서 측정된 답변"과 "태깅 밖 시장 답변"이 표준 집계 분모와
  // 언급·인용 분자에 복귀한다(2026-08-30 실측 겹침 28,371 · 신 술어 단독 1,216).
  it("루트 · 한국어 비-KR 제외가 축 on 에도 남는다", () => {
    for (const f of [NONE, ONE_ROUND, MANY_ROUNDS, FROM_ONLY]) {
      const t = textOf(f);
      expect(t, "한국어 제외 술어").toContain("a.region <> 'KR'");
      expect(t).toContain("FROM scope_prompts sp WHERE sp.text ~ '[가-힣]'");
    }
  });

  it("프로젝트·웹사이트 표면에는 루트 전용 술어가 붙지 않는다", () => {
    // 그 표면들은 종전에도 `rootFullCycleAnswerIds` 를 타지 않았다.
    expect(textOf(MANY_ROUNDS, ONE_PROJECT)).not.toContain("a.region <> 'KR'");
    expect(textOf(MANY_ROUNDS, TWO_PROJECTS)).not.toContain("a.region <> 'KR'");
  });

  // 스냅샷 모드(기간 미지정)에서만 이 경로가 회차 선택 서브쿼리를 탄다 — 기간을 걸면
  // 누적 모드라 dedup 자체가 없고, 그 분기는 축 off 에서도 루트 술어를 안 갖는다.
  it("snapshotRunFilter(루트·스냅샷)도 같은 술어를 쓴다 — 카드와 드릴다운이 갈리지 않게", () => {
    const t = compile(snapshotRunFilter(undefined, NONE)).text;
    expect(t).toContain("a.region <> 'KR'");
    expect(t).toContain("FROM scope_prompts sp WHERE sp.text ~ '[가-힣]'");
    // 이 경로는 바깥에 숨김 지역 술어가 없다 — 여기서 걸려야 한다(목록이 있을 때만 —
    // 2026-09-28 ID 해제, hmg-geo PR #302 로 목록이 비면 절 자체가 없다).
    if (HIDDEN_STANDARD_REGIONS.length) expect(t).toContain("a.region NOT IN (");
    else expect(t).not.toContain("a.region NOT IN (");
  });

  it("축이 꺼지면 종전 텍스트다 — 같은 필터로 두 축의 SQL 이 다르다", () => {
    const on = textOf(MANY_ROUNDS);
    setAnchorAxisForTests(false);
    const off = textOf(MANY_ROUNDS);
    expect(off).not.toBe(on);
    expect(off).not.toContain("scope_answer_cycle_anchors");
    expect(off).toContain("COALESCE(r.cycle_anchor_at, r.started_at)");
  });
});

// ── C: 대표 선택이 SQL·JS 두 경로에서 **같은 답**을 내는가 ─────────────────────
describe("대표 선택 — 카드(SQL)와 드릴다운(JS)이 같은 규칙", () => {
  beforeEach(() =>
    setAnchorAxisForTests(true, undefined, undefined, {
      ca: fleetGate("ca"),
      ca2: fleetGate("ca2"),
    }),
  );
  const cardSql = (f: StandardFilters) => compile(answerWhere(f)).text;

  it("SQL ORDER BY 가 job_id 까지 내려간다 — 임의 행 선택을 막는다", () => {
    for (const f of [NONE, ONE_ROUND, MANY_ROUNDS]) {
      const t = cardSql(f);
      expect(t).toContain("ORDER BY ca.round_date, a.prompt_id, a.target, a.region, ca.measured_at_orig DESC, a.job_id DESC");
    }
  });

  it("DISTINCT ON 과 ORDER BY 의 접두가 일치한다(PostgreSQL 런타임 제약)", () => {
    const t = cardSql(MANY_ROUNDS);
    const m = /DISTINCT ON \(([^)]*)\) a\.job_id[\s\S]*?ORDER BY ([^\n]*)/.exec(t);
    expect(m, "DISTINCT ON / ORDER BY 쌍을 찾지 못했다").not.toBeNull();
    expect(m![2].startsWith(m![1])).toBe(true);
  });

  it("JS 경로의 모집단이 카드와 같은 서브쿼리다 — 기간이 걸려도", () => {
    // 축 off 의 누적 분기(detailAllRunsWindowPreds)에는 run 상태 술어가 없어
    // 카드와 모집단이 갈린다. 축 on 에서는 두 경로가 같은 서브쿼리를 써야 한다.
    const drill = compile(snapshotRunFilter(undefined, MANY_ROUNDS)).text;
    expect(drill).toContain("r.status IN ('completed', 'partial_failed')");
    expect(drill).toContain("ca.round_date");
    expect(drill).toContain("ORDER BY ca.round_date, a.prompt_id, a.target, a.region, ca.measured_at_orig DESC, a.job_id DESC");
  });

  it("축 off 의 누적 분기는 종전 그대로다", () => {
    setAnchorAxisForTests(false);
    const drill = compile(snapshotRunFilter(undefined, { ...MANY_ROUNDS, cumulative: true })).text;
    expect(drill).not.toContain("scope_answer_cycle_anchors");
  });
});

// ── D: 노출 게이트 세 축이 **데이터 술어에도** 나란히 선다 ──────────────────
describe("노출 게이트 — 답변 경로 바깥 술어에도 숨김이 걸린다", () => {
  beforeEach(() =>
    setAnchorAxisForTests(true, { ca: sql.raw("NOT_HIDDEN_CA"), ca2: sql.raw("NOT_HIDDEN_CA2") }),
  );

  it("기간 경로 — 시간 게이트와 숨김 게이트가 함께", () => {
    const t = compile(answerWhere(MANY_ROUNDS)).text;
    expect(t).toContain("ca.view_anchor_date <= hmg_anchor_today()");
    expect(t).toContain("NOT_HIDDEN_CA");
  });

  it("기간 미지정 경로 — 최신 회차 선택과 바깥 술어 둘 다", () => {
    const t = compile(answerWhere(NONE)).text;
    // 최신 회차를 고르는 서브쿼리 안(ca2)과 바깥 술어(ca) 둘 다 걸려야 한다.
    expect(t).toContain("NOT_HIDDEN_CA2");
    expect(t).toContain("NOT_HIDDEN_CA");
  });

  it("드릴다운(JS 모집단)에도 같은 게이트가 있다", () => {
    const t = compile(snapshotRunFilter(ONE_PROJECT, MANY_ROUNDS)).text;
    expect(t).toContain("NOT_HIDDEN_CA");
  });

  it("미러 진행 게이트(③)는 그대로 남는다 — 셋이 나란히 AND 다", () => {
    const t = compile(answerWhere(MANY_ROUNDS)).text;
    expect(t).toContain("NOT_HIDDEN_CA");
    expect(t).toContain("ca.view_anchor_date IS NOT NULL");
  });

  it("축이 꺼지면 숨김 조각이 붙지 않는다", () => {
    setAnchorAxisForTests(false);
    expect(compile(answerWhere(MANY_ROUNDS)).text).not.toContain("NOT_HIDDEN_CA");
  });
});

// ── D 후속: 숨김 게이트의 **지표 계열**이 화면을 따라간다 ────────────────────
//
// 계약 §3 은 축 on 의 모든 읽기 경로에 노출 게이트 3종이 걸려야 완결이라고 적는다.
// 계열을 안 맞추면 두 방향으로 깨진다:
//   · 인용 화면에 `'mentions'` → `hidden_scope='citations'` 회차가 살아남아 숨김의
//     목적이 깨진다(수집이 깨진 인용이 그대로 화면에 나온다).
//   · 언급 화면에 `'all'`     → 인용만 깨진 회차의 멀쩡한 언급 값까지 사라진다.
describe("숨김 게이트 계열 — 화면마다 다르다", () => {
  const FAM = {
    ca: sql.raw("NH_all_ca"),
    ca2: sql.raw("NH_all_ca2"),
  };
  // 계열별로 다른 조각을 주입해 어느 계열이 걸렸는지 텍스트로 구분한다.
  beforeEach(() => setAnchorAxisForTests(true, FAM));

  it("기본은 mentions — 계열을 안 넘기면 언급 계열이다", () => {
    // 주입 조각은 전 계열 공통이라 여기서는 **인자 전달 여부**를 본다.
    // 계열별 구분은 아래 소스 스캔이 책임진다.
    expect(compile(answerWhere(MANY_ROUNDS)).text).toContain("NH_all_ca");
  });

  it("계열을 넘겨도 게이트는 항상 걸린다(세 계열 전부)", () => {
    for (const fam of ["mentions", "citations", "all"] as const) {
      expect(compile(answerWhere(MANY_ROUNDS, undefined, { hiddenFamily: fam })).text)
        .toContain("NH_all_ca");
      expect(compile(detailAnswerWhere(MANY_ROUNDS, undefined, { hiddenFamily: fam })).text)
        .toContain("NH_all_ca");
      expect(compile(snapshotRunFilter(undefined, NONE, undefined, fam)).text)
        .toContain("NH_all_ca");
    }
  });

  it("축이 꺼지면 계열을 넘겨도 게이트가 없다", () => {
    setAnchorAxisForTests(false);
    expect(compile(answerWhere(MANY_ROUNDS, undefined, { hiddenFamily: "citations" })).text)
      .not.toContain("NH_all_ca");
  });
});

// ── N1: 카드·상세·드릴다운이 **같은 빌더**를 쓴다 ────────────────────────────
//
// 축 on + 기간에서 `detailAnswerWhere` 만 회차 dedup 이 없던 적이 있다
// (`cumulativeMode` 가 `anchor_period` 를 내 창 술어로 빠졌다). 축 off 에서는
// 양쪽 다 dedup 이 없어 일치했으므로 회귀였다 — 2026-09-16 실측(카드 156,566 vs
// 드릴다운 37,200 = 4.2배)이 정확히 이 축의 반대 방향 사고다.
describe("모집단 — 카드 == 상세 == 드릴다운 (같은 서브쿼리 빌더)", () => {
  beforeEach(() => setAnchorAxisForTests(true));

  /** 세 경로가 낸 문장에서 회차 선택 서브쿼리를 괄호 균형으로 잘라낸다. */
  function dedupSubquery(t: string): string | null {
    const at = t.indexOf("(\n    SELECT DISTINCT ON (ca.round_date");
    if (at < 0) return null;
    let depth = 0;
    for (let i = at; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") {
        depth--;
        if (depth === 0) return t.slice(at, i + 1);
      }
    }
    return null;
  }

  for (const [label, f] of [
    ["기간 없음", NONE],
    ["한 회차", ONE_ROUND],
    ["여러 회차", MANY_ROUNDS],
    ["cumulative 선언", CUMULATIVE],
  ] as const) {
    it(`루트 · ${label} — 세 경로의 회차 선택 서브쿼리가 같다`, () => {
      const card = dedupSubquery(compile(answerWhere(f)).text);
      const detail = dedupSubquery(compile(detailAnswerWhere(f)).text);
      const drill = dedupSubquery(compile(snapshotRunFilter(undefined, f)).text);
      expect(card, "카드에 dedup 서브쿼리가 없다").toBeTruthy();
      expect(detail, "상세에 dedup 서브쿼리가 없다").toBeTruthy();
      expect(drill, "드릴다운에 dedup 서브쿼리가 없다").toBeTruthy();
      expect(detail).toBe(card);
      expect(drill).toBe(card);
    });

    it(`프로젝트 · ${label} — 세 경로가 같다`, () => {
      const card = dedupSubquery(compile(answerWhere(f, ONE_PROJECT)).text);
      const detail = dedupSubquery(compile(detailAnswerWhere(f, ONE_PROJECT)).text);
      const drill = dedupSubquery(compile(snapshotRunFilter(ONE_PROJECT, f)).text);
      expect(card).toBeTruthy();
      expect(detail).toBe(card);
      expect(drill).toBe(card);
    });
  }

  it("상세도 대표 선택 규칙을 갖는다 — dedup·대표·동률이 전부 있다", () => {
    const t = compile(detailAnswerWhere(MANY_ROUNDS)).text;
    expect(t).toContain("DISTINCT ON (ca.round_date, a.prompt_id, a.target, a.region)");
    expect(t).toContain("ca.measured_at_orig DESC, a.job_id DESC");
  });

  it("명시 allRuns(추이)는 종전 창을 유지한다 — dedup 하지 않는다", () => {
    const t = compile(detailAnswerWhere(MANY_ROUNDS, undefined, { allRuns: true })).text;
    expect(t).not.toContain("DISTINCT ON (ca.round_date");
    expect(t).toContain("ca.round_date"); // 창은 앵커 축이다
  });

  it("축 off 는 종전 분기 그대로 — 누적이면 창, 아니면 스냅샷", () => {
    setAnchorAxisForTests(false);
    const cum = compile(detailAnswerWhere({ ...MANY_ROUNDS, cumulative: true })).text;
    expect(cum).not.toContain("scope_answer_cycle_anchors");
    expect(cum).toContain("cycle_anchor_at");
  });
});

// ── N2: 최신 회차 선택 게이트가 바깥 술어와 같은 계열이다 ────────────────────
describe("기준 회차 선택 — 계열이 안팎에서 같다", () => {
  /** 계열별로 다른 마커를 넣어 어느 계열이 걸렸는지 텍스트로 본다. */
  function withFamilyMarkers() {
    // `setAnchorAxisForTests` 는 별칭별 주입이라 계열을 구분하지 못한다 —
    // 대신 별칭으로 구분한다: 안쪽(ca2)과 바깥(ca)이 **같은 계열 인자**를 받는지는
    // 아래 소스 단언이, 텍스트에 둘 다 존재하는지는 이 주입이 본다.
    setAnchorAxisForTests(true, {
      ca: sql.raw("NH_OUTER"),
      ca2: sql.raw("NH_INNER"),
    });
  }

  it("기간 미지정 — 안쪽(ca2)과 바깥(ca) 게이트가 둘 다 있다", () => {
    withFamilyMarkers();
    const t = compile(answerWhere(NONE)).text;
    expect(t).toContain("NH_INNER");
    expect(t).toContain("NH_OUTER");
  });

  it("최신 회차 서브쿼리는 여전히 비상관이다", () => {
    withFamilyMarkers();
    const inner = /SELECT max\(ca2\.round_date\) FROM scope_answer_cycle_anchors ca2 WHERE ([\s\S]*?)\)\s*AND/.exec(
      compile(answerWhere(NONE)).text,
    );
    expect(inner, "최신 회차 서브쿼리를 찾지 못했다").not.toBeNull();
    expect(inner![1]).not.toMatch(/(^|[^c])a\./);
  });
});

// ── N2 의 값 계약: 계열마다 기준 회차가 갈릴 수 있다 ─────────────────────────
//
// 픽스처: 최신 회차 R 이 `hidden_scope='citations'` 로 숨겨져 있다.
//   · `'mentions'` 게이트는 R 을 **통과시킨다**(언급 값은 멀쩡하다)  → 기준 회차 = R
//   · `'citations'`·`'all'` 게이트는 R 을 **제외한다**              → 기준 회차 = R-1
// 계열별 조각을 다른 텍스트로 주입해, 최신 회차를 고르는 서브쿼리가 **어느 계열의
// 게이트를 쓰는지**를 직접 본다. 종전에는 여기가 `'all'` 고정이라 바깥 계열 인자가
// 통째로 죽어 있었다(언급 화면이 한 회차 뒤로 밀렸다).
describe("N2 — 최신 회차 선택 게이트의 계열", () => {
  const KEEP_R = "GATE_mentions_keeps_R"; // 'mentions' 판 = R 을 남긴다
  const DROP_R = "GATE_citations_drops_R"; // 'citations' 판 = R 을 뺀다
  const DROP_R_ALL = "GATE_all_drops_R";

  beforeEach(() =>
    setAnchorAxisForTests(true, undefined, {
      mentions: { ca2: sql.raw(KEEP_R), ca: sql.raw(KEEP_R) },
      citations: { ca2: sql.raw(DROP_R), ca: sql.raw(DROP_R) },
      all: { ca2: sql.raw(DROP_R_ALL), ca: sql.raw(DROP_R_ALL) },
    }),
  );

  /** 최신 회차를 고르는 서브쿼리만 괄호 균형으로 잘라낸다. */
  function latestRound(t: string): string {
    const at = t.indexOf("(SELECT max(ca2.round_date)");
    expect(at, "최신 회차 서브쿼리를 찾지 못했다").toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = at; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") {
        depth--;
        if (depth === 0) return t.slice(at, i + 1);
      }
    }
    throw new Error("괄호가 닫히지 않았다");
  }

  it("언급 화면(mentions) — 안쪽·바깥이 둘 다 mentions 판이다", () => {
    const t = compile(answerWhere(NONE, undefined, { hiddenFamily: "mentions" })).text;
    expect(latestRound(t)).toContain(KEEP_R);
    expect(latestRound(t)).not.toContain(DROP_R);
    expect(t).toContain(KEEP_R); // 바깥 술어도 같은 계열
  });

  it("인용 화면(citations) — 안쪽·바깥이 둘 다 citations 판이다", () => {
    const t = compile(answerWhere(NONE, undefined, { hiddenFamily: "citations" })).text;
    expect(latestRound(t)).toContain(DROP_R);
    expect(latestRound(t)).not.toContain(KEEP_R);
  });

  it("혼합 롤업(all) — 안쪽·바깥이 둘 다 all 판이다", () => {
    const t = compile(answerWhere(NONE, undefined, { hiddenFamily: "all" })).text;
    expect(latestRound(t)).toContain(DROP_R_ALL);
  });

  it("안쪽과 바깥이 **같은 계열**이다 — 한쪽만 고정이면 다른 쪽이 죽는다", () => {
    for (const fam of ["mentions", "citations", "all"] as const) {
      const t = compile(answerWhere(NONE, undefined, { hiddenFamily: fam })).text;
      const marker = { mentions: KEEP_R, citations: DROP_R, all: DROP_R_ALL }[fam];
      const inner = latestRound(t);
      const outer = t.slice(t.indexOf(inner) + inner.length);
      expect(inner, `안쪽이 ${fam} 판이 아니다`).toContain(marker);
      expect(outer, `바깥이 ${fam} 판이 아니다`).toContain(marker);
    }
  });

  it("상세·드릴다운도 같은 계열을 쓴다", () => {
    const detail = compile(detailAnswerWhere(NONE, undefined, { hiddenFamily: "citations" })).text;
    const drill = compile(snapshotRunFilter(undefined, NONE, undefined, "citations")).text;
    expect(latestRound(detail)).toContain(DROP_R);
    expect(latestRound(drill)).toContain(DROP_R);
  });
});
