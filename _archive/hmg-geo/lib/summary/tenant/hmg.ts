/**
 * 사실표 생성기의 **테넌트 seam** — HMG(현대차그룹) 상수를 코어에 넣어 주는 유일한 통로.
 *
 * 왜 한 파일인가: 코어(`lib/summary/generate/*`)는 브랜드 명부·자사 base·비경쟁 사전·
 * 숨김 국가를 **모르는 채** 문장을 만든다(설계 v4.1 §7-5, PR① T8). 그 값들이 코어 곳곳에서
 * 직접 import 되면 "이 로직이 테넌트에 묶여 있나" 를 파일마다 다시 판단해야 한다 —
 * 여기 한 곳만 보면 되게 한다.
 *
 * 경계는 `lib/summary/summary.tenant-boundary.test.ts`(소스 grep)가 집행한다.
 * 이 파일은 그 테스트의 **허용 목록**이며, 표면 어댑터(`scripts/summary/surface-*.ts`)는
 * 테넌트 값을 이 모듈에서 가져온다.
 */
import { STANDARD_ROOT_PROJECT_ID } from "@/lib/db/repositories/standards";
import { geoCountryCode } from "@/lib/geo-catalog";
import {
  GEO_OWNED_BASES,
  GEO_OWNED_BASE_PREFIXES,
  SHARED_GLOBAL_HOSTS,
  normalizeOwnedBaseUrl,
  ownedBasePrefixFromUrl,
} from "@/lib/geo-catalog/owned";
import { registrableDomainOfHost } from "@/lib/public-suffix";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";
import {
  HMG_BRAND_NAME_PREFIXES,
  ownedBasePrefixesForScope,
  resolveHmgBrandName,
  rollupCanonicalPairs,
} from "@/lib/scope/hmg-brands";
import {
  BARE_ONLY_NON_COMPETITOR_PATTERNS,
  NON_COMPETITOR_BRANDS,
} from "@/lib/scope/non-competitor-brands";
import {
  OWN_VARIANT_ALL,
  type OwnCitationScope,
  type OwnVariant,
} from "@/lib/summary/generate/fold";
import type { RosterEntity } from "@/lib/summary/generate/types";

export { ownedBasePrefixFromUrl, STANDARD_ROOT_PROJECT_ID };

/** 공유 글로벌 호스트 — 국가 유닛의 "사이트 루트 홈" 판정에서 제외한다(#216). */
export function sharedGlobalHosts(): string[] {
  return [...SHARED_GLOBAL_HOSTS];
}

/** 글로벌 표면의 자사 base universe = 카탈로그 선언 base 전량(§3-5). */
export function globalBaseUniverse(): string[] {
  return [...new Set(GEO_OWNED_BASE_PREFIXES)];
}

/** 표준(글로벌) 화면에서 숨기는 국가. 사실표에는 굳히지 않고 조회 시 거른다(§4). */
export function hiddenStandardRegions(): string[] {
  return [...HIDDEN_STANDARD_REGIONS];
}

/**
 * `summary_generations.roster_snapshot` — 재생성이 "최신 명부로의 재해석" 이 되지 않도록
 * 판정 입력을 통째로 보존한다(§7-8). `scopeRootProjectId` 는 글로벌 표면만 넣는다.
 */
export function rosterSnapshot(
  roster: RosterEntity[],
  extra?: { scopeRootProjectId?: string; hiddenStandardRegions?: string[] },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    own_entities: roster,
    rollup_canonical_pairs: rollupCanonicalPairs(roster),
    hmg_brand_name_prefixes: HMG_BRAND_NAME_PREFIXES,
    standard_root_project_id: STANDARD_ROOT_PROJECT_ID,
  };
  if (extra?.scopeRootProjectId) base.scope_root_project_id = extra.scopeRootProjectId;
  if (extra?.hiddenStandardRegions) base.hidden_standard_regions = extra.hiddenStandardRegions;
  return base;
}

