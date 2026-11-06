// Type-only snapshot; no database or server implementation is included.
import "server-only";
/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export declare function resetWebsiteOwnedUnitForTests(): void;
/** 테스트 전용 — DB 없이 판정값을 고정한다(켜진 경로의 SQL 형태 검증용). */
export declare function setWebsiteOwnedUnitForTests(value: boolean): void;
/**
 * 판정을 **확정**한다. 이미 확정돼 있으면 왕복이 없고, 동시에 여러 진입점이 불러도
 * 발사는 1회다. 절대 throw 하지 않는다 — 판정 실패가 화면 장애가 되면 안 되고,
 * 실패의 의미는 "종전 flat"이라 값이 틀릴 방향이 없다.
 */
export declare function ensureWebsiteOwnedUnit(): Promise<boolean>;
/**
 * 동기 빌더가 읽는 판정값. **호출 전에 `ensureWebsiteOwnedUnit()` 이 await 돼 있어야
 * 한다.** 미확정이면 종전 flat(false)으로 나가고 프로세스당 한 번 경고한다.
 */
export declare function websiteOwnedUnitKnownEnabled(): boolean;
