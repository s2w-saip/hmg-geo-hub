/**
 * 0080 — 발행 리포트 사실표를 **진짜 Postgres(pglite = wasm 빌드)** 에서 실행해 확인한다.
 *
 * 텍스트 검사로는 못 잡는 것만 여기서 본다:
 *   · 문장이 전부 **적용된다**(타입·제약·부분 인덱스 문법이 실제로 파싱·실행된다)
 *   · **재적용이 no-op 이다** — 인덱스·테이블 oid 가 그대로면 지웠다 다시 만들지 않았다는
 *     뜻이고, 그래야 `db:apply` 재실행이 안전하다(이 리포의 손 적용 체제의 전제).
 *   · **active 부분 유니크**가 실제로 두 번째 active 를 막는다. 이것이 없으면 정정 발행이
 *     앞 행을 안 내렸을 때 리더가 둘 중 하나를 임의로 골라 조용히 다른 숫자를 낸다.
 *   · CHECK 제약이 분자 > 분모를 막는다.
 *
 * ⚠️ 파일 전체를 **트랜잭션 안에서** 돌린다 — `SET LOCAL lock_timeout` + 가드 DO 블록이
 *    "npm run db:apply 로 적용됐는가" 를 단언하기 때문이다(0070~0072 와 같은 가드).
 *    그 경로를 흉내 내지 않으면 가드가 정당하게 터진다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationStatements } from "../../../scripts/db/answer-cycle-anchors-pglite-fixture";

const FILE = path.join(__dirname, "0080_report_publications.sql");
const raw = fs.readFileSync(FILE, "utf8");
/** REVOKE 는 뺀다 — pglite 에 anon/authenticated 롤이 없다. */
const statements = migrationStatements(raw);

type Db = {
  query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (s: string) => Promise<unknown>;
  close: () => Promise<void>;
};

async function newDb(applyTimes = 1): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite() as unknown as Db;
  for (let i = 0; i < applyTimes; i += 1) {
    await db.exec("BEGIN");
    for (const s of statements) await db.exec(s);
    await db.exec("COMMIT");
  }
  return db;
}

const rows = async <T>(db: Db, q: string, p?: unknown[]): Promise<T[]> =>
  (await db.query(q, p)).rows as T[];

const TABLES = ["report_publications", "report_site_facts", "report_site_engine_facts"];
const INDEXES = [
  "report_publications_slug_uq",
  "report_publications_active_uq",
  "report_publications_sha_idx",
  "report_site_facts_fs_idx",
];

const PUB = `
INSERT INTO report_publications
  (id, slug, surface, brand_scope, version, round_date, source_filename, source_sha256, sb_data_version)
VALUES ($1::uuid, $2, 'website', 'Global', 'v3.0', '2026-09-11', 'r.html', $3, 'vol2')`;

describe("0080 적용", () => {
  it("모든 문장이 적용되고 표 3개 + 인덱스 4개가 생긴다", async () => {
    const db = await newDb();
    try {
      expect(statements.length).toBeGreaterThan(5);
      const t = await rows<{ t: string }>(
        db,
        `SELECT tablename::text AS t FROM pg_tables WHERE tablename = ANY($1) ORDER BY 1`,
        [TABLES],
      );
      expect(t.map((r) => r.t)).toEqual([...TABLES].sort());
      const i = await rows<{ i: string }>(
        db,
        `SELECT indexname::text AS i FROM pg_indexes WHERE indexname = ANY($1) ORDER BY 1`,
        [INDEXES],
      );
      expect(i.map((r) => r.i)).toEqual([...INDEXES].sort());
    } finally {
      await db.close();
    }
  }, 120_000);

  it("재적용이 **아무것도 다시 만들지 않는다** (oid 불변 = 락도 안 잡았다)", async () => {
    const db = await newDb();
    try {
      const oids = async () =>
        rows<{ n: string; o: number }>(
          db,
          `SELECT c.relname::text AS n, c.oid::int AS o FROM pg_class c
            WHERE c.relname = ANY($1) ORDER BY 1`,
          [[...TABLES, ...INDEXES]],
        );
      const before = await oids();
      expect(before).toHaveLength(TABLES.length + INDEXES.length);

      // 2회차 적용 — 같은 DB 에 그대로 다시 돌린다.
      await db.exec("BEGIN");
      for (const s of statements) await db.exec(s);
      await db.exec("COMMIT");

      expect(await oids(), "재적용이 객체를 다시 만들었다").toEqual(before);
    } finally {
      await db.close();
    }
  }, 180_000);

  it("트랜잭션 밖에서 적용하면 가드가 막는다 (db:apply 우회 방지)", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite() as unknown as Db;
    try {
      // 암묵 트랜잭션에서는 `SET LOCAL` 이 그 문장에만 걸려 다음 문장이 기본값을 본다.
      await expect(
        (async () => {
          for (const s of statements) await db.exec(s);
        })(),
      ).rejects.toThrow(/0080/);
    } finally {
      await db.close();
    }
  }, 120_000);
});

