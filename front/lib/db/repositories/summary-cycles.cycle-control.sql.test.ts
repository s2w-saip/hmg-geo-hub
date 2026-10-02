import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { __testables, DEFAULT_COMPLETE_QUIET_HOURS } from "./summary-cycles";

// 회차 관제 SQL 의 **형태**를 고정한다(설계 v4.1 §2 · PR① T6 수용 기준 ①·②·③).
// 값 대조는 실 DB 드라이런(T16)의 몫이고, 여기서 잡는 것은 "지우면 조용히 틀리는 것"들이다:
//   · 미귀속 판정 술어(`NOT EXISTS summary_cycle_runs`)
//   · `AS MATERIALIZED` — **플랜 안정성** 고정용(성능 근거가 아니다: 힌트 12개를 전부
//     빼도 1,346 → 1,377 ms, +2.3%. T15 검증 2026-09-10)
//   · 날짜 캐스트가 전부 `AT TIME ZONE 'UTC'` 를 지난다(`::date` 단독 0건)
//   · 멱등 가드(ON CONFLICT DO NOTHING / IS DISTINCT FROM / status='open')

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q).sql;

const OPTS = {
  now: new Date("2026-09-10T00:00:00.000Z"),
  rootProjectId: "be28fe15-c743-4a88-abb8-182b25602812",
  recheckWindowDays: 3,
};

const ALL: Array<[string, string]> = [
  ["open", compile(__testables.cycleOpenSql(OPTS))],
  ["attribute", compile(__testables.cycleAttributeSql(OPTS))],
  ["counters", compile(__testables.cycleCountersSql())],
  ["close", compile(__testables.cycleCloseSql(OPTS))],
  ["fleet", compile(__testables.cycleFleetSql())],
];

describe("회차 판정 CTE", () => {
  const judge = compile(__testables.cycleJudgeCte());

  it("열기·귀속 후보는 summary_cycle_runs 에 없는 run 뿐이다 (§2-3 규칙 0)", () => {
    expect(judge).toContain("NOT EXISTS (SELECT 1 FROM summary_cycle_runs cr WHERE cr.run_id = r.run_id)");
  });

  it("알려진 anchor 열 = 원장 ∪ 미귀속 run 의 scope anchor — scope_runs 전량이 아니다", () => {
    // 이 술어가 무너지면 운영자가 다른 회차로 선언한 scope anchor 가 유령 회차를 연다.
    const known = judge.slice(judge.indexOf("known AS"), judge.indexOf("derived AS"));
    expect(known).toContain("FROM cyc");
    expect(known).toContain("FROM scoped");
    expect(known).not.toContain("scope_runs");
  });

  it("모든 판정 CTE 가 MATERIALIZED 다 (플랜 안정성 — 성능 주장이 아니다)", () => {
    // 왜 고정하는가: 데이터 분포가 바뀌어도 플래너가 같은 모양을 고르게 하려는 것이다.
    // 성능 이득은 크지 않다 — 힌트를 전부 빼도 +2.3%(T15 검증 2026-09-10).
    // 진짜 위험은 힌트 유무가 아니라 **단일 참조 CTE + LATERAL** 조합이다
    // (그 형태에서 25,594행 × 재평가로 50 s 가 나온 1회용 probe 실측이 있다).
    // 여기 CTE 들은 대부분 2회 이상 참조라 PG12+ 가 애초에 인라인하지 않는다.
    for (const name of ["cyc", "unatt", "scoped", "known", "derived", "attr", "pick", "new_anchor", "pickmem"]) {
      expect(judge).toContain(`${name} AS MATERIALIZED (`);
    }
  });

  it("귀속은 scope anchor 우선, NULL 이면 `≤ started_at` 최대 anchor (§2-3 규칙 1·2)", () => {
    const scoped = judge.slice(judge.indexOf("scoped AS"), judge.indexOf("known AS"));
    expect(scoped).toContain("u.cycle_anchor_at IS NOT NULL");
    expect(scoped).toContain("'scope'");
    const derived = judge.slice(judge.indexOf("derived AS"), judge.indexOf("attr AS"));
    expect(derived).toContain("k.anchor <= u.started_at");
    expect(derived).toContain("max(k.anchor)");
    expect(derived).toContain("u.cycle_anchor_at IS NULL");
    // anchor 를 못 찾은 run 은 attr 에 아예 없다 = 미귀속.
    expect(derived).toContain("d.anchor IS NOT NULL");
  });
});

