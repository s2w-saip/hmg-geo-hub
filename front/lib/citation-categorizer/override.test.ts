import { describe, it, expect } from "vitest";
import {
  categorizeDomain,
  normalizeCitationDomain,
  seedCategoryOf,
  EMPTY_CITATION_OVERRIDES,
  FALLBACK_CATEGORY,
  type CitationCategory,
  type CitationOverrideMap,
} from "./index";
import { classificationSource, overrideShadowsOwned } from "./source";
import { ruleCategory } from "./rules";
import { ownedBrandOf } from "@/lib/geo-catalog/owned";
import rawSeed from "./seed.json";

// 운영자 오버라이드 계층(2026-08-21)의 안전망.
// 회귀 기준: **오버라이드가 0행이면 모든 산출물이 현행과 동일**해야 한다. 그래서
// 여기서는 (a) 우선순위, (b) 파라미터 생략/빈 맵의 무해성, (c) 배지 출처가
// categorizeDomain 의 판정과 어긋나지 않음을 함께 고정한다.

// 각 계층을 대표하는 도메인 — 아래 케이스가 실제로 그 계층에서 결정되는지
// (테스트가 스스로를 검증하도록) 먼저 단언한다.
const OWNED = "kia.com"; // geo-catalog owned inventory
const SEEDED = "caranddriver.com"; // seed.json
// rules.ts 로만 결정되는 도메인. reddit.com 이었으나 2026-08-24 도메인 분류사전
// 병합으로 seed 에 들어가 이 계층 대표에서 탈락했다.
const RULED = "hyundai-forums.com"; // rules.ts (Community & Forums)
const UNKNOWN = "some-random-site.io"; // fallback

describe("오버라이드 우선순위 (override > owned > seed > rule > fallback)", () => {
  it("전제: 각 대표 도메인이 실제로 그 계층에서 결정된다", () => {
    expect(ownedBrandOf(OWNED)).not.toBeNull();
    expect(seedCategoryOf(SEEDED)).not.toBeNull();
    expect(ownedBrandOf(SEEDED)).toBeNull();
    expect(seedCategoryOf(RULED)).toBeNull();
    expect(ruleCategory(RULED)).not.toBeNull();
    expect(seedCategoryOf(UNKNOWN)).toBeNull();
    expect(ruleCategory(UNKNOWN)).toBeNull();
  });

  it("override 가 owned 카탈로그를 이긴다 (아래에 두면 owned 오분류를 UI 로 못 고친다)", () => {
    const ov: CitationOverrideMap = new Map([[OWNED, "Dealer & Marketplace" as CitationCategory]]);
    expect(categorizeDomain(OWNED)).toBe("Official (HMG)");
    expect(categorizeDomain(OWNED, ov)).toBe("Dealer & Marketplace");
    expect(classificationSource(OWNED, ov)).toBe("override");
    // owned 를 덮은 오버라이드는 화면에 경고 배지로 드러나야 한다.
    expect(overrideShadowsOwned(OWNED, ov)).toBe(true);
    expect(overrideShadowsOwned(SEEDED, new Map([[SEEDED, "News & Media" as CitationCategory]]))).toBe(false);
  });

  it("override 가 seed 를 이긴다", () => {
    const ov: CitationOverrideMap = new Map([[SEEDED, "Blogs & Reviews" as CitationCategory]]);
    expect(categorizeDomain(SEEDED)).toBe("Automotive Media");
    expect(categorizeDomain(SEEDED, ov)).toBe("Blogs & Reviews");
    expect(classificationSource(SEEDED, ov)).toBe("override");
  });

  it("override 가 rule 을 이긴다", () => {
    const ov: CitationOverrideMap = new Map([[RULED, "News & Media" as CitationCategory]]);
    expect(categorizeDomain(RULED)).toBe("Community & Forums");
    expect(categorizeDomain(RULED, ov)).toBe("News & Media");
    expect(classificationSource(RULED, ov)).toBe("override");
  });

  it("override 가 fallback 을 이긴다 (미분류 큐레이션의 본래 목적)", () => {
    const ov: CitationOverrideMap = new Map([[UNKNOWN, "Government & Public" as CitationCategory]]);
    expect(categorizeDomain(UNKNOWN)).toBe(FALLBACK_CATEGORY);
    expect(categorizeDomain(UNKNOWN, ov)).toBe("Government & Public");
    expect(classificationSource(UNKNOWN, ov)).toBe("override");
  });

  it("오버라이드 키는 정규화된 도메인 — 호출 입력이 www./대문자여도 맞는다", () => {
    const ov: CitationOverrideMap = new Map([["example.com", "News & Media" as CitationCategory]]);
    expect(categorizeDomain("www.example.com", ov)).toBe("News & Media");
    expect(categorizeDomain("WWW.Example.COM", ov)).toBe("News & Media");
    // 반대로 키가 정규화돼 있지 않으면 조용히 무시된다 — 리포지터리가
    // normalizeCitationDomain 으로 쓰기를 강제하는 이유.
    const bad: CitationOverrideMap = new Map([["www.example.com", "News & Media" as CitationCategory]]);
    expect(categorizeDomain("example.com", bad)).toBe(FALLBACK_CATEGORY);
    expect(normalizeCitationDomain("WWW.Example.COM")).toBe("example.com");
    expect(normalizeCitationDomain(null)).toBe("");
  });

  it("빈/누락 도메인은 오버라이드와 무관하게 Other + fallback 출처", () => {
    const ov: CitationOverrideMap = new Map([["", "News & Media" as CitationCategory]]);
    expect(categorizeDomain("", ov)).toBe(FALLBACK_CATEGORY);
    expect(categorizeDomain(null, ov)).toBe(FALLBACK_CATEGORY);
    expect(classificationSource(null, ov)).toBe("fallback");
    expect(overrideShadowsOwned(null, ov)).toBe(false);
  });
});

