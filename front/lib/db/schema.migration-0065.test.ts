/**
 * 0065(집계층 스키마 개정)의 **형태**를 고정하는 오프라인 테스트.
 *
 * DB 에 붙지 않는다 — 이 리포의 마이그레이션 적용은 사람이 `npm run db:apply` 로 돌리는
 * 승인 게이트 뒤에 있고(0064 머리 주석), 그 전에 확인 가능한 것은 전부 파일 형태다.
 * 여기서 잡는 것은 "적용해 봐야 아는" 것이 아니라 **규율 위반**이다:
 *
 *   · additive-only (0007 prod 장애 전례)
 *   · `IF NOT EXISTS` 금지 — no-op 이어도 락을 먼저 잡는다(797초 대기 실증).
 *     대신 카탈로그 선확인 DO 블록.
 *   · 한 파일 = 한 tx → `CONCURRENTLY` 불가
 *   · summary_* 계열은 drizzle 밖 out-of-band 자산 — schema.ts·저널에 넣지 않는다
 *     (0059·0060·0062·0063·0064 와 같은 자세)
 *   · 저널 `when` 은 직전 + 86,400,000 단조 (벽시계를 넣으면 조용히 스킵된다)
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceText } from "@/test/source-text";

const REPO = path.resolve(__dirname, "../..");
const MIG_DIR = path.join(REPO, "lib/db/migrations");
const FILE = path.join(MIG_DIR, "0065_summary_aggregate_layer.sql");

const raw = readSourceText(FILE);
/** `--` 줄 주석 제거 — 롤백 안내문의 DROP 이 규율 검사에 걸리지 않게. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

/** 이 파일이 읽는 JSON 두 개의 최소 형태 — `any` 를 쓰지 않기 위해 좁게 선언한다. */
type SnapshotTable = { name: string };
type Snapshot = { tables?: Record<string, SnapshotTable> };
type JournalEntry = { idx: number; when: number; tag: string };
type Journal = { entries: JournalEntry[] };

const AGG_TABLES = [
  "summary_trend_answers",
  "summary_trend_brands",
  "summary_trend_domains",
  "summary_trend_own",
] as const;

/** 플랜 §3-2 — `trend_own` 을 KPI 엔진으로 만드는 7컬럼. */
const NEW_OWN_COLUMNS = [
  "comp_mentions",
  "all_citations",
  "own_citations",
  "own_fallback_citations",
  "tile_own_mentions",
  "citing_answers",
  "prompts_measured",
] as const;

/** 플랜 §4-2 — 조회 6 + generation 정리 4 + E4 세부층 폴백 1. */
const NEW_INDEXES = [
  "summary_trend_answers_read",
  "summary_trend_brands_read",
  "summary_trend_domains_read",
  "summary_trend_own_read",
  "summary_trend_answers_cb",
  "summary_trend_brands_cb",
  "summary_trend_answers_gen",
  "summary_trend_brands_gen",
  "summary_trend_domains_gen",
  "summary_trend_own_gen",
  "summary_brand_own_idx",
] as const;

