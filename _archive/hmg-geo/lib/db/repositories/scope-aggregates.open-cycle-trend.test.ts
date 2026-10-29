// 회귀 가드 — 미러 추이가 **뷰 앵커(V-1)가 아직 오지 않은 회차**를 그리지 않게 (2026-09-10).
//
// 배경(실측 2026-09-10 15:40 KST · 웹사이트 무필터 주 버킷): 8/24 46,442 · 8/31 20,574 인데
// 9/07 주는 19,243 이었고 그 중 19,146(99.5%)이 관제 원장상 `open` 인 9/10 회차의 진행분,
// 글로벌(root) 9/07 주 37,569 는 **전량** open 9/08 회차였다. 사실표(summary_*) 경로에만
// 있던 "뷰 앵커 = 측정 앵커 + 1~2일" 규칙이 미러 폴백 경로에는 없어 생긴 구멍이다.
//
// 핫픽스 A(#238)는 추이 리더 **2곳**만, A2(#240)는 **미러 시계열 리더 전부**를 고쳤지만
// 둘 다 술어를 **관제 상태(`open`)** 로 썼다. 상태는 뷰 앵커의 대리 변수일 뿐이라 양쪽으로
// 틀린다 — **A3(이 파일의 현재 형태)가 술어를 시간 규칙으로 바꾼다**:
//   · 지나치게 감춘다 — 글로벌 9/08 회차 `9db294d8`(anchor 2026-09-08 01:10Z · 38,747/38,748 ·
//     sealed 1 · gap 0.0191)은 앵커+2일 = 9/10 01:10Z 가 지나 **노출돼야 하는데** 아직 `open`
//     이라 9/07 주(≈37,569)가 통째로 사라졌다.
//   · 지나치게 드러낸다 — 관제가 100% 로 닫는 순간 술어가 풀려 **부분 분석 데이터**가 샌다.
//
// 이 테스트가 고정하는 것:
//   ① 숨김 술어는 **시간 규칙**이다 — `COALESCE(view_anchor_at, cycle_anchor_at + 표면 지연)
//      > now()`. 상태(`c.status IN …`)는 **ELSE(상수 없는 표면) 폴백에만** 남는다. 상태 기반
//      으로 되돌리면 실패한다.
//   ② 표면 지연은 **코어 상수 `VIEW_ANCHOR_DELAY` 에서 생성**한다(리터럴 복사 금지). 지연을
//      0 으로 바꾸거나 표면을 빠뜨리면 실패한다. 값 자체(글로벌 2일·웹사이트 1일)도 고정한다.
//   ③ 상수 없는 표면(`project` 등)은 종전 `open` 규칙을 그대로 쓴다 — 없는 규칙을 지어내지
//      않는다. 그 목록은 여전히 `open` **하나뿐**이다(generating·closed 를 넣으면 과거 버킷이
//      소급해 줄어든다 — 2026-09-10 실측: generating 이 8/28 앵커 회차 1개에 13일째 멈춰 있고
//      그 답변 335건이 웹사이트 8/24 주 버킷 안에 있다).
//   ④ 원장 미적용(0059 전) 환경에서는 술어가 아예 없다 = 값 무변경.
//   ⑤ **시계열 리더 전부**에 술어가 붙는다 — KPI ①~⑤(week·day) · 웹사이트 ⑥ · 프로젝트 ⑥ ·
//      4-KPI 탭 3종(브랜드·엔진·우선노출도) · 언급/인용 화면의 주간 롤업 · ACR 일별 추이.
//   ⑥ **같은 함수 안의 스냅샷 문장에는 안 붙는다.** 엔진 KPI 의 `latest`·우선노출도 순위표·
//      인용 카드는 "지금 시점 상태"라 규칙이 다르다. 이 항목이 "몰래 다른 리더에 붙이기"
//      뮤테이션을 잡는다 — ⑤만 있으면 전 문장에 붙여도 통과한다.
//
// ⚠️ 술어가 `now()` 를 쓰므로 여기서는 **SQL 형태만** 고정한다. 값(어느 회차가 실제로
// 숨는가)의 검증은 실 DB 대조 몫이다 — 2026-09-10 관제 전수 대조에서 A2→A3 로 판정이
// 바뀌는 회차는 글로벌 `9db294d8` 단 1개(숨김→노출)였다.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const ledgerAvailable = vi.fn<[], Promise<boolean>>();
vi.mock("@/lib/db/repositories/summary-settings", () => ({
  summaryLedgerAvailable: () => ledgerAvailable(),
}));

