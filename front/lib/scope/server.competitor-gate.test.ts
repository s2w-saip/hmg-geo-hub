import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { SUMMARY_SCREEN_OPT_IN } from "@/lib/summary/read/screens";
import { readSourceText } from "@/test/source-text";

// 대시보드 **경쟁사 행**의 배선을 고정한다 — PR④ B1 수용 기준 ①·③·⑤.
//
// `fetchStandardCompetitorBrands` 자체는 세션·DB·설정을 태워야 실행되므로, 여기서는
// **소스 형태**로 세 가지를 못 박는다(`server.fallback-destination.test.ts` 와 같은 자세):
//
//   ① 키가 **옵트인**이고, 꺼져 있으면 종전 페처로 간다 → 값·마커 무변경.
//   ③ 이 경로가 **자기 문장을 새로 내지 않는다** — 카드가 이미 읽은 S1 셀
//      (`viaGlobalS1` → `requestS1`)을 다른 매핑으로 한 번 더 읽을 뿐이다.
//   ⑤ 롤백이 **키 단위**다 — 코드를 되돌리지 않고 `read_screens` 에서 이름만 뺀다.
//
// B2(경쟁사 Δ 회차 축)도 같은 키를 쓰므로 아래 마지막 describe 가 그 배선을 함께 본다.
//
// 이 셋 중 하나라도 깨지면 "성능은 좋아졌는데 문장이 늘었다"거나 "스위치를 껐는데
// 값이 안 돌아온다"가 된다. 둘 다 화면으로는 안 보인다.

const src = readSourceText(
  fileURLToPath(new URL("./server.ts", import.meta.url)),
);
const dashboard = readSourceText(
  fileURLToPath(new URL("../../app/[locale]/(dash)/dashboard/page.tsx", import.meta.url)),
);

/** `fetchStandardCompetitorBrands` 의 본문(다음 최상위 선언 전까지). */
const body = (() => {
  const i = src.indexOf("export async function fetchStandardCompetitorBrands");
  expect(i, "페처가 실재한다").toBeGreaterThan(0);
  const j = src.indexOf("\n}\n", i);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
})();

describe("경쟁사 행 — 화면 키 게이트", () => {
  it("`S1.competitors` 는 옵트인이다 — `screens all` 로도 안 켜진다", () => {
    // 값이 바뀌는 키(창·모수 + `avgPosition` **축 변경**)라 성능 스위치가 켜면 안 된다.
    // 축 변경의 근거·수치는 `screens.ts` 의 `S1.competitors` 주석이 정본이다 —
    // 플랜의 "avg→min" 서술은 실측으로 반증됐다.
    expect(SUMMARY_SCREEN_OPT_IN.has("S1.competitors")).toBe(true);
  });

  it("키가 꺼져 있으면 **종전 페처**로 간다 — 조건 뒤에 미러가 온다", () => {
    expect(body).toContain('summaryScreenAllowed("S1.competitors")');
    // 부정 조건 + 즉시 반환. `if (allowed) { …집계층 } ` 로 뒤집어 써도 동작은 같지만,
    // 그러면 "기본값이 종전" 이라는 성질이 코드에서 안 읽힌다.
    expect(body).toMatch(/if \(!\(await summaryScreenAllowed\("S1\.competitors"\)\)\) return onMirror\(\);/);
  });

  it("종전 경로는 `fetchStandardMentions` 이고 **예산 프로파일을 그대로 넘긴다**", () => {
    // 프로파일이 빠지면 대시보드가 S2 언급 화면과 같은 셀(22/35)을 받는다 — 예산 분리가
    // 무의미해지고, 이 경계의 실효 최악이 되돌아간다.
    expect(body).toContain("fetchStandardMentions(filters, { budget: opts.budget })");
  });

  it("대시보드 페이지는 미러 페처를 직접 부르지 않는다 — 경계는 한 곳이다", () => {
    expect(dashboard).toContain("fetchStandardCompetitorSources(filters)");
    for (const fn of [
      "fetchStandardMentions(",
      "fetchStandardKpiBrandTrend(",
      "fetchStandardKpiFirstPosition(",
    ]) {
      expect(dashboard, fn).not.toContain(fn);
    }
  });
});

