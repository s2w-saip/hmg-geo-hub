import { describe, expect, it } from "vitest";
import {
  TREND_GRID_MAX_DAYS,
  TREND_GRID_SLOTS,
  mergeTrendGrid,
  takeLatestSlots,
  toTrendSlots,
  trendGridDateFloor,
  withTrendGridWindow,
  type TrendSlot,
} from "./trend-grid";
import type { TrendGridSlotRow } from "@/lib/db/repositories/trend-grid-slots";

// ════════════════════════════════════════════════════════════════════════════
// 손계산 리터럴의 출처 — W0 실측 (설계 문서 "확정과 W0 실측" 절, 운영 담당, 미러 읽기 전용)
// ════════════════════════════════════════════════════════════════════════════
//
//   글로벌 : 자리 15개(2026-06-08 ~ 09-14) **전부 월요일**.
//            07-13·07-20·07-27 은 회차가 `closed`·미발행(분석 갭 17~22%)이라 점이 없다.
//            한 자리 두 회차: 07-13(둘 다 미발행) · 08-10(셋, 함대 패자 2) ·
//            08-17(둘, 패자 1) · 08-24(둘, 인용 숨김 1).
//   website: 자리는 07-03 ~ 09-18 **금요일**이고 **07-31 은 원장에 자리 자체가 없다**.
//
// 지금 화면(메인 관찰): Overview 창 91일·회차 축이면 빈 자리 미채움 → **5점** /
// 언급 창 84일·항상 주 격자 채움 → **13점**(그중 5점이 빈 슬롯). 격자 on 은 둘 다
// 같은 13자리가 된다.

const MON = [
  "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06",
  "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10",
  "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14",
] as const;

/** website 금요일 자리 — **07-31 결번**(원장에 없다). */
const FRI = [
  "2026-07-03", "2026-07-10", "2026-07-17", "2026-07-24",
  "2026-08-07", "2026-08-14", "2026-08-21", "2026-08-28",
  "2026-09-04", "2026-09-11", "2026-09-18",
] as const;

/** 미발행 확정 자리(W0: 회차는 있는데 `closed`·미발행). */
const UNPUBLISHED = new Set(["2026-07-13", "2026-07-20", "2026-07-27"]);

/** `YYYY-MM-DD` → 그 주의 월요일(`hmg_anchor_week` 와 같은 값). 픽스처용 손계산. */
function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const row = (p: Partial<TrendGridSlotRow> & { roundDate: string }): TrendGridSlotRow => ({
  // SQL 은 `hmg_anchor_week(round_date)` 를 싣는다 — **원장 `cycle_week` 가 아니다**
  // (초판이 그것을 실어 한 주씩 어긋났다). 픽스처도 같은 파생을 쓴다.
  anchorWeek: mondayOf(p.roundDate),
  cycleIds: [`c-${p.roundDate}`],
  totalCycles: 1,
  assignedCycles: 1,
  servableCycles: 1,
  collectionErrorCycles: 0,
  operatorCycles: 0,
  completionRatio: 1,
  ...p,
});

/** 글로벌 15자리 원자료 — 미발행 셋만 서빙 불가. */
const globalRows = (): TrendGridSlotRow[] =>
  MON.map((d) =>
    UNPUBLISHED.has(d)
      ? row({
          roundDate: d,
          // 07-13 은 회차가 둘인데 둘 다 미발행이다(W0 A3).
          cycleIds: d === "2026-07-13" ? [`c-${d}-a`, `c-${d}-b`] : [`c-${d}`],
          totalCycles: d === "2026-07-13" ? 2 : 1,
          assignedCycles: d === "2026-07-13" ? 2 : 1,
          servableCycles: 0,
          completionRatio: null,
        })
      : row({ roundDate: d }),
  );

const websiteRows = (): TrendGridSlotRow[] => FRI.map((d) => row({ roundDate: d }));

// ── ① 표면별 요일 ───────────────────────────────────────────────────────────

describe("자리 키의 요일 — 정규 요일은 0077 배정이 굳힌 값이다", () => {
  const dow = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay();

  it("글로벌 자리는 전부 월요일이다", () => {
    for (const s of toTrendSlots(globalRows())) expect(dow(s.roundDate), s.roundDate).toBe(1);
  });

  it("website 자리는 전부 금요일이다", () => {
    for (const s of toTrendSlots(websiteRows())) expect(dow(s.roundDate), s.roundDate).toBe(5);
  });
});

