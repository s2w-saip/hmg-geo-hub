import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXTRAS_LABELS, COMPETITOR_LABELS } from "./_components/degrade-notice";

// degrade 고지는 **라벨 문자열 매칭**으로만 성립한다(`degradeAware(<라벨>)` 이 심고
// `wasDegraded(<라벨>)` 이 읽는다). 오타 하나면 고지가 조용히 사라지는데, `wasDegraded`
// 는 RSC 요청 스코프 밖에서 fail-closed(false)라 **렌더 테스트로는 못 잡는다**.
// 그래서 `server.ts` 소스와 직접 대조한다.
const server = readFileSync(
  fileURLToPath(new URL("../../../../lib/scope/server.ts", import.meta.url)),
  "utf8",
);

/** `degradeAware("x", …)` · `degradeAware(\`x:${u}\`, …)` 의 라벨 원문을 전부 뽑는다. */
const declared = new Set(
  [...server.matchAll(/degradeAware\(\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]),
);

describe("degrade 라벨 정합 — 고지 목록 ↔ server.ts", () => {
  it("server.ts 가 심는 라벨을 뽑아낸다(추출기 자체가 죽지 않았는지)", () => {
    expect(declared.size).toBeGreaterThanOrEqual(5);
    expect(declared).toContain("standardMentions");
  });

  it("EXTRAS_LABELS — 추이는 단위별로 갈린 라벨이고 둘 다 실재한다", () => {
    // `standardTrend:${unit}` 는 템플릿이라 원문이 `standardTrend:${unit}` 로 잡힌다.
    expect(declared).toContain("standardTrend:${unit}");
    expect([...EXTRAS_LABELS]).toEqual(["standardTrend:day", "standardTrend:week"]);
    for (const l of EXTRAS_LABELS) expect(l.startsWith("standardTrend:")).toBe(true);
  });

  it("COMPETITOR_LABELS — 전부 server.ts 가 실제로 심는 라벨이다(죽은 라벨 금지)", () => {
    for (const l of COMPETITOR_LABELS) expect(declared, l).toContain(l);
  });

  it("경쟁사 경계의 네 read 가 **전부** 보호돼 있고 넷 다 목록에 있다 (PR④ A3)", () => {
    // 종전에는 `fetchStandardCitationDomains` 만 `degradeAware` 가 없어 셋이었다.
    // 그 페처가 상한 없이 돌던 시절엔 붕괴 경로도 없었지만, A3 가 `extras` 예산을
    // 붙이면서 `57014` 가 실현 가능해졌다 — 보호와 예산은 한 세트다.
    const i = server.indexOf("export async function fetchStandardCitationDomains");
    expect(i).toBeGreaterThan(0);
    const block = server.slice(i, server.indexOf("\n}\n", i));
    expect(block).toContain('degradeAware("standardCitationDomains"');
    // 미러 폴백 **두 갈래 다** extras 예산이어야 한다(한쪽만 고치면 경계 최악이 60 s).
    expect([...block.matchAll(/cachedStandardCitations\(f, "extras"\)/g)]).toHaveLength(2);
    expect([...COMPETITOR_LABELS]).toContain("standardCitationDomains");
    expect(COMPETITOR_LABELS).toHaveLength(4);
    // S3 인용 화면은 종전 예산(`screen`)을 유지한다 — 본문이 degrade 되면 지면이 빈다.
    expect(server).toContain('cachedStandardCitations(f, "screen")');
  });

  it("인용 셀은 **프로파일을 캐시 키로** 받는다 — 한 예산을 박아 두면 셀 공유로 되돌아간다", () => {
    const i = server.indexOf('mirrorCache("standard-citations"');
    expect(i).toBeGreaterThan(0);
    const next = server.indexOf("mirrorCache(", i + 20);
    const block = server.slice(i, next > 0 ? next : i + 1200);
    expect(block).toContain("profile: CitationsBudgetProfile");
    expect(block).toContain("citationsBudgetOf(profile)");
    expect(block).not.toContain("mirrorHeavyBudget()");
  });
});

describe("예산 프로파일 기본값 — 화면 쪽이 종전(또는 더 넉넉한) 상한을 유지한다", () => {
  // ⚠️ 이 단언이 없으면 기본값을 `extras` 로 뒤집어도 전 테스트가 통과한다(검증 지적 ⑤).
  // 기본값의 규율은 하나다: **옵션을 잊은 호출부가 화면을 죽이지 않는 방향으로 틀린다.**
  //   · 스파크·우선노출도 → `kpi-tab`(20/30). 뒤집히면 S2 4-KPI 탭의 문장 상한이 15 s 로
  //     내려가 우선노출도(실측 14.8~15.2 s)가 degrade 문턱에 걸린다.
  //   · 언급            → `screen`(22/35). 뒤집히면 S2 언급 화면의 **본문**이 콜드에서
  //     죽는다(최장 문장 warm 9.19 s × 1.7 = 15.6 s > extras 의 15 s).
  it("기본값을 가진 페처는 셋이고, 셋 다 짧은 쪽(`extras`)이 아니다", () => {
    const hits = [...server.matchAll(/opts\.budget \?\? "([a-z-]+)"/g)].map((m) => m[1]);
    expect(hits.length, "brandTrend·firstPosition·mentions 셋 다 기본값을 가진다").toBe(3);
    expect(hits.sort()).toEqual(["kpi-tab", "kpi-tab", "screen"]);
    expect(hits).not.toContain("extras");
  });

  it("`extras` 는 **경쟁사 경계에서만** 명시된다 — 셋 다", () => {
    // PR④ B2: 이 묶음의 조립이 page.tsx 에서 `fetchStandardCompetitorSources` 로
    // 옮겨졌다(묶음의 모양이 화면 키 `S1.competitors` 에 달려 있다). 보는 자리가
    // 바뀔 뿐 규율은 같다 — 짧은 쪽은 이 한 경계에서만 명시된다.
    const i = server.indexOf("export async function fetchStandardCompetitorSources");
    expect(i, "경쟁사 경계 함수").toBeGreaterThan(0);
    const boundary = server.slice(i, server.indexOf("\n}\n", i));
    for (const fn of [
      // 값 read 는 `fetchStandardMentions` 에서 이 페처로 바뀌었지만 예산의 자리는
      // 그대로다 — 이 페처가 미러 폴백에 그 프로파일을 그대로 실어 준다
      // (server.ts 의 `fetchStandardMentions(filters, { budget: opts.budget })`).
      "fetchStandardCompetitorBrands",
      "fetchStandardKpiBrandTrend",
      "fetchStandardKpiFirstPosition",
    ]) {
      expect(boundary, fn).toContain(`${fn}(filters, { budget: "extras" })`);
    }
  });
});
