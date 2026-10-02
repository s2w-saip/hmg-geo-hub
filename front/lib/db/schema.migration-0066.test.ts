/**
 * 0066(집계층 키 확장)의 **형태**를 고정하는 오프라인 테스트.
 *
 * 0065 테스트와 같은 자세다 — DB 에 붙지 않고, "적용해 봐야 아는" 것이 아니라 **규율 위반**과
 * **조용히 통과하는 뮤테이션**을 잡는다. 0066 은 0065 보다 위험이 크다:
 *   · TRUNCATE 가 있다 (데이터를 버린다)
 *   · PK 를 DROP 하고 다시 만든다 (additive-only 예외)
 * 그래서 봉쇄할 지문도 더 많다 — TRUNCATE 대상 4표 · PK 컬럼 목록 · 선확인 극성 · 두 컬럼 타입.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const MIG_DIR = path.join(REPO, "lib/db/migrations");
const FILE = path.join(MIG_DIR, "0066_summary_aggregate_keys.sql");

const raw = fs.readFileSync(FILE, "utf8");
/** `--` 줄 주석 제거 — 롤백 안내문의 DROP/TRUNCATE 가 규율 검사에 걸리지 않게. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

type SnapshotTable = { name: string };
type Snapshot = { tables?: Record<string, SnapshotTable> };
type Journal = { entries: { idx: number; when: number; tag: string }[] };

const AGG_TABLES = [
  "summary_trend_answers",
  "summary_trend_brands",
  "summary_trend_domains",
  "summary_trend_own",
] as const;

/** 재작성 후 PK 컬럼 목록 — 0059 원본에 `presence_set`(bpr 뒤)·`report_fs`(run_status 뒤)를 끼운 것. */
const NEW_PK: Record<(typeof AGG_TABLES)[number], string[]> = {
  summary_trend_answers: [
    "cycle_id", "generation_id", "country", "lang", "engine", "catalog_brands",
    "funnel_catalog", "funnel_scope", "brand_presence_resolved", "presence_set",
    "list_type", "depth1", "depth2", "depth3", "in_root_catalog", "in_tagged_region",
    "in_full_cycle", "run_status", "report_fs",
  ],
  summary_trend_brands: [
    "cycle_id", "generation_id", "country", "lang", "engine", "catalog_brands",
    "funnel_catalog", "funnel_scope", "brand_presence_resolved", "presence_set",
    "list_type", "depth1", "in_root_catalog", "in_tagged_region", "in_full_cycle",
    "run_status", "report_fs", "brand_id", "brand_name",
  ],
  summary_trend_domains: [
    "cycle_id", "generation_id", "country", "lang", "engine", "catalog_brands",
    "funnel_catalog", "funnel_scope", "brand_presence_resolved", "presence_set",
    "list_type", "depth1", "in_root_catalog", "in_tagged_region", "in_full_cycle",
    "run_status", "report_fs", "group_key", "matched_base", "base_norm_null",
  ],
  summary_trend_own: [
    "cycle_id", "generation_id", "country", "lang", "engine", "catalog_brands",
    "funnel_catalog", "funnel_scope", "brand_presence_resolved", "presence_set",
    "list_type", "depth1", "in_root_catalog", "in_tagged_region", "in_full_cycle",
    "run_status", "report_fs", "own_variant",
  ],
};

