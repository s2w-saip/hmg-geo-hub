import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BARE_ONLY_NON_COMPETITOR_PATTERNS,
  isNonCompetitorMention,
} from "@/lib/scope/non-competitor-brands";
import { NAME_BOUNDARY_CLASS } from "@/lib/scope/text-trim";

// 2026-08-29 정합 회귀 가드 (bare-only 비경쟁 제외).
//
// 배경: 비경쟁 제외는 **rollup 표기**로 판정하므로 이름 하나가 그 rollup 에 매달린
// 하위 Product 언급까지 함께 지운다. smart/cruise/international 은 이름이 진짜
// 자동차·모빌리티 브랜드와 겹쳐 그 대가가 실제 데이터 손실이었다(Smart Fortwo 계열
// 161 언급 소실). 이제 bare 표기만 제외하고 이름을 확장한 하위 제품은 살린다.
//
// 이 가드가 잡아야 하는 재발은 **한쪽 경로만 고치는 것**이다 — SQL(집계)과
// JS(result-adapter)가 갈리면 표면끼리 다시 어긋난다(#113 이 갚은 부채가 그것).
// 술어가 SQL 조각이라 단위 실행으로 못 잡으므로 소스 텍스트를 본다
// (scope-aggregates.tracked-parity.test.ts 와 같은 방식·같은 이유).
const AGG = readFileSync(
  fileURLToPath(new URL("./scope-aggregates.ts", import.meta.url)),
  "utf8",
);
const ADAPTER = readFileSync(
  fileURLToPath(new URL("../../scope/result-adapter.ts", import.meta.url)),
  "utf8",
);

const aggCodeLines = AGG.split("\n").filter((l) => !l.trim().startsWith("//"));

describe("비경쟁 제외 — SQL·JS 두 경로가 같은 규칙을 쓴다", () => {
  it("scope_mentions 집계의 모든 호출부가 자기 표기(m.brand)를 함께 넘긴다", () => {
    // 술어 진입점이 둘이다(2026-09-01 성능 작업에서 갈라짐):
    //  · excludeNonCompetitorBrandsSql — 원 표기를 받아 안에서 정규화
    //  · excludeNonCompetitorBaresSql  — 이미 정규화된 키(names 쪽 사전 계산)를 받음
    // 판정 로직은 하나이므로 가드도 **둘 다** 세야 한다. 종전에는 앞의 것만 세서,
    // 뒤로 이관된 호출부가 커버리지에서 조용히 빠졌다(2026-09-02 KPI 탭 이식에서 발현).
    const sites = aggCodeLines.filter((l) =>
      /AND \$\{excludeNonCompetitor(Brands|Bares)Sql\(/.test(l),
    );
    expect(sites.length).toBeGreaterThanOrEqual(12);
    const offenders = sites.filter((l) => !/sql`(m|x)\.brand`/.test(l));
    expect(offenders).toEqual([]);
  });

  it("SQL 술어가 bare-only 패턴을 ~* 로 붙인다 (되살리기 분기 존재)", () => {
    const body = AGG.slice(
      AGG.indexOf("function excludeNonCompetitorBrandsSql("),
      AGG.indexOf("// Domain-level owned-citation detection"),
    );
    expect(body).toContain("BARE_ONLY_NON_COMPETITOR_PATTERNS");
    expect(body).toContain("~*");
    // ownCol 미전달 시 종전 동작(하위 호환) — 되살리기 분기를 건너뛴다.
    expect(body).toContain("if (!ownCol");
  });

  it("JS 경로가 bare 전용 판정(isNonCompetitorBrand)을 더는 쓰지 않는다", () => {
    expect(ADAPTER).toContain("isNonCompetitorMention");
    expect(ADAPTER).not.toContain("isNonCompetitorBrand(");
  });

  it("JS 경로가 rollup 표기와 자기 표기를 함께 넘긴다", () => {
    expect(ADAPTER).toContain("isNonCompetitorMention(name, m.display_name)");
  });
});

// POSIX 패턴(SQL)과 JS 판정이 같은 답을 내는지 — 미러 실측 전수 케이스로 대조한다.
// `[^[:alnum:]]` → `[^\p{L}\p{Nd}]` 로만 바꾼 것이 두 술어의 유일한 차이여야 한다
// (등가 근거는 lib/scope/text-trim.ts::NAME_BOUNDARY_CLASS — PG 실측).
function matchesPosixTwin(rollupName: string, ownName: string): boolean {
  const entry = BARE_ONLY_NON_COMPETITOR_PATTERNS.find(
    ([n]) => n === rollupName.trim().toLowerCase(),
  );
  if (!entry) return false;
  const js = new RegExp(
    entry[1].replace("[^[:alnum:]]", `[^${NAME_BOUNDARY_CLASS}]`),
    "iu",
  );
  return js.test(ownName.trim());
}

describe("SQL 패턴 ↔ JS 판정 등가 (미러 실측 전수 케이스)", () => {
  // 2026-08-29 프로덕션 미러: 세 rollup 그룹에 속한 (rollup, 자기표기) 전수.
  const cases: Array<[rollup: string, own: string, revive: boolean]> = [
    ["Smart", "Smart", false],
    ["Smart", "Smart Fortwo", true],
    ["Smart", "Smart Fortwo EQ", true],
    ["Smart", "Smart EQ Fortwo", true],
    ["Smart", "Charge point", false],
    ["Smart", "Fiat Avventura", false],
    ["Smart", "Hyundai Venue N Line N10", false],
    ["Cruise", "Cruise", false],
    ["Cruise", "Cruise Origin", true],
    ["Cruise", "2nd gen", false],
    ["International", "International", false],
    ["International", "Mission Raceway Park", false],
  ];

  it.each(cases)("%s / %s → 되살림=%s", (rollup, own, revive) => {
    expect(matchesPosixTwin(rollup, own)).toBe(revive);
    expect(isNonCompetitorMention(rollup, own)).toBe(!revive);
  });
});
