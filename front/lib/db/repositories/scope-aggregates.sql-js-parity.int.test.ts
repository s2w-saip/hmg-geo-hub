// 경계 규칙 SQL↔JS 등가를 **실 DB(read-only)** 로 강제한다.
// DATABASE_URL 이 있을 때만 실행 (무DB skip). 로컬:
//   DATABASE_URL=... npx vitest run lib/db/repositories/scope-aggregates.sql-js-parity.int.test.ts
//
// 왜 단위테스트로 부족한가: 오프라인 테스트(lib/scope/name-boundary-parity.test.ts)
// 는 POSIX 클래스를 JS 클래스로 **치환한 쌍둥이**와 대조한다. 그 치환의 타당성
// (`[[:alnum:]]` ≡ `[\p{L}\p{Nd}]`, `btrim(col, JS_TRIM_CHARS)` ≡ `.trim()`)은
// Postgres 의 ctype 에 달려 있어 **DB 에서 돌려봐야만** 알 수 있다.
// citation-group-key.parity.int.test.ts 가 세운 선례와 같은 자세다.
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { hmgBrandByNamePrefix } from "@/lib/scope/hmg-brands";
import { isNonCompetitorMention } from "@/lib/scope/non-competitor-brands";
import { JS_TRIM_CHARS, NAME_BOUNDARY_CLASS } from "@/lib/scope/text-trim";
import { canonRollupSql, excludeNonCompetitorBrandsSql } from "./scope-aggregates";

const hasDb = !!process.env.DATABASE_URL;

// 경계·공백·부분일치 격자. 2026-08-29 이전에 SQL↔JS 가 갈렸던 6건을 포함한다.
const PROBES = [
  "Genesis", "Kia", "Hyundai", "현대", "기아", "제네시스",
  "Genesis G70", "Genesis-G70", "Genesis(G70)", "Kia EV6", "현대 아이오닉 5",
  "Hyundai_N", "Kia/Charge", "제네시스 GV80", "Kia Charge", "Hyundai Canada",
  "Genesisian", "Kiabi", "Hyundaia", "현대차량", "기아자동차판매",
  "Genesis2", "Kia6", "현대1", "Genesis٣", "Kia１",
  "  Genesis", " Kia", "\t현대", "Genesis ", "Genesis X", "Genesis﻿",
  "Genesis²", "GenesisⅡ", "Genesis①", "Genesis½",
  "Toyota", "Tesla Model 3", "Dacia Spring Essential", "X Gran Berlinetta Concept",
  "Smart Fortwo", "Smartphone", "Smart", "Cruise Origin",
];

