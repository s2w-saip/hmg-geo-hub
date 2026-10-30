import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RnSparkline } from "./sparkline";

// RnSparkline (renewal audit 3-1, 2026-10-31): the line was an aria-hidden svg only, so a round's value could not be
// read. With `tips` (one text per value) every point gets a hover / focus zone whose text the shared tooltip shows;
// without it the line is the same decorative svg as before (Mention, Citation, ACR, Conversion, Visibility, website
// weekly mentions).

describe("RnSparkline without tips", () => {
  it("draws the same decorative svg as before", () => {
    expect(renderToStaticMarkup(<RnSparkline values={[70, 72, null, 71, 74]} tone="onDark" domain={[0, 100]} className="h-[30px]" />)).toBe(
      '<svg aria-hidden="true" class="block h-9 w-full h-[30px]" viewBox="0 0 120 36" preserveAspectRatio="none"><g><polygon class="fill-rn-sky/18" points="3.0,36 3.0,12.0 31.5,11.4 31.5,36"></polygon><polyline class="fill-none stroke-rn-sky" stroke-width="2" vector-effect="non-scaling-stroke" points="3.0,12.0 31.5,11.4"></polyline></g><g><polygon class="fill-rn-sky/18" points="88.5,36 88.5,11.7 117.0,10.8 117.0,36"></polygon><polyline class="fill-none stroke-rn-sky" stroke-width="2" vector-effect="non-scaling-stroke" points="88.5,11.7 117.0,10.8"></polyline></g><circle class="fill-white" cx="117" cy="10.8" r="3"></circle></svg>',
    );
    expect(renderToStaticMarkup(<RnSparkline values={[3, 2.5, 2.8]} invert minSpan={2} />)).toBe(
      '<svg aria-hidden="true" class="block h-9 w-full" viewBox="0 0 120 36" preserveAspectRatio="none"><g><polygon class="fill-rn-navy/8" points="3.0,36 3.0,21.8 60.0,14.3 117.0,18.7 117.0,36"></polygon><polyline class="fill-none stroke-rn-navy" stroke-width="2" vector-effect="non-scaling-stroke" points="3.0,21.8 60.0,14.3 117.0,18.7"></polyline></g><circle class="fill-rn-navy" cx="117" cy="18.749999999999996" r="3"></circle></svg>',
    );
    expect(renderToStaticMarkup(<RnSparkline values={[null, null]} />)).toBe('<svg aria-hidden="true" class="block h-9 w-full" viewBox="0 0 120 36"></svg>');
    expect(renderToStaticMarkup(<RnSparkline values={[42]} />)).toBe(
      '<svg aria-hidden="true" class="block h-9 w-full" viewBox="0 0 120 36" preserveAspectRatio="none"><g></g><circle class="fill-rn-navy" cx="60" cy="18" r="3"></circle></svg>',
    );
  });
});

describe("RnSparkline with tips", () => {
  const values = [70, 72, null, 71, 74];
  const tips = ["9/7 · 70.0%", "9/14 · 72.0%\n직전 회차 대비 ▲2.0pp", "9/21 · 데이터 없음", null, "10/5 · 74.0%\n직전 회차 대비 ▲3.0pp"];
  const out = renderToStaticMarkup(<RnSparkline values={values} tone="onDark" domain={[0, 100]} className="h-[30px]" tips={tips} />);
  const zones = [...out.matchAll(/<span([^>]*data-rn-spark-point="(\d)"[^>]*)>/g)].map(([, attrs, i]) => ({
    i: +i,
    attrs,
    tip: attrs.match(/data-rn-tip="([^"]*)"/)?.[1],
    left: +(attrs.match(/left:([\d.]+)%/)?.[1] ?? NaN),
    width: +(attrs.match(/width:([\d.]+)%/)?.[1] ?? NaN),
  }));

  it("gives every point with a tip its own zone carrying the text (a null tip has none)", () => {
    expect(zones.map((z) => z.i)).toEqual([0, 1, 2, 4]);
    expect(zones.map((z) => z.tip?.replace(/&#10;|\n/g, "|"))).toEqual(["9/7 · 70.0%", "9/14 · 72.0%|직전 회차 대비 ▲2.0pp", "9/21 · 데이터 없음", "10/5 · 74.0%|직전 회차 대비 ▲3.0pp"]);
  });

  it("puts each zone around its point, the zones side by side across the line", () => {
    // the points sit at 3 + i·114/4 of the 120-wide box: 2.5 · 26.25 · 50 · 73.75 · 97.5 %
    const at = [2.5, 26.25, 50, 73.75, 97.5];
    for (const z of zones) {
      expect(z.left, `zone ${z.i}`).toBeLessThanOrEqual(at[z.i]);
      expect(z.left + z.width, `zone ${z.i}`).toBeGreaterThanOrEqual(at[z.i]);
    }
    expect(zones[0].left).toBe(0);
    expect(zones[zones.length - 1].left + zones[zones.length - 1].width).toBeCloseTo(100, 5);
  });

  it("can be read by keyboard and screen reader while the line stays decorative", () => {
    for (const z of zones) {
      expect(z.attrs).toContain('tabindex="0"');
      expect(z.attrs).toMatch(/aria-label="[^"]+"/);
    }
    expect(out).toContain('<svg aria-hidden="true" class="block h-full w-full"');
    // the size the caller gave stays on the box
    expect(out).toMatch(/^<span class="relative block h-9 w-full h-\[30px\]"/);
  });
});
