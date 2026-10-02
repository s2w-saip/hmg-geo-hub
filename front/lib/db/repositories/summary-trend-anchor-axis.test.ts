// 집계층 추이의 **x축 키·라벨**이 축 on 에서 귀속 날짜(`round_date`)인가 (2026-09-20).
//
// 고치는 결함 둘(둘 다 프리뷰·제품 책임자 실측, 뿌리가 같다):
//   ① 글로벌 프롬프트 화면에서 **추이 마지막 점 9/13 vs 카드 기준일 9/14**.
//      원장 회차 `round_date` 09-14 의 앵커는 `2026-09-13T15:48:44Z` 라, 추이가 앵커의
//      **UTC 일**을 키로 쓰면 하루 앞선 라벨이 나온다. 카드는 `round_date` 를 쓴다.
//   ② website 추이 x축 `7. 27.` **중복**(2~5차 관찰 연속). 라벨이 금요일(귀속 요일)이
//      아니라 목·월·화가 섞여 나왔다 = 앵커 날짜를 쓰고 있었다는 지문이고, merged 자리
//      (같은 귀속 날짜에 회차 둘)에서 두 점이 같은 라벨로 찍혔다.
//
// 계약(스펙 §9 · 계약 §3): 축 on 에서 추이의 **버킷 키와 x축 라벨은 `round_date`** 하나다.
// 같은 `round_date` 의 회차 둘은 **한 점으로 합산**된다.
//
// 기대값은 전부 **손계산 리터럴**이다(구현과 같은 함수로 기대값을 만들지 않는다).
// 달력 사실(2026): 09-13 = 일 · 09-14 = 월 · 09-11 = 금 · 07-27 = 월.
import { describe, it, expect } from "vitest";
import { toSeries, attachBrandSeries } from "./summary-global-trend-read";
import { websiteTrendBucketsFrom } from "./summary-website-aggregates";
import type {
  TrendAggregates,
  TrendOwnRow,
  TrendBrandRow,
  TrendDomainRow,
} from "./summary-trend-aggregates";
import type { CycleSet, SummaryCyclePick } from "@/lib/summary/read/cycle-set";

const own = (p: Partial<TrendOwnRow>): TrendOwnRow => ({
  axis: "cycle", bucket: null, cycleAnchorAt: null, keyRows: 1,
  monitored: 0, trackedAnswers: 0, multiAnswers: 0, top1Answers: 0, top3Answers: 0,
  rankSum: 0, rankedAnswers: 0, ownMentions: 0, ownPositive: 0, ownSignals: 0,
  compMentions: 0, allCitations: 0, ownCitations: 0, ownFallbackCitations: 0,
  tileOwnMentions: 0, citingAnswers: 0, ...p,
});
const domain = (p: Partial<TrendDomainRow>): TrendDomainRow => ({
  axis: "cycle", isRest: false, restCount: 0, keyRows: 1, groupKey: null, domain: null,
  country: null, cycleAnchorAt: null, citations: 0, citingAnswers: 0,
  ownedCitations: 0, isOurs: false, ...p,
});
const brand = (p: Partial<TrendBrandRow>): TrendBrandRow => ({
  axis: "cycle-brand", country: null, engine: null, cycleAnchorAt: null,
  brandName: "Hyundai", isRest: false, restCount: 0, keyRows: 1, isTracked: true,
  mentions: 0, answers: 0, rankSum: 0, rankedAnswers: 0,
  compRankSum: 0, compRankedAnswers: 0, top3Answers: 0,
  positive: 0, neutral: 0, negative: 0, mixed: 0, typeMention: 0,
  typeRecommendation: 0, typeComparison: 0, typeDefinition: 0, typeFinalChoice: 0, ...p,
});

/** 제품 책임자가 미러에서 읽어 준 실제 값(읽기 전용 실측). */
const A_0914 = "2026-09-13T15:48:44.000Z"; // 귀속 09-14 (KST 09-14 00:48)
const A_0907 = "2026-09-08T01:10:00.000Z"; // 귀속 09-07
const A_0831 = "2026-08-31T00:00:00.000Z"; // 앵커일 = 귀속일
/** 08-24 귀속 자리에 회차 **둘**(merged). 앵커는 서로 다른 주에 있다. */
const A_0818 = "2026-08-18T12:46:00.000Z";
const A_0825 = "2026-08-25T12:50:00.000Z";

