import { describe, expect, it } from "vitest";
import {
  GEO_OWNED_BASE_PREFIXES,
  normalizeOwnedBaseUrl,
  ownedBasePrefixFromUrl,
  ownedBaseEntryForUrl,
} from "./owned";

describe("owned base-url attribution", () => {
  it("normalizes scheme, www, query, fragment, and trailing slash", () => {
    expect(
      normalizeOwnedBaseUrl("https://www.kia.com.mm/models?utm_source=test#hero/"),
    ).toBe("kia.com.mm/models");
  });

  it("matches a citation URL to its canonical localized base", () => {
    const owned = ownedBaseEntryForUrl(
      "https://www.kia.com.mm/news/latest?utm_source=test",
    );
    expect(owned?.brand).toBe("Kia");
    expect(owned?.country).toBe("Myanmar");
    expect(owned?.prefix).toBe("kia.com.mm");
  });

  it("does not attribute citations to excluded bases", () => {
    expect(ownedBaseEntryForUrl("https://kia-uae.com/models")).toBeNull();
    expect(GEO_OWNED_BASE_PREFIXES).not.toContain("kia-uae.com");
  });

  it("keeps shared kia.com host as owned when the base is retained", () => {
    const owned = ownedBaseEntryForUrl("https://www.kia.com/jp/ja");
    expect(owned?.prefix?.startsWith("kia.com")).toBe(true);
  });
});

// 2026-08-07 고객 피드백 #5: 베이스가 홈 문서 URL 로 등재돼도 prefix 는
// 브랜드×국가×언어 사이트 루트가 되어야 하위 페이지 인용이 owned 로 잡힌다.
describe("owned base prefix — 홈 문서 URL 절단", () => {
  it("main.html 등 홈 문서 세그먼트는 제거된다", () => {
    expect(ownedBasePrefixFromUrl("https://www.genesis.com/kr/ko/main.html")).toBe(
      "genesis.com/kr/ko",
    );
    expect(ownedBasePrefixFromUrl("https://www.genesis.com/us/en/home")).toBe(
      "genesis.com/us/en",
    );
  });

  it("언어 세그먼트를 겸하는 .html 문서는 확장자만 잘린다", () => {
    expect(ownedBasePrefixFromUrl("https://www.hyundai.com/it/it.html")).toBe(
      "hyundai.com/it/it",
    );
  });

  it("문서가 아닌 베이스는 그대로 유지된다", () => {
    expect(ownedBasePrefixFromUrl("https://www.kia.com/it/it")).toBe("kia.com/it/it");
    expect(ownedBasePrefixFromUrl("https://newsroom.genesis.com/ko-ko/")).toBe(
      "newsroom.genesis.com/ko-ko",
    );
  });

  it("루트 prefix 베이스가 하위 페이지·홈 문서 인용을 모두 잡는다", () => {
    // 카탈로그 원본은 genesis.com/kr/ko/main.html — 절단 후 하위 페이지 매칭.
    const sub = ownedBaseEntryForUrl("https://www.genesis.com/kr/ko/models/gv60/");
    expect(sub?.brand).toBe("Genesis");
    expect(sub?.prefix).toBe("genesis.com/kr/ko");
    // 홈 문서 URL 자체(hyundai.com/it/it.html)도 루트 prefix 와 동치.
    const home = ownedBaseEntryForUrl("https://www.hyundai.com/it/it.html");
    expect(home?.prefix).toBe("hyundai.com/it/it");
  });
});
