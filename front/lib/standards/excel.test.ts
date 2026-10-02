import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildCatalogWorkbook, parseCatalogWorkbook } from "@/lib/standards/excel";
import type { StandardCatalogRow } from "@/lib/db/repositories/standards";

async function sheetBuffer(
  headers: string[],
  rows: (string | null)[][],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("catalog");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("parseCatalogWorkbook", () => {
  it("id+text+라벨을 파싱하고 kind 컬럼은 무시한다", async () => {
    const buf = await sheetBuffer(
      ["id", "text", "brand", "kind"],
      [["p-1", "새 본문", "Kia", "acr"]],
    );
    const { rows, warnings } = await parseCatalogWorkbook(buf);
    expect(rows).toEqual([{ id: "p-1", text: "새 본문", labels: { brand: "Kia" } }]);
    expect(warnings).toEqual([]);
  });

  it("빈 셀은 null(clear), 없는 컬럼은 omit", async () => {
    const buf = await sheetBuffer(["id", "depth1"], [["p-1", null]]);
    const { rows } = await parseCatalogWorkbook(buf);
    expect(rows[0].labels).toEqual({ depth1: null });
    expect(rows[0].text).toBeUndefined();
  });

  it("id 없는 행은 경고로 강등하고 건너뛴다", async () => {
    const buf = await sheetBuffer(["id", "text"], [[null, "본문만"]]);
    const { rows, warnings } = await parseCatalogWorkbook(buf);
    expect(rows).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  it("text 컬럼이 있는데 셀이 비면 경고 + text omit (본문 clear 불허)", async () => {
    const buf = await sheetBuffer(["id", "text", "brand"], [["p-1", null, "Kia"]]);
    const { rows, warnings } = await parseCatalogWorkbook(buf);
    expect(rows).toEqual([{ id: "p-1", labels: { brand: "Kia" } }]);
    expect(warnings.length).toBe(1);
  });

  it("알 수 없는 헤더는 무시한다", async () => {
    const buf = await sheetBuffer(["id", "text", "무슨열"], [["p-1", "t", "x"]]);
    const { rows } = await parseCatalogWorkbook(buf);
    expect(rows).toEqual([{ id: "p-1", text: "t", labels: {} }]);
  });

  it("snake/스페이스 헤더 변형(List Type, funnel-stage)도 매칭한다", async () => {
    const buf = await sheetBuffer(
      ["id", "List Type", "funnel-stage"],
      [["p-1", "Brand Message", "인지/탐색"]],
    );
    const { rows } = await parseCatalogWorkbook(buf);
    expect(rows[0].labels).toEqual({
      listType: "Brand Message",
      funnelStage: "인지/탐색",
    });
  });
});

describe("buildCatalogWorkbook → parseCatalogWorkbook 왕복", () => {
  it("내보낸 파일을 그대로 다시 파싱하면 전 행이 id 매칭된다", async () => {
    const rows: StandardCatalogRow[] = [
      {
        id: "p-1",
        text: "t",
        promptType: null,
        category: null,
        brand: "Kia",
        brandPresence: "branded",
        listType: "Brand Message",
        depth1: "D1",
        depth2: null,
        depth3: null,
        depth4: null,
        funnelStage: "인지/탐색",
        kind: "single",
        scopePromptId: "sp-1",
        scopeText: "t",
        deletedAt: null,
      },
    ];
    const buf = await buildCatalogWorkbook(rows);
    const parsed = await parseCatalogWorkbook(buf);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].id).toBe("p-1");
    expect(parsed.rows[0].text).toBe("t");
    expect(parsed.rows[0].labels).toMatchObject({
      brand: "Kia",
      brandPresence: "branded",
      listType: "Brand Message",
      depth1: "D1",
      funnelStage: "인지/탐색",
    });
  });
});