const pick = (
  id: string,
  anchor: string,
  week: string,
  roundDate?: string,
): SummaryCyclePick =>
  ({
    cycleId: id,
    generationId: `${id}-g`,
    projectId: "p1",
    cycleAnchorAt: anchor,
    cycleWeek: week,
    ...(roundDate ? { roundDate } : {}),
  }) as SummaryCyclePick;

const setOf = (cycles: SummaryCyclePick[]): CycleSet =>
  ({
    surface: "global",
    mode: "period",
    cycles,
    cycleKey: cycles.map((c) => c.cycleId).join(","),
    projectIds: ["p1"],
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))],
  }) as CycleSet;

// 앵커 4개(08-24 자리는 회차 둘 = 총 5회차).
const CYCLES_ON = [
  pick("c1", A_0818, "2026-08-17", "2026-08-24"),
  pick("c2", A_0825, "2026-08-24", "2026-08-24"),
  pick("c3", A_0831, "2026-08-31", "2026-08-31"),
  pick("c4", A_0907, "2026-09-07", "2026-09-07"),
  pick("c5", A_0914, "2026-09-07", "2026-09-14"),
];
/** 같은 회차인데 `round_date` 가 안 실린 상태 = 축 off. */
const CYCLES_OFF = CYCLES_ON.map((c) => pick(c.cycleId, c.cycleAnchorAt, c.cycleWeek));

const AGG: TrendAggregates = {
  empty: false,
  answers: [],
  own: [
    own({ cycleAnchorAt: A_0818, monitored: 100, trackedAnswers: 10 }),
    own({ cycleAnchorAt: A_0825, monitored: 200, trackedAnswers: 20 }),
    own({ cycleAnchorAt: A_0831, monitored: 300, trackedAnswers: 30 }),
    own({ cycleAnchorAt: A_0907, monitored: 400, trackedAnswers: 40 }),
    own({ cycleAnchorAt: A_0914, monitored: 500, trackedAnswers: 50 }),
  ],
  brands: [],
  domains: [
    domain({ cycleAnchorAt: A_0818, citations: 10 }),
    domain({ cycleAnchorAt: A_0825, citations: 20 }),
    domain({ cycleAnchorAt: A_0914, citations: 50 }),
  ],
};

