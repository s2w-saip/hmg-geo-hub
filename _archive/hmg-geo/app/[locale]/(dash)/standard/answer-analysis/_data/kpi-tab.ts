// 답변분석 > 언급(Mention) 화면의 4-KPI 탭 셸 — URL 규약과 순수 로직.
//
// 상태의 유일한 저장소는 URL 쿼리다(필터와 동일 원칙, filter-carry.ts 주석 참조).
// 탭도 같은 규약을 따른다: `?kpi=` 하나만 읽고 쓰며, 나머지 파라미터(필터)는
// 원문 그대로 옮긴다 — 그래서 "탭 전환 시 필터 유지"가 상태 동기화 없이 성립한다.
// 다중 선택 인코딩(FILTER_SEP)·기간 인코딩을 해석하지 않으므로 왕복 손실도 없다.
//
// 중립 모듈("use client"/"server-only" 없음): 클라이언트 탭 바(write)와 서버
// page.tsx(read)가 **같은 함수**를 써야 폴백 규칙이 갈라지지 않는다
// (customer-interest-tabs.tsx 의 normalize… 패턴과 동일).

export const KPI_TAB_PARAM = "kpi";

export const KPI_TABS = ["exposure", "sov", "favorability", "first-rank"] as const;
export type KpiTab = (typeof KPI_TABS)[number];

export const DEFAULT_KPI_TAB: KpiTab = "exposure";

/**
 * 실제 지면이 있는 탭. PR ②(노출률·점유율)에서 셸을 먼저 세우고 PR ③(2026-09-02)
 * 에서 우호도·우선 노출도가 얹혔다 — 이제 네 탭 전부다. 목록을 남겨 두는 이유는
 * 새 탭을 추가할 때 "자리만 있고 지면은 없는" 중간 상태를 표현할 수 있게 하기 위해서.
 */
export const IMPLEMENTED_KPI_TABS: readonly KpiTab[] = [
  "exposure",
  "sov",
  "favorability",
  "first-rank",
];

export function isImplementedKpiTab(tab: KpiTab): boolean {
  return IMPLEMENTED_KPI_TABS.includes(tab);
}

/**
 * `?kpi=` 파싱. 파라미터 부재·미지값·빈 문자열은 전부 exposure 폴백(스펙 SHALL).
 * 배열(중복 지정)은 첫 값만 본다 — 중복 파라미터로 탭 판정을 흔들 수 없게.
 */
export function resolveKpiTab(raw: string | string[] | undefined | null): KpiTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return DEFAULT_KPI_TAB;
  const t = v.trim();
  return (KPI_TABS as readonly string[]).includes(t) ? (t as KpiTab) : DEFAULT_KPI_TAB;
}

/**
 * 탭 링크의 쿼리 문자열 — 입력 파라미터를 복제하고 `kpi` 만 교체한다.
 * 기본 탭은 파라미터를 지운다(공유된 URL 이 `?kpi=exposure` 로 지저분해지지 않게 —
 * customer-interest-tabs 의 "default tab = no param" 규약과 동일).
 * 반환값은 `?a=b` 또는 빈 문자열이라 `pathname + query` 로 바로 이어붙일 수 있다.
 */
export function kpiTabQuery(current: URLSearchParams, tab: KpiTab): string {
  const next = new URLSearchParams(current.toString());
  if (tab === DEFAULT_KPI_TAB) next.delete(KPI_TAB_PARAM);
  else next.set(KPI_TAB_PARAM, tab);
  const s = next.toString();
  return s ? `?${s}` : "";
}
