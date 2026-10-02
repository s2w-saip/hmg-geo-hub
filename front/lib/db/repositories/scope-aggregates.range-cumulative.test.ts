import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// 2026-09-06 회귀 가드 — "기간을 바꿔도 숫자가 안 바뀐다".
//
// 웹사이트 대시보드는 기간이 걸리면 **그 기간 회차들의 합**을 보여준다(제품 결정).
// 종전 스냅샷("기간 내 최신 배치")은 달력을 어떻게 움직여도 그 안에 최신 회차만
// 들어 있으면 같은 숫자를 냈다 — 프리셋이 전부 오늘 끝나는 트레일링 창이라
// 실질적으로 항상 그랬다(실측: 국가=KR 7일·30일·1년 전부 답변 910·언급 11,881).
//
// 그 스위치가 `filters.cumulative` 이고, 여기서 고정하는 것은 **SQL 이 실제로 두
// 갈래로 갈린다**는 것이다:
//   · 스냅샷  → 배치 선택(`a.job_id IN (…)`), 행 클리핑 없음
//   · 누적    → 런 전체(`a.run_id IN (…)`) + 기간 클리핑
//
// ⚠️ 2026-09-16 축 이동 이후 누적의 기간 축은 `a.measured_at` 이 **아니라 회차
// 앵커**(`scope_runs.cycle_anchor_at`)다 — `a.measured_at` 클리핑은 앵커가 NULL 인
// run(0.14%)의 폴백 arm 안에만 남는다. 축 자체의 계약은
// `scope-aggregates.cycle-anchor-axis.test.ts` 가 고정하고, 이 파일은 **모드 전환**
// (스냅샷 ↔ 누적)만 본다.
// 실측 검산(국가=KR, 08-08~09-06 누적): 답변 3,459 = 926+1,623+910,
// 언급 42,380 = 11,881+22,280+8,219 — 구간별 합과 정확히 일치했다.

vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: vi.fn(), transaction: vi.fn() }) }));

const { answerWhere, detailAnswerWhere, snapshotRunFilter } = await import(
  "@/lib/db/repositories/scope-aggregates"
);
const dialect = new PgDialect();
const sqlText = (f: Parameters<typeof answerWhere>[0]) =>
  dialect.sqlToQuery(answerWhere(f, ["11111111-1111-4111-8111-111111111111"])).sql;

const RANGE = { dateFrom: "2026-08-08", dateTo: "2026-09-06" } as const;

describe("기간 축 의미론", () => {
  it("스냅샷(기본)은 배치를 고르고 measured_at 을 자르지 않는다", () => {
    const s = sqlText({ ...RANGE });
    expect(s).toContain("a.job_id IN");
    // 신선도 바닥(`a.measured_at >= pm.floor_at`)은 배치 선택의 일부라 남는다 —
    // 없어야 하는 것은 **필터 날짜로 행을 자르는** 클리핑(파라미터 바인딩)이다.
    expect(s).toContain("a.measured_at >= pm.floor_at");
    expect(s).not.toMatch(/a\.measured_at >= \$\d/);
  });

  it("누적은 런 전체 + measured_at 클리핑 — 기간 안 회차가 전부 합산된다", () => {
    const s = sqlText({ ...RANGE, cumulative: true });
    expect(s).toContain("a.run_id IN");
    expect(s).toMatch(/a\.measured_at >= \$\d+::date/);
    expect(s).toMatch(/a\.measured_at < \(\$\d+::date \+ 1\)/);
    // 배치 선택으로 되돌아가면 "기간을 바꿔도 안 바뀐다" 가 재발한다.
    expect(s).not.toContain("a.job_id IN");
  });

  it("두 갈래의 SQL 이 실제로 다르다", () => {
    expect(sqlText({ ...RANGE })).not.toBe(sqlText({ ...RANGE, cumulative: true }));
  });
});

