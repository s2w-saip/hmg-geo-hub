// 표기 접두 규칙(canonRollupSql 의 HMG 접두 CASE)이 **실 데이터에서 실제로 값을
// 바꾸는** 슬라이스를 고정한다. DATABASE_URL 이 있을 때만 실행(무DB skip). 로컬:
//   DATABASE_URL=... npx vitest run lib/db/repositories/scope-aggregates.prefix-rule-slice.int.test.ts
//
// ── 왜 이 파일이 있는가 (읽고 가라) ─────────────────────────────────────────
// PR #113 은 4개 표면의 지표 정합을 **AE/Genesis 슬라이스 하나**로 검증했다.
// 사후 검증이 밝힌 것: 그 슬라이스에서는 접두 규칙 on/off 가 **완전히 같은 값**을
// 냈다(총계 2,046 · Genesis 182 — 양쪽 동일). 즉 그 규칙은 **한 번도 실행되지
// 않은 채** "검증됐다"는 딱지를 달고 배포됐다.
//
// 교훈은 "AE 말고 KR 을 쓰자"가 아니다. 슬라이스는 데이터가 굴러가면 조용해진다
// (표준 스냅샷은 7일 full-cycle 창이라 특히 그렇다). 규율은 이것이다:
//
//   ① 정합 검증은 **공허하게 통과할 수 있으면 안 된다.**
//      값을 비교하기 전에 "규칙이 이 슬라이스에서 실제로 발화했는가"를 먼저
//      단언한다. 발화 0이면 그 검증은 통과가 아니라 **무효**다.
//   ② 슬라이스는 손으로 고르지 말고 **측정으로 고른다.** 아래 discoverSlices()
//      가 그 측정이고, 핀이 조용해지면 테스트가 **현재 순위표를 띄우며 실패**한다
//      — 다음 사람은 어디로 옮길지 다시 조사할 필요가 없다.
//   ③ 규칙이 배선돼 있는지(발행 SQL 전수)는 DB 없이 도는 쌍둥이가 본다:
//      scope-aggregates.prefix-rule-parity.test.ts. 이 리포는 PR CI 가 없어
//      (.github/workflows 부재) DB 의존 가드만으로는 다음 사람에게 도달하지
//      않는다 — **주 가드는 그쪽, 이 파일은 실데이터 확증**이라는 분업이다.
//
// 2026-08-29 프로덕션 미러 실측 — (region, prompts.brand) 별 재귀속 행수 상위:
//   CA/Hyundai 33행 160언급 · CA/Kia 11/17 · CA/Genesis 9/9 · AE/Genesis 8/9
//   · AE/Kia 6/7 · BE/Kia 6/6 · EG/Genesis 6/6 · KR/Genesis 4/5 · KR/Hyundai 3/5
// 지역 단위(브랜드 무필터)로는 CA 926언급 · KR 296 · IN 291 · BE 269 가 상위다.
//
// ⚠️ 위 순위는 **완료된 답변 전체**(모든 회차) 기준이다. 표준 화면의 스냅샷은
//    7일 full-cycle 창만 본다 — #113 의 AE/Genesis 가 전 기간으로는 8행/9언급을
//    발화시키는데도 그 창 안에서는 0이었던 이유가 이것이다. 그래서 **핀 자체는
//    안전장치가 아니다**. 안전장치는 아래 "발화 선단언"이고, 핀은 그 선단언이
//    가장 잘 걸리는 자리일 뿐이다.
//
// 핀 슬라이스(CA/Hyundai) 실측 — 이 파일의 단언이 보는 값(2026-08-29):
//   당사 언급 규칙 on 6,259 / off 6,099 (차 160 = 재귀속 언급과 정확히 일치)
//   재귀속 행 33 · 되찾은 rollup 중 비HMG 0건
import { describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  HMG_BRAND_ENTITY_IDS,
  rollupCanonicalPairs,
  trackedEntityIdsFor,
} from "@/lib/scope/hmg-brands";
import { canonRollupSql } from "./scope-aggregates";

const hasDb = !!process.env.DATABASE_URL;

/** 측정으로 고른 핀. 조용해지면 아래 첫 테스트가 현재 순위표와 함께 실패한다. */
const PINNED = { region: "CA", brand: "Hyundai" } as const;

/** 접두 규칙을 **뺀** 롤업 해석 = id 알리아스 CASE 만 (pre-#113 동작). */
function rollupWithoutPrefix(alias = "m"): SQL {
  const rid = sql`${sql.raw(alias)}.brand_rollup_entity_id`;
  const pairs = rollupCanonicalPairs();
  if (!pairs.length) return rid;
  return sql`(CASE ${rid} ${sql.join(
    pairs.map(([a, c]) => sql`WHEN ${a} THEN ${c}`),
    sql` `,
  )} ELSE ${rid} END)`;
}

