// 우선 노출도 = 답변 안 **경쟁 순위** (2026-09-28 제품 책임자 A안): 실제 문장을 pglite 에서 돌린다.
//
// `aggregateFirstPositionFromMirror` 가 **실제로 발행하는** 스냅샷·추이 문장을 그대로
// 진짜 Postgres(pglite)에서 실행한다. 답변셋(`_answer_set`)만 픽스처로 대신 만든다.
// 답변셋 술어(`detailAnswerWhere`)는 이 변경이 건드리지 않았고, 여기서 보려는 것은 언급
// 쪽 문장(per → rk → 브랜드 평균)이다.
//
// 이 파일이 고정하는 것:
//   ① 서수와 경쟁 순위가 갈리는 픽스처: 한 브랜드가 먼저 나오고 뒤에서(모델 롤업 행으로)
//      반복돼도 그 답변의 순위는 1 이다. 본문 위치(10·30·40)는 값에 안 들어간다.
//   ② 답변 안 동률은 공동 순위이고 다음 순위를 건너뛴다 · avg_position NULL 은 순위를 안 받는다.
//   ③ series cap 밖 브랜드도 순위 모집단이다: cap 이 순위를 바꾸면 안 된다.
//   ④ 추이도 (bucket, name, job) 에 같은 규칙. 추이 픽스처에도 **답변 안 동률**이 있어
//      `rank` 를 `dense_rank` 로 바꾸는 변이를 실행으로 잡는다(정적 단언만으로는 못 잡았다).
//
// DB 드라이버는 drizzle(pglite)로 감싼다: raw execute 의 timestamptz 가 프로덕션
// (postgres-js)처럼 문자열로 오게 하기 위해서다.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  createTableFrom,
  statementsOf,
  MIG_DIR,
} from "@/scripts/db/answer-cycle-anchors-pglite-fixture";
import { HMG_BRAND_ENTITY_IDS } from "@/lib/scope/hmg-brands";

type PgliteLike = {
  exec: (s: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const dialect = new PgDialect();
let pg: PgliteLike;
let drz: { execute: (q: SQL) => Promise<{ rows: unknown[] }> };
/** 다음 `CREATE TEMP TABLE _answer_set` 가 만들 픽스처(스냅샷·추이 각각). */
const fixture = { snap: "", trend: "" };

async function exec(q: SQL): Promise<unknown[]> {
  const { sql: text } = dialect.sqlToQuery(q);
  // SET LOCAL work_mem 은 pglite 에서도 실행해 문법을 확인한다(트랜잭션 밖이라 효과는 없다).
  if (/^\s*SET LOCAL work_mem/i.test(text)) return (await drz.execute(q)).rows;
  if (/^\s*SET LOCAL/i.test(text)) return [];
  if (text.includes("CREATE TEMP TABLE _answer_set")) {
    await pg.exec("DROP TABLE IF EXISTS _answer_set");
    await pg.exec(/AS bucket/.test(text) ? fixture.trend : fixture.snap);
    return [];
  }
  if (/^\s*ANALYZE _answer_set/.test(text)) return [];
  // 언급 쪽 문장은 **컴파일된 그대로**(파라미터 포함) 실행한다.
  if (text.includes("_answer_set")) return (await drz.execute(q)).rows;
  // 그 밖(컬럼 가용성·축·격자 프로브)은 빈 결과 = 종전 축(kpi-tabs 테스트와 같은 자세).
  return [];
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: exec,
    transaction: async (cb: (t: { execute: typeof exec }) => Promise<unknown>) => cb({ execute: exec }),
  }),
}));

const MIRROR = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");

const HY = HMG_BRAND_ENTITY_IDS.Hyundai;
const TESLA = "0b000000-0000-4000-8000-000000000001";
const TOYOTA = "0b000000-0000-4000-8000-000000000002";
const VOLVO = "0b000000-0000-4000-8000-000000000003";
const TUCSON = "0c000000-0000-4000-8000-000000000001"; // Product → Hyundai 롤업

