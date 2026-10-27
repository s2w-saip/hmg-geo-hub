import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SUMMARY_SCREEN_KEYS, SUMMARY_SCREEN_OPT_IN } from "@/lib/summary/read/screens";

// 언급 추이 주 격자 키의 **스위치 배선**(2026-09-17). 리더 SQL 은
// `scope-aggregates.mention-trend-week.sql.test.ts` 가 컴파일된 문자열로 고정하고,
// 여기서는 키 어휘와 "캐시 키에 분기가 실리는가" 만 본다 —
// `fetchStandardMentions` 본체는 세션·DB·설정을 태워야 해서 단위 테스트 대상이 아니다.

const SERVER_SRC = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

describe("S2.mentionTrend 키", () => {
  it("화면 키 목록에 있다", () => {
    expect(SUMMARY_SCREEN_KEYS).toContain("S2.mentionTrend");
  });

  it("**옵트인**이다 — `screens all`(빈 배열)로는 켜지지 않는다", () => {
    // 주 배정이 바뀌면 주별 값·시리즈 멤버십이 바뀐다(고객이 보는 숫자다). 이유 셋은
    // `screens.ts` 의 이 키 블록, **수치는 `scope-aggregates.ts::trendWeekKey` 머리 주석**이
    // 정본이다 — 여기에 복사하지 않는다(docs/development-guide.md "수치를 두 곳에 적지 말 것").
    expect(SUMMARY_SCREEN_OPT_IN.has("S2.mentionTrend")).toBe(true);
  });

  it("화면 전체를 집계층으로 옮기는 `S2.mention` 과 **다른 키**다 (T8·GGMD 대기와 분리)", () => {
    expect(SUMMARY_SCREEN_KEYS).toContain("S2.mention");
    expect(SUMMARY_SCREEN_OPT_IN.has("S2.mention")).toBe(true);
  });
});

// ⚠️ 소스 단언이다(포맷 변경에 약하다는 것을 알고 쓴다) — 캐시 키 누락은 **런타임에
//    조용히** 옛 격자 셀을 서빙하는 결함이라, 값으로 잡을 수 있는 자리가 없다.
//    SQL 쪽 가드는 위 파일이 컴파일된 문장으로 들고 있다.
describe("캐시 키에 분기가 실린다", () => {
  it("`cachedStandardMentions` 가 `weekSource` 를 인자로 받는다", () => {
    expect(SERVER_SRC).toMatch(
      /cachedStandardMentions = mirrorCache\([\s\S]{0,400}weekSource: TrendWeekSource/,
    );
    expect(SERVER_SRC).toMatch(/cachedStandardMentions\(f, opts\.budget \?\? "screen", weekSource\)/);
  });

  it("판정은 캐시 **바깥**이다 — 설정을 고치면 다음 요청부터 반영돼야 한다", () => {
    const gate = SERVER_SRC.indexOf('summaryScreenAllowed("S2.mentionTrend")');
    const call = SERVER_SRC.indexOf('cachedStandardMentions(f, opts.budget ?? "screen", weekSource)');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(call);
  });

  it("off 면 `measured`(종전), on 이면 `cycle` 이다", () => {
    expect(SERVER_SRC).toMatch(
      /await summaryScreenAllowed\("S2\.mentionTrend"\)\)\s*\?\s*"cycle"\s*:\s*"measured"/,
    );
  });
});

// ── 4-KPI 탭 추이 3종 (2026-09-18) ────────────────────────────────────────
//
// 같은 화면의 추이가 축 두 벌을 갖지 않게 **같은 키**를 재사용한다. 새 키를 두면 기본
// off 로 나가므로, 이미 켜져 있는 `S2.mentionTrend`(주별 브랜드 언급 수)와 갈려 배포
// 직후 이 PR 이 고치려던 상태가 그대로 재현된다. 이유는 `server.ts::KpiTabWeekAxis` 주석.
// (언급 KPI 탭 화면은 이제 API 추이를 읽는다 — 페이지 호출부 대조는 화면 이관으로 끝났다.)

/**
 * 함수 하나의 **본문 슬라이스**(선언 ~ 열 0 의 닫는 중괄호). `server.ts` 의 함수는 전부
 * top-level 이라 `\n}` 이 곧 함수의 끝이고, 중첩 블록은 들여쓰기돼 있어 걸리지 않는다.
 *
 * 왜 필요한가: 파일 전체에 `indexOf` 를 걸면 **옆 함수의 호출을 자기 것으로 오인한다.**
 * 고정 길이(`+3_000`) 슬라이스도 같은 결함이다 — 함수가 길어지면 남의 본문을 먹는다.
 */
