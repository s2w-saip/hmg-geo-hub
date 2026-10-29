// Deterministic rule pass of the citation-source categorizer. No LLM, no I/O —
// every rule is reviewable code, so classification is reproducible and
// auditable (design decision 2026-07-02: runtime LLM rejected).
//
// Input is a registrable domain (both aggregation paths already collapse hosts
// via registrableDomain()). Precedence is encoded in categorizeDomain() in
// ./index.ts: owned catalog → seed → these generic rules → fallback.

import type { CitationCategory } from "./taxonomy";

// The label of a registrable domain — everything left of the public suffix.
// Input to this module is ALWAYS a registrable domain (categorizeDomain()
// normalizes, and both aggregation paths fold hosts through
// lib/public-suffix), so the first label is the registered name by definition:
// "bmw.co.kr" -> "bmw", "bmwofaustin.com" -> "bmwofaustin".
function domainLabel(domain: string): string {
  return domain.split(".")[0] ?? "";
}

// HMG official sites whose registrable domain is EXACTLY a brand name.
//
// Why this exists and why it runs first: the geo-catalog owned set is the
// verified canonical 108-site inventory, which deliberately does NOT contain
// every HMG country site. Everything it omits used to fall through to the
// CONTAINED_BRAND dealer heuristic below and be reported to the customer as
// "딜러·마켓플레이스" — measured 2026-08-24: hyundai.com.py, genesis.com.vn,
// genesis.com.pr and friends, plus the 39,447 mirror rows whose country-site
// host the old TWO_LEVEL_TLDS truncation had already destroyed.
//
// Exact-label match only. "hyundaiofalbany.com" / "kiavietnam.com.vn" /
// "mongolhyundai.mn" do NOT match here — those are dealer or affiliate sites and
// are curated in seed.json individually when they are in fact official.
//
// "genesis" is an ordinary English word, so it is accepted only under a
// multi-part registry suffix (genesis.com.pr, genesis.com.vn) — enough for
// every HMG country site while leaving genesis.io / genesis.co style
// third-party domains alone. "hyundai" and "kia" are unambiguous.
const HMG_BRAND_LABEL = new Set(["hyundai", "kia"]);

function isHmgBrandDomain(domain: string): boolean {
  const label = domainLabel(domain);
  if (HMG_BRAND_LABEL.has(label)) return true;
  return label === "genesis" && domain.split(".").length >= 3;
}

// Competitor OEM official sites (registrable domains). HMG-owned sites are NOT
// listed here — they come from the geo-catalog owned-domain set, which is the
// verified canonical inventory.
const COMPETITOR_OFFICIAL = new Set([
  "toyota.com", "toyota.jp", "lexus.com", "honda.com", "acura.com",
  "ford.com", "lincoln.com", "chevrolet.com", "gmc.com", "cadillac.com",
  "buick.com", "gm.com", "jeep.com", "dodge.com", "ramtrucks.com",
  "chrysler.com", "stellantis.com", "fiat.com",
  "nissan.com", "nissanusa.com", "infinitiusa.com", "infiniti.com",
  "mazda.com", "mazdausa.com", "subaru.com", "mitsubishicars.com",
  "mitsubishi-motors.com", "vw.com", "volkswagen.com", "audi.com",
  "audiusa.com", "porsche.com", "skoda-auto.com", "seat.com", "cupra.com",
  "bmw.com", "bmwusa.com", "mini.com", "mercedes-benz.com", "mbusa.com",
  "smart.com", "volvocars.com", "polestar.com", "jaguar.com",
  "landrover.com", "tesla.com", "rivian.com", "lucidmotors.com",
  "renault.com", "peugeot.com", "citroen.com", "opel.com", "dacia.com",
  "byd.com", "bydauto.com", "mg.co.uk", "mgmotor.com", "gwm.com",
  "chery.com", "suzuki.com", "isuzu.com", "toyotabharat.com",
]);