describe("회귀 기준 — 오버라이드 0행이면 현행과 동일", () => {
  // 대표 도메인이 아니라 실제 분류 모수 전체(seed 전량 + 규칙/폴백 표본)로 돌린다.
  const probes: string[] = [
    ...Object.keys(rawSeed as Record<string, string>),
    "kia.com", "hyundai.com", "genesis.com", "hyundai.news", "hmfusa.com",
    "toyota.com", "tesla.com", "reddit.com", "www.reddit.com", "youtube.com",
    "medium.com", "nhtsa.gov", "transport.gov.uk", "iihs.org",
    "kiaofstreetsboro.com", "genesisofcolumbiasc.com", "dutchmillerkia.com",
    "wolfchasegenesis.com", "kellyhyundaiofhamburg.com", "bestdealerdeals.com",
    "genesisowners.com", "hyundai-forums.com", "kiaownersclub.co.uk",
    "nokia.com", "wikipedia.org", "namu.wiki", "fandom.com", "britannica.com",
    "wikia.com", "electriccarwiki.com", "suzuki.com", "some-random-site.io", "",
  ];

  it("파라미터 생략 vs undefined vs null vs 빈 맵 — 네 형태가 전 도메인에서 동일", () => {
    for (const d of probes) {
      const base = categorizeDomain(d);
      expect(categorizeDomain(d, undefined), d).toBe(base);
      expect(categorizeDomain(d, null), d).toBe(base);
      expect(categorizeDomain(d, new Map()), d).toBe(base);
      expect(categorizeDomain(d, EMPTY_CITATION_OVERRIDES), d).toBe(base);
    }
  });

  it("무관한 도메인의 오버라이드는 다른 도메인 분류를 건드리지 않는다", () => {
    const ov: CitationOverrideMap = new Map([
      ["totally-unrelated-domain.test", "News & Media" as CitationCategory],
    ]);
    for (const d of probes) {
      expect(categorizeDomain(d, ov), d).toBe(categorizeDomain(d));
    }
  });

  it("빈 맵에서는 분류 출처가 오버라이드 도입 이전 계층만 낸다", () => {
    const seen = new Set<string>();
    for (const d of probes) seen.add(classificationSource(d, EMPTY_CITATION_OVERRIDES));
    expect(seen.has("override")).toBe(false);
  });
});

describe("classificationSource 는 categorizeDomain 과 같은 사슬을 걷는다", () => {
  const ov: CitationOverrideMap = new Map([
    [OWNED, "Dealer & Marketplace" as CitationCategory],
    [UNKNOWN, "Government & Public" as CitationCategory],
  ]);
  const probes = [OWNED, SEEDED, RULED, UNKNOWN, "hyundai.news", "wikia.com", ""];

  it("보고된 계층의 값이 실제 반환값과 일치한다", () => {
    for (const d of probes) {
      const cat = categorizeDomain(d, ov);
      const src = classificationSource(d, ov);
      const n = normalizeCitationDomain(d);
      switch (src) {
        case "override":
          expect(ov.get(n), d).toBe(cat);
          break;
        case "owned":
          expect(cat, d).toBe("Official (HMG)");
          break;
        case "seed":
          expect(seedCategoryOf(n), d).toBe(cat);
          break;
        case "rule":
          expect(ruleCategory(n), d).toBe(cat);
          break;
        case "fallback":
          expect(cat, d).toBe(FALLBACK_CATEGORY);
          break;
      }
    }
  });
});
