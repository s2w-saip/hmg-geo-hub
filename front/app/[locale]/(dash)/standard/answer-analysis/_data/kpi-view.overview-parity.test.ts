import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  exposureDeltaFromSlots,
  engineKpiSeries,
  favorabilityHero,
  favorabilityTrendPoints,
  firstRankDeltaBasis,
  firstRankHero,
  kpiHero,
  kpiTrendPoints,
  overviewDeltaFromSlots,
  typeComboPoints,
} from "./kpi-view";
import { overviewTrendValues } from "@/lib/kpi/overview-card-values";
import type {
  EngineKpiTrend,
  FirstPositionResult,
  StandardSubKpis,
  StandardTrendBucket,
} from "@/lib/db/repositories/scope-aggregates";
import { COLLECTION_ERROR_GAP, TREND_GAP_FIELD } from "@/lib/viz/trend-gap";

// ════════════════════════════════════════════════════════════════════════════
// Overview 와 언급의 **AI 노출률이 같은 함수·같은 원천에서 나온다** (제품 결정 ②)
// ════════════════════════════════════════════════════════════════════════════
//
// 증상(메인 실측 2026-09-20, Overview/언급): 08-17 75.0/78.6 · 08-24 72.2/68.7 ·
// 08-31 64.8/65.2 · 09-07 72.9/72.8. 원인은 **원천이 둘**이었다는 것이다 —
// Overview 는 `fetchStandardTrend`(사실표 우선), 언급은
// `aggregateEngineKpiTrendFromMirror`(미러 전용).
//
// 이 파일이 고정하는 것 셋:
//   ① **배선** — 언급 페처가 Overview 의 두 함수를 부른다(소스 가드). 이것이 깨지면
//      값이 다시 갈리는데 화면만 봐서는 안 보인다.
//   ② **값** — 같은 자리 배열에서 두 화면의 산식이 **같은 수**를 낸다. Overview 는
//      `live.ts::pct`(`Math.round((n/d)*1000)/10`), 언급은 `pctOrNull`
//      (`Math.round((100*n/d)*10)/10`). 두 식은 대수적으로 같고, 실측으로도 0~4,000
//      분모 전수에서 차이 0이다 — 그 성질을 여기 고정한다(둘 중 하나를 고치면 깨진다).
//   ③ **끄면 종전** — `overviewSlots`·`exposure` 가 없으면 옛 경로(엔진 합·행 합) 그대로.

/** Overview 쪽 산식 — `app/[locale]/(dash)/dashboard/_data/live.ts::pct` 원문. */
const overviewPct = (n: number, d: number): number =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : 0;

const bucket = (
  bucketStart: string,
  trackedAnswers: number,
  answers: number,
  over: Partial<StandardTrendBucket> = {},
): StandardTrendBucket =>
  ({
    bucketStart,
    roundDate: bucketStart,
    answers,
    trackedAnswers,
    totalMentions: 0,
    trackedMentions: 0,
    sentMentions: 0,
    positiveMentions: 0,
    avgPosition: null,
    totalCitations: 0,
    ownedCitations: 0,
    measuredDays: 1,
    firstAt: `${bucketStart}T00:00:00.000Z`,
    lastAt: `${bucketStart}T00:00:00.000Z`,
    ...over,
  }) as unknown as StandardTrendBucket;

/** 운영 담당이 실측한 다섯 자리(Overview 값 기준 분자·분모). */
const SLOTS: StandardTrendBucket[] = [
  bucket("2026-08-17", 249, 332),
  bucket("2026-08-24", 13474, 18662),
  bucket("2026-08-31", 24336, 37570),
  bucket("2026-09-07", 27385, 37568),
  bucket("2026-09-14", 29452, 38600),
];

const trendWith = (slots: readonly StandardTrendBucket[]): EngineKpiTrend =>
  ({
    unit: "week",
    engines: ["chatgpt"],
    // 미러 버킷은 **일부러 다른 값**으로 둔다 — 노출률이 이쪽에서 오면 테스트가 깨진다.
    buckets: slots.map((b) => ({
      bucketStart: b.bucketStart,
      measuredDays: 1,
      firstAt: b.firstAt,
      lastAt: b.lastAt,
      engines: [
        {
          engine: "chatgpt",
          answers: 1000,
          trackedAnswers: 999,
          exposurePct: 99.9,
          totalMentions: 10,
          trackedMentions: 1,
          sovPct: 10,
          sentSignals: 0,
          positiveSignals: 0,
          negativeSignals: 0,
        },
      ],
    })),
    latestBrands: [],
    typeTrend: [],
    latest: [],
    latestMeasuredAt: null,
    trendDegraded: false,
    overviewSlots: slots,
    // Δ 의 입력은 Overview 가 쓰는 **Δ 전용 롤업**이다(N2). 테스트에서는 같은 배열을
    // 주지만, 두 필드가 **따로** 소비되는 것을 아래 가드가 단언한다.
    overviewDeltaSlots: slots,
  }) as unknown as EngineKpiTrend;