/**
 * ⑤(공식 인용) 판정 스코프 — 접기(PR② T2)가 `summary_trend_own.own_citations` 를 굳힐 때 쓴다.
 *
 * 리더(`summary-global-aggregates.ts::ownedCitationExpr`)와 **같은 두 갈래**를 만든다:
 *   · `bases` = `$sel` — base 목록을 `ownedBasePrefixFromUrl` 로 접은 것(세부층 `matched_base` 정규형).
 *   · `fallbackPattern` = `$fbRe` — base 정규화가 불가능했던 행(`base_norm_null = 1`)의
 *     도메인 서픽스 폴백.
 *
 * ⚠️ 폴백 규칙의 **네 번째 사본**이다. 정본은 `scope-aggregates.ts` 의
 * `ownedDomainPatternFor`/`ownedFallbackDomains`(SA:462-480)이고 export 가 없어 리더 두 곳
 * (`summary-global-aggregates.ts:89-101`·`summary-website-aggregates.ts:82-94`)이 이미 베껴 쓴다.
 * 코어(`lib/summary/generate/*`)는 `@/lib/geo-catalog/owned` 를 import 할 수 없으므로
 * (테넌트 경계) 이 seam 이 대신 든다. 규칙을 바꾸면 **넷을 함께** 고쳐야 한다.
 *
 * 인자로 받는 `basePrefixes` 는 그 generation 의 base universe 다(글로벌 = 카탈로그 선언 base
 * 전량, 웹사이트 = 사이트 선언 base 전량). 즉 여기서 나오는 스코프는 **브랜드·국가·언어로
 * 좁히지 않은 "ALL" 변형**의 것이다 — 좁힌 변형은 T3 가 만든다.
 */
export function ownCitationScope(basePrefixes: string[]): {
  bases: string[];
  fallbackPattern: string | null;
} {
  const bases = [...new Set(basePrefixes.map(ownedBasePrefixFromUrl).filter(Boolean))];
  const domains = new Set<string>();
  for (const p of basePrefixes) {
    const norm = normalizeOwnedBaseUrl(p);
    if (!norm) continue;
    const d = registrableDomainOfHost(norm.split("/")[0] ?? "");
    if (d) domains.add(d);
  }
  const list = [...domains];
  const fallbackPattern = list.length
    ? `(^|\\.)(${list.map((d) => d.replace(/\./g, "\\.")).join("|")})$`
    : null;
  return { bases, fallbackPattern };
}

/** `summary_generations.noise_snapshot` — 비경쟁 제외 사전의 그 시점 값. */
export function noiseSnapshot(): Record<string, unknown> {
  return {
    non_competitor_brands: [...NON_COMPETITOR_BRANDS],
    bare_only_non_competitors: BARE_ONLY_NON_COMPETITOR_PATTERNS.map(([name]) => name),
  };
}

// ── `own_variant` 유도 (PR② T3) ──────────────────────────────────────────────

/**
 * 명부 1행 → 변형 키. `trackedRosterFor`(hmg-brands.ts:190-198)의 교집합 키와 **같은 식**이다
 * (`resolveHmgBrandName(name) ?? name`). 같은 식이어야 브랜드 락 계정의 `$own`
 * (`trackedEntityIdsFor([key], roster)`)이 그 변형의 `entityIds` 와 정확히 일치한다.
 */
function variantKeyOf(e: RosterEntity): string {
  return resolveHmgBrandName(e.name) ?? e.name;
}

/**
 * 스코프 행 해석 — 접기 SQL 의 `vsel` LATERAL(`fold.ts::foldTrendOwnSelect`)과 **같은 규칙**.
 * `''` 는 와일드카드이고, 더 구체적인 행이 이긴다. 동점(둘 다 한 축만 명시)이면
 * **국가를 명시한 행**이 이긴다 — `ownedBasePrefixesForScope` 가 국가를 먼저 좁히고
 * 그 결과 위에 언어를 얹기 때문이다(hmg-brands.ts:258-271).
 *
 * SQL 과 이 함수가 갈리면 굳힌 값과 화면이 조용히 어긋나므로 테스트가 둘을 대조한다.
 */
