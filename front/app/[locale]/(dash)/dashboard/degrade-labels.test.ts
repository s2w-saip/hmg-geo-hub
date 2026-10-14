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

/** 이 폴더 기준 상대 경로의 소스(줄바꿈은 LF 로 맞춘다 — 체크아웃 설정에 따라 CRLF 일 수 있다). */
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

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
    for (const fn of ["fetchStandardKpiBrandTrend", "fetchStandardKpiFirstPosition"]) {
      expect(boundary, fn).toContain(`${fn}(filters, { budget: "extras" })`);
    }
    // 값 read 만 인자 헬퍼를 쓴다(2026-09-20) — 언급 화면이 **같은 인자**로 같은 리더를
    // 불러야 해서 인자가 한 곳으로 모였다. 예산의 자리는 그대로이고, 그 값이 `extras`
    // 라는 사실은 헬퍼 본문에서 단언한다(아래).
    expect(boundary, "fetchStandardCompetitorBrands").toContain(
      "fetchStandardCompetitorBrands(...competitorValueReadArgs(filters))",
    );
  });

  it("인자 헬퍼가 예산을 `extras` 로 박는다 — 두 화면이 같은 셀을 쓴다", () => {
    const i = server.indexOf("export function competitorValueReadArgs");
    expect(i, "인자 헬퍼").toBeGreaterThan(0);
    const body = server.slice(i, server.indexOf("\n}\n", i));
    expect(body).toContain('[overviewReadFilters(filters), { budget: "extras" }]');
    // 언급 화면 페처도 **같은 헬퍼**를 쓴다(다른 인자를 적을 자리가 없다).
    expect(server).toContain(
      "return await fetchStandardCompetitorBrands(...competitorValueReadArgs(filters));",
    );
  });

  it("언급 화면 보강 read 는 어떤 오류든 삼킨다 — 장식적 read 가 지면을 내리지 않는다", () => {
    // 행동 가드는 `lib/scope/server.mention-competitor-isolation.test.ts` 가 실패 주입으로
    // 한다. 여기서는 **보호가 그 함수 안에 있다**는 배선만 고정한다(페이지가 `.catch` 를
    // 붙이는 형태로 옮겨 가면 다른 호출부가 생겼을 때 조용히 빠진다).
    const i = server.indexOf("export async function fetchStandardMentionCompetitorBrands");
    expect(i, "언급 전용 페처").toBeGreaterThan(0);
    const body = server.slice(i, server.indexOf("\n}\n", i));
    expect(body).toContain("try {");
    expect(body).toContain("catch (e) {");
    expect(body).toContain("return null;");
    // 삼키되 조용하지 않다.
    expect(body).toContain("console.error(");
  });
});

// ── 섹션 지연 고지(B027) — 화면이 읽는 라벨 = 원천이 심는 라벨 ─────────────────────
// 섹션째 사라지던 일시 실패(글로벌 GEO, 프로젝트 홈 구성·⑦)는 api 원천이 라벨을 남기고 화면이 기존
// `DegradeNotice`(kpi.degraded)로 그 자리에 고지한다. 고지는 라벨 문자열 매칭뿐이라 위와 같이 소스로 대조한다.
describe("섹션 지연 고지(B027) — 대시보드·프로젝트 홈", () => {
  const page = src("./page.tsx");
  const live = src("./_data/live.ts");
  const adapter = src("../../../../lib/hgh/adapters/dashboard.ts");
  const projectView = src("../projects/[id]/_components/project-dashboard.tsx");
  const projectLive = src("../projects/[id]/_data/live.ts");

  it("글로벌 GEO: 페이지 라벨 = 종전 리더 라벨(server.ts) = api 가 남기는 라벨(_data/live.ts)", () => {
    const m = page.match(/const GEO_LABELS = \[([^\]]*)\] as const;/);
    expect(m, "GEO_LABELS").not.toBeNull();
    const labels = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(labels).toEqual(["standardGeoCompetition"]);
    for (const l of labels) {
      expect(declared, l).toContain(l);
      expect(live).toContain(`degradeOnApiFailure("${l}"`);
    }
    // GeoSection 이 그 목록으로 고지를 그린다(api 경로에서만 — legacy 는 종전 그대로).
    const geo = page.slice(page.indexOf("async function GeoSection("));
    expect(geo.slice(0, geo.indexOf("\n}\n"))).toContain("<DegradeNotice labels={GEO_LABELS}");
  });

  it("프로젝트 홈: 구성·⑦ 라벨은 한 상수를 원천(_data/live.ts)과 화면(project-dashboard.tsx)이 함께 쓴다", () => {
    for (const name of ["PROJECT_COMPOSITION_LABEL", "PROJECT_CONVERSION_LABEL"]) {
      const m = adapter.match(new RegExp(`export const ${name} = "([^"]+)";`));
      expect(m, name).not.toBeNull();
      // 종전 리더에는 이 read 의 라벨이 없었다 — 기존 라벨과 겹치면 다른 read 의 지연이 여기 고지로 샌다.
      expect(declared).not.toContain(m![1]);
      expect(projectLive).toContain(`degradeOnApiFailure(${name},`);
      expect(projectView).toContain(`DegradeNotice({ labels: [${name}]`);
    }
  });
});
