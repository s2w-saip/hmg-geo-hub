import { describe, expect, it } from "vitest";
import {
  buildStandardPromptSheet,
  exportFilename,
  marketCellText,
  showsListTypeColumn,
  visibleDepthColumns,
  type StandardPromptExportLabels,
} from "./prompt-export";
import { filterRows, EMPTY_FILTER } from "./prompt-list-readonly";
import type { StandardPromptViewRow } from "./prompt-list-readonly";

// 이 시트의 계약은 "화면과 같다"는 것 하나다. 그래서 테스트도 두 갈래로 간다:
//   ① 컬럼 노출 규칙이 화면 규칙과 같은가 (조건부 컬럼)
//   ② 필터를 건 결과를 그대로 넘겼을 때 그 행들만 나오는가 (filterRows 와 합성)

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

function row(over: Partial<StandardPromptViewRow> = {}): StandardPromptViewRow {
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
    ...over,
  };
}

describe("조건부 컬럼 — 화면과 같은 규칙", () => {
  it("값이 하나도 없는 depth 레벨과 리스트유형은 컬럼이 안 생긴다", () => {
    const rows = [row(), row({ id: "2" })];
    expect(visibleDepthColumns(rows)).toEqual([]);
    expect(showsListTypeColumn(rows)).toBe(false);
    expect(buildStandardPromptSheet(rows, rows, L, F).headers).toEqual([
      "프롬프트", "브랜드", "퍼널", "대상 시장", "언어", "브랜드 언급", "측정 종류", "측정 상태",
    ]);
  });

  it("한 행이라도 값이 있으면 그 레벨 컬럼이 생긴다", () => {
    const rows = [row(), row({ id: "2", depth1: "EV", depth3: "충전", listType: "리스트" })];
    expect(visibleDepthColumns(rows)).toEqual(["depth1", "depth3"]);
    expect(buildStandardPromptSheet(rows, rows, L, F).headers).toEqual([
      "프롬프트", "브랜드", "리스트유형", "D1", "D3",
      "퍼널", "대상 시장", "언어", "브랜드 언급", "측정 종류", "측정 상태",
    ]);
  });

  it("컬럼 노출은 **필터 결과가 아니라 전체 rows** 로 판정한다 (화면과 동일)", () => {
    const all = [row({ id: "1", depth1: "EV" }), row({ id: "2" })];
    const visible = [all[1]]; // 필터 결과엔 depth1 값이 없다
    const sheet = buildStandardPromptSheet(visible, all, L, F);
    // 화면도 이 경우 D1 헤더를 유지한다 — 컬럼 구성이 엑셀에서만 달라지면 안 된다.
    expect(sheet.headers).toContain("D1");
    expect(sheet.rows).toEqual([
      ["제네시스 GV80 는 어떤가", "Genesis", "", "비교/검증", "전체", "L(KO)", "브랜드", "단일", "측정중"],
    ]);
  });
});

describe("셀 값", () => {
  it("대상 시장 미지정은 빈칸이 아니라 '전체' — 화면 배지와 같다", () => {
    expect(marketCellText(null, L, F)).toBe("전체");
    expect(marketCellText([], L, F)).toBe("전체");
  });

  it("대상 시장은 실국가 먼저, 의사코드 뒤 — 접지 않고 전부 적는다", () => {
    // 화면은 실국가 3개까지만 배지로 보이고 나머지는 +N 툴팁이다(MARKET_BADGE_LIMIT).
    // 엑셀에는 전부 들어가야 한다.
    expect(marketCellText(["x:EU", "KR", "US", "GB", "AU"], L, F)).toBe(
      "M(AU) · M(GB) · M(KR) · M(US) · M(x:EU)",
    );
  });

  it("브랜드 없음/엄브렐러(HMG)는 '공통' 으로 적는다", () => {
    const rows = [row({ brand: null }), row({ id: "2", brand: "HMG" })];
    const sheet = buildStandardPromptSheet(rows, rows, L, F);
    expect(sheet.rows.map((r) => r[1])).toEqual(["공통", "공통"]);
  });

  it("미측정(scopePromptId=null)·ACR 이 화면 배지와 같은 문구로 나온다", () => {
    const rows = [row({ scopePromptId: null, kind: "acr" })];
    const sheet = buildStandardPromptSheet(rows, rows, L, F);
    expect(sheet.rows[0].slice(-2)).toEqual(["ACR", "미측정"]);
  });
});

describe("필터 동일성 — filterRows 의 결과를 그대로 넘긴다", () => {
  const all = [
    row({ id: "1", lang: "KO", funnelStage: "인지/탐색" }),
    row({ id: "2", lang: "EN", funnelStage: "인지/탐색" }),
    row({ id: "3", lang: "KO", funnelStage: "비교/검증" }),
  ];

  it("언어 필터를 건 결과만 시트에 들어간다", () => {
    const visible = filterRows(all, { ...EMPTY_FILTER, lang: "KO" }, "");
    expect(visible.map((r) => r.id)).toEqual(["1", "3"]);
    const sheet = buildStandardPromptSheet(visible, all, L, F);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows.map((r) => r[0])).toEqual(visible.map((r) => r.text));
  });

  it("필터가 0건이면 헤더만 남는다 (빈 시트가 아니라 컬럼은 유지)", () => {
    const visible = filterRows(all, { ...EMPTY_FILTER, lang: "FR" }, "");
    const sheet = buildStandardPromptSheet(visible, all, L, F);
    expect(visible).toEqual([]);
    expect(sheet.rows).toEqual([]);
    expect(sheet.headers.length).toBeGreaterThan(0);
  });
});

describe("파일명", () => {
  it("<stem>-YYYY-MM-DD.xlsx — 자릿수는 0 으로 채운다", () => {
    expect(exportFilename("글로벌-프롬프트", new Date(2026, 8, 3))).toBe(
      "글로벌-프롬프트-2026-09-03.xlsx",
    );
  });
});
