// 당사(HMG) 브랜드 정본 — "추적" 판정의 단일 소스 (2026-07-02 결정 축D/E 구현).
//
// 문자열 매칭(`brand IN ('Hyundai','Kia','Genesis')`) 대신 scope 미러의
// entity_id 로 판정한다. scope 는 HMG 3사에 합성 고정 UUID 를 부여하며
// (2026-07-02 실측: scope_mentions 20만 행 전부 entity_id·brand_rollup_entity_id
// 100% 채움, Brand 행은 rollup == 자기 entity), Product(모델) 언급은
// brand_rollup_entity_id 가 소속 브랜드를 가리켜 모델 포함 집계가 자동 성립한다
// (자사·경쟁 대칭 — 축B/C).
//
// 축E: "당사" 는 고정 3사가 아니라 계정 브랜드 스코프(활성 brand 필터, 락 포함)와의
// 교집합 — kia-hq 의 당사 = Kia. admin(무필터)은 3사 전체. 교집합이 비면(브랜드
// 필터에 당사가 없음) 3사로 폴백해 빈 IN 절·무의미한 0 카드를 막는다.
//
// 정의의 집은 entity_registry(DB, migration 0023 — admin 관리 예정)로 이관됐다:
// 게이트웨이(lib/scope/server.ts)가 own 명부를 로드해 filters.ownEntities 로
// 주입하면 아래 함수들이 그 로스터를 쓰고, 명부가 비거나 미적용이면 이 파일의
// 시드로 폴백한다 — 적용 전에도 동작 불변.
import { GEO_OWNED_BASES } from "@/lib/geo-catalog/owned";
import { geoCountryCode } from "@/lib/geo-catalog";
import { NAME_BOUNDARY_CLASS } from "./text-trim";

export const HMG_BRANDS = ["Hyundai", "Kia", "Genesis"] as const;
export type HmgBrand = (typeof HMG_BRANDS)[number];

export const HMG_BRAND_ENTITY_IDS: Record<HmgBrand, string> = {
  Hyundai: "00000000-0000-0000-0000-000000000301",
  Kia: "00000000-0000-0000-0000-000000000302",
  Genesis: "00000000-0000-0000-0000-000000000304",
};

// 표기 변형 알리아스 — scope 는 자국어 표기('기아'·'هيونداي' 등)를 별도 entity 로
// 만들어 정본 3사 rollup 과 갈라놓는다(2026-08-05 미러 전수조사: 아래 5개가 전부,
// 합계 ~5.5천 언급). 이 id 들은 정본 id 와 같은 브랜드로 취급한다 — tracked 판정은
// 로스터 포함으로, 랭킹/추이 표시는 rollupCanonicalPairs 의 read-time 접기로.
export const HMG_BRAND_ALIAS_ENTITY_IDS: Record<HmgBrand, readonly string[]> = {
  Hyundai: [
    "e0348d5f-afe4-48e6-aa99-1dee566f2822", // 현대자동차
    "c6dc2ca3-0fc9-42bc-b255-6fbfdb394e45", // هيونداي
    "65eabd79-6138-4851-8b58-8a9b0261b517", // יונדאי (히브리어)
  ],
  Kia: [
    "ed4b8012-4a73-4174-9b43-4cb696934b25", // 기아
    "53a1ac82-6346-477d-9fb7-31d78b9248fa", // كيا
    "e21f66ad-9a28-46ab-8436-78ead06bd8f9", // קיה (히브리어)
  ],
  Genesis: [
    "fd2f4a33-8f9b-4a46-bfd0-62133d162d28", // 제네시스
  ],
};

// 표기 접두 → 정본 브랜드 (2026-08-28). scope 의 rollup 이 **틀린 브랜드를 가리키는**
// 케이스가 미러 전수조사에서 확인됐다: `Genesis G70 3.3T`→Dodge(96 언급),
// `Hyundai Verna`→Suzuki(87), `Kia Pro Cee'd`→BMW(54), `Hyundai Creta Electric`→Tata(39),
// `Hyundai Grand i10 Nios`→Tata(38), `Kia Seltos Hybrid`→MG(33), `Hyundai i30 Fastback`→Ora(32).
// 같은 조사에서 **당사 파생 표기가 별도 rollup 으로 떨어져 있는** 것도 나왔다:
// `Kia Charge`(1,077)·`Hyundai Canada`(801)·`Hyundai N`(220) — 전부 당사인데 3사 어디에도
// 안 합산된다. 둘 다 "표기가 당사 브랜드로 시작하는가"라는 하나의 규칙으로 교정된다.
//
// UUID 목록(HMG_BRAND_ALIAS_ENTITY_IDS)과 달리 이 규칙은 **데이터 비의존**이라 새 오분류가
// 유입돼도 자동으로 잡힌다. 접두 anchored 이므로 'Genesisian' 같은 부분일치는 걸리지 않고,
// 'Hyundai Genesis Coupe' 는 Hyundai 로 간다(표기 그대로의 귀속).
// 소비처: lib/db/repositories/scope-aggregates.ts::canonRollupSql (read-time 접기).
export const HMG_BRAND_NAME_PREFIXES: Record<HmgBrand, readonly string[]> = {
  // 평가 순서 = 이 객체의 키 순서. Genesis 를 먼저 봐야 'Genesis …' 가 Hyundai 로 새지 않는다.
  Genesis: ["Genesis", "제네시스", "جينيسيس"],
  // 현대자동차 · 현대차 → 현대 순(긴 것 먼저). 짧은 것이 먼저 맞으면 긴 표기가 가려진다.
  Hyundai: ["Hyundai", "현대자동차", "현대차", "현대", "هيونداي", "יונדאי"],
  Kia: ["Kia", "기아", "كيا", "קיה"],
};

