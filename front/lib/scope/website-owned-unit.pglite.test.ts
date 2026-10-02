// 유닛 단위 자사 판정 — 진짜 Postgres(pglite)에서 (2026-09-20).
//
// 두 가지를 실행으로 고정한다:
//   ① flat(스코프 전 사이트 base 합집합) 과 유닛(그 프롬프트의 base) 이 **갈리는 자리**.
//      사이트 A(base a.com/x)의 프롬프트가 사이트 B(base b.com)를 인용한 경우가 그것이고,
//      미러 실측에서 자사 URL 인용률을 함대 78.62% → 90.22% 로 부풀린 원인이다.
//   ② `websiteUnitOwnedClause`(컬럼 입력) 와 `ownedBasePrefixClause`(리터럴 입력)가
//      같은 입력에 **같은 판정**을 내는가. 갈리면 화면과 리포트·집계 사실표가 어긋난다
//      (`scripts/summary/surface-website.ts::unitOwnedSql` 이 후자를 base 하나로 부른다).
//
// 텍스트 대조로는 안 된다 — `unnest`/`LIKE`/`split_part` 경계와 빈 배열의 `NOT EXISTS`
// 는 실행해야 드러난다.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ownedBasePrefixClause } from "@/lib/db/repositories/scope-aggregates";
import { websiteUnitOwnedClause, type WebsiteOwnedUnit } from "./website-owned-unit";

type Db = {
  exec: (s: string) => Promise<unknown>;
  query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  close: () => Promise<void>;
};

const dialect = new PgDialect();

/** 컴파일된 drizzle SQL 의 바인드를 리터럴로 되박아 문장에 직접 심는다. */
function inline(fragment: SQL): string {
  const q = dialect.sqlToQuery(fragment);
  let out = q.sql;
  for (let i = q.params.length; i >= 1; i -= 1) {
    const p = q.params[i - 1];
    const lit = Array.isArray(p)
      ? `ARRAY[${p.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(", ")}]::text[]`
      : `'${String(p).replace(/'/g, "''")}'`;
    out = out.split(`$${i}`).join(lit);
  }
  return out;
}

// ── 유닛 셋 ────────────────────────────────────────────────────────────────
// A = 경로로 갈린 사이트, B = 남의 사이트, H = 언어로 갈린 사이트(형제 규칙),
// K = 루트 홈이 자사인 사이트, G = 공유 글로벌 호스트(루트 홈 제외).
const U: Record<string, WebsiteOwnedUnit> = {
  A: { siteId: "a", fileSeq: 1, base: "a.com/x", sibs: [], homeHost: "a.com" },
  B: { siteId: "b", fileSeq: 2, base: "b.com", sibs: [], homeHost: "b.com" },
  H_EN: { siteId: "h", fileSeq: 3, base: "h.com", sibs: ["h.com/ko"], homeHost: "h.com" },
  H_KO: { siteId: "h", fileSeq: 4, base: "h.com/ko", sibs: [], homeHost: "h.com" },
  K: { siteId: "k", fileSeq: 5, base: "k.ca/en", sibs: [], homeHost: "k.ca" },
  G: { siteId: "g", fileSeq: 6, base: "hyundai.com/au", sibs: [], homeHost: null },
  DOC: { siteId: "d", fileSeq: 7, base: "h.com/no/no", sibs: [], homeHost: "h.com" },
};

/** flat 집합 = 이 픽스처가 대시보드 무필터에서 만드는 것(전 사이트 base 합집합). */
const FLAT = Object.values(U).map((u) => u.base);

/** [인용 base NORM, 유닛, 유닛 기대, flat 기대] */
const CASES: Array<[string, WebsiteOwnedUnit, boolean, boolean]> = [
  // ① 핵심 — A 의 프롬프트가 B 사이트를 인용. flat 은 자사, 유닛은 비자사.
  ["b.com/page", U.A, false, true],
  ["b.com", U.A, false, true],
  // 자기 base 는 당연히 자사(두 정의 모두)
  ["a.com/x", U.A, true, true],
  ["a.com/x/models/n", U.A, true, true],
  // A 의 base 밖·같은 호스트 — 루트 홈 규칙으로 홈만 자사
  ["a.com", U.A, true, true],
  ["a.com/y", U.A, false, false],
  // ② 형제 제외 — h.com/ko 는 KO 유닛 자산이라 EN 유닛에서 빠진다.
  //    flat 은 universe == prefixes 라 형제 제외가 통째로 꺼져 자사로 잡는다.
  ["h.com/ko/p", U.H_EN, false, true],
  ["h.com/ko/p", U.H_KO, true, true],
  ["h.com/en/p", U.H_EN, true, true],
  // ③ 루트 홈 = 자사 (base 가 언어 경로여도)
  ["k.ca", U.K, true, true],
  ["k.ca/", U.K, true, true],
  // 쿼리가 붙은 루트는 **호스트 사전필터**에서 먼저 걸린다(split_part(x,'/',1) 이
  // 'k.ca?iscl=1'). 루트 홈 규칙의 rtrim/split_part 까지 못 간다 — 두 구현 모두 그렇고,
  // 자사 계열 입력은 base NORM 이라 쿼리가 이미 없어 실제로는 도달하지 않는 형태다
  // (⑥ 의 tracked NORM 경로에서만 쿼리가 남고, 그쪽은 호스트 사전필터도 같이 막는다).
  ["k.ca?iscl=1", U.K, false, false],
  ["k.ca/fr/p", U.K, false, false],
  // ④ 공유 글로벌 호스트는 루트 홈 규칙에서 빠진다
  ["hyundai.com", U.G, false, false],
  ["hyundai.com/au/models", U.G, true, true],
  // ⑤ base 자체의 .html 변형 (surface-website.ts:216 의 11 job 13건 전례)
  ["h.com/no/no.html", U.DOC, true, true],
  ["h.com/no/no", U.DOC, true, true],
  // ⑥ 접두만 같은 경로는 자사가 아니다
  ["a.com/xyz", U.A, false, false],
  // ⑦ 호스트 사전필터 — 전혀 다른 호스트
  ["carexpert.com.au/review", U.A, false, false],
];

