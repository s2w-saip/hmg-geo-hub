/**
 * 생성기 **컴파일 SQL 스냅샷** — 리팩터(T8 코어 추출)가 발행 SQL 을 바꾸지 않았음을 고정한다.
 *
 * 왜 이 형태인가: 두 생성기(`website-0904.ts`·`global-0831.ts`)는 import 즉시 `main()` 을
 * 도는 실행 스크립트라 빌더를 따로 가져올 수 없다. 그래서 **`getDb()` 를 가짜로 갈아
 * 끼우고 스크립트를 통째로 돌려**, 실제 실행 경로가 발행하는 문장을 순서대로 받아 적는다.
 * 리팩터 전에 이 파일로 md5 를 굳혀 두고, 리팩터 후 같은 값이 나오는지로 판정한다
 * (플랜 T8 수용 기준 ①).
 *
 * 판정 대상 = **실행되는 SQL**: `--` 주석 제거 + 공백 정규화 후의 문장 텍스트와 바인드
 * 파라미터. 주석·들여쓰기를 md5 에 넣으면 "코어로 옮기며 두 표면의 주석이 한 벌로
 * 합쳐진 것"만으로 게이트가 깨져, 실제 회귀와 구분이 안 된다. 원문(주석 포함) md5 도
 * 함께 기록해 두어 무엇이 바뀌었는지는 눈으로 볼 수 있게 한다.
 *
 * 고정값(픽스처) 갱신은 **의도적 변경일 때만**:
 *   UPDATE_SQL_SNAPSHOT=1 npx vitest run scripts/summary/generator-sql-snapshot.test.ts
 * 갱신하면 커밋 메시지·작업 로그에 "어느 문장이 왜 바뀌었는지" 를 남긴다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const FIXTURE = "scripts/summary/__snapshots__/generator-sql.json";
const UPDATE = process.env.UPDATE_SQL_SNAPSHOT === "1";

const dialect = new PgDialect();
/** `--` 줄 주석 제거 + 공백 정규화. 실행되는 SQL 의 동치 판정 기준. */
const stripComments = (s: string) => s.replace(/--[^\n]*/g, " ");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

type Captured = { sql: string; params: unknown[] };
const captured = vi.hoisted(() => ({ list: [] as Array<{ q: unknown }> }));

// ── 가짜 DB ─────────────────────────────────────────────────────────────────
// 문장을 받아 적고, 스크립트가 다음 단계로 갈 수 있을 만큼의 canned row 만 돌려준다.
const CYCLE_ID = "11111111-1111-4111-8111-111111111111";
const GEN_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_A = "44444444-4444-4444-8444-444444444444";
const RUN_B = "55555555-5555-4555-8555-555555555555";
const PROMPT_ID = "66666666-6666-4666-8666-666666666666";
const COMPLETED_UNITS = 7;

vi.mock("node:child_process", () => ({
  // GENERATOR_VERSION 이 git sha 를 물고 있어 그대로 두면 커밋마다 md5 가 바뀐다.
  execFileSync: () => "0000000\n",
}));

