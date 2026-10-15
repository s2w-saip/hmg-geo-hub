import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { SUMMARY_SCREEN_KEYS, SUMMARY_SCREEN_OPT_IN } from "@/lib/summary/read/screens";
import { periodRouteScreenKeyFor } from "@/lib/summary/read/period-route-flag";
import { readSourceText } from "@/test/source-text";

// ── 기간 누적의 집계층 서빙: **배선 가드** (2026-09-18) ────────────────────
//
// 카드 계열이 기간 모드를 타는 조건은 셋이 **전부** 맞을 때다:
//   ① 요청에 기간이 걸려 있다(`hasPeriod`)
//   ② 화면 키 `S1.periodRoute` 옵트인이 켜졌다(또는 프리뷰 전용 env)
//   ③ 그 위에 종전 화면 게이트(`S1.dashboard`)가 여전히 통과한다
// 하나라도 빠지면 **종전 스냅샷 판정 그대로**여야 한다. 그 회귀 0 이 이 change 의
// 전제이므로, 배선이 그 모양인지를 소스에서 고정한다(라이브 판정은 검증자가 본다).

const src = readSourceText(
  fileURLToPath(new URL("./server.ts", import.meta.url)),
);

function bodyOf(name: string): string {
  const i = src.indexOf(`async function ${name}<T>(`);
  expect(i, name).toBeGreaterThan(0);
  return src.slice(i, src.indexOf("\n}\n", i));
}

describe("기간 경로 스위치 배선", () => {
  it("두 키가 어휘에 있고 **옵트인**이다: `screens all` 로 켜지지 않는다", () => {
    for (const k of ["S1.periodRoute", "S4.periodRoute"] as const) {
      expect(SUMMARY_SCREEN_KEYS, k).toContain(k);
      expect(SUMMARY_SCREEN_OPT_IN.has(k), k).toBe(true);
    }
  });

  // ⚠️ **화면별 판정**이 계약이다(F2). 게이트 하나를 여러 화면이 공유하므로
  //    (`viaTrend` 는 카드·언급·인용이 함께 부른다), 게이트 단위로 판정하면
  //    승인받지 않은 지면까지 함께 기간 모드로 옮겨진다. 호출 **횟수**가 아니라
  //    **어느 화면이 켜지는가**를 본다.
  it("기간 모드를 타는 화면은 카드 계열 셋뿐이다", () => {
    expect(periodRouteScreenKeyFor("S1.dashboard")).toBe("S1.periodRoute");
    expect(periodRouteScreenKeyFor("S4.dashboard")).toBe("S4.periodRoute");
    // 같은 카드 안의 배지: ①~⑤ 와 모수가 갈리면 안 되므로 카드와 같은 키다.
    expect(periodRouteScreenKeyFor("S4.subkpi")).toBe("S4.periodRoute");
    // 인용·언급 계열은 별도 승인 대상이라 어떤 스위치로도 안 켜진다.
    for (const s of ["S2.mention", "S3.citation", "S5.mention", "S6.citation", "P.dashboard"] as const) {
      expect(periodRouteScreenKeyFor(s), s).toBeNull();
    }
    // 매핑에 실린 화면은 위 셋이 전부다(넷째가 생기면 이 단언이 먼저 깨진다).
    const mapped = SUMMARY_SCREEN_KEYS.filter((k) => periodRouteScreenKeyFor(k) !== null);
    expect([...mapped].sort()).toEqual(["S1.dashboard", "S4.dashboard", "S4.subkpi"]);
  });

  it("두 게이트가 **화면 키로** 판정한다: 게이트 단위 판정 금지", () => {
    const g = bodyOf("viaGlobalS1");
    expect(g).toContain("await periodRouteEnabledForScreen(screen, f)");
    // 두 갈래가 다 있다: 켜지면 기간 판정, 아니면 종전 스냅샷 판정.
    expect(g).toContain("globalPeriodRoute(rootId, f, screen)");
    expect(g).toContain("globalSummaryRoute(rootId, f, screen)");

    const w = bodyOf("viaTrend");
    expect(w).toContain("await periodRouteEnabledForScreen(screen, f)");
    expect(w).toContain("websitePeriodRoute(ids, f, screen)");
    expect(w).toContain("websiteSummaryRoute(ids, f, screen)");

    // 스위치 키를 **게이트에 박아 넣는** 형태를 금지한다(그것이 F2 의 결함이었다).
    expect(src).not.toMatch(/periodRouteEnabled\(\s*"S[0-9]/);
    // 인용·언급 전용 게이트는 아직 이 스위치를 아예 안 부른다.
    for (const fn of ["viaGlobalTrend", "viaGlobalSummary"]) {
      expect(bodyOf(fn), fn).not.toContain("periodRouteEnabled");
    }
  });

  it("웹사이트 기간 로그도 같은 형태다", () => {
    const w = bodyOf("viaTrend");
    expect(w).toContain('const tag = period ? `${screen} period` : `${screen}`;');
    expect(w).toContain('const dest = period ? "mirror" : "detail";');
    expect(src).toContain("x-hmg-summary(${s} period): ${summaryRouteHeaderValue(route)}");
  });

  it("기간 모드 로그는 `period` 꼬리표를 달고 회차 수가 남는다 (AC3.1)", () => {
    // 판정 줄은 `globalPeriodRoute` 가 낸다(`… period): hit cycles:<n>`).
    expect(src).toContain("x-hmg-summary(global ${screen} period): ${summaryRouteHeaderValue(route)}");
    // `agg-*` 폴백 줄도 모드에 따라 꼬리표·목적지가 갈린다.
    const body = bodyOf("viaGlobalS1");
    expect(body).toContain('const tag = period ? `global ${screen} period` : `global ${screen}`;');
    expect(body).toContain('const dest = period ? "mirror" : "detail";');
    expect(body).toContain("x-hmg-summary(${tag}): fallback:agg-fold-missing → ${dest}");
    expect(body).toContain("x-hmg-summary(${tag}): fallback:agg-empty → ${dest}");
    expect(body).toContain("x-hmg-summary(${tag}): fallback:agg-widget-empty → ${dest}");
  });
});

describe("env 강제 경로의 금기", () => {
  const flag = readSourceText(
    fileURLToPath(new URL("../summary/read/period-route-flag.ts", import.meta.url)),
  );

  it("`NEXT_PUBLIC_` 접두사를 쓰지 않는다: 서버 전용 값이다", () => {
    // 주석에는 "붙이지 마라" 가 적혀 있다: **코드만** 본다(`server.fallback-destination`
    // 가드가 주석 우회로 침묵했던 F3 와 같은 이유).
    const code = flag.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("NEXT_PUBLIC_");
    expect(code).toContain('import "server-only"');
  });

  it("값보다 **환경**을 먼저 본다: 판정 함수가 환경 검사를 통과해야 env 를 읽는다", () => {
    expect(flag).toContain("periodRouteOverrideAllowedHere(env) && env.PERIOD_ROUTE_FORCE");
  });

  it("GGMD-107 과 **같은 파일명을 쓰지 않는다**(병합 충돌 회피)", () => {
    // 두 스위치는 같은 계약이지만 다른 브랜치에서 온다. 같은 파일에 모으는 것은
    // 두 트랙이 통합 프리뷰에서 만난 **뒤**의 일이다.
    expect(flag).toContain("period-compare-flag.ts");
  });
});
