// G2e A/B 덤프 하네스 — **실제 빌더가 낸 텍스트**를 파일로 떨군다 (2026-09-20).
//
// 손으로 쓴 근사로 EXPLAIN 을 재면 그 계획은 제품이 내는 계획이 아니다. 그래서
// `scripts/db/dump-g2e-sql.ts` 가 `answerWhere`·`trendDimJoinSql`·`anchorJoinSql` 에서
// 뽑고, 이 테스트가 그 산출물의 성질을 단언한 뒤 스크래치패드로 떨군다.
//
// ⚠️ 출력 디렉터리는 리포 **밖**이라 CI 에는 없다 — 없으면 쓰기만 건너뛴다(단언은 돈다).
import { describe, expect, it } from "vitest";
import { buildG2eStatements, writeG2eStatements } from "@/scripts/db/dump-g2e-sql";

describe("G2e A/B/C — 빌더가 낸 세 문장", () => {
  const dumps = buildG2eStatements();
  const body = (n: string) => dumps.find((d) => d.name.startsWith(n))?.body ?? "";

  it("세 파일이 나온다 (C 는 비용 귀속용 진단 문장)", () => {
    expect(dumps.map((d) => d.name).sort()).toEqual([
      "G2e-A-current.sql",
      "G2e-B-dim.sql",
      "G2e-C-gate-only.sql",
    ]);
  });

  it("A 는 **수리 전** 형태다 — dim 조인도 dim 술어도 없다", () => {
    const a = body("G2e-A");
    expect(a).not.toContain("summary_prompt_dim");
    expect(a).not.toContain("d.in_root_catalog");
    // 현재값 술어는 그대로 있다(카탈로그 게이트는 바깥 `prompts` 서브쿼리).
    expect(a).toContain("SELECT scope_prompt_id FROM prompts");
  });

  it("B 는 dim 파생표를 **FROM 에** 걸고 술어는 WHERE 에 둔다 (semi-join 없음)", () => {
    const b = body("G2e-B");
    expect(b).toContain("LEFT JOIN (");
    expect(b).toContain("summary_prompt_dim pd");
    expect(b).toContain(") d ON d.cycle_id = ca.cycle_id AND d.prompt_id = a.prompt_id");
    expect(b).toContain("CASE WHEN d.prompt_id IS NOT NULL THEN");
    // 4차 수리의 핵심: 바깥 조인을 한 번 더 하는 semi-join 이 **없어야** 한다.
    expect(b).not.toContain("FROM scope_answers a2");
    expect(b).not.toContain("dim_small AS MATERIALIZED");
  });

  // 5차 — 함대 게이트도 조인 판본이어야 한다. 실측에서 이 조각이 순증의 1.06초였다
  // (앵커 표 재스캔 `ca_1` loops=187,233 + 상관 EXISTS `sc_1` 같은 수).
  it("B 에 **두 번째 앵커 조인**이 없다 (함대 게이트 semi-join 제거)", () => {
    const b = body("G2e-B");
    expect(b).toContain("SELECT sc2.cycle_id");
    expect(b).toContain(") sv ON sv.cycle_id = ca.cycle_id");
    expect(b).toContain("(ca.surface = 'project' OR sv.cycle_id IS NOT NULL)");
    // 앵커 표를 다시 찌르는 semi-join·상관 EXISTS 가 남아 있으면 안 된다.
    expect(b).not.toContain("FROM scope_answer_cycle_anchors ca WHERE");
    expect(b).not.toContain("EXISTS (\n    SELECT 1 FROM summary_cycles sc\n");
  });

  it("C 는 게이트만 켠 진단 문장이다 (dim 술어·조인 없음)", () => {
    const c = body("G2e-C");
    expect(c).toContain(") sv ON sv.cycle_id = ca.cycle_id");
    expect(c).toContain("(ca.surface = 'project' OR sv.cycle_id IS NOT NULL)");
    expect(c).not.toContain("summary_prompt_dim");
    expect(c).not.toContain("d.in_root_catalog");
  });

  it("둘 다 단일 문장·바인드 없음·EXPLAIN 머리", () => {
    for (const d of dumps) {
      expect(d.body, d.name).toContain("EXPLAIN (ANALYZE, BUFFERS)");
      expect(d.body, d.name).not.toMatch(/\$\d/);
      expect(d.body.replace(/^--.*$/gm, "").trim(), d.name).not.toContain(";");
    }
  });

  it("uuid 리터럴에 ::uuid 캐스트가 붙어 있다", () => {
    const bare = /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'(?!::uuid)/i;
    for (const d of dumps) expect(bare.test(d.body), d.name).toBe(false);
  });

  // ⚠️ 기본은 **아무것도 안 쓴다**. `G2E_DUMP_DIR=<경로>` 를 준 실행에서만 떨군다 —
  //    종전에는 `npm test` 마다 리포 밖 3파일을 말없이 덮어썼다(검증자 주의 2).
  it("env 가 없으면 파일을 쓰지 않는다", () => {
    const saved = process.env.G2E_DUMP_DIR;
    delete process.env.G2E_DUMP_DIR;
    expect(writeG2eStatements()).toBe(false);
    if (saved !== undefined) process.env.G2E_DUMP_DIR = saved;
  });

  it("`G2E_DUMP_DIR` 이 있으면 떨군다", () => {
    if (!process.env.G2E_DUMP_DIR) return; // 평소 실행에서는 건너뛴다
    expect(writeG2eStatements()).toBe(true);
  });
});