vi.mock("@/lib/db", () => {
  const respond = (q: unknown): unknown[] => {
    const text = new PgDialect().sqlToQuery(q as SQL).sql;
    captured.list.push({ q });
    if (text.includes("pg_attribute")) return [{ ok: 1 }];
    if (text.includes("FROM entity_registry")) {
      return [
        { entity_id: "ent-genesis", name: "Genesis" },
        { entity_id: "ent-hyundai", name: "Hyundai" },
        { entity_id: "ent-kia", name: "Kia" },
      ];
    }
    if (text.includes("DISTINCT owned_base_url AS base")) {
      return [{ base: "https://www.hyundai.com/kr/ko" }, { base: "https://www.kia.com/kr" }];
    }
    if (text.includes("WITH spec(ix, brand, cc")) {
      return [
        {
          pid: PROJECT_ID,
          prompt_id: PROMPT_ID,
          report_fs: 41,
          unit_base: "hyundai.com/kr",
          turl: "hyundai.com/kr/ko/index",
          turl_base: "hyundai.com/kr/ko/index",
          sibs: ["hyundai.com/kr/ko/vehicles"],
          home_host: "hyundai.com",
        },
      ];
    }
    if (text.includes("array_agg(r.run_id::text")) {
      return [{ project_id: PROJECT_ID, runs: [RUN_A, RUN_B] }];
    }
    if (text.includes("FROM mem ORDER BY started_at")) {
      return [
        { run_id: RUN_A, status: "completed", anchored: false },
        { run_id: RUN_B, status: "completed", anchored: false },
      ];
    }
    if (text.includes("AS answers_all")) {
      return [
        {
          answers_all: 10,
          answers_completed: 9,
          expected_units: 8,
          completed_units: COMPLETED_UNITS,
          prompts: 4,
          gap_answers: 0,
          gap_cells: 0,
          measured_from: "2026-08-30T00:00:00.000Z",
          measured_to: "2026-09-01T00:00:00.000Z",
        },
      ];
    }
    // 접기 전 ANALYZE 대상 파티션 프로브(T2) — 실제 이름을 돌려줘야 ANALYZE 문장이
    // 스냅샷에 잡힌다(빈 배열이면 그 경로가 통째로 스냅샷 밖으로 빠진다).
    if (text.includes("to_regclass(x.n)")) {
      return [
        { rel: "summary_answers_20260831" },
        { rel: "summary_brand_mentions_20260831" },
        { rel: "summary_domain_citations_20260831" },
      ];
    }
    if (text.includes("INSERT INTO summary_cycles")) return [{ cycle_id: CYCLE_ID }];
    if (text.includes("INSERT INTO summary_generations")) return [{ generation_id: GEN_ID }];
    if (text.includes("AS drift")) return [{ drift: 0 }];
    if (text.includes("AS jobs,") && text.includes("AS expected")) {
      // `completed_cells` = 셀 선택과 같은 그레인(prompt,engine,country). 가드는 이것과 비교한다.
      // `completed` 는 원장과 같은 region 그레인이라 일부러 **크게** 둔다 — 접힘이 있어도
      // 가드가 통과하는지(2026-09-10 백필 정지 재발 방지) 이 픽스처가 함께 고정한다.
      return [{
        jobs: COMPLETED_UNITS,
        expected: 8,
        completed: COMPLETED_UNITS + 2,
        completed_cells: COMPLETED_UNITS,
      }];
    }
    if (text.includes("FROM summary_cycle_jobs\n") && text.includes("AS c")) {
      return [{ c: COMPLETED_UNITS }];
    }
    if (text.includes("::int AS c FROM summary_cycle_jobs")) return [{ c: COMPLETED_UNITS }];
    if (text.includes("::int AS c FROM summary_prompt_dim")) return [{ c: 12 }];
    if (text.includes("AS pass_prompts")) return [{ pass_prompts: 3, pass_measured: 3 }];
    if (text.includes("AS cycle_jobs,")) {
      return [
        {
          cycle_jobs: COMPLETED_UNITS,
          answers: COMPLETED_UNITS,
          brand_mentions: 3,
          domain_citations: 4,
          target_hits: 2,
          prompt_dim: 12,
        },
      ];
    }
    return [];
  };
  const fake = {
    execute: async (q: unknown) => respond(q),
    transaction: async (cb: (tx: unknown) => unknown) =>
      cb({ execute: async (q: unknown) => respond(q) }),
  };
  return { getDb: () => fake };
});

