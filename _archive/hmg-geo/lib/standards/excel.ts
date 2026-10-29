import "server-only";
import ExcelJS from "exceljs";
import type { StandardCatalogRow } from "@/lib/db/repositories/standards";

// 글로벌 카탈로그 xlsx 내보내기/가져오기 (catalog-prompt-audit 벌크 편집).
// lib/prompts/excel.ts(프로젝트 프롬프트 IO)와 형제 모듈 — 헤더 정규화·셀 정규화
// 헬퍼는 같은 구현을 복사한다(컬럼 계약이 독립적으로 진화하므로 공용화하지 않음).
//
// 계약:
// - 예약 열 = 아래 CATALOG_XLSX_COLUMNS. 알 수 없는 헤더는 조용히 무시.
// - `kind`는 export 전용 — 파서가 받지 않는다(셀당 측정 ~20배 비용 스위치라
//   확인 다이얼로그가 있는 단건 토글로만 바꾼다).
// - 라벨 의미론: 열이 시트에 없으면 omit(불변), 있는데 빈 셀이면 null(clear).
// - `text`는 clear 불허 — text 열이 있는데 셀이 비면 경고 + omit.
// - id 없는 행은 경고 + skip (벌크는 기존 행 수정 전용 — 신규는 단건 생성 경로).

const SHEET_NAME = "catalog";

export const CATALOG_XLSX_COLUMNS = [
  "id",
  "text",
  "brand",
  "brand_presence",
  "list_type",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
  "funnel_stage",
  "category",
  "prompt_type",
  "regions",
  "lang",
  "kind",
] as const;

// 정규화된 헤더 → CatalogLabelsPatch 필드명. (id/text/kind는 별도 취급.)
const LABEL_HEADER_TO_FIELD: Record<string, string> = {
  brand: "brand",
  brandpresence: "brandPresence",
  listtype: "listType",
  depth1: "depth1",
  depth2: "depth2",
  depth3: "depth3",
  depth4: "depth4",
  funnelstage: "funnelStage",
  category: "category",
  prompttype: "promptType",
};

// lib/prompts/excel.ts:23과 동일 — 소문자 + 공백/_/- 제거.
function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

// lib/prompts/excel.ts:29와 동일 — richText/number/formula/hyperlink 정규화.
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

