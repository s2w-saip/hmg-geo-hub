// Type-only snapshot; no database or server implementation is included.
import type { BucketUnit, StandardTrendBucket } from "@/lib/db/repositories/scope-aggregates";
import type { StandardFilters } from "@/lib/scope/result-adapter";
/** Overview 카드 다섯 개의 키. `live.ts::TrendKpiKey` 와 같은 어휘다. */
export type OverviewKpiKey = "visibility" | "shareOfVoice" | "sentiment" | "position" | "citationShare";
/**
 * ⑤ 분자 — **⑤ 를 계산하는 소비자는 이 함수로만 읽는다**(제품 책임자 2026-09-29).
 *
 * 글로벌 리더는 `officialHmgCitations`(출처 카테고리 `Official (HMG)` 인용 수 — 인용 탭의
 * 카테고리 차트와 같은 분류)를 싣고, website·project 리더는 싣지 않는다. 그래서:
 *   · 필드가 있으면 → 카테고리 정의(글로벌)
 *   · 없으면        → 종전 base URL 정의(`ownedCitations`, website·project)
 * 정의·판정 근거는 `lib/kpi/official-hmg-citations.ts` 머리 주석.
 *
 * 여기에 두는 이유: 이 모듈은 클라이언트 뷰모델도 부르므로 분류기(public-suffix 스냅샷)를
 * import 하면 안 된다. 분자 **선택**만 여기 있고 **분류**는 서버 리더가 끝내 온다.
 */
export declare function citationShareNumerator(c: {
    ownedCitations: number;
    officialHmgCitations?: number;
}): number;
/**
 * 자리 하나의 카드 값들. **값이 없는 지표는 키 자체를 안 만든다**(0 과 결측을 가른다).
 *
 * 이 함수가 `live.ts` 의 `values` 블록 정본이다. 규칙 셋이 그대로 들어 있다:
 *   · 언급 계열 갭(`scope:'all'`)이거나 모수가 0 이면 **아무 값도 없다**.
 *   · 분모가 0 인 지표는 그 지표만 없다(선이 끊긴다, 0% 가 아니다).
 *   · 인용 계열 갭(`scope:'citations'`)이면 값이 남아 있어도 `citationShare` 를
 *     만들지 않는다 — 음영 위에 점이 찍히면 안 된다.
 */
export declare function overviewTrendValues(b: StandardTrendBucket): Partial<Record<OverviewKpiKey, number>>;
export interface OverviewCardDelta {
    /** 마지막 자리 − 직전 자리. 퍼센트포인트(순위는 '위'). */
    delta: number;
    /** 비교 대상 자리의 날짜 — 각주가 "직전 회차({date}) 대비" 로 쓴다. */
    basisDate: string;
}
/**
 * 지표 하나의 **직전 회차 대비 Δ**. 값이 있는 마지막 두 자리를 쓴다
 * (`live.ts::applyTrendDeltas` 와 같은 규칙: `vals.length < 2` 면 `null`).
 *
 * 입력은 `fetchStandardTrend` 가 낸 배열 그대로여야 한다 — 다른 배열을 주면 두 화면의
 * Δ 가 갈린다. 그 계약은 호출부(`server.ts::withOverviewSlots`)가 지킨다.
 */
export declare function overviewCardDelta(slots: readonly StandardTrendBucket[] | undefined, key: OverviewKpiKey): OverviewCardDelta | null;
/** Δ 전용 롤업의 버킷 단위. 정본은 여기다(`live.ts` 가 재수출한다). */
export declare const DELTA_TREND_BUCKET: BucketUnit;
/**
 * Δ 전용 추이 롤업의 필터. 사용자가 기간을 지정했으면 **그 범위를 그대로** 쓰고
 * (객체도 그대로 — `requestDeduped` 키가 화면 추이와 겹칠 여지를 남긴다),
 * 지정하지 않았으면 최근 30일로 바운드해 전 이력 스캔을 상수화한다.
 * 측정은 주 단위 cadence 라 30일이면 측정 버킷 2개가 안전하게 들어온다.
 */
export declare function deltaTrendFilters(filters: StandardFilters, now?: number): StandardFilters;