// ── 상세(detail) 경로도 같은 규약 — 2026-09-16 ────────────────────────────────
//
// 위 규약은 `answerWhere`(도메인표·요약타일)에만 적용돼 있었고, 인용/언급 **상세**
// 모집단(`detailAnswerWhere`)은 `f.cumulative` 를 아예 읽지 않아 항상 스냅샷이었다.
// 그래서 페이지가 `cumulative: true` 를 넘겨도(2026-09-04~) 상세 숫자는 "셀당 최신
// 1건 + floor_at 7일 바닥"에 갇혔다.
//
// 고객 신고(이노션, 2026-09-15 · GENESIS GV80 HEV 런칭 1.2v): 기간 8/19~9/15 를
// 걸어도 `genesisnewseurope.com` 인용이 안 뜬다. 라이브 미러 실측(prompt
// 77eb27e1…·chatgpt·KR, scope project 2b146c83…):
//   · 스냅샷 8/19~9/15 → 당선 474셀(전부 9/9·9/10 회차) · 인용 **0**
//     floor_at = max(measured_at) 2026-09-10 05:12Z − 7d = 2026-09-03 05:12Z(UTC)
//     → 9/2 답변은 순위와 무관하게 배제
//   · 누적  8/19~9/15 → 답변 1,896 · 인용 **3** (9/2 2건 + 8/19 1건)
const detailSql = (
  f: Parameters<typeof detailAnswerWhere>[0],
  opts?: Parameters<typeof detailAnswerWhere>[2],
) => dialect.sqlToQuery(detailAnswerWhere(f, ["22222222-2222-4222-8222-222222222222"], opts)).sql;

describe("기간 축 의미론 — 상세(detailAnswerWhere)", () => {
  it("스냅샷(기본)은 배치를 고른다 — 종전 그대로", () => {
    const s = detailSql({ ...RANGE });
    expect(s).toContain("a.job_id IN");
    expect(s).not.toMatch(/a\.measured_at >= \$\d/);
  });

  it("누적은 런 전체 + measured_at 클리핑 (배치 선택을 타지 않는다)", () => {
    const s = detailSql({ ...RANGE, cumulative: true });
    expect(s).toContain("a.run_id IN");
    expect(s).toMatch(/a\.measured_at >= \$\d+::date/);
    expect(s).toMatch(/a\.measured_at < \(\$\d+::date \+ 1\)/);
    expect(s).not.toContain("a.job_id IN");
    // floor_at 7일 바닥은 배치 선택의 일부다 — 누적에는 없어야 한다(9/2 배제의 원인).
    expect(s).not.toContain("pm.floor_at");
  });

  it("두 갈래의 SQL 이 실제로 다르다", () => {
    expect(detailSql({ ...RANGE })).not.toBe(detailSql({ ...RANGE, cumulative: true }));
  });

  // 확정 기획(제품 책임자 2026-09-16) = "필터 없음(기본) = 최신 1회차만". #225 가 웹사이트
  // 대시보드에 세운 형태(`cumulative: Boolean(dateFrom || dateTo)`)와 같다.
  //
  // 이 게이트가 없으면 기본 화면이 `now() − 7일` 창이 되어, **최근 7일 측정이 없는
  // 프로젝트가 통째로 빈 화면**이 된다 — 라이브 실측(2026-09-15 16:30 UTC):
  // 루트 제외 scope 프로젝트 186개 중 51개가 해당(Hyundai IONIQ 34일 · 인용 5,654 → 0).
  it("기간이 없으면 cumulative 스위치가 켜져 있어도 스냅샷이다 (빈 화면 회귀 차단)", () => {
    const s = detailSql({ cumulative: true });
    expect(s).toContain("a.job_id IN");
    // `pm.floor_at` 안의 `interval '7 days'` 는 셀 신선도 바닥이라 남는다 —
    // 없어야 하는 것은 누적 기본창(`a.measured_at >= now() - …`)이다.
    expect(s).toContain("pm.floor_at");
    expect(s).not.toContain("a.measured_at >= now() - interval '7 days'");
    // 페이지가 넘기는 값과 무관하게 SQL 이 같아야 한다.
    expect(s).toBe(detailSql({}));
  });

  it("기간이 한쪽만 있어도 누적이다 (open-ended)", () => {
    expect(detailSql({ dateFrom: "2026-08-08", cumulative: true })).toContain("a.run_id IN");
    expect(detailSql({ dateTo: "2026-09-06", cumulative: true })).toContain("a.run_id IN");
  });

  it("기간이 있으면 기본 7일 창은 붙지 않는다", () => {
    expect(detailSql({ ...RANGE, cumulative: true })).not.toContain("interval '7 days'");
  });

  // 2026-09-04 사고 재발 방지 — 추이(allRuns)에 누적 기본창이 얹히면 주별 그래프가
  // 한 주로 접힌다. `kpiTabTrendWhere` 가 이 경로를 탄다.
  it("추이(allRuns) 읽기는 누적 기본창의 영향을 받지 않는다", () => {
    expect(detailSql({ cumulative: true }, { allRuns: true })).not.toContain(
      "interval '7 days'",
    );
  });

  it("allRuns 호출의 SQL 은 cumulative 유무와 무관하게 동일하다", () => {
    expect(detailSql({ ...RANGE, cumulative: true }, { allRuns: true })).toBe(
      detailSql({ ...RANGE }, { allRuns: true }),
    );
  });

  it("cumulative 없는 2-인자 호출은 SQL 이 바이트 동일 (기존 호출부 무영향)", () => {
    expect(detailSql({ ...RANGE })).toBe(detailSql({ ...RANGE, cumulative: false }));
  });
});

