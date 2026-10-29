// Browser-side XLSX export for the answer-analysis "내보내기" buttons.
//
// Mirrors the (filename, headers, rows) shape of `downloadCsv` in ./csv so call
// sites can swap one for the other. ExcelJS is loaded via dynamic import so the
// (large) library only ships to the client when an operator actually clicks
// export — it stays out of the initial bundle.
//
// Browser-only (Blob / document / URL). Import from a "use client" component
// and call (await) inside an event handler.

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type XlsxCell = string | number | null | undefined;

export async function downloadXlsx(
  filename: string,
  headers: string[],
  rows: XlsxCell[][],
  sheetName = "Sheet1",
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  const header = ws.addRow(headers);
  header.font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const r of rows) ws.addRow(r.map((c) => (c == null ? "" : c)));

  // Width each column to its widest cell (header included), clamped to a
  // readable range.
  ws.columns.forEach((col, i) => {
    let max = headers[i]?.length ?? 10;
    for (const r of rows) {
      const len = r[i] == null ? 0 : String(r[i]).length;
      if (len > max) max = len;
    }
    col.width = Math.min(Math.max(max + 2, 10), 60);
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
