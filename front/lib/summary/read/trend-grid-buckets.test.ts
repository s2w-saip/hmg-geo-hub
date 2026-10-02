import { describe, expect, it } from "vitest";
import type { StandardTrendBucket } from "@/lib/db/repositories/scope-aggregates";
import type { TrendSlot } from "@/lib/period/trend-grid";
import { CITATIONS_COLLECTION_ERROR_GAP, isTrendGap } from "@/lib/viz/trend-gap";
import {
  applyTrendGridToBuckets,
  applyTrendGridToWeeklyTrend,
  restrictToTrendGrid,
  toTrendGridSlotViews,
} from "./trend-grid-buckets";
import { isTrendGridApplied } from "@/lib/period/trend-grid-axis";

// ════════════════════════════════════════════════════════════════════════════
// 격자 → 추이 버킷 — **자리가 축을 정하고, 값은 얹힐 뿐이다**
// ════════════════════════════════════════════════════════════════════════════

const slot = (
  roundDate: string,
  opts: { anchorWeek?: string; gapReason?: TrendSlot["gapReason"] } = {},
): TrendSlot => ({
  roundDate,
  anchorWeek: opts.anchorWeek ?? roundDate,
  cycleIds: [`c-${roundDate}`],
  renderable: !opts.gapReason,
  gapReason: opts.gapReason ?? null,
  completionRatio: opts.gapReason ? null : 1,
});

const bucket = (
  key: string,
  over: Partial<StandardTrendBucket> = {},
): StandardTrendBucket => ({
  bucketStart: key,
  roundDate: key,
  cycleAnchorAt: `${key}T00:00:00.000Z`,
  answers: 100,
  trackedAnswers: 70,
  totalMentions: 50,
  trackedMentions: 20,
  sentMentions: 10,
  positiveMentions: 6,
  avgPosition: 2.5,
  totalCitations: 30,
  ownedCitations: 9,
  measuredDays: 1,
  firstAt: `${key}T00:00:00.000Z`,
  lastAt: `${key}T00:00:00.000Z`,
  ...over,
});