export function resolveOwnCitationScope(
  rows: OwnCitationScope[],
  country: string,
  lang: string,
): OwnCitationScope | undefined {
  const rank = (s: OwnCitationScope): [number, number] => [
    (s.country !== "" ? 1 : 0) + (s.lang !== "" ? 1 : 0),
    s.country !== "" ? 1 : 0,
  ];
  let best: OwnCitationScope | undefined;
  for (const s of rows) {
    if (s.country !== "" && s.country !== country) continue;
    if (s.lang !== "" && s.lang !== lang) continue;
    if (!best) {
      best = s;
      continue;
    }
    const [a0, a1] = rank(s);
    const [b0, b1] = rank(best);
    if (a0 > b0 || (a0 === b0 && a1 > b1)) best = s;
  }
  return best;
}

const sameScope = (a: OwnCitationScope, b: OwnCitationScope) =>
  a.fallbackPattern === b.fallbackPattern &&
  a.bases.length === b.bases.length &&
  a.bases.every((x, i) => x === b.bases[i]);

/**
 * ⑤ 판정 스코프 행 — **카탈로그가 실제로 좁히는 (국가, 언어) 축에서만** 만든다.
 *
 * 왜 데이터가 아니라 카탈로그인가: `ownedBasePrefixesForScope` 는 "좁혀서 비면 상위로 폴백"
 * 이라(hmg-brands.ts:258-271) **값이 바뀌는 지점이 카탈로그 선언 지점뿐**이다. 선언에 없는
 * (국가, 언어)는 상위 행이 그대로 답이 되므로 행을 만들 필요가 없다 — 그래서 이 함수는
 * DB 를 읽지 않고, 같은 카탈로그·같은 명부면 항상 같은 표를 낸다(감사 가능).
 *
 * ⚠️ **정수 0 오차가 성립하는 범위**: 화면이 국가(·언어)를 **하나씩** 고른 경우다.
 * 굳힌 값은 키의 `country`·`lang` 으로 좁힌 것이라, 화면이 국가를 안 고르거나 여러 개 고르면
 * 오늘 리더(`ownedBasePrefixesForScope(브랜드, 국가**집합**, 언어집합)`)와 다르다 —
 * 리더는 그 집합의 base 합집합을 **모든 행에** 적용하고, 여기 굳힌 값은 행마다 자기
 * 국가·언어의 base 만 적용한다. 2026-09-10 라이브 실측(글로벌 8/31, 변형 ALL):
 * 무필터 18,774 vs 국가+언어별 합 10,003 (−46.7%). 무필터·다국가 ⑤ 의 정확한 분자는
 * `summary_trend_domains`(키에 `matched_base` 가 있다)에서 나와야 한다 — PR② T4 판단 사항.
 */
function catalogGeoScopes(
  brandFilter: string[] | undefined,
  roster: RosterEntity[],
  langCase: "upper" | "lower",
): OwnCitationScope[] {
  const norm = (l: string) => (langCase === "upper" ? l.toUpperCase() : l.toLowerCase());
  const countries = new Set<string>();
  const langs = new Set<string>();
  const pairs = new Set<string>();
  for (const e of GEO_OWNED_BASES) {
    const iso = geoCountryCode(e.country)?.toUpperCase() ?? null;
    const lang = e.language ? norm(e.language) : null;
    if (iso) countries.add(iso);
    if (lang) langs.add(lang);
    if (iso && lang) pairs.add(`${iso} ${lang}`);
  }
  const row = (country: string, lang: string): OwnCitationScope => ({
    country,
    lang,
    ...ownCitationScope(
      ownedBasePrefixesForScope(
        brandFilter,
        roster,
        country ? [country] : undefined,
        lang ? [lang] : undefined,
      ),
    ),
  });
  // 와일드카드 → 언어만 → 국가만 → 국가+언어 순. 뒤 행은 앞 행보다 **덜 구체적일 수 없으므로**,
  // 이미 담은 행들의 해석 결과와 같으면 그 행은 어떤 키에서도 답을 못 바꾼다 → 버린다.
  const out: OwnCitationScope[] = [row("", "")];
  const push = (c: string, l: string) => {
    const r = row(c, l);
    const cur = resolveOwnCitationScope(out, c, l);
    if (!cur || !sameScope(cur, r)) out.push(r);
  };
  for (const l of [...langs].sort()) push("", l);
  for (const c of [...countries].sort()) push(c, "");
  for (const p of [...pairs].sort()) {
    const [c, l] = p.split(" ");
    push(c, l);
  }
  return out;
}

