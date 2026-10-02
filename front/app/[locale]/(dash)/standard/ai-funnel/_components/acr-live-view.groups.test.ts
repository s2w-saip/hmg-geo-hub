import { describe, it, expect } from "vitest";
import { acrOnlyGroups } from "./acr-live-view";

// ACR 화면의 language 축 노출 규칙 (2026-09-03) — 대시보드와 같은 규칙:
// 실측 옵션이 있으면 노출, 없으면 축을 내린다(정적 폴백 en/ko/fr 로 새지 않게).
describe("acrOnlyGroups", () => {
  it("실측 언어가 있으면 language 를 노출한다", () => {
    expect(acrOnlyGroups(["ko", "en"])).toContain("language");
  });

  it("실측 언어가 없으면 language 를 뺀다", () => {
    expect(acrOnlyGroups([])).not.toContain("language");
    expect(acrOnlyGroups(undefined)).not.toContain("language");
  });

  it("language 말고는 축을 잃지 않는다", () => {
    const withLang = acrOnlyGroups(["ko"]);
    const without = acrOnlyGroups([]);
    expect(without).toEqual(withLang.filter((g) => g !== "language"));
  });

  it("geography 바로 뒤에 온다 (다른 표면과 같은 자리)", () => {
    const g = acrOnlyGroups(["ko"]);
    expect(g[g.indexOf("geography") + 1]).toBe("language");
  });
});
