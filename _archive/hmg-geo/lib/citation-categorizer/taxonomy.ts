// Citation-source taxonomy — single-level (subcategory 폐기, see migration
// 0016) category set for cited domains. Values are display-ready English
// names because the Citation Sources UI (badge/pie/table/CSV) renders the
// category string raw — the same contract scope's classifier would have used.
//
// scope does NOT send citation categories (confirmed 2026-07-02), so this
// local taxonomy is the sole source. Editing this list is the whole taxonomy
// migration path; seed.json values are validated against it in tests.

export const CITATION_CATEGORIES = [
  "Official (HMG)",
  "Official (Competitor)",
  "Dealer & Marketplace",
  "Automotive Media",
  "News & Media",
  "Community & Forums",
  "Social & Video",
  "Blogs & Reviews",
  // 위키·백과류 — 종전에는 Other 로 떨어졌다 (2026-08-06 고객 피드백: Wiki 단독
  // 집계 요청). 분류는 read-time 파생이라 추가 즉시 전 이력이 재분류된다.
  "Wiki & Reference",
  "Government & Public",
  // 2026-08-28 고객(이노션) 확정: 종전 "Government & Public" 하나에 정부기관과
  // 수상·인증기관이 섞여 있었다(J.D. Power·Red Dot·Michelin 등). SCORE 의
  // "권위 기관(수상·인증·공공 등)" **단일 통합** 제안은 기각됐다 — 정부와 권위를
  // 한 묶음에 두면 사용성 측면에서 혼란이라는 이유. 대신 축을 셋으로 나눈다:
  //   Government & Public   소유·운영 주체가 정부·공공기관 (엄격 기준 유지)
  //   Award & Certification 수상·인증 (어워드·디자인상·품질인증)
  //   Academic & Research   대학·논문·학계
  "Award & Certification",
  "Academic & Research",
  "Other",
] as const;

export type CitationCategory = (typeof CITATION_CATEGORIES)[number];

// 경쟁사 축(인용 화면)이 의존하는 단일 카테고리 — 값 문자열이 두 곳에 복붙되면
// 조용히 어긋난다(필터 패널의 축 활성 규칙 · 뷰의 카테고리 재계산이 같은 값을
// 봐야 한다). 여기가 정본이고 _data/citation-view.ts 가 재수출한다.
export const OFFICIAL_COMPETITOR_CATEGORY: CitationCategory = "Official (Competitor)";

export const FALLBACK_CATEGORY: CitationCategory = "Other";

const CATEGORY_SET: ReadonlySet<string> = new Set(CITATION_CATEGORIES);

export function isCitationCategory(v: string): v is CitationCategory {
  return CATEGORY_SET.has(v);
}

// i18n message-key slug per category (messages/{ko,en}.json::citationCategories.*).
// Data keeps the English display name; UI resolves labels through these slugs so
// the filter panel / badges / charts can localize without changing stored values.
export const CITATION_CATEGORY_SLUGS: Record<CitationCategory, string> = {
  "Official (HMG)": "officialHmg",
  "Official (Competitor)": "officialCompetitor",
  "Dealer & Marketplace": "dealerMarketplace",
  "Automotive Media": "automotiveMedia",
  "News & Media": "newsMedia",
  "Community & Forums": "communityForums",
  "Social & Video": "socialVideo",
  "Blogs & Reviews": "blogsReviews",
  "Wiki & Reference": "wikiReference",
  "Government & Public": "governmentPublic",
  "Award & Certification": "awardCertification",
  "Academic & Research": "academicResearch",
  Other: "other",
};

/** Slug for a category value, or null for non-taxonomy strings (e.g. legacy scope values). */
export function citationCategorySlug(name: string): string | null {
  return isCitationCategory(name) ? CITATION_CATEGORY_SLUGS[name] : null;
}