// Competitor country sites. COMPETITOR_OFFICIAL above is an exact-match Set, so
// it could only ever list .com — bmw.co.kr (1,632 mirror rows),
// mercedes-benz.co.kr (1,211) and lexus.co.kr (3,457) all fell through to Other.
// Same exact-label test as the HMG rule, which is what keeps dealer sites out:
// "bmw.co.kr" matches, "bmwofaustin.com" does not.
//
// Deliberately excluded because the label is an ordinary word and the exact
// .com forms are already listed above: mini, smart, mg, gm.
const COMPETITOR_BRAND_LABEL = new Set([
  "toyota", "lexus", "daihatsu", "hino", "honda", "acura",
  "ford", "lincoln", "chevrolet", "chevy", "gmc", "cadillac", "buick",
  "jeep", "dodge", "ramtrucks", "chrysler", "stellantis", "fiat",
  "alfaromeo", "maserati", "lancia", "abarth",
  "nissan", "infiniti", "datsun", "mazda", "subaru",
  "mitsubishi", "mitsubishi-motors",
  "volkswagen", "vw", "audi", "porsche", "skoda", "skoda-auto", "seat", "cupra",
  "bmw", "mercedes-benz", "mercedes", "maybach",
  "volvocars", "polestar", "jaguar", "landrover", "land-rover",
  "tesla", "rivian", "lucidmotors",
  "renault", "peugeot", "citroen", "opel", "dacia", "alpine",
  "byd", "bydauto", "chery", "geely", "gwm", "haval", "wuling",
  "nio", "xpeng", "lixiang", "zeekr", "ora",
  "suzuki", "isuzu", "tata", "mahindra", "ssangyong", "kgm",
]);

const COMMUNITY = new Set([
  "reddit.com", "quora.com", "stackexchange.com", "stackoverflow.com",
  "discord.com", "dcinside.com", "clien.net", "bobaedream.co.kr",
  "fmkorea.com", "ppomppu.co.kr",
]);

const SOCIAL_VIDEO = new Set([
  "youtube.com", "youtu.be", "tiktok.com", "instagram.com", "facebook.com",
  "x.com", "twitter.com", "threads.net", "linkedin.com", "pinterest.com",
  "vimeo.com", "twitch.tv", "snapchat.com", "dailymotion.com",
]);

const BLOG_PLATFORMS = new Set([
  "medium.com", "substack.com", "blogspot.com", "wordpress.com",
  "tumblr.com", "tistory.com", "brunch.co.kr",
]);

// Public-interest safety/regulatory orgs that aren't on a gov TLD.
const PUBLIC_ORGS = new Set([
  "iihs.org", "nhtsa.gov", "epa.gov", "fueleconomy.gov",
]);

// 위키·백과류 (2026-08-06 고객 피드백: Wiki 단독 분류). wikia.com 은
// CONTAINED_BRAND_DENY 에도 있으나("kia" 오탐 방지) 여기서 먼저 잡힌다.
const WIKI_REFERENCE = new Set([
  "wikipedia.org", "wikimedia.org", "wiktionary.org", "wikidata.org",
  "namu.wiki", "fandom.com", "wikia.com", "britannica.com", "dbpedia.org",
]);
// wiki 를 도메인 라벨로 쓰는 사이트(electriccarwiki.com 등). 라벨 경계 앵커라
// "kiwi" 류 오탐 없음; seed 명시 엔트리가 있으면 그쪽이 우선한다.
const WIKI_PATTERN = /(?:^|\.|-)wiki(?:$|\.|-)|\.wiki$/;

// Brand tokens that mark a dealer site when they PREFIX a non-owned,
// non-competitor domain (kiaofstreetsboro.com, genesismilwaukee.com,
// toyotaofseattle.com). Prefix-anchored so nokia.com etc. can't match.
const DEALER_BRAND_PREFIX =
  /^(?:hyundai|kia|genesis|toyota|lexus|honda|ford|chevrolet|chevy|nissan|mazda|subaru|vw|volkswagen|audi|bmw|mercedes|volvo|jeep|dodge|buick|gmc|cadillac|acura|infiniti|mitsubishi)(?:of|-)?[a-z][a-z0-9-]*\.[a-z.]+$/;

// 정부·공공 접미사. 국가별 gov/go 접미사를 하나씩 나열하던 것을 패턴으로 바꿨다 —
// 열거 방식은 이 PR 이 지우는 TWO_LEVEL_TLDS 와 같은 실패를 반복한다(실측: www.gov.br
// 313행·gov.kr 240행이 열거에 없어 Other 였다). 라벨 경계 앵커라 "chicago.kr"·"cargo.jp"
// 같은 우연한 부분일치는 걸리지 않는다.
const GOV_TLD =
  /(?:^|\.)(?:gov|mil)$|(?:^|\.)(?:gov|gouv|go|mil)\.[a-z]{2}$|(?:^|\.)(?:gc\.ca|europa\.eu)$/;

// Dealer names commonly EMBED the brand ("dutchmillerkia.com",
// "wolfchasegenesis.com", "kellyhyundaiofhamburg.com"), so a contained brand
// token on a non-owned domain is a dealer signal. "hyundai" is unambiguous;
// "kia"/"genesis" appear inside unrelated words, so known non-dealer domains
// are denylisted (seed entries also override this rule).
const CONTAINED_BRAND = /hyundai|kia|genesis|chevy|chevrolet|toyota|lexus|nissan|subaru|mazda|cadillac|buick/;
const CONTAINED_BRAND_DENY = new Set([
  "nokia.com", "wikia.com", "kiala.com", "sagenesis.com",
]);


