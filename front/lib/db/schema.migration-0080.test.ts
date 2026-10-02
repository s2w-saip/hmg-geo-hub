/**
 * 0080(발행 리포트 사실표 3개)의 형태를 고정하는 오프라인 테스트(DB 접속 없음).
 * 0070~0072 테스트와 같은 자세다.
 *
 * 0080 에 고유한 위험은 넷:
 *   · **schema.ts 와 SQL 이 어긋나면** 리더가 drizzle 로 읽다 42703 으로 죽는다.
 *     이 표들은 `summary_*` 계열과 달리 **앱이 읽으므로** 둘을 대조해야 한다.
 *   · **REVOKE 를 빼면** 신규 표가 anon 에 열린 채 남는다(RLS 없는 리포의 보상통제는
 *     lockdown 뿐이고, 신규 표는 그 파일 재실행 전까지 무방비다).
 *   · **active 부분 유니크를 빼면** 한 회차에 active 발행물이 둘이 되고, 리더가
 *     둘 중 하나를 임의로 골라 조용히 다른 숫자를 낸다.
 *   · **기존 표를 건드리면** additive-only 규율이 깨진다(0007 prod 장애).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const FILE = path.join(REPO, "lib/db/migrations/0080_report_publications.sql");

const raw = fs.readFileSync(FILE, "utf8");
/** `--` 줄 주석 제거 — 설명문이 규율 검사에 걸리지 않게. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0080 — 발행 리포트 사실표", () => {
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

  it("멱등 — 신규 표·인덱스는 IF NOT EXISTS", () => {
    for (const t of ["report_publications", "report_site_facts", "report_site_engine_facts"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"`));
    }
    for (const i of [
      "report_publications_slug_uq",
      "report_publications_active_uq",
      "report_publications_sha_idx",
      "report_site_facts_fs_idx",
    ]) {
      expect(sql, i).toMatch(new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "${i}"`));
    }
  });

  it("additive-only — 기존 표 ALTER·DROP·TRUNCATE 가 실행 경로에 없다", () => {
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|FUNCTION)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    // FK 를 두지 않는다 — 미러 재싱크가 발행값을 지우면 안 된다(0053·0054·0077 논리).
    expect(sql).not.toMatch(/\bREFERENCES\b/i);
  });

  it("**한 회차에 active 발행물은 하나** — 부분 유니크가 그것을 보장한다", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "report_publications_active_uq"\s+ON "report_publications" \("surface", "round_date", "brand_scope"\)\s+WHERE "status" = 'active'/,
    );
    // brand_scope 가 nullable 이면 NULL 끼리 서로 다른 것으로 취급돼 중복 active 가 샌다.
    expect(sql).toMatch(/"brand_scope" text NOT NULL/);
    expect(sql).toMatch(/"surface" text NOT NULL/);
    expect(sql).toMatch(/"round_date" date NOT NULL/);
  });

  it("분자 ≤ 분모를 표가 막는다", () => {
    expect(sql).toMatch(/"report_site_facts_target_ck"/);
    expect(sql).toMatch(/"report_site_facts_owned_ck"/);
    expect(sql).toMatch(/"target_hit_prompts" <= "measured_prompts"/);
    expect(sql).toMatch(/"owned_prompts" <= "owned_prompts_den"/);
  });

  it("신규 표 REVOKE — anon/authenticated 차단 3표 전부", () => {
    for (const t of ["report_publications", "report_site_facts", "report_site_engine_facts"]) {
      expect(sql, t).toMatch(
        new RegExp(`REVOKE ALL ON "${t}" FROM PUBLIC, anon, authenticated`),
      );
    }
  });

  it("schema.ts 의 정의와 컬럼 집합이 일치한다 (앱이 drizzle 로 읽는 표다)", () => {
    const schema = fs.readFileSync(path.join(REPO, "lib/db/schema.ts"), "utf8");
    const block = (from: string, to: string) => {
      const i = schema.indexOf(from);
      expect(i, from).toBeGreaterThan(-1);
      const j = schema.indexOf(to, i);
      expect(j, to).toBeGreaterThan(i);
      return schema.slice(i, j);
    };

    const pub = block("export const reportPublications = pgTable(", "export type ReportPublicationRow");
    for (const col of [
      "slug", "surface", "brand_scope", "volume", "version", "title",
      "cycle_label", "cycle_label_en", "round_date", "prev_round_date",
      "asof_cur", "asof_prev", "published_on", "engines", "excluded_fs",
      "bench_n", "bench_n_all", "src_cite", "source_filename", "source_sha256",
      "manifest_verified", "verify_note", "sb_data_version", "status",
      "superseded_by", "ingested_at",
    ]) {
      expect(pub, `schema.ts:${col}`).toContain(`"${col}"`);
      expect(sql, `sql:${col}`).toContain(`"${col}"`);
    }
    // 부분 유니크가 schema.ts 쪽에도 있어야 db:drift 가 두 곳을 같게 본다.
    expect(pub).toContain("report_publications_active_uq");
    expect(pub).toMatch(/\.where\(sql`.*= 'active'`\)/);

    const site = block("export const reportSiteFacts = pgTable(", "export type ReportSiteFactRow");
    for (const col of [
      "publication_id", "file_seq", "brand", "country_code", "country_name",
      "region_label", "lang_code", "lang_label", "agency_status", "in_headline_pool",
      "target_hit_prompts", "measured_prompts", "owned_prompts", "owned_prompts_den",
      "owned_answers", "monitored_answers", "prompts", "answers",
      "prev_target_hit_prompts", "prev_measured_prompts",
      "prev_owned_prompts", "prev_owned_prompts_den", "raw",
    ]) {
      expect(site, `schema.ts:${col}`).toContain(`"${col}"`);
      expect(sql, `sql:${col}`).toContain(`"${col}"`);
    }
    expect(site).toContain("primaryKey({ columns: [t.publicationId, t.fileSeq] })");

    const eng = block("export const reportSiteEngineFacts = pgTable(", "export type ReportSiteEngineFactRow");
    for (const col of ["publication_id", "file_seq", "engine", "target_hit_prompts", "prev_target_hit_prompts"]) {
      expect(eng, `schema.ts:${col}`).toContain(`"${col}"`);
    }
    expect(eng).toContain("primaryKey({ columns: [t.publicationId, t.fileSeq, t.engine] })");
  });

  it("저널이 0079 바로 뒤에 하루 간격으로 붙는다 (벽시계를 넣으면 drizzle 이 조용히 스킵한다)", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(REPO, "lib/db/migrations/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const i = journal.entries.findIndex((e) => e.tag === "0079_scope_runs_project_cycle_idx");
    expect(i).toBeGreaterThan(-1);
    const next = journal.entries[i + 1];
    expect(next?.tag).toBe("0080_report_publications");
    expect(next.idx - journal.entries[i].idx).toBe(1);
    expect(next.when - journal.entries[i].when).toBe(86_400_000);
  });

  it("엔진 표에는 **분모가 없다** — 엔진 필터를 발행값으로 답할 수 없는 근거", () => {
    const i = sql.indexOf('CREATE TABLE IF NOT EXISTS "report_site_engine_facts"');
    const body = sql.slice(i, sql.indexOf(");", i));
    expect(body).toContain('"target_hit_prompts"');
    expect(body).not.toContain('"measured_prompts"');
    expect(body).not.toContain('"owned_prompts_den"');
  });
});
