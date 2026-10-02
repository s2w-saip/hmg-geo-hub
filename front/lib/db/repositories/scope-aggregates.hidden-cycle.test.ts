// 회귀 가드 — **원장 숨김**(0070)이 미러 술어에 실제로 걸리는가 (2026-09-10).
//
// A3(`open-cycle-trend.test.ts`)는 "아직 노출일이 안 됐다"(시간)를 고정한다. 이 파일은
// 그 위에 얹힌 **"이 회차는 값이 틀렸다"(사람의 판단)** 를 고정한다. 둘은 직교하고,
// 술어에서 `OR` 로 결합된다.
//
// 이 파일이 잡는 뮤테이션 셋:
//   ① `hidden_reason` 절을 **지우면** 실패한다(핫픽스 C 의 본체가 사라지는 형태).
//   ② 절을 CASE **안**으로 옮기면 실패한다 — `project` 처럼 지연 상수가 없는 표면에서
//      조용히 빠진다(숨김은 표면과 무관한 판단이므로 모든 표면에 걸려야 한다).
//   ③ 컬럼 프로브를 무시하고 무조건 붙이면 실패한다 — 0070 미적용 배포에서 42703 이라
//      전 화면이 미러 폴백으로 떨어진다(숨김이 아니라 장애다).
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const ledgerAvailable = vi.fn<[], Promise<boolean>>();
vi.mock("@/lib/db/repositories/summary-settings", () => ({
  summaryLedgerAvailable: () => ledgerAvailable(),
}));

const dialect = new PgDialect();
const execute = vi.fn(async () => [] as unknown as never);
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const setHidden = async (value: boolean) => {
  const ca = await import("@/lib/db/column-availability");
  ca.setColumnAvailabilityForTests("summary_cycles", "hidden_reason", value);
};

/** 0071 의 범위 컬럼(`hidden_scope`) 가용성 — 0070 프로브와 **따로** 움직인다. */
const setScope = async (value: boolean) => {
  const ca = await import("@/lib/db/column-availability");
  ca.setColumnAvailabilityForTests("summary_cycles", "hidden_scope", value);
};

