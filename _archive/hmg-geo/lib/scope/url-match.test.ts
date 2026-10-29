import { describe, it, expect } from "vitest";
import { normalizeUrlForMatch } from "./url-match";

// Pure JS half of the SQL↔JS normalization parity. The SQL side (cnorm) is
// checked against a live DB by scripts/scope/verify-url-match.ts; this keeps the
// JS behavior pinned in the fast unit suite.
describe("normalizeUrlForMatch", () => {
  it("strips scheme, leading www., trailing slashes", () => {
    expect(normalizeUrlForMatch("https://www.kia.com/it/")).toBe("kia.com/it");
    expect(normalizeUrlForMatch("HTTP://Kia.com/IT///")).toBe("kia.com/it");
    expect(normalizeUrlForMatch("  https://www.hyundai.com  ")).toBe("hyundai.com");
  });

  it("drops the URL fragment, incl. #:~:text= scroll-to-text (client-only)", () => {
    const clean = "hyundai.com/worldwide/en/company/innovation/design";
    expect(
      normalizeUrlForMatch(
        "https://www.hyundai.com/worldwide/en/company/innovation/design#:~:text=Design-,philosophy,solutions%20with%20captivating%20emotional%20appeal.",
      ),
    ).toBe(clean);
    // ± fragment → same key (so citations dedup / KPI⑥ match as one URL)
    expect(normalizeUrlForMatch("https://www.hyundai.com/worldwide/en/company/innovation/design")).toBe(clean);
  });

  it("strips fragment before trailing slash (order matters)", () => {
    expect(normalizeUrlForMatch("https://kia.com/it/#:~:text=foo")).toBe("kia.com/it");
    expect(normalizeUrlForMatch("https://kia.com/it/#section")).toBe("kia.com/it");
  });

  // 자원을 식별하는 쿼리는 다른 URL로 남긴다 — 이게 원래 정책.
  it("keeps resource-identifying query strings (a distinct URL)", () => {
    expect(normalizeUrlForMatch("https://youtube.com/watch?v=abc")).toBe("youtube.com/watch?v=abc");
    expect(normalizeUrlForMatch("https://news.example.com/read?articleId=7")).toBe(
      "news.example.com/read?articleId=7".toLowerCase(),
    );
  });

  // …단, 유입 경로만 기록하는 파라미터는 같은 페이지다. AI 엔진이 붙이는
  // utm_source=chatgpt.com 을 남기면 KPI⑥ 타겟 URL 등호 비교가 통째로 어긋난다.
  it("strips tracking params, preserving the '?' for surviving params", () => {
    expect(normalizeUrlForMatch("https://kia.com/it?utm=a")).toBe("kia.com/it");
    expect(normalizeUrlForMatch("https://kia.com/sg/x.html?utm_source=chatgpt.com")).toBe(
      "kia.com/sg/x.html",
    );
    expect(normalizeUrlForMatch("https://kia.com/it/?msockid=3564f27c")).toBe("kia.com/it");
    // 선두 트래킹 파라미터를 지워도 뒤따르는 파라미터의 '?' 자리가 유지된다
    expect(normalizeUrlForMatch("https://y.com/watch?utm_source=x&utm_medium=y&v=abc")).toBe(
      "y.com/watch?v=abc",
    );
    expect(normalizeUrlForMatch("https://y.com/watch?v=abc&utm_source=x")).toBe("y.com/watch?v=abc");
  });

  // 경로 안의 '&' 는 구분자가 아니므로 어느 패스에도 걸리면 안 된다
  it("never rewrites '&' inside a path", () => {
    expect(normalizeUrlForMatch("https://a.com/tom&jerry")).toBe("a.com/tom&jerry");
  });

  it("empty/nullish → empty string", () => {
    expect(normalizeUrlForMatch("")).toBe("");
    expect(normalizeUrlForMatch(null)).toBe("");
    expect(normalizeUrlForMatch(undefined)).toBe("");
  });
});