const dialect = new PgDialect();
const captured: string[] = [];
const params: unknown[][] = [];
// ACR 은 총량(Q1)·브랜드(Q2)가 비면 추이(Q3) 문장을 **아예 보내지 않는다**(조기 반환).
// 그래서 그 두 문장에만 최소 행을 돌려준다 — 다른 리더는 종전대로 빈 배열이다.
const acrStub = (s: string): unknown[] | null => {
  if (/AS answers/.test(s)) {
    return [{ answers: 1, prompts: 1, as_of: "2026-09-15T00:00:00.000Z" }];
  }
  if (/AS prompt_runs/.test(s)) {
    return [{ prompt_runs: 1, prompts: 1, iterations: 10, engines: ["chatgpt"] }];
  }
  if (/AS appearance,/.test(s)) {
    return [{ brand: "Hyundai", is_ours: 1, choice: 5, appearance: 5, cells: 1 }];
  }
  return null;
};
const execute = vi.fn(async (q: SQL) => {
  let text = "";
  try {
    const built = dialect.sqlToQuery(q);
    text = built.sql;
    captured.push(built.sql);
    params.push(built.params);
  } catch {
    /* raw SET 등 — 형태 검사 대상 아님 */
  }
  return (acrStub(text) ?? []) as unknown as never;
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const PIDS = ["11111111-1111-1111-1111-111111111111"];
const BASES = ["hyundai.com"];
const URLS = ["https://hyundai.com/a"];
// 원장 술어의 지문 — 테이블 둘과 조인 키까지 본다(테이블 이름만 보면 다른 자리의
// summary_cycle_runs 참조와 구분되지 않는다). 답변셋은 `a.run_id`, ACR 롤업은 `x.run_id`.
const ledgerRe = (col: string) =>
  new RegExp(
    `NOT EXISTS \\(\\s*SELECT 1 FROM summary_cycle_runs cr\\s+JOIN summary_cycles c ON c\\.cycle_id = cr\\.cycle_id\\s+WHERE cr\\.run_id = ${col.replace(".", "\\.")}`,
  );
const LEDGER = ledgerRe("a.run_id");
const LEDGER_ACR = ledgerRe("x.run_id");

beforeAll(async () => {
  // 컬럼 존재 프로브가 answerWhere 의 SQL 텍스트를 바꾸므로 한 번 가라앉힌다.
  ledgerAvailable.mockResolvedValue(true);
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
  params.length = 0;
  ledgerAvailable.mockResolvedValue(true);
});

const run = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch {
    /* 빈 mock 결과로 후처리가 실패해도 SQL 은 이미 캡처됐다 */
  }
};

const buildPredicate = async (col?: string) => {
  const m = await import("./scope-aggregates");
  const { sql } = await import("drizzle-orm");
  // 계열(0071)은 **시간 규칙과 직교**하다 — 이 파일이 고정하는 것은 시간 규칙이라
  // 어느 계열로 지어도 같아야 한다. 종전 동작(0071 미적용)의 지문은 `citation` 이다.
  const pred = await m.excludeHiddenCycleRuns(col ? sql.raw(col) : sql`a.run_id`, "citation");
  return dialect.sqlToQuery(sql`SELECT 1 WHERE ${pred}`);
};

/** 한 표면의 뷰 앵커 분기 지문 — 지연 리터럴까지 본다(0 으로 바꾸면 안 맞는다). */
const branchRe = (delay: string) =>
  new RegExp(
    `WHEN \\$\\d+ THEN COALESCE\\(\\s*c\\.view_anchor_at, c\\.cycle_anchor_at \\+ interval '${delay}'\\s*\\) > now\\(\\)`,
  );

describe("뷰 앵커 전 회차 감추기 — 술어 형태(V-1 시간 규칙)", () => {
  it("표면 지연은 코어 상수에서 온다 — 값도 고정(운영 확정 2026-09-10)", async () => {
    const { VIEW_ANCHOR_DELAY } = await import("@/lib/summary/generate/types");
    expect(VIEW_ANCHOR_DELAY).toEqual({ global: "2 days", website: "1 day" });
    // `swap.ts`(쓰기 V-1)는 같은 상수를 재수출한다 — 두 벌이 되면 쓰기/읽기가 갈린다.
    const swap = await import("@/lib/summary/generate/swap");
    expect(swap.VIEW_ANCHOR_DELAY).toBe(VIEW_ANCHOR_DELAY);
  });

  it("숨김 조건은 상태가 아니라 시간이다 — COALESCE(view_anchor_at, anchor+지연) > now()", async () => {
    const built = await buildPredicate();
    expect(built.sql).toMatch(LEDGER);
    expect(built.sql).toMatch(/CASE c\.surface/);
    expect(built.sql).toMatch(/COALESCE\(\s*c\.view_anchor_at, c\.cycle_anchor_at \+ interval/);
    expect(built.sql).toMatch(/> now\(\)/);
    // 상태 기반으로 되돌리는 뮤테이션 가드 — `c.status` 는 ELSE 폴백에 **한 번만** 나온다.
    expect(built.sql.match(/c\.status/g)?.length).toBe(1);
    expect(built.sql).toMatch(/ELSE c\.status IN \(/);
  });

  it("VIEW_ANCHOR_DELAY 의 모든 표면이 분기로 생성된다 — 리터럴 복사·누락 가드", async () => {
    const { VIEW_ANCHOR_DELAY } = await import("@/lib/summary/generate/types");
    const built = await buildPredicate();
    const surfaces = Object.keys(VIEW_ANCHOR_DELAY);
    for (const [, delay] of Object.entries(VIEW_ANCHOR_DELAY)) {
      // 지연을 0 으로 바꾸거나 표면을 빠뜨리면 여기서 죽는다.
      expect(built.sql).toMatch(branchRe(delay));
    }
    // 표면 이름은 바인드 파라미터로 나간다 — 상수의 키가 곧 파라미터 앞부분이다.
    expect(built.params.slice(0, surfaces.length)).toEqual(surfaces);
    expect(built.sql.match(/WHEN \$\d+ THEN COALESCE\(/g)?.length).toBe(surfaces.length);
  });

  it("상수 없는 표면(project 등)은 종전 `open` 규칙을 폴백으로 쓴다", async () => {
    const m = await import("./scope-aggregates");
    // 목록을 늘리면 과거 버킷이 소급해 줄어든다 — 늘리기 전에 실측하라(머리 주석 ③).
    expect([...m.TREND_HIDDEN_CYCLE_STATUSES]).toEqual(["open"]);
    const built = await buildPredicate();
    // 폴백은 ELSE 뒤에만 있다 — 그리고 목록이 곧 뒤쪽 파라미터다.
    const { VIEW_ANCHOR_DELAY } = await import("@/lib/summary/generate/types");
    expect(built.params.slice(Object.keys(VIEW_ANCHOR_DELAY).length)).toEqual(["open"]);
    for (const st of ["generating", "closed", "published", "stale"]) {
      expect(built.params).not.toContain(st);
    }
  });

  it("run 컬럼을 지정하면 그 컬럼으로 건다 — ACR 롤업(x.run_id)", async () => {
    const built = await buildPredicate("x.run_id");
    expect(built.sql).toMatch(LEDGER_ACR);
  });

  it("원장 미적용(0059 전)이면 술어가 없다 = 값 무변경", async () => {
    ledgerAvailable.mockResolvedValue(false);
    const built = await buildPredicate();
    expect(built.sql).not.toMatch(/summary_cycle_runs/);
    expect(built.sql).not.toMatch(/view_anchor_at/);
    expect(built.sql).toContain("true");
  });
});

describe("뷰 앵커 전 회차 감추기 — 붙는 자리(시계열 리더 전부)", () => {
  it.each([
    ["week"],
    ["day"], // 카드 Δ 롤업이 쓰는 단위 — 같은 리더라 같은 술어를 타야 한다
  ])("KPI 추이(%s)의 답변셋에 술어가 붙는다", async (unit) => {
    const m = await import("./scope-aggregates");
    await run(() =>
      m.aggregateStandardTrendFromMirror({}, unit as "week" | "day", PIDS, BASES, BASES, true),
    );
    expect(captured.some((s) => LEDGER.test(s))).toBe(true);
  });

  it("글로벌(root) 경로에도 붙는다 — 같은 리더", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateStandardTrendFromMirror({}, "week", "p1", BASES));
    expect(captured.some((s) => LEDGER.test(s))).toBe(true);
  });

  it("웹사이트 ⑥ 타겟 인용률 추이의 스냅샷 CTE 에 붙는다", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateWebsiteCitationAccuracyTrend({}, "week", PIDS, BASES, BASES));
    expect(captured.some((s) => LEDGER.test(s))).toBe(true);
  });

  // ── 핫픽스 A2 (2026-09-10) — 아래부터가 확장분 ────────────────────────────
  it("프로젝트 ⑥ 타겟 인용률 추이에 붙는다", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateCitationAccuracyTrend({}, URLS, "week", "", PIDS[0]));
    expect(captured.some((s) => LEDGER.test(s))).toBe(true);
  });

  it.each([
    ["브랜드 추이", (m: Mod) => m.aggregateBrandTrendFromMirror({}, PIDS, {})],
    ["엔진 KPI 추이", (m: Mod) => m.aggregateEngineKpiTrendFromMirror({}, PIDS, {})],
    ["우선 노출도 추이", (m: Mod) => m.aggregateFirstPositionFromMirror({}, PIDS, {})],
  ])("4-KPI 탭 %s — 추이 답변셋에만 붙는다(스냅샷 답변셋엔 안 붙는다)", async (_l, call) => {
    const m = await import("./scope-aggregates");
    await run(() => call(m));
    // 답변셋 확정 문장(CREATE TEMP TABLE)만 본다. 버킷 컬럼(`AS bucket`)이 있는 것이
    // 추이 단계, 없는 것이 스냅샷 단계다 — kpiTabTrendCols vs detailAnswerWhere.
    const sets = captured.filter((s) => /CREATE TEMP TABLE _answer_set/.test(s));
    expect(sets.length).toBeGreaterThan(0);
    const trendSets = sets.filter((s) => /AS bucket/.test(s));
    const snapSets = sets.filter((s) => !/AS bucket/.test(s));
    expect(trendSets.length).toBe(1);
    expect(trendSets.every((s) => LEDGER.test(s))).toBe(true);
    expect(snapSets.some((s) => /summary_cycle_runs/.test(s))).toBe(false);
  });

  it("언급 화면 주간 롤업에 붙는다 — 헤드라인 스냅샷 문장엔 안 붙는다", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateMentionsFromMirror({}, PIDS, "none"));
    const weekly = captured.filter((s) => /date_trunc\('week', a\.measured_at\)/.test(s));
    const rest = captured.filter((s) => !/date_trunc\('week', a\.measured_at\)/.test(s));
    expect(weekly.length).toBeGreaterThan(0);
    expect(weekly.every((s) => LEDGER.test(s))).toBe(true);
    expect(rest.some((s) => /summary_cycle_runs/.test(s))).toBe(false);
  });

  it("인용 화면 주간 롤업에 붙는다 — 카드·표 스냅샷 문장엔 안 붙는다", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateCitationsFromMirror({}, PIDS, BASES, BASES, true));
    const weekly = captured.filter((s) => /date_trunc\('week', a\.measured_at\)/.test(s));
    const rest = captured.filter((s) => !/date_trunc\('week', a\.measured_at\)/.test(s));
    expect(weekly.length).toBeGreaterThan(0);
    expect(weekly.every((s) => LEDGER.test(s))).toBe(true);
    expect(rest.some((s) => /summary_cycle_runs/.test(s))).toBe(false);
  });

  it("ACR 일별 추이의 분자·분모 양쪽에 붙는다 — 스냅샷 문장엔 안 붙는다", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateAcrFromMirror({}));
    const trend = captured.filter((s) => /day_tot/.test(s));
    const rest = captured.filter((s) => !/day_tot/.test(s));
    expect(trend.length).toBe(1);
    // 한 문장 안에 분모(cells)·분자(brand_day) 두 자리 → 지문이 두 번 나와야 한다.
    expect(trend[0].match(new RegExp(LEDGER_ACR.source, "g"))?.length).toBe(2);
    expect(rest.some((s) => /summary_cycle_runs/.test(s))).toBe(false);
  });

  it("원장 미적용이면 어느 리더에도 원장 표가 안 나온다", async () => {
    const m = await import("./scope-aggregates");
    ledgerAvailable.mockResolvedValue(false);
    await run(() => m.aggregateStandardTrendFromMirror({}, "week", PIDS, BASES, BASES, true));
    await run(() => m.aggregateWebsiteCitationAccuracyTrend({}, "week", PIDS, BASES, BASES));
    await run(() => m.aggregateCitationAccuracyTrend({}, URLS, "week", "", PIDS[0]));
    await run(() => m.aggregateBrandTrendFromMirror({}, PIDS, {}));
    await run(() => m.aggregateEngineKpiTrendFromMirror({}, PIDS, {}));
    await run(() => m.aggregateFirstPositionFromMirror({}, PIDS, {}));
    await run(() => m.aggregateMentionsFromMirror({}, PIDS, BASES, BASES, true));
    await run(() => m.aggregateCitationsFromMirror({}, PIDS, BASES, BASES, true));
    await run(() => m.aggregateAcrFromMirror({}));
    expect(captured.some((s) => /summary_cycle_runs/.test(s))).toBe(false);
  });

  it("시계열이 아닌 미러 리더(카드·서브KPI)에는 붙지 않는다 — 범위 밖", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateStandardFromMirror({}, PIDS, BASES, BASES, true));
    await run(() => m.aggregateSubKpisFromMirror({}, PIDS, BASES, BASES, true));
    await run(() => m.latestMeasureDays({}, PIDS));
    await run(() => m.measureDayBoundsInRange({}, PIDS));
    expect(captured.some((s) => /summary_cycle_runs/.test(s))).toBe(false);
  });
});

type Mod = typeof import("./scope-aggregates");
