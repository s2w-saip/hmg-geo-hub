import { describe, expect, it } from "vitest";
import {
  AXIS_CHILDREN,
  clearDescendantsIfEmpty,
  pruneToOptions,
} from "@/components/dash/dimension-filter-panel";

// 2026-09-04 고객 검수: "상위 카테고리 선택 취소 시 하위 카테고리 선택이 남으면
// 안 된다". 직접 증상은 글로벌 대시보드에서 브랜드 → 권역(중동) → 언어 순으로
// 고른 뒤 **브랜드를 취소하면 국가가 임의로 선택된 채 남던 것**이었다 — 권역
// 토글이 국가 draft 를 채우는데, 브랜드가 사라지면 권역 드롭다운도 없어져
// 되돌릴 방법조차 없었다.
describe("축 캐스케이드 — 부모가 비면 자식도 비운다", () => {
  it("브랜드를 비우면 국가·언어·카탈로그 택소노미가 함께 비워진다", () => {
    const next = clearDescendantsIfEmpty(
      {
        brand: [],
        geography: ["AE", "EG"],
        language: ["ar"],
        listType: ["Brand Message"],
        depth1: ["Brand Image/key value"],
        engine: ["chatgpt"],
      },
      "brand",
    );
    expect(next.geography).toBeUndefined();
    expect(next.language).toBeUndefined();
    expect(next.listType).toBeUndefined();
    expect(next.depth1).toBeUndefined();
    // 형제 축(엔진)은 건드리지 않는다 — 브랜드에 종속되지 않는다.
    expect(next.engine).toEqual(["chatgpt"]);
  });

  it("국가를 비우면 언어가 비워진다", () => {
    const next = clearDescendantsIfEmpty({ geography: [], language: ["ar"] }, "geography");
    expect(next.language).toBeUndefined();
  });

  it("부모에 선택이 남아 있으면 자식을 건드리지 않는다", () => {
    const draft = { brand: ["Hyundai"], geography: ["AE"], language: ["ar"] };
    expect(clearDescendantsIfEmpty(draft, "brand")).toBe(draft);
  });

  it("지울 자식이 없으면 같은 객체를 그대로 돌려준다 (불필요한 리렌더 방지)", () => {
    const draft = { brand: [], engine: ["chatgpt"] };
    expect(clearDescendantsIfEmpty(draft, "brand")).toBe(draft);
  });

  it("언어는 잎 축이라 하위가 없다", () => {
    expect(AXIS_CHILDREN.language).toBeUndefined();
  });
});

// 2026-09-04 고객 검수 2차 — 부모가 *비지 않고* 바뀌는 경우.
//
// 언어를 고른 뒤 국가를 바꾸면 언어 옵션이 그 국가 것만 남는데, 이전 언어 선택이
// draft 에 그대로 남아 **배지는 "언어 2"인데 드롭다운에는 1개만** 보였다. 목록에
// 없으니 클릭해서 해제할 수도 없다. clearDescendantsIfEmpty 는 부모가 비었을 때만
// 걸리므로 이 케이스를 못 잡는다 — pruneToOptions 가 그 자리다.
describe("pruneToOptions — 선택을 현재 옵션 안으로 좁힌다", () => {
  it("옵션에 없는 언어 선택을 지운다 (유령 선택 방지)", () => {
    const next = pruneToOptions({ geography: ["BA"], language: ["ko", "bs"] }, "language", [
      "bs",
    ]);
    expect(next.language).toEqual(["bs"]);
    // 형제 축은 그대로
    expect(next.geography).toEqual(["BA"]);
  });

  it("남는 값이 하나도 없으면 축 자체를 비운다", () => {
    const next = pruneToOptions({ language: ["ko", "en"] }, "language", ["bs"]);
    expect(next.language).toBeUndefined();
  });

  it("전부 옵션 안이면 같은 객체를 돌려준다 (리렌더 방지)", () => {
    const draft = { language: ["bs"] };
    expect(pruneToOptions(draft, "language", ["bs", "hr"])).toBe(draft);
  });

  it("옵션을 모르면(null/undefined) 건드리지 않는다 — 목록 미도착 중 선택 소실 방지", () => {
    const draft = { language: ["ko"] };
    expect(pruneToOptions(draft, "language", null)).toBe(draft);
    expect(pruneToOptions(draft, "language", undefined)).toBe(draft);
  });

  it("선택이 없으면 그대로", () => {
    const draft = { geography: ["BA"] };
    expect(pruneToOptions(draft, "language", ["bs"])).toBe(draft);
  });
});