// ── 두 술어가 같은 판정을 쓴다 — 2026-09-16 제품 확정 ─────────────────────────
//
// 이 버그의 정체가 "판정이 두 벌로 갈라져 있었다"였다(`answerWhere` 만 `cumulative`
// 를 읽고 `detailAnswerWhere` 는 안 읽음, 2026-09-04~09-16). 두 술어가 같은
// `cumulativeMode` 를 쓰는지는 내부 함수라 직접 못 보므로, **모드 전환 지점이
// 같은지**를 관찰 가능한 SQL 형태로 고정한다. 한쪽만 규칙이 바뀌면 깨진다.
const MODE_CASES: ReadonlyArray<[string, Parameters<typeof answerWhere>[0], "snapshot" | "cumulative"]> = [
  ["필터 없음", {}, "snapshot"],
  ["cumulative 만 (기간 없음)", { cumulative: true }, "snapshot"],
  ["기간만 (cumulative 없음)", { ...RANGE }, "snapshot"],
  ["cumulative + 기간", { ...RANGE, cumulative: true }, "cumulative"],
  ["cumulative + dateFrom 만", { dateFrom: RANGE.dateFrom, cumulative: true }, "cumulative"],
  ["cumulative + dateTo 만", { dateTo: RANGE.dateTo, cumulative: true }, "cumulative"],
];

// `snapshotRunFilter` 는 bare-column(미러 JS 경로) 트윈이라 `a.` 접두가 없다.
const srfSql = (f: Parameters<typeof answerWhere>[0]) =>
  dialect.sqlToQuery(snapshotRunFilter(["22222222-2222-4222-8222-222222222222"], f)).sql;

describe("answerWhere / detailAnswerWhere / snapshotRunFilter 는 같은 기간 판정을 공유한다", () => {
  // ⚠️ `snapshotRunFilter` 가 이 목록에 들어온 이유(2026-09-16 독립 검증 AC4 실패):
  // 이 술어만 `cumulative` 를 안 읽어 **카드 156,566 vs 드릴다운 37,200 = 4.2배** 였다.
  // 브랜드 드릴다운(언급·인용)이 전부 이 술어를 탄다.
  for (const [label, f, expected] of MODE_CASES) {
    it(`${label} → ${expected} (세 술어 동일)`, () => {
      const srf = srfSql(f);
      if (expected === "cumulative") {
        expect(srf).toContain("run_id IN");
        expect(srf).not.toContain("job_id IN (\n    SELECT DISTINCT ON");
      } else {
        expect(srf).toContain("job_id IN");
      }
      for (const s of [sqlText(f), detailSql(f)]) {
        if (expected === "cumulative") {
          expect(s).toContain("a.run_id IN");
          expect(s).not.toContain("a.job_id IN");
        } else {
          expect(s).toContain("a.job_id IN");
          expect(s).not.toContain("a.run_id IN");
        }
      }
    });
  }

  it("어느 쪽도 누적 기본창을 만들지 않는다 (기간 없는 누적은 도달 불가)", () => {
    for (const s of [sqlText({ cumulative: true }), detailSql({ cumulative: true })]) {
      expect(s).not.toContain("a.measured_at >= now() - interval '7 days'");
    }
    expect(srfSql({ cumulative: true })).not.toContain("measured_at >= now() - interval '7 days'");
  });

  // 브랜드 드릴다운 선축소 — 켜지는 조건과 SQL 형태를 고정한다.
  it("onlyBrand 를 안 주면 SQL 이 종전과 바이트 동일 (기존 호출부 무영향)", () => {
    const wide = dialect.sqlToQuery(snapshotRunFilter(undefined, { ...RANGE, cumulative: true })).sql;
    expect(wide).not.toContain("scope_mentions");
  });

  it("onlyBrand 를 주면 그 브랜드 job 으로 선축소한다", () => {
    const q = dialect.sqlToQuery(
      snapshotRunFilter(undefined, { ...RANGE, cumulative: true }, "Hyundai"),
    );
    expect(q.sql).toContain("FROM scope_mentions m");
    expect(q.sql).toContain("brand_rollup_entity_id IS NOT NULL");
    expect(q.params).toContain("Hyundai");
    // 초과 포함(superset) 이어야 JS 최종 판정이 이긴다 — rollup 표기 OR 원표기.
    expect(q.sql).toMatch(/= \$\d+ OR x\.brand = \$\d+/);
  });
});
