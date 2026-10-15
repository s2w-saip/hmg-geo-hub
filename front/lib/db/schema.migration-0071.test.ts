/**
 * 0071(회차 숨김 **범위** — `summary_cycles.hidden_scope`)의 형태를 고정하는 오프라인
 * 테스트. 0070 테스트와 같은 자세다.
 *
 * 0071 에 고유한 위험은 넷:
 *   · **DEFAULT 를 붙이면** 기존 96행이 'all' 로 굳는다. 값은 같지만(리더가 COALESCE 로
 *     읽으므로) "NULL = 숨기지 않음" 이라는 0070 의 자세와 표가 두 목소리를 낸다.
 *   · **CHECK 이 없으면** 오타(`citation`·`citations `)가 그대로 들어가고, 리더는 그것을
 *     `all` 로 접어 **회차 전체를 숨긴다** — 인용만 내린 줄 알았는데 언급까지 사라진다.
 *   · **0070 프로브에 컬럼을 더하면** 0070✓/0071✗ 배포에서 숨김이 통째로 꺼진다
 *     (= 8/24 골짜기가 화면에 돌아온다). 프로브는 반드시 따로여야 한다.
 *   · **회차 집합 판정(집계층·스냅샷 픽)까지 범위를 태우면** 반쪽 회차가 창에 들어온다.
 *     스펙 §4-2 는 "무변경" 이고, 아래 소스 대조가 그것을 고정한다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceText } from "@/test/source-text";

const REPO = path.resolve(__dirname, "../..");
const MIG_DIR = path.join(REPO, "lib/db/migrations");
const FILE = path.join(MIG_DIR, "0071_summary_cycle_hidden_scope.sql");

const raw = readSourceText(FILE);
/** `--` 줄 주석 제거 — 롤백 안내문이 규율 검사에 걸리지 않게. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0071 — 회차 숨김 범위", () => {
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
    // 범위는 사람이 스크립트로 찍는다 — 마이그레이션이 회차를 숨기거나 좁히지 않는다.
    expect(sql).not.toMatch(/^\s*UPDATE\s+summary_/im);
  });

  it("컬럼은 **DEFAULT 없이** nullable 로 붙는다 (NULL = all)", () => {
    expect(sql).toMatch(/ALTER TABLE public\.summary_cycles ADD COLUMN hidden_scope text'/);
    const adds = sql.match(/ADD COLUMN hidden_scope [^']*/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(adds[0]).not.toMatch(/DEFAULT/i);
    expect(adds[0]).not.toMatch(/NOT NULL/i);
  });

  it("0070 을 **선행 조건으로 단언**한다 — hidden_reason 없이 범위만 생기면 CHECK 이 거짓말한다", () => {
    expect(sql).toMatch(/attname = 'hidden_reason'[\s\S]{0,300}RAISE EXCEPTION[\s\S]{0,120}0070/);
  });

  it("CHECK 이 어휘와 **'범위는 숨긴 회차에만'** 불변식을 함께 못 박는다", () => {
    expect(sql).toMatch(/CONSTRAINT summary_cycles_hidden_scope_ck CHECK/);
    expect(sql).toMatch(/hidden_scope IS NULL/);
    expect(sql).toMatch(/hidden_reason IS NOT NULL AND hidden_scope IN \('all','citations'\)/);
    // 어휘는 둘뿐 — 늘리면 리더 3곳(excludeHiddenCycleRuns·trend-gaps·trend-gap.ts)을
    // 함께 봐야 한다. 오타가 들어오면 리더가 'all' 로 접어 **회차 전체를 숨긴다**.
    expect(sql.match(/'citations'/g) ?? []).toHaveLength(1);
  });

  it("카탈로그 선확인 뒤에만 ALTER 한다 (멱등)", () => {
    expect(sql).toMatch(/attname = 'hidden_scope'[\s\S]{0,300}ADD COLUMN hidden_scope/);
    expect(sql).toMatch(/IF NOT EXISTS \(\s*\n\s*SELECT 1 FROM pg_constraint/);
    // 극성 — `NOT EXISTS` 가 뒤집히면 재실행이 깨지거나 아무것도 안 하고 통과한다.
    expect(sql).not.toMatch(/IF EXISTS \(\s*\n\s*SELECT 1 FROM pg_attribute[\s\S]{0,300}ADD COLUMN/);
  });

  it("COMMENT 에 어휘의 뜻과 판정 정본 포인터가 있다", () => {
    const c = /COMMENT ON COLUMN summary_cycles\.hidden_scope IS[\s\S]*?;/.exec(raw)?.[0] ?? "";
    expect(c).toMatch(/citations/);
    expect(c).toMatch(/excludeHiddenCycleRuns/); // 미러 술어 정본 포인터
    expect(c).toMatch(/trend-gaps/); // 갭 키 생산자 정본 포인터
    expect(c).toMatch(/COALESCE/); // NULL = all 을 읽는 방법
    // 회차 **집합** 판정은 범위 무관 — 이 사실이 컬럼 주석에 없으면 다음 사람이
    // `cycle-set.ts` 도 계열화하려고 든다(반쪽 회차가 창에 들어온다).
    expect(c).toMatch(/집합/);
  });

  it("ACL 을 닫는다 (0059·0064~0070 관례)", () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.summary_cycles FROM PUBLIC, anon, authenticated/);
    expect(sql).not.toMatch(/pg_inherits/);
  });

  it("운영 절차(스크립트)와 롤백이 파일에 박혀 있다", () => {
    expect(raw).toMatch(/scripts\/summary\/hide-cycle\.ts/);
    expect(raw).toMatch(/--scope=citations/);
    expect(raw).toMatch(/--yes/); // 없으면 dry-run 이라는 사실
    expect(raw).toMatch(/DROP CONSTRAINT summary_cycles_hidden_scope_ck/); // 롤백 순서
    expect(raw).toMatch(/hiddenCycleScopeAvailable/); // 롤백해도 42703 이 안 나는 이유
  });

  it("실측 근거가 남아 있다 — 왜 '인용만' 인가", () => {
    expect(raw).toMatch(/3\.8%/); // 8/25 chatgpt 인용률
    expect(raw).toMatch(/73\.1%/); // 같은 회차 gemini 인용률(정상)
    expect(raw).toMatch(/83\.8%/); // chatgpt 언급률(정상)
    expect(raw).toMatch(/93\.5%/); // gemini 언급률(정상)
    expect(raw).toMatch(/2026-08-24/); // 되살아나는 주
    expect(raw).toMatch(/1045851c-e47d-4977-bda1-550c56d74705/); // 대상 회차
  });

  it("0070 파일을 고치지 않았다 — 적용된 마이그레이션은 불변이다", () => {
    const old = readSourceText(path.join(MIG_DIR, "0070_summary_cycle_hidden.sql"));
    expect(old).not.toMatch(/hidden_scope/);
  });
});