describe("0066 — 집계층 키 확장", () => {
  it("tx 안에서 돌 수 있고 lock_timeout·tx 가드가 첫 DDL 앞에 있다", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(sql.split(";")[0]).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'3s'/i);
    expect(sql).toMatch(/current_setting\('lock_timeout'\)\s*<>\s*'3s'/);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,120}트랜잭션 블록 밖에서 적용 중/);

    const iGuard = sql.search(/current_setting\('lock_timeout'\)/);
    const iDdl = sql.search(/TRUNCATE|ADD COLUMN|DROP CONSTRAINT/i);
    expect(iGuard).toBeGreaterThan(0);
    expect(iDdl).toBeGreaterThan(iGuard);
  });

  it("`IF NOT EXISTS` 를 쓰지 않는다 — 락을 먼저 잡기 때문", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i);
    expect(sql).not.toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
    expect(sql).not.toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS/i);
    expect(sql).toMatch(/to_regclass/);
    expect(sql).toMatch(/pg_attribute/);
  });

  it("TRUNCATE 대상이 집계층 4표뿐이다 — 세부층·원장에 번지면 안 된다", () => {
    const truncs = sql.match(/TRUNCATE[\s\S]*?;/gi) ?? [];
    expect(truncs, "TRUNCATE 문장 수").toHaveLength(1);
    const t = truncs[0];
    for (const tbl of AGG_TABLES) expect(t, `${tbl} 누락`).toContain(tbl);
    // ⚠️ 이 단언이 이 파일에서 제일 중요하다. 세부층 6표·원장 4표가 목록에 끼면
    //    회차 데이터가 통째로 날아간다(집계층과 달리 재생성이 싸지 않다).
    for (const forbidden of [
      "summary_answers", "summary_brand_mentions", "summary_domain_citations",
      "summary_target_hits", "summary_prompt_dim", "summary_cycle_jobs",
      "summary_cycles", "summary_cycle_runs", "summary_generations", "summary_settings",
      "scope_", "prompts", "projects",
    ]) {
      expect(t, `TRUNCATE 대상에 ${forbidden} 가 끼었다`).not.toContain(forbidden);
    }
  });

  it("두 컬럼의 타입·기본값이 세부층 실측 규약과 같다", () => {
    // summary_answers.report_fs = integer NULL → 집계층 int NOT NULL DEFAULT 0 (COALESCE 접힘).
    expect(sql).toMatch(/ADD COLUMN report_fs int NOT NULL DEFAULT 0/);
    // summary_answers.presence_set = text[] NOT NULL DEFAULT '{}' → 그대로 복사.
    expect(sql).toMatch(/ADD COLUMN presence_set text\[\] NOT NULL DEFAULT '\{\}'/);
    for (const t of AGG_TABLES) {
      expect(raw, `${t}.report_fs COMMENT 누락`).toContain(`COMMENT ON COLUMN ${t}.report_fs`);
      expect(raw, `${t}.presence_set COMMENT 누락`).toContain(`COMMENT ON COLUMN ${t}.presence_set`);
    }
    // 0 sentinel 의 근거(실값이 1부터)가 파일에 박혀 있어야 한다 — 이 전제가 깨지면 규약이 깨진다.
    expect(raw).toMatch(/report_fs = 0[\s\S]{0,40}실측 0건/);
  });

  it("`summary_trend_domains.unit_owned_citations` 를 측정 컬럼으로 추가한다 (T3)", () => {
    // 웹사이트 ⑤ 분자·인용표 is_ours 의 정본. 없으면 집계층이 그 둘을 못 낸다.
    expect(sql).toMatch(
      /ALTER TABLE public\.summary_trend_domains ADD COLUMN unit_owned_citations int NOT NULL DEFAULT 0/,
    );
    // 카탈로그 선확인이 이 컬럼에도 걸려 있어야 한다(멱등).
    expect(sql).toMatch(/attname = 'unit_owned_citations'[\s\S]{0,200}ADD COLUMN unit_owned_citations/);
    // 표를 잘못 고르면 조용히 틀린다 — domains 에만 붙는다.
    for (const t of ["summary_trend_answers", "summary_trend_brands", "summary_trend_own"]) {
      expect(sql, `${t} 에 unit_owned_citations 가 붙었다`).not.toMatch(
        new RegExp(`ALTER TABLE public\\.${t} ADD COLUMN unit_owned_citations`),
      );
    }
    // 키가 아니다 — 어느 PK 목록에도 들어가면 안 된다(그레인이 폭발한다).
    for (const t of AGG_TABLES) {
      expect(NEW_PK[t], `${t} PK 에 측정 컬럼이 섞였다`).not.toContain("unit_owned_citations");
    }
    expect(sql).not.toMatch(/'[a-z0-9_, ]*unit_owned_citations[a-z0-9_, ]*'\)/);
    // COMMENT 에 "웹사이트만 의미 · 글로벌 0" 과 is_ours 동치 근거가 남아야 한다.
    const c = raw.match(/COMMENT ON COLUMN summary_trend_domains\.unit_owned_citations IS[\s\S]*?;/)?.[0] ?? "";
    expect(c).toMatch(/웹사이트에서만 의미/);
    expect(c).toMatch(/글로벌은 전량 0/);
    expect(c).toMatch(/is_ours = \(이 값 > 0\)/);
    // 동치의 근거(음수 0건)가 파일에 실측으로 박혀 있어야 한다.
    expect(raw).toMatch(/음수 \*\*0건\*\*/);
  });

  it("PK 4개의 컬럼 목록이 순서까지 고정돼 있다", () => {
    for (const t of AGG_TABLES) {
      const want = NEW_PK[t].join(", ");
      expect(sql, `${t} 의 새 PK 목록`).toContain(`'${t}',\n       '${want}'`);
      // presence_set 은 bpr 바로 뒤, report_fs 는 run_status 바로 뒤여야 한다.
      expect(want).toContain("brand_presence_resolved, presence_set");
      expect(want).toContain("run_status, report_fs");
      // 선두 (cycle_id, generation_id) 는 정리 DELETE 접두사 — 건드리면 안 된다.
      expect(want.startsWith("cycle_id, generation_id, ")).toBe(true);
      // D11 — brands·domains·own 에는 depth2/depth3 가 들어가지 않는다.
      if (t !== "summary_trend_answers") {
        expect(want, `${t} 에 depth2/3 가 들어갔다 (D11 위반)`).not.toMatch(/depth[23]/);
      }
    }
  });

  it("PK 재작성의 멱등 선확인 **극성**이 `NOT in_pk` 다", () => {
    // 뒤집히면 이미 재작성된 표를 또 DROP/ADD 하거나(재실행 시 실패), 아예 아무것도
    // 안 하고 조용히 통과한다 — 이 리포가 반복해서 값을 치른 지문.
    expect(sql).toMatch(/IF NOT in_pk THEN\s*\n[\s\S]{0,400}?DROP CONSTRAINT/);
    expect(sql).not.toMatch(/IF in_pk THEN\s*\n[\s\S]{0,400}?DROP CONSTRAINT/);
    // 선확인은 pg_index.indisprimary 에서 presence_set 을 찾는 형태여야 한다.
    expect(sql).toMatch(/indisprimary[\s\S]{0,120}attname = 'presence_set'/);
  });

  it("PK 형태를 마이그레이션이 스스로 단언한다 (컬럼 수 + 이름)", () => {
    expect(sql).toMatch(/'summary_trend_answers', 19/);
    expect(sql).toMatch(/'summary_trend_brands', 19/);
    expect(sql).toMatch(/'summary_trend_domains', 20/);
    expect(sql).toMatch(/'summary_trend_own',\s+18/);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,80}PK 컬럼 수가/);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,60}PK 에 report_fs 가 없다/);
  });

  it("롤백 스니펫이 세 컬럼을 모두 되돌린다", () => {
    const rb = raw.slice(raw.indexOf("── 롤백"));
    expect(rb).toMatch(/SET LOCAL lock_timeout = '3s'/);
    expect(rb).toMatch(/DROP COLUMN unit_owned_citations/);
    expect(rb).toMatch(/DROP COLUMN report_fs, DROP COLUMN presence_set/);
  });

  it("인덱스를 새로 만들지 않는다 — 근거가 파일에 적혀 있다", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX/i);
    expect(raw).toMatch(/distinct 가 4개/); // presence_set gin 을 안 만드는 근거
    expect(raw).toMatch(/EXPLAIN 근거를 만들 수 없다/);
  });

  it("0065 와의 적용 순서 위험이 머리 주석에 박혀 있다", () => {
    // 0065 블록 ⓪ 이 "4표 = 0행" 을 단언하는데 2026-09-10 현재 115행이 있다.
    expect(raw).toMatch(/TRUNCATE 4표[\s\S]{0,60}0065[\s\S]{0,40}0066/);
    expect(raw).toMatch(/115행/);
  });

  it("접기(T2)·리더(T4) 계약이 파일에 남아 있다", () => {
    expect(raw).toMatch(/summary_brand_mentions[\s\S]{0,200}job_id/); // report_fs 조인 필요
    expect(raw).toMatch(/unitFlags/);
    expect(raw).toMatch(/brandPresence/);
    expect(raw).toMatch(/&&/); // any-match 술어
  });

  it("ANALYZE·REVOKE 를 동반하고 60표 전수 함수는 부르지 않는다", () => {
    expect(sql).toMatch(/ANALYZE public\.%I/);
    expect(sql).toMatch(/REVOKE ALL ON public\.%I FROM PUBLIC, anon, authenticated/);
    expect(sql).not.toMatch(/PERFORM summary_ensure_cycle_gen_stats/);
  });
});

describe("0066 — out-of-band 규약", () => {
  it("schema.ts·기준선 스냅샷·저널 어디에도 들어가지 않는다", () => {
    const schema = fs.readFileSync(path.join(REPO, "lib/db/schema.ts"), "utf8");
    expect(schema).not.toMatch(/pgTable\(\s*["']summary_/);

    const metaDir = path.join(MIG_DIR, "meta");
    const latest = fs
      .readdirSync(metaDir)
      .filter((f) => f.endsWith("_snapshot.json"))
      .sort()
      .pop()!;
    const snap: Snapshot = JSON.parse(fs.readFileSync(path.join(metaDir, latest), "utf8"));
    const names = Object.values(snap.tables ?? {}).map((t) => t.name);
    for (const t of AGG_TABLES) expect(names).not.toContain(t);

    const j: Journal = JSON.parse(fs.readFileSync(path.join(MIG_DIR, "meta/_journal.json"), "utf8"));
    expect(j.entries.filter((e) => e.tag.startsWith("0066"))).toHaveLength(0);
  });
});
