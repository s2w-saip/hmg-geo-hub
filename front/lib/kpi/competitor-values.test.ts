import { describe, it, expect } from "vitest";
import {
  brandKey,
  resolveCompetitorOverlay,
  competitorPositionDeltas,
  competitorTrendDeltas,
  competitorValueIndex,
  competitorValueOf,
  lastTwoDelta,
  COMPETITOR_DELTA_KEYS,
  type CompetitorMetricKey,
} from "./competitor-values";
import type { OverviewKpiKey } from "./overview-card-values";
import type { CompetitorBrandValue, MentionsBrandLive } from "@/lib/scope/result-adapter";
import type {
  BrandTrendResult,
  FirstPositionResult,
} from "@/lib/db/repositories/scope-aggregates";

// ════════════════════════════════════════════════════════════════════════════
// 경쟁사 값·Δ 산식의 **정본 이전**이 값을 안 바꿨는가 (2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
// 이 모듈로 옮겨 온 식이 셋이다. 셋 다 **옛 식을 여기 그대로 적어 두고** 같은 입력으로
// 나란히 돌려 동일함을 단언한다 — "옮겼다" 는 주장을 코드로 만드는 유일한 방법이다.
//   · `competitorValueOf`  ← `lib/scope/competitor-row.ts`
//   · `lastTwoDelta`       ← `dashboard/_components/overview-kpi-cards.tsx`
//   · 언급 화면의 삼항식   ← `_data/kpi-view.ts::competitorKpiRows`

/** 옛 식 ①: `overview-kpi-cards.tsx` 안에 있던 `lastTwoDelta`(2026-09-20 이전 원문). */
function oldLastTwoDelta(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return null;
  return Math.round((v[v.length - 1] - v[v.length - 2]) * 10) / 10;
}

/** 옛 식 ②: 언급 경쟁사 표의 값(`competitorKpiRows` 안 삼항식, 2026-09-20 이전 원문). */
function oldMentionPct(b: MentionsBrandLive, metric: "exposure" | "sov"): number | null {
  return b.mentions > 0 ? (metric === "exposure" ? b.mentionRate : b.share) : null;
}

const brand = (over: Partial<MentionsBrandLive> = {}): MentionsBrandLive => ({
  brand: "Tesla",
  mentions: 12,
  prompts: 5,
  share: 6.5,
  mentionRate: 30.1,
  avgPosition: 3.9,
  isTracked: false,
  sentiment: { positive: 7, neutral: 2, negative: 1, mixed: 0 },
  ...over,
});

describe("competitorValueOf — 지표별 값", () => {
  it("노출률·점유율은 언급이 0 이면 null (0% 와 구분)", () => {
    const b = brand({ mentions: 0 });
    expect(competitorValueOf(b, "visibility")).toBeNull();
    expect(competitorValueOf(b, "shareOfVoice")).toBeNull();
  });

  it("우호도 = 긍정 / (P+NE+NG+MX), 1자리", () => {
    expect(competitorValueOf(brand(), "sentiment")).toBe(70);
    expect(
      competitorValueOf(brand({ sentiment: { positive: 1, neutral: 1, negative: 1, mixed: 0 } }), "sentiment"),
    ).toBe(33.3);
  });

  it("감정 신호가 없으면(필드 부재·합 0) null", () => {
    expect(competitorValueOf(brand({ sentiment: undefined }), "sentiment")).toBeNull();
    expect(
      competitorValueOf(brand({ sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0 } }), "sentiment"),
    ).toBeNull();
  });

  it("우선 노출도는 그대로, 인용 점유율은 이 원천에 없다", () => {
    expect(competitorValueOf(brand(), "position")).toBe(3.9);
    expect(competitorValueOf(brand({ avgPosition: null }), "position")).toBeNull();
    expect(competitorValueOf(brand(), "citationShare")).toBeNull();
  });

  it("**옛 언급 화면 삼항식과 바이트 동일**하다 (미러 행에 걸었을 때)", () => {
    const cases: MentionsBrandLive[] = [
      brand(),
      brand({ mentions: 0, mentionRate: 0, share: 0 }),
      brand({ mentions: 1, mentionRate: 100, share: 0.1 }),
      brand({ mentions: 3, mentionRate: 0, share: 0 }),
    ];
    for (const b of cases) {
      expect(competitorValueOf(b, "visibility")).toBe(oldMentionPct(b, "exposure"));
      expect(competitorValueOf(b, "shareOfVoice")).toBe(oldMentionPct(b, "sov"));
    }
  });
});

