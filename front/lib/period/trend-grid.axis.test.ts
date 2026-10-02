import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { TrendGridSlotRow } from "@/lib/db/repositories/trend-grid-slots";
import {
  collapseSameWeekSlots,
  isTrendGridApplied,
  trendGridGapMarker,
  trendGridKeyResolver,
  trimTrailingUnpublished,
} from "./trend-grid-axis";
import { isTrendGap } from "@/lib/viz/trend-gap";

// ════════════════════════════════════════════════════════════════════════════
// 격자 자리 집합 — **미러 실측을 손계산 리터럴로** 고정한다
// ════════════════════════════════════════════════════════════════════════════
//
// W0(운영 담당, 미러 읽기 전용)이 낸 자리 목록 그대로다. 이 테스트의 목적은 산식이
// 아니라 **결과 집합**을 박는 것이다 — 자리가 하나 늘거나 줄면 고객이 보는 x축이
// 바뀌므로, 화면을 안 열고도 그 사실이 드러나야 한다.

const MON = [
  "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06",
  "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10",
  "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14",
];
/** 글로벌: 07-13·07-20·07-27 은 회차가 `closed`·미발행이라 서빙 가능 0 이다. */
const GLOBAL_EMPTY = new Set(["2026-07-13", "2026-07-20", "2026-07-27"]);

/** website: 금요일 자리. **07-31 은 결번**이고, 09-18 은 진행 중(서빙 가능 0)이다. */
const FRI = [
  "2026-07-03", "2026-07-10", "2026-07-17", "2026-07-24", "2026-08-07",
  "2026-08-14", "2026-08-21", "2026-08-28", "2026-09-04", "2026-09-11",
  "2026-09-18",
];

/** 금요일 자리의 KST 주 월요일 — 미러 주 격자(`anchor_week`)와 대조할 때 쓰는 값. */
const mondayOf = (friday: string): string => {
  const t = Date.parse(`${friday}T00:00:00Z`);
  return new Date(t - 4 * 86_400_000).toISOString().slice(0, 10);
};

const row = (
  roundDate: string,
  opts: { servable?: number; anchorWeek?: string; collectionError?: number } = {},
): TrendGridSlotRow => ({
  roundDate,
  anchorWeek: opts.anchorWeek ?? roundDate,
  cycleIds: [`c-${roundDate}`],
  totalCycles: 1,
  assignedCycles: 1,
  servableCycles: opts.servable ?? 1,
  collectionErrorCycles: opts.collectionError ?? 0,
  operatorCycles: 0,
  completionRatio: 1,
});

const globalRows = (): TrendGridSlotRow[] =>
  MON.map((d) => row(d, { servable: GLOBAL_EMPTY.has(d) ? 0 : 1 }));

const websiteRows = (): TrendGridSlotRow[] =>
  FRI.map((d) =>
    row(d, { servable: d === "2026-09-18" ? 0 : 1, anchorWeek: mondayOf(d) }),
  );

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

async function loadGrid(rows: TrendGridSlotRow[]) {
  vi.doMock("@/lib/db/repositories/trend-grid-slots", () => ({
    trendGridSlotRows: async () => rows,
  }));
  vi.doMock("./trend-grid-flag", () => ({ ensureTrendGrid: async () => true }));
  return import("./trend-grid");
}

describe("글로벌 자리 집합 (W0 실측)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("06-22 ~ 09-14 월요일 13자리 — 07-13·07-20·07-27 은 갭", async () => {
    const mod = await loadGrid(globalRows());
    const slots = await mod.buildTrendGrid({
      surface: "global",
      projectIds: [ROOT],
      family: "all",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual([
      "2026-06-22", "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20",
      "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24",
      "2026-08-31", "2026-09-07", "2026-09-14",
    ]);
    expect(slots?.filter((s) => s.gapReason !== null).map((s) => s.roundDate)).toEqual([
      "2026-07-13", "2026-07-20", "2026-07-27",
    ]);
    // 창 밖으로 밀린 06-08·06-15 는 **자리 자체가 없다**(그릴 대상이 아니다).
    expect(slots?.some((s) => s.roundDate < "2026-06-22")).toBe(false);
  });

  it("중간의 미발행 자리는 잘리지 않는다 — 그 주가 없었던 것처럼 보이면 안 된다", async () => {
    const mod = await loadGrid(globalRows());
    const slots = await mod.buildTrendGrid({
      surface: "global",
      projectIds: [ROOT],
      family: "all",
    });
    const i = slots?.findIndex((s) => s.roundDate === "2026-07-06") ?? -1;
    expect(slots?.[i + 1].roundDate).toBe("2026-07-13");
    expect(slots?.[i + 1].gapReason).toBe("not-published");
  });
});

