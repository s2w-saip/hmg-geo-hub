import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type {
  BrandTrendResult,
  EngineKpiTrend,
  StandardSubKpis,
  TypeKpi,
} from "@/lib/db/repositories/scope-aggregates";
import type { MentionsBrandLive, MentionTypesByBrand } from "@/lib/scope/result-adapter";
import { MentionKpiTab } from "./mention-kpi-tab";
import type { KpiMetric } from "../../_data/kpi-view";

// 탭 본문 전체가 실제로 **렌더된다**는 것을 확인하는 스모크. 순수 함수 테스트는
// 값이 맞는지만 보는데, 이 화면의 실패 양상은 대개 "렌더 중 throw" 라서(차트
// 라이브러리·i18n 키 누락) 정적 검사로는 안 잡힌다.
//
// i18n 키 누락은 next-intl 이 던지지 않고 키 경로를 그대로 출력하므로, 마크업에
// 원시 키(`answerAnalysis.mentions.kpi.…`)가 남지 않았는지도 함께 본다.

function engineRow(over: Partial<StandardSubKpis["rows"][number]>) {
  return {
    engine: "chatgpt", answers: 0, tracked: 0, multi: 0, top1: 0, top3: 0,
    avgPosition: null, totalMentions: 0, trackedMentions: 0, sentMentions: 0,
    positiveMentions: 0, negativeMentions: 0, citTotal: 0, citOwned: 0, ...over,
  };
}

const SUB: StandardSubKpis = {
  rows: [
    engineRow({ engine: "chatgpt", answers: 100, tracked: 80, totalMentions: 400, trackedMentions: 100 }),
    engineRow({ engine: "gemini", answers: 100, tracked: 40, totalMentions: 600, trackedMentions: 50 }),
  ],
  promptsWithoutBrand: 3,
  measuredPrompts: 230,
};

const PREV: StandardSubKpis = {
  rows: [engineRow({ engine: "chatgpt", answers: 100, tracked: 90, totalMentions: 500, trackedMentions: 120 })],
  promptsWithoutBrand: 2,
  measuredPrompts: 228,
};

function enginePoint(engine: string, over: Record<string, number | null> = {}) {
  return {
    engine, answers: 0, trackedAnswers: 0, exposurePct: null,
    totalMentions: 0, trackedMentions: 0, sovPct: null, ...over,
  } as EngineKpiTrend["latest"][number];
}

const ENGINE_TREND: EngineKpiTrend = {
  unit: "week",
  trendDegraded: false,
  latestBrands: [],
  typeTrend: [],
  windowStartBucket: "2026-07-06",
  windowEndBucket: "2026-07-20",
  engines: ["chatgpt", "gemini"],
  buckets: [
    {
      bucketStart: "2026-07-06", measuredDays: 7, firstAt: null, lastAt: null,
      engines: [
        enginePoint("chatgpt", { answers: 50, trackedAnswers: 25, totalMentions: 200, trackedMentions: 40 }),
        enginePoint("gemini", { answers: 50, trackedAnswers: 25, totalMentions: 200, trackedMentions: 60 }),
      ],
    },
    // 07-13 결측(갭) — 채워진 null 점이 렌더를 깨지 않는지 함께 본다.
    {
      bucketStart: "2026-07-20", measuredDays: 3, firstAt: null, lastAt: null,
      engines: [
        enginePoint("chatgpt", { answers: 100, trackedAnswers: 80, totalMentions: 400, trackedMentions: 100 }),
        enginePoint("gemini", { answers: 100, trackedAnswers: 40, totalMentions: 600, trackedMentions: 50 }),
      ],
    },
  ],
  latest: [
    enginePoint("chatgpt", { answers: 100, trackedAnswers: 80, exposurePct: 80, totalMentions: 400, trackedMentions: 100, sovPct: 25 }),
    enginePoint("gemini", { answers: 100, trackedAnswers: 40, exposurePct: 40, totalMentions: 600, trackedMentions: 50, sovPct: 8.3 }),
  ],
  latestMeasuredAt: "2026-07-22T00:00:00.000Z",
};