describe("applyTrendGridToBuckets", () => {
  it("자리가 없으면(키 off) **입력 배열 그대로**(참조 동일)", () => {
    const input = [bucket("2026-09-07"), bucket("2026-09-14")];
    expect(applyTrendGridToBuckets(input, null)).toBe(input);
  });

  it("자리 ∧ 값 → 점, 자리 ∧ 값 없음 → 사유가 실린 갭", () => {
    const slots = [
      slot("2026-07-06"),
      slot("2026-07-13", { gapReason: "not-published" }),
      slot("2026-08-03"),
    ];
    const out = applyTrendGridToBuckets([bucket("2026-07-06"), bucket("2026-08-03")], slots);
    expect(out.map((b) => b.bucketStart)).toEqual([
      "2026-07-06", "2026-07-13", "2026-08-03",
    ]);
    expect(out[1].gap?.reason).toBe("not_published");
    expect(isTrendGap(out[1].gap)).toBe(true);
    // 계약 — 갭 슬롯의 측정값은 전부 0/null 이다.
    expect(out[1].answers).toBe(0);
    expect(out[1].avgPosition).toBeNull();
    expect(out[1].measuredDays).toBe(0);
  });

  it("자리는 있는데 그 지면에 값이 없으면 `no_value` 갭이다", () => {
    const out = applyTrendGridToBuckets(
      [bucket("2026-07-06")],
      [slot("2026-07-06"), slot("2026-08-03")],
    );
    expect(out[1].gap?.reason).toBe("no_value");
  });

  it("자리 없는 값은 **버린다** — 없던 주를 만들지 않는다", () => {
    const out = applyTrendGridToBuckets(
      [bucket("2026-05-04"), bucket("2026-07-06")],
      [slot("2026-07-06")],
    );
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-07-06"]);
  });

  it("인용 계열 마커는 살아남는다 — 격자가 대체하는 것은 채움이지 마커가 아니다", () => {
    const marked = bucket("2026-08-24", {
      gap: CITATIONS_COLLECTION_ERROR_GAP,
      totalCitations: 0,
      ownedCitations: 0,
    });
    const out = applyTrendGridToBuckets([marked], [slot("2026-08-24")]);
    expect(out[0].gap).toBe(CITATIONS_COLLECTION_ERROR_GAP);
    // 언급 값은 그대로 살아 있다("멘션은 살려줘야 해" — 0071).
    expect(out[0].answers).toBe(100);
  });

  it("미러 주 키(월요일)로 온 값도 금요일 자리를 찾는다", () => {
    const s = slot("2026-09-11", { anchorWeek: "2026-09-07" });
    // 미러 경로: 버킷 키는 주 월요일이고 `roundDate` 는 실려 있지 않을 수 있다.
    const mirror = bucket("2026-09-07", { roundDate: undefined, cycleAnchorAt: undefined });
    const out = applyTrendGridToBuckets([mirror], [s]);
    expect(out).toHaveLength(1);
    expect(out[0].bucketStart).toBe("2026-09-11");
    expect(out[0].roundDate).toBe("2026-09-11");
    expect(out[0].answers).toBe(100);
  });

  it("갭 버킷도 회차 축 신호를 갖는다 — `every` 판정이 깨지면 화면이 다시 채운다", () => {
    const out = applyTrendGridToBuckets(
      [bucket("2026-07-06"), bucket("2026-08-03")],
      [slot("2026-07-06"), slot("2026-07-13", { gapReason: "not-published" }), slot("2026-08-03")],
    );
    expect(out.every((b) => !!b.cycleAnchorAt)).toBe(true);
  });

  // 검증 B2 — 화면이 채움을 건너뛰는 근거는 **데이터 표식**이지 스위치가 아니다.
  it("격자가 만든 버킷은 전부 `gridSlot` 표식을 갖는다(점·갭 둘 다)", () => {
    const out = applyTrendGridToBuckets(
      [bucket("2026-07-06")],
      [slot("2026-07-06"), slot("2026-07-13", { gapReason: "not-published" })],
    );
    expect(out.every((b) => b.gridSlot === true)).toBe(true);
    expect(isTrendGridApplied(out)).toBe(true);
  });

  it("키 off 경로의 버킷에는 표식이 없다 — 화면이 종전 채움을 쓴다", () => {
    const input = [bucket("2026-09-07")];
    expect(isTrendGridApplied(applyTrendGridToBuckets(input, null))).toBe(false);
  });

  // `null`(격자를 못 세웠다)과 `[]`(이 창에 자리가 없다)는 **다른 명제**다.
  // 뭉개면 기간을 좁혀 자리가 0인 화면이 **창 밖 값을 그대로 그린다** — 사용자가 고른
  // 기간과 다른 데이터를 보여 주는 것이라 값이 사라지는 것보다 나쁘다.
  it("자리가 0개면 빈 추이다 — 창 밖 값으로 되돌아가지 않는다", () => {
    expect(applyTrendGridToBuckets([bucket("2026-09-07")], [])).toEqual([]);
  });
});

