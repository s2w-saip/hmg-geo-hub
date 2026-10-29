// 2026-09-04 프로덕션 회귀: 0052 적용 직후 website 도메인별 인용 집계가
// `column "bk" does not exist` 로 500. 원인 = 그 쿼리의 c2 CTE 만 정규화 컬럼을
// 투영하지 않는데, 공유 헬퍼 citationOwnedByUrlSelect 는 컬럼이 있으면 `bk` 를 읽는다.
// 컬럼이 없던 동안에는 폴백 경로라 드러나지 않았다 — 마이그레이션이 노출시켰다.
//
// 이 테스트는 "ownedByUrl 을 쓰는 모든 c2 정의는 bk 를 투영한다"는 성질을
// 소스 형태로 고정한다(쿼리는 실행 시 DB 가 필요해 단위로 못 돈다).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("citation owned-by-url CTE 는 항상 bk 를 투영한다", () => {
  it("ownedByUrl/citationOwnedByUrlSelect 호출부의 직전 c2 정의에 citationNormProjection 이 있다", () => {
    const src = readFileSync(
      join(process.cwd(), "lib/db/repositories/scope-aggregates.ts"),
      "utf8",
    ).split("\n");
    const offenders: number[] = [];
    src.forEach((line, i) => {
      const isCall =
        (line.includes("ownedByUrl(sql`c2`)") ||
          line.includes("citationOwnedByUrlSelect(sql`c2`")) &&
        !line.includes("const ownedByUrl");
      if (!isCall) return;
      const block = src.slice(Math.max(0, i - 12), i + 1).join("\n");
      if (!block.includes("citationNormProjection")) offenders.push(i + 1);
    });
    expect(offenders).toEqual([]);
  });
});