describe("0071 — out-of-band 규약", () => {
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
    expect(Object.values(snap.tables ?? {}).map((t) => t.name)).not.toContain("summary_cycles");

    const j = JSON.parse(fs.readFileSync(path.join(MIG_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    expect(j.entries.filter((e) => e.tag.startsWith("0071"))).toHaveLength(0);
  });

  it("번호가 유일하다 — 같은 0071 이 둘이면 적용 순서가 갈린다", () => {
    const files = fs.readdirSync(MIG_DIR).filter((f) => /^0071/.test(f));
    expect(files).toEqual(["0071_summary_cycle_hidden_scope.sql"]);
  });
});

// ── 프로브는 **따로**다 (교차 배포 4상태) ────────────────────────────────────
describe("0071 — 컬럼 프로브를 0070 과 합치지 않는다", () => {
  const src = readSourceText(path.join(REPO, "lib/db/column-availability.ts"));

  it("hiddenCycleColumnsAvailable 은 여전히 hidden_reason 하나만 본다", () => {
    const fn =
      /export function hiddenCycleColumnsAvailable\(\)[\s\S]*?\n}/.exec(src)?.[0] ?? "";
    expect(fn).toMatch(/columnAvailable\("summary_cycles", "hidden_reason"\)/);
    // 여기 hidden_scope 를 더하면 0070✓/0071✗ 배포에서 숨김이 통째로 꺼진다.
    expect(fn).not.toMatch(/hidden_scope/);
  });

  it("hiddenCycleScopeAvailable 이 별도 프로브로 존재한다", () => {
    const fn = /export function hiddenCycleScopeAvailable\(\)[\s\S]*?\n}/.exec(src)?.[0] ?? "";
    expect(fn).toMatch(/columnAvailable\("summary_cycles", "hidden_scope"\)/);
  });

  it("동기 프로브 목록(SYNC_PROBED_COLUMNS)에는 안 넣는다 — 콜드 왕복을 늘리지 않는다", () => {
    const list = /export const SYNC_PROBED_COLUMNS = \[[\s\S]*?\] as const/.exec(src)?.[0] ?? "";
    expect(list.length).toBeGreaterThan(50);
    expect(list).not.toMatch(/hidden_scope/);
  });
});