/** 스크립트를 통째로 돌려 발행 문장을 순서대로 받는다. */
async function runScript(mod: string, argv: string[]): Promise<Captured[]> {
  vi.resetModules();
  captured.list.length = 0;
  const prevArgv = process.argv;
  process.argv = ["node", mod, ...argv];
  // sha 는 파라미터(GENERATOR_VERSION)에 들어간다 — 개발자 셸에 HMG_GIT_SHA 가 있으면
  // 스냅샷이 흔들린다. 가짜 execFileSync 경로로 고정한다.
  const prevSha = process.env.HMG_GIT_SHA;
  delete process.env.HMG_GIT_SHA;
  let finish: (code: number) => void = () => undefined;
  const finished = new Promise<number>((r) => {
    finish = r;
  });
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: number) => {
      finish(code ?? 0);
      return undefined as never;
    }) as never);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await import(mod);
    const code = await finished;
    if (code !== 0) throw new Error(`${mod} ${argv.join(" ")} exited ${code}`);
  } finally {
    process.argv = prevArgv;
    if (prevSha === undefined) delete process.env.HMG_GIT_SHA;
    else process.env.HMG_GIT_SHA = prevSha;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  }
  return captured.list.map(({ q }) => {
    const compiled = dialect.sqlToQuery(q as SQL);
    return { sql: compiled.sql, params: compiled.params };
  });
}

type Row = {
  i: number;
  head: string;
  md5: string;
  md5_raw: string;
  params_md5: string;
};

function digest(list: Captured[]): Row[] {
  return list.map((c, i) => {
    const exec = norm(stripComments(c.sql));
    return {
      i,
      head: exec.slice(0, 72),
      md5: md5(exec),
      md5_raw: md5(norm(c.sql)),
      params_md5: md5(JSON.stringify(c.params)),
    };
  });
}

const CASES: Array<{ name: string; mod: string; argv: string[] }> = [
  { name: "website:dry-run", mod: "./website-0904", argv: [] },
  { name: "website:apply", mod: "./website-0904", argv: ["--yes"] },
  { name: "global:dry-run", mod: "./global-0831", argv: [] },
  { name: "global:apply", mod: "./global-0831", argv: ["--yes"] },
];