describe("website 자리 집합 (W0 실측)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("전부 금요일 · 07-31 결번 · 09-18 은 잘려 마지막이 09-11 이다", async () => {
    const mod = await loadGrid(websiteRows());
    const slots = await mod.buildTrendGrid({
      surface: "website",
      projectIds: [ROOT],
      family: "all",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual([
      "2026-07-03", "2026-07-10", "2026-07-17", "2026-07-24", "2026-08-07",
      "2026-08-14", "2026-08-21", "2026-08-28", "2026-09-04", "2026-09-11",
    ]);
    // 종전 `fillGaps` 는 금요일 격자를 기계적으로 메워 07-31 에 빈 슬롯을 만들었다.
    expect(slots?.some((s) => s.roundDate === "2026-07-31")).toBe(false);
    // 진행 중 회차(서빙 가능 0)는 **갭도 아니다** — 아직 열리지 않은 자리는 결측이 아니다.
    expect(slots?.some((s) => s.roundDate === "2026-09-18")).toBe(false);
    // 전부 금요일(UTC dow 5). 종전 관찰에서 월요일 하나가 섞였던 자리다.
    expect(
      slots?.map((s) => new Date(`${s.roundDate}T00:00:00Z`).getUTCDay()),
    ).toEqual(Array(10).fill(5));
  });

  it("자리 키는 금요일이고 주 월요일은 파생값으로만 실린다", async () => {
    const mod = await loadGrid(websiteRows());
    const slots = await mod.buildTrendGrid({
      surface: "website",
      projectIds: [ROOT],
      family: "all",
    });
    const last = slots?.[slots.length - 1];
    expect(last?.roundDate).toBe("2026-09-11");
    expect(last?.anchorWeek).toBe("2026-09-07");
  });
});

