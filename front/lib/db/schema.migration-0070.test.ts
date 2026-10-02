/**
 * 0070(회차 원장 숨김 — `summary_cycles.hidden_reason` / `hidden_at`)의 **형태**를
 * 고정하는 오프라인 테스트. 0064~0067 테스트와 같은 자세다.
 *
 * 0070 에 고유한 위험은 셋:
 *   · 두 컬럼이 **한 쌍**이어야 한다(사유 있으면 시각 있음). 한쪽만 쓰는 스크립트 버그를
 *     DB 가 막아야 하는데, 그 방어가 CHECK 하나뿐이라 제약이 사라지면 조용히 뚫린다.
 *   · DEFAULT 를 붙이면 기존 96행이 "숨김" 으로 굳는다 — **전 화면이 비는** 사고다.
 *   · 관제(`runCycleControl`)가 `fleet_visible` 처럼 이 컬럼을 재계산하면 사람이 찍은
 *     숨김이 20분마다 지워진다. 그 불변식은 아래 소스 대조 describe 가 지킨다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const MIG_DIR = path.join(REPO, "lib/db/migrations");
const FILE = path.join(MIG_DIR, "0070_summary_cycle_hidden.sql");

const raw = fs.readFileSync(FILE, "utf8");
/** `--` 줄 주석 제거 — 롤백 안내문이 규율 검사에 걸리지 않게. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0070 — 회차 원장 숨김", () => {
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
    expect(sql).not.toMatch(/ADD\s+CONSTRAINT\s+IF\s+NOT\s+EXISTS/i);
    expect(sql).toMatch(/to_regclass/);
    expect(sql).toMatch(/pg_attribute/);
    expect(sql).toMatch(/pg_constraint/);
  });

  it("additive-only — DROP·TRUNCATE·UPDATE 가 실행 경로에 하나도 없다", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|STATISTICS|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    // 숨김은 사람이 스크립트로 찍는다 — 마이그레이션이 회차를 숨기지 않는다.
    expect(sql).not.toMatch(/^\s*UPDATE\s+summary_/im);
  });

  it("두 컬럼은 **DEFAULT 없이** nullable 로 붙는다", () => {
    expect(sql).toMatch(/ALTER TABLE public\.summary_cycles ADD COLUMN hidden_reason text'/);
    expect(sql).toMatch(/ALTER TABLE public\.summary_cycles ADD COLUMN hidden_at timestamptz'/);
    // ⚠️ 제일 중요한 단언 — DEFAULT 가 붙으면 기존 96행이 전부 "숨김" 이 되고 화면이 빈다.
    const adds = sql.match(/ADD COLUMN hidden_\w+ [^']*/g) ?? [];
    expect(adds).toHaveLength(2);
    for (const a of adds) {
      expect(a, `${a} 에 DEFAULT 가 붙었다`).not.toMatch(/DEFAULT/i);
      expect(a, `${a} 에 NOT NULL 이 붙었다`).not.toMatch(/NOT NULL/i);
    }
  });

  it("CHECK 이 어휘와 **쌍 불변식**을 함께 못 박는다", () => {
    expect(sql).toMatch(/CONSTRAINT summary_cycles_hidden_reason_ck CHECK/);
    // 어휘 — 두 값뿐. 늘리면 리더(trend-gaps.ts GAP_REASONS)와 함께 봐야 한다.
    expect(sql).toMatch(/hidden_reason IN \('collection_error','operator'\)/);
    // 쌍 — 한쪽만 채우면 거절된다(스크립트가 hidden_at 을 빠뜨리는 사고를 DB 가 막는다).
    expect(sql).toMatch(/hidden_reason IS NULL AND hidden_at IS NULL/);
    expect(sql).toMatch(/hidden_at IS NOT NULL/);
  });

  it("카탈로그 선확인 뒤에만 ALTER 한다 (멱등)", () => {
    for (const col of ["hidden_reason", "hidden_at"]) {
      expect(sql, `${col} 선확인 없음`).toMatch(
        new RegExp(`attname = '${col}'[\\s\\S]{0,200}ADD COLUMN ${col}`),
      );
    }
    // 극성 — `NOT EXISTS` 가 뒤집히면 재실행이 깨지거나 아무것도 안 하고 통과한다.
    expect(sql.match(/IF NOT EXISTS \(\s*\n\s*SELECT 1 FROM pg_attribute/g) ?? []).toHaveLength(2);
    expect(sql).toMatch(/IF NOT EXISTS \(\s*\n\s*SELECT 1 FROM pg_constraint/);
    expect(sql).not.toMatch(/IF EXISTS \(\s*\n\s*SELECT 1 FROM pg_attribute[\s\S]{0,300}ADD COLUMN/);
  });

  it("두 컬럼에 COMMENT 가 있고, 어휘의 뜻이 적혀 있다", () => {
    const c = /COMMENT ON COLUMN summary_cycles\.hidden_reason IS[\s\S]*?;/.exec(raw)?.[0] ?? "";
    expect(c).toMatch(/collection_error/);
    expect(c).toMatch(/operator/);
    expect(c).toMatch(/excludeHiddenCycleRuns/); // 리더 술어 정본 포인터
    expect(c).toMatch(/cycle-set/);
    expect(c).toMatch(/데이터는 지우지 않는다/); // 드롭과의 차이
    const a = /COMMENT ON COLUMN summary_cycles\.hidden_at IS[\s\S]*?;/.exec(raw)?.[0] ?? "";
    expect(a).toMatch(/summary_cycles_hidden_reason_ck/);
  });

  it("운영 절차(스크립트)와 롤백이 파일에 박혀 있다", () => {
    expect(raw).toMatch(/scripts\/summary\/hide-cycle\.ts/);
    expect(raw).toMatch(/--reason=collection_error/);
    expect(raw).toMatch(/--yes/); // 없으면 dry-run 이라는 사실
    expect(raw).toMatch(/DROP CONSTRAINT summary_cycles_hidden_reason_ck/); // 롤백 순서
    // 왜 드롭이 아니라 숨김인지 — 다음 사람이 "그냥 지우지" 하기 전에 읽는다.
    expect(raw).toMatch(/scope_answer_drops/);
    expect(raw).toMatch(/가역/);
  });

  it("실측 근거가 남아 있다 — 무엇을 숨기려고 만든 파일인지", () => {
    expect(raw).toMatch(/9,652/); // 부분 수집 유닛 수
    expect(raw).toMatch(/38,748/); // 정원
    expect(raw).toMatch(/13,816/); // 미러에 찍히던 답변 수
    expect(raw).toMatch(/2026-08-24/); // 골짜기가 보이던 주
  });

  it("ACL 을 닫는다 (0059·0064~0067 관례)", () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.summary_cycles FROM PUBLIC, anon, authenticated/);
    // summary_cycles 는 파티션이 아니다 — 자식 순회를 넣으면 잘못 베낀 것이다.
    expect(sql).not.toMatch(/pg_inherits/);
  });
});