/**
 * `own_variant` 목록 — `ALL`(명부 전체) + **명부에서 유도한 브랜드 각각**.
 *
 * 코드 상수가 아니라 `entity_registry(role='own')` 스냅샷에서 나오므로(플랜 §9 T3),
 * 명부에 브랜드가 추가되면 변형이 자동으로 는다. `profiles.brands`(권한 데이터)는 읽지 않는다.
 *
 * `scopeNarrowing`:
 *  · `"catalog-geo"` — 글로벌 표면. ⑤ 스코프를 `GEO_OWNED_BASES` 의 (국가, 언어) 축으로 좁힌다.
 *  · `"none"` — 웹사이트 표면. base universe 가 사이트 **선언**(`website_prompts.owned_base_url`)이라
 *    카탈로그 축과 무관하다. 오늘 리더는 그것을 (프로젝트, 언어, 사이트 국가)로 좁히는데
 *    (`scope-aggregates.ts::websiteDeclaredOwnedBases`, SA:5242-5283) **프로젝트 축이
 *    `OwnCitationScope` 에 없다** → 좁히지 않고 선언 전량을 쓴다. T4/T11 인계 사항.
 */
export function ownVariants(opts: {
  roster: RosterEntity[];
  basePrefixes: string[];
  scopeNarrowing: "catalog-geo" | "none";
  /** 세부층 `lang` 표기 — 글로벌 대문자·웹사이트 소문자(`fold.ts::OwnCitationScope` 주석). */
  langCase: "upper" | "lower";
}): OwnVariant[] {
  const { roster, basePrefixes, scopeNarrowing, langCase } = opts;
  if (roster.length === 0) {
    throw new Error("ownVariants: 명부가 비었다 — entity_registry(role='own') 확인");
  }
  const groups = new Map<string, string[]>();
  for (const e of roster) {
    const key = variantKeyOf(e);
    if (key === OWN_VARIANT_ALL) {
      throw new Error(`ownVariants: 명부 표기 '${e.name}' 가 예약 키 ${OWN_VARIANT_ALL} 와 충돌한다`);
    }
    const ids = groups.get(key);
    if (ids) ids.push(e.id);
    else groups.set(key, [e.id]);
  }
  const wildcard: OwnCitationScope = { country: "", lang: "", ...ownCitationScope(basePrefixes) };
  const universe = new Set(wildcard.bases);
  const scopesFor = (brandFilter?: string[]): OwnCitationScope[] => {
    if (scopeNarrowing === "none") return [wildcard];
    const rows = catalogGeoScopes(brandFilter, roster, langCase);
    // 굳힌 스코프의 base 는 세부층 `matched_base` 로 실제 나타날 수 있는 값이어야 한다 —
    // 세부층은 `basePrefixes`(universe)로 최장 일치를 접기 때문이다. 어긋나면 ⑤ 분자가
    // 조용히 0 이 된다(0065 `DEFAULT 0` 마스킹).
    for (const r of rows) {
      for (const b of r.bases) {
        if (!universe.has(b)) {
          throw new Error(`ownVariants: 스코프 base ${b} 가 base universe 밖이다 — 세부층과 어긋난다`);
        }
      }
    }
    return rows;
  };
  return [
    { key: OWN_VARIANT_ALL, entityIds: roster.map((e) => e.id), citationScopes: scopesFor() },
    ...[...groups.keys()].sort().map((key) => ({
      key,
      entityIds: groups.get(key)!,
      citationScopes: scopesFor([key]),
    })),
  ];
}