describe("② 값 — 두 화면의 노출률이 자리마다 같은 수다", () => {
  const points = kpiTrendPoints(trendWith(SLOTS), "exposure");

  it("자리 목록이 Overview 배열과 **같은 순서·같은 키**다", () => {
    expect(points.map((p) => p.bucketStart)).toEqual(SLOTS.map((b) => b.roundDate));
  });

  it("자리마다 pct 가 Overview 산식과 일치한다", () => {
    for (const [i, s] of SLOTS.entries()) {
      expect(points[i].pct, s.bucketStart).toBe(overviewPct(s.trackedAnswers, s.answers));
    }
  });

  it("분자·분모도 그대로 옮겨진다 (재계산 없음)", () => {
    expect(points.map((p) => p.numerator)).toEqual(SLOTS.map((b) => b.trackedAnswers));
    expect(points.map((p) => p.denominator)).toEqual(SLOTS.map((b) => b.answers));
  });

  it("실측 수치를 재현한다 — 08-31 은 64.8 이다", () => {
    expect(points[2].pct).toBe(64.8);
  });

  it("미러 버킷(엔진 합 99.9%)이 값에 섞이지 않는다", () => {
    expect(points.every((p) => p.pct !== 99.9)).toBe(true);
  });

  it("두 반올림 식이 분모 전수에서 같다 (한쪽만 고치면 여기서 깨진다)", () => {
    const pctOrNullEquiv = (n: number, d: number) =>
      d > 0 ? Math.round(((100 * n) / d) * 10) / 10 : null;
    for (let d = 1; d <= 1500; d += 1) {
      for (let n = 0; n <= d; n += Math.max(1, Math.floor(d / 23))) {
        expect(pctOrNullEquiv(n, d), `${n}/${d}`).toBe(overviewPct(n, d));
      }
    }
  });
});

describe("② 갭 자리 — 값이 아니라 결측으로 옮겨진다", () => {
  const withGap = [
    SLOTS[0],
    bucket("2026-08-24", 0, 0, { gap: COLLECTION_ERROR_GAP }),
    SLOTS[2],
  ];
  const points = kpiTrendPoints(trendWith(withGap), "exposure");

  it("갭 자리는 값 전부 null 이고 마커가 남는다", () => {
    expect(points[1]).toMatchObject({
      bucketStart: "2026-08-24",
      pct: null,
      numerator: null,
      denominator: null,
      measuredDays: 0,
      gap: COLLECTION_ERROR_GAP,
    });
  });

  it("갭 자리가 축에서 사라지지 않는다 (점 개수 = 자리 수)", () => {
    expect(points).toHaveLength(withGap.length);
  });

  it("갭 다음 자리의 WoW 는 null 이다 (결측을 건너뛰고 비교하지 않는다)", () => {
    expect(points[2].numeratorWow).toBeNull();
  });
});

describe("② 카드 — Overview 카드 값이 정본이다", () => {
  const sub = {
    rows: [{ answers: 1000, tracked: 999, totalMentions: 10, trackedMentions: 1 }],
    promptsWithoutBrand: null,
    measuredPrompts: null,
    overviewCards: {
      visibility: { numerator: 29452, denominator: 38600 },
      shareOfVoice: { numerator: 1, denominator: 10 },
      sentiment: { numerator: 5, denominator: 10 },
      position: { avgPosition: 2.7, sampledAnswers: 100 },
      citationShare: { numerator: 11, denominator: 100 },
    },
  } as unknown as StandardSubKpis;

  it("`overviewCards` 가 있으면 rows 합이 아니라 그것을 쓴다", () => {
    expect(kpiHero(sub, "exposure")).toEqual({
      pct: overviewPct(29452, 38600),
      numerator: 29452,
      denominator: 38600,
    });
  });

  it("점유율도 같은 원천이다 (2026-09-20 확장)", () => {
    // 초판은 노출률만이었다. 이제 `overviewCards.shareOfVoice` 가 정본이다.
    expect(kpiHero(sub, "sov")).toEqual({ pct: 10, numerator: 1, denominator: 10 });
  });
});

describe("③ 끄면 종전 그대로", () => {
  it("`overviewSlots` 가 없으면 엔진 합 경로다", () => {
    const t = trendWith(SLOTS) as EngineKpiTrend & { overviewSlots?: unknown };
    delete t.overviewSlots;
    const points = kpiTrendPoints(t, "exposure");
    expect(points.every((p) => p.pct === 99.9)).toBe(true);
  });

  it("`overviewCards` 가 없으면 rows 합 경로다", () => {
    const sub = {
      rows: [{ answers: 1000, tracked: 999, totalMentions: 10, trackedMentions: 1 }],
      promptsWithoutBrand: null,
      measuredPrompts: null,
    } as unknown as StandardSubKpis;
    expect(kpiHero(sub, "exposure")).toEqual({ pct: 99.9, numerator: 999, denominator: 1000 });
  });
});

