// 타겟 URL 일치 — **리포트 ↔ 대시보드 ↔ JS 쌍둥이** 3자 대조 (2026-09-20).
//
// 제품 결정: "리포트는 절대 진실이어야 한다. 리포트는 못 바꾼다. 대시보드를 고쳐야 한다."
// 그래서 여기서 정본은 발행 리포트 생성기다:
//   · 정규화  `scripts/reports/extract-citation-data.mts:14-22` (TRACK · NORM · NORM_T)
//   · 비교식  `scripts/reports/extract-citation-data.mts:97`
//              `EXISTS (… c3.tn = ${NORM_T("lp.target_url")}) target_hit`
//
// 대시보드 쪽은 `citationTrackedNormSql`(정규화) + `targetMatchSql`(비교)이다.
// 둘이 **같은 입력에 같은 판정**을 내는지 진짜 Postgres(pglite)에서 확인한다.
// 텍스트 스냅샷으로는 안 된다 — 정규식 백슬래시 전달·`split_part` 경계처럼
// 파서·실행이 있어야만 드러나는 차이가 이 판정의 핵심이기 때문이다.
//
// ⚠️ 리포트의 정규화 식은 **파일에서 읽어 온다**(복사본을 여기 두지 않는다).
// 복사하면 리포트가 바뀌어도 이 테스트가 초록이라 "정본과 대조한다"가 거짓이 된다
// (같은 함정을 2026-09-17 검증자 F-2 가 verify:url-match 에서 잡았다).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { citationTrackedNormSql } from "@/lib/db/repositories/scope-aggregates";
import { targetMatchSql } from "./url-match-sql";
import { matchesTargetUrl } from "./url-match";

type Db = {
  query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  close: () => Promise<void>;
};

const REPORT_SRC = path.join(
  process.cwd(), "scripts", "reports", "extract-citation-data.mts",
);

/**
 * 리포트 생성기의 `NORM` 을 **소스에서 떼어 와** 그대로 쓴다. 잘라 오는 구간은
 * `const TRACK =` 부터 `const NORM_T = NORM;` 직전까지 — 그 사이에는 TRACK 상수와
 * NORM 화살표 함수밖에 없다(DB 접속·argv 같은 부수효과는 그 뒤에 있다).
 * 타입 주석 하나만 걷어내면 순수 JS 라 `new Function` 으로 평가할 수 있다.
 */
function reportNormFromSource(): (col: string) => string {
  const src = fs.readFileSync(REPORT_SRC, "utf8");
  const from = src.indexOf("const TRACK =");
  const to = src.indexOf("const NORM_T = NORM;");
  if (from < 0 || to < 0 || to <= from) {
    throw new Error("리포트 생성기에서 TRACK/NORM 구간을 못 찾았다 — 추출기가 바뀌었다");
  }
  const snippet = src.slice(from, to).replace("(col: string)", "(col)");
  const factory = new Function(`${snippet}\nreturn NORM;`) as () => (c: string) => string;
  const fn = factory();
  if (typeof fn !== "function") throw new Error("리포트 NORM 추출 실패");
  return fn;
}

const dialect = new PgDialect();

/** 컴파일된 drizzle SQL 의 바인드를 리터럴로 되박아 문장에 직접 심는다. */
function inline(fragment: ReturnType<PgDialect["sqlToQuery"]>): string {
  let out = fragment.sql;
  for (let i = fragment.params.length; i >= 1; i -= 1) {
    const lit = `'${String(fragment.params[i - 1]).replace(/'/g, "''")}'`;
    out = out.split(`$${i}`).join(lit);
  }
  return out;
}

const dashNorm = (col: string) => inline(dialect.sqlToQuery(citationTrackedNormSql(sql.raw(col))));
const dashMatch = (c: string, t: string) =>
  inline(dialect.sqlToQuery(targetMatchSql(sql.raw(c), sql.raw(t))));

