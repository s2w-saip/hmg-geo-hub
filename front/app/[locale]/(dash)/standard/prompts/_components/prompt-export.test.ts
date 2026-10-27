import { describe, expect, it } from "vitest";
import { buildStandardPromptSheet, exportFilename, marketCellText, type StandardPromptExportLabels } from "./prompt-export";
import type { PromptRow } from "../_data/screen-types";

// 이 시트의 계약은 "화면과 같다"는 것 하나다. 행·순서·컬럼은 화면과 같은 screen 이 정하고
// (back/bff/tests/test_screens_standard_prompts.py), 여기서는 셀 문구와 컬럼 구성을 본다.

const L: StandardPromptExportLabels = {
  text: "프롬프트",
  brand: "브랜드",
  listType: "리스트유형",
  depth1: "D1",
  depth2: "D2",
  depth3: "D3",
  depth4: "D4",
  funnel: "퍼널",
  market: "대상 시장",
  lang: "언어",
  presence: "브랜드 언급",
  kind: "측정 종류",
  status: "측정 상태",
  common: "공통",
  marketAll: "전체",
  branded: "브랜드",
  unbranded: "비브랜드",
  kindAcr: "ACR",
  kindSingle: "단일",
  statusMeasured: "측정중",
  statusUnmeasured: "미측정",
};

const F = {
  market: (c: string) => `M(${c})`,
  language: (c: string) => `L(${c})`,
};

function row(over: Partial<PromptRow> = {}): PromptRow {
  return {
    id: "1",
    text: "제네시스 GV80 는 어떤가",
    brand: "Genesis",
    brandPresence: "branded",
    listType: null,
    depth1: null,
    depth2: null,
    depth3: null,
    depth4: null,
    funnelStage: "비교/검증",
    kind: "single",
    regions: null,
    lang: "KO",
    scopePromptId: "sp-1",
    presence: "branded",
    common: false,
    markets: { real: [], pseudo: [] },
    ...over,
  };
}

describe("컬럼 구성 — 화면의 분류 컬럼", () => {
  it("분류 컬럼이 없으면 리스트유형·Depth 컬럼이 안 생긴다", () => {
    expect(buildStandardPromptSheet([row()], [], L, F).headers).toEqual([
      "프롬프트", "브랜드", "퍼널", "대상 시장", "언어", "브랜드 언급", "측정 종류", "측정 상태",
    ]);
  });

  it("화면이 보이는 분류 컬럼만 같은 순서로 생긴다", () => {
    expect(buildStandardPromptSheet([row()], ["depth3", "listType", "depth1"], L, F).headers).toEqual([
      "프롬프트", "브랜드", "리스트유형", "D1", "D3",
      "퍼널", "대상 시장", "언어", "브랜드 언급", "측정 종류", "측정 상태",
    ]);
  });

  it("행에 값이 없어도 화면의 컬럼은 유지된다 (빈 셀)", () => {
    const sheet = buildStandardPromptSheet([row()], ["depth1"], L, F);
    expect(sheet.headers).toContain("D1");
    expect(sheet.rows).toEqual([
      ["제네시스 GV80 는 어떤가", "Genesis", "", "비교/검증", "전체", "L(KO)", "브랜드", "단일", "측정중"],
    ]);
  });

  it("0건이면 헤더만 남는다 (빈 시트가 아니라 컬럼은 유지)", () => {
    const sheet = buildStandardPromptSheet([], ["listType"], L, F);
    expect(sheet.rows).toEqual([]);
    expect(sheet.headers.length).toBeGreaterThan(0);
  });
});

describe("셀 값", () => {
  it("대상 시장 미지정은 빈칸이 아니라 '전체' — 화면 배지와 같다", () => {
    expect(marketCellText({ real: [], pseudo: [] }, L, F)).toBe("전체");
  });

  it("대상 시장은 실국가 먼저, 의사코드 뒤 — 접지 않고 전부 적는다", () => {
    expect(marketCellText({ real: ["AU", "GB", "KR", "US"], pseudo: ["x:EU"] }, L, F)).toBe(
      "M(AU) · M(GB) · M(KR) · M(US) · M(x:EU)",
    );
  });

  it("공통 행은 '공통' 으로 적는다", () => {
    const sheet = buildStandardPromptSheet([row({ brand: null, common: true }), row({ id: "2", brand: "HMG", common: true })], [], L, F);
    expect(sheet.rows.map((r) => r[1])).toEqual(["공통", "공통"]);
  });

  it("브랜드 노출은 행의 presence 대로, 알 수 없으면 빈칸", () => {
    const sheet = buildStandardPromptSheet([row({ presence: "unbranded" }), row({ id: "2", presence: null })], [], L, F);
    expect(sheet.rows.map((r) => r[5])).toEqual(["비브랜드", ""]);
  });

  it("미측정(scopePromptId=null)·ACR 이 화면 배지와 같은 문구로 나온다", () => {
    const sheet = buildStandardPromptSheet([row({ scopePromptId: null, kind: "acr" })], [], L, F);
    expect(sheet.rows[0].slice(-2)).toEqual(["ACR", "미측정"]);
  });
});

describe("파일명", () => {
  it("<stem>-YYYY-MM-DD.xlsx — 자릿수는 0 으로 채운다", () => {
    expect(exportFilename("글로벌-프롬프트", new Date(2026, 8, 3))).toBe("글로벌-프롬프트-2026-09-03.xlsx");
  });
});
