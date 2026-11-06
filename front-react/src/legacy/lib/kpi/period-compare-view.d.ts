// Type-only snapshot; no database or server implementation is included.
import { type CompareKind, type CompareLedger, type CompareMetricKey, type CompareResult, type CompareUnit } from "@/lib/kpi/period-compare";
/**
 * 억제 기호 — **U+2015 HORIZONTAL BAR**. 값 없음의 em dash(U+2014)와 **다른 문자**다.
 * 칩에만 쓴다(문구에는 쓰지 않는다).
 */
export { SUPPRESSED_GLYPH, periodChipText } from "@/lib/period-chip-text";
/** 프리셋 길이(일) — 화면 라벨 키가 이 넷에 붙는다(design §10 `periodCompare.label.*`). */
export declare const PERIOD_PRESET_DAYS: {
    readonly weekly: 7;
    readonly biweekly: 14;
    readonly monthly: 30;
    readonly yearly: 365;
};
export type PeriodPresetKey = keyof typeof PERIOD_PRESET_DAYS;
/**
 * 라벨 키(`periodCompare.label.*`) — 프리셋 넷 + **달력 프리셋 넷**.
 *
 * 달력 프리셋(`thisMonth`·`lastMonth`·`thisWeek`·`lastWeek`)은 창 길이에서 파생되지
 * 않는다(9월 1~30일은 길이가 30 이지만 "지난 30일" 이 아니라 "지난달" 과 비교한다).
 * 그래서 지면이 자기가 고른 프리셋 이름을 그대로 내려주고, 못 내려주는 경우에만
 * `periodPresetKeyOf(days)` 가 창 프리셋으로 떨어진다.
 */
export type PeriodLabelKey = PeriodPresetKey | "thisMonth" | "lastMonth" | "thisWeek" | "lastWeek";
/**
 * "1년 규모" 의 하한(일). `yearly` 프리셋이 실제로 만드는 구간은 365 가 **아니라 366일**
 * 이다 — `presetRange`(`components/dash/dimension-filter-panel.tsx`)가 "1년 전 같은 날 ~
 * 끝점" 을 양 끝 포함으로 만들기 때문이고, 그 동작은 `filter-draft-sync.test.ts` 가
 * 고정하고 있다(윤년이 끼면 367). 표의 `N=365` 를 그대로 믿고 등호로 판정하면
 * **연간 전용 문구가 영영 도달하지 않는다** — 고객은 "직전 366일 구간의 …" 을 본다.
 *
 * 창 자체는 366일이어도 정합하다: 게이트웨이가 현재 창을 `(dateFrom,dateTo)` 그대로 받아
 * 직전 창을 **같은 길이**로 잡는다. 갈리는 것은 문구·라벨뿐이라 여기서 닫는다.
 */
export declare const YEAR_WINDOW_MIN_DAYS = 365;
export declare function isYearScaleWindow(days: number): boolean;
/** 창 길이 → 프리셋 키. 임의 구간(캘린더 직접 선택)이면 `null`. */
export declare function periodPresetKeyOf(days: number): PeriodPresetKey | null;
/**
 * 캡션 메시지 키 — `messages/{ko,en}.json` 의 `periodCompare.*` 와 1:1.
 *
 * | 키 | 언제 |
 * | --- | --- |
 * | `window` | 정상. "현재 N회차 / 직전 M회차 수집 기준" |
 * | `reason.noPrevWindow` | 억제 — 직전 구간의 발행 회차 0 |
 * | `reason.noPrevYear` | 억제 — 같은 조건인데 **1년 프리셋**(고객 요청 문안) |
 * | `reason.noPrevWeek` · `reason.noPrevMonth` | 같은 조건인데 달력 주·달력 월 |
 * | `reason.noDataPrev` · `reason.noDataCur` | 억제 — 이 필터로 한쪽 구간의 데이터 0 |
 * | `reason.missingShare` | 억제 — 누락 비중 ≥ 30% |
 * | `reason.startWindow` · `reason.startMonth` | 억제 — 시작 구간 / 시작 월 |
 * | `reason.unsupported` | 억제 — 집계층 표현 불가 |
 */
export type PeriodCaptionKey = "window" | "reason.noPrevWindow" | "reason.noPrevYear" | "reason.noPrevWeek" | "reason.noPrevMonth" | "reason.noDataPrev" | "reason.noDataCur" | "reason.missingShare" | "reason.startWindow" | "reason.startMonth" | "reason.unsupported";
export interface PeriodCaptionMessage {
    key: PeriodCaptionKey;
    /** ICU 파라미터. 키마다 쓰는 것만 담는다(남는 값을 넘겨도 next-intl 은 무시한다). */
    params: {
        days?: number;
        pct?: number;
        prevCycles?: number;
        curCycles?: number;
    };
}
/**
 * 비교 결과 → 캡션 한 줄.
 *
 * 억제 사유가 있으면 **사유 문구가 이긴다**(회차 문구를 함께 적지 않는다) — "왜 안
 * 보이는가" 가 "얼마나 모였는가" 보다 먼저 답해야 할 질문이기 때문이다.
 *
 * `ledgers` 는 `missingShare` 문구의 퍼센트를 만드는 데만 쓴다. 없으면 퍼센트 없는
 * 파라미터로 떨어진다(문구 자체는 같은 키다).
 */
