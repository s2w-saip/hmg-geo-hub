/**
 * 0077 마이그레이션의 **텍스트 계약**.
 *
 * ── 이 파일이 지키는 것 ──────────────────────────────────────────────────────
 * 단위 테스트는 DB 없이 돈다. 그래서 여기서 고정할 수 있는 것은 "무엇이 쓰여 있는가"
 * 뿐이고, **날짜 산술이 실제로 맞는지는 마이그레이션 자신이 적용 시점에 검증한다**
 * (0077 의 `$selftest$` DO 블록 — 틀리면 `db:apply` 가 실패한다). 이 파일은 그
 * 검산 케이스가 **존재하는지**를 고정해, 나중에 누가 자가검증을 지우고 지나가는
 * 회귀를 잡는다.
 *
 * 고정하는 성질:
 *   ① 우선순위 registry → ledger → run → fallback_measured
 *   ② `registry` 출처 행을 약한 출처가 덮지 않는다
 *   ③ 노출 게이트가 `view_anchor_date` 이고 타임존이 붙은 "오늘"을 쓴다
 *   ④ 타임존 상수가 **한 곳**이다(D1 을 한 줄로 뒤집을 수 있다)
 *   ⑤ additive-only — 기존 테이블 ALTER·DROP 없음
 *   ⑥ REVOKE anon/authenticated
 *   ⑦ `IF NOT EXISTS` 락 함정 회피 — DDL 은 카탈로그 선확인 DO 블록 안
 *   ⑧ drizzle 저널의 `when` 이 직전 + 86,400,000 (단조 규칙)
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readSourceText } from "@/test/source-text";

const DIR = path.resolve(__dirname);
const FILE = path.join(DIR, "0077_scope_answer_cycle_anchors.sql");
const sql = readSourceText(FILE);
/** 주석을 뺀 실행 본문 — 계약은 "실행되는 것"에만 건다. */
const body = sql
  .split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");
const flat = body.replace(/\s+/g, " ");

