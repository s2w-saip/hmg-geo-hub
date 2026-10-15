/**
 * 0067(세부층 `report_fs` · 집계층 `own_negative`)의 **형태**를 고정하는 오프라인 테스트.
 *
 * 0065·0066 테스트와 같은 자세다. 0067 에 고유한 위험은 둘:
 *   · 세부층 `report_fs` 에 **DEFAULT 를 붙이면** 기존 웹사이트 54,760행이 틀린 0 으로 굳는다.
 *     "NULL 로 둔다" 가 값 규약의 핵심이라 테스트가 그것을 못 박는다.
 *   · 셋째 항목(인덱스 DROP)은 재실측에서 전제가 뒤집혀 **하지 않기로** 했다.
 *     나중에 누가 "정리 안 했네" 하고 다시 넣지 않도록, **DROP 이 없다**를 단언한다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceText } from "@/test/source-text";

const REPO = path.resolve(__dirname, "../..");
const MIG_DIR = path.join(REPO, "lib/db/migrations");
const FILE = path.join(MIG_DIR, "0067_summary_detail_report_fs.sql");

const raw = readSourceText(FILE);
/** `--` 줄 주석 제거 — 백필·롤백 안내문이 규율 검사에 걸리지 않게. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0067 — PR③ 위생", () => {
  it("tx 안에서 돌 수 있고 lock_timeout·tx 가드가 첫 DDL 앞에 있다", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(sql.split(";")[0]).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'3s'/i);
    expect(sql).toMatch(/current_setting\('lock_timeout'\)\s*<>\s*'3s'/);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,120}트랜잭션 블록 밖에서 적용 중/);

    const iGuard = sql.search(/current_setting\('lock_timeout'\)/);
    const iDdl = sql.search(/ADD COLUMN/i);
    expect(iGuard).toBeGreaterThan(0);
    expect(iDdl).toBeGreaterThan(iGuard);
  });

  it("`IF NOT EXISTS` 를 쓰지 않는다 — 락을 먼저 잡기 때문", () => {
    expect(sql).not.toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i);
    expect(sql).toMatch(/to_regclass/);
    expect(sql).toMatch(/pg_attribute/);
  });

  it("additive-only — DROP·TRUNCATE·UPDATE 가 실행 경로에 하나도 없다", () => {
    // 0066 은 PK 재작성 때문에 DROP CONSTRAINT 예외가 있었다. 0067 은 예외가 없다.
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|STATISTICS|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    // 백필은 이 파일 밖이다 — DDL 과 대량 DML 을 한 tx 에 섞지 않는다.
    expect(sql).not.toMatch(/^\s*UPDATE\s+summary_/im);
  });

  it("세부층 report_fs 는 **DEFAULT 없이** nullable int 로 붙는다", () => {
    // ⚠️ 이 파일에서 제일 중요한 단언. `NOT NULL DEFAULT 0` 을 붙이면 기존 웹사이트
    //    54,760행이 조용히 0 이 되어 유닛 게이트가 통째로 틀린다(되돌릴 근거도 사라진다).
    expect(sql).toMatch(
      /ALTER TABLE public\.summary_domain_citations ADD COLUMN report_fs int\b/,
    );
    const stmt = /ALTER TABLE public\.summary_domain_citations ADD COLUMN report_fs[^']*/.exec(sql)![0];
    expect(stmt, "세부층 report_fs 에 DEFAULT 가 붙었다").not.toMatch(/DEFAULT/i);
    expect(stmt, "세부층 report_fs 에 NOT NULL 이 붙었다").not.toMatch(/NOT NULL/i);
    // 규약 근거(정본이 nullable · 기존 행이 틀린 0 이 된다)가 파일에 남아야 한다.
    expect(raw).toMatch(/integer NULL/);
    expect(raw).toMatch(/54,760/);
    const c = /COMMENT ON COLUMN summary_domain_citations\.report_fs IS[\s\S]*?;/.exec(raw)?.[0] ?? "";
    expect(c).toMatch(/글로벌은 NULL/);
    expect(c).toMatch(/COALESCE/);
  });

  it("집계층 own_negative 는 0065·0066 규약대로 NOT NULL DEFAULT 0 이다", () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.summary_trend_own ADD COLUMN own_negative int NOT NULL DEFAULT 0/,
    );
    // 표를 잘못 고르면 조용히 틀린다 — own 에만 붙는다.
    for (const t of ["summary_trend_answers", "summary_trend_brands", "summary_trend_domains"]) {
      expect(sql, `${t} 에 own_negative 가 붙었다`).not.toMatch(
        new RegExp(`ALTER TABLE public\\.${t} ADD COLUMN own_negative`),
      );
    }
    const c = /COMMENT ON COLUMN summary_trend_own\.own_negative IS[\s\S]*?;/.exec(raw)?.[0] ?? "";
    expect(c).toMatch(/own_signals/); // 부분합이라는 가산성 근거
    expect(c).toMatch(/negativeMentions/);
  });

  it("두 컬럼 다 카탈로그 선확인 뒤에만 ALTER 한다 (멱등)", () => {
    for (const col of ["report_fs", "own_negative"]) {
      expect(sql, `${col} 선확인 없음`).toMatch(
        new RegExp(`attname = '${col}'[\\s\\S]{0,260}ADD COLUMN ${col}`),
      );
    }
    // 극성 — `NOT EXISTS` 가 뒤집히면 재실행이 깨지거나 아무것도 안 하고 통과한다.
    expect(sql.match(/IF NOT EXISTS \(\s*\n\s*SELECT 1 FROM pg_attribute/g) ?? []).toHaveLength(2);
    expect(sql).not.toMatch(/IF EXISTS \(\s*\n\s*SELECT 1 FROM pg_attribute[\s\S]{0,300}ADD COLUMN/);
  });

  it("인덱스를 만들지도 지우지도 않는다 — 재실측 근거가 파일에 남아 있다", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX/i);
    expect(sql).not.toMatch(/DROP\s+INDEX/i);
    // 받은 전제(`idx_scan = 0`)가 뒤집힌 실측을 근거로 남긴다 — 다음 사람이 다시 지우려 할 때 읽는다.
    expect(raw).toMatch(/stats_reset IS NULL/);
    for (const n of ["_cb", "_pick"]) expect(raw).toContain(n);
    expect(raw).toMatch(/DROP 하지 않는다/);
  });

  it("own_negative 의 '조용한 0' 해소 절차가 파일에 박혀 있다 (D1)", () => {
    // 타입으로는 못 막는다(집계층은 NULL 을 못 쓴다) — 해소는 **절차**다.
    // 이 주석이 사라지면 적용자가 refold 를 건너뛰고 화면이 조용히 0 이 된다.
    expect(raw).toMatch(/25,808/);          // 조용한 0 이 되는 기존 행 수(실측)
    expect(raw).toMatch(/24,808/);          // 글로벌
    // 머리 주석(적용 절차)과 블록 ②(컬럼 옆) **두 군데 다** 있어야 한다 — 한쪽만 지워도
    // 적용자가 절차를 놓친다. 한 곳만 세면 그 삭제가 조용히 통과한다(자체 뮤테이션 N3).
    // ⚠️ **실행 가능한** 형태여야 한다 — `--surface` 없으면 usage 종료, `--yes` 없으면
    //    DRY-RUN 이라 절차가 조용히 no-op 이 된다(generate-cycle.ts:96·246·366).
    expect(raw).toMatch(/--surface=global\s+--refold --all-published --yes/);
    expect(raw).toMatch(/--surface=website --refold --all-published --yes/);
    // 두 군데(머리 주석·블록 ②) 다 있어야 한다 — 한쪽만 지워도 적용자가 절차를 놓친다.
    expect(
      (raw.match(/--refold --all-published --yes/g) ?? []).length,
      "실행 가능한 refold 안내가 두 군데 있어야 한다",
    ).toBeGreaterThanOrEqual(2);
    // 플래그가 왜 필요한지도 남긴다 — 문자열만 베끼고 이유를 지우면 다음에 또 빠진다.
    expect(raw).toMatch(/DRY-RUN/);
    expect(raw).toMatch(/usage/);
    expect(raw).toMatch(/세부층을 건드리지 않고/);
    expect(raw).toMatch(/own_negative > 0/); // 사후 확인 쿼리
    expect(raw).toMatch(/13,617/);           // 비교 모수(own_signals > 0) — "0 이면 실패" 판정 근거
  });

  it("백필 스니펫이 rowcount·프루닝·ANALYZE·사후 기대값을 갖춘다 (D4~D6)", () => {
    const bf = raw.slice(raw.indexOf("-- 사전 확인"), raw.indexOf("── 롤백"));
    // D6 — rowcount 단언. 기대는 54,760 이 아니라 **54,578**(웹 54,760 − NULL 몫 182).
    expect(bf).toMatch(/UPDATE n/);
    expect(bf).toMatch(/54578/);
    // D6 — 파티션 프루닝: 양쪽 표에 cycle_week 상수 술어.
    expect(bf).toMatch(/d\.cycle_week = DATE '2026-08-31'/);
    expect(bf).toMatch(/a\.cycle_week = DATE '2026-08-31'/);
    // 멱등 — 재실행하면 0행.
    expect(bf).toMatch(/IS DISTINCT FROM a\.report_fs/);
    // D4 — 백필 직후 ANALYZE. 없으면 T7 enrich 술어를 플래너가 0행으로 추정한다.
    expect(bf).toMatch(/ANALYZE summary_domain_citations/);
    const iUpd = bf.indexOf("UPDATE summary_domain_citations");
    expect(bf.indexOf("ANALYZE summary_domain_citations"), "ANALYZE 가 UPDATE 뒤에 와야 한다")
      .toBeGreaterThan(iUpd);
    // D5 — 사후 기대값은 64 가 아니라 **182**(NULL 답변 64건에 매달린 인용 행).
    expect(bf).toMatch(/\*\*182\*\* 여야 한다/);
    expect(bf).not.toMatch(/NULL 64행 몫/);
  });

  it("파티션 상속·백필이 문서화돼 있다", () => {
    // 새 주 파티션은 `PARTITION OF` 라 컬럼을 자동 상속한다(0064 를 고칠 것이 없다).
    expect(raw).toMatch(/summary_ensure_week_partitions/);
    expect(raw).toMatch(/PARTITION OF/);
    // 백필은 이 파일 밖 — 규모와 조인 키가 적혀 있어야 다음 사람이 이어받는다.
    expect(raw).toMatch(/150,729/);
    // 4키 조인이 적혀 있어야 다음 사람이 백필을 이어받는다.
    expect(raw).toMatch(/USING \(cycle_week, cycle_id, generation_id, job_id\)/);
    expect(raw).toMatch(/a\.job_id = d\.job_id/);
  });

  it("ACL 을 파티션 자식까지 닫는다 (0064 의 교훈)", () => {
    expect(sql).toMatch(/pg_inherits/);
    expect(sql).toMatch(/REVOKE ALL ON public\.%I FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON public\.summary_trend_own FROM PUBLIC, anon, authenticated/);
  });
});

describe("0067 — out-of-band 규약", () => {
  it("schema.ts·기준선 스냅샷·저널 어디에도 들어가지 않는다", () => {
    const schema = readSourceText(path.join(REPO, "lib/db/schema.ts"));
    expect(schema).not.toMatch(/pgTable\(\s*["']summary_/);

    const metaDir = path.join(MIG_DIR, "meta");
    const latest = fs
      .readdirSync(metaDir)
      .filter((f) => f.endsWith("_snapshot.json"))
      .sort()
      .pop()!;
    const snap = JSON.parse(fs.readFileSync(path.join(metaDir, latest), "utf8")) as {
      tables?: Record<string, { name: string }>;
    };
    const names = Object.values(snap.tables ?? {}).map((t) => t.name);
    for (const t of ["summary_trend_own", "summary_domain_citations"]) {
      expect(names).not.toContain(t);
    }

    const j = JSON.parse(fs.readFileSync(path.join(MIG_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    expect(j.entries.filter((e) => e.tag.startsWith("0067"))).toHaveLength(0);
  });
});
