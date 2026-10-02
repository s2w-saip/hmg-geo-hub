/**
 * **원장 → 앵커 테이블 전파 배선** (스펙 §4 · §9 "전파" · B2).
 *
 * 렌즈4·CLEANUP-PLAN B2 의 지적: `refresh_answer_cycle_anchors` 의 비테스트 호출이
 * 미러 재싱크와 백필뿐이라, 회차 마감·노출일 지정·귀속 변경이 테이블에 반영되지
 * 않았다. 순수 함수만 보면 "호출하는 줄을 통째로 지우는" 회귀를 하나도 못 잡으므로,
 * **호출부가 존재하는지**를 소스 대조로 고정한다(0053 배선 테스트와 같은 자세).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const dialect = new PgDialect();
const compile = (q: SQL) => {
  const c = dialect.sqlToQuery(q);
  return { text: c.sql.replace(/\s+/g, " ").trim(), params: c.params };
};

const RUN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CYCLE = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ROOT_ID = "be28fe15-c743-4a88-abb8-182b25602812";

describe("전파 SQL 빌더", () => {
  it("run 집합 — 배열 바인드 하나 + 루트 id 바인드 하나", async () => {
    const { refreshAnchorsForRunsSql } = await import("./scope-answer-anchors");
    const q = refreshAnchorsForRunsSql([RUN_A, RUN_B], ROOT_ID);
    expect(q).not.toBeNull();
    const { text, params } = compile(q as SQL);
    expect(text).toBe(
      "SELECT refresh_answer_cycle_anchors($1::uuid[], $2::uuid)",
    );
    expect(params).toEqual([[RUN_A, RUN_B], ROOT_ID]);
  });

  it("run 이 비면 null — 문장을 발행하지 않는다", async () => {
    const { refreshAnchorsForRunsSql } = await import("./scope-answer-anchors");
    expect(refreshAnchorsForRunsSql([], ROOT_ID)).toBeNull();
  });

  it("회차 단위 — run 목록을 앱으로 왕복시키지 않고 서브쿼리로 넘긴다", async () => {
    const { refreshAnchorsForCycleSql } = await import("./scope-answer-anchors");
    const { text, params } = compile(refreshAnchorsForCycleSql(CYCLE, null));
    expect(text).toContain("ARRAY(SELECT run_id FROM summary_cycle_runs WHERE cycle_id = $1::uuid)");
    expect(params).toEqual([CYCLE, null]);
  });

  it("루트 id 를 SQL 텍스트에 인라인하지 않는다", async () => {
    const { refreshAnchorsForRunsSql } = await import("./scope-answer-anchors");
    const { text } = compile(refreshAnchorsForRunsSql([RUN_A], ROOT_ID) as SQL);
    expect(text).not.toContain(ROOT_ID);
  });
});

/**
 * 호출부 인벤토리. 각 항목은 **그 파일이 원장의 무엇을 쓰는가**와 짝이다.
 * 새 원장 쓰기 경로를 추가하면서 전파를 빼면 여기가 깨져야 한다.
 */
describe("원장을 쓰는 코드 경로마다 전파 호출이 있다", () => {
  const cases: Array<{ file: string; writes: string; marker: string }> = [
    {
      // 관제: 귀속(summary_cycle_runs INSERT) + 회차 열기·종결.
      file: "lib/db/repositories/summary-cycles.ts",
      writes: "INSERT INTO summary_cycle_runs",
      marker: "refreshAnchorsForRunsSql(attributedRuns",
    },
    {
      // 스왑: `view_anchor_at` 을 쓰는 **유일한** 경로.
      file: "lib/summary/generate/swap.ts",
      writes: "view_anchor_at = COALESCE(",
      marker: "refreshAnchorsForCycleSql(cycleId",
    },
    {
      // 생성기 글로벌 표면: 재귀속(ON CONFLICT DO UPDATE SET cycle_id).
      file: "scripts/summary/surface-global.ts",
      writes: "upsertCycleRunsSql(cycleId, runIds)",
      marker: "refreshAnchorsForRunsSql(runIds",
    },
    {
      // 생성기 웹사이트 표면: 같은 재귀속 경로.
      file: "scripts/summary/surface-website.ts",
      writes: "upsertCycleRunsSql(cycleId, p.runs)",
      marker: "refreshAnchorsForRunsSql(p.runs",
    },
    {
      // 원장 삭제: 회차·귀속이 통째로 사라진다.
      file: "scripts/summary/purge-excluded-cycles.ts",
      writes: "DELETE FROM ${sql.raw(t)} WHERE cycle_id",
      marker: "refreshAnchorsForRunsSql(affectedRunIds",
    },
  ];

  for (const c of cases) {
    it(`${c.file} — ${c.writes}`, () => {
      const src = read(c.file);
      expect(src).toContain(c.writes); // 전제: 그 경로가 아직 원장을 쓴다
      expect(src).toContain(c.marker); // 결론: 전파 호출이 있다
      // capability 프로브 뒤에서만 발행한다(0077 미적용 배포 내성).
      expect(src).toContain("answerCycleAnchorsWritable");
      expect(src).toMatch(/if \(anchorsWritable\)/);
    });
  }

  it("전파 호출은 전부 capability 프로브를 **트랜잭션 밖에서** 확정한다", () => {
    for (const c of cases) {
      const src = read(c.file);
      const iProbe = src.indexOf("await answerCycleAnchorsWritable()");
      const iUse = src.indexOf("if (anchorsWritable)");
      expect(iProbe).toBeGreaterThan(-1);
      expect(iUse).toBeGreaterThan(iProbe);
    }
  });
});

