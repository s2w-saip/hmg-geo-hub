/**
 * 0072(답변 단위 브랜드 스탠스 미러 — `scope_answer_stances`)의 형태를 고정하는
 * 오프라인 테스트. 0070·0071 테스트와 같은 자세다(DB 접속 없음).
 *
 * 0072 에 고유한 위험은 넷:
 *   · **PK 에 turn 축이 빠지면** 멀티턴 답변의 두 번째 턴 스탠스가 첫 턴을 덮는다.
 *     조용히 사라지고, 발생 축과 대조하기 전에는 아무도 모른다.
 *   · **드롭 레지스트리(0054)에 등재하지 않으면** 드롭된 job 의 스탠스가 고아로 남고
 *     재싱크가 그것을 되살리지도 지우지도 못한다(앵커 2026-08-31 원복 사고 형태).
 *   · **0054 의 기존 삭제 3개를 잃으면** 드롭 자체가 깨진다 — CREATE OR REPLACE 라
 *     본문을 통째로 덮어쓰기 때문이다. 세 DELETE 가 그대로 있는지 단언한다.
 *   · **REVOKE 를 빼면** 신규 테이블이 anon 에 열린 채로 남는다(RLS 없는 리포의
 *     보상통제는 lockdown 뿐이고, 신규 테이블은 그 파일 재실행 전까지 무방비다).
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceText } from "@/test/source-text";

const REPO = path.resolve(__dirname, "../..");
const FILE = path.join(REPO, "lib/db/migrations/0072_scope_answer_stances.sql");

const raw = readSourceText(FILE);
/** `--` 줄 주석 제거 — 검증·롤백 안내문이 규율 검사에 걸리지 않게. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0072 — 답변 단위 브랜드 스탠스 미러", () => {
  it("tx 안에서 돌 수 있고 lock_timeout·tx 가드가 첫 DDL 앞에 있다", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(sql.split(";")[0]).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'/i);
    expect(sql).toMatch(/current_setting\('lock_timeout'\)\s*<>\s*'5s'/);

    const iGuard = sql.search(/current_setting\('lock_timeout'\)/);
    const iDdl = sql.search(/CREATE TABLE/i);
    expect(iGuard).toBeGreaterThan(0);
    expect(iDdl).toBeGreaterThan(iGuard);
  });

  it("멱등 — 신규 테이블은 IF NOT EXISTS, 함수는 CREATE OR REPLACE", () => {
    // 신규 테이블은 `IF NOT EXISTS` 가 맞다(존재하지 않는 객체라 잡을 락이 없다).
    // 기존 테이블 ALTER 의 `IF NOT EXISTS` 금지 규율과 혼동하지 말 것.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "scope_answer_stances"/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION scope_answer_drop_apply\(p_run_id uuid\)/);
  });

  it("additive-only — 기존 테이블 ALTER·DROP·TRUNCATE 가 실행 경로에 없다", () => {
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|FUNCTION)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("PK 는 (job_id, turn_index, entity_id) — turn 축이 빠지면 턴이 서로를 덮는다", () => {
    expect(sql).toMatch(/PRIMARY KEY \("job_id", "turn_index", "entity_id"\)/);
    // turn_index 는 PK 구성요소라 NOT NULL + 기본 0(코어가 안 실을 수 있다).
    expect(sql).toMatch(/"turn_index" integer DEFAULT 0 NOT NULL/);
  });

  it("evidence 오프셋 두 컬럼이 함께 있다 — 한쪽만 두면 '원문 대조됨'을 판정할 수 없다", () => {
    expect(sql).toMatch(/"evidence_start" integer/);
    expect(sql).toMatch(/"evidence_end" integer/);
    expect(sql).toMatch(/"evidence_text" text/);
  });

  it("신규 테이블 REVOKE — anon/authenticated 차단", () => {
    expect(sql).toMatch(/REVOKE ALL ON "scope_answer_stances" FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION scope_answer_drop_apply\(uuid\) FROM PUBLIC, anon, authenticated/,
    );
  });

  it("드롭 레지스트리에 등재 — 스탠스가 **먼저**, 0054 의 삭제 3개는 그대로", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION"), sql.indexOf("$fn$;"));
    const iStance = fn.indexOf("DELETE FROM scope_answer_stances");
    const iCit = fn.indexOf("DELETE FROM scope_citations");
    const iMen = fn.indexOf("DELETE FROM scope_mentions");
    const iAns = fn.indexOf("DELETE FROM scope_answers a\n   USING scope_answer_drops");
    expect(iStance).toBeGreaterThan(-1);
    expect(iCit).toBeGreaterThan(iStance);
    expect(iMen).toBeGreaterThan(iCit);
    // answers 는 언제나 **마지막** — 먼저 지우면 자식 행을 좁힐 근거(run_id)가 사라진다.
    expect(iAns).toBeGreaterThan(iMen);
    // 반환값(감사용 answers 행수) 계약도 유지된다.
    expect(fn).toContain("GET DIAGNOSTICS n = ROW_COUNT");
  });

  it("schema.ts 의 테이블 정의와 컬럼 집합이 일치한다", () => {
    const schema = readSourceText(path.join(REPO, "lib/db/schema.ts"));
    const block = schema.slice(
      schema.indexOf('export const scopeAnswerStances = pgTable('),
      schema.indexOf("export type ScopeAnswerStanceRow"),
    );
    expect(block.length).toBeGreaterThan(200);
    for (const col of [
      "job_id",
      "turn_index",
      "entity_id",
      "brand_label",
      "is_tracked",
      "stance",
      "confidence",
      "evidence_text",
      "evidence_start",
      "evidence_end",
      "reason",
      "model_slug",
    ]) {
      expect(block).toContain(`"${col}"`);
      expect(sql).toContain(`"${col}"`);
    }
    expect(block).toContain('primaryKey({ columns: [t.jobId, t.turnIndex, t.entityId] })');
  });
});
