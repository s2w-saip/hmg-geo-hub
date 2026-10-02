// 축 on 문장 **전수**가 진짜 Postgres(pglite)에서 이름·컬럼까지 해석되는가 (2026-09-20).
//
// 고치는 결함: 축을 켠 글로벌 `/ko/dashboard` 가 회차를 포함한 주 단위 창에서
// `column "round_date" does not exist`(42703)로 통째로 죽었다.
//
// **문장 텍스트 스냅샷은 컬럼의 존재를 검증하지 않는다.** 78건 스냅샷도, 축 on 스냅샷도,
// 소스 대조 가드도 전부 통과한 채로 프로덕션에서 터졌다. 컬럼이 실제로 있는지는
// 파서·플래너가 이름을 해석해 봐야 안다 — 그게 `PREPARE` 다.
//
// 여기서 `PREPARE` 를 쓰는 이유(실행이 아니라):
//   · 파싱 + **이름·컬럼 해석**까지 한다 — 42703/42P01/42883 을 전부 잡는다.
//   · 행을 읽지 않으므로 픽스처 데이터가 필요 없고 빠르다.
//   (행 수준 동작은 `scope-aggregates.answer-set.pglite.test.ts` 가 실제 실행으로 본다.)
//
// 스키마는 **원본 DDL 에서 읽어 온다** — 타입을 여기 복사하지 않는다(픽스처와 같은 규율).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildAxisOnStatements,
  type AxisOnStatement,
} from "@/scripts/db/axis-on-sql-manifest";
import {
  createTableFrom,
  statementsOf,
  MIG_DIR,
} from "@/scripts/db/answer-cycle-anchors-pglite-fixture";

type Db = { exec: (s: string) => Promise<unknown>; close: () => Promise<void> };

const MIRROR = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");
const mig = (f: string) => path.join(MIG_DIR, f);

/**
 * 0077 의 함수 정의를 **이름으로** 골라 온다. 본문을 여기 복사하지 않는다 —
 * 요일 상수(`hmg_round_canonical_dow`)를 복사하면 그 순간 두 벌이 되고, 그것이
 * 이 트랙에서 이미 한 번 값을 틀리게 만든 종류의 결함이다.
 */
function anchorFnDdl(names: readonly string[]): string[] {
  const stmts = statementsOf(mig("0077_scope_answer_cycle_anchors.sql"));
  return names.map((n) => {
    const found = stmts.find((s) =>
      new RegExp(`^CREATE OR REPLACE FUNCTION ${n}\\s*\\(`, "m").test(s),
    );
    if (!found) throw new Error(`0077 에서 ${n} 정의를 못 찾았다`);
    return found;
  });
}

/** 0077 의 앵커 표 — 픽스처와 같은 파일에서 읽는다. */
function anchorTableDdl(): string {
  const src = fs.readFileSync(mig("0077_scope_answer_cycle_anchors.sql"), "utf8");
  const m = src.match(/CREATE TABLE scope_answer_cycle_anchors \([\s\S]*?\n {4}\);/);
  if (!m) throw new Error("0077 의 scope_answer_cycle_anchors DDL 을 못 찾았다");
  return m[0].replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS");
}

