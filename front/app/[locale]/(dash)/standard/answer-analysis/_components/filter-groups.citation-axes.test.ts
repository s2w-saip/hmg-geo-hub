import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { FILTER_SECTIONS } from "@/components/dash/dimension-filter-panel";
import {
  STANDARD_CITATION_ONLY_GROUPS,
  STANDARD_CITATION_V2_ONLY_GROUPS,
  composeGroups,
} from "./filter-groups";

// QA 2차 #2 — 글로벌(표준) 인용 화면만 출처 카테고리·경쟁사 축을 얻는다.
// website/project 인용 화면(CitationsView)은 같은 기본 목록을 공유하므로
// **기본 목록은 건드리지 않는다** — 축을 거기 넣으면 요청 범위 밖 화면이 바뀐다.

const HERE = "app/[locale]/(dash)/standard/answer-analysis";

describe("표준 인용 화면 축 목록", () => {
  it("V2 목록에만 source·competitor 가 있다", () => {
    expect(STANDARD_CITATION_V2_ONLY_GROUPS).toContain("source");
    expect(STANDARD_CITATION_V2_ONLY_GROUPS).toContain("competitor");
  });
  it("공유 기본 목록(website/project 인용)은 그대로다", () => {
    expect(STANDARD_CITATION_ONLY_GROUPS).not.toContain("source");
    expect(STANDARD_CITATION_ONLY_GROUPS).not.toContain("competitor");
  });
  it("composeGroups 가 두 축을 only 에 실어 나른다(언어 가드는 그대로)", () => {
    const g = composeGroups("citations", {
      onlyGroups: STANDARD_CITATION_V2_ONLY_GROUPS,
      languageOptions: [],
    });
    expect(g.only).toContain("source");
    expect(g.only).toContain("competitor");
    expect(g.only).not.toContain("language");
  });
});

describe("답변 필터 행", () => {
  it("FILTER_SECTIONS 의 citation 행이 출처 카테고리 + 경쟁사다", () => {
    const row = FILTER_SECTIONS.find((s) => s.id === "citation");
    expect(row?.groups).toEqual(["source", "competitor"]);
  });
});

describe("칩 표면 제거 (QA 2차 #5-(a))", () => {
  it("citation-category-chips.tsx 가 사라졌다", () => {
    expect(existsSync(`${HERE}/_components/citation-category-chips.tsx`)).toBe(false);
  });
  it("인용 페이지가 필터 박스에 칩 행(footerSlot)을 더 이상 넣지 않는다", () => {
    const page = readFileSync(`${HERE}/citation/page.tsx`, "utf8");
    expect(page).not.toContain("citation-category-chips");
    expect(page).not.toContain("footerSlot");
  });
});
