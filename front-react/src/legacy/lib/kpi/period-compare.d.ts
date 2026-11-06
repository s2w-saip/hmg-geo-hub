// Type-only snapshot; no database or server implementation is included.
/** UTC 일(`YYYY-MM-DD`). 구간 멤버십의 시간축은 UTC 다(design §1-1: 표시만 KST). */
export type Day = string;
export declare function isDay(v: unknown): v is Day;
export declare function assertDay(v: string, label?: string): Day;
/** 일 오프셋. 월 산술(MoM `momMonthMinus`)을 대체하는 것이 이 함수 하나다. */
export declare function addDays(d: Day, n: number): Day;
/** 두 날의 차(일). `diffDays(a, a) = 0`. */
export declare function diffDays(from: Day, to: Day): number;
/**
 * 증감의 단위.
 *
 * | 값 | 산식 | 왜 |
 * | --- | --- | --- |
 * | `pp` | `(cur − prev) × 100` | 0~1 비율 지표 |
 * | `pct` | `(cur − prev) / prev × 100` | 답변 1건당 건수 — 직전 0 이면 `null` |
 * | `rank` | `cur − prev` | 평균 순위는 %p 가 성립하지 않는다(2.5 → 250 이 된다) |
 */
export type CompareUnit = "pp" | "pct" | "rank";
/**
 * 비교의 종류. 달력 월·달력 주는 창 비교의 **위에 얹히는** 정책이고, 구간이 어디까지나
 * `{key, lo, hi}` 라 **같은 산식·같은 리더**를 탄다. 종류가 가르는 것은 셋뿐이다:
 * 누락 임계의 적용 여부(`appliesMissingShare`) · 시작 구간 판정(`start_*`) · 라벨.
 *
 * `calendarWeek` 는 앵커 축의 주 버킷(`ca.anchor_week` = KST 주의 월요일)과 같은 경계를
 * 쓴다. 글로벌 회차는 그 주의 월요일, 웹사이트 회차는 그 주의 금요일에 귀속되므로
 * (스펙 §9.2 정규 요일) **한 주 버킷에 표면별 정규 회차가 정확히 하나** 들어온다 —
 * "글로벌은 월요일 회차끼리, 웹사이트는 금요일 회차끼리" 가 주 경계 하나로 성립한다.
 */
export type CompareKind = "window" | "calendarMonth" | "calendarWeek";
/**
 * 지표 어휘 — **산식**의 어휘다(화면·i18n 이 아니다).
 *
 * ⚠️ **⑤ AI 인용 점유율은 여기 없다**(design §6-2). 집계층 `summary_trend_own.own_citations`
 * (무필터 5.30%)와 화면 정본인 도메인 표(10.39%)가 갈린다 → 후속(tasks 7.1).
 *
 * ⚠️ 웹사이트 "자사 URL 수"·"타겟 URL 수"(design §6-1)도 없다 — `summary_trend_own` 에
 * 그 컬럼이 없다(2026-09-18 실측: 41컬럼에 URL 계열 0). 원천이 정해지면 `pct` 로 붙는다.
 */
export type CompareMetricKey = "visibility" | "share" | "favorability" | "position" | "mentionsPerAnswer" | "citationsPerAnswer";
export declare const COMPARE_METRIC_UNITS: Readonly<Record<CompareMetricKey, CompareUnit>>;
/** 지표 계열 — `hidden_scope='citations'` 회차를 세는 방식을 가르는 축(design §6-3). */
export type CompareFamily = "mention" | "citation";
/**
 * 지표 → 계열. **`Record` 이지 `Set` 이 아니다.** 지표를 더하면 계열을 적지 않는 한
 * 컴파일이 깨진다 — "`family` 에 기본값을 두지 않는다"(tasks 2.3)를 타입으로 집행한다.
 * `Set` 이면 빠뜨린 지표가 조용히 언급 계열로 떨어진다(fail-open).
 */
