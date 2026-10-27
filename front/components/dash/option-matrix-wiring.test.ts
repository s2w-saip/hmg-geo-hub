import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveMatrixOptions } from "./dimension-filter-panel";

// 옵션 매트릭스 배선 계약 (2026-09-18, PR #275).
// 패널은 매트릭스를 **draft 브랜드**로 좁힌다. 서버가 같은 표를 **적용된 브랜드**로 먼저
// 자르면, 다른 브랜드를 고르는 순간 교집합이 0행이 되어 국가 드롭다운이 빈다. 글로벌 표를
// 선축소하지 않는 규칙은 패널 옵션 화면(back/bff/screens/_filters.py, shared/panel-options ·
// overview/filters)이 지키고, 페이지는 받은 optionMatrix 를 그대로 넘긴다. 여기서는 그
// 결함이 패널에서 어떻게 드러나는지를 고정한다.
const PAGES: ReadonlyArray<[rel: string, expr: string]> = [
  ["app/[locale]/(dash)/dashboard/page.tsx", "optionMatrix={v.optionMatrix}"],
  ["app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx", "optionMatrix={options.optionMatrix}"],
  ["app/[locale]/(dash)/standard/answer-analysis/citation/page.tsx", "optionMatrix={bar.options.optionMatrix}"],
];

describe("옵션 매트릭스 배선", () => {
  it.each(PAGES)("%s 는 화면이 보낸 매트릭스를 그대로 넘긴다(다시 좁히지 않는다)", (rel, expr) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    expect(src).toContain(expr);
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
