/**
 * `generate-cycle.ts` — CLI 계약 고정(PR① T9).
 *
 * 스냅샷 하네스(`generator-sql-snapshot.test.ts`)와 같은 수법: `getDb()` 를 가짜로 갈아
 * 끼우고 CLI 를 통째로 돌려 **발행 문장을 순서대로** 받아 적는다. 여기서 고정하는 계약은
 * 네 가지다.
 *   ① `--yes` 가 없으면 어떤 쓰기도 없다 (dry-run 이 기본값이라는 것이 안전장치의 전부다)
 *   ② 재생성이 노출일을 밀지 않는다 — `view_anchor_at = COALESCE(view_anchor_at, …)`
 *      (V-1, PR② T14: 안쪽은 `GREATEST(cycle_anchor_at + 표면 지연, now())`)
 *   ③ 스왑의 `FOR SHARE` 낙관 검사가 살아 있다 (§7-3)
 *   ④ `timings` 에 표 6종 키가 전부 들어간다 (그 표면이 안 만드는 표는 0)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const CYCLE_ID = "11111111-1111-4111-8111-111111111111";
const GEN_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "be28fe15-c743-4a88-abb8-182b25602812";
const RUN_A = "44444444-4444-4444-8444-444444444444";
const REFOLD_CYCLE_2 = "33333333-3333-4333-8333-333333333333";
const COMPLETED = 7;

const captured = vi.hoisted(() => ({
  list: [] as Array<{ sql: string; params: unknown[] }>,
  /** 이 조각을 포함한 문장에서 던진다 — 적재 중간 실패를 주입한다. */
  failOn: null as string | null,
}));

vi.mock("node:child_process", () => ({ execFileSync: () => "0000000\n" }));

