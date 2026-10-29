import "server-only";
import ExcelJS from "exceljs";

// Excel (.xlsx) import/export for the per-project prompt list.
//
// 포맷 개정(2026-07-31): 예약 열은 `id`, `text` 둘뿐. 그 외 모든 헤더는
// **커스텀 태그 이름으로 그대로 매핑**된다 — 이전의 promptType/brand/category/
// status 고정 열은 폐지(프로젝트에서 안 쓰는 축). id는 시스템이 발급하므로
// 신규 추가 시 열 자체를 생략할 수 있다(있으면 수정, 없으면 생성).
//
// 값 규칙: present 태그 열 + 빈 셀 = 그 태그 비움(clear), 열 자체가 없으면
// 손대지 않음(untouched). 헤더 매칭은 id/text만 공백·대소문자 관대 매칭이고,
// 태그 헤더는 라벨 원문(trim)을 그대로 태그 이름으로 쓴다.
//
// 태그 값 자체는 prompt_custom_field_values(로컬) — scope는 못 본다. 태그 열↔
// 태그 생성/매칭·자동 생성 결정은 순수 파싱과 분리해 import 액션이 담당한다.
// exceljs는 서버 전용(이 모듈은 prompt-tab 서버 액션에서만 import).

const SHEET_NAME = "prompts";

// id/text 헤더 관대 매칭용 정규화 (소문자 + 공백/_/- 제거). 태그 헤더에는
// 적용하지 않는다(한글 라벨 원문을 태그 이름으로 보존해야 하므로).
function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

// Coerce an exceljs cell value to a trimmed string (rich text / number /
// formula-result / hyperlink shapes). Returns "" for empty.
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
      return v.richText.map((r) => (r as { text?: string }).text ?? "").join("").trim();
    }
    if ("result" in v) return cellToString(v.result as ExcelJS.CellValue);
    if ("text" in v) return cellToString(v.text as ExcelJS.CellValue);
  }
  return String(value).trim();
}

// A prompt as it comes out of the repository (only the round-tripped fields).
export interface ExportablePrompt {
  id: string;
  text: string;
}

// A project custom tag (dynamic column). `label` becomes the sheet header.
export interface ExportTag {
  id: string;
  label: string;
}

// Build an .xlsx workbook (Node Buffer) from prompt rows + the project's tags.
// Columns: id, text, then one column per tag (header = tag label). Each prompt's
// tag cells are filled from valuesByPrompt (promptId -> {fieldId: value}).
export async function buildWorkbook(
  prompts: ExportablePrompt[],
  tags: ExportTag[] = [],
  valuesByPrompt: Map<string, Record<string, string>> = new Map(),
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME);

  ws.columns = [
    { header: "id", key: "id", width: 38 },
    { header: "text", key: "text", width: 60 },
    ...tags.map((t) => ({ header: t.label, key: `tag:${t.id}`, width: 18 })),
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.getCell(1, 1).note =
    "시스템이 발급하는 프롬프트 식별자입니다. 기존 행을 수정할 때만 값을 유지하고, 신규 프롬프트 행은 이 칸을 비워두세요.";

  for (const p of prompts) {
    const row: Record<string, string> = { id: p.id, text: p.text };
    const vals = valuesByPrompt.get(p.id) ?? {};
    for (const t of tags) row[`tag:${t.id}`] = vals[t.id] ?? "";
    ws.addRow(row);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export interface ParsedRow {
  rowNumber: number; // 1-based sheet row (header is row 1, data starts at 2)
  id: string | null;
  text: string | null;
  // tag 라벨(원문 trim) -> 값. present 태그 열만 담긴다. 빈 셀 = null(clear),
  // 열 자체가 없으면 키가 아예 없음(untouched).
  tags: Record<string, string | null>;
}

export interface ParseResult {
  rows: ParsedRow[];
  // 시트에 등장한 태그 헤더(라벨) 목록 — 액션이 없는 태그는 자동 생성한다.
  tagHeaders: string[];
  warnings: string[];
}

// Parse an uploaded .xlsx buffer into rows + tag headers + warnings. Pure
// extraction; tag create/match/auth decisions live in the import action.
export async function parseWorkbook(
  buffer: ArrayBuffer | Buffer,
): Promise<ParseResult> {
  const warnings: string[] = [];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as ArrayBuffer);
  } catch {
    return { rows: [], tagHeaders: [], warnings: ["파일을 읽을 수 없습니다 (.xlsx 형식이 아닙니다)"] };
  }

  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 1) {
    return { rows: [], tagHeaders: [], warnings: ["시트가 비어 있습니다"] };
  }

  // Column mapping from the header row.
  let idCol: number | null = null;
  let textCol: number | null = null;
  // tag column index -> label (원문 trim). 중복 라벨은 첫 열만 채택 + 경고.
  const tagCols = new Map<number, string>();
  const seenTagNorm = new Set<string>();

  ws.getRow(1).eachCell((cell, col) => {
    const raw = cellToString(cell.value);
    if (!raw) return; // 빈 헤더 열은 무시
    const norm = normalizeHeader(raw);
    if (norm === "id") {
      idCol = col;
      return;
    }
    if (norm === "text") {
      textCol = col;
      return;
    }
    // 그 외 = 태그 헤더. 라벨은 원문 trim 그대로.
    if (seenTagNorm.has(norm)) {
      warnings.push(`헤더 '${raw}'가 중복되어 첫 번째 열만 사용합니다`);
      return;
    }
    seenTagNorm.add(norm);
    tagCols.set(col, raw);
  });

  if (idCol == null && textCol == null) {
    return {
      rows: [],
      tagHeaders: [...tagCols.values()],
      warnings: ["헤더에 'id' 또는 'text' 열이 없습니다"],
    };
  }

  const tagHeaders = [...tagCols.values()];
  const rows: ParsedRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const id = idCol != null ? cellToString(row.getCell(idCol).value) || null : null;
    const text = textCol != null ? cellToString(row.getCell(textCol).value) || null : null;

    const tags: Record<string, string | null> = {};
    let anyTag = false;
    for (const [col, label] of tagCols) {
      const val = cellToString(row.getCell(col).value);
      tags[label] = val ? val : null; // present 열 → 빈 셀은 clear(null)
      if (val) anyTag = true;
    }

    // 완전 빈 행 스킵 (id·text·태그 어느 것도 값 없음)
    if (!id && !text && !anyTag) continue;

    rows.push({ rowNumber: r, id, text, tags });
  }

  return { rows, tagHeaders, warnings };
}
