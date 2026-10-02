import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectableAnchorDatesCacheKey } from "@/lib/calendar/selectable-anchor-dates";

// ════════════════════════════════════════════════════════════════════════════
// 캐시 키 — **축 off 의 키는 문자 하나도 바뀌면 안 된다** (계약 §4)
// ════════════════════════════════════════════════════════════════════════════
//
// `unstable_cache` 의 호출 키는 `JSON.stringify(arguments)` 다. 그래서 셀 인자에 플래그를
// **항상** 실으면(`false` 포함) 축이 꺼진 배포의 키까지 바뀌고, 기존 엔트리가 통째로
// 미스가 된다. 값은 같아도 **비용과 지연이 달라진다** — "끄면 종전 동작" 이 캐시 층에서
// 깨지는 형태이고, 화면만 봐서는 안 보인다.
//
// 그래서 규약은 "켜졌을 때만 슬롯을 붙인다" 이고, 그것을 여기서 두 각도로 고정한다:
//   ① 타입     — `anchorAxis?: true` (false 를 넣을 수 없다)
//   ② 호출부   — off 는 인자 10개, on 은 11개
//   ③ 키 문자열 — 10개짜리 직렬화를 **리터럴로** 박아 둔다

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER_SRC = readFileSync(`${REPO_ROOT}/lib/scope/server.ts`, "utf8");

/** `unstable_cache` 가 인자에서 키를 만드는 규칙. Next 구현과 같은 식이다. */
const invocationKey = (args: readonly unknown[]): string => JSON.stringify(args);

// 종전(축 없던 시절)의 10개 슬롯 — 순서가 곧 키다.
const OFF_ARGS = [
  "2026-09-15", // anchorDay
  "global", // surface
  ["p1"], // projectIds
  "ownAll", // ownVariant
  [], // ownedBasePrefixes
  "mention", // family
  [{ key: "2026-09-07..2026-09-13", lo: "2026-09-07", hi: "2026-09-13" }],
  false, // unitFlags
  [], // excludedUnits
  {}, // filters
] as const;

describe("기간 비교 셀 — 축 off 키 무변경", () => {
  it("off 키는 이 리터럴이다(슬롯 10개, 플래그 없음)", () => {
    expect(invocationKey(OFF_ARGS)).toBe(
      '["2026-09-15","global",["p1"],"ownAll",[],"mention",' +
        '[{"key":"2026-09-07..2026-09-13","lo":"2026-09-07","hi":"2026-09-13"}],false,[],{}]',
    );
  });

  it("축 on 키는 off 와 다르고, off 키를 **접두사로** 포함한다", () => {
    const on = invocationKey([...OFF_ARGS, true]);
    const off = invocationKey(OFF_ARGS);
    expect(on).not.toBe(off);
    expect(on).toBe(off.slice(0, -1) + ",true]");
  });

  it("플래그에 false 를 실으면 off 키가 깨진다(= 그래서 안 싣는다)", () => {
    expect(invocationKey([...OFF_ARGS, false])).not.toBe(invocationKey(OFF_ARGS));
  });

  it("타입이 `false` 를 막는다 — 슬롯은 `anchorAxis?: true` 다", () => {
    expect(SERVER_SRC).toContain("anchorAxis?: true,");
    expect(SERVER_SRC).not.toContain("anchorAxis?: boolean,");
  });

  it("호출부는 off 에서 슬롯을 **아예 넘기지 않는다**", () => {
    // 종전 10개 슬롯이 한 튜플로 묶여 있고, on 만 뒤에 `true` 가 붙는다.
    const at = SERVER_SRC.indexOf("const cellArgs = [");
    expect(at).toBeGreaterThan(-1);
    const tuple = SERVER_SRC.slice(at, SERVER_SRC.indexOf("] as const;", at));
    // 주석 줄을 뺀 실제 슬롯 수.
    const slots = tuple
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.endsWith(",") && !l.startsWith("//"));
    expect(slots).toEqual([
      "anchorDay,",
      "opts.surface,",
      "projectIds,",
      "plan.ownVariant,",
      "extras.ownedBasePrefixes,",
      "opts.family,",
      "windows,",
      "extras.unitFlags,",
      "extras.excludedUnits,",
      "f,",
    ]);
    expect(SERVER_SRC).toContain("? await cachedPeriodCompare(...cellArgs, true)");
    expect(SERVER_SRC).toContain(": await cachedPeriodCompare(...cellArgs);");
  });

  it("리더 옵션도 켜졌을 때만 만든다", () => {
    expect(SERVER_SRC).toContain("anchorAxis ? { anchorAxis: true } : undefined,");
  });
});