export declare const COMPARE_METRIC_FAMILY: Readonly<Record<CompareMetricKey, CompareFamily>>;
/**
 * 억제 사유 — 정확히 여섯.
 *
 * | 사유 | 조건 |
 * | --- | --- |
 * | `unsupported` | 집계층 표현 불가(`depth2`·`depth3`·다중 브랜드) |
 * | `no_prev` | 직전 구간의 **발행 회차** 0 (원장 기준 — 필터 무관) |
 * | `no_data` | **이 필터로** 어느 한쪽 구간의 데이터 회차 0 |
 * | `missing_share` | 누락 비중 ≥ 30% (창 비교는 30일 이상, 달력 월은 항상, 달력 주는 없음) |
 * | `start_window` | 창 비교·달력 주 — 직전 구간이 측정 시작 구간에 걸친다 |
 * | `start_month` | 달력 월 전용 — 직전 달이 측정 시작 월 |
 *
 * `before_epoch` 는 **사유가 아니다**: 게이트웨이가 `null` 을 돌려주므로 여기 오지 않는다.
 */
export type SuppressionReason = "unsupported" | "no_prev" | "no_data" | "missing_share" | "start_window" | "start_month";
/**
 * 우선순위 — **위에서 아래**.
 *
 * `unsupported` 가 맨 앞인 이유: 그 상태에서는 다른 사유를 **판정할 입력 자체가 없다**.
 * `start_window`·`start_month` 는 상호 배타(종류가 다르면 발화하지 않는다)라 순서가
 * 서로에 대해 무의미하고, 둘 다 맨 뒤다 — 정량 사유(`missing_share`)가 구조 분류보다
 * 고객에게 쓸모 있다(MoM 2026-09-17 재교정과 같은 판단).
 */
export declare const SUPPRESSION_PRECEDENCE: readonly SuppressionReason[];
export interface CompareMeasure {
    numerator: number;
    denominator: number;
}
/**
 * 구간 하나의 **회차 원장 요약**.
 *
 * `plannedUnits`·`missingUnits`·`publishedCycles` 는 **필터 무관**(표면 원장 기준)이다 —
 * 누락 비중의 분모를 필터로 좁히면 같은 구간의 억제 여부가 화면마다 갈린다.
 * `dataCycles` 만 **필터 적용 후**의 수다(둘의 차이가 `no_data` 를 만든다).
 */
export interface CompareLedger {
    /** Σ `expected_units` (구간 안 전체 회차). */
    plannedUnits: number;
    /** Σ `expected_units` (구간 안 **미발행** 회차). */
    missingUnits: number;
    /** 발행된(= 노출 가능한) 회차 수. */
    publishedCycles: number;
    /** **이 필터로** 데이터가 있었던 회차 수. */
    dataCycles: number;
    /**
     * 계획 수집량을 **알 수 있는가**. 생략(`undefined`)이면 `plannedUnits > 0` 으로 본다 —
     * 종전 동작과 같다.
     *
     * `false` 인 경우는 "빠진 게 없다" 가 아니라 **"누락 비중을 판정할 근거가 없다"** 다.
     * 원장에 회차가 아예 없는 표면(프로젝트 표면은 `summary_cycles` 에 노출 가능 회차가
     * 0건이다)과, 회차는 있는데 `expected_units` 가 전부 NULL 인 구간(측정 유닛 미부여)이
     * 여기 해당한다. 그때 `missingShare` 는 0 을 돌려주는데, 그 0 을 "누락 0%" 로 읽어
     * 비교를 그대로 내보내면 **모르는 것을 안다고 말하는 것**이 된다.
     *
     * 그래서 판정은 `missing_share` 억제를 **건너뛰고**(0 을 임계와 견주지 않는다) 캡션은
     * 회차 수 병기(`window`)로 남긴다. 회차가 아예 없으면 그 앞에서 `no_prev` 가 답한다 —
     * 이 상태를 위해 새 억제 사유를 만들지 않는 이유다.
     */
    plannedKnown?: boolean;
    /**
     * 그 **범위(표면 × 프로젝트 집합)의 전 이력 첫 발행 회차 앵커일**. `null` = 모름.
     *
     * ⚠️ **"이 구간 안의 첫 회차" 가 아니다.** 구간 안으로 재면 회차가 드문 구간이 전부
     *    시작 구간으로 오분류된다 — 실측 반례: 웹사이트 7일 직전 창(`08-29~09-04`)의
     *    창 내 첫 발행은 `09-04` 라 `grace(7)=2` 를 넘지만, 전 이력 첫 발행은 `2026-07-02`
     *    이므로 그 창은 시작 구간이 아니다. 구간마다 같은 값이 들어오는 것이 정상이다.
     */
    firstPublishedAnchor: Day | null;
}
/** 비교 단위 하나(구간). 창이든 달력 월이든 같은 모양이다. */
export interface ComparePeriod {
    /** 창: `'YYYY-MM-DD..YYYY-MM-DD'` · 월: `'YYYY-MM'`. 리더의 `windows[].key` 와 같다. */
    key: string;
    /** UTC 일, **양 끝 포함**. */
    lo: Day;
    hi: Day;
    measures: Partial<Record<CompareMetricKey, CompareMeasure>>;
    ledger: CompareLedger;
}
export interface CompareResult {
    metric: CompareMetricKey;
    unit: CompareUnit;
    /** 구간 합계 분자 ÷ 구간 합계 분모. 분모 0 → `null`. */
    prev: number | null;
    cur: number | null;
    /** 억제됐거나 산식이 성립하지 않으면 `null`. */
    delta: number | null;
    suppressed: boolean;
    reason: SuppressionReason | null;
    /** 캡션용 — **억제일 때도 채운다**(그때가 오히려 더 필요하다). */
    cyclesPrev: number;
    cyclesCur: number;
    plannedPrev: number;
    plannedCur: number;
    /**
     * 구간별 **누락 비중**(0~1) — `missingShare(ledger)` 와 같은 값.
     *
     * 왜 결과에 싣는가: `periodCompare.reason.missingShare` 문구가 "계획의 {pct}% 에 그쳐"
     * 라서 **수집 비율**이 필요한데, 게이트웨이가 화면에 돌려주는 것은 `CompareResult[]`
     * 뿐이고 `ComparePeriod.ledger` 는 넘어가지 않는다. `plannedPrev` 만으로는 못 만든다
     * (미발행 단위 수가 없다). 원장을 통째로 직렬화하는 대신 이미 계산한 비율 하나만 싣는다.
     */
    missingSharePrev: number;
    missingShareCur: number;
}
/**
 * 누락 비중 억제 임계 — **경계 포함**(`>=`). 정확히 30% 도 억제다.
 * MoM 정책 확정(2026-09-17)과 같은 값이고, 기간 비교 쪽 정본은 이 상수 하나다.
 */