describe("D1 — 열기와 귀속이 같은 상한을 본다 (T16 검증)", () => {
  const judge = compile(__testables.cycleJudgeCte({ maxAttributions: 7 }));

  it("상한은 `attr`(귀속 가능한 run)에 걸린다 — `unatt` 가 아니다", () => {
    // unatt 에 걸면 가장 오래된 run(= 첫 anchor 이전, 실측 24,299건)이 상한을 다 먹고
    // 정작 귀속돼야 할 최근 run 이 영영 못 들어온다.
    const pick = judge.slice(judge.indexOf("pick AS"), judge.indexOf("new_anchor AS"));
    expect(pick).toContain("FROM attr a");
    expect(pick).toContain("ORDER BY a.started_at NULLS FIRST");
    expect(pick).toContain("LIMIT");
    const unatt = judge.slice(judge.indexOf("unatt AS"), judge.indexOf("scoped AS"));
    expect(unatt).not.toContain("LIMIT");
  });

  it("열릴 회차는 `pick` 에서 유도된다 — 상한 밖 anchor 는 열리지 않는다", () => {
    const na = judge.slice(judge.indexOf("new_anchor AS"), judge.indexOf("pickmem AS"));
    expect(na).toContain("FROM pick p");
    expect(na).not.toContain("FROM unatt");
  });

  it("귀속 문장은 자체 LIMIT 을 갖지 않는다 (상한이 두 벌이면 다시 어긋난다)", () => {
    const attach = compile(__testables.cycleAttributeSql({ ...OPTS, maxAttributions: 7 }));
    const body = attach.slice(attach.indexOf("bind AS"));
    expect(body).not.toContain("LIMIT");
    expect(body).toContain("FROM pick p");
  });

  it("상한 값이 바인드로 나간다", () => {
    const params = dialect.sqlToQuery(__testables.cycleOpenSql({ ...OPTS, maxAttributions: 7 })).params;
    expect(params).toContain(7);
  });
});

describe("날짜 캐스트 — `::date` 단독 0건 (§2-5)", () => {
  // 규칙의 요점은 "세션 TZ 를 타는 `::date` 단독 캐스트 금지"다. 2026-09-28 부터 글로벌
  // 회차 주는 **명시적 KST**(`AT TIME ZONE 'Asia/Seoul'`) 절단이다 — 이것도 세션 TZ 무관이라
  // 규칙을 지킨다. 허용 존은 이 둘뿐이다(다른 존이 끼면 여기서 죽는다).
  it("모든 ::date 캐스트가 명시 존(AT TIME ZONE 'UTC' | 'Asia/Seoul')을 지난다", () => {
    for (const [name, text] of ALL) {
      const hits = [...text.matchAll(/::date\b/g)];
      for (const m of hits) {
        const before = text.slice(Math.max(0, m.index - 60), m.index);
        expect(
          before.includes("AT TIME ZONE 'UTC'") || before.includes("AT TIME ZONE 'Asia/Seoul'"),
          `${name}: ${JSON.stringify(text.slice(Math.max(0, m.index - 60), m.index + 6))}`,
        ).toBe(true);
      }
    }
  });

  it("주 키는 date_trunc('week', (anchor AT TIME ZONE 'UTC'))::date 형태다", () => {
    const week = compile(sql`SELECT ${__testables.cycleWeekExpr(sql`x.anchor`)}`);
    expect(week).toContain("date_trunc('week', (x.anchor AT TIME ZONE 'UTC'))");
    expect(week).toContain("::date");
  });

  // 2026-09-28 — 글로벌만 KST 월요일. 판정은 `surfaceExpr` 와 같은 루트 비교다.
  it("열기 문장의 주 키는 표면별이다 — 루트 = KST, 그 외 = UTC", () => {
    const open = ALL[0][1];
    const ins = open.slice(open.indexOf("INSERT INTO summary_cycles"));
    expect(ins).toMatch(
      /CASE WHEN na\.project_id = \$\d+::uuid\s+THEN \(date_trunc\('week', \(na\.anchor AT TIME ZONE 'Asia\/Seoul'\)\)\)::date\s+ELSE \(date_trunc\('week', \(na\.anchor AT TIME ZONE 'UTC'\)\)\)::date\s+END/,
    );
    const params = dialect.sqlToQuery(__testables.cycleOpenSql(OPTS)).params;
    expect(params).toContain(OPTS.rootProjectId);
  });

  it("루트 미지정이면 KST 팔이 없다 — 전부 UTC(종전 문장)", () => {
    const open = compile(__testables.cycleOpenSql({ ...OPTS, rootProjectId: null }));
    expect(open).not.toContain("Asia/Seoul");
    expect(open).toContain("date_trunc('week', (na.anchor AT TIME ZONE 'UTC'))");
  });
});