// ── 2026-08-28 신설: 수상·인증 / 학술·연구 ────────────────────────────────────
// 고객(이노션) 확정으로 종전 Government & Public 이 셋으로 갈라졌다. 여기 두 축은
// **소유 주체가 민간이어도** 공신력으로 인용되는 출처다 — 그래서 "정부·공공"과
// 섞이면 안 되고(사용성 혼란), "기타"로 떨어져도 안 된다(출처 성격이 죽는다).
//
// ⚠️ 정부가 소유한 연구기관(nih.gov 등)은 **Government & Public 을 유지한다** —
// 공공 축의 기준이 "소유·운영 주체"라서다. 그래서 GOV 판정을 이 둘보다 먼저 둔다.
const AWARD_CERT = new Set([
  "red-dot.org", "red-dot.de", "red-dot.cn",
  "ifdesign.com", "ifworlddesignguide.com",
  "gooddesignawards.com", "good-designawards.com",
  "idsa.org",
  "worldcarawards.com",
  "euroncap.com", "greenncap.com", "iihs.org",
]);
// 여기 넣지 않은 것들:
//   nhtsa.gov  — 정부 소유라 GOV 판정이 먼저 잡는다(위 ⚠️). 넣으면 죽은 항목이 된다.
//   caranddriver·wardsauto — 시상도 하지만 성격은 자동차 매체다. 시드가 이미
//     Automotive Media 로 잡고 있고, 시드는 항상 룰보다 우선한다(index.ts).
//   michelin — 분류 단위가 **registrable domain** 이라 guide.michelin.com 이
//     michelin.com 으로 접힌다. 룰에 넣으면 타이어 사업 도메인까지 수상·인증으로
//     끌려간다. 고객이 미쉐린 가이드를 이 축에 원하면 운영자 오버라이드
//     (citation_domain_overrides · /admin/standards/citation-sources)로 처리한다.

const ACADEMIC_TLD = /(?:^|\.)edu$|(?:^|\.)(?:ac|edu)\.[a-z]{2}$/;
const ACADEMIC_ORGS = new Set([
  "arxiv.org", "jstor.org", "sciencedirect.com", "springer.com",
  "springeropen.com", "nature.com", "science.org", "ieee.org",
  "researchgate.net", "academia.edu", "ssrn.com", "mdpi.com",
  "tandfonline.com", "wiley.com", "sagepub.com", "plos.org",
  "semanticscholar.org", "scholar.google.com",
  "dbpia.co.kr", "riss.kr", "kci.go.kr",
]);

/**
 * Generic (non-seed) rules over a normalized registrable domain.
 * Returns null when no rule fires — the caller decides the fallback.
 */
export function ruleCategory(domain: string): CitationCategory | null {
  // Ownership statements come first — both of them, and specifically BEFORE the
  // dealer heuristics at the bottom of this function. A brand-owned country
  // site is not a dealer just because its name contains the brand.
  if (isHmgBrandDomain(domain)) return "Official (HMG)";
  if (COMPETITOR_OFFICIAL.has(domain)) return "Official (Competitor)";
  if (COMPETITOR_BRAND_LABEL.has(domainLabel(domain))) return "Official (Competitor)";
  // Wiki 는 CONTAINED_BRAND("kia" in wikia 등)보다 먼저 — 순서 의존.
  if (WIKI_REFERENCE.has(domain) || WIKI_PATTERN.test(domain)) return "Wiki & Reference";
  if (COMMUNITY.has(domain)) return "Community & Forums";
  if (SOCIAL_VIDEO.has(domain)) return "Social & Video";
  if (BLOG_PLATFORMS.has(domain)) return "Blogs & Reviews";
  // 소유·운영 주체가 정부·공공인 것 — 정부 소유 연구기관도 여기다(아래 두 축보다 먼저).
  if (PUBLIC_ORGS.has(domain) || GOV_TLD.test(domain)) return "Government & Public";
  if (AWARD_CERT.has(domain)) return "Award & Certification";
  if (ACADEMIC_ORGS.has(domain) || ACADEMIC_TLD.test(domain)) return "Academic & Research";
  // Substring signals, checked before the dealer prefix so e.g.
  // hyundai-forums.com / kiaownersclub.co.uk land in Community.
  if (/forum|ownersclub|owners\./.test(domain)) return "Community & Forums";
  if (/dealer/.test(domain)) return "Dealer & Marketplace";
  if (DEALER_BRAND_PREFIX.test(domain)) return "Dealer & Marketplace";
  if (CONTAINED_BRAND.test(domain) && !CONTAINED_BRAND_DENY.has(domain)) {
    return "Dealer & Marketplace";
  }
  return null;
}
