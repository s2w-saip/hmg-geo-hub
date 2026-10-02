import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { addressableRootProjectId } from "@/lib/surface/run-surface";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";

// ════════════════════════════════════════════════════════════════════════════
// **카탈로그 도입 전 회차** 판정 — 6월 자리에 값이 나오게 (제품 책임자 2026-09-20 지시 ①)
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: `internal-kb/hmg-geo-trend-single-source-design-2026-09-20.md`
// §4(D2) · 이 트랙의 `X.trendGrid` 키.
//
// ── 증상 ────────────────────────────────────────────────────────────────────
//
// 6월 자리(귀속 06-07·06-13·06-22·06-29)는 **발행돼 있고 사실표에 행도 있는데**
// (`summary_trend_*` 12~70행 · `monitored` 748~1,500) 화면이 빈다. 원인은 글로벌
// 리더의 두 게이트다: 그 회차들의 행은 `in_root_catalog = 1` 이 **한 행도 없다**.
// 지금의 루트 카탈로그(`prompts` where project_id = 루트)는 07-02 회차부터 잡히고,
// 6월 회차가 측정한 프롬프트 세트는 그 카탈로그가 생기기 전 것이라 전부 0 이다.
// 게이트는 등호라 자리 전체가 0행 → 점이 사라진다.
//
// ── 규칙 (날짜 하드코딩 금지 — 데이터가 판정한다) ───────────────────────────
//
//   **그 회차(활성 세대)의 사실표 행 중 `in_root_catalog = 1` 이 하나도 없으면**
//   그 회차는 카탈로그 도입 전 세대로 보고 **카탈로그·지역 게이트를 적용하지 않는다**
//   (= 그 회차가 측정한 프롬프트 전체가 모수).
//
// 세 가지가 이 규칙의 안전장치다.
//
//   ① **혼합 회차는 대상이 아니다.** 카탈로그 행이 하나라도 있으면(07-02 이후 전부)
//      `NOT EXISTS` 가 거짓이 되어 종전 게이트가 그대로 걸린다. 판정이 "0인가"라
//      경계가 데이터에 있고 날짜에 없다.
//   ② **행이 아예 없는 회차는 대상이 아니다.** `EXISTS` 를 함께 요구한다 — 접기가
//      아직 안 돈 회차(신규·실패)를 "카탈로그 전" 으로 오판하면 게이트가 통째로
//      풀린 채 미러가 그려진다. 그 방향의 오류는 **값이 부푸는** 쪽이라 더 나쁘다.
//   ③ **판정은 한 곳, 소비는 두 곳.** 사실표 경로(`trendWhere`)와 미러 폴백 경로
//      (`trendAlignedRootPreds` 계열)가 **같은 id 목록**을 읽는다 —
//      `trend-grid-flag.ts` 의 state 하나가 격자 판정과 목록을 함께 들고, 만료도 하나다.
//      보장 범위는 거기까지다(2026-09-20 독립 검증 A2): 판정이 **실패한** 요청에서는
//      두 경로가 **둘 다** 빈 목록을 본다(= 둘 다 닫힘). 값이 갈리지는 않지만 그
//      요청의 6월은 닫힌 채 나가고, 그 결과는 캐시되지 않는다(다음 요청이 재시도).
//
// ── 왜 `summary_prompt_dim` 으로 판정하지 않는가 (중요) ─────────────────────
//
// 미러 쪽 게이트는 dim 스냅샷(`d.in_root_catalog`)을 읽으므로 dim 이 자연스러운
// 판정원처럼 보이지만 **쓸 수 없다**: dim 의 모집단이
// `pids = SELECT pid FROM cat UNION SELECT prompt_id FROM jb`
// (`scripts/summary/surface-global.ts:512-528`)라 **루트 카탈로그 전량이 항상 들어
// 있다**. 그래서 "그 회차 dim 에 `in_root_catalog = 1` 행이 있는가" 는 어느 회차에서나
// 참이고, 6월을 골라내지 못한다. 골라내려면 dim 을 그 회차가 **실제로 측정한**
// 프롬프트로 좁혀야 하는데(= `summary_cycle_jobs` 조인), 그러면 사실표 행 판정과
// 같은 집합을 더 비싸게 구하는 것이 된다. 그래서 **게이트가 실제로 걸리는 표**를
// 직접 본다 — 판정과 게이트가 같은 행을 보므로 서로 어긋날 수 없다.
//
// ── 어느 표를 보는가: `summary_trend_answers` (2026-09-20 독립 검증 A1-c 수리) ──
//
// 초판은 `summary_trend_own` 을 봤다(노출률의 분자·분모가 거기 있으므로). 검증이
// pglite 로 반증했다: **답변 행은 있는데 own 행이 없는 회차**(당사 언급 0 · 접기 부분
// 실패)는 목록에 안 들고, 그 자리의 모수·퍼널·인용이 전부 계속 빈다. `own` 은 own_variant
// 축이라 행 존재 범위가 `answers` 의 부분집합이다 — 판정원으로는 `answers` 가 넓고
// 안전하다. 네 표는 같은 `d` CTE 에서 함께 접히므로(`surface-global.ts::dimsCte`)
// `in_root_catalog` 값이 표 사이에서 갈리지 않는다. 즉 표를 넓혀도 규칙은 그대로다.
//
// ── 판정 모집단 = 게이트 모집단 (A1-d 수리) ────────────────────────────────
//
// 판정은 게이트가 **실제로 남기는 행**만 봐야 한다. 초판은 `run_status` 와 숨김 지역을
// 안 봤다: 어떤 회차의 `in_root_catalog = 1` 행이 전부 `run_status` 밖이거나
// `country = 'ID'` 라면 판정은 "카탈로그 전 아님" 인데 게이트 결과는 0행 → 자리가
// 조용히 빈다. 그래서 두 술어를 판정에도 건다(`trendWhere` 의 같은 두 줄).
// `own_variant` 는 `answers` 표에 없으므로 대상이 아니다.
//
// ── 비용 ────────────────────────────────────────────────────────────────────
//
// `summary_cycles` 의 `surface='global'` 행은 수십 개다. 회차당 인덱스 탐색 2회
// (`summary_trend_answers_gen (cycle_id, generation_id)`, 0065 블록 ③)뿐이고 격자 판정과
// 같은 30초 메모라 한 렌더에 왕복 1회 이하다.
// ⚠️ 그 인덱스의 **적용 여부는 DB 실측 대상**이다(이 리포의 규율: 저널은 신뢰 신호가
//    아니다). 확인 SQL 은 판정문 §I SQL-5.

