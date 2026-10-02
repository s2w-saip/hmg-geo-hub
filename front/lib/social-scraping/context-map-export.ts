import ExcelJS from "exceljs";
import type { ContextMapExportData } from "@/components/social-scraping/types";

// "Excel 내보내기" 워크북 생성 — 구매 맥락 지도의 3개 탭을 3개 시트로 낸다.
//
// 2026-09-03: 이 버튼은 도입 이래 `toast.success("… (데모)")` 스텁이었다.
// 파일이 만들어진 적이 없다(context-map-view.tsx의 onClick). 실제 생성으로 교체하면서
// 규율 두 가지를 지킨다:
//   1) exceljs는 서버 전용 — 라이브러리가 클라이언트 번들로 넘어가지 않도록
//      /api/context-map/export 라우트에서만 import 한다(lib/prompts/excel.ts와 동일).
//   2) 시트명·헤더 문자열은 여기 하드코딩하지 않는다. 호출한 클라이언트가
//      messages/{ko,en}.json 에서 읽어 labels 로 넘긴다(경계 #4: UI 문자열은 메시지에서만).
//
// 상세(근거 인용·도메인·연결)는 일부러 제외한다 — 엔티티당 fan-out이 되어
// 페이지를 쪼갠 이유(openspec 2026-07-15-add-context-map-query)를 되돌린다.

const PERCENT_SUFFIX = "%";

export type ContextMapExportLabels = {
  sheets: {
    contexts: string;
    conditions: string;
    combinations: string;
  };
  cols: {
    name: string;
    theme: string;
    category: string;
    positive: string;
    negative: string;
    neutral: string;
    drivenConditions: string;
    drivenByContexts: string;
    mentions: string;
    conditionA: string;
    conditionB: string;
    frequency: string;
    cooccurrence: string;
  };
  frequency: {
    high: string;
    medium: string;
    low: string;
  };
};

type Cell = string | number;

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: Cell[][],
) {
  // Excel 시트명 제약: 31자 이하 + [ ] : * ? / \ 금지. 번역 문구가 이 규칙을
  // 어기면 워크북 저장 자체가 실패하므로 여기서 방어한다.
  const safe = name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet";
  const ws = wb.addWorksheet(safe);

  const header = ws.addRow(headers);
  header.font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const r of rows) ws.addRow(r);

  ws.columns.forEach((col, i) => {
    let max = headers[i]?.length ?? 10;
    for (const r of rows) {
      const len = r[i] == null ? 0 : String(r[i]).length;
      if (len > max) max = len;
    }
    col.width = Math.min(Math.max(max + 2, 10), 60);
  });

  return ws;
}

/** 3-시트 워크북을 바이트로 만든다. 순수 함수 — DB·요청 컨텍스트 없음.
 *  반환이 Buffer 가 아니라 ArrayBuffer 인 이유: 데모 화면(sample fixture)은 붙을
 *  DB 가 없어 브라우저에서 같은 빌더를 돌린다. Buffer 는 브라우저에 없다. */
export async function buildContextMapWorkbook(
  data: ContextMapExportData,
  labels: ContextMapExportLabels,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const { cols } = labels;

  addSheet(
    wb,
    labels.sheets.contexts,
    [
      cols.name,
      cols.theme,
      `${cols.positive}${PERCENT_SUFFIX}`,
      `${cols.negative}${PERCENT_SUFFIX}`,
      `${cols.neutral}${PERCENT_SUFFIX}`,
      cols.drivenConditions,
      cols.mentions,
    ],
    data.contexts.map((r) => [
      r.name,
      r.themeName,
      r.perspective.buyer,
      r.perspective.seller,
      r.perspective.neutral,
      r.linkedCount,
      r.mentionCount,
    ]),
  );

  addSheet(
    wb,
    labels.sheets.conditions,
    [
      cols.name,
      cols.category,
      `${cols.positive}${PERCENT_SUFFIX}`,
      `${cols.negative}${PERCENT_SUFFIX}`,
      `${cols.neutral}${PERCENT_SUFFIX}`,
      cols.drivenByContexts,
      cols.mentions,
    ],
    data.conditions.map((r) => [
      r.name,
      r.categoryId,
      r.perspective.buyer,
      r.perspective.seller,
      r.perspective.neutral,
      r.linkedCount,
      r.mentionCount,
    ]),
  );

  addSheet(
    wb,
    labels.sheets.combinations,
    [cols.conditionA, cols.conditionB, cols.frequency, cols.cooccurrence],
    data.combinations.map((r) => [
      r.condAName,
      r.condBName,
      labels.frequency[r.frequency],
      r.coOccurrenceCount,
    ]),
  );

  const buf = await wb.xlsx.writeBuffer();
  // exceljs types this as its own Buffer alias; normalize to a plain, exactly
  // sized ArrayBuffer so both Response and Blob accept it unchanged.
  const bytes = new Uint8Array(buf as ArrayBuffer);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
