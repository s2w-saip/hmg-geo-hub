// 인용 그룹 키 — SQL ↔ JS 패리티를 **실 DB(read-only)** 로 강제한다.
// DATABASE_URL 이 있을 때만 실행 (CI 무DB skip). 로컬:
//   DATABASE_URL=... npx vitest run lib/db/repositories/citation-group-key.parity.int.test.ts
//
// 왜 단위테스트로 부족한가: 미러 경로의 키는 raw SQL(`citationGroupKeySql`)이,
// 라이브 경로의 키는 JS(`citationGroupKey`)가 만든다. 두 식이 실제 URL 위에서
// 같은 문자열을 내는지는 **DB 에서 돌려봐야만** 알 수 있다 —
// `verify:url-match`(KPI ⑥ 정규화 패리티)가 세운 선례와 같은 자세다.
//
// 판별력(mutation): 두 경로가 같은 배열(OFFICIAL_SOCIAL_ACCOUNTS)을 읽는 것이
// 설계의 전부이므로, 어느 한쪽이 목록을 자체 보유하거나 비우는 순간 아래
// "전 행 일치"와 "키별 건수" 두 단언이 동시에 깨진다.
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { citationGroupKeySql } from "./citation-group-key";
import {
  OFFICIAL_SOCIAL_ACCOUNTS,
  OFFICIAL_SOCIAL_DOMAINS,
  citationGroupKey,
} from "@/lib/citation-categorizer/official-social";

const hasDb = !!process.env.DATABASE_URL;

// 2026-08-30 프로덕션 미러 실측 (scope_citations, 앵커 적용 후) — **최소 하한**
// (lower bound), 정확값 아님.
//
// scope_citations 는 증분 동기화로 계속 늘어나는 append-only 미러다(mass-update-
// safety 룰: 이 미러가 measurement 원본의 복구 소스). 2026-08-28 실측값을 정확값
// (toEqual)으로 박아 뒀더니 이틀 뒤(2026-08-30) linkedin 두 계정만 자연 증가해
// 즉시 깨졌다(genesisworldwide 197→198, hyundai-motor-group 317→319 — 나머지
// 7개 키는 변동 없음, 계정별로 새 인용이 들어오는 속도가 다르다). 이 테스트의
// 진짜 판별력은 "SQL 키 = JS 키" 전 행 패리티(위 첫 단언, 27,689행 실측)가 이미
// 담당한다 — 여기는 OFFICIAL_SOCIAL_ACCOUNTS 목록이 SQL·JS 양쪽에 계속 같은
// 배열로 연결돼 있는지 잡는 보조 스모크 체크라, 정확값을 고집할 이유가 없다.
// 하한으로 바꾸면 자연 증가는 통과하고, 목록이 빠지거나(값이 0으로 떨어짐)
// 그룹핑이 깨져 건수가 줄어드는 진짜 회귀만 잡는다.
const EXPECTED_COUNTS_FLOOR: Record<string, number> = {
  "facebook.com/HyundaiMotorGroupNewsroom": 391,
  "linkedin.com/hyundai-motor-group": 319,
  "linkedin.com/genesisworldwide": 198,
  "instagram.com/hyundai": 26,
  "youtube.com/@hyundai_kor": 26,
  "facebook.com/Hyundai.Europe": 21,
  "facebook.com/HyundaiMotorGroupTV": 15,
  "facebook.com/HyundaiCarsIreland": 1,
  "threads.com/@genesis_usa": 1,
};

