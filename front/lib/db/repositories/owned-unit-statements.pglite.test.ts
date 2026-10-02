// 유닛 단위 자사 판정(화면 키 `X.websiteOwnedUnit`)의 **on 문장 전수**가 진짜 Postgres
// (pglite)에서 이름·컬럼까지 해석되는가 (2026-09-20).
//
// 왜 필요한가: 이 리포의 집계 단위 테스트는 `db.execute` 를 mock 한다 — **문장이 문법적으로
// 성립하는지, 그 글자가 가리키는 컬럼이 실제로 있는지는 전혀 보지 않는다.** 같은 틈으로
// 이미 두 번 나갔다:
//   · 2026-09-20 축 on 글로벌 대시보드 `column "round_date" does not exist`(42703)
//   · 2026-09-20 인용 화면 `${ids}::uuid[]` 가 `($1,$2,…)::uuid[]` 로 펼쳐져 프리뷰 사망
// 유닛 판정은 CTE 둘(`wu`·`wup`)과 조인 하나를 **여섯 자리**에 새로 얹는다. 텍스트 가드
// (`website-owned-unit.sql-shape.test.ts`)는 그 조각이 붙었다는 것만 말할 뿐이다.
//
// `PREPARE` 를 쓰는 이유(실행이 아니라): 파싱 + 이름·컬럼 해석까지 하면서 행을 읽지 않는다.
// 42703/42P01/42883/42P18 을 전부 잡는다. 행 수준 동치는 `website-owned-unit.pglite.test.ts`
// (판정식 쌍둥이 대조)와 미러 실측 대조 SQL 이 담당한다.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { WebsiteOwnedUnit } from "@/lib/scope/website-owned-unit";
import {
  setWebsiteOwnedUnitForTests,
  resetWebsiteOwnedUnitForTests,
} from "@/lib/scope/website-owned-unit-state";
import { createTableFrom, MIG_DIR } from "@/scripts/db/answer-cycle-anchors-pglite-fixture";
import {
  SYNC_PROBED_COLUMNS,
  setColumnAvailabilityForTests,
  resetColumnAvailabilityForTests,
} from "@/lib/db/column-availability";

type Db = {
  exec: (s: string) => Promise<unknown>;
  query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  close: () => Promise<void>;
};

