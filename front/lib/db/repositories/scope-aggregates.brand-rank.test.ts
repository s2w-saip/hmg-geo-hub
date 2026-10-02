import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { writeFileSync } from "node:fs";

// ④ 우선노출도 = 브랜드 내 순위 (2026-09-06) — SQL 조각의 계약을 고정한다.
//  ① 순위는 답변(job) 안에서 rank() 로 매긴다 — 저장된 avg_position 을 그대로 평균하지 않는다.
//  ② 모집단은 언급 탭과 같다: rollup 보유 + 비경쟁(NON_COMPETITOR) 제외.
//  ③ 자사(tracked) 행만 반환하고, 자사 무순위 답변은 행이 없다(종전 "미랭크 제외" 유지).
//  ④ 소비처 4곳(④ 카드·Sub-KPI·추이·언급 탭)이 같은 rank() 문장을 쓴다.

const dialect = new PgDialect();
const compile = (w: SQL) => dialect.sqlToQuery(w);

const execute = vi.fn(async () => []);
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));

describe("ownBrandRankPerJobSql", () => {
  it("답변 안 rank() + 비경쟁 제외 + tracked 필터로 (job_id, rk) 를 낸다", async () => {
    const mod = await import("./scope-aggregates");
    const q = compile(mod.ownBrandRankPerJobSql({}));
    expect(q.sql).toContain("rank() OVER (PARTITION BY job_id ORDER BY tp)");
    expect(q.sql).toContain("m.brand_rollup_entity_id IS NOT NULL");
    expect(q.sql).toContain("m.avg_position IS NOT NULL");
    expect(q.sql).toContain("NOT IN (");
    expect(q.sql).toContain("WHERE is_trk GROUP BY job_id");
    expect(q.sql).toContain("JOIN _answer_set a ON a.job_id = m.job_id");
    // 비경쟁 목록이 실제로 바인드됐는지 — 빈 목록이면 노이즈가 그대로 순위를 민다.
    expect(q.params).toContain("modern");
    expect(q.params).toContain("vehicle".length > 0 ? "across" : "");
  });

  it("(도구) 패리티용 SQL 을 파일로 남긴다 — 미러에서 직접 실행해 시뮬레이션과 대조", async () => {
    const out = process.env.BRAND_RANK_SQL_OUT;
    if (!out) return;
    const mod = await import("./scope-aggregates");
    const { sql } = await import("drizzle-orm");
    const q = compile(sql`
      WITH _answer_set AS (
        SELECT s.job_id, s.measured_at::date AS d,
          CASE WHEN s.region IN ('AE','BE','BR','CA','DE','EG','FR','KR','US') THEN 'orig9' ELSE 'new36' END AS grp
        FROM scope_answers s JOIN scope_runs r ON r.run_id = s.run_id
        WHERE r.project_id = 'be28fe15-c743-4a88-abb8-182b25602812' AND s.status = 'completed'
          AND s.measured_at::date IN ('2026-08-11','2026-08-18','2026-08-25','2026-08-31')
      )
      SELECT a.d, a.grp, count(r.rk) AS sampled, round(avg(r.rk)::numeric, 2) AS brand_rank_avg,
        round(100.0 * count(*) FILTER (WHERE r.rk = 1) / NULLIF(count(r.rk), 0), 1) AS rank1_pct,
        round(100.0 * count(*) FILTER (WHERE r.rk <= 3) / NULLIF(count(r.rk), 0), 1) AS top3_pct
      FROM _answer_set a LEFT JOIN ${mod.ownBrandRankPerJobSql({})} r ON r.job_id = a.job_id
      GROUP BY 1, 2 ORDER BY 1, 2
    `);
    // $n → 리터럴 인라인 (문자열만 — 이 조각의 파라미터는 전부 문자열/uuid).
    const inlined = q.sql.replace(/\$(\d+)/g, (_, n) => {
      const v = q.params[Number(n) - 1];
      return "'" + String(v).replace(/'/g, "''") + "'";
    });
    writeFileSync(out, inlined);
  });
});
