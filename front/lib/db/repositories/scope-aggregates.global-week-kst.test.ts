/**
 * 글로벌 표면 추이의 **주 격자 = 회차 앵커의 KST 주** (2026-09-28, 제품 책임자 옵션 1).
 *
 * ── 무엇이 문제였나 ──────────────────────────────────────────────────────
 * 글로벌(표준 루트) 회차는 KST 월요일 0시대(= UTC 일요일 15~16시)에 앵커가 선다.
 * 미러 추이는 주 격자를 `date_trunc('week', a.measured_at)`(UTC 주)로 만들었으므로
 * 회차의 첫 드레인(UTC 일요일 밤)이 **전 주 칸**에 들어갔다. 2026-09-28 프로덕션 재현:
 * 관리자 `/ko/standard/answer-analysis/mention?geography=PH` 측정 커버리지 "8/31, 9/7, 9/21"
 * — 필리핀 9/14 회차 답변(09-13 16~17Z 측정)이 9/7 칸에 9/8 회차와 합쳐지고(셀당 최신 1건이라
 * 9/8 답변은 밀려난다) 9/14 칸이 비었다.
 *
 * 같은 원인이 원장 `summary_cycles.cycle_week`(UTC 월요일 절단)에도 있다 — 9/21 회차가
 * 2026-09-14 로 9/14 회차와 같은 주가 되고, 9/28 회차는 2026-09-21 이 된다.
 *
 * ── 이 파일이 고정하는 것 ────────────────────────────────────────────────
 *   ① 값 — PGlite(인메모리 Postgres)에서 조각을 **실제로 실행**해 앵커 4개가
 *      9/7·9/14·9/21·9/28 로 떨어지는지, 앵커 NULL 은 종전 식으로 떨어지는지,
 *      재측정(manual) run 이 원 회차 주를 받는지, 같은 셀의 두 회차가 DISTINCT ON 에서
 *      둘 다 살아남는지 본다. 세션 TZ 를 KST 로 바꿔도 날짜가 같아야 한다.
 *   ② 원장 규칙 — 루트 = KST 월요일, 그 외 = UTC 월요일(같은 앵커로 실행 대조).
 *   ③ 붙는 자리 — 글로벌(projectCtx 없음) 추이 리더에만 조인·KST 키가 붙고,
 *      웹사이트·프로젝트(ctx 있음)는 **문장 텍스트가 종전 그대로**다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

// ── ③ 용 캡처 DB (withAnswerSet 트랜잭션을 그대로 태운다) ─────────────────────
const dialect = new PgDialect();
const captured: string[] = [];
const execute = vi.fn(async (q: SQL) => {
  try {
    captured.push(dialect.sqlToQuery(q).sql);
  } catch {
    /* raw SET 등 */
  }
  return [] as unknown as never;
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
const OTHER = "11111111-1111-4111-8111-111111111111";

// 실측 앵커(2026-09-28 메인 확인) — 글로벌 루트 be28fe15.
const RUN_0908 = "a0000000-0000-4000-8000-000000000908"; // 2026-09-08T01:10Z (KST 화 10:10)
const RUN_0914 = "a0000000-0000-4000-8000-000000000914"; // 2026-09-13T15:48Z (KST 월 00:48)
const RUN_0921 = "a0000000-0000-4000-8000-000000000921"; // 2026-09-20T15:50Z
const RUN_0928 = "a0000000-0000-4000-8000-000000000928"; // 2026-09-27T16:00Z
const RUN_MANUAL = "a0000000-0000-4000-8000-00000000091f"; // 9/14 회차 앵커를 물려받은 재측정
const RUN_NOANCHOR = "a0000000-0000-4000-8000-0000000000ff"; // 앵커 NULL

const ANCHOR: Record<string, string | null> = {
  [RUN_0908]: "2026-09-08T01:10:00Z",
  [RUN_0914]: "2026-09-13T15:48:00Z",
  [RUN_0921]: "2026-09-20T15:50:00Z",
  [RUN_0928]: "2026-09-27T16:00:00Z",
  [RUN_MANUAL]: "2026-09-13T15:48:00Z",
  [RUN_NOANCHOR]: null,
};