const dialect = new PgDialect();
const captured: Array<{ sql: string; params: unknown[] }> = [];
let stubRows: unknown[] = [];
const execute = vi.fn(async (q: SQL) => {
  try {
    const c = dialect.sqlToQuery(q);
    captured.push({ sql: c.sql, params: c.params });
  } catch {
    /* raw — 형태 검사 대상 아님 */
  }
  return stubRows as unknown as never;
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const MIRROR = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");
const mig = (f: string) => path.join(MIG_DIR, f);

/** 0052 의 정규화 함수 — 본문을 여기 복사하지 않고 원본 마이그레이션에서 읽어 온다. */
function normFnDdl(): string[] {
  const src = fs.readFileSync(mig("0052_scope_citations_url_norm.sql"), "utf8");
  return ["citation_url_norm", "citation_url_base_norm"].map((n) => {
    const m = src.match(
      new RegExp(`CREATE OR REPLACE FUNCTION ${n}\\(text\\)[\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$;`),
    );
    if (!m) throw new Error(`0052 에서 ${n} 정의를 못 찾았다`);
    return m[0];
  });
}

const PIDS = ["11111111-1111-1111-1111-111111111111"];
const BASES = ["kia.com/kr"];
const UNITS: WebsiteOwnedUnit[] = [
  { siteId: "22222222-2222-2222-2222-222222222222", fileSeq: 66,
    base: "kia.com/kr", sibs: ["kia.com/kr/en"], homeHost: null },
  { siteId: "33333333-3333-3333-3333-333333333333", fileSeq: 128,
    base: "hyundai-n.com", sibs: ["hyundai-n.com/ko"], homeHost: "hyundai-n.com" },
];

/** 빈 결과 조기 반환을 지나가게 하는 최소 행(값은 형태 검사에 쓰이지 않는다). */
const STUB_ROW = {
  region: "KR", answers: 1, tracked: 1, last_measured_at: null,
  domain: "kia.com", category: null, target: "chatgpt",
  citations: 1, owned: true, owned_citations: 1,
  prompt_id: "44444444-4444-4444-4444-444444444444",
  job_id: "55555555-5555-5555-5555-555555555555",
  url: "https://kia.com/kr", cites: 1, bucket_total: 1, targets: ["chatgpt"],
  day: "2026-09-11", key: "kia.com", n: 1,
  total: 1, with_cit: 1, bucket: "2026-09-08",
  measured_prompts: 1, hit_prompts: 1, owned_prompts: 1,
  owned_answers: 1, target_answers: 1, measured_days: 1, first_at: null, last_at: null,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 바인드를 리터럴로 되박는다. 배열은 `ARRAY[…]`, uuid 는 `::uuid` 캐스트까지. */
function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    if (v.length === 0) return "ARRAY[]::text[]";
    return `ARRAY[${v.map((x) => literal(x)).join(", ")}]`;
  }
  const s = String(v).replace(/'/g, "''");
  return UUID_RE.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
}

function inline(entry: { sql: string; params: unknown[] }): string {
  let out = entry.sql;
  for (let i = entry.params.length; i >= 1; i -= 1) {
    out = out.split(`$${i}`).join(literal(entry.params[i - 1]));
  }
  return out;
}

type SiteCall = (
  m: typeof import("./scope-aggregates"),
  u: WebsiteOwnedUnit[],
) => Promise<unknown>;

const SITES: Array<[string, SiteCall]> = [
  ["코어 ⑤", (m, u) => m.aggregateStandardFromMirror({}, PIDS, BASES, BASES, true, undefined, u)],
  ["Sub KPI Q4", (m, u) => m.aggregateSubKpisFromMirror({}, PIDS, BASES, BASES, true, {}, u)],
  ["⑤ 추이", (m, u) => m.aggregateStandardTrendFromMirror({}, "week", PIDS, BASES, BASES, true, undefined, u)],
  ["인용 화면", (m, u) => m.aggregateCitationsFromMirror({}, PIDS, BASES, BASES, true, undefined, u)],
  ["출처 구성", (m, u) => m.aggregateSourceCompositionFromMirror({}, PIDS, BASES, u)],
  ["⑥ 카드", (m, u) => m.aggregateWebsiteCitationAccuracy({}, PIDS, BASES, BASES, u)],
  ["⑥ 추이", (m, u) => m.aggregateWebsiteCitationAccuracyTrend({}, "week", PIDS, BASES, BASES, u)],
  ["자사·타겟 URL 인용률", (m, u) => m.aggregateWebsiteTargetHitRate({}, PIDS, BASES, BASES, u)],
];

let db: Db;
const statements = new Map<string, string[]>();

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite() as unknown as Db;

  const ddl: string[] = [
    ...["scope_runs", "scope_answers", "scope_mentions", "scope_citations", "scope_prompts"].map(
      (t) => createTableFrom(MIRROR, t),
    ),
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS project_id uuid;`,
    `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS cycle_anchor_at timestamptz;`,
    // 저널 밖 DDL(0044 가 회수한 것 + 0052) — 미러 DDL 파일에는 없다.
    ...[
      "brand_rollup_entity_id uuid",
      "surfaces text[]",
      "type_mention integer NOT NULL DEFAULT 0",
      "type_recommendation integer NOT NULL DEFAULT 0",
      "type_comparison integer NOT NULL DEFAULT 0",
      "type_definition integer NOT NULL DEFAULT 0",
      "type_final_choice integer NOT NULL DEFAULT 0",
    ].map((c) => `ALTER TABLE scope_mentions ADD COLUMN IF NOT EXISTS ${c};`),
    ...["category text", "url_norm text", "url_base_norm text"].map(
      (c) => `ALTER TABLE scope_citations ADD COLUMN IF NOT EXISTS ${c};`,
    ),
    ...["is_korean boolean", "regions text[]"].map(
      (c) => `ALTER TABLE scope_prompts ADD COLUMN IF NOT EXISTS ${c};`,
    ),
    createTableFrom(mig("0019_website_sites_prompts.sql"), "website_sites"),
    createTableFrom(mig("0019_website_sites_prompts.sql"), "website_prompts"),
    `ALTER TABLE website_prompts ADD COLUMN IF NOT EXISTS owned_base_url text;`,
    createTableFrom(mig("0059_summary_tables.sql"), "summary_cycles"),
    ...[
      "hidden_reason text",
      "hidden_scope text",
      "fleet_visible boolean",
      "view_anchor_at timestamptz",
      "active_generation_id uuid",
      "cycle_week date",
    ].map((c) => `ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS ${c};`),
    createTableFrom(mig("0059_summary_tables.sql"), "summary_cycle_runs"),
    // drizzle 스키마가 정본인 표 — 이 문장들이 읽는 컬럼만 둔다.
    `CREATE TABLE IF NOT EXISTS projects (
       id uuid PRIMARY KEY, name text, country text, scope_project_id uuid, industry_id uuid);`,
    `CREATE TABLE IF NOT EXISTS prompts (
       id uuid PRIMARY KEY, scope_prompt_id uuid, project_id uuid, brand text, list_type text,
       depth1 text, depth2 text, depth3 text, region text, country text, lang_code text,
       kind text, enabled boolean, funnel_stage text, brand_presence text);`,
    `CREATE TABLE IF NOT EXISTS prompt_custom_field_values (prompt_id uuid, field_id uuid, value text);`,
    `CREATE TABLE IF NOT EXISTS entity_registry (id uuid PRIMARY KEY, name text, role text);`,
    ...normFnDdl(),
    // `withAnswerSet` 의 TEMP 표 — 자리마다 투영이 다르므로 **상위집합**으로 만든다.
    `CREATE TABLE IF NOT EXISTS _answer_set (
       job_id uuid, run_id uuid, region text, measured_at timestamptz,
       prompt_id uuid, target text, bucket timestamptz, round_date date);`,
  ];
  for (const s of ddl) await db.exec(s);

  const m = await import("./scope-aggregates");
  // 컬럼 프로브가 술어 텍스트를 바꾸므로 한 번 가라앉힌다.
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 100));

  setWebsiteOwnedUnitForTests(true);
  stubRows = [STUB_ROW];
  // 정규화 컬럼(0052)의 **두 상태**를 모두 본다. 프로덕션은 컬럼 있음 경로로 돌지만,
  // "적용 전 배포" 창에서는 인라인 식 경로가 실제로 나간다(citationNormExpr 머리 주석).
  for (const cols of [false, true]) {
    for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, cols);
    for (const [name, call] of SITES) {
      await call(m, UNITS); // 예열(모듈 메모 프로브 문장 배제)
      captured.length = 0;
      await call(m, UNITS);
      statements.set(
        `${name} [정규화컬럼 ${cols ? "있음" : "없음"}]`,
        captured
          .map(inline)
          .filter((q) => /^\s*(SELECT|WITH)\b/i.test(q))
          .map((q) => q.trim()),
      );
    }
  }
  resetColumnAvailabilityForTests();
  stubRows = [];
}, 180_000);

afterAll(async () => {
  resetWebsiteOwnedUnitForTests();
  await db?.close();
});

describe("유닛 판정 on — 문장 전수가 진짜 파서를 통과한다", () => {
  it("자리마다 문장이 하나 이상 잡혔다 (조기 반환으로 비면 이 가드가 무의미하다)", () => {
    expect(statements.size).toBe(SITES.length * 2);
    for (const [name, qs] of statements) {
      expect(qs.length, `${name}: 문장 0개`).toBeGreaterThan(0);
    }
  });

  it("유닛 CTE 를 실제로 쓰는 문장이 자리마다 있다", () => {
    for (const [name, qs] of statements) {
      const hit = qs.filter((q) => q.includes("unit_base"));
      expect(hit.length, `${name}: 유닛 판정 문장 0개`).toBeGreaterThan(0);
    }
  });

  it("인라인 안 된 바인드가 없다", () => {
    for (const [name, qs] of statements) {
      for (const q of qs) expect(q, name).not.toMatch(/\$\d/);
    }
  });

  // 오늘 프리뷰를 죽인 형태 — 배열을 템플릿에 그대로 넣으면 `($1,$2,…)::uuid[]` 로 펼쳐진다.
  // `sql.param(...)` 를 쓰면 단일 바인드라 인라인 후 `ARRAY[…]::type[]` 이 된다.
  it("배열 캐스트 앞이 괄호 목록이 아니다 (sql.param 단일 바인드)", () => {
    for (const [name, qs] of statements) {
      for (const q of qs) {
        expect(q, `${name}: 배열 바인드가 펼쳐졌다`).not.toMatch(/\)::(uuid|text)\[\]/);
      }
    }
  });

  it("각 문장이 PREPARE 를 통과한다", async () => {
    const failed: string[] = [];
    let i = 0;
    for (const [name, qs] of statements) {
      for (const q of qs) {
        i += 1;
        const tag = `_ou${i}`;
        try {
          await db.exec(`PREPARE ${tag} AS ${q}`);
          await db.exec(`DEALLOCATE ${tag}`);
        } catch (e) {
          failed.push(`${name}#${i}: ${String((e as Error).message).split("\n")[0]}`);
        }
      }
    }
    expect(failed, failed.join("\n")).toEqual([]);
  }, 120_000);
});