// ── ①' `anchor_week` — round_date 에서 파생한다 (미러 실측이 잡은 결함 1) ────
//
// 초판은 원장 `cycle_week`(앵커 **시각**의 UTC 주)를 실었다. 미러 실측:
// 글로벌 round_date 06-08 자리의 anchor_week 가 `2026-06-01`, 06-15 → `06-08`,
// 08-24 → `08-17`. **한 주씩 어긋난다.** 계약은 "round_date 가 속한 KST 주의 월요일" 이다.

describe("anchorWeek — 자리 날짜의 주 월요일이지 원장 cycle_week 가 아니다", () => {
  it("글로벌은 자리가 월요일이라 anchorWeek == roundDate 다", () => {
    for (const s of toTrendSlots(globalRows())) {
      expect(s.anchorWeek, s.roundDate).toBe(s.roundDate);
    }
    // 실측이 잡은 그 자리 — 06-08 의 anchor_week 가 06-01 이면 결함이다.
    const first = toTrendSlots(globalRows())[0];
    expect(first.roundDate).toBe("2026-06-08");
    expect(first.anchorWeek).toBe("2026-06-08");
    expect(first.anchorWeek).not.toBe("2026-06-01");
  });

  it("website 는 자리가 금요일이라 anchorWeek = 자리 - 4일 이다", () => {
    for (const s of toTrendSlots(websiteRows())) {
      const diff =
        (Date.parse(`${s.roundDate}T00:00:00Z`) - Date.parse(`${s.anchorWeek}T00:00:00Z`)) /
        86_400_000;
      expect(diff, s.roundDate).toBe(4);
      expect(new Date(`${s.anchorWeek}T00:00:00Z`).getUTCDay(), s.anchorWeek).toBe(1);
    }
  });

  // 병합 키는 `roundDate` 하나다. `anchorWeek` 로 맞추면 website 는 4일 어긋나
  // **전 자리가 `no-value` 갭**이 된다 — 그 사실을 기계로 못 박는다.
  it("병합은 roundDate 로 맞춘다 — anchorWeek 로 맞추면 전부 갭이다", () => {
    const slots = toTrendSlots(websiteRows());
    const buckets = slots.map((s) => ({ roundDate: s.roundDate, answers: 1 }));

    const byRound = mergeTrendGrid(slots, buckets, { keyOf: (b) => b.roundDate });
    expect(byRound.cells.every((c) => c.gapReason === null)).toBe(true);
    expect(byRound.droppedKeys).toEqual([]);

    const byWeek = mergeTrendGrid(slots, buckets, {
      keyOf: (b) => mondayOf(b.roundDate), // 잘못된 키
    });
    expect(byWeek.cells.every((c) => c.gapReason === "no-value")).toBe(true);
    expect(byWeek.droppedKeys).toHaveLength(slots.length);
  });
});

// ── ②' 앵커 표에 행이 없는 회차 (미러 실측이 잡은 결함 2) ──────────────────
//
// 실측: website 자리에 `2026-07-20`(월) · `08-17`(월) · `08-18`(화) · `08-19`(수)가
// 섞였다. 전부 servable 0 이고, 앵커 표에 행이 없어 폴백이 앵커 요일로 자리를 만든 것.
// 수리는 두 단이다 — SQL 이 같은 주 정규 요일로 **스냅**하고(07-20 → 07-24,
// 08-17·18·19 → 08-21), 판정이 `assignedCycles === 0` 후보를 **자리로 안 센다**.