// [brand, entityId, prefixes] — SQL CASE 생성용(평가 순서 보존).
export function hmgBrandPrefixEntries(): ReadonlyArray<
  readonly [brand: HmgBrand, entityId: string, prefixes: readonly string[]]
> {
  return (Object.keys(HMG_BRAND_NAME_PREFIXES) as HmgBrand[]).map(
    (b) => [b, HMG_BRAND_ENTITY_IDS[b], HMG_BRAND_NAME_PREFIXES[b]] as const,
  );
}

// 표기 접두 규칙의 JS 트윈 — SQL(canonRollupSql)과 **같은 판정**이어야 한다.
// 규칙: 표기가 접두로 시작하고, 그 바로 뒤가 문자·숫자가 아닐 것(경계). SQL 은
// `^(pat)([^[:alnum:]]|$)` 이고 여기서는 같은 경계를 `[\p{L}\p{Nd}]` 로 본다
// (한글·아랍어 모두 양쪽에서 alnum 취급). 두 경로가 갈리면 프로젝트 표면(JS)과
// 표준 표면(SQL)의 브랜드 귀속이 어긋나므로 hmg-brands.test 가 대조한다.
//
// 2026-08-29 수정: 종전 `\p{N}` 은 Nd·Nl·No 를 전부 숫자로 봐서 `"Genesis²"`
// (U+00B2, 카테고리 No)에서 SQL=Genesis 매칭 / JS=미매칭으로 갈렸다. Postgres
// `[[:alnum:]]` 은 L*+**Nd** 만 참이라(프로덕션 실측) `\p{Nd}` 가 정확한 쌍둥이다.
// 클래스 정본·근거는 lib/scope/text-trim.ts::NAME_BOUNDARY_CLASS.
const NAME_BOUNDARY = new RegExp(`[${NAME_BOUNDARY_CLASS}]`, "u");

export function hmgBrandByNamePrefix(name: string | null | undefined): HmgBrand | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const [brand, , prefixes] of hmgBrandPrefixEntries()) {
    for (const p of prefixes) {
      const lp = p.toLowerCase();
      if (!lower.startsWith(lp)) continue;
      const next = trimmed.charAt(lp.length);
      if (next === "" || !NAME_BOUNDARY.test(next)) return brand;
    }
  }
  return null;
}

// 표기 접두로 해석한 정본 rollup entity_id (해석 불가면 null).
export function hmgRollupIdByNamePrefix(name: string | null | undefined): string | null {
  const b = hmgBrandByNamePrefix(name);
  return b ? HMG_BRAND_ENTITY_IDS[b] : null;
}

// 표기 → 정본 브랜드 사전. 레지스트리(admin UI)에 자국어 표기 그대로 등록된
// 행('기아' 등)도 정본 브랜드로 해석해 축E 교집합·정규화 페어가 성립하게 한다.
// (표시명 병합 사전 lib/scope/brand-display-aliases.ts 가 이 엔트리를 합성한다.)
export const HMG_BRAND_NAME_ALIASES: Readonly<Record<string, HmgBrand>> = {
  기아: "Kia",
  현대: "Hyundai",
  현대차: "Hyundai",
  현대자동차: "Hyundai",
  제네시스: "Genesis",
  هيونداي: "Hyundai",
  كيا: "Kia",
  جينيسيس: "Genesis",
  יונדאי: "Hyundai",
  קיה: "Kia",
};

// 표기 변형을 정본 브랜드명으로 해석 — 정확 일치 → 영문 대소문자 무시 → 알리아스
// 사전 순. 해석 불가(비 HMG)면 null.
export function resolveHmgBrandName(name: string): HmgBrand | null {
  if (isHmgBrand(name)) return name;
  const trimmed = name.trim();
  const cased = HMG_BRANDS.find((b) => b.toLowerCase() === trimmed.toLowerCase());
  return cased ?? HMG_BRAND_NAME_ALIASES[trimmed] ?? null;
}