describe("멱등 가드 — 재실행이 0행을 쓴다", () => {
  it("열기: ON CONFLICT (project_id, cycle_anchor_at) DO NOTHING", () => {
    expect(ALL[0][1]).toContain("ON CONFLICT (project_id, cycle_anchor_at) DO NOTHING");
  });

  it("귀속: ON CONFLICT (run_id) DO NOTHING — 한 run 은 한 회차에만", () => {
    expect(ALL[1][1]).toContain("ON CONFLICT (run_id) DO NOTHING");
  });

  it("카운터: 값이 실제로 달라졌을 때만 쓴다(ROW … IS DISTINCT FROM ROW …)", () => {
    expect(ALL[2][1]).toMatch(/ROW\([\s\S]*?\)\s*IS DISTINCT FROM\s*ROW\(/);
  });

  it("카운터·종결은 status='open' 회차만 만진다 (P6: 종결 회차 모수 동결)", () => {
    expect(ALL[2][1]).toContain("c.status = 'open'");
    expect(ALL[3][1]).toContain("allc.status = 'open'");
  });

  it("fleet_visible: 값이 바뀔 때만 쓴다", () => {
    expect(ALL[4][1]).toContain("c.fleet_visible IS DISTINCT FROM r.want");
  });
});

describe("종결 사유 (§2-1 (a)(b)(c))", () => {
  const text = ALL[3][1];

  it("세 사유가 설계 순서대로 있다", () => {
    const a = text.indexOf("'next_anchor'");
    const b = text.indexOf("'complete'");
    const c = text.indexOf("'recheck_window'");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("재확인 창 컷오프는 ISO 문자열 + 명시 캐스트다 (Date 바인딩 회귀 방지)", () => {
    // 2026-08-29 회귀: JS Date 를 raw sql 파라미터로 넘겨 `invalid input syntax` 로 죽었다.
    expect(text).toContain("::timestamptz");
    const params = dialect.sqlToQuery(__testables.cycleCloseSql(OPTS)).params;
    expect(params).toContain("2026-09-07T00:00:00.000Z"); // now − 3일
  });

  it("회차 run 이 하나도 없으면 recheck_window 로 닫지 않는다", () => {
    expect(text).toContain("EXISTS (SELECT 1 FROM allmem m");
  });

  it("(a) next_anchor 도 멤버 존재를 요구한다 — 세 팔의 술어 모양이 같다 (D1)", () => {
    // 종전에는 (a) 만 순수 anchor 비교였다. 그래서 상한을 넘긴 틱에서 멤버 0 회차가
    // expected_units = NULL 인 채 즉시 닫히고, 뒤늦은 run 이 전부 late 가 되며
    // 카운터가 영원히 NULL 로 동결되는 경로가 있었다.
    const arm = text.slice(text.indexOf("CASE"), text.indexOf("'next_anchor'"));
    expect(arm).toContain("EXISTS (SELECT 1 FROM allmem m");
  });

  it("(b) 100% 에는 정온 가드가 붙는다 — 마지막 run 이 조용해야 닫는다", () => {
    // 가드가 빠지면 첫 run 이 자기 셀을 채운 순간 회차가 닫히고 같은 디스패치의
    // 나머지가 전부 late + stale 로 들어온다(글로벌 8/31 실측: 216 run 이 39.9시간 분산).
    const complete = text.slice(text.indexOf("COALESCE(allc.completed"), text.indexOf("'complete'"));
    expect(complete).toContain("NOT EXISTS");
    expect(complete).toContain("m.started_at IS NULL OR m.started_at >=");
    // 정온 컷오프는 now − CYCLE_COMPLETE_QUIET_HOURS 로 바인드된다.
    const params = dialect.sqlToQuery(__testables.cycleCloseSql(OPTS)).params;
    const quiet = new Date(OPTS.now.getTime() - DEFAULT_COMPLETE_QUIET_HOURS * 3_600_000);
    expect(params).toContain(quiet.toISOString());
  });

  it("(a) next_anchor·(c) recheck_window 에는 정온 가드를 걸지 않는다", () => {
    // 둘은 그 자체가 이미 \"더 안 온다\" 의 증거다.
    const nextAnchor = text.slice(text.indexOf("CASE"), text.indexOf("'next_anchor'"));
    expect(nextAnchor).not.toContain("started_at");
    const quietIso = new Date(OPTS.now.getTime() - DEFAULT_COMPLETE_QUIET_HOURS * 3_600_000).toISOString();
    const recheck = text.slice(text.indexOf("'complete'"), text.indexOf("'recheck_window'"));
    expect(recheck).not.toContain(quietIso);
  });

  it("정온 창은 36시간이다 (관측 최대 도착 간격 29.1h 를 덮고, (c) 3일 아래)", () => {
    // 값을 바꿀 때 이 테스트가 같이 깨져야 한다 — 근거 수치는 리포지터리 주석의 표.
    // 처음 넣은 6h 는 실측(글로벌 19.2h · 웹사이트 29.1h)에 뚫렸다.
    expect(DEFAULT_COMPLETE_QUIET_HOURS).toBe(36);
    // 상한: (c) recheck_window 3일(72h)을 넘으면 (b) 가 영원히 (c) 보다 늦어 죽는다.
    expect(DEFAULT_COMPLETE_QUIET_HOURS).toBeLessThan(3 * 24);
    // 하한: 관측된 최대 도착 간격 29.1h 를 덮어야 한다.
    expect(DEFAULT_COMPLETE_QUIET_HOURS).toBeGreaterThan(29.1);
  });
});

describe("표면 판정", () => {
  it("루트가 주어지면 global 이 website 보다 먼저 걸린다", () => {
    const t = compile(sql`SELECT ${__testables.surfaceExpr(sql`p.id`, "11111111-1111-1111-1111-111111111111")}`);
    expect(t.indexOf("'global'")).toBeLessThan(t.indexOf("'website'"));
    expect(t).toContain("website_sites");
  });

  it("루트가 없으면 global 분기 자체가 없다 (코어는 테넌트 상수를 갖지 않는다)", () => {
    const t = compile(sql`SELECT ${__testables.surfaceExpr(sql`p.id`, null)}`);
    expect(t).not.toContain("'global'");
    expect(t).toContain("'project'");
  });

  it("원장의 회차는 저장된 surface 를 쓴다(재유도하지 않는다)", () => {
    const judge = compile(__testables.cycleJudgeCte());
    const cyc = judge.slice(judge.indexOf("cyc AS"), judge.indexOf("unatt AS"));
    expect(cyc).toContain("c0.surface");
    expect(cyc).not.toContain("website_sites");
  });
});

describe("P5 — 미러는 읽기만 한다", () => {
  it("어떤 문장도 미러 3표에 쓰지 않는다", () => {
    for (const [name, text] of ALL) {
      for (const t of ["scope_runs", "scope_answers", "scope_mentions", "scope_citations"]) {
        expect(text, name).not.toMatch(new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${t}\\b`));
      }
    }
  });

  it("쓰기 대상은 summary_cycles·summary_cycle_runs 뿐이다", () => {
    const targets = new Set<string>();
    for (const [, text] of ALL) {
      for (const m of text.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)) {
        targets.add(m[1]);
      }
    }
    expect([...targets].sort()).toEqual(["summary_cycle_runs", "summary_cycles"]);
  });

  it("view_anchor_at 은 어디서도 SET 하지 않는다 (§7-1 스왑 tx 전용)", () => {
    for (const [name, text] of ALL) {
      expect(text, name).not.toMatch(/view_anchor_at\s*=/);
    }
  });
});
