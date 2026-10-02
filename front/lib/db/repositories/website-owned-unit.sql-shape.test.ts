import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { WebsiteOwnedUnit } from "@/lib/scope/website-owned-unit";
import {
  setWebsiteOwnedUnitForTests,
  resetWebsiteOwnedUnitForTests,
} from "@/lib/scope/website-owned-unit-state";

// 유닛 단위 자사 판정의 **스위치 계약** (2026-09-20, 화면 키 `X.websiteOwnedUnit`).
//
// 이 키는 고객이 보는 숫자를 바꾼다(자사 URL 인용률 함대 90.22% → 78.62%). 그래서
// 계약이 둘이고, 둘 다 여기서 텍스트로 고정한다:
//   ① **off 면 SQL 이 글자 그대로 종전과 같다.** 켜지 않은 배포에서 값이 흔들릴
//      자리가 없다는 것의 증거다. "키를 넣었으니 안전하다"는 주장은 off 경로의 SQL 이
//      바이트 동일할 때만 참이다.
//   ② **on 이면 판정이 유닛 컬럼을 본다.** 유닛 CTE 가 붙고, 자사 술어가
//      `ub`(DISTINCT url)에서 `pm`(프롬프트 행)으로 내려온다.
// 그리고 셋째, 이 트랙의 원인 그 자체:
//   ③ **유닛 CTE 는 필터와 무관하다.** flat 경로의 결함이 "브랜드·국가·언어를 고르면
//      자사 집합이 달라져 같은 프롬프트의 판정이 바뀐다" 였다.

const dialect = new PgDialect();
const captured: string[] = [];
const capturedParams: unknown[][] = [];
/**
 * 집계가 돌려받는 행. 기본은 빈 배열인데, 그러면 **"측정 없음" 조기 반환**에 걸려
 * 뒤 문장이 아예 발행되지 않는다(코어 ⑤ 는 `totalAnswers === 0` 에서, 인용 화면은
 * `groups.length === 0` 에서 끊긴다). 자리별 형태를 보려면 한 줄은 돌려줘야 한다.
 */