const BRAND_TREND: BrandTrendResult = {
  unit: "week",
  windowStartBucket: "2026-07-06",
  windowEndBucket: "2026-07-20",
  brands: [
    { brand: "Hyundai", isTracked: true, mentions: 100 },
    { brand: "Kia", isTracked: false, mentions: 60 },
  ],
  buckets: [
    {
      bucketStart: "2026-07-06", answers: 100, totalMentions: 400, measuredDays: 7,
      firstAt: null, lastAt: null,
      brands: [
        { brand: "Hyundai", isTracked: true, mentions: 40, answers: 30, exposurePct: 30, sharePct: 10 },
        { brand: "Kia", isTracked: false, mentions: 20, answers: 10, exposurePct: 10, sharePct: 5 },
      ],
    },
    {
      bucketStart: "2026-07-20", answers: 200, totalMentions: 1000, measuredDays: 3,
      firstAt: null, lastAt: null,
      brands: [
        { brand: "Hyundai", isTracked: true, mentions: 60, answers: 80, exposurePct: 40, sharePct: 15 },
        { brand: "Kia", isTracked: false, mentions: 0, answers: 0, exposurePct: 0, sharePct: 0 },
      ],
    },
  ],
};

const TYPE_KPI: TypeKpi = {
  totalAnswers: 200,
  totalMentions: 300,
  ownMentions: 100,
  rows: [
    { type: "mention", ownMentions: 60, otherMentions: 120, totalMentions: 180, ownAnswers: 100, otherAnswers: 150, ownExposurePct: 50, otherExposurePct: 75, ownSharePct: 33.3 },
    { type: "recommendation", ownMentions: 40, otherMentions: 80, totalMentions: 120, ownAnswers: 40, otherAnswers: 60, ownExposurePct: 20, otherExposurePct: 30, ownSharePct: 33.3 },
    { type: "comparison", ownMentions: 0, otherMentions: 0, totalMentions: 0, ownAnswers: 0, otherAnswers: 0, ownExposurePct: 0, otherExposurePct: 0, ownSharePct: null },
    { type: "definition", ownMentions: 0, otherMentions: 0, totalMentions: 0, ownAnswers: 0, otherAnswers: 0, ownExposurePct: 0, otherExposurePct: 0, ownSharePct: null },
    { type: "final_choice", ownMentions: 0, otherMentions: 0, totalMentions: 0, ownAnswers: 0, otherAnswers: 0, ownExposurePct: 0, otherExposurePct: 0, ownSharePct: null },
  ],
  sentimentMatrix: { own: [], all: [] },
};

// 유형 스택(당사 · 선택 경쟁사 · 기타)의 원천. totals 는 캡 이전 전량.
const TYPES_BY_BRAND: MentionTypesByBrand = {
  totals: { mention: 180, recommendation: 120, comparison: 0, definition: 0, final_choice: 0 },
  brands: [
    {
      brand: "Hyundai", isTracked: true,
      types: { mention: 60, recommendation: 40, comparison: 0, definition: 0, final_choice: 0 },
    },
    {
      brand: "Kia", isTracked: false,
      types: { mention: 45, recommendation: 20, comparison: 0, definition: 0, final_choice: 0 },
    },
    {
      brand: "Toyota", isTracked: false,
      types: { mention: 75, recommendation: 60, comparison: 0, definition: 0, final_choice: 0 },
    },
  ],
};

const BRANDS: MentionsBrandLive[] = [
  { brand: "Hyundai", mentions: 100, prompts: 40, share: 20, mentionRate: 60, avgPosition: 1.5, isTracked: true },
  { brand: "Kia", mentions: 60, prompts: 20, share: 12, mentionRate: 30, avgPosition: 2, isTracked: false },
];

function render(
  metric: KpiMetric,
  over: Partial<Parameters<typeof MentionKpiTab>[0]> = {},
  locale: "ko" | "en" = "ko",
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <MentionKpiTab
        metric={metric}
        subKpis={SUB}
        prevSubKpis={PREV}
        brands={BRANDS}
        engineTrend={ENGINE_TREND}
        brandTrend={BRAND_TREND}
        typeKpi={TYPE_KPI}
        typesByBrand={TYPES_BY_BRAND}
        prevBasisDate="2026-08-12"
        {...over}
      />
    </NextIntlClientProvider>,
  );
}

