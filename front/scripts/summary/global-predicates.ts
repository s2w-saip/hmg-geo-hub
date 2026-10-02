/**
 * 글로벌(표준·루트) 표면의 **제외 술어 한 벌** — `scope-aggregates.ts` 의 표준 경로와
 * 같은 규칙을 사실표 생성기에서 쓰기 위한 모듈.
 *
 * 왜 옮겨 적는가: `rootFullCycleAnswerIds`(SA:642-782)와 그 안의 두 제외 술어는
 * scope-aggregates 의 **비공개 함수**라 import 할 수 없고, 생성기는 그 파일을 고치지
 * 않는다(소유 경계). 그래서 여기 한 벌만 두고, `global-predicates.test.ts` 가 SA 의
 * 컴파일 SQL 과 이 술어의 텍스트를 대조한다 — SA 가 바뀌면 그 테스트가 먼저 깨진다.
 *
 * 별도 모듈인 이유는 `excluded.ts` 와 같다: 생성기(global-0831.ts)는 import 즉시
 * main() 을 도는 실행 스크립트라, 테스트가 그 파일에서 술어를 가져올 수 없다.
 *
 * ⚠️ 전부 **함수**다. 술어가 `columnKnownAvailable` 판정에 의존하는데 그 판정은 import
 * 시점엔 false 이므로(첫 호출이 백그라운드 프로브를 띄우고 false 를 돌려주는 계약),
 * 모듈 상수로 굳히면 제외가 조용히 빠진다 — 2026-09-06 실측: 지역태그 제외가 통째로
 * 빠져 in_full_cycle 통과 프롬프트가 11,410 → 11,320 으로 90개 탈락했다.
 */
import { sql, type SQL } from "drizzle-orm";
import { columnKnownAvailable } from "@/lib/db/column-availability";
import { brandPresenceResolvedSqlFor } from "@/lib/db/repositories/scope-aggregates";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";
import { REGION_TAGGING_CUTOFF_ISO } from "@/lib/scope/region-tagging";

/**
 * `presence_set`(0063) 적재식 — 그 프롬프트의 **모든 카탈로그 행**에서 유도한 distinct 집합.
 *
 * 미러의 brandPresence 판정은 두 겹이다(scope-aggregates.ts:655-672):
 *   ① 값이 유도값 — `COALESCE(brand_presence, brand='HMG'?unbranded:branded)`
 *   ② 카탈로그 중복 행에 대해 any-match(프롬프트 세미조인)
 * 원값 1행(`(array_agg(p.brand_presence ORDER BY updated_at DESC))[1]`)만 굳히면 둘 다 깨진다 —
 * 2026-09-06 실측으로 `branded` 격자가 답변 12,776(사실표) vs 20,712(미러)까지 벌어졌다.
 *
 * ①은 **SA 의 함수를 그대로 import** 해서 쓴다(옮겨 적지 않는다, §7-5). 컬럼 참조를 인자로
 * 받는 이유는 생성기의 CAT CTE 가 `prompts p` 로 별칭을 쓰기 때문이다.
 * ②는 `array_agg(DISTINCT …)` 로 집합을 만들어 조회의 `&&` 로 넘긴다. NULL 유도값은 버린다
 * (오늘의 세미조인도 NULL 행으로는 매칭되지 않는다) — 그래서 `FILTER` 가 필요하다.
 *
 * 글로벌·웹사이트 두 생성기가 함께 쓴다. 웹사이트 프롬프트는 루트 카탈로그(`prompts`)에
 * 매칭되는 행이 **0건**이라(2026-09-06 실측: website_prompts 12,685 중 matched 0) 결과는
 * 항상 `'{}'` 지만, 규칙을 표면별로 갈라 두면 나중에 매칭이 생기는 순간 조용히 갈린다.
 */
