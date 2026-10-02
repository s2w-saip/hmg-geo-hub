/**
 * 0077 백필 dry-run SQL 의 **형태 계약**. DB 없이 돈다 — 수치는 실행한 사람이 본다.
 *
 * 고정하는 성질:
 *   ① 읽기 전용 — 쓰기·DDL 키워드가 없다
 *   ② prelude 1개 + 문장 3개가 `-- @@prelude` / `-- @@statement` 로 나뉘고, prelude 를
 *      앞에 붙이면 각 문장이 독립 실행 가능하다(백필 스크립트가 같은 규칙으로 자른다)
 *   ③ 무겁지 않다 — 상관 서브쿼리 0, 표면·원장은 run 단위로 먼저 해소, UNIQUE 없는 키는 DISTINCT 로 접어 조인
 *   ④ 우선순위·게이트가 마이그레이션 함수와 같은 모양이다
 *   ⑤ R1(KST) 전제: 타임존 상수가 **파일에 한 벌**이고 registry 이관 지표가 정리돼 있다
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve(__dirname, "answer-cycle-anchors-dryrun.sql");
const raw = fs.readFileSync(FILE, "utf8");
const stripComments = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

const preludeIdx = raw.search(/^-- @@prelude\s*$/m);
const afterPrelude = raw.slice(preludeIdx).replace(/^-- @@prelude\s*$/m, "");
const parts = afterPrelude.split(/^-- @@statement (\S+)\s*$/m);
/** 문장 앞에 붙는 공통 머리 — 타임존 상수가 여기 한 번만 나온다(B12). */
const prelude = stripComments(parts[0]);
const statements: Record<string, string> = {};
for (let i = 1; i < parts.length; i += 2) {
  statements[parts[i]] = `${prelude} ${stripComments(parts[i + 1])}`;
}
const all = Object.values(statements).join("\n");

describe("① 읽기 전용", () => {
  it("쓰기·DDL 키워드가 없다", () => {
    expect(all).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO)\b/i);
    expect(all).not.toMatch(/\bFOR UPDATE\b/i);
  });
});

