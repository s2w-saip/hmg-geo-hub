import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { competitorValueReadArgs, normalizeFilters } from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { unsupportedGlobalFilterReason } from "@/lib/summary/read/gate";
import { planTrendRead } from "@/lib/db/repositories/summary-trend-aggregates";
import { competitorMinis } from "../../../dashboard/_components/overview-kpi-cards";
import { competitorKpiRows, overviewKeyOf, type KpiMetric } from "./kpi-view";
import type { BrandTrendResult } from "@/lib/db/repositories/scope-aggregates";
import type { CompetitorBrandValue, MentionsBrandLive, StandardFilters } from "@/lib/scope/result-adapter";

// 오버레이를 포기할 때 나오는 경고는 **의도된 출력**이다(N-b). 테스트가 그것을 삼키고,
// 필요한 블록에서만 호출을 단언한다.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ════════════════════════════════════════════════════════════════════════════
// 경쟁사 값 — Overview 와 언급 화면이 같은 리더·같은 인자·같은 수 (제품 책임자 2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
// 프리뷰 실측(같은 시각·필터 없음·기준 회차 09-14)에서 두 화면이 달랐다:
//   점유율  Overview Toyota 6.6 · Tesla 6.5 · BMW 5.5 / 언급 BMW 6.1 · Toyota 6.1 · Tesla 5.8
//   노출률  당사 개별 행도 갈렸다 — 사실표 Hyundai 53.3 vs 언급 표 49.0
// 원인은 스키마가 아니라 **리더 비대칭**이었다(`SCHEMA-NEEDS.md` §7).
//
// 이 파일이 막는 것 넷:
//   ① 두 화면의 값 read **인자**가 깊은 동등이고 캐시 키가 같다.
//   ② 같은 필터 상태에서 **폴백 판정**이 같다(한쪽만 미러로 가는 상태가 없다).
//   ③ 같은 픽스처에서 같은 브랜드의 값이 같다(당사 3사 개별 행 포함).
//   ④ 격자 off(= 리더 값 미전달)에서는 종전 값 그대로다.

// ── ① 인자·캐시 키 ──────────────────────────────────────────────────────────

/** 대시보드(`dashboard/page.tsx`)의 필터 구성. */
function dashboardFilters(sp: Record<string, string | string[] | undefined>): StandardFilters {
  const raw = readStandardFilters(sp);
  return { ...raw, cumulative: Boolean(raw.dateFrom || raw.dateTo) };
}
/** 언급(`mention/page.tsx`)의 필터 구성 — `cumulative: true` 상시. */
function mentionFilters(sp: Record<string, string | string[] | undefined>): StandardFilters {
  return { ...readStandardFilters(sp), cumulative: true };
}

const URL_CASES: Array<[string, Record<string, string | string[] | undefined>]> = [
  ["기본(기간 미선택)", {}],
  ["브랜드 필터", { brand: "Hyundai" }],
  ["지역 필터", { region: "US" }],
  ["엔진 필터", { engine: "chatgpt" }],
  ["브랜드+지역+엔진", { brand: "Kia", region: "US", engine: "gemini" }],
  ["기간 지정(시작만)", { time: "2026-09-01.." }],
  ["기간 지정(양끝)", { time: "2026-09-01..2026-09-14" }],
];