const job = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const prompt = (n: number) => `0d000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** (job, entity, brand, type, rollup, pos, mc) */
type M = [number, string, string, "Brand" | "Product", string, number | null, number];
const MENTIONS: M[] = [
  // J1: Hyundai 가 **먼저**(1) 나오고 뒤에서 모델 행으로 반복(25). Tesla 10, Toyota 30.
  [1, HY, "Hyundai", "Brand", HY, 1, 2],
  [1, TUCSON, "Hyundai Tucson", "Product", HY, 25, 1],
  [1, TESLA, "Tesla", "Brand", TESLA, 10, 1],
  [1, TOYOTA, "Toyota", "Brand", TOYOTA, 30, 1],
  // J2: Tesla 2, Toyota 5, Hyundai 40.
  [2, TESLA, "Tesla", "Brand", TESLA, 2, 1],
  [2, TOYOTA, "Toyota", "Brand", TOYOTA, 5, 1],
  [2, HY, "Hyundai", "Brand", HY, 40, 1],
  // J3: 답변 안 동률: Tesla·Toyota 3, Hyundai 7.
  [3, TESLA, "Tesla", "Brand", TESLA, 3, 1],
  [3, TOYOTA, "Toyota", "Brand", TOYOTA, 3, 1],
  [3, HY, "Hyundai", "Brand", HY, 7, 1],
  // J4: Volvo 는 위치 NULL(순위 없음), Tesla 4.
  [4, VOLVO, "Volvo", "Brand", VOLVO, null, 2],
  [4, TESLA, "Tesla", "Brand", TESLA, 4, 1],
  // J5: cap 밖(언급 최소) Volvo 가 **가장 먼저**(0.5) 나온다. 위치(12·20·31)는 순위와 겹치지
  //     않게 골랐다: 서수로 되돌리는 변이도, cap 뒤에 순위를 매기는 변이(1·2)도 잡힌다.
  [5, VOLVO, "Volvo", "Brand", VOLVO, 0.5, 1],
  [5, HY, "Hyundai", "Brand", HY, 12, 10],
  [5, TESLA, "Tesla", "Brand", TESLA, 20, 9],
  [5, TOYOTA, "Toyota", "Brand", TOYOTA, 31, 8],
];

const snapSet = (jobs: number[]) => `
  CREATE TEMP TABLE _answer_set AS
  SELECT v.job_id::uuid AS job_id FROM (VALUES ${jobs.map((j) => `('${job(j)}')`).join(", ")}) v(job_id)`;

/** (job, bucket): 답변마다 다른 프롬프트라 셀 dedup 에 안 걸린다. */
const trendSet = (rows: Array<[number, string]>) =>
  rows.length === 0
    ? `CREATE TEMP TABLE _answer_set (job_id uuid, prompt_id uuid, target text, region text,
         measured_at timestamptz, bucket timestamptz)`
    : `
  CREATE TEMP TABLE _answer_set AS
  SELECT v.job_id::uuid AS job_id, v.prompt_id::uuid AS prompt_id, 'chatgpt'::text AS target,
         'US'::text AS region, v.bucket::timestamptz AS measured_at, v.bucket::timestamptz AS bucket
  FROM (VALUES ${rows
    .map(([j, b]) => `('${job(j)}', '${prompt(j)}', '${b}')`)
    .join(", ")}) v(job_id, prompt_id, bucket)`;

const W1 = "2026-09-07T00:00:00Z";
const W2 = "2026-09-14T00:00:00Z";

let agg: typeof import("./scope-aggregates");

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  pg = client as unknown as PgliteLike;
  drz = drizzle(client) as unknown as typeof drz;
  await pg.exec(createTableFrom(MIRROR, "scope_mentions"));
  // 0044 가 나중에 붙인 scope_mentions 컬럼(brand_rollup_entity_id · type_*): 원본에서 읽는다.
  for (const s of statementsOf(path.join(MIG_DIR, "0044_out_of_band_columns_backfill.sql"))) {
    if (s.includes('"scope_mentions"')) await pg.exec(s);
  }
  const values = MENTIONS.map(
    ([j, e, b, t, r, p, mc]) =>
      `('${job(j)}', '${e}', '${b.replace(/'/g, "''")}', '${t}', '${r}', ${p ?? "NULL"}, ${mc})`,
  ).join(",\n");
  await pg.exec(`INSERT INTO scope_mentions
    (job_id, entity_id, brand, entity_type, brand_rollup_entity_id, avg_position, mention_count)
    VALUES ${values}`);
  agg = await import("./scope-aggregates");
}, 180_000);

afterAll(async () => {
  await pg?.close();
});

const at = (rows: Array<{ brand: string }>, b: string) => rows.find((r) => r.brand === b)!;