const trackedIn = () =>
  sql`(${sql.join(trackedEntityIdsFor().map((id) => sql`${id}`), sql`, `)})`;

/** 규칙이 그 행의 귀속을 바꾸는가 = with ≠ without. */
const firesSql = () =>
  sql`(${canonRollupSql({})} IS DISTINCT FROM ${rollupWithoutPrefix()})`;

const sliceFrom = (region?: string, brand?: string) => sql`
  FROM scope_mentions m
  JOIN scope_answers a ON a.job_id = m.job_id AND a.status = 'completed'
  ${region ? sql`AND a.region = ${region}` : sql``}
  JOIN prompts p ON p.scope_prompt_id = a.prompt_id
  ${brand ? sql`AND p.brand = ${brand}` : sql``}
  WHERE m.brand_rollup_entity_id IS NOT NULL`;

type SliceRow = { region: string; brand: string; fires: number; mentions: number };

/** (region, brand) 슬라이스별 "규칙이 귀속을 바꾼 행" 순위표. */
async function discoverSlices(): Promise<SliceRow[]> {
  return (await getDb().execute(sql`
    SELECT a.region, p.brand,
      count(*) FILTER (WHERE ${firesSql()})::int AS fires,
      COALESCE(sum(m.mention_count) FILTER (WHERE ${firesSql()}), 0)::int AS mentions
    ${sliceFrom()}
    GROUP BY 1, 2 ORDER BY 3 DESC, 4 DESC
  `)) as unknown as SliceRow[];
}

describe.skipIf(!hasDb)("접두 규칙 — 정합 검증 슬라이스", { timeout: 240_000 }, () => {
  it("핀 슬라이스가 여전히 규칙을 발화시킨다 (아니면 순위표를 띄우고 실패)", async () => {
    const rows = await discoverSlices();
    const pin = rows.find(
      (r) => r.region === PINNED.region && r.brand === PINNED.brand,
    );
    const top = rows
      .filter((r) => r.fires > 0)
      .slice(0, 10)
      .map((r) => `${r.region}/${r.brand} ${r.fires}행 ${r.mentions}언급`)
      .join(" · ");
    // 실패 메시지에 현재 순위표를 실어 보낸다 — 다음 사람이 재조사하지 않도록.
    expect(
      { pin: pin ? `${pin.fires}행` : "슬라이스 없음", top },
      `핀(${PINNED.region}/${PINNED.brand})이 조용해졌다. PINNED 를 위 top 중 하나로 옮기고 이 주석의 실측표를 갱신하라. 현재 상위: ${top}`,
    ).toMatchObject({ pin: expect.not.stringMatching(/^0행$|슬라이스 없음/) });
  });

  it("단일 슬라이스는 공허하게 통과할 수 있다 (#113 의 실제 결함)", async () => {
    // 이 단언이 통과한다는 것 자체가 "슬라이스 하나로는 못 믿는다"의 증거다.
    const rows = await discoverSlices();
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.fires === 0).length).toBeGreaterThan(0);
  });

  it("핀 슬라이스에서 규칙 on/off 가 다른 값을 낸다 (발화 선단언)", async () => {
    const rows = (await getDb().execute(sql`
      SELECT
        COALESCE(sum(m.mention_count) FILTER (
          WHERE ${canonRollupSql({})} IN ${trackedIn()}), 0)::int AS with_prefix,
        COALESCE(sum(m.mention_count) FILTER (
          WHERE ${rollupWithoutPrefix()} IN ${trackedIn()}), 0)::int AS without_prefix,
        count(*) FILTER (WHERE ${firesSql()})::int AS fires
      ${sliceFrom(PINNED.region, PINNED.brand)}
    `)) as unknown as Array<{
      with_prefix: number;
      without_prefix: number;
      fires: number;
    }>;
    const r = rows[0]!;
    // ① 발화 선단언 — 이게 0이면 아래 비교는 의미가 없다(공허 통과 차단).
    expect(r.fires).toBeGreaterThan(0);
    // ② 규칙은 당사 언급을 **회수하는** 방향으로만 작동해야 한다.
    //    (귀속이 HMG 3사 사이에서만 오가는 행은 총계에 안 잡히므로 ≥ 가 맞다.)
    expect(r.with_prefix).toBeGreaterThan(r.without_prefix);
  });

  it("규칙이 되찾는 것은 전부 HMG 3사 rollup 이다 (오검출 0)", async () => {
    // 접두 규칙이 비HMG 를 당사로 끌어오면 SoV 가 조용히 부풀려진다.
    const ids = new Set<string>(Object.values(HMG_BRAND_ENTITY_IDS));
    const rows = (await getDb().execute(sql`
      SELECT DISTINCT ${canonRollupSql({})}::text AS canon
      ${sliceFrom(PINNED.region, PINNED.brand)} AND ${firesSql()}
    `)) as unknown as Array<{ canon: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !ids.has(r.canon))).toEqual([]);
  });
});
