import "server-only";
import { cache } from "react";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";

// T18 — 캐시 우회 성능 프로브 게이트.
//
// 목표(perf-target-roadmap §1-3): "진짜 성능" = 앱 캐시(`mirrorCache` =
// `unstable_cache`, TTL 7,200 s)를 **우회한** 상태에서 배포된 페이지가 그려지기까지의
// 시간. 그런데 캐시를 지우면(revalidateTag) 그 순간 실사용자가 콜드 비용을 대신 낸다.
// 그래서 지우지 않고 **지나간다**: 요청별 랜덤 솔트를 캐시 키에 섞으면 그 요청만
// 아무도 안 쓰는 새 셀을 만들고, 다른 사용자의 셀은 손대지 않는다.
//
// 게이트는 fail-closed 다 — 아래 넷 중 하나라도 걸리면 솔트는 null 이고, 캐시 경로는
// 평소와 **완전히 동일**하다:
//   1. `CRON_SECRET` 미설정 (프리뷰·로컬)
//   2. 헤더 없음
//   3. 헤더 불일치
//   4. 요청 컨텍스트 밖 (크론 잡·빌드 프리렌더·`unstable_cache` 콜백 안 등
//      `headers()` 가 던지는 자리) — 이 경우 프로브는 **항상 off**
// 어느 경우에도 로그를 남기지 않는다: 불일치를 찍으면 그 자체가 시크릿 탐색의
// 오라클이 되고, 정상 트래픽(=거의 전부)에 같은 줄이 쌓여 신호가 죽는다.
export const PERF_NOCACHE_HEADER = "x-hmg-perf-nocache";

// 솔트 셀의 TTL(초). 본 캐시(7,200 s)와 분리한다 — 솔트는 요청당 1회용이라
// 재사용되는 일이 없고, 본 TTL 을 물려주면 프로브 1회마다 Data Cache 에 2시간짜리
// 죽은 셀이 수십 개 쌓인다. 한 요청 안에서 같은 셀을 두 섹션이 부르는 경우(요청 내
// 재사용)만 살리면 되므로 짧게 잡는다.
export const PERF_PROBE_CACHE_TTL = 60;

// 길이가 달라도 `timingSafeEqual` 이 던지지 않도록 양쪽을 sha256 으로 고정 길이화한
// 뒤 비교한다. 길이 자체는 이 방식으로도 새지 않는다(해시가 항상 32바이트).
export function perfSecretMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

async function resolveNoCacheSalt(): Promise<string | null> {
  const expected = process.env.CRON_SECRET;
  if (!expected) return null;
  let provided: string | null = null;
  try {
    provided = (await headers()).get(PERF_NOCACHE_HEADER);
  } catch {
    // 요청 컨텍스트 밖 — 프로브는 존재하지 않는 것으로 친다.
    return null;
  }
  if (!provided) return null;
  if (!perfSecretMatches(provided, expected)) return null;
  return randomUUID();
}

// React `cache()` 는 인자 0개라 요청당 정확히 1회 평가된다 — 한 요청 안의 모든
// 캐시 셀이 **같은 솔트**를 받는다는 뜻이다. 이게 중요한 이유: 솔트가 셀마다 달라도
// 우회는 되지만, 한 요청 안에서 같은 집계를 두 섹션이 부를 때 중복 계산이 생겨
// 측정값이 실제 콜드 렌더보다 부풀려진다. 요청 스코프 밖에서는 React 가 메모 없이
// 그냥 호출하는데, 그 자리에선 어차피 `headers()` 가 던져 null 이다.
export const perfNoCacheSalt = cache(resolveNoCacheSalt);

/** 이 요청이 캐시 우회 프로브인가 (관측·표식용). */
export async function perfNoCacheActive(): Promise<boolean> {
  return (await perfNoCacheSalt()) !== null;
}

/**
 * 캐시 셀 한 개를 프로브 게이트 뒤에 둔다.
 * - 게이트 off(기본): `base` 를 **그대로** 호출한다 — 키·TTL·태그 전부 무변경.
 * - 게이트 on: `buildSalted(salt)` 가 만든 솔트 키 셀로 우회한다.
 * `base` 는 지연 생성(lazyCache)일 수 있으므로 여기서 호출만 하고 만들지 않는다.
 */
export function withNoCacheSalt<A extends unknown[], R>(
  base: (...args: A) => Promise<R>,
  buildSalted: (salt: string) => (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const salt = await perfNoCacheSalt();
    if (salt === null) return base(...args);
    return buildSalted(salt)(...args);
  };
}
