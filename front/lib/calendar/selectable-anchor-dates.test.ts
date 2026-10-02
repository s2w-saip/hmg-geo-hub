import { afterEach, describe, expect, it, vi } from "vitest";

// 캐시 셀에는 **직렬화 가능한 값만** 들어가야 한다. 2026-09-18 사고: 셀이 `Map` 을
// 돌려주게 두었더니 첫 로드만 정상이고 캐시 HIT 부터 세그먼트가 죽었다. 여기서는
// `unstable_cache` 를 **JSON 라운드트립 하는 가짜**로 갈아 끼워, 실제 캐시가 하는
// 직렬화를 매 호출 재현한다 — 반환값에 Map·Date·Set 이 섞이면 이 테스트가 깨진다.
//
// 2026-09-27: 가짜 캐시가 **호출 인자(= 캐시 키)를 기록**한다 — 회차 지문 조각이 키에
// 실리는지(새 회차가 열리면 셀이 갈리는지)를 보기 위해서다.
const cellArgs: unknown[][] = [];
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      cellArgs.push(a);
      return JSON.parse(JSON.stringify(await fn(...a))) as R;
    },
}));

const listSelectableAnchorDates = vi.fn();
vi.mock("@/lib/db/repositories/scope-answer-anchors", () => ({
  listSelectableAnchorDates: (...a: unknown[]) => listSelectableAnchorDates(...a),
}));

let cycleSlot = "cycle:aaaaaaaaaaaaaaaa";
vi.mock("@/lib/period/cycle-fingerprint", () => ({
  ensureCycleCacheSlot: async () => cycleSlot,
}));

const { loadSelectableAnchorDates, selectableAnchorDatesCacheKey } = await import(
  "./selectable-anchor-dates"
);

afterEach(() => {
  listSelectableAnchorDates.mockReset();
});

const PIDS = ["11111111-1111-1111-1111-111111111111"];

describe("loadSelectableAnchorDates", () => {
  it("리더의 문자열 배열을 그대로 돌려준다(캐시 직렬화 통과)", async () => {
    listSelectableAnchorDates.mockResolvedValue(["2026-09-07", "2026-09-14"]);
    await expect(loadSelectableAnchorDates("standard", PIDS)).resolves.toEqual([
      "2026-09-07",
      "2026-09-14",
    ]);
  });

  it("JSON 라운드트립 후에도 같은 값·같은 타입이다", async () => {
    listSelectableAnchorDates.mockResolvedValue(["2026-09-14"]);
    const out = await loadSelectableAnchorDates("website", PIDS);
    expect(Array.isArray(out)).toBe(true);
    expect(out.every((d) => typeof d === "string")).toBe(true);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("프로젝트가 없으면 리더를 부르지 않는다", async () => {
    await expect(loadSelectableAnchorDates("standard", [])).resolves.toEqual([]);
    expect(listSelectableAnchorDates).not.toHaveBeenCalled();
  });

  it("리더가 던져도 화면을 죽이지 않고 빈 배열로 접는다", async () => {
    listSelectableAnchorDates.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadSelectableAnchorDates("standard", PIDS)).resolves.toEqual([]);
    spy.mockRestore();
  });

  it("리더가 배열이 아닌 것을 주면 '모른다'로 접는다", async () => {
    listSelectableAnchorDates.mockResolvedValue({ 0: "2026-09-14" } as unknown);
    await expect(loadSelectableAnchorDates("standard", PIDS)).resolves.toEqual([]);
  });

  it("프로젝트 id 중복은 제거하고 넘긴다", async () => {
    listSelectableAnchorDates.mockResolvedValue([]);
    await loadSelectableAnchorDates("project", [PIDS[0], PIDS[0]]);
    expect(listSelectableAnchorDates).toHaveBeenCalledWith("project", PIDS, {}, "mentions");
  });

  // 2026-09-27 — 목록은 노출 게이트(앵커 노출일·원장·시계)에 의존하므로, 새 회차가
  // 열리면 달력 셀도 카드 셀과 **같이** 갈려야 한다(라벨·달력은 9/25, 카드는 9/18 인
  // 한 지면 분열의 재발 방지).
  it("회차 지문 조각이 셀 키(마지막 인자)에 실린다 — 조각이 바뀌면 키가 바뀐다", async () => {
    listSelectableAnchorDates.mockResolvedValue([]);
    cellArgs.length = 0;
    cycleSlot = "cycle:aaaaaaaaaaaaaaaa";
    await loadSelectableAnchorDates("website", PIDS);
    cycleSlot = "cycle:bbbbbbbbbbbbbbbb";
    await loadSelectableAnchorDates("website", PIDS);
    expect(cellArgs).toHaveLength(2);
    expect(cellArgs[0].at(-1)).toBe("cycle:aaaaaaaaaaaaaaaa");
    expect(cellArgs[1].at(-1)).toBe("cycle:bbbbbbbbbbbbbbbb");
    expect(JSON.stringify(cellArgs[0])).not.toBe(JSON.stringify(cellArgs[1]));
    // 조각은 키 전용이다 — 리더 인자는 그대로다.
    expect(listSelectableAnchorDates).toHaveBeenLastCalledWith("website", PIDS, {}, "mentions");
  });
});

describe("selectableAnchorDatesCacheKey", () => {
  it("집합이 같으면 순서가 달라도 같은 키다", () => {
    const a = selectableAnchorDatesCacheKey("standard", ["b", "a"], {
      engines: ["gemini", "chatgpt"],
      countries: ["US", "KR"],
    });
    const b = selectableAnchorDatesCacheKey("standard", ["a", "b"], {
      engines: ["chatgpt", "gemini"],
      countries: ["KR", "US"],
    });
    expect(a).toBe(b);
  });

  it("표면·기간이 다르면 다른 키다", () => {
    const base = selectableAnchorDatesCacheKey("standard", ["a"], {});
    expect(selectableAnchorDatesCacheKey("website", ["a"], {})).not.toBe(base);
    expect(selectableAnchorDatesCacheKey("standard", ["a"], { from: "2026-09-01" })).not.toBe(
      base,
    );
  });
});