describe("달력 로더 셀 — 키는 순서가 고정된 문자열 하나", () => {
  it("같은 집합이면 순서가 달라도 같은 키다", () => {
    const a = selectableAnchorDatesCacheKey("website", ["p2", "p1"], {}, "mentions");
    const b = selectableAnchorDatesCacheKey("website", ["p1", "p2"], {}, "mentions");
    expect(a).toBe(b);
  });

  it("표면이 다르면 키가 갈린다", () => {
    expect(selectableAnchorDatesCacheKey("standard", ["p1"], {}, "mentions")).not.toBe(
      selectableAnchorDatesCacheKey("website", ["p1"], {}, "mentions"),
    );
  });

  it("통합 배선이 넘기는 형태(필터 없음)의 키는 이 리터럴이다", () => {
    expect(selectableAnchorDatesCacheKey("standard", ["root-1"], {}, "mentions")).toBe(
      '["standard",["root-1"],null,null,[],[],"mentions"]',
    );
  });

  it("계열이 키를 가른다 — 언급 화면과 인용 화면이 한 셀을 공유하지 않는다", () => {
    expect(selectableAnchorDatesCacheKey("standard", ["root-1"], {}, "citations")).toBe(
      '["standard",["root-1"],null,null,[],[],"citations"]',
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 미러 집계 셀에도 축이 들어간다 (검증 W5)
// ════════════════════════════════════════════════════════════════════════════
//
// 이 셀들의 **내용**은 축에 따라 달라지는데(리더가 안에서 `ensureAnchorAxis()` 를 본다)
// 키에는 축이 없었다. `MIRROR_CACHE_GENERATION` 은 소스 해시라 화면 키 토글로는 안
// 바뀌므로, 켠 직후 최대 TTL(7,200초) 동안 카드는 옛 축·달력은 새 축일 수 있었다.
describe("미러 집계 셀 — 축 on 에서만 셀이 갈린다", () => {
  const SRC = readFileSync(`${REPO_ROOT}/lib/scope/server.ts`, "utf8");
  const at = SRC.indexOf("function mirrorCache<A extends unknown[], R>(");
  const body = SRC.slice(at, SRC.indexOf("\n}\n", at));

  it("축 off 셀의 키 조각은 종전 그대로다(두 조각)", () => {
    expect(body).toContain("unstable_cache(fn, [MIRROR_CACHE_GENERATION, key], {");
  });

  // 2026-09-27 — 축 on 셀은 **축 고정 조각 + 회차 지문 조각**을 싣는다. 축 조각만
  // 있던 시절에는 앵커 수동 적재·시계의 노출일 통과가 TTL 동안 가려졌다(프리뷰 실측:
  // 라벨 9/25 · 카드 17개 9/18). 행동 증명은 `lib/scope/server.cycle-key.test.ts`.
  it("축 on 은 [축 조각, (회차 조각)] 을 가진 **다른 셀**이다 — 회차 조각은 셀 모드를 따른다", () => {
    expect(body).toContain("const cycleMode = mirrorCycleModeOf(key);");
    expect(body).toContain(
      'cycleMode === "none" ? Promise.resolve(null) : ensureCycleCacheSlot(cycleMode),',
    );
    expect(body).toContain(
      "axis: cycle ? [ANCHOR_AXIS_CACHE_SLOT, cycle] : [ANCHOR_AXIS_CACHE_SLOT], grid",
    );
    expect(body).toContain(
      "cell = unstable_cache(fn, [MIRROR_CACHE_GENERATION, key, ...parts], {",
    );
    // `false` 를 키에 싣지 않는다 — 실으면 축 off 키까지 바뀐다.
    expect(body).not.toContain("anchorAxis ?");
    expect(body).not.toContain("String(");
  });

  // 2026-09-20(통합 W1) — 셀이 셋이 됐다: 종전(축 off) · 축 on · 축 on + 격자 on.
  // 격자 셀이 필요한 이유는 미러 SQL 이 격자 판정에 의존하게 됐기 때문이다
  // (`trendAlignedRootPreds`·`trendMirrorJoins`·`trendFloorDays`). 라우팅은 축을 먼저
  // 보고(격자는 축을 선행 조건으로 둔다) 그 다음 격자를 본다.
  it("라우팅은 리더가 보는 바로 그 상태를 쓴다 — 축 → (회차 ∥ 격자)", () => {
    expect(body).toContain("if (!(await ensureAnchorAxis())) return base(...args);");
    // 회차 지문은 축이 켜진 **뒤에만** 묻는다(축 off = DB 왕복 0).
    const routedAt = body.indexOf("const routed = async");
    const routed = body.slice(routedAt, body.indexOf("};", routedAt));
    expect(routed.indexOf("ensureAnchorAxis")).toBeLessThan(routed.indexOf("axisOn()"));
    // 회차 조각과 격자 판정은 병렬로 확정한다(검증 C3).
    const onAt = body.indexOf("const axisOn = async");
    const on = body.slice(onAt, body.indexOf("\n  };", onAt));
    expect(on).toContain("await Promise.all([");
    expect(on).toContain("ensureTrendGrid(),");
    // 2026-09-20(A2-1): 격자 셀은 **목록 해시가 실린 슬롯**으로 고른다.
    expect(body).toContain(
      "return slotCell(grid ? [...axis, trendGridCacheSlot()] : axis)(...args);",
    );
  });

  // 종전(축 off) 셀과 조각 셀(축 on·격자·유닛)의 TTL·태그가 같아야 한다.
  it("두 래퍼의 TTL·태그가 같다 (한쪽만 오래 살면 토글 뒤 또 갈린다)", () => {
    const cells = [...body.matchAll(/revalidate: revalidate \?\? MIRROR_CACHE_TTL,/g)];
    expect(cells).toHaveLength(2);
    const tags = [...body.matchAll(/tags: \[MIRROR_AGGREGATE_TAG, \.\.\.extraTags\],/g)];
    expect(tags.length).toBeGreaterThanOrEqual(2);
  });

  it("고정 조각의 값이 박혀 있다 (바꾸면 전 셀이 1회 미스다)", () => {
    expect(SRC).toContain('const ANCHOR_AXIS_CACHE_SLOT = "anchor-axis" as const;');
    expect(SRC).toContain('const TREND_GRID_CACHE_SLOT = "trend-grid" as const;');
  });

  // 격자 off 의 키는 **한 글자도** 바뀌면 안 된다 — 격자 조각은 켜졌을 때만 붙는다.
  it("격자 조각은 축·회차 조각 **뒤에** 한 겹으로만 붙는다", () => {
    // 슬롯은 `trendGridCacheSlot()` 이 만든다 — 목록이 비면 `TREND_GRID_CACHE_SLOT`
    // 그대로이고, 목록이 있으면 `"trend-grid:<해시>"` 다(A2-1).
    expect(body).toContain("slotCell(grid ? [...axis, trendGridCacheSlot()] : axis)");
  });

  it("조각 셀은 조합마다 **하나**다 (지문·목록이 바뀌면 셀이 갈린다), 래퍼 수는 상한이 있다", () => {
    expect(body).toContain("const slotCells = new Map<string, (...args: A) => Promise<R>>();");
    expect(body).toContain("slotCells.set(k, cell);");
    expect(body).toContain("if (slotCells.size >= MIRROR_SLOT_CELL_CAP) slotCells.clear();");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 유닛 단위 자사 판정 셀 (2026-09-20, 화면 키 `X.websiteOwnedUnit`)
// ════════════════════════════════════════════════════════════════════════════
//
// 이 키는 website 표면의 **값**을 바꾼다(자사 URL 인용률 함대 90.22% → 78.62%). 그런데
// 그 값을 내는 셀들의 키에 판정이 없으면, 켠 직후 최대 TTL(2시간) 동안 **어떤 타일은
// 유닛, 옆 타일은 flat** 이다 — 이 트랙이 애초에 막으려던 "한 화면에 두 정의" 가
// 캐시 층에서 그대로 재현된다.
describe("미러 집계 셀 — 유닛 판정은 옵트인 셀에만, 켜졌을 때만 붙는다", () => {
  const SRC = readFileSync(`${REPO_ROOT}/lib/scope/server.ts`, "utf8");
  const at = SRC.indexOf("function mirrorCache<A extends unknown[], R>(");
  const body = SRC.slice(at, SRC.indexOf("\n}\n", at));

  it("고정 조각의 값이 박혀 있다 (바꾸면 키 on 의 전 셀이 1회 미스다)", () => {
    expect(SRC).toContain('const WEBSITE_OWNED_UNIT_CACHE_SLOT = "owned-unit" as const;');
  });

  it("조각은 **마지막**에 한 겹으로만 붙는다", () => {
    expect(body).toContain("slotCell([WEBSITE_OWNED_UNIT_CACHE_SLOT])");
    expect(body).toContain("? [...axis, trendGridCacheSlot(), WEBSITE_OWNED_UNIT_CACHE_SLOT]");
    expect(body).toContain(": [...axis, WEBSITE_OWNED_UNIT_CACHE_SLOT],");
  });

  it("옵트인이다 — 안 건 셀은 판정을 묻지도 않는다(글로벌·프로젝트 셀 콜드 방지)", () => {
    expect(body).toContain(
      "ownedUnitAware && (await ensureWebsiteOwnedUnit()) ? unitRouted(...args) : routed(...args)",
    );
    // `false` 를 키에 싣지 않는다 — 실으면 키 off 의 셀까지 갈린다.
    expect(body).not.toContain("ownedUnit ?");
  });

  it("유닛 라우팅이 축·회차·격자 조합을 **그대로** 따라간다", () => {
    // 축 off 의 유닛 셀 키는 종전 `[세대, key, "owned-unit"]` 그대로다.
    expect(body).toContain(
      "if (!(await ensureAnchorAxis())) return slotCell([WEBSITE_OWNED_UNIT_CACHE_SLOT])(...args);",
    );
    const at = body.indexOf("const unitRouted = async");
    const unit = body.slice(at, body.indexOf("\n  };", at));
    expect(unit).toContain("const { axis, grid } = await axisOn();");
    expect(unit.indexOf("ensureAnchorAxis")).toBeLessThan(unit.indexOf("axisOn()"));
  });

  // 키가 켜지면 **함께** 움직여야 하는 셀 전부. 하나라도 빠지면 그 타일만 flat 값으로
  // 남는다(캐시 키가 갈리지 않아 TTL 동안 옛 값이 서빙된다).
  it("website 자사 판정을 읽는 셀은 전부 옵트인돼 있다", () => {
    const cells = [
      "website-aggregates",
      "website-trend",
      "website-subkpis",
      "website-subkpis-prev",
      "website-source-composition",
      "website-citations",
      "website-citation-accuracy",
      "website-citation-accuracy-trend",
      "website-target-hit-rate",
    ];
    for (const name of cells) {
      const start = SRC.indexOf(`mirrorCache("${name}"`);
      expect(start, `${name}: 셀을 못 찾았다`).toBeGreaterThan(-1);
      // 셀 정의는 `}, [], undefined, true);` 로 닫힌다(옵트인 플래그가 4번째 인자).
      const chunk = SRC.slice(start, start + 1400);
      expect(chunk, `${name}: 유닛 옵트인 누락`).toContain("}, [], undefined, true);");
    }
  });
});
