import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveMatrixOptions } from "./dimension-filter-panel";

// 옵션 매트릭스 배선 계약 (2026-09-18, PR #275).
// 패널은 매트릭스를 **draft 브랜드**로 좁힌다. 서버가 같은 표를 **적용된 브랜드**
// (narrowScopeBrands → optionScope)로 먼저 자르면, 다른 브랜드를 고르는 순간 교집합이
// 0행이 되어 국가 드롭다운이 빈다. deriveMatrixOptions 단위 테스트는 온전한 표를
// 넣으므로 이 배선 결함을 못 본다 — 그래서 호출부를 직접 단언한다.
const PAGES = [
  "app/[locale]/(dash)/dashboard/page.tsx",
  "app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx",
  "app/[locale]/(dash)/standard/answer-analysis/citation/page.tsx",
];

describe("옵션 매트릭스 배선", () => {
  it.each(PAGES)("%s 는 매트릭스를 적용 브랜드로 선축소하지 않는다", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    const calls = src.match(/listMeasuredScopeMatrix\(([^,)]*)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).not.toContain("optionScope");
  });

  it("선축소된 표는 다른 브랜드에서 국가 0개가 된다 (결함 재현)", () => {
    const full = [
      { brand: "Hyundai", region: "KR", lang: "ko" },
      { brand: "Kia", region: "KR", lang: "ko" },
      { brand: "Kia", region: "US", lang: "en" },
    ];
    const narrowed = full.filter((r) => r.brand === "Hyundai");
    expect(deriveMatrixOptions(narrowed, ["Kia"], undefined).regions).toEqual([]);
    expect([...deriveMatrixOptions(full, ["Kia"], undefined).regions].sort()).toEqual(["KR", "US"]);
  });
});
