import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  buildWorkbook,
  parseWorkbook,
  type ExportablePrompt,
  type ExportTag,
} from "./excel";

// Build a workbook in-memory from arbitrary header + data rows for parse tests.
async function makeSheet(headers: string[], rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("prompts");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const PROMPT: ExportablePrompt = {
  id: "11111111-1111-1111-1111-111111111111",
  text: "가족이 함께 탈 SUV 추천해줘",
};
const TAGS: ExportTag[] = [
  { id: "f-prio", label: "우선순위" },
  { id: "f-owner", label: "담당권역" },
];

describe("buildWorkbook", () => {
  it("emits id, text, then one column per tag (header = tag label)", async () => {
    const buf = await buildWorkbook([PROMPT], TAGS);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const header = wb.worksheets[0].getRow(1).values as unknown[];
    // exceljs row.values is 1-indexed (index 0 empty)
    expect(header.slice(1)).toEqual(["id", "text", "우선순위", "담당권역"]);
  });

  it("fills tag cells from valuesByPrompt (fieldId → value)", async () => {
    const values = new Map<string, Record<string, string>>([
      [PROMPT.id, { "f-prio": "높음" }], // 담당권역은 미지정 → 빈 셀
    ]);
    const buf = await buildWorkbook([PROMPT], TAGS, values);
    const { rows } = await parseWorkbook(buf);
    expect(rows[0].tags["우선순위"]).toBe("높음");
    expect(rows[0].tags["담당권역"]).toBeNull(); // present 열 + 빈 셀 = null(clear)
  });

  it("id-and-text only when no tags", async () => {
    const buf = await buildWorkbook([PROMPT]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const header = wb.worksheets[0].getRow(1).values as unknown[];
    expect(header.slice(1)).toEqual(["id", "text"]);
  });
});

describe("parseWorkbook — reserved columns + tag headers", () => {
  it("matches id/text case/space-insensitively and treats everything else as a tag", async () => {
    const buf = await makeSheet(
      ["ID", "Text", "우선순위"],
      [["abc", "hi", "높음"]],
    );
    const { rows, tagHeaders, warnings } = await parseWorkbook(buf);
    expect(warnings).toEqual([]);
    expect(rows[0].id).toBe("abc");
    expect(rows[0].text).toBe("hi");
    expect(tagHeaders).toEqual(["우선순위"]);
    expect(rows[0].tags["우선순위"]).toBe("높음");
  });

  it("reports every non-id/text header as a tag header (for auto-create)", async () => {
    const buf = await makeSheet(
      ["text", "우선순위", "담당권역"],
      [["새 프롬프트", "높음", "유럽"]],
    );
    const { rows, tagHeaders } = await parseWorkbook(buf);
    expect(tagHeaders).toEqual(["우선순위", "담당권역"]);
    expect(rows[0].id).toBeNull(); // no id column → new insert
    expect(rows[0].text).toBe("새 프롬프트");
    expect(rows[0].tags).toEqual({ 우선순위: "높음", 담당권역: "유럽" });
  });

  it("present tag column with an empty cell maps to null (explicit clear)", async () => {
    const buf = await makeSheet(["id", "text", "우선순위"], [["x", "hi", ""]]);
    const { rows } = await parseWorkbook(buf);
    expect(rows[0].tags).toHaveProperty("우선순위");
    expect(rows[0].tags["우선순위"]).toBeNull();
  });

  it("treats a row with no id as a new insert (id null)", async () => {
    const buf = await makeSheet(["id", "text"], [["", "new prompt"]]);
    const { rows } = await parseWorkbook(buf);
    expect(rows[0].id).toBeNull();
    expect(rows[0].text).toBe("new prompt");
  });

  it("warns and keeps only the first of duplicate tag headers", async () => {
    const buf = await makeSheet(
      ["text", "우선순위", "우선순위"],
      [["hi", "높음", "낮음"]],
    );
    const { rows, tagHeaders, warnings } = await parseWorkbook(buf);
    expect(tagHeaders).toEqual(["우선순위"]);
    expect(rows[0].tags["우선순위"]).toBe("높음");
    expect(warnings.some((w) => w.includes("우선순위"))).toBe(true);
  });
});

describe("parseWorkbook — edge cases", () => {
  it("skips fully blank rows", async () => {
    const buf = await makeSheet(
      ["id", "text"],
      [["", ""], ["x", "kept"]],
    );
    const { rows } = await parseWorkbook(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("kept");
  });

  it("errors when neither id nor text header is present", async () => {
    const buf = await makeSheet(["우선순위"], [["높음"]]);
    const { rows, warnings } = await parseWorkbook(buf);
    expect(rows).toEqual([]);
    expect(warnings[0]).toContain("id");
  });

  it("rejects a non-xlsx buffer gracefully", async () => {
    const { rows, warnings } = await parseWorkbook(Buffer.from("not a workbook"));
    expect(rows).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