describe("0070 — out-of-band 규약", () => {
  it("schema.ts·기준선 스냅샷·저널 어디에도 들어가지 않는다", () => {
    const schema = fs.readFileSync(path.join(REPO, "lib/db/schema.ts"), "utf8");
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
    expect(Object.values(snap.tables ?? {}).map((t) => t.name)).not.toContain("summary_cycles");

    const j = JSON.parse(fs.readFileSync(path.join(MIG_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    expect(j.entries.filter((e) => e.tag.startsWith("0070"))).toHaveLength(0);
  });

  it("번호가 유일하다 — 같은 0070 이 둘이면 적용 순서가 갈린다", () => {
    const files = fs.readdirSync(MIG_DIR).filter((f) => /^0070/.test(f));
    expect(files).toEqual(["0070_summary_cycle_hidden.sql"]);
  });
});

// ── 관제·생성기·스왑은 이 두 컬럼을 건드리지 않는다 (소스 대조) ──────────────
//
// `fleet_visible` 은 관제가 **매 실행 재계산**한다(5단계). 새 컬럼이 같은 취급을 받으면
// 사람이 찍은 숨김이 20분마다 지워지고, 그 사실은 화면에서 "가끔 골짜기가 돌아온다" 로만
// 보인다 — 재현이 거의 불가능한 형태다. 그래서 **쓰는 문장의 컬럼 목록**을 여기서 고정한다.
describe("0070 — 새 컬럼은 어떤 자동 경로에서도 안 써진다", () => {
  const sources = [
    "lib/db/repositories/summary-cycles.ts",
    "lib/summary/generate/cycle.ts",
    "lib/summary/generate/swap.ts",
  ];

  it.each(sources)("%s 는 summary_cycles 에 hidden_* 를 쓰지 않는다", (rel) => {
    const src = fs.readFileSync(path.join(REPO, rel), "utf8");
    // 쓰기 문장(INSERT/UPDATE) 안에 컬럼 이름이 등장하면 안 된다.
    const writes = src.match(/(INSERT INTO summary_cycles[\s\S]{0,900}?`|UPDATE summary_cycles[\s\S]{0,900}?`)/g) ?? [];
    // 비공허성 — 문장 형태가 바뀌어 0개가 잡히면 이 테스트는 조용히 아무것도 안 보게 된다.
    expect(writes.length, `${rel} 에서 summary_cycles 쓰기 문장을 하나도 못 찾았다`).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w, `${rel} 의 쓰기 문장이 hidden_* 를 건드린다`).not.toMatch(/hidden_(reason|at)\s*=/);
    }
  });

  it("`SELECT *` 로 summary_cycles 를 읽는 곳이 없다 — 새 컬럼이 조용히 실려 나가지 않게", () => {
    for (const rel of sources) {
      const src = fs.readFileSync(path.join(REPO, rel), "utf8");
      expect(src, rel).not.toMatch(/SELECT\s+\*\s+FROM\s+summary_cycles/i);
    }
  });

  it("숨김을 쓰는 곳은 운영자 스크립트 **한 곳**뿐이다", () => {
    const script = fs.readFileSync(path.join(REPO, "scripts/summary/hide-cycle.ts"), "utf8");
    expect(script).toMatch(/UPDATE summary_cycles SET hidden_reason = /);
    // rowcount 단언 — 0행을 성공으로 세면 "숨겼다" 는 보고가 거짓이 된다.
    expect(script).toMatch(/expected 1 row updated/);
    // 기본이 dry-run 이다.
    expect(script).toMatch(/--yes 가 없다/);
    // 접속 정보는 env 로만 — argv 로 받으면 `ps` 에 평문으로 보인다.
    expect(script).toMatch(/process\.env\.DATABASE_URL/);
    expect(script).not.toMatch(/--db-url/);
  });
});
