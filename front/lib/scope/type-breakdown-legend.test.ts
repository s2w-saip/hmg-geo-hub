import { describe, expect, it } from "vitest";
import { assignOtherColors, legendFromSegments } from "./type-breakdown-legend";

const COLORS = ["c1", "c2", "c3"] as const;

describe("assignOtherColors — 색은 브랜드에 고정된다 (GEO-5 핵심)", () => {
  it("전체 합계 상위 N개에만 색을 준다", () => {
    const m = assignOtherColors(
      [
        { brand: "Honda", total: 100 },
        { brand: "Fiat", total: 50 },
        { brand: "VW", total: 30 },
        { brand: "Tata", total: 10 },
      ],
      COLORS,
    );
    expect(m.get("Honda")).toBe("c1");
    expect(m.get("Fiat")).toBe("c2");
    expect(m.get("VW")).toBe("c3");
    expect(m.has("Tata")).toBe(false); // 색이 없으면 "기타"로 접힌다
  });

  it("합계가 0인 브랜드는 색을 차지하지 않는다", () => {
    const m = assignOtherColors(
      [{ brand: "Zero", total: 0 }, { brand: "Honda", total: 5 }],
      COLORS,
    );
    expect(m.get("Honda")).toBe("c1");
    expect(m.has("Zero")).toBe(false);
  });

  it("동점은 이름순으로 결정적 — 렌더마다 색이 흔들리면 안 된다", () => {
    const a = assignOtherColors([{ brand: "B", total: 5 }, { brand: "A", total: 5 }], COLORS);
    const b = assignOtherColors([{ brand: "A", total: 5 }, { brand: "B", total: 5 }], COLORS);
    expect(a.get("A")).toBe(b.get("A"));
    expect(a.get("A")).toBe("c1");
  });
});

describe("legendFromSegments — 범례는 막대에서 파생된다", () => {
  const rows = [
    { segs: [
      { label: "당사", val: 10, color: "bg-brand-700" },
      { label: "Honda", val: 5, color: "c1" },
      { label: "기타", val: 1, color: "bg-ink-100" },
    ] },
    { segs: [
      { label: "당사", val: 8, color: "bg-brand-700" },
      { label: "Fiat", val: 3, color: "c2" },
      { label: "Honda", val: 2, color: "c1" },
    ] },
  ];

  it("모든 막대 구간이 범례에 나타난다 — 이름 없는 색 덩어리가 없다", () => {
    const legend = legendFromSegments(rows);
    const barColors = new Set(rows.flatMap((r) => r.segs).filter((s) => s.val > 0).map((s) => s.color));
    expect(new Set(legend.map((l) => l.color))).toEqual(barColors);
  });

  it("한 색에 라벨은 하나뿐 — 색 고정이 지켜지는지 확인", () => {
    const legend = legendFromSegments(rows);
    expect(legend.filter((l) => l.color === "c1")).toHaveLength(1);
    expect(legend.find((l) => l.color === "c1")?.label).toBe("Honda");
  });

  it("값이 0인 구간은 범례에 안 나온다", () => {
    const legend = legendFromSegments([
      { segs: [{ label: "없음", val: 0, color: "cX" }, { label: "당사", val: 1, color: "c1" }] },
    ]);
    expect(legend.map((l) => l.label)).toEqual(["당사"]);
  });

  it("첫 등장 순서를 유지한다 (당사 → 비교 → 기타)", () => {
    expect(legendFromSegments(rows).map((l) => l.label)).toEqual(["당사", "Honda", "기타", "Fiat"]);
  });
});
