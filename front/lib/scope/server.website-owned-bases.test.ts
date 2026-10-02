import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 구조 가드 — main #164 의 website 자사 base 선언 배선이 리베이스에서 유실된 사고
// (2026-09-02, PR #163 verifier 결함 A)의 재발 방지. website 캐시 9곳은 카탈로그
// (scopeOwnedPrefixes)가 아니라 websiteOwnedPrefixes(선언 우선)를 거쳐야 한다.
const src = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");

describe("website owned-base wiring (#164)", () => {
  it("defines websiteOwnedPrefixes on top of websiteDeclaredOwnedBases", () => {
    expect(src).toMatch(/async function websiteOwnedPrefixes\(/);
    // 2026-09-20 — 유닛 단위 키 판정(`ensureWebsiteOwnedUnit`)과 함께 `Promise.all`
    // 로 나가므로 `await` 접두는 빠졌다. 선언 base 읽기가 그 자리에 남아 있는지를 본다
    // (#164 가 지키려던 것).
    expect(src).toContain("websiteDeclaredOwnedBases(filters, projectIds)");
    // 유닛 도출에는 **필터를 넘기지 않는다** — 넘기면 flat 의 결함(필터가 자사 집합을
    // 바꾼다)이 유닛 경로로 그대로 옮겨온다.
    expect(src).toContain("await websiteOwnedUnits()");
    expect(src).not.toMatch(/websiteOwnedUnits\(\s*filters/);
  });
  it("routes every website aggregate through it (9 call sites)", () => {
    const calls = src.match(/await websiteOwnedPrefixes\(projectIds, filters\)/g) ?? [];
    // GGMD-61(2026-09-17) 8 → 9: 프롬프트 기준 인용률 2종(website-target-hit-rate)도
    // ⑤ 와 같은 선언 base 로 자사를 판정한다.
    expect(calls.length).toBe(9);
    // website 캐시 정의 안에는 카탈로그 직결이 남아 있지 않다.
    const block = src.slice(src.indexOf('mirrorCache("website-aggregates"'), src.indexOf('mirrorCache("website-subkpis-prev"') + 400);
    expect(block).not.toMatch(/projectIds, scopeOwnedPrefixes\(filters\)/);
  });
});
