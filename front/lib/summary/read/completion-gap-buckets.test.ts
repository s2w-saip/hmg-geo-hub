// 완결성 갭 슬롯 — 설계 §4-A 의 "값 대신 갭" 을 버킷 배열 위에서 고정한다.
//
// 값 제거는 회차 집합(`restrictToCompleteCycles`)이 하고, 여기는 ② "자리를 남긴다" 다.
// 둘이 갈리면 그 자리가 **축에서 통째로 사라진다**(값도 없고 슬롯도 없다) — 숨김 회차
// 에서 이미 겪은 "그 주가 없었던 것처럼 보인다" 와 같은 결함이다.
import { describe, it, expect, vi } from "vitest";
import type { StandardTrendBucket } from "@/lib/db/repositories/scope-aggregates";

vi.mock("@/lib/db/repositories/summary-cycles", () => ({ hiddenCycleSlots: vi.fn() }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, cache: <T,>(fn: T) => fn };
});

const { insertCompletionGapBuckets } = await import("./trend-gaps");

/** 회차 축 버킷(집계층 경로) — `cycleAnchorAt` 이 채워져 있는 것이 그 표식이다. */
const bucket = (day: string, over: Partial<StandardTrendBucket> = {}): StandardTrendBucket => ({
  bucketStart: day,
  roundDate: day,
  cycleAnchorAt: `${day}T00:00:00.000Z`,
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
  firstAt: `${day}T00:00:00.000Z`,
  lastAt: `${day}T00:00:00.000Z`,
  ...over,
});

const AXIS = ["2026-08-03", "2026-08-17", "2026-08-31"].map((d) => bucket(d));

describe("insertCompletionGapBuckets", () => {
  it("갭 자리가 없으면 **입력 배열 그대로**(참조 동일)", () => {
    expect(insertCompletionGapBuckets(AXIS, [])).toBe(AXIS);
  });

  it("빠진 자리에 값 없는 슬롯을 끼운다 — 순서는 키 오름차순", () => {
    const out = insertCompletionGapBuckets(AXIS, ["2026-08-10"]);
    expect(out.map((b) => b.bucketStart)).toEqual([
      "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-31",
    ]);
    const gap = out[1];
    expect(gap.gap).toEqual({ reason: "collection_error" });
    // 계약: 갭 슬롯의 측정값은 전부 0/null 이다(`lib/viz/trend-gap.ts` 머리 주석).
    expect(gap.answers).toBe(0);
    expect(gap.trackedAnswers).toBe(0);
    expect(gap.totalCitations).toBe(0);
    expect(gap.avgPosition).toBeNull();
    expect(gap.measuredDays).toBe(0);
    // 회차 축 표식을 유지해야 화면이 주 격자 채우기로 되돌아가지 않는다.
    expect(gap.cycleAnchorAt).toBe("2026-08-10T00:00:00.000Z");
    expect(gap.roundDate).toBe("2026-08-10");
  });

  // 규칙 ① — 축을 넓히지 않는다. 첫 점 앞·끝 점 뒤의 갭은 이을 이웃이 없어 음영만 뜨고,
  // 축 끝이 늘어나 "측정이 더 있었던 것처럼" 보인다.
  it("축 밖(첫 점 앞·끝 점 뒤) 자리는 끼우지 않는다", () => {
    expect(insertCompletionGapBuckets(AXIS, ["2026-07-27"])).toBe(AXIS);
    expect(insertCompletionGapBuckets(AXIS, ["2026-09-07"])).toBe(AXIS);
  });

  it("이미 값이 있는 자리에는 끼우지 않는다(같은 키 두 점 금지)", () => {
    const out = insertCompletionGapBuckets(AXIS, ["2026-08-17"]);
    expect(out).toBe(AXIS);
  });

  // 미러 주 격자에 귀속 날짜 키를 얹으면 **없던 날**이 생긴다(`day` 격자 규칙과 같은 이유).
  it("회차 축이 아니면(=`cycleAnchorAt` 없는 버킷이 섞이면) 아무것도 안 한다", () => {
    const mixed = [bucket("2026-08-03"), { ...bucket("2026-08-17"), cycleAnchorAt: undefined }];
    expect(insertCompletionGapBuckets(mixed, ["2026-08-10"])).toBe(mixed);
  });

  it("점이 둘 미만이면 아무것도 안 한다(시계열이 아니다)", () => {
    const one = [bucket("2026-08-03")];
    expect(insertCompletionGapBuckets(one, ["2026-08-10"])).toBe(one);
  });
});