let db: Db;
let stmts: AxisOnStatement[];

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite() as unknown as Db;

  const ddl: string[] = [
    // 미러 5표 — `scope-mirror.sql` 에서 표별로 뜯어 온다(파일 전체를 exec 하면
    // GRANT/REVOKE 의 anon 롤이 없어 중간에 끊긴다).
    ...[
      "scope_runs",
      "scope_answers",
      "scope_mentions",
      "scope_citations",
      "scope_prompts",
      "scope_mention_occurrences",
    ].map((t) => createTableFrom(MIRROR, t)),
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS project_id uuid;`,
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS cycle_anchor_at timestamptz;`,
    createTableFrom(mig("0025_prompt_kind_acr_rollups.sql"), "scope_acr_rollups"),
    createTableFrom(mig("0019_website_sites_prompts.sql"), "website_sites"),
    createTableFrom(mig("0019_website_sites_prompts.sql"), "website_prompts"),
    createTableFrom(mig("0059_summary_tables.sql"), "summary_cycles"),
    createTableFrom(mig("0059_summary_tables.sql"), "summary_cycle_runs"),
    // 0059 이후에 ALTER 로 붙은 컬럼들(0070 hidden_reason 등). 이 문장들이 읽는 것만.
    ...[
      "hidden_reason text",
      "hidden_scope text",
      "fleet_visible boolean",
      "view_anchor_at timestamptz",
      "active_generation_id uuid",
      "cycle_week date",
    ].map((c) => `ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS ${c};`),
    // drizzle 스키마가 정본인 표 — 이 문장들이 읽는 컬럼만 둔다(픽스처 `baseSchema` 와 같은 자세).
    `CREATE TABLE IF NOT EXISTS projects (
       id uuid PRIMARY KEY, name text, country text, scope_project_id uuid, industry_id uuid);`,
    `CREATE TABLE IF NOT EXISTS prompts (
       id uuid PRIMARY KEY, scope_prompt_id uuid, project_id uuid, brand text, list_type text,
       depth1 text, depth2 text, depth3 text, region text, country text, lang_code text,
       kind text, enabled boolean);`,
    `CREATE TABLE IF NOT EXISTS prompt_custom_field_values (prompt_id uuid, field_id uuid, value text);`,
    anchorTableDdl(),
    // 0077 의 날짜 함수들 — 본문은 **원본 마이그레이션에서 읽어 온다**(픽스처와 같은
    // 규율). 추이 격자 문장이 `hmg_anchor_week`·`hmg_round_canonical_dow` 를 쓰므로
    // 반환 타입만 맞춘 대역으로는 자리 날짜 산술이 검증되지 않는다.
    ...anchorFnDdl([
      "hmg_anchor_timezone",
      "hmg_anchor_date",
      "hmg_anchor_today",
      "hmg_anchor_week",
      "hmg_round_canonical_dow",
    ]),
  ];
  for (const s of ddl) await db.exec(s);

  stmts = await buildAxisOnStatements();
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("축 on 문장 전수 — 이름·컬럼이 해석된다", () => {
  it("문장 목록이 비지 않는다", () => {
    expect(stmts.length).toBeGreaterThanOrEqual(12);
  });

  it("규약: 단일 문장·세미콜론 없음·SELECT/WITH 로 시작", () => {
    for (const s of stmts) {
      expect(s.body, s.name).not.toContain(";");
      expect(s.body.trimStart(), s.name).toMatch(/^(SELECT|WITH)\b/);
    }
  });

  it("규약: 인라인 안 된 바인드가 없다", () => {
    for (const s of stmts) expect(s.body, s.name).not.toMatch(/\$\d/);
  });

  it("uuid 비교 자리에 ::uuid 캐스트가 있다 (지난 덤프가 uuid = text[] 로 깨졌다)", () => {
    const bare = /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'(?!::uuid)/i;
    for (const s of stmts) expect(bare.test(s.body), `${s.name}: 캐스트 없는 uuid 리터럴`).toBe(false);
  });

  it("전부 축 on 문장이다 — 앵커 표를 본다", () => {
    for (const s of stmts) {
      expect(s.body, s.name).toMatch(/scope_answer_cycle_anchors|ca\.round_date/);
    }
  });

  // ── 추이 격자 자리 목록 (미러 실측 2026-09-20 이 잡은 결함 둘) ─────────────
  //
  // PREPARE 는 "이름이 해석되는가" 만 본다 — **어느 열을 골랐는가**는 못 본다.
  // 초판이 정확히 그 틈으로 나갔다: 문장은 멀쩡히 돌았고 `anchor_week` 만 한 주
  // 어긋난 값을 냈다. 그래서 텍스트로도 못 박는다.
  describe("13·14 자리 목록", () => {
    const grid = (): AxisOnStatement[] =>
      stmts.filter((s) => s.name.includes("trend-grid-slots"));

    it("anchor_week 는 round_date 에서 파생한다 — 원장 cycle_week 가 아니다", () => {
      for (const s of grid()) {
        expect(s.body, s.name).toContain("hmg_anchor_week(g.round_date)");
        expect(s.body, s.name).not.toContain("cycle_week");
      }
    });

    it("앵커 행이 없으면 같은 주의 **정규 요일**로 스냅한다", () => {
      for (const s of grid()) {
        expect(s.body, s.name).toContain("hmg_round_canonical_dow(");
        expect(s.body, s.name).toContain("hmg_anchor_week(");
        // 귀속이 있는 회차를 셀 수 있어야 판정이 후보를 버릴 수 있다.
        expect(s.body, s.name).toContain("assigned_cycles");
      }
    });

    // 원장은 `global`, 앵커 쪽 요일 함수는 `standard` 다. 여기가 어긋나면
    // `hmg_round_canonical_dow` 가 NULL 을 내고 글로벌 스냅이 앵커 요일로 떨어진다.
    it("글로벌은 요일 함수에 'standard' 를 넘긴다", () => {
      const g = grid().find((s) => s.name.includes("global"));
      expect(g?.body).toContain("hmg_round_canonical_dow('standard')");
      expect(g?.body).toContain("c.surface = 'global'");
      const w = grid().find((s) => s.name.includes("website"));
      expect(w?.body).toContain("hmg_round_canonical_dow('website')");
    });
  });

  it("각 문장이 PREPARE 를 통과한다", async () => {
    const failed: string[] = [];
    for (const s of stmts) {
      try {
        await db.exec(`PREPARE _c AS ${s.body}`);
        await db.exec(`DEALLOCATE _c`);
      } catch (e) {
        failed.push(`${s.name}: ${String((e as Error).message).split("\n")[0]}`);
      }
    }
    expect(failed, failed.join("\n")).toEqual([]);
  }, 120_000);
});