describe("전파하지 않는 경로 — 의도적으로 뺀 것들", () => {
  it("숨김(hide-cycle)은 전파 대상이 아니다 — 리더가 조인한다(R3)", () => {
    const src = read("scripts/summary/hide-cycle.ts");
    expect(src).toContain("hidden_reason"); // 전제: 여전히 숨김을 쓴다
    expect(src).not.toContain("refresh_answer_cycle_anchors");
    expect(src).not.toContain("refreshAnchorsFor");
  });

  it("앵커 이동 경로는 리포에 없다 — UPDATE … SET cycle_anchor_at 0건", () => {
    // 있으면 전파 인벤토리에 항목이 하나 더 필요하다(스펙 §4).
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|sql)$/.test(e.name) && !e.name.includes(".test.")) files.push(rel);
      }
    };
    walk("lib");
    walk("scripts");
    // ⚠️ `\b` 가 필요하다 — 없으면 **접미가 같은 다른 컬럼**까지 잡는다.
    // 0078 의 회차 상태 표에는 `run_cycle_anchor_at`(회차 키의 **사본**. 앵커의
    // 정본이 아니다)이 있고, 경계 없는 정규식은 그 upsert 를 앵커 이동으로 오인했다.
    const hits = files.filter((f) =>
      /UPDATE[\s\S]{0,400}?SET[\s\S]{0,200}?\bcycle_anchor_at\s*=/i.test(read(f)),
    );
    expect(hits).toEqual([]);
  });
});

describe("야간 정합 감사 SQL", () => {
  const audit = read("scripts/db/answer-cycle-anchors-audit.sql");

  it("읽기 전용이다 — 쓰기·DDL 키워드가 없다", () => {
    const body = audit
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|DO)\b/i);
    expect(body).not.toMatch(/\bFOR UPDATE\b/i);
  });

  it("불일치·고아·누락을 모두 센다", () => {
    for (const k of [
      "view_anchor_drift",
      "ledger_anchor_drift",
      "attribution_drift",
      "run_anchor_drift",
      "missing_rows",
      "orphan_rows",
      "stale_status_rows",
      "derived_key_drift",
    ]) {
      expect(audit).toContain(`'${k}'`);
    }
  });

  it("회차 단위 상속의 불변식을 센다 (스펙 §3.1)", () => {
    // 같은 회차의 답변이 서로 다른 anchor_date 를 가지면 상속이 깨진 것이다(긴급).
    expect(audit).toContain("'cycle_anchor_split'");
    const row = audit.split("\n").find((l) => l.includes("'cycle_anchor_split'")) ?? "";
    expect(row).toContain("THEN 2");
    // 고정 출처(수작업 접기·정렬 보정)로 의도적으로 다른 행은 뺀다.
    expect(audit).toContain("AND NOT hmg_anchor_is_pinned(c.source)");
    // 한 (프로젝트, KST 주)에 앵커 날짜는 하나여야 한다.
    expect(audit).toContain("'project_week_split'");
  });

  it("등급이 이 리포 관례(0/1/2)이고 긴급은 전파 누락 계열이다", () => {
    expect(audit).toContain("severity");
    for (const k of ["view_anchor_drift", "ledger_anchor_drift", "attribution_drift", "missing_rows"]) {
      const row = audit.split("\n").find((l) => l.includes(`'${k}'`)) ?? "";
      expect(row).toContain("THEN 2");
    }
  });

  it("스케줄·알림 배선이 범위 밖임을 스스로 적고 목적지를 지정한다", () => {
    expect(audit).toContain("이번 범위 밖");
    expect(audit).toContain("GitHub Issue");
  });

  it("고정(pinned) 행을 자동 삭제 대상으로 세지 않는다", () => {
    expect(audit).toContain("orphan_rows_pinned");
    expect(audit).toContain("지우지 않고 표면화만 한다");
    // 고정 출처는 registry 하나뿐이고, 판정은 함수 한 곳에서만 한다.
    expect(audit).toContain("hmg_anchor_is_pinned(c.source)");
  });

  it("N-1 노출일 정합 점검이 있고 긴급 등급이다", () => {
    expect(audit).toContain("'view_date_drift'");
    const row = audit.split("\n").find((l) => l.includes("'view_date_drift'")) ?? "";
    expect(row).toContain("THEN 2");
    expect(audit).toContain("hmg_anchor_view_date(c.surface, c.anchor_date, c.ledger_view_anchor_date)");
  });
});
