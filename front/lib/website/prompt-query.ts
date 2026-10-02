import "server-only";
import type { AllowedScope } from "@/lib/auth/types";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { readStandardFilters } from "@/components/dash/standard-filters";
import {
  WEBSITE_PROMPT_SORT_KEYS,
  type WebsitePromptQueryFilters,
  type WebsitePromptSortKey,
} from "@/lib/db/repositories/website-sites";
import { readCursorParam } from "@/lib/hgh/paginate";

// /website/prompts 의 **필터 파생 단일화**.
//
// 왜 한 곳인가 — 이 화면은 서버 페이징이라(website_prompts 1만행대) 내보내기가
// 화면 배열을 재사용할 수 없고 서버가 다시 질의해야 한다. 그때 화면과 내보내기가
// searchParams 를 각자 해석하면 "화면엔 300건인데 엑셀은 다른 300건"이 조용히
// 생긴다. 축 목록(admin 전용 brand)·정렬 화이트리스트·페이지 클램프까지 전부
// 여기서만 파생하고, page.tsx 와 /api/website/prompts/export 는 이 함수만 부른다.
//
// 글로벌(표준) 화면이 반대 선택(클라이언트 배열 직렬화)을 한 이유는
// app/[locale]/(dash)/standard/prompts/_components/prompt-export.ts 머리 주석 참조.

export const WEBSITE_PROMPTS_PAGE_SIZE = 50;

/**
 * 노출 축 — WebsitePromptFilters 의 groups 와 **동일 구성**이어야 한다.
 * 숨은 축의 URL 파라미터가 조용히 데이터만 좁히는 것을 막으려고
 * readStandardFilters 에도 같은 목록을 넘긴다(그 함수의 visibleGroups 주석).
 * 브랜드 축이 admin 전용인 근거: prompt-filters.tsx 머리 주석(2026-06-30).
 */
export function websitePromptFilterGroups(isAdmin: boolean): DimensionGroup[] {
  return ["geography", "language", "engine", "time", ...(isAdmin ? (["brand"] as const) : [])];
}

export interface WebsitePromptQuery {
  filters: WebsitePromptQueryFilters;
  sort: WebsitePromptSortKey;
  dir: "asc" | "desc";
  page: number;
  /**
   * Keyset cursor of the backend API source (?cursor, decision D5, unit U8). null = first
   * page. The legacy source ignores it; the export ignores it on both sources.
   */
  cursor: string | null;
}

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

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

/** searchParams → 질의 파라미터. 화면·내보내기가 공유하는 유일한 파생 경로. */
export function readWebsitePromptQuery(
  sp: SearchParamsRecord,
  scope: AllowedScope | undefined,
  isAdmin: boolean,
): WebsitePromptQuery {
  const groups = websitePromptFilterGroups(isAdmin);
  // 필터 축은 표준 파서를 그대로 쓴다 — ?geography/?language/?brand/?engine/?time
  // 규약과 scope 하드락(D4)이 화면마다 갈라지지 않게. readStandardFilters 는
  // ?geography 를 region 으로 파싱하므로 website 축(country)으로 옮긴다
  // (website/page.tsx·brand-citations 라우트와 동일한 remap).
  const raw = readStandardFilters(sp, scope, groups, "website");

  const sortParam = one(sp.sort);
  const sort: WebsitePromptSortKey =
    sortParam && (WEBSITE_PROMPT_SORT_KEYS as readonly string[]).includes(sortParam)
      ? (sortParam as WebsitePromptSortKey)
      : "lastMeasuredAt";
  const dir = one(sp.dir) === "asc" ? "asc" : "desc";
  const requestedPage = Number.parseInt(one(sp.page) ?? "1", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  return {
    filters: {
      brands: raw.brand,
      countries: raw.region, // geography → website country
      langs: raw.lang,
      search: one(sp.q),
      engines: raw.engine,
      dateFrom: raw.dateFrom,
      dateTo: raw.dateTo,
    },
    sort,
    dir,
    page,
    cursor: readCursorParam(one(sp.cursor)),
  };
}