// 답변 — job id 끝자리로 무엇인지 알 수 있게.
//   j0908 : 9/8 회차 필리핀 셀(P·chatgpt·PH)       09-08T03:00Z  → KST 주 9/7 · UTC 주 9/7
//   j0914 : 9/14 회차 **같은 셀**                   09-13T16:30Z  → KST 주 9/14 · UTC 주 9/7 ← 버그
//   j0921 : 9/21 회차                               09-20T16:10Z  → 9/21 · UTC 9/14
//   j0928 : 9/28 회차                               09-27T20:00Z  → 9/28 · UTC 9/21
//   j091f : 9/14 회차 재측정(manual)                09-17T05:00Z  → 9/14 · UTC 9/14
//   j00ff : 앵커 NULL                               09-13T16:30Z  → 폴백 = UTC 주 9/7
const ANSWERS: Array<[job: string, run: string, prompt: string, measuredAt: string]> = [
  ["b0000000-0000-4000-8000-000000000908", RUN_0908, "p-ph", "2026-09-08T03:00:00Z"],
  ["b0000000-0000-4000-8000-000000000914", RUN_0914, "p-ph", "2026-09-13T16:30:00Z"],
  ["b0000000-0000-4000-8000-000000000921", RUN_0921, "p-2", "2026-09-20T16:10:00Z"],
  ["b0000000-0000-4000-8000-000000000928", RUN_0928, "p-3", "2026-09-27T20:00:00Z"],
  ["b0000000-0000-4000-8000-00000000091f", RUN_MANUAL, "p-4", "2026-09-17T05:00:00Z"],
  ["b0000000-0000-4000-8000-0000000000ff", RUN_NOANCHOR, "p-5", "2026-09-13T16:30:00Z"],
];
const jobOf = (suffix: string) => `b0000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

let pg: PGlite;

async function rows<T>(q: SQL): Promise<T[]> {
  const built = dialect.sqlToQuery(q);
  return (await pg.query<T>(built.sql, built.params as unknown[])).rows;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    SET TimeZone = 'UTC';
    CREATE TABLE scope_runs (run_id uuid PRIMARY KEY, project_id uuid, cycle_anchor_at timestamptz);
    CREATE TABLE scope_answers (
      job_id uuid PRIMARY KEY, run_id uuid, prompt_id text, target text, region text,
      measured_at timestamptz
    );
  `);
  for (const [runId, anchor] of Object.entries(ANCHOR)) {
    await pg.query(`INSERT INTO scope_runs VALUES ($1, $2, $3)`, [runId, ROOT, anchor]);
  }
  for (const [job, run, prompt, at] of ANSWERS) {
    await pg.query(`INSERT INTO scope_answers VALUES ($1, $2, $3, 'chatgpt', 'PH', $4)`, [
      job, run, prompt, at,
    ]);
  }
  // 컬럼 프로브가 answerWhere 텍스트를 바꾸므로 ③ 전에 한 번 가라앉힌다(open-cycle-trend 와 동일).
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  await pg.close();
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
});

/** 조각을 그대로 실행 — 답변별 주 키(YYYY-MM-DD). */
async function weekByJob(grid: "measured" | "anchorKst"): Promise<Record<string, string>> {
  const m = await import("./scope-aggregates");
  const wk = m.mirrorWeekKey(grid);
  const out = await rows<{ job_id: string; wk: string }>(sql`
    SELECT a.job_id::text AS job_id, to_char(${wk.key}, 'YYYY-MM-DD') AS wk
    FROM scope_answers a${wk.join}
  `);
  return Object.fromEntries(out.map((r) => [r.job_id, r.wk]));
}

