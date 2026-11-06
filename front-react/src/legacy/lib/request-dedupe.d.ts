// Type-only snapshot; no database or server implementation is included.
/**
 * 인자 배열을 결정적인 문자열로 직렬화한다. 객체 키는 정렬하므로 선언 순서가
 * 달라도 같은 키가 나온다(`{a,b}` === `{b,a}`). 배열은 **순서를 보존**한다 —
 * 필터 축의 정렬 정규화는 게이트웨이(normalizeFilters)의 일이고, 여기서까지
 * 정렬하면 순서가 의미를 갖는 인자(예: 시계열 unit 목록)를 잘못 접는다.
 * `undefined` 는 키 자체를 생략해 "명시 안 함"과 "undefined 전달"을 같게 본다.
 */
export declare function stableKey(value: unknown): string;
/**
 * 같은 요청 · 같은 키의 호출을 **한 번의 실행**으로 접는다.
 * 반환 프로미스는 공유된다(첫 호출자와 동일한 인스턴스).
 */
export declare function dedupeInRequest<T>(key: string, run: () => Promise<T>): Promise<T>;
/**
 * 비동기 페처를 요청단위 dedup 으로 감싼다. 이름은 키 네임스페이스이므로
 * **모듈 안에서 유일**해야 한다(다른 페처와 겹치면 서로의 결과를 받는다).
 */
export declare function requestDeduped<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
