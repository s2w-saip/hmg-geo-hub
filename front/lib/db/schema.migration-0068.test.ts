/**
 * 0068(S1 카드 read 커버링 인덱스 2개)의 **형태**를 고정하는 오프라인 테스트.
 *
 * ⚠️ domains 는 **`_s1_cover_v2`** 다. 초판(`_s1_cover`)은 `engine` 이 인덱스에 없어
 *    필터 조합에서 행마다 heap 을 되짚었고(shared hit 248 → 4,951) 인용 화면의
 *    engine×category 문장은 3,409 → 68,013 buffers 로 **느려지기까지** 했다(2026-09-10 실측).
 *    v2 는 `engine` 을 키 6번째에 넣어 country·engine 을 연속 경계로 만든다.
 *    brands 는 초판 그대로다 — B2(`brand_name = ANY`)의 경계를 지키기 위한 문서화된 트레이드.
 *    이 테스트가 그 두 형태를 **서로 다르게** 고정한다(같이 바꾸면 한쪽이 깨진다).
 *
 * 0065~0067 테스트와 같은 자세다. 0068 에 고유한 위험은 넷:
 *   · `CREATE INDEX` 는 no-op 이어도 ACCESS EXCLUSIVE 를 먼저 잡는다(0045 실측 797초)
 *     → 파일 안에서는 `IF NOT EXISTS` 금지 · `to_regclass` 선확인 · `lock_timeout` 필수.
 *   · `db:apply` 가 파일을 한 tx 로 감싸므로 파일 안에 `CONCURRENTLY` 가 있으면 안 된다.
 *   · 부분 인덱스 술어에 **파라미터로 나가는 컬럼**(surface·project_id·cycle_id·
 *     generation_id·cycle_anchor_at)이 들어가면 플래너가 함의를 못 증명해 인덱스가
 *     통째로 안 쓰일 수 있다 — 그 컬럼들은 술어가 아니라 키에 있어야 한다.
 *   · A2 는 "값 무변경" 이 전제다 — PK·컬럼·데이터를 건드리는 문장이 하나도 없어야 한다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceText } from "@/test/source-text";

const REPO = path.resolve(__dirname, "../..");
const MIG_DIR = path.join(REPO, "lib/db/migrations");
const FILE = path.join(MIG_DIR, "0068_summary_trend_s1_cover_idx.sql");

const raw = readSourceText(FILE);
/** `--` 줄 주석 제거 — out-of-band 안내문·롤백 절이 규율 검사에 걸리지 않게. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const IDX = ["summary_trend_brands_s1_cover", "summary_trend_domains_s1_cover_v2"] as const;

describe("0068 — PR④ A2 커버링 인덱스", () => {
  it("tx 안에서 돌 수 있고 lock_timeout·tx 가드가 첫 DDL 앞에 있다", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/DROP\s+INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(sql.split(";")[0]).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'3s'/i);
    expect(sql).toMatch(/current_setting\('lock_timeout'\)\s*<>\s*'3s'/);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,120}트랜잭션 블록 밖에서 적용 중/);

    const iGuard = sql.search(/current_setting\('lock_timeout'\)/);
    const iDdl = sql.search(/CREATE\s+INDEX/i);
    expect(iGuard).toBeGreaterThan(0);
    expect(iDdl).toBeGreaterThan(iGuard);
  });

  it("`IF NOT EXISTS` 를 쓰지 않는다 — 락을 먼저 잡기 때문", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i);
    for (const idx of IDX) {
      expect(sql).toMatch(new RegExp(`to_regclass\\('public\\.${idx}'\\)\\s+IS NULL`));
    }
    // 기반 표 존재도 선확인한다(0059 미적용 환경에서 조용히 실패하지 않게).
    expect(sql).toMatch(/to_regclass\('public\.summary_trend_brands'\)\s+IS NULL/);
    expect(sql).toMatch(/to_regclass\('public\.summary_trend_domains'\)\s+IS NULL/);
  });

  it("값 무변경 — 인덱스와 ANALYZE 말고는 아무것도 하지 않는다", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|STATISTICS|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\s+/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/PRIMARY\s+KEY/i);
    // 통계 갱신은 필수다 — 새 부분 인덱스는 통계 없이 태어난다.
    expect(sql).toMatch(/ANALYZE public\.summary_trend_brands;/);
    expect(sql).toMatch(/ANALYZE public\.summary_trend_domains;/);
  });

  it("부분 술어에는 **리터럴 게이트만** 들어간다 (파라미터 컬럼 금지)", () => {
    const wheres = [...sql.matchAll(/WHERE ([\s\S]*?)\n\s*\$ddl\$/g)].map((m) => m[1]);
    expect(wheres).toHaveLength(2);
    for (const w of wheres) {
      // 리더가 파라미터로 내보내는 술어가 부분 인덱스에 들어가면 함의 증명이 깨진다.
      for (const col of ["surface", "project_id", "cycle_id", "generation_id", "cycle_anchor_at"]) {
        expect(w, `부분 술어에 파라미터 컬럼 ${col} 이 들어갔다`).not.toMatch(
          new RegExp(`\\b${col}\\b`),
        );
      }
      expect(w).toMatch(/in_root_catalog = 1/);
      expect(w).toMatch(/in_tagged_region = 1/);
      expect(w).toMatch(/in_full_cycle = 1/);
      expect(w).toMatch(/run_status IN \('completed', 'partial_failed'\)/);
    }
    // brands 만 is_competitor 게이트를 갖는다(trendBrandsSql 이 무조건 건다).
    expect(wheres[0]).toMatch(/is_competitor = 1/);
    expect(wheres[1]).not.toMatch(/is_competitor/);
  });

  it("brands 인덱스가 카드 문장이 읽는 열을 전부 덮는다", () => {
    const def = /CREATE INDEX summary_trend_brands_s1_cover[\s\S]*?\$ddl\$/.exec(sql)![0];
    // 키 — surface 는 파라미터 술어라 반드시 키에 있어야 Index Cond 가 된다.
    expect(def).toMatch(
      /\(surface, cycle_id, generation_id, project_id, brand_name, country\)/,
    );
    // 출력·필터 열 (BRAND_MEASURE_SUMS 14개 + 축·판정 열)
    for (const c of [
      "cycle_anchor_at", "engine", "brand_id",
      "mentions", "answers", "rank_sum", "ranked_answers", "top3_answers",
      "positive", "neutral", "negative", "mixed",
      "type_mention", "type_recommendation", "type_comparison",
      "type_definition", "type_final_choice",
    ]) {
      expect(def, `INCLUDE 에 ${c} 가 없다 — Index Only Scan 이 깨진다`).toMatch(
        new RegExp(`\\b${c}\\b`),
      );
    }
    // 게이트 컬럼 보험 — 부분 술어 함의가 안 증명돼도 index-only 를 유지한다.
    for (const c of ["run_status", "is_competitor", "in_root_catalog", "in_tagged_region", "in_full_cycle"]) {
      expect(def.split("INCLUDE")[1]).toMatch(new RegExp(`\\b${c}\\b`));
    }
    // ⚠️ brands 는 domains 와 **일부러 다르다** — engine 은 INCLUDE 에 남는다.
    //    키로 올리면 카드 필터는 좋아지지만 B2(brand_name = ANY)가 부분 인덱스 전량을
    //    훑는다(21,236 → 135,695 튜플). 한 인덱스로 둘 다는 불가능하다(PG 17, skip scan 없음).
    expect(def.split("INCLUDE")[1]).toMatch(/\bengine\b/);
  });

  it("domains 인덱스가 ⑤ 분자 판정 열까지 덮고, engine 이 **키 경계**에 있다", () => {
    const def = /CREATE INDEX summary_trend_domains_s1_cover_v2[\s\S]*?\$ddl\$/.exec(sql)![0];
    // v2 의 핵심 — country 다음이 engine 이어야 두 필터 축이 연속 경계가 된다.
    expect(def).toMatch(
      /\(surface, cycle_id, generation_id, project_id, country, engine, group_key, domain\)/,
    );
    // engine 이 INCLUDE 로 내려가면 경계를 잃는다(스캔 범위가 안 줄고 초판 회귀가 재발).
    expect(def.split("INCLUDE")[1]).not.toMatch(/\bengine\b/);
    for (const c of [
      "cycle_anchor_at", "matched_base", "base_norm_null", "citations", "citing_answers",
    ]) {
      expect(def, `INCLUDE 에 ${c} 가 없다`).toMatch(new RegExp(`\\b${c}\\b`));
    }
    // 웹사이트 전용 열은 뺀다 — 이 부분 술어를 만족하는 웹사이트 행이 0건이다(실측).
    expect(def).not.toMatch(/unit_owned_citations/);
  });

  it("초판 이름(`summary_trend_domains_s1_cover`)을 만들지 않는다", () => {
    // 초판은 프로덕션에서 DROP 했고 다른 환경엔 애초에 없다 — 되살리면 회귀가 돌아온다.
    expect(sql).not.toMatch(/CREATE INDEX summary_trend_domains_s1_cover(?!_v2)/);
    expect(sql).not.toMatch(/to_regclass\('public\.summary_trend_domains_s1_cover'\)/);
  });

  it("근거·적용 절차·롤백이 파일에 남아 있다", () => {
    // out-of-band CONCURRENTLY 절차 (주석 원문에서 확인)
    expect(raw).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS summary_trend_brands_s1_cover/);
    expect(raw).toMatch(/CREATE INDEX CONCURRENTLY summary_trend_domains_s1_cover_v2/);
    expect(raw).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS summary_trend_brands_s1_cover/);
    expect(raw).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS summary_trend_domains_s1_cover_v2/);
    // 실측 기준선(before) — 근거 없는 인덱스를 금지하는 리포 규율.
    expect(raw).toMatch(/Bitmap Heap 5,647 blk/);
    // v2 개정 사유 = 초판이 실제로 낸 회귀 수치. 이 숫자가 사라지면 다음 사람이
    // "engine 을 INCLUDE 로 내려도 되겠지" 로 되돌린다.
    expect(raw).toMatch(/68,013/);
    expect(raw).toMatch(/4,951/);
    // brands 트레이드(+21 ms)를 숨기지 않는다.
    expect(raw).toMatch(/B2/);
    expect(raw).toMatch(/skip scan/);
    // PK 를 건드리지 않는다는 선언(PR⑤ 경계)
    expect(raw).toMatch(/PK 를 건드리지 않는다/);
    // 두 인덱스에 COMMENT 가 붙는다
    for (const idx of IDX) {
      expect(sql).toMatch(new RegExp(`COMMENT ON INDEX ${idx} IS`));
    }
  });

  it("summary_* 규약 — schema.ts·저널에 넣지 않는다", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIG_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag.startsWith("0068"))).toBe(false);
    const schema = readSourceText(path.join(REPO, "lib/db/schema.ts"));
    expect(schema).not.toMatch(/summary_trend_brands_s1_cover/);
  });
});
