import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrendTooltip } from "./charts";

// RnLineChart's tooltip (renewal audit 5-1, 2026-10-31): `tooltipNote` adds the caller's lines for the hovered point
// under its values — the renewal Mention trends name each round's numerator and denominator there, as the original's
// tooltips did. The point's index comes with the data row; without a note the tooltip is the same as before.

const series = [
  { key: "__avg", name: "경쟁사 평균", color: "#8a837b", values: [30, 31] },
  { key: "__own", name: "HMG", color: "#002c5f", values: [76.6, 77.0], own: true },
];
const payload = [
  { dataKey: "__avg", value: 31, payload: { x: "10/5", __rnRow: 1 } },
  { dataKey: "__own", value: 77, payload: { x: "10/5", __rnRow: 1 } },
];
const render = (note?: (i: number) => ReadonlyArray<string> | null) =>
  renderToStaticMarkup(<TrendTooltip active payload={payload} label="10/5" series={series} value={(v) => `${v.toFixed(1)}%`} title={(x) => `${x} 회차`} note={note} />);

describe("RnLineChart tooltip note", () => {
  it("adds the caller's lines for the hovered point", () => {
    const html = render((i) => (i === 1 ? ["브랜드 언급 답변 수 34,452개", "모니터링 답변 수 44,979개"] : null));
    expect(html).toContain("data-rn-tip-note");
    expect(html).toContain("<div>브랜드 언급 답변 수 34,452개</div><div>모니터링 답변 수 44,979개</div>");
    expect(html.indexOf("77.0%")).toBeLessThan(html.indexOf("브랜드 언급 답변 수"));
  });

  it("without a note, or a note with nothing for that point, the tooltip has no note", () => {
    expect(render()).not.toContain("data-rn-tip-note");
    expect(render(() => null)).not.toContain("data-rn-tip-note");
    expect(render()).toContain("77.0%");
  });
});