describe("① 두 화면의 경쟁사 값 read 인자가 같다", () => {
  for (const [name, sp] of URL_CASES) {
    it(`${name} — 인자가 깊은 동등`, () => {
      expect(competitorValueReadArgs(mentionFilters(sp))).toEqual(
        competitorValueReadArgs(dashboardFilters(sp)),
      );
    });

    it(`${name} — 캐시 키(normalizeFilters 직렬화)도 같다`, () => {
      const a = normalizeFilters(competitorValueReadArgs(mentionFilters(sp))[0]);
      const b = normalizeFilters(competitorValueReadArgs(dashboardFilters(sp))[0]);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  }

  it("예산도 인자다 — 미러 폴백 셀의 캐시 키이므로 같아야 한다", () => {
    expect(competitorValueReadArgs({})[1]).toEqual({ budget: "extras" });
  });

  it("공허하지 않다 — 정규화가 없었다면 기본 화면에서 갈렸다", () => {
    expect(mentionFilters({})).not.toEqual(dashboardFilters({}));
  });
});

// ── ② 폴백 대칭 ─────────────────────────────────────────────────────────────
//
// 사실표를 포기하는 판정은 순수 함수 둘의 합성이고, 둘 다 **필터 객체 하나만** 본다:
//   · `unsupportedGlobalFilterReason` — cumulative · sourceCategory · customFieldFilters ·
//     websiteCountry
//   · `planTrendRead` — depth2 · depth3 · own-variant
// 인자가 같으면 두 판정이 같다. 그것을 실제 객체로 돌려 확인한다(소스 grep 이 아니다).

const FALLBACK_CASES: Array<[string, StandardFilters]> = [
  ["필터 없음", {}],
  ["depth2", { depth2: ["SUV"] }],
  ["depth3", { depth3: ["대형"] }],
  ["sourceCategory", { sourceCategory: ["official"] }],
  ["customFieldFilters", { customFieldFilters: { f1: ["a"] } }],
  ["customFieldFilters(빈 값)", { customFieldFilters: { f1: [] } }],
  ["websiteCountry", { websiteCountry: ["worldwide"] }],
  ["기간", { dateFrom: "2026-09-01", dateTo: "2026-09-14" }],
  ["지역+엔진", { region: ["US"], engine: ["chatgpt"] }],
  ["브랜드 다중(own-variant)", { brand: ["Hyundai", "Kia"] }],
  ["브랜드 단일", { brand: ["Genesis"] }],
];

describe("② 한쪽만 폴백하는 필터 상태가 없다", () => {
  for (const [name, base] of FALLBACK_CASES) {
    it(`${name} — 두 화면의 폴백 사유가 같다`, () => {
      const m = competitorValueReadArgs({ ...base, cumulative: true })[0];
      const d = competitorValueReadArgs({
        ...base,
        cumulative: Boolean(base.dateFrom || base.dateTo),
      })[0];
      for (const mode of ["snapshot", "period"] as const) {
        expect(
          unsupportedGlobalFilterReason(m, mode),
          `${name}/${mode} 미지원 축`,
        ).toBe(unsupportedGlobalFilterReason(d, mode));
      }
      expect(planTrendRead({ surface: "global", filters: m })).toEqual(
        planTrendRead({ surface: "global", filters: d }),
      );
    });
  }

  it("공허하지 않다 — 정규화 없이는 기본 상태에서 한쪽만 폴백한다", () => {
    // 언급 화면의 원본 필터(`cumulative: true`)는 스냅샷 모드에서 미러로 떨어지고,
    // 대시보드의 필터(`cumulative: false`)는 사실표로 간다. 이것이 B1-a 의 모양이다.
    expect(unsupportedGlobalFilterReason({ cumulative: true }, "snapshot")).toBe("cumulative");
    expect(unsupportedGlobalFilterReason({ cumulative: false }, "snapshot")).toBeNull();
  });

  it("사실표가 표현 못 하는 축은 **둘 다** 미러로 간다", () => {
    for (const f of [
      { sourceCategory: ["official"] },
      { customFieldFilters: { f1: ["a"] } },
      { websiteCountry: ["worldwide"] },
    ]) {
      expect(unsupportedGlobalFilterReason(competitorValueReadArgs(f)[0], "period")).not.toBeNull();
    }
    for (const f of [{ depth2: ["SUV"] }, { depth3: ["대형"] }]) {
      expect(
        planTrendRead({ surface: "global", filters: competitorValueReadArgs(f)[0] }).ok,
      ).toBe(false);
    }
  });
});

// ── ③ 값 동일 ───────────────────────────────────────────────────────────────

/** 리더(사실표 회차 스냅샷)가 낸 행들 — Overview 경쟁사 줄이 읽는 바로 그 배열. */
const LEADER: CompetitorBrandValue[] = [
  { brand: "Tesla", mentions: 301, share: 6.5, mentionRate: 30.1, avgPosition: 3.9, isTracked: false, sentiment: { positive: 669, neutral: 200, negative: 100, mixed: 31 } },
  { brand: "BMW", mentions: 299, share: 5.5, mentionRate: 29.9, avgPosition: 4.1, isTracked: false, sentiment: { positive: 671, neutral: 200, negative: 100, mixed: 29 } },
  { brand: "Toyota", mentions: 284, share: 6.6, mentionRate: 28.4, avgPosition: 4.4, isTracked: false, sentiment: { positive: 720, neutral: 180, negative: 80, mixed: 20 } },
  { brand: "Hyundai", mentions: 533, share: 15.1, mentionRate: 53.3, avgPosition: 2.6, isTracked: true, sentiment: { positive: 576, neutral: 240, negative: 140, mixed: 44 } },
  { brand: "Kia", mentions: 440, share: 16.2, mentionRate: 44.0, avgPosition: 2.9, isTracked: true, sentiment: { positive: 532, neutral: 260, negative: 150, mixed: 58 } },
  { brand: "Genesis", mentions: 125, share: 5.1, mentionRate: 12.5, avgPosition: 5.2, isTracked: true, sentiment: { positive: 470, neutral: 300, negative: 180, mixed: 50 } },
];

/** 미러(누적 창)가 낸 행들 — 값이 **일부러 다르다**(프리뷰에서 관측된 차이와 같은 방향). */
const MIRROR: MentionsBrandLive[] = [
  { brand: "Tesla", mentions: 280, prompts: 40, share: 5.8, mentionRate: 30.4, avgPosition: 21.3, isTracked: false },
  { brand: "BMW", mentions: 310, prompts: 44, share: 6.1, mentionRate: 30.4, avgPosition: 20.1, isTracked: false },
  { brand: "Toyota", mentions: 295, prompts: 41, share: 6.1, mentionRate: 28.9, avgPosition: 22.0, isTracked: false },
  { brand: "Hyundai", mentions: 500, prompts: 60, share: 14.2, mentionRate: 49.0, avgPosition: 16.4, isTracked: true },
  { brand: "Kia", mentions: 420, prompts: 55, share: 15.0, mentionRate: 38.1, avgPosition: 18.0, isTracked: true },
  { brand: "Genesis", mentions: 160, prompts: 22, share: 5.6, mentionRate: 16.2, avgPosition: 24.5, isTracked: true },
  // 리더에 **없는** 브랜드 — 최신 회차에 언급이 없었다는 뜻이다.
  { brand: "Volvo", mentions: 12, prompts: 3, share: 0.4, mentionRate: 1.2, avgPosition: 30.0, isTracked: false },
];

const rowsWith = (metric: KpiMetric, values: CompetitorBrandValue[] | null) =>
  competitorKpiRows({ brands: MIRROR, trend: null, metric, ownPct: 60, values });

const pctOf = (metric: KpiMetric, brand: string, values: CompetitorBrandValue[] | null) =>
  rowsWith(metric, values).find((r) => r.brand === brand)?.pct ?? null;

describe("③ 같은 브랜드의 값이 두 화면에서 같다", () => {
  for (const metric of ["exposure", "sov"] as const) {
    const key = overviewKeyOf(metric);

    it(`${metric} — 경쟁사 값이 Overview 미니 카드와 같다`, () => {
      // Overview 가 그리는 값(후보 선정은 언급 수 상위, 표시 순서는 값 순).
      const minis = competitorMinis(LEADER, key, 10);
      expect(minis.length).toBeGreaterThan(0);
      for (const m of minis) {
        expect(pctOf(metric, m.brand, LEADER), `${metric}/${m.brand}`).toBe(m.value);
      }
    });

    it(`${metric} — **당사 3사 개별 행**도 리더 값이다`, () => {
      for (const b of ["Hyundai", "Kia", "Genesis"]) {
        const lead = LEADER.find((x) => x.brand === b)!;
        expect(pctOf(metric, b, LEADER)).toBe(metric === "exposure" ? lead.mentionRate : lead.share);
      }
    });

    it(`${metric} — 오버레이 전후가 실제로 다르다(테스트가 공허하지 않다)`, () => {
      expect(pctOf(metric, "Hyundai", LEADER)).not.toBe(pctOf(metric, "Hyundai", null));
    });

    it(`${metric} — 리더에 없는 브랜드는 null (누적 창 값으로 메우지 않는다)`, () => {
      expect(pctOf(metric, "Volvo", LEADER)).toBeNull();
      // N-a: 언급 수도 **null** 이다. 0 이면 "측정은 있었고 언급이 0" 이라는 값으로
      // 읽혀, 같은 행에서 pct 는 결측인데 언급 수만 사실처럼 보인다.
      expect(rowsWith(metric, LEADER).find((r) => r.brand === "Volvo")?.mentions).toBeNull();
      // 값이 없는 행은 정렬에서 뒤로 간다.
      const order = rowsWith(metric, LEADER).filter((r) => !r.isTracked).map((r) => r.brand);
      expect(order[order.length - 1]).toBe("Volvo");
    });

    it(`${metric} — 언급 수도 값과 같은 원천이다`, () => {
      const row = rowsWith(metric, LEADER).find((r) => r.brand === "Tesla")!;
      expect(row.mentions).toBe(301);
    });
  }

  it("우호도는 언급 화면에 경쟁사 지면이 없다 — 값을 만들지 않는다", () => {
    // 경쟁사 표의 스칼라 열은 탭 지표(노출률·점유율) 하나뿐이고, 우호도 탭
    // (`favorability-kpi-tab.tsx`)에는 브랜드별 행이 없다. 그래서 맞출 대상이 없다.
    // 리더 행에는 감정 4열이 실려 있으므로 지면이 생기면 같은 함수로 낼 수 있다.
    expect(LEADER[0].sentiment).toBeDefined();
  });

  it("표기 흔들림(대소문자·공백)은 접혀서 맞는다", () => {
    const mirror = [{ ...MIRROR[0], brand: " TESLA " }];
    const rows = competitorKpiRows({ brands: mirror, trend: null, metric: "sov", ownPct: 60, values: LEADER });
    expect(rows[0].pct).toBe(6.5);
  });

  it("리더가 **한 건도 못 맞추면** 오버레이를 포기한다(표가 통째로 비지 않게)", () => {
    const alien: CompetitorBrandValue[] = [{ ...LEADER[0], brand: "브랜드-없음" }];
    const rows = competitorKpiRows({ brands: MIRROR, trend: null, metric: "sov", ownPct: 60, values: alien });
    expect(rows.find((r) => r.brand === "Tesla")?.pct).toBe(5.8);
    expect(rows.find((r) => r.brand === "Tesla")?.mentions).toBe(280);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ── N-b 당사 행 공백 방지 (2026-09-20 검증자) ───────────────────────────────
//
// 당사 행은 상한과 무관하게 항상 남는다. 리더에 당사가 없으면 그 행만 "—" 가 되는데,
// **같은 화면 히어로는 사실표 값(53.3)을 그린다** — 한 화면에서 같은 지표가 있고 없고가
// 갈린다. 그래서 안전판이 "당사는 전부 맞아야 한다" 를 요구하고, 어기면 통째로 포기한다.

describe("N-b — 당사 행이 리더에 없으면 오버레이를 통째로 포기한다", () => {
  /** Genesis 만 리더에서 뺀 목록. 경쟁사·나머지 당사 2사는 그대로 맞는다. */
  const NO_GENESIS = LEADER.filter((b) => b.brand !== "Genesis");

  const rows = (metric: KpiMetric) =>
    competitorKpiRows({ brands: MIRROR, trend: null, metric, ownPct: 60, values: NO_GENESIS });

  it("당사 3사가 전부 미러 값으로 남는다 — '—' 가 되지 않는다", () => {
    const r = rows("exposure");
    expect(r.find((x) => x.brand === "Genesis")?.pct).toBe(16.2);
    expect(r.find((x) => x.brand === "Hyundai")?.pct).toBe(49.0);
  });

  it("경쟁사 행도 함께 되돌아간다 — 부분 적용은 모순을 남긴다", () => {
    expect(rows("sov").find((x) => x.brand === "Tesla")?.pct).toBe(5.8);
  });

  it("언급 수도 미러 값 그대로다(한 행 안에서 원천이 갈리지 않는다)", () => {
    expect(rows("sov").find((x) => x.brand === "Genesis")?.mentions).toBe(160);
  });

  it("**포기는 조용하지 않다** — 안 맞은 당사 브랜드가 로그에 남는다", () => {
    rows("sov");
    expect(warnSpy).toHaveBeenCalled();
    const line = warnSpy.mock.calls[0]?.map(String).join(" ") ?? "";
    expect(line).toContain("오버레이 포기");
    expect(line).toContain("Genesis");
  });

  it("공허하지 않다 — 종전 안전판('한 건이라도 맞으면 통과')이었다면 적용됐을 입력이다", () => {
    // 경쟁사·당사 2사는 맞으므로 `anyMatched` 는 참이다.
    expect(NO_GENESIS.some((b) => b.brand === "Hyundai")).toBe(true);
    // 그 상태에서 종전 규칙이면 Genesis 만 "—" 였다(히어로는 53.3).
    expect(rows("exposure").find((x) => x.brand === "Genesis")?.pct).not.toBeNull();
  });
});

// ── N-c 스칼라와 스파크·증감의 모집단 차이 (표시만, 코드 변경 아님) ──────────
//
// 한 행에서 원천이 둘이다:
//   · 스칼라 `pct`  = 사실표 **스냅샷**(`in_full_cycle` 게이트 적용)
//   · 스파크·`wowPp` = 13자리 **회차 추이**(격자 on 은 그 게이트 미적용)
// 최신 회차에서는 차이가 0이지만(메인 P5 실측), 과거 회차를 기준일로 고르면 모수가
// 4.6배까지 갈린다(`trend-grid-flag.ts` 주석의 08-17 실측: 332 대 1,539).
// Overview 경쟁사 줄도 **같은 구조**라 이 PR 이 만든 비대칭이 아니다. 후속에서 다루고,
// 여기서는 **현재 동작을 고정**한다 — 조용히 바뀌면 아무도 못 잡는다.

describe("N-c — 스칼라와 스파크·증감이 다른 모집단이다(현재 동작 고정)", () => {
  /** 과거 회차: 추이(게이트 없음)의 값이 스냅샷(게이트 적용)보다 크게 낮다. */
  const pastTrend = (): BrandTrendResult =>
    ({
      unit: "week",
      brands: [{ brand: "Toyota" }],
      buckets: [
        { bucketStart: "2026-08-10", measuredDays: 1, brands: [{ brand: "Toyota", exposurePct: 12.0, sharePct: 2.0 }] },
        { bucketStart: "2026-08-17", measuredDays: 1, brands: [{ brand: "Toyota", exposurePct: 11.4, sharePct: 1.8 }] },
      ],
    }) as unknown as BrandTrendResult;

  const row = (metric: KpiMetric) =>
    competitorKpiRows({
      brands: MIRROR,
      trend: pastTrend(),
      metric,
      ownPct: 60,
      values: LEADER,
    }).find((r) => r.brand === "Toyota")!;

  it("스칼라는 스냅샷 값이다", () => {
    expect(row("exposure").pct).toBe(28.4);
    expect(row("sov").pct).toBe(6.6);
  });

  it("스파크의 **마지막 점은 다른 수**다 — 모수가 다르다", () => {
    const r = row("exposure");
    expect(r.spark[r.spark.length - 1]).toBe(11.4);
    expect(r.spark[r.spark.length - 1]).not.toBe(r.pct);
  });

  it("증감은 스파크 배열의 차이고 **스칼라의 변화가 아니다**", () => {
    // 스칼라는 28.4 인데 칩은 추이 두 점의 차(-0.6)를 말한다.
    expect(row("exposure").wowPp).toBe(-0.6);
    expect(row("sov").wowPp).toBe(-0.2);
  });

  it("Gap 은 스칼라 기준이다(당사 합산과 같은 모집단)", () => {
    expect(row("exposure").gapPp).toBe(-31.6); // 28.4 - 60
  });

  it("최신 회차처럼 두 원천이 일치하면 차이가 0 이다(오늘의 기본 화면)", () => {
    const aligned = {
      unit: "week",
      brands: [{ brand: "Toyota" }],
      buckets: [
        { bucketStart: "2026-09-07", measuredDays: 1, brands: [{ brand: "Toyota", exposurePct: 28.0, sharePct: 6.5 }] },
        { bucketStart: "2026-09-14", measuredDays: 1, brands: [{ brand: "Toyota", exposurePct: 28.4, sharePct: 6.6 }] },
      ],
    } as unknown as BrandTrendResult;
    const r = competitorKpiRows({
      brands: MIRROR, trend: aligned, metric: "exposure", ownPct: 60, values: LEADER,
    }).find((x) => x.brand === "Toyota")!;
    expect(r.spark[r.spark.length - 1]).toBe(r.pct);
  });
});

// ── ④ 격자 off 무변경 ───────────────────────────────────────────────────────

describe("④ 리더 값이 없으면(격자 off·degrade) 종전 그대로다", () => {
  /** 2026-09-20 이전 `competitorKpiRows` 의 값·언급 수 산식(원문). */
  const before = (b: MentionsBrandLive, metric: KpiMetric) => ({
    pct: b.mentions > 0 ? (metric === "exposure" ? b.mentionRate : b.share) : null,
    mentions: b.mentions as number | null,
  });

  for (const metric of ["exposure", "sov"] as const) {
    for (const values of [null, undefined, []] as const) {
      it(`${metric} · values=${JSON.stringify(values)} — 미러 값·언급 수 그대로`, () => {
        const rows = competitorKpiRows({
          brands: MIRROR,
          trend: null,
          metric,
          ownPct: 60,
          ...(values === undefined ? {} : { values }),
        });
        for (const r of rows) {
          const src = MIRROR.find((b) => b.brand === r.brand)!;
          expect({ pct: r.pct, mentions: r.mentions }, r.brand).toEqual(before(src, metric));
        }
      });
    }
  }
});