// 자사 명부 한 항목 — entity_registry(role='own') 행과 동형.
export interface OwnEntity {
  id: string; // scope entity_id
  name: string; // 대표 표기 (brand 필터의 이름과 매칭)
}

const SEED_ROSTER: readonly OwnEntity[] = HMG_BRANDS.flatMap((b) => [
  { id: HMG_BRAND_ENTITY_IDS[b], name: b },
  ...HMG_BRAND_ALIAS_ENTITY_IDS[b].map((id) => ({ id, name: b })),
]);

const isHmgBrand = (b: string): b is HmgBrand =>
  (HMG_BRANDS as readonly string[]).includes(b);

// 스코프 좁히기 공용 규칙: 허용 목록을 요청값과 교집합하되, 교집합이 비면(요청이
// 스코프 밖) 빈 결과 대신 원본 스코프 전체로 폴백 — 빈 IN 절·무의미한 0 카드를
// 막는다. trackedRosterFor(아래)와 lib/scope/server.ts::withWebsite의 브랜드
// 필터가 공유하는 규칙(2026-07-06 추출). ga4/property-map.ts::pickSet은 폴백 없이
// 빈 결과를 그대로 두는 다른 규칙이라 별개 — 통합 대상 아님.
export function intersectOrFallback<T>(
  items: readonly T[],
  allowed: string[],
  key: (item: T) => string,
): T[] {
  const scoped = items.filter((item) => allowed.includes(key(item)));
  return scoped.length ? scoped : [...items];
}

// 계정 스코프를 화면의 브랜드 선택(filters.brand)으로 좁힌 "유효 스코프".
// lib/scope/server.ts::withWebsite의 데이터 읽기와, 필터 드롭다운 옵션 소스
// (listWebsiteCountries/listMeasuredLanguages/listMeasuredRegions)가 같은
// 규칙을 공유해야 옵션과 데이터가 어긋나지 않는다 — 2026-07-13, admin이
// 브랜드=Hyundai를 선택해도 국가 드롭다운에 Kia만 측정한 인도네시아가 남아
// 있던 버그의 원인이 이 드리프트였다.
//  - 선택 없음 → 계정 스코프 그대로
//  - admin(all)/브랜드 락 없음 → 선택 브랜드로 좁힘
//  - 브랜드 락 계정 → 락 ∩ 선택 (교집합이 비면 락 전체로 폴백 — 빈 배열을
//    흘리면 length===0을 "제한 없음"으로 읽는 소비자에서 전체가 샌다)
export function narrowScopeBrands<S extends { all: boolean; brands?: string[] }>(
  scope: S,
  requestedBrands?: string[],
): S {
  if (!requestedBrands?.length) return scope;
  if (scope.all || !scope.brands?.length) {
    return { ...scope, all: false, brands: requestedBrands };
  }
  return { ...scope, brands: intersectOrFallback(scope.brands, requestedBrands, (b) => b) };
}

// 축E 스코프 규칙: 활성 brand 필터(계정 락/프로젝트 컨텍스트 포함) ∩ 자사 명부,
// 교집합이 비면 명부 전체 폴백 (빈 IN 절·무의미한 0 카드 방지).
export function trackedRosterFor(
  brandFilter?: string[],
  roster?: readonly OwnEntity[],
): readonly OwnEntity[] {
  const own = roster?.length ? roster : SEED_ROSTER;
  if (!brandFilter?.length) return own;
  // 알리아스 표기('기아' 등)로 등록된 명부 행도 정본 브랜드명으로 해석해 교집합 —
  // kia-hq(brand=['Kia'])에서 '기아' rollup 이 tracked 에서 빠지는 갭 방지.
  return intersectOrFallback(own, brandFilter, (e) => resolveHmgBrandName(e.name) ?? e.name);
}

export function trackedEntityIdsFor(
  brandFilter?: string[],
  roster?: readonly OwnEntity[],
): string[] {
  return trackedRosterFor(brandFilter, roster).map((e) => e.id);
}

// 표기용/HTTP-경로 폴백용 — entity_id 가 없는 데이터(공개 API 행)에서만 사용.
export function trackedBrandNameSetFor(
  brandFilter?: string[],
  roster?: readonly OwnEntity[],
): Set<string> {
  return new Set(trackedRosterFor(brandFilter, roster).map((e) => e.name));
}

export function isTrackedEntityId(
  id: string | null | undefined,
  brandFilter?: string[],
  roster?: readonly OwnEntity[],
): boolean {
  if (!id) return false;
  return trackedEntityIdsFor(brandFilter, roster).includes(id);
}

