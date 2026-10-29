import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 회귀 가드 — 추이(시계열) 읽기가 "버킷별 셀 최신 1건" 규칙에서 이탈하지 않게.
//
// 2026-09-01 이전: KPI 추이(①~⑤)와 ⑥ 인용 정확도 추이는 allRuns 로 그 기간의 **전
// 답변**을 셌다. 카드는 스냅샷(셀당 최신 1건)이라, 한 주에 재측정된 셀이 추이에서만
// 이중 계상돼 같은 화면의 카드와 그래프 호버가 어긋났다(실측 Kia·KR 웹사이트:
// 카드 300답변/1,930인용 vs 마지막 주 버킷 497답변/1,950인용 → ⑤·⑥ 0.1~0.2%p).
// 답변분석 추이(readCitationDomainDayCounts)는 2026-08-12 결정으로 이미 이 규칙을
// 쓰고 있었고, 남아 있던 KPI 추이 3곳을 맞춘 것이다.
const SRC = readFileSync(
  fileURLToPath(new URL("./scope-aggregates.ts", import.meta.url)),
  "utf8",
);

// 함수 본문만 잘라낸다 — 다음 최상위 export 선언 직전까지.
function bodyOf(name: string): string {
  // 일부는 모듈 내부 헬퍼라 export 가 없다(readCitationDomainDayCounts).
  const start = SRC.search(new RegExp(`^(export )?async function ${name}\\(`, "m"));
  expect(start, `${name} 를 찾지 못했다`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  const next = rest.search(/^(export )?(async function|interface|const|type) /m);
  return next === -1 ? SRC.slice(start) : SRC.slice(start, start + 1 + next);
}

const TREND_FNS = [
  "aggregateStandardTrendFromMirror", // KPI 추이 ①~⑤ (표준·웹사이트 공용)
  "aggregateCitationAccuracyTrend", // ⑥ 프로젝트
  "aggregateWebsiteCitationAccuracyTrend", // ⑥ 웹사이트
  "readCitationDomainDayCounts", // 답변분석 인용 추이 (2026-08-12 선례)
];

describe("추이 = 버킷별 스냅샷 (카드와 같은 단위)", () => {
  it.each(TREND_FNS)("%s 는 버킷+셀 단위로 DISTINCT ON 한다", (name) => {
    const body = bodyOf(name);
    expect(body).toMatch(/DISTINCT ON/);
    // 셀 = 프롬프트 × 엔진(target) × 지역. 하나라도 빠지면 중복이 다시 샌다.
    for (const col of ["prompt_id", "a.target", "a.region"]) {
      expect(body, `${name}: DISTINCT ON 에 ${col} 가 없다`).toContain(col);
    }
    // 버킷이 키에 안 들어가면 전 기간에서 1건만 남아 시계열이 붕괴한다.
    expect(body).toMatch(/date_trunc/);
    // 최신 1건이어야 한다 — ORDER BY 가 measured_at DESC 로 끝나지 않으면
    // 어떤 행이 남는지 플랜 의존이 된다.
    expect(body).toMatch(/measured_at DESC/);
  });

  it("DISTINCT ON 식은 바인드 파라미터가 아니라 리터럴 버킷을 쓴다", () => {
    // Postgres 는 DISTINCT ON 식이 ORDER BY 선두와 **문자적으로** 같기를 요구한다.
    // date_trunc(${field}, …) 처럼 파라미터로 넣으면 두 자리가 $1/$2 로 갈려
    // "SELECT DISTINCT ON expressions must match initial ORDER BY expressions" 로
    // 런타임에 죽는다(유닛 테스트는 SQL 을 실행하지 않아 못 잡는다).
    for (const name of TREND_FNS) {
      const body = bodyOf(name);
      if (!/DISTINCT ON/.test(body)) continue;
      expect(body, `${name}: 버킷 식에 바인드 파라미터가 쓰였다`).not.toMatch(
        /DISTINCT ON \([^)]*date_trunc\(\$\{field\}/,
      );
    }
  });
});