export function presenceSetExpr(brandCol: SQL, presenceCol: SQL): SQL {
  const resolved = brandPresenceResolvedSqlFor(brandCol, presenceCol);
  return sql`COALESCE(array_agg(DISTINCT ${resolved}) FILTER (WHERE ${resolved} IS NOT NULL), '{}')::text[]`;
}

/** 숨김 국가 제외 — `AND <region> NOT IN (…)` 조각(없으면 빈 조각). SA:683-685 */
export function hiddenRegionsClause(regionCol: SQL): SQL {
  if (!HIDDEN_STANDARD_REGIONS.length) return sql``;
  return sql`AND ${regionCol} NOT IN (${sql.join(
    HIDDEN_STANDARD_REGIONS.map((r) => sql`${r}`),
    sql`, `,
  )})`;
}

/**
 * 한국어 프롬프트의 비-KR 셀 제외 (2026-08-20 사고 대응 술어, 2026-09-28 태그 우선). SA:koreanNonKrExclusion
 *
 * 제외 조건 = 한국어 ∧ 비-KR ∧ (태그 없음 ∨ 태깅 이전 측정 ∨ measured_at NULL).
 * 태그 있고 태깅(`REGION_TAGGING_CUTOFF_ISO`) 이후면 `regionTagPred` 가 판정한다.
 * regions 컬럼이 미확인이면 태그를 알 수 없으므로 종전 술어(무조건 제외)와 같다.
 * `measuredCol` 은 필수다 — 빠지면 태깅 이전 US 이력이 되살아나 과거 회차에서
 * 기아 KO 프롬프트가 full-cycle 탈락한다(lib/scope/region-tagging.ts 주석).
 */
export function koreanNonKrPred(promptCol: SQL, regionCol: SQL, measuredCol: SQL): SQL {
  const flag = columnKnownAvailable("scope_prompts", "is_korean")
    ? sql`sp.is_korean`
    : sql`sp.text ~ '[가-힣]'`;
  const untaggedOrPreTagging = columnKnownAvailable("scope_prompts", "regions")
    ? sql`
    AND (
      ${measuredCol} IS NULL
      OR ${measuredCol} < ${sql.raw(`'${REGION_TAGGING_CUTOFF_ISO}'::timestamptz`)}
      OR ${promptCol} NOT IN (
        SELECT sp.prompt_id FROM scope_prompts sp
        WHERE sp.prompt_id IS NOT NULL
          AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
      )
    )`
    : sql``;
  return sql`NOT (
    ${regionCol} <> 'KR'
    AND ${promptCol} IS NOT NULL
    AND ${promptCol} IN (SELECT sp.prompt_id FROM scope_prompts sp WHERE ${flag})${untaggedOrPreTagging}
  )`;
}

/** 태깅된 시장 밖 셀 제외 (H3). 태그 없음(NULL/빈 배열) = 전체(상속) → 제외 안 함. SA:742-760 */
export function regionTagPred(promptCol: SQL, regionCol: SQL): SQL {
  if (!columnKnownAvailable("scope_prompts", "regions")) return sql`true`;
  return sql`(
    ${promptCol} IS NULL
    OR ${promptCol} NOT IN (
      SELECT sp.prompt_id FROM scope_prompts sp
      WHERE sp.prompt_id IS NOT NULL AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
    OR (${promptCol}, ${regionCol}) IN (
      SELECT sp.prompt_id, r FROM scope_prompts sp, unnest(sp.regions) AS r
      WHERE sp.prompt_id IS NOT NULL AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
  )`;
}

/** §3-2 `in_tagged_region` = 위 두 술어의 AND. 숨김 국가는 굳히지 않는다(조회 시, §4). */
export function inTaggedRegionExpr(promptCol: SQL, regionCol: SQL, measuredCol: SQL): SQL {
  return sql`(CASE WHEN ${koreanNonKrPred(promptCol, regionCol, measuredCol)}
                    AND ${regionTagPred(promptCol, regionCol)} THEN 1 ELSE 0 END)`;
}

