import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 글로벌 **추이**만 같은 주 대표 회차를 쓴다 — 배선 가드 (2026-09-18) ──────
//
// 값 대조는 순수 함수 쪽(`lib/summary/read/cycle-set.fleet-visible.test.ts`)이 한다.
// 여기서 고정하는 것은 **어디에 걸려 있는가** 셋이다:
//
//   ① `viaGlobalSeries`(추이 전용 게이트)가 회차 집합을 `restrictToFleetVisible` 로
//      좁힌다.
//   ② 회차 하한(`G_TREND_MIN_CYCLES`)·캐시 키·접기 존재 검사가 **거른 뒤 집합**을 본다.
//      하나라도 `route.*` 를 보면 "판정한 회차" 와 "읽는 회차" 가 갈린다.
//   ③ 다른 게이트(스냅샷 S1·누적·웹사이트)는 이 필터를 **안 탄다**. 누적은 한 주 두
//      회차를 더하는 것이 정당하고, 스냅샷은 애초에 회차를 하나만 고른다.
//
// ③이 이 파일의 존재 이유다 — 필터를 `pickCyclesInRange` 술어나 `judgeCycleRange` 로
// 올리면 이 세 가드가 전부 조용히 통과하면서 누적 값이 바뀐다.

const src = readFileSync(
  fileURLToPath(new URL("./server.ts", import.meta.url)),
  "utf8",
);

/** `viaX` 함수 본문만 잘라낸다(다음 최상위 선언 전까지) — fallback-destination 과 같은 자세. */
function bodyOf(name: string): string {
  const i = src.indexOf(`async function ${name}<T>(`);
  expect(i, name).toBeGreaterThan(0);
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j);
}

