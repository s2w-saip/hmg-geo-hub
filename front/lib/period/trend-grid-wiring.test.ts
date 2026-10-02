import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ════════════════════════════════════════════════════════════════════════════
// 추이 격자 배선 가드 — **끄면 바이트 동일**을 소스로 고정한다 (W1)
// ════════════════════════════════════════════════════════════════════════════
//
// 이 PR 이 값을 바꾸는 범위는 좁다: 추이 리더 셋 + 기간 모드 회차 집합. 그 경계가
// 코드에서 지켜지는지는 **값이 아니라 배선**이라 단위 테스트로 잡히지 않는다 —
// 카드 리더에 플래그를 한 줄 얹어도 tsc 도 vitest 도 조용하다.
//
// ⚠️ `lib/scope/server.ts` 는 런타임 import 가 불가능하다(`server-only` + DB + Next
//    캐시). 이 리포의 다른 배선 가드와 같이 **소스 분석**으로 본다.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(`${REPO_ROOT}/${rel}`, "utf8");

const SERVER = read("lib/scope/server.ts");
const GATE = read("lib/summary/read/gate.ts");
const TREND_READ = read("lib/db/repositories/summary-global-trend-read.ts");
const AGG = read("lib/db/repositories/summary-trend-aggregates.ts");

describe("플래그 모듈 — 이름과 시그니처는 PR② 와 공유한다", () => {
  const FLAG = read("lib/period/trend-grid-flag.ts");

  it("`lib/period/trend-grid-flag.ts` 가 두 진입점을 낸다", () => {
    expect(FLAG).toContain("export async function trendGridEnabled(): Promise<boolean>");
    expect(FLAG).toContain("export function ensureTrendGrid(): Promise<boolean>");
  });

  it("env 이름은 프리뷰 전용 `TREND_GRID_FORCE` 이고 `NEXT_PUBLIC_` 이 아니다", () => {
    expect(FLAG).toContain("env.TREND_GRID_FORCE === \"1\"");
    // 주석에는 "NEXT_PUBLIC_ 을 붙이지 않는다" 가 있으므로 **읽는 코드**만 본다.
    expect(FLAG).not.toMatch(/env\.NEXT_PUBLIC/);
  });
});

describe("리더 경계 — 추이 셋만 게이트를 뺀다", () => {
  it("추이 read 세 곳이 전부 `withTrendGrid` 를 거친다", () => {
    const calls = TREND_READ.match(/await withTrendGrid\(scope\)/g) ?? [];
    expect(calls).toHaveLength(3);
    for (const fn of [
      "readGlobalTrendCore",
      "readGlobalBrandSnapshot",
      "readGlobalBrandSeries",
    ]) {
      const at = TREND_READ.indexOf(`export async function ${fn}`);
      expect(at, fn).toBeGreaterThan(-1);
      const body = TREND_READ.slice(at, TREND_READ.indexOf("\n}\n", at));
      expect(body, fn).toContain("withTrendGrid(scope)");
    }
  });

  // 카드·인용·웹사이트 리더가 이 플래그를 읽으면 스냅샷 모수가 함께 움직인다
  // (설계 §4-2: "카드는 같은 결정을 지금 받지 않는다").
  it("카드·인용·웹사이트 리더는 플래그 모듈을 import 하지 않는다", () => {
    for (const f of [
      "lib/db/repositories/summary-global-aggregates.ts",
      "lib/db/repositories/summary-citation-read.ts",
      "lib/db/repositories/summary-website-aggregates.ts",
    ]) {
      expect(read(f), f).not.toContain("trend-grid-flag");
    }
  });

  it("스코프 필드는 `true` 만 받는다 — `false` 를 실을 수 없다", () => {
    expect(AGG).toContain("trendGrid?: true;");
    expect(AGG).not.toContain("trendGrid?: boolean");
  });

  it("게이트 제거는 조건 한 줄이고 나머지 둘은 무조건이다", () => {
    expect(AGG).toContain("conds.push(sql`in_root_catalog = 1`, sql`in_tagged_region = 1`);");
    expect(AGG).toContain("if (scope.trendGrid !== true) conds.push(sql`in_full_cycle = 1`);");
  });
});

