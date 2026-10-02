// 웹사이트 > 프롬프트 목록의 엑셀 직렬화 — **순수 함수만**(라우트에서 테스트 분리).
//
// 컬럼은 화면(prompt-table.tsx)의 <th> 순서 그대로다. 정렬 아이콘·링크·배지 같은
// 표현 요소만 빠지고 값은 같다. 라벨은 인자로 받는다 — 경계 #4(UI 문자열은
// messages/{ko,en}.json 에서만).

import type { WebsitePromptViewRow } from "@/lib/db/repositories/website-sites";

export interface WebsitePromptExportLabels {
  prompt: string;
  brand: string;
  country: string;
  lang: string;
  targetUrl: string;
  answers: string;
  lastMeasured: string;
  engines: string;
  /** 측정 이력이 없는 행의 '최근 측정' 셀 — 화면과 같은 문구. */
  notMeasured: string;
}

export interface WebsitePromptExportFormatters {
  country: (code: string) => string;
  language: (code: string) => string;
}

export type ExportCell = string | number;

export interface WebsitePromptExportSheet {
  headers: string[];
  rows: ExportCell[][];
}

/**
 * 최근 측정 = KST 달력일 `YYYY-MM-DD`.
 *
 * 화면은 `Intl.DateTimeFormat(locale, {dateStyle:"medium", timeZone:"Asia/Seoul"})`
 * 로 "2026. 9. 8." 처럼 그린다. 엑셀에서는 그 문자열이 정렬되지 않아 쓸모가 떨어져
 * **같은 날짜를 정렬 가능한 형태로** 적는다(시간대는 화면과 동일한 Asia/Seoul —
 * 달력일 자체는 절대 어긋나지 않는다). 형식만 다르고 값은 같다.
 */
export function lastMeasuredCell(iso: string | null, notMeasured: string): string {
  if (!iso) return notMeasured;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return notMeasured;
  // en-CA = YYYY-MM-DD. 시간대를 지정해야 UTC 서버에서 KST 달력일이 나온다.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function buildWebsitePromptSheet(
  rows: WebsitePromptViewRow[],
  labels: WebsitePromptExportLabels,
  fmt: WebsitePromptExportFormatters,
): WebsitePromptExportSheet {
  const headers = [
    labels.prompt,
    labels.brand,
    labels.country,
    labels.lang,
    labels.targetUrl,
    labels.answers,
    labels.lastMeasured,
    labels.engines,
  ];

  return {
    headers,
    rows: rows.map((r): ExportCell[] => [
      r.promptText,
      r.brand,
      fmt.country(r.countryCode),
      fmt.language(r.langCode),
      r.targetUrl,
      // 화면은 0 을 "—" 로 그리지만 엑셀에서는 숫자 0 이 맞다(합계·필터가 걸린다).
      r.answers,
      lastMeasuredCell(r.lastMeasuredAt, labels.notMeasured),
      r.engines.join(", "),
    ]),
  };
}
