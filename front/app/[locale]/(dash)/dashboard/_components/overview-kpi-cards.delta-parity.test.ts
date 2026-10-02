import { describe, it, expect } from "vitest";
import { competitorDeltas } from "./overview-kpi-cards";
import type { OverviewKpiKey } from "../_data/overview-metrics";
import type {
  BrandTrendResult,
  FirstPositionResult,
} from "@/lib/db/repositories/scope-aggregates";

// ════════════════════════════════════════════════════════════════════════════
// 경쟁사 Δ 산식을 `lib/kpi/competitor-values.ts` 로 옮겼다 — **Overview 값 무변경**
// ════════════════════════════════════════════════════════════════════════════
//
// 지시(제품 책임자 2026-09-20): "Overview 쪽 인라인 산식이 있으면 그 모듈로 옮기되 Overview 의
// 값·서식이 바뀌면 안 된다. 옛 산식과 새 함수를 같은 입력으로 나란히 돌려 동일함을
// 테스트로 단언."
//
// 그래서 **2026-09-20 이전 원문을 아래 `oldCompetitorDeltas` 에 그대로 복사**해 두고,
// 같은 입력으로 나란히 돌린다. 이 파일의 복사본은 의도된 중복이다 — 기준선이 없으면
// "안 바뀌었다" 를 확인할 방법이 없다(`grid-off-8c9b3e7.json` 과 같은 자세).

type Extras = {
  brandTrend: BrandTrendResult | null;
  firstPosition: FirstPositionResult | null;
};

/** 2026-09-20 이전 `overview-kpi-cards.tsx` 원문(자구 그대로). */
function oldLastTwoDelta(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return null;
  return Math.round((v[v.length - 1] - v[v.length - 2]) * 10) / 10;
}
function oldCompetitorDeltas(
  extras: Extras | null,
  key: OverviewKpiKey,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!extras) return out;
  if (key === "visibility" || key === "shareOfVoice") {
    const bt = extras.brandTrend;
    if (!bt) return out;
    for (const b of bt.brands) {
      const series = bt.buckets.map((bk) => {
        const hit = bk.brands.find((x) => x.brand === b.brand);
        return hit ? (key === "visibility" ? hit.exposurePct : hit.sharePct) : null;
      });
      out.set(b.brand, oldLastTwoDelta(series));
    }
  } else if (key === "position") {
    const fp = extras.firstPosition;
    if (!fp) return out;
    for (const brand of fp.brands) {
      const series = fp.buckets.map(
        (bk) => bk.brands.find((x) => x.brand === brand)?.avgPosition ?? null,
      );
      out.set(brand, oldLastTwoDelta(series));
    }
  }
  return out;
}

const brandTrend = (): BrandTrendResult =>
  ({
    unit: "week",
    brands: [{ brand: "Tesla" }, { brand: "BMW" }, { brand: "Toyota" }],
    buckets: [
      {
        bucketStart: "2026-08-31",
        brands: [
          { brand: "Tesla", exposurePct: 29.9, sharePct: 6.4 },
          { brand: "BMW", exposurePct: 28.0, sharePct: 5.1 },
        ],
      },
      {
        bucketStart: "2026-09-07",
        brands: [{ brand: "Tesla", exposurePct: 30.1, sharePct: 6.5 }],
      },
      {
        bucketStart: "2026-09-14",
        brands: [
          { brand: "Tesla", exposurePct: 30.6, sharePct: 6.55 },
          { brand: "BMW", exposurePct: 29.9, sharePct: 5.5 },
        ],
      },
    ],
  }) as unknown as BrandTrendResult;

const firstPosition = (): FirstPositionResult =>
  ({
    brands: ["Tesla", "BMW", "Toyota"],
    buckets: [
      {
        bucketStart: "2026-08-31",
        brands: [
          { brand: "Tesla", avgPosition: 4.2 },
          { brand: "Toyota", avgPosition: 5.1 },
        ],
      },
      { bucketStart: "2026-09-07", brands: [{ brand: "Tesla", avgPosition: null }] },
      {
        bucketStart: "2026-09-14",
        brands: [
          { brand: "Tesla", avgPosition: 3.75 },
          { brand: "BMW", avgPosition: 6.0 },
        ],
      },
    ],
  }) as unknown as FirstPositionResult;

const KEYS: OverviewKpiKey[] = [
  "visibility",
  "shareOfVoice",
  "sentiment",
  "position",
  "citationShare",
];

const CASES: Array<[string, Extras | null]> = [
  ["전량", { brandTrend: brandTrend(), firstPosition: firstPosition() }],
  ["브랜드 추이 없음", { brandTrend: null, firstPosition: firstPosition() }],
  ["순위 없음", { brandTrend: brandTrend(), firstPosition: null }],
  ["둘 다 없음", { brandTrend: null, firstPosition: null }],
  ["extras 자체가 없음", null],
];

describe("competitorDeltas — 정본 이전 전후가 같다", () => {
  for (const [name, extras] of CASES) {
    for (const key of KEYS) {
      it(`${name} · ${key}`, () => {
        const now = competitorDeltas(extras as never, key);
        const before = oldCompetitorDeltas(extras, key);
        expect([...now.entries()]).toEqual([...before.entries()]);
      });
    }
  }

  it("공허하지 않다 — 실제로 값이 나오는 조합이 있다", () => {
    const d = competitorDeltas(
      { brandTrend: brandTrend(), firstPosition: firstPosition() } as never,
      "visibility",
    );
    expect(d.get("Tesla")).toBe(0.5);
    expect(d.get("BMW")).toBe(1.9);
    // 시리즈에는 있지만 버킷에 점이 없는 브랜드는 null 이다(없는 Δ 를 만들지 않는다).
    expect(d.get("Toyota")).toBeNull();
  });

  it("우호도 Δ 는 여전히 없다 — 새로 만들지 않았다(지시 ⑤)", () => {
    const d = competitorDeltas(
      { brandTrend: brandTrend(), firstPosition: firstPosition() } as never,
      "sentiment",
    );
    expect(d.size).toBe(0);
  });
});
