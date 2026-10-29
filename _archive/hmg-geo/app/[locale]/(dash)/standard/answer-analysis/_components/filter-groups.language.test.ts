import { describe, it, expect } from "vitest";
import {
  composeGroups,
  STANDARD_CITATION_ONLY_GROUPS,
  STANDARD_MENTION_ONLY_GROUPS,
} from "./filter-groups";

// 표준 언급·인용 화면의 language 축 노출 (2026-09-03 운영 결정).
// 술어는 대시보드와 공통(promptAxisPreds standard)이라 축만 켜면 되지만, **옵션이
// 없으면 켜면 안 된다** — 패널이 정적 폴백(en/ko/fr, 스코프 무관)을 그린다.
// 그 보호를 composeGroups 한 곳에 둬서 모든 소비처(표준·웹사이트 필터바, 프로젝트
// 뷰 내부 패널)가 같이 받는다.

describe("표준 답변분석 축 목록", () => {
  it("언급·인용 both 에 language 가 있고 geography 바로 뒤다", () => {
    for (const groups of [STANDARD_MENTION_ONLY_GROUPS, STANDARD_CITATION_ONLY_GROUPS]) {
      expect(groups).toContain("language");
      expect(groups[groups.indexOf("geography") + 1]).toBe("language");
    }
  });
});

describe("composeGroups — 옵션 없으면 language 축을 내린다", () => {
  it("옵션이 있으면 only·primary 양쪽에 language 가 남는다", () => {
    for (const stage of ["mentions", "citations"] as const) {
      const g = composeGroups(stage, { languageOptions: ["ko", "en"] });
      expect(g.only).toContain("language");
      expect(g.primary).toContain("language");
    }
  });

  it("옵션이 비면 only·primary 양쪽에서 빠진다", () => {
    for (const stage of ["mentions", "citations"] as const) {
      for (const languageOptions of [[], undefined]) {
        const g = composeGroups(stage, { languageOptions });
        expect(g.only).not.toContain("language");
        expect(g.primary).not.toContain("language");
      }
    }
  });

  it("옵션을 아예 안 넘기는 표면(프로젝트 뷰)도 보호된다", () => {
    // 회귀 방지: 새 표면이 languageOptions 를 빠뜨려도 정적 폴백으로 새지 않는다.
    expect(composeGroups("mentions", {}).only).not.toContain("language");
  });

  it("호출부가 명시한 onlyGroups 에 language 가 있어도 옵션 없으면 뺀다", () => {
    const g = composeGroups("mentions", { onlyGroups: ["geography", "language", "engine"] });
    expect(g.only).toEqual(["geography", "engine"]);
  });

  it("language 말고 다른 축은 그대로다", () => {
    const withLang = composeGroups("citations", { languageOptions: ["ko"] });
    const without = composeGroups("citations", { languageOptions: [] });
    expect(without.only).toEqual(withLang.only.filter((g) => g !== "language"));
    expect(without.primary).toEqual(withLang.primary.filter((g) => g !== "language"));
  });

  it("extraGroups(웹사이트 admin brand 축)는 영향을 받지 않는다", () => {
    const g = composeGroups("mentions", { languageOptions: [], extraGroups: ["brand"] });
    expect(g.only).toContain("brand");
    expect(g.only).not.toContain("language");
  });
});
