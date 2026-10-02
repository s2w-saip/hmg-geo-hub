import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  answerWhere,
  detailAnswerWhere,
  snapshotRunFilter,
  __testables as agg,
} from "./scope-aggregates";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { sql } from "drizzle-orm";
import {
  setAnchorAxisForTests,
  resetAnchorAxisForTests,
} from "@/lib/period/anchor-axis-state";
import {
  setTrendGridForTests,
  resetTrendGridForTests,
} from "@/lib/period/trend-grid-flag";
import {
  SYNC_PROBED_COLUMNS,
  setColumnAvailabilityForTests,
  resetColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import BASELINE from "./__fixtures__/grid-off-8c9b3e7.json";

// ════════════════════════════════════════════════════════════════════════════
// PR④ — 미러 **추이**가 사실표와 같은 모수 술어를 거는가 (`X.trendGrid`)
// ════════════════════════════════════════════════════════════════════════════
//
// 고치는 결함: 추이 분기(`allRuns`)에만 루트 지역 스코핑 2종이 빠져 있었다. 그 결과
// 2026-08-20 사고 데이터(한국어 프롬프트의 비-KR 측정)가 과거 점의 모수에 실렸다 —
// 미러 실측 08-03 3,516셀 · 08-17 2,645셀(`verify/out/G1c-…csv` 의 `3-tag-split`).
//
// 여기서 고정하는 것 넷:
//   ① 켜면 추이 분기에 술어 셋(한국어·시장 태그·함대 게이트)이 붙는다.
//   ② **끄면 바이트 동일** — 78건 스냅샷과 같은 성질을 이 파일에서도 직접 단언한다.
//   ③ **스냅샷·누적은 안 바뀐다**(켜도). 그쪽은 이미 같은 술어를 갖고 있거나 범위 밖이다.
//   ④ 웹사이트·프로젝트 표면은 안 바뀐다(지역 스코핑은 루트 전용 개념).
//
// ⚠️ PREPARE 가 이름 해석만 보는 것과 달리, 여기서는 **어느 컬럼을 고르는지**를 본다
//    (다른 빌더의 교훈): `sp.regions`·`sp.is_korean`·`summary_cycles.fleet_visible`.

const dialect = new PgDialect();
const compile = (q: SQL) => {
  const { sql: text, params } = dialect.sqlToQuery(q);
  return { text, params };
};

const ROOT_CTX = undefined;
const PROJECT_CTX = ["11111111-1111-4111-8111-111111111111"];

const NONE: StandardFilters = {};
const RANGE: StandardFilters = { dateFrom: "2026-08-20", dateTo: "2026-09-04" };

/**
 * 프로덕션의 **함대 게이트와 같은 텍스트**(`scope-answer-anchors.ts::anchorLedgerServableSql`).
 * 테스트 세터의 기본값은 `true` 라, 그대로 두면 semi-join 이 `WHERE true` 가 되어
 * "게이트가 붙었다" 를 텍스트로 확인할 수 없다 — 축 on 덤프 매니페스트가 같은 이유로
 * 같은 조각을 주입한다(`scripts/db/axis-on-sql-manifest.ts::fleetFrag`).
 */
const fleetFrag = sql`(ca.surface = 'project' OR EXISTS (
    SELECT 1 FROM summary_cycles sc
     WHERE sc.cycle_id = ca.cycle_id
       AND sc.fleet_visible
       AND sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()
       AND sc.active_generation_id IS NOT NULL
  ))`;

/** 축 on + 컬럼 프로브 true + 실제 함대 조각 — 프로덕션 프리뷰와 같은 상태. */
function fixAxisOn(): void {
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, true);
  setAnchorAxisForTests(true, undefined, undefined, { ca: fleetFrag, ca2: fleetFrag });
}

beforeEach(() => {
  resetTrendGridForTests();
  resetAnchorAxisForTests();
  resetColumnAvailabilityForTests();
  fixAxisOn();
});

afterEach(() => {
  resetTrendGridForTests();
  resetAnchorAxisForTests();
  resetColumnAvailabilityForTests();
});

/** 켠 판본과 끈 판본을 같은 입력으로 한 번씩 만든다. */
function onOff(build: () => SQL): { on: ReturnType<typeof compile>; off: ReturnType<typeof compile> } {
  setTrendGridForTests(false);
  const off = compile(build());
  setTrendGridForTests(true);
  const on = compile(build());
  return { on, off };
}