describe.skipIf(!hasDb)("표기 경계 — SQL ↔ JS parity (실 DB)", { timeout: 120_000 }, () => {
  it("POSIX [[:alnum:]] 는 [\\p{L}\\p{Nd}] 와 같다 (치환의 전제)", async () => {
    const chars = [
      "2", "٣", "１", "가", "一", "é", "ß", "²", "①", "½", "Ⅱ", " ", "-", "_", "・",
    ];
    const rows = (await getDb().execute(sql`
      SELECT c, (c ~ '[[:alnum:]]') AS pg
      FROM unnest(ARRAY[${sql.join(chars.map((c) => sql`${c}`), sql`, `)}]) AS c
    `)) as unknown as Array<{ c: string; pg: boolean }>;
    const js = new RegExp(`^[${NAME_BOUNDARY_CLASS}]$`, "u");
    expect(rows.map((r) => [r.c, r.pg])).toEqual(rows.map((r) => [r.c, js.test(r.c)]));
  });

  it("btrim(col, JS_TRIM_CHARS) 는 String.prototype.trim() 과 같다", async () => {
    const rows = (await getDb().execute(sql`
      SELECT v, btrim(v, ${JS_TRIM_CHARS}) AS t
      FROM unnest(ARRAY[${sql.join(PROBES.map((p) => sql`${p}`), sql`, `)}]) AS v
    `)) as unknown as Array<{ v: string; t: string }>;
    const offenders = rows.filter((r) => r.t !== r.v.trim());
    expect(offenders).toEqual([]);
  });

  it("canonRollupSql 접두 판정이 hmgBrandByNamePrefix 와 전 프로브 일치", async () => {
    // rollup 이 NULL 이 아닌 가짜 행을 만들어 접두 CASE 만 실행시킨다
    // (NULL 이면 아래 NULL 보존 단락에서 먼저 잘린다 — 그건 다음 테스트가 본다).
    const probe = sql.join(
      PROBES.map((p) => sql`(${p}, '00000000-0000-0000-0000-0000000000ff'::uuid)`),
      sql`, `,
    );
    const rows = (await getDb().execute(sql`
      WITH m(brand, brand_rollup_entity_id) AS (VALUES ${probe})
      SELECT m.brand, ${canonRollupSql({})}::text AS canon FROM m
    `)) as unknown as Array<{ brand: string; canon: string | null }>;
    const ID = {
      Hyundai: "00000000-0000-0000-0000-000000000301",
      Kia: "00000000-0000-0000-0000-000000000302",
      Genesis: "00000000-0000-0000-0000-000000000304",
    } as const;
    const offenders = rows.filter((r) => {
      const jsBrand = hmgBrandByNamePrefix(r.brand);
      const expected = jsBrand ? ID[jsBrand] : "00000000-0000-0000-0000-0000000000ff";
      return r.canon !== expected;
    });
    expect(offenders).toEqual([]);
  });

  it("canonRollupSql 은 NULL 롤업을 보존한다 (표기가 당사여도)", async () => {
    const rows = (await getDb().execute(sql`
      WITH m(brand, brand_rollup_entity_id) AS (
        VALUES ('Kia EV series', NULL::uuid), ('현대 N', NULL::uuid),
               ('Hyundai Creta N Line', NULL::uuid), ('adaptive cruise control', NULL::uuid)
      )
      SELECT m.brand, ${canonRollupSql({})} IS NULL AS canon_null FROM m
    `)) as unknown as Array<{ brand: string; canon_null: boolean }>;
    expect(rows.every((r) => r.canon_null === true)).toBe(true);
  });

  it("미러 전수: Brand·Product 행은 rollup NULL 이 없다 (IS NOT NULL 가드의 의미)", async () => {
    const rows = (await getDb().execute(sql`
      SELECT entity_type,
        count(*) FILTER (WHERE brand_rollup_entity_id IS NULL)::int AS null_rollup
      FROM scope_mentions WHERE entity_type IN ('Brand','Product') GROUP BY 1
    `)) as unknown as Array<{ entity_type: string; null_rollup: number }>;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.null_rollup === 0)).toBe(true);
  });

  it("비경쟁 제외 술어가 JS 쌍둥이(isNonCompetitorMention)와 일치", async () => {
    const pairs: Array<[string, string]> = [
      ["Smart", "Smart"], ["Smart", "Smart Fortwo"], ["Smart", "Smartphone"],
      ["Smart", "Smart²"], ["Cruise", "Cruise Origin"], ["Cruise", "2nd gen"],
      ["Fahren", "Dacia Spring Essential"], ["Hyundai", "Hyundai Aura"],
      ["Kia", "Kia Carens Clavis EV"], ["Apple", "Apple CarPlay"],
      ["Toyota", "Toyota Corolla"], ["  Smart", "Smart Fortwo"],
    ];
    const vals = sql.join(pairs.map(([b, o]) => sql`(${b}, ${o})`), sql`, `);
    const rows = (await getDb().execute(sql`
      WITH m(rollup_name, brand) AS (VALUES ${vals})
      SELECT m.rollup_name, m.brand,
        NOT (${excludeNonCompetitorBrandsSql(sql`m.rollup_name`, sql`m.brand`)}) AS excluded
      FROM m
    `)) as unknown as Array<{ rollup_name: string; brand: string; excluded: boolean }>;
    const offenders = rows.filter(
      (r) => r.excluded !== isNonCompetitorMention(r.rollup_name, r.brand),
    );
    expect(offenders).toEqual([]);
  });

  it("제외 rollup 밑 당사 접두 제품은 SQL 경로에서 구제된다 (주석이 주장하는 사실)", async () => {
    const rows = (await getDb().execute(sql`
      WITH names AS (
        SELECT DISTINCT ON (entity_id) entity_id, brand FROM scope_mentions
        WHERE entity_type='Brand' AND brand IS NOT NULL
        ORDER BY entity_id, (brand ~ '^[A-Za-z]') DESC, brand
      )
      SELECT m.brand AS own_name, n.brand AS resolved
      FROM scope_mentions m LEFT JOIN names n ON n.entity_id = ${canonRollupSql({})}
      WHERE m.brand IN ('Hyundai Aura','Kia Carens Clavis EV')
      GROUP BY 1,2
    `)) as unknown as Array<{ own_name: string; resolved: string | null }>;
    expect(rows.sort((a, b) => a.own_name.localeCompare(b.own_name))).toEqual([
      { own_name: "Hyundai Aura", resolved: "Hyundai" },
      { own_name: "Kia Carens Clavis EV", resolved: "Kia" },
    ]);
  });
});
