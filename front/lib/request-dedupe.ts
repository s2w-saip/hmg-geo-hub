import { cache } from "react";

// 요청단위(request-scoped) 페처 dedup.
//
// 왜 필요한가: 화면을 섹션별 <Suspense> 로 쪼개면 한 렌더 안에서 **여러 섹션이
// 같은 read 를 부른다**(예: 대시보드의 SUMMARY 와 GEO 는 둘 다 getLiveDashboard).
// 그대로 두면 콜드 키(unstable_cache 미적중)에서 같은 집계가 중복 계산되고 —
// 2026-08-26 에 하루를 쓴 "중복 스캔 · 유기 트랜잭션" 문제가 그대로 되살아난다.
// 분할의 전제조건이 이 dedup 이다.
//
// 왜 React `cache()` 를 직접 페처에 못 씌우나: `cache()` 의 인자 매칭은
// **참조 동일성**(원시값은 값, 객체는 WeakMap 키)이다. 우리 페처의 인자는 전부
// `StandardFilters` 객체라, 같은 렌더 안에서 서로 다른 객체 리터럴
// (`{ ...filters, dateFrom }` 같은 파생 객체 포함)을 넘기면 dedup 이 조용히
// 실패한다. 그래서 `cache()` 는 **요청당 Map 을 만드는 데에만** 쓰고
// (인자 0개 → 참조 문제 없음), 실제 매칭은 인자를 정렬 직렬화한 **문자열 키**로
// 한다. 값이 같으면 객체 아이덴티티와 무관하게 접힌다.
//
// 범위: 이 Map 은 React 의 요청 캐시에 산다 — 요청이 끝나면 사라진다. 요청을
// 넘어선 캐시는 여전히 `unstable_cache`(lib/scope/server.ts::mirrorCache) 담당.
// 둘은 층이 다르다: unstable_cache 는 요청 간·인스턴스 간, 이건 요청 안.
const requestScopedStore = cache((): Map<string, Promise<unknown>> => new Map());

/**
 * 인자 배열을 결정적인 문자열로 직렬화한다. 객체 키는 정렬하므로 선언 순서가
 * 달라도 같은 키가 나온다(`{a,b}` === `{b,a}`). 배열은 **순서를 보존**한다 —
 * 필터 축의 정렬 정규화는 게이트웨이(normalizeFilters)의 일이고, 여기서까지
 * 정렬하면 순서가 의미를 갖는 인자(예: 시계열 unit 목록)를 잘못 접는다.
 * `undefined` 는 키 자체를 생략해 "명시 안 함"과 "undefined 전달"을 같게 본다.
 */
export function stableKey(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? "undefined";
}

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") {
    // 함수는 직렬화가 불가능하다 — 키에 섞이면 서로 다른 호출이 같은 키로
    // 접힐 수 있으므로 명시적으로 거부한다(조용한 오접힘 방지).
    if (typeof value === "function") {
      throw new TypeError("stableKey: function arguments are not keyable");
    }
    return typeof value === "bigint" ? `${value}n` : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue; // 미지정 축은 키에서 뺀다
    out[k] = normalize(v);
  }
  return out;
}

/**
 * 같은 요청 · 같은 키의 호출을 **한 번의 실행**으로 접는다.
 * 반환 프로미스는 공유된다(첫 호출자와 동일한 인스턴스).
 */
export function dedupeInRequest<T>(key: string, run: () => Promise<T>): Promise<T> {
  const store = requestScopedStore();
  const hit = store.get(key);
  if (hit) return hit as Promise<T>;
  const promise = run();
  store.set(key, promise);
  // 실패한 프로미스를 요청 내내 붙잡아 두면 같은 요청의 다른 섹션이 재시도조차
  // 못 한다 — reject 시에는 엔트리를 비운다(성공만 캐시).
  promise.catch(() => {
    if (store.get(key) === promise) store.delete(key);
  });
  return promise;
}

/**
 * 비동기 페처를 요청단위 dedup 으로 감싼다. 이름은 키 네임스페이스이므로
 * **모듈 안에서 유일**해야 한다(다른 페처와 겹치면 서로의 결과를 받는다).
 */
export function requestDeduped<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => dedupeInRequest(`${name}(${stableKey(args)})`, () => fn(...args));
}
