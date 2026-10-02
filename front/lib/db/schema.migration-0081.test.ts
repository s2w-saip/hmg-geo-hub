/**
 * 0081(자사·타겟 URL 인용률 사실표 2개)의 형태를 고정하는 오프라인 테스트(DB 접속 없음).
 * 0080 테스트와 같은 자세다. 실행 확인(2회 적용·제약)은 `summary-url-hits.pglite.test.ts`.
 *
 * 고유한 위험:
 *   · 기존 표를 ALTER 하면 additive-only 규율이 깨진다: 특히 `summary_answers` 는 파티션
 *     부모라 ACCESS EXCLUSIVE 가 라이브 조회와 경합한다(0007 prod 장애 계열).
 *   · 원장 표가 없으면 리더가 "행이 반쯤 적재된 generation" 을 구분할 수 없다.
 *   · REVOKE 를 빼면 신규 표가 anon 에 열린다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationStatements } from "../../scripts/db/answer-cycle-anchors-pglite-fixture";

const REPO = path.resolve(__dirname, "../..");
const FILE = path.join(REPO, "lib/db/migrations/0081_summary_url_hits.sql");
const raw = fs.readFileSync(FILE, "utf8");
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0081: 자사·타겟 URL 인용률 사실표", () => {
  it("tx 안에서 돌고 lock_timeout·tx 가드가 첫 DDL 앞에 있다", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(sql.split(";")[0]).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'/i);
    const iGuard = sql.search(/current_setting\('lock_timeout'\)/);
    expect(iGuard).toBeGreaterThan(0);
    expect(sql.search(/CREATE TABLE/i)).toBeGreaterThan(iGuard);
  });

  it("멱등: 신규 표·인덱스는 IF NOT EXISTS", () => {
    const creates = [...sql.matchAll(/CREATE\s+(TABLE|INDEX)\s+(\S+)/gi)];
    expect(creates.length).toBe(4);
    for (const m of creates) expect(m[2].toUpperCase(), m[0]).toBe("IF");
  });

  it("additive-only: ALTER·DROP·TRUNCATE·DELETE·UPDATE 가 없다", () => {
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+\w/i);
  });

  it("job 표의 키는 (generation, job): 리더 조인·옛 generation 정리가 그 위에 선다", () => {
    expect(sql).toMatch(/PRIMARY KEY \("generation_id", "job_id"\)/);
    expect(sql).toMatch(/ON "summary_url_hits" \("cycle_id", "generation_id"\)/);
  });

  it("판정 불변식을 표가 막는다: 타겟 ⊂ 자사 · 미등록은 분자 밖", () => {
    expect(sql).toMatch(/CHECK \(NOT "target_hit" OR "owned_hit"\)/);
    expect(sql).toMatch(/CHECK \("registered" OR NOT "owned_hit"\)/);
  });

  it("신규 표 REVOKE: anon/authenticated 차단 2표 전부", () => {
    for (const t of ["summary_url_hits", "summary_url_hit_generations"]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON "${t}" FROM PUBLIC, anon, authenticated`));
    }
  });

  it("문장 분리기가 모든 문장을 낸다 (breakpoint 누락 시 한 문장으로 붙는다)", () => {
    // SET · DO · CREATE×4 (REVOKE 는 pglite 용 분리기가 뺀다)
    expect(migrationStatements(raw)).toHaveLength(6);
  });

  it("저널이 0080 바로 뒤에 하루 간격으로 붙는다 (벽시계를 넣으면 drizzle 이 조용히 스킵한다)", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(REPO, "lib/db/migrations/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const i = journal.entries.findIndex((e) => e.tag === "0080_report_publications");
    expect(i).toBeGreaterThan(-1);
    const next = journal.entries[i + 1];
    expect(next?.tag).toBe("0081_summary_url_hits");
    expect(next.idx - journal.entries[i].idx).toBe(1);
    expect(next.when - journal.entries[i].when).toBe(86_400_000);
  });
});
