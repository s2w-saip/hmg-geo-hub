import "server-only";
import ExcelJS from "exceljs";

// Excel (.xlsx) import/export for the per-project tracked-URL list
// (KPI ⑥ AI 타겟 URL 인용률의 분자). Tracked URLs live on the local
// `project_tracked_urls` table — scope never sees them, so this is a pure
// BFF-local read/write. exceljs runs server-side only (imported solely from
// the setting-tab server actions); the client just triggers a download or
// uploads a file.
//
// Header row uses fixed English machine keys so export and import round-trip
// exactly. Import header matching is whitespace/case-tolerant. URL validation
// and normalization happen in the action (mirrors addProjectTrackedUrlAction),
// so this module is pure extraction.

export const EXPORT_COLUMNS = ["id", "url", "label"] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

// A tracked URL as it comes out of the repository (only round-tripped fields).
export interface ExportableTrackedUrl {
  id: string;
  url: string;
  label: string | null;
}

export interface ParsedRow {
  rowNumber: number; // 1-based sheet row (header is row 1, data starts at 2)
  id: string | null;
  url: string | null;
  // Present only when the `label` column existed in the sheet. An empty cell
  // on a present column maps to null (explicit clear); an absent column is
  // omitted so update() leaves the field untouched.
  label?: string | null;
}

export interface ParseResult {
  rows: ParsedRow[];
  warnings: string[];
}

const SHEET_NAME = "tracked-urls";

// normalize a header cell for tolerant matching: lowercase, strip spaces/_-.
function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

const HEADER_LOOKUP: Map<string, ExportColumn> = new Map(
  EXPORT_COLUMNS.map((k) => [normalizeHeader(k), k]),
);

// Coerce an exceljs cell value to a trimmed string (handles rich text /
// number / formula-result / hyperlink shapes). Returns "" for empty.
function cellToString(value: ExcelJS.CellValue | undefined): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((r) => (r as { text?: string }).text ?? "")
        .join("")
        .trim();
    }
    if ("result" in v) return cellToString(v.result as ExcelJS.CellValue);
    if ("text" in v) return cellToString(v.text as ExcelJS.CellValue);
  }
  return String(value).trim();
}

// Build an .xlsx workbook (returned as a Node Buffer) from tracked-URL rows.
export async function buildWorkbook(
  urls: ExportableTrackedUrl[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME);

  ws.columns = EXPORT_COLUMNS.map((key) => ({
    header: key,
    key,
    width: key === "url" ? 60 : key === "id" ? 38 : 30,
  }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.getCell(1, 1).note =
    "시스템이 발급하는 행 식별자입니다. 기존 행을 수정할 때만 값을 유지하고, 신규 URL 행은 이 칸을 비워두세요.";

  for (const u of urls) {
    ws.addRow({ id: u.id, url: u.url, label: u.label ?? "" });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// Parse an uploaded .xlsx buffer into rows + warnings. Pure extraction;
// upsert / auth / URL-validation decisions live in the action.
export async function parseWorkbook(
  buffer: ArrayBuffer | Buffer,
): Promise<ParseResult> {
  const warnings: string[] = [];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as ArrayBuffer);
  } catch {
    return {
      rows: [],
      warnings: ["파일을 읽을 수 없습니다 (.xlsx 형식이 아닙니다)"],
    };
  }

  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 1) {
    return { rows: [], warnings: ["시트가 비어 있습니다"] };
  }

  // Map column index (1-based) -> canonical key from the header row.
  const colKey = new Map<number, ExportColumn>();
  ws.getRow(1).eachCell((cell, col) => {
    const key = HEADER_LOOKUP.get(normalizeHeader(cellToString(cell.value)));
    if (key) colKey.set(col, key);
  });

  const keys = [...colKey.values()];
  if (!keys.includes("url") && !keys.includes("id")) {
    return { rows: [], warnings: ["헤더에 'id' 또는 'url' 열이 없습니다"] };
  }
  const hasLabelCol = keys.includes("label");

  const rows: ParsedRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw: Partial<Record<ExportColumn, string>> = {};
    colKey.forEach((key, col) => {
      raw[key] = cellToString(row.getCell(col).value);
    });

    // Skip fully blank rows.
    if (!Object.values(raw).some((v) => v && v.length > 0)) continue;

    const parsed: ParsedRow = {
      rowNumber: r,
      id: raw.id ? raw.id : null,
      url: raw.url ? raw.url : null,
    };
    if (hasLabelCol) parsed.label = raw.label ? raw.label : null;
    rows.push(parsed);
  }

  return { rows, warnings };
}