describe("회차 집합 — 완결성은 기간 모드에서만, 켜졌을 때만 실린다", () => {
  it("게이트가 스냅샷 모드에서는 격자를 묻지 않는다", () => {
    const calls = GATE.match(/mode === "period" \? ensureTrendGrid\(\) : Promise\.resolve\(false\)/g);
    // 표면 둘(글로벌·웹사이트).
    expect(calls).toHaveLength(2);
  });

  it("꺼져 있으면 `resolveCycleSet` 호출에 인자 자체가 없다", () => {
    const calls = GATE.match(/\.\.\.\(trendGrid \? \{ trendGrid: true \} : \{\}\),/g);
    expect(calls).toHaveLength(2);
    expect(GATE).not.toContain("trendGrid,\n  });");
  });

  it("픽에 완결성을 싣는 것도 켜졌을 때만이다(캐시 키 불변)", () => {
    const CYCLE_SET = read("lib/summary/read/cycle-set.ts");
    expect(CYCLE_SET).toContain("...(opts.trendGrid");
    expect(CYCLE_SET).toContain("completionRatio: completionRatioFromUnits(");
  });
});

// ── 거르기 순서는 **한 곳**에 산다 (2026-09-20 카드 정합 수리) ──────────────
//
// 종전에는 세 단계가 `server.ts::viaGlobalSeries` 안에만 인라인으로 있었고, 그래서
// **카드 게이트(`viaGlobalS1`)가 같은 자리의 회차를 전부 합산**했다(8/17 자리 카드
// 14.0% vs 상세 6.5%). 규칙을 `cycle-set.ts::restrictToTrendSlotSet` 한 벌로 옮기고
// 두 게이트가 그것을 부른다 — 그래서 순서 가드도 그 함수를 본다.
describe("자리 거르기 — 순서는 `restrictToTrendSlotSet` 안에 있다", () => {
  const CYCLE_SET = read("lib/summary/read/cycle-set.ts");
  const bodyOfRestrict = (): string => {
    const at = CYCLE_SET.indexOf("export function restrictToTrendSlotSet(");
    expect(at).toBeGreaterThan(-1);
    return CYCLE_SET.slice(at, CYCLE_SET.indexOf("\n}\n", at));
  };

  it("자리 대표 거르기는 함대 대표 거르기 **뒤**다", () => {
    const body = bodyOfRestrict();
    const fleetAt = body.indexOf("const fleetSet: CycleSet = restrictToFleetVisible(set);");
    const repAt = body.indexOf("restrictToSlotRepresentative(fleetSet);");
    expect(fleetAt).toBeGreaterThan(-1);
    expect(repAt).toBeGreaterThan(fleetAt);
  });

  // 완결성 거르기는 **자리 대표 거르기 뒤**여야 한다(2026-09-20 독립 검증 B2-c).
  // 완결성은 자리의 **최대**로 판정하는데(`slotIsIncomplete`), 자리 값이 대표 하나가 된
  // 뒤로 그 전제가 깨졌다. 대표를 먼저 고르면 자리에 회차가 하나뿐이라 최대 = 대표의
  // 비율이고, 두 판정이 같은 회차를 본다. 순서가 뒤집히면 **부분 측정 회차의 값이
  // 실값으로 나간다**(검증자가 실행으로 재현한 상태).
  it("완결성 거르기는 자리 대표 거르기 **뒤**다", () => {
    const body = bodyOfRestrict();
    const repAt = body.indexOf("restrictToSlotRepresentative(fleetSet);");
    const completeAt = body.indexOf(
      "const { set: complete, gapDays } = restrictToCompleteCycles(repSet);",
    );
    expect(repAt).toBeGreaterThan(-1);
    expect(completeAt).toBeGreaterThan(repAt);
  });

  it("규칙은 한 벌이다 — 세 단계를 부르는 곳이 이 함수뿐", () => {
    for (const name of [
      "restrictToFleetVisible(",
      "restrictToCompleteCycles(",
    ]) {
      // 선언 1 + `restrictToTrendSlotSet` 안의 호출 1 = 2. `server.ts` 에는 없다.
      expect((CYCLE_SET.match(new RegExp(name.replace("(", "\\("), "g")) ?? []).length, name)
        .toBe(2);
      expect(SERVER, name).not.toContain(name);
    }
  });

  it("두 게이트(추이·카드)가 **같은 함수**를 부른다", () => {
    const seriesAt = SERVER.indexOf("async function viaGlobalSeries<T>(");
    const seriesBody = SERVER.slice(seriesAt, SERVER.indexOf("\n}\n", seriesAt));
    expect(seriesBody).toContain("restrictToTrendSlotSet(globalCycleSetOf(route))");
    const s1At = SERVER.indexOf("async function viaGlobalS1<T>(");
    const s1Body = SERVER.slice(s1At, SERVER.indexOf("\n}\n", s1At));
    expect(s1Body).toContain("restrictToTrendSlotSet(routeSet)");
    // 카드 쪽은 **격자 키 뒤**다 — 끄면 회차 집합·캐시 키가 한 글자도 안 바뀐다.
    expect(s1Body).toContain("if (period && trendGridApplied(routeSet))");
  });

  // 거른 뒤 집합이 캐시 키·회차 하한·접힘 프로브에 들어가야 한다 — 하나라도 옛 집합이면
  // "읽는 회차와 판정한 회차" 가 갈린다.
  it("거른 뒤 집합(`set`)이 하한·프로브·read 에 쓰인다", () => {
    const at = SERVER.indexOf("const restricted = restrictToTrendSlotSet(globalCycleSetOf(route));");
    expect(at).toBeGreaterThan(-1);
    const body = SERVER.slice(at, at + 2500);
    expect(body).toContain("if (set.anchorCount < G_TREND_MIN_CYCLES)");
    expect(body).toContain("cachedGlobalSeriesFoldPresent(JSON.stringify({ set, tables }))");
    expect(body).toContain("read(JSON.stringify({ set, v: plan.ownVariant, f, ...extraKey }))");
  });

  it("카드 시계열 pick 이 갭 슬롯을 끼운다", () => {
    expect(SERVER).toContain(
      "insertCompletionGapBuckets(toStandardTrendBuckets(series), gapDays)",
    );
  });
});