/**
 * §3-7 full-cycle 프롬프트 게이트 — SA 의 `_fc_*` 게이트를 **회차 창**으로 재표현한다.
 * 오늘의 창 술어 `r.started_at >= now() - 7d` 자리에 회차 run 멤버십(`a.run_id ∈ mem`)을
 * 넣는 것 말고는 술어·집계가 같다.
 *
 *   fc_cells       = (prompt, target, region) 셀 — 이력 무제한 completed 1회 스캔
 *                    (w = 창 안 행 있음, first_at = 최초 측정, w_last = 창 안 마지막 측정)
 *   fc_active      = 창 안에서 실제로 completed 가 있는 (target, region)   (#188)
 *   expected_cells = fc_active 에 들고, 창 끝(= max w_last) 이후에 처음 생긴 셀이 아닌 셀 수
 *   window_cells   = 창 안 셀 수
 *   게이트          = window_cells >= expected_cells
 *
 * 창 끝 이후 첫 셀 제외(2026-09-28): 프롬프트에 시장이 나중에 추가되면(9/28 scope 743개
 * 태깅) 그 새 셀이 과거 회차의 기대치에 들어가 그 프롬프트가 과거 회차에서 탈락했다.
 * 창 안 셀(w)은 항상 남고 NULL 은 종전대로 둔다 — SA `_fc_gate` 주석과 같은 규칙이다.
 *
 * 종전에는 fc_active 와 fc 가 scope_answers 를 각각 스캔했다(2회). 셀 집계 하나에서 둘 다
 * 파생하므로 이제 1회다 — 산출 컬럼(`fc_active(target, region)`,
 * `fc(prompt_id, expected_cells, window_cells)`)은 그대로라 호출부는 바뀌지 않는다.
 *
 * `mem` CTE(회차 run 집합, `run_id` 컬럼)가 같은 WITH 절에 먼저 있어야 한다.
 * 셀이 아예 없는 프롬프트(제외 술어로 행이 전부 사라진 프롬프트)는 fc 에 행이 없으므로
 * `in_full_cycle = 0` 이다(오늘 SA 도 JOIN 에서 탈락).
 */
export function fullCycleCte(rootProjectId: string): SQL {
  const hidden = hiddenRegionsClause(sql`a.region`);
  const kor = koreanNonKrPred(sql`a.prompt_id`, sql`a.region`, sql`a.measured_at`);
  const rtag = regionTagPred(sql`a.prompt_id`, sql`a.region`);
  return sql`
  fc_cells AS (
    SELECT a.prompt_id, a.target, a.region,
      bool_or(a.run_id IN (SELECT run_id FROM mem)) AS w,
      min(a.measured_at) AS first_at,
      max(a.measured_at) FILTER (WHERE a.run_id IN (SELECT run_id FROM mem)) AS w_last
    FROM scope_answers a
    JOIN scope_runs r ON r.run_id = a.run_id
    WHERE r.project_id = ${rootProjectId}::uuid
      AND r.status IN ('completed', 'partial_failed') AND a.status = 'completed'
      ${hidden}
      AND ${kor}
      AND ${rtag}
    GROUP BY 1, 2, 3
  ),
  fc_active AS (
    SELECT DISTINCT target, region FROM fc_cells WHERE w
  ),
  fc AS (
    SELECT c.prompt_id,
      count(*) FILTER (
        WHERE (c.target, c.region) IN (SELECT ac.target, ac.region FROM fc_active ac)
          AND (c.w OR c.first_at IS NULL
            OR c.first_at <= (SELECT COALESCE(max(w_last), 'infinity'::timestamptz) FROM fc_cells))
      )::int AS expected_cells,
      count(*) FILTER (WHERE c.w)::int AS window_cells
    FROM fc_cells c
    GROUP BY c.prompt_id
  )`;
}