describe("① 배선 — 언급 페처가 Overview 의 함수를 부른다", () => {
  const SERVER = readFileSync(
    fileURLToPath(new URL("../../../../../../lib/scope/server.ts", import.meta.url)),
    "utf8",
  );

  it("추이는 `fetchStandardTrend` 한 함수에서 온다", () => {
    expect(SERVER).toContain(
      'fetchStandardTrend(f, "week")',
    );
    // 붙이는 자리가 **하나**여야 한다 — 둘이면 두 벌이 생긴다.
    expect((SERVER.match(/function withOverviewSlots\(/g) ?? []).length).toBe(1);
    expect(SERVER).toContain("return withOverviewSlots(trend, filters);");
  });

  it("카드는 `fetchStandardAggregates` 한 함수에서 온다", () => {
    expect(SERVER).toContain(
      "const agg = await fetchStandardAggregates(overviewReadFilters(filters));",
    );
    expect((SERVER.match(/function withOverviewCards\(/g) ?? []).length).toBe(1);
    expect(SERVER).toContain("return withOverviewCards(sub, filters);");
  });

  it("둘 다 격자 키 뒤에 있다 (끄면 왕복 0·값 종전)", () => {
    for (const fn of ["withOverviewSlots", "withOverviewCards", "withOverviewFirstPosition"]) {
      const at = SERVER.indexOf(`async function ${fn}(`);
      expect(at, fn).toBeGreaterThan(0);
      expect(SERVER.slice(at, at + 900)).toContain("await ensureTrendGrid()");
    }
  });

  it("언급 쪽이 노출률을 **자기 산식으로 다시 계산하지 않는다**", () => {
    const VIEW = readFileSync(
      fileURLToPath(new URL("./kpi-view.ts", import.meta.url)),
      "utf8",
    );
    // 카드는 `overviewCards` 를, 추이는 `overviewSlots` 를 **그대로** 쓴다.
    expect(VIEW).toContain("return overviewTrendPoints(");
    expect(VIEW).toContain("sub?.overviewCards");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 회귀(2026-09-20 프리뷰) 둘 — 계열 갭과 카드 Δ
// ════════════════════════════════════════════════════════════════════════════

describe("회귀 1 — `citations` 갭은 노출률을 죽이지 않는다", () => {
  // 08-24 자리의 실제 모양: 앵커 08-25 회차가 인용만 깨져 `withTrendGapBuckets` 의 ②
  // 패스가 `scope:'citations'` 마커를 얹고 **인용 두 필드만** 비운다. 언급 값은 산다.
  const citGap = { reason: "collection_error", scope: "citations" } as const;
  const slots = [
    bucket("2026-08-17", 249, 332),
    bucket("2026-08-24", 6635, 9652, { gap: citGap, totalCitations: 0, ownedCitations: 0 }),
    bucket("2026-08-31", 24336, 37570),
  ];
  const points = kpiTrendPoints(trendWith(slots), "exposure");

  it("그 자리에 **값이 선다** (점이 사라지지 않는다)", () => {
    expect(points[1].pct).toBe(overviewPct(6635, 9652));
    expect(points[1].numerator).toBe(6635);
    expect(points[1].denominator).toBe(9652);
  });

  it("커버리지에서도 빠지지 않는다", () => {
    expect(points[1].measuredDays).toBe(1);
  });

  it("인용 계열 마커를 노출률 차트로 나르지 않는다 (음영 금지)", () => {
    expect(points[1].gap).toBeUndefined();
  });

  it("`scope:'all'` 갭은 종전대로 값이 없다", () => {
    const all = [
      slots[0],
      bucket("2026-08-24", 0, 0, { gap: COLLECTION_ERROR_GAP }),
      slots[2],
    ];
    const p = kpiTrendPoints(trendWith(all), "exposure");
    expect(p[1].pct).toBeNull();
    expect(p[1].gap).toEqual(COLLECTION_ERROR_GAP);
  });

  it("Overview 와 같은 판정 함수를 쓴다 (소스 가드)", () => {
    const VIEW = readFileSync(fileURLToPath(new URL("./kpi-view.ts", import.meta.url)), "utf8");
    expect(VIEW).toContain('trendGapApplies(b.gap, "mention")');
    const LIVE = readFileSync(
      fileURLToPath(new URL("../../../dashboard/_data/live.ts", import.meta.url)),
      "utf8",
    );
    expect(LIVE).toContain('trendGapApplies(b.gap, "mention")');
  });
});

describe("회귀 2 — 카드 Δ 는 Overview 와 같은 규칙·같은 수다", () => {
  /** Overview 의 규칙 원문(`live.ts::applyTrendDeltas`) — 값 있는 마지막 두 점의 차. */
  const overviewDelta = (bs: readonly StandardTrendBucket[]): number | null => {
    const vals = bs
      .filter((b) => !b.gap || b.gap.scope === "citations")
      .map((b) => overviewPct(b.trackedAnswers, b.answers));
    if (vals.length < 2) return null;
    return Math.round((vals[vals.length - 1] - vals[vals.length - 2]) * 10) / 10;
  };

  it("메인 실측 자리에서 3.4pp 를 낸다 (09-07 72.9 → 09-14 76.3)", () => {
    const d = exposureDeltaFromSlots(SLOTS);
    expect(d).not.toBeNull();
    expect(d?.pp).toBe(3.4);
    expect(d?.pp).toBe(overviewDelta(SLOTS));
  });

  it("비교 기준 자리는 **직전 자리**다 (기간 첫 측정일이 아니다)", () => {
    expect(exposureDeltaFromSlots(SLOTS)?.basisDate).toBe("2026-09-07");
  });

  it("갭 자리는 건너뛰고 값이 있는 직전 자리와 비교한다", () => {
    const withGap = [
      SLOTS[2],
      bucket("2026-09-07", 0, 0, { gap: COLLECTION_ERROR_GAP }),
      SLOTS[4],
    ];
    const d = exposureDeltaFromSlots(withGap);
    expect(d?.basisDate).toBe("2026-08-31");
    expect(d?.pp).toBe(
      Math.round((overviewPct(29452, 38600) - overviewPct(24336, 37570)) * 10) / 10,
    );
  });

  it("`citations` 갭 자리는 **건너뛰지 않는다** (값이 살아 있다)", () => {
    const citGap = { reason: "collection_error", scope: "citations" } as const;
    const bs = [
      SLOTS[2],
      bucket("2026-09-07", 6635, 9652, { gap: citGap }),
      SLOTS[4],
    ];
    expect(exposureDeltaFromSlots(bs)?.basisDate).toBe("2026-09-07");
  });

  it("자리가 2개 미만이면 null = 배지 숨김", () => {
    expect(exposureDeltaFromSlots([SLOTS[0]])).toBeNull();
    expect(exposureDeltaFromSlots(undefined)).toBeNull();
    expect(exposureDeltaFromSlots([])).toBeNull();
  });

  it("배선 — 배지와 각주가 **같은 함수**를 읽는다 (둘이 다른 비교를 말하지 않게)", () => {
    const TAB = readFileSync(
      fileURLToPath(new URL("../_components/kpi/mention-kpi-tab.tsx", import.meta.url)),
      "utf8",
    );
    // 배지와 각주가 **같은 배열(Δ 롤업)** 을 읽는다 — 둘이 갈리면 숫자는 맞고 설명이 틀린다.
    expect((TAB.match(/engine\?\.overviewDeltaSlots/g) ?? []).length).toBe(2);
    expect(TAB).toContain('t("hero.deltaBasisCycle"');
    // 노출률·점유율이 **같은 함수에 키만 다르게** 들어간다.
    expect(TAB).toContain('metric === "exposure" ? "visibility" : "shareOfVoice"');
    // 격자 off 폴백은 종전 경로 그대로다.
    expect(TAB).toContain("deltaPp(ownPct, prevHero.pct)");
  });

  it("두 로케일에 각주 키가 있다", async () => {
    for (const loc of ["ko", "en"]) {
      const m = JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../../../../../../messages/${loc}.json`, import.meta.url)),
          "utf8",
        ),
      );
      const hero = m.answerAnalysis.mentions.kpi.hero;
      expect(typeof hero.deltaBasisCycle, loc).toBe("string");
      expect(hero.deltaBasisCycle, loc).toContain("{date}");
    }
  });
});

// ── 주의(독립 검증 §5): 두 격자의 길이가 갈려도 선이 안 밀린다 ───────────────
//
// 노출률은 `overviewSlots`(격자 family `"all"`), 점유율은 `buckets`(family
// `"mentions"`)에서 온다. 두 family 는 `hidden_scope='citations'` 회차 처리가 달라
// (`"mentions"` 는 남기고 `"all"` 은 뺀다) 자리 수가 갈릴 수 있다. 인덱스로 zip 하면
// **점유율 선이 한 칸 밀린 채 정상처럼 그려진다** — 값이 사라지는 것이 아니라 틀린
// 자리에 찍히므로 화면만 봐서는 못 잡는다.
describe("자리 수가 갈려도 유형 콤보가 자리 키로 맞춘다", () => {
  // 2026-09-20: 점유율이 **노출률과 같은 배열**(`overviewSlots`)로 옮겨졌다. 그래서 두
  // 계열의 길이는 이제 구조적으로 같다 — 아래 픽스처는 그 사실을 고정하고, 인덱스 zip
  // 이었다면 유형(`typeTrend`, 여전히 미러)과 어긋났을 자리를 함께 본다.
  const engineBucket = (bucketStart: string, tracked: number, answers: number) => ({
    bucketStart,
    measuredDays: 1,
    firstAt: `${bucketStart}T00:00:00.000Z`,
    lastAt: `${bucketStart}T00:00:00.000Z`,
    engines: [
      {
        engine: "chatgpt",
        answers,
        trackedAnswers: tracked,
        exposurePct: null,
        totalMentions: answers,
        trackedMentions: tracked,
        sovPct: null,
        sentSignals: 0,
        positiveSignals: 0,
        negativeSignals: 0,
      },
    ],
  });

  // 사실표 자리 3개(08-17 · 08-31 · 09-07) · 미러 버킷 4개(08-24 가 하나 더 있다).
  const trend = {
    unit: "week",
    engines: ["chatgpt"],
    buckets: [
      engineBucket("2026-08-17", 10, 100),   // sov 10%
      engineBucket("2026-08-24", 20, 100),   // sov 20%  ← 노출률 자리에는 없다
      engineBucket("2026-08-31", 30, 100),   // sov 30%
      engineBucket("2026-09-07", 40, 100),   // sov 40%
    ],
    latestBrands: [],
    typeTrend: [],
    latest: [],
    latestMeasuredAt: null,
    trendDegraded: false,
    overviewSlots: [
      bucket("2026-08-17", 1, 10, { totalMentions: 100, trackedMentions: 10 }),
      bucket("2026-08-31", 3, 10, { totalMentions: 100, trackedMentions: 30 }),
      bucket("2026-09-07", 4, 10, { totalMentions: 100, trackedMentions: 40 }),
    ],
  } as unknown as EngineKpiTrend;

  const points = typeComboPoints(trend);

  it("축은 노출률 자리를 따른다", () => {
    expect(points.map((p) => p.bucketStart)).toEqual([
      "2026-08-17", "2026-08-31", "2026-09-07",
    ]);
  });

  it("점유율이 **사실표 자리**의 값이다 (미러 버킷이 아니다)", () => {
    expect(points.map((p) => p.sovPct)).toEqual([10, 30, 40]);
    // 미러 버킷(20%가 낀 4칸)을 인덱스로 zip 했다면 [10, 20, 30] 이다.
    expect(points.map((p) => p.sovPct)).not.toEqual([10, 20, 30]);
  });

  it("노출률과 점유율의 자리 수가 **구조적으로 같다** (한 배열에서 온다)", () => {
    const exposure = kpiTrendPoints(trend, "exposure");
    const sov = kpiTrendPoints(trend, "sov");
    expect(sov.map((p) => p.bucketStart)).toEqual(exposure.map((p) => p.bucketStart));
  });

  it("미러가 짧아도 사실표 자리 수는 안 줄어든다", () => {
    const shorter = {
      ...trend,
      buckets: [engineBucket("2026-08-17", 10, 100)],
    } as unknown as EngineKpiTrend;
    expect(typeComboPoints(shorter).map((p) => p.sovPct)).toEqual([10, 30, 40]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 나머지 카드 셋도 Overview 와 같은 원천 (제품 책임자 "나머지 카드들도 원천 일치인지?")
// ════════════════════════════════════════════════════════════════════════════

const OVERVIEW_CARDS = {
  visibility: { numerator: 29452, denominator: 38600 },     // 76.3%
  shareOfVoice: { numerator: 3640, denominator: 10000 },    // 36.4%
  sentiment: { numerator: 542, denominator: 1000 },         // 54.2%
  position: { avgPosition: 2.7, sampledAnswers: 1200 },     // 2.7 위
  citationShare: { numerator: 114, denominator: 1000 },     // 11.4%
} as const;

describe("카드 값 — 네 지표가 Overview 카드와 같은 수다", () => {
  const sub = {
    // rows 는 **일부러 다른 값**이다 — 카드가 여기서 오면 테스트가 깨진다.
    rows: [{
      answers: 100, tracked: 99, totalMentions: 100, trackedMentions: 99,
      sentMentions: 100, positiveMentions: 99, negativeMentions: 1,
    }],
    promptsWithoutBrand: null,
    measuredPrompts: null,
    overviewCards: OVERVIEW_CARDS,
  } as unknown as StandardSubKpis;

  it("노출률", () => {
    expect(kpiHero(sub, "exposure").pct).toBe(overviewPct(29452, 38600));
  });

  it("점유율 — rows 합(99%)이 아니라 Overview 값이다", () => {
    const h = kpiHero(sub, "sov");
    expect(h.pct).toBe(overviewPct(3640, 10000));
    expect(h).toEqual({ pct: 36.4, numerator: 3640, denominator: 10000 });
  });

  it("우호도 **긍정** — Overview 값이다", () => {
    const h = favorabilityHero(sub);
    expect(h.positivePct).toBe(overviewPct(542, 1000));
    expect(h.positive).toBe(542);
    expect(h.total).toBe(1000);
  });

  it("우호도 **부정** — 소스가 없어 종전 미러다 (같은 탭에서 원천이 갈린다)", () => {
    // `StandardAggregates.sentiment` 에 부정 신호 합이 없다. 이 단언이 깨지면 소스가
    // 생겼다는 뜻이고, 그때 `favorabilityHero` 의 주석·분기를 함께 고쳐야 한다.
    const h = favorabilityHero(sub);
    expect(h.negative).toBe(1);
    expect(h.negativePct).toBe(1);
    // 긍정 분모(Overview)와 부정 분모(미러)가 다르므로 합이 100 이 아니다.
    expect((h.positivePct ?? 0) + (h.negativePct ?? 0)).not.toBe(100);
  });

  it("우선 노출도 — Overview 의 평균 순위와 모수다", () => {
    const fp = {
      unit: "week", brands: [], buckets: [], latest: [],
      overviewCards: OVERVIEW_CARDS,
      overviewDeltaSlots: SLOTS,
    } as unknown as FirstPositionResult;
    const h = firstRankHero(fp);
    expect(h.avgPosition).toBe(2.7);
    expect(h.rankedAnswers).toBe(1200);
  });

  it("끄면(카드 페이로드 없음) 네 지표 전부 종전 경로다", () => {
    const off = { ...sub, overviewCards: undefined } as unknown as StandardSubKpis;
    expect(kpiHero(off, "sov").pct).toBe(99);
    expect(favorabilityHero(off).positivePct).toBe(99);
  });
});

describe("카드 Δ — 네 지표가 같은 배열·같은 규칙이다", () => {
  /** Overview 의 Δ 규칙 원문(`live.ts::applyTrendDeltas`) 재구현 — 대조군. */
  const overviewDelta = (key: string): number | null => {
    const vals = SLOTS.map((b) => overviewTrendValues(b)[key as never] as number | undefined)
      .filter((v): v is number => typeof v === "number");
    if (vals.length < 2) return null;
    return Math.round((vals[vals.length - 1] - vals[vals.length - 2]) * 10) / 10;
  };

  for (const key of ["visibility", "shareOfVoice", "sentiment", "position"] as const) {
    it(`${key} — Overview 규칙과 같은 수다`, () => {
      const d = overviewDeltaFromSlots(SLOTS, key);
      expect(d?.pp ?? null).toBe(overviewDelta(key));
    });

    it(`${key} — 비교 기준이 직전 **자리**다`, () => {
      const d = overviewDeltaFromSlots(SLOTS, key);
      if (d) expect(d.basisDate).toBe("2026-09-07");
    });
  }

  it("값이 있는 자리가 2개 미만이면 null = 배지 숨김", () => {
    expect(overviewDeltaFromSlots([SLOTS[0]], "shareOfVoice")).toBeNull();
    expect(overviewDeltaFromSlots(undefined, "sentiment")).toBeNull();
  });

  it("우선 노출도 Δ 도 같은 함수에서 온다 (배지와 각주가 한 입력)", () => {
    const fp = {
      unit: "week", brands: [], buckets: [], latest: [],
      overviewCards: OVERVIEW_CARDS,
      overviewDeltaSlots: SLOTS,
    } as unknown as FirstPositionResult;
    expect(firstRankHero(fp).delta).toBe(overviewDeltaFromSlots(SLOTS, "position")?.pp ?? null);
    expect(firstRankDeltaBasis(fp)).toBe(
      overviewDeltaFromSlots(SLOTS, "position")?.basisDate ?? null,
    );
  });

  it("값 산식이 **live.ts 와 한 함수**다 (소스 가드)", () => {
    const LIVE = readFileSync(
      fileURLToPath(new URL("../../../dashboard/_data/live.ts", import.meta.url)),
      "utf8",
    );
    expect(LIVE).toContain("const values = overviewTrendValues(b);");
    // 옛 인라인 산식이 남아 있으면 두 벌이다.
    expect(LIVE).not.toContain("values.visibility = pct(");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 카드 값 == 그 탭 추이의 **마지막 점** (제품 책임자 "완전 같아야 한다")
// ════════════════════════════════════════════════════════════════════════════
//
// 같은 픽스처로 카드와 추이를 동시에 만든다. 카드 페이로드를 **마지막 자리에서 유도**해
// 주므로, 둘이 갈리면 원천이나 산식이 어긋난 것이다.
//
// ⚠️ 라이브에서는 한 가지가 더 있다: 카드는 `in_full_cycle` 게이트를 걸고 추이는 안 건다
//    (설계 §4-2 D2 = A). 그래서 **최신 자리에서 카드와 추이 끝점이 다를 수 있고, 그것은
//    Overview 에서도 똑같이 그렇다**(두 화면이 같은 두 리더를 쓰므로). 이 테스트는 그
//    게이트를 뺀 "정의가 같은가" 를 본다.
describe("카드와 그 탭 추이의 마지막 점이 같은 값이다", () => {
  const last = SLOTS[SLOTS.length - 1];
  const cardsFromLastSlot = {
    visibility: { numerator: last.trackedAnswers, denominator: last.answers },
    shareOfVoice: { numerator: last.trackedMentions, denominator: last.totalMentions },
    sentiment: { numerator: last.positiveMentions, denominator: last.sentMentions },
    position: { avgPosition: last.avgPosition, sampledAnswers: 100 },
    citationShare: { numerator: last.ownedCitations, denominator: last.totalCitations },
  };
  const MENTIONED = SLOTS.map((b, i) =>
    bucket(b.roundDate as string, b.trackedAnswers, b.answers, {
      totalMentions: 1000,
      trackedMentions: 300 + i,
      sentMentions: 500,
      positiveMentions: 260 + i,
      avgPosition: 3 - i * 0.1,
    }),
  );
  const lastM = MENTIONED[MENTIONED.length - 1];
  const cards = {
    ...cardsFromLastSlot,
    shareOfVoice: { numerator: lastM.trackedMentions, denominator: lastM.totalMentions },
    sentiment: { numerator: lastM.positiveMentions, denominator: lastM.sentMentions },
    position: { avgPosition: lastM.avgPosition, sampledAnswers: 100 },
  };
  const sub = {
    rows: [], promptsWithoutBrand: null, measuredPrompts: null, overviewCards: cards,
  } as unknown as StandardSubKpis;
  const trend = { ...trendWith(MENTIONED) } as EngineKpiTrend;

  it("노출률", () => {
    const pts = kpiTrendPoints(trend, "exposure");
    expect(kpiHero(sub, "exposure").pct).toBe(pts[pts.length - 1].pct);
  });

  it("점유율", () => {
    const pts = kpiTrendPoints(trend, "sov");
    expect(kpiHero(sub, "sov").pct).toBe(pts[pts.length - 1].pct);
  });

  it("우호도 긍정", () => {
    const pts = favorabilityTrendPoints(trend);
    expect(favorabilityHero(sub).positivePct).toBe(pts[pts.length - 1].positivePct);
  });

  it("우선 노출도 — 카드와 추이 값의 축이 같다", () => {
    const fp = {
      unit: "week", brands: [], buckets: [], latest: [],
      overviewCards: cards, overviewDeltaSlots: MENTIONED,
    } as unknown as FirstPositionResult;
    expect(firstRankHero(fp).avgPosition).toBe(lastM.avgPosition);
  });

  it("우호도 **부정**은 미러 분모라 긍정과 합이 100 이 아닐 수 있다 (각주 대상)", () => {
    const pts = favorabilityTrendPoints(trend);
    const p = pts[pts.length - 1];
    // 미러 버킷의 감정 신호(엔진 합)가 사실표 분모와 다르다 — 그 사실을 고정한다.
    expect(p.total).toBe(500);
    expect(p.negative).toBe(0);
  });
});

describe("엔진별 라인 — 히어로 주 계열과 같은 배열", () => {
  const withEngines = SLOTS.slice(0, 3).map((b, i) =>
    bucket(b.roundDate as string, b.trackedAnswers, b.answers, {
      totalMentions: 1000,
      trackedMentions: 300 + i,
      engines: [
        {
          engine: "chatgpt", answers: 100, trackedAnswers: 70 + i,
          totalMentions: 200, trackedMentions: 60 + i,
          sentMentions: 50, positiveMentions: 25, rankSum: 10, rankedAnswers: 5,
        },
        {
          engine: "gemini", answers: 100, trackedAnswers: 40 + i,
          totalMentions: 200, trackedMentions: 30 + i,
          sentMentions: 50, positiveMentions: 20, rankSum: 12, rankedAnswers: 4,
        },
      ],
    }),
  );
  const trend = trendWith(withEngines);

  it("엔진 목록·자리 목록이 히어로 주 계열과 같다", () => {
    const s = engineKpiSeries(trend, "exposure");
    expect(s.engines).toEqual(["chatgpt", "gemini"]);
    expect(s.points.map((p) => p.bucketStart)).toEqual(
      kpiTrendPoints(trend, "exposure").map((p) => p.bucketStart),
    );
  });

  it("값이 사실표 엔진 분해에서 온다 (미러 99.9% 가 아니다)", () => {
    const s = engineKpiSeries(trend, "exposure");
    expect(s.points[0].chatgpt).toBe(70);
    expect(s.points[0].gemini).toBe(40);
  });

  it("점유율도 같은 배열이다", () => {
    const s = engineKpiSeries(trend, "sov");
    expect(s.points[0].chatgpt).toBe(30);
  });

  it("엔진 분해가 없으면 **통째로** 미러다 (한 차트 안 혼재 금지)", () => {
    const noEngines = trendWith(SLOTS.slice(0, 3));
    const s = engineKpiSeries(noEngines, "exposure");
    // 미러 버킷의 엔진(99.9%)만 나온다.
    expect(s.points[0].chatgpt).toBe(99.9);
  });

  it("갭 자리는 전 엔진 null + 마커다", () => {
    const gapped = [
      withEngines[0],
      bucket("2026-08-24", 0, 0, { gap: COLLECTION_ERROR_GAP }),
      withEngines[2],
    ];
    const s = engineKpiSeries(trendWith(gapped), "exposure");
    expect(s.points[1].chatgpt).toBeNull();
    expect(s.points[1][TREND_GAP_FIELD]).toEqual(COLLECTION_ERROR_GAP);
  });
});

// ── 엔진 라인의 **원천 혼재 금지** (2026-09-20 수리) ─────────────────────────
//
// 종전 판정은 `trend.overviewSlots?.some((b) => b.engines?.length)` 였다. `some` 이면
// 자리 하나에만 엔진 분해가 있어도 사실표 경로로 들어오고, 엔진이 없는 나머지 자리는
// **갭 마커 없이 전 엔진 null** 로 그려진다 — 측정이 있었는데 선이 끊기고 화면은 그것을
// "측정 없음" 으로 읽는다(원인을 반대로 말한다).
//
// 새 판정은 **값 있는 자리 기준 `every`** 다: 혼재 상태가 구조적으로 불가능해진다.
// 기준이 "값 있는 자리" 인 이유 — 갭·모수 0 자리는 애초에 엔진 행이 없는 것이 정상이라
// 그것까지 요구하면 이 경로가 영영 안 열린다.
describe("engineKpiSeries — 자리마다 엔진 분해가 있을 때만 사실표 배열을 쓴다", () => {
  const eng = (engine: string, tracked: number, answers: number) => ({
    engine,
    answers,
    trackedAnswers: tracked,
    totalMentions: answers,
    trackedMentions: tracked,
    sentSignals: 0,
    positiveSignals: 0,
    negativeSignals: 0,
  });
  /** 미러 버킷 — 폴백으로 갔을 때 그려지는 것. 자리 키가 일부러 다르다. */
  const mirrorTrend = {
    unit: "week",
    engines: ["mirror-engine"],
    buckets: [
      {
        bucketStart: "2026-08-17",
        measuredDays: 1,
        firstAt: "2026-08-17T00:00:00.000Z",
        lastAt: "2026-08-17T00:00:00.000Z",
        engines: [{ ...eng("mirror-engine", 1, 10), exposurePct: 10, sovPct: 10 }],
      },
    ],
    latest: [],
    latestBrands: [],
    typeTrend: [],
    latestMeasuredAt: null,
    trendDegraded: false,
  };

  const withSlots = (slots: StandardTrendBucket[]) =>
    ({ ...mirrorTrend, overviewSlots: slots }) as unknown as EngineKpiTrend;

  it("값 있는 자리 **전부**에 엔진이 있으면 사실표 배열을 쓴다", () => {
    const out = engineKpiSeries(
      withSlots([
        bucket("2026-08-31", 3, 10, { engines: [eng("chatgpt", 3, 10)] }),
        bucket("2026-09-07", 4, 10, { engines: [eng("chatgpt", 4, 10)] }),
      ]),
      "exposure",
    );
    expect(out.engines).toEqual(["chatgpt"]);
    expect(out.points.map((p) => p.bucketStart)).toEqual(["2026-08-31", "2026-09-07"]);
  });

  it("**일부만** 있으면 미러로 간다 — 혼재한 배열을 그리지 않는다", () => {
    const out = engineKpiSeries(
      withSlots([
        bucket("2026-08-31", 3, 10, { engines: [eng("chatgpt", 3, 10)] }),
        bucket("2026-09-07", 4, 10), // 엔진 분해 없음 — 종전 `some` 이면 여기가 조용히 null
      ]),
      "exposure",
    );
    expect(out.engines).toEqual(["mirror-engine"]);
    expect(out.points.map((p) => p.bucketStart)).toEqual(["2026-08-17"]);
  });

  it("갭·모수 0 자리는 엔진을 요구하지 않는다(그 자리에 엔진 행이 없는 것이 정상)", () => {
    const out = engineKpiSeries(
      withSlots([
        bucket("2026-08-24", 0, 0), // 모수 0 — 값 있는 자리가 아니다
        bucket("2026-08-31", 3, 10, {
          answers: 0,
          gap: COLLECTION_ERROR_GAP,
        }),
        bucket("2026-09-07", 4, 10, { engines: [eng("chatgpt", 4, 10)] }),
      ]),
      "exposure",
    );
    expect(out.engines).toEqual(["chatgpt"]);
  });

  it("값 있는 자리가 하나도 없으면 미러다(빈 배열로 경로를 열지 않는다)", () => {
    expect(engineKpiSeries(withSlots([]), "exposure").engines).toEqual(["mirror-engine"]);
    expect(
      engineKpiSeries(withSlots([bucket("2026-08-24", 0, 0)]), "exposure").engines,
    ).toEqual(["mirror-engine"]);
  });
});