describe("0065 — 집계층 스키마 개정", () => {
  it("파일이 있고 tx 안에서 돌 수 있다 (CONCURRENTLY·명시 BEGIN/COMMIT 없음)", () => {
    expect(fs.existsSync(FILE)).toBe(true);
    // 문자열 리터럴(RAISE EXCEPTION 안내문)에 단어가 나오는 것은 무방하다 — 실제 DDL 만 본다.
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/DROP\s+INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/REINDEX\s+.*CONCURRENTLY/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
  });

  it("additive-only — DROP·TRUNCATE·RENAME 이 실행 경로에 없다", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|STATISTICS|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bRENAME\s+TO\b/i);
    // 0059 의 `*_pick` 인덱스는 남긴다(플랜 §4-2: 제거는 다음 PR).
    for (const t of AGG_TABLES) expect(sql).not.toContain(`${t}_pick`);
  });

  it("`IF NOT EXISTS` 를 쓰지 않는다 — 락을 먼저 잡기 때문", () => {
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i);
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
    expect(sql).not.toMatch(/CREATE\s+STATISTICS\s+IF\s+NOT\s+EXISTS/i);
    expect(sql).not.toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
    // 대신 카탈로그 선확인이 있어야 한다.
    expect(sql).toMatch(/to_regclass/);
    expect(sql).toMatch(/pg_attribute/);
  });

  it("lock_timeout 을 먼저 건다", () => {
    const firstStmt = sql.split(";")[0];
    expect(firstStmt).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'3s'/i);
  });

  it("트랜잭션 블록 밖 적용을 막는 가드가 lock_timeout 직후에 있다", () => {
    // 실측(2026-09-10): `SET LOCAL` 은 tx 밖에서 WARNING(25P01) 만 내고 값은 '0'(무제한)로
    // 남는다 — 그 상태로 블록 ④ 가 300 MB 파티션 부모에 락을 걸면 무한 대기다.
    expect(sql).toMatch(/current_setting\('lock_timeout'\)\s*<>\s*'3s'/);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,120}트랜잭션 블록 밖에서 적용 중/);
    // 순서가 중요하다 — SET LOCAL 보다 뒤, 첫 DDL(ALTER/CREATE) 보다 앞.
    const iSet = sql.search(/SET\s+LOCAL\s+lock_timeout/i);
    const iGuard = sql.search(/current_setting\('lock_timeout'\)/);
    const iDdl = sql.search(/ADD COLUMN|CREATE INDEX|CREATE STATISTICS/i);
    expect(iSet).toBeGreaterThanOrEqual(0);
    expect(iGuard).toBeGreaterThan(iSet);
    expect(iDdl).toBeGreaterThan(iGuard);
  });

  it("집계층 4표가 비어 있음을 마이그레이션이 단언한다 (T1 수용 기준 ②)", () => {
    // CONCURRENTLY 를 안 쓰는 근거가 "빈 표" 이므로, 그 전제를 파일이 스스로 잠근다.
    expect(sql).toMatch(/SELECT count\(\*\) FROM public\.%I/);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,200}이미 %행이 있다/);
    for (const t of AGG_TABLES) expect(sql).toContain(t);
    // ⚠️ 비교를 `n <> 0` 로 **고정**한다. `n < 0`·`n > 1e9` 같은 형태로 바뀌면 단언이
    //    영원히 참이 되어 조용히 통과한다(= 가드 소멸). 문자열로 못 박는 이유다.
    expect(sql).toMatch(/IF\s+n\s*<>\s*0\s+THEN\s*\n\s*RAISE EXCEPTION/);
  });

  it("`trend_own` 확장 7컬럼이 int NOT NULL DEFAULT 0 으로 추가된다 (플랜 §3-2)", () => {
    for (const c of NEW_OWN_COLUMNS) {
      expect(sql, `컬럼 ${c} 누락`).toContain(`'${c}'`);
      expect(raw, `COMMENT ON COLUMN summary_trend_own.${c} 누락`).toContain(
        `COMMENT ON COLUMN summary_trend_own.${c}`,
      );
    }
    expect(sql).toMatch(/ADD COLUMN %I int NOT NULL DEFAULT 0/);
  });

  it("`prompts_measured` 는 그룹 간 가산 불가임이 주석에 박혀 있다", () => {
    // 이 컬럼을 SUM 하면 이중 계상이다(플랜 §3-4 16). 다음 사람이 리더에서 SUM 하지
    // 않도록 컬럼 COMMENT 로 DB 안에 남긴다 — 문서는 안 읽혀도 \d+ 는 읽힌다.
    const c = raw.match(/COMMENT ON COLUMN summary_trend_own\.prompts_measured IS[\s\S]*?;/)?.[0] ?? "";
    expect(c).toMatch(/이중 계상/);
  });

  it("인덱스 11개를 만든다 (조회 6 · generation 정리 4 · E4 폴백 1)", () => {
    for (const i of NEW_INDEXES) expect(sql, `인덱스 ${i} 누락`).toContain(i);
    // 조회 인덱스는 cycle_anchor_at 을 앞으로 당긴다 — 회차 **집합**(범위)을 먼저 고른다.
    expect(sql).toMatch(
      /summary_trend_brands_read\s+ON public\.summary_trend_brands\s+\(surface, cycle_anchor_at, project_id, country, engine\)/,
    );
    expect(sql).toMatch(
      /summary_trend_own_read\s+ON public\.summary_trend_own\s+\(surface, own_variant, cycle_anchor_at, project_id\)/,
    );
    // catalog_brands 는 `&&` any-match → gin.
    expect(sql).toMatch(/summary_trend_answers_cb ON public\.summary_trend_answers USING gin \(catalog_brands\)/);

    // ③ 조회 인덱스 4개의 **컬럼 순서**를 전부 못 박는다. 순서가 바뀌면 회차 집합(범위)
    //    선행이라는 설계 의도가 사라지는데, 이름만 보는 단언은 그걸 못 잡는다.
    for (const t of ["answers", "brands", "domains"] as const) {
      expect(sql, `summary_trend_${t}_read 컬럼 순서`).toMatch(
        new RegExp(
          `summary_trend_${t}_read\\s+ON public\\.summary_trend_${t}\\s+\\(surface, cycle_anchor_at, project_id, country, engine\\)`,
        ),
      );
    }

    // ④ E4 폴백 인덱스의 컬럼 집합·순서 — 0059 `summary_brand_id_idx` 에 country 를 붙인 것.
    expect(sql).toMatch(
      /summary_brand_own_idx\s+ON public\.summary_brand_mentions\s+\(cycle_id, generation_id, brand_id, country\)/,
    );

    // ③ generation 정리 인덱스도 컬럼을 고정한다.
    for (const t of AGG_TABLES) {
      expect(sql, `${t}_gen 컬럼`).toMatch(
        new RegExp(`${t}_gen\\s+ON public\\.${t}\\s+\\(cycle_id, generation_id\\)`),
      );
    }
  });

  it("인덱스 선확인의 **극성**이 `IS NULL` 이다 — 뒤집히면 조용한 no-op 이 된다", () => {
    // 이 리포가 반복해서 값을 치른 지문: `to_regclass(...) IS NOT NULL` 로 뒤집히면
    // 인덱스가 **하나도 안 만들어지는데** 마이그레이션은 Success 로 끝난다.
    // 선확인 블록 3개(조회 6 · 정리 4 · E4 1) 전부 IS NULL 이어야 한다.
    const NESTED = String.raw`to_regclass\((?:[^()]|\([^()]*\))*\)`;
    const isNull = sql.match(new RegExp(`${NESTED}\\s+IS NULL`, "g")) ?? [];
    const isNotNull = sql.match(new RegExp(`${NESTED}\\s+IS NOT NULL`, "g")) ?? [];
    // 실측 5곳: 블록 ⓪(표 존재) · ②(조회 인덱스) · ③(정리 인덱스) · ④(표 2 + 인덱스 1 중 2).
    expect(isNull.length, "to_regclass … IS NULL 선확인 개수").toBeGreaterThanOrEqual(5);
    expect(isNotNull, "선확인이 IS NOT NULL 로 뒤집혔다").toHaveLength(0);
    // 인덱스 생성 경로 3곳을 개별로도 못 박는다 (전역 카운트만 보면 자리 이동을 놓친다).
    expect(sql).toMatch(/IF to_regclass\(format\('public\.%I', r\.idx\)\) IS NULL THEN\s*\n\s*EXECUTE r\.ddl;/);
    expect(sql).toMatch(/ELSIF to_regclass\('public\.summary_brand_own_idx'\) IS NULL THEN/);
  });

  it("E4 폴백 인덱스만이 비어 있지 않은 표를 건드린다 — 그 사실이 파일에 적혀 있다", () => {
    // summary_brand_mentions = 파티션 부모(자식 8) · 315,174행 · 300 MB (2026-09-10 실측).
    // 나머지 블록과 락 성질이 다르므로 적용 창을 생성 러너 밖으로 잡아야 한다.
    expect(raw).toMatch(/summary_brand_mentions[\s\S]{0,400}315,174/);
    expect(raw).toMatch(/SHARE 락/);
  });

  it("확장 통계는 0062 의 이름 규약을 쓰고, 중복 객체를 만들지 않는다", () => {
    // 0062 의 summary_ensure_cycle_gen_stats() 가 이미 4표에 st_*_cyc_gen 을 만들어 뒀다
    // (2026-09-10 실측, stxkind = d,f,m). 같은 컬럼쌍에 두 번째 객체는 ANALYZE 비용만 는다.
    expect(sql).toMatch(/'st_' \|\| t \|\| '_cyc_gen'/);
    for (const t of AGG_TABLES) expect(sql).toContain(`st_${t}_cyc_gen`);
    // 플랜 §4-2 가 제안한 `*_cg` 이름은 쓰지 않는다.
    expect(sql).not.toMatch(/summary_trend_\w+_cg\b/);
    // 4개가 다 있는지 마이그레이션이 단언한다 (T1 수용 기준 ④).
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,120}확장 통계가 4개/);
    // 60표 전수 ANALYZE 를 부르지 않는다 — tx 안에서 낼 비용이 아니다.
    expect(sql).not.toMatch(/PERFORM summary_ensure_cycle_gen_stats/);
  });

  it("집계층 4표에 REVOKE 를 동반한다 (0059·0064 관례)", () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.%I FROM PUBLIC, anon, authenticated/);
  });
});

