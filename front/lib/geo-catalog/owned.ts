// Owned-domain / owned-base layer of the geo catalog — SERVER-SIDE ONLY by
// convention (not marked "server-only" so vitest and scripts can import it).
//
// Split out of ./index.ts on 2026-08-24. Two reasons, in order:
//   1. It is the only part of the catalog that needs eTLD+1 resolution, and the
//      single authority for that is lib/public-suffix (a 147KB committed PSL
//      snapshot). ./index.ts is imported by client components, so keeping this
//      here would ship the snapshot to the browser — measured at +50 kB First
//      Load JS across 9 routes before the split.
//   2. Owned-domain judgement is a KPI ⑤ input; giving it its own module makes
//      the import graph say so.
//
// The hand-maintained 24-entry TWO_LEVEL_TLDS that used to sit here is gone.
// Its own comment already admitted it "over-collapses e.g. hyundai.com.ua ->
// com.ua", and two rounds of adding entries (8 -> 24) still left 207 suffixes
// leaking in live data — a flat Set cannot express PSL wildcard (`*.mm`) or
// exception (`!city.kobe.jp`) rules at all.
//
// Verified behaviour-preserving for this catalog: the derived owned set is the
// same 42 registrable domains / 170 base prefixes before and after the swap.

import { GEO_ENTRIES } from "./index";
import { normalizeUrlForMatch } from "@/lib/scope/url-match";
import { registrableDomainOfHost } from "@/lib/public-suffix";

export { registrableDomainOfHost };

// ── Owned-domain set (for precise citation attribution) ──────────────────
// Canonical HMG site base URLs (country/path included where applicable) plus a
// derived registrable-domain allowlist for the legacy host-based surfaces.
//
// KPI ⑤ now attributes a citation as "ours" when the CITED URL belongs to one
// of these base URL prefixes, not merely because the host looks HMG-owned.
// Example: an answer ASKED from Italy that cites https://kia.com/uk/... stays an
// Italy answer, while the citation itself is attributed to the UK Kia base.

// 2026-05-22 verified canonical list (`HMG_정본리스트_검증_20260522.xlsx`):
// these geo-catalog rows exist, but they are not part of the validated HMG 108
// canonical site set used for owned-domain attribution. Exclude them from KPI ⑤
// so the allowlist follows the checked canonical inventory rather than every
// raw geo-catalog host.
const EXCLUDED_OWNED_DOMAINS = new Set([
  "hyundaiksa.com",
  "kiaphilippines.com",
  "kia.by",
  "kia.ma",
  "kia.co.za",
  "kia.com.sv",
  // Operator-requested removals (2026-07-02). Note that kia.com/* path-level
  // removals cannot be expressed here without excluding the whole shared host.
  "kia-uae.com",
  "kia.uz",
  "kia.com.br",
  "kia.am",
  "kia.cn",
]);

