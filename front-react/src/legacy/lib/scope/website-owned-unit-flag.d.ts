// Type-only snapshot; no database or server implementation is included.
import "server-only";
/** 유닛 단위 자사 판정을 켜는 화면 키. */
export declare const WEBSITE_OWNED_UNIT_SCREEN_KEY: "X.websiteOwnedUnit";
/** 이 배포에서 env 오버라이드를 읽어도 되는 환경인가. */
export declare function websiteOwnedUnitOverrideAllowedHere(env?: NodeJS.ProcessEnv): boolean;
/** env 오버라이드가 **지금 켜져 있는가**. 환경 검사까지 포함한 최종 판정. */
export declare function websiteOwnedUnitForced(env?: NodeJS.ProcessEnv): boolean;
/**
 * 이 요청에서 website 자사 판정을 유닛 단위로 하는가.
 *
 * 한 요청 안에서 **같은 값**이어야 한다(위 "키가 하나인 이유"). 호출부는 동기 SQL
 * 빌더가 아니라 `ensureWebsiteOwnedUnit()` 을 통해 읽는다 — 그 계약은
 * `website-owned-unit-state.ts` 머리 주석 참조.
 */
export declare function websiteOwnedUnitEnabled(): Promise<boolean>;
