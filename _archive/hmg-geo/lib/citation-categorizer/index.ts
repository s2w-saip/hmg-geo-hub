// Citation-source categorizer — pure, synchronous domain → category mapping
// for the Citation Sources card/pie/badge. Replaces the never-delivered scope
// domain-classifier (scope confirmed it won't send `category`, 2026-07-02), so
// this module is the single source of citation categories on BOTH read paths
// (live result-adapter + scope_* mirror, which share aggregateCitationsFrom*).
//
// Design: no runtime LLM. Precedence per lookup —
//   0. operator override (DB, optional) → highest — see ./overrides-loader.ts
//   1. official HMG social account   → Official (HMG)   (host+path group key)
//   2. geo-catalog owned-domain set   → Official (HMG)   (verified inventory)
//   3. curated seed (seed.json)       → explicit, code-reviewed classification
//   4. generic rules (rules.ts)       → platforms / TLDs / dealer patterns
//   5. FALLBACK_CATEGORY ("Other")
// The override layer is a *parameter*, never module-global state: passing the
// map explicitly is what keeps live/mirror parity a structural guarantee rather
// than a load-timing race (2026-08-21 design decision). Omit the parameter and
// the function behaves exactly as it did before the override layer existed.
// Seed sits above the generic rules so a curation entry can correct any rule
// false-positive without code changes. Refresh the seed with
// scripts/citations/seed-curation.ts (top uncategorized domains by weight).

import { ownedBrandOf } from "@/lib/geo-catalog/owned";
import { isOfficialSocialKey } from "./official-social";
import rawSeed from "./seed.json";
import { ruleCategory } from "./rules";
import {
  FALLBACK_CATEGORY,
  isCitationCategory,
  type CitationCategory,
} from "./taxonomy";

export { CITATION_CATEGORIES, FALLBACK_CATEGORY, isCitationCategory } from "./taxonomy";
export type { CitationCategory } from "./taxonomy";

/**
 * Operator override layer: normalized registrable domain → category.
 * Built by loadCitationOverrides() (./overrides-loader). An empty/absent map
 * means "no overrides" — every code path must behave identically to the
 * pre-override classifier in that case (regression baseline).
 */
export type CitationOverrideMap = ReadonlyMap<string, CitationCategory>;

/** Shared empty map — avoids allocating one per call site. */
export const EMPTY_CITATION_OVERRIDES: CitationOverrideMap = new Map();

// seed.json: { [registrableDomain]: category }. Invalid categories are dropped
// (and rejected by the seed-integrity test) instead of poisoning the pie.
const SEED: ReadonlyMap<string, CitationCategory> = new Map(
  Object.entries(rawSeed as Record<string, string>).flatMap(([d, c]) =>
    isCitationCategory(c) ? [[d.toLowerCase(), c] as const] : [],
  ),
);

/** Curated seed size — exposed for the curation script / tests. */
export const SEED_DOMAIN_COUNT = SEED.size;

function normalize(domain: string): string {
  // trim 이 먼저다 — www-strip 뒤에 두면 선행 공백이 있는 입력에서 앵커(^)가
  // 빗나가 " www.example.com" 이 "www.example.com" 으로 남고, 같은 도메인의
  // 쓰기 키(example.com)와 조회 키가 갈려 오버라이드가 에러 없이 무시된다.
  return domain.trim().toLowerCase().replace(/^www\./, "").trim();
}

/**
 * The domain key shape used by seed.json, the override table PK and every
 * lookup here: lowercase registrable domain with a leading `www.` stripped.
 * Exported so writers (the override repository / admin action) can normalize
 * with the exact same function the reader uses — a mismatch would make an
 * override silently inert.
 */
export function normalizeCitationDomain(domain: string | null | undefined): string {
  return domain ? normalize(domain) : "";
}

/** Curated-seed lookup on an already-normalized domain (null = not seeded). */
export function seedCategoryOf(normalizedDomain: string): CitationCategory | null {
  return SEED.get(normalizedDomain) ?? null;
}

/**
 * Category for one citation row, given whatever category the row itself carries.
 *
 * Precedence: **operator override > stored/engine category > local classifier**.
 * The override wins on purpose (운영 결정 2026-08-21) — a human correction is more
 * trustworthy than an engine's automatic label, and putting it below `row.category`
 * would silently disable the whole admin screen the moment scope starts sending
 * categories (mirror sync stores `c?.category ?? null`, and mock rows already carry
 * one). Every citation rollup MUST go through this so live and mirror agree.
 */
export function resolveCitationCategory(
  rowCategory: string | null | undefined,
  domain: string | null | undefined,
  overrides?: CitationOverrideMap | null,
): string {
  if (overrides?.size && domain) {
    const ov = overrides.get(normalize(domain));
    if (ov) return ov;
  }
  // 공식 HMG 소셜 계정 키는 **행 단위 category 보다 위**다. 이 키는 사람이
  // 전수 판정해 커밋한 목록(official-social.ts)이라 오버라이드와 같은 성격의
  // 인간 판정이고, 엔진이 보내는 자동 라벨보다 신뢰도가 높다 — 오버라이드를
  // rowCategory 위에 둔 것과 같은 근거(운영 결정 2026-08-21).
  // 2026-08-28 실측 기준 이 판정은 **동작 변화가 없다**: 해당 995행의
  // scope_citations.category 는 전부 NULL 이다(전체 246만 행 중 non-null 656).
  if (isOfficialSocialKey(domain)) return "Official (HMG)";
  // 저장값은 **택소노미 안에 있을 때만** 신뢰한다. 밖의 문자열(레거시 scope
  // 값, 데모 시드의 한글 임의 라벨 등)이 그대로 통과하면 UI 가 조용히 망가진다 —
  // 색맵도 i18n 슬러그도 택소노미 키로 조회하므로 회색 fallback + 원문 라벨이
  // 된다(2026-09-04 실증: 데모 프로젝트 인용 차트 전 조각이 #8c8578).
  // 밖의 값은 버리고 도메인 분류기로 내린다.
  if (rowCategory && isCitationCategory(rowCategory)) return rowCategory;
  return categorizeDomain(domain, overrides);
}

/**
 * Categorize a cited registrable domain. Total function — unknown domains get
 * FALLBACK_CATEGORY, mirroring the aeorank fallback baseline (Other).
 */
export function categorizeDomain(
  domain: string | null | undefined,
  // Optional operator overrides. Omitted → identical to the pre-override
  // behaviour (owned → seed → rules → Other).
  overrides?: CitationOverrideMap | null,
): CitationCategory {
  if (!domain) return FALLBACK_CATEGORY;
  const d = normalize(domain);
  if (!d) return FALLBACK_CATEGORY;
  // Override sits ABOVE the owned catalog on purpose: below it there would be no
  // way to correct a mis-catalogued owned domain from the UI at all. The screen
  // shows a warning badge when an override shadows an owned domain.
  const ov = overrides?.get(d);
  if (ov) return ov;
  // 공식 HMG 소셜 계정의 그룹 키(host+path). 이 값은 registrable domain 이
  // 아니므로 아래의 owned 카탈로그·seed·rules 어디에도 걸리지 않는다 —
  // `linkedin.com/hyundai-motor-group` 은 ownedBrandOf 의 서픽스 비교에도,
  // seed.json 의 도메인 키에도 매칭될 수 없다. 그래서 별도 분기가 필요하다.
  if (isOfficialSocialKey(d)) return "Official (HMG)";
  if (ownedBrandOf(d) !== null) return "Official (HMG)";
  return SEED.get(d) ?? ruleCategory(d) ?? FALLBACK_CATEGORY;
}
