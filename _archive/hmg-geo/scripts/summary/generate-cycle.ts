/**
 * summary_* 사실표 — **회차 범용 생성 CLI**(PR① T9).
 *
 *   npm run summary:generate -- --surface=global  --pending            # dry-run(기본)
 *   npm run summary:generate -- --surface=website --cycle=<uuid>       # dry-run
 *   npm run summary:generate -- --surface=global  --pending --yes --revalidate
 *
 * | 옵션 | 뜻 |
 * | --- | --- |
 * | `--surface=global\|website` | 필수 |
 * | `--cycle=<uuid>` | 그 회차 하나만 |
 * | `--pending` | `status='closed' AND active_generation_id IS NULL AND analysis_gap_ratio <= 0.05` |
 * | `--dry-run` | **기본값.** 대상 회차·run 수·예상 셀 수만 출력하고 쓰기 0. `--yes` 와 **함께 주면 거부**(종료 2) |
 * | `--yes` | 실제 적재 + published 스왑 |
 * | `--reinterpret` | 직전 활성 generation 의 판정 입력 스냅샷을 **재사용하지 않고** 최신 명부로 |
 * | `--revalidate` | 스왑 뒤 내부 무효화 라우트 호출(env `HMG_INTERNAL_BASE_URL`·`CRON_SECRET`) |
 * | `--max-cycles=N` | `--pending` 한 번에 소화할 **회차 묶음** 수(기본 8 · 1~1000 정수, 그 밖은 종료 2) |
 * | `--refold` | **백필 모드.** 세부층은 그대로 두고 활성 generation 의 세부층에서 집계층 4표만 다시 만든다 |
 * | `--all-published` | `--refold` 전용. 표면의 노출 가능(V-2) + 활성 generation 회차 전부 |
 * | `--since=<YYYY-MM-DD>` | `--all-published` 전용. `cycle_anchor_at >= date` 로 자른다(13주 파티션 창 밖 제외) |
 *
 * 재접기(`--refold`)가 **안 건드리는 것**: 스왑 3문장(retire·activate·publish)·`view_anchor_at`·
 * `generator_version`·`summary_cycles.status`·세부층. 건드리는 것은 집계층 4표와
 * `summary_generations.timings`(`refold_*` 키 **병합** — 원래 생성 소요를 지우지 않는다)뿐이다.
 * 회차 단위 원자(표별 DELETE→INSERT 한 tx)·멱등이고, 실패한 회차는 건너뛰고 계속한다.
 *
 * `--max-cycles` 는 **행 수가 아니라 묶음 수**다(2026-09-10 변경). 묶음 = 글로벌
 * `cycle_anchor_at` · 웹사이트 `cycle_week`. 행으로 자르면 백로그가 2주 쌓였을 때 한 틱이
 * 앞 주 전부 + 뒤 주 일부를 집어, 화면이 **프로젝트마다 다른 회차를 보는 반쪽 회차**가 된다
 * (읽기 쪽 `pickWebsiteCycles` 가 `partial:25/126` 으로 떨어진다). 묶음으로 자르면
 * "한 틱 = 회차 N개(전부 또는 전무)" 가 보장된다.
 * ⚠️ 러너 유닛의 `MAX_CYCLES_GLOBAL`/`MAX_CYCLES_WEBSITE` 값도 이 의미로 읽어야 한다 —
 * 웹사이트 함대 95개는 **묶음 1개**이므로 120 은 "백로그 120주 전부"를 뜻한다(재조정 대상).
 *
 * 회차 상수가 없다 — 회차 좌표(anchor·week)와 **run 멤버십은 회차 원장에서 읽는다**
 * (`summary_cycles` / `summary_cycle_runs`, 설계 v4.1 §8-1 P6: 닫힌 회차의 모수는 안 바뀐다).
 * 그래서 다음 회차를 돌리려고 스크립트를 새로 만들 필요가 없다.
 *
 * 규율
 *  · `--yes` 가 없으면 **어떤 쓰기도 하지 않는다**(`generate-cycle.test.ts` 가 고정).
 *    `--dry-run` 은 그 위의 하드 오버라이드다 — 둘을 함께 주면 실행하지 않고 종료 2.
 *  · 시크릿은 env 로만 받는다 — argv 금지·로그 미출력(secrets-handling 룰 6).
 *  · 한 회차가 실패해도 그 generation 만 `failed` 로 접고 다음 회차로 간다.
 *    (`summary_cycles.status` 에는 'failed' 가 없다 — 실패는 generation 단위 상태다.)
 */
