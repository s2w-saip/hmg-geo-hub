import { describe, it, expect } from "vitest";
import {
  categorizeDomain,
  isCitationCategory,
  FALLBACK_CATEGORY,
  SEED_DOMAIN_COUNT,
} from "./index";
import rawSeed from "./seed.json";

// Pins the local citation-source classification (scope sends no category —
// this module is the sole source for the Citation Sources card/pie/badge).

describe("categorizeDomain precedence", () => {
  it("geo-catalog owned domains → Official (HMG), above every other rule", () => {
    expect(categorizeDomain("kia.com")).toBe("Official (HMG)");
    expect(categorizeDomain("hyundai.com")).toBe("Official (HMG)");
    expect(categorizeDomain("genesis.com")).toBe("Official (HMG)");
  });

  it("seed overrides the contained-brand dealer heuristic (HMG press/finance)", () => {
    expect(categorizeDomain("hyundai.news")).toBe("Official (HMG)");
    expect(categorizeDomain("hmfusa.com")).toBe("Official (HMG)");
  });

  it("seed classifies curated media/marketplace domains", () => {
    expect(categorizeDomain("caranddriver.com")).toBe("Automotive Media");
    // KBB 는 시세·리뷰 발행이 본류다. 앤서 Quick-Win 사전이 Dealer 로 판정해 한때
    // 그렇게 넣었으나, 고객(GGMD) 사전과의 교차감사에서 되돌렸다 — 미러 13,961행.
    // 판정 근거: scripts/citations/dictionary-rulings.json
    expect(categorizeDomain("kbb.com")).toBe("Automotive Media");
    expect(categorizeDomain("cars.com")).toBe("Dealer & Marketplace");
    expect(categorizeDomain("forbes.com")).toBe("News & Media");
    expect(categorizeDomain("consumerreports.org")).toBe("Blogs & Reviews");
  });
});

describe("generic rules", () => {
  it("competitor OEM official sites", () => {
    expect(categorizeDomain("toyota.com")).toBe("Official (Competitor)");
    expect(categorizeDomain("tesla.com")).toBe("Official (Competitor)");
  });

  it("platform lists (community / social / blogs)", () => {
    expect(categorizeDomain("reddit.com")).toBe("Community & Forums");
    expect(categorizeDomain("www.reddit.com")).toBe("Community & Forums"); // www-normalized
    expect(categorizeDomain("youtube.com")).toBe("Social & Video");
    expect(categorizeDomain("medium.com")).toBe("Blogs & Reviews");
  });

  it("gov/public TLDs and orgs", () => {
    expect(categorizeDomain("nhtsa.gov")).toBe("Government & Public");
    expect(categorizeDomain("transport.gov.uk")).toBe("Government & Public");
    expect(categorizeDomain("iihs.org")).toBe("Government & Public");
  });

  it("dealer patterns: brand prefix, contained brand, and 'dealer' substring", () => {
    expect(categorizeDomain("kiaofstreetsboro.com")).toBe("Dealer & Marketplace");
    expect(categorizeDomain("genesisofcolumbiasc.com")).toBe("Dealer & Marketplace");
    expect(categorizeDomain("dutchmillerkia.com")).toBe("Dealer & Marketplace"); // brand suffix
    expect(categorizeDomain("wolfchasegenesis.com")).toBe("Dealer & Marketplace");
    expect(categorizeDomain("kellyhyundaiofhamburg.com")).toBe("Dealer & Marketplace");
    expect(categorizeDomain("bestdealerdeals.com")).toBe("Dealer & Marketplace");
  });

  it("community signals beat the dealer heuristic", () => {
    expect(categorizeDomain("genesisowners.com")).toBe("Community & Forums");
    expect(categorizeDomain("hyundai-forums.com")).toBe("Community & Forums");
    expect(categorizeDomain("kiaownersclub.co.uk")).toBe("Community & Forums");
  });

  it("contained-brand denylist: nokia is not a Kia dealer", () => {
    expect(categorizeDomain("nokia.com")).toBe(FALLBACK_CATEGORY);
  });

  // 2026-08-06 고객 피드백: Wiki 단독 분류. wikia.com 은 contained-brand
  // denylist("kia" 오탐)와 겹치지만 Wiki 규칙이 먼저 잡는다 (순서 의존).
  it("wiki & reference: explicit set, .wiki TLD, and the wikia ordering", () => {
    expect(categorizeDomain("wikipedia.org")).toBe("Wiki & Reference");
    expect(categorizeDomain("namu.wiki")).toBe("Wiki & Reference");
    expect(categorizeDomain("fandom.com")).toBe("Wiki & Reference");
    expect(categorizeDomain("britannica.com")).toBe("Wiki & Reference");
    expect(categorizeDomain("wikia.com")).toBe("Wiki & Reference");
    // seed 명시 엔트리는 규칙보다 우선 — wiki 라벨이 있어도 Automotive Media 유지.
    expect(categorizeDomain("electriccarwiki.com")).toBe("Automotive Media");
    // 'uki' 포함 무관 도메인은 오탐 없음 (suzuki 는 경쟁사 공식).
    expect(categorizeDomain("suzuki.com")).toBe("Official (Competitor)");
  });
});

describe("fallback", () => {
  it("unknown / empty / null domains → Other", () => {
    expect(categorizeDomain("some-random-site.io")).toBe(FALLBACK_CATEGORY);
    expect(categorizeDomain("")).toBe(FALLBACK_CATEGORY);
    expect(categorizeDomain(null)).toBe(FALLBACK_CATEGORY);
    expect(categorizeDomain(undefined)).toBe(FALLBACK_CATEGORY);
  });
});

describe("seed integrity", () => {
  const entries = Object.entries(rawSeed as Record<string, string>);

  it("every seed value is a valid taxonomy category (invalid ones are dropped at load)", () => {
    for (const [domain, category] of entries) {
      expect(isCitationCategory(category), `${domain} → ${category}`).toBe(true);
    }
    // No entry was dropped by the loader.
    expect(SEED_DOMAIN_COUNT).toBe(entries.length);
  });

  it("seed keys are normalized registrable domains (lowercase, no www/scheme)", () => {
    for (const [domain] of entries) {
      expect(domain).toBe(domain.toLowerCase());
      expect(domain.startsWith("www.")).toBe(false);
      expect(domain.includes("/")).toBe(false);
    }
  });
});