describe("앵커 행 없는 회차 — 자리를 오염시키지도 늘리지도 않는다", () => {
  const dow = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay();

  it("스냅해 합류한 회차가 있어도 자리 수·요일이 그대로다", () => {
    // SQL 의 GROUP BY 가 이미 합쳐서 준 모양: 08-21 자리에 앵커 행 없는 35회차 합류.
    const rows = websiteRows().map((r) =>
      r.roundDate === "2026-08-21"
        ? {
            ...r,
            cycleIds: [...r.cycleIds, "c-0817", "c-0818", "c-0819"],
            totalCycles: 97 + 35,
            assignedCycles: 97,
            servableCycles: 94,
          }
        : r,
    );
    const slots = toTrendSlots(rows);
    expect(slots).toHaveLength(FRI.length); // 자리 수가 늘지 않는다
    for (const s of slots) expect(dow(s.roundDate), s.roundDate).toBe(5);
    const merged = slots.find((s) => s.roundDate === "2026-08-21");
    expect(merged?.renderable).toBe(true);
    // 합류한 회차는 `cycleIds` 에만 남는다 — 판정(점/갭)은 서빙 가능 회차가 정한다.
    expect(merged?.cycleIds).toContain("c-0818");
  });

  it("앵커 귀속이 없고 서빙도 불가한 후보는 **자리가 되지 않는다**", () => {
    const rows = [
      ...websiteRows(),
      row({
        roundDate: "2026-07-31", // 스냅 결과가 결번 금요일에 떨어진 경우
        totalCycles: 3,
        assignedCycles: 0,
        servableCycles: 0,
        completionRatio: null,
      }),
    ];
    const slots = toTrendSlots(rows);
    expect(slots.map((s) => s.roundDate)).toEqual([...FRI]);
  });

  // 안전 방향: 앵커 백필이 늦은 **발행** 회차를 떨어뜨리면 점이 조용히 사라진다.
  it("앵커 귀속이 없어도 서빙 가능한 회차가 있으면 남긴다", () => {
    const [s] = toTrendSlots([
      row({ roundDate: "2026-07-31", assignedCycles: 0, servableCycles: 1 }),
    ]);
    expect(s.roundDate).toBe("2026-07-31");
    expect(s.renderable).toBe(true);
  });

  it("글로벌에도 같은 규칙이다 — 월요일 자리만 남고 수가 늘지 않는다", () => {
    const rows = [
      ...globalRows(),
      row({ roundDate: "2026-09-21", assignedCycles: 0, servableCycles: 0, completionRatio: null }),
    ];
    const slots = toTrendSlots(rows);
    expect(slots).toHaveLength(15);
    for (const s of slots) expect(dow(s.roundDate), s.roundDate).toBe(1);
  });
});

// ── ② 점 / 갭 / 미표시 판정 ─────────────────────────────────────────────────

describe("toTrendSlots — 자리와 갭 사유", () => {
  it("글로벌 15자리 중 셋이 미발행 갭이다", () => {
    const slots = toTrendSlots(globalRows());
    expect(slots).toHaveLength(15);
    expect(slots.filter((s) => !s.renderable).map((s) => s.roundDate)).toEqual([
      "2026-07-13", "2026-07-20", "2026-07-27",
    ]);
    expect(slots.find((s) => s.roundDate === "2026-07-13")?.gapReason).toBe("not-published");
    expect(slots.find((s) => s.roundDate === "2026-07-13")?.cycleIds).toEqual([
      "c-2026-07-13-a", "c-2026-07-13-b",
    ]);
  });

  it("수집 오류로 숨긴 회차만 있는 자리는 `hidden-collection-error` 갭이다", () => {
    const [s] = toTrendSlots([
      row({ roundDate: "2026-08-31", servableCycles: 0, collectionErrorCycles: 1, completionRatio: null }),
    ]);
    expect(s.renderable).toBe(false);
    expect(s.gapReason).toBe("hidden-collection-error");
  });

  // 현 `trend-gaps.ts` 규칙을 그대로 옮긴 것: 운영 판단으로 내린 회차를 수집 오류
  // 음영으로 덮으면 고객에게 사실이 아닌 원인을 말하게 된다.
  it("운영 숨김뿐인 자리는 **자리가 되지 않는다**", () => {
    expect(
      toTrendSlots([
        row({ roundDate: "2026-08-31", servableCycles: 0, operatorCycles: 1, completionRatio: null }),
      ]),
    ).toEqual([]);
  });

  it("운영 숨김과 다른 회차가 섞인 자리는 남는다", () => {
    const [s] = toTrendSlots([
      row({
        roundDate: "2026-08-31",
        totalCycles: 2,
        servableCycles: 0,
        operatorCycles: 1,
        completionRatio: null,
      }),
    ]);
    expect(s.gapReason).toBe("not-published");
  });

  // 08-24 자리: 인용 숨김 회차 1 + 정상 회차 1. 서빙 가능한 회차가 있으므로 **점**이다.
  // (인용 계열 음영은 이 모듈이 아니라 `trend-gaps.ts` 의 ② 마커 패스가 쥔다.)
  it("한 자리에 숨김 회차와 정상 회차가 섞이면 점이다", () => {
    const [s] = toTrendSlots([
      row({
        roundDate: "2026-08-24",
        cycleIds: ["c-0818", "c-0825"],
        totalCycles: 2,
        servableCycles: 1,
        collectionErrorCycles: 1,
      }),
    ]);
    expect(s.renderable).toBe(true);
    expect(s.gapReason).toBeNull();
  });
});