process.env.DB_POOL_MAX ??= "2";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { columnAvailable } from "@/lib/db/column-availability";
import { createRuntime, generatorVersion, type GeneratorRuntime } from "@/lib/summary/generate/context";
import {
  activeGenerationSnapshotSql,
  cycleByIdSql,
  cycleRunIdsSql,
  mergeGenerationTimingsSql,
  pendingCyclesSql,
  updateGenerationTimingsSql,
  type CycleRow,
} from "@/lib/summary/generate/cycle";
import {
  AGG_TIMING_KEYS,
  TIMING_KEYS,
  type GenerationKeys,
  type SummarySurface,
} from "@/lib/summary/generate/types";
import {
  analyzeFoldSources,
  applyFoldTx,
  FOLD_STATEMENT_TIMEOUT,
  FOLD_WORK_MEM,
  foldBatches,
} from "@/lib/summary/generate/fold";
import { cycleViewableSql } from "@/lib/db/repositories/summary-cycles";
import { ANALYSIS_GAP_MAX } from "@/lib/summary/read/analysis-gap";
import * as G from "./surface-global";
import * as W from "./surface-website";

// 정본은 `lib/summary/read/analysis-gap.ts` — 읽기 쪽(`cycle-set.ts::isGeneratorSkipped`)이
// **같은 상수**를 봐야 "생성기가 안 뽑는 것" 과 "기간 조회가 창에서 빼는 것" 이 어긋나지 않는다.


const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const SURFACE = value("surface") as SummarySurface | undefined;
const CYCLE_ID = value("cycle");
const PENDING = flag("pending");
const DRY_RUN = flag("dry-run");
/**
 * 쓰기 스위치. `--dry-run` 이 **이긴다** — 모순 인자는 main() 이 종료 2 로 거부하지만,
 * 그 가드를 우회하는 경로가 생겨도 여기서 한 번 더 막힌다(2026-09-10: 종전 구현은
 * `--dry-run --yes` 에서 `--yes` 가 이겨 쓰기 15문장을 발행했다).
 */
const APPLY = flag("yes") && !DRY_RUN;
const REINTERPRET = flag("reinterpret");
/** 백필 모드 — 세부층은 그대로 두고 **접기만** 다시 한다(PR② T2 라운드4). */
const REFOLD = flag("refold");
const ALL_PUBLISHED = flag("all-published");
const SINCE = value("since");
const REVALIDATE = flag("revalidate");
const MAX_CYCLES_RAW = value("max-cycles");
const MAX_CYCLES_DEFAULT = 8;
const MAX_CYCLES_CAP = 1000;

/** 인자 오류 — 종료코드 2. `process.exit` 를 여기서 부르지 않는 이유는 그것이 **흐름을
 *  멈추지 않기 때문**이다(스텁된 환경에서는 그대로 아래로 흘러 DB 를 건드린다). */
class UsageError extends Error {}
function usage(msg: string): never {
  throw new UsageError(msg);
}

/**
 * `--max-cycles` 검증 — 미지정이면 기본값, 그 밖에는 **1~1000 의 십진 정수만** 받는다.
 * 종전 구현은 `Number(...)` 후 `> 0` 검사라 `abc`·`0`·`-1` 이 전부 **조용히 8 로 폴백**했다.
 * 러너 유닛의 오타가 소리 없이 다른 규모로 도는 것이 최악이라, 여기서 죽인다.
 */
function parseMaxCycles(): number {
  if (MAX_CYCLES_RAW === undefined) return MAX_CYCLES_DEFAULT;
  if (!/^[1-9]\d*$/.test(MAX_CYCLES_RAW)) {
    usage(`--max-cycles 는 1 이상의 정수여야 한다 (받은 값: '${MAX_CYCLES_RAW}')`);
  }
  const n = Number(MAX_CYCLES_RAW);
  if (n > MAX_CYCLES_CAP) usage(`--max-cycles 상한은 ${MAX_CYCLES_CAP} 이다 (받은 값: ${n})`);
  return n;
}