export async function buildCatalogWorkbook(rows: StandardCatalogRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME);
  ws.columns = CATALOG_XLSX_COLUMNS.map((key) => ({
    header: key,
    key,
    width: key === "text" ? 80 : key === "id" ? 38 : 16,
  }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of rows) {
    ws.addRow({
      id: r.id,
      text: r.text,
      brand: r.brand ?? "",
      brand_presence: r.brandPresence ?? "",
      list_type: r.listType ?? "",
      depth1: r.depth1 ?? "",
      depth2: r.depth2 ?? "",
      depth3: r.depth3 ?? "",
      depth4: r.depth4 ?? "",
      funnel_stage: r.funnelStage ?? "",
      category: r.category ?? "",
      prompt_type: r.promptType ?? "",
      // 시장은 CSV 한 셀로 낸다 — 정렬해서 내보내면 왕복(export→import)이
      // 가짜 변경을 만들지 않는다(감사 로그의 정렬 CSV 규약과 같은 이유).
      regions: r.regions && r.regions.length > 0 ? [...r.regions].sort().join(",") : "",
      lang: r.lang ?? "",
      kind: r.kind,
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface CatalogParsedRow {
  id: string;
  text?: string;
  labels: Record<string, string | null>;
  /**
   * 시장 축. `undefined` = 열 없음(불변), `null` = 빈 셀(미지정=전체로 되돌림),
   * 배열 = 그 목록으로 설정. `labels`(전부 string|null)와 타입 계열이 달라
   * 별도 필드로 둔다 — 서버 액션에서 `CatalogLabelsPatch` 와 나눈 것과 같은 이유.
   *
   * ⚠️ 여기서는 **형식만** 본다. 어휘(루트 프로젝트 시장) 검증은 프리뷰가 한다 —
   * 어휘는 scope 조회가 필요해 이 순수 파서가 알 수 없다.
   */
  regions?: string[] | null;
  lang?: string | null;
}

export interface CatalogParseResult {
  rows: CatalogParsedRow[];
  warnings: string[];
}

export async function parseCatalogWorkbook(
  buffer: ArrayBuffer | Buffer,
): Promise<CatalogParseResult> {
  const warnings: string[] = [];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as ArrayBuffer);
  } catch {
    return { rows: [], warnings: ["파일을 읽을 수 없습니다 (.xlsx 형식이 아닙니다)"] };
  }

  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 1) {
    return { rows: [], warnings: ["시트가 비어 있습니다"] };
  }

  let idCol: number | null = null;
  let textCol: number | null = null;
  let regionsCol: number | null = null;
  let langCol: number | null = null;
  const labelCols = new Map<number, string>(); // col -> 필드명

  ws.getRow(1).eachCell((cell, col) => {
    const raw = cellToString(cell.value);
    if (!raw) return;
    const norm = normalizeHeader(raw);
    if (norm === "id") {
      idCol = col;
      return;
    }
    if (norm === "text") {
      textCol = col;
      return;
    }
    if (norm === "regions") {
      regionsCol = col;
      return;
    }
    if (norm === "lang") {
      langCol = col;
      return;
    }
    const field = LABEL_HEADER_TO_FIELD[norm];
    if (field) labelCols.set(col, field);
    // kind 및 알 수 없는 헤더 → 조용히 무시 (계약 주석 참고).
  });

  if (idCol == null) {
    return { rows: [], warnings: ["헤더에 'id' 열이 없습니다 — 벌크는 기존 행 수정 전용입니다"] };
  }

  const rows: CatalogParsedRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const id = cellToString(row.getCell(idCol).value);

    const labels: Record<string, string | null> = {};
    let anyValue = false;
    for (const [col, field] of labelCols) {
      const val = cellToString(row.getCell(col).value);
      labels[field] = val ? val : null; // present 열 → 빈 셀은 clear(null)
      if (val) anyValue = true;
    }

    let text: string | undefined;
    if (textCol != null) {
      const t = cellToString(row.getCell(textCol).value);
      if (t) {
        text = t;
        anyValue = true;
      } else if (id) {
        warnings.push(`행 ${r}: text 셀이 비어 있어 본문은 건드리지 않습니다 (본문 비우기는 불허)`);
      }
    }

    // 시장·언어 — 열이 없으면 undefined(불변), 빈 셀이면 null(미지정=전체).
    // 형식이 아닌 코드는 **그 행의 시장 변경 자체를 omit** 하고 경고한다.
    // 절반만 적용하면 "3개 중 2개만 들어간" 조용한 손실이 된다.
    let regions: string[] | null | undefined;
    if (regionsCol != null) {
      const raw = cellToString(row.getCell(regionsCol).value);
      if (raw) anyValue = true;
      if (!raw) {
        regions = null;
      } else {
        const parts = raw
          .split(/[,;|]/)
          .map((x) => x.trim())
          .filter(Boolean);
        const bad = parts.filter((x) => !/^(?:[A-Za-z]{2}|[xX]:[A-Za-z0-9]{2,8})$/.test(x));
        if (bad.length > 0) {
          warnings.push(
            `행 ${r}: 시장 코드 형식이 아닙니다 (${bad.join(", ")}) — 이 행의 시장은 변경하지 않습니다`,
          );
        } else {
          regions = parts.map((x) => (x.startsWith("x:") || x.startsWith("X:") ? "x:" + x.slice(2).toUpperCase() : x.toUpperCase()));
        }
      }
    }

    let lang: string | null | undefined;
    if (langCol != null) {
      const raw = cellToString(row.getCell(langCol).value);
      if (raw) anyValue = true;
      if (!raw) {
        lang = null;
      } else if (!/^[A-Za-z]{2}$/.test(raw)) {
        warnings.push(`행 ${r}: 언어 코드 형식이 아닙니다 (${raw}) — 이 행의 언어는 변경하지 않습니다`);
      } else {
        lang = raw.toUpperCase();
      }
    }

    if (!id) {
      // 완전 빈 행은 조용히 스킵, 값이 있는데 id가 없으면 경고.
      if (anyValue) warnings.push(`행 ${r}: id가 없어 건너뜁니다 (신규 추가는 단건 생성 경로 사용)`);
      continue;
    }

    rows.push({
      id,
      labels,
      ...(text !== undefined ? { text } : {}),
      ...(regions !== undefined ? { regions } : {}),
      ...(lang !== undefined ? { lang } : {}),
    });
  }

  return { rows, warnings };
}
