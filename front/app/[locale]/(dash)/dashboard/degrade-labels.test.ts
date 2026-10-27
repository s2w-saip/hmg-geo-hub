import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 읽기 계층(`lib/scope/server.ts`)의 예산 배선과, 화면 기반 섹션의 지연 고지 배선을 소스로 고정한다.
// (대시보드 화면은 degrade 를 payload 로 알린다 — 종전 라벨 레지스트리 대조는 화면 이관으로 끝났다.)
const server = readFileSync(
  fileURLToPath(new URL("../../../../lib/scope/server.ts", import.meta.url)),
  "utf8",
);

/** 이 폴더 기준 상대 경로의 소스(줄바꿈은 LF 로 맞춘다 — 체크아웃 설정에 따라 CRLF 일 수 있다). */
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

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

// ── 섹션 지연 고지(B027) ─────────────────────────────────────────────────────────
// 섹션째 사라지던 일시 실패(글로벌 GEO)는 화면이 degraded 로 알리고, 페이지가 그 자리에 기존 지연 고지
// 카드(kpi.degraded, PendingNotice)를 그린다.
describe("섹션 지연 고지(B027) — 대시보드", () => {
  const page = src("./page.tsx");

  it("글로벌 GEO: 화면(overview/geo)이 degraded 를 알리면 그 자리에 지연 고지를 그린다", () => {
    // The degrade registry is gone with the BFF port: overview/geo says `degraded` when /v1/geo failed
    // transiently (old label standardGeoCompetition), and a transient failure of the screen itself is
    // read the same way. GeoSection draws the existing notice card (kpi.degraded) in that case only.
    const geo = page.slice(page.indexOf("async function GeoSection("));
    const body = geo.slice(0, geo.indexOf("\n}\n"));
    expect(body).toContain('screenGet<OverviewGeoView>("overview/geo"');
    expect(body).toContain("v = { geo: null, degraded: true };");
    expect(body).toContain('{v.degraded ? <PendingNotice title={tOverview("geo.title")} /> : null}');
  });
});
