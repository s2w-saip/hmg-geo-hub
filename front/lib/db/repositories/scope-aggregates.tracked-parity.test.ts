import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 2026-08-28 정합 회귀 가드.
//
// 배경: 같은 슬라이스(AE/Genesis)에서 대시보드와 답변분석>언급이 다른 값을 내던
// 원인 중 하나가 "당사(tracked) 판정"이 두 갈래로 갈려 있던 것이다 —
// 랭킹·점유율은 canonRollupSql 로 알리아스를 접은 뒤 비교했고, 노출률·우호도·
// 순위·Sub KPI 는 raw `m.brand_rollup_entity_id` 를 그대로 비교했다.
// 이제 전 호출부가 trackedRollupPredicate() 하나를 쓴다.
//
// 이 테스트는 소스 텍스트를 본다 — 술어가 SQL 조각이라 단위 실행으로 잡을 수
// 없고, "새 집계를 추가하면서 raw 비교를 다시 쓰는" 재발이 정확히 이 파일에서
// 일어나기 때문이다(2026-08 이전 14개 지점이 그렇게 늘어났다).
const SRC = readFileSync(
  fileURLToPath(new URL("./scope-aggregates.ts", import.meta.url)),
  "utf8",
);

// 주석 줄은 규칙을 설명하느라 금지 패턴을 인용할 수 있으므로 코드 줄만 본다.
const codeLines = SRC.split("\n").filter((l) => !l.trim().startsWith("//"));

describe("tracked 판정 술어 — 단일 정본", () => {
  it("raw brand_rollup_entity_id 를 trackedRollupIn 과 직접 비교하는 곳이 없다", () => {
    const offenders = codeLines.filter((l) =>
      /\.brand_rollup_entity_id IN \$\{trackedRollupIn/.test(l),
    );
    expect(offenders).toEqual([]);
  });

  it("trackedRollupPredicate 가 실제로 여러 집계에서 쓰인다 (도입만 하고 미사용 방지)", () => {
    const uses = codeLines.filter((l) =>
      /\$\{trackedRollupPredicate\(/.test(l),
    ).length;
    expect(uses).toBeGreaterThanOrEqual(10);
  });

  it("trackedRollupPredicate 는 canonRollupSql 로 접은 뒤 비교한다", () => {
    const body = SRC.slice(
      SRC.indexOf("function trackedRollupPredicate("),
      SRC.indexOf("// 표시명 병합(2026-08-06)"),
    );
    expect(body).toContain("canonRollupSql(f, alias)");
    expect(body).toContain("trackedRollupIn(f)");
  });

  it("canonRollupSql 은 표기 접두 교정을 id CASE 보다 먼저 평가한다", () => {
    const body = SRC.slice(
      SRC.indexOf("function canonRollupSql("),
      SRC.indexOf("function escapeRegexLiteral("),
    );
    expect(body).toContain("hmgBrandPrefixEntries()");
    // CASE (NULL 단락) ... prefixCases ... ELSE byId — 접두가 먼저, id 접기가 폴백.
    // NULL 단락의 존재·행동은 scope-aggregates.null-rollup-parity.test 가 컴파일된
    // SQL 로 강제한다(소스 grep 이 아니라 행동 가드).
    expect(body).toMatch(
      /CASE WHEN \$\{rid\} IS NULL THEN \$\{rid\} \$\{sql\.join\(prefixCases[\s\S]*ELSE \$\{byId\}/,
    );
  });

  it("GEO 경쟁 랭킹도 canon 이름으로 GROUP BY 한다 (알리아스 분리 행 방지)", () => {
    const body = SRC.slice(
      SRC.indexOf("export async function aggregateGeoCompetitionFromMirror("),
      SRC.indexOf("export const SIGNAL_COLUMNS"),
    );
    expect(body).toContain("canonBrandNameSql");
    expect(body).toContain("canonRollupSql(filters)");
    expect(body).not.toContain("n.entity_id = m.brand_rollup_entity_id");
  });
});
