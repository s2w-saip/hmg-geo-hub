// 글로벌 > 프롬프트 목록의 엑셀 직렬화 — **순수 함수만**.
//
// 2026-09-11 고객 요청(이노션): "화면에서 보여지는 프롬프트 리스트를 엑셀로
// 내려받기. 필터를 걸면 그 필터의 국가-언어에 맞는 프롬프트만 다운로드된다."
//
// 행·순서·컬럼은 화면과 같은 screen(catalog/prompts-export)이 정한다 — 필터·검색·정렬이
// 같은 질의로 같은 서버 코드를 지나므로 "화면과 다른 엑셀"이 생길 자리가 없다.
// 여기서는 받은 값을 셀 문구로 옮기기만 한다. 라벨은 인자로 받는다 — 경계 #4(UI
// 문자열은 messages/{ko,en}.json 에서만).

import type { PromptRow } from "../_data/screen-types";

export interface StandardPromptExportLabels {
  // 컬럼 헤더 — 화면 <th> 와 같은 i18n 키에서 온다.
  text: string;
  brand: string;
  listType: string;
  depth1: string;
  depth2: string;
  depth3: string;
  depth4: string;
  funnel: string;
  market: string;
  lang: string;
  presence: string;
  kind: string;
  status: string;
  // 셀 값 — 화면 배지와 같은 문구.
  common: string;
  marketAll: string;
  branded: string;
  unbranded: string;
  kindAcr: string;
  kindSingle: string;
  statusMeasured: string;
  statusUnmeasured: string;
}

export interface StandardPromptExportFormatters {
  /** 대상 시장 코드 → 표시 라벨 (실국가명 또는 의사코드 i18n 라벨). */
  market: (code: string) => string;
  /** 언어 코드 → 표시 언어명. */
  language: (code: string) => string;
}

export type ExportCell = string | number;

export interface StandardPromptExportSheet {
  headers: string[];
  rows: ExportCell[][];
}

const DEPTH_KEYS = ["depth1", "depth2", "depth3", "depth4"] as const;

/**
 * 대상 시장 셀 — 화면 배지(MarketCell)의 텍스트판. 순서는 화면의 `+N` 툴팁과 같은
 * `[...실국가, ...의사코드]`. 접기(상위 3개)는 하지 않는다 — 접기는 좁은 화면의 제약이지
 * 데이터의 성질이 아니다.
 */
export function marketCellText(
  markets: PromptRow["markets"],
  labels: Pick<StandardPromptExportLabels, "marketAll">,
  fmt: Pick<StandardPromptExportFormatters, "market">,
): string {
  const codes = [...markets.real, ...markets.pseudo];
  return codes.length ? codes.map((c) => fmt.market(c)).join(" · ") : labels.marketAll;
}

/**
 * 내보내기 행(필터·검색·정렬이 적용된 **전량**)을 시트로 옮긴다. columns = 화면의 분류
 * 컬럼(리스트유형·Depth1~4 중 값이 있는 것) — 화면과 같은 컬럼 구성.
 */
export function buildStandardPromptSheet(
  rows: PromptRow[],
  columns: readonly string[],
  labels: StandardPromptExportLabels,
  fmt: StandardPromptExportFormatters,
): StandardPromptExportSheet {
  const withListType = columns.includes("listType");
  const depths = DEPTH_KEYS.filter((k) => columns.includes(k));

  const headers = [
    labels.text,
    labels.brand,
    ...(withListType ? [labels.listType] : []),
    ...depths.map((k) => labels[k]),
    labels.funnel,
    labels.market,
    labels.lang,
    labels.presence,
    labels.kind,
    labels.status,
  ];

  const cells = rows.map((r): ExportCell[] => [
    r.text,
    r.common ? labels.common : (r.brand ?? ""),
    ...(withListType ? [r.listType ?? ""] : []),
    ...depths.map((k) => r[k] ?? ""),
    r.funnelStage ?? "",
    marketCellText(r.markets, labels, fmt),
    r.lang ? fmt.language(r.lang) : "",
    r.presence === "branded" ? labels.branded : r.presence === "unbranded" ? labels.unbranded : "",
    r.kind === "acr" ? labels.kindAcr : labels.kindSingle,
    r.scopePromptId === null ? labels.statusUnmeasured : labels.statusMeasured,
  ]);

  return { headers, rows: cells };
}

/**
 * 다운로드 파일명 — `<stem>-YYYY-MM-DD.xlsx`. stem 은 i18n 에서 온다.
 * 날짜는 넘겨받은 Date 의 **로컬 달력일**(사용자가 보는 날짜).
 */
export function exportFilename(stem: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  return `${stem}-${day}.xlsx`;
}