/** 대상 회차 — `--cycle` 하나이거나 `--pending` 목록(묶음 `limit` 개). */
async function targetCycles(
  rt: GeneratorRuntime,
  surface: SummarySurface,
  limit: number,
): Promise<CycleRow[]> {
  if (CYCLE_ID) {
    const rows = await rt.rows<CycleRow>(cycleByIdSql(CYCLE_ID));
    if (!rows[0]) throw new Error(`회차를 찾지 못했다: ${CYCLE_ID}`);
    if (rows[0].surface !== surface) {
      throw new Error(`회차 ${CYCLE_ID} 의 표면은 '${rows[0].surface}' 다 (--surface=${surface})`);
    }
    return rows;
  }
  return rt.rows<CycleRow>(pendingCyclesSql({ surface, gapMax: ANALYSIS_GAP_MAX, limit }));
}

/**
 * 재접기 대상 — 표면의 **노출 가능**(V-2) + 활성 generation 이 있는 회차 전부.
 *
 * 술어는 `cycleViewableSql()` 한 벌을 그대로 쓴다 — 읽기 게이트와 갈리면 "재접기는 했는데
 * 화면은 못 보는" 회차나 그 반대가 생긴다. `--since` 는 13주 파티션 창 밖(세부층이 이미
 * DROP 된 회차)을 잘라내는 손잡이다: 세부층이 없으면 접기가 0행을 넣어 **집계층을 비운다**.
 */
function refoldCyclesSql(args: { surface: SummarySurface; since?: string }): SQL {
  const since = args.since
    ? sql` AND cycle_anchor_at >= ${args.since}::date`
    : sql``;
  return sql`
    SELECT cycle_id::text AS cycle_id, surface, project_id::text AS project_id,
           cycle_anchor_at::text AS cycle_anchor_at, cycle_week::text AS cycle_week, status,
           active_generation_id::text AS active_generation_id,
           analysis_gap_ratio::text AS analysis_gap_ratio, view_anchor_at::text AS view_anchor_at
    FROM summary_cycles
    WHERE surface = ${args.surface}
      AND status = 'published'
      AND active_generation_id IS NOT NULL
      AND ${cycleViewableSql()}${since}
    ORDER BY cycle_anchor_at, project_id
  `;
}

/** 재접기 미리보기 — 접기 **입력**(세부층 행수)을 센다. 출력(집계층 행수)은 그보다 작다. */
async function refoldPreview(rt: GeneratorRuntime, keys: GenerationKeys) {
  const w = sql`cycle_week = ${keys.cycleWeek}::date AND cycle_id = ${keys.cycleId}::uuid AND generation_id = ${keys.generationId}::uuid`;
  const r = await rt.rows<{ answers: number; brands: number; domains: number }>(sql`
    SELECT (SELECT count(*) FROM summary_answers          WHERE ${w})::int AS answers,
           (SELECT count(*) FROM summary_brand_mentions   WHERE ${w})::int AS brands,
           (SELECT count(*) FROM summary_domain_citations WHERE ${w})::int AS domains
  `);
  return r[0] ?? { answers: 0, brands: 0, domains: 0 };
}

/** 읽기 전용 미리보기 — 이 회차가 만들 셀 수를 센다(쓰기 0). */
async function preview(rt: GeneratorRuntime, cycleId: string) {
  const r = await rt.rows<{ runs: number; expected_cells: number; completed_cells: number }>(sql`
    WITH r AS (SELECT run_id FROM summary_cycle_runs WHERE cycle_id = ${cycleId}::uuid)
    SELECT (SELECT count(*) FROM r)::int AS runs,
           (SELECT count(DISTINCT (a.prompt_id, a.target, a.region)) FROM scope_answers a
             WHERE a.run_id IN (SELECT run_id FROM r))::int AS expected_cells,
           (SELECT count(DISTINCT (a.prompt_id, a.target, a.region)) FROM scope_answers a
             WHERE a.run_id IN (SELECT run_id FROM r) AND a.status = 'completed')::int AS completed_cells
  `);
  return r[0] ?? { runs: 0, expected_cells: 0, completed_cells: 0 };
}

