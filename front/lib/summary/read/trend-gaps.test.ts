// 카드 ①~⑤ 시계열의 갭 버킷 생산(0070) — 두 축(집계층 회차 / 미러 주 격자)을 고정한다.
//
// 축을 잘못 고르면 **조용히 아무 일도 안 일어난다**(슬롯 키가 축에 없어 그냥 안 들어간다).
// 8/25 앵커 회차는 anchor 일과 cycle_week 가 다르므로 그 실수를 여기서 잡는다.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StandardTrendBucket } from "@/lib/db/repositories/scope-aggregates";

const hiddenCycleSlots = vi.fn();
vi.mock("@/lib/db/repositories/summary-cycles", () => ({
  hiddenCycleSlots: (...a: unknown[]) => hiddenCycleSlots(...a),
}));
// `react.cache` 는 요청 스코프 밖(테스트)에서 그대로 통과시킨다.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, cache: <T,>(fn: T) => fn };
});

const bucket = (bucketStart: string, over: Partial<StandardTrendBucket> = {}): StandardTrendBucket => ({
  bucketStart,
  answers: 100,
  trackedAnswers: 60,
  totalMentions: 200,
  trackedMentions: 80,
  sentMentions: 50,
  positiveMentions: 30,
  avgPosition: 2,
  totalCitations: 500,
  ownedCitations: 100,
  measuredDays: 1,
  firstAt: `${bucketStart}T00:00:00.000Z`,
  lastAt: `${bucketStart}T00:00:00.000Z`,
  ...over,
});

const ROOT = "11111111-1111-1111-1111-111111111111";
const SLOT = {
  cycleId: "1045851c-e47d-4977-bda1-550c56d74705",
  projectId: ROOT,
  cycleWeek: "2026-08-24",
  anchorDay: "2026-08-25",
  reason: "collection_error",
  // 0071 — 원장이 NULL 이거나 0071 미적용이면 리더가 "all" 로 접어 준다(종전 동작).
  scope: "all" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  hiddenCycleSlots.mockResolvedValue([SLOT]);
});

describe("withTrendGapBuckets", () => {
  it("미러 주 격자 — 키는 cycle_week(월요일)다", async () => {
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [bucket("2026-08-17"), bucket("2026-08-31")],
      "week",
      "global",
      [ROOT],
    );
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-08-17", "2026-08-24", "2026-08-31"]);
    const gap = out[1];
    expect(gap.gap).toEqual({ reason: "collection_error" });
    // 계약 — 측정값 필드가 전부 0/null 이다(화면이 값 대신 음영을 그린다).
    expect(gap.answers).toBe(0);
    expect(gap.trackedAnswers).toBe(0);
    expect(gap.totalCitations).toBe(0);
    expect(gap.avgPosition).toBeNull();
    expect(gap.measuredDays).toBe(0);
    expect(gap.firstAt).toBeNull();
    expect(gap.lastAt).toBeNull();
    // 미러 축이므로 회차 표시자를 만들지 않는다(만들면 화면이 회차 축으로 오인한다).
    expect(gap.cycleAnchorAt).toBeUndefined();
  });

  it("집계층 회차 축 — 키는 anchor 일이고 cycleAnchorAt 도 채운다", async () => {
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [
        bucket("2026-08-18", { cycleAnchorAt: "2026-08-18T01:00:00.000Z" }),
        bucket("2026-09-01", { cycleAnchorAt: "2026-09-01T01:00:00.000Z" }),
      ],
      "week",
      "global",
      [ROOT],
    );
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-08-18", "2026-08-25", "2026-09-01"]);
    // 회차 축에서는 anchor 일(8/25)이 키다 — 주(8/24)를 쓰면 이 기대가 깨진다.
    expect(out[1].gap).toBeDefined();
    // `isCycleBucketed` 의 every 가 깨지지 않아야 한다 — 깨지면 화면이 주 격자 채우기로 되돌아간다.
    expect(out.every((b) => !!b.cycleAnchorAt)).toBe(true);
  });

  it("`day` 격자에는 넣지 않는다 — 월요일 키가 없는 날을 만든다", async () => {
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const input = [bucket("2026-08-18"), bucket("2026-09-01")];
    expect(await withTrendGapBuckets(input, "day", "global", [ROOT])).toBe(input);
  });

  it("`operator` 숨김은 갭 슬롯을 만들지 않는다 — 문구가 사실이 아니다", async () => {
    hiddenCycleSlots.mockResolvedValue([{ ...SLOT, reason: "operator" }]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const input = [bucket("2026-08-17"), bucket("2026-08-31")];
    expect(await withTrendGapBuckets(input, "week", "global", [ROOT])).toBe(input);
  });

  it("숨긴 회차가 없으면 **참조 동일** = 무변경", async () => {
    hiddenCycleSlots.mockResolvedValue([]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const input = [bucket("2026-08-17"), bucket("2026-08-31")];
    expect(await withTrendGapBuckets(input, "week", "global", [ROOT])).toBe(input);
  });

  it("그 주에 측정이 남아 있으면 안 넣는다 — 값이 있는 슬롯을 갭이라 하지 않는다", async () => {
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const input = [bucket("2026-08-17"), bucket("2026-08-24"), bucket("2026-08-31")];
    expect(await withTrendGapBuckets(input, "week", "global", [ROOT])).toBe(input);
  });

  it("프로젝트가 없으면 원장을 읽지도 않는다", async () => {
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const input = [bucket("2026-08-17"), bucket("2026-08-31")];
    expect(await withTrendGapBuckets(input, "week", null, [])).toBe(input);
    expect(hiddenCycleSlots).not.toHaveBeenCalled();
  });
});