// ── 기간을 좁혔을 때 (메인 추가 규칙 4) ────────────────────────────────────
//
// 창 안에 자리가 하나도 없으면 **빈 추이**다. 13자리로 되돌아가면 사용자가 고른 기간과
// 다른 데이터를 보여 주게 된다 — 값이 사라지는 것보다 나쁘다.
describe("기간 창(from/to)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("창 안의 자리만 남는다", async () => {
    const mod = await loadGrid(globalRows());
    const slots = await mod.buildTrendGrid({
      surface: "global",
      projectIds: [ROOT],
      family: "all",
      from: "2026-08-03",
      to: "2026-08-31",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual([
      "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31",
    ]);
  });

  it("창 안에 자리가 없으면 **빈 배열**이다 — 13자리로 안 되돌아간다", async () => {
    const mod = await loadGrid(globalRows());
    const slots = await mod.buildTrendGrid({
      surface: "global",
      projectIds: [ROOT],
      family: "all",
      from: "2026-10-01",
      to: "2026-10-31",
    });
    // `null`(격자를 못 세웠다)이 **아니다** — 원장이 "이 창에는 없다" 고 답한 것이다.
    expect(slots).toEqual([]);
    expect(slots).not.toBeNull();
  });

  it("창 끝이 진행 중 회차 위에 있으면 그것도 잘린다", async () => {
    const mod = await loadGrid(websiteRows());
    const slots = await mod.buildTrendGrid({
      surface: "website",
      projectIds: [ROOT],
      family: "all",
      from: "2026-09-01",
      to: "2026-09-18",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual(["2026-09-04", "2026-09-11"]);
  });

  it("창이 미발행 자리에서 끝나면 그 자리는 안 그린다", async () => {
    const mod = await loadGrid(globalRows());
    const slots = await mod.buildTrendGrid({
      surface: "global",
      projectIds: [ROOT],
      family: "all",
      from: "2026-07-06",
      to: "2026-07-27",
    });
    // 07-13·07-20·07-27 은 전부 미발행이라 끝에서부터 잘리고 07-06 만 남는다.
    expect(slots?.map((s) => s.roundDate)).toEqual(["2026-07-06"]);
  });
});

describe("trimTrailingUnpublished", () => {
  const s = (roundDate: string, gapReason: "not-published" | "hidden-collection-error" | null) => ({
    roundDate,
    gapReason,
  });

  it("끝의 미발행만 자른다", () => {
    expect(
      trimTrailingUnpublished([s("a", null), s("b", "not-published"), s("c", "not-published")]).map(
        (x) => x.roundDate,
      ),
    ).toEqual(["a"]);
  });

  it("끝의 숨김(수집 오류)은 **남긴다** — 음영으로 보여 주는 것이 기존 정책", () => {
    expect(
      trimTrailingUnpublished([s("a", null), s("b", "hidden-collection-error")]).map(
        (x) => x.roundDate,
      ),
    ).toEqual(["a", "b"]);
  });

  it("숨김 뒤의 미발행은 잘리고 숨김에서 멈춘다", () => {
    expect(
      trimTrailingUnpublished([
        s("a", null),
        s("b", "hidden-collection-error"),
        s("c", "not-published"),
      ]).map((x) => x.roundDate),
    ).toEqual(["a", "b"]);
  });

  it("중간의 미발행은 그대로다", () => {
    expect(
      trimTrailingUnpublished([s("a", null), s("b", "not-published"), s("c", null)]).map(
        (x) => x.roundDate,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("자를 것이 없으면 **입력 배열 그대로**(참조 동일)", () => {
    const input = [s("a", null)];
    expect(trimTrailingUnpublished(input)).toBe(input);
  });

  it("전부 미발행이면 빈 배열", () => {
    expect(trimTrailingUnpublished([s("a", "not-published")])).toEqual([]);
  });
});

describe("trendGridKeyResolver — 경로마다 다른 버킷 키를 같은 자리로", () => {
  const slots = FRI.slice(0, 3).map((d) => ({
    roundDate: d,
    anchorWeek: mondayOf(d),
    gapReason: null,
  }));

  it("귀속 날짜(집계층 키)는 그대로", () => {
    expect(trendGridKeyResolver(slots)("2026-07-10")).toBe("2026-07-10");
  });

  it("주 월요일(미러 키)도 같은 자리를 찾는다", () => {
    expect(trendGridKeyResolver(slots)("2026-07-06")).toBe("2026-07-10");
  });

  it("자리 밖 키는 그대로 돌아온다 — 병합기가 버린다", () => {
    expect(trendGridKeyResolver(slots)("2026-05-01")).toBe("2026-05-01");
  });

  // 검증 N8 — 프로젝트 표면은 정규 요일이 없어 한 주에 자리가 여럿일 수 있다.
  // first-wins 로 두면 **앞 자리가 그 주 값을 통째로 먹고 뒤 자리는 결측**이 된다.
  it("한 주에 자리가 둘이면 그 주의 별칭을 만들지 않는다", () => {
    const proj = [
      { roundDate: "2026-09-15", anchorWeek: "2026-09-14", gapReason: null },
      { roundDate: "2026-09-17", anchorWeek: "2026-09-14", gapReason: null },
    ];
    const keyOf = trendGridKeyResolver(proj);
    // 주 키는 **자기 자신**으로 돌아온다 = 병합기가 버리고 로그에 남는다.
    expect(keyOf("2026-09-14")).toBe("2026-09-14");
    // 자리 키 자체는 그대로 맞는다(버킷이 `roundDate` 를 실어 오는 정상 경로).
    expect(keyOf("2026-09-15")).toBe("2026-09-15");
    expect(keyOf("2026-09-17")).toBe("2026-09-17");
  });

  it("한 주에 자리가 하나면 별칭이 살아 있다", () => {
    const keyOf = trendGridKeyResolver([
      { roundDate: "2026-09-11", anchorWeek: "2026-09-07", gapReason: null },
      { roundDate: "2026-09-18", anchorWeek: "2026-09-14", gapReason: null },
    ]);
    expect(keyOf("2026-09-07")).toBe("2026-09-11");
    expect(keyOf("2026-09-14")).toBe("2026-09-18");
  });

  it("자리 키가 이미 다른 자리의 주 키면 별칭이 덮어쓰지 않는다", () => {
    const keyOf = trendGridKeyResolver([
      { roundDate: "2026-09-07", anchorWeek: "2026-09-07", gapReason: null },
      { roundDate: "2026-09-11", anchorWeek: "2026-09-07", gapReason: null },
    ]);
    expect(keyOf("2026-09-07")).toBe("2026-09-07");
  });

  it("월요일 자리(글로벌)에서는 두 키가 같아 충돌이 없다", () => {
    const g = MON.slice(0, 3).map((d) => ({ roundDate: d, anchorWeek: d, gapReason: null }));
    const keyOf = trendGridKeyResolver(g);
    for (const d of MON.slice(0, 3)) expect(keyOf(d)).toBe(d);
  });
});

describe("격자 사유 → viz 마커", () => {
  // 이 셋이 `isTrendGap` 을 못 지나면 화면이 마커를 통째로 무시한다(음영·보조선 전멸).
  it.each(["hidden-collection-error", "not-published", "no-value"] as const)(
    "%s 는 viz 가 갭으로 읽는다",
    (reason) => {
      expect(isTrendGap(trendGridGapMarker(reason))).toBe(true);
    },
  );

  it("사유마다 다른 마커다 — 나중에 문구가 생기면 여기서 갈린다", () => {
    const reasons = (["hidden-collection-error", "not-published", "no-value"] as const).map(
      (r) => trendGridGapMarker(r).reason,
    );
    expect(new Set(reasons).size).toBe(3);
  });
});

// 검증 B2 — "격자를 얹었나" 는 **데이터 표식**이 답한다. 스위치로 물으면 키가 켜져
// 있으나 격자를 안 얹은 경로(일 버킷 · 자리 null)에서 종전 채움이 통째로 사라진다.
describe("isTrendGridApplied", () => {
  it("전부 표식이 있으면 참", () => {
    expect(isTrendGridApplied([{ gridSlot: true }, { gridSlot: true }])).toBe(true);
  });

  it("하나라도 없으면 거짓 — 두 경로가 섞였으면 종전 채움이 안전하다", () => {
    expect(isTrendGridApplied([{ gridSlot: true }, {}])).toBe(false);
  });

  it("표식이 없으면 거짓(일 버킷·미러 종전 경로)", () => {
    expect(isTrendGridApplied([{}, {}])).toBe(false);
  });

  it("빈 배열은 거짓 — `every` 가 공허참을 내지 않게", () => {
    expect(isTrendGridApplied([])).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 검증 C2 — 프로젝트 표면의 **한 주 세 자리** (미러 실측: anchor_week 09-14 에
// 프로젝트 42개·자리 88개·한 주 최대 3자리)
// ════════════════════════════════════════════════════════════════════════════
//
// 그 지면의 값은 전부 **주 단위**다(주별 Top-N 행 키 = `anchor_week`, 메인 추이 버킷도
// 같고 라벨은 `max(round_date)`). 값 하나가 세 회차의 합이므로, 자리를 셋으로 두면
// 한 자리에 붙여도(오귀속) 안 붙여도(소실) 틀린다. 자리를 값의 그레인에 맞춰 접는다.
describe("collapseSameWeekSlots", () => {
  const s = (
    roundDate: string,
    anchorWeek: string,
    over: Partial<{
      renderable: boolean;
      gapReason: "not-published" | "hidden-collection-error" | null;
      cycleIds: string[];
      completionRatio: number | null;
    }> = {},
  ) => ({
    roundDate,
    anchorWeek,
    renderable: over.renderable ?? true,
    gapReason: over.gapReason ?? null,
    cycleIds: over.cycleIds ?? [`c-${roundDate}`],
    completionRatio: over.completionRatio ?? 1,
  });

  it("한 주 세 자리 → 한 자리. 키는 **서빙 가능한 마지막 귀속 날짜**", () => {
    const out = collapseSameWeekSlots([
      s("2026-09-14", "2026-09-14"),
      s("2026-09-16", "2026-09-14"),
      s("2026-09-17", "2026-09-14"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].roundDate).toBe("2026-09-17");
    expect(out[0].anchorWeek).toBe("2026-09-14");
    // 회차 id 는 **합집합** — 그 자리가 그 주 전체를 대표한다.
    expect(out[0].cycleIds).toEqual(["c-2026-09-14", "c-2026-09-16", "c-2026-09-17"]);
  });

  it("글로벌(월요일)·website(금요일)에서는 무동작 — 한 주에 자리가 하나다", () => {
    const global = [s("2026-09-07", "2026-09-07"), s("2026-09-14", "2026-09-14")];
    expect(collapseSameWeekSlots(global)).toEqual(global);
    const web = [s("2026-09-11", "2026-09-07"), s("2026-09-18", "2026-09-14")];
    expect(collapseSameWeekSlots(web)).toEqual(web);
  });

  it("하나라도 서빙 가능하면 접힌 자리도 서빙 가능하다", () => {
    const out = collapseSameWeekSlots([
      s("2026-09-15", "2026-09-14", { renderable: false, gapReason: "not-published" }),
      s("2026-09-17", "2026-09-14"),
    ]);
    expect(out[0].renderable).toBe(true);
    expect(out[0].gapReason).toBeNull();
  });

  it("전부 서빙 불가면 수집 오류 사유가 이긴다", () => {
    const out = collapseSameWeekSlots([
      s("2026-09-15", "2026-09-14", { renderable: false, gapReason: "not-published" }),
      s("2026-09-17", "2026-09-14", {
        renderable: false,
        gapReason: "hidden-collection-error",
      }),
    ]);
    expect(out[0].renderable).toBe(false);
    expect(out[0].gapReason).toBe("hidden-collection-error");
  });

  it("완결성은 **최대값** — 자리 값이 회차 합이기 때문이다", () => {
    const out = collapseSameWeekSlots([
      s("2026-09-15", "2026-09-14", { completionRatio: 0.5 }),
      s("2026-09-17", "2026-09-14", { completionRatio: 1 }),
    ]);
    expect(out[0].completionRatio).toBe(1);
  });

  it("출력은 자리 키 오름차순이다", () => {
    const out = collapseSameWeekSlots([
      s("2026-09-17", "2026-09-14"),
      s("2026-09-01", "2026-08-31"),
    ]);
    expect(out.map((x) => x.roundDate)).toEqual(["2026-09-01", "2026-09-17"]);
  });

  // **접은 뒤에는 모호한 주가 구조적으로 없다** = N8 의 별칭 포기가 발동하지 않는다.
  // 즉 주 월요일 키로 온 값이 반드시 그 주의 자리를 찾는다(소실 0).
  it("접은 뒤에는 주 별칭이 항상 유일하게 해소된다", () => {
    const collapsed = collapseSameWeekSlots([
      s("2026-09-14", "2026-09-14"),
      s("2026-09-16", "2026-09-14"),
      s("2026-09-17", "2026-09-14"),
      s("2026-09-01", "2026-08-31"),
    ]);
    const keyOf = trendGridKeyResolver(collapsed);
    expect(keyOf("2026-09-14")).toBe("2026-09-17");
    expect(keyOf("2026-08-31")).toBe("2026-09-01");
  });
});

describe("buildTrendGrid — 한 주 세 자리 픽스처 (C2, 데이터 소실 0)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  /** 프로젝트 표면: 09-14 주에 자리 셋, 그 앞 주에 하나. */
  const projectRows = (): TrendGridSlotRow[] => [
    row("2026-09-01", { anchorWeek: "2026-08-31" }),
    row("2026-09-14", { anchorWeek: "2026-09-14" }),
    row("2026-09-16", { anchorWeek: "2026-09-14" }),
    row("2026-09-17", { anchorWeek: "2026-09-14" }),
  ];

  it("자리는 2개이고 09-14 주의 키는 09-17 이다", async () => {
    const mod = await loadGrid(projectRows());
    const slots = await mod.buildTrendGrid({
      surface: "project",
      projectIds: [ROOT],
      family: "all",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual(["2026-09-01", "2026-09-17"]);
  });

  it("주 키로 온 값이 **버려지지 않는다** — 소실 0", async () => {
    const mod = await loadGrid(projectRows());
    const slots = await mod.buildTrendGrid({
      surface: "project",
      projectIds: [ROOT],
      family: "all",
    });
    const keyOf = trendGridKeyResolver(slots ?? []);
    // 미러 주별 Top-N 의 행 키(`ca.anchor_week`) 둘이 각자 자리를 찾는다.
    expect(keyOf("2026-08-31")).toBe("2026-09-01");
    expect(keyOf("2026-09-14")).toBe("2026-09-17");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 검증 C5 — 기간이 **접기보다 먼저**다
// ════════════════════════════════════════════════════════════════════════════
//
// 접힌 키는 그 주의 마지막 자리 날짜다. 접기를 먼저 하면 `to` 가 주 가운데일 때 그 키가
// 범위 밖으로 떨어져 **주 전체가 사라진다**(값까지 버려진다). 기간을 먼저 걸면 접힌 키가
// `max(범위 안 자리)` 가 되어 값 쪽 `round_label`(= `max(기간 안 답변)`)과 같은 방향으로
// 좁혀진다 — 라벨 어긋남 (c) 도 여기서 함께 닫힌다.
describe("기간 → 접기 순서 (C5)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  /** 09-14 주에 자리 셋 + 그 앞 주 하나. */
  const midWeekRows = (): TrendGridSlotRow[] => [
    row("2026-09-07", { anchorWeek: "2026-09-07" }),
    row("2026-09-15", { anchorWeek: "2026-09-14" }),
    row("2026-09-16", { anchorWeek: "2026-09-14" }),
    row("2026-09-17", { anchorWeek: "2026-09-14" }),
  ];

  it("to 가 주 가운데여도 그 주가 남고, 키는 **기간 안 마지막 자리**다", async () => {
    const mod = await loadGrid(midWeekRows());
    const slots = await mod.buildTrendGrid({
      surface: "project",
      projectIds: [ROOT],
      family: "all",
      to: "2026-09-16",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual(["2026-09-07", "2026-09-16"]);
  });

  it("to 가 주 끝이면 키는 그 주 마지막 자리다", async () => {
    const mod = await loadGrid(midWeekRows());
    const slots = await mod.buildTrendGrid({
      surface: "project",
      projectIds: [ROOT],
      family: "all",
      to: "2026-09-17",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual(["2026-09-07", "2026-09-17"]);
  });

  it("from 이 주 가운데면 키는 그 주 마지막이고 앞 자리만 빠진다", async () => {
    const mod = await loadGrid(midWeekRows());
    const slots = await mod.buildTrendGrid({
      surface: "project",
      projectIds: [ROOT],
      family: "all",
      from: "2026-09-16",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual(["2026-09-17"]);
  });

  it("기간이 없으면 종전대로 그 주 마지막 자리로 접힌다", async () => {
    const mod = await loadGrid(midWeekRows());
    const slots = await mod.buildTrendGrid({
      surface: "project",
      projectIds: [ROOT],
      family: "all",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual(["2026-09-07", "2026-09-17"]);
  });

  it("글로벌은 순서가 바뀌어도 무동작이다", async () => {
    const mod = await loadGrid(globalRows());
    const slots = await mod.buildTrendGrid({
      surface: "global",
      projectIds: [ROOT],
      family: "all",
      from: "2026-08-03",
      to: "2026-08-31",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual([
      "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31",
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 검증 D1 — 접힌 키는 **서빙 가능한** 마지막 자리다
// ════════════════════════════════════════════════════════════════════════════
//
// `max(roundDate)` 로 두면 09-15 가 서빙 가능하고 09-17 이 미발행인 주에서 마지막 점이
// **아무것도 발행된 적 없는 09-17** 로 라벨된다(`renderable` 은 `some` 이라 참이어서
// `trimTrailingUnpublished` 도 안 자른다). 불변식: 마지막으로 그려지는 점의 날짜는
// 카드 기준일 규칙(노출 가능한 최신 회차)과 같은 날이어야 한다.
describe("접힌 키는 서빙 가능한 마지막 자리 (D1)", () => {
  const p = (
    roundDate: string,
    renderable: boolean,
    gapReason: "not-published" | "hidden-collection-error" | null = renderable
      ? null
      : "not-published",
  ) => ({
    roundDate,
    anchorWeek: "2026-09-14",
    renderable,
    gapReason,
    cycleIds: [`c-${roundDate}`],
    completionRatio: renderable ? 1 : null,
  });

  it("(1) 서빙 가능 09-15 + 미발행 09-17 → 키는 **09-15**", () => {
    const out = collapseSameWeekSlots([p("2026-09-15", true), p("2026-09-17", false)]);
    expect(out).toHaveLength(1);
    expect(out[0].roundDate).toBe("2026-09-15");
    expect(out[0].renderable).toBe(true);
    expect(out[0].gapReason).toBeNull();
    // 회차 id 는 여전히 합집합 — 그 자리가 그 주 전체를 대표한다.
    expect(out[0].cycleIds).toEqual(["c-2026-09-15", "c-2026-09-17"]);
  });

  it("(2) 셋 다 미발행 → 키는 전체 최대 09-17 이고 갭이다", () => {
    const out = collapseSameWeekSlots([
      p("2026-09-15", false),
      p("2026-09-16", false),
      p("2026-09-17", false),
    ]);
    expect(out[0].roundDate).toBe("2026-09-17");
    expect(out[0].renderable).toBe(false);
    expect(out[0].gapReason).toBe("not-published");
  });

  it("서빙 가능이 둘이면 그중 마지막이다", () => {
    const out = collapseSameWeekSlots([
      p("2026-09-15", true),
      p("2026-09-16", true),
      p("2026-09-17", false),
    ]);
    expect(out[0].roundDate).toBe("2026-09-16");
  });

  it("서빙 불가가 앞에 있어도 서빙 가능한 마지막이 이긴다", () => {
    const out = collapseSameWeekSlots([
      p("2026-09-15", false),
      p("2026-09-17", true),
    ]);
    expect(out[0].roundDate).toBe("2026-09-17");
  });

  it("전부 서빙 불가인데 하나가 수집 오류면 사유가 그것이다", () => {
    const out = collapseSameWeekSlots([
      p("2026-09-15", false, "hidden-collection-error"),
      p("2026-09-17", false),
    ]);
    expect(out[0].roundDate).toBe("2026-09-17");
    expect(out[0].gapReason).toBe("hidden-collection-error");
  });
});

describe("D1 × 끝자리 자르기 · 표면 무동작", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  /** 마지막 주(09-14)에 서빙 가능 09-15 + 미발행 09-17. 그 앞 주 하나. */
  const lastWeekRows = (): TrendGridSlotRow[] => [
    row("2026-09-07", { anchorWeek: "2026-09-07" }),
    row("2026-09-15", { anchorWeek: "2026-09-14" }),
    row("2026-09-17", { anchorWeek: "2026-09-14", servable: 0 }),
  ];

  it("(3) 그 주가 **마지막 주**여도 잘리지 않고 09-15 로 남는다", async () => {
    const mod = await loadGrid(lastWeekRows());
    const slots = await mod.buildTrendGrid({
      surface: "project",
      projectIds: [ROOT],
      family: "all",
    });
    // 접힌 자리는 서빙 가능하므로 `trimTrailingUnpublished` 의 대상이 아니다.
    expect(slots?.map((s) => s.roundDate)).toEqual(["2026-09-07", "2026-09-15"]);
    expect(slots?.[1].gapReason).toBeNull();
  });

  it("(3b) 마지막 주가 **전부 미발행**이면 종전대로 잘린다", async () => {
    const mod = await loadGrid([
      row("2026-09-07", { anchorWeek: "2026-09-07" }),
      row("2026-09-15", { anchorWeek: "2026-09-14", servable: 0 }),
      row("2026-09-17", { anchorWeek: "2026-09-14", servable: 0 }),
    ]);
    const slots = await mod.buildTrendGrid({
      surface: "project",
      projectIds: [ROOT],
      family: "all",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual(["2026-09-07"]);
  });

  it("(4) 글로벌은 무동작 — 13자리와 갭 위치가 그대로다", async () => {
    const mod = await loadGrid(globalRows());
    const slots = await mod.buildTrendGrid({
      surface: "global",
      projectIds: [ROOT],
      family: "all",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual([
      "2026-06-22", "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20",
      "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24",
      "2026-08-31", "2026-09-07", "2026-09-14",
    ]);
    expect(slots?.filter((s) => s.gapReason !== null).map((s) => s.roundDate)).toEqual([
      "2026-07-13", "2026-07-20", "2026-07-27",
    ]);
  });

  it("(4b) website 도 무동작 — 금요일 10자리 그대로", async () => {
    const mod = await loadGrid(websiteRows());
    const slots = await mod.buildTrendGrid({
      surface: "website",
      projectIds: [ROOT],
      family: "all",
    });
    expect(slots?.map((s) => s.roundDate)).toEqual([
      "2026-07-03", "2026-07-10", "2026-07-17", "2026-07-24", "2026-08-07",
      "2026-08-14", "2026-08-21", "2026-08-28", "2026-09-04", "2026-09-11",
    ]);
  });

  it("(5) 키 off 면 자리 목록 자체가 없다 — 접기에 도달하지 않는다", async () => {
    vi.doMock("@/lib/db/repositories/trend-grid-slots", () => ({
      trendGridSlotRows: async () => lastWeekRows(),
    }));
    vi.doMock("./trend-grid-flag", () => ({ ensureTrendGrid: async () => false }));
    const mod = await import("./trend-grid");
    expect(
      await mod.buildTrendGrid({ surface: "project", projectIds: [ROOT], family: "all" }),
    ).toBeNull();
  });
});