describe("경쟁사 행 — 집계층 문장 증가 0", () => {
  it("카드와 **같은 게이트·같은 셀**(`viaGlobalS1`)을 탄다", () => {
    // `viaGlobalS1` 안의 `requestS1` 이 React 요청 캐시라, 카드가 이미 읽은 회차·필터면
    // DB 문장이 0개 더 나간다. 여기서 전용 게이트(`viaGlobalSeries` 등)를 새로 부르면
    // 셀이 따로 서서 문장이 늘어난다.
    expect(body).toContain("viaGlobalS1<CompetitorBrandValue[]>");
  });

  it("자기 캐시 셀·자기 리더를 새로 만들지 않는다", () => {
    for (const forbidden of ["mirrorCache(", "readTrendAggregates(", "cache("]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it("값의 출처는 S1 read 의 `competitors` 필드 하나다", () => {
    expect(body).toContain("(v) => v.competitors");
  });
});

/** 경계 조립 함수의 본문. */
const boundary = (() => {
  const i = src.indexOf("export async function fetchStandardCompetitorSources");
  expect(i, "경계 함수가 실재한다").toBeGreaterThan(0);
  return src.slice(i, src.indexOf("\n}\n", i));
})();

describe("경쟁사 Δ — 회차 축 2단 (B2)", () => {
  it("키가 꺼져 있으면 넷을 **한 번에** 발행한다 — 값 read 를 기다리지 않는다", () => {
    // Δ 는 이름을 필요로 하지 않는다. off 경로에서 값 read 를 기다리면 이 경계가
    // 16.5 s 에서 25 s 로 **나빠진다**(미러 언급 16 s + 미러 Δ 9 s 직렬).
    const off = boundary.slice(boundary.indexOf("if (!on)"), boundary.indexOf("const brands ="));
    expect(off).toContain("Promise.all");
    expect(off).toContain("brandsPromise");
    expect(off).toContain("fetchStandardKpiBrandTrend(filters,");
    expect(off).toContain("fetchStandardKpiFirstPosition(filters,");
  });

  it("켜져 있으면 **화면 규칙**으로 이름을 고른다 — 읽기 계층이 다시 정하지 않는다", () => {
    expect(boundary).toContain("competitorDeltaBrands(brands)");
    expect(boundary).toContain("competitorSeriesTotals(brands, names)");
  });

  it("전역 페처·전역 키는 그대로다 — 폴백이 그것이다 (제품 책임자 D3 (1))", () => {
    // S2 4-KPI 탭은 종전 그대로여야 한다. 두 전역 페처가 살아 있고, 경쟁사 경로의
    // 미러 폴백이 정확히 그 둘이다.
    expect(src).toContain("export async function fetchStandardKpiBrandTrend");
    expect(src).toContain("export async function fetchStandardKpiFirstPosition");
    for (const fn of ["fetchStandardCompetitorBrandTrend", "fetchStandardCompetitorFirstPosition"]) {
      const i = src.indexOf(`async function ${fn}`);
      expect(i, fn).toBeGreaterThan(0);
      const b = src.slice(i, src.indexOf("\n}\n", i));
      expect(b, fn).toContain("budget: opts.budget");
    }
    // 전역 키는 **켜지 않는다** — B2 는 경계만 바꾼다.
    expect(SUMMARY_SCREEN_OPT_IN.has("S1.brandTrend")).toBe(true);
    expect(SUMMARY_SCREEN_OPT_IN.has("S1.firstPosition")).toBe(true);
  });

  it("우선노출도 **축**은 두 페처 모두 comp 축이다 (F1 · 2026-09-28 제품 책임자 A안)", () => {
    // 값(`toCompetitorBrands`)이 `comp_rank_sum` 축이므로 Δ 도 같은 축이어야 한다(F1).
    // 2026-09-28: 전역 페처(`S1.firstPosition`)도 comp 로 옮겼다. 폴백인 미러 셀이 같은 축
    // (경쟁 순위)이 됐으므로, 키를 켜도 축이 바뀌지 않게 한다. 키 자체는 옵트인 그대로다.
    const at = (fn: string) => {
      const i = src.indexOf(`async function ${fn}`);
      expect(i, fn).toBeGreaterThan(0);
      return src.slice(i, src.indexOf("\n}\n", i));
    };
    for (const fn of ["fetchStandardCompetitorFirstPosition", "fetchStandardKpiFirstPosition"]) {
      const b = at(fn);
      expect(b, fn).toContain('positionAxis: "comp"');
      expect(b, fn).not.toContain('positionAxis: "ordinal"');
    }
    expect(SUMMARY_SCREEN_OPT_IN.has("S1.firstPosition")).toBe(true);
  });

  it("미러 셀 이름이 서수 축 셀(`kpi-first-position`)과 갈린다: 배포 혼재 중 셀 공유 금지", () => {
    expect(src).toContain('mirrorCache("kpi-first-position-comp",');
    expect(src).not.toContain('mirrorCache("kpi-first-position",');
  });

  it("degrade 라벨은 종전과 같다 — 고지 지면(`COMPETITOR_LABELS`)이 그것을 읽는다", () => {
    for (const [fn, label] of [
      ["fetchStandardCompetitorBrandTrend", "brandTrend"],
      ["fetchStandardCompetitorFirstPosition", "firstPosition"],
    ] as const) {
      const i = src.indexOf(`async function ${fn}`);
      expect(src.slice(i, src.indexOf("\n}\n", i)), fn).toContain(`degradeAware("${label}"`);
    }
  });

  it("**1단(스냅샷)을 읽지 않는다** — 선정이 값 행에서 끝났다", () => {
    const i = src.indexOf("const requestGlobalCompetitorSeries");
    expect(i).toBeGreaterThan(0);
    const b = src.slice(i, src.indexOf("\n);\n", i));
    // `requestGlobalBrands`(전역 2단)는 이것을 부른다 — 경쟁사 경로는 부르면 안 된다.
    expect(b).not.toContain("cachedGlobalBrandSnapshot");
    expect(b).not.toContain("pickSeriesBrands");
    // 코어는 카드 추이와 **같은 셀**이라 여기서 문장이 늘지 않는다.
    expect(b).toContain("requestGlobalCore");
    expect(b).toContain("cachedGlobalBrandSeries");
  });

  it("그릴 브랜드가 없으면 회차 축 문장을 아예 안 낸다(미러 폴백도 아니다)", () => {
    const i = src.indexOf("const requestGlobalCompetitorSeries");
    const b = src.slice(i, src.indexOf("\n);\n", i));
    expect(b).toContain("names.length === 0");
    expect(b).toContain("brandTotals: []");
  });
});
