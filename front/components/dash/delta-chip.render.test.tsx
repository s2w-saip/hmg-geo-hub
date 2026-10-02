import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import {
  PERIOD_CHIP_ORDER,
  SUPPRESSED_GLYPH,
  periodCaption,
  periodChip,
  toPeriodDeltaView,
  type PeriodCaptionKey,
} from "@/lib/kpi/period-compare-view";
import type { CompareResult, SuppressionReason } from "@/lib/kpi/period-compare";
import { DeltaChip, PeriodDeltaCaption, PeriodDeltaChip } from "./delta-chip";
import { PeriodDeltaLine } from "./period-delta-line";

// 화면 쪽 수용 기준: 4상태가 실제로 그려지는가 · 키가 새지 않는가 ·
// **억제 기호는 U+2015 이고 U+2014 는 0건**인가. 값·분기는 순수 계층
// (`lib/kpi/period-compare-view.test.ts`)이 이미 고정했다.

const EM_DASH = "—";
const RAW = /periodCompare\./;
const text = (h: string) => h.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ");

const result = (over: Partial<CompareResult> = {}): CompareResult => ({
  metric: "visibility",
  unit: "pp",
  prev: 64.7751,
  cur: 74.5735,
  delta: 9.7984,
  suppressed: false,
  reason: null,
  cyclesPrev: 1,
  cyclesCur: 2,
  plannedPrev: 37570,
  plannedCur: 75138,
  missingSharePrev: 0,
  missingShareCur: 0,
  ...over,
});

const chipOf = (r: CompareResult) => periodChip({ metric: r.metric, delta: r.delta });

function render(node: React.ReactNode, locale: "ko" | "en" = "ko"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      {node}
    </NextIntlClientProvider>,
  );
}

describe("DeltaChip — 4상태", () => {
  it("상승은 positive 톤 + 상승 아이콘", () => {
    const html = renderToStaticMarkup(<DeltaChip direction="up" text="9.8pp" />);
    expect(html).toContain('data-period-delta="up"');
    expect(html).toContain("text-positive");
    expect(html).toContain("9.8pp");
    expect(html).toContain("<svg");
  });

  it("하락은 destructive 톤", () => {
    const html = renderToStaticMarkup(<DeltaChip direction="down" text="1.6pp" />);
    expect(html).toContain('data-period-delta="down"');
    expect(html).toContain("text-destructive");
  });

  it("변화 없음은 중립 톤이고 값이 그대로 보인다", () => {
    const html = renderToStaticMarkup(<DeltaChip direction="flat" text="0.0pp" />);
    expect(html).toContain('data-period-delta="flat"');
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("0.0pp");
    expect(html).not.toContain(SUPPRESSED_GLYPH);
  });

  it("억제는 방향 아이콘도 값도 없고 U+2015 하나뿐이다", () => {
    const html = renderToStaticMarkup(<DeltaChip direction="up" text="9.8pp" suppressed />);
    expect(html).toContain('data-period-delta="suppressed"');
    expect(html).toContain(SUPPRESSED_GLYPH);
    expect(html).not.toContain("9.8pp");
    expect(html).not.toContain("<svg");
    // 억제는 좋고 나쁨이 없다 — 색이 붙으면 오독한다.
    expect(html).not.toContain("text-positive");
    expect(html).not.toContain("text-destructive");
  });

  it("hex 리터럴을 쓰지 않는다(팔레트 정본은 globals.css)", () => {
    expect(renderToStaticMarkup(<DeltaChip direction="up" text="9.8pp" />)).not.toMatch(
      /#[0-9A-Fa-f]{6}/,
    );
  });
});

