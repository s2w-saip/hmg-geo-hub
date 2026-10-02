import { afterEach, describe, expect, it, vi } from "vitest";
import { regularRoundDateOf } from "@/lib/kpi/period-compare-week";

// ════════════════════════════════════════════════════════════════════════════
// 표면별 날짜 범위 — 달력에 칠해지는 날이 표면마다 다르다 (스펙 §9.2)
// ════════════════════════════════════════════════════════════════════════════
//
// 귀속 규칙: **글로벌 = 월요일 · 웹사이트 = 금요일 · 프로젝트 = 임의**(정규 요일 없음).
// 통합 배선이 지키는 것은 두 가지다:
//   ① 표면 문자열이 지면 → 로더 → 리더까지 **변형 없이** 간다(섞이면 다른 표면의
//      날짜가 달력에 칠해진다 — 화면만 봐서는 "그날 데이터가 없다"로 보인다).
//   ② 프로젝트 목록이 비면 리더를 아예 부르지 않는다(전수 스캔 방지).
//
// 요일 기대값은 **손계산 리터럴**이다. 기준 달력:
//   2026-09-14(월) 15 16 17 18(금) 19 20(일)

vi.mock("next/cache", () => ({
  unstable_cache:
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> =>
      JSON.parse(JSON.stringify(await fn(...a))) as R,
}));

const listSelectableAnchorDates = vi.fn();
vi.mock("@/lib/db/repositories/scope-answer-anchors", () => ({
  listSelectableAnchorDates: (...a: unknown[]) => listSelectableAnchorDates(...a),
}));
// 회차 지문 조각(2026-09-27) — DB 없이 고정한다. 셀 키 동작은 selectable-anchor-dates.test.ts.
vi.mock("@/lib/period/cycle-fingerprint", () => ({
  ensureCycleCacheSlot: async () => "cycle:0000000000000000",
}));

const { loadSelectableAnchorDates, selectableAnchorDatesCacheKey } = await import(
  "./selectable-anchor-dates"
);

afterEach(() => listSelectableAnchorDates.mockReset());

const ROOT = "11111111-1111-1111-1111-111111111111";
const FLEET = ["22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"];

describe("정규 요일 — 글로벌 월요일 · 웹사이트 금요일 (§9.2)", () => {
  it.each([
    ["global", "2026-09-17", "2026-09-14"], // 목요일 앵커 → 그 주 월요일
    ["global", "2026-09-20", "2026-09-14"], // 일요일도 같은 주(ISO)
    ["website", "2026-09-17", "2026-09-18"], // 목요일 앵커 → 그 주 금요일
    ["website", "2026-09-14", "2026-09-18"],
  ] as const)("%s / %s → %s", (surface, day, expected) => {
    expect(regularRoundDateOf(surface, day)).toBe(expected);
  });

  it("두 표면은 같은 주에서 나흘 떨어진다", () => {
    const mon = regularRoundDateOf("global", "2026-09-16");
    const fri = regularRoundDateOf("website", "2026-09-16");
    expect(mon).toBe("2026-09-14");
    expect(fri).toBe("2026-09-18");
  });
});