describe("applyTrendGridToWeeklyTrend", () => {
  const row = (week: string, over: Record<string, unknown> = {}) => ({
    week,
    "HYUNDAI": 10,
    "KIA": 5,
    ...over,
  });
  const trend = (points: ReturnType<typeof row>[]) => ({
    series: ["HYUNDAI", "KIA"],
    points,
  });

  it("격자가 없으면(키 off) **입력 그대로**(참조 동일)", () => {
    const t = trend([row("2026-09-07")]);
    expect(applyTrendGridToWeeklyTrend(t, null)).toBe(t);
  });

  it("자리 ∧ 값 → 점, 자리 ∧ 값 없음 → 시리즈 전부 null + 갭 마커", () => {
    const out = applyTrendGridToWeeklyTrend(
      trend([row("2026-07-06"), row("2026-08-03")]),
      [
        { roundDate: "2026-07-06", anchorWeek: "2026-07-06", gapReason: null },
        { roundDate: "2026-07-13", anchorWeek: "2026-07-13", gapReason: "not-published" },
        { roundDate: "2026-08-03", anchorWeek: "2026-08-03", gapReason: null },
      ],
    );
    expect(out?.points.map((p) => p.week)).toEqual([
      "2026-07-06", "2026-07-13", "2026-08-03",
    ]);
    expect(out?.points[1].HYUNDAI).toBeNull();
    expect(out?.points[1].KIA).toBeNull();
    expect(isTrendGap(out?.points[1].gap)).toBe(true);
  });

  // 미러 주 격자 키(`ca.anchor_week`)가 금요일 자리(website)를 찾아야 한다.
  it("주 월요일 키로 온 행이 금요일 자리로 옮겨진다", () => {
    const out = applyTrendGridToWeeklyTrend(trend([row("2026-09-07")]), [
      { roundDate: "2026-09-11", anchorWeek: "2026-09-07", gapReason: null },
    ]);
    expect(out?.points).toHaveLength(1);
    expect(out?.points[0].week).toBe("2026-09-11");
    expect(out?.points[0].HYUNDAI).toBe(10);
  });

  it("자리 밖 행은 버린다", () => {
    const out = applyTrendGridToWeeklyTrend(
      trend([row("2026-05-04"), row("2026-09-07")]),
      [{ roundDate: "2026-09-07", anchorWeek: "2026-09-07", gapReason: null }],
    );
    expect(out?.points.map((p) => p.week)).toEqual(["2026-09-07"]);
  });

  it("자리가 0개면 점이 없다 — 시리즈 목록은 유지한다", () => {
    const out = applyTrendGridToWeeklyTrend(trend([row("2026-09-07")]), []);
    expect(out).toEqual({ series: ["HYUNDAI", "KIA"], points: [] });
  });

  it("0070 숨김 마커가 붙은 행은 그대로 나른다", () => {
    const marked = row("2026-08-24", { gap: CITATIONS_COLLECTION_ERROR_GAP });
    const out = applyTrendGridToWeeklyTrend(trend([marked]), [
      { roundDate: "2026-08-24", anchorWeek: "2026-08-24", gapReason: null },
    ]);
    expect(out?.points[0].gap).toBe(CITATIONS_COLLECTION_ERROR_GAP);
    expect(out?.points[0].HYUNDAI).toBe(10);
  });
});

describe("toTrendGridSlotViews", () => {
  it("화면으로 내려가는 것은 자리 키·주·사유 셋뿐이다", () => {
    expect(toTrendGridSlotViews([slot("2026-09-11", { anchorWeek: "2026-09-07" })])).toEqual([
      { roundDate: "2026-09-11", anchorWeek: "2026-09-07", gapReason: null },
    ]);
  });

  // `undefined` 와 `[]` 를 가르는 것이 계약이다 — 앞은 "격자 없음"(화면이 종전 축을
  // 만든다), 뒤는 "이 창에 자리가 없다"(축도 비어야 한다).
  it("null 만 undefined 다 — 빈 배열은 그대로 빈 배열이다", () => {
    expect(toTrendGridSlotViews(null)).toBeUndefined();
    expect(toTrendGridSlotViews([])).toEqual([]);
  });
});