describe("생성기 컴파일 SQL 스냅샷", () => {
  const produced: Record<string, Row[]> = {};

  for (const c of CASES) {
    it(`${c.name} — 발행 SQL 이 고정값과 같다`, async () => {
      const rows = digest(await runScript(c.mod, c.argv));
      produced[c.name] = rows;
      expect(rows.length).toBeGreaterThan(0);
      if (UPDATE) return;
      const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, Row[]>;
      const want = fixture[c.name];
      expect(want, `픽스처에 ${c.name} 없음`).toBeTruthy();
      expect(rows.map((r) => `${r.md5}:${r.params_md5}`)).toEqual(
        want.map((r) => `${r.md5}:${r.params_md5}`),
      );
    });
  }

  // ── 0067 ① — 세부층 인용표의 `report_fs` 는 **웹사이트에만** 굳는다 ────────────
  // 스냅샷 md5 는 "무언가 바뀌었다" 만 말한다. 무엇이 어떻게 바뀌어야 하는지는 여기서 못 박는다.
  it("summary_domain_citations INSERT — 웹사이트는 report_fs 를 굳히고 글로벌은 안 굳힌다", async () => {
    const pick = async (mod: string) => {
      const list = await runScript(mod, ["--yes"]);
      const hits = list
        .map((c) => norm(stripComments(c.sql)))
        .filter((t) => /INSERT INTO summary_domain_citations/.test(t));
      expect(hits, `${mod}: 인용표 INSERT 가 정확히 1개여야 한다`).toHaveLength(1);
      // INSERT 컬럼 목록만 본다 — 본문 CTE 에 우연히 섞인 이름을 세지 않기 위해서다.
      return /INSERT INTO summary_domain_citations \(([^)]*)\)/.exec(hits[0])![1];
    };
    const web = await pick("./website-0904");
    expect(web, "웹사이트 인용표에 report_fs 가 없다 — 2단 enrich 가 job 세미조인을 남긴다").toContain("report_fs");
    expect(web).toContain("unit_owned_citations");

    const glob = await pick("./global-0831");
    // 글로벌은 정본(`summary_answers.report_fs`)이 전량 NULL 이라 굳힐 값이 없다.
    // 굳이 컬럼을 적으면 NULL 을 명시 INSERT 하는 셈이라 의미가 없고, 0067 규약(글로벌 NULL)과도 어긋난다.
    expect(glob, "글로벌 인용표에 report_fs 가 붙었다 — 굳힐 값이 없다").not.toContain("report_fs");
  });

  // ── 셀 유일화 그레인 ⊆ summary_cycle_jobs 유니크 키 (2026-09-10 23505 #2) ──
  // 유닛(셀)을 유일화하는 열이 유니크 키보다 **넓으면**, 넓은 쪽에서만 갈리는 두 행이
  // 살아남아 같은 유니크 키로 INSERT 된다 → duplicate key. 실제로 그렇게 죽었다:
  // 웹사이트가 `DISTINCT ON (prompt_id, target, region)` 인데 `country` 는 사이트
  // `country_code` 에서 오므로, 같은 셀을 CZ·US 두 region 으로 재면 둘 다 통과한 뒤
  // 같은 country 로 접혔다. 판정 대상은 **`summary_cycle_jobs` 에 INSERT 하는 문장** 하나다
  // (같은 스크립트의 진단용 CTE 는 유니크 키를 만들지 않으므로 이 규칙의 대상이 아니다).
  const jobsInsertOf = async (mod: string): Promise<string> => {
    const list = await runScript(mod, ["--yes"]);
    const hits = list
      .map((c) => norm(stripComments(c.sql)))
      .filter((t) => /INSERT INTO summary_cycle_jobs/.test(t));
    expect(hits, `${mod}: summary_cycle_jobs INSERT 가 정확히 1개여야 한다`).toHaveLength(1);
    return hits[0];
  };

  it.each(["./website-0904", "./global-0831"])(
    "%s — country 값이 셀 유일화 서브쿼리 **안**에서 나온다 (23505 방지)",
    async (mod) => {
      // 규칙(표면 무관): `summary_cycle_jobs.country` 로 들어가는 값은 **DISTINCT ON 을 건
      // 서브쿼리가 이미 확정한 것**이어야 한다. 밖에서 조인해 접으면 유일화 그레인이 유니크
      // 키보다 넓어져 같은 키로 두 행이 들어간다 — 그것이 2026-09-10 웹 백필 정지의 원인이다.
      //   · 글로벌: `c.region` 을 그대로 country 로 넣고 DISTINCT 도 region → 항등, 안전.
      //   · 웹사이트(수리 전): `COALESCE(ws.country_code, c.region)` 에서 `ws.` 가
      //     서브쿼리 **밖** 조인이었다 → 결함.
      const t = await jobsInsertOf(mod);
      const cols = /INSERT INTO summary_cycle_jobs \(([^)]*)\)/i.exec(t)![1]
        .split(",")
        .map((c) => c.trim());
      const idx = cols.indexOf("country");
      expect(idx, "INSERT 컬럼 목록에 country 가 없다").toBeGreaterThanOrEqual(0);

      // SELECT 목록을 깊이 0 콤마로 쪼개 country 자리의 식을 뽑는다.
      const sel = t.slice(t.indexOf(" SELECT ", t.indexOf("INSERT INTO summary_cycle_jobs")) + 8);
      const items: string[] = [];
      let cur = "";
      let depth = 0;
      for (const ch of sel) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        if (depth === 0 && /^ FROM /i.test(sel.slice(sel.indexOf(cur) + cur.length))) break;
        if (ch === "," && depth === 0) {
          items.push(cur);
          cur = "";
        } else cur += ch;
      }
      items.push(cur);
      const expr = (items[idx] ?? "").trim();
      expect(expr, `${mod}: country 자리의 식을 못 읽었다`).toBeTruthy();

      // 그 식이 참조하는 테이블 별칭 — 전부 dedup 서브쿼리 별칭이어야 한다.
      const subAlias = /\)\s*(\w+)\s*$/.exec(t.split("DISTINCT ON")[1]?.split(") ")[0] ?? "")?.[1];
      const aliases = [...expr.matchAll(/\b(\w+)\./g)].map((m) => m[1]);
      expect(aliases.length, `${mod}: country 식이 별칭 없는 리터럴이다: ${expr}`).toBeGreaterThan(0);
      for (const a of aliases) {
        expect(
          a === "c",
          `${mod}: country 가 dedup 서브쿼리 밖 별칭 '${a}' 에서 온다 (${expr}) — 유일화 그레인이 유니크 키보다 넓어진다`,
        ).toBe(true);
      }
      expect(subAlias === undefined || subAlias === "c").toBe(true);
    },
  );

  it("웹사이트 셀 유일화가 region 이 아니라 country 로 접힌다 — 진단 CTE 포함 전 경로", async () => {
    // ⚠️ INSERT 경로만 보면 안 된다. 같은 유일화가 dry-run 의 진단 CTE(`cells AS (…)`)에도
    //    있고, 2026-09-10 수리에서 그 둘이 **서로 다른 복붙본**이라 한쪽만 고쳐질 뻔했다.
    //    두 경로 전부를 대상으로 삼는다.
    const list = await runScript("./website-0904", ["--yes"]);
    const dry = await runScript("./website-0904", []);
    const stmts = [...list, ...dry].map((c) => norm(stripComments(c.sql)));
    const shapes = stmts.flatMap((t) =>
      [...t.matchAll(/DISTINCT ON \(([^)]*)\)/gi)]
        // 유닛 스펙 CTE(`DISTINCT ON (s.ix)`)는 셀 그레인이 아니다.
        .filter((m) => /prompt_id/.test(m[1]))
        .map((m) => ({ on: m[1], t })),
    );
    expect(shapes.length, "웹사이트 셀 유일화를 하나도 못 찾았다").toBeGreaterThanOrEqual(2);
    for (const { on, t } of shapes) {
      expect(on, `셀 유일화가 아직 region 으로 갈린다: ${on}`).not.toMatch(/\bregion\b/);
      expect(on).toMatch(/country/);
      // 최신 우선 + job_id tiebreaker (같은 measured_at 에서도 매 실행 같은 셀을 고른다).
      expect(t).toMatch(/ORDER BY[^;]*measured_at DESC, [\w.]*job_id/i);
    }
  });

  it("두 경로의 사이트 조인이 대칭이다 — 소속 프로젝트 한정이 양쪽에 있다", async () => {
    // 비대칭이면 사이트의 `scope_project_id` 가 run 의 프로젝트와 다른 답변이 생겼을 때
    // dry-run 과 실행이 **다른 셀**을 고른다(현재 답변 431,619건 전수 0건이지만 데이터
    // 의존 불변식이라 코드로 맞춘다).
    const both = [
      ...(await runScript("./website-0904", ["--yes"])),
      ...(await runScript("./website-0904", [])),
    ].map((c) => norm(stripComments(c.sql)));
    // 대상은 **country 를 해석하는 조인**뿐이다. 같은 표를 프로젝트 귀속용으로만 쓰는
    // 조인(`COALESCE(ws.scope_project_id, mem.project_id)`)은 country 와 무관하므로 제외한다.
    let checked = 0;
    for (const t of both) {
      for (const m of t.matchAll(/LEFT JOIN website_sites ws ON ws\.id = wp\.site_id(.{0,200})/gs)) {
        if (!/ws\.country_code/.test(m[1])) continue; // country 해석 조인이 아니다
        checked += 1;
        expect(
          m[1],
          `country 를 해석하는 website_sites 조인에 소속 프로젝트 한정이 없다: ...${m[1].slice(0, 70)}`,
        ).toMatch(/^\s*AND ws\.scope_project_id/);
      }
    }
    expect(checked, "country 해석 조인을 하나도 못 찾았다").toBeGreaterThanOrEqual(2);
  });

  it("픽스처 갱신(UPDATE_SQL_SNAPSHOT=1 일 때만 쓴다)", () => {
    if (!UPDATE) {
      expect(Object.keys(produced).length).toBe(CASES.length);
      return;
    }
    writeFileSync(FIXTURE, `${JSON.stringify(produced, null, 2)}\n`);
    expect(Object.keys(produced).length).toBe(CASES.length);
  });
});