/**
 * 판정 SQL. **읽기 전용 단일 문장**이고 하네스가 그대로 붙여 넣을 수 있게 export 한다.
 *
 * @param rootProjectId `summary_cycles.project_id` 스코프. `null` 이면 안 건다
 *        (`trendDimJoinSql` 과 같은 자세 — 루트 설정이 없는 배포에서 표면만으로 판정).
 */
export function preCatalogCyclesSql(rootProjectId: string | null): SQL {
  const projectScope = rootProjectId ? sql` AND sc.project_id = ${rootProjectId}` : sql``;
  // 게이트와 같은 모집단(위 A1-d) — `trendWhere` 의 `run_status` 와 숨김 지역 제외.
  const gate = sql`t.run_status IN ('completed', 'partial_failed')
            AND t.country <> ALL(${sql.param([...HIDDEN_STANDARD_REGIONS])}::text[])`;
  return sql`
    SELECT sc.cycle_id::text AS cycle_id
      FROM summary_cycles sc
     WHERE sc.surface = 'global'
       AND sc.active_generation_id IS NOT NULL${projectScope}
       AND EXISTS (
         SELECT 1 FROM summary_trend_answers t
          WHERE t.cycle_id = sc.cycle_id AND t.generation_id = sc.active_generation_id
            AND ${gate}
       )
       AND NOT EXISTS (
         SELECT 1 FROM summary_trend_answers t
          WHERE t.cycle_id = sc.cycle_id AND t.generation_id = sc.active_generation_id
            AND t.in_root_catalog = 1
            AND ${gate}
       )
     ORDER BY sc.cycle_anchor_at;
  `;
}

// ── 읽기만 한다 — **메모는 여기에 없다** (2026-09-20 독립 검증 A2) ──────────
//
// 초판은 이 파일이 30초 메모를 따로 들었다. 그러면 격자 판정(`trend-grid-flag.ts`)과
// **만료 시점이 둘**이 되고, 목록이 먼저 만료된 구간에서 `ensureTrendGrid()` 는 캐시된
// `true` 를 즉시 돌려주면서 목록은 빈 채로 남는다. 그 순간 시작된 요청이 미러 셀에
// 굳으면 **한 경로만 6월이 닫힌 값**이 TTL 동안 서빙된다.
//
// 그래서 메모를 격자 state 객체 **안으로** 옮겼다(`trend-grid-flag.ts::ensureTrendGrid`).
// 만료가 하나뿐이라 그 구간이 존재하지 않는다. 이 파일은 SQL 과 1회 읽기만 담당한다.

/**
 * 목록을 한 번 읽는다. **실패는 던진다** — 호출부가 "실패를 캐시하지 않는다" 를
 * 결정해야 하기 때문이다(초판은 여기서 빈 목록을 30초 캐시했고, 그것이 A2 의
 * 두 번째 구멍이었다).
 */
export async function readPreCatalogCycleIds(): Promise<readonly string[]> {
  const rows = (await getDb().execute(
    preCatalogCyclesSql(addressableRootProjectId()),
  )) as unknown as Array<{ cycle_id: string }>;
  return rows.map((r) => r.cycle_id).filter((v): v is string => Boolean(v));
}
