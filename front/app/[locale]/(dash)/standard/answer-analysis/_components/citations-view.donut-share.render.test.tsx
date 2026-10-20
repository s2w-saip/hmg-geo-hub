import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CategoryDonut } from "./citations-view";
import { categoryShare } from "../_data/citation-view";

// 도넛 중앙의 공식(HMG) 비중은 인용 현황 카드(categoryShare)와 같은 반올림이어야 한다. toFixed(1) 은 이진 부동소수 때문에
// x.x5 경계에서 카드와 0.1 갈렸다(247 / 2000 = 12.35 → 카드 12.4%, 도넛 12.3%).

describe("CategoryDonut center share", () => {
  it("rounds like the status card", () => {
    const data = [
      { name: "Official (HMG)", value: 247 },
      { name: "Automotive Media", value: 1753 },
    ];
    expect(categoryShare(data, "Official (HMG)")).toBe(12.4);
    const html = renderToStaticMarkup(
      <CategoryDonut title="t" centerLabel="c" data={data} activeCategories={[]} onSliceClick={() => {}} label={(n) => n} variant="standard" />,
    );
    expect(html).toContain("12.4%");
    expect(html).not.toContain("12.3%");
  });
});