export declare const MISSING_SHARE_MAX = 0.3;
/**
 * 누락 임계를 적용하는 **최소 창 길이**(일). 창 비교에만 쓴다.
 *
 * 근거(제품 책임자 방향 2): 7·14일 창은 회차가 1~3개라 30% 임계가 "회차 하나 미발행" 으로
 * 곧바로 걸려 억제가 기본값이 된다. 그 창들은 한쪽 창의 **발행 회차 0** 일 때만 억제한다.
 * 달력 월은 MoM 정책 그대로 **항상** 적용한다.
 */
export declare const MISSING_SHARE_MIN_WINDOW_DAYS = 30;
/**
 * **적용일**(제품 결정 Q6=b: 적용일 이후만). 상수는 이 파일 **한 곳**이다.
 *
 * 게이트는 게이트웨이 진입부가 `cur.hi >= PERIOD_COMPARE_EPOCH` 로 걸고, 미달이면
 * `null`(종전 Δ)을 돌려준다. 이 모듈은 상수와 순수 판정만 제공하고 **분기를 두지 않는다**.
 *
 * 값 2026-09-08(제품 책임자 2026-09-18 결정): 배포 시점의 최신 공개 회차(글로벌 09-13·웹사이트 09-11)가
 * 첫 적용 대상이 되게 한다. 09-19 로 두면 앵커 ≥09-19 회차가 공개될 때까지 전 지면이 null 이라
 * 9/21 QA 에서 기능이 보이지 않는다.
 */
export declare const PERIOD_COMPARE_EPOCH = "2026-09-08";
/** 적용일 판정(순수). 게이트 위치는 `fetchPeriodCompare` 진입부다. */
export declare function periodCompareApplies(curHi: string, epoch?: Day): boolean;
/**
 * `start_window` 유예(일) — **창 길이에 비례**한다(design §5-2).
 *
 * MoM 조항 ⑤ 의 "그 달 첫째 주 7일" 은 달력 월 전용이라 그대로 옮길 수 없다.
 * 30일의 7일 ≈ N/4 를 보존해 `ceil(N/4)` 로 일반화: 7→2 · 14→4 · 30→8 · 365→92.
 *
 * 대안 (a) 유예 없음 → 첫 창 다음 창까지 억제된다. (b) 7일 고정 → 7일 창에서 유예가
 * 창 전체와 같아져 무의미해진다. 비례가 MoM 의 의도(월의 첫 주 ≈ 창의 첫 1/4)를
 * 유일하게 보존한다.
 */