describe("trendGapWeekKeys / weeklyGapWeeks", () => {
  it("week 축이면 cycle_week 목록, 그 밖이면 undefined", async () => {
    const { trendGapWeekKeys } = await import("./trend-gaps");
    expect(await trendGapWeekKeys("week", "global", [ROOT], "mention")).toEqual(["2026-08-24"]);
    expect(await trendGapWeekKeys("day", "global", [ROOT], "mention")).toBeUndefined();
  });

  it("숨긴 회차가 없으면 undefined — 결과 객체를 헛되이 복사하지 않게", async () => {
    hiddenCycleSlots.mockResolvedValue([]);
    const { trendGapWeekKeys, weeklyGapWeeks } = await import("./trend-gaps");
    expect(await trendGapWeekKeys("week", "global", [ROOT], "mention")).toBeUndefined();
    expect(await weeklyGapWeeks("global", [ROOT], "mention")).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 숨김 **범위**(0071) — 계열별 갭 키 · 혼합 버킷 마킹 (스펙 §5-D · §5-E)
// ════════════════════════════════════════════════════════════════════════════
//
// 8/25 회차는 인용만 깨졌다. 그러니 갭도 인용 계열에만 있어야 한다 — 언급 화면에
// 음영이 남으면 **값은 살아났는데 "수집되지 않음" 이라고 말하는** 화면이 된다.
const CIT_SLOT = { ...SLOT, scope: "citations" as const };

describe("계열별 갭 키 (D)", () => {
  it("D1/D2 — 언급 계열은 빈 목록, 인용 계열은 8/24 를 낸다", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { weeklyGapWeeks } = await import("./trend-gaps");
    expect(await weeklyGapWeeks("global", [ROOT], "mention")).toEqual([]);
    expect(await weeklyGapWeeks("global", [ROOT], "citation")).toEqual(["2026-08-24"]);
  });

  it("D3 — 4-KPI 탭(언급)의 gapBuckets 는 undefined 가 된다", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { trendGapWeekKeys } = await import("./trend-gaps");
    expect(await trendGapWeekKeys("week", "global", [ROOT], "mention")).toBeUndefined();
    expect(await trendGapWeekKeys("week", "global", [ROOT], "citation")).toEqual(["2026-08-24"]);
  });

  it("범위가 all 이면 두 계열 다 갭이다 — 0071 이전과 동일", async () => {
    hiddenCycleSlots.mockResolvedValue([SLOT]);
    const { weeklyGapWeeks } = await import("./trend-gaps");
    expect(await weeklyGapWeeks("global", [ROOT], "mention")).toEqual(["2026-08-24"]);
    expect(await weeklyGapWeeks("global", [ROOT], "citation")).toEqual(["2026-08-24"]);
  });

  it("같은 키에 all·citations 가 겹치면 **넓은 쪽이 이긴다**(함대 표면)", async () => {
    hiddenCycleSlots.mockResolvedValue([
      { ...CIT_SLOT, cycleId: "a", projectId: ROOT },
      { ...SLOT, cycleId: "b", projectId: ROOT },
    ]);
    const { weeklyGapWeeks } = await import("./trend-gaps");
    // 한 사이트는 전체가 깨졌으므로 그 주는 언급 계열에서도 구멍이다.
    expect(await weeklyGapWeeks("global", [ROOT], "mention")).toEqual(["2026-08-24"]);
  });

  it("`operator` 는 범위와 무관하게 갭이 아니다 — 문구가 사실이 아니다", async () => {
    hiddenCycleSlots.mockResolvedValue([{ ...CIT_SLOT, reason: "operator" }]);
    const { weeklyGapWeeks } = await import("./trend-gaps");
    expect(await weeklyGapWeeks("global", [ROOT], "citation")).toEqual([]);
  });
});

describe("혼합 버킷 — 오버뷰 5 KPI (E)", () => {
  it("E1 — 언급 값이 살아난 8/24 버킷에 scope:citations 마커만 얹는다", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const revived = bucket("2026-08-24", { totalCitations: 0, ownedCitations: 0 });
    const out = await withTrendGapBuckets(
      [bucket("2026-08-17"), revived, bucket("2026-08-31")],
      "week",
      "global",
      [ROOT],
    );
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-08-17", "2026-08-24", "2026-08-31"]);
    const marked = out[1];
    expect(marked.gap).toEqual({ reason: "collection_error", scope: "citations" });
    // 값은 **그대로**다 — 마커만 얹었지 지우지 않았다(그것이 이 유닛의 목적이다).
    expect(marked.answers).toBe(revived.answers);
    expect(marked.totalMentions).toBe(revived.totalMentions);
    expect(marked.avgPosition).toBe(revived.avgPosition);
    // 이웃은 손대지 않는다(참조까지 동일).
    expect(out[0]).toBe(out[0]);
    expect(out[0].gap).toBeUndefined();
    expect(out[2].gap).toBeUndefined();
  });

  it("E2 — 슬롯이 없으면 삽입하고, 그 슬롯도 범위를 싣는다 (D-4 A)", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [
        bucket("2026-08-18", { cycleAnchorAt: "2026-08-18T01:00:00.000Z" }),
        bucket("2026-09-01", { cycleAnchorAt: "2026-09-01T01:00:00.000Z" }),
      ],
      "week",
      "global",
      [ROOT],
    );
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-08-18", "2026-08-25", "2026-09-01"]);
    const gap = out[1];
    expect(gap.gap).toEqual({ reason: "collection_error", scope: "citations" });
    // 값 필드는 전부 0/null — 계약은 범위와 무관하다.
    expect(gap.answers).toBe(0);
    expect(gap.totalMentions).toBe(0);
    expect(gap.totalCitations).toBe(0);
    expect(gap.avgPosition).toBeNull();
    expect(gap.cycleAnchorAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("E3 — 인용 값이 남아 있으면 마커를 **안 붙인다**(0070 규칙 ②)", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    // bucket() 기본값 totalCitations = 500 → 그 주는 구멍이 아니다.
    const input = [bucket("2026-08-17"), bucket("2026-08-24"), bucket("2026-08-31")];
    expect(await withTrendGapBuckets(input, "week", "global", [ROOT])).toBe(input);
  });

  it("축 끝(첫/마지막)의 인용 갭은 마킹하지 않는다 — 축을 넓히지 않는 규칙 ①", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const input = [
      bucket("2026-08-24", { totalCitations: 0 }),
      bucket("2026-08-31"),
    ];
    expect(await withTrendGapBuckets(input, "week", "global", [ROOT])).toBe(input);
  });

  it("범위가 all 이면 종전대로 **삽입**된다 — 값 있는 버킷은 건드리지 않는다", async () => {
    hiddenCycleSlots.mockResolvedValue([SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [bucket("2026-08-17"), bucket("2026-08-31")],
      "week",
      "global",
      [ROOT],
    );
    expect(out[1].gap).toEqual({ reason: "collection_error" });
    expect(out[1].gap).not.toHaveProperty("scope");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 회차 축의 인용 갭은 **값이 남아 있어도 갭이다** (D2 §3-A2)
// ════════════════════════════════════════════════════════════════════════════
//
// 8/25 회차를 사실표로 생성하면 그 버킷의 `totalCitations` 가 0 이 아니게 된다(인용률
// 3.8% 로 깨진 채 굳은 값이다). 위 E3 규칙(`totalCitations > 0` 이면 마킹 안 함)을 회차
// 축에도 그대로 적용하면 **마커가 빠지고**, 그러면 `dashboard/_data/live.ts:600` 의
// `if (!citationGap && b.totalCitations > 0)` 가드가 함께 풀려 그 3.8% 가 인용 점유율
// 카드에 찍힌다. 에러가 없어 조용한 회귀다 — 여기서 잡는다.
//
// 규칙이 축마다 다른 이유: 미러 주 격자는 한 주 키에 숨김 회차 **밖의** run 이 섞일 수
// 있어 "값이 남은 슬롯은 구멍이 아니다"(0070 규칙 ②)가 옳지만, 회차 축의 키는 그 회차
// **하나**를 정확히 가리키므로 섞임이 없다.
describe("회차 축 인용 갭 (D2 A2)", () => {
  const cyc = (day: string, over: Partial<StandardTrendBucket> = {}) =>
    bucket(day, { cycleAnchorAt: `${day}T01:00:00.000Z`, ...over });

  it("사실표 값이 실린 8/25 버킷도 마커가 붙고 인용 필드가 0 으로 비워진다", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const generated = cyc("2026-08-25", { totalCitations: 4000, ownedCitations: 150 });
    const out = await withTrendGapBuckets(
      [cyc("2026-08-18"), generated, cyc("2026-09-01")],
      "week",
      "global",
      [ROOT],
    );
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-08-18", "2026-08-25", "2026-09-01"]);
    const marked = out[1];
    expect(marked.gap).toEqual({ reason: "collection_error", scope: "citations" });
    // 계약 — 갭 슬롯의 인용 값은 0 이다(마커를 안 보는 소비자가 생겨도 안 샌다).
    expect(marked.totalCitations).toBe(0);
    expect(marked.ownedCitations).toBe(0);
  });

  it("언급 필드·회차 표시자·모수는 **그대로**다 — 그것이 이 작업의 산출물이다", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const generated = cyc("2026-08-25", { totalCitations: 4000, ownedCitations: 150 });
    const out = await withTrendGapBuckets(
      [cyc("2026-08-18"), generated, cyc("2026-09-01")],
      "week",
      "global",
      [ROOT],
    );
    const marked = out[1];
    // 마커가 없으면 아래 "값이 그대로다" 는 참이지만 화면은 틀린다 — 함께 본다.
    expect(marked.gap).toEqual({ reason: "collection_error", scope: "citations" });
    expect(marked.answers).toBe(generated.answers);
    expect(marked.trackedAnswers).toBe(generated.trackedAnswers);
    expect(marked.totalMentions).toBe(generated.totalMentions);
    expect(marked.trackedMentions).toBe(generated.trackedMentions);
    expect(marked.sentMentions).toBe(generated.sentMentions);
    expect(marked.positiveMentions).toBe(generated.positiveMentions);
    expect(marked.avgPosition).toBe(generated.avgPosition);
    expect(marked.measuredDays).toBe(generated.measuredDays);
    expect(marked.firstAt).toBe(generated.firstAt);
    expect(marked.lastAt).toBe(generated.lastAt);
    // `isCycleBucketed` 의 every 가 깨지면 화면이 주 격자 채우기로 되돌아간다.
    expect(marked.cycleAnchorAt).toBe(generated.cycleAnchorAt);
    expect(out.every((b) => !!b.cycleAnchorAt)).toBe(true);
    // 이웃은 무변경.
    expect(out[0].gap).toBeUndefined();
    expect(out[2].gap).toBeUndefined();
  });

  // ── 검증자 지적(2026-09-11): 축 **끝점**이 차단 결함이었다 ─────────────────
  //
  // ②가 `trendGapKeysToMark` 의 엄격 내부 제한(`key > first && key < last`)을 타면
  // 8/25 가 첫 점·끝 점일 때 마커가 빠지고 인용 필드 비우기도 안 돌아 3.8% 가 샌다.
  // 도달 경로: 기간 필터 `dateFrom ∈ (8/20, 8/25]`(첫 점) · `dateTo = 8/26`(끝 점) ·
  // **월간 프리셋(today−29)은 2026-09-19 부터 자동**. `G_TREND_MIN_CYCLES=2` 는 회차 수
  // 하한이라 못 막는다. ②는 있는 슬롯에 마커만 얹으므로 축이 안 넓어진다 = 제한이 불필요하다.
  it("8/25 가 회차 축의 **첫 점**이어도 마커가 붙고 인용 필드가 0 이 된다", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const generated = cyc("2026-08-25", { totalCitations: 4000, ownedCitations: 150 });
    const out = await withTrendGapBuckets(
      [generated, cyc("2026-09-01"), cyc("2026-09-08")],
      "week",
      "global",
      [ROOT],
    );
    const marked = out[0];
    expect(marked.bucketStart).toBe("2026-08-25");
    expect(marked.gap).toEqual({ reason: "collection_error", scope: "citations" });
    expect(marked.totalCitations).toBe(0);
    expect(marked.ownedCitations).toBe(0);
    // 언급 계열은 이 회차의 산출물이라 그대로다.
    expect(marked.answers).toBe(generated.answers);
    expect(marked.totalMentions).toBe(generated.totalMentions);
    expect(marked.avgPosition).toBe(generated.avgPosition);
    expect(marked.cycleAnchorAt).toBe(generated.cycleAnchorAt);
    // 이웃은 무변경.
    expect(out[1].gap).toBeUndefined();
    expect(out[2].gap).toBeUndefined();
  });

  it("8/25 가 회차 축의 **끝 점**이어도 마커가 붙고 인용 필드가 0 이 된다 (Δ 칩 오염 경로)", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const generated = cyc("2026-08-25", { totalCitations: 4000, ownedCitations: 150 });
    const out = await withTrendGapBuckets(
      [cyc("2026-08-11"), cyc("2026-08-18"), generated],
      "week",
      "global",
      [ROOT],
    );
    const marked = out[2];
    expect(marked.bucketStart).toBe("2026-08-25");
    expect(marked.gap).toEqual({ reason: "collection_error", scope: "citations" });
    expect(marked.totalCitations).toBe(0);
    expect(marked.ownedCitations).toBe(0);
    expect(marked.answers).toBe(generated.answers);
    expect(marked.totalMentions).toBe(generated.totalMentions);
    expect(marked.cycleAnchorAt).toBe(generated.cycleAnchorAt);
    expect(out[0].gap).toBeUndefined();
    expect(out[1].gap).toBeUndefined();
  });

  it("같은 값이 **미러 주 격자**로 오면 마킹하지 않는다 — 0070 규칙 ② 유지", async () => {
    hiddenCycleSlots.mockResolvedValue([CIT_SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    // cycleAnchorAt 이 없으면 주 격자다. 키도 주(8/24)로 바뀐다.
    const input = [
      bucket("2026-08-17"),
      bucket("2026-08-24", { totalCitations: 4000, ownedCitations: 150 }),
      bucket("2026-08-31"),
    ];
    expect(await withTrendGapBuckets(input, "week", "global", [ROOT])).toBe(input);
  });

  it("범위가 all 인 회차는 회차 축에서도 종전대로 **삽입**된다(마킹 경로가 아니다)", async () => {
    hiddenCycleSlots.mockResolvedValue([SLOT]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [cyc("2026-08-18"), cyc("2026-09-01")],
      "week",
      "global",
      [ROOT],
    );
    expect(out[1].bucketStart).toBe("2026-08-25");
    expect(out[1].gap).toEqual({ reason: "collection_error" });
    expect(out[1].totalCitations).toBe(0);
  });
});

// ── 갭 슬롯 라벨 원천(2026-09-28) — 합성 앵커 대신 숨긴 회차의 실앵커 ─────────
//
// 키(`anchorDay`)는 실앵커의 UTC 일이다. 합성 `${key}T00:00Z` 를 `cycleAnchorAt` 에 넣으면
// 15:00Z 이후 앵커(운영 앵커는 매번 15:4xZ)의 슬롯 라벨이 KST 규칙보다 하루 이르다.
describe("갭 슬롯 cycleAnchorAt = 숨긴 회차 실앵커 — 키·값 불변", () => {
  const cycAt = (day: string, anchor: string) => bucket(day, {
    cycleAnchorAt: anchor, firstAt: anchor, lastAt: anchor,
  });
  const HIDDEN_0913 = {
    ...SLOT,
    cycleWeek: "2026-09-07",
    anchorDay: "2026-09-13",
    anchorAt: "2026-09-13T15:48:44.000Z",
  };

  it("재현: 이웃 9/06T15:48Z·9/20T15:50Z 사이 숨긴 9/13T15:48Z → 라벨 [09-07, 09-14, 09-21]", async () => {
    hiddenCycleSlots.mockResolvedValue([HIDDEN_0913]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [cycAt("2026-09-06", "2026-09-06T15:48:00.000Z"), cycAt("2026-09-20", "2026-09-20T15:50:51.000Z")],
      "week", "global", [ROOT],
    );
    // 키 불변 — 슬롯 키는 여전히 실앵커의 UTC 일.
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-09-06", "2026-09-13", "2026-09-20"]);
    expect(out[1].cycleAnchorAt).toBe("2026-09-13T15:48:44.000Z");
    // 값 불변 — 갭 계약(측정값 전부 0/null)과 마커 그대로.
    expect(out[1]).toMatchObject({
      gap: { reason: "collection_error" }, answers: 0, totalCitations: 0, avgPosition: null,
      measuredDays: 0, firstAt: null, lastAt: null,
    });
    // 라벨 원천 = 실앵커(KST 9/14) — 합성 ${key}T00:00Z 가 아니다.
    expect(out.map((b) => b.cycleAnchorAt)).toEqual([
      "2026-09-06T15:48:00.000Z",
      "2026-09-13T15:48:44.000Z",
      "2026-09-20T15:50:51.000Z",
    ]);
  });

  it("같은 KST 날 충돌 — 가짜 09:00 이 아니라 실시각을 싣는다", async () => {
    hiddenCycleSlots.mockResolvedValue([HIDDEN_0913]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [cycAt("2026-09-06", "2026-09-06T15:48:00.000Z"), cycAt("2026-09-14", "2026-09-14T03:00:00.000Z")],
      "week", "global", [ROOT],
    );
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-09-06", "2026-09-13", "2026-09-14"]);
    // 표시(같은 KST 날 충돌 시 시각)는 화면이 이 앵커로 계산한다 — 합성 09:00 이 아니라 실시각.
    expect(out.map((b) => b.cycleAnchorAt)).toEqual([
      "2026-09-06T15:48:00.000Z",
      "2026-09-13T15:48:44.000Z",
      "2026-09-14T03:00:00.000Z",
    ]);
  });

  it("같은 UTC 일에 숨긴 회차가 여럿이면 최소 실앵커(toSeries 대표값과 같은 규칙)", async () => {
    hiddenCycleSlots.mockResolvedValue([
      { ...HIDDEN_0913, projectId: "22222222-2222-2222-2222-222222222222", anchorAt: "2026-09-13T16:10:00.000Z" },
      HIDDEN_0913,
    ]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [cycAt("2026-09-06", "2026-09-06T15:48:00.000Z"), cycAt("2026-09-20", "2026-09-20T15:50:51.000Z")],
      "week", "global", [ROOT],
    );
    expect(out[1].cycleAnchorAt).toBe("2026-09-13T15:48:44.000Z");
  });

  it("실앵커가 없는 슬롯(구 배포·목)은 종전 합성값으로 폴백 — 축 판정 truthy 유지", async () => {
    hiddenCycleSlots.mockResolvedValue([{ ...HIDDEN_0913, anchorAt: undefined }]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [cycAt("2026-09-06", "2026-09-06T15:48:00.000Z"), cycAt("2026-09-20", "2026-09-20T15:50:51.000Z")],
      "week", "global", [ROOT],
    );
    expect(out[1].cycleAnchorAt).toBe("2026-09-13T00:00:00.000Z");
    expect(out.every((b) => !!b.cycleAnchorAt)).toBe(true);
  });

  it("미러 주 격자에는 앵커를 싣지 않는다(종전 그대로)", async () => {
    hiddenCycleSlots.mockResolvedValue([HIDDEN_0913]);
    const { withTrendGapBuckets } = await import("./trend-gaps");
    const out = await withTrendGapBuckets(
      [bucket("2026-08-31"), bucket("2026-09-14")], "week", "global", [ROOT],
    );
    expect(out.map((b) => b.bucketStart)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(out[1].cycleAnchorAt).toBeUndefined();
  });
});
