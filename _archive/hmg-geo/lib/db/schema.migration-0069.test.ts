/**
 * 0069(집계층 `summary_trend_brands` 의 답변 안 경쟁 순위 2컬럼)의 **형태**를 고정하는
 * 오프라인 테스트. 0065·0066·0067 테스트와 같은 자세다.
 *
 * 0069 에 고유한 위험은 셋:
 *   · **조용한 0** — `NOT NULL DEFAULT 0` 이라 적용 순간 기존 309,037행이 0 이 된다.
 *     타입으로는 못 막는다(집계층은 NULL 을 못 쓴다) → 해소는 **절차**(refold)이고,
 *     그 절차가 파일에 실행 가능한 형태로 박혀 있어야 한다(0067 D1 의 재발 방지).
 *   · **표를 잘못 고르기** — 이 두 컬럼은 `summary_trend_brands` 에만 붙는다.
 *   · **기존 `rank_sum` 을 덮기** — 그 컬럼은 GEO 위젯이 쓴다. additive 여야 한다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const MIG_DIR = path.join(REPO, "lib/db/migrations");
const FILE = path.join(MIG_DIR, "0069_summary_trend_brands_comp_rank.sql");

const raw = fs.readFileSync(FILE, "utf8");
/** `--` 줄 주석 제거 — 롤백·확인 안내문이 규율 검사에 걸리지 않게. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0069 — 집계층 경쟁 순위 2컬럼", () => {
  it("번호가 겹치지 않는다 — 0068 은 다른 PR 이 선점했다", () => {
    const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith("0069"))).toHaveLength(1);
    // `db:apply -- 0069` 는 접두어 매칭이라 같은 번호가 둘이면 중단한다(apply-migration.ts).
  });

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

  it("additive-only — DROP·TRUNCATE·UPDATE·ALTER TYPE 이 실행 경로에 하나도 없다", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|STATISTICS|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/^\s*UPDATE\s+summary_/im);
    // 기존 `rank_sum` 은 GEO 위젯(toGeoKpi 의 posSum)의 정본이다 — 타입도 뜻도 안 건드린다.
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+rank_sum/i);
  });

  it("두 컬럼은 summary_trend_brands 에만, 0065 규약대로 NOT NULL DEFAULT 0 으로 붙는다", () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.summary_trend_brands ADD COLUMN comp_rank_sum real NOT NULL DEFAULT 0/,
    );
    expect(sql).toMatch(
      /ALTER TABLE public\.summary_trend_brands ADD COLUMN comp_ranked_answers int NOT NULL DEFAULT 0/,
    );
    // 표를 잘못 고르면 조용히 틀린다.
    for (const t of ["summary_trend_answers", "summary_trend_domains", "summary_trend_own"]) {
      for (const c of ["comp_rank_sum", "comp_ranked_answers"]) {
        expect(sql, `${t} 에 ${c} 가 붙었다`).not.toMatch(
          new RegExp(`ALTER TABLE public\\.${t} ADD COLUMN ${c}`),
        );
      }
    }
    // 타입은 기존 짝(`rank_sum real` · `ranked_answers int`)과 같아야 한다.
    expect(sql).toMatch(/comp_rank_sum real\b/);
    expect(sql).toMatch(/comp_ranked_answers int\b/);
  });

  it("두 컬럼 다 카탈로그 선확인 뒤에만 ALTER 한다 (멱등)", () => {
    for (const col of ["comp_rank_sum", "comp_ranked_answers"]) {
      expect(sql, `${col} 선확인 없음`).toMatch(
        new RegExp(`attname = '${col}'[\\s\\S]{0,260}ADD COLUMN ${col}`),
      );
    }
    // 극성 — `NOT EXISTS` 가 뒤집히면 재실행이 깨지거나 아무것도 안 하고 통과한다.
    expect(sql.match(/IF NOT EXISTS \(\s*\n\s*SELECT 1 FROM pg_attribute/g) ?? []).toHaveLength(2);
    expect(sql).not.toMatch(/IF EXISTS \(\s*\n\s*SELECT 1 FROM pg_attribute[\s\S]{0,300}ADD COLUMN/);
  });

  it("'조용한 0' 해소 절차(refold)가 실행 가능한 형태로 박혀 있다 (0067 D1 의 재발 방지)", () => {
    expect(raw).toMatch(/309,037/); // 조용한 0 이 되는 기존 행 수(실측)
    // 세 플래그가 다 있어야 한다 — `--surface` 없으면 usage 종료, `--yes` 없으면 DRY-RUN.
    expect(raw).toMatch(/--surface=global\s+--refold --all-published --yes/);
    expect(raw).toMatch(/--surface=website --refold --all-published --yes/);
    expect(raw).toMatch(/DRY-RUN/);
    expect(raw).toMatch(/usage/);
    // 사후 확인 쿼리 + "0 이면 실패" 판정 근거(비교 모수).
    expect(raw).toMatch(/comp_ranked_answers > 0/);
    expect(raw).toMatch(/0 이면 refold 가 안 돈 것/);
    // refold 는 덮어쓰기다 — 값 확인을 **먼저** 하라는 절차가 있어야 한다(검증자 F7).
    expect(raw).toMatch(/fold-dryrun\.ts/);
    expect(raw).toMatch(/--surface=global --cycle=74eca7fb/);
    // §③ 확인 쿼리의 기대값 — 반올림 경계 바로 아래라 "3.4" 로 적으면 오판을 부른다.
    expect(raw).toMatch(/기대: \*\*≈ 3\.3469\*\*/);
    expect(raw).not.toMatch(/기대: \*\*3\.4\*\*/);
  });

  it("백필이 **없다**는 것과 그 이유가 적혀 있다", () => {
    // 0067 과 다른 점 — 경쟁 순위는 세부층에서 창 함수로 계산되므로 세부층 변경도
    // 대량 UPDATE 도 없다. 이 문장이 사라지면 다음 사람이 있지도 않은 백필을 찾는다.
    expect(raw).toMatch(/세부층을 건드리지 않는다/);
    expect(raw).toMatch(/백필/);
    expect(raw).toMatch(/대량 UPDATE 도 없다/);
  });

  it("왜 새 컬럼인지(기존 rank_sum 과 다른 양)가 실측과 함께 남아 있다", () => {
    // 이 근거가 없으면 다음 사람이 "중복이네" 하고 하나로 합친다 — 그 순간 축이 다시 갈린다.
    // 실측표는 **이 파일이 정본**이다(검증자 F4 — 사본 셋이 서로 다른 값을 들고 있었다).
    // 값은 2026-09-11 독립 재현: 접기 스코프 · is_competitor=1 · numeric 누적.
    for (const [brand, ord, comp] of [
      ["Hyundai", "16.4041", "3.3469"],
      ["Kia", "17.3410", "3.6253"],
      ["Genesis", "18.3362", "3.5407"],
      ["Tesla", "18.9899", "3.9765"],
      ["Toyota", "19.5979", "4.1950"],
      ["BMW", "23.2787", "5.2305"],
      ["Mercedes-Benz", "23.8676", "5.4067"],
    ] as const) {
      expect(raw, brand).toContain(`| ${ord} | ${comp} |`);
    }
    // 스코프를 안 적으면 다음 사람이 화면 값과 등호로 잇는다(게이트 후 3.3566).
    expect(raw).toMatch(/접기\(fold\) 스코프|접기 스코프/);
    expect(raw).toMatch(/3\.3566/);
    expect(raw).toMatch(/74eca7fb/);
    expect(raw).toMatch(/toGeoKpi/); // rank_sum 을 남기는 이유(소비자)
    const c = /COMMENT ON COLUMN summary_trend_brands\.comp_rank_sum IS[\s\S]*?;/.exec(raw)?.[0] ?? "";
    expect(c).toMatch(/rank\(\) OVER \(PARTITION BY job_id ORDER BY tp\)/);
    expect(c).toMatch(/같은 축/);
    expect(c).toMatch(/min\(brand_id\)/); // 대표 행 규약(이중 계상 방지)
    const c2 = /COMMENT ON COLUMN summary_trend_brands\.comp_ranked_answers IS[\s\S]*?;/.exec(raw)?.[0] ?? "";
    expect(c2).toMatch(/pos_cnt/);
  });

  it("컬럼 부재 내성이 문서화돼 있다 — 적용보다 배포가 먼저여도 42703 이 안 난다", () => {
    expect(raw).toMatch(/SYNC_PROBED_COLUMNS/);
    expect(raw).toMatch(/42703/);
  });

  it("ACL 을 닫는다 (0059·0064~0067 관례)", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON public\.summary_trend_brands FROM PUBLIC, anon, authenticated/,
    );
    // 이 표는 파티션이 아니다 — 자식 순회가 필요 없다는 근거가 파일에 있어야 한다.
    expect(raw).toMatch(/파티션이 아니다/);
  });
});

describe("0069 — out-of-band 규약", () => {
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
    const names = Object.values(snap.tables ?? {}).map((t) => t.name);
    expect(names).not.toContain("summary_trend_brands");

    const j = JSON.parse(fs.readFileSync(path.join(MIG_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    expect(j.entries.filter((e) => e.tag.startsWith("0069"))).toHaveLength(0);
  });
});
