import "server-only";
import { sql, type SQL } from "drizzle-orm";
import {
  OFFICIAL_SOCIAL_ACCOUNTS,
  OFFICIAL_SOCIAL_DOMAINS,
} from "@/lib/citation-categorizer/official-social";

// 인용 롤업 그룹 키의 **SQL 쌍둥이**.
//
// ⚠️ 이 파일은 목록을 갖지 않는다 — `OFFICIAL_SOCIAL_ACCOUNTS` 하나를 읽어
// CASE 식을 생성한다. JS 경로(`citationGroupKey`)와 같은 배열을 통과하므로
// live/mirror 패리티가 "두 목록을 맞춰 놓기"가 아니라 **구조적으로** 보장된다
// (citation-categorizer/index.ts 의 순수 함수 설계와 같은 원칙).
// 목록을 여기 복제하는 순간 그 보장이 사라진다.
//
// ── 표기에 대하여 (운영 결정 2026-08-28) ────────────────────────────────
// 이 식이 만드는 컬럼 이름은 그대로 `domain` 이고 UI 열 표기도 "도메인"이다.
// 실제로는 **이 열의 값 대부분이 registrable domain 이지만 공식 소셜 계정 행만
// host+path 다.** 계정 단위로 나누지 않으면 `linkedin.com` 전체가 공식(HMG)이
// 되어버리기 때문에 키를 넓혔고, 그럼에도 **표기를 바꾸지 않는 것은 운영
// 결정(2026-08-28)** 이다. 같은 주석이 JS 헬퍼(`official-social.ts`)와 UI
// 컴포넌트(`citation-domain-table.tsx`)에도 있다.

/**
 * URL → 매칭용 정규화 문자열 `"<registrable domain><경로>"`.
 * `citationPathKeyOf`(JS)의 1:1 쌍둥이 — 단계와 순서가 같아야 한다:
 *   트림 → 소문자 → `^https?://` 제거 → 첫 `/` 부터를 경로로 → `?`·`#` 절단
 *   → `%40` → `@`.
 * 호스트를 통째로 버리고 미러가 계산해 둔 registrable domain 을 앞에 붙이므로
 * `www.` / `kr.` / `m.` 서브도메인이 자동으로 접힌다.
 */
function citationPathKeyExprSql(domainCol: SQL, urlCol: SQL): SQL {
  // 이 식은 매처마다 인라인 반복되므로(citationGroupKeySql 주석의 SubPlan 실측)
  // **자기 자신의 크기와 참조 횟수가 곧 비용**이다. 그래서 ① 정규식을 쓰지 않고
  // ② 하위식 재참조를 최소화한다(t 6회 — regexp 판은 9회 + regexp 3회였다).
  // E'' 안의 \\t\\n\\r 은 **SQL 이 해석**해야 한다 — TS 템플릿 리터럴에서 이스케이프를
  // 한 번 더 걸지 않으면 실제 제어문자가 SQL 텍스트에 박힌다.
  const t = sql`lower(btrim(coalesce(${urlCol}, ''), E' \\t\\n\\r'))`;
  // scheme 제거: 'https://'(8자) / 'http://'(7자) 만 — JS 의 /^https?:\/\// 와 동일.
  const u = sql`substr(${t}, CASE WHEN starts_with(${t}, 'https://') THEN 9 WHEN starts_with(${t}, 'http://') THEN 8 ELSE 1 END)`;
  // 첫 '/' 부터가 경로. strpos=0(경로 없음) → nullif → substr NULL → ''.
  const path = sql`coalesce(substr(${u}, nullif(strpos(${u}, '/'), 0)), '')`;
  const noQuery = sql`split_part(split_part(${path}, '?', 1), '#', 1)`;
  return sql`(lower(${domainCol}) || replace(${noQuery}, '%40', '@'))`;
}

