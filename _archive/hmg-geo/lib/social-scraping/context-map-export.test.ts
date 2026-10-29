import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildContextMapWorkbook,
  type ContextMapExportLabels,
} from "./context-map-export";
import type { ContextMapExportData } from "@/components/social-scraping/types";

// 이 테스트가 존재하는 이유: 이 버튼은 도입 이래 토스트만 띄우는 스텁이었고
// (context-map-view.tsx `toast.success(t("exportToast"))`), 정적 검사로는
// "성공했다고 말하는데 파일이 없다"가 잡히지 않았다. 그래서 실제 바이트를
// 만들어 다시 열어보는 것까지 한다.

const labels: ContextMapExportLabels = {
  sheets: {
    contexts: "구매 맥락",
    conditions: "구매 조건",
    combinations: "조합 패턴",
  },
  cols: {
    name: "이름",
    theme: "주제",
    category: "카테고리",
    positive: "긍정",
    negative: "부정",
    neutral: "중립",
    drivenConditions: "유발 조건",
    drivenByContexts: "유발한 맥락",
    mentions: "언급",
    conditionA: "조건 A",
    conditionB: "조건 B",
    frequency: "빈도",
    cooccurrence: "동시 언급",
  },
  frequency: { high: "강", medium: "중", low: "약" },
};

const data: ContextMapExportData = {
  contexts: [
    {
      id: "c1",
      name: "가족 여행",
      themeId: "occasion",
      themeName: "상황·시즌",
      mentionCount: 120,
      perspective: { buyer: 60, seller: 10, neutral: 30 },
      linkedCount: 4,
    },
    {
      id: "c2",
      name: "출퇴근",
      themeId: "usecase",
      themeName: "사용 목적",
      mentionCount: 80,
      perspective: { buyer: 50, seller: 20, neutral: 30 },
      linkedCount: 2,
    },
  ],
  conditions: [
    {
      id: "q1",
      name: "연비 좋은",
      categoryId: "연비·동력",
      mentionCount: 200,
      perspective: { buyer: 70, seller: 5, neutral: 25 },
      linkedCount: 7,
    },
  ],
  combinations: [
    {
      id: "q1:q2",
      condAId: "q1",
      condAName: "연비 좋은",
      condBId: "q2",
      condBName: "트렁크 넓은",
      coOccurrenceCount: 33,
      frequency: "high",
    },
    {
      id: "q1:q3",
      condAId: "q1",
      condAName: "연비 좋은",
      condBId: "q3",
      condBName: "가격 저렴한",
      coOccurrenceCount: 5,
      frequency: "low",
    },
  ],
};

async function reopen(bytes: ArrayBuffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  return wb;
}

describe("buildContextMapWorkbook", () => {
  it("writes a real xlsx (zip magic + non-trivial size)", async () => {
    const bytes = await buildContextMapWorkbook(data, labels);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // .xlsx is a zip — "PK\x03\x04".
    const head = new Uint8Array(bytes.slice(0, 4));
    expect(Array.from(head)).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("has one sheet per tab, named from the supplied labels", async () => {
    const wb = await reopen(await buildContextMapWorkbook(data, labels));
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "구매 맥락",
      "구매 조건",
      "조합 패턴",
    ]);
  });

  it("writes header + one row per record, with translated cells", async () => {
    const wb = await reopen(await buildContextMapWorkbook(data, labels));

    const contexts = wb.getWorksheet("구매 맥락")!;
    expect(contexts.rowCount).toBe(1 + data.contexts.length);
    expect(contexts.getRow(1).values).toEqual([
      undefined, // exceljs row.values is 1-indexed
      "이름",
      "주제",
      "긍정%",
      "부정%",
      "중립%",
      "유발 조건",
      "언급",
    ]);
    expect(contexts.getRow(2).values).toEqual([
      undefined,
      "가족 여행",
      "상황·시즌",
      60,
      10,
      30,
      4,
      120,
    ]);

    const conditions = wb.getWorksheet("구매 조건")!;
    expect(conditions.rowCount).toBe(1 + data.conditions.length);
    expect(conditions.getRow(2).getCell(2).value).toBe("연비·동력");

    // frequency는 enum 그대로가 아니라 라벨로 나가야 한다.
    const combos = wb.getWorksheet("조합 패턴")!;
    expect(combos.rowCount).toBe(1 + data.combinations.length);
    expect(combos.getRow(2).values).toEqual([
      undefined,
      "연비 좋은",
      "트렁크 넓은",
      "강",
      33,
    ]);
    expect(combos.getRow(3).getCell(3).value).toBe("약");
  });

  it("survives an empty corpus (header-only sheets, still a valid file)", async () => {
    const wb = await reopen(
      await buildContextMapWorkbook(
        { contexts: [], conditions: [], combinations: [] },
        labels,
      ),
    );
    expect(wb.worksheets).toHaveLength(3);
    for (const ws of wb.worksheets) expect(ws.rowCount).toBe(1);
  });

  it("sanitizes sheet names Excel would reject (>31 chars, [ ] : * ? / \\)", async () => {
    const wb = await reopen(
      await buildContextMapWorkbook(data, {
        ...labels,
        sheets: {
          contexts: "a".repeat(40),
          conditions: "b[c]:d*e?f/g\\h",
          combinations: "ok",
        },
      }),
    );
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toHaveLength(31);
    expect(names[1]).not.toMatch(/[[\]:*?/\\]/);
  });
});