describe("① 앵커 결정: **회차 단위**로 정하고 답변이 상속한다 (스펙 §3.1)", () => {
  it("회차 키 = 프로젝트 + cycle_anchor_at, NULL 이면 run 단독", () => {
    expect(flat).toContain(
      "rr.project_id::text || '|' || COALESCE(rr.cycle_anchor_at::text, 'run:' || rr.run_id::text) AS cycle_key",
    );
    // 답변은 회차 결과를 **조인해서 받는다**(답변마다 따로 정하지 않는다).
    expect(flat).toContain("FROM ans a JOIN cyc_map c ON c.cycle_key = a.cycle_key");
  });

  it("받은 run 이 속한 **회차 전체**로 범위를 넓힌다", () => {
    expect(flat).toContain("WITH seed AS ( SELECT DISTINCT r.project_id, r.cycle_anchor_at");
    expect(flat).toContain(
      "JOIN seed s ON s.project_id = r.project_id AND r.cycle_anchor_at = s.cycle_anchor_at",
    );
    // 확장 결과(v_runs)를 upsert 와 B8 삭제가 **둘 다** 쓴다.
    expect(flat).toContain("USING v_runs, p_root_project_id;");
    expect(flat).toContain("WHERE t.run_id = ANY(v_runs)");
    expect(flat).not.toContain("WHERE rr.run_id = ANY(run_ids)");
    // 넓어졌다는 사실을 NOTICE 로 드러낸다.
    expect(flat).toContain("회차 상속으로 run %개");
  });

  it("상관 서브쿼리를 쓰지 않는다 — 회차 키를 먼저 뽑아 평 조인한다", () => {
    // 확장은 seed CTE + UNION 조인이다(EXISTS 상관 조회가 아니다).
    const expand = flat.slice(flat.indexOf("WITH seed AS ("), flat.indexOf("INTO v_runs"));
    expect(expand).not.toMatch(/EXISTS\s*\(/);
    // 0053 이관 대조도 회차를 UTC 일자로 접어 평 조인한다(종전엔 답변마다 도는 스칼라 서브쿼리).
    expect(flat).toContain("LEFT JOIN cyc_utc u ON u.project_id = b.project_id AND u.d = r.reg_anchor");
    expect(flat).toContain("(cycle_anchor_at AT TIME ZONE INTERVAL '0')::date AS utc_date");
  });

  it("registry → ledger → run → fallback_measured 순서로 쓰여 있다", () => {
    const i = {
      registry: flat.indexOf("'registry'"),
      ledger: flat.indexOf("'ledger'"),
      run: flat.indexOf("'run'"),
      fallback: flat.indexOf("'fallback_measured'"),
    };
    expect(i.registry).toBeGreaterThan(-1);
    expect(i.ledger).toBeGreaterThan(i.registry);
    expect(i.run).toBeGreaterThan(i.ledger);
    expect(i.fallback).toBeGreaterThan(i.run);
  });

  it("레지스트리는 회차 **전체**에 퍼진다 — 한 답변만 등록돼도 회차가 상속한다", () => {
    expect(flat).toContain("SELECT cycle_key, min(reg_anchor) AS reg_anchor, count(DISTINCT reg_anchor)::int AS reg_variants FROM ans WHERE reg_anchor IS NOT NULL GROUP BY cycle_key");
  });

  it("회차 안 레지스트리 불일치는 **가장 이른 날짜**로 결정적으로 접고 변이 수를 남긴다", () => {
    expect(flat).toContain("count(DISTINCT reg_anchor)::int AS reg_variants");
    expect(flat).toContain("count(DISTINCT ledger_anchor_at)::int AS ledger_variants");
    expect(sql).toContain("불일치를 가정하고");
  });

  it("fallback 은 그 회차 답변의 가장 이른 측정 시각이다 (회차가 쪼개지지 않게)", () => {
    expect(flat).toContain("min(measured_at) AS fallback_at");
  });

  it("네 출처가 각각 어느 컬럼에서 오는지가 명시돼 있다", () => {
    expect(flat).toContain("scope_answer_anchors reg");
    expect(flat).toContain("summary_cycle_runs scr");
    expect(flat).toContain("summary_cycles cyc");
    expect(flat).toContain("rr.cycle_anchor_at");
    expect(flat).toContain("a.measured_at");
  });

  it("수작업 접기 뒤 무엇을 불러야 하는지가 주석에 있다", () => {
    expect(sql).toContain("수작업 접기 절차 뒤에 반드시 부른다");
    expect(sql).toContain("docs/measured-at-anchor-registry.md");
    expect(sql).toContain("SELECT refresh_answer_cycle_anchors(");
  });

  it("R1 이관 — 0053 의 UTC 날짜를 **회차 단위로** KST 로 다시 자른다", () => {
    // 0053 의 `anchor` 는 UTC 날짜다. 그대로 쓰면 KST 축과 하루 어긋난다(스펙 §9 말미).
    // ① UTC 일자(정본 규칙) → ② KST 일자 폴백 → ③ 원래 날짜 유지.
    expect(flat).toContain(
      "THEN COALESCE(hmg_anchor_date(u.cycle_anchor_at), hmg_anchor_date(k.cycle_anchor_at), r.reg_anchor)",
    );
    expect(flat).toContain("LEFT JOIN cyc_kst k ON k.project_id = b.project_id AND k.d = r.reg_anchor");
    // ① 을 먼저 보므로 캠페인처럼 다른 회차를 가리키는 이관은 그대로 유지된다.
    const iUtc = flat.indexOf("), cyc_utc AS (");
    const iKst = flat.indexOf("), cyc_kst AS (");
    expect(iUtc).toBeGreaterThan(-1);
    expect(iKst).toBeGreaterThan(iUtc);
    // 못 찾으면 원래 날짜를 유지하고 reason 에 표식을 남긴다(감사 대상).
    expect(flat).toContain("'[anchor-tz:utc-date-kept]'");
    expect(flat).toContain(
      "(r.reg_anchor IS NOT NULL AND u.cycle_anchor_at IS NULL AND k.cycle_anchor_at IS NULL) AS reg_utc_kept",
    );
    // anchor_at 도 같은 분기로 — hmg_anchor_date(anchor_at) = anchor_date 불변식.
    expect(flat).toContain(
      "THEN COALESCE(u.cycle_anchor_at, k.cycle_anchor_at, (r.reg_anchor::timestamp AT TIME ZONE hmg_anchor_timezone()))",
    );
    // 답변 단위로 도는 상관 스칼라 서브쿼리는 없어졌다.
    expect(flat).not.toContain("hmg_anchor_utc_midnight(reg.anchor)");
  });

  it("UTC 자정 헬퍼는 존 이름을 쓰지 않는다 — 상수 한 곳 규율 유지", () => {
    expect(flat).toContain("FUNCTION hmg_anchor_utc_midnight(d date)");
    expect(flat).toContain("SELECT (d::timestamp AT TIME ZONE INTERVAL '0')");
    expect(flat).toContain(
      "REVOKE ALL ON FUNCTION hmg_anchor_utc_midnight(date) FROM PUBLIC, anon, authenticated;",
    );
    // 자가검증이 UTC 자정임을 실행으로 확인한다.
    expect(flat).toContain(
      "hmg_anchor_utc_midnight(DATE '2026-09-01') <> TIMESTAMPTZ '2026-09-01 00:00:00+00'",
    );
  });

  it("완료 답변만 대상이다 — 결정 ⑬ (전수 = completed)", () => {
    expect(flat).toContain("a.status = 'completed'");
  });

  /**
   * N-9 — 변이 실험 3 이 통과해 버린 구멍을 막는다.
   * `AND r.project_id IS NOT NULL` 을 `AND true` 로 바꿔도 53/53 이 통과했다.
   * 결정 ⑩ 은 "project_id NULL 레거시 run(594개·답변 10,419)을 테이블에서 제외" 다.
   */
  it("결정 ⑩ — project_id NULL 레거시 run 을 제외한다", () => {
    // src CTE 의 WHERE 에 세 술어가 **함께** 있어야 한다(⑩·⑬·배치 한정).
    // 회차 단위가 되면서 세 술어의 자리가 나뉘었다: run 한정·project_id 는 run_ctx,
    // completed 는 ans. 둘을 각각 확인한다.
    expect(flat).toContain("WHERE rr.run_id = ANY($1) AND rr.project_id IS NOT NULL");
    // run_ctx 와 ans 의 술어를 각각 잘라 확인한다(다른 곳의 completed 와 섞이지 않게).
    const runCtx = flat.slice(flat.indexOf("), run_ctx AS ("), flat.indexOf("), ans AS ("));
    expect(runCtx).toContain("WHERE rr.run_id = ANY($1) AND rr.project_id IS NOT NULL");
    expect(runCtx).not.toContain("AND true");
    const ansCte = flat.slice(flat.indexOf("), ans AS ("), flat.indexOf("), cyc_reg AS ("));
    expect(ansCte).toContain("WHERE a.status = 'completed'");
    // 범위 확장도 project_id NULL run 을 빼고 넓힌다.
    expect(flat).toContain("WHERE r.run_id = ANY(run_ids) AND r.project_id IS NOT NULL");
    // 컬럼은 nullable 로 남긴다(전수를 이기는 제약을 두지 않는다 — 스펙 §3 주석).
    // ⚠️ **앵커 테이블의 DDL 블록 안에서만** 본다 — 매핑 표(`scope_cycle_rounds`)의
    //    `project_id` 는 NOT NULL 이 맞다(회차 키의 일부라 NULL 일 수 없다).
    const anchorDdl = flat.slice(
      flat.indexOf("CREATE TABLE scope_answer_cycle_anchors ("),
      flat.indexOf("CREATE TABLE scope_cycle_rounds ("),
    );
    expect(anchorDdl).toContain("project_id uuid,");
    expect(anchorDdl).not.toContain("project_id uuid NOT NULL");
  });

  it("결정 ⑩ 이 dry-run·백필·감사에서도 같은 술어다", () => {
    const dry = readSourceText(
      path.resolve(DIR, "../../../scripts/db/answer-cycle-anchors-dryrun.sql"),
    );
    // dry-run 은 제외분을 **세기** 위해 LEFT JOIN 뒤 FILTER 로 가른다.
    expect(dry).toContain("count(*) FILTER (WHERE has_run AND project_id IS NULL)");
    const backfill = readSourceText(
      path.resolve(DIR, "../../../scripts/db/backfill-answer-cycle-anchors.ts"),
    );
    expect(backfill).toContain("AND r.project_id IS NOT NULL");
    expect(backfill).toContain("r_run IS NOT NULL AND project_id IS NULL");
    const audit = readSourceText(
      path.resolve(DIR, "../../../scripts/db/answer-cycle-anchors-audit.sql"),
    );
    expect(audit).toContain("AND r.project_id IS NOT NULL");
  });
});

/**
 * 회차 상속의 **날짜 기대값** — 전부 손계산 리터럴이다(KST = UTC+9 고정, 서머타임 없음).
 * 구현과 같은 상수·같은 산식을 공유하는 헬퍼로 재계산하면 둘이 같이 틀려도 통과한다.
 */
describe("①' 회차 상속 시나리오 (a)~(d)", () => {
  const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=일

  it("(a) run 17개가 앵커 07-09 22:55Z 를 공유하고 일부만 레지스트리 07-10 → 회차 전체 2026-07-10", () => {
    // 22:55Z + 9h = 07-10 07:55 KST. 레지스트리 UTC 날짜 07-10 과 같은 값이다.
    expect(flat).toContain(
      "hmg_anchor_date(TIMESTAMPTZ '2026-07-09 22:55:00+00') <> DATE '2026-07-10'",
    );
    // 그 회차의 UTC 일자는 07-09 라 UTC 조회(①)로는 못 찾고 KST 폴백(②)이 집는다.
    expect(flat).toContain(
      "(TIMESTAMPTZ '2026-07-09 22:55:00+00' AT TIME ZONE INTERVAL '0')::date <> DATE '2026-07-09'",
    );
    expect(dow("2026-07-10")).toBe(5); // 금
    // 회차 전체가 한 값을 받는 배선: 답변이 cyc_res 를 조인한다.
    expect(flat).toContain("FROM ans a JOIN cyc_map c ON c.cycle_key = a.cycle_key");
  });

  it("(b) 레지스트리 없는 회차, 앵커 22:35Z → KST 다음 날", () => {
    expect(flat).toContain(
      "hmg_anchor_date(TIMESTAMPTZ '2026-07-16 22:35:00+00') <> DATE '2026-07-17'",
    );
    expect(dow("2026-07-17")).toBe(5); // 금
    // 레지스트리가 없으면 ledger → run 으로 내려간다.
    expect(flat).toContain("WHEN l.ledger_anchor_at IS NOT NULL THEN 'ledger'");
    expect(flat).toContain("WHEN b.run_anchor_at IS NOT NULL THEN 'run'");
  });

  it("(c) 캠페인: 뒤 회차(08-01)의 레지스트리가 앞 회차(07-27)를 가리킨다 → 2026-07-27", () => {
    expect(flat).toContain(
      "hmg_anchor_date(TIMESTAMPTZ '2026-07-27 01:10:00+00') <> DATE '2026-07-27'",
    );
    // 레지스트리 날짜(07-27)가 앞 회차의 UTC 일자와 같아 ①로 찾힌다.
    expect(flat).toContain(
      "(TIMESTAMPTZ '2026-07-27 01:10:00+00' AT TIME ZONE INTERVAL '0')::date <> DATE '2026-07-27'",
    );
    // 두 회차 날짜가 실제로 다르다는 것(이관이 의미 있다는 것)도 단언한다.
    expect(flat).toContain(
      "hmg_anchor_date(TIMESTAMPTZ '2026-08-01 01:10:00+00') = DATE '2026-07-27'",
    );
    expect(dow("2026-07-27")).toBe(1); // 월
  });

  it("(d) cycle_anchor_at NULL run 은 회차를 이루지 못하고 run 단독이다", () => {
    // 회차 키에 run_id 를 섞어 다른 NULL run 과 뭉치지 않게 한다.
    expect(flat).toContain("COALESCE(rr.cycle_anchor_at::text, 'run:' || rr.run_id::text)");
    // 범위 확장의 seed 도 NULL 앵커 run 을 회차 키로 쓰지 않는다.
    expect(flat).toContain("AND r.cycle_anchor_at IS NOT NULL");
    // 그런 run 은 fallback_measured 로 떨어지고, 회차 안 가장 이른 측정 시각 하나를 쓴다.
    expect(flat).toContain("WHEN b.fallback_at IS NOT NULL THEN 'fallback_measured'");
    expect(flat).toContain("min(measured_at) AS fallback_at");
  });
});

describe("①'' 신설 컬럼 — 대표 답변 정렬 키 · 기본 엔진 (인계 §1-7·§1 엔진 범위)", () => {
  it("measured_at_orig 는 NOT NULL 이고 COALESCE 세 단계다", () => {
    expect(flat).toContain("measured_at_orig timestamptz NOT NULL");
    expect(flat).toContain(
      "COALESCE(a.reg_source_measured_at, a.measured_at, c.anchor_at)",
    );
  });

  it("is_default_engine 은 NOT NULL 이고 목록은 함수 한 곳에서만 온다", () => {
    expect(flat).toContain("is_default_engine boolean NOT NULL");
    expect(flat).toContain("(a.target = ANY(hmg_anchor_default_engines()))");
    // 목록 리터럴은 함수 본문에 딱 한 번.
    const lists = flat.match(/ARRAY\['chatgpt', 'gemini'\]/g) ?? [];
    expect(lists).toHaveLength(1);
  });

  /**
   * 정본 대조 — SQL 은 TS 상수를 읽을 수 없으므로 **여기서** 두 목록을 맞춘다.
   * 이 테스트가 없으면 `DEFAULT_AI_ENGINES` 가 바뀌어도 SQL 이 조용히 뒤처진다.
   */
  it("SQL 목록이 `lib/scope/engines.ts::DEFAULT_AI_ENGINES` 와 같다", async () => {
    const { DEFAULT_AI_ENGINES, AI_ENGINE_IDS } = await import("@/lib/scope/engines");
    const m = flat.match(/ARRAY\[([^\]]+)\]::text\[\]/);
    const sqlList = (m?.[1] ?? "").split(",").map((x) => x.trim().replace(/'/g, ""));
    expect(sqlList).toEqual([...DEFAULT_AI_ENGINES]);
    // 전체 어휘에 없는 토큰을 쓰지 않았는지도 본다(철자 오타 방지).
    for (const id of sqlList) expect(AI_ENGINE_IDS as readonly string[]).toContain(id);
  });

  it("두 컬럼은 보존 가드 **밖**이다 (앵커가 아니라 답변 단위 사실)", () => {
    expect(flat).toContain("measured_at_orig = EXCLUDED.measured_at_orig,");
    expect(flat).toContain("is_default_engine = EXCLUDED.is_default_engine,");
    // 보존 가드에 묶이지 않았는지 확인한다.
    expect(flat).not.toMatch(/hmg_anchor_keep_existing\(t\.source, EXCLUDED\.source\) THEN t\.measured_at_orig/);
    expect(flat).not.toMatch(/hmg_anchor_keep_existing\(t\.source, EXCLUDED\.source\) THEN t\.is_default_engine/);
    // 변경 감지 튜플 ①에 들어 있어야 값이 바뀔 때 실제로 쓰인다.
    expect(flat).toContain(
      "(t.run_id, t.project_id, t.surface, t.ledger_view_anchor_date, t.cycle_id, t.measured_at_orig, t.is_default_engine) IS DISTINCT FROM",
    );
    expect(flat).toContain(
      "EXCLUDED.ledger_view_anchor_date, EXCLUDED.cycle_id, EXCLUDED.measured_at_orig, EXCLUDED.is_default_engine)",
    );
  });

  it("대표 답변 선택용 인덱스 후보가 있다 (리더 전환은 C 단계)", () => {
    expect(flat).toContain("scope_answer_cycle_anchors_rep_idx");
    // 대표는 **귀속 날짜 단위**로 고른다 — 합쳐진 자리는 한 회차로 본다.
    expect(flat).toContain("(project_id, round_date, measured_at_orig DESC)");
    expect(sql).toContain("리더 전환(C 단계) 때 EXPLAIN 으로 모양을 확정할 것");
  });

  it("schema.ts 가 두 컬럼과 인덱스를 안다 (db:drift 기준선)", () => {
    const schema = readSourceText(path.resolve(DIR, "../schema.ts"));
    expect(schema).toContain('measuredAtOrig: timestamp("measured_at_orig"');
    expect(schema).toContain('isDefaultEngine: boolean("is_default_engine").notNull()');
    expect(schema).toContain("scope_answer_cycle_anchors_rep_idx");
  });
});

describe("② 고정(pinned) 출처 보존 — BLOCK-2② 수리", () => {
  it("보존 가드는 `hmg_anchor_keep_existing` 한 곳에서 판정한다", () => {
    expect(flat).toContain("FUNCTION hmg_anchor_keep_existing(t_source text, new_source text)");
    expect(flat).toContain(
      "SELECT hmg_anchor_is_pinned(t_source) AND NOT (t_source = 'registry' AND new_source = 'registry')",
    );
    // 앵커 계열 7개 컬럼이 전부 같은 가드를 쓴다(하나라도 빠지면 부분 덮어쓰기).
    const guards = flat.match(/hmg_anchor_keep_existing\(t\.source, EXCLUDED\.source\)/g);
    expect(guards?.length).toBeGreaterThanOrEqual(7);
    // 인라인 리터럴 가드가 남아 있으면 안 된다(두 벌 금지).
    expect(flat).not.toContain("t.source = 'registry' AND EXCLUDED.source <> 'registry'");
  });

  it("고정 출처는 registry 하나뿐이고 CHECK 에서 fleet_align 이 빠졌다", () => {
    expect(flat).toContain("SELECT src IN ('registry')");
    expect(flat).toContain(
      "CHECK (source IN ('registry', 'ledger', 'run', 'fallback_measured'))",
    );
    // 정렬 보정 출처는 정규 요일 귀속으로 대체돼 사라졌다.
    expect(flat).not.toContain("'fleet_align', 'ledger'");
  });

  it("자가검증 진리표가 registry 보존을 단언한다", () => {
    expect(flat).toContain("IF NOT hmg_anchor_keep_existing('registry', 'ledger')");
    expect(flat).toContain("OR NOT hmg_anchor_keep_existing('registry', 'run')");
    // `fleet_align` 은 이제 고정이 **아니다**.
    expect(flat).toContain("OR hmg_anchor_is_pinned('fleet_align')");
  });

  it("같은 registry 끼리는 갱신된다 — 0053 정정이 전파돼야 한다", () => {
    expect(flat).toContain("OR hmg_anchor_keep_existing('registry', 'registry')");
    expect(flat).toContain("IF NOT hmg_anchor_keep_existing('registry', 'ledger')");
  });

  it("B8 삭제도 고정 출처를 지우지 않는다", () => {
    expect(flat).toContain("AND NOT hmg_anchor_is_pinned(t.source)");
    expect(flat).not.toMatch(/DELETE FROM scope_answer_cycle_anchors[\s\S]{0,200}?t\.source <> 'registry'/);
  });

  it("값이 안 바뀐 행은 쓰지 않는다 (멱등)", () => {
    expect(flat).toContain("IS DISTINCT FROM");
    expect(flat).toContain("ON CONFLICT (job_id) DO UPDATE SET");
  });

  it("N-2 — 주·월이 변경 감지 술어에 들어 있다", () => {
    expect(flat).toContain(
      "(t.anchor_at, t.anchor_date, t.anchor_week, t.anchor_month, t.source, t.source_measured_at, t.reason)",
    );
    expect(flat).toContain(
      "(EXCLUDED.anchor_at, EXCLUDED.anchor_date, EXCLUDED.anchor_week, EXCLUDED.anchor_month, EXCLUDED.source, EXCLUDED.source_measured_at, EXCLUDED.reason)",
    );
  });
});

describe("③ 노출 게이트 (스펙 §3.3 + §9 노출)", () => {
  it("원장 view_anchor_at 이 정본이고 첫 분기다", () => {
    expect(flat).toContain("WHEN p_ledger_view_date IS NOT NULL THEN p_ledger_view_date");
    // 원장 값은 별도 컬럼으로도 보관한다(보존 경로의 재계산 입력 · 감사).
    expect(flat).toContain("ledger_view_anchor_date date");
    expect(flat).toContain("hmg_anchor_date(a.ledger_view_anchor_at),");
  });

  it("노출일 산식은 `hmg_anchor_view_date` **한 곳**이다 (insert·upsert 두 벌 금지)", () => {
    expect(flat).toContain("FUNCTION hmg_anchor_view_date(");
    // insert 경로
    expect(flat).toContain(
      "hmg_anchor_view_date(a.surface, c.anchor_date, hmg_anchor_date(a.ledger_view_anchor_at))",
    );
    // 종전처럼 CASE 를 인라인으로 펼친 흔적이 없어야 한다.
    expect(flat).not.toContain("WHEN ledger_view_anchor_at IS NOT NULL THEN hmg_anchor_date(ledger_view_anchor_at) WHEN surface");
  });

  it("결정 ⑫ — 프로젝트 표면은 앵커 **+1일**이다", () => {
    expect(flat).toContain("WHEN p_surface = 'project' THEN p_anchor_date + 1");
    expect(flat).not.toMatch(/WHEN p_surface = 'project' THEN p_anchor_date(?! \+ 1)/);
    // 자가검증이 실행으로 확인한다.
    expect(flat).toContain(
      "hmg_anchor_view_date('project', DATE '2026-01-05', NULL) <> DATE '2026-01-06'",
    );
    // 원장 노출일이 있으면 project 표면이라도 ①이 이긴다.
    expect(flat).toContain(
      "hmg_anchor_view_date('project', DATE '2026-01-05', DATE '2026-01-09') <> DATE '2026-01-09'",
    );
  });

  it("R4 — fallback_measured 전용 분기가 없다 (표면 규칙을 그대로 탄다)", () => {
    expect(flat).not.toContain("WHEN source = 'fallback_measured' THEN anchor_date");
    // 산식 함수는 `source` 를 인자로 받지도 않는다.
    expect(flat).not.toMatch(/hmg_anchor_view_date\([^)]*p_source/);
    // 제외 목록(프로젝트 id 하드코딩)도 없다.
    expect(flat).not.toMatch(/de300000|f0513a4e/);
  });

  it("결정 ⑪ 채움 분기가 **없다** (철회 — 비어 있는 209 회차는 채우지 않는다)", () => {
    // 술어 조각·인자·원장 컬럼 참조가 전부 사라졌다.
    expect(flat).not.toContain("v_published");
    expect(flat).not.toContain("ledger_published");
    expect(flat).not.toContain("active_generation_id");
    expect(flat).not.toContain("cyc.status");
    // 산식 함수는 인자 셋뿐이다.
    expect(flat).toContain(
      "FUNCTION hmg_anchor_view_date( p_surface text, p_anchor_date date, p_ledger_view_date date )",
    );
    expect(flat).toContain(
      "REVOKE ALL ON FUNCTION hmg_anchor_view_date(text, date, date) FROM PUBLIC, anon, authenticated;",
    );
  });

  it("산식이 **시간에 의존하지 않는다** (N-12 을 구조적으로 막는다)", () => {
    const fnStart = flat.indexOf("FUNCTION hmg_anchor_view_date(");
    const fnBody = flat.slice(fnStart, flat.indexOf("$fn$;", fnStart + 200));
    expect(fnBody).not.toContain("hmg_anchor_today()");
    expect(fnBody).not.toContain("now()");
    // 자가검증이 오늘±30일 앵커 둘 다 NULL 임을 확인한다.
    expect(flat).toContain(
      "hmg_anchor_view_date('standard', hmg_anchor_today() + 30, NULL) IS NOT NULL OR hmg_anchor_view_date('standard', hmg_anchor_today() - 30, NULL) IS NOT NULL",
    );
  });

  it("산식 분기 순서: 원장 → 프로젝트(⑫) → NULL", () => {
    const i = [
      "WHEN p_ledger_view_date IS NOT NULL THEN p_ledger_view_date",
      "WHEN p_surface = 'project' THEN p_anchor_date + 1",
    ].map((k) => flat.indexOf(k));
    expect(i.every((v) => v > -1)).toBe(true);
    expect(i[1]).toBeGreaterThan(i[0]);
  });

  it("N-1 — 보존 경로의 노출일은 **보존된 anchor_date** 로 다시 계산한다", () => {
    expect(flat).toContain(
      "view_anchor_date = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source) THEN hmg_anchor_view_date( EXCLUDED.surface, t.anchor_date, EXCLUDED.ledger_view_anchor_date) ELSE EXCLUDED.view_anchor_date END,",
    );
    // 종전처럼 EXCLUDED 값을 무조건 받는 형태가 남아 있으면 안 된다.
    expect(flat).not.toContain("view_anchor_date = EXCLUDED.view_anchor_date,");
    // 변경 감지 축은 원장 입력이다(재계산 결과를 비교하면 보존 행이 매번 바뀐 것처럼 보인다).
    expect(flat).toContain("t.ledger_view_anchor_date, t.cycle_id,");
  });

  it("숨김은 이 테이블에 복사하지 않는다 (R3) — 컬럼도 값도 없다", () => {
    expect(flat).not.toMatch(/hidden_reason|hidden_scope/);
    expect(sql).toContain("숨김(R3)은 이 테이블에\n-- 복사하지 않는다");
  });

  it("'오늘' 은 앵커 타임존 기준이다 — current_date 를 직접 쓰지 않는다", () => {
    expect(flat).toContain("hmg_anchor_today()");
    expect(flat).not.toMatch(/\bcurrent_date\b/i);
  });
});

describe("④ R1 확정 = KST — 타임존 상수는 한 곳", () => {
  it("타임존 문자열이 실행 본문에 정확히 한 번만 나오고 그 값이 Asia/Seoul 이다", () => {
    const zones = body.match(/'(UTC|Asia\/Seoul|[A-Z][a-z]+\/[A-Za-z_]+)'/g) ?? [];
    expect(zones).toEqual(["'Asia/Seoul'"]);
    expect(flat).toContain("FUNCTION hmg_anchor_timezone()");
    expect(flat).toMatch(/FUNCTION hmg_anchor_timezone\(\) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS \$fn\$ SELECT 'Asia\/Seoul'::text \$fn\$/);
  });

  it("다른 날짜 함수는 전부 그 상수를 경유한다", () => {
    expect(flat).toContain("(ts AT TIME ZONE hmg_anchor_timezone())::date");
    expect(flat).toContain("SELECT hmg_anchor_date(now())");
    // AT TIME ZONE 의 리터럴 존은 없어야 한다(두 벌 금지).
    expect(flat).not.toMatch(/AT TIME ZONE '/);
  });

  it("뒤집는 법이 파일 머리에 **지금 기본(KST) → UTC** 방향으로 적혀 있다", () => {
    expect(sql).toContain("$fn$ SELECT 'UTC'::text $fn$;");
    expect(sql).not.toContain("$fn$ SELECT 'Asia/Seoul'::text $fn$;");
  });

  it("dry-run SQL 의 zone 상수가 마이그레이션과 같은 값이고 **딱 한 벌**이다", () => {
    const dry = readSourceText(path.resolve(DIR, "../../../scripts/db/answer-cycle-anchors-dryrun.sql"))
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    const zones = dry.match(/'[^']*'::text AS zone/g) ?? [];
    // B12: 종전에는 문장마다 한 벌씩 2벌이었다. prelude 로 모아 1벌이 됐다.
    expect(zones).toEqual(["'Asia/Seoul'::text AS zone"]);
    expect(dry).not.toMatch(/AT TIME ZONE '/);
  });
});

describe("④' 날짜 산술 자가검증 케이스 (KST 기준)", () => {
  it("22:35Z 는 KST 로 다음 날이다", () => {
    expect(flat).toContain(
      "hmg_anchor_date(TIMESTAMPTZ '2026-09-10 22:35:00+00') <> DATE '2026-09-11'",
    );
  });

  it("KST 자정 경계(14:59:59Z / 15:00:00Z)를 양방향으로 잡는다", () => {
    expect(flat).toContain("hmg_anchor_date(TIMESTAMPTZ '2026-08-31 14:59:59+00') <> DATE '2026-08-31'");
    expect(flat).toContain("hmg_anchor_date(TIMESTAMPTZ '2026-08-31 15:00:00+00') <> DATE '2026-09-01'");
  });

  it("UTC 기대값이 남아 있지 않다", () => {
    // 옛 케이스: UTC 였다면 22:35Z 가 같은 날이고 자정 경계가 23:59:59Z 였다.
    expect(flat).not.toContain("'2026-08-31 22:35:00+00') <> DATE '2026-08-31'");
    expect(flat).not.toContain("TIMESTAMPTZ '2026-08-31 23:59:59+00'");
  });

  it("주는 월요일이다", () => {
    expect(flat).toContain("hmg_anchor_week(DATE '2026-09-01') <> DATE '2026-08-31'");
    expect(flat).toContain("date_trunc('week'");
  });

  it("월 귀속은 **달력 월** — 2026-08-31 은 8월이고 목요일 규칙은 지워졌다", () => {
    expect(flat).toContain("hmg_anchor_month(DATE '2026-08-31') <> DATE '2026-08-01'");
    expect(flat).toContain("hmg_anchor_month(DATE '2026-09-01') <> DATE '2026-09-01'");
    expect(flat).toContain("date_trunc('month', d::timestamp)");
    // 철회된 "월요일 + 3 = 목요일" 규칙의 잔재가 없어야 한다.
    expect(flat).not.toContain("hmg_anchor_week(d) + 3");
    expect(flat).not.toContain("hmg_anchor_month(DATE '2026-08-31') <> DATE '2026-09-01'");
  });

  it("시각→날짜→주→월 사슬 두 벌이 KST 기준으로 박혀 있다", () => {
    expect(flat).toContain(
      "hmg_anchor_date(TIMESTAMPTZ '2026-08-31 15:30:00+00') <> DATE '2026-09-01'",
    );
    expect(flat).toContain(
      "hmg_anchor_week(hmg_anchor_date(TIMESTAMPTZ '2026-08-31 15:30:00+00')) <> DATE '2026-08-31'",
    );
    expect(flat).toContain(
      "hmg_anchor_month(hmg_anchor_date(TIMESTAMPTZ '2026-08-31 15:30:00+00')) <> DATE '2026-09-01'",
    );
    expect(flat).toContain(
      "hmg_anchor_week(hmg_anchor_date(TIMESTAMPTZ '2026-09-10 22:35:00+00')) <> DATE '2026-09-07'",
    );
  });

  it("오프셋 가드가 +09:00 을 계산으로 확인한다 (존 이름을 두 번 적지 않는다)", () => {
    expect(flat).toContain(
      "(TIMESTAMPTZ '2026-08-31 15:30:00+00' AT TIME ZONE hmg_anchor_timezone()) = TIMESTAMP '2026-09-01 00:30:00'",
    );
  });

  /**
   * ⚠️ 기대값은 **손으로 계산한 리터럴**이다 — 구현과 같은 상수·같은 산식을 공유하는
   * 헬퍼로 재계산하면 둘이 같이 틀려도 통과한다(렌즈4 지적). KST = UTC+9 고정(서머타임
   * 없음)을 쓰는 곳은 아래 주석의 손계산뿐이고, 코드는 그 결과만 단언한다.
   */
  it("기대값 자체가 달력과 맞는다 (손계산 리터럴)", () => {
    // 2026-09-10T22:35:00Z + 9h = 2026-09-11 07:35 KST → 2026-09-11 (금)
    //   → 그 주 월요일 2026-09-07 → 달력 월 2026-09-01
    const CASE_A = { date: "2026-09-11", week: "2026-09-07", month: "2026-09-01" };
    // 2026-08-31T15:30:00Z + 9h = 2026-09-01 00:30 KST → 2026-09-01 (화)
    //   → 그 주 월요일 2026-08-31 → 달력 월 2026-09-01
    const CASE_B = { date: "2026-09-01", week: "2026-08-31", month: "2026-09-01" };
    // 2026-08-31 은 월요일이고, 달력 월은 **8월**(목요일 규칙이었다면 9월)
    const CASE_C = { date: "2026-08-31", week: "2026-08-31", month: "2026-08-01" };

    // 달력 사실 확인: 요일만 JS 로 본다(월/주 산식은 위 리터럴이 정본).
    const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=일
    expect(dow(CASE_A.date)).toBe(5); // 2026-09-11 금
    expect(dow(CASE_A.week)).toBe(1); // 2026-09-07 월
    expect(dow(CASE_B.date)).toBe(2); // 2026-09-01 화
    expect(dow(CASE_B.week)).toBe(1); // 2026-08-31 월
    expect(dow(CASE_C.date)).toBe(1); // 2026-08-31 월
    // 달력 월 = 날짜의 앞 7자 + "-01". 주와 무관하다는 것이 이 규칙의 전부다.
    for (const c of [CASE_A, CASE_B, CASE_C]) {
      expect(c.month).toBe(`${c.date.slice(0, 7)}-01`);
    }
    // 그리고 그 리터럴들이 실제로 마이그레이션 자가검증에 쓰였다.
    expect(flat).toContain(`<> DATE '${CASE_A.week}'`);
    expect(flat).toContain(`<> DATE '${CASE_C.month}'`);
  });

  it("검산이 실패하면 적용이 중단된다", () => {
    expect(flat).toContain("RAISE EXCEPTION");
  });
});

describe("표면 판정 — website → standard(원장 global) → project", () => {
  it("UNIQUE 없는 scope_project_id 에 조인하지 않고 EXISTS 로 판정한다 (행 복제 금지)", () => {
    expect(flat).not.toMatch(/JOIN website_sites/);
    expect(flat).not.toMatch(/JOIN projects\b/);
    expect(flat).toContain(
      "WHEN EXISTS (SELECT 1 FROM website_sites ws WHERE ws.scope_project_id = rr.project_id::text) THEN 'website'",
    );
  });

  it("standard 는 project 보다 먼저 판정된다 — 루트는 projects 에도 한 행이 있다", () => {
    // 2026-09-19 dry-run 실측: projects 를 먼저 보면 sf_standard 0 · sf_project 277,260.
    const iWeb = flat.indexOf("THEN 'website'");
    const iStd = flat.indexOf("WHEN %2$s THEN 'standard'");
    const iPrj = flat.indexOf("ELSE 'project' END AS surface");
    expect(iWeb).toBeGreaterThan(-1);
    expect(iStd).toBeGreaterThan(iWeb);
    expect(iPrj).toBeGreaterThan(iStd);
    // projects 테이블 소속 여부로 표면을 정하지 않는다(그것이 오분류의 원인이었다).
    expect(flat).not.toMatch(/FROM projects\b/);
    expect(flat).not.toContain("ELSE 'standard'");
  });

  it("B4 — standard 의 근거는 **인자로 받은 루트 id** 이고, NULL 일 때만 원장 폴백이다", () => {
    // 함수 시그니처가 두 인자다. 기본값을 두지 않는다 — 빠뜨린 호출이 드러나야 한다.
    expect(flat).toContain(
      "FUNCTION refresh_answer_cycle_anchors(run_ids uuid[], p_root_project_id uuid)",
    );
    expect(flat).not.toMatch(/p_root_project_id uuid DEFAULT/);
    // $2 가 있으면 그 값이 정본, 없으면 원장 출력 폴백.
    expect(flat).toContain("CASE WHEN $2 IS NOT NULL THEN rr.project_id = $2");
    expect(flat).toContain(
      "ELSE EXISTS (SELECT 1 FROM summary_cycles g WHERE g.project_id = rr.project_id AND g.surface = 'global')",
    );
    expect(flat).toContain("$q$, v_ledger, v_global, v_cycutc) USING v_runs, p_root_project_id;");
    expect(flat).toContain("%1$s WHERE rr.run_id = ANY($1)");
  });

  it("폴백으로 떨어지면 NOTICE 로 드러낸다 (조용히 종전 동작으로 가지 않는다)", () => {
    expect(flat).toContain("IF p_root_project_id IS NULL THEN");
    expect(flat).toContain("RAISE NOTICE 'refresh_answer_cycle_anchors: p_root_project_id 가 NULL");
  });

  it("REVOKE 가 새 시그니처를 가리킨다", () => {
    expect(flat).toContain(
      "REVOKE ALL ON FUNCTION refresh_answer_cycle_anchors(uuid[], uuid) FROM PUBLIC, anon, authenticated;",
    );
    expect(flat).not.toContain("REVOKE ALL ON FUNCTION refresh_answer_cycle_anchors(uuid[]) FROM");
  });

  it("원장 없는 환경에서도 인자가 있으면 standard 가 생긴다 (B4)", () => {
    // to_regclass 가드의 ELSE 분기: 원장 EXISTS 는 못 쓰지만 $2 비교는 쓸 수 있다.
    // 분기 시작점은 원장 없는 환경 전용 더미 관계다(v_global 의 CASE 안 ELSE 와 섞이지 않게).
    const elseAt = flat.indexOf("LEFT JOIN (SELECT NULL::uuid AS run_id");
    const endIf = flat.indexOf("END IF;", elseAt);
    const elseBranch = flat.slice(elseAt, endIf);
    expect(elseAt).toBeGreaterThan(-1);
    expect(elseBranch).toContain("v_global := $q$($2 IS NOT NULL AND rr.project_id = $2)$q$;");
    expect(elseBranch).not.toContain("summary_cycles g");
    // 원장 없는 환경에서는 0053 의 UTC 날짜를 KST 로 옮길 근거도 없다(빈 관계).
    expect(elseBranch).toContain("NULL::timestamptz AS cycle_anchor_at WHERE false");
  });

  it("호출부 둘이 루트 id 를 넘긴다 — 미러 싱크와 백필", () => {
    // N-4: 해소는 `lib/scope/anchor-root.ts` 한 곳이다 — env 를 직접 읽는 사본이 없다.
    // N-14: 경로마다 다르게 쓴다 — 미러 싱크는 죽이지 않고 재계산만 건너뛴다.
    const mirror = readSourceText(path.resolve(DIR, "../repositories/scope-mirror.ts"));
    expect(mirror).toContain('import { resolveAnchorRootProjectId } from "@/lib/scope/anchor-root";');
    expect(mirror).toContain("function anchorRootForMirror()");
    expect(mirror).toContain("rootProjectId: anchorRootForMirror().projectId,");
    expect(mirror).toContain(
      "refresh_answer_cycle_anchors(array[${runId}::uuid], ${rootProjectId}::uuid)",
    );
    const backfill = readSourceText(
      path.resolve(DIR, "../../../scripts/db/backfill-answer-cycle-anchors.ts"),
    );
    // 백필은 원장을 쓰는 경로라 형식 오류를 던진다(N-14).
    expect(backfill).toContain("const ROOT_PROJECT_ID = anchorRootProjectIdOrThrow();");
    expect(backfill).toContain("${ids}::uuid[], ${ROOT_PROJECT_ID}::uuid");
    // 전파 호출부 전부가 같은 해소를 쓴다(env 직독 사본 0).
    for (const rel of [
      "../../../scripts/summary/surface-global.ts",
      "../../../scripts/summary/surface-website.ts",
      "../../../scripts/summary/purge-excluded-cycles.ts",
      "../../../lib/summary/cycle-control.ts",
      "../../../lib/summary/generate/swap.ts",
    ]) {
      const f = readSourceText(path.resolve(DIR, rel));
      expect(f, rel).toContain("anchor-root");
      expect(f, rel).not.toContain("process.env.SCOPE_ROOT_PROJECT_ID ?? null");
    }
  });

  it("SQL 의 'global' 리터럴이 TS 매핑(standard ↔ global)과 같은 값이다", async () => {
    const { toLedgerSurface } = await import("../repositories/scope-answer-anchors");
    expect(flat).toContain(`g.surface = '${toLedgerSurface("standard")}'`);
  });
});

describe("⑤⑥⑦ 규율", () => {
  it("additive-only — 기존 테이블 ALTER·DROP 이 없다", () => {
    expect(flat).not.toMatch(/\bALTER TABLE\b/i);
    expect(flat).not.toMatch(/\bDROP TABLE\b/i);
    expect(flat).not.toMatch(/\bDROP INDEX\b/i);
    // 0053 레지스트리·백업 테이블은 읽기만 한다.
    expect(flat).not.toMatch(/(DELETE FROM|UPDATE)\s+scope_answer_anchors/i);
    expect(flat).not.toContain("_bak_anchor_fold");
    // 미러 원본을 쓰지 않는다(2026-07-21 오염 사고 — 미러가 복구 소스다).
    expect(flat).not.toMatch(/UPDATE\s+scope_answers\b/i);
  });

  it("신규 테이블·함수에 anon/authenticated 권한을 남기지 않는다", () => {
    expect(flat).toContain(
      'REVOKE ALL ON "scope_answer_cycle_anchors" FROM PUBLIC, anon, authenticated;',
    );
    expect(flat).toContain('REVOKE ALL ON "scope_cycle_rounds" FROM PUBLIC, anon, authenticated;');
    for (const fn of [
      "refresh_answer_cycle_anchors(uuid[], uuid)",
      "hmg_assign_cycle_rounds(uuid[], uuid[])",
      "hmg_propagate_cycle_rounds(uuid[], uuid[])",
      "hmg_round_canonical_dow(text)",
      "hmg_round_prev_canonical(date, int)",
      "hmg_round_next_canonical(date, int)",
      "hmg_round_date_of(uuid, date)",
      "hmg_anchor_timezone()",
      "hmg_anchor_date(timestamptz)",
      "hmg_anchor_today()",
      "hmg_anchor_utc_midnight(date)",
      "hmg_anchor_week(date)",
      "hmg_anchor_month(date)",
    ]) {
      expect(flat).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated;`);
    }
  });

  it("DDL 은 카탈로그 선확인 뒤에만 부른다 — IF NOT EXISTS 락 함정", () => {
    // `CREATE … IF NOT EXISTS` 는 no-op 이어도 락을 먼저 잡는다(797초 대기 실측).
    expect(flat).not.toMatch(/CREATE TABLE IF NOT EXISTS/i);
    expect(flat).not.toMatch(/CREATE INDEX IF NOT EXISTS/i);
    expect(flat).toContain("to_regclass('public.scope_answer_cycle_anchors') IS NULL");
    expect(flat).toContain("to_regclass('public.' || r.name) IS NULL");
    expect(flat).toContain("SET LOCAL lock_timeout");
  });

  it("원장(0059) 없는 DB 에서도 함수가 돈다", () => {
    expect(flat).toContain("to_regclass('public.summary_cycle_runs') IS NOT NULL");
  });

  it("인덱스가 귀속 날짜 축으로 서 있다", () => {
    for (const name of [
      "scope_answer_cycle_anchors_rep_idx",
      "scope_answer_cycle_anchors_round_idx",
      "scope_answer_cycle_anchors_surface_round_idx",
      "scope_answer_cycle_anchors_project_date_idx",
      "scope_answer_cycle_anchors_run_idx",
      "scope_answer_cycle_anchors_week_idx",
      "scope_answer_cycle_anchors_cycle_idx",
      "scope_cycle_rounds_seat_idx",
      "scope_cycle_rounds_round_idx",
    ]) {
      expect(flat).toContain(name);
    }
    // 회차 축은 **부분 인덱스**다 — 쓰임이 전부 `cycle_id = <uuid>` 동등 조회라
    // NULL 행(회차 없는 project 표면)을 싣지 않는다. schema.ts 도 같은 술어를 안다.
    expect(flat).toContain(
      "('scope_answer_cycle_anchors_cycle_idx', '(cycle_id) WHERE cycle_id IS NOT NULL')",
    );
    const schema = readSourceText(path.resolve(DIR, "../schema.ts"));
    expect(schema).toContain("scope_answer_cycle_anchors_cycle_idx");
    expect(schema).toContain("`${t.cycleId} IS NOT NULL`");
    // 기간 술어의 주 경로는 **귀속 날짜**다.
    expect(flat).toContain("('scope_answer_cycle_anchors_round_idx', '(round_date, job_id)')");
    // 앵커 날짜 단독 인덱스는 없앴다(매핑 조인은 project_date_idx 가 받는다).
    expect(flat).not.toContain("scope_answer_cycle_anchors_date_idx");
  });
});

describe("⑧ drizzle 저널", () => {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };

  /** 저널에서 0077 항목의 위치. (0078 이 뒤에 붙었으므로 "마지막" 이 아니다.) */
  const at0077 = () =>
    journal.entries.findIndex((e) => e.tag === "0077_scope_answer_cycle_anchors");

  it("0077 항목이 있고 tag 가 파일명과 같다", () => {
    const i = at0077();
    expect(i).toBeGreaterThan(-1);
    expect(fs.existsSync(path.join(DIR, `${journal.entries[i].tag}.sql`))).toBe(true);
  });

  it("0078(hot path 수리)이 0077 바로 뒤에 하루 간격으로 붙는다", () => {
    const i = at0077();
    const next = journal.entries[i + 1];
    expect(next?.tag).toBe("0078_answer_cycle_anchor_hot_path");
    expect(fs.existsSync(path.join(DIR, `${next.tag}.sql`))).toBe(true);
    expect(next.idx - journal.entries[i].idx).toBe(1);
    expect(next.when - journal.entries[i].when).toBe(86_400_000);
  });

  /**
   * B9 — **0074~0076 자리를 비워 둔다.**
   *
   * 파일 번호는 0077 인데 직전 저널 항목은 0073 이다(0074~0076 은 미머지 브랜치
   * `feat/core-view-anchor` 가 쓴다). 그대로 `idx+1 / when+1일` 로 붙이면 그 브랜치가
   * 나중에 머지될 때 **같은 idx·같은 when 을 두 항목이 갖는다.**
   *
   * 그래서 0077 을 `idx+4 / when+4일` 에 두고 **세 칸을 비워 둔다** — 머지 시
   * 양쪽 항목을 그대로 두기만 하면 순서가 이미 맞다.
   *
   * `when` 이 직전 + 86,400,000 의 **배수**여야 하는 이유는 그대로다: 벽시계를 넣으면
   * 단조가 깨져 drizzle 이 조용히 스킵한다. idx 에 구멍이 있어도 `db:check` 는 통과한다
   * (이 저널은 이미 56→58→61 로 구멍이 있고, `db:migrate` 는 이 리포에서 차단돼 있다).
   */
  it("0074~0076 자리(idx 3칸·3일)를 비우고 붙는다", () => {
    const i = at0077();
    const prev = journal.entries[i - 1];
    const last = journal.entries[i];
    expect(prev.tag).toBe("0073_scope_mirror_progress");
    expect(last.idx - prev.idx).toBe(4);
    expect(last.when - prev.when).toBe(4 * 86_400_000);
    // 벽시계가 아니라 하루 단위 배수다.
    expect((last.when - prev.when) % 86_400_000).toBe(0);
  });

  it("전체가 단조 증가한다", () => {
    for (let i = 1; i < journal.entries.length; i += 1) {
      expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });
});

describe("B8 삭제·원복 전파", () => {
  it("그 run 범위에서 더 이상 completed 가 아닌 **비고정** 행만 지운다", () => {
    expect(flat).toContain("DELETE FROM scope_answer_cycle_anchors t WHERE t.run_id = ANY(v_runs)");
    expect(flat).toContain("AND NOT hmg_anchor_is_pinned(t.source)");
    expect(flat).toContain(
      "AND NOT EXISTS (SELECT 1 FROM scope_answers a WHERE a.job_id = t.job_id AND a.status = 'completed')",
    );
  });

  it("고정(pinned) 행은 자동으로 지우지 않는다 (수작업 접기·정렬 보정의 기록)", () => {
    // 삭제 문장이 고정 출처를 포함하는 형태가 없어야 한다.
    expect(flat).not.toMatch(/DELETE FROM scope_answer_cycle_anchors[\s\S]{0,300}?source = 'registry'/);
    expect(sql).toContain("**고정(pinned) 출처는 지우지 않는다**");
  });

  it("지운 행 수를 NOTICE 로 드러낸다 (조용한 삭제 금지)", () => {
    expect(flat).toContain("GET DIAGNOSTICS v_deleted = ROW_COUNT;");
    expect(flat).toContain("RAISE NOTICE 'refresh_answer_cycle_anchors: completed 에서 벗어났거나");
  });

  it("전수 계약이 위에서만 깨지지 않게 한다 — 삭제가 upsert 뒤다", () => {
    const iUpsert = flat.indexOf("ON CONFLICT (job_id) DO UPDATE SET");
    const iDelete = flat.indexOf("DELETE FROM scope_answer_cycle_anchors t");
    expect(iUpsert).toBeGreaterThan(-1);
    expect(iDelete).toBeGreaterThan(iUpsert);
  });
});

describe("정규 요일 귀속 — 회차를 표면의 정규 요일 자리에 앉힌다", () => {
  it("정규 요일 상수는 한 곳뿐이다 (글로벌=월 1 · 웹사이트=금 5 · 프로젝트=없음)", () => {
    expect(flat).toContain("FUNCTION hmg_round_canonical_dow(p_surface text)");
    expect(flat).toContain("SELECT CASE p_surface WHEN 'standard' THEN 1 WHEN 'website' THEN 5 END");
    // 요일 숫자가 다른 SQL 에 또 적혀 있으면 안 된다(dry-run 사본은 prelude 한 곳뿐이고
    // 그 대조는 dry-run 테스트가 한다).
    expect((sql.match(/WHEN 'website' THEN 5/g) ?? [])).toHaveLength(1);
  });

  it("앞 자리·뒤 자리는 **strictly** 앞뒤다 — 자기 날짜를 가리키지 않는다", () => {
    expect(flat).toContain(
      "SELECT d - ((((EXTRACT(ISODOW FROM d)::int - p_dow) + 6) % 7) + 1)",
    );
    expect(flat).toContain(
      "SELECT d + ((((p_dow - EXTRACT(ISODOW FROM d)::int) + 6) % 7) + 1)",
    );
    // 음수 나머지 함정(PG 의 % 는 0 쪽으로 자른다)을 피한 근거가 주석에 있다.
    expect(sql).toContain("(-1) % 7 = -1");
  });

  it("배정 규칙: 빈 자리 우선 → 둘 다 비면 가까운 쪽 → 둘 다 차면 합친다", () => {
    expect(flat).toContain("v_round := v_prev; v_basis := 'prev_empty';");
    expect(flat).toContain("v_round := v_next; v_basis := 'next_empty';");
    expect(flat).toContain(
      "v_basis := CASE WHEN v_prev_taken THEN 'merged' ELSE 'nearest' END;",
    );
    // 동률이면 앞쪽(결정론). 실제로는 앞·뒤 거리의 합이 7 이라 동률이 없다.
    expect(flat).toContain("IF (v_c.anchor_date - v_prev) <= (v_next - v_c.anchor_date) THEN");
  });

  it("2단계다 — 정규 요일 회차를 먼저 전부 앉히고, 비정규를 이른 순으로 차례 배정", () => {
    const fn = flat.slice(flat.indexOf("FUNCTION hmg_assign_cycle_rounds"));
    const phase1 = fn.indexOf("INSERT INTO scope_cycle_rounds");
    const phase2 = fn.indexOf("FOR v_c IN EXECUTE format(");
    expect(phase1).toBeGreaterThan(0);
    expect(phase2).toBeGreaterThan(phase1);
    // 비정규 후보는 (프로젝트, anchor_date) 오름차순이다.
    expect(flat).toContain("ORDER BY 1, 3");
    // 이미 배정된 회차는 후보에서 빠진다(과거 값 안정성).
    expect(flat).toContain("AND NOT EXISTS (SELECT 1 FROM scope_cycle_rounds m");
  });

  it("같은 프로젝트를 두 트랜잭션이 동시에 배정하지 못하게 잠근다", () => {
    expect(flat).toContain("PERFORM pg_advisory_xact_lock(8077, hashtext(v_proj::text));");
    // 교착 회피 — 항상 오름차순으로 전부 먼저 잡는다.
    expect(sql).toContain("오름차순 고정이 교착을 막는다");
  });

  it("범위 인자는 run 축·project 축을 **동적 SQL 로 갈라** 쓴다 (플랜 보호)", () => {
    expect(flat).toContain("v_where := 'c.run_id = ANY($1)';");
    expect(flat).toContain("v_where := 'c.project_id = ANY($2)';");
    expect(flat).toContain("p_run_ids 와 p_project_ids 가 둘 다 NULL 이다");
    // OR 로 합친 형태는 인덱스를 못 탄다 — 남아 있으면 안 된다.
    expect(flat).not.toContain("(p_run_ids IS NULL OR c.run_id");
  });

  it("귀속 날짜는 회차 단위로 한 번만 조회한다 (답변마다 부르지 않는다)", () => {
    expect(flat).toContain(
      "SELECT c.*, hmg_round_date_of(c.project_id, c.anchor_date) AS round_date FROM cyc_res c",
    );
    expect(flat).toContain("FROM ans a JOIN cyc_map c ON c.cycle_key = a.cycle_key");
  });

  it("주·월은 **귀속 날짜 기준**이다 (앵커 날짜가 아니다)", () => {
    expect(flat).toContain("hmg_anchor_week(c.round_date), hmg_anchor_month(c.round_date),");
    expect(flat).toContain(
      "anchor_week = CASE WHEN hmg_anchor_keep_existing(t.source, EXCLUDED.source) THEN hmg_anchor_week(hmg_round_date_of(t.project_id, t.anchor_date))",
    );
  });

  it("재계산이 배정 → 전파 → **단언** 순서로 끝난다 (잠정값이 새지 않는다)", () => {
    const fn = flat.slice(flat.indexOf("FUNCTION refresh_answer_cycle_anchors"));
    const del = fn.indexOf("DELETE FROM scope_answer_cycle_anchors t");
    const asg = fn.indexOf("hmg_assign_cycle_rounds(v_runs, NULL)");
    const prop = fn.indexOf("hmg_propagate_cycle_rounds(v_runs, NULL)");
    const chk = fn.indexOf("귀속 날짜가 매핑과 어긋난 행이");
    // 삭제가 먼저다 — 사라질 회차에 자리를 내주지 않는다.
    expect(del).toBeGreaterThan(0);
    expect(asg).toBeGreaterThan(del);
    expect(prop).toBeGreaterThan(asg);
    expect(chk).toBeGreaterThan(prop);
  });

  it("함대 대표일(최빈값) 규칙과 정렬 백필은 **제거**됐다", () => {
    expect(flat).not.toContain("hmg_refresh_fleet_round_dates");
    expect(flat).not.toContain("fleet_round_date");
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(DIR, "../../../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:align:website-anchors"]).toBeUndefined();
    expect(pkg.scripts["db:reassign:cycle-rounds"]).toContain("reassign-cycle-rounds.ts");
    expect(fs.existsSync(path.resolve(DIR, "../../../scripts/db/align-website-anchor-weeks.ts"))).toBe(
      false,
    );
  });

  // 값 단언(`compile(anchorDateColumnSql(s)).text === "ca.round_date"`)은
  // `repositories/scope-answer-anchors.test.ts` 가 세 표면 전부에 대해 이미 한다.
  // 여기서 보는 것은 **텍스트 계약**뿐이다: 리더가 기간 키로 `anchor_date` 를 쓰지
  // 않고, 컬럼 리터럴을 자기 파일에 또 적지 않고 정본 헬퍼에 위임하는가.
  it("리더는 round_date 를 본다 (달력 축 = 기간 술어 축)", () => {
    const code = readSourceText(path.resolve(DIR, "../repositories/scope-answer-anchors.ts"))
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join("\n");
    // 컬럼 리터럴의 정본은 `lib/period/anchor-axis.ts::anchorRoundDateSql` 한 곳이다.
    expect(code).toContain("anchorRoundDateSql");
    expect(code).not.toContain("fleet_round_date");
    expect(code).not.toContain(".anchor_date");

    const canonical = readSourceText(
      path.resolve(DIR, "../../period/anchor-axis.ts"),
    );
    expect(canonical).toContain('col(alias, "round_date")');
    expect(canonical).not.toContain('col(alias, "anchor_date")');
  });

  it("매핑 표의 basis 어휘가 CHECK 와 배정 함수에서 같다", () => {
    expect(flat).toContain(
      "CHECK (basis IN ('canonical', 'prev_empty', 'next_empty', 'nearest', 'merged', 'project'))",
    );
    for (const b of ["canonical", "prev_empty", "next_empty", "nearest", "merged", "project"]) {
      expect(flat, b).toContain(`'${b}'`);
    }
  });

  it("schema.ts 가 매핑 표와 round_date 를 안다 (db:drift 기준선)", () => {
    const schema = readSourceText(path.resolve(DIR, "../schema.ts"));
    expect(schema).toContain('pgTable(\n  "scope_cycle_rounds"');
    expect(schema).toContain('roundDate: date("round_date", { mode: "string" }).notNull()');
    expect(schema).not.toContain("fleet_round_date");
  });

  it("감사 SQL 이 귀속 불변식 넷을 본다", () => {
    const audit = readSourceText(
      path.resolve(DIR, "../../../scripts/db/answer-cycle-anchors-audit.sql"),
    );
    for (const k of [
      "off_canonical_round_date",
      "round_date_drift",
      "merged_seats",
      "orphan_round_rows",
      "basis/",
    ]) {
      expect(audit, k).toContain(k);
    }
    expect(audit).not.toContain("fleet_round_date_filled");
  });
});