// 카탈로그 원천(webgeo_final_list.xlsx → _data/web-geo-final.json)의 사이트 URL 오등록
// 교정 (2026-09-01). 원천 xlsx 를 다시 추출해도 살아남도록 코드에 둔다 — 원천이 고쳐지면
// 이 맵은 무해하게 중복될 뿐이다. 키는 원천의 url 그대로, 값은 그 사이트의 실제 base.
//
//  · hyundai.com/kr/ko/e — `/e` 는 URL 조각이다. 이 접두가 채택되면 현대 한국의 타겟
//    116개 중 56개(`/brand` 15 · `/service-membership` 21 · `/digital-customer-support`
//    10 등)가 자사 밖으로 떨어진다. 실제 base 는 hyundai.com/kr/ko — 그 접두로는 116개
//    전부가 안에 들어온다(2026-09-01 실측).
//  · genesis.com/ru/ru/genesis.html — 홈 문서 URL 이라 접두가 `…/ru/ru/genesis` 로
//    잘린다. 실제 base 는 genesis.com/ru/ru.
//
// 국가 사이트가 언어 경로 없이 `host/<국가>/<섹션>` 으로 갈라지는데 원천이 홈 URL
// (…/au/en · …/it/it · …/tr/anasayfa.html · …/my/en · …/cz/cz.html)로 등재된 5곳
// (2026-09-29). 홈 접두로는 그 나라 사이트 인용 대부분이 자사 밖으로 떨어진다. 값은
// Website 표면이 측정 유닛별로 이미 선언한 base(0049 `website_prompts.owned_base_url`)와
// 같다. 수치 = 9/28 글로벌 회차(e4107918) 해당 브랜드·국가 답변의 자사 인용 / 전체 인용.
//  · kia.com/au/en → kia.com/au: 10 → 591 / 9,022 (0.11% → 6.55%). /cars·/owners·/shopping-tools.
//  · kia.com/it/it → kia.com/it: 29 → 790 / 8,477 (0.34% → 9.32%). /tutto-su-kia·/guida-all-acquisto.
//  · kia.com/tr/anasayfa.html → kia.com/tr: 13 → 577 / 8,612 (0.15% → 6.70%). `anasayfa` 가
//    홈 문서명 규칙(main|index|home) 밖이라 접두가 `…/tr/anasayfa` 로 남던 것.
//  · kia.com/my/en → kia.com/my: 26 → 410 / 9,997 (0.26% → 4.10%). /owners·/util·/showroom.
//  · hyundai.com/cz/cz.html → hyundai.com/cz: 11 → 436 / 11,959 (0.09% → 3.65%). /prodej·/modely.
// 보류: kia.com/nmc/ar · kia.com/om/ar · genesis.com/es/es 는 국가 경로 아래가 언어로 갈린다
// (/en 과 /ar·/es 가 공존). 국가 접두로 넓히면 카탈로그에 없는 다른 언어 사이트를 자사로
// 세게 되므로 넣지 않았다(언어를 가른 사이트는 서로를 자사로 세지 않는다는 규칙과 같은 이유).
const OWNED_BASE_URL_FIXES: Readonly<Record<string, string>> = {
  "https://www.hyundai.com/kr/ko/e": "https://www.hyundai.com/kr/ko",
  "https://www.genesis.com/ru/ru/genesis.html": "https://www.genesis.com/ru/ru",
  "https://www.kia.com/au/en": "https://www.kia.com/au",
  "https://www.kia.com/it/it": "https://www.kia.com/it",
  "https://www.kia.com/tr/anasayfa.html": "https://www.kia.com/tr",
  "https://www.kia.com/my/en": "https://www.kia.com/my",
  "https://www.hyundai.com/cz/cz.html": "https://www.hyundai.com/cz",
};

// `registrableDomainOfHost` is re-exported above: the citation aggregation
// derives the owned-domain candidate/fallback set from a list of owned base-URL
// prefixes (host + optional path) rather than the global catalog — the 축E
// brand-scoped official-citation judgment needs a domain set that matches
// exactly the bases it was given.

function registrableDomain(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return registrableDomainOfHost(host);
}

// domain → owning brand (first brand seen for that registrable domain).
const DOMAIN_TO_BRAND = new Map<string, string>();
for (const e of GEO_ENTRIES) {
  if (!e.url) continue;
  const d = registrableDomain(e.url);
  if (d && !EXCLUDED_OWNED_DOMAINS.has(d) && !DOMAIN_TO_BRAND.has(d)) {
    DOMAIN_TO_BRAND.set(d, e.brand);
  }
}

/** Distinct registrable domains of every brand site (owned-citation allowlist). */
export const GEO_OWNED_DOMAINS: string[] = [...DOMAIN_TO_BRAND.keys()];

/** Whether a cited domain is a brand-owned site (catalog match). */
export function isOwnedDomain(domain: string): boolean {
  return ownedBrandOf(domain) !== null;
}

