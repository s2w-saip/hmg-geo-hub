// 글로벌 > 프롬프트 목록의 엑셀 직렬화 — **순수 함수만**.
//
// 2026-09-11 고객 요청(이노션): "화면에서 보여지는 프롬프트 리스트를 엑셀로
// 내려받기. 필터를 걸면 그 필터의 국가-언어에 맞는 프롬프트만 다운로드된다."
//
// 설계 결정 — **화면이 이미 들고 있는 배열을 그대로 직렬화한다.**
// 이 화면의 데이터는 `listStandardCatalogScoped(scope)` 가 LIMIT 없이 스코프
// 전량을 내려주고(lib/db/repositories/standards.ts:317-341), 필터는 클라이언트
// 순수 함수 `filterRows`(prompt-list-readonly.tsx:141) 가 건다. 즉 화면에는
// **이미 필터 결과 전량**이 메모리에 있다 — "현재 페이지가 아니라 필터 전량"이
// 서버 재조회 없이 그대로 성립한다.
// 서버 재조회를 택했다면 `filterRows` 의 11개 술어를 SQL 로 다시 구현해야 하고,
// 두 구현이 갈리는 순간 "화면과 다른 엑셀"이 된다. 같은 메모리 객체를 넘기는
// 것 자체가 필터 동일성의 보장이다.
//
// 판정 함수(브랜드 공통·대상 시장·브랜드 노출)는 **화면이 쓰는 모듈을 그대로
// import** 한다. 사본을 만들면 화면과 엑셀이 갈릴 수 있는 자리가 생긴다.
// 라벨만 인자로 받는다 — 경계 #4(UI 문자열은 messages/{ko,en}.json 에서만).

import { brandPresenceOf, UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import { isMarketUnset, splitMarkets } from "@/lib/standards/prompt-markets";
import type { StandardPromptViewRow } from "./prompt-list-readonly";

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

// 화면의 isCommon(prompt-list-readonly.tsx:136)과 같은 판정.
function isCommon(brand: string | null): boolean {
  return brand == null || brand === UMBRELLA_BRAND;
}

// 조건부 컬럼 — 화면의 규칙을 그대로 옮긴다.
//   · 리스트유형: listTypeOptions 가 비지 않을 때 (= rows 에 값이 하나라도 있을 때)
//   · Depth1~4 : rows.some((r) => r[key])   (prompt-list-readonly.tsx:483-494)
// 판정 모집단이 **필터 결과가 아니라 rows(전체)** 라는 점이 중요하다 — 화면이
// 그렇게 하고 있어서, 필터를 걸어 그 컬럼이 전부 비어도 컬럼은 남는다. 여기서
// 필터 결과로 판정하면 엑셀의 컬럼 구성이 화면과 달라진다.
const DEPTH_KEYS = ["depth1", "depth2", "depth3", "depth4"] as const;
type DepthKey = (typeof DEPTH_KEYS)[number];

export function visibleDepthColumns(all: StandardPromptViewRow[]): DepthKey[] {
  return DEPTH_KEYS.filter((k) => all.some((r) => r[k]));
}

export function showsListTypeColumn(all: StandardPromptViewRow[]): boolean {
  return all.some((r) => r.listType);
}

/**
 * 대상 시장 셀 — 화면 배지(MarketCell)의 텍스트판.
 * 순서는 화면의 `+N` 툴팁과 같은 `[...실국가, ...의사코드]`. 접기(상위 3개)는
 * 하지 않는다 — 접기는 좁은 화면의 제약이지 데이터의 성질이 아니다.
 */
export function marketCellText(
  regions: string[] | null,
  labels: Pick<StandardPromptExportLabels, "marketAll">,
  fmt: Pick<StandardPromptExportFormatters, "market">,
): string {
  if (isMarketUnset(regions)) return labels.marketAll;
  const { real, pseudo } = splitMarkets(regions);
  return [...real, ...pseudo].map((c) => fmt.market(c)).join(" · ");
}

/**
 * 화면에 보이는 행 배열(`sorted`)을 그대로 시트로 직렬화한다.
 *
 * @param visible 필터·검색·정렬이 적용된 **전량** (페이지 슬라이스 전의 배열).
 * @param all     컬럼 노출 판정용 모집단 — 화면과 동일하게 전체 rows.
 */
export function buildStandardPromptSheet(
  visible: StandardPromptViewRow[],
  all: StandardPromptViewRow[],
  labels: StandardPromptExportLabels,
  fmt: StandardPromptExportFormatters,
): StandardPromptExportSheet {
  const withListType = showsListTypeColumn(all);
  const depths = visibleDepthColumns(all);

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

  const rows = visible.map((r): ExportCell[] => {
    const presence = brandPresenceOf(r.brand, r.brandPresence);
    return [
      r.text,
      isCommon(r.brand) ? labels.common : (r.brand ?? ""),
      ...(withListType ? [r.listType ?? ""] : []),
      ...depths.map((k) => r[k] ?? ""),
      r.funnelStage ?? "",
      marketCellText(r.regions, labels, fmt),
      r.lang ? fmt.language(r.lang) : "",
      presence === "branded"
        ? labels.branded
        : presence === "unbranded"
          ? labels.unbranded
          : "",
      r.kind === "acr" ? labels.kindAcr : labels.kindSingle,
      r.scopePromptId === null ? labels.statusUnmeasured : labels.statusMeasured,
    ];
  });

  return { headers, rows };
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