/** [인용 URL, 타겟 URL, 기대 판정] — 제네시스 형태(쿼리·`.html`)를 앞에 둔다. */
const CASES: Array<[string, string, boolean]> = [
  // 같은 URL — 정규화가 흡수하는 차이만 있다
  ["https://www.genesis.com/de/de/models/genesis-g80.html",
   "https://www.genesis.com/de/de/models/genesis-g80.html", true],
  ["http://genesis.com/de/de/models/genesis-g80.html/",
   "https://www.genesis.com/de/de/models/genesis-g80.html", true],
  ["https://www.genesis.com/de/de/models/genesis-g80.html#spec",
   "https://www.genesis.com/de/de/models/genesis-g80.html", true],
  ["https://www.genesis.com/de/de/models/genesis-g80.html?utm_source=chatgpt.com",
   "https://www.genesis.com/de/de/models/genesis-g80.html", true],
  // 제네시스 형태 ① — 인용에 붙은 비(非)트래킹 쿼리. 느슨한 일치는 여기서 부풀었다
  ["https://www.genesis.com/uk/en/models/genesis-gv70?moveto=top",
   "https://www.genesis.com/uk/en/models/genesis-gv70", false],
  ["https://www.genesis.com/it/it/buy/configurator?step=trim",
   "https://www.genesis.com/it/it/buy/configurator", false],
  ["https://www.genesis.com/ch/de/models/gv60?lang=de",
   "https://www.genesis.com/ch/de/models/gv60", false],
  // 제네시스 형태 ② — `.html`/`.htm` 유무 차이
  ["https://www.genesis.com/fr/fr/news/neolun.html",
   "https://www.genesis.com/fr/fr/news/neolun", false],
  ["https://www.genesis.com/nl/nl/news/neolun.htm",
   "https://www.genesis.com/nl/nl/news/neolun", false],
  ["https://www.genesis.com/nl/nl/news/neolun",
   "https://www.genesis.com/nl/nl/news/neolun.html", false],
  ["https://www.genesis.com/fr/fr/news/neolun.html?lang=fr",
   "https://www.genesis.com/fr/fr/news/neolun", false],
  // 자원을 가르는 쿼리 — 값이 같을 때만 일치
  ["https://news.example.com/read?id=A", "https://news.example.com/read?id=A", true],
  ["https://news.example.com/read?id=B", "https://news.example.com/read?id=A", false],
  ["https://news.example.com/read", "https://news.example.com/read?id=A", false],
  // 하위 경로·접두 일치는 도달이 아니다
  ["https://www.kia.com/us/en/vehicles/fleet", "https://www.kia.com/us/en/vehicles", false],
  ["https://www.kia.com/us/en/vehiclesxyz", "https://www.kia.com/us/en/vehicles", false],
  // 대소문자는 정규화가 접는다
  ["https://WWW.Hyundai.com/BR/PT/Modelos/CRETA", "https://www.hyundai.com/br/pt/modelos/creta", true],
];

let db: Db;
let reportNorm: (col: string) => string;

beforeAll(async () => {
  reportNorm = reportNormFromSource();
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite() as unknown as Db;
});

afterAll(async () => {
  await db?.close();
});

describe("리포트 정규화 ↔ 대시보드 정규화", () => {
  it("두 식은 공백을 빼면 **글자 그대로 같다**", () => {
    const strip = (s: string) => s.replace(/\s+/g, "");
    expect(strip(reportNorm("COL"))).toBe(strip(dashNorm("COL")));
  });
});

describe("타겟 일치 — 리포트 · 대시보드(SQL) · JS 쌍둥이 3자 대조", () => {
  it.each(CASES)("%s vs %s → %s", async (cited, target, expected) => {
    const stmt = `
      WITH v(cu, tu) AS (VALUES ($1::text, $2::text)),
      n AS (
        SELECT ${dashNorm("cu")} AS c, ${dashNorm("tu")} AS t,
               ${reportNorm("cu")} AS rc, ${reportNorm("tu")} AS rt
        FROM v
      )
      SELECT (${dashMatch("n.c", "n.t")}) AS dash, (n.rc = n.rt) AS report,
             n.c AS c, n.rc AS rc FROM n`;
    const { rows } = await db.query(stmt, [cited, target]);
    const row = rows[0]!;
    // 정규화 결과 자체가 같아야 판정 비교가 의미를 갖는다.
    expect(row.rc).toBe(row.c);
    expect({
      report: row.report === true,
      dash: row.dash === true,
      js: matchesTargetUrl(cited, target),
    }).toEqual({ report: expected, dash: expected, js: expected });
  });
});