type Snapshot = {
  roster_snapshot?: { own_entities?: Array<{ id: string; name: string }> } | null;
  base_universe?: { matching_universe?: string[] } | null;
};

/**
 * 판정 입력 결정(§7-8) — 기본은 **그 회차의 직전 활성 generation 스냅샷 재사용**,
 * `--reinterpret` 이면 최신 명부.
 *
 * ⚠️ 재사용 범위는 **명부(own_entities)와 base universe** 뿐이다. 비경쟁 사전·브랜드 접두
 * 목록은 코드 상수(`lib/summary/tenant/hmg.ts`)라 스냅샷으로 되돌릴 수 없다 —
 * `noise_snapshot` 에 기록만 되고 판정은 언제나 그 시점 코드다. 이 한계를 감추지 않는다.
 */
async function judgmentInputs<T extends { roster: Array<{ id: string; name: string }>; basePrefixes: string[]; filters: { ownEntities?: Array<{ id: string; name: string }> } }>(
  rt: GeneratorRuntime,
  cycleId: string,
  fresh: T,
): Promise<T> {
  if (REINTERPRET) return fresh;
  const snap = await rt.rows<Snapshot>(activeGenerationSnapshotSql(cycleId));
  const roster = snap[0]?.roster_snapshot?.own_entities;
  const bases = snap[0]?.base_universe?.matching_universe;
  if (!roster?.length && !bases?.length) return fresh;
  rt.log(
    `판정 입력 = 직전 generation 스냅샷 재사용(명부 ${roster?.length ?? fresh.roster.length}개 · ` +
      `base ${bases?.length ?? fresh.basePrefixes.length}개). 최신 명부로 다시 해석하려면 --reinterpret`,
  );
  return {
    ...fresh,
    roster: roster?.length ? roster : fresh.roster,
    basePrefixes: bases?.length ? bases : fresh.basePrefixes,
    filters: { ...fresh.filters, ownEntities: roster?.length ? roster : fresh.filters.ownEntities },
  };
}