let stubRows: unknown[] = [];
const execute = vi.fn(async (q: SQL) => {
  try {
    const c = dialect.sqlToQuery(q);
    captured.push(c.sql);
    capturedParams.push(c.params);
  } catch {
    /* raw SET 등 — 형태 검사 대상 아님 */
  }
  return stubRows as unknown as never;
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const PIDS = ["11111111-1111-1111-1111-111111111111"];
const BASES = ["kia.com/kr"];
const UNITS: WebsiteOwnedUnit[] = [
  {
    siteId: "22222222-2222-2222-2222-222222222222",
    fileSeq: 66,
    base: "kia.com/kr",
    sibs: ["kia.com/kr/en"],
    homeHost: null,
  },
  {
    siteId: "33333333-3333-3333-3333-333333333333",
    fileSeq: 128,
    base: "hyundai-n.com",
    sibs: ["hyundai-n.com/ko"],
    homeHost: "hyundai-n.com",
  },
];

beforeAll(async () => {
  // 컬럼 존재 프로브가 answerWhere 의 SQL 텍스트를 바꾸므로 한 번 가라앉힌다.
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
  capturedParams.length = 0;
  resetWebsiteOwnedUnitForTests();
});

afterEach(() => {
  resetWebsiteOwnedUnitForTests();
});

async function targetHitRateSql(
  on: boolean,
  units: WebsiteOwnedUnit[] | undefined,
  filters: Record<string, unknown> = {},
): Promise<string> {
  setWebsiteOwnedUnitForTests(on);
  const m = await import("./scope-aggregates");
  captured.length = 0;
  capturedParams.length = 0;
  await m.aggregateWebsiteTargetHitRate(filters, PIDS, BASES, BASES, units);
  return captured.at(-1)!;
}

/** 마지막 문장의 바인드 값. 유닛 값이 필터마다 같은지 보는 데 쓴다. */
const lastParams = (): unknown[] => capturedParams.at(-1) ?? [];

/**
 * 자리 번호를 지운다. 필터가 붙으면 그 앞에 바인드가 늘어 `$3` 이 `$4` 가 되는데,
 * 그것은 **값이 달라진 것이 아니다**. 이 테스트가 보려는 것은 유닛 CTE 의 구조와
 * 값이지 번호가 아니다(값은 `lastParams` 로 따로 대조한다).
 */
const unnumber = (s: string) => s.replace(/\$\d+/g, "$?");

describe("① 키 off 면 SQL 이 종전과 바이트 동일", () => {
  it("유닛을 넘겨도 키가 꺼져 있으면 안 넘긴 것과 같은 문장이다", async () => {
    const withUnits = await targetHitRateSql(false, UNITS);
    const without = await targetHitRateSql(false, undefined);
    expect(withUnits).toBe(without);
  });

  it("키가 켜져도 유닛이 비면 종전 문장이다 (판정 공집합 방지)", async () => {
    const empty = await targetHitRateSql(true, []);
    const without = await targetHitRateSql(false, undefined);
    expect(empty).toBe(without);
  });

  it("off 문장은 자사 판정을 ub(DISTINCT url)에서 한다 — 종전 형태", async () => {
    const q = await targetHitRateSql(false, UNITS);
    expect(q).toContain("AS owned_base FROM un");
    expect(q).toContain("bool_or(cit.owned_base)");
    expect(q).not.toContain("unit_base");
    expect(q).not.toContain("wu(site_id");
  });
});

describe("② 키 on 이면 판정이 그 프롬프트의 유닛을 본다", () => {
  it("유닛 CTE 3단(wu · wut · wup)이 붙고 프롬프트당 1행으로 접힌다", async () => {
    const q = await targetHitRateSql(true, UNITS);
    expect(q).toContain("wu(site_id, file_seq, unit_base, unit_sibs, unit_home_host)");
    expect(q).toContain("wut AS MATERIALIZED");
    expect(q).toContain("wup AS MATERIALIZED");
    expect(q).toContain("SELECT DISTINCT ON (wp.scope_prompt_id)");
    // 2026-09-20 검증 C 지적 2 수리 — 이 카드도 **다른 자리와 같은 `wup`** 을 쓴다.
    // 종전에는 여기만 `wp LEFT JOIN wu` + bool_or 로 유닛들의 OR 을 취해 규칙이 둘이었다.
    expect(q).not.toContain("LEFT JOIN wu ON wu.site_id = wp.site_id");
    expect(q).toContain("LEFT JOIN wup ON wup.prompt_id = cit.prompt_id::text");
  });

  it("동률 정렬 키가 결정적이다 (unit_base 하나로는 unit_turls 가 흔들린다)", async () => {
    const q = await targetHitRateSql(true, UNITS);
    expect(q).toContain(
      "ORDER BY wp.scope_prompt_id, wu.unit_base, wp.file_seq, wp.site_id",
    );
  });

  it("자사 술어가 ub 에서 pm 으로 내려오고 유닛 컬럼을 읽는다", async () => {
    const q = await targetHitRateSql(true, UNITS);
    expect(q).not.toContain("AS owned_base FROM un");
    expect(q).not.toContain("bool_or(cit.owned_base)");
    expect(q).toContain("wup.unit_base");
    expect(q).toContain("unnest(wup.unit_sibs)");
    expect(q).toContain("wup.unit_home_host");
    // 타겟 항 = 리포트 정본(tracked NORM · 유닛 전체 tset).
    expect(q).toContain("cit.cnorm = ANY(coalesce(wup.unit_turls, ARRAY[]::text[]))");
  });

  it("정규화 사슬은 여전히 DISTINCT url 당 1회다 (플랜 붕괴 방지)", async () => {
    const q = await targetHitRateSql(true, UNITS);
    // wp(target_url) 1 + wut(유닛 tset) 1 + un(인용 url, tracked) 1 = 3.
    // **행당이 아니라** 각각 (등록 프롬프트 | 유닛 | DISTINCT url) 당 1회다. 이 수가
    // 더 늘면 2026-09-03 의 73.9s 플랜 붕괴가 돌아온다.
    expect((q.match(/lower\(regexp_replace\(/g) ?? []).length).toBe(3);
    expect(q).toContain("c2 AS MATERIALIZED");
    expect(q).toContain("un AS MATERIALIZED");
    expect(q).toContain("ub AS MATERIALIZED");
    expect(q).toContain("pm AS MATERIALIZED");
  });

  it("분모는 안 바뀐다 — 유닛 전환은 분자(자사) 술어만 건드린다", async () => {
    const on = await targetHitRateSql(true, UNITS);
    const off = await targetHitRateSql(false, UNITS);
    for (const q of [on, off]) {
      expect(q).toContain("count(DISTINCT snap.prompt_id)");
      expect(q).toContain("SELECT count(*) FROM pm WHERE pm.target_hit");
      expect(q).toContain("SELECT count(*) FROM pm WHERE pm.owned_base_hit OR pm.target_hit");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ①' 나머지 배선 자리 — website 표면 전체가 **한 키로 함께** 움직인다 (2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
// 자사 URL 인용률 카드 하나만 유닛이고 나머지가 flat 이면, 같은 화면에서 "자사 78.6%"
// 옆에 flat 로 계산된 공식 당사 인용 비중·owned 배지·⑤·⑥ 가 나란히 선다. 그래서 자리를
// 하나 추가할 때마다 여기에 줄이 늘어야 한다 — 목록이 곧 계약이다.
type SiteCall = (
  m: typeof import("./scope-aggregates"),
  units: WebsiteOwnedUnit[] | undefined,
  filters: Record<string, unknown>,
) => Promise<unknown>;

interface Site {
  name: string;
  call: SiteCall;
  /**
   * `wup`(프롬프트 → 유닛) CTE 를 쓰는가. **2026-09-20 검증 C 수리 이후 전 자리가 `true`**
   * 다 — 종전에는 `aggregateWebsiteTargetHitRate` 만 `wp LEFT JOIN wu` + `bool_or` 로
   * 유닛들의 OR 을 취해 유닛 선택 규칙이 둘이었다. 필드는 남겨 둔다: 새 자리가 다른
   * 방식으로 유닛을 붙이면 이 목록에서 그 사실이 드러나야 한다.
   */
  wup: boolean;
  /**
   * on 문장이 off 대비 더 가질 수 있는 **정규화 사슬 수**(문장당).
   * 기본 1 = `wut` 이 유닛의 `target_url` 집합을 tracked NORM 으로 접는 몫(유닛당 1회).
   * 출처 구성만 3 — off 경로는 정규화가 **아예 없고**(도메인 정규식 매칭뿐) on 에서
   * 인용의 base·tracked 정규화가 새로 생긴다. 셋 다 owned 후보 도메인 행에만 걸린다.
   *
   * ⚠️ 이 가드가 지키는 명제는 "사슬이 **행 단위로 내려가지 않는다**" 이지 "사슬 수가
   *    안 는다" 가 아니다. 행 단위로 내려가면 델타가 이 상한과 비교도 안 되게 커진다
   *    (2026-09-03: 73.9s 중 72.9s 가 그 형태였다).
   */
  normDelta?: number;
}

const SITES: Site[] = [
  { name: "코어 ⑤ (aggregateStandardFromMirror)", wup: true,
    call: (m, u, f) => m.aggregateStandardFromMirror(f, PIDS, BASES, BASES, true, undefined, u) },
  { name: "Sub KPI Q4 (aggregateSubKpisFromMirror)", wup: true,
    call: (m, u, f) => m.aggregateSubKpisFromMirror(f, PIDS, BASES, BASES, true, {}, u) },
  { name: "⑤ 추이 (aggregateStandardTrendFromMirror)", wup: true,
    call: (m, u, f) => m.aggregateStandardTrendFromMirror(f, "week", PIDS, BASES, BASES, true, undefined, u) },
  { name: "인용 화면 (aggregateCitationsFromMirror)", wup: true,
    call: (m, u, f) => m.aggregateCitationsFromMirror(f, PIDS, BASES, BASES, true, undefined, u) },
  { name: "출처 구성 (aggregateSourceCompositionFromMirror)", wup: true, normDelta: 3,
    call: (m, u, f) => m.aggregateSourceCompositionFromMirror(f, PIDS, BASES, u) },
  { name: "⑥ 카드 (aggregateWebsiteCitationAccuracy)", wup: true,
    call: (m, u, f) => m.aggregateWebsiteCitationAccuracy(f, PIDS, BASES, BASES, u) },
  { name: "⑥ 추이 (aggregateWebsiteCitationAccuracyTrend)", wup: true,
    call: (m, u, f) => m.aggregateWebsiteCitationAccuracyTrend(f, "week", PIDS, BASES, BASES, u) },
  { name: "자사·타겟 URL 인용률 (aggregateWebsiteTargetHitRate)", wup: true,
    call: (m, u, f) => m.aggregateWebsiteTargetHitRate(f, PIDS, BASES, BASES, u) },
];

/**
 * 빈 결과에서 조기 반환하는 자리를 지나가게 하는 최소 행 한 줄.
 * 값은 형태 검사에 쓰이지 않는다 — **문장이 발행되게 하는 것**이 목적이다.
 */
const STUB_ROW = {
  region: "KR", answers: 1, tracked: 1, last_measured_at: null,
  domain: "kia.com", category: null, target: "chatgpt",
  citations: 1, owned: true, owned_citations: 1,
  prompt_id: "44444444-4444-4444-4444-444444444444", job_id: "55555555-5555-5555-5555-555555555555",
  url: "https://kia.com/kr", cites: 1, bucket_total: 1, targets: ["chatgpt"],
  day: "2026-09-11", key: "kia.com", n: 1,
  total: 1, with_cit: 1, bucket: "2026-09-08",
  measured_prompts: 1, hit_prompts: 1, owned_prompts: 1,
  owned_answers: 1, target_answers: 1, measured_days: 1, first_at: null, last_at: null,
};

/** 한 자리의 문장 **전부**(그 호출이 낸 것). 자리마다 문장 수가 다르다. */
async function statementsFor(
  site: Site,
  on: boolean,
  units: WebsiteOwnedUnit[] | undefined,
  filters: Record<string, unknown> = {},
): Promise<string[]> {
  setWebsiteOwnedUnitForTests(on);
  const m = await import("./scope-aggregates");
  stubRows = [STUB_ROW];
  try {
    // 모듈 메모(프로브·판정)가 첫 호출에서만 문장을 내므로 한 번 예열하고 두 번째를 본다.
    await site.call(m, units, filters);
    captured.length = 0;
    await site.call(m, units, filters);
    return captured.slice();
  } finally {
    stubRows = [];
  }
}

describe("①' 키 off 면 어느 자리도 문장이 안 바뀐다", () => {
  it.each(SITES.map((s) => [s.name, s] as const))("%s", async (_name, site) => {
    const withUnits = await statementsFor(site, false, UNITS);
    const without = await statementsFor(site, false, undefined);
    expect(withUnits).toEqual(without);
  });
});

describe("②' 키 on 이면 모든 자리가 유닛 판정으로 함께 넘어간다", () => {
  it.each(SITES.map((s) => [s.name, s] as const))("%s — 유닛 판정식이 실린다", async (_name, site) => {
    const on = (await statementsFor(site, true, UNITS)).join("\n/*—*/\n");
    expect(on).toContain("wu(site_id, file_seq, unit_base, unit_sibs, unit_home_host)");
    expect(on).toContain("unit_base");
    expect(on).toContain("unnest(");
    if (site.wup) {
      expect(on).toContain("wup AS MATERIALIZED");
      // 프롬프트당 1행 보장 — 이게 없으면 인용 count(*) 가 조용히 부풀어 오른다.
      expect(on).toContain("SELECT DISTINCT ON (wp.scope_prompt_id)");
      expect(on).toContain("LEFT JOIN wup ON wup.prompt_id =");
    }
  });

  it.each(SITES.map((s) => [s.name, s] as const))(
    "%s — flat 합집합 매칭이 자사 판정에 남아 있지 않다",
    async (name, site) => {
      // flat 판정의 지문 = `ownedBasePrefixClause` 가 내는 `LIKE ANY(ARRAY[...])`.
      // ⑥ 은 예외다: **분자**(타겟 도달)가 의도적으로 flat 집합이라 `target_set` 이 남고,
      //   그 CTE 는 base 매칭이 아니라 타겟 URL 목록이라 이 지문과 무관하다.
      //   ⑥ 의 분모(자사)에서만 flat 이 빠지면 된다 — `ownedOnN` 이 안 실리는 것으로 본다.
      const stmts = await statementsFor(site, true, UNITS);
      for (const q of stmts) {
        if (!q.includes("unit_base")) continue; // 유닛과 무관한 문장(asOf·통계 등)
        expect(/ LIKE ANY\(ARRAY\[/.test(q), `${name}: flat prefix 매칭이 남았다`).toBe(false);
      }
    },
  );
});

describe("③' 정규화 사슬은 유닛 전환으로 (거의) 늘지 않는다 — 플랜 붕괴 방지", () => {
  // 2026-09-03 의 73.9 s 플랜 붕괴가 정확히 "정규화 식이 행마다·식 등장 횟수만큼" 이었다.
  // 유닛 판정은 값싼 문자열 비교라 행에서 해도 되지만, 정규화까지 행으로 내려오면 안 된다.
  it.each(SITES.map((s) => [s.name, s] as const))("%s", async (_name, site) => {
    const count = (s: string) => (s.match(/lower\(btrim\(|lower\(regexp_replace\(/g) ?? []).length;
    const off = (await statementsFor(site, false, undefined)).map(count);
    const on = (await statementsFor(site, true, UNITS)).map(count);
    expect(on.length).toBe(off.length);
    for (let i = 0; i < on.length; i += 1) {
      expect(on[i] - off[i], `문장 ${i}: 정규화 사슬 증가분`).toBeLessThanOrEqual(site.normDelta ?? 1);
    }
  });
});

/** 유닛 바인드 식별용 — 이 값들이 필터와 무관하게 그대로 실려야 한다. */
const UNIT_VALUES = new Set<string>(
  UNITS.flatMap((u) => [u.siteId, String(u.fileSeq), u.base, u.homeHost ?? ""]).filter(Boolean),
);

describe("③ 유닛 판정은 필터와 무관하다 (flat 결함의 정확한 반대)", () => {
  const FILTERS: Array<[string, Record<string, unknown>]> = [
    ["무필터", {}],
    ["브랜드", { brand: ["Genesis"] }],
    ["국가", { websiteCountry: ["KR"] }],
    ["언어", { lang: ["ko"] }],
    ["브랜드+국가+언어", { brand: ["Kia"], websiteCountry: ["KR"], lang: ["ko"] }],
  ];

  it("유닛 CTE 와 자사 술어가 모든 필터 조합에서 글자 그대로 같다", async () => {
    const slice = (q: string) => {
      const from = q.indexOf("wu(site_id");
      const to = q.indexOf("snap AS MATERIALIZED");
      return unnumber(q.slice(from, to));
    };
    const ownedPred = (q: string) => {
      const from = q.indexOf("bool_or(((coalesce(wup.unit_base");
      return unnumber(q.slice(from, from + 400));
    };
    /** 유닛 바인드만 — 값이 필터마다 같아야 한다(번호는 달라도 된다). */
    const unitParams = (ps: unknown[]) =>
      ps.filter((v) => Array.isArray(v) || UNIT_VALUES.has(String(v)));
    const base = await targetHitRateSql(true, UNITS, FILTERS[0][1]);
    const baseSlice = slice(base);
    const basePred = ownedPred(base);
    const baseParams = JSON.stringify(unitParams(lastParams()));
    for (const [label, f] of FILTERS.slice(1)) {
      const q = await targetHitRateSql(true, UNITS, f);
      expect(slice(q), `${label}: 유닛 CTE`).toBe(baseSlice);
      expect(ownedPred(q), `${label}: 자사 술어`).toBe(basePred);
      expect(JSON.stringify(unitParams(lastParams())), `${label}: 유닛 값`).toBe(baseParams);
    }
  });

  it("유닛 도출은 필터를 받지 않는다 (시그니처로 고정)", async () => {
    const m = await import("./scope-aggregates");
    // 인자를 받게 되는 순간 화면 축이 판정에 새어 들어올 수 있다.
    expect(m.websiteOwnedUnits.length).toBe(0);
  });
});