describe("viaGlobalSeries — 추이 회차 집합은 대표만", () => {
  const body = bodyOf("viaGlobalSeries");

  it("① 회차 집합을 자리 규칙 한 벌(`restrictToTrendSlotSet`)로 좁힌다", () => {
    // 2026-09-20: 세 거르기(함대 대표 → 자리 대표 → 완결성)가 `cycle-set.ts` 의
    // `restrictToTrendSlotSet` 한 함수로 옮겨갔다 — **카드 게이트가 같은 규칙을 써야**
    // 하기 때문이다(카드가 한 자리의 회차를 전부 합산하던 결함). 순서 가드는 그 함수
    // 안을 보는 `trend-grid-wiring.test.ts` 가 소유한다.
    expect(body).toMatch(/restrictToTrendSlotSet\(globalCycleSetOf\(route\)\)/);
    expect(body).toMatch(/const \{ set, gapDays \} = restricted;/);
  });

  it("② 회차 하한은 **거른 뒤** `set.anchorCount` 로 판정한다", () => {
    expect(body).toMatch(/set\.anchorCount < G_TREND_MIN_CYCLES/);
    // 거르기 전 수로 판정하면 패자 하나가 시계열 점화를 대신 통과시킨다.
    expect(body).not.toMatch(/route\.anchorCount < G_TREND_MIN_CYCLES/);
  });

  it("② 좁히는 것이 하한 판정보다 **먼저**다", () => {
    expect(body.indexOf("restrictToTrendSlotSet"))
      .toBeLessThan(body.indexOf("G_TREND_MIN_CYCLES"));
  });

  it("② 캐시 키·접기 검사도 거른 뒤 집합을 넘긴다", () => {
    // read 키와 접기 프로브 키가 둘 다 `set` 이어야 한다(route 를 다시 쓰면 갈린다).
    expect(body).toMatch(/cachedGlobalSeriesFoldPresent\(JSON\.stringify\(\{ set, tables \}\)\)/);
    expect(body).toMatch(/read\(JSON\.stringify\(\{ set, v: plan\.ownVariant, f, \.\.\.extraKey \}\)\)/);
    // 좁힌 뒤에 `route.cycleKey` 를 다시 읽으면 캐시 셀이 옛 회차 집합 키로 서는데
    // 내용은 새 집합이라, 두 집합이 한 셀을 공유한다. 이 본문에는 등장하지 않는다
    // (집합 추출은 `globalCycleSetOf` 가 하고, 그 뒤로는 `set` 만 쓴다).
    expect(body.match(/route\.cycleKey/g) ?? []).toHaveLength(0);
  });

  it("③ 함대 대표 거르기의 **호출은 한 곳**이다", () => {
    const CYCLE_SET = readFileSync(
      fileURLToPath(new URL("../summary/read/cycle-set.ts", import.meta.url)),
      "utf8",
    );
    // 선언 1 + `restrictToTrendSlotSet` 안의 호출 1. 늘었다면 누적·스냅샷 경로로 샜는지 볼 것.
    expect(CYCLE_SET.match(/restrictToFleetVisible\(/g) ?? []).toHaveLength(2);
    // `server.ts` 는 이제 이 함수를 직접 부르지 않는다 — 규칙이 한 벌이라는 뜻이다.
    expect(src.match(/restrictToFleetVisible\(/g) ?? []).toHaveLength(0);
  });

  // ── 카드도 같은 규칙을 탄다 (2026-09-20) ─────────────────────────────────
  //
  // 종전 이 파일의 ③ 은 "이 필터를 타는 게이트는 추이 하나뿐" 이었다. 그 경계가
  // 정확히 결함이었다 — 기간 모드의 카드가 한 자리의 회차를 **전부 합산**해서
  // 2026-08-17 자리에서 14.0%(함대 노출 꺼진 회차 포함)를, 같은 자리 상세는 6.5%를
  // 냈다. 누적·스냅샷이 이 규칙을 안 타는 것은 그대로다.
  it("③′ 카드 게이트도 같은 함수를 쓰되 **격자 키 뒤**다", () => {
    const s1 = bodyOf("viaGlobalS1");
    expect(s1).toContain("restrictToTrendSlotSet(routeSet)");
    expect(s1).toContain("if (period && trendGridApplied(routeSet))");
  });

  it("③″ 인용·누적 게이트는 이 규칙을 안 탄다", () => {
    for (const fn of ["viaGlobalTrend"]) {
      expect(bodyOf(fn), fn).not.toContain("restrictToTrendSlotSet");
    }
  });

  // ── 함대 게이트는 **자리 규칙 한 벌을 그대로 부르면 안 된다** (검증 H 복원) ──
  //
  // 종전 ③ 은 세 함수를 한꺼번에 감시했는데 `viaGlobalS1` 이 의도적으로 편입되면서
  // 범위가 하나로 좁아졌다. 남은 위험은 `viaTrend`(함대)다: 거기서 `restrictToTrendSlotSet`
  // 을 부르면 자리 그룹이 날짜 하나라 **그 자리의 사이트 수십 개가 회차 하나로 접힌다**
  // (`cycle-set.slot-representative.test.ts` 의 "perProject 를 빠뜨리면" 가 그 동작이다).
  // 함대는 반드시 `websiteSlotRestrictedSet`(= `perProject: true`)을 거쳐야 한다.
  it("③‴ 함대 게이트는 자리 규칙 한 벌을 직접 부르지 않는다", () => {
    const trend = bodyOf("viaTrend");
    expect(trend).not.toContain("restrictToTrendSlotSet");
    expect(trend).toContain("websiteSlotRestrictedSet(cycleSetOf(route)");
    // 함대 경로의 유일한 자리 거르기는 그 헬퍼이고, 그 안은 `perProject: true` 다.
    const at = src.indexOf("function websiteSlotRestrictedSet(");
    expect(at).toBeGreaterThan(-1);
    const helper = src.slice(at, src.indexOf("\n}\n", at));
    expect(helper).toContain("{ perProject: true }");
    expect(helper).not.toContain("restrictToTrendSlotSet");
    // 웹사이트 추이 판정도 같은 헬퍼를 쓴다(두 지면이 갈리면 ⑥ 병합 키가 어긋난다).
    expect((src.match(/websiteSlotRestrictedSet\(cycleSetOf\(route\)/g) ?? [])).toHaveLength(2);
  });
});

// ── 규칙은 한 곳, 소비자는 셋 (2026-09-18 후속) ────────────────────────────
//
// 대표 판정이 코드 여러 곳에 복제되면 "화면이 내는 회차" 와 "감시가 기대하는 회차" 가
// 갈려 상시 오탐이 된다(2026-09-13 사건의 교훈). 소비자가 전부 같은 모듈을 쓰는지 본다.
describe("dropFleetLosers — 소비자 배선", () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("세 소비자(추이 집합·스냅샷 픽·회차 감시)가 같은 모듈을 쓴다", () => {
    for (const rel of [
      "../summary/read/cycle-set.ts",
      "../db/repositories/summary-cycles.ts",
      "../summary/health/cycle-chain.ts",
    ]) {
      expect(read(rel), rel)
        .toContain('import { dropFleetLosers } from "@/lib/summary/fleet-visible"');
    }
  });

  it("하네스 둘도 프로덕션과 같은 회차 집합을 읽는다", () => {
    // 안 태우면 화면에 없는 점을 대조하게 된다(패리티가 거짓 불일치를 낸다).
    for (const rel of [
      "../../scripts/summary/parity-global-trend.ts",
      "../../scripts/summary/explain-global-trend.ts",
    ]) {
      const src = read(rel);
      expect(src, rel).toContain("restrictToFleetVisible({");
      expect(src, rel).toContain("fleet_visible");
    }
  });
});
