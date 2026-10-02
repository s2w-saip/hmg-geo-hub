/**
 * 집계층 접기 **드라이런** — 쓰기 0, 읽기·EXPLAIN 만 (PR② T2 수용 기준 ②·④).
 *
 * 왜 필요한가: 0065 가 아직 적용되지 않은 DB 에서는 접기 INSERT 를 돌려 볼 수 없다. 그런데
 * 확인해야 할 두 가지(집계층 SUM = 세부층 SUM · 접기 소요 ≤ 90 s)는 **SELECT 부분만으로**
 * 확인된다. 그래서 `fold.ts::foldSelects` 가 만든 **바로 그 SELECT** 를 감싸 집계하고,
 * 같은 값을 **독립 산식**(이 파일에 따로 적은 SQL)으로 다시 세어 대조한다.
 * 접기 SQL 로 접기 SQL 을 검증하면 "둘 다 같은 실수를 했다" 를 못 잡는다.
 *
 * 대조 대상은 §7-2 4 의 셋(mentions·citations·monitored)에 더해 **0065 확장 7컬럼 전부**다 —
 * 그 7개는 `NOT NULL DEFAULT 0` 이라 접기가 컬럼을 빠뜨려도 조용히 0 이 되고, 이 단언이
 * 유일한 감시다(0065 머리 주석 · 코디네이터 요건).
 *
 * 사용:
 *   npx tsx --env-file=.env.local scripts/summary/fold-dryrun.ts --surface=global --cycle=<uuid>
 *   npx tsx --env-file=.env.local scripts/summary/fold-dryrun.ts --surface=website --cycle=<uuid> [--explain]
 */
import { readFileSync } from "node:fs";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { createRuntime, generatorVersion } from "@/lib/summary/generate/context";
import { cycleByIdSql, type CycleRow } from "@/lib/summary/generate/cycle";
import {
  AGG_KEY_NAMES,
  aggKeyGroup,
  aggKeySelect,
  foldSelects,
  type FoldArgs,
  type OwnVariant,
} from "@/lib/summary/generate/fold";
import type { GenerationKeys } from "@/lib/summary/generate/types";
import { resolveOwnCitationScope } from "@/lib/summary/tenant/hmg";
import * as G from "./surface-global";
import * as W from "./surface-website";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const SURFACE = arg("surface");
const CYCLE_ID = arg("cycle");
const EXPLAIN = argv.includes("--explain");
/** 플랜만 본다(EXPLAIN, ANALYZE 없음). `--gen` 과 함께 쓰면 "통계에 없는 generation" 을 재현한다. */
const PLAN_ONLY = argv.includes("--plan");
const GEN_OVERRIDE = arg("gen");
/**
 * 통계가 없을 때(rows=1 추정) 플래너가 고르는 **정렬 기반 그룹집계**를 강제해 최악 소요를
 * 재는 스위치. 세션 GUC 만 바꾼다(데이터 무변경).
 */
const NO_HASHAGG = argv.includes("--no-hashagg");
/** 세션 `work_mem` 실험용(읽기 전용 GUC). 정렬 그룹집계 ↔ 해시집계 전환점을 재는 데 쓴다. */
const WORK_MEM = arg("work-mem");

const n = (v: unknown) => Number(v ?? 0);

/**
 * 0059/0065 에서 각 집계층 표의 **NOT NULL 컬럼**을 뽑는다.
 *
 * 왜: 세부층은 차원에 NULL 을 담는데 집계층은 `NOT NULL DEFAULT ''` 다. 접기 INSERT 를
 * 못 돌려 보는 동안(0065 미적용) not-null 위반은 **SELECT 만으로는 안 드러난다** —
 * 그래서 접기 SELECT 의 출력에서 직접 센다. (2026-09-10 실측: 이 검사가 없었으면
 * `brand_presence_resolved` 8,088행이 프로덕션 INSERT 에서 죽었을 것이다.)
 */