describe("어휘 — 카드 키가 Overview 와 같다", () => {
  it("CompetitorMetricKey 와 OverviewKpiKey 가 서로 대입된다", () => {
    const a: CompetitorMetricKey = "citationShare" satisfies OverviewKpiKey;
    const b: OverviewKpiKey = "position" satisfies CompetitorMetricKey;
    expect([a, b]).toEqual(["citationShare", "position"]);
  });

  it("Δ 키는 셋 — 우호도·인용 점유율은 Δ 원천이 없다(지시 ⑤: 새로 만들지 않는다)", () => {
    expect([...COMPETITOR_DELTA_KEYS]).toEqual(["visibility", "shareOfVoice", "position"]);
  });
});

describe("brandKey · competitorValueIndex", () => {
  it("대소문자·앞뒤 공백을 접는다", () => {
    expect(brandKey(" TESLA ")).toBe("tesla");
  });

  it("같은 키가 둘이면 언급 수가 큰 쪽이 남는다", () => {
    const idx = competitorValueIndex([
      brand({ brand: "Tesla", mentions: 3, share: 1 }) as CompetitorBrandValue,
      brand({ brand: "TESLA ", mentions: 9, share: 7 }) as CompetitorBrandValue,
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get("tesla")?.share).toBe(7);
  });

  it("null·빈 배열이면 빈 Map (오버레이 미적용)", () => {
    expect(competitorValueIndex(null).size).toBe(0);
    expect(competitorValueIndex(undefined).size).toBe(0);
    expect(competitorValueIndex([]).size).toBe(0);
  });
});

// ── 오버레이 안전판 (2026-09-20 검증자 N-b) ────────────────────────────────
describe("resolveCompetitorOverlay — 언제 오버레이를 포기하는가", () => {
  const idx = (names: string[]) =>
    competitorValueIndex(names.map((n) => brand({ brand: n }) as CompetitorBrandValue));
  const rows = (spec: Array<[string, boolean]>) =>
    spec.map(([b, t]) => ({ brand: b, isTracked: t }));

  const TABLE = rows([
    ["Hyundai", true], ["Kia", true], ["Genesis", true],
    ["Tesla", false], ["BMW", false],
  ]);

  it("전부 맞으면 쓴다", () => {
    const d = resolveCompetitorOverlay(TABLE, idx(["Hyundai", "Kia", "Genesis", "Tesla", "BMW"]));
    expect(d).toEqual({ usable: true, unmatchedTracked: [], anyMatched: true });
  });

  it("경쟁사 일부가 빠진 것은 괜찮다 — 그 행만 값이 없다", () => {
    const d = resolveCompetitorOverlay(TABLE, idx(["Hyundai", "Kia", "Genesis", "Tesla"]));
    expect(d.usable).toBe(true);
    expect(d.unmatchedTracked).toEqual([]);
  });

  it("**당사 브랜드가 하나라도 빠지면 통째로 포기**한다 (히어로와 표가 갈리는 상태)", () => {
    const d = resolveCompetitorOverlay(TABLE, idx(["Hyundai", "Kia", "Tesla", "BMW"]));
    expect(d.usable).toBe(false);
    expect(d.unmatchedTracked).toEqual(["Genesis"]);
    // 종전 규칙("한 건이라도 맞으면 통과")이었다면 통과했을 상태다 — 공허하지 않다.
    expect(d.anyMatched).toBe(true);
  });

  it("당사가 여럿 빠지면 전부 이름으로 남는다(로그가 원인을 말할 수 있게)", () => {
    const d = resolveCompetitorOverlay(TABLE, idx(["Tesla", "BMW"]));
    expect(d.unmatchedTracked).toEqual(["Hyundai", "Kia", "Genesis"]);
    expect(d.usable).toBe(false);
  });

  it("한 건도 못 맞추면 포기한다 (표가 통째로 비지 않게)", () => {
    const d = resolveCompetitorOverlay(TABLE, idx(["브랜드-없음"]));
    expect(d).toEqual({
      usable: false,
      unmatchedTracked: ["Hyundai", "Kia", "Genesis"],
      anyMatched: false,
    });
  });

  it("리더가 비었으면(격자 off·degrade) 판정 자체가 '미적용' 이다", () => {
    const d = resolveCompetitorOverlay(TABLE, competitorValueIndex(null));
    expect(d).toEqual({ usable: false, unmatchedTracked: [], anyMatched: false });
  });

  it("표기 흔들림은 접혀서 맞는다", () => {
    const d = resolveCompetitorOverlay(
      rows([[" HYUNDAI ", true]]),
      idx(["Hyundai"]),
    );
    expect(d.usable).toBe(true);
  });

  it("당사 행이 없는 표(경쟁사만)는 ① 규칙만 본다", () => {
    const d = resolveCompetitorOverlay(rows([["Tesla", false]]), idx(["Tesla"]));
    expect(d.usable).toBe(true);
  });
});

describe("lastTwoDelta — 옛 식과 동일", () => {
  const CASES: Array<Array<number | null | undefined>> = [
    [],
    [1],
    [1, 2],
    [10, null, 12],
    [null, null],
    [5, undefined, null, 4.25],
    [72.05, 72.15],
  ];
  for (const c of CASES) {
    it(`[${c.join(",")}] — 새 함수가 옛 식과 같다`, () => {
      expect(lastTwoDelta(c)).toBe(oldLastTwoDelta(c));
    });
  }

  it("**null 을 건너뛴다** — 축의 마지막 두 칸 규칙과 다른 규칙이다", () => {
    expect(lastTwoDelta([10, 20, null])).toBe(10);
  });
});

// ── Δ 매핑 두 개 — 옛 `competitorDeltas` 본문과 같은 결과를 내는가 ───────────

const bt = (): BrandTrendResult =>
  ({
    unit: "week",
    brands: [{ brand: "Tesla" }, { brand: "BMW" }],
    buckets: [
      {
        bucketStart: "2026-09-01",
        brands: [
          { brand: "Tesla", exposurePct: 30, sharePct: 6 },
          { brand: "BMW", exposurePct: 20, sharePct: 4 },
        ],
      },
      {
        bucketStart: "2026-09-08",
        brands: [{ brand: "Tesla", exposurePct: 32.5, sharePct: 6.5 }],
      },
    ],
  }) as unknown as BrandTrendResult;

const fp = (): FirstPositionResult =>
  ({
    brands: ["Tesla", "BMW"],
    buckets: [
      { bucketStart: "2026-09-01", brands: [{ brand: "Tesla", avgPosition: 4 }] },
      {
        bucketStart: "2026-09-08",
        brands: [
          { brand: "Tesla", avgPosition: 3.2 },
          { brand: "BMW", avgPosition: 5 },
        ],
      },
    ],
  }) as unknown as FirstPositionResult;

describe("competitorTrendDeltas · competitorPositionDeltas", () => {
  it("노출률 Δ = 마지막 두 **값** 차", () => {
    expect(competitorTrendDeltas(bt(), "visibility").get("Tesla")).toBe(2.5);
  });

  it("점유율 Δ 도 같은 배열·같은 규칙", () => {
    expect(competitorTrendDeltas(bt(), "shareOfVoice").get("Tesla")).toBe(0.5);
  });

  it("점이 하나뿐이면 null (없는 Δ 를 만들지 않는다)", () => {
    expect(competitorTrendDeltas(bt(), "visibility").get("BMW")).toBeNull();
    expect(competitorPositionDeltas(fp()).get("BMW")).toBeNull();
  });

  it("순위 Δ 는 순위 시계열에서 (부호 해석은 화면 몫)", () => {
    expect(competitorPositionDeltas(fp()).get("Tesla")).toBe(-0.8);
  });

  it("원천이 없으면 빈 Map", () => {
    expect(competitorTrendDeltas(null, "visibility").size).toBe(0);
    expect(competitorPositionDeltas(null).size).toBe(0);
  });
});
