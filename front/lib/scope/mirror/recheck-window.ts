/**
 * terminal run 재확인 창 — **의존성 없는 리프 모듈**(2026-09-28).
 *
 * 값의 근거는 lib/db/repositories/scope-mirror.ts 의 RUN_RECHECK_WINDOW_DAYS 주석(그 파일이
 * 이 값을 가져다 re-export 한다). 여기로 옮긴 이유: 미러 싱크의 floor 판정
 * (sync.ts runHoldsFloor)도 같은 창을 써야 하는데, 두 곳에 3 을 따로 적으면 한쪽만
 * 고쳐지는 결함이 난다 — 그리고 리포지토리 모듈을 import 하면 그 모듈을 mock 하는
 * 테스트 전부가 이 상수를 잃는다.
 */
export const RUN_RECHECK_WINDOW_DAYS = 3;
export const RUN_RECHECK_WINDOW_MS = RUN_RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