/** 스왑 뒤 Next 캐시 무효화 — 값은 env 로만 받고 URL·토큰을 로그에 남기지 않는다. */
async function revalidate(rt: GeneratorRuntime): Promise<void> {
  const base = process.env.HMG_INTERNAL_BASE_URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    throw new Error("--revalidate 에는 HMG_INTERNAL_BASE_URL 과 CRON_SECRET 이 필요하다(env)");
  }
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/internal/summary/published`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw new Error(`revalidate 실패: HTTP ${res.status}`);
  rt.log("revalidate 200");
}

async function main() {
  if (!SURFACE || (SURFACE !== "global" && SURFACE !== "website")) {
    usage("--surface=global|website 이 필요하다");
  }
  if (REFOLD) {
    if (PENDING) usage("--refold 는 --pending 과 함께 쓸 수 없다 (재접기는 이미 활성인 generation 만 다룬다)");
    if (!CYCLE_ID && !ALL_PUBLISHED) usage("--refold 에는 --cycle=<uuid> 또는 --all-published 가 필요하다");
    if (CYCLE_ID && ALL_PUBLISHED) usage("--cycle 과 --all-published 는 함께 쓸 수 없다");
  } else {
    if (ALL_PUBLISHED) usage("--all-published 는 --refold 전용이다");
    if (!CYCLE_ID && !PENDING) usage("--cycle=<uuid> 또는 --pending 중 하나가 필요하다");
    if (CYCLE_ID && PENDING) usage("--cycle 과 --pending 은 함께 쓸 수 없다");
  }
  if (SINCE !== undefined) {
    if (!ALL_PUBLISHED) usage("--since 는 --all-published 와 함께만 쓴다");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) usage(`--since 는 YYYY-MM-DD 여야 한다 (받은 값: '${SINCE}')`);
  }
  // 모순 인자는 "안전한 쪽으로 해석" 하지 않고 거부한다 — 어느 쪽 의도였는지 모른 채
  // 쓰기를 하거나(종전 결함) 조용히 건너뛰는 것 둘 다 나쁘다.
  if (DRY_RUN && flag("yes")) usage("--dry-run 과 --yes 는 함께 쓸 수 없다");
  const maxCycles = parseMaxCycles();

  // 판정식이 컬럼 유무로 갈린다 — 프로브가 끝난 뒤에 SQL 을 만든다.
  const probes = [columnAvailable("scope_citations", "url_norm")];
  if (SURFACE === "global") {
    probes.push(
      columnAvailable("scope_prompts", "is_korean"),
      columnAvailable("scope_prompts", "regions"),
    );
  }
  await Promise.all(probes);

  const db = getDb();
  // 세션 GUC — 이 커넥션에만 걸린다(풀 max≥2). 그래서 쓰기 문장은 execViaHeavy 로
  // 자기 tx 안에서 `SET LOCAL` 을 다시 건다: 어느 커넥션이 잡혀도 상한이 보장된다.
  await db.execute(sql`SET statement_timeout = '10min'`);
  await db.execute(sql`SET lock_timeout = '5s'`);

  const rt = createRuntime({
    db,
    version: generatorVersion(`${SURFACE}-cycle-v1`),
    heavyTimeout: "10min",
    heavyLockTimeout: "5s",
    execViaHeavy: APPLY,
  });

  if (REFOLD) return runRefold(rt, SURFACE);

  const cycles = await targetCycles(rt, SURFACE, maxCycles);
  rt.log(
    `표면 ${SURFACE} · 대상 회차 ${cycles.length}개` +
      (PENDING ? ` (묶음 상한 ${maxCycles})` : "") +
      ` · ${APPLY ? "APPLY" : "DRY-RUN(쓰기 없음)"} · ${rt.version}`,
  );
  if (cycles.length === 0) {
    rt.log("대상 없음 — 종료.");
    return 0;
  }

  let ok = 0;
  let failed = 0;
  for (const c of cycles) {
    const p = await preview(rt, c.cycle_id);
    rt.log(
      `회차 ${c.cycle_id} project=${c.project_id} anchor=${c.cycle_anchor_at} week=${c.cycle_week} ` +
        `status=${c.status} gap=${c.analysis_gap_ratio ?? "-"} · run ${p.runs}개 · ` +
        `셀 ${p.completed_cells}/${p.expected_cells}(완료/관측)`,
    );
    if (!APPLY) continue;
    if (p.runs === 0) {
      rt.log("  ↳ 회차 원장에 run 이 없다 — 건너뛴다(관제 A1 이 귀속을 끝내야 한다).");
      failed += 1;
      continue;
    }

    const runIds = (await rt.rows<{ run_id: string }>(cycleRunIdsSql(c.cycle_id))).map(
      (r) => r.run_id,
    );
    try {
      const generationId =
        SURFACE === "global"
          ? await runGlobal(rt, c, runIds)
          : await runWebsite(rt, c, runIds);
      await recordTimings(rt, generationId);
      ok += 1;
      rt.log(`  ↳ 완료 generation=${generationId} timings=${JSON.stringify(rt.timings)}`);
    } catch (e) {
      failed += 1;
      console.error(`  ↳ 실패 cycle=${c.cycle_id}:`, e);
    }
    for (const k of Object.keys(rt.timings)) delete rt.timings[k];
  }

  rt.log(`결과: 성공 ${ok} · 실패 ${failed} / ${cycles.length}`);
  if (APPLY && REVALIDATE && ok > 0) await revalidate(rt);
  return failed > 0 ? 1 : 0;
}

/**
 * **재접기(백필)** — 세부층은 손대지 않고 활성 generation 의 세부층에서 집계층 4표만 다시 만든다.
 *
 * 왜 필요한가(T5 실측): 집계층에 접힌 웹사이트 회차가 95개 중 1개뿐이라 S4 가 배포돼도
 * `fallback:agg-fold-missing` 으로 미러를 서빙한다. 세부층 재생성(회차당 수 s~135 s)은
 * 회차 의미론상 위험하고 느리다 — 접기만 다시 하면 된다.
 *
 * 안 건드리는 것: 스왑 3문장(retire·activate·publish)·`view_anchor_at`·`generator_version`·
 * `summary_cycles.status`·세부층. 건드리는 것: 집계층 4표와 `summary_generations.timings`
 * (`refold_*` 키를 **병합**한다 — 원래 생성 소요를 지우지 않는다).
 */
async function runRefold(rt: GeneratorRuntime, surface: SummarySurface): Promise<number> {
  const targets = CYCLE_ID
    ? await rt.rows<CycleRow>(cycleByIdSql(CYCLE_ID))
    : await rt.rows<CycleRow>(refoldCyclesSql({ surface, since: SINCE }));
  if (CYCLE_ID && !targets[0]) throw new Error(`회차를 찾지 못했다: ${CYCLE_ID}`);
  const cycles = targets.filter((c) => c.surface === surface);
  if (CYCLE_ID && cycles.length === 0) {
    throw new Error(`회차 ${CYCLE_ID} 의 표면은 '${targets[0]?.surface}' 다 (--surface=${surface})`);
  }
  rt.log(
    `표면 ${surface} · **재접기** 대상 ${cycles.length}개` +
      (SINCE ? ` (since ${SINCE})` : "") +
      ` · ${APPLY ? "APPLY" : "DRY-RUN(쓰기 없음)"}`,
  );
  if (cycles.length === 0) {
    rt.log("대상 없음 — 종료.");
    return 0;
  }

  // 표면 컨텍스트는 회차마다 다시 읽지 않는다(웹사이트는 유닛 적재가 붙어 있다).
  // 판정 입력(명부·base)만 회차별 스냅샷으로 갈아 끼운다.
  const baseCtx = surface === "global" ? await G.loadCtx(rt) : await W.loadCtx(rt);
  const analyzed = new Set<string>();
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  const totals = { answers: 0, brands: 0, domains: 0 };

  for (const c of cycles) {
    const genId = c.active_generation_id;
    if (!genId) {
      rt.log(`  ↳ 건너뜀 cycle=${c.cycle_id} — 활성 generation 이 없다(재접기 대상 아님).`);
      skipped += 1;
      continue;
    }
    const keys: GenerationKeys = {
      cycleWeek: c.cycle_week.slice(0, 10),
      cycleId: c.cycle_id,
      generationId: genId,
    };
    const pv = await refoldPreview(rt, keys);
    totals.answers += pv.answers;
    totals.brands += pv.brands;
    totals.domains += pv.domains;
    rt.log(
      `회차 ${c.cycle_id} project=${c.project_id} anchor=${c.cycle_anchor_at} gen=${genId} · ` +
        `세부층 답변 ${pv.answers} · 브랜드 ${pv.brands} · 도메인 ${pv.domains}`,
    );
    if (pv.answers === 0) {
      // 세부층이 없다(13주 파티션 밖). 그대로 접으면 집계층을 0행으로 **비운다** — 안 한다.
      rt.log("  ↳ 건너뜀 — 세부층 행이 0이다(파티션 창 밖). 접으면 집계층이 비워진다.");
      skipped += 1;
      continue;
    }
    if (!APPLY) continue;

    try {
      const ctx = await judgmentInputs(rt, c.cycle_id, baseCtx);
      const batches = foldBatches({
        keys,
        surface,
        cycleAnchorAt: c.cycle_anchor_at,
        variants: surface === "global" ? G.ownVariants(ctx as G.Ctx) : W.ownVariants(ctx as W.Ctx),
        ownCitationsFrom: surface === "global" ? G.OWN_CITATIONS_FROM : W.OWN_CITATIONS_FROM,
      });
      // 주 파티션 통계는 주당 한 번이면 된다 — 회차 95개가 같은 주를 공유한다.
      if (!analyzed.has(keys.cycleWeek)) {
        await analyzeFoldSources(rt, keys);
        analyzed.add(keys.cycleWeek);
      }
      await applyFoldTx(rt, batches, {
        statementTimeout: FOLD_STATEMENT_TIMEOUT,
        workMem: FOLD_WORK_MEM,
      });
      await recordRefoldTimings(rt, genId);
      ok += 1;
      rt.log(`  ↳ 재접기 완료 gen=${genId} timings=${JSON.stringify(rt.timings)}`);
    } catch (e) {
      failed += 1;
      console.error(`  ↳ 재접기 실패 cycle=${c.cycle_id}:`, e);
    }
    for (const k of Object.keys(rt.timings)) delete rt.timings[k];
  }

  rt.log(
    `결과: 성공 ${ok} · 실패 ${failed} · 건너뜀 ${skipped} / ${cycles.length} · ` +
      `세부층 입력 합계 답변 ${totals.answers} · 브랜드 ${totals.brands} · 도메인 ${totals.domains}`,
  );
  if (APPLY && REVALIDATE && ok > 0) await revalidate(rt);
  return failed > 0 ? 1 : 0;
}

/** 재접기 소요를 `refold_*` 키로 **병합**한다(기존 timings 보존). */
async function recordRefoldTimings(rt: GeneratorRuntime, generationId: string): Promise<void> {
  if (!(await columnAvailable("summary_generations", "timings"))) return;
  const patch: Record<string, number> = {};
  let total = 0;
  for (const k of AGG_TIMING_KEYS) {
    const v = rt.timings[k] ?? 0;
    patch[k.replace(/^fold_/, "refold_")] = v;
    total += v;
  }
  patch.refold_total_ms = total;
  patch.refold_at = Math.floor(Date.now() / 1000);
  await rt.exec(mergeGenerationTimingsSql(generationId, patch));
}

async function runGlobal(rt: GeneratorRuntime, c: CycleRow, runIds: string[]): Promise<string> {
  const spec: G.GlobalCycleSpec = {
    cycleAnchorAt: c.cycle_anchor_at,
    cycleAnchorDate: c.cycle_anchor_at.slice(0, 10),
    cycleWeek: c.cycle_week,
  };
  const mem = G.runsMemCte(runIds);
  const ctx = await judgmentInputs(rt, c.cycle_id, await G.loadCtx(rt));
  const obs = await G.observe(rt, mem);
  const res = await G.generate(rt, ctx, spec, runIds, obs, { cycleId: c.cycle_id, mem });
  return res.generationId;
}

async function runWebsite(rt: GeneratorRuntime, c: CycleRow, runIds: string[]): Promise<string> {
  const spec: W.WebsiteCycleSpec = { cycleAnchorAt: c.cycle_anchor_at, cycleWeek: c.cycle_week };
  const ctx = await judgmentInputs(rt, c.cycle_id, await W.loadCtx(rt));
  const res = await W.generateProject(
    rt,
    ctx,
    spec,
    { project_id: c.project_id, runs: runIds },
    { cycleId: c.cycle_id },
  );
  if (!res.ok) throw new Error(`generation ${res.generationId} 미스왑: ${res.reason}`);
  return res.generationId;
}

/**
 * 표별 소요를 `summary_generations.timings` 에 기록한다(0064).
 * 0064 미적용이면 **조용히 건너뛴다** — 코드가 마이그레이션보다 먼저 배포될 수 있다.
 * 키는 `TIMING_KEYS` 6종 + `AGG_TIMING_KEYS` 4종 전부(안 만드는 표는 0) + `total_ms`.
 */
async function recordTimings(rt: GeneratorRuntime, generationId: string): Promise<void> {
  if (!(await columnAvailable("summary_generations", "timings"))) {
    rt.log("  ↳ summary_generations.timings 없음(0064 미적용) — 소요 기록 생략");
    return;
  }
  const payload: Record<string, number> = {};
  let total = 0;
  // 세부층 6키 + 집계층 접기 4키(PR② T2). 접기를 건너뛴 회차(0065 미적용)는 0 으로 남아
  // "키가 없다"와 "안 돌았다"가 구분된다.
  for (const k of [...TIMING_KEYS, ...AGG_TIMING_KEYS]) {
    const v = rt.timings[k] ?? 0;
    payload[k] = v;
    total += v;
  }
  payload.total_ms = total;
  await rt.exec(updateGenerationTimingsSql(generationId, payload));
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    if (e instanceof UsageError) {
      console.error(
        `${e.message}\n` +
          "사용: npm run summary:generate -- --surface=global|website (--cycle=<uuid> | --pending) " +
          "[--yes | --dry-run] [--reinterpret] [--revalidate] [--max-cycles=N(1~1000, 묶음 수)]",
      );
      process.exit(2);
    }
    console.error(e);
    process.exit(1);
  },
);
