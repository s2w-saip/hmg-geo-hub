import "server-only";
import { unstable_cache } from "next/cache";
import { citationOverrideRepository } from "@/lib/db/repositories/citation-overrides";
import {
  EMPTY_CITATION_OVERRIDES,
  isCitationCategory,
  type CitationCategory,
  type CitationOverrideMap,
} from "./index";

// 운영자 오버라이드 로더 — DB 행을 분류기가 먹는 맵으로 만들어 캐시한다.
//
// 캐시 계약: 저장·삭제 액션이 CITATION_OVERRIDES_TAG 와 MIRROR_AGGREGATE_TAG 를
// 함께 revalidateTag 한다. 앞은 이 로더를, 뒤는 이미 접힌 미러 집계 결과를 버린다 —
// 둘 다 버려야 화면이 즉시 바뀐다(entities admin 선례와 동일).
//
// ⚠️ 중첩 시 이 캐시는 우회된다(에러 아님). aggregateCitationsFromMirror 는 이미
// unstable_cache(MIRROR_AGGREGATE_TAG) 안에서 돌고, Next 는 중첩 unstable_cache 를
// `isNestedUnstableCache` 로 감지해 **캐시를 건너뛰고 콜백을 그대로 실행**한다
// (next/dist/server/web/spec-extension/unstable-cache.js:141, Next 15.5.18 확인).
// 즉 미러 경로에서는 바깥 캐시 미스마다 이 작은 쿼리가 1회 더 도는 대신, 결과는
// 바깥 엔트리에 함께 접혀 캐시된다. 그래서 두 태그를 **함께** 무효화해야 한다 —
// 중첩 호출의 태그는 바깥 엔트리에 상속되지 않는다.

/** 이 로더 전용 캐시 태그 — 저장·삭제 액션이 revalidateTag 대상으로 쓴다. */
export const CITATION_OVERRIDES_TAG = "citation-overrides";

// 안전망 TTL. 실제 무효화는 태그가 담당(미러 집계와 같은 자세).
const CITATION_OVERRIDES_TTL = 1800; // seconds

// unstable_cache 를 **모듈 로드 시점에 호출하지 않는다** — 일부 테스트가
// next/cache 를 부분 mock(revalidatePath 만) 하므로 import 시점 호출은 이 모듈을
// 간접 import 하는 테스트를 전부 깨뜨린다. lib/scope/server.ts:530 lazyCache 와
// 동일한 패턴(래퍼는 첫 호출 때 1회 생성 후 메모).
function lazyCache<A extends unknown[], R>(
  factory: () => (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let fn: ((...args: A) => Promise<R>) | null = null;
  return (...args: A) => (fn ??= factory())(...args);
}

// unstable_cache 는 반환값을 직렬화한다 — Map 은 통과하지 못하므로 튜플 배열로
// 캐시하고 Map 은 바깥에서 만든다.
const cachedEntries = lazyCache(() =>
  unstable_cache(
    async (): Promise<[string, CitationCategory][]> => {
      const rows = await citationOverrideRepository.list();
      return rows
        .filter((r) => r.domain && isCitationCategory(r.category))
        .map((r) => [r.domain, r.category] as [string, CitationCategory]);
    },
    ["citation-overrides-v1"],
    { revalidate: CITATION_OVERRIDES_TTL, tags: [CITATION_OVERRIDES_TAG] },
  ),
);

/**
 * 분류기에 주입할 오버라이드 맵. **실패해도 throw 하지 않는다** — 테이블 미적용
 * (마이그레이션 0043 전)·DB 오류에서 빈 맵으로 접히면 분류가 오버라이드 도입 이전과
 * 100% 동일하게 동작한다. 인용 화면 전체가 오버라이드 테이블 하나에 인질로 잡히면
 * 안 된다(GA4 규율과 다른 판단: 여기서 실패는 기능 부재이지 데이터 오류가 아니다).
 */
export async function loadCitationOverrides(): Promise<CitationOverrideMap> {
  try {
    const entries = await cachedEntries();
    return entries.length > 0 ? new Map(entries) : EMPTY_CITATION_OVERRIDES;
  } catch {
    return EMPTY_CITATION_OVERRIDES;
  }
}
