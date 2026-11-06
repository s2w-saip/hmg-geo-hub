// Type-only snapshot; no database or server implementation is included.
import "server-only";
/** 격자 전환을 켜는 화면 키. 설계 §9-1 에서 이름이 고정돼 있다. */
export declare const TREND_GRID_SCREEN_KEY: "X.trendGrid";
/** 이 배포에서 env 오버라이드를 읽어도 되는 환경인가(`anchor-axis-flag.ts` 와 같은 규칙). */
export declare function trendGridOverrideAllowedHere(env?: NodeJS.ProcessEnv): boolean;
/** env 오버라이드가 **지금 켜져 있는가**. 환경 검사까지 포함한 최종 판정. */
export declare function trendGridForced(env?: NodeJS.ProcessEnv): boolean;
/**
 * 이 요청에서 추이가 **격자 판본**을 쓰는가. 판정은 두 겹이고 **둘 다** 참이어야 한다.
 *
 * 순서가 계약이다: ① 스위치(env 는 왕복 0, 화면 키는 30초 메모) → ② 선행 축.
 * 스위치가 꺼져 있으면 축 판정을 **건드리지 않는다** — 오늘 프로덕션(키 off)에서 이
 * 모듈 때문에 늘어나는 일이 0 이어야 하기 때문이다. 반대로 축이 꺼져 있으면 스위치가
 * 무엇이든 false 다(위 머리 주석의 선행 조건).
 */
export declare function trendGridEnabled(): Promise<boolean>;
/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export declare function resetTrendGridForTests(): void;
/**
 * 테스트 전용 — DB 없이 판정값을 고정한다.
 * `preCatalog` 를 생략하면 **빈 목록**(= 종전 게이트)이다.
 */
export declare function setTrendGridForTests(value: boolean, preCatalog?: readonly string[]): void;
export declare function ensureTrendGrid(): Promise<boolean>;
/**
 * 동기 SQL 빌더가 읽는 **카탈로그 도입 전 회차 목록**.
 *
 * 격자 판정과 **같은 state·같은 만료**에서 나온다 — 그래서 "격자는 켜졌는데 목록만
 * 비어 있는" 구간이 없다. 미확정·판정 실패는 둘 다 `[]`(= 종전 게이트)이고, 그 값을
 * **두 소비처가 같이** 본다(사실표 `trendWhere` · 미러 `withPreCatalogEscape`).
 */
export declare function preCatalogCycleIdsKnown(): readonly string[];
/** 캐시 키 조각용 — 목록의 **안정 해시**. 비면 빈 문자열(격자 off 키와 같은 자세). */
export declare function preCatalogCacheSlot(): string;
/**
 * 동기 코드가 읽는 판정값. **호출 전에 `ensureTrendGrid()` 가 await 돼 있어야 한다.**
 *
 * 미확정이면 종전(false)이고 프로세스당 한 번 경고한다 — PR④ 가 이 값을 **동기 SQL
 * 빌더**(`scope-aggregates.ts::trendAlignedRootPreds`)에서 읽기 시작했기 때문이다.
 * 미확정 폴백은 값이 틀릴 방향이 없지만("종전 추이"), **켰는데 일부 경로만 안 바뀌는
 * 상태는 화면만 봐서는 안 보인다** — 그래서 새 진입점이 ensure 를 빠뜨린 것을 로그로
 * 드러낸다(`anchor-axis-state.ts::anchorAxisKnownEnabled` 과 같은 계약).
 */
export declare function trendGridKnownEnabled(): boolean;