describe("0065 — out-of-band 규약 (schema.ts·저널)", () => {
  it("schema.ts 는 summary_* 표를 정의하지 않는다", () => {
    const schema = readSourceText(path.join(REPO, "lib/db/schema.ts"));
    expect(schema).not.toMatch(/pgTable\(\s*"summary_/);
    expect(schema).not.toMatch(/pgTable\(\s*'summary_/);
  });

  it("드리즐 기준선 스냅샷에도 집계층이 없다 — db:drift 는 '참고' 로만 낸다", () => {
    const metaDir = path.join(MIG_DIR, "meta");
    const latest = fs
      .readdirSync(metaDir)
      .filter((f) => f.endsWith("_snapshot.json"))
      .sort()
      .pop()!;
    const snap: Snapshot = JSON.parse(fs.readFileSync(path.join(metaDir, latest), "utf8"));
    const names = Object.values(snap.tables ?? {}).map((t) => t.name);
    for (const t of AGG_TABLES) expect(names).not.toContain(t);
  });

  it("저널에 0065 항목이 없다 — 0059~0064 와 같은 자세", () => {
    const j: Journal = JSON.parse(fs.readFileSync(path.join(MIG_DIR, "meta/_journal.json"), "utf8"));
    const tags = j.entries.map((e) => e.tag);
    for (const n of ["0059", "0060", "0062", "0063", "0064", "0065"]) {
      expect(tags.filter((t) => t.startsWith(n))).toHaveLength(0);
    }
  });

  it("저널 `when` 은 단조 증가 — 손작성 구간(idx ≥ 21)은 86,400,000 의 배수 간격", () => {
    // 실측(2026-09-10): idx 0~20 은 drizzle-kit generate 가 벽시계로 찍은 값이라
    // 간격이 제각각이고(493,886,521 등), **idx 21 부터 손작성 체제**로 바뀌어 하루
    // (86,400,000) 단위로 걷는다. 건너뛴 번호가 있으면 그 배수가 된다(0058 = 2일, 0061 = 3일).
    // 벽시계를 다시 섞으면 drizzle 이 그 마이그레이션을 조용히 스킵한다 — 그것을 잡는 테스트다.
    const j: Journal = JSON.parse(fs.readFileSync(path.join(MIG_DIR, "meta/_journal.json"), "utf8"));
    const entries = j.entries;
    for (let i = 1; i < entries.length; i++) {
      const step = entries[i].when - entries[i - 1].when;
      expect(step, `${entries[i].tag} 의 when 이 단조가 아니다`).toBeGreaterThan(0);
    }
    // 86,400,000 의 배수가 아닌 간격은 **알려진 재베이스 지점 하나뿐**이다(0049 —
    // 2026-09-01 에 when 전체가 앞으로 밀렸다). 새 위반이 생기면 여기서 터진다.
    const REBASE_TAGS = new Set(["0049_website_prompts_owned_base"]);
    const offenders = entries
      .slice(1)
      .filter((e, i) => e.idx >= 21 && (e.when - entries[i].when) % 86_400_000 !== 0)
      .map((e) => e.tag);
    expect(new Set(offenders)).toEqual(REBASE_TAGS);

    // idx 는 비감소 (43 이 두 번 나오는 것은 기존 이력 — 유일성은 요구하지 않는다).
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].idx, `${entries[i].tag} 의 idx 가 역행한다`).toBeGreaterThanOrEqual(
        entries[i - 1].idx,
      );
    }
  });
});
