// Type-only snapshot; no database or server implementation is included.
import "server-only";
/** 스위치 계열(read_enabled·read_screens)이 공유하는 프로세스 내 메모 TTL. */
export declare const MEMO_TTL_MS = 30000;
/** 테스트 전용 — 메모 상태 초기화. */
export declare function resetSummarySettingsForTests(): void;
/** 테스트 전용 — DB 없이 스위치 값을 고정한다. */
export declare function setSummaryReadEnabledForTests(value: boolean): void;
/** `summary_settings.read_enabled = '1'` 인가. 실패·미적용은 전부 false(폴백). */
export declare function readEnabled(): Promise<boolean>;
/** 테스트 전용 — read_screens 메모 초기화. */
export declare function resetSummaryScreensSettingForTests(): void;
/** `summary_settings.read_screens` 원문(JSON 문자열). 요청당 1회·30초 메모. */
export declare function readScreensRaw(): Promise<string | null>;
/**
 * 0059 의 회차 원장·사실표를 쓸 수 있는가. 표 전체가 한 마이그레이션(= 한 트랜잭션)
 * 에서 생기므로 대표 컬럼 하나만 본다 — `anchorRegistryAvailable`(0053)·
 * `dropRegistryAvailable`(0054) 와 같은 자세. 표가 없으면 `to_regclass` 가 NULL 이라
 * 프로브가 false 를 돌려주고 조회는 **무조건 미러 폴백**이다.
 *
 * 이 리포는 머지 = 무인 배포이고 마이그레이션은 사람이 따로 적용하므로, 코드가
 * 원장 없는 DB 에 먼저 갈 수 있다(그 반대도).
 */
export declare function summaryLedgerAvailable(): Promise<boolean>;
/**
 * 0060 의 **유닛 고유 플래그**(보고서 v2.4 정합)를 쓸 수 있는가.
 * `summary_answers.unit_owned` / `unit_target` / `report_fs`,
 * `summary_domain_citations.unit_owned_citations`,
 * `summary_prompt_dim.unit_base` / `report_fs` 가 한 마이그레이션에서 함께 생기므로
 * 대표 컬럼 하나만 본다(0052~0054 와 같은 자세). 없으면 종전 판정 경로로 폴백한다.
 */
export declare function summaryUnitFlagsAvailable(): Promise<boolean>;
export declare function websiteExcludedUnits(): Promise<number[]>;
/** 테스트 전용 — period_compare_epoch 메모 초기화. */
export declare function resetPeriodCompareEpochForTests(): void;
/** `summary_settings.period_compare_epoch` (`YYYY-MM-DD`). 없음·오류·형식 불일치 = null. */
export declare function periodCompareEpochRaw(): Promise<string | null>;
