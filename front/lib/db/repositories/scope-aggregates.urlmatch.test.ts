import { describe, it, expect } from "vitest";
import { normalizeUrlForMatch } from "./scope-aggregates";
import { domainHost } from "@/lib/scope/url-match";

// KPI ⑥ 분모(자사 도메인 프리픽스)·분자(추적 URL) 공통 정규화. SQL 쪽
// cnorm(scheme/www/끝 슬래시 제거)과 round-trip 으로 같은 형태여야 매칭이
// 성립한다. 쿼리스트링은 의도적으로 보존(다른 URL).
describe("normalizeUrlForMatch", () => {
  it("strips scheme, leading www, and trailing slash", () => {
    expect(normalizeUrlForMatch("https://www.kia.com/it/")).toBe("kia.com/it");
    expect(normalizeUrlForMatch("http://kia.com")).toBe("kia.com");
    expect(normalizeUrlForMatch("kia.com/it/it")).toBe("kia.com/it/it");
  });

  it("lowercases and trims", () => {
    expect(normalizeUrlForMatch("  HTTPS://WWW.Kia.com/IT  ")).toBe(
      "kia.com/it",
    );
  });

  it("collapses multiple trailing slashes", () => {
    expect(normalizeUrlForMatch("kia.com/it///")).toBe("kia.com/it");
  });

  it("makes http/https + www + trailing-slash variants of one page converge", () => {
    const variants = [
      "https://www.kia.com/it/it/modelli",
      "http://kia.com/it/it/modelli/",
      "https://kia.com/it/it/modelli",
      "WWW.KIA.COM/it/it/modelli",
    ];
    const normalized = new Set(variants.map(normalizeUrlForMatch));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe("kia.com/it/it/modelli");
  });

  it("keeps resource-identifying query strings distinct (different URL)", () => {
    expect(normalizeUrlForMatch("y.com/watch?v=abc")).not.toBe(
      normalizeUrlForMatch("y.com/watch?v=xyz"),
    );
  });

  // 유입 표식(utm_*, msockid …)은 자원을 바꾸지 않는다 — 남기면 KPI⑥ 타겟 URL
  // 등호 비교가 어긋난다(인용 URL 절반 이상이 utm_source=chatgpt.com 을 달고 온다).
  it("folds tracking params into the same URL", () => {
    expect(normalizeUrlForMatch("kia.com/it?utm=a")).toBe(normalizeUrlForMatch("kia.com/it"));
    expect(normalizeUrlForMatch("kia.com/sg/x.html?utm_source=chatgpt.com")).toBe(
      normalizeUrlForMatch("kia.com/sg/x.html"),
    );
  });

  it("returns empty string for blank/nullish input (global fallback / skip)", () => {
    expect(normalizeUrlForMatch("")).toBe("");
    expect(normalizeUrlForMatch("   ")).toBe("");
    expect(normalizeUrlForMatch(null)).toBe("");
    expect(normalizeUrlForMatch(undefined)).toBe("");
  });

  it("keeps a bare host without a path", () => {
    expect(normalizeUrlForMatch("https://www.hyundai.com")).toBe("hyundai.com");
  });
});

// projects.domain(canonical 호스트+경로) → scope 미러용 호스트만 파생.
describe("domainHost", () => {
  it("strips the path, keeping only the host", () => {
    expect(domainHost("kia.com/it")).toBe("kia.com");
    expect(domainHost("https://www.kia.com/it/it/modelli")).toBe("kia.com");
  });

  it("passes a bare host through unchanged (after normalization)", () => {
    expect(domainHost("https://www.hyundai.com/")).toBe("hyundai.com");
    expect(domainHost("KIA.com")).toBe("kia.com");
  });

  it("returns empty string for blank/nullish input", () => {
    expect(domainHost("")).toBe("");
    expect(domainHost(null)).toBe("");
    expect(domainHost(undefined)).toBe("");
  });

  it("keeps a distinct subdomain (only leading www is stripped)", () => {
    expect(domainHost("shop.kia.com/it")).toBe("shop.kia.com");
  });
});