describe("① 값 — 조각을 PGlite 에서 실행", () => {
  it("글로벌(anchorKst): 앵커 4개가 9/7·9/14·9/21·9/28 로 떨어진다", async () => {
    const w = await weekByJob("anchorKst");
    expect(w[jobOf("908")]).toBe("2026-09-07"); // 9/8(화) 회차 — KST 로도 9/7 주
    expect(w[jobOf("914")]).toBe("2026-09-14"); // 09-13(일) 16:30Z 측정이어도 회차 주
    expect(w[jobOf("921")]).toBe("2026-09-21");
    expect(w[jobOf("928")]).toBe("2026-09-28");
  });

  it("재측정(manual) run 은 물려받은 앵커의 주로 간다", async () => {
    const w = await weekByJob("anchorKst");
    expect(w[jobOf("91f")]).toBe("2026-09-14");
  });

  it("앵커 NULL run 은 종전 식(측정 시각의 세션 TZ 주)으로 폴백한다", async () => {
    const w = await weekByJob("anchorKst");
    const old = await weekByJob("measured");
    expect(w[jobOf("ff")]).toBe("2026-09-07");
    expect(w[jobOf("ff")]).toBe(old[jobOf("ff")]);
  });

  it("종전 격자(measured)는 버그 그대로다 — 이 파일이 무엇을 고치는지의 대조군", async () => {
    const old = await weekByJob("measured");
    expect(old[jobOf("914")]).toBe("2026-09-07"); // 9/14 회차가 9/7 칸
    expect(old[jobOf("921")]).toBe("2026-09-14");
    expect(old[jobOf("928")]).toBe("2026-09-21");
  });

  it("조인이 행을 불리지 않는다 — 답변 수 그대로", async () => {
    const m = await import("./scope-aggregates");
    const wk = m.mirrorWeekKey("anchorKst");
    const [{ n }] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM scope_answers a${wk.join}`,
    );
    expect(n).toBe(ANSWERS.length);
  });

  it("DISTINCT ON(셀 × 주) 에서 같은 셀의 9/8·9/14 회차가 **둘 다** 산다", async () => {
    // 언급·인용 주간 롤업과 같은 형태의 문장 — DISTINCT ON 과 ORDER BY 가 같은 조각이다.
    // (조각에 바인드 파라미터가 끼면 여기서 "must match initial ORDER BY" 로 죽는다.)
    const m = await import("./scope-aggregates");
    const pick = async (grid: "measured" | "anchorKst") => {
      const wk = m.mirrorWeekKey(grid);
      return rows<{ job_id: string; wk: string }>(sql`
        SELECT x.job_id::text AS job_id, to_char(x.wk, 'YYYY-MM-DD') AS wk FROM (
          SELECT DISTINCT ON (a.prompt_id, a.target, a.region, ${wk.key})
            a.job_id, ${wk.key} AS wk
          FROM scope_answers a${wk.join}
          WHERE a.prompt_id = 'p-ph'
          ORDER BY a.prompt_id, a.target, a.region, ${wk.key}, a.measured_at DESC
        ) x ORDER BY 2
      `);
    };
    expect(await pick("anchorKst")).toEqual([
      { job_id: jobOf("908"), wk: "2026-09-07" },
      { job_id: jobOf("914"), wk: "2026-09-14" },
    ]);
    // 종전: 한 칸에 합쳐지고 9/8 답변이 밀려난다(재현된 증상).
    expect(await pick("measured")).toEqual([{ job_id: jobOf("914"), wk: "2026-09-07" }]);
  });

  it("세션 TZ 가 KST 여도 앵커 팔의 날짜는 같다(`::date` 뒤 같은 TZ 로 되돌린다)", async () => {
    await pg.exec(`SET TimeZone = 'Asia/Seoul'`);
    try {
      const w = await weekByJob("anchorKst");
      expect(w[jobOf("914")]).toBe("2026-09-14");
      expect(w[jobOf("928")]).toBe("2026-09-28");
    } finally {
      await pg.exec(`SET TimeZone = 'UTC'`);
    }
  });

  it("KPI 탭 축 경계도 KST 주로 자른다(글로벌) — 버킷 키와 같은 격자", async () => {
    // 2026-09-27T16:30Z = KST 9/28(월) 01:30. UTC 주는 9/21, KST 주는 9/28.
    const t = sql`'2026-09-27T16:30:00Z'::timestamptz`;
    const [r] = await rows<{ kst: string; utc: string }>(sql`
      SELECT to_char((date_trunc('week', (${t}) AT TIME ZONE 'Asia/Seoul'))::date, 'YYYY-MM-DD') AS kst,
             to_char(date_trunc('week', ${t}), 'YYYY-MM-DD') AS utc
    `);
    expect(r).toEqual({ kst: "2026-09-28", utc: "2026-09-21" });
  });
});

describe("② 원장 cycle_week 규칙 — 루트 = KST 월요일, 그 외 = UTC 월요일", () => {
  const anchors: Array<[string, string, string]> = [
    // [anchor, KST 월요일(루트), UTC 월요일(그 외)]
    ["2026-09-08T01:10:00Z", "2026-09-07", "2026-09-07"],
    ["2026-09-13T15:48:00Z", "2026-09-14", "2026-09-07"],
    ["2026-09-20T15:50:00Z", "2026-09-21", "2026-09-14"],
    ["2026-09-27T16:00:00Z", "2026-09-28", "2026-09-21"],
  ];

  it.each(anchors)("앵커 %s → 루트 %s · 그 외 %s", async (anchor, kst, utc) => {
    const { __testables } = await import("./summary-cycles");
    const expr = (project: string, root: string | null) =>
      __testables.cycleWeekForSurfaceExpr(
        sql`${anchor}::timestamptz`,
        sql`${project}::uuid`,
        root,
      );
    const [r] = await rows<{ root: string; other: string; noroot: string }>(sql`
      SELECT to_char(${expr(ROOT, ROOT)}, 'YYYY-MM-DD') AS root,
             to_char(${expr(OTHER, ROOT)}, 'YYYY-MM-DD') AS other,
             to_char(${expr(ROOT, null)}, 'YYYY-MM-DD') AS noroot
    `);
    expect(r).toEqual({ root: kst, other: utc, noroot: utc });
  });

  it("원장(루트) 주와 미러 글로벌 주 격자가 같은 값을 낸다 — 갭 슬롯 키가 격자에 선다", async () => {
    const { __testables } = await import("./summary-cycles");
    const w = await weekByJob("anchorKst");
    for (const [job, run] of ANSWERS) {
      const anchor = ANCHOR[run];
      if (!anchor) continue;
      const [r] = await rows<{ wk: string }>(sql`
        SELECT to_char(${__testables.cycleWeekKstExpr(sql`${anchor}::timestamptz`)}, 'YYYY-MM-DD') AS wk
      `);
      expect(w[job], job).toBe(r.wk);
    }
  });
});

// ── ③ 붙는 자리 ─────────────────────────────────────────────────────────────
const JOIN_RE = /LEFT JOIN \(SELECT run_id AS _wk_run_id, cycle_anchor_at AS _wk_anchor FROM scope_runs\) _wk ON _wk\._wk_run_id = a\.run_id/;
const KST_KEY =
  "COALESCE((date_trunc('week', (_wk._wk_anchor AT TIME ZONE 'Asia/Seoul')))::date::timestamptz, date_trunc('week', a.measured_at))";
const PIDS = ["22222222-2222-4222-8222-222222222222"];
const BASES = ["hyundai.com"];

const run = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch {
    /* 빈 mock 결과로 후처리가 실패해도 SQL 은 이미 캡처됐다 */
  }
};
const answerSets = () => captured.filter((s) => /CREATE TEMP TABLE _answer_set/.test(s));

describe("③ 붙는 자리 — 글로벌 추이 리더에만", () => {
  it("mirrorWeekGridFor: ctx 없음 = 글로벌(anchorKst), ctx 있음 = 종전", async () => {
    const m = await import("./scope-aggregates");
    expect(m.mirrorWeekGridFor(undefined)).toBe("anchorKst");
    expect(m.mirrorWeekGridFor([])).toBe("anchorKst"); // answerWhere 도 [] 를 루트로 본다
    expect(m.mirrorWeekGridFor("p1")).toBe("measured");
    expect(m.mirrorWeekGridFor(PIDS)).toBe("measured");
  });

  it("measured 조각은 종전 식과 문자 그대로 같다(조인 없음)", async () => {
    const m = await import("./scope-aggregates");
    const wk = m.mirrorWeekKey("measured");
    expect(dialect.sqlToQuery(wk.join).sql).toBe("");
    expect(dialect.sqlToQuery(wk.key).sql).toBe("date_trunc('week', a.measured_at)");
    const kst = m.mirrorWeekKey("anchorKst");
    expect(dialect.sqlToQuery(kst.key).sql).toBe(KST_KEY);
    expect(dialect.sqlToQuery(kst.key).params).toEqual([]); // DISTINCT ON 문자 일치 조건
  });

  it("KPI 추이(week, 글로벌) — 답변셋에 조인 + DISTINCT ON 에 KST 키", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateStandardTrendFromMirror({}, "week", undefined, BASES));
    const [set] = answerSets();
    expect(set).toMatch(JOIN_RE);
    expect(set).toContain(`SELECT DISTINCT ON (${KST_KEY}, a.prompt_id, a.target, a.region)`);
    expect(set).toContain(`ORDER BY ${KST_KEY}, a.prompt_id, a.target, a.region, a.measured_at DESC`);
  });

  it("KPI 추이(day, 글로벌) — 측정일 격자 그대로(조인 없음)", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateStandardTrendFromMirror({}, "day", undefined, BASES));
    const [set] = answerSets();
    expect(set).not.toMatch(/_wk/);
    expect(set).toContain("date_trunc('day', a.measured_at)");
  });

  it.each([
    ["웹사이트", PIDS],
    ["프로젝트", "p1"],
  ])("KPI 추이(week, %s) — 문장 텍스트 종전 그대로", async (_l, ctx) => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateStandardTrendFromMirror({}, "week", ctx, BASES, BASES, true));
    const [set] = answerSets();
    expect(set).not.toMatch(/_wk|Asia\/Seoul/);
    expect(set).toContain(
      "SELECT DISTINCT ON (date_trunc('week', a.measured_at), a.prompt_id, a.target, a.region)",
    );
    expect(set).toContain("FROM scope_answers a WHERE");
  });

  it("언급·인용 주간 롤업(글로벌) — 조인 + DISTINCT ON/ORDER BY 에 같은 KST 키", async () => {
    const m = await import("./scope-aggregates");
    // "all"(JS 경로)는 주간 롤업을 헤드라인과 **동시에** 발행한다 — 빈 mock 에서도 문장이
    // 잡힌다. 글로벌 화면이 쓰는 "none"(SQL 헤드라인) 경로도 같은 리더(readMentionBrandDayCounts)
    // 를 같은 scopeProjectId 로 부른다(헤드라인이 0건이면 그 전에 반환해 mock 에선 안 잡힌다).
    await run(() => m.aggregateMentionsFromMirror({}, undefined, "all"));
    await run(() => m.aggregateCitationsFromMirror({}, undefined, BASES));
    const weekly = captured.filter((s) => /AS wk/.test(s));
    expect(weekly.length).toBe(2);
    for (const s of weekly) {
      expect(s).toMatch(JOIN_RE);
      expect(s).toContain(`SELECT DISTINCT ON (a.prompt_id, a.target, a.region, ${KST_KEY})`);
      expect(s).toContain(`ORDER BY a.prompt_id, a.target, a.region, ${KST_KEY},`);
    }
  });

  it("언급·인용 주간 롤업(웹사이트·프로젝트) — 종전 문장 그대로", async () => {
    const m = await import("./scope-aggregates");
    await run(() => m.aggregateMentionsFromMirror({}, PIDS, "all"));
    await run(() => m.aggregateCitationsFromMirror({}, "p1", BASES));
    const weekly = captured.filter((s) => /AS wk/.test(s));
    expect(weekly.length).toBe(2);
    for (const s of weekly) {
      expect(s).not.toMatch(/_wk\b|Asia\/Seoul/);
      expect(s).toContain(
        "SELECT DISTINCT ON (a.prompt_id, a.target, a.region, date_trunc('week', a.measured_at))",
      );
    }
  });

  it.each([
    ["브랜드 추이", "aggregateBrandTrendFromMirror"],
    ["엔진 KPI 추이", "aggregateEngineKpiTrendFromMirror"],
    ["우선 노출도 추이", "aggregateFirstPositionFromMirror"],
  ] as const)("4-KPI 탭 %s(글로벌) — 추이 답변셋에만 조인·KST 버킷", async (_l, fn) => {
    const m = await import("./scope-aggregates");
    await run(() => (m[fn] as (f: object, c: undefined, o: object) => Promise<unknown>)({}, undefined, {}));
    const sets = answerSets();
    const trend = sets.filter((s) => /AS bucket/.test(s));
    const snap = sets.filter((s) => !/AS bucket/.test(s));
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatch(JOIN_RE);
    expect(trend[0]).toContain(`${KST_KEY} AS bucket`);
    // 스냅샷 답변셋은 주 격자와 무관 — 조인이 새면 안 된다.
    expect(snap.every((s) => !/_wk/.test(s))).toBe(true);
  });

  it.each([
    ["브랜드 추이", "aggregateBrandTrendFromMirror"],
    ["엔진 KPI 추이", "aggregateEngineKpiTrendFromMirror"],
  ] as const)("4-KPI 탭 %s — 축 경계: 글로벌 = KST 절단, 프로젝트 = 종전", async (_l, fn) => {
    const m = await import("./scope-aggregates");
    const call = m[fn] as (f: object, c: unknown, o: object) => Promise<unknown>;
    await run(() => call({}, undefined, {}));
    const g = captured.filter((s) => /AS win_start/.test(s));
    expect(g).toHaveLength(1);
    expect(g[0]).toContain("(date_trunc('week', (now() - interval '120 days') AT TIME ZONE 'Asia/Seoul'))::date");
    captured.length = 0;
    await run(() => call({}, PIDS, {}));
    const p = captured.filter((s) => /AS win_start/.test(s));
    expect(p).toHaveLength(1);
    expect(p[0]).not.toContain("Asia/Seoul");
    expect(p[0]).toMatch(/to_char\(date_trunc\(\$\d+, now\(\) - interval '120 days'\), 'YYYY-MM-DD'\) AS win_start/);
    // 프로젝트 추이 답변셋도 종전 그대로 — 필드는 bind 파라미터.
    const trend = answerSets().filter((s) => /AS bucket/.test(s));
    expect(trend[0]).toContain("date_trunc($");
    expect(trend[0]).not.toMatch(/_wk/);
  });
});
