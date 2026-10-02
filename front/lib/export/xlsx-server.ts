import "server-only";
import ExcelJS from "exceljs";

// 서버 측 XLSX 생성 — `./xlsx`(브라우저판 downloadXlsx)의 쌍둥이.
//
// 두 벌인 이유: 브라우저판은 Blob/document/URL 을 쓰고 exceljs 를 동적 import 해
// 초기 번들에서 빼는 것이 목적이고, 이쪽은 라우트 핸들러가 바이트를 그대로
// 응답으로 돌려주는 것이 목적이다. **시각 규약(헤더 굵게·1행 고정·열 너비)은
// 동일하게 유지한다** — 같은 제품의 두 화면에서 나온 엑셀이 달라 보이면 안 된다.
//
// 서버 전용인 이유(lib/social-scraping/context-map-export.ts 와 동일 규율):
// exceljs 가 클라이언트 번들로 넘어가지 않도록 "server-only" 로 못 박는다.

export type XlsxCell = string | number | null | undefined;

// 시트명 제약: 31자 이하 + [ ] : * ? / \ 금지. 번역 문구가 이 규칙을 어기면
// 워크북 저장 자체가 실패하므로 여기서 방어한다(context-map-export.ts 선례).
function safeSheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet1";
}

export async function buildXlsxBuffer(
  headers: string[],
  rows: XlsxCell[][],
  sheetName = "Sheet1",
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(safeSheetName(sheetName));

  const header = ws.addRow(headers);
  header.font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const r of rows) ws.addRow(r.map((c) => (c == null ? "" : c)));

  // 열 너비 = 그 열의 가장 긴 셀(헤더 포함), 읽을 수 있는 범위로 클램프.
  ws.columns.forEach((col, i) => {
    let max = headers[i]?.length ?? 10;
    for (const r of rows) {
      const len = r[i] == null ? 0 : String(r[i]).length;
      if (len > max) max = len;
    }
    col.width = Math.min(Math.max(max + 2, 10), 60);
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