// 검증 B4 — 부수 시리즈(인용 정확도 추이 ⑥·KPI 탭 버킷)는 **가두기만** 한다.
describe("restrictToTrendGrid", () => {
  const row = (bucketStart: string, rate = 10) => ({ bucketStart, rate });

  it("격자가 없으면 입력 그대로(참조 동일)", () => {
    const input = [row("2026-09-07")];
    expect(restrictToTrendGrid(input, null)).toBe(input);
  });

  it("자리 밖 행을 버린다 — 없던 주를 만들지 않는다", () => {
    const out = restrictToTrendGrid(
      [row("2026-07-24"), row("2026-07-31"), row("2026-08-07")],
      [
        { roundDate: "2026-07-24", anchorWeek: "2026-07-20", gapReason: null },
        { roundDate: "2026-08-07", anchorWeek: "2026-08-03", gapReason: null },
      ],
    );
    // website 07-31 은 원장에 자리가 없다 — 메인 추이에서 사라진 그 자리가
    // ⑥ 한 차트에만 남으면 같은 페이지에 축이 둘이 된다.
    expect(out.map((r) => r.bucketStart)).toEqual(["2026-07-24", "2026-08-07"]);
  });

  it("갭 자리의 행도 버린다 — 음영 위에 점이 얹히면 안 된다", () => {
    const out = restrictToTrendGrid(
      [row("2026-07-13")],
      [{ roundDate: "2026-07-13", anchorWeek: "2026-07-13", gapReason: "not-published" }],
    );
    expect(out).toEqual([]);
  });

  it("주 월요일 키로 온 행을 금요일 자리로 옮긴다", () => {
    const out = restrictToTrendGrid(
      [row("2026-09-07")],
      [{ roundDate: "2026-09-11", anchorWeek: "2026-09-07", gapReason: null }],
    );
    expect(out.map((r) => r.bucketStart)).toEqual(["2026-09-11"]);
  });

  it("자리가 0개면 빈 배열 — 창 밖 값으로 되돌아가지 않는다", () => {
    expect(restrictToTrendGrid([row("2026-09-07")], [])).toEqual([]);
  });

  // ⑥ 은 갭 행을 만들지 않는다 — 자리를 세우는 것은 메인 추이다.
  it("없는 자리에 행을 **만들지 않는다**", () => {
    const out = restrictToTrendGrid(
      [row("2026-08-07")],
      [
        { roundDate: "2026-07-24", anchorWeek: "2026-07-20", gapReason: null },
        { roundDate: "2026-08-07", anchorWeek: "2026-08-03", gapReason: null },
      ],
    );
    expect(out).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 검증 C1 — 기간을 고르면 주별 Top-N 축도 그 안이어야 한다
// ════════════════════════════════════════════════════════════════════════════
//
// 값 쪽(`mentionBrandDayCountsQuery` 등)은 기간 술어를 탄다. 축만 최근 13자리로 두면
// 2주를 고른 화면에서 **11칸이 거짓 결측**이 된다(B1 과 같은 실패 계열: 안 읽은 것을
// 결측이라 말한다). 자리 목록을 기간으로 좁히는 것은 `trendSlotsFor` 가 하고, 여기서는
// **좁혀진 자리로는 거짓 갭이 안 생긴다**는 성질만 고정한다.
describe("기간을 좁힌 주별 Top-N (C1)", () => {
  const slotsOf = (dates: string[]) =>
    dates.map((d) => ({ roundDate: d, anchorWeek: d, gapReason: null as null }));
  const row = (week: string) => ({ week, HYUNDAI: 10 });

  it("기간 안 자리만 주면 값 2행 · 갭 0행", () => {
    const out = applyTrendGridToWeeklyTrend(
      { series: ["HYUNDAI"], points: [row("2026-09-07"), row("2026-09-14")] },
      slotsOf(["2026-09-07", "2026-09-14"]),
    );
    expect(out?.points).toHaveLength(2);
    expect(out?.points.filter((p) => p.gap != null)).toHaveLength(0);
  });

  it("기간을 안 좁히면 13자리 중 11칸이 거짓 갭이 된다 — 고치기 전 모양", () => {
    const thirteen = Array.from({ length: 13 }, (_, i) =>
      new Date(Date.parse("2026-06-22T00:00:00Z") + i * 7 * 86_400_000)
        .toISOString().slice(0, 10),
    );
    const out = applyTrendGridToWeeklyTrend(
      { series: ["HYUNDAI"], points: [row("2026-09-07"), row("2026-09-14")] },
      slotsOf(thirteen),
    );
    expect(out?.points).toHaveLength(13);
    expect(out?.points.filter((p) => p.gap != null)).toHaveLength(11);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 검증 C2·C6 — 라벨이 어긋나도 **값이 갭이 되지 않는다** (2단 자리 해소)
// ════════════════════════════════════════════════════════════════════════════
//
// 값 쪽 라벨(`round_label`)은 `to_char(max(round_date))` 이고 그 `max` 의 모집단은
// **필터된 답변셋**이다. 자리 쪽 접힌 키는 **원장**의 그 주 마지막 자리다. 모집단이 다르니
// 갈리고, 갈리면 그 주가 통째로 거짓 결측이 됐다. 검증자가 든 어긋남 입력 넷을 그대로 박는다.
describe("라벨 어긋남 넷 (C2)", () => {
  /** 프로젝트 다자리 주: 09-15·09-16·09-17 이 전부 `anchor_week` 09-14 → 접힌 키 09-17. */
  const projectSlot = (roundDate: string) =>
    slot(roundDate, { anchorWeek: "2026-09-14" });

  /** 미러 주 버킷: 키는 주 월요일, 라벨은 답변셋의 `max(round_date)`. */
  const weekBucket = (roundLabel: string) =>
    bucket("2026-09-14", { roundDate: roundLabel, cycleAnchorAt: undefined });

  const collapsed = [
    slot("2026-09-07"),
    // 접은 결과와 같은 모양(그 주 마지막 자리 하나).
    projectSlot("2026-09-17"),
  ];

  it.each([
    ["(a) 마지막 회차가 사용자 필터에 전부 걸림", "2026-09-15"],
    ["(b) 마지막 회차가 hidden_scope=all 로 숨겨짐", "2026-09-16"],
    ["(c) to 가 주 가운데라 답변이 그 앞까지만", "2026-09-15"],
    ["(d) 마지막 회차의 해당 계열 답변이 0", "2026-09-16"],
  ])("%s 이어도 그 주 값이 산다", (_label, roundLabel) => {
    const out = applyTrendGridToBuckets(
      [bucket("2026-09-07"), weekBucket(roundLabel)],
      collapsed,
    );
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-09-07", "2026-09-17"]);
    const week = out[1];
    expect(week.gap, "그 주가 갭이 됐다 — 2단 해소가 안 돈다").toBeUndefined();
    expect(week.answers).toBe(100);
    // 표시 라벨은 **자리 키**다(카드 기준일과 같은 규칙) — 필터를 켜고 끌 때마다
    // x축 날짜가 움직이면 안 된다.
    expect(week.roundDate).toBe("2026-09-17");
  });

  it("라벨이 자리 키와 같으면 1단에서 끝난다 — 글로벌·website 경로 무변화", () => {
    const out = applyTrendGridToBuckets(
      [bucket("2026-09-14", { roundDate: "2026-09-14" })],
      [slot("2026-09-14")],
    );
    expect(out[0].answers).toBe(100);
    expect(out[0].roundDate).toBe("2026-09-14");
  });

  it("라벨·주 키 둘 다 자리 밖이면 버린다(로그)", () => {
    const out = applyTrendGridToBuckets(
      [bucket("2026-05-04", { roundDate: "2026-05-04" })],
      [slot("2026-09-14")],
    );
    expect(out).toHaveLength(1);
    expect(out[0].gap?.reason).toBe("no_value");
  });
});

// 검증 D1 × C2 — 접힌 키가 "서빙 가능한 마지막" 으로 바뀌면 값 쪽 라벨과 **더 자주**
// 어긋난다. 2단 해소가 그것을 받아 주는지가 D1 수리의 전제다.
describe("D1 라벨 변경 × 2단 해소", () => {
  it("자리 키 09-15 · 값 라벨 09-17(미발행 자리) → 주 키로 붙는다", () => {
    const out = applyTrendGridToBuckets(
      [
        bucket("2026-09-14", {
          // 값 쪽 `round_label` 이 원장의 미발행 마지막 자리를 가리키는 경우.
          roundDate: "2026-09-17",
          cycleAnchorAt: undefined,
        }),
      ],
      [slot("2026-09-15", { anchorWeek: "2026-09-14" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].bucketStart).toBe("2026-09-15");
    expect(out[0].gap, "그 주가 갭이 됐다").toBeUndefined();
    expect(out[0].answers).toBe(100);
    // 표시 라벨은 자리 키(= 실제로 발행된 마지막 회차)다.
    expect(out[0].roundDate).toBe("2026-09-15");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 통합 검증 B1 — 자리가 120일보다 멀어도 값이 갭이 되지 않는다
// ════════════════════════════════════════════════════════════════════════════
//
// 주별 Top-N 의 두 리더는 바닥이 120일인데 자리 목록은 `TREND_GRID_MAX_DAYS` 180일까지
// 뻗는다. 읽기 창을 자리 창으로 좁히지 않으면 121~180일 구간이 **값이 있는데도**
// `no_value` 갭이 되고, 그 갭은 화면에서 수집 오류와 같은 음영으로 그려진다.
//
// 여기서는 그 성질을 순수 함수로 고정한다: **읽기 창 == 자리 창이면 갭이 0이다.**
describe("자리 첫 날이 150일 전인 격자 (B1)", () => {
  const DAY = 86_400_000;
  const TODAY = Date.parse("2026-09-20T00:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  /** 150일 전부터 주 단위 13자리(= 150·143·…·66일 전). 전부 120일을 넘는 자리가 5개다. */
  const SLOTS = Array.from({ length: 13 }, (_, i) =>
    iso(TODAY - (150 - i * 7) * DAY),
  ).map((d) => ({ roundDate: d, anchorWeek: d, gapReason: null as null }));

  it("픽스처 전제 — 121일보다 오래된 자리가 실제로 있다", () => {
    const old = SLOTS.filter(
      (s) => (TODAY - Date.parse(`${s.roundDate}T00:00:00Z`)) / DAY > 120,
    );
    expect(old.length, "이 픽스처는 120일 상한을 안 넘는다").toBeGreaterThanOrEqual(4);
  });

  it("읽기 창 == 자리 창이면 13자리 전부 값이 붙고 갭이 0이다", () => {
    // 창이 `slots[0]` 로 좁혀지면 그 창 안의 모든 주에 값이 온다.
    const points = SLOTS.map((s) => ({ week: s.roundDate, HYUNDAI: 7 }));
    const out = applyTrendGridToWeeklyTrend({ series: ["HYUNDAI"], points }, SLOTS);
    expect(out?.points).toHaveLength(13);
    expect(out?.points.filter((p) => p.gap != null), "거짓 갭이 생겼다").toHaveLength(0);
  });

  it("읽기 창이 120일에 머물면 그만큼이 거짓 갭이 된다 — 고치기 전 모양", () => {
    const within120 = SLOTS.filter(
      (s) => (TODAY - Date.parse(`${s.roundDate}T00:00:00Z`)) / DAY <= 120,
    );
    const points = within120.map((s) => ({ week: s.roundDate, HYUNDAI: 7 }));
    const out = applyTrendGridToWeeklyTrend({ series: ["HYUNDAI"], points }, SLOTS);
    const gaps = out?.points.filter((p) => p.gap != null) ?? [];
    expect(gaps.length).toBe(13 - within120.length);
    // 그 갭의 사유는 `no_value` 이고, viz 는 이것을 수집 오류와 **같은 음영**으로 그린다.
    expect(gaps[0]?.gap).toEqual({ reason: "no_value" });
  });

  it("버킷 경로도 같다 — 창이 자리 창이면 갭 0", () => {
    const slotObjs = SLOTS.map((s) => slot(s.roundDate));
    const out = applyTrendGridToBuckets(
      SLOTS.map((s) => bucket(s.roundDate)),
      slotObjs,
    );
    expect(out).toHaveLength(13);
    expect(out.filter((b) => b.gap != null)).toHaveLength(0);
  });
});