/** Which brand owns a cited domain (exact or subdomain match), or null. */
export function ownedBrandOf(domain: string): string | null {
  const d = domain.toLowerCase().replace(/^www\./, "");
  for (const owned of GEO_OWNED_DOMAINS) {
    if (d === owned || d.endsWith(`.${owned}`)) {
      return DOMAIN_TO_BRAND.get(owned) ?? null;
    }
  }
  return null;
}

// KPI ⑤ base-url normalization: scheme / www / query / fragment / trailing
// slash differences are ignored so a cited page under the same localized site
// rolls up to that site regardless of tracking params.
export function normalizeOwnedBaseUrl(raw: string | null | undefined): string {
  const norm = normalizeUrlForMatch(raw);
  if (!norm) return "";
  return norm.split("?")[0] ?? "";
}

// 베이스 URL → owned 판정 prefix ("브랜드×국가×언어 사이트 루트").
// 카탈로그/프로젝트 설정의 베이스가 홈 문서 URL(…/main.html, …/home,
// …/it/it.html)로 등재되면 그대로는 하위 페이지(…/kr/ko/models/…)가 전부
// prefix 매칭에서 빠진다 (2026-08-07 고객 피드백 #5 결정: www.genesis.com/kr/ko/
// 가 베이스가 되도록). 마지막 세그먼트가 홈 문서명(main|index|home[.확장자])이면
// 세그먼트를 제거하고, 그 외 .html/.htm 문서면 확장자만 잘라낸다
// (hyundai.com/it/it.html → hyundai.com/it/it — 세그먼트가 언어 코드를 겸함).
// 인용 URL 쪽 정규화(normalizeOwnedBaseUrl)는 SQL 쌍둥이(citationBaseNormSql)
// 와의 패리티 계약 때문에 손대지 않는다 — 홈 문서 인용 자체는
// matchesOwnedBasePrefix / ownedBasePrefixClause 의 '.html' 동치 분기가 잡는다.
export function ownedBasePrefixFromUrl(raw: string | null | undefined): string {
  const norm = normalizeOwnedBaseUrl(raw);
  if (!norm) return "";
  const slash = norm.lastIndexOf("/");
  if (slash === -1) return norm; // 도메인 단독
  const seg = norm.slice(slash + 1);
  if (/^(main|index|home)(\.[a-z0-9]+)?$/.test(seg)) return norm.slice(0, slash);
  const doc = seg.match(/^(.+)\.html?$/);
  if (doc) return `${norm.slice(0, slash + 1)}${doc[1]}`;
  return norm;
}

// 브랜드 전 세계 사이트가 국가 경로로 갈라지는 **공유 글로벌 호스트**. 이 호스트의 루트
// (hyundai.com)는 특정 국가 유닛의 홈이 아니라 글로벌 랜딩이므로, 아래 '사이트 루트 홈 =
// 자사' 규칙에서 제외한다. 그 외 호스트(kia.ca·hyundaicanada.com·hyundai-n.com …)는 한 사이트가
// 언어로만 갈라지므로 루트 홈이 모든 언어 유닛의 홈이다.
export const SHARED_GLOBAL_HOSTS: ReadonlySet<string> = new Set(["hyundai.com", "kia.com", "genesis.com"]);

