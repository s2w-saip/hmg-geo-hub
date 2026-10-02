/**
 * 접기 4문장 **형태 테스트** (PR② T2).
 *
 * 왜 형태인가: 접기의 진짜 위험은 "틀린 값"이 아니라 **빠뜨린 컬럼**이다. 0065 가 확장 7컬럼을
 * `NOT NULL DEFAULT 0` 으로 붙였기 때문에, INSERT 컬럼 목록에서 하나가 빠져도 SQL 은 성공하고
 * 화면은 **조용히 0** 을 그린다(0065 머리 주석의 마스킹 경고). 그래서 마이그레이션 파일에서
 * 컬럼 목록을 **직접 파싱해** INSERT 목록과 집합 대조한다 — 컬럼이 늘면 이 테스트가 먼저 깨진다.
 *
 * 값 대조(집계층 SUM = 세부층 SUM)는 실 DB 가 필요해 별도다: `scripts/summary/fold-dryrun.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  assertVariants,
  foldBatches,
  foldSelects,
  foldTrendBrandsSelect,
  foldTrendOwnSelect,
  OWN_VARIANT_ALL,
  type FoldArgs,
  type OwnVariant,
} from "./fold";
import { AGG_TABLES, AGG_TIMING_KEYS } from "./types";

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q).sql;

const VARIANT: OwnVariant = {
  key: OWN_VARIANT_ALL,
  entityIds: ["00000000-0000-0000-0000-000000000301"],
  citationScopes: [
    { country: "", lang: "", bases: ["hyundai.com/kr"], fallbackPattern: "(^|\\.)(hyundai\\.com)$" },
  ],
};

const ARGS: FoldArgs = {
  keys: {
    cycleWeek: "2026-08-31",
    cycleId: "11111111-1111-4111-8111-111111111111",
    generationId: "22222222-2222-4222-8222-222222222222",
  },
  surface: "global",
  cycleAnchorAt: "2026-08-31T00:00:00.000Z",
  variants: [VARIANT],
  ownCitationsFrom: "scope",
};

// ── 마이그레이션에서 기대 컬럼 목록을 뽑는다 ─────────────────────────────────

/** `CREATE TABLE … ( … )` 안의 최상위 컬럼명. `PRIMARY KEY (…)` 절은 뺀다. */
function columnsOfCreateTable(ddl: string, table: string): string[] {
  const head = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = ddl.indexOf(head);
  if (start < 0) throw new Error(`${table} CREATE TABLE 을 못 찾았다`);
  let i = start + head.length;
  let depth = 0;
  let body = "";
  for (; i < ddl.length; i += 1) {
    const ch = ddl[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    body += ch;
  }
  const parts: string[] = [];
  let cur = "";
  depth = 0;
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim().split(/\s+/)[0] ?? "")
    .filter((n) => n && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(n));
}

const DDL_0059 = readFileSync("lib/db/migrations/0059_summary_tables.sql", "utf8");
const DDL_0065 = readFileSync("lib/db/migrations/0065_summary_aggregate_layer.sql", "utf8");

/** 0065 가 `summary_trend_own` 에 붙인 확장 컬럼 — DO 블록의 `cols text[] := ARRAY[…]`. */
const OWN_EXTRA = (() => {
  const m = DDL_0065.match(/cols text\[\] := ARRAY\[([\s\S]*?)\]/);
  if (!m) throw new Error("0065 확장 컬럼 배열을 못 찾았다");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
})();

const DDL_0066 = readFileSync("lib/db/migrations/0066_summary_aggregate_keys.sql", "utf8");
const DDL_0067 = readFileSync("lib/db/migrations/0067_summary_detail_report_fs.sql", "utf8");
const DDL_0069 = readFileSync("lib/db/migrations/0069_summary_trend_brands_comp_rank.sql", "utf8");

/**
 * `fold.ts` 의 `OWN_MEASURE_COLS` 정본 순서 — **소스에서 파싱한다**.
 * 테스트에 손으로 베껴 두면 둘이 같이 틀려도 안 깨진다(그럼 감시가 아니다).
 */
const OWN_MEASURE_COLS_EXPECTED = (() => {
  const src = readFileSync("lib/summary/generate/fold.ts", "utf8");
  const m = src.match(/const OWN_MEASURE_COLS = \[([\s\S]*?)\] as const;/);
  if (!m) throw new Error("fold.ts 의 OWN_MEASURE_COLS 를 못 찾았다");
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
})();

