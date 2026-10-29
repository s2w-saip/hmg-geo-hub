import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 구조 가드 — main #164 의 website 자사 base 선언 배선이 리베이스에서 유실된 사고
// (2026-09-02, PR #163 verifier 결함 A)의 재발 방지. website 캐시 8곳은 카탈로그
// (scopeOwnedPrefixes)가 아니라 websiteOwnedPrefixes(선언 우선)를 거쳐야 한다.
const src = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");

describe("website owned-base wiring (#164)", () => {
  it("defines websiteOwnedPrefixes on top of websiteDeclaredOwnedBases", () => {
    expect(src).toMatch(/async function websiteOwnedPrefixes\(/);
    expect(src).toContain("await websiteDeclaredOwnedBases(filters, projectIds)");
  });
  it("routes every website aggregate through it (8 call sites)", () => {
    const calls = src.match(/await websiteOwnedPrefixes\(projectIds, filters\)/g) ?? [];
    expect(calls.length).toBe(8);
    // website 캐시 정의 안에는 카탈로그 직결이 남아 있지 않다.
    const block = src.slice(src.indexOf('mirrorCache("website-aggregates"'), src.indexOf('mirrorCache("website-subkpis-prev"') + 400);
    expect(block).not.toMatch(/projectIds, scopeOwnedPrefixes\(filters\)/);
  });
});