/**
 * 인용 한 행의 **그룹 키** 식 — 공식 소셜 계정이면 `도메인+계정경로`,
 * 아니면 종전과 동일한 `lower(domain)`.
 *
 * 성능: 바깥 `CASE WHEN lower(domain) IN (…)` 게이트가 정규화를 목록에 든 5개
 * 도메인(미러 240만 행 중 약 5.7만 행)에서만 돌게 한다. SQL 의 CASE 는 참인
 * 분기만 평가하므로 나머지 행은 문자열 연산 없이 `lower(domain)` 으로 빠진다 —
 * `citationOwnedBaseSql` 이 owned 후보 도메인에만 URL 정규화를 거는 것과 같은
 * 수법이다(전 행 정규화가 website 창에서 쿼리당 ~5s 를 만들던 전례).
 */
export function citationGroupKeySql(domainCol: SQL, urlCol: SQL): SQL {
  const gateList = sql.join(
    [...OFFICIAL_SOCIAL_DOMAINS].map((d) => sql`${d}`),
    sql`, `,
  );
  // ⚠️ 정규화 식을 스칼라 서브쿼리 `(SELECT … FROM (SELECT <norm> AS n) s)` 로
  // 한 번만 계산하게 만들었다가 **되돌렸다.** 그 형태는 상관 SubPlan 이 되어
  // 행마다 executor 재기동 비용을 문다 — 2026-08-28 EXPLAIN (ANALYZE) 실측,
  // 전 이력 246만 행 기준(같은 플랜·같은 buffers, SubPlan loops=45,058):
  //     baseline(ownedBase 포함)                  11,104 ms
  //     스칼라 서브쿼리 판                        24,951 ms  (+13.8s)
  //     인라인 판(정규식 norm, 매처 1개)          13,308 ms  (+2.2s)
  // 45,058회 실행에 12초가 붙는다(회당 ~273µs). 그래서 인라인을 택하고,
  // 대신 정규화 자체에서 정규식을 걷어냈다(citationPathKeyExprSql 주석).
  const norm = citationPathKeyExprSql(domainCol, urlCol);
  const branches: SQL[] = [];
  for (const acc of OFFICIAL_SOCIAL_ACCOUNTS) {
    for (const m of acc.matchers) {
      // boundary=true  → 프리픽스와 완전히 같거나 뒤에 '/' 가 와야 한다.
      //                  (쿼리·프래그먼트는 정규화에서 이미 잘렸으므로 경계
      //                   문자는 '/' 와 문자열 끝뿐 — JS matcherHits 와 동일.)
      // boundary=false → 프리픽스가 자기 구분자를 포함(LinkedIn `/posts/<handle>_`).
      // starts_with(): LIKE 를 쓰면 프리픽스의 `_` 가 와일드카드로 해석돼
      //                `hyundai-motor-groupX` 까지 잡힌다 — 앵커 규율 위반.
      // boundary 판정을 **norm 1회 참조**로 접는다:
      //   starts_with(norm || '/', prefix || '/')
      //     ≡ (norm = prefix) OR starts_with(norm, prefix || '/')
      // norm=prefix 면 양쪽이 같아지고, norm=prefix+'/…' 면 접두가 성립하며,
      // norm=prefix+'abc' 면 prefix 다음 글자가 'a' ≠ '/' 라 성립하지 않는다.
      // 식을 두 번 쓰면 인라인 비용이 그대로 두 배가 된다.
      const hit = m.boundary
        ? sql`starts_with(${norm} || '/', ${`${m.prefix}/`})`
        : sql`starts_with(${norm}, ${m.prefix})`;
      branches.push(sql`WHEN ${hit} THEN ${acc.key}`);
    }
  }
  if (branches.length === 0) return sql`lower(${domainCol})`;
  // 바깥 게이트가 CASE 단락으로 정규화 자체를 5개 도메인 행에만 태운다
  // (246만 행 중 45,058행 — EXPLAIN 의 실행 횟수로 확인).
  return sql`CASE WHEN lower(${domainCol}) IN (${gateList}) THEN (
      CASE ${sql.join(branches, sql` `)} ELSE lower(${domainCol}) END
    ) ELSE lower(${domainCol}) END`;
}