export declare function graceDays(days: number): number;
/** 달력 월의 "첫째 주" 상한(MoM `MOM_START_WEEK_LAST_DAY` 와 같은 값·같은 근거). */
export declare const START_MONTH_FIRST_WEEK_LAST_DAY = 7;
/**
 * 달력 주의 길이(일). `start_window` 유예를 창 길이에서 읽지 않고 **7 로 고정**하는 이유:
 * 진행 중인 주의 현재 구간은 부분 주(월~금 5일 등)라 `cur` 의 길이로 재면 유예가
 * 주마다 흔들린다(5일이면 `grace=2`, 3일이면 `grace=1`). 직전 주는 언제나 온전한 7일이다.
 */
export declare const CALENDAR_WEEK_DAYS = 7;
/** **양 끝 포함** 구간. `lo <= hi` 가 불변식이다. */
export interface CompareWindow {
    lo: Day;
    hi: Day;
}
/** 구간 길이(일). 양 끝 포함이라 `hi − lo + 1`. */
export declare function windowLength(w: CompareWindow): number;
/**
 * 프리셋 길이 → 두 창. **정본 수식**(design §1, §15 계약).
 *
 * ```
 * cur  = [ E − (N−1) , E ]
 * prev = [ E − (2N−1) , E − N ]
 * ```
 *
 * 두 창은 길이가 같고(각 N일), 겹치지 않으며 맞닿는다(`cur.lo − 1 = prev.hi`).
 * 이 함수는 **클램프를 하지 않는다** — `minDay` 클램프는 `clampWindowLo` 로 분리했고,
 * **현재 창에만** 건다(아래 주석).
 */
export declare function resolveWindows(endDay: string, days: number): {
    cur: CompareWindow;
    prev: CompareWindow;
};
/**
 * 수집 시작일(`minDay`) 클램프 — **현재 창에만** 건다.
 *
 * ⚠️ 직전 창에 걸면 길이가 달라져 비교 자체가 깨진다. 직전 창이 수집 시작일 앞으로
 *    삐져나가는 것은 클램프 대상이 아니라 `start_window` **억제** 대상이다(design §1).
 *    이 뮤테이션(`prev` 에도 클램프)은 테스트가 죽인다.
 */
export declare function clampWindowLo(w: CompareWindow, minDay?: Day | null): CompareWindow;
/** 창 키 — 리더의 `windows[].key` 규약(`'YYYY-MM-DD..YYYY-MM-DD'`). */
export declare function windowKey(w: CompareWindow): string;
/**
 * **임의 날짜쌍** → 두 창. 캘린더로 직접 고른 구간이 프리셋과 같은 규칙을 타는 진입점.
 * `N = to − from + 1` 을 읽어 `resolveWindows` 에 위임한다 — 창 수식이 두 벌이 되지 않게.
 */
export declare function windowsFromRange(from: string, to: string): {
    days: number;
    cur: CompareWindow;
    prev: CompareWindow;
};
/** 누락 비중 = 미발행 회차의 계획 단위 합 ÷ 집계 대상 회차의 계획 단위 합. */
export declare function missingShare(l: CompareLedger): number;
/**
 * 그 구간의 누락 비중을 **판정할 수 있는가**(`CompareLedger.plannedKnown` 주석 참조).
 *
 * 기본값이 `plannedUnits > 0` 이라 이 술어를 끼워도 종전 판정은 한 건도 바뀌지 않는다:
 * 계획 단위가 0 이면 `missingShare` 가 어차피 0 이라 임계(0.3)에 닿지 않았다.
 * 달라지는 것은 **의미**다 — "누락 0%" 가 아니라 "모른다" 로 읽힌다.
 */
