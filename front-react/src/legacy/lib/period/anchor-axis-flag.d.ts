// Type-only snapshot; no database or server implementation is included.
import "server-only";
/** 축 전환을 켜는 화면 키. 계약 §4 에서 이름이 고정돼 있다. */
export declare const ANSWER_ANCHOR_SCREEN_KEY: "X.answerAnchor";
/** 이 배포에서 env 오버라이드를 읽어도 되는 환경인가. */
export declare function answerAnchorOverrideAllowedHere(env?: NodeJS.ProcessEnv): boolean;
/** env 오버라이드가 **지금 켜져 있는가**. 환경 검사까지 포함한 최종 판정. */
export declare function answerAnchorForced(env?: NodeJS.ProcessEnv): boolean;
/**
 * 이 요청에서 기간 축을 **회차 귀속 날짜**(`ca.round_date`)로 읽는가.
 *
 * 한 요청 안에서 **같은 값**이어야 한다 — 카드가 앵커 축인데 추이가 측정 축이면
 * 같은 화면에서 모수가 갈린다. 호출부는 진입점에서 한 번 await 해서 아래로
 * 내려보낸다(`periodCompareEnabled` 와 같은 자세).
 */
export declare function answerAnchorEnabled(): Promise<boolean>;