describe("PeriodDeltaChip — 순수 계층이 만든 칩", () => {
  it.each(["ko", "en"] as const)("정상 값을 키 노출 없이 그린다 (%s)", (locale) => {
    const html = render(<PeriodDeltaChip chip={chipOf(result())} />, locale);
    expect(html).not.toMatch(RAW);
    expect(html).toContain("9.8pp");
    expect(html).toContain('data-period-delta="up"');
    expect(html).toContain("aria-label=");
  });

  it("순위형 하락은 개선으로 칠한다 — 뒤집기는 순수 계층이 이미 끝냈다", () => {
    const html = render(
      <PeriodDeltaChip chip={chipOf(result({ metric: "position", unit: "rank", delta: -0.44 }))} />,
    );
    expect(html).toContain('data-period-delta="up"');
    expect(html).toContain("text-positive");
    expect(html).toContain("0.4");
  });

  // 2026-09-20 프리뷰 실측: 기간 미지정 카드는 `0.1위` 인데 주 단위 창(기간 비교 경로)은
  // `0.1` 이었다 — 같은 화면의 같은 지표가 창에 따라 다른 표기를 가졌다.
  // 같은 날 고객 요구로 ko 단위가 '위' → '번째'가 됐고, 정본 키는 `metricUnit.position`
  // 하나다(카드·표·지도·이 칩이 같은 키 = 표기가 다시 갈릴 수 없다).
  it.each([
    ["ko", "0.4번째"],
    ["en", "#0.4"],
  ] as const)("순위형 칩에 단위가 붙는다 (%s)", (locale, expected) => {
    const html = render(
      <PeriodDeltaChip chip={chipOf(result({ metric: "position", unit: "rank", delta: -0.44 }))} />,
      locale,
    );
    expect(html).not.toMatch(RAW);
    expect(html).toContain(expected);
  });

  it("순위형 억제 칩에는 단위가 붙지 않는다 (U+2015 하나뿐)", () => {
    const html = render(
      <PeriodDeltaChip
        chip={chipOf(
          result({ metric: "position", unit: "rank", suppressed: true, delta: null, reason: "no_prev" }),
        )}
      />,
    );
    expect(html).toContain(SUPPRESSED_GLYPH);
    expect(html).not.toContain("번째");
  });

  it("pp·% 지표에는 순위 단위가 새지 않는다", () => {
    for (const html of [
      render(<PeriodDeltaChip chip={chipOf(result())} />),
      render(
        <PeriodDeltaChip
          chip={chipOf(result({ metric: "citationsPerAnswer", unit: "pct", delta: -63.9 }))}
        />,
      ),
    ]) {
      expect(html).not.toContain("번째");
    }
  });

  it.each(["ko", "en"] as const)("억제 칩은 U+2015 이고 U+2014 는 0건이다 (%s)", (locale) => {
    const html = render(
      <PeriodDeltaChip chip={chipOf(result({ suppressed: true, delta: null, reason: "no_prev" }))} />,
      locale,
    );
    expect(html).not.toMatch(RAW);
    expect(html).toContain(SUPPRESSED_GLYPH);
    expect(html).not.toContain(EM_DASH);
  });
});