export declare function missingShareKnown(l: CompareLedger): boolean;
export interface CompareOptions {
    kind: CompareKind;
    /** 창 길이 N. `kind: "window"` 에서 미지정이면 `cur` 의 길이에서 읽는다. */
    days?: number;
    /** 달력 월 전용 — **전전월** 구간(조항 ⑤ 1단계 입력). */
    before?: ComparePeriod;
    /** 이 지면이 요청한 지표. 결과는 이 순서를 따른다. */
    metrics: readonly CompareMetricKey[];
    /** 집계층 표현 불가(`planTrendRead` 가 `ok:false`) — `unsupported` 억제. */
    unsupported?: boolean;
}
/**
 * 이 비교에 누락 30% 임계를 적용하는가.
 *
 * **달력 주도 적용한다**(검증 W6, 2026-09-20 정정). 종전 코드는 "한 주 버킷에는 정규
 * 회차가 하나뿐이라 비중이 0% 아니면 100%" 라는 이유로 껐는데, 그 전제가 틀렸다:
 * 원장은 **(프로젝트 × 회차)마다 한 행**이고 `plannedUnits` 는 그 행들의
 * `expected_units` 합이다. 웹사이트 함대는 한 회차에 90개 넘는 프로젝트가 들어오므로
 * 그중 일부만 발행되면 비중은 0~100% 사이의 연속값이다(정확히 임계가 잡아야 할 모양).
 *
 * 확정 요구사항 A안·계약 §3·스펙 §5.2 어디에도 주 단위 예외가 없다. 산식도 월과 같은
 * 정의를 그대로 쓴다(빠진 회차의 계획 수집량 ÷ 그 구간의 계획 수집량).
 *
 * 창 비교만 길이 하한(`MISSING_SHARE_MIN_WINDOW_DAYS`)을 둔다 — 짧은 트레일링 창은
 * 회차 경계와 무관하게 잘려 비중이 구조적으로 커진다.
 */
export declare function appliesMissingShare(opts: {
    kind: CompareKind;
    days: number;
}): boolean;
/**
 * 직전 **창**이 측정 시작 구간인가 — `F > prev.lo + grace(N)`.
 *
 * `F` 는 **전 이력** 첫 발행 앵커다(`CompareLedger.firstPublishedAnchor` 주석의 반례 참조).
 * 모르면(`null`) 억제하지 않는다 — 모르는 것을 억제 사유로 쓰지 않는다.
 */
export declare function judgeStartWindow(a: {
    firstPublishedAnchor: Day | null;
    prevLo: Day;
    days: number;
}): boolean;
/**
 * 직전 **달**이 측정 시작 월인가 — MoM 조항 ⑤ 를 `F` 하나로 단순화한 판정(design §7).
 *
 * 1. 전전월(`before`)에 **이 필터의 데이터가 있으면** → 시작 월이 아니다. 여기서 끝.
 * 2. 없으면 `F`(전 이력 첫 발행 앵커)가 **그 달 안**이고 그 **일자가 첫째 주(7일)를
 *    넘으면** 시작 월이다. 달 첫 회차부터 측정했다면 전전월이 비어 있어도 **온전한 달**
 *    이다(정책 표: 첫 회차 전 인입 → 2개월째에 첫 비교).
 *
 * MoM 의 프로젝트별 2단 판정(`judgeMomStartMonth`)은 여기 없다 — 그 판정은 원장을 세 달로
 * 넓혀 프로젝트 축을 함께 읽어야 하는데, 이 계층의 예산은 **문장 2개**다. `before` 구간을
 * `windows` 에 한 원소 더 넣는 것으로 1단계를 사고, 2단계는 `F` 로 근사한다.
 */
export declare function judgeStartMonth(a: {
    firstPublishedAnchor: Day | null;
    prevLo: Day;
    prevHi: Day;
    beforeDataCycles: number;
}): boolean;
export declare function suppressionOf(prev: ComparePeriod, cur: ComparePeriod, opts: CompareOptions): SuppressionReason | null;
declare function ratio(m: CompareMeasure | undefined): number | null;
declare function deltaOf(unit: CompareUnit, prev: number | null, cur: number | null): number | null;
/**
 * 두 구간의 합계 + 회차 원장 → 지표별 비교 결과.
 *
 * 억제되더라도 `prev`·`cur`·회차 수는 그대로 채운다 — 화면이 "―" 를 그리면서
 * "현재 2회차 / 직전 1회차 수집 기준" 을 함께 적어야 하기 때문이다.
 * **`delta` 만 `null` 이 된다.**
 */
export declare function computeCompare(prev: ComparePeriod, cur: ComparePeriod, opts: CompareOptions): CompareResult[];
/** 테스트가 내부 조각을 직접 단언할 수 있게 노출한다(산식 뮤턴트 그물). */
export declare const __testables: {
    ratio: typeof ratio;
    deltaOf: typeof deltaOf;
};
export {};
