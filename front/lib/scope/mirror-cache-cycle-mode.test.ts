// 셀별 회차 지문 모드(`mirror-cache-cycle-mode.ts`)가 **실제 셀 시그니처**와 맞는가.
//
// 규칙은 이름으로 정해진다(`summary-*` → none, `period-compare` → ledger, 나머지 → gate).
// 이름 규칙은 틀리기 쉬우므로 `server.ts` 원문과 양방향으로 대조한다:
//   ① `summary-*` 셀은 **전부** 첫 인자로 회차 집합 키를 받는다(`SummaryArgs`·
//      `GlobalSummaryArgs`·`_cycleKey`) — 그래야 지문을 빼도 회차가 바뀌면 셀이 갈린다.
//   ② 회차 집합 키를 받는 셀은 **전부** `summary-*` 이름이다 — 이름을 다르게 지으면
//      지문이 이중으로 붙어(무해) 콜드만 늘거나, 반대로 규칙이 조용히 빗나간다.
//   ③ `ledger` 셀의 리더가 실제로 원장 `status` 를 읽는다(근거가 사라지면 이 테스트가 운다).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LEDGER_CYCLE_CELLS,
  mirrorCycleModeOf,
} from "./mirror-cache-cycle-mode";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SRC = readFileSync(`${REPO}/lib/scope/server.ts`, "utf8");

/** `mirrorCache("<이름>", <첫 인자 선언 ~400자>)` 를 전부 뽑는다. */
function cells(): Array<{ name: string; head: string }> {
  const out: Array<{ name: string; head: string }> = [];
  const re = /mirrorCache\(\s*"([a-z0-9-]+)"/g;
  for (let m = re.exec(SRC); m; m = re.exec(SRC)) {
    out.push({ name: m[1], head: SRC.slice(m.index, m.index + 400) });
  }
  return out;
}

const CARRIES_CYCLE_KEY = /GlobalSummaryArgs|SummaryArgs|_cycleKey: string/;

describe("mirrorCycleModeOf", () => {
  it("summary-* → none, period-compare → ledger, 나머지 → gate", () => {
    expect(mirrorCycleModeOf("summary-website-dashboard")).toBe("none");
    expect(mirrorCycleModeOf("period-compare")).toBe("ledger");
    expect(mirrorCycleModeOf("website-target-hit-rate")).toBe("gate");
    expect(mirrorCycleModeOf("entity-roster")).toBe("gate");
  });

  it("셀 목록을 실제로 읽었다(헛돌지 않음)", () => {
    const all = cells();
    expect(all.length).toBeGreaterThanOrEqual(70);
    expect(all.filter((c) => c.name.startsWith("summary-")).length).toBeGreaterThanOrEqual(20);
  });

  it("① summary-* 셀은 전부 첫 인자로 회차 집합 키를 받는다", () => {
    const bad = cells()
      .filter((c) => mirrorCycleModeOf(c.name) === "none")
      .filter((c) => !CARRIES_CYCLE_KEY.test(c.head))
      .map((c) => c.name);
    expect(bad).toEqual([]);
  });

  it("② 회차 집합 키를 받는 셀은 전부 summary-* 이름이다", () => {
    const bad = cells()
      .filter((c) => CARRIES_CYCLE_KEY.test(c.head))
      .filter((c) => mirrorCycleModeOf(c.name) !== "none")
      .map((c) => c.name);
    expect(bad).toEqual([]);
  });

  it("③ ledger 셀은 실재하고, 그 리더가 원장 status·세대 조인을 읽는다", () => {
    const names = new Set(cells().map((c) => c.name));
    for (const n of LEDGER_CYCLE_CELLS) expect(names.has(n), n).toBe(true);
    const reader = readFileSync(
      `${REPO}/lib/db/repositories/summary-period-compare.ts`,
      "utf8",
    );
    expect(reader).toContain(".status <> 'open' AND");
    expect(reader).toContain(".active_generation_id");
  });

  it("gate 셀이 status 를 읽는 유일한 자리는 축 on 에서 도달하지 않는다(3838 반환 뒤)", () => {
    const agg = readFileSync(`${REPO}/lib/db/repositories/scope-aggregates.ts`, "utf8");
    const fnAt = agg.indexOf("export async function excludeHiddenCycleRuns(");
    const body = agg.slice(fnAt, agg.indexOf("\n}\n", fnAt));
    const earlyReturn = body.indexOf("if (anchorAxisKnownEnabled() && (jobIdCol || anchorRunIdCol))");
    const statusRead = body.indexOf("ELSE c.status IN (");
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(statusRead).toBeGreaterThan(earlyReturn);
    // 호출부는 전부 job 또는 run 열을 넘긴다(세 번째 인자 또는 네 번째 인자).
    const calls = [...agg.matchAll(/excludeHiddenCycleRuns\(\s*sql`[a-z.]+_?id`,\s*"(?:mention|citation)",?\s*([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const c of calls) expect(c[1], c[0]).toMatch(/sql`[a-z]+\.(job|run)_id`/);
  });
});