describe.skipIf(!hasDb)("citation group key — SQL ↔ JS parity", { timeout: 300_000 }, () => {
  const gate = sql.join(
    [...OFFICIAL_SOCIAL_DOMAINS].map((d) => sql`${d}`),
    sql`, `,
  );
  const key = citationGroupKeySql(sql`c.domain`, sql`c.url`);

  it("게이트 도메인의 모든 DISTINCT (domain,url) 에서 SQL 키 = JS 키", async () => {
    const rows = (await getDb().execute(sql`
      SELECT DISTINCT lower(c.domain) AS domain, c.url AS url, ${key} AS sql_key
      FROM scope_citations c
      WHERE c.domain IS NOT NULL AND lower(c.domain) IN (${gate})
    `)) as unknown as Array<{ domain: string; url: string; sql_key: string }>;

    expect(rows.length).toBeGreaterThan(0);
    const mismatches = rows
      .filter((r) => r.sql_key !== citationGroupKey(r.domain, r.url))
      .slice(0, 20)
      .map((r) => ({ url: r.url, sql: r.sql_key, js: citationGroupKey(r.domain, r.url) }));
    console.log(`[parity] distinct (domain,url) rows compared: ${rows.length}`);
    expect(mismatches).toEqual([]);
  });

  it("게이트 밖 도메인은 SQL 키가 lower(domain) 그대로 (회귀 없음)", async () => {
    const rows = (await getDb().execute(sql`
      SELECT lower(c.domain) AS domain, ${key} AS sql_key
      FROM scope_citations c
      WHERE c.domain IS NOT NULL AND lower(c.domain) NOT IN (${gate})
      LIMIT 20000
    `)) as unknown as Array<{ domain: string; sql_key: string }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.sql_key !== r.domain)).toEqual([]);
  });

  it("키별 인용 건수가 실측 기준선 이상이다 (append-only 미러 — 하한 단언)", async () => {
    const rows = (await getDb().execute(sql`
      SELECT ${key} AS k, count(*)::int AS n
      FROM scope_citations c
      WHERE c.domain IS NOT NULL AND lower(c.domain) IN (${gate})
      GROUP BY 1
    `)) as unknown as Array<{ k: string; n: number }>;

    const byKey = new Map(rows.map((r) => [r.k, Number(r.n)]));
    for (const acc of OFFICIAL_SOCIAL_ACCOUNTS) {
      const floor = EXPECTED_COUNTS_FLOOR[acc.key];
      if (floor == null) continue; // 기준선 미등재 키(신규 계정) — 존재만으로 충분
      expect(byKey.get(acc.key) ?? 0, acc.key).toBeGreaterThanOrEqual(floor);
    }
  });

  it("앵커가 실제로 좁힌다 — instagram.com/hyundai 는 substring 매칭보다 훨씬 적다", async () => {
    const rows = (await getDb().execute(sql`
      SELECT
        count(*) FILTER (WHERE ${key} = 'instagram.com/hyundai')::int AS anchored,
        count(*) FILTER (WHERE c.url ILIKE '%instagram.com/hyundai%')::int AS substring_match
      FROM scope_citations c
      WHERE c.domain = 'instagram.com'
    `)) as unknown as Array<{ anchored: number; substring_match: number }>;

    const anchored = Number(rows[0]?.anchored);
    const substringMatch = Number(rows[0]?.substring_match);
    // 두 카운트 모두 append-only 미러 위 실측이라 절대값은 계속 늘 수 있다
    // (2026-08-28→30 사흘 만에 substring_match 192→196, anchored 는 26 유지 —
    // 그마저도 anchored 를 exact 로 박으면 다음 실제 hyundai 인용이 들어오는
    // 순간 또 깨진다). 이 테스트의 본래 목적은 "앵커링이 실제로 좁힌다"는
    // 것이므로, 하한 + 배수 격차로 바꿔 절대값 드리프트에 흔들리지 않으면서도
    // 앵커가 no-op 으로 퇴행하면(둘이 같아지면) 여전히 잡는다.
    expect(anchored, "anchored").toBeGreaterThanOrEqual(26);
    expect(
      substringMatch,
      "substring_match must stay meaningfully larger than anchored (narrowing invariant)",
    ).toBeGreaterThan(anchored * 3);
  });
});