function fnBody(src: string, name: string): string {
  const head = new RegExp(`(?:export )?(?:async )?function ${name}\\(`).exec(src);
  if (!head) throw new Error(`함수를 못 찾았다: ${name}`);
  const end = src.indexOf("\n}", head.index);
  if (end < 0) throw new Error(`함수의 끝을 못 찾았다: ${name}`);
  return src.slice(head.index, end + 2);
}

describe("KPI 탭 추이의 주 격자 축", () => {
  it("축 결정은 **같은 화면 키** 하나가 한다 — 새 키를 만들지 않았다", () => {
    const helper = SERVER_SRC.match(
      /async function kpiTabWeekSource\([\s\S]{0,400}?\n}/,
    )?.[0];
    expect(helper).toBeTruthy();
    expect(helper).toContain('summaryScreenAllowed("S2.mentionTrend")');
    expect(helper).toContain('if (axis !== "S2.mentionTrend") return "measured"');
    // 키 어휘가 늘지 않았다는 것까지 본다(다른 키를 쓰면 여기서 잡힌다).
    expect(SERVER_SRC.match(/summaryScreenAllowed\("S2\.mentionTrend"\)/g)).toHaveLength(2);
  });

  it("`weekSource` 가 두 캐시의 **키**에 실린다", () => {
    // 안 실으면 키를 켜고 끄는 사이에 옛 격자 셀이 그대로 서빙된다.
    expect(SERVER_SRC).toMatch(
      /cachedKpiBrandTrend = mirrorCache\([\s\S]{0,400}weekSource: TrendWeekSource/,
    );
    expect(SERVER_SRC).toContain(
      "cachedKpiBrandTrend(f, win, topBrands, profile, weekSource)",
    );
    expect(SERVER_SRC).toMatch(
      /cachedKpiEngineTrend = mirrorCache\([\s\S]{0,700}weekSource: TrendWeekSource/,
    );
    expect(SERVER_SRC).toContain("cachedKpiEngineTrend(f, win, weekSource)");
  });

  it.each([
    ["fetchStandardKpiBrandTrend", "cachedKpiBrandTrend(f, win, topBrands, profile, weekSource)"],
    ["fetchStandardKpiEngineTrend", "cachedKpiEngineTrend(f, win, weekSource)"],
  ])("`%s` 가 **자기 본문에서** 축을 정하고 그 값을 캐시에 넘긴다", (fn, call) => {
    // ⚠️ 종전에는 `SERVER_SRC.indexOf(…)` 로 전역 위치만 비교했다. 그러면 **두 페처 중
    //    하나가 `kpiTabWeekSource` 를 아예 안 불러도 통과한다** — 앞 페처의 호출이 뒤
    //    페처의 캐시 호출보다 앞에 있기 때문이다(검증자 변이: "engineTrend 가 weekAxis 를
    //    무시하고 항상 measured" 를 주입해도 전 스위트 초록). 그래서 **함수 본문 슬라이스**
    //    안에서만 본다.
    const body = fnBody(SERVER_SRC, fn);
    // ① 이 함수가 자기 본문에서 축을 정한다(상수 "measured" 를 박아 넣으면 실패).
    expect(body).toContain("const weekSource = await kpiTabWeekSource(opts.weekAxis);");
    // ② 그 값이 이 함수의 캐시 호출 인자로 그대로 간다.
    expect(body).toContain(call);
    // ③ 판정이 캐시 **바깥**이다 — 설정을 고치면 다음 요청부터 반영돼야 한다(안쪽이면 TTL 만큼 굳는다).
    expect(body.indexOf("await kpiTabWeekSource(opts.weekAxis)")).toBeLessThan(body.indexOf(call));
    // ④ 축을 우회하는 상수 배선이 섞여 있지 않다.
    expect(body).not.toMatch(/weekSource\s*=\s*"(measured|cycle)"/);
  });

  it("기본값은 종전 축이다 — 대시보드 경쟁사 행은 `weekAxis` 를 안 넘긴다", () => {
    // `fetchStandardCompetitorSources`(대시보드) 의 두 호출부는 예산만 명시한다.
    expect(SERVER_SRC).toContain('fetchStandardKpiBrandTrend(filters, { budget: "extras" })');
    expect(SERVER_SRC).toContain(
      'fetchStandardKpiBrandTrend(filters, { budget: opts.budget })',
    );
    // 대시보드 경쟁사 read 두 함수 **본문**에 축 인자가 없다(고정 길이 슬라이스 아님).
    for (const fn of [
      "fetchStandardCompetitorBrandTrend",
      "fetchStandardCompetitorSources",
    ]) {
      expect(fnBody(SERVER_SRC, fn)).not.toContain("weekAxis");
    }
  });
});