// ── 범위를 보는 판정은 **period 하나**다 (0071 §4-2 → D2 §3-A1 개정) ─────────
//
// 초판(0071)은 회차 집합 판정을 통째로 "범위 무관 전부 제외" 로 두었다. D2(2026-09-11,
// 제품 책임자 "2번 정공")가 그중 **기간(period) 집합만** 뒤집는다 — 8/25 회차를 사실표로 생성해
// 언급 4 KPI 는 실값으로 내고 인용만 갭으로 남기려면, 그 회차가 창에 들어와야 한다.
//
// 뒤집지 **않는** 것이 이 describe 의 본체다: 스냅샷 픽(`cycleNotHiddenSql` →
// `pickGlobalCycle`·`pickWebsiteCycles`)은 범위를 몰라야 한다. 반쪽 회차가 "측정 기준일"
// 이 되면 카드 스냅샷 7 KPI 가 한 덩어리로 그 회차의 깨진 인용 값을 낸다.
describe("0071/D2 — 범위를 보는 판정은 period 하나뿐이다", () => {
  const files = [
    "lib/summary/read/cycle-set.ts",
    "lib/db/repositories/summary-cycles.ts",
  ];

  it("cycle-set.ts 의 범위 판정은 judgeCycleRange 안에만 있다 — 스냅샷 분기는 모른다", () => {
    const src = readSourceText(path.join(REPO, files[0]));
    // `isGeneratorSkipped` 선언 뒤가 스냅샷 경로(`resolveCycleSet`)다.
    const at = src.indexOf("export function isGeneratorSkipped");
    expect(at).toBeGreaterThan(0);
    const period = src.slice(0, at);
    const snapshot = src.slice(at);
    // 배제는 `citations` **가 아닐 때만**. `=== "all"` 로 쓰면 tsconfig 가 제외하는
    // 자리(test·scripts)에서 온 `undefined` 가 숨긴 회차를 조용히 집합에 넣는다.
    expect(period).toMatch(/r\.hidden && r\.hiddenScope !== "citations"/);
    expect(snapshot).not.toMatch(/hiddenScope/);
  });

  it("cycleNotHiddenSql 은 사유만 본다 (pickGlobalCycle·pickWebsiteCycles 공통)", () => {
    const src = readSourceText(path.join(REPO, files[1]));
    const fn = /export function cycleNotHiddenSql\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
    expect(fn.length).toBeGreaterThan(50);
    expect(fn).toMatch(/hidden_reason IS NULL/);
    expect(fn).not.toMatch(/hidden_scope/);
  });

  it("summary-cycles.ts 가 hidden_scope 를 읽는 곳은 갭 슬롯 + 범위 조회 **둘**뿐이다", () => {
    const src = readSourceText(path.join(REPO, files[1]));
    // 문자열 `hidden_scope` 가 나오는 SQL 은 `hiddenCycleSlots` 와 `pickCyclesInRange`
    // 두 줄뿐이다(주석·타입 주석은 백틱 SQL 밖이라 아래 정규식이 안 잡는다).
    const inSql = src.match(/COALESCE\(c\.hidden_scope, 'all'\)/g) ?? [];
    expect(inSql).toHaveLength(2);
    // 0071 미적용 배포에서 두 자리 모두 리터럴 `'all'` 로 폴백한다(구 동작).
    expect(src.match(/sql`'all'`/g) ?? []).toHaveLength(2);
  });
});

// ── 새 컬럼은 어떤 자동 경로에서도 안 써진다 (0070 과 같은 소스 대조) ────────
describe("0071 — 관제·생성기·스왑은 hidden_scope 를 안 쓴다", () => {
  const sources = [
    "lib/db/repositories/summary-cycles.ts",
    "lib/summary/generate/cycle.ts",
    "lib/summary/generate/swap.ts",
  ];

  it.each(sources)("%s 의 summary_cycles 쓰기 문장에 hidden_scope 가 없다", (rel) => {
    const src = readSourceText(path.join(REPO, rel));
    const writes =
      src.match(/(INSERT INTO summary_cycles[\s\S]{0,900}?`|UPDATE summary_cycles[\s\S]{0,900}?`)/g) ??
      [];
    expect(writes.length, `${rel} 에서 summary_cycles 쓰기 문장을 하나도 못 찾았다`).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w, `${rel} 의 쓰기 문장이 hidden_scope 를 건드린다`).not.toMatch(/hidden_scope\s*=/);
    }
  });

  it("범위를 쓰는 곳은 운영자 스크립트 **한 곳**뿐이다", () => {
    const script = readSourceText(path.join(REPO, "scripts/summary/hide-cycle.ts"));
    expect(script).toMatch(/hidden_scope = \$\{scope\}/);
    // 0071 미적용 DB 에서 citations 를 조용히 all 로 떨어뜨리지 않는다.
    expect(script).toMatch(/0071 을 먼저 적용할 것/);
    // 같은 사유면 hidden_at 보존(D-3 A).
    expect(script).toMatch(/keepHiddenAt/);
    expect(script).toMatch(/hidden_at = \$\{hiddenAtExpr\}/);
    // 접속 정보는 env 로만.
    expect(script).toMatch(/process\.env\.DATABASE_URL/);
    expect(script).not.toMatch(/--db-url/);
  });
});