describe("0080 제약 — 조용히 틀리는 형태를 표가 막는다", () => {
  it("(표면, 회차, 브랜드 범위) 당 active 는 하나뿐이다", async () => {
    const db = await newDb();
    try {
      await db.query(PUB, ["11111111-1111-4111-8111-111111111111", "a", "sha-a"]);
      // 같은 자리에 두 번째 active → 부분 유니크가 막는다.
      await expect(
        db.query(PUB, ["22222222-2222-4222-8222-222222222222", "b", "sha-b"]),
      ).rejects.toThrow(/report_publications_active_uq|unique/i);

      // 앞 행을 내리면 들어간다(정정 발행 경로).
      await db.query(
        `UPDATE report_publications SET status = 'superseded' WHERE slug = 'a'`,
      );
      await db.query(PUB, ["22222222-2222-4222-8222-222222222222", "b", "sha-b"]);
      const n = await rows<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM report_publications WHERE status = 'active'`,
      );
      expect(Number(n[0].n)).toBe(1);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("slug 은 전역 유일 · status 어휘가 고정돼 있다", async () => {
    const db = await newDb();
    try {
      await db.query(PUB, ["11111111-1111-4111-8111-111111111111", "a", "sha-a"]);
      await expect(
        db.query(
          `INSERT INTO report_publications
             (id, slug, surface, brand_scope, version, round_date, source_filename, source_sha256, sb_data_version)
           VALUES ('33333333-3333-4333-8333-333333333333','a','website','Hyundai','v3.0','2026-09-18','r.html','x','vol2')`,
        ),
      ).rejects.toThrow(/slug_uq|unique/i);
      await expect(
        db.query(`UPDATE report_publications SET status = 'draft' WHERE slug = 'a'`),
      ).rejects.toThrow(/status_ck|check/i);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("분자 > 분모를 CHECK 가 막는다 (손 INSERT 경로가 생겨도)", async () => {
    const db = await newDb();
    try {
      const id = "11111111-1111-4111-8111-111111111111";
      await db.query(PUB, [id, "a", "sha-a"]);
      const insert = (hit: number, den: number, own: number) =>
        db.query(
          `INSERT INTO report_site_facts
             (publication_id, file_seq, brand, target_hit_prompts, measured_prompts,
              owned_prompts, owned_prompts_den, raw)
           VALUES ($1::uuid, 1, 'Kia', $2, $3, $4, $3, '{}'::jsonb)`,
          [id, hit, den, own],
        );
      await expect(insert(21, 20, 5)).rejects.toThrow(/target_ck|check/i);
      await expect(insert(5, 20, 21)).rejects.toThrow(/owned_ck|check/i);
      await insert(10, 20, 15); // 정상은 들어간다
      const n = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM report_site_facts`);
      expect(Number(n[0].n)).toBe(1);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("PK 가 (publication_id, file_seq) — 같은 유닛이 두 번 들어가지 않는다", async () => {
    const db = await newDb();
    try {
      const id = "11111111-1111-4111-8111-111111111111";
      await db.query(PUB, [id, "a", "sha-a"]);
      const ins = () =>
        db.query(
          `INSERT INTO report_site_facts
             (publication_id, file_seq, brand, target_hit_prompts, measured_prompts,
              owned_prompts, owned_prompts_den, raw)
           VALUES ($1::uuid, 7, 'Kia', 1, 2, 1, 2, '{}'::jsonb)`,
          [id],
        );
      await ins();
      await expect(ins()).rejects.toThrow(/report_site_facts_pk|unique|duplicate/i);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("in_headline_pool 기본값은 true — 안 적으면 풀에 든다", async () => {
    const db = await newDb();
    try {
      const id = "11111111-1111-4111-8111-111111111111";
      await db.query(PUB, [id, "a", "sha-a"]);
      await db.query(
        `INSERT INTO report_site_facts
           (publication_id, file_seq, brand, target_hit_prompts, measured_prompts,
            owned_prompts, owned_prompts_den, raw)
         VALUES ($1::uuid, 1, 'Kia', 1, 2, 1, 2, '{}'::jsonb)`,
        [id],
      );
      const r = await rows<{ p: boolean }>(db, `SELECT in_headline_pool AS p FROM report_site_facts`);
      expect(r[0].p).toBe(true);
    } finally {
      await db.close();
    }
  }, 120_000);
});