// ── ③ 자리 개수 창 ──────────────────────────────────────────────────────────

describe("takeLatestSlots — 창은 날짜가 아니라 자리 개수다", () => {
  it("상수는 13이고 안전 상한은 180일이다", () => {
    expect(TREND_GRID_SLOTS).toBe(13);
    expect(TREND_GRID_MAX_DAYS).toBe(180);
    // 13자리 × 7일 = 91일 — 안전 상한이 정상 케이던스를 자르지 않는다.
    expect(TREND_GRID_MAX_DAYS).toBeGreaterThan(TREND_GRID_SLOTS * 7);
  });

  it("15자리 → 최신 13자리(06-22 ~ 09-14), 오름차순 유지", () => {
    const kept = takeLatestSlots(toTrendSlots(globalRows()));
    expect(kept).toHaveLength(13);
    expect(kept[0].roundDate).toBe("2026-06-22");
    expect(kept[12].roundDate).toBe("2026-09-14");
    expect(kept.map((s) => s.roundDate)).toEqual([...MON].slice(2));
  });

  it("자리가 창보다 적으면 전부 남는다 (website 11자리)", () => {
    expect(takeLatestSlots(toTrendSlots(websiteRows()))).toHaveLength(11);
  });

  it("n <= 0 은 빈 창이다 — 무제한이 아니다", () => {
    expect(takeLatestSlots(toTrendSlots(globalRows()), 0)).toEqual([]);
  });
});

// ── ④ 병합 ──────────────────────────────────────────────────────────────────

interface Bucket {
  roundDate: string;
  answers: number;
}
const keyOf = (b: Bucket): string => b.roundDate;

describe("mergeTrendGrid — 자리가 격자를 정한다", () => {
  const slots = takeLatestSlots(toTrendSlots(globalRows()));

  it("자리 ∧ 값 → 점 / 자리 ∧ 값 없음 → 갭", () => {
    // 미발행 셋을 뺀 10자리에만 값이 있다.
    const buckets: Bucket[] = slots
      .filter((s) => s.renderable)
      .map((s, i) => ({ roundDate: s.roundDate, answers: 100 + i }));
    const { cells, droppedKeys } = mergeTrendGrid(slots, buckets, { keyOf });

    expect(cells).toHaveLength(13);
    expect(droppedKeys).toEqual([]);
    expect(cells.filter((c) => c.value !== null)).toHaveLength(10);
    const gaps = cells.filter((c) => c.gapReason !== null);
    expect(gaps.map((c) => c.roundDate)).toEqual(["2026-07-13", "2026-07-20", "2026-07-27"]);
    for (const g of gaps) expect(g.gapReason).toBe("not-published");
    // 점과 갭은 동시에 차지 않는다.
    for (const c of cells) expect(c.value === null).toBe(c.gapReason !== null);
  });

  it("서빙 가능한 자리인데 집계층에 값이 없으면 `no-value` 다", () => {
    const { cells } = mergeTrendGrid(slots, [{ roundDate: "2026-09-14", answers: 1 }], { keyOf });
    const c = cells.find((x) => x.roundDate === "2026-08-31");
    expect(c?.gapReason).toBe("no-value");
    expect(cells.find((x) => x.roundDate === "2026-09-14")?.gapReason).toBeNull();
  });

  // ③ 규칙 — 원장에 자리가 없으면 아무것도 그리지 않는다.
  it("자리가 없는 키의 값은 버려지고 `droppedKeys` 로 보고된다", () => {
    const { cells, droppedKeys } = mergeTrendGrid(
      slots,
      [
        { roundDate: "2026-09-14", answers: 1 },
        { roundDate: "2026-09-21", answers: 2 }, // 창 밖(원장에 아직 없는 자리)
        { roundDate: "2026-06-08", answers: 3 }, // 창보다 이른 자리
      ],
      { keyOf },
    );
    expect(cells.map((c) => c.roundDate)).not.toContain("2026-09-21");
    expect(droppedKeys).toEqual(["2026-06-08", "2026-09-21"]);
  });

  it("완결성 하한을 주면 미달 자리는 `not-published` 갭이다", () => {
    const low = toTrendSlots([row({ roundDate: "2026-09-14", completionRatio: 0.3 })]);
    const buckets = [{ roundDate: "2026-09-14", answers: 9 }];
    expect(mergeTrendGrid(low, buckets, { keyOf }).cells[0].gapReason).toBeNull();
    expect(
      mergeTrendGrid(low, buckets, { keyOf, completionFloor: 0.5 }).cells[0].gapReason,
    ).toBe("not-published");
    // 하한을 안 주면 판정 자체를 안 한다(임계는 PR①의 결정).
    expect(mergeTrendGrid(low, buckets, { keyOf }).cells[0].value).toEqual(buckets[0]);
  });
});