vi.mock("@/lib/db", () => {
  const d = new PgDialect();
  const respond = (q: unknown): unknown[] => {
    const c = d.sqlToQuery(q as SQL);
    captured.list.push({ sql: c.sql, params: c.params });
    const t = c.sql;
    if (captured.failOn && t.includes(captured.failOn)) {
      throw new Error(`주입된 실패: ${captured.failOn}`);
    }
    if (t.includes("pg_attribute")) return [{ ok: 1 }];
    if (t.includes("FROM entity_registry")) return [{ entity_id: "e1", name: "Hyundai" }];
    if (t.includes("FROM summary_cycles WHERE cycle_id")) {
      return [
        {
          cycle_id: CYCLE_ID,
          surface: "global",
          project_id: PROJECT_ID,
          cycle_anchor_at: "2026-09-08 00:00:00+00",
          cycle_week: "2026-09-07",
          status: "closed",
          active_generation_id: null,
          analysis_gap_ratio: "0.02000",
          view_anchor_at: null,
        },
      ];
    }
    // 재접기 대상(--all-published) — 활성 generation 이 있는 회차 2개.
    if (t.includes("FROM summary_cycles") && t.includes("view_anchor_at IS NOT NULL")) {
      return [0, 1].map((i) => ({
        cycle_id: i === 0 ? CYCLE_ID : REFOLD_CYCLE_2,
        surface: "global",
        project_id: PROJECT_ID,
        cycle_anchor_at: "2026-09-08 00:00:00+00",
        cycle_week: "2026-09-07",
        status: "published",
        active_generation_id: GEN_ID,
        analysis_gap_ratio: "0.02000",
        view_anchor_at: "2026-09-10 00:00:00+00",
      }));
    }
    // 재접기 미리보기 — 세부층 행수(0 이면 건너뛴다).
    if (t.includes("AS answers,") && t.includes("summary_brand_mentions")) {
      return [{ answers: 66, brands: 159, domains: 150 }];
    }
    if (t.includes("to_regclass(x.n)")) return [{ rel: "summary_answers_20260907" }];
    if (t.includes("AS expected_cells")) {
      return [{ runs: 1, expected_cells: 8, completed_cells: COMPLETED }];
    }
    if (t.includes("FROM summary_cycle_runs cr JOIN scope_runs")) return [{ run_id: RUN_A }];
    if (t.includes("FROM summary_generations") && t.includes("status = 'active'")) return [];
    if (t.includes("AS answers_all")) {
      return [
        {
          answers_all: 10, answers_completed: 9, expected_units: 8, completed_units: COMPLETED,
          prompts: 4, gap_answers: 0, gap_cells: 0,
          measured_from: "2026-09-07T00:00:00.000Z", measured_to: "2026-09-08T00:00:00.000Z",
        },
      ];
    }
    if (t.includes("INSERT INTO summary_generations")) return [{ generation_id: GEN_ID }];
    if (t.includes("::int AS c FROM summary_cycle_jobs")) return [{ c: COMPLETED }];
    if (t.includes("::int AS c FROM summary_prompt_dim")) return [{ c: 12 }];
    if (t.includes("AS pass_prompts")) return [{ pass_prompts: 3, pass_measured: 3 }];
    if (t.includes("AS drift")) return [{ drift: 0 }];
    if (t.includes("AS cycle_jobs,")) {
      return [{ cycle_jobs: COMPLETED, answers: COMPLETED, brand_mentions: 3, domain_citations: 4, target_hits: 0, prompt_dim: 12 }];
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

async function runCli(
  args: string[],
  opts: { failOn?: string } = {},
): Promise<{ code: number; stmts: typeof captured.list }> {
  vi.resetModules();
  captured.list.length = 0;
  captured.failOn = opts.failOn ?? null;
  const prev = process.argv;
  process.argv = ["node", "generate-cycle", ...args];
  // sha 는 파라미터(GENERATOR_VERSION)에 들어간다 — 개발자 셸에 HMG_GIT_SHA 가 있으면
  // 스냅샷이 흔들린다. 가짜 execFileSync 경로로 고정한다.
  const prevSha = process.env.HMG_GIT_SHA;
  delete process.env.HMG_GIT_SHA;
  let finish: (c: number) => void = () => undefined;
  const done = new Promise<number>((r) => {
    finish = r;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    finish(c ?? 0);
    return undefined as never;
  }) as never);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await import("./generate-cycle");
    const code = await done;
    return { code, stmts: [...captured.list] };
  } finally {
    process.argv = prev;
    captured.failOn = null;
    if (prevSha === undefined) delete process.env.HMG_GIT_SHA;
    else process.env.HMG_GIT_SHA = prevSha;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/** 표에 쓰는 문장인가 — `SET`/`SELECT` 는 쓰기가 아니다. */
const isWrite = (s: string) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s);

describe("generate-cycle CLI", () => {
  beforeEach(() => {
    captured.list.length = 0;
    captured.failOn = null;
  });

  it("--yes 없이는 어떤 쓰기도 없다 (dry-run 이 기본값)", async () => {
    const { code, stmts } = await runCli([`--surface=global`, `--cycle=${CYCLE_ID}`]);
    expect(code).toBe(0);
    expect(stmts.filter((s) => isWrite(s.sql))).toEqual([]);
  });

  it("--dry-run 이 대상 회차·run 수·예상 셀 수를 읽는다", async () => {
    const { stmts } = await runCli([`--surface=global`, `--cycle=${CYCLE_ID}`, "--dry-run"]);
    const texts = stmts.map((s) => s.sql).join("\n");
    expect(texts).toContain("FROM summary_cycles WHERE cycle_id");
    expect(texts).toContain("AS expected_cells");
    expect(stmts.filter((s) => isWrite(s.sql))).toEqual([]);
  });

  it("--pending 술어가 status/active_generation_id/analysis_gap_ratio 셋을 다 건다", async () => {
    const { stmts } = await runCli([`--surface=global`, "--pending"]);
    const pending = stmts.find((s) => s.sql.includes("FROM summary_cycles") && s.sql.includes("status = 'closed'"));
    expect(pending, "pending 조회 문장이 있어야 한다").toBeTruthy();
    expect(pending!.sql).toContain("active_generation_id IS NULL");
    expect(pending!.sql).toContain("analysis_gap_ratio <=");
    expect(stmts.filter((s) => isWrite(s.sql))).toEqual([]);
  });

  it("--pending 이 스테일 generating 회차를 회수한다 (러너 하드 크래시 탈출)", async () => {
    const { stmts } = await runCli([`--surface=global`, "--pending"]);
    const pending = stmts.find((s) => s.sql.includes("FROM summary_cycles"))!;
    expect(pending.sql).toContain("status = 'generating'");
    // 진행 중(loading) generation 이 최근에 시작돼 있으면 뽑지 않는다 = 동시 러너 이중 생성 차단.
    expect(pending.sql).toContain("g.status = 'loading'");
    expect(pending.sql).toContain("g.started_at > now() -");
  });

  it("--pending 이 행이 아니라 회차 묶음 단위로 자른다 (표면별 묶음 키)", async () => {
    const g = await runCli([`--surface=global`, "--pending", "--max-cycles=3"]);
    const gs = g.stmts.find((s) => s.sql.includes("FROM summary_cycles"))!;
    // 묶음 = 글로벌 회차 앵커. LIMIT 은 cand 가 아니라 DISTINCT 묶음에 걸린다.
    expect(gs.sql).toContain("cycle_anchor_at AS grp");
    expect(gs.sql).toMatch(/SELECT DISTINCT grp FROM cand ORDER BY grp LIMIT/);
    expect(gs.params).toContain(3);

    const w = await runCli([`--surface=website`, "--pending"]);
    const ws = w.stmts.find((s) => s.sql.includes("FROM summary_cycles"))!;
    // 웹사이트는 함대 95 프로젝트가 한 주를 공유한다 — 묶음 키가 주(week)여야
    // 백로그 2주가 한 틱에 섞여 회차가 반만 만들어지는 경로가 닫힌다.
    expect(ws.sql).toContain("cycle_week AS grp");
  });

  it("--max-cycles 가 0·음수·비수치면 종료코드 2 로 거부한다 (조용한 폴백 금지)", async () => {
    for (const bad of ["0", "-1", "abc", "1001", "2.5", ""]) {
      const { code, stmts } = await runCli([`--surface=global`, "--pending", `--max-cycles=${bad}`]);
      expect(code, `--max-cycles=${bad}`).toBe(2);
      expect(stmts, `--max-cycles=${bad} 는 DB 를 건드리면 안 된다`).toEqual([]);
    }
    const okRun = await runCli([`--surface=global`, "--pending", "--max-cycles=1000"]);
    expect(okRun.code).toBe(0);
  });

  it("--dry-run 과 --yes 를 함께 주면 종료코드 2 · 쓰기 0", async () => {
    const { code, stmts } = await runCli([
      `--surface=global`,
      `--cycle=${CYCLE_ID}`,
      "--yes",
      "--dry-run",
    ]);
    // 종전에는 --yes 가 이겨 15문장을 썼다(검증자 캡처). 모순 인자는 거부한다.
    expect(code).toBe(2);
    expect(stmts).toEqual([]);
  });

  it("--surface 없으면 종료코드 2 로 거부하고 DB 를 건드리지 않는다", async () => {
    const { code, stmts } = await runCli(["--pending"]);
    expect(code).toBe(2);
    expect(stmts).toEqual([]);
  });

  describe("--yes (가짜 DB 적재)", () => {
    it("스왑이 view_anchor_at 을 COALESCE 로 보존하고 FOR SHARE 검사를 유지한다", async () => {
      const { code, stmts } = await runCli([`--surface=global`, `--cycle=${CYCLE_ID}`, "--yes"]);
      expect(code).toBe(0);
      const publish = stmts.find((s) => s.sql.includes("UPDATE summary_cycles SET active_generation_id"));
      expect(publish, "published 스왑 문장").toBeTruthy();
      // 재생성이 노출일을 밀지 않는다 — 이 한 줄이 P3(측정 기준일) 의 전제다.
      // V-1(T14): 첫 스왑 값이 `GREATEST(cycle_anchor_at + 표면 지연, now())` 로 바뀌었지만
      // **COALESCE 바깥 껍질은 그대로**여야 한다(재생성 불변이 P3 의 전제).
      expect(publish!.sql.replace(/\s+/g, " ")).toContain(
        "view_anchor_at = COALESCE(view_anchor_at, GREATEST(cycle_anchor_at + interval '2 days', now()))",
      );
      expect(publish!.sql).not.toContain("view_anchor_at = now()");
      expect(publish!.sql).not.toContain("view_anchor_at = GREATEST(");

      const drift = stmts.find((s) => s.sql.includes("AS drift"));
      expect(drift, "낙관 검사 문장").toBeTruthy();
      expect(drift!.sql).toContain("FOR SHARE");
      expect(drift!.sql).toContain("synced_at IS DISTINCT FROM");
    });

    it("timings 에 표 6종 키가 전부 들어간다", async () => {
      const { stmts } = await runCli([`--surface=global`, `--cycle=${CYCLE_ID}`, "--yes"]);
      const timings = stmts.find((s) => s.sql.includes("SET timings ="));
      expect(timings, "timings UPDATE 문장").toBeTruthy();
      const payload = JSON.parse(String(timings!.params[0])) as Record<string, number>;
      for (const k of [
        "cycle_jobs",
        "answers",
        "brand_mentions",
        "domain_citations",
        "target_hits",
        "prompt_dim",
      ]) {
        expect(Object.keys(payload), `timings.${k}`).toContain(k);
      }
      expect(payload.total_ms).toBeGreaterThanOrEqual(0);
    });

    it("카운터 UPDATE 가 관제 종결 출처를 덮어쓰지 않는다 (COALESCE 보존)", async () => {
      const { stmts } = await runCli([`--surface=global`, `--cycle=${CYCLE_ID}`, "--yes"]);
      const counters = stmts.find(
        (s) => s.sql.includes("UPDATE summary_cycles SET") && s.sql.includes("status = 'generating'"),
      );
      expect(counters, "회차 카운터 UPDATE 문장").toBeTruthy();
      // 관제(T6)가 `next_anchor`·`complete`·`recheck_window` 로 닫아 둔 종결 출처를
      // 첫 생성이 지우면 안 된다 — 라이브 96 회차가 전부 operator/override 였던 지문.
      expect(counters!.sql).toContain("closed_by = COALESCE(closed_by, 'operator')");
      expect(counters!.sql).toContain("closed_at = COALESCE(closed_at, now())");
      expect(counters!.sql).toContain("analysis_gate = COALESCE(analysis_gate, 'override')");
      expect(counters!.sql).not.toMatch(/closed_by = 'operator'/);
      expect(counters!.sql).not.toMatch(/analysis_gate = 'override'/);
    });

    it("회차 원장에서 run 을 읽고, 회차 upsert 를 다시 하지 않는다", async () => {
      const { stmts } = await runCli([`--surface=global`, `--cycle=${CYCLE_ID}`, "--yes"]);
      const texts = stmts.map((s) => s.sql).join("\n");
      expect(texts).toContain("FROM summary_cycle_runs cr JOIN scope_runs");
      // 회차는 이미 관제가 열어 둔 것 — CLI 가 anchor_source 를 'operator' 로 덮지 않는다.
      expect(texts).not.toContain("INSERT INTO summary_cycles");
    });

    it("적재 중 실패하면 generation 을 failed 로 접고 회차 status 를 되돌린다", async () => {
      // 카운터 UPDATE(=status 'generating') **이후** 단계에서 죽인다.
      const { code, stmts } = await runCli(
        [`--surface=global`, `--cycle=${CYCLE_ID}`, "--yes"],
        { failOn: "INSERT INTO summary_prompt_dim" },
      );
      expect(code).toBe(1);
      const counters = stmts.find(
        (s) => s.sql.includes("UPDATE summary_cycles SET") && s.sql.includes("status = 'generating'"),
      );
      expect(counters, "실패 전에 카운터가 status 를 올려 뒀다").toBeTruthy();
      expect(
        stmts.find((s) => s.sql.includes("UPDATE summary_generations SET status = 'failed'")),
        "generation failed 마킹",
      ).toBeTruthy();
      const restore = stmts.find((s) =>
        s.sql.includes("SET status = CASE WHEN c.active_generation_id IS NOT NULL"),
      );
      expect(restore, "회차 status 복원 문장이 없으면 --pending 이 영영 안 뽑는다").toBeTruthy();
      expect(restore!.sql).toContain("status = 'generating'"); // 스왑 성공분은 안 건드린다
      // generator_version 도 되돌린다(2026-09-10) — 카운터 UPDATE 가 스왑 tx 밖에서 먼저
      // 새 버전을 박기 때문에, 안 되돌리면 "구 generation 활성 + 새 릴리스 버전" 모순이 남는다.
      expect(restore!.sql, "generator_version 복원").toContain(
        "generator_version = COALESCE(",
      );
    });

    it("모든 쓰기 문장이 statement_timeout·lock_timeout 을 건 tx 안에서 돈다", async () => {
      const { stmts } = await runCli([`--surface=global`, `--cycle=${CYCLE_ID}`, "--yes"]);
      const guards = stmts.filter((s) => /SET LOCAL (statement|lock)_timeout/.test(s.sql));
      expect(guards.some((s) => s.sql.includes("'10min'"))).toBe(true);
      expect(guards.some((s) => s.sql.includes("lock_timeout = '5s'"))).toBe(true);
      const session = stmts.filter((s) => /^SET (statement|lock)_timeout/.test(s.sql.trim()));
      expect(session.length).toBe(2);
    });
  });

  /**
   * 재접기(백필) — PR② T2 라운드4. 고정하는 계약 셋:
   *   ① 인자 조합 검증(종료 2)
   *   ② `--yes` 없으면 쓰기 0, `--yes` 면 표별 DELETE→INSERT 가 한 tx 안에서
   *   ③ **스왑 문장을 하나도 안 낸다** — 재접기는 노출 상태를 건드리지 않는다
   */
  describe("--refold (백필)", () => {
    const AGG = [
      "summary_trend_answers",
      "summary_trend_brands",
      "summary_trend_domains",
      "summary_trend_own",
    ];

    it.each([
      [["--surface=global", "--refold"], "--cycle 또는 --all-published"],
      [["--surface=global", "--refold", "--pending"], "--pending"],
      [["--surface=global", "--refold", `--cycle=${CYCLE_ID}`, "--all-published"], "함께"],
      [["--surface=global", "--all-published"], "--refold 전용"],
      [["--surface=global", "--refold", "--all-published", "--since=2026-8-1"], "YYYY-MM-DD"],
      [["--surface=global", `--cycle=${CYCLE_ID}`, "--since=2026-08-01"], "--all-published"],
    ])("인자 조합 %j 은 종료 2", async (args) => {
      const { code, stmts } = await runCli(args as string[]);
      expect(code).toBe(2);
      expect(stmts.length, "인자 오류면 DB 를 건드리지 않는다").toBe(0);
    });

    it("--yes 없으면 쓰기 0 (대상·세부층 행수만 센다)", async () => {
      const { code, stmts } = await runCli(["--surface=global", "--refold", "--all-published"]);
      expect(code).toBe(0);
      const w = stmts.filter((x) => /^\s*(INSERT|UPDATE|DELETE|ANALYZE)\b/i.test(x.sql.trim()));
      expect(w.map((x) => x.sql.slice(0, 40))).toEqual([]);
    });

    it("--yes: 표별 DELETE→INSERT 를 회차마다 한 벌씩 낸다", async () => {
      const { code, stmts } = await runCli([
        "--surface=global", "--refold", "--all-published", "--yes",
      ]);
      expect(code).toBe(0);
      for (const t of AGG) {
        const del = stmts.filter((x) => x.sql.startsWith(`DELETE FROM ${t} WHERE cycle_id`));
        const ins = stmts.filter((x) => x.sql.includes(`INSERT INTO ${t} (`));
        expect(del.length, `${t} DELETE`).toBe(2); // 회차 2개
        expect(ins.length, `${t} INSERT`).toBe(2);
        // DELETE 가 INSERT 앞 — 멱등의 전부다.
        expect(stmts.indexOf(del[0])).toBeLessThan(stmts.indexOf(ins[0]));
      }
      // 접기 tx 의 GUC 두 줄(스왑과 같은 값).
      expect(stmts.some((x) => x.sql.includes("SET LOCAL statement_timeout = '10min'"))).toBe(true);
      expect(stmts.some((x) => x.sql.includes("SET LOCAL work_mem = '256MB'"))).toBe(true);
      // 주 파티션 ANALYZE 는 주당 한 번(회차 2개가 같은 주).
      expect(stmts.filter((x) => x.sql.startsWith("ANALYZE ")).length).toBe(1);
    });

    it("스왑 문장을 하나도 내지 않는다 — 노출 상태 무접촉", async () => {
      const { stmts } = await runCli([
        "--surface=global", "--refold", "--all-published", "--yes",
      ]);
      // 쓰기 문장만 본다 — 판정 입력 스냅샷 읽기(`… WHERE status = 'active'`)는 정상 경로다.
      const writes = stmts
        .map((x) => x.sql.trim())
        .filter((x) => /^(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|ANALYZE)\b/i.test(x));
      const t = writes.join("\n");
      for (const forbidden of [
        "SET status = 'retired'",
        "SET status = 'active'",
        "SET active_generation_id",
        "view_anchor_at",
        "generator_version =",
        "INSERT INTO summary_generations",
        "INSERT INTO summary_answers",
        "INSERT INTO summary_brand_mentions",
        "INSERT INTO summary_domain_citations",
        "UPDATE summary_cycles",
      ]) {
        expect(t, `재접기가 '${forbidden}' 를 발행했다`).not.toContain(forbidden);
      }
      // drift 검사(FOR SHARE)는 읽기지만 스왑 전용이다 — 재접기 경로엔 없어야 한다.
      expect(stmts.some((x) => x.sql.includes("AS drift"))).toBe(false);
    });

    it("timings 는 덮지 않고 병합한다 — refold_* 키만 얹는다", async () => {
      const { stmts } = await runCli([
        "--surface=global", "--refold", "--all-published", "--yes",
      ]);
      const m = stmts.find((x) => x.sql.includes("SET timings = COALESCE(timings"));
      expect(m, "timings 병합 UPDATE").toBeTruthy();
      expect(m!.sql).toContain("|| $1::jsonb");
      const patch = JSON.parse(String(m!.params[0])) as Record<string, number>;
      expect(Object.keys(patch).sort()).toEqual([
        "refold_answers", "refold_at", "refold_brands", "refold_domains",
        "refold_own", "refold_total_ms",
      ]);
    });
  });
});