describe("표면·프로젝트 범위가 로더를 그대로 지나간다", () => {
  it("글로벌 화면은 'standard' + 루트 프로젝트 하나", async () => {
    listSelectableAnchorDates.mockResolvedValue(["2026-09-07", "2026-09-14"]);
    await loadSelectableAnchorDates("standard", [ROOT]);
    expect(listSelectableAnchorDates).toHaveBeenCalledWith("standard", [ROOT], {}, "mentions");
  });

  it("웹사이트 화면은 'website' + 함대 프로젝트 전부", async () => {
    listSelectableAnchorDates.mockResolvedValue(["2026-09-11", "2026-09-18"]);
    await loadSelectableAnchorDates("website", FLEET);
    expect(listSelectableAnchorDates).toHaveBeenCalledWith("website", FLEET, {}, "mentions");
  });

  it("프로젝트 화면은 'project' + 그 프로젝트 하나", async () => {
    listSelectableAnchorDates.mockResolvedValue(["2026-09-16"]);
    await loadSelectableAnchorDates("project", [ROOT]);
    expect(listSelectableAnchorDates).toHaveBeenCalledWith("project", [ROOT], {}, "mentions");
  });

  // W7: 캐시 셀의 호출 키는 인자 전체의 직렬화라, 같은 집합이라도 순서가 다르면
  // 셀이 갈린다. 그래서 중복 제거 **와 정렬**까지 하고 넘긴다.
  it("중복 프로젝트는 접히고 **정렬**돼서 넘어간다", async () => {
    listSelectableAnchorDates.mockResolvedValue([]);
    await loadSelectableAnchorDates("website", [FLEET[1], FLEET[0], FLEET[1]]);
    expect(listSelectableAnchorDates).toHaveBeenCalledWith("website", FLEET, {}, "mentions");
  });

  it("순서만 다른 호출이 같은 인자로 리더에 닿는다 (셀이 갈리지 않는다)", async () => {
    listSelectableAnchorDates.mockResolvedValue([]);
    await loadSelectableAnchorDates("website", [FLEET[0], FLEET[1]]);
    await loadSelectableAnchorDates("website", [FLEET[1], FLEET[0]]);
    const calls = listSelectableAnchorDates.mock.calls.map((c) => JSON.stringify(c));
    expect(new Set(calls).size).toBe(1);
  });

  it("프로젝트가 없으면 리더를 부르지 않는다", async () => {
    await expect(loadSelectableAnchorDates("standard", [])).resolves.toEqual([]);
    expect(listSelectableAnchorDates).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 숨김 계열 — 달력은 **그 화면의 계열**을 쓴다 (2026-09-20 계약)
// ════════════════════════════════════════════════════════════════════════════
//
// `'mentions'` 가 가장 느슨하다(`hidden_scope='citations'` 로 숨긴 회차를 남긴다).
// 집계층 `DEFAULT_HIDDEN_FAMILY` 와 같은 기본값이라, 언급 화면에서 "행은 보이는데
// 날짜를 고를 수 없는" 상태가 생기지 않는다. 인용 화면만 `'citations'` 이다.
describe("숨김 계열 배선", () => {
  it("기본은 'mentions' 이고 리더까지 그대로 간다", async () => {
    listSelectableAnchorDates.mockResolvedValue([]);
    await loadSelectableAnchorDates("standard", [ROOT]);
    expect(listSelectableAnchorDates).toHaveBeenCalledWith("standard", [ROOT], {}, "mentions");
  });

  it("인용 화면은 'citations' 를 넘긴다", async () => {
    listSelectableAnchorDates.mockResolvedValue([]);
    await loadSelectableAnchorDates("standard", [ROOT], {}, "citations");
    expect(listSelectableAnchorDates).toHaveBeenCalledWith("standard", [ROOT], {}, "citations");
  });

  it("계열이 캐시 키에 들어간다 — 두 화면이 한 셀을 공유하지 않는다", async () => {
    const m = selectableAnchorDatesCacheKey("standard", [ROOT], {}, "mentions");
    const c = selectableAnchorDatesCacheKey("standard", [ROOT], {}, "citations");
    expect(m).not.toBe(c);
    expect(m).toBe(`["standard",["${ROOT}"],null,null,[],[],"mentions"]`);
  });

  it("계열이 다르면 캐시를 건너뛰고 리더를 다시 부른다", async () => {
    listSelectableAnchorDates.mockResolvedValue(["2026-09-14"]);
    await loadSelectableAnchorDates("standard", [ROOT], {}, "mentions");
    await loadSelectableAnchorDates("standard", [ROOT], {}, "citations");
    expect(listSelectableAnchorDates).toHaveBeenCalledTimes(2);
  });
});