describe("글로벌 집계층 추이 — 축 on 의 x축은 귀속 날짜다", () => {
  const buckets = toSeries(AGG, setOf(CYCLES_ON)).buckets;

  it("앵커 09-13 15:48Z 회차의 라벨은 **09-14** 다 (카드 기준일과 같다)", () => {
    // 종전에는 앵커의 UTC 일이라 09-13 이었다 = 카드(09-14)와 하루 어긋났다.
    expect(buckets[buckets.length - 1].bucketStart).toBe("2026-09-14");
  });

  it("앵커 09-08 01:10Z 회차의 라벨은 **09-07** 이다 (앵커일보다 앞이다)", () => {
    expect(buckets.map((b) => b.bucketStart)).toContain("2026-09-07");
    expect(buckets.map((b) => b.bucketStart)).not.toContain("2026-09-08");
  });

  it("merged 자리(같은 귀속 날짜의 회차 둘)는 **한 점으로 합산**된다", () => {
    const merged = buckets.filter((b) => b.bucketStart === "2026-08-24");
    expect(merged).toHaveLength(1);
    expect(merged[0].monitored).toBe(300); // 100 + 200
    expect(merged[0].trackedAnswers).toBe(30); // 10 + 20
    expect(merged[0].allCitations).toBe(30); // 10 + 20
  });

  it("버킷 키가 **유일**하고 귀속 날짜 오름차순이다", () => {
    const keys = buckets.map((b) => b.bucketStart);
    expect(keys).toEqual(["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("브랜드 2단 결과가 **같은 키**로 붙는다 (조인이 안 깨진다)", () => {
    const core = toSeries(AGG, setOf(CYCLES_ON));
    const byAnchor = new Map([
      [A_0914, [{ brand: "Hyundai", isTracked: true, mentions: 7, answers: 3, rankSum: 0, rankedAnswers: 0, compRankSum: 0, compRankedAnswers: 0 }]],
    ]);
    const out = attachBrandSeries(core, byAnchor, [], setOf(CYCLES_ON));
    const last = out.buckets[out.buckets.length - 1];
    expect(last.bucketStart).toBe("2026-09-14");
    expect(last.brands.map((b) => b.mentions)).toEqual([7]);
  });

  it("축 off(집합에 round_date 없음)는 **종전 라벨 그대로**다", () => {
    const off = toSeries(AGG, setOf(CYCLES_OFF)).buckets.map((b) => b.bucketStart);
    // 앵커의 UTC 일 — 09-13 이 마지막이고 08-18·08-25 가 따로 선다.
    expect(off).toEqual(["2026-08-18", "2026-08-25", "2026-08-31", "2026-09-08", "2026-09-13"]);
  });

  it("집합을 안 넘기면 종전과 **완전히 같다**(호출부 미배선 경로의 안전망)", () => {
    expect(toSeries(AGG).buckets.map((b) => b.bucketStart)).toEqual(
      toSeries(AGG, setOf(CYCLES_OFF)).buckets.map((b) => b.bucketStart),
    );
  });

  it("브랜드 조인도 축 off 에서 종전 키를 쓴다", () => {
    const core = toSeries(AGG, setOf(CYCLES_OFF));
    const byAnchor = new Map([
      [A_0914, [{ brand: "Hyundai", isTracked: true, mentions: 7, answers: 3, rankSum: 0, rankedAnswers: 0, compRankSum: 0, compRankedAnswers: 0 }]],
    ]);
    const out = attachBrandSeries(core, byAnchor, [], setOf(CYCLES_OFF));
    expect(out.buckets[out.buckets.length - 1].bucketStart).toBe("2026-09-13");
    expect(out.buckets[out.buckets.length - 1].brands.map((b) => b.mentions)).toEqual([7]);
  });

  it("브랜드 행이 있어도 라벨은 귀속 날짜다 (brands 축이 키를 흔들지 않는다)", () => {
    const withBrands: TrendAggregates = {
      ...AGG,
      brands: [brand({ cycleAnchorAt: A_0914, mentions: 3, answers: 2 })],
    };
    const b = toSeries(withBrands, setOf(CYCLES_ON)).buckets;
    expect(b[b.length - 1].bucketStart).toBe("2026-09-14");
  });
});

// ── website ────────────────────────────────────────────────────────────────
//
// website 회차는 **금요일** 귀속이다. 관찰된 라벨 열
// (`7. 2. · 7. 9. · 7. 16. · 7. 27. · 7. 27. · 8. 7. …`)은 목·월·금·화가 섞여 있었다
// = 앵커 날짜를 쓰고 있었다는 뜻이고, 중복은 **서로 다른 `cycle_week` 두 버킷의 대표
// 앵커 날짜가 같을 때** 생긴다(대표일이 키에서 파생되지 않았기 때문).

const websiteSet = (cycles: SummaryCyclePick[]): CycleSet =>
  ({ ...setOf(cycles), surface: "website" }) as CycleSet;

/** 서로 다른 `cycle_week` 두 개인데 대표 앵커 날짜가 **같은 날**인 구성. */
const W_A = "2026-07-27T01:00:00.000Z"; // cycle_week 07-20
const W_B = "2026-07-27T22:00:00.000Z"; // cycle_week 07-27
const W_C = "2026-08-07T02:00:00.000Z"; // cycle_week 08-03

describe("website 집계층 추이 — `7. 27.` 중복", () => {
  const rows = {
    empty: false,
    answers: [],
    brands: [],
    domains: [],
    own: [
      own({ cycleAnchorAt: W_A, monitored: 10, trackedAnswers: 1 }),
      own({ cycleAnchorAt: W_B, monitored: 20, trackedAnswers: 2 }),
      own({ cycleAnchorAt: W_C, monitored: 30, trackedAnswers: 3 }),
    ],
  } as TrendAggregates;

  it("축 off 에서는 라벨이 **중복된다** (관찰된 결함을 그대로 재현한다)", () => {
    const off = websiteTrendBucketsFrom(
      rows,
      websiteSet([
        pick("w1", W_A, "2026-07-20"),
        pick("w2", W_B, "2026-07-27"),
        pick("w3", W_C, "2026-08-03"),
      ]),
    ).map((b) => b.bucketStart);
    expect(off).toEqual(["2026-07-27", "2026-07-27", "2026-08-07"]);
    expect(new Set(off).size).toBe(2); // 중복 1건
  });

  it("축 on 에서는 라벨이 **금요일 귀속 날짜**이고 유일하다", () => {
    const on = websiteTrendBucketsFrom(
      rows,
      websiteSet([
        pick("w1", W_A, "2026-07-20", "2026-07-24"),
        pick("w2", W_B, "2026-07-27", "2026-07-31"),
        pick("w3", W_C, "2026-08-03", "2026-08-07"),
      ]),
    );
    const keys = on.map((b) => b.bucketStart);
    expect(keys).toEqual(["2026-07-24", "2026-07-31", "2026-08-07"]);
    expect(new Set(keys).size).toBe(keys.length);
    // 값은 회차별로 그대로 실린다(합칠 자리가 없다).
    expect(on.map((b) => b.answers)).toEqual([10, 20, 30]);
  });

  it("같은 귀속 날짜의 회차 둘은 **한 점으로 합산**된다", () => {
    const on = websiteTrendBucketsFrom(
      rows,
      websiteSet([
        pick("w1", W_A, "2026-07-20", "2026-07-31"),
        pick("w2", W_B, "2026-07-27", "2026-07-31"),
        pick("w3", W_C, "2026-08-03", "2026-08-07"),
      ]),
    );
    expect(on.map((b) => b.bucketStart)).toEqual(["2026-07-31", "2026-08-07"]);
    expect(on[0].answers).toBe(30); // 10 + 20
    expect(on[0].trackedAnswers).toBe(3); // 1 + 2
  });
});

// ── 매핑 키 빈틈 (2026-09-20, 미러 실측) ────────────────────────────────────
//
// website 함대에서 축 on 라벨에 **토·일**이 섞였다:
//   `2026-08-01(Sat) 6회차 3,389답변` · `2026-08-02(Sun) 18회차 10,425답변`.
// 원인은 집계층이 귀속 날짜를 구할 때 매핑 표를 **원장 앵커**로 찾은 것이다. 그 24개
// 회차는 원장 앵커가 08-01/08-02 지만 0053 registry 로 앵커가 07-27 로 접혀
// `ca.anchor_date = 2026-07-27` · `round_date = 2026-07-24` 였고, 매핑 행도 (project,
// 07-27) 에 있다. 원장 KST 일자로 조인하니 빗나가 `COALESCE` 폴백이 앵커 KST 일자를
// 냈다. 값도 07-24 점에 안 붙고 08-01·08-02 **두 점**으로 쪼개졌다.
//
// 수리 뒤에는 회차가 `cycle_id` 로 앵커 표의 `round_date` 를 직접 받으므로, 리더에
// 도착하는 `SummaryCyclePick.roundDate` 가 07-24 다. 아래는 그 상태의 리더 동작이다.

/** 그 날의 요일(0=일 … 6=토). 테스트 로컬 산술 — 구현 함수를 쓰지 않는다. */
const dow = (d: string): number =>
  new Date(`${d}T00:00:00Z`).getUTCDay();

describe("매핑 키 빈틈 — 원장 앵커 08-01/08-02, ca 앵커 07-27, 귀속 07-24", () => {
  /** 원장 앵커가 08-01(6회차)·08-02(18회차)인데 귀속은 전부 07-24 인 구성. */
  const cycles: SummaryCyclePick[] = [
    ...Array.from({ length: 6 }, (_, i) =>
      pick(`s${i}`, `2026-08-01T0${i}:00:00.000Z`, "2026-07-27", "2026-07-24"),
    ),
    ...Array.from({ length: 18 }, (_, i) =>
      pick(`u${i}`, `2026-08-02T${String(i).padStart(2, "0")}:30:00.000Z`, "2026-07-27", "2026-07-24"),
    ),
    // 같은 창의 정상 회차(원장 앵커 == ca 앵커) 하나.
    pick("ok", "2026-08-07T02:00:00.000Z", "2026-08-03", "2026-08-07"),
  ];
  const rows = {
    empty: false,
    answers: [],
    brands: [],
    domains: [],
    own: cycles.map((c) =>
      own({ cycleAnchorAt: c.cycleAnchorAt, monitored: 100, trackedAnswers: 10 }),
    ),
  } as TrendAggregates;

  it("라벨이 **07-24 하나**로 합산되고 토·일이 나오지 않는다", () => {
    const b = websiteTrendBucketsFrom(rows, websiteSet(cycles));
    expect(b.map((x) => x.bucketStart)).toEqual(["2026-07-24", "2026-08-07"]);
    // 24회차 × 100 = 2,400 이 한 점에 실린다(두 점으로 쪼개지지 않는다).
    expect(b[0].answers).toBe(2400);
    expect(b[1].answers).toBe(100);
    for (const x of b) {
      expect(dow(x.bucketStart), `${x.bucketStart} 가 토·일이다`).not.toBe(0);
      expect(dow(x.bucketStart)).not.toBe(6);
    }
  });

  it("website 라벨은 전부 **금요일**이고 유일하다", () => {
    const keys = websiteTrendBucketsFrom(rows, websiteSet(cycles)).map((x) => x.bucketStart);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(dow(k), `${k} 가 금요일이 아니다`).toBe(5);
  });

  it("글로벌 라벨은 전부 **월요일**이고 유일하다", () => {
    const keys = toSeries(AGG, setOf(CYCLES_ON)).buckets.map((b) => b.bucketStart);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(dow(k), `${k} 가 월요일이 아니다`).toBe(1);
  });
});

// ── 숨김 회차의 갭 슬롯 키 (2026-09-20 관찰: 글로벌 `8. 25.` 잔존) ──────────
//
// 미러 실측:
//   · 회차 A  앵커 08-18 12:46Z · cycle_week 08-17 · round_date **08-24** · 숨김 아님
//   · 회차 B  앵커 08-25 12:50Z · cycle_week 08-24 · round_date **08-24**
//              · hidden_reason=collection_error · hidden_scope=citations
// 두 회차의 귀속 자리는 같다(08-24). 그런데 갭 슬롯 키가 **앵커 KST 일자**(08-25)라
// 08-24 자리에 이미 데이터 점이 있어도 `present` 검사를 통과해 슬롯이 하나 더 끼었다
// (`lib/viz/trend-gap.ts:295`). 화면에는 `8. 24.`(데이터) + `8. 25.`(슬롯) 두 점이다.
//
// 수리 뒤에는 슬롯 키도 귀속 날짜라 **이미 있는 점에 겹쳐 안 끼고**, 데이터가 없는
// 주의 숨김 회차만 음영으로 들어간다.
import { insertTrendGapSlots } from "@/lib/viz/trend-gap";

describe("숨김 회차 갭 슬롯 — 키가 귀속 날짜여야 점이 둘로 안 선다", () => {
  /** 축 on 의 데이터 점(귀속 날짜 격자). */
  const points = ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"];
  const insert = (slotKeys: string[]): string[] =>
    insertTrendGapSlots(
      points.map((k) => ({ bucketStart: k })),
      slotKeys,
      (r) => r.bucketStart,
      (k) => ({ bucketStart: k }),
    ).map((r) => r.bucketStart);

  it("종전 키(앵커 KST 일자 08-25)는 **점을 하나 더 만든다** (관찰된 결함)", () => {
    expect(insert(["2026-08-25"])).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
    ]);
  });

  it("새 키(귀속 날짜 08-24)는 **끼어들지 않는다** — 이미 점이 있다", () => {
    expect(insert(["2026-08-24"])).toEqual(points);
  });

  it("데이터가 없는 주의 숨김 회차는 그대로 음영으로 들어간다", () => {
    // 09-01 자리에 데이터 점이 없으면 슬롯이 들어가야 한다(한계 9 의 해소).
    expect(insert(["2026-09-01"])).toEqual([
      "2026-08-24",
      "2026-08-31",
      "2026-09-01",
      "2026-09-07",
      "2026-09-14",
    ]);
  });
});