function tableBody(table: string): string {
  const ddl = readFileSync("lib/db/migrations/0059_summary_tables.sql", "utf8");
  const head = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = ddl.indexOf(head);
  if (start < 0) throw new Error(`${table} DDL 없음`);
  let depth = 0;
  let body = "";
  for (let i = start + head.length; i < ddl.length; i += 1) {
    const ch = ddl[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    body += ch;
  }
  return body;
}

/**
 * PK 컬럼 — 접기가 `is_competitor`·`domain` 처럼 PK 밖 컬럼으로도 그룹을 나누므로 유일성 실측이
 * 필요하다. 0066 이 PK 를 재작성했으므로 **그 파일이 정본**이고, 없으면 0059 로 폴백한다.
 */
function pkColumns(table: string): string[] {
  const k = readFileSync("lib/db/migrations/0066_summary_aggregate_keys.sql", "utf8");
  const m66 = new RegExp(`\\('${table}',\\s*\n?\\s*'([^']+)'\\)`).exec(k);
  if (m66) return m66[1].split(",").map((c) => c.trim()).filter(Boolean);
  const m = tableBody(table).match(/PRIMARY KEY\s*\(([\s\S]*?)\)/);
  if (!m) throw new Error(`${table} PK 없음`);
  return m[1].split(",").map((c) => c.trim()).filter(Boolean);
}

function notNullColumns(table: string): string[] {
  const body = tableBody(table);
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const cols = parts
    .map((x) => x.trim())
    .filter((x) => /NOT NULL/i.test(x) && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)/i.test(x))
    .map((x) => x.split(/\s+/)[0]);
  if (table === "summary_trend_own") {
    const m = readFileSync("lib/db/migrations/0065_summary_aggregate_layer.sql", "utf8")
      .match(/cols text\[\] := ARRAY\[([\s\S]*?)\]/);
    if (m) cols.push(...[...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
  }
  // 0066 블록 ① — 4표 공통 NOT NULL 키(report_fs · presence_set).
  const k66 = readFileSync("lib/db/migrations/0066_summary_aggregate_keys.sql", "utf8");
  for (const m of k66.matchAll(/public\.%I ADD COLUMN (\w+)[^,']*NOT NULL/g)) {
    if (!cols.includes(m[1])) cols.push(m[1]);
  }
  // 0066 블록 ①-b — summary_trend_domains 전용 측정 컬럼.
  for (const m of k66.matchAll(/public\.(summary_trend_\w+) ADD COLUMN (\w+)[^,']*NOT NULL/g)) {
    if (m[1] === table && !cols.includes(m[2])) cols.push(m[2]);
  }
  return cols;
}


type Check = { name: string; fold: number; independent: number };

function report(rows: Check[]): boolean {
  let ok = true;
  for (const r of rows) {
    const diff = r.fold - r.independent;
    if (diff !== 0) ok = false;
    console.log(
      `  ${diff === 0 ? "✓" : "✗"} ${r.name.padEnd(28)} 접기=${String(r.fold).padStart(12)}` +
        `  독립=${String(r.independent).padStart(12)}  Δ=${diff}`,
    );
  }
  return ok;
}

async function main() {
  if (SURFACE !== "global" && SURFACE !== "website") {
    console.error("--surface=global|website 이 필요하다");
    return 2;
  }
  if (!CYCLE_ID) {
    console.error("--cycle=<uuid> 가 필요하다");
    return 2;
  }
  const db = getDb();
  await db.execute(sql`SET statement_timeout = '10min'`);
  if (NO_HASHAGG) await db.execute(sql`SET enable_hashagg = off`);
  if (WORK_MEM) await db.execute(sql`SET work_mem = ${sql.raw(`'${WORK_MEM}'`)}`);
  const rt = createRuntime({ db, version: generatorVersion(`${SURFACE}-fold-dryrun`) });

  const cycle = (await rt.rows<CycleRow>(cycleByIdSql(CYCLE_ID)))[0];
  if (!cycle) {
    console.error(`회차 ${CYCLE_ID} 없음`);
    return 1;
  }
  if (!cycle.active_generation_id) {
    console.error(`회차 ${CYCLE_ID} 에 활성 generation 이 없다 — 드라이런 대상이 아니다`);
    return 1;
  }
  const keys: GenerationKeys = {
    cycleWeek: cycle.cycle_week.slice(0, 10),
    cycleId: cycle.cycle_id,
    // `--gen` 은 **플랜 재현 전용**이다(H1: 통계에 없는 generation_id 의 추정 붕괴).
    // 값 대조는 활성 generation 으로만 의미가 있으므로 --plan 과 함께만 쓴다.
    generationId: GEN_OVERRIDE ?? cycle.active_generation_id,
  };
  if (GEN_OVERRIDE && !PLAN_ONLY) {
    console.error("--gen 은 --plan 과 함께만 쓴다(값 대조가 무의미해진다)");
    return 2;
  }
  const variants: OwnVariant[] =
    SURFACE === "global" ? G.ownVariants(await G.loadCtx(rt)) : W.ownVariants(await W.loadCtx(rt));
  const args: FoldArgs = {
    keys,
    surface: SURFACE,
    cycleAnchorAt: cycle.cycle_anchor_at,
    variants,
    // 표면별 ⑤ 정본(2026-09-10 실 DB 대조) — `fold.ts::FoldArgs.ownCitationsFrom` 주석 참고.
    ownCitationsFrom: SURFACE === "website" ? "unit_column" : "scope",
  };
    // 0066 이 재작성한 PK 를 **마이그레이션 파일에서 파싱**한다 — 여기 베껴 두면
  // 스키마가 바뀔 때 둘이 같이 틀려도 안 깨진다(fold.test.ts 의 pk0066 과 같은 자세).
  const PK_BY_TABLE: Record<string, string[] | undefined> = (() => {
    const ddl = readFileSync("lib/db/migrations/0066_summary_aggregate_keys.sql", "utf8");
    const out: Record<string, string[]> = {};
    for (const m of ddl.matchAll(/\('(summary_trend_\w+)',\s*\n?\s*'([^']+)'\)/g)) {
      // `cycle_id`·`generation_id` 는 접기 SELECT 안에서 상수라 GROUP BY 대상이 아니다.
      out[m[1]] = m[2].split(",").map((c) => c.trim()).filter((c) => c !== "cycle_id" && c !== "generation_id");
    }
    return out;
  })();

  const selects = foldSelects(args);

  rt.log(
    `회차 ${keys.cycleId} · gen ${keys.generationId} · week ${keys.cycleWeek} · ` +
      `변형 ${variants.map((v) => v.key).join(",")} · 쓰기 없음`,
  );

  // ── 플랜 전용 모드 — EXPLAIN(ANALYZE 없음)으로 **추정치와 플랜 형태**만 본다.
  if (PLAN_ONLY) {
    for (const f of selects) {
      const rows = await rt.rows<Record<string, string>>(sql`EXPLAIN ${f.select}`);
      const lines = rows.map((r) => Object.values(r)[0] as string);
      const top = /rows=(\d+)/.exec(lines[0] ?? "")?.[1] ?? "?";
      const nest = lines.filter((l) => l.includes("Nested Loop")).length;
      const mat = lines.filter((l) => l.includes("Materialize")).length;
      const hash = lines.filter((l) => l.includes("Hash Join")).length;
      const merge = lines.filter((l) => l.includes("Merge Join")).length;
      console.log(
        `\n[${f.table}] 최상위 추정 rows=${top} · Nested Loop ${nest} · Hash Join ${hash} · Merge Join ${merge} · Materialize ${mat}`,
      );
      for (const l of lines) console.log("   " + l);
    }
    return 0;
  }

  // ── 세부층 술어 (독립 산식이 쓰는 것 — 접기와 같은 창) ────────────────────
  const S = sql`cycle_week = ${keys.cycleWeek}::date AND cycle_id = ${keys.cycleId}::uuid AND generation_id = ${keys.generationId}::uuid`;
  const v0 = variants[0];
  const own = sql`${sql.param(v0.entityIds)}::uuid[]`;
  /**
   * ⑤ 판정 스코프의 **독립 경로**(PR② T3). 접기 SQL 은 (변형, 국가, 언어) → 스코프 행을
   * `vsel` LATERAL 로 고르는데, 여기서는 같은 선택을 **JS**(`resolveOwnCitationScope`)로 해서
   * 이미 고른 값만 VALUES 로 넘긴다. 둘이 갈리면(와일드카드 우선순위·동점 규칙) 이 대조가 잡는다 —
   * 스코프 행이 하나도 안 맞으면 `bases` 가 NULL 이 돼 ⑤ 분자가 **조용히 0** 이 되는 자리다.
   */
  const clPairs = await rt.rows<{ country: string; lang: string }>(
    sql`SELECT DISTINCT country, COALESCE(lang, '') AS lang FROM summary_domain_citations WHERE ${S}`,
  );
  const indScope = sql.join(
    clPairs.map((cl) => {
      const sc = resolveOwnCitationScope(v0.citationScopes, cl.country, cl.lang);
      if (!sc) throw new Error(`드라이런: (${cl.country}, ${cl.lang}) 에 맞는 스코프 행이 없다`);
      return sql`(${cl.country}::text, ${cl.lang}::text, ${sql.param(sc.bases)}::text[], ${sc.fallbackPattern}::text)`;
    }),
    sql`, `,
  );
  /** 와일드카드('','') 행 = 오늘의 **무필터** 화면 스코프. 대조가 아니라 참고 수치다(T11 격자). */
  const wild = v0.citationScopes.find((x) => x.country === "" && x.lang === "")!;
  const UNIT_PATH = args.ownCitationsFrom === "unit_column";
  // ⑤ 분자의 독립 산식 — 표면 정본 경로를 따라간다(fold.ts::FoldArgs.ownCitationsFrom).
  const indOwnCit = UNIT_PATH
    ? sql`(SELECT COALESCE(sum(unit_owned_citations), 0)::bigint
             FROM summary_domain_citations WHERE ${S})`
    : sql`(SELECT COALESCE(sum(c.citations) FILTER (
              WHERE c.matched_base <> '' AND c.matched_base = ANY(s.bases)), 0)::bigint
             FROM summary_domain_citations c
             JOIN ind_scope s ON s.country = c.country AND s.lang = COALESCE(c.lang, '')
             WHERE ${S})`;
  const indOwnFb = UNIT_PATH
    ? sql`0::bigint`
    : sql`(SELECT COALESCE(sum(c.citations) FILTER (
              WHERE c.base_norm_null = 1 AND s.pat IS NOT NULL AND c.domain ~* s.pat), 0)::bigint
             FROM summary_domain_citations c
             JOIN ind_scope s ON s.country = c.country AND s.lang = COALESCE(c.lang, '')
             WHERE ${S})`;
  // 차원 정규화(NULL → '')는 접기와 **같은 규칙**을 써야 대조가 성립한다 — fold.ts 가 정본.
  const dims = sql.raw(AGG_KEY_NAMES.join(", "));
  // 브랜드 표에는 report_fs 가 없다(0066) — 접기와 **같은 방식**으로 답변 표를 조인해 온다.
  const dimsSelM = sql.raw(aggKeySelect("m", "ra."));
  const dimsGrpM = sql.raw(aggKeyGroup("m", "ra."));
  const dimsSelA = sql.raw(aggKeySelect("a", "a."));
  const raJoin = sql`JOIN summary_answers ra
        ON ra.cycle_week = ${keys.cycleWeek}::date AND ra.cycle_id = ${keys.cycleId}::uuid
       AND ra.generation_id = ${keys.generationId}::uuid AND ra.job_id = m.job_id`;

  /** 접기 SELECT 를 감싸 합계를 낸다 — 컴파일된 문장 그대로 쓴다. */
  const foldAgg = async (
    table: string,
    expr: SQL,
    where?: SQL,
  ): Promise<Record<string, unknown>> => {
    const f = selects.find((s) => s.table === table)!;
    const rows = await rt.rows<Record<string, unknown>>(
      where
        ? sql`SELECT ${expr} FROM (${f.select}) AS t WHERE ${where}`
        : sql`SELECT ${expr} FROM (${f.select}) AS t`,
    );
    return rows[0] ?? {};
  };
  const one = async (q: SQL): Promise<Record<string, unknown>> =>
    (await rt.rows<Record<string, unknown>>(q))[0] ?? {};

  let allOk = true;

  // ── ① trend_answers ────────────────────────────────────────────────────────
  console.log("\n[trend_answers]");
  {
    const f = await foldAgg(
      "summary_trend_answers",
      sql`count(*)::bigint AS rows, sum(monitored)::bigint AS monitored,
          sum(all_mentions)::bigint AS all_mentions, sum(all_citations)::bigint AS all_citations,
          sum(has_any_brand)::bigint AS has_any_brand`,
    );
    const d = await one(sql`
      SELECT sum(monitored)::bigint AS monitored, sum(all_mentions)::bigint AS all_mentions,
             sum(all_citations)::bigint AS all_citations, sum(has_any_brand)::bigint AS has_any_brand
      FROM summary_answers WHERE ${S}`);
    console.log(`  행 ${n(f.rows)}`);
    allOk =
      report([
        { name: "monitored", fold: n(f.monitored), independent: n(d.monitored) },
        { name: "all_mentions", fold: n(f.all_mentions), independent: n(d.all_mentions) },
        { name: "all_citations", fold: n(f.all_citations), independent: n(d.all_citations) },
        { name: "has_any_brand", fold: n(f.has_any_brand), independent: n(d.has_any_brand) },
      ]) && allOk;
  }

  // ── ② trend_brands ─────────────────────────────────────────────────────────
  console.log("\n[trend_brands]");
  {
    const f = await foldAgg(
      "summary_trend_brands",
      sql`count(*)::bigint AS rows, sum(mentions)::bigint AS mentions,
          sum(answers)::bigint AS answers, sum(ranked_answers)::bigint AS ranked_answers,
          round(sum(rank_sum)::numeric, 2) AS rank_sum, sum(positive)::bigint AS positive,
          round(sum(comp_rank_sum)::numeric, 2) AS comp_rank_sum,
          sum(comp_ranked_answers)::bigint AS comp_ranked_answers`,
    );
    const d = await one(sql`
      SELECT sum(mentions)::bigint AS mentions, count(*)::bigint AS answers,
             count(*) FILTER (WHERE first_rank IS NOT NULL)::bigint AS ranked_answers,
             round(sum(first_rank)::numeric, 2) AS rank_sum, sum(positive)::bigint AS positive
      FROM summary_brand_mentions WHERE ${S}`);
    // 0069 — 답변 안 경쟁 순위의 **독립 산식**. 접기와 달리 키 차원을 아예 안 쓴다:
    // 키 차원은 job 이 정하므로(§3-4 전제) job 안 순위는 키 그룹과 무관해야 하고,
    // 따라서 전 키 그룹 합계가 이 값과 **정확히** 같아야 한다. 다르면 둘 중 하나다 —
    // ⓐ 대표 brand_id 몰아주기가 표시명당 둘 이상을 만들었다(이중 계상) ⓑ 창이 어긋났다.
    const dc = await one(sql`
      WITH bp AS (
        SELECT job_id, brand_name, min(first_rank) AS tp
        FROM summary_brand_mentions
        WHERE ${S} AND is_competitor = 1 AND first_rank IS NOT NULL
        GROUP BY 1, 2
      )
      , rkx AS (
        SELECT rank() OVER (PARTITION BY job_id ORDER BY tp) AS rk FROM bp
      )
      SELECT round(sum(rk)::numeric, 2) AS comp_rank_sum,
             count(*)::bigint AS comp_ranked_answers
      FROM rkx`);
    console.log(`  행 ${n(f.rows)}`);
    allOk =
      report([
        { name: "mentions", fold: n(f.mentions), independent: n(d.mentions) },
        // 세부층 PK 가 job×브랜드라 "브랜드별 job distinct 합" = 세부층 행수와 같아야 한다.
        { name: "answers(=세부층 행수)", fold: n(f.answers), independent: n(d.answers) },
        { name: "ranked_answers", fold: n(f.ranked_answers), independent: n(d.ranked_answers) },
        { name: "positive", fold: n(f.positive), independent: n(d.positive) },
        // 0069 — 표시명 그레인이라 `ranked_answers`(id 그레인)보다 작거나 같다.
        {
          name: "comp_ranked_answers",
          fold: n(f.comp_ranked_answers),
          independent: n(dc.comp_ranked_answers),
        },
      ]) && allOk;
    console.log(`  · rank_sum 접기=${f.rank_sum} 독립=${d.rank_sum} (real 누적오차 허용)`);
    console.log(
      `  · comp_rank_sum 접기=${f.comp_rank_sum} 독립=${dc.comp_rank_sum} (real 누적오차 허용)`,
    );
    // §7-2 2 — 브랜드 축을 가로질러 SUM 한 answers 는 답변 수와 **달라야** 한다.
    const jobs = n((await one(sql`SELECT count(*)::bigint AS c FROM summary_answers WHERE ${S}`)).c);
    const dup = n(f.answers) !== jobs;
    console.log(
      `  ${dup ? "✓" : "✗"} §7-2 2 이중 계상 단언: brands.answers 합(${n(f.answers)}) ≠ 답변 수(${jobs})`,
    );
    allOk = dup && allOk;
  }

  // ── ③ trend_domains ────────────────────────────────────────────────────────
  console.log("\n[trend_domains]");
  {
    const f = await foldAgg(
      "summary_trend_domains",
      sql`count(*)::bigint AS rows, sum(citations)::bigint AS citations,
          sum(citing_answers)::bigint AS citing_answers`,
    );
    const d = await one(sql`
      SELECT sum(citations)::bigint AS citations, count(*)::bigint AS rows
      FROM summary_domain_citations WHERE ${S}`);
    console.log(`  행 ${n(f.rows)}`);
    allOk =
      report([
        { name: "citations", fold: n(f.citations), independent: n(d.citations) },
        { name: "citing_answers(=세부층 행수)", fold: n(f.citing_answers), independent: n(d.rows) },
      ]) && allOk;
  }

  // ── ④ trend_own — 0065 확장 7컬럼 포함 전수 ────────────────────────────────
  console.log(`\n[trend_own · own_variant=${v0.key}]`);
  {
    // ⚠️ 변형이 여럿이면 표 전체 합은 변형 수만큼 부풀어 오른다(PR② T3: ALL + 브랜드 3).
    //    독립 산식이 변형 하나(`v0`)의 정의라, 접기 쪽도 **그 변형으로 좁혀** 대조한다.
    const f = await foldAgg(
      "summary_trend_own",
      sql`count(*)::bigint AS rows, sum(monitored)::bigint AS monitored,
          sum(tracked_answers)::bigint AS tracked_answers, sum(multi_answers)::bigint AS multi_answers,
          sum(top1_answers)::bigint AS top1_answers, sum(top3_answers)::bigint AS top3_answers,
          sum(rank_sum)::bigint AS rank_sum, sum(ranked_answers)::bigint AS ranked_answers,
          sum(own_mentions)::bigint AS own_mentions, sum(own_positive)::bigint AS own_positive,
          sum(own_negative)::bigint AS own_negative,
          sum(own_signals)::bigint AS own_signals,
          sum(comp_mentions)::bigint AS comp_mentions, sum(all_citations)::bigint AS all_citations,
          sum(own_citations)::bigint AS own_citations,
          sum(own_fallback_citations)::bigint AS own_fallback_citations,
          sum(tile_own_mentions)::bigint AS tile_own_mentions,
          sum(citing_answers)::bigint AS citing_answers`,
      sql`own_variant = ${v0.key}`,
    );
    // 독립 산식 — 리더(summary-global-aggregates.ts)의 정의를 여기 다시 적는다.
    const d = await one(sql`
      WITH ob AS (
        SELECT job_id, sum(mentions)::bigint AS mc,
               COALESCE(sum(mentions) FILTER (WHERE is_competitor = 1), 0)::bigint AS mc_comp,
               sum(positive)::bigint AS pos,
               sum(negative)::bigint AS neg,
               (sum(positive) + sum(neutral) + sum(negative) + sum(mixed))::bigint AS sig
        FROM summary_brand_mentions WHERE ${S} AND brand_id = ANY(${own}) GROUP BY 1
      ),
      bp AS (
        SELECT job_id, brand_name, min(first_rank) AS tp,
               bool_or(brand_id = ANY(${own})) AS is_own
        FROM summary_brand_mentions
        WHERE ${S} AND is_competitor = 1 AND first_rank IS NOT NULL GROUP BY 1, 2
      ),
      rk AS (SELECT job_id, is_own, rank() OVER (PARTITION BY job_id ORDER BY tp) AS rk FROM bp),
      rj AS (SELECT job_id, min(rk)::int AS tp FROM rk WHERE is_own GROUP BY 1),
      a AS (SELECT job_id, monitored, all_citations FROM summary_answers WHERE ${S}),
      tl AS (
        SELECT COALESCE(sum(mn) FILTER (WHERE is_own), 0)::bigint AS tile FROM (
          SELECT ${dimsSelM}, m.brand_name, sum(m.mentions)::bigint AS mn,
                 bool_or(m.brand_id = ANY(${own})) AS is_own
          FROM summary_brand_mentions m ${raJoin}
          WHERE m.cycle_week = ${keys.cycleWeek}::date AND m.cycle_id = ${keys.cycleId}::uuid
            AND m.generation_id = ${keys.generationId}::uuid AND m.is_competitor = 1
          GROUP BY ${dimsGrpM}, m.brand_name
        ) z
      ),
      ind_scope(country, lang, bases, pat) AS (VALUES ${indScope})
      SELECT
        (SELECT sum(monitored)::bigint FROM a) AS monitored,
        (SELECT count(*)::bigint FROM a JOIN ob USING (job_id)) AS tracked_answers,
        (SELECT count(*)::bigint FROM a LEFT JOIN ob USING (job_id) WHERE COALESCE(ob.mc, 0) >= 2) AS multi_answers,
        (SELECT count(*)::bigint FROM a JOIN ob USING (job_id) LEFT JOIN rj USING (job_id)
          WHERE COALESCE(rj.tp, 100) <= 1) AS top1_answers,
        (SELECT count(*)::bigint FROM a JOIN ob USING (job_id) LEFT JOIN rj USING (job_id)
          WHERE COALESCE(rj.tp, 100) <= 3) AS top3_answers,
        (SELECT COALESCE(sum(rj.tp), 0)::bigint FROM a JOIN rj USING (job_id)) AS rank_sum,
        (SELECT count(*)::bigint FROM a JOIN rj USING (job_id)) AS ranked_answers,
        (SELECT COALESCE(sum(mc_comp), 0)::bigint FROM ob) AS own_mentions,
        (SELECT COALESCE(sum(pos), 0)::bigint FROM ob) AS own_positive,
        (SELECT COALESCE(sum(neg), 0)::bigint FROM ob) AS own_negative,
        (SELECT COALESCE(sum(sig), 0)::bigint FROM ob) AS own_signals,
        (SELECT COALESCE(sum(mentions) FILTER (WHERE is_competitor = 1), 0)::bigint
           FROM summary_brand_mentions WHERE ${S}) AS comp_mentions,
        (SELECT sum(all_citations)::bigint FROM a) AS all_citations,
        ${indOwnCit} AS own_citations,
        ${indOwnFb} AS own_fallback_citations,
        (SELECT COALESCE(sum(citations) FILTER (
            WHERE matched_base <> '' AND matched_base = ANY(${sql.param(wild.bases)}::text[])), 0)::bigint
           FROM summary_domain_citations WHERE ${S}) AS own_citations_unnarrowed,
        (SELECT tile FROM tl) AS tile_own_mentions,
        (SELECT count(*)::bigint FROM a WHERE all_citations > 0) AS citing_answers,
        (SELECT sum(citations)::bigint FROM summary_domain_citations WHERE ${S}) AS domain_citations_total
    `);
    console.log(`  행 ${n(f.rows)} (변형 ${v0.key} 만 · 전체 변형 ${variants.length}개)`);
    allOk =
      report([
        { name: "monitored", fold: n(f.monitored), independent: n(d.monitored) },
        { name: "tracked_answers", fold: n(f.tracked_answers), independent: n(d.tracked_answers) },
        { name: "multi_answers", fold: n(f.multi_answers), independent: n(d.multi_answers) },
        { name: "top1_answers", fold: n(f.top1_answers), independent: n(d.top1_answers) },
        { name: "top3_answers", fold: n(f.top3_answers), independent: n(d.top3_answers) },
        { name: "rank_sum(서수 합)", fold: n(f.rank_sum), independent: n(d.rank_sum) },
        { name: "ranked_answers", fold: n(f.ranked_answers), independent: n(d.ranked_answers) },
        { name: "own_mentions", fold: n(f.own_mentions), independent: n(d.own_mentions) },
        { name: "own_positive", fold: n(f.own_positive), independent: n(d.own_positive) },
        { name: "own_negative", fold: n(f.own_negative), independent: n(d.own_negative) },
        { name: "own_signals", fold: n(f.own_signals), independent: n(d.own_signals) },
        { name: "comp_mentions ⑤①", fold: n(f.comp_mentions), independent: n(d.comp_mentions) },
        { name: "all_citations", fold: n(f.all_citations), independent: n(d.all_citations) },
        { name: "own_citations", fold: n(f.own_citations), independent: n(d.own_citations) },
        {
          name: "own_fallback_citations",
          fold: n(f.own_fallback_citations),
          independent: n(d.own_fallback_citations),
        },
        { name: "tile_own_mentions", fold: n(f.tile_own_mentions), independent: n(d.tile_own_mentions) },
        { name: "citing_answers", fold: n(f.citing_answers), independent: n(d.citing_answers) },
      ]) && allOk;
    // ⑤ 스코프 레짐 대비(T11 격자 입력): 굳힌 값은 키의 (국가, 언어)로 좁힌 것이고,
    // 무필터 화면의 리더는 좁히지 않은 universe 를 쓴다 — 둘은 **구조적으로 다르다**.
    const narrowed = n(d.own_citations);
    const un = n(d.own_citations_unnarrowed);
    console.log(
      UNIT_PATH
        ? `  · ⑤ 분자 출처: unit_owned_citations 합 ${narrowed} (오늘 화면과 같은 컬럼) vs` +
          ` 선언 base 전량 $sel ${un} — Δ=${narrowed - un},` +
          ` 분모 ${n(d.all_citations)} 기준 ${((narrowed / n(d.all_citations)) * 100).toFixed(2)}% vs ${((un / n(d.all_citations)) * 100).toFixed(2)}%`
        : `  · ⑤ 분자 레짐: 키 좁힘(굳힘) ${narrowed} vs 무필터 universe ${un}` +
          ` — Δ=${narrowed - un} (${un ? (((narrowed - un) / un) * 100).toFixed(1) : "0"}%),` +
          ` 분모 ${n(d.all_citations)} 기준 ${((narrowed / n(d.all_citations)) * 100).toFixed(2)}% vs ${((un / n(d.all_citations)) * 100).toFixed(2)}%`,
    );
    // 층 간 체크섬(§7-2 4): 답변 표의 all_citations 합 = 도메인 표의 citations 합.
    const same = n(d.all_citations) === n(d.domain_citations_total);
    console.log(
      `  ${same ? "✓" : "✗"} 층 간: answers.all_citations(${n(d.all_citations)}) = domains.citations(${n(d.domain_citations_total)})`,
    );
    allOk = same && allOk;
  }

  // ── prompts_* — 그룹 간 SUM 은 이중 계상이라 **그룹 단위**로 대조한다 ──────
  console.log("\n[trend_own · prompts_* 그룹 단위 (0065 COMMENT: 그룹 간 SUM 불가)]");
  {
    const f = selects.find((s) => s.table === "summary_trend_own")!;
    const r = await one(sql`
      WITH fold AS (SELECT ${dims}, own_variant, prompts_measured, prompts_tracked FROM (${f.select}) AS t),
      -- FILTER 안에 서브쿼리를 두지 않는다 — 불리언을 한 겹 아래에서 만든다.
      ind_src AS (
        SELECT ${dimsSelA}, a.prompt_id,
               EXISTS (
                 SELECT 1 FROM summary_brand_mentions m
                 WHERE m.cycle_week = ${keys.cycleWeek}::date AND m.cycle_id = ${keys.cycleId}::uuid
                   AND m.generation_id = ${keys.generationId}::uuid
                   AND m.job_id = a.job_id AND m.brand_id = ANY(${own})
               ) AS trk
        FROM summary_answers a WHERE ${S}
      ),
      ind AS (
        SELECT ${dims},
               count(DISTINCT prompt_id)::int AS prompts_measured,
               count(DISTINCT prompt_id) FILTER (WHERE trk)::int AS prompts_tracked
        FROM ind_src GROUP BY ${dims}
      )
      SELECT count(*)::int AS groups,
             count(*) FILTER (WHERE fold.prompts_measured <> ind.prompts_measured)::int AS bad_measured,
             count(*) FILTER (WHERE fold.prompts_tracked <> ind.prompts_tracked)::int AS bad_tracked
      FROM fold JOIN ind USING (${dims})
      WHERE fold.own_variant = ${v0.key}`);
    const ok = n(r.bad_measured) === 0 && n(r.bad_tracked) === 0;
    console.log(
      `  ${ok ? "✓" : "✗"} 그룹 ${n(r.groups)}개 · prompts_measured 불일치 ${n(r.bad_measured)} · prompts_tracked 불일치 ${n(r.bad_tracked)}`,
    );
    allOk = ok && allOk;
  }

  // ── 변형별 행수·⑤ 분자 (PR② T3) ────────────────────────────────────────────
  console.log("\n[trend_own · 변형별]");
  {
    const f = selects.find((s) => s.table === "summary_trend_own")!;
    const t0 = Date.now();
    const rows = await rt.rows<Record<string, unknown>>(sql`
      SELECT own_variant, count(*)::int AS rows,
             sum(own_citations)::int AS own_citations,
             sum(own_fallback_citations)::int AS own_fallback,
             sum(all_citations)::int AS all_citations,
             sum(own_mentions)::int AS own_mentions, sum(tracked_answers)::int AS tracked_answers
      FROM (${f.select}) AS t GROUP BY 1 ORDER BY 1`);
    console.log(`  fold_own SELECT 1회 소요 ${Date.now() - t0} ms (§8 M5 — INSERT 제외)`);
    for (const r of rows) {
      const share = n(r.all_citations) ? ((n(r.own_citations) + n(r.own_fallback)) / n(r.all_citations)) * 100 : 0;
      console.log(
        `  ${String(r.own_variant).padEnd(10)} 행 ${String(n(r.rows)).padStart(7)} · ⑤분자 ${String(n(r.own_citations)).padStart(7)}` +
          ` (+폴백 ${n(r.own_fallback)}) / 분모 ${n(r.all_citations)} = ${share.toFixed(2)}%` +
          ` · ①분자 ${n(r.tracked_answers)} · ②분자 ${n(r.own_mentions)}`,
      );
    }
    console.log(`  · 스코프 행 수: ${variants.map((v) => `${v.key}=${v.citationScopes.length}`).join(" ")}`);
  }

  // ── PK 유일성 (접기가 PK 밖 컬럼으로 그룹을 나눈다 — brands.is_competitor·domains.domain) ──
  console.log("\n[PK 유일성 — INSERT 를 못 돌려 보는 동안의 대체 검사]");
  for (const f of selects) {
    const pk = pkColumns(f.table).filter((c) => c !== "cycle_id" && c !== "generation_id");
    const key = sql.raw(pk.join(", "));
    const r = await one(
      sql`SELECT count(*)::int AS rows, count(DISTINCT (${key}))::int AS uniq FROM (${f.select}) AS t`,
    );
    const ok = n(r.rows) === n(r.uniq);
    console.log(
      `  ${ok ? "✓" : "✗"} ${f.table.padEnd(24)} 행 ${n(r.rows)} · PK distinct ${n(r.uniq)}`,
    );
    allOk = ok && allOk;
  }

  // ── NOT NULL 위반 (INSERT 를 못 돌려 보는 동안의 대체 검사) ────────────────
  console.log("\n[NOT NULL — 접기 SELECT 출력에 NULL 이 있으면 INSERT 가 죽는다]");
  for (const f of selects) {
    const cols = notNullColumns(f.table);
    const pred = sql.raw(cols.map((c) => `${c} IS NULL`).join(" OR "));
    const r = await one(sql`SELECT count(*)::int AS bad FROM (${f.select}) AS t WHERE ${pred}`);
    const ok = n(r.bad) === 0;
    console.log(`  ${ok ? "✓" : "✗"} ${f.table.padEnd(24)} NOT NULL ${cols.length}개 · 위반 ${n(r.bad)}행`);
    allOk = ok && allOk;
  }

  // ── 멱등(①의 SELECT 결정성) ────────────────────────────────────────────────
  console.log("\n[멱등 — 같은 SELECT 2회 결과 동일]");
  {
    const probe = async () =>
      JSON.stringify(
        await foldAgg(
          "summary_trend_own",
          sql`count(*)::bigint AS rows, sum(monitored)::bigint AS m, sum(own_citations)::bigint AS oc,
              sum(tile_own_mentions)::bigint AS tile`,
        ),
      );
    const a1 = await probe();
    const a2 = await probe();
    console.log(`  ${a1 === a2 ? "✓" : "✗"} ${a1}`);
    allOk = a1 === a2 && allOk;
  }

  // ── PK 유일성 (2026-09-10 23505 장애 재발 방지) ─────────────────────────────
  // 접기 SELECT 가 같은 PK 로 두 행을 내면 INSERT 가 duplicate key 로 죽는다.
  // 실제로 죽었다: 브랜드 접기가 PK 밖 `is_competitor` 를 GROUP BY 에 두어, 같은
  // brand_id 가 한 키 그룹에서 0/1 을 모두 갖는 **과거 회차**(전수 실측 35그룹/4회차)에서
  // 두 그룹 → 같은 PK. 형태 테스트는 모양만 보므로, 여기서 **그 회차 실데이터로** 센다.
  // 쓰기 전에 세는 것이 핵심 — 적재해 보고 아는 것은 늦다.
  {
    console.log("\n[PK 유일성 — 접기 결과에 같은 키가 두 번 나오지 않는가]");
    for (const s of selects) {
      const keyCols = PK_BY_TABLE[s.table];
      if (!keyCols) continue;
      const cols = sql.raw(keyCols.join(", "));
      const rows = await rt.rows<{ dupe_keys: string; extra_rows: string }>(sql`
        SELECT count(*)::bigint AS dupe_keys, COALESCE(sum(n - 1), 0)::bigint AS extra_rows
        FROM (SELECT ${cols}, count(*)::bigint AS n FROM (${s.select}) AS t
              GROUP BY ${cols} HAVING count(*) > 1) z
      `);
      const dupes = Number(rows[0]?.dupe_keys ?? 0);
      const extra = Number(rows[0]?.extra_rows ?? 0);
      const ok = dupes === 0;
      console.log(`  ${ok ? "✓" : "✗"} ${s.table.padEnd(24)} 중복 키 ${dupes} · 잉여 행 ${extra}`);
      if (!ok) {
        console.log(`     → 이대로 INSERT 하면 23505(duplicate key)로 죽는다. 접기 GROUP BY 에`);
        console.log(`        PK 밖 컬럼이 들어갔는지 먼저 볼 것(fold.ts 의 브랜드·도메인 주석).`);
      }
      allOk = ok && allOk;
    }
  }

  // ── 소요 (수용 기준 ④ — M5) ────────────────────────────────────────────────
  if (EXPLAIN) {
    console.log("\n[EXPLAIN ANALYZE — SELECT 부분 실측(INSERT 비용 제외)]");
    let total = 0;
    for (const s of selects) {
      const rows = await rt.rows<Record<string, string>>(
        sql`EXPLAIN (ANALYZE, BUFFERS, TIMING) ${s.select}`,
      );
      const lines = rows.map((r) => Object.values(r)[0] as string);
      const ms = Number(/Execution Time: ([\d.]+) ms/.exec(lines.join("\n"))?.[1] ?? 0);
      total += ms;
      console.log(`  ${s.table.padEnd(24)} ${ms.toFixed(0).padStart(8)} ms   ${lines[0]?.slice(0, 90)}`);
    }
    console.log(`  합계 ${total.toFixed(0)} ms (수용 기준 ④: 회차당 ≤ 90,000 ms)`);
  }

  console.log(`\n판정: ${allOk ? "PASS" : "FAIL"}`);
  return allOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

