import { describe, expect, it } from "vitest";
import { assertRenderedPage, isLoginRedirect, smokeBaseUrl } from "./smoke-checks";

const page = "<!doctype html>" + "test page ".repeat(70);
describe("HTTP smoke evidence", () => {
  it("checks intended app origin and never echoes invalid secret-bearing URLs", () => {
    expect(smokeBaseUrl(undefined).origin).toBe("http://127.0.0.1:3000");
    expect(smokeBaseUrl("https://app.example.com").origin).toBe("https://app.example.com");
    expect(() => smokeBaseUrl("https://password@example.com/?secret=private")).toThrow("기본 URL만");
  });
  it("rejects redirects, non-HTML, and failed status", () => {
    expect(() => assertRenderedPage("/ko/dashboard", 200, "text/html", page)).not.toThrow();
    expect(() => assertRenderedPage("/ko/dashboard", 307, "text/html", page)).toThrow("HTTP 307");
    expect(() => assertRenderedPage("/ko/dashboard", 200, "application/json", page)).toThrow("HTML");
  });
  it("rejects errors hidden in HTTP 200 streamed responses", () => {
    for (const error of [':E{"digest":"123"}', ':E{\\"digest\\":\\"123\\"}', "NEXT_REDIRECT", "NEXT_HTTP_ERROR_FALLBACK;404"]) {
      expect(() => assertRenderedPage("/ko/dashboard", 200, "text/html", page + error)).toThrow("스트림");
    }
  });
  it("accepts local Next hostname canonicalization without accepting other origins", () => {
    const base = new URL("http://127.0.0.1:3309");
    expect(isLoginRedirect(307, "http://localhost:3309/ko/login", base)).toBe(true);
    expect(isLoginRedirect(307, "http://localhost:3310/ko/login", base)).toBe(false);
    expect(isLoginRedirect(307, "https://other.example.com/ko/login", base)).toBe(false);
    expect(isLoginRedirect(200, null, base)).toBe(false);
  });
});