describe("answerWhere(allRuns) — 루트 추이", () => {
  it("켜면 한국어 비-KR 제외가 붙는다 — **dim 스냅샷**이 1순위다", () => {
    const { on, off } = onOff(() => answerWhere(NONE, ROOT_CTX, { allRuns: true }));
    expect(off.text).not.toContain("is_korean");
    // dim 경로 — 회차가 굳힌 값으로 판정한다.
    expect(on.text).toContain("d.is_korean = 1");
    expect(on.text).toContain("a2.region <> 'KR'");
    // 현재값 경로는 dim 행이 **없을 때만** 타는 ELSE 가지에 남는다.
    expect(on.text).toContain("SELECT sp.prompt_id FROM scope_prompts sp WHERE sp.is_korean");
  });

  it("켜면 시장 태그 제외가 붙는다 (scope #474) — dim 의 `regions` 가 1순위", () => {
    const { on, off } = onOff(() => answerWhere(NONE, ROOT_CTX, { allRuns: true }));
    expect(off.text).not.toContain("sp.regions");
    // dim 경로 — 스냅샷 배열로 판정.
    expect(on.text).toContain("a2.region = ANY(d.regions)");
    expect(on.text).toContain("cardinality(d.regions) = 0");
    // 현재값 폴백 경로.
    expect(on.text).toContain("cardinality(sp.regions) > 0");
    expect(on.text).toContain("unnest(sp.regions)");
    // **비상관**이어야 한다(2026-08-27 성능 수정의 전제) — 바깥 별칭 `a.` 를 안 본다.
    expect(on.text).not.toContain("a.region = ANY(sp.regions)");
    expect(on.text).not.toContain("pd.prompt_id = a.prompt_id");
  });

  // 메인 결정(2026-09-20): 과거 회차의 판정은 **그 회차를 생성한 시점의 정의**다.
  // 미러 실측으로 확정된 드리프트(08-03 176셀 · 08-17 180셀, 전부 EG 태그)가 이 경로로 사라진다.
  // 2026-09-20 3차 — **성능 재작성**. 초판은 셀마다 `summary_prompt_dim` 파티션 Append 를
  // 돌았다(미러 EXPLAIN 실측: 13자리 창 4,324ms · shared hit 2,277,858 · Nested Loop
  // 209,480회, 플래너 추정 rows=80 대 실제 209,480). dim 을 **먼저 작게 만들어**
  // 인덱스 접근 경로를 없애면 중첩 루프가 구조적으로 비싸져 플래너가 해시를 고른다.
  it("dim 을 **사전 집계**한 뒤 등치 해시 조인한다 (LATERAL·상관·파티션 Append 금지)", () => {
    setTrendGridForTests(true);
    const t = compile(answerWhere(NONE, ROOT_CTX, { allRuns: true })).text;
    // ① 사전 집계 — 루트 회차 × 활성 세대 dim 을 한 번만 만든다.
    expect(t).toContain("WITH dim_small AS MATERIALIZED (");
    expect(t).toContain("FROM summary_cycles sc");
    // 파티션 프루닝 키와 활성 세대는 **CTE 안**에서 건다.
    expect(t).toContain("pd.cycle_week = sc.cycle_week");
    expect(t).toContain("pd.generation_id = sc.active_generation_id");
    // ② 답변 쪽과는 (cycle_id, prompt_id) **등치**로만 만난다.
    expect(t).toContain("LEFT JOIN dim_small d ON d.cycle_id = ca2.cycle_id");
    expect(t).toContain("d.prompt_id = a2.prompt_id");
    // 인덱스 있는 파티션 표를 셀마다 찌르는 형태가 남아 있으면 안 된다.
    expect(t).not.toContain("LEFT JOIN summary_prompt_dim");
    expect(t).not.toContain("LATERAL");
    // 두 경로가 **한 식 안에서** 갈린다(스캔 한 번).
    expect(t).toContain("CASE WHEN d.prompt_id IS NOT NULL THEN");
  });

  // 좁힘은 **바깥 창과 같은 바닥일 때만**. 다른 값을 넣으면 안쪽이 더 좁아져 셀이 빠진다.
  it("안쪽 `round_date` 바닥은 바깥 창을 알 때만 붙는다", () => {
    setTrendGridForTests(true);
    // 기간 없음 + 창 미고지 → 바닥 없음(전체 이력).
    expect(compile(answerWhere(NONE, ROOT_CTX, { allRuns: true })).text)
      .not.toContain("ca2.round_date >=");
    // 기간 있음 → 그 기간의 `dateFrom` 이 바닥이다(앵커 축의 기간은 round_date 다).
    const withRange = compile(answerWhere(RANGE, ROOT_CTX, { allRuns: true }));
    expect(withRange.text).toContain("ca2.round_date >=");
    expect(withRange.params).toContain("2026-08-20");
    // 호출부가 `trendWindowFloor()` 를 얹는다고 고지하면 같은 바닥을 쓴다.
    const declared = compile(
      answerWhere(NONE, ROOT_CTX, { allRuns: true, trendRoundFloor: true }),
    ).text;
    // ⚠️ 격자가 켜진 상태이므로 바닥 일수는 **격자 상한(180)** 이다 — 바깥
    //    `trendWindowFloor` 과 같은 값이어야 셀이 안 샌다(`trend-grid-floor.test.ts`).
    expect(declared).toContain("ca2.round_date >= hmg_anchor_today() - 180");
  });

  it("켜면 함대 대표 게이트가 붙는다 (원장 fleet_visible)", () => {
    const { on, off } = onOff(() => answerWhere(NONE, ROOT_CTX, { allRuns: true }));
    expect(off.text).not.toContain("fleet_visible");
    expect(on.text).toContain("sc.fleet_visible");
    expect(on.text).toContain("scope_answer_cycle_anchors");
  });

  // `anchorPeriodPreds` 가 이미 함대 게이트를 건다 — 같은 술어를 두 번 싣지 않는다.
  it("기간이 걸린 축 on 경로에서는 함대 게이트를 **중복으로** 넣지 않는다", () => {
    setTrendGridForTests(true);
    const withRange = compile(answerWhere(RANGE, ROOT_CTX, { allRuns: true }));
    expect(withRange.text.match(/sc\.fleet_visible/g) ?? []).toHaveLength(1);
  });

  it("`in_full_cycle`(full-cycle 게이트)은 추이에 **안 붙는다** (D2)", () => {
    setTrendGridForTests(true);
    const on = compile(answerWhere(NONE, ROOT_CTX, { allRuns: true }));
    // 미러 쪽 full-cycle 게이트의 지문 = expected/window 셀 카운트 CTE.
    expect(on.text).not.toContain("_fc_base");
  });

  // 켜면 바깥 현재값 카탈로그 게이트가 **빠진다** — dim 의 `in_root_catalog` 가 쥔다.
  // 둘 다 걸면 교집합이 되어 "카탈로그에서 빠진 프롬프트" 가 소급 제외된다(같은 드리프트).
  it("카탈로그 게이트는 dim 이 쥔다 — 바깥에 두 벌로 걸지 않는다", () => {
    const { on, off } = onOff(() => answerWhere(NONE, ROOT_CTX, { allRuns: true }));
    const outer = /AND a\.prompt_id IN \(\s*SELECT scope_prompt_id FROM prompts/g;
    expect(off.text.match(outer) ?? [], "off 는 종전대로 바깥 게이트 하나").toHaveLength(1);
    expect(on.text.match(outer) ?? [], "on 은 바깥 게이트가 없다").toHaveLength(0);
    // dim 경로와 폴백 경로가 각자 카탈로그를 본다.
    expect(on.text).toContain("d.in_root_catalog = 1");
    expect(on.text).toContain("a2.prompt_id IN (");
  });

  it("**기본 엔진 범위는 안 건다** — 사실표가 안 걸기 때문이다", () => {
    setTrendGridForTests(true);
    const on = compile(answerWhere(NONE, ROOT_CTX, { allRuns: true }));
    expect(on.text).not.toContain("is_default_engine");
  });
});

describe("끄면 바이트 동일", () => {
  const cases: Array<[string, () => SQL]> = [
    ["루트 추이(기간 없음)", () => answerWhere(NONE, ROOT_CTX, { allRuns: true })],
    ["루트 추이(기간)", () => answerWhere(RANGE, ROOT_CTX, { allRuns: true })],
    ["루트 스냅샷", () => answerWhere(NONE, ROOT_CTX, {})],
    // ⚠️ `allRuns: true` 는 **언제나** 추이다(`resolvePeriodMode` 가 `allRuns` 를 먼저
    //    본다) — 그래서 누적 케이스는 `allRuns` 없이 만든다.
    ["루트 누적", () => answerWhere({ ...RANGE, cumulative: true }, ROOT_CTX, {})],
    ["상세 추이", () => detailAnswerWhere(NONE, ROOT_CTX, { allRuns: true })],
    ["상세 스냅샷", () => detailAnswerWhere(NONE, ROOT_CTX, {})],
    ["bare 누적", () => snapshotRunFilter(undefined, { ...RANGE, cumulative: true })],
    // ⚠️ 창 바닥 — 2026-09-20 2차 검증이 잡은 드리프트 자리. 위 일곱은 전부
    //    `answerWhere`/`detailAnswerWhere`/`snapshotRunFilter` 라 `trendWindowFloor` 의
    //    분기 손실을 한 건도 못 봤다(P1-SAME=false 가 기준선 밖에서 났다).
    //    `caJoined=true · svJoined=false` = 인용 추이 두 문장이 쓰는 조합이고,
    //    8c9b3e7 에서는 **직접 AND** 다. semi-join 으로 떨어지면 여기서 깨진다.
    ["창 바닥(ca 조인됨)", () => agg.trendWindowFloor(undefined, undefined, true)],
    ["창 바닥(조인 없음)", () => agg.trendWindowFloor()],
  ];

  // ⚠️ 2026-09-20 — 종전 판본은 **같은 상태를 두 번 컴파일**해 비교했다. 항등식이라
  //    무엇을 바꿔도 통과한다(검증자 지적). 기준선을 `8c9b3e7` 시점 텍스트로 **박아** 둔다
  //    (`__fixtures__/grid-off-8c9b3e7.json` — 그 커밋의 빌더로 직접 뽑은 것).
  //
  //    그리고 이 PR 이 **격자 off · 축 on** 에서 바꾸는 것은 함대 게이트의
  //    `AND sc.hidden_reason IS NULL` **한 항뿐**이다(`1910e33` — 계열별 숨김 술어
  //    `anchorNotHiddenSql(family)` 로 대체한 의도된 변경). 그 한 항만 제거하면 기준선과
  //    **바이트 동일**해야 한다. 다른 글자가 하나라도 달라지면 여기서 깨진다.
  const HIDDEN_TERM = " AND sc.hidden_reason IS NULL";

  // ── hmg-geo PR #302(main e9a200d, 2026-09-28) 의 **의도된** 텍스트 변경 2종 ──────────
  //   ① ID 숨김 해제 — `HIDDEN_STANDARD_REGIONS = []` 라 숨김 국가 절과 그 바인드('ID')가 사라진다.
  //   ② 한국어 비-KR 제외 태그 우선 — `rootKoreanNonKrPred` 안에 "태그 없음 ∨ 태깅 이전"
  //      절이 붙는다(lib/scope/region-tagging.ts).
  // 기준선 파일은 8c9b3e7 시점의 **사실 기록**이라 고치지 않는다. 대신 이 두 변경만 양쪽에서
  // 정규화하고(바인드 번호는 ①로 당겨지므로 `$?` 로 지운다) 나머지는 여전히 바이트 대조한다.
  const TAG_FIRST_CLAUSE =
    /\s*AND \(\s*a\.measured_at IS NULL\s*OR a\.measured_at < '2026-08-19T00:00:00Z'::timestamptz\s*OR a\.prompt_id NOT IN \(\s*SELECT sp\.prompt_id FROM scope_prompts sp\s*WHERE sp\.prompt_id IS NOT NULL\s*AND sp\.regions IS NOT NULL AND cardinality\(sp\.regions\) > 0\s*\)\s*\)/g;
  const HIDDEN_REGION_CLAUSE = /(?: AND |\n\s*AND )?a\.region NOT IN \(\$\?\)/g;
  const deparam = (t: string) => t.replace(/\$\d+/g, "$?");
  const norm302 = (t: string) => deparam(t).replace(TAG_FIRST_CLAUSE, "").replace(HIDDEN_REGION_CLAUSE, "");

  it("격자 off · 축 on 이 8c9b3e7 기준선과 같다 — `hidden_reason` 한 항과 #302 의도 변경만 빼고", () => {
    for (const [label, build] of cases) {
      const base = BASELINE.cases[label];
      expect(base, `기준선에 '${label}' 이 없다`).toBeTruthy();
      setTrendGridForTests(false);
      const now = compile(build());
      expect(norm302(now.text), label).toBe(norm302(base.text.split(HIDDEN_TERM).join("")));
      expect(now.params, label).toEqual(base.params.filter((p) => p !== "ID"));
      // ①이 실제로 일어났다: 지금 문장에는 숨김 국가 절이 없다.
      expect(deparam(now.text), label).not.toMatch(HIDDEN_REGION_CLAUSE);
    }
  });

  it("기준선에서 사라진 것은 그 한 항이 전부다 (제거 전에는 달랐다)", () => {
    // 기준선에 그 항이 실제로 있었던 케이스에서만 의미가 있다 — 없으면 비교가 공허하다.
    const withTerm = cases.filter(([l]) => BASELINE.cases[l]?.text.includes(HIDDEN_TERM));
    expect(withTerm.length, "함대 게이트가 붙는 케이스가 하나는 있어야 한다").toBeGreaterThan(0);
    for (const [label, build] of withTerm) {
      setTrendGridForTests(false);
      expect(compile(build()).text, label).not.toBe(BASELINE.cases[label].text);
    }
  });

  // ⚠️ **스냅샷 경로에는 종전부터 지역 스코핑이 있다**(`snapshotAnswerIds` ·
  //    `rootFullCycleAnswerIds`). 그래서 "끄면 없다" 는 **추이 경로에만** 성립한다 —
  //    그 구분이 이 PR 의 내용 자체다(SA:972-978 의 "추이 분기만 빠져 있었다").
  it("추이 경로만 끄면 새 술어가 없다", () => {
    setTrendGridForTests(false);
    for (const [label, build] of [
      ["루트 추이(기간 없음)", () => answerWhere(NONE, ROOT_CTX, { allRuns: true })] as const,
      ["루트 추이(기간)", () => answerWhere(RANGE, ROOT_CTX, { allRuns: true })] as const,
      ["상세 추이", () => detailAnswerWhere(NONE, ROOT_CTX, { allRuns: true })] as const,
    ]) {
      const t = compile(build()).text;
      expect(t, label).not.toContain("is_korean");
      expect(t, label).not.toContain("sp.regions");
    }
  });

  it("기간 없는 추이에는 끄면 함대 게이트도 없다", () => {
    setTrendGridForTests(false);
    expect(compile(answerWhere(NONE, ROOT_CTX, { allRuns: true })).text)
      .not.toContain("fleet_visible");
    expect(compile(detailAnswerWhere(NONE, ROOT_CTX, { allRuns: true })).text)
      .not.toContain("fleet_visible");
  });
});

describe("경계 — 추이가 아닌 읽기·루트가 아닌 표면은 안 바뀐다", () => {
  it("스냅샷은 켜도 바이트 동일하다 (이미 같은 술어를 갖고 있다)", () => {
    const { on, off } = onOff(() => answerWhere(NONE, ROOT_CTX, {}));
    expect(on.text).toBe(off.text);
    expect(on.params).toEqual(off.params);
  });

  it("누적은 켜도 바이트 동일하다 (PR④ 범위 밖)", () => {
    const { on, off } = onOff(() => answerWhere({ ...RANGE, cumulative: true }, ROOT_CTX, {}));
    expect(on.text).toBe(off.text);
  });

  it("프로젝트·웹사이트 표면은 켜도 바이트 동일하다 (지역 스코핑은 루트 전용)", () => {
    for (const build of [
      () => answerWhere(NONE, PROJECT_CTX, { allRuns: true }),
      () => detailAnswerWhere(NONE, PROJECT_CTX, { allRuns: true }),
    ]) {
      const { on, off } = onOff(build);
      expect(on.text).toBe(off.text);
      expect(on.params).toEqual(off.params);
    }
  });

  it("bare 경로(`prefix=\"\"`)는 켜도 안 바뀐다 — 별칭이 없어 술어가 안 맞는다", () => {
    const { on, off } = onOff(() =>
      snapshotRunFilter(undefined, { ...RANGE, cumulative: true }),
    );
    expect(on.text).toBe(off.text);
  });
});

describe("detailAnswerWhere(allRuns) — KPI 탭 추이 3종이 공유하는 자리", () => {
  it("켜면 같은 술어 셋이 붙는다", () => {
    const { on, off } = onOff(() => detailAnswerWhere(NONE, ROOT_CTX, { allRuns: true }));
    expect(off.text).not.toContain("is_korean");
    expect(on.text).toContain("is_korean");
    expect(on.text).toContain("cardinality(sp.regions) > 0");
    expect(on.text).toContain("sc.fleet_visible");
  });

  // 두 계열(`answerWhere`·`detailAnswerWhere`)이 **같은 텍스트 조각**을 써야 한다 —
  // 복제하면 한쪽만 고치는 결함이 생긴다(이 파일 머리 주석의 "정의는 하나").
  it("두 계열이 같은 조각을 쓴다", () => {
    setTrendGridForTests(true);
    const a = compile(answerWhere(NONE, ROOT_CTX, { allRuns: true })).text;
    const b = compile(detailAnswerWhere(NONE, ROOT_CTX, { allRuns: true })).text;
    const korean = /NOT \(a2\.region <> 'KR' AND d\.is_korean = 1\)/;
    const ka = a.match(korean)?.[0];
    const kb = b.match(korean)?.[0];
    expect(ka).toBeTruthy();
    expect(kb).toBe(ka);
  });
});
