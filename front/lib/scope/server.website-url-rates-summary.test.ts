import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 자사·타겟 URL 인용률(GGMD-61) 서머리 편입: **배선 가드** (2026-09-27) ────────
//
// 값의 동치는 `summary-url-hits.pglite.test.ts`(판정·접기·커버리지)와 라이브 패리티
// 하네스가 본다. 여기서는 "언제 사실표로 가고, 언제 종전 미러로 남는가" 를 소스에서 고정한다
// (server.report-truth.test.ts 와 같은 자세: 게이트웨이는 세션·DB 없이 못 부른다).

const src = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");
const aggSrc = readFileSync(
  fileURLToPath(new URL("../db/repositories/scope-aggregates.ts", import.meta.url)),
  "utf8",
);

function bodyOf(text: string, signature: string): string {
  const i = text.indexOf(signature);
  expect(i, signature).toBeGreaterThan(0);
  return text.slice(i, text.indexOf("\n}\n", i));
}

describe("websiteTargetHitRateLive: 사실표 우선·미러 폴백", () => {
  const body = bodyOf(src, "async function websiteTargetHitRateLive(");

  it("유닛 자사 판정이 꺼져 있으면 게이트를 묻지도 않고 **종전 미러 셀**로 간다", () => {
    const iUnit = body.indexOf("await ensureWebsiteOwnedUnit()");
    const iRoute = body.indexOf("websiteSummaryRoute(");
    expect(iUnit).toBeGreaterThan(0);
    expect(iRoute).toBeGreaterThan(iUnit);
    // 마지막 문장 = 종전 셀(인자·키 불변).
    expect(body.trimEnd().endsWith("return cachedWebsiteTargetHitRate(ids, f);")).toBe(true);
  });

  it("형제 카드(⑥)와 **같은 화면 키·같은 회차 집합**으로 판정한다", () => {
    expect(body).toContain('websiteSummaryRoute(ids, f, "S4.dashboard")');
    expect(body).toContain("route.cycleKey, cycleSetOf(route), route.projectIds, f");
  });

  it("리더가 null(커버리지 미달)이면 미러로 떨어진다: 0 으로 메우지 않는다", () => {
    expect(body).toContain("if (v) return v;");
    expect(body).toContain("fallback:url-hits-uncovered");
  });
});

describe("fetchWebsiteTargetHitRate: 발행값 우선순위 유지", () => {
  const body = bodyOf(src, "export async function fetchWebsiteTargetHitRate(");

  it("발행값 해소가 라이브(사실표 포함)보다 먼저다", () => {
    const iPub = body.indexOf("websiteTargetHitRateFromPublication(ids, f, ctx)");
    const iLive = body.lastIndexOf("websiteTargetHitRateLive(ids, f)");
    expect(iPub).toBeGreaterThan(0);
    expect(iLive).toBeGreaterThan(iPub);
  });

  it("라이브 경로에서 미러 셀을 직접 부르지 않는다 (편입 경로를 우회하지 않는다)", () => {
    expect(body).not.toContain("cachedWebsiteTargetHitRate(");
  });
});

describe("사실표 셀", () => {
  it("SUMMARY_TAG 로 무효화되고 게이트가 좁힌 스코프로 리더를 부른다", () => {
    const i = src.indexOf('mirrorCache("summary-website-prompt-hit-rates"');
    expect(i).toBeGreaterThan(0);
    const cell = src.slice(i, src.indexOf("[SUMMARY_TAG]);", i) + 15);
    expect(cell).toContain("summaryWebsitePromptHitRates(await summaryScopeOf(set, ids, f))");
  });
});

describe("판정 한 벌: 생성기 빌더와 미러 쌍둥이가 같은 조각을 쓴다", () => {
  const live = bodyOf(aggSrc, "export async function aggregateWebsiteTargetHitRate(");
  const gen = bodyOf(aggSrc, "export function websitePromptUrlHitJobFlagsSql(");

  it("타겟 일치 = 그 프롬프트의 타겟(`wp.turl`)과 targetMatchSql", () => {
    for (const b of [live, gen]) expect(b).toContain("targetMatchSql(sql`cit.cnorm`, sql`wp.turl`)");
  });

  it("유닛 자사 = websiteUnitOwnedTargetClause(base NORM, tracked NORM, wup)", () => {
    for (const b of [live, gen]) {
      expect(b).toContain('websiteUnitOwnedTargetClause(sql`cit.base`, sql`cit.cnorm`, "wup")');
    }
  });

  it("타겟 URL 정규화·정규화 컬럼 폴백이 같은 식이다", () => {
    for (const frag of [
      "nullif(${citationTrackedNormSql(sql`coalesce(wp.target_url, '')`)}, '') AS turl",
      "coalesce(nk, citation_url_norm(url)) AS cnorm",
      "coalesce(bk, citation_url_base_norm(url)) AS base",
      'citationNormProjection(sql`c.url_norm`, "nk")',
      'citationNormProjection(sql`c.url_base_norm`, "bk")',
    ]) {
      expect(live, frag).toContain(frag);
      expect(gen, frag).toContain(frag);
    }
  });

  it("미러 쌍둥이의 분자 합성(자사 = base 판정 OR 타겟)을 job 단위로 그대로 굳힌다", () => {
    expect(live).toContain("pm.owned_base_hit OR pm.target_hit");
    expect(gen).toContain("COALESCE(jm.owned_base_hit, false) OR COALESCE(jm.target_hit, false) AS owned_hit");
  });

  it("생성기는 wup 을 자기 job 의 프롬프트로 좁힌다 (함대 전체 CTE × 인용 Nested Loop 방지)", () => {
    expect(gen).toContain("websiteUnitPromptCtes(args.units, sql`SELECT DISTINCT prompt_id::text FROM snap`)");
    // 대시보드 호출부는 좁히지 않는다: 종전 문장 그대로.
    expect(live).toContain("websiteUnitPromptCtes(units)");
  });
});
