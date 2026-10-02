import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { TREND_WINDOW_DAYS } from "./scope-aggregates";

// 회귀 가드 — allRuns 추이 읽기가 **120일 창** 밖으로 새지 않게 (2026-09-03).
//
// allRuns 추이는 런 윈도 제한이 없어 전 이력을 스캔한다. 프로덕션
// pg_stat_statements 실측(PR #178 §6): 같은 주별 DISTINCT ON 스냅샷인데 120일
// 바운드가 있는 계열은 평균 2.2s / 최대 23.5s, 없는 계열은 평균 53.5s / 최대
// 119.1s 였다. 병목은 스냅샷 선정(533ms)이 아니라 그 위의 인용·언급 조인이라
// 스캔 모수를 상수화하는 것이 남은 레버였다.
//
// 이 가드가 없으면 새 추이 함수가 바운드 없이 추가되거나(가장 흔한 재발 경로),
// 기존 함수의 WHERE 가 리팩터링 중에 창을 떨구고도 조용히 통과한다 — 유닛
// 테스트는 SQL 을 실행하지 않아 느려진 것을 못 본다.
const SRC = readFileSync(
  fileURLToPath(new URL("./scope-aggregates.ts", import.meta.url)),
  "utf8",
);

// 함수 본문만 잘라낸다 — 다음 최상위 선언 직전까지
// (trend-bucket-snapshot.test.ts 와 동일한 절단 규칙).
function bodyOf(name: string): string {
  const start = SRC.search(new RegExp(`^(export )?async function ${name}\\(`, "m"));
  expect(start, `${name} 를 찾지 못했다`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  const next = rest.search(/^(export )?(async function|interface|const|type) /m);
  return next === -1 ? SRC.slice(start) : SRC.slice(start, start + 1 + next);
}

// allRuns(전 이력) 추이 읽기 전부. 새 추이 함수를 만들면 여기 등재해야 한다.
const BOUNDED_TREND_FNS = [
  "aggregateStandardTrendFromMirror", // KPI 추이 ①~⑤ (표준·웹사이트 공용)
  "aggregateCitationAccuracyTrend", // ⑥ 프로젝트
  "aggregateWebsiteCitationAccuracyTrend", // ⑥ 웹사이트
  "readCitationDomainDayCounts", // 답변분석 인용 추이 (2026-08-12 선례)
  "readMentionBrandDayCounts", // 답변분석 언급 추이 (2026-08-12 선례)
];

describe("추이(allRuns) 읽기의 120일 창", () => {
  it("창은 120일(~17주)이다 — 바꾸면 화면 의미와 i18n 문구가 함께 바뀐다", () => {
    expect(TREND_WINDOW_DAYS).toBe(120);
  });

  // 2026-09-20(통합 B1) — 주별 Top-N 두 리더는 `trendWindowFloor` 를 **직접** 부르지 않고
  // 공용 바닥 빌더 `weeklyTopNTrendFloor(onTrendGrid[, caJoined])` 를 경유한다. 그 빌더가
  // 안에서 같은 헬퍼를 부르고, 격자에 얹히는 호출에서만 상한을 180 으로 넓힌다
  // (`lib/period/trend-grid-wiring.test.ts` 의 "격자에 갇히는 리더의 창 바닥" 이 정본).
  // 여기서 막는 것은 여전히 **바운드가 아예 없는 것**(전 이력 스캔)이다.
  it.each(BOUNDED_TREND_FNS)("%s 는 공통 창 헬퍼로 바운드된다", (name) => {
    const body = bodyOf(name);
    expect(body, `${name}: 창 바닥이 없다 — 전 이력 스캔`).toMatch(
      /trendWindowFloor\(|weeklyTopNTrendFloor\(/,
    );
  });

  it("창을 인라인 리터럴로 재선언하지 않는다 (정본은 상수 하나)", () => {
    // 인라인이 남아 있으면 상수를 바꿔도 그 함수만 옛 창에 머문다.
    // 대상은 measured_at 하한만 — `r.started_at >= now() - interval '7 days'`
    // (루트 full-cycle 런 윈도)는 창이 아니라 배치 선택 규칙이라 무관하다.
    const code = SRC.split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    const inline = code.match(/measured_at >= now\(\) - interval '\d+ days'/g) ?? [];
    expect(inline, `인라인 창 리터럴: ${inline.join(", ")}`).toEqual([]);
  });

  it("컴파일된 SQL 은 바인드 파라미터가 아니라 리터럴 interval 을 쓴다", () => {
    // pg_stat_statements 정규화 텍스트를 배포 전후로 비교하려면 이 자리가
    // $n 으로 갈리면 안 된다(기존 두 리더가 리터럴이었다).
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      sql`SELECT 1 WHERE ${sql`a.measured_at >= now() - ${sql.raw(`interval '${TREND_WINDOW_DAYS} days'`)}`}`,
    );
    expect(compiled.sql).toContain("interval '120 days'");
    expect(compiled.params).toEqual([]);
  });

  it("latestMeasureDays 는 **일부러** 바운드하지 않는다", () => {
    // 이 함수는 추이가 아니라 Sub KPI '직전 측정 대비'의 비교 시점 탐색이다.
    // 창을 걸면 측정 공백이 창보다 길 때 직전 측정일을 잃어 칩이 통째로 사라진다.
    const body = bodyOf("latestMeasureDays");
    expect(body).toMatch(/allRuns: true/);
    expect(body).not.toMatch(/trendWindowFloor\(/);
  });
});