let db: Db;

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite() as unknown as Db;
});

afterAll(async () => {
  await db?.close();
});

/**
 * 한 사례를 세 식으로 동시에 판정한다: 유닛(컬럼) · 유닛(리터럴) · flat.
 *
 * ⚠️ 인용 값은 **컬럼**(`wp.n`)으로 넘긴다. `sql.raw("$1")` 로 넘기면 `inline` 이
 * drizzle 이 매긴 `$1`(바인드 1번)과 구분하지 못해 URL 자리가 정규식 리터럴로
 * 덮인다 — 실제로 그렇게 짰다가 리터럴판이 전부 true 로 나왔다.
 */
async function verdicts(norm: string, u: WebsiteOwnedUnit) {
  const stmt = `
    WITH wp(unit_base, unit_sibs, unit_home_host, n) AS (
      VALUES (${`'${u.base}'`}::text,
              ARRAY[${u.sibs.map((s) => `'${s}'`).join(", ")}]::text[],
              ${u.homeHost === null ? "NULL" : `'${u.homeHost}'`}::text,
              $1::text)
    )
    SELECT (${inline(websiteUnitOwnedClause(sql.raw("wp.n"), "wp"))}) AS unit_col,
           (${inline(ownedBasePrefixClause(sql.raw("wp.n"), [u.base], [u.base, ...u.sibs]))}) AS unit_lit,
           (${inline(ownedBasePrefixClause(sql.raw("wp.n"), FLAT, FLAT))}) AS flat
    FROM wp`;
  const { rows } = await db.query(stmt, [norm]);
  const r = rows[0]!;
  return { unitCol: r.unit_col === true, unitLit: r.unit_lit === true, flat: r.flat === true };
}

describe("유닛 단위 자사 판정 — flat 과 갈리는 자리", () => {
  it.each(CASES)("%s → 유닛 %s · flat %s", async (norm, unit, wantUnit, wantFlat) => {
    const v = await verdicts(norm, unit);
    expect({ unit: v.unitCol, flat: v.flat }).toEqual({ unit: wantUnit, flat: wantFlat });
  });

  it("A 사이트 프롬프트의 B 사이트 인용은 flat 에서만 자사다 (이 트랙의 원인)", async () => {
    const v = await verdicts("b.com/page", U.A);
    expect(v.flat).toBe(true);
    expect(v.unitCol).toBe(false);
  });
});

// ── 쌍둥이 대조 ─────────────────────────────────────────────────────────────
// 컬럼 입력판(화면)과 리터럴 입력판(`unitOwnedSql` 이 부르는 것)이 같은 답을 내야 한다.
describe("websiteUnitOwnedClause === ownedBasePrefixClause([base], [base, ...sibs])", () => {
  it("전 사례에서 두 구현의 판정이 같다", async () => {
    const diffs: string[] = [];
    for (const [norm, unit] of CASES) {
      const v = await verdicts(norm, unit);
      if (v.unitCol !== v.unitLit) {
        diffs.push(`${norm} vs ${unit.base}: 컬럼 ${v.unitCol} · 리터럴 ${v.unitLit}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it("교차 격자 — 모든 (인용, 유닛) 조합에서도 같다", async () => {
    const norms = [...new Set(CASES.map(([n]) => n))];
    const diffs: string[] = [];
    for (const n of norms) {
      for (const u of Object.values(U)) {
        const v = await verdicts(n, u);
        if (v.unitCol !== v.unitLit) diffs.push(`${n} vs ${u.base}: ${v.unitCol}/${v.unitLit}`);
      }
    }
    expect(diffs).toEqual([]);
  });
});
