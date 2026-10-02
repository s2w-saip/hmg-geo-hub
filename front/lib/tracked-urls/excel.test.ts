import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  buildWorkbook,
  parseWorkbook,
  EXPORT_COLUMNS,
  type ExportableTrackedUrl,
} from "./excel";

function sample(
  over: Partial<ExportableTrackedUrl> = {},
): ExportableTrackedUrl {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    url: "https://kia.com/it/it/modelli",
    label: "이탈리아 모델 페이지",
    ...over,
  };
}

// Build a workbook in-memory from arbitrary header + data rows for parse tests.
async function makeSheet(headers: string[], rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("tracked-urls");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("buildWorkbook", () => {
  it("uses the fixed English machine-key header order", async () => {
    const buf = await buildWorkbook([sample()]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const header = wb.worksheets[0].getRow(1).values as unknown[];
    expect(header.slice(1)).toEqual([...EXPORT_COLUMNS]);
  });

  it("renders a null label as an empty cell", async () => {
    const buf = await buildWorkbook([sample({ label: null })]);
    const { rows } = await parseWorkbook(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBeNull();
  });
});

describe("parseWorkbook", () => {
  it("round-trips id/url/label through build", async () => {
    const buf = await buildWorkbook([sample()]);
    const { rows, warnings } = await parseWorkbook(buf);
    expect(warnings).toEqual([]);
    expect(rows[0]).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      url: "https://kia.com/it/it/modelli",
      label: "이탈리아 모델 페이지",
    });
  });

  it("matches headers tolerantly (case / spacing)", async () => {
    const buf = await makeSheet(
      ["ID", "  Url ", "Label"],
      [["", "https://kia.com/it", "신규"]],
    );
    const { rows } = await parseWorkbook(buf);
    expect(rows[0].id).toBeNull();
    expect(rows[0].url).toBe("https://kia.com/it");
    expect(rows[0].label).toBe("신규");
  });

  it("omits label when the column is absent (untouched on update)", async () => {
    const buf = await makeSheet(
      ["id", "url"],
      [["abc", "https://kia.com/it"]],
    );
    const { rows } = await parseWorkbook(buf);
    expect(rows[0].label).toBeUndefined();
  });

  it("maps a present-but-empty label cell to null (explicit clear)", async () => {
    const buf = await makeSheet(
      ["id", "url", "label"],
      [["abc", "https://kia.com/it", ""]],
    );
    const { rows } = await parseWorkbook(buf);
    expect(rows[0].label).toBeNull();
  });

  it("skips fully blank rows", async () => {
    const buf = await makeSheet(
      ["id", "url", "label"],
      [["", "", ""], ["", "https://kia.com/it", ""]],
    );
    const { rows } = await parseWorkbook(buf);
    expect(rows).toHaveLength(1);
  });

  it("warns when neither id nor url header is present", async () => {
    const buf = await makeSheet(["label"], [["x"]]);
    const { rows, warnings } = await parseWorkbook(buf);
    expect(rows).toEqual([]);
    expect(warnings[0]).toContain("id");
  });

  it("returns a warning for a non-xlsx buffer", async () => {
    const { rows, warnings } = await parseWorkbook(
      Buffer.from("not a workbook"),
    );
    expect(rows).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
