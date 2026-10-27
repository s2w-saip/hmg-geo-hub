import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CategoryDonut } from "./citations-view";
import { donutPctFor } from "./citation-vm.fixture";

// 도넛 중앙의 공식(HMG) 비중은 인용 현황 카드와 같은 반올림이어야 한다. toFixed(1) 은 이진 부동소수 때문에
// x.x5 경계에서 카드와 0.1 갈렸다(247 / 2000 = 12.35 → 카드 12.4%, 도넛 12.3%). 중앙 값은 서버가 계산하고
// (back/bff/screens/citation_model.py donut_official_pct), 도넛은 받은 값(12.4)을 그대로 그린다.

describe("CategoryDonut center share", () => {
  it("rounds like the status card", () => {
    const data = [
      { name: "Official (HMG)", value: 247 },
      { name: "Automotive Media", value: 1753 },
    ];
    const html = renderToStaticMarkup(
      <CategoryDonut title="t" centerLabel="c" data={data} officialPct={donutPctFor(data)} activeCategories={[]} onSliceClick={() => {}} label={(n) => n} variant="standard" />,
    );
    expect(html).toContain("12.4%");
    expect(html).not.toContain("12.3%");
  });
});