/** 0067 블록 ② — `summary_trend_own` 에만 붙는 측정 컬럼(키 아님). */
const OWN_EXTRA_0067 = [
  ...DDL_0067.matchAll(/public\.summary_trend_own ADD COLUMN (\w+)[^']*NOT NULL/g),
].map((m) => m[1]);

/** 0069 블록 ① — `summary_trend_brands` 에만 붙는 측정 컬럼(키 아님). */
const BRANDS_EXTRA_0069 = [
  ...DDL_0069.matchAll(/public\.summary_trend_brands ADD COLUMN (\w+)[^']*NOT NULL/g),
].map((m) => m[1]);

/** 0066 블록 ① — **4표 공통** 키 컬럼(`format('… public.%I ADD COLUMN …', t)`). */
const KEY_EXTRA = [...DDL_0066.matchAll(/public\.%I ADD COLUMN (\w+)[^,']*NOT NULL/g)].map((m) => m[1]);
/** 0066 블록 ①-b — `summary_trend_domains` 에만 붙는 측정 컬럼(키 아님). */
const DOMAINS_EXTRA = [
  ...DDL_0066.matchAll(/public\.summary_trend_domains ADD COLUMN (\w+)[^,']*NOT NULL/g),
].map((m) => m[1]);

const EXPECTED: Record<string, string[]> = {
  summary_trend_answers: [...columnsOfCreateTable(DDL_0059, "summary_trend_answers"), ...KEY_EXTRA],
  summary_trend_brands: [
    ...columnsOfCreateTable(DDL_0059, "summary_trend_brands"),
    ...KEY_EXTRA,
    ...BRANDS_EXTRA_0069,
  ],
  summary_trend_domains: [
    ...columnsOfCreateTable(DDL_0059, "summary_trend_domains"),
    ...KEY_EXTRA,
    ...DOMAINS_EXTRA,
  ],
  summary_trend_own: [
    ...columnsOfCreateTable(DDL_0059, "summary_trend_own"),
    ...OWN_EXTRA,
    ...KEY_EXTRA,
    ...OWN_EXTRA_0067,
  ],
};

/** 0066 이 재작성한 PK — 접기의 GROUP BY 키가 이 집합과 맞아야 한다(교차 대조). */
function pk0066(table: string): string[] {
  const m = new RegExp(`\\('${table}',\\s*\n?\\s*'([^']+)'\\)`).exec(DDL_0066);
  if (!m) throw new Error(`${table} 의 0066 PK 를 못 찾았다`);
  return m[1].split(",").map((c) => c.trim());
}

/** 컴파일된 문장에서 INSERT 대상 표와 컬럼 목록을 뽑는다. */
function insertColumns(stmt: string): { table: string; cols: string[] } {
  const m = stmt.match(/INSERT INTO\s+(\w+)\s*\(([^)]*)\)/);
  if (!m) throw new Error("INSERT 컬럼 목록을 못 찾았다");
  return { table: m[1], cols: m[2].split(",").map((c) => c.trim()).filter(Boolean) };
}

describe("접기 4문장 — 형태", () => {
  const batches = foldBatches(ARGS);

  it("표 순서·timings 키가 정본과 같다", () => {
    expect(batches.map((b) => b.table)).toEqual([...AGG_TABLES]);
    expect(batches.map((b) => b.key)).toEqual([...AGG_TIMING_KEYS]);
  });

  it("표마다 DELETE(멱등·옛 generation 정리)가 INSERT 앞에 온다", () => {
    for (const b of batches) {
      expect(b.statements).toHaveLength(2);
      const del = text(b.statements[0]);
      expect(del).toMatch(new RegExp(`^\\s*DELETE FROM ${b.table} WHERE cycle_id = `));
      expect(text(b.statements[1])).toContain(`INSERT INTO ${b.table}`);
    }
  });

  it.each(AGG_TABLES)("%s INSERT 가 표의 컬럼을 남김없이 채운다", (table) => {
    const b = batches.find((x) => x.table === table)!;
    const { table: got, cols } = insertColumns(text(b.statements[1]));
    expect(got).toBe(table);
    expect([...cols].sort()).toEqual([...EXPECTED[table]].sort());
  });

  it.each(AGG_TABLES)("%s INSERT 컬럼이 0066 PK 를 전부 포함한다", (table) => {
    // PK 컬럼이 INSERT 목록에 없으면 DEFAULT 로 채워져 **키가 뭉개진다**(0066 ⓪-b 가
    // 기존 행을 버린 것과 같은 이유). 두 파일이 어긋나면 여기서 먼저 깨진다.
    const b = batches.find((x) => x.table === table)!;
    const { cols } = insertColumns(text(b.statements[1]));
    for (const c of pk0066(table)) expect(cols, `${table}.${c} 가 INSERT 에 없다`).toContain(c);
  });

  it("summary_trend_own 이 0067 own_negative 를 명시적으로 적는다", () => {
    // 0065 와 같은 `DEFAULT 0` 마스킹 감시 — 빠지면 Sub-KPI negativeMentions 가 조용히 0 이 된다.
    const { cols } = insertColumns(text(batches[3].statements[1]));
    expect(OWN_EXTRA_0067).toEqual(["own_negative"]);
    expect(cols).toContain("own_negative");
  });

  it("fold-dryrun 이 own_negative 를 **독립 산식으로** 대조한다 (0065 가 말한 유일한 감시)", () => {
    // 형태 테스트는 "접기가 그 컬럼을 적었나" 만 본다. 값이 맞는지는 `fold-dryrun.ts` 의
    // 독립 재계산 대조가 유일한 감시다(0065 머리 주석). 거기서 빠지면 틀린 값이 그냥 통과한다.
    const dry = readFileSync("scripts/summary/fold-dryrun.ts", "utf8");
    expect(dry, "ob 갈래에 neg 원천이 없다").toContain("sum(negative)::bigint AS neg");
    expect(dry, "독립 산식 SELECT 에 own_negative 가 없다").toContain(
      "(SELECT COALESCE(sum(neg), 0)::bigint FROM ob) AS own_negative",
    );
    expect(dry, "접기 쪽 SELECT 에 own_negative 가 없다").toContain(
      "sum(own_negative)::bigint AS own_negative",
    );
    expect(dry, "report() 대조 목록에 own_negative 가 없다").toContain(
      'name: "own_negative", fold: n(f.own_negative), independent: n(d.own_negative)',
    );
  });

  it("own_negative 의 **산식**과 **자리**를 고정한다 (이름 존재만으로는 안 잡힌다)", () => {
    // 이름만 보면 두 가지가 통과해 버린다:
    //   ⓐ 의미 오염 — `sum(m.negative)` 를 `sum(m.positive)` 로 바꿔도 컬럼 이름은 그대로다.
    //   ⓑ 자리 어긋남 — UNION ALL 다섯 갈래는 **위치**로 맞물리므로, `OWN_MEASURE_COLS` 의
    //      순서와 바깥 SELECT 별칭 순서가 어긋나면 값이 옆 칸으로 샌다.
    // md5 스냅샷은 이 둘을 잡지만 `UPDATE_SQL_SNAPSHOT=1` 한 번이면 통과한다 — 여기서 못 박는다.
    const own = text(batches[3].statements[1]);

    // ⓐ 산식 — `ob` 갈래의 원천과 `pb` 갈래의 집계 양쪽.
    expect(own, "ob 갈래의 neg 원천 산식").toContain(
      "COALESCE(sum(m.negative), 0)::bigint AS neg",
    );
    expect(own, "pb 갈래의 own_negative 집계").toContain("COALESCE(sum(neg), 0)::bigint");
    // positive 로 바꿔치기하면 위 두 줄 중 하나는 반드시 깨진다.
    expect(own).toContain("COALESCE(sum(m.positive), 0)::bigint AS pos");

    // ⓑ-1 자리(INSERT 목록) — `OWN_MEASURES` 가 만드는 INSERT 컬럼 목록의 **꼬리**가
    //      정본 순서와 같아야 한다. 별칭 순서만 보면 `OWN_MEASURES` 안에서 순서를 바꿔도
    //      통과한다(md5 스냅샷만 잡는데 그건 UPDATE_SQL_SNAPSHOT=1 로 무력화된다).
    const { cols } = insertColumns(own);
    expect(
      cols.slice(-OWN_MEASURE_COLS_EXPECTED.length),
      "INSERT 컬럼 목록 꼬리의 측정값 순서가 정본과 다르다",
    ).toEqual([...OWN_MEASURE_COLS_EXPECTED]);

    // ⓑ-2 자리(바깥 SELECT) — `sum(<col>)::int AS <col>` 별칭 순서도 같아야 한다.
    // 바깥 SELECT 만 고른다 — 안쪽 다섯 갈래는 `::bigint` 라 이 패턴에 안 걸린다.
    const order = [...own.matchAll(/sum\((\w+)\)::(?:int|real) AS (\w+)/g)].map((m) => {
      expect(m[1], `바깥 SELECT 의 sum(${m[1]}) 별칭이 ${m[2]} 로 어긋났다`).toBe(m[2]);
      return m[2];
    });
    expect(order.length, "바깥 SELECT 측정 칸 수").toBe(OWN_MEASURE_COLS_EXPECTED.length);
    expect(order).toEqual([...OWN_MEASURE_COLS_EXPECTED]);
    // own_negative 는 정본 순서의 **마지막**(0067 이 뒤에 붙였다).
    expect(order[order.length - 1]).toBe("own_negative");
  });

  it("summary_trend_own 이 0065 확장 7컬럼을 **명시적으로** 적는다", () => {
    // 0065 의 `DEFAULT 0` 마스킹 감시(코디네이터 요건 1). 이름 하나라도 빠지면 실패한다.
    const { cols } = insertColumns(text(batches[3].statements[1]));
    expect(OWN_EXTRA).toHaveLength(7);
    for (const c of OWN_EXTRA) expect(cols, `${c} 누락`).toContain(c);
  });

  // ── 23505 재발 방지 (2026-09-10 백필 장애) ─────────────────────────────────
  // 원인: 접기 GROUP BY 에 **PK 에 없는 판별자**(`is_competitor`)가 있어, 과거 회차에서
  // 같은 brand_id 가 두 값을 가지면 두 그룹 → 같은 PK 로 INSERT → duplicate key.
  // "지금 0건" 실측으로 눌러 둔 전제였고, 과거 데이터가 그것을 깼다.
  // 이 테스트는 그 형태를 **구조적으로** 금지한다 — 값이 아니라 모양을 본다.
  it.each(AGG_TABLES)("%s 접기의 GROUP BY 항이 PK 의 부분집합이다 (23505 방지)", (table) => {
    const b = batches.find((x) => x.table === table)!;
    const stmt = text(b.statements[1]);
    // 마지막 GROUP BY = 바깥 집계(own 은 앞쪽에 갈래별 GROUP BY 가 더 있다).
    const gb = stmt.slice(stmt.lastIndexOf("GROUP BY ") + "GROUP BY ".length);
    const terms: string[] = [];
    let cur = "";
    let depth = 0;
    for (const ch of gb) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        terms.push(cur);
        cur = "";
      } else cur += ch;
    }
    terms.push(cur);

    const pk = new Set(pk0066(table));
    // PK 밖이지만 허용되는 유일한 항 — `project_id`.
    // 접기의 WHERE 가 `(cycle_id, generation_id)` 를 **상수로** 고정하고, 그 쌍 안에서
    // project_id 는 단일값이다(2026-09-10 전수 실측: 세부층 3표 × generation 쌍 106개 중
    // 다중 project 쌍 **0**). 즉 그룹을 쪼개지 않으므로 PK 충돌을 만들 수 없다.
    // 새 컬럼을 여기 추가하려면 **같은 수준의 실측**을 근거로 달 것.
    const CYCLE_DETERMINED = new Set(["project_id"]);
    for (const t of terms) {
      const term = t.trim();
      if (!term) continue;
      // `COALESCE(x.col, …)` · `x.col` · `col` 에서 컬럼 이름만 뽑는다.
      const name = (term.match(/COALESCE\(\s*(?:\w+\.)?(\w+)/i) ?? term.match(/(?:\w+\.)?(\w+)\s*$/))?.[1];
      expect(name, `GROUP BY 항을 못 읽었다: ${term}`).toBeTruthy();
      expect(
        pk.has(name!) || CYCLE_DETERMINED.has(name!),
        `${table}: GROUP BY 에 PK 밖 컬럼 '${name}' 이 있다 — 같은 PK 로 두 행이 나올 수 있다(23505)`,
      ).toBe(true);
    }
  });

  it("PK 밖 판별자는 집계로 접는다 — brands.is_competitor · domains.domain", () => {
    const brands = text(batches.find((x) => x.table === "summary_trend_brands")!.statements[1]);
    expect(brands, "is_competitor 가 집계되지 않았다").toContain(
      "max(m.is_competitor)::int AS is_competitor",
    );
    // ⚠️ `GROUP BY[\s\S]*m\.is_competitor` 로 보면 안 된다 — 0069 의 `bp` 갈래가 pm 의
    //    GROUP BY **뒤에** `WHERE … m.is_competitor = 1` 을 두므로 그 정규식은 오탐한다.
    //    실제로 봐야 하는 것은 **GROUP BY 절 안**이다.
    for (const gb of [...brands.matchAll(/GROUP BY ([^\n]*)/g)].map((m) => m[1])) {
      expect(gb, "is_competitor 가 아직 GROUP BY 에 있다").not.toContain("is_competitor");
    }
    const domains = text(batches.find((x) => x.table === "summary_trend_domains")!.statements[1]);
    expect(domains, "domain 이 집계되지 않았다").toContain("min(c.domain) AS domain");
    expect(domains, "domain 이 아직 GROUP BY 에 있다").not.toMatch(/GROUP BY[\s\S]*c\.domain/);
  });

  it("foldSelects 의 컬럼 목록에 중복이 없다(INSERT 위치 매핑의 전제)", () => {
    for (const f of foldSelects(ARGS)) {
      expect(new Set(f.columns).size, `${f.table} 컬럼 중복`).toBe(f.columns.length);
      expect([...f.columns].sort()).toEqual([...EXPECTED[f.table]].sort());
    }
  });

  it("prompts_measured 는 답변 표의 DISTINCT prompt 다(그룹 간 SUM 은 이중 계상 — 0065 COMMENT)", () => {
    expect(text(foldTrendOwnSelect(ARGS))).toContain("count(DISTINCT prompt_id)::bigint AS prompts_measured");
  });
});

describe("④ 축 세 컬럼 — brands.rank_sum ≠ brands.comp_rank_sum = own.rank_sum", () => {
  const brands = text(foldTrendBrandsSelect(ARGS));
  const own = text(foldTrendOwnSelect(ARGS));

  it("brands.rank_sum 은 브랜드별 first_rank 합이다(세부층 PK 가 이미 job×브랜드 최소값)", () => {
    // 0069 이후에도 **이 컬럼은 안 바뀐다** — GEO 위젯(toGeoKpi 의 posSum)이 이 정의를 쓴다.
    expect(brands).toContain("sum(m.first_rank) FILTER (WHERE m.first_rank IS NOT NULL)");
    // 서수 갈래(pm)에는 창 함수가 없다 — 창 함수는 경쟁 순위 갈래(bp→rk)에만 있다.
    const pm = brands.slice(brands.indexOf("pm AS ("), brands.indexOf("bp AS ("));
    expect(pm, "서수 갈래에 창 함수가 섞였다").not.toContain("rank() OVER");
  });

  // ── 0069 (PR④-b) ─────────────────────────────────────────────────────────
  it("brands.comp_rank_sum 은 own 과 **글자 그대로 같은 규칙**을 쓴다", () => {
    // 이 테스트가 이 PR 의 본질이다: 두 문장이 같은 축을 내는지는 **규칙 문자열이
    // 같은가** 로만 기계 검증할 수 있다. 한쪽 산식을 손대면 여기가 먼저 깨진다.
    const RULE_GATE = "m.is_competitor = 1 AND m.first_rank IS NOT NULL";
    const RULE_TP = "min(m.first_rank) AS tp";
    for (const t of [brands, own]) {
      expect(t, "모집단 게이트가 다르다").toContain(RULE_GATE);
      expect(t, "표시명 대표 서수 식이 다르다").toContain(RULE_TP);
    }
    // 창은 job(+own 은 변형)으로만 갈린다. `dense_rank()` 로 바뀌면 동률 답변에서만
    // 값이 조용히 낮아진다 — 이름을 못 박는다(미러도 `rank()` 다).
    expect(brands).toContain("rank() OVER (PARTITION BY job_id ORDER BY tp) AS rk");
    expect(own).toContain("rank() OVER (PARTITION BY job_id, own_variant ORDER BY tp) AS rk");
    for (const t of [brands, own]) expect(t).not.toContain("dense_rank(");
    // 표시명 그레인 — brand_id 로 접으면 순위가 밀린다(SGA:205-225).
    expect(brands).toMatch(/min\(m\.first_rank\) AS tp[\s\S]*?m\.job_id, m\.brand_name/);
    expect(own).toMatch(/min\(m\.first_rank\) AS tp[\s\S]*?v\.own_variant, m\.job_id, m\.brand_name/);
  });

  it("경쟁 순위는 표시명당 **대표 brand_id 한 행**에만 실린다(이중 계상 방지)", () => {
    // 한 표시명에 brand_id 가 둘 이상인 경우가 실재한다(글로벌 74eca7fb: 1,103개 중 10개).
    // 두 행에 각각 얹으면 리더가 brand_name 으로 롤업할 때 같은 답변을 두 번 센다.
    // ⚠️ `::text` 는 장식이 아니다 — PG 17 에는 `min(uuid)` 집계가 없다(실측: min 인자
    //    22종에 uuid 없음, PG 18 부터). 빼면 접기가 42883 으로 죽는다.
    expect(brands).toContain("min(m.brand_id::text) AS rep_brand_id");
    expect(brands).toContain("min(rep_brand_id)::uuid AS brand_id");
    // pr 의 GROUP BY 는 brand_id 가 **아니라** brand_name 이어야 한다(그래야 대표가 하나).
    const pr = brands.slice(brands.indexOf("pr AS ("), brands.indexOf("parts AS ("));
    const gb = pr.slice(pr.lastIndexOf("GROUP BY "));
    expect(gb, "pr 이 brand_id 로 그룹핑하면 대표가 표시명당 여럿이 된다").toContain("brand_name");
    expect(gb).not.toContain("brand_id");
  });

  it("두 갈래가 UNION ALL 로 합쳐지고 측정 17칸이 자리로 맞물린다", () => {
    // own 과 같은 이유로 조인이 아니라 UNION ALL 이다(통계 없는 generation → Nested Loop).
    expect(brands).toContain("parts AS (SELECT * FROM pm UNION ALL SELECT * FROM pr)");
    expect(brands.match(/UNION ALL/g)?.length).toBe(1);
    // 자리 — 두 갈래 + 바깥 SELECT 가 각각 17칸을 **이름으로** 낸다.
    for (const c of ["is_competitor", "mentions", "rank_sum", "comp_rank_sum", "comp_ranked_answers"]) {
      expect(brands.match(new RegExp(`AS ${c}\\b`, "g"))?.length, c).toBe(3);
    }
    // INSERT 컬럼 목록의 꼬리가 정본 순서와 같아야 한다(옆 칸으로 새는 것 방지).
    const cols = insertColumns(
      text(foldBatches(ARGS).find((x) => x.table === "summary_trend_brands")!.statements[1]),
    ).cols;
    expect(cols.slice(-2)).toEqual(["comp_rank_sum", "comp_ranked_answers"]);
    expect(BRANDS_EXTRA_0069).toEqual(["comp_rank_sum", "comp_ranked_answers"]);
  });

  it("fold-dryrun 이 comp_rank_sum 을 **독립 산식으로** 대조한다", () => {
    // 형태 테스트는 "그 컬럼을 적었나" 만 본다. 값이 맞는지는 드라이런의 독립 재계산이
    // 유일한 감시다(0065 머리 주석 · own_negative 와 같은 자세). 독립 산식은 **키 차원을
    // 아예 안 쓴다** — 키가 job 을 분할한다는 전제(§3-4)가 깨지면 합계가 갈려 잡힌다.
    const dry = readFileSync("scripts/summary/fold-dryrun.ts", "utf8");
    expect(dry, "접기 쪽 SELECT 에 comp_rank_sum 이 없다").toContain(
      "sum(comp_ranked_answers)::bigint AS comp_ranked_answers",
    );
    expect(dry, "독립 산식에 키 없는 rank() 창이 없다").toContain(
      "rank() OVER (PARTITION BY job_id ORDER BY tp) AS rk FROM bp",
    );
    // ⚠️ 집계 안에 창 함수를 직접 넣으면 PG 가 거부한다(42803) — 반드시 서브쿼리 한 겹.
    expect(dry, "sum() 안에 창 함수를 직접 넣었다 — PG 가 거부한다").not.toMatch(
      /sum\(\s*rank\(\) OVER/,
    );
    expect(dry, "report() 대조 목록에 comp_ranked_answers 가 없다").toContain(
      'name: "comp_ranked_answers"',
    );
  });

  it("`rank_sum` 의 NULL 의미가 보존된다 — 안 채운 칸이 0 이 아니라 NULL 이다", () => {
    // 0059 에서 brands.rank_sum 만 nullable 이다. pr 갈래가 `0::real` 을 내면 바깥 sum() 이
    // NULL 을 무시해 "순위가 없었다"(NULL)가 "합이 0"(0)으로 조용히 바뀐다.
    expect(brands).toContain("NULL::real AS rank_sum");
    expect(brands).toContain("sum(rank_sum)::real AS rank_sum");
    // 새 두 칸은 0069 가 NOT NULL DEFAULT 0 이라 0 이 정본이다.
    expect(brands).toContain("0::real AS comp_rank_sum");
    expect(brands).toContain("COALESCE(sum(comp_rank_sum), 0)::real AS comp_rank_sum");
  });

  it("own 은 job 별 당사 최선 **서수** 합이다(표시명 접기 → rank() → min)", () => {
    // 정본: summary-global-aggregates.ts::ownBrandRankByJobSql (PR #223).
    expect(own).toContain("rank() OVER (PARTITION BY job_id, own_variant ORDER BY tp)");
    expect(own).toContain("min(rk)::int AS tp");
    expect(own).toContain("COALESCE(sum(tp), 0)::bigint AS rank_sum");
    // 표시명(brand_name)으로 접는다 — brand_id 로 접으면 top3 경계가 밀린다(SGA 주석).
    expect(own).toContain("min(m.first_rank) AS tp");
    expect(own).toMatch(/min\(m\.first_rank\) AS tp[\s\S]*?v\.own_variant, m\.job_id, m\.brand_name/);
  });
});

describe("own 접기 — 모집단 게이트", () => {
  const own = text(foldTrendOwnSelect(ARGS));

  it("당사 언급(①·③)은 비경쟁 게이트를 걸지 않는다", () => {
    // `ob` CTE 의 WHERE 에 is_competitor 가 없어야 한다(리더 SGA:236-239·286-290 모집단).
    const ob = own.slice(own.indexOf("ob AS ("), own.indexOf("pb AS ("));
    const where = ob.slice(ob.lastIndexOf("WHERE "), ob.lastIndexOf("GROUP BY"));
    expect(where).toContain("m.brand_id = ANY(v.ids)");
    expect(where).not.toContain("is_competitor");
  });

  it("② 분모·타일·순위는 is_competitor = 1 안에서만 센다", () => {
    expect(own).toContain("COALESCE(sum(m.mentions) FILTER (WHERE m.is_competitor = 1), 0)");
    expect(own).toContain("m.is_competitor = 1 AND m.first_rank IS NOT NULL");
    const bn = own.slice(own.indexOf("bn AS ("), own.indexOf("pc AS ("));
    expect(bn).toContain("m.is_competitor = 1");
  });

  it("⑤ 분자는 $sel(base) + $fbRe(도메인 폴백) 두 갈래다", () => {
    expect(own).toContain("c.matched_base <> '' AND c.matched_base = ANY(sc.bases)");
    expect(own).toContain("c.base_norm_null = 1 AND sc.pat IS NOT NULL AND c.domain ~* sc.pat");
  });

  // ── 2026-09-10 프로덕션 실패의 회귀 가드 ─────────────────────────────────
  it("교차 테이블 조인이 **없다** — 새 generation 은 통계에 없어 조인이 전부 Nested Loop 로 뒤집힌다", () => {
    // 실측: 통계에 없는 generation_id 로 EXPLAIN 하면 추정이 rows=1 로 붕괴하고
    // (answers 3,902→1 · brands 22,911→1 · domains 9,610→1), 조인이 있던 옛 own 문장은
    // Nested Loop 6→11 · Hash Join 1→0 으로 뒤집혀 3.2 s 가 >600 s(타임아웃)가 됐다.
    // 허용되는 조인은 둘뿐이다: 변형 목록(CROSS JOIN v)과 스코프 LATERAL.
    const joins = [...own.matchAll(/(CROSS JOIN|LEFT JOIN|RIGHT JOIN|FULL JOIN|INNER JOIN|[^ ]JOIN) +([^ \n]+)/g)]
      .map((m) => `${m[1].replace(/^[^A-Z]/, "").trim()} ${m[2]}`);
    expect(joins.sort()).toEqual([
      "CROSS JOIN v",
      "CROSS JOIN v",
      "CROSS JOIN v",
      "CROSS JOIN v",
      "CROSS JOIN v",
      "LEFT JOIN LATERAL",
    ]);
  });

  it("다섯 갈래가 UNION ALL 로 합쳐진다(측정값 18칸 정렬)", () => {
    expect(own.match(/UNION ALL/g)?.length).toBe(4);
    for (const cte of ["pa AS (", "pb AS (", "pc AS (", "pd AS (", "pe AS ("]) {
      expect(own, `${cte} 없음`).toContain(cte);
    }
    // 각 갈래가 18칸을 전부 이름으로 낸다 — 자리를 손으로 세지 않는다(5갈래 + 바깥 SELECT).
    for (const c of ["monitored", "tile_own_mentions", "prompts_measured", "rank_sum"]) {
      expect(own.match(new RegExp(`AS ${c}\\b`, "g"))?.length, c).toBe(6);
    }
  });

  it("② 타일 분자는 표시명 그룹의 bool_or 를 **생성 시각에** 접는다", () => {
    expect(own).toContain("bool_or(m.brand_id = ANY(v.ids)) AS is_own");
    expect(own).toContain("sum(mn) FILTER (WHERE is_own)");
  });
});

describe("변형 인자 검증", () => {
  const base = () => ({ ...ARGS, variants: [{ ...VARIANT }] });

  it("빈 목록을 거부한다", () => {
    expect(() => assertVariants([])).toThrow(/최소 1개/);
  });

  it("entityIds 가 비면 거부한다 — 당사 지표가 전부 0 이 된다", () => {
    expect(() => assertVariants([{ ...VARIANT, entityIds: [] }])).toThrow(/entityIds/);
  });

  it("citationScopes 가 비면 거부한다 — ⑤ 분자가 조용히 0 이 된다", () => {
    expect(() => assertVariants([{ ...VARIANT, citationScopes: [] }])).toThrow(/citationScopes/);
  });

  it("중복 키를 거부한다(PK 충돌 전에 잡는다)", () => {
    expect(() => assertVariants([VARIANT, VARIANT])).toThrow(/중복/);
  });

  it("변형 여러 개면 VALUES 에 전부 들어간다(T3 가 갈아끼울 자리)", () => {
    const args = base();
    args.variants = [VARIANT, { ...VARIANT, key: "Kia" }];
    const params = dialect.sqlToQuery(foldTrendOwnSelect(args)).params;
    expect(params).toContain(OWN_VARIANT_ALL);
    expect(params).toContain("Kia");
  });
});

/**
 * ⑤ 분자 출처의 표면 분기(PR② T3). 2026-09-10 실 DB 대조로 확정 —
 * 웹사이트는 세부층에 굳힌 `unit_owned_citations`(오늘 화면과 같은 컬럼), 글로벌은 `$sel` 판정.
 * 두 경로가 회차 `a3204f07` 에서 83 vs 102(⑤ 18.04% vs 22.17%)로 갈렸다.
 */
describe("⑤ 분자 출처 — ownCitationsFrom", () => {
  const own = (a: FoldArgs) => text(foldTrendOwnSelect(a));

  it("scope: $sel 판정(vs VALUES + LATERAL)을 만들고 unit 컬럼을 안 쓴다", () => {
    const t = own({ ...ARGS, ownCitationsFrom: "scope" });
    expect(t).toContain("vs(own_variant, country, lang, bases, pat) AS (VALUES");
    expect(t).toContain("matched_base = ANY(sc.bases)");
    expect(t).not.toContain("sum(c.unit_owned_citations)");
  });

  it("unit_column: unit_owned_citations 를 더하고 스코프 판정 CTE 를 아예 안 만든다", () => {
    const t = own({ ...ARGS, surface: "website", ownCitationsFrom: "unit_column" });
    expect(t).toContain("sum(c.unit_owned_citations)");
    // 안 쓰는 스코프 VALUES(변형 4개면 840행)와 LATERAL 이 남으면 그대로 비용이 된다.
    expect(t).not.toContain("vs(own_variant, country, lang, bases, pat)");
    expect(t).not.toContain("LEFT JOIN LATERAL (");
    // 폴백은 정의상 0 — 유닛 경로에는 서픽스 판정이 없다.
    expect(t).toContain("0::bigint AS own_fallback_citations");
  });

  it("두 경로 모두 측정 18칸을 그대로 낸다 — 컬럼이 빠지면 DEFAULT 0 이 조용히 메운다", () => {
    for (const from of ["scope", "unit_column"] as const) {
      const t = own({ ...ARGS, ownCitationsFrom: from });
      for (const c of ["own_citations", "own_fallback_citations", "comp_mentions", "tile_own_mentions"]) {
        expect(t, from).toContain(`AS ${c}`);
      }
    }
  });
});
