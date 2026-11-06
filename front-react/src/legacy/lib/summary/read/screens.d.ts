// Type-only snapshot; no database or server implementation is included.
import "server-only";
export declare const SUMMARY_SCREEN_KEYS: readonly ["S1.dashboard", "S2.mention", "S3.citation", "S4.dashboard", "S4.subkpi", "S5.mention", "S6.citation", "P.dashboard", "S1.brandTrend", "S1.firstPosition", "S1.competitors", "S2.mentionTrend", "S1.periodCompare", "S1.periodRoute", "S4.periodRoute", "X.answerAnchor", "X.trendGrid", "X.websiteOwnedUnit", "X.reportTruth"];
export type SummaryScreenKey = (typeof SUMMARY_SCREEN_KEYS)[number];
/** 파싱 결과. `allowAll` 이면 목록은 무의미하다(제한 없음). */
export type ScreenAllowlist = {
    allowAll: true;
} | {
    allowAll: false;
    screens: ReadonlySet<SummaryScreenKey>;
};
/**
 * `read_screens` 원문 → allowlist. **순수 함수**(테스트가 여기부터 본다).
 *
 * - 전 화면 **허용**: 행 없음 · 빈 문자열(공백만 포함) · `'[]'` — 그 셋뿐이다.
 * - 전 화면 **차단**(빈 allowlist = 미러 폴백): 파싱 불가 · 배열 아님 ·
 *   알려진 키가 하나도 없는 배열. `warn` 을 함께 돌려준다.
 * - 알려진 키가 있으면 그 목록으로 제한하고, 섞여 있던 미지 키만 무시한다(+`warn`).
 *
 * 로깅은 여기서 하지 않는다(순수성) — 호출부가 `warn` 으로 1줄 남긴다.
 */
export declare function parseScreenAllowlist(raw: string | null | undefined): {
    list: ScreenAllowlist;
    warn: string | null;
};
/** 테스트 전용 — 파싱 메모 초기화. */
export declare function resetSummaryScreensForTests(): void;
/**
 * **기본 허용에서 빠지는 화면** — `read_screens` 에 이름이 **명시**돼 있을 때만 켜진다
 * (빈 배열 = 전 화면 허용이 이들에게는 적용되지 않는다).
 *
 * 왜 예외를 두는가: 이 둘은 x축만 바뀌는 것이 아니라 **값의 산식이 바뀐다**.
 *   · `S1.brandTrend`   — 시리즈 cap 의 모집단이 "창 전체 언급 합" → "최신 회차"
 *     (13회차 브랜드 축을 통째로 읽지 않으려는 2단 조회의 대가, PR③ 플랜 §3-4).
 *     ⚠️ **예외 하나(2026-09-29 제품 책임자 A안)**: 언급 KPI 탭 호출(`weekAxis: "S2.mentionTrend"`)
 *     이면서 격자(`X.trendGrid`)가 켜져 있으면 이 키가 꺼져 있어도 **카드 게이트
 *     (`S1.dashboard`)** 로 집계층을 탄다 — 같은 히어로의 카드(집계층 회차 스냅샷)와 추이가
 *     다른 원천을 읽던 결함(Kia·IN 9/28: 카드 29.6% · 추이 29.9%)을 닫기 위해서다.
 *     판정은 `gate.ts::applyScreenGateAligned`, 호출부는 `server.ts::fetchStandardKpiBrandTrend`
 *     한 곳이고 로그에 `opt-in-bypass:kpi-card-align` 이 붙는다. 격자 off 와 대시보드 경쟁사
 *     스파크(`weekAxis` 없음)는 여전히 이 키가 정한다(= 오늘 운영값에서 미러).
 *   · `S1.firstPosition`: 축은 이제 미러와 **같다**(2026-09-28 제품 책임자 A안): 미러 집계
 *     (`aggregateFirstPositionFromMirror`)와 이 키의 집계층 경로(`toFirstPosition(…,
 *     positionAxis: "comp")`) 둘 다 답변 안 **경쟁 순위**다(카드 ④·`S1.competitors` 와 같은 축).
 *     종전에는 미러도 이 경로도 본문 서수(`rank_sum / ranked_answers`)였다.
 *     → 그래도 옵트인에 남는 이유: 켜면 **모집단**이 미러 스냅샷 창에서 회차 원장으로
 *        바뀌고 그레인도 갈린다(미러 = 표시명 접기 · 집계층 = `brand_id` 행). 값이 움직이므로
 *        켜는 것은 운영 결정이다.
 *   · `S4.subkpi`       — S4 카드 배지의 Sub-KPI(위 "이 키를 켜면 배지 숫자가 바뀐다" 표).
 *     창·모수가 다르고 `citOwned` 는 유닛 판정 차이라, 켜면 배지 숫자가 바뀐다.
 *   · `S2.mention`·`S5.mention` — T8 의 **누적 → 회차 집합 SUM**. 화면의 "고유 프롬프트"
 *     계열 지표가 회차 합으로 바뀌는 의도적 화면 변경이고, 켜는 조건이 코드가 아니라
 *     **GGMD 확인**(P-5)이다. 코드는 머지하되 켜지 않는 것이 플랜 §6-2 의 계약인데,
 *     `read_screens='[]'`(전 화면 허용)가 그 계약을 조용히 깨고 있었다(F2) — 지금은
 *     `screens all` 로도 안 켜진다.
 * 고객이 보는 숫자가 달라지므로 스위치 없이 켜지면 안 된다 — 켜는 것은 운영 결정이다.
 * (x축만 바뀌는 `fetchStandardTrend` 는 D-4 해제로 승인된 변경이라 `S1.dashboard` 를 탄다.)
 */
export declare const SUMMARY_SCREEN_OPT_IN: ReadonlySet<SummaryScreenKey>;
/** 이 화면이 사실표 경로를 써도 되는가. 설정 읽기는 요청당 1회(30초 메모). */
export declare function summaryScreenAllowed(screen: SummaryScreenKey): Promise<boolean>;