// ── ⑤ 기존 갭 채우기와의 관계 — website 07-31 이 사라진다 ───────────────────

describe("website 07-31 — 격자 on 에서 자리가 사라진다", () => {
  // 지금(`fillGaps`)은 금요일 격자를 기계적으로 메워 07-31 에 **빈 슬롯**을 만든다.
  // 원장에는 그 자리가 없으므로 격자 on 에서는 자리 자체가 없어야 한다(③).
  it("자리 목록에 07-31 이 없다", () => {
    const slots = toTrendSlots(websiteRows());
    expect(slots.map((s) => s.roundDate)).not.toContain("2026-07-31");
    expect(slots.map((s) => s.roundDate)).toEqual([...FRI]);
  });

  it("기존 채움이 만들던 07-31 빈 슬롯은 격자 병합에서 버려진다", () => {
    const slots = toTrendSlots(websiteRows());
    // `fillGaps` 가 만들던 모양 — 값이 전부 0 인 빈 버킷.
    const withFilled: Bucket[] = [
      { roundDate: "2026-07-24", answers: 10 },
      { roundDate: "2026-07-31", answers: 0 },
      { roundDate: "2026-08-07", answers: 20 },
    ];
    const { cells, droppedKeys } = mergeTrendGrid(slots, withFilled, { keyOf });
    expect(droppedKeys).toEqual(["2026-07-31"]);
    expect(cells.map((c) => c.roundDate)).not.toContain("2026-07-31");
    // 07-24 와 08-07 은 그대로 점이다(자리가 사라져도 이웃 값이 안 흔들린다).
    expect(cells.find((c) => c.roundDate === "2026-07-24")?.value?.answers).toBe(10);
    expect(cells.find((c) => c.roundDate === "2026-08-07")?.value?.answers).toBe(20);
  });
});

// ── ⑥ 어댑터 — 키 off 무변경 ────────────────────────────────────────────────

describe("어댑터 — 격자가 없으면 아무것도 바꾸지 않는다", () => {
  it("`trendGridDateFloor` 는 첫 자리의 날짜다", () => {
    expect(trendGridDateFloor(takeLatestSlots(toTrendSlots(globalRows())))).toBe("2026-06-22");
    expect(trendGridDateFloor([])).toBeNull();
    expect(trendGridDateFloor(null)).toBeNull();
  });

  it("`withTrendGridWindow` 는 격자가 null 이면 **입력 객체를 그대로** 돌려준다", () => {
    const f = { dateFrom: "2026-06-21", dateTo: "2026-09-20" };
    expect(withTrendGridWindow(f, null)).toBe(f);
    expect(withTrendGridWindow(f, [])).toBe(f);
  });

  it("격자가 있으면 바닥만 자리 날짜로 바꾼다 (상계·나머지 필드는 그대로)", () => {
    const f = { dateFrom: "2026-06-21", dateTo: "2026-09-20", country: "KR" };
    const out = withTrendGridWindow(f, takeLatestSlots(toTrendSlots(globalRows())));
    expect(out).toEqual({ dateFrom: "2026-06-22", dateTo: "2026-09-20", country: "KR" });
  });

  it("바닥이 이미 같으면 입력 객체를 그대로 돌려준다 (캐시 키가 이유 없이 안 갈리게)", () => {
    const slots: TrendSlot[] = takeLatestSlots(toTrendSlots(globalRows()));
    const f = { dateFrom: "2026-06-22" };
    expect(withTrendGridWindow(f, slots)).toBe(f);
  });
});