describe("우선 노출도 스냅샷: 답변 안 경쟁 순위", () => {
  it("① 먼저 나오고 뒤에서 반복된 브랜드는 그 답변 1위다(본문 서수가 아니다)", async () => {
    fixture.snap = snapSet([1, 2]);
    fixture.trend = trendSet([]);
    const out = await agg.aggregateFirstPositionFromMirror({}, "p1", {});
    // J1: Hyundai 1 · Tesla 2 · Toyota 3 / J2: Tesla 1 · Toyota 2 · Hyundai 3
    expect(at(out.latest, "Hyundai").avgPosition).toBe(2);
    expect(at(out.latest, "Tesla").avgPosition).toBe(1.5);
    expect(at(out.latest, "Toyota").avgPosition).toBe(2.5);
    for (const b of ["Hyundai", "Tesla", "Toyota"]) expect(at(out.latest, b).rankedAnswers).toBe(2);
    // 종전 서수 축이었다면 Hyundai 26.5 · Tesla 6 · Toyota 17.5 이고 순서가 Tesla·Toyota·Hyundai 다.
    expect(out.latest.map((r) => [r.brand, r.rank])).toEqual([
      ["Tesla", 1],
      ["Hyundai", 2],
      ["Toyota", 3],
    ]);
    // 언급 수는 종전 의미 그대로(모델 롤업 행 포함 합).
    expect(at(out.latest, "Hyundai").mentions).toBe(4);
  });

  it("② 답변 안 동률은 공동 순위이고 다음을 건너뛴다", async () => {
    fixture.snap = snapSet([3]);
    fixture.trend = trendSet([]);
    const out = await agg.aggregateFirstPositionFromMirror({}, "p1", {});
    expect(at(out.latest, "Tesla").avgPosition).toBe(1);
    expect(at(out.latest, "Toyota").avgPosition).toBe(1);
    expect(at(out.latest, "Hyundai").avgPosition).toBe(3);
  });

  it("② avg_position NULL 인 브랜드는 순위를 받지 않고, 다른 브랜드 순위도 밀지 않는다", async () => {
    fixture.snap = snapSet([4]);
    fixture.trend = trendSet([]);
    const out = await agg.aggregateFirstPositionFromMirror({}, "p1", {});
    expect(at(out.latest, "Tesla").avgPosition).toBe(1);
    const volvo = at(out.latest, "Volvo") as { avgPosition: number | null; rank: number | null; rankedAnswers: number; mentions: number };
    expect(volvo.avgPosition).toBeNull();
    expect(volvo.rank).toBeNull();
    expect(volvo.rankedAnswers).toBe(0);
    expect(volvo.mentions).toBe(2);
  });

  it("③ series cap 밖 브랜드도 순위 모집단이다(cap 이 순위를 바꾸지 않는다)", async () => {
    fixture.snap = snapSet([5]);
    // cap 선정은 추이 창의 언급 합으로 한다: 같은 답변을 추이에도 싣는다.
    fixture.trend = trendSet([[5, W1]]);
    const out = await agg.aggregateFirstPositionFromMirror({}, "p1", { topBrands: 2 });
    // Volvo 는 언급이 가장 적어 cap(2) 밖이다: 행으로는 안 나온다.
    expect(out.brands).not.toContain("Volvo");
    expect(out.latest.map((r) => r.brand)).not.toContain("Volvo");
    // 그러나 J5 에서 가장 먼저 나왔으므로 Hyundai 는 2위, Tesla 는 3위다(cap 후 재순위면 1·2).
    expect(at(out.latest, "Hyundai").avgPosition).toBe(2);
    expect(at(out.latest, "Tesla").avgPosition).toBe(3);
    const w1 = out.buckets[0]!.brands;
    expect(at(w1, "Hyundai").avgPosition).toBe(2);
    expect(at(w1, "Tesla").avgPosition).toBe(3);
  });
});

describe("우선 노출도 추이: (bucket, name, job) 에 같은 규칙", () => {
  it("④ 회차마다 답변 안 경쟁 순위의 평균이다(동률 포함)", async () => {
    fixture.snap = snapSet([1]);
    fixture.trend = trendSet([
      [1, W1],
      [2, W1],
      [3, W2],
      [4, W2],
    ]);
    const out = await agg.aggregateFirstPositionFromMirror({}, "p1", {});
    expect(out.buckets.map((b) => b.bucketStart)).toEqual(["2026-09-07", "2026-09-14"]);
    const [w1, w2] = [out.buckets[0]!.brands, out.buckets[1]!.brands];
    expect(at(w1, "Hyundai").avgPosition).toBe(2);
    expect(at(w1, "Tesla").avgPosition).toBe(1.5);
    expect(at(w1, "Toyota").avgPosition).toBe(2.5);
    expect(at(w1, "Hyundai").rankedAnswers).toBe(2);
    // W2 = J3(Tesla·Toyota 공동 1, Hyundai 3) + J4(Tesla 1, Volvo 순위 없음).
    // dense_rank 였다면 J3 의 Hyundai 가 2 다.
    expect(at(w2, "Tesla").avgPosition).toBe(1);
    expect(at(w2, "Toyota").avgPosition).toBe(1);
    expect(at(w2, "Hyundai").avgPosition).toBe(3);
    expect(at(w2, "Volvo").avgPosition).toBeNull();
    expect(at(w2, "Volvo").rankedAnswers).toBe(0);
    // 스냅샷(J1 하나): Hyundai 1 · Tesla 2 · Toyota 3.
    expect(out.latest.map((r) => [r.brand, r.avgPosition])).toEqual([
      ["Hyundai", 1],
      ["Tesla", 2],
      ["Toyota", 3],
      ["Volvo", null],
    ]);
  });
});