// ── 캐시 키 — **켰을 때만** 갈린다 ─────────────────────────────────────────
//
// 셀의 호출 키는 `JSON.stringify(arguments)` 이고 인자에 `CycleSet` 이 통째로 들어간다
// (`cachedGlobalSeriesCore(set.cycleKey, set, ownVariant, filters)`). 그래서 회차 픽에
// 필드를 **항상** 실으면(`null` 포함) 꺼진 배포의 키까지 바뀌어 기존 엔트리가 통째로
// 미스가 된다 — 값은 같은데 비용과 지연만 달라지는, 화면으로는 안 보이는 회귀다.
describe("캐시 키 — 회차 픽의 직렬화", () => {
  const base = {
    cycleId: "c1",
    generationId: "g1",
    projectId: "p1",
    cycleAnchorAt: "2026-08-31T00:00:00.000Z",
    cycleWeek: "2026-08-31",
    roundDate: "2026-08-31",
  };

  it("off 픽의 직렬화는 이 리터럴이다(완결성 없음)", () => {
    expect(JSON.stringify(base)).toBe(
      '{"cycleId":"c1","generationId":"g1","projectId":"p1",' +
        '"cycleAnchorAt":"2026-08-31T00:00:00.000Z","cycleWeek":"2026-08-31",' +
        '"roundDate":"2026-08-31"}',
    );
  });

  it("on 은 키가 갈린다 — `null` 이어도 갈린다(그래서 off 에는 안 싣는다)", () => {
    expect(JSON.stringify({ ...base, completionRatio: 1 })).not.toBe(JSON.stringify(base));
    expect(JSON.stringify({ ...base, completionRatio: null })).not.toBe(JSON.stringify(base));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PR④ — 미러 추이 배선 가드
// ════════════════════════════════════════════════════════════════════════════
//
// `trendAlignedRootPreds` 는 **동기**이고 판정(`trendGridKnownEnabled`)은 메모된 상태를
// 읽는다. 그래서 추이 읽기의 async 진입점이 `await ensureTrendGrid()` 를 빠뜨리면 그
// 경로만 조용히 종전 모수로 나간다 — 값이 틀리는 방향은 아니지만 **켰는데 일부 화면만
// 안 바뀌는** 상태가 되고, 그것은 화면만 봐서는 안 보인다(`anchor-axis-state.ts` 가 같은
// 이유로 경고를 남긴다). 그래서 "빠뜨림"을 소스로 고정한다.
describe("미러 추이 — 모든 allRuns 진입점이 판정을 확정한다", () => {
  const AGG = read("lib/db/repositories/scope-aggregates.ts");

  /**
   * 최상위 함수 단위로 자른다(다음 함수 선언 전까지). **주석 줄은 지운다** —
   * 머리 주석의 `{ allRuns: true }` 인용이 옆 함수에 귀속돼 오탐이 난다
   * (실제로 `standardCollectionDates` 가 그렇게 잡혔다).
   */
  function functionsOf(src: string): Array<{ name: string; body: string }> {
    const re = /^(?:export )?(?:async )?function (\w+)/gm;
    const hits = [...src.matchAll(re)];
    const strip = (t: string) =>
      t.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    return hits.map((m, i) => ({
      name: m[1],
      body: strip(src.slice(m.index ?? 0, hits[i + 1]?.index ?? src.length)),
    }));
  }

  /**
   * `allRuns: true` 를 쓰지만 스스로 ensure 하지 **않아도 되는** 비공개 헬퍼 —
   * 공개 진입점이 이미 확정한 뒤에만 불린다. 새 이름이 여기 들어오려면 그 호출부가
   * ensure 하는 것을 확인해야 한다.
   */
  const ALLOWED_WITHOUT_ENSURE: Record<string, string> = {
    // `aggregateCitationsFromMirror` 안에서만 불린다(그쪽이 ensure).
    readCitationDomainDayCounts: "aggregateCitationsFromMirror",
    // `aggregateMentionsFromMirror` 안에서만 불린다(그쪽이 ensure).
    readMentionBrandDayCounts: "aggregateMentionsFromMirror",
    // KPI 탭 추이 3종이 공유하는 술어 자리 — 자기 안에서 ensure 한다(아래 별도 단언).
    kpiTabTrendWhere: "self",
  };

  it("`allRuns: true` 를 내는 함수는 전부 ensure 하거나 허용 목록에 있다", () => {
    const missing: string[] = [];
    for (const fn of functionsOf(AGG)) {
      if (!fn.body.includes("allRuns: true")) continue;
      if (fn.body.includes("await ensureTrendGrid()")) continue;
      if (fn.name in ALLOWED_WITHOUT_ENSURE) continue;
      missing.push(fn.name);
    }
    expect(missing, `ensure 누락: ${missing.join(", ")}`).toEqual([]);
  });

  it("KPI 탭 추이의 공유 술어 자리가 스스로 확정한다", () => {
    const at = AGG.indexOf("async function kpiTabTrendWhere(");
    const body = AGG.slice(at, AGG.indexOf("\n}\n", at));
    expect(body).toContain("await ensureTrendGrid();");
  });

  it("술어는 **한 함수**에서만 만들어진다 (복제 금지)", () => {
    expect((AGG.match(/function trendAlignedRootPreds\(/g) ?? [])).toHaveLength(1);
    // 소비자는 둘(answerWhere 루트 분기 · detailAllRunsWindowPreds 루트 분기).
    expect((AGG.match(/trendAlignedRootPreds\(/g) ?? []).length).toBe(3);
  });

  it("지역 스코핑 술어의 **정의**는 한 벌이다 (접두 판본은 감싸기만 한다)", () => {
    // `AND ` 접두 판본이 bare 판본을 감싸는 형태여야 한다 — 본문을 복사하면
    // 한쪽만 고치는 결함이 생긴다(그 결함이 검증 B1 이었다).
    expect(AGG).toContain("const bare = rootKoreanNonKrPred();");
    expect(AGG).toContain("const bare = rootRegionTagPred();");
    // ⚠️ 2026-09-20 후속: dim 스냅샷 경로가 생기면서 **현재값 술어의 별칭 판본**이
    //    하나 더 생겼다(`a2.` — semi-join 안쪽). 정의가 둘이 아니라 **같은 규칙의 별칭
    //    판본**이므로 수를 2로 고정한다. 셋이 되면 그때는 진짜 복제다.
    // 별칭 판본이 셋이다(같은 규칙): 바깥 `a.`(종전) · semi-join 안쪽 `a2.` ·
    // 조인 판본 `a.`(dim 이 FROM 에 붙은 경로). 넷이 되면 그때는 진짜 복제다.
    expect((AGG.match(/a\.region <> 'KR'\n/g) ?? [])).toHaveLength(2);
    expect((AGG.match(/a2\.region <> 'KR'\n/g) ?? [])).toHaveLength(1);
    expect((AGG.match(/unnest\(sp\.regions\) AS r/g) ?? [])).toHaveLength(4);
  });
});

// ── dim 조인과 술어는 **함께 간다** (42P01 가드) ────────────────────────────
//
// `caJoined: true` 로 술어만 켜고 `trendDimJoinSql()` 을 FROM 에 안 붙이면 `d` 별칭이
// 없어 런타임 42P01 이다. 타입으로는 못 막으므로 소스로 고정한다.
/**
 * `name(...)` **호출**의 최상위 인자 목록을 괄호·따옴표·백틱 균형으로 뽑는다.
 * 선언부(`function name(`)는 건너뛴다. 정규식으로는 중첩 괄호에서 잘린다.
 */
function splitCalls(src: string, name: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    const args: string[] = [];
    let cur = "";
    let quote: string | null = null;
    for (; i < src.length && depth > 0; i += 1) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") { cur += ch + src[i + 1]; i += 1; continue; }
        if (ch === quote) quote = null;
        cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      if (ch === "," && depth === 1) { args.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    // 인자 사이의 `//` 주석 줄을 걷어낸다 — 안 걷으면 주석이 인자 텍스트에 섞인다.
    out.push(
      args.map((a) =>
        a.split("\n").map((l) => l.trim()).filter((l) => !l.startsWith("//")).join(" ").trim(),
      ),
    );
  }
  return out;
}

describe("dim 조인 조각과 caJoined 는 같은 호출부에서 함께 쓴다", () => {
  const AGG = read("lib/db/repositories/scope-aggregates.ts");

  // 5f5b84e 차단 결함의 회귀 가드 — 조인 조각과 "조인했다" 는 **한 객체**에서 온다.
  it("`caJoined`·`svJoined` 는 `trendMirrorJoins()` 한 곳에서만 온다", () => {
    const users = [...AGG.matchAll(/caJoined: ([^,\n]+)/g)].map((m) => m[1].trim());
    expect(users).toContain("trendMirrorJoins().joined");
    // `anchorAxisKnownEnabled()` 만 보고 켜면 조인 없는 문장이 `sv` 를 참조한다.
    expect(users).not.toContain("anchorAxisKnownEnabled()");
    expect(AGG).toContain("sql`${anchorJoinSql(sql.raw(\"a.job_id\"))}${mirrorJoins.join}`");
    expect(AGG).toContain("mirrorJoins.joined,\n    mirrorJoins.joined,");
  });

  it("`sv` 술어는 `svJoined` 가 참일 때만 나온다", () => {
    expect(AGG).toContain("if (caJoined && svJoined) {");
  });

  // ⚠️ 위 가드는 **이름 인자(`caJoined:`)만** 훑는다. `trendWindowFloor` 은 **위치 인자**로
  //    받으므로 `:4717`·`:8287` 의 `anchorOn` 은 그 정규식 밖이었다(2026-09-20 2차 검증
  //    §6-2). 지금은 `svJoined` 기본값이 막고 있지만, 가드 방식이 바뀌면 같은 사각이
  //    다시 열린다 — 위치 인자 호출도 전수 열거한다.
  it("`trendWindowFloor` 의 **위치 인자** 호출을 전수 확인한다", () => {
    // ⚠️ `[^)]*` 로는 못 센다 — `sql.raw("a.job_id")` 의 닫는 괄호에서 잘려 4인자 호출이
    //    2인자로 보인다(이 테스트를 쓰다 실제로 겪었다). **괄호 균형**으로 훑는다.
    const calls = splitCalls(AGG, "trendWindowFloor");
    expect(calls.length, "호출이 하나도 안 잡히면 정규식이 썩은 것이다").toBeGreaterThanOrEqual(4);
    for (const args of calls) {
      // 3번째 = caJoined, 4번째 = svJoined.
      const [, , caJoined, svJoined, windowDays] = args;
      // 바닥 일수를 넘기는 호출은 **격자와 같은 상한**을 써야 한다(상수 직접 기입 금지).
      if (windowDays !== undefined) {
        // 2026-09-20(검증 W2): 격자는 **주 버킷에만** 얹히므로 단위를 넘기는 판본도
        // 허용한다. 통합 B1 로 공용 바닥 빌더(`weeklyTopNTrendFloor`)가 생겨 그 안에서는
        // 지역 변수 `days` 로 넘어온다 — 그 변수의 출처는 바로 아래 describe 가 본다.
        // 여기서 막는 것은 **상수 직접 기입**이다(`120`·`180` 같은 리터럴).
        expect(windowDays, `windowDays=${windowDays}`).toMatch(
          /^(trendFloorDays\((unit)?\)|days)$/,
        );
      }
      // 리터럴 `false` 는 "조인 안 했다" 를 **명시**한 것이라 안전하다(격자 바닥만
      // 넓히는 5인자 호출이 그 형태다). 나머지는 한 객체에서 와야 한다.
      if (svJoined !== undefined && svJoined !== "false") {
        // 넷을 다 넘기면 **둘 다** 한 객체에서 와야 한다.
        expect(caJoined, `caJoined=${caJoined}`).toMatch(/mirrorJoins\.joined|trendMirrorJoins\(\)\.joined/);
        expect(svJoined, `svJoined=${svJoined}`).toMatch(/mirrorJoins\.joined|trendMirrorJoins\(\)\.joined/);
      } else if (caJoined !== undefined) {
        // 셋만 넘기는 호출은 `sv` 를 절대 방출하면 안 된다 — 기본값이 유일한 방벽이다.
        expect(AGG, "svJoined 기본값이 false 여야 셋짜리 호출이 안전하다").toContain("svJoined = false,");
      }
    }
  });

  // 8c9b3e7 원형의 세 분기(sv 조인 판본 / `ca` 직접 AND / semi-join)가 다 있어야 한다.
  // `if (caJoined)` 를 빼면 인용 추이 두 문장이 semi-join 으로 떨어져 **main 보다 느려진다**
  // (2026-09-20 2차 검증 P1-SAME=false).
  it("`ca` 직접 AND 분기가 남아 있다 (8c9b3e7 원형)", () => {
    const at = AGG.indexOf("function trendWindowFloor(");
    const body = AGG.slice(at, AGG.indexOf("\n}\n", at));
    expect(body).toContain("if (caJoined && svJoined) {");
    expect(body).toContain("if (caJoined) return sql.join(preds, sql` AND `);");
    expect(body).toContain("const clause = anchorJobIdIn(jobIdCol, preds);");
    // 순서도 고정 — semi-join 이 직접 AND 앞에 오면 드리프트가 되돌아온다.
    expect(body.indexOf("if (caJoined) return")).toBeLessThan(body.indexOf("anchorJobIdIn("));
  });

  it("조인 조각은 격자·축이 꺼지면 **빈 조각**이다 (키 off 바이트 동일)", () => {
    const at = AGG.indexOf("export function trendDimJoinSql(");
    const body = AGG.slice(at, AGG.indexOf("\n}\n", at));
    expect(body).toContain("if (!trendGridKnownEnabled() || !anchorAxisKnownEnabled()) return sql``;");
    // 객체 판본도 같은 판정을 쓴다.
    expect(AGG).toContain("const joined = trendGridKnownEnabled() && anchorAxisKnownEnabled();");
  });

  it("semi-join 판본은 **남아 있다** — `ca` 를 안 조인하는 호출부용", () => {
    expect(AGG).toContain("function trendDimScopedJobIds(");
    expect(AGG).toContain("WITH dim_small AS MATERIALIZED (");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 통합 B1 — 격자에 갇히는 원천은 `windowDays` 를 **반드시** 넘긴다
// ════════════════════════════════════════════════════════════════════════════
//
// 종전 가드는 "넘기면 상수 직접 기입 금지" 까지만 봤다. **안 넘기는** 호출부가 사각이었고
// 그 사각이 B1 이었다(주별 Top-N 두 리더가 기본값 120 에 남아 자리보다 값이 좁았다).
describe("격자에 갇히는 리더의 창 바닥 (통합 B1)", () => {
  const AGG = read("lib/db/repositories/scope-aggregates.ts");

  it("주별 Top-N 두 리더는 공용 바닥 빌더를 쓴다 — 기본값 120 에 안 남는다", () => {
    // 둘 다 `weeklyTopNTrendFloor(onTrendGrid[, caJoined])` 를 경유한다.
    expect(AGG).toContain("weeklyTopNTrendFloor(onTrendGrid, anchorOn)");
    expect(AGG).toContain("const trendFloor = weeklyTopNTrendFloor(onTrendGrid);");
    // 그 빌더는 단위를 `trendFloorDays` 로 넘긴다(상수 직접 기입 금지).
    expect(AGG).toContain('trendFloorDays(onTrendGrid ? "week" : "day")');
    expect(AGG).toContain("trendWindowFloor(undefined, undefined, caJoined, false, days)");
  });

  it("두 리더가 `onTrendGrid` 를 **필수**로 받는다 — 리더가 추측하지 않는다", () => {
    for (const fn of ["readCitationDomainDayCounts", "readMentionBrandDayCounts"]) {
      const i = AGG.indexOf(`async function ${fn}(`);
      expect(i, `${fn} 을 못 찾았다`).toBeGreaterThan(0);
      const sig = AGG.slice(i, AGG.indexOf("): Promise<DayKeyCount[]> {", i));
      expect(sig, `${fn} 에 onTrendGrid 가 없다`).toContain("onTrendGrid: boolean,");
      expect(sig, `${fn} 의 onTrendGrid 에 기본값이 있다`).not.toContain("onTrendGrid: boolean =");
      expect(sig, `${fn} 의 onTrendGrid 가 선택 인자다`).not.toContain("onTrendGrid?:");
    }
  });

  it("세 호출부가 `true` 를 명시한다", () => {
    expect(AGG).toContain("readMentionBrandDayCounts(\n      filters, true,");
    expect(AGG).toContain("readCitationDomainDayCounts(filters, true, scopeProjectId)");
  });
});