// 공식(당사) 인용 판정의 베이스 목록 — 축E 를 owned base 로 확장한 규칙
// (2026-08-05 결정: "전사 관점" 별도 지표 없음 — 공식 인용 비중도 언급 계열
// KPI 와 같은 당사 스코프를 따른다). 활성 brand 필터 ∩ 로스터의 브랜드 집합에
// 속한 카탈로그 베이스만 반환하고, 교집합이 비면 trackedRosterFor 와 동일하게
// 3사 전체로 폴백한다(빈 목록 = owned 판정 전무를 만들지 않는다). 프로젝트
// 표면은 이 헬퍼가 아니라 프로젝트 사슬(설정 owned bases → project.domain →
// brand×country 카탈로그, lib/scope/server.ts::ownedBasePrefixesForProject)을
// 쓴다.
// `countryFilter` 는 ISO alpha-2 목록(scope_answers.region · website_sites.country_code
// 와 같은 표기). 국가를 좁혔는데 자사 베이스는 브랜드 전체로 두면 **다른 나라 자사
// 사이트 인용이 그 나라의 성과로 잡힌다** — 2026-09-01 실측: Kia/KR 화면의 ⑤ 가
// 58.60% 로 나오지만 kia.com/kr 만 세면 55.28% 였고, 전 사이트 평균으로는 44.33% 대
// 31.50% (−12.83%p, 107/107 곳 과대). 계열 누수를 성과로 세던 것이므로 국가 축도
// 함께 좁힌다. 교집합이 비면 브랜드만 적용한 목록으로 폴백(판정 공집합 방지).
// `langFilter` 는 본문 언어 코드(website_prompts.lang_code 와 같은 표기). 국가와 같은
// 이유로 필요하다 — 같은 도메인을 언어로 가른 사이트(hyundaicanada.com = EN,
// hyundaicanada.com/fr = FR)에서 언어만 좁히면 서로를 자사로 센다.
export function ownedBasePrefixesForScope(
  brandFilter?: string[],
  roster?: readonly OwnEntity[],
  countryFilter?: string[],
  langFilter?: string[],
): string[] {
  const brands = new Set<HmgBrand>();
  for (const e of trackedRosterFor(brandFilter, roster)) {
    const b = resolveHmgBrandName(e.name);
    if (b) brands.add(b);
  }
  // 로스터가 전부 비HMG 표기(해석 불가)면 3사 전체 — 판정 공집합 방지.
  const byBrand =
    brands.size === 0
      ? GEO_OWNED_BASES
      : GEO_OWNED_BASES.filter((e) => brands.has(e.brand as HmgBrand));
  const codes = new Set((countryFilter ?? []).filter(Boolean).map((c) => c.toUpperCase()));
  let narrowed = byBrand;
  if (codes.size) {
    const byCountry = byBrand.filter((e) => {
      const iso = geoCountryCode(e.country);
      return iso ? codes.has(iso.toUpperCase()) : false;
    });
    if (byCountry.length) narrowed = byCountry;
  }
  const langs = new Set((langFilter ?? []).filter(Boolean).map((l) => l.toLowerCase()));
  if (langs.size) {
    const byLang = narrowed.filter((e) => e.language && langs.has(e.language.toLowerCase()));
    if (byLang.length) narrowed = byLang;
  }
  return narrowed.map((e) => e.prefix);
}

// 랭킹/추이 표시 병합용 — 알리아스 rollup id → 정본 rollup id 페어. 로스터
// (레지스트리)가 주입되면 그 명부에서 파생하고(이름을 정본으로 해석할 수 있는
// 행 중 id 가 정본과 다른 것), 미주입이면 시드에서 파생한다. 소비처는
// lib/db/repositories/scope-aggregates.ts::canonRollupSql (read-time 접기).
export function rollupCanonicalPairs(
  roster?: readonly OwnEntity[],
): ReadonlyArray<readonly [aliasId: string, canonicalId: string]> {
  const own = roster?.length ? roster : SEED_ROSTER;
  const pairs: Array<readonly [string, string]> = [];
  for (const e of own) {
    const brand = resolveHmgBrandName(e.name);
    if (brand && e.id !== HMG_BRAND_ENTITY_IDS[brand]) {
      pairs.push([e.id, HMG_BRAND_ENTITY_IDS[brand]] as const);
    }
  }
  return pairs;
}

// 진단·전수 배지용(스코프 무관 "HMG 그룹사인가"): 3사 전체 집합 (알리아스 포함).
export const HMG_BRAND_ENTITY_ID_SET = new Set([
  ...Object.values(HMG_BRAND_ENTITY_IDS),
  ...Object.values(HMG_BRAND_ALIAS_ENTITY_IDS).flat(),
]);
export const HMG_BRAND_NAME_SET: Set<string> = new Set(HMG_BRANDS);
export { isHmgBrand };