beforeAll(async () => {
  ledgerAvailable.mockResolvedValue(true);
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(async () => {
  execute.mockClear();
  ledgerAvailable.mockResolvedValue(true);
  await setHidden(true);
  // 기본은 **0071 미적용** = 오늘의 프로덕션. 종전 동작이 기본값이어야 회귀가 드러난다.
  await setScope(false);
});

const buildPredicate = async (family: "mention" | "citation" = "citation") => {
  const m = await import("./scope-aggregates");
  const { sql } = await import("drizzle-orm");
  return dialect.sqlToQuery(
    sql`SELECT 1 WHERE ${await m.excludeHiddenCycleRuns(sql`a.run_id`, family)}`,
  );
};

const buildDelta = async () => {
  const m = await import("./scope-aggregates");
  const { sql } = await import("drizzle-orm");
  return dialect.sqlToQuery(
    sql`SELECT 1 WHERE ${await m.excludeCitationOnlyHiddenRuns(sql`a.run_id`)}`,
  );
};

describe("원장 숨김(0070) — 미러 술어", () => {
  it("숨김 절이 CASE **밖**에서 OR 로 결합된다 (뮤테이션 ①②)", async () => {
    const built = await buildPredicate();
    expect(built.sql).toMatch(/c\.hidden_reason IS NOT NULL/);
    // OR 가 CASE 를 감싼다 — `(hidden OR CASE …)`. CASE 안으로 들어가면 이 지문이 깨진다.
    expect(built.sql).toMatch(/\(c\.hidden_reason IS NOT NULL OR CASE c\.surface/);
    // WHEN 절 안에 숨김이 섞이면 표면마다 규칙이 갈린다 — 그 형태를 금지한다.
    expect(built.sql).not.toMatch(/WHEN \$\d+ THEN[\s\S]{0,200}hidden_reason/);
    // 절은 **한 번만** 나온다(표면 수만큼 복제되지 않았다).
    expect(built.sql.match(/hidden_reason/g)).toHaveLength(1);
  });

  it("시간 규칙은 그대로 살아 있다 — 숨김이 A3 를 대체하지 않는다", async () => {
    const built = await buildPredicate();
    expect(built.sql).toMatch(/COALESCE\(\s*c\.view_anchor_at, c\.cycle_anchor_at \+ interval/);
    expect(built.sql).toMatch(/ELSE c\.status IN \(/);
    expect(built.sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM summary_cycle_runs cr/);
  });

  it("0070 미적용이면 절이 아예 없다 = 종전 SQL 과 동일 (뮤테이션 ③)", async () => {
    await setHidden(false);
    const built = await buildPredicate();
    expect(built.sql).not.toMatch(/hidden_reason/);
    // 나머지는 그대로 — 술어가 통째로 사라지는 것이 아니다.
    expect(built.sql).toMatch(/CASE c\.surface/);
    expect(built.sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM summary_cycle_runs cr/);
  });

  it("원장 미적용(0059 전)이면 숨김도 없다 — 값 무변경이 이긴다", async () => {
    ledgerAvailable.mockResolvedValue(false);
    const built = await buildPredicate();
    expect(built.sql).not.toMatch(/summary_cycle_runs/);
    expect(built.sql).not.toMatch(/hidden_reason/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 숨김 **범위**(0071) — 계열별 술어 (스펙 §5-C · §5-F)
// ════════════════════════════════════════════════════════════════════════════
//
// 이 블록이 잡는 뮤테이션 셋:
//   ④ `family` 에 기본값이 생기면 — 새 리더가 조용히 틀린 쪽을 먹는다(C5, 타입 레벨).
//   ⑤ 언급 계열에서 범위 절이 빠지면 — 8/24 언급 값이 다시 사라진다.
//   ⑥ 인용 계열에 범위 절이 붙으면 — 깨진 인용이 화면에 되돌아온다(고객 오도).
//   ⑦ 0071 미적용인데 절을 붙이면 — 42703 으로 전 화면이 미러 폴백/500 이 된다.
describe("숨김 범위(0071) — 계열별 미러 술어", () => {
  it("언급 계열: COALESCE(hidden_scope,'all') = 'all' 이 붙는다 (C1, 뮤테이션 ⑤)", async () => {
    await setScope(true);
    const built = await buildPredicate("mention");
    expect(built.sql).toMatch(
      /\(c\.hidden_reason IS NOT NULL AND COALESCE\(c\.hidden_scope, 'all'\) = 'all'\)/,
    );
    // 시각 규칙은 계열과 무관하게 그대로 — 숨김이 A3 를 대체하지 않는다.
    expect(built.sql).toMatch(/CASE c\.surface/);
    expect(built.sql).toMatch(/ELSE c\.status IN \(/);
  });

  it("인용 계열: 범위 절이 **없다** — 숨긴 회차는 전부 제외 (C2, 뮤테이션 ⑥)", async () => {
    await setScope(true);
    const built = await buildPredicate("citation");
    expect(built.sql).not.toMatch(/hidden_scope/);
    expect(built.sql).toMatch(/\(c\.hidden_reason IS NOT NULL OR CASE c\.surface/);
  });

  it("0071 미적용이면 두 계열 SQL 이 서로 같고 종전과 **문자열 동일** (C3, 뮤테이션 ⑦)", async () => {
    await setScope(false);
    const m = await buildPredicate("mention");
    const c = await buildPredicate("citation");
    expect(m.sql).toBe(c.sql);
    expect(m.sql).not.toMatch(/hidden_scope/);
    // 0070 만 적용된 오늘의 형태.
    expect(m.sql).toMatch(/\(c\.hidden_reason IS NOT NULL OR CASE c\.surface/);
    expect(m.sql.match(/hidden_reason/g)).toHaveLength(1);
  });

  it("0070 미적용이면 두 계열 다 숨김 절이 통째로 없다 (C4)", async () => {
    await setHidden(false);
    await setScope(true); // 있을 수 없는 조합이지만, 있어도 42703 이 나면 안 된다
    for (const family of ["mention", "citation"] as const) {
      const built = await buildPredicate(family);
      expect(built.sql).not.toMatch(/hidden_reason/);
      expect(built.sql).not.toMatch(/hidden_scope/);
      expect(built.sql).toMatch(/CASE c\.surface/);
    }
  });

  it("원장 미적용(0059 전)이면 계열과 무관하게 술어가 없다", async () => {
    ledgerAvailable.mockResolvedValue(false);
    await setScope(true);
    for (const family of ["mention", "citation"] as const) {
      const built = await buildPredicate(family);
      expect(built.sql).not.toMatch(/summary_cycle_runs/);
    }
  });

  it("교차 배포 4상태 전부 SQL 이 만들어진다 (F1)", async () => {
    const states: Array<[boolean, boolean, RegExp | null]> = [
      // [0070, 0071, 기대 지문]
      [false, false, null],
      [true, false, /\(c\.hidden_reason IS NOT NULL OR CASE/],
      [true, true, /COALESCE\(c\.hidden_scope, 'all'\) = 'all'/],
      // 0070✗ / 0071✓ — 마이그레이션 가드가 막는 조합. 그래도 죽지 않아야 한다.
      [false, true, null],
    ];
    for (const [h, sc, expected] of states) {
      await setHidden(h);
      await setScope(sc);
      const built = await buildPredicate("mention");
      expect(built.sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM summary_cycle_runs cr/);
      if (expected) expect(built.sql).toMatch(expected);
      else expect(built.sql).not.toMatch(/hidden_reason/);
    }
  });
});

describe("계열 델타 술어 — excludeCitationOnlyHiddenRuns", () => {
  it("범위가 citations 인 회차만 뺀다 — 시각 규칙(CASE)을 다시 얹지 않는다", async () => {
    await setScope(true);
    const built = await buildDelta();
    expect(built.sql).toMatch(/c\.hidden_reason IS NOT NULL/);
    expect(built.sql).toMatch(/COALESCE\(c\.hidden_scope, 'all'\) = 'citations'/);
    // ⑤ 는 인용 **행** 단위(수십만)라 표면 CASE 를 행마다 다시 평가하면 안 된다.
    expect(built.sql).not.toMatch(/CASE c\.surface/);
    expect(built.sql).not.toMatch(/view_anchor_at/);
  });

  it("0071 미적용이면 절이 통째로 없다 = 종전 SQL", async () => {
    await setScope(false);
    const built = await buildDelta();
    expect(built.sql).not.toMatch(/summary_cycle_runs/);
    expect(built.sql).toMatch(/SELECT 1 WHERE true/);
  });

  it("0070 미적용·원장 미적용에서도 절이 없다", async () => {
    await setScope(true);
    await setHidden(false);
    expect((await buildDelta()).sql).toMatch(/SELECT 1 WHERE true/);
    await setHidden(true);
    ledgerAvailable.mockResolvedValue(false);
    expect((await buildDelta()).sql).toMatch(/SELECT 1 WHERE true/);
  });
});

// ── 리더 → 계열 매핑 (스펙 §4-1 표) — 소스 대조 ──────────────────────────────
//
// 왜 소스 대조인가: 이 매핑이 틀려도 **정상 경로에서 값이 같다**(숨긴 회차가 없거나
// 범위가 all 이면 두 계열이 동일 SQL 이다). 원장이 citations 로 바뀐 뒤에야 갈리므로,
// 배선 자체를 텍스트로 못 박지 않으면 다음 리팩터가 조용히 되돌린다.
describe("리더 → 계열 매핑 (§4-1)", () => {
  const src = fsSrc();

  // [함수 선언, 기대 계열] — 스펙 §4-1 표 그대로.
  const cases: Array<[string, "mention" | "citation"]> = [
    ["export async function aggregateStandardTrendFromMirror(", "mention"],
    ["async function readCitationDomainDayCounts(", "citation"],
    ["async function readMentionBrandDayCounts(", "mention"],
    ["export async function aggregateCitationAccuracyTrend(", "citation"],
    ["export async function aggregateWebsiteCitationAccuracyTrend(", "citation"],
    ["async function kpiTabTrendWhere(", "mention"],
  ];

  it.each(cases)("%s → %s", (decl, family) => {
    const i = src.indexOf(decl);
    expect(i, `${decl} 를 못 찾았다 — 선언이 바뀌었으면 이 가드를 고칠 것`).toBeGreaterThanOrEqual(0);
    const rest = src.slice(i + decl.length);
    const j = rest.search(/\n(?:export )?(?:async )?function /);
    // 줄 주석 제거 — 주석에 적힌 호출 예시가 계열 판정에 섞이면 가드가 거짓말한다.
    const body = rest
      .slice(0, j === -1 ? rest.length : j)
      .split("\n")
      .map((l) => l.replace(/^\s*\/\/.*$/, ""))
      .join("\n");
    // 3번째 인자(앵커 축의 job_id 표기)가 붙어도 계열 판정은 그대로여야 한다 —
    // `"mention"` 뒤가 `)` 이거나 `,` 이거나 둘 다 받는다.
    const calls = body.match(/excludeHiddenCycleRuns\([^)]*"(mention|citation)"[^)]*\)/g) ?? [];
    expect(calls.length, `${decl} 에 excludeHiddenCycleRuns 호출이 없다`).toBeGreaterThan(0);
    for (const c of calls) expect(c, `${decl} 의 계열이 틀렸다: ${c}`).toContain(`"${family}"`);
  });

  it("ACR 추이는 언급 계열이다 — 브랜드 선택률의 입력은 인용이 아니다", () => {
    // ACR 은 `job_id` 가 없어 3번째 인자(답변 단위)가 비고 4번째(run 축 앵커 게이트)가
    // 붙는다 — 계열은 그대로 `mention` 이어야 한다.
    expect(src).toMatch(/excludeHiddenCycleRuns\(\s*sql`x\.run_id`,\s*"mention"/);
  });

  it("계열 인자에 기본값이 없다 (C5) — 새 리더는 컴파일 에러로 잡힌다", () => {
    const sig =
      /export async function excludeHiddenCycleRuns\([\s\S]*?\): Promise<SQL>/.exec(src)?.[0] ?? "";
    expect(sig.length).toBeGreaterThan(30);
    expect(sig).toMatch(/family: HiddenCycleFamily/);
    expect(sig, "family 에 기본값이 붙었다").not.toMatch(/family: HiddenCycleFamily\s*=/);
    expect(sig, "runIdCol 에 기본값이 붙었다").not.toMatch(/runIdCol: SQL\s*=/);
  });

  it("⑤(인용 문장)만 델타 술어를 한 겹 더 쓴다 — _answer_set 투영에 run_id 가 있다", () => {
    // 뒤에 조건부 조각이 붙을 수 있으므로(유닛 판정의 `a.prompt_id`) **접두만** 고정한다.
    // 이 가드가 지키는 것은 "투영에 run_id 가 있다" 이지 투영 목록의 끝이 아니다.
    expect(src).toMatch(/sql`a\.job_id, a\.run_id, a\.measured_at, \$\{bkt\} AS bucket/);
    expect(src).toMatch(/const citOnlyHidden = await excludeCitationOnlyHiddenRuns\(sql`a\.run_id`\)/);
    // c2 CTE(⑤ 인용)의 WHERE 에 걸린다.
    expect(src).toMatch(/FROM scope_citations c JOIN _answer_set a ON a\.job_id = c\.job_id\s*\n\s*WHERE \$\{citOnlyHidden\}/);
  });
});

function fsSrc(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  return fs.readFileSync(path.join(process.cwd(), "lib/db/repositories/scope-aggregates.ts"), "utf8");
}
