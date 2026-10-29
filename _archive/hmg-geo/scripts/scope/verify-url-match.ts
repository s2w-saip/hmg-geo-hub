/**
 * KPI ⑥ AI 타겟 URL 인용률 — URL 정규화 매칭 SQL↔JS 패리티 검증.
 *
 * scope-aggregates.ts 의 매칭은 raw SQL(regexp_replace …)로 돌기 때문에 JS
 * 단위테스트로는 SQL 쪽 동작을 보장할 수 없다. 이 스크립트는 **테이블을 전혀
 * 건드리지 않고**(리터럴 SELECT만) 두 가지를 강제한다:
 *   A. cnorm(SQL) === normalizeUrlForMatch(JS)  — 분모/분자 공통 정규화
 *   B. 분모 프리픽스 술어 (cnorm = prefix OR cnorm LIKE prefix||'/%') 진리표
 *
 * 둘 중 하나라도 어긋나면 exit 1.
 *
 *   npm run verify:url-match
 *   (= tsx --env-file=.env.local scripts/scope/verify-url-match.ts)
 */
import postgres from "postgres";
import { normalizeUrlForMatch } from "../../lib/scope/url-match";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("✗ DATABASE_URL not set in .env.local");
  process.exit(1);
}
const conn = postgres(DATABASE_URL, { prepare: false });

// SQL cnorm 의 1:1 미러 — scope-aggregates.ts 의 cnorm 과 동일해야 한다.
// 트림 → lower → scheme → 선행 www. → fragment(#…) → 트래킹 파라미터 3패스 →
// 끝 슬래시를 독립 단계로 제거.
// 백슬래시는 JS 문자열에서 \\s → \s, \\. → \. 로 postgres 에 전달된다.
const TRACK =
  "(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)";
const cnormExpr = (col: string) => {
  const base = `regexp_replace(regexp_replace(regexp_replace(lower(regexp_replace(${col}, '^\\s+|\\s+$', '', 'g')), '^https?://', ''), '^www\\.', ''), '#.*$', '')`;
  const noMid = `regexp_replace(${base}, '&${TRACK}=[^&]*', '', 'g')`;
  const noHead = `regexp_replace(${noMid}, '\\?${TRACK}=[^&]*&', '?')`;
  const noOnly = `regexp_replace(${noHead}, '\\?${TRACK}=[^&]*$', '')`;
  return `regexp_replace(${noOnly}, '/+$', '')`;
};

const cnormSql = (url: string) =>
  conn.unsafe<{ cnorm: string }[]>(
    `SELECT ${cnormExpr("$1")} AS cnorm`,
    [url],
  );

// 분모 프리픽스 술어 — aggregateCitationAccuracy 의 ownedClause 와 동일.
const prefixMatchSql = (url: string, prefix: string) =>
  conn.unsafe<{ matched: boolean }[]>(
    `WITH c AS (SELECT ${cnormExpr("$1")} AS cnorm)
     SELECT (cnorm = $2 OR cnorm LIKE $2 || '/%') AS matched FROM c`,
    [url, prefix],
  );

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  console.log(`  ✗ ${m}`);
  failures += 1;
};

// ── A. cnorm 파리티 — SQL 정규화가 JS 와 같은 값을 내는가 ──────────────────
console.log("\nA. cnorm(SQL) === normalizeUrlForMatch(JS)");
const cnormCases = [
  "https://www.kia.com/it/",
  "http://kia.com/it/it/modelli/",
  "https://kia.com/it/it/modelli",
  "WWW.KIA.COM/it/it/modelli",
  "  HTTPS://WWW.Kia.com/IT  ",
  "kia.com/it///",
  "https://www.hyundai.com",
  "kia.com/it?utm=a",
  "https://shop.kia.com/it",
  // 트래킹 파라미터 — AI 엔진이 붙이는 유입 표식이라 같은 페이지로 수렴해야 한다
  "https://www.kia.com/sg/x.html?utm_source=chatgpt.com",
  "https://www.kia.com/it/?msockid=3564f27cfed16f12",
  "https://y.com/watch?utm_source=x&utm_medium=y&v=abc",
  "https://y.com/watch?v=abc&utm_source=x",
  // 자원을 식별하는 쿼리는 보존 / 경로 안의 '&' 는 구분자가 아니므로 불변
  "https://youtube.com/watch?v=abc",
  "https://a.com/tom&jerry",
  // text-fragment(스크롤-투-텍스트) — fragment 는 클라이언트 전용이라 제거
  "https://www.hyundai.com/worldwide/en/company/innovation/design#:~:text=Design-,philosophy,solutions%20with%20captivating%20emotional%20appeal.",
  "https://kia.com/it/#:~:text=foo",
];
for (const url of cnormCases) {
  const js = normalizeUrlForMatch(url);
  const [{ cnorm }] = await cnormSql(url);
  if (js === cnorm) pass(`${JSON.stringify(url)} → ${JSON.stringify(js)}`);
  else fail(`${JSON.stringify(url)} — JS ${JSON.stringify(js)} ≠ SQL ${JSON.stringify(cnorm)}`);
}

// 변형 수렴: 한 페이지의 scheme/www/끝 슬래시 변형이 SQL 에서도 1개로 모이는가
const variants = [
  "https://www.kia.com/it/it/modelli",
  "http://kia.com/it/it/modelli/",
  "https://kia.com/it/it/modelli",
  "https://kia.com/it/it/modelli#:~:text=ABC", // text-fragment 변형도 같은 페이지
  "https://www.kia.com/it/it/modelli/#section", // 일반 anchor + 끝 슬래시
];
const cnorms = new Set<string>();
for (const v of variants) cnorms.add((await cnormSql(v))[0].cnorm);
if (cnorms.size === 1 && [...cnorms][0] === "kia.com/it/it/modelli") {
  pass(`변형 ${variants.length}개 → 1개로 수렴 (kia.com/it/it/modelli)`);
} else {
  fail(`변형이 수렴하지 않음: ${JSON.stringify([...cnorms])}`);
}

// ── B. 분모 프리픽스 술어 진리표 ──────────────────────────────────────────
console.log("\nB. ownedClause: (cnorm = prefix OR cnorm LIKE prefix||'/%')");
const prefixCases: Array<[string, string, boolean]> = [
  ["https://www.kia.com/it/it/modelli", "kia.com/it", true], // 하위 경로
  ["https://kia.com/it", "kia.com/it", true], // 정확 일치
  ["https://kia.com/it/", "kia.com/it", true], // 끝 슬래시 → 정확 일치
  ["https://kia.com/italy", "kia.com/it", false], // /it 경계 — italy 제외
  ["https://kia.com/de", "kia.com/it", false], // 다른 국가
  ["https://kia.com", "kia.com/it", false], // 홈은 /it 하위 아님
  ["https://shop.kia.com/it", "kia.com/it", false], // 서브도메인은 별개
];
for (const [url, prefix, expected] of prefixCases) {
  const [{ matched }] = await prefixMatchSql(url, prefix);
  const ok = matched === expected;
  const label = `${JSON.stringify(url)} vs '${prefix}' → ${matched} (기대 ${expected})`;
  if (ok) pass(label);
  else fail(label);
}

await conn.end();

console.log(
  failures === 0
    ? "\n✓ all url-match checks passed (SQL ↔ JS 정규화 일치)"
    : `\n✗ ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