describe("② prelude + 문장 분할", () => {
  it("문장은 다섯이고 이름이 고정돼 있다", () => {
    expect(Object.keys(statements)).toEqual([
      "S1_coverage",
      "S2_registry",
      "S3_gate",
      "S4_cycles",
      "S5_rounds",
    ]);
  });

  it("prelude 는 상수 CTE 셋(tz·de·cw)뿐이고 세미콜론이 없다 (문장이 아니라 머리다)", () => {
    expect(prelude).toBe(
      "WITH tz AS (SELECT 'Asia/Seoul'::text AS zone), " +
        "de AS (SELECT ARRAY['chatgpt', 'gemini']::text[] AS engines), " +
        "cw AS (SELECT * FROM (VALUES ('standard', 1), ('website', 5)) AS v(surface, dow))",
    );
    expect(prelude).not.toContain(";");
  });

  /**
   * 정규 요일 상수도 두 곳(0077 · 이 dry-run)이 같아야 한다. dry-run 은 **적용 전**에
   * 돌아야 해서 `hmg_round_canonical_dow()` 를 부를 수 없으므로 사본이 불가피하다.
   */
  it("prelude 의 정규 요일이 0077 과 같다 (글로벌=월 1 · 웹사이트=금 5)", () => {
    const mig = fs.readFileSync(
      path.resolve(__dirname, "../../lib/db/migrations/0077_scope_answer_cycle_anchors.sql"),
      "utf8",
    );
    expect(mig).toContain(
      "SELECT CASE p_surface WHEN 'standard' THEN 1 WHEN 'website' THEN 5 END",
    );
    expect(prelude).toContain("VALUES ('standard', 1), ('website', 5)");
  });

  /** 기본 엔진 목록은 세 곳(TS 정본 · 0077 · 이 dry-run)이 같아야 한다. */
  it("prelude 의 기본 엔진 목록이 TS 정본·0077 과 같다", async () => {
    const { DEFAULT_AI_ENGINES } = await import("@/lib/scope/engines");
    const mig = fs.readFileSync(
      path.resolve(__dirname, "../../lib/db/migrations/0077_scope_answer_cycle_anchors.sql"),
      "utf8",
    );
    const parse = (t: string) => {
      const m = t.match(/ARRAY\[([^\]]+)\]::text\[\]/);
      return (m?.[1] ?? "").split(",").map((x) => x.trim().replace(/'/g, ""));
    };
    expect(parse(prelude)).toEqual([...DEFAULT_AI_ENGINES]);
    expect(parse(stripComments(mig))).toEqual([...DEFAULT_AI_ENGINES]);
  });

  it("prelude 를 붙이면 각 문장이 WITH 로 시작해 세미콜론 하나로 끝난다", () => {
    for (const s of Object.values(statements)) {
      expect(s.startsWith("WITH tz AS (")).toBe(true);
      expect(s.endsWith(";")).toBe(true);
      expect(s.match(/;/g)).toHaveLength(1);
    }
    // 문장 본체는 `, <cte> AS (` 로 이어붙을 수 있어야 한다(자기 WITH 를 다시 열지 않는다).
    for (let i = 1; i < parts.length; i += 2) {
      expect(stripComments(parts[i + 1]).startsWith(", "), parts[i]).toBe(true);
    }
    // run_ctx 를 쓰는 문장은 자기 안에서 정의한다.
    for (const s of Object.values(statements)) {
      if (s.includes("JOIN run_ctx")) expect(s).toContain("run_ctx AS (");
    }
  });

  it("백필 스크립트가 같은 경계로 자르고 prelude 를 앞에 붙인다", () => {
    // 분리기는 `answer-cycle-anchors-dryrun-split.ts` 한 곳이고, 백필 스크립트와
    // pglite 실행 테스트가 둘 다 그것을 import 한다(사본 금지).
    const splitter = fs.readFileSync(
      path.resolve(__dirname, "answer-cycle-anchors-dryrun-split.ts"),
      "utf8",
    );
    expect(splitter).toContain("/^-- @@statement (\\S+)\\s*$/m");
    expect(splitter).toContain("/^-- @@prelude\\s*$/m");
    expect(splitter).toContain("`${prelude}\\n${parts[i + 1].trim()}`");
    const script = fs.readFileSync(path.resolve(__dirname, "backfill-answer-cycle-anchors.ts"), "utf8");
    expect(script).toContain('from "./answer-cycle-anchors-dryrun-split"');
    expect(script).toContain("splitDryRunStatements(fs.readFileSync(DRYRUN_SQL_PATH, \"utf8\"))");
  });
});

describe("③ 2분 타임아웃 안에 돌 형태", () => {
  it("상관 서브쿼리가 없다 — EXISTS·LATERAL 0, 최종 SELECT 의 서브셀렉트는 **비상관**만", () => {
    for (const [name, s] of Object.entries(statements)) {
      expect(s, name).not.toMatch(/\bEXISTS\s*\(/i);
      expect(s, name).not.toMatch(/\bLATERAL\b/i);
      // 서브셀렉트가 있다면 **전부 비상관**(바깥 행을 참조하지 않는 CTE 조회)이어야 한다.
      // 허용 대상: tz 상수(InitPlan 1회) · S4 의 회차 집계(cyc_res·wk).
      // `DISTINCT` 로 접은 조인 대상(FROM 절 인라인 뷰)은 서브셀렉트가 아니라 파생 테이블이다.
      const subs = (s.match(/\(SELECT[\s\S]*?FROM (\w+)/g) ?? []).filter(
        (x) => !x.includes("SELECT DISTINCT"),
      );
      for (const sub of subs) {
        expect(sub, `${name}: ${sub.slice(-40)}`).toMatch(
          /FROM (tz|de|cw|cyc|cyc_res|wk|wk_de|seats|est2|all_seats|summary_cycles|scope_answer_cycle_anchors)$/,
        );
      }
    }
  });

  it("표면·원장 조인은 run 단위에서 한 번만 한다 (답변마다 6-way 조인 금지)", () => {
    for (const name of ["S1_coverage", "S3_gate"]) {
      const s = statements[name];
      const end = s.indexOf(name === "S1_coverage" ? "), ans AS (" : "resolved AS (");
      const runCtx = s.slice(s.indexOf("run_ctx AS ("), end);
      expect(runCtx, name).toContain("FROM scope_runs r");
      expect(runCtx, name).toContain("summary_cycle_runs");
      expect(runCtx, name).not.toContain("scope_answers");
      const resolved = s.slice(s.indexOf("resolved AS ("));
      expect(resolved, name).not.toContain("website_sites");
      expect(resolved, name).not.toContain("summary_cycles");
    }
  });

  it("S4 는 회차 입도 지표를 낸다 (스펙 §3.1)", () => {
    const s = statements.S4_cycles;
    for (const k of [
      "AS cycles",
      "AS cycles_registry",
      "AS cycle_registry_split",
      "AS cycle_answer_unit_split",
      "AS reg_same_own_cycle",
      "AS reg_moved_other_cycle",
      "AS reg_utc_kept",
      "AS project_week_split",
    ]) {
      expect(s).toContain(k);
    }
    // 회차 키는 0077 과 같은 식이다.
    expect(s).toContain(
      "r.project_id::text || '|' || COALESCE(r.cycle_anchor_at::text, 'run:' || r.run_id::text) AS cycle_key",
    );
    expect(raw).toContain("**기대 0.** 회차 안 레지스트리 앵커가 엇갈린 회차");
  });

  it("S1 도 회차 단위 상속으로 계산한다 (0077 과 같은 우선순위)", () => {
    const s = statements.S1_coverage;
    expect(s).toContain("AS cycle_key");
    expect(s).toContain("cyc_res AS (");
    expect(s).toContain("LEFT JOIN cyc_res c ON c.cycle_key = a.cycle_key");
    // ① UTC 일자 → ② KST 일자 폴백 순서도 같다.
    const iU = s.indexOf("LEFT JOIN cyc_utc u");
    const iK = s.indexOf("LEFT JOIN cyc_kst k");
    expect(iU).toBeGreaterThan(-1);
    expect(iK).toBeGreaterThan(iU);
  });

  it("UNIQUE 없는 scope_project_id 는 DISTINCT 로 접어 조인한다 — 행 복제 금지", () => {
    for (const name of ["S1_coverage", "S3_gate"]) {
      expect(statements[name]).toContain("(SELECT DISTINCT scope_project_id FROM website_sites");
      expect(statements[name]).toContain("(SELECT DISTINCT scope_project_id FROM projects");
    }
  });

  it("S2 는 레지스트리에서 출발한다 (답변 전수 스캔이 아니다)", () => {
    expect(statements.S2_registry).toContain("FROM scope_answer_anchors g");
  });
});

describe("④ 마이그레이션 함수와 같은 규칙", () => {
  it("우선순위 registry → ledger → run → fallback_measured", () => {
    const s = statements.S1_coverage;
    const i = ["'registry'", "'ledger'", "'run'", "'fallback_measured'"].map((k) => s.indexOf(k));
    expect(i.every((v) => v > -1)).toBe(true);
    expect([...i].sort((a, b) => a - b)).toEqual(i);
  });

  it("완료 답변만 · project_id NULL run 은 제외분으로 따로 센다", () => {
    expect(statements.S1_coverage).toContain("a.status = 'completed'");
    expect(statements.S1_coverage).toContain("AS excluded_null_project");
    expect(statements.S1_coverage).toContain("AS no_source");
  });

  it("게이트: 원장 view_anchor → project +1일(⑫) → NULL", () => {
    const s = statements.S3_gate;
    const i = [
      "r.ledger_view_anchor_at IS NOT NULL",
      "COALESCE(r.surface, 'project') = 'project' THEN r.anchor_date + 1",
    ].map((k) => s.indexOf(k));
    expect(i.every((v) => v > -1)).toBe(true);
    expect(i[1]).toBeGreaterThan(i[0]);
    // R4: fallback 전용 분기는 게이트에서 사라졌다(표면 규칙을 그대로 탄다).
    expect(s).not.toContain("WHEN r.is_fallback THEN r.anchor_date");
  });

  it("결정 ⑪ 채움 분기가 없다 (철회)", () => {
    expect(statements.S3_gate).not.toContain("ledger_published");
    expect(statements.S3_gate).not.toContain("view_filled_published");
    expect(statements.S3_gate).not.toContain("active_generation_id");
    const mig = fs.readFileSync(
      path.resolve(__dirname, "../../lib/db/migrations/0077_scope_answer_cycle_anchors.sql"),
      "utf8",
    );
    expect(stripComments(mig)).not.toContain("active_generation_id");
  });
});

describe("표면 판정 — website → standard(원장 global) → project", () => {
  it("S1·S3 의 run_ctx 가 같은 순서로 판정하고, 미분류는 NULL 로 남긴다", () => {
    for (const name of ["S1_coverage", "S3_gate"]) {
      const s = statements[name];
      const i = [
        "WHEN ws.scope_project_id IS NOT NULL THEN 'website'",
        "WHEN gl.project_id IS NOT NULL THEN 'standard'",
        "WHEN p.scope_project_id IS NOT NULL THEN 'project'",
      ].map((k) => s.indexOf(k));
      expect(i.every((v) => v > -1)).toBe(true);
      expect([...i].sort((a, b) => a - b)).toEqual(i);
      expect(s).not.toContain("ELSE 'standard'");
      expect(s).toContain("(SELECT DISTINCT project_id FROM summary_cycles WHERE surface = 'global') gl");
    }
  });

  it("S1 이 sf_unclassified(기대 0)를 낸다", () => {
    expect(statements.S1_coverage).toContain(
      "count(*) FILTER (WHERE source IS NOT NULL AND surface IS NULL) AS sf_unclassified",
    );
    expect(raw).toContain("sf_unclassified        **기대 0.**");
  });

  it("S3 은 표면별로 묶고 view_null 의 두 원인을 가른다", () => {
    const s = statements.S3_gate;
    expect(s).toContain("GROUP BY 1");
    expect(s).toContain("(scr.run_id IS NOT NULL) AS has_cycle");
    expect(s).toContain("ledger_view_anchor_at IS NULL AND NOT has_cycle) AS view_null_no_cycle");
    expect(s).toContain("ledger_view_anchor_at IS NULL AND has_cycle) AS view_null_cycle_unpublished");
    expect(s).toContain("AS ledger_view_missing");
    expect(s).toContain("(WHERE view_anchor_date IS NULL) AS view_null");
  });
});

describe("⑤ R1 = KST — 타임존 상수는 파일에 한 벌", () => {
  it("zone 상수가 prelude 한 곳에만 있고 값이 Asia/Seoul 이다", () => {
    // 원문(prelude 포함 전체)에서 센다 — 문장별로 세면 prelude 가 중복 계산된다.
    const zones = stripComments(raw).match(/'[^']*'::text AS zone/g) ?? [];
    expect(zones).toEqual(["'Asia/Seoul'::text AS zone"]);
    expect(all).not.toMatch(/AT TIME ZONE '/);
  });

  it("마이그레이션 0077 의 hmg_anchor_timezone() 과 같은 값이다", () => {
    const mig = fs.readFileSync(
      path.resolve(__dirname, "../../lib/db/migrations/0077_scope_answer_cycle_anchors.sql"),
      "utf8",
    );
    const migZone = stripComments(mig).match(/SELECT '([^']+)'::text \$fn\$/)?.[1];
    expect(migZone).toBe("Asia/Seoul");
    expect(prelude).toContain(`'${migZone}'::text AS zone`);
  });

  it("registry 지표: R1 이관 결과(이관된 행·UTC 유지)와 접기 원복을 가른다", () => {
    const s = statements.S2_registry;
    for (const k of [
      "registry_rows",
      "registry_in_table",
      "registry_orphans",
      "registry_shifted",
      "registry_utc_kept",
      "registry_unfolded",
      "registry_vs_auto",
      "registry_no_auto_anchor",
    ]) {
      expect(s).toContain(`AS ${k}`);
    }
    // 옛 이름·옛 기대치("불일치 0")가 남아 있으면 안 된다 — R1 이관으로 의미가 바뀌었다.
    expect(s).not.toContain("registry_mismatch");
    expect(raw).toContain("registry_shifted       **0 이 기대값이 아니다.**");
    expect(raw).toContain("registry_unfolded      **기대 0.**");
  });

  it("0053 이관은 0077 과 **같은 회차**를 고른다 (프로젝트 + UTC 일자)", () => {
    const s = statements.S2_registry;
    // 상관 서브쿼리·LATERAL 없이 회차를 먼저 접어 평 조인한다(③ 계약과 양립).
    expect(s).toContain("(cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date");
    expect(s).toContain("LEFT JOIN cyc_utc rc ON rc.project_id = r.project_id AND rc.utc_date = g.anchor");
    // 같은 날 회차가 둘이면 이른 쪽 — 0077 의 ORDER BY … LIMIT 1 과 같은 결정론.
    expect(s).toContain("min(cycle_anchor_at) AS cycle_anchor_at");
    // 이관 결과는 KST 로 다시 자른다.
    expect(s).toContain("COALESCE((reg_cycle_anchor_at AT TIME ZONE zone)::date, anchor) AS anchor_date");
  });

  it("접기 원복 대조는 **UTC 축**이다 — 0053 접기가 UTC 로 맞추기 때문", () => {
    expect(statements.S2_registry).toContain(
      "(measured_at AT TIME ZONE INTERVAL '0')::date IS DISTINCT FROM anchor",
    );
  });
});