export declare function periodCaption(r: Pick<CompareResult, "reason" | "cyclesPrev" | "cyclesCur"> & Partial<Pick<CompareResult, "missingSharePrev" | "missingShareCur">>, ctx: {
    days: number;
    kind?: CompareKind;
    prevLedger?: CompareLedger;
    curLedger?: CompareLedger;
    /** `no_data` 분기용 — 현재 구간의 데이터 회차. */
    curDataCycles?: number;
}): PeriodCaptionMessage;
export interface PeriodChip {
    key: CompareMetricKey;
    unit: CompareUnit;
    /** 억제·산식 불성립이면 `true` — 칩은 "―" 를 그린다. */
    suppressed: boolean;
    /** 절대값(부호는 `direction` 이 그린다). 억제면 `null`. */
    value: number | null;
    direction: "up" | "down" | "flat";
}
/**
 * 지표 하나 → 칩 입력.
 *
 * `delta` 가 `null` 인 경우는 둘이다 — 억제(사유 있음)와 산식 불성립(분모 0·직전 0).
 * 화면에서는 **둘 다 "―"** 다: 어느 쪽이든 "이 기간의 증감을 말할 수 없다" 는 같은
 * 명제이고, 사유는 캡션이 말한다.
 */
export declare function periodChip(m: {
    metric: CompareMetricKey;
    delta: number | null;
}): PeriodChip;
/** 화면이 그릴 순서 — 어느 화면이든 이 순서를 따른다(카드마다 순서가 갈리지 않게). */
export declare const PERIOD_CHIP_ORDER: readonly CompareMetricKey[];
export interface PeriodDeltaView {
    days: number;
    presetKey: PeriodLabelKey | null;
    caption: PeriodCaptionMessage;
    chips: PeriodChip[];
}
/**
 * `CompareResult[]` + 이 지면이 쓸 지표 목록 → view model. 순수.
 *
 * "요청한 지표가 전부 계산 불가" 는 **지면마다 다르므로** `reason` 으로 올리지 않는다
 * (같은 데이터가 화면마다 다른 사유를 갖게 되어 `reason` 의 뜻이 깨진다). 지표 집합을
 * 아는 이 계층에서 `reason.unsupported` 캡션으로 닫는다.
 */
export declare function toPeriodDeltaView(results: readonly CompareResult[], ctx: {
    days: number;
    kind?: CompareKind;
    prevLedger?: CompareLedger;
    curLedger?: CompareLedger;
    /** 현재 구간의 시작일(`YYYY-MM-DD`). 달력 주 라벨 판정 입력(W4). */
    curLo?: string;
    /** 오늘(KST). 같은 판정의 다른 한쪽. */
    todayKst?: string;
}): PeriodDeltaView;
/**
 * 라벨 키 결정. 달력 주만 종류에서 파생한다 — `calendarWeek` 는 길이가 7 이라
 * `periodPresetKeyOf` 가 `weekly`("지난 7일 대비")로 떨어지는데, 그 문구는 트레일링
 * 7일 창의 것이라 "지난주 대비" 와 다른 비교를 가리킨다.
 *
 * ⚠️ **어느 주인지까지 가른다**(검증 W4). 종전에는 `calendarWeek` 이면 무조건
 * `"thisWeek"`("지난주 대비")를 냈는데, "지난주" 프리셋의 비교 대상은 **전전주**라
 * 문장이 틀렸다. 이번 주 = 지난주 대비, 지난주 = 전전주 대비, 그 밖의 주 = 라벨 없음
 * (일반 캡션 "현재 N회차 / 직전 M회차" 로 떨어진다 — 없는 낱말을 지어내지 않는다).
 *
 * 판정 입력은 **현재 구간의 시작일**과 **오늘(KST)**이다. 둘 중 하나가 없으면
 * 종전처럼 `"thisWeek"` 로 둔다(값 없는 폴백이 문장을 바꾸지 않게).
 *
 * 달력 **월**은 건드리지 않는다(종전 동작 유지): `thisMonth`·`lastMonth` 는 어느 쪽인지
 * 날짜쌍만으로 가를 수 없고(말일에 고른 "이번 달" 과 "지난달" 이 같은 모양이다) 지면이
 * 프리셋 이름을 직접 내려주는 경로가 이미 있다(`overview-kpi-cards.tsx::preset`).
 */
export declare function labelKeyOf(ctx: {
    days: number;
    kind?: CompareKind;
    curLo?: string;
    todayKst?: string;
}): PeriodLabelKey | null;
/** 달력 월 라벨 — 현재 구간이 이번 달인가 지난달인가. 주 판정과 같은 자세다. */
export declare function monthLabelKeyOf(curLo: string | undefined, todayKst: string | undefined): PeriodLabelKey | null;
/**
 * 지면이 타일·줄에 함께 내려보내는 **라벨·캡션 문맥**. `days` 말고도 종류와 구간
 * 시작일이 필요하다 — 없으면 달력 주에서 "직전 1일 구간" 같은 틀린 문장이 나간다(W3).
 */
export interface PeriodLabelCtx {
    kind?: CompareKind;
    /** 현재 구간의 시작일(`YYYY-MM-DD`). */
    curLo?: string;
    /** 오늘(KST). */
    todayKst?: string;
}
/** 달력 주 라벨 — 현재 구간이 이번 주인가 지난주인가. */
export declare function weekLabelKeyOf(curLo: string | undefined, todayKst: string | undefined): PeriodLabelKey | null;