describe("PeriodDeltaCaption — 사유 문장", () => {
  it("정상 상태(window)는 기본적으로 그리지 않는다", () => {
    expect(
      render(<PeriodDeltaCaption caption={periodCaption(result(), { days: 7 })} />),
    ).toBe("");
  });

  it("reasonOnly 를 끄면 회차 문구가 나온다", () => {
    const html = render(
      <PeriodDeltaCaption caption={periodCaption(result(), { days: 7 })} reasonOnly={false} />,
    );
    expect(html).toContain('data-period-delta-reason="window"');
    expect(text(html)).toContain("2");
    expect(html).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  const CASES: Array<[SuppressionReason, Partial<CompareResult>, number, PeriodCaptionKey]> = [
    ["unsupported", {}, 30, "reason.unsupported"],
    ["no_prev", {}, 7, "reason.noPrevWindow"],
    // `yearly` 프리셋의 실제 길이는 366일이다(365 로 판정하면 영영 안 걸린다).
    ["no_prev", {}, 366, "reason.noPrevYear"],
    ["no_data", { cyclesCur: 0, cyclesPrev: 3 }, 14, "reason.noDataCur"],
    ["no_data", { cyclesCur: 3, cyclesPrev: 0 }, 14, "reason.noDataPrev"],
    ["missing_share", { missingSharePrev: 0.40846 }, 30, "reason.missingShare"],
    ["start_window", {}, 30, "reason.startWindow"],
    ["start_month", {}, 30, "reason.startMonth"],
  ];

  it.each(CASES)("%s(days=%i) 가 ko·en 양쪽에서 문장으로 풀린다", (reason, over, days, key) => {
    for (const locale of ["ko", "en"] as const) {
      const r = result({ suppressed: true, delta: null, reason, ...over });
      const html = render(
        <PeriodDeltaCaption caption={periodCaption(r, { days, curDataCycles: r.cyclesCur })} />,
        locale,
      );
      const domKey = key.replace(/^reason\./, "");
      expect(html, `${key}/${locale}`).toContain(`data-period-delta-reason="${domKey}"`);
      expect(html, `${key}/${locale}`).not.toMatch(RAW);
      expect(html, `${key}/${locale}`).not.toContain(EM_DASH);
      // 자리표시자가 그대로 새면 문장이 아니다.
      expect(html, `${key}/${locale}`).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });

  it("누락 억제 문장은 **수집분** 비율을 적는다 (골든 G3: 누락 40.8% → 59%)", () => {
    const r = result({
      suppressed: true,
      delta: null,
      reason: "missing_share",
      missingSharePrev: 0.40846,
    });
    expect(text(render(<PeriodDeltaCaption caption={periodCaption(r, { days: 30 })} />))).toContain(
      "59%",
    );
  });
});

describe("PeriodDeltaLine — 라벨 + 칩 여럿 + 캡션", () => {
  const view = (results: CompareResult[], days: number) =>
    toPeriodDeltaView(results, { days });

  it("칩이 없으면 줄 자체가 없다 (= 종전 Δ 경로가 그린다)", () => {
    expect(render(<PeriodDeltaLine view={null} />)).toBe("");
    expect(render(<PeriodDeltaLine view={view([], 7)} />)).toBe("");
  });

  it.each(["ko", "en"] as const)("라벨 + 칩 2개 + 회차 문구를 한 줄에 (%s)", (locale) => {
    const html = render(
      <PeriodDeltaLine
        view={view([result(), result({ metric: "share", delta: -1.5531 })], 7)}
      />,
      locale,
    );
    expect(html).not.toMatch(RAW);
    expect(html).toContain("data-period-delta-line");
    expect(html).toContain(locale === "ko" ? "지난 7일 대비" : "vs. previous 7 days");
    expect(html).toContain("9.8pp");
    expect(html).toContain("1.6pp");
    expect(html).not.toContain(EM_DASH);
    expect(html).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("억제되면 칩이 전부 U+2015 이고 사유 문장이 붙는다", () => {
    const sup = (metric: CompareResult["metric"]) =>
      result({
        metric,
        suppressed: true,
        delta: null,
        reason: "missing_share",
        missingSharePrev: 0.41,
      });
    const html = render(<PeriodDeltaLine view={view([sup("visibility"), sup("share")], 30)} />);
    expect(html.match(new RegExp(SUPPRESSED_GLYPH, "g")) ?? []).toHaveLength(2);
    expect(html).toContain('data-period-delta-line="missingShare"');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain(EM_DASH);
  });

  it("지표 이름 6종이 ko·en 사전에 다 있다 — PERIOD_CHIP_ORDER 와 같은 집합", () => {
    for (const messages of [ko.periodCompare, en.periodCompare]) {
      expect(Object.keys(messages.metric).sort()).toEqual([...PERIOD_CHIP_ORDER].sort());
    }
  });
});

describe("periodCompare 사전 — ko·en 쌍 (C3)", () => {
  const flatten = (o: unknown, prefix = ""): string[] =>
    typeof o === "object" && o !== null
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => flatten(v, `${prefix}${k}.`))
      : [prefix.slice(0, -1)];

  it("두 로케일의 키 집합이 같다", () => {
    expect(flatten(ko.periodCompare).sort()).toEqual(flatten(en.periodCompare).sort());
  });

  it("빈 문자열이 없다", () => {
    for (const messages of [ko.periodCompare, en.periodCompare]) {
      const walk = (o: unknown): void => {
        if (typeof o === "string") expect(o.trim().length).toBeGreaterThan(0);
        else if (o && typeof o === "object") Object.values(o).forEach(walk);
      };
      walk(messages);
    }
  });

  // 스펙: 「억제되면 칩은 U+2015 를 그리고 … U+2014 em dash 를 쓰지 않는다」.
  // 문구 쪽은 **둘 다** 금지다 — 억제 기호는 칩에만 있고 문장에는 없다.
  it("UI 문자열에 U+2014·U+2015 가 0건이다", () => {
    for (const messages of [ko.periodCompare, en.periodCompare]) {
      const walk = (o: unknown): void => {
        if (typeof o === "string") {
          expect(o).not.toContain(EM_DASH);
          expect(o).not.toContain(SUPPRESSED_GLYPH);
        } else if (o && typeof o === "object") Object.values(o).forEach(walk);
      };
      walk(messages);
    }
  });

  it("억제 사유 10종이 모두 사전에 있다 (순수 계층이 낼 수 있는 캡션 키 전수)", () => {
    // `noPrevWeek`·`noPrevMonth` 는 달력 주·달력 월의 `no_prev` 전용 문구다 — 창 비교의
    // `noPrevWindow` 가 `{days}` 를 싣는데, 달력 구간에서 그 값은 **현재 구간의 길이**라
    // 비교 대상(직전 달·주 전체)을 잘못 말한다.
    const keys = [
      "unsupported",
      "noPrevWindow",
      "noPrevYear",
      "noPrevWeek",
      "noPrevMonth",
      "noDataPrev",
      "noDataCur",
      "missingShare",
      "startWindow",
      "startMonth",
    ];
    for (const messages of [ko.periodCompare, en.periodCompare]) {
      expect(Object.keys(messages.reason).sort()).toEqual([...keys].sort());
    }
  });

  it("프리셋 라벨은 기간 길이를 문구에 담는다 (제품 결정 Q3=a)", () => {
    expect(ko.periodCompare.label.weekly).toBe("지난 7일 대비");
    expect(ko.periodCompare.label.biweekly).toBe("지난 14일 대비");
    expect(ko.periodCompare.label.monthly).toBe("지난 30일 대비");
    expect(ko.periodCompare.label.yearly).toBe("지난 1년 대비");
    expect(en.periodCompare.label.weekly).toBe("vs. previous 7 days");
  });
});