describe("MentionKpiTab", () => {
  it.each(["exposure", "sov"] as const)("renders the %s tab end to end", (metric) => {
    const html = render(metric);
    expect(html).toContain("Hyundai");
    expect(html).toContain("Kia");
    // 모든 i18n 키가 해소됐는지 — 누락은 throw 가 아니라 키 문자열 출력으로 샌다.
    expect(html).not.toContain("answerAnalysis.mentions.kpi");
  });

  it("shows the metric-specific hero value from the snapshot", () => {
    // 노출률 = 120/200, 점유율 = 150/1000 — 같은 Sub KPI 에서 metric 만 갈린다.
    expect(render("exposure")).toContain("60.0%");
    expect(render("sov")).toContain("15.0%");
  });

  // 노출률 히어로는 게이지, 점유율 히어로는 큰 숫자 — 같은 컴포넌트의 두 변형.
  it("draws the gauge only on the exposure tab", () => {
    expect(render("exposure")).toContain("<svg");
    expect(render("exposure")).toContain("stroke-dasharray");
    expect(render("sov")).not.toContain("stroke-dasharray");
  });

  // 8s 가드 초과 → 그 집계만 null. 페이지가 죽지 않고 대체 문구가 나와야 한다.
  it("degrades each aggregate independently without throwing", () => {
    const html = render("exposure", {
      engineTrend: null, brandTrend: null, typeKpi: null, typesByBrand: null,
    });
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.degraded);
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.engine.empty);
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.type.empty);
    // 스칼라는 스냅샷에서 오므로 추이가 죽어도 그대로 서빙된다.
    expect(html).toContain("60.0%");
  });

  it("renders with no data at all", () => {
    const html = render("sov", {
      subKpis: null, prevSubKpis: null, brands: [],
      engineTrend: null, brandTrend: null, typeKpi: null, typesByBrand: null,
      prevBasisDate: null,
    });
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.competitor.empty);
  });

  it("renders in English too (both dictionaries carry the keys)", () => {
    const html = render("exposure", {}, "en");
    expect(html).toContain(en.answerAnalysis.mentions.kpi.metric.exposure);
    expect(html).toContain(en.answerAnalysis.mentions.kpi.competitor.col.gap);
    expect(html).not.toContain("answerAnalysis.mentions.kpi");
  });
});

// ── 회귀 — 2026-09-01 적대적 검증 F3·F4·F5 (렌더 결과로 고정) ───────────────

// 3사 전부 tracked + cap 밖 브랜드 — 검증자가 반례를 재현한 형태.
const THREE_OWN: MentionsBrandLive[] = [
  { brand: "Hyundai", mentions: 300, prompts: 40, share: 20, mentionRate: 40, avgPosition: 1.5, isTracked: true },
  { brand: "Kia", mentions: 120, prompts: 30, share: 10, mentionRate: 30, avgPosition: 2, isTracked: true },
  { brand: "Genesis", mentions: 60, prompts: 20, share: 5, mentionRate: 15, avgPosition: 3, isTracked: true },
  { brand: "Peugeot", mentions: 12, prompts: 5, share: 1.2, mentionRate: 4, avgPosition: 6, isTracked: false },
];

describe("MentionKpiTab — regression F3 (도넛 중앙 라벨)", () => {
  // 반례: ownPct 는 3사 합집합(60.0%)인데 중앙 라벨이 tracked 첫 행의 브랜드명이라
  // "Hyundai 60.0%" 로 찍혔다 — 같은 표의 Hyundai 행은 40.0% 였다.
  it("labels the donut with a set label when several brands are ours", () => {
    const html = render("exposure", { brands: THREE_OWN });
    expect(html).toContain(
      ko.answerAnalysis.mentions.kpi.competitor.ownSet.replace("{n}", "3"),
    );
    // 중앙 라벨이 단일 브랜드명 + 합집합 값의 조합이면 안 된다.
    expect(html).not.toContain(">Hyundai</span><span class=\"text-lg font-bold tabular-nums\">60.0%");
  });

  it("still uses the brand name when exactly one brand is ours", () => {
    const html = render("exposure", { brands: BRANDS });
    expect(html).toContain("Hyundai");
    expect(html).not.toContain(
      ko.answerAnalysis.mentions.kpi.competitor.ownSet.replace("{n}", "1"),
    );
  });
});

