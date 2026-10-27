// A route's URLSearchParams in the shape Next hands a page (`searchParams`): a repeated key -> array,
// a single one -> string, a missing one -> undefined. Routes that forward the page's query to a screen
// use it so the screen reads the same values the page sent.
export type SearchParamsRecord = Record<string, string | string[] | undefined>;

/**
 * URLSearchParams → Next 서버 컴포넌트의 `searchParams` 와 **같은 의미론**.
 *
 * 급소: 같은 키가 여러 번 오면 Next 는 **배열**을 준다. 라우트 핸들러에서
 * `forEach` 로 평탄화하면(기존 /api/scope/* 관례) 마지막 값만 남아 다중 선택
 * 필터가 화면과 갈라진다 — 다중값 축은 `?geography=KR~US`(FILTER_SEP) 도
 * 쓰지만 패널이 키를 반복해 쓰는 경로도 있어 양쪽 다 살려야 한다.
 * (splitFilterValues 는 배열을 FILTER_SEP 로 이어붙여 처리한다 — filter-encoding.ts:19)
 */
export function searchParamsToRecord(sp: URLSearchParams): SearchParamsRecord {
  const out: SearchParamsRecord = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}