// 사이트 루트 홈 판정 — 정규화 URL 이 (쿼리·끝 슬래시를 떼면) 호스트 그 자체인가.
// 2026-09-06 제품 결정: `www.kia.ca` · `kia.ca/` · `kia.ca/?isCL=1&location=…` 는 EN·FR 어느
// 유닛에서 봐도 그 사이트의 홈이라 자사다. 선언 base 가 언어 경로(kia.ca/en)라 prefix 로는 빠지고,
// FR 유닛엔 루트 타겟도 없어 타겟 규칙(PR #213)으로도 잡히지 않던 21건(2026-09-04 회차, 6유닛).
// 쿼리를 떼는 이유: 위치 쿠키(isCL/location) 같은 자원 비식별 쿼리가 붙은 루트 인용이 ⑥ 경로의
// tracked 정규화(비-트래킹 쿼리 보존)에서 루트와 갈라졌다. SQL 쌍둥이 = ownedBasePrefixClause.
export function isSiteRootHome(normUrl: string, host: string): boolean {
  if (SHARED_GLOBAL_HOSTS.has(host)) return false;
  const noQuery = normUrl.split("?")[0] ?? "";
  return noQuery.replace(/\/+$/, "") === host;
}

function matchesOwnedBasePrefix(normUrl: string, basePrefix: string): boolean {
  return (
    normUrl === basePrefix ||
    normUrl.startsWith(`${basePrefix}/`) ||
    // 홈 문서 URL 인용(hyundai.com/it/it.html)을 루트 prefix(hyundai.com/it/it)
    // 와 동치로 — SQL 쌍둥이 ownedBasePrefixClause 와 동일 분기.
    normUrl === `${basePrefix}.html`
  );
}

export interface OwnedBaseEntry {
  brand: string;
  region: string;
  country: string;
  /** 본문 실측 언어(GeoEntry.language) — 같은 도메인을 언어로 가른 사이트를
   *  자사 판정에서 구분하기 위해 싣는다(2026-09-01). null = 카탈로그 미기재. */
  language: string | null;
  url: string;
  prefix: string;
}

const OWNED_BASE_BY_PREFIX = new Map<string, OwnedBaseEntry>();
for (const e of GEO_ENTRIES) {
  if (!e.url) continue;
  const url = OWNED_BASE_URL_FIXES[e.url] ?? e.url;
  const d = registrableDomain(url);
  if (!d || EXCLUDED_OWNED_DOMAINS.has(d)) continue;
  const prefix = ownedBasePrefixFromUrl(url);
  if (!prefix || OWNED_BASE_BY_PREFIX.has(prefix)) continue;
  OWNED_BASE_BY_PREFIX.set(prefix, {
    brand: e.brand,
    region: e.region,
    country: e.country,
    language: e.language ?? null,
    url,
    prefix,
  });
}

/** Canonical HMG localized site bases used by KPI ⑤ (host + country path). */
export const GEO_OWNED_BASES: OwnedBaseEntry[] = [...OWNED_BASE_BY_PREFIX.values()];

/** Normalized base-url prefixes that count as "ours" for KPI ⑤. */
export const GEO_OWNED_BASE_PREFIXES: string[] = GEO_OWNED_BASES.map((e) => e.prefix);

const GEO_OWNED_BASES_DESC = [...GEO_OWNED_BASES].sort(
  (a, b) => b.prefix.length - a.prefix.length,
);

/**
 * Which canonical owned base a cited URL belongs to, or null. This is the
 * source of truth for KPI ⑤ attribution and keeps answer market attribution
 * separate from cited-site market attribution.
 */
export function ownedBaseEntryForUrl(url: string): OwnedBaseEntry | null {
  const norm = normalizeOwnedBaseUrl(url);
  if (!norm) return null;
  for (const e of GEO_OWNED_BASES_DESC) {
    if (matchesOwnedBasePrefix(norm, e.prefix)) return e;
  }
  // 사이트 루트 홈 — 같은 호스트의 base 중 가장 짧은 것(호스트에 가장 가까운 유닛)에 귀속.
  for (const e of [...GEO_OWNED_BASES_DESC].reverse()) {
    if (isSiteRootHome(norm, e.prefix.split("/")[0] ?? "")) return e;
  }
  return null;
}

/** Whether a cited URL belongs to one of the canonical owned site bases. */
export function isOwnedBaseUrl(url: string): boolean {
  return ownedBaseEntryForUrl(url) !== null;
}