describe("MentionKpiTab — regression F5 (시리즈 밖 표기)", () => {
  // 반례: Peugeot 는 추이 시리즈 밖이라 스파크라인이 전 구간 null → "—"(측정 없음)
  // 인데 값 열엔 4.0% 가 있었다.
  it("says 'no trend' rather than showing an empty-measurement dash", () => {
    const html = render("exposure", { brands: THREE_OWN });
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.competitor.notInSeries);
    expect(html).toContain("4.0%");
  });
});

describe("MentionKpiTab — regression F1 (경쟁사 커버리지 표기)", () => {
  it("states how many cycles the sparkline axis holds", () => {
    const html = render("exposure");
    // 픽스처는 07-06 / 07-20 두 측정 + 07-13 갭 = 축 3회차.
    expect(html).toContain("3");
    expect(html).toMatch(/추이 축/);
  });
});

describe("MentionKpiTab — regression F4 (유형 스택바 125%)", () => {
  // 반례: 노출률 × 타사 포함에서 own 50% + other 75% = 125% 를 한 트랙에 스택으로
  // 그리고 컨테이너가 overflow-hidden 이라 넘친 세그먼트가 잘려 **구성비인 것처럼**
  // 보였다. 원인은 own/other 분모가 둘 다 "전체 답변 수" 였던 것 — 분모를 그 유형의
  // 전 브랜드 신호 합으로 바꿔 **디자인(327:369)의 3분할 스택**을 복원했다.
  function typeSectionHtml(metric: "exposure" | "sov"): string {
    const html = render(metric);
    const title = ko.answerAnalysis.mentions.kpi.type.title[metric];
    const at = html.indexOf(title);
    expect(at).toBeGreaterThan(-1);
    return html.slice(at);
  }

  it("draws one bar track per type row in the default (ours-only) scope", () => {
    const section = typeSectionHtml("exposure");
    expect(section.match(/rounded-full bg-muted/g) ?? []).toHaveLength(5); // 유형 5종
  });

  it("keeps the signal-not-mentions caption on both tabs", () => {
    expect(typeSectionHtml("exposure")).toContain(ko.answerAnalysis.mentions.kpi.type.signalNote);
    expect(typeSectionHtml("sov")).toContain(ko.answerAnalysis.mentions.kpi.type.signalNote);
  });

  // ★ 재검증 C7: renderToStaticMarkup 은 useState 를 뒤집지 못해 종전 테스트가
  // "타사 포함" 분기를 **한 번도 밟지 않았다**. seam(initialTypeScope·
  // initialCompetitor)으로 강제한다.
  function typeSectionAll(metric: "exposure" | "sov", competitor: string | null = "Kia"): string {
    const html = render(metric, { initialTypeScope: "all", initialTypeCompetitor: competitor });
    const at = html.indexOf(ko.answerAnalysis.mentions.kpi.type.title[metric]);
    expect(at).toBeGreaterThan(-1);
    return html.slice(at);
  }

  /** 한 트랙 안의 세그먼트 폭(%)을 뽑는다 — 실제 렌더된 style 이 근거다. */
  function trackWidths(section: string): number[][] {
    const tracks = section.match(
      /<span class="flex h-3 overflow-hidden rounded-full bg-muted">.*?<\/span><\/span>/g,
    ) ?? [];
    return tracks.map((track) =>
      [...track.matchAll(/width:\s*([0-9.]+)%/g)].map((m) => Number(m[1])),
    );
  }

  /** 신호가 실제로 그려진 트랙만 — 신호 0 인 유형은 폭 0 세그먼트 하나뿐이다. */
  const drawnTracks = (section: string) =>
    trackWidths(section).filter((w) => w.reduce((a, b) => a + b, 0) > 0);

  it.each(["exposure", "sov"] as const)(
    "stacks ours / the picked competitor / the rest to exactly 100%% on the %s tab",
    (metric) => {
      const section = typeSectionAll(metric, "Kia");
      // 한 유형 = 한 트랙(독립 막대 2줄이 아니다).
      expect(section.match(/rounded-full bg-muted/g) ?? []).toHaveLength(5);
      // 신호가 있는 유형 2종(mention·recommendation)만 값을 갖는다.
      const drawn = drawnTracks(section);
      expect(drawn).toHaveLength(2);
      for (const segs of drawn) {
        expect(segs).toHaveLength(3); // 당사 · Kia · 기타
        expect(segs.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
      }
      // 잘려서 거짓 비율이 되던 종전 그림의 지문.
      expect(section).not.toContain("width:125%");
      expect(section).not.toContain(
        "노출률은 당사·기타의 분모가 모두 '전체 답변 수'라",
      );
    },
  );

  it("labels the competitor segment with the picked brand", () => {
    const section = typeSectionAll("exposure", "Kia");
    // mention 행: 당사 60/180 = 33.3%, Kia 45/180 = 25.0%, 기타 41.7%
    expect(section).toContain("33.3%");
    expect(section).toContain("25.0%");
    expect(section).toContain("41.7%");
    expect(section).toContain(ko.answerAnalysis.mentions.kpi.type.stackNote);
  });

  it("falls back to ours / rest (still 100%) when no competitor is picked", () => {
    const section = typeSectionAll("sov", null);
    const drawn = drawnTracks(section);
    expect(drawn).toHaveLength(2);
    for (const segs of drawn) {
      expect(segs).toHaveLength(2);
      expect(segs.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
    }
  });
});

// ── ① 히어로 우측 다중 브랜드 라인 (디자인 327:550) ────────────────────────
//
// ⚠️ recharts 는 `renderToStaticMarkup` 에서 SVG 를 전혀 내지 않는다(2026-09-02
// 실측: ResponsiveContainer 가 wrapper div 만 남긴다 — 폭 측정이 브라우저에만
// 있다). 그래서 여기서는 **어느 차트 분기를 탔는가**(캡션·커버리지)만 마크업으로
// 고정하고, 시리즈 개수·갭 null·색은 순수 함수 계약으로 단언한다
// (`brandTrendChart` = kpi-view.test.ts, `brandLineProps` = brand-trend-chart.render.test.tsx).
describe("MentionKpiTab — 점유율 히어로의 다중 브랜드 추이", () => {
  /** 히어로 카드(경쟁사 표 제목 앞까지)만 잘라 본다. */
  function heroHtml(metric: "exposure" | "sov", over = {}): string {
    const html = render(metric, over);
    const end = html.indexOf(
      // 2026-09-02 피그마 1:1: 제목은 짧은 지표명("경쟁사 분석(점유율)").
      ko.answerAnalysis.mentions.kpi.competitor.title.replace(
        "{metric}",
        ko.answerAnalysis.mentions.kpi.metricShort[metric],
      ),
    );
    expect(end).toBeGreaterThan(-1);
    return html.slice(0, end);
  }

  it("switches the sov hero to the multi-brand chart", () => {
    const hero = heroHtml("sov");
    expect(hero).toContain(ko.answerAnalysis.mentions.kpi.hero.brandTrendNote.sov);
  });

  it("keeps the single own-trend line on the exposure tab", () => {
    const hero = heroHtml("exposure");
    expect(hero).not.toContain(ko.answerAnalysis.mentions.kpi.hero.brandTrendNote.exposure);
    expect(hero).not.toContain(ko.answerAnalysis.mentions.kpi.hero.brandTrendNote.sov);
  });

  it("leaves the missing cycle as a break (coverage lists measured cycles only)", () => {
    // 픽스처는 07-06 / 07-20 측정 + 07-13 결측. 채워진 갭 점이 렌더를 깨지 않고,
    // 커버리지 라벨이 "미측정 0" 을 주장하지 않는다.
    const hero = heroHtml("sov");
    expect(hero).toContain(ko.answerAnalysis.mentions.kpi.hero.coverage);
    expect(hero.match(/일 측정/g) ?? []).toHaveLength(2); // 갭은 항목이 없다
  });

  it("falls back to the single line when the brand trend degrades", () => {
    const hero = heroHtml("sov", { brandTrend: null });
    expect(hero).not.toContain(ko.answerAnalysis.mentions.kpi.hero.brandTrendNote.sov);
    // 지면이 통째로 비지는 않는다 — 엔진 추이 기반 단일 라인이 남는다.
    expect(hero).toContain(ko.answerAnalysis.mentions.kpi.hero.coverage);
  });
});

// ── 회귀 C2 (2026-09-01 재검증) — 추이 단계만 죽으면 섹션 전체가 죽지 않는다 ──
// ── QA 2차 #9 (2026-09-09) — 유형 콤보의 선 = 유형 5종 노출률 ────────────────
//
// ⚠️ recharts 는 renderToStaticMarkup 에서 SVG·범례를 내지 않는다(위 주석 참조).
// 그래서 여기서 고정할 수 있는 것은 **칩 행이 사라졌다**는 마크업 사실이고,
// 선 5개의 값 계약은 `typeComboPoints`(kpi-view.test.ts 의 byType) 가 소유한다.
describe("MentionKpiTab — 유형 콤보 칩 제거", () => {
  it("no longer renders the per-type chip row", () => {
    const html = render("exposure");
    // 칩 행 라벨은 그 span 의 전체 내용이었다. 섹션 제목
    // ("멘션 유형별 …")과 구분하려고 태그 경계까지 포함해 본다.
    expect(html).not.toContain(`>${ko.answerAnalysis.mentions.kpi.type.chips}<`);
  });
});

describe("MentionKpiTab — regression C2 (부분 degrade 입도)", () => {
  // 반례: 엔진 집계가 통째로 null 이 되면 히어로 추이·엔진 섹션·유형 콤보·
  // 커버리지가 **동시에** 비었다. 실제로는 시계열 단계 하나만 못 낸 것이다.
  const degradedTrend: EngineKpiTrend = {
    ...ENGINE_TREND,
    buckets: [],
    trendDegraded: true,
    windowStartBucket: null,
    windowEndBucket: null,
  };

  it("keeps the engine bars (snapshot scalars) while blanking only the time series", () => {
    const html = render("exposure", { engineTrend: degradedTrend });
    // 좌측 바는 latest 에서 오므로 살아 있다.
    expect(html).toContain("chatgpt");
    expect(html).toContain("80.0%");
    // 우측 시계열만 대체 문구.
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.degradedTrend);
    // 섹션이 통째로 "데이터 없음"이 되지는 않는다.
    expect(html).not.toContain(ko.answerAnalysis.mentions.kpi.engine.empty);
  });

  it("still serves the hero scalar from the snapshot", () => {
    expect(render("exposure", { engineTrend: degradedTrend })).toContain("60.0%");
  });
});

// ── QA 2차 #6 (2026-09-10) — 3섹션 경쟁사 선택 결합 해제 ─────────────────────
//
// 고객 기대값: "경쟁사 분석(노출률), 멘션 유형별 노출은 각각 경쟁사 선택을 할 수
// 있는 구조로 따로 작동해야함(연계성 없음). AI 엔진별 노출 또한 타 영역의 경쟁사
// 선택과는 별개이며, 당사·경쟁사 평균만 데이터 제공."
//
// 종전에는 `mention-kpi-tab.tsx:125` 의 useState **하나**를 세 섹션이 나눠 썼다.
// renderToStaticMarkup 은 useState 를 뒤집지 못하므로 초기값 seam 으로 고정한다.
describe("MentionKpiTab — QA 2차 #6 (섹션별 경쟁사 선택 독립)", () => {
  const ENGINE_TREND_BRANDS: EngineKpiTrend = {
    ...ENGINE_TREND,
    latestBrands: [
      { engine: "chatgpt", brand: "Hyundai", isTracked: true, answersWithBrand: 80, mentions: 100 },
      { engine: "chatgpt", brand: "Kia", isTracked: false, answersWithBrand: 30, mentions: 60 },
      { engine: "chatgpt", brand: "Toyota", isTracked: false, answersWithBrand: 10, mentions: 40 },
      { engine: "gemini", brand: "Hyundai", isTracked: true, answersWithBrand: 40, mentions: 50 },
      { engine: "gemini", brand: "Kia", isTracked: false, answersWithBrand: 20, mentions: 30 },
    ],
  };

  /** 세 섹션을 제목으로 잘라낸다 — 한 섹션의 변화가 다른 섹션에 새는지 본다. */
  function sections(over: Partial<Parameters<typeof MentionKpiTab>[0]> = {}) {
    const html = render("exposure", { engineTrend: ENGINE_TREND_BRANDS, initialTypeScope: "all", ...over });
    const competitorAt = html.indexOf(
      ko.answerAnalysis.mentions.kpi.competitor.title
        .replace("{metric}", ko.answerAnalysis.mentions.kpi.metricShort.exposure),
    );
    const engineAt = html.indexOf(ko.answerAnalysis.mentions.kpi.engine.title.exposure);
    const typeAt = html.indexOf(ko.answerAnalysis.mentions.kpi.type.title.exposure);
    expect(competitorAt).toBeGreaterThan(-1);
    expect(engineAt).toBeGreaterThan(competitorAt);
    expect(typeAt).toBeGreaterThan(engineAt);
    return {
      competitor: html.slice(competitorAt, engineAt),
      engine: html.slice(engineAt, typeAt),
      type: html.slice(typeAt),
    };
  }

  const NONE = sections;

  it("leaves the type section untouched when a competitor is picked in the competitor table", () => {
    expect(sections({ initialCompetitors: ["Kia"] }).type).toBe(NONE().type);
  });

  it("leaves the competitor table untouched when a competitor is picked in the type section", () => {
    expect(sections({ initialTypeCompetitor: "Kia" }).competitor).toBe(NONE().competitor);
  });

  it("reflects each pick in its own section only", () => {
    // ② 는 선택 수 배지가, ④ 는 세그먼트 라벨이 바뀐다 — 각자 자기 섹션에서만.
    const own = sections({ initialCompetitors: ["Kia"] });
    expect(own.competitor).not.toBe(NONE().competitor);
    const typed = sections({ initialTypeCompetitor: "Kia" });
    expect(typed.type).not.toBe(NONE().type);
  });

  it("draws exactly two bars per engine (ours + competitor average)", () => {
    const engine = NONE().engine;
    expect((engine.match(/data-engine-bar=/g) ?? []).length).toBe(2);
    // ValueBar 는 엔진 막대마다 role="img" 하나 — 엔진 2개 × 막대 2개 = 4.
    expect((engine.match(/role="img"/g) ?? []).length).toBe(4);
    expect(engine).toContain(ko.answerAnalysis.mentions.kpi.engine.own);
  });

  it("keeps the engine section byte-identical no matter what either dropdown holds", () => {
    const base = NONE().engine;
    expect(sections({ initialCompetitors: ["Kia"] }).engine).toBe(base);
    expect(sections({ initialTypeCompetitor: "Kia" }).engine).toBe(base);
    expect(sections({ initialCompetitors: ["Kia"], initialTypeCompetitor: "Kia" }).engine).toBe(base);
  });

  it("never labels an engine bar with a picked competitor brand", () => {
    const engine = sections({ initialCompetitors: ["Kia"], initialTypeCompetitor: "Kia" }).engine;
    expect(engine).not.toContain("Kia");
  });

  it("names how many brands the competitor average covers (운영 D8)", () => {
    // chatgpt 는 비추적 2개(Kia·Toyota), gemini 는 1개(Kia).
    const engine = NONE().engine;
    expect(engine).toContain(
      ko.answerAnalysis.mentions.kpi.engine.competitorAvgWithCount.replace("{n}", "2"),
    );
    expect(engine).toContain(
      ko.answerAnalysis.mentions.kpi.engine.competitorAvgWithCount.replace("{n}", "1"),
    );
  });

  // 검증자 B4(2026-09-10) — `(N개사)` 는 "그 엔진의 경쟁 브랜드 수"가 아니다.
  // 상류(`scope-aggregates` ENGINE_BRAND_TOP_N)가 엔진당 상위 30 으로 자르므로
  // 라이브에서는 늘 30 이 찍혔고, 실제 경쟁 브랜드는 850~1,115 였다(검증자 DB 실측).
  // 라벨은 **모수가 아니라 상위 N** 임을 말해야 한다. 위 테스트는 사전 키를 그대로
  // 되읽어 문구가 무엇이든 초록이므로, 여기서 문구 자체를 못 박는다.
  it("says the average covers only the top N brands, not the whole field (검증자 B4)", () => {
    const engine = NONE().engine;
    expect(engine).toContain("경쟁사 평균 (상위 2개사)");
    expect(engine).toContain("경쟁사 평균 (상위 1개사)");
    expect(engine).not.toContain("경쟁사 평균 (2개사)");
    const en_ = render("exposure", { engineTrend: ENGINE_TREND_BRANDS, initialTypeScope: "all" }, "en");
    expect(en_).toContain("Competitor avg. (top 2)");
    expect(en_).not.toContain("Competitor avg. (2 brands)");
  });
});
