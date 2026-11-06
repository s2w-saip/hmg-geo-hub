// Type-only snapshot; no database or server implementation is included.
import { type SQL } from "drizzle-orm";
/**
 * **회차 앵커 축(0077 `scope_answer_cycle_anchors`)의 SQL 조각 정본.**
 *
 * 계약: `notes/hmg-anchor-table/streams/CONTRACT.md` §2·§3 ·
 * 스펙 `internal-kb/hmg-geo-answer-anchor-table-spec-2026-09-19.md`
 * §5·§9·§9.2.
 *
 * ── 기간 키는 `round_date` 다. `anchor_date` 가 아니다 ────────────────────────
 *
 * 테이블에는 날짜 컬럼이 둘이다:
 *   · `anchor_date`  — 실제 앵커의 KST 일자. **기록용**이고 기간 키가 아니다.
 *   · `round_date`   — 회차 **귀속** 날짜(§9.2 정규 요일 귀속: 글로벌 = 월요일,
 *                      website = 금요일, project = `anchor_date`). 기간 술어·달력·
 *                      dedup·주 버킷·MoM 월이 **전부 이 키 하나**를 본다.
 * 둘을 섞으면 "달력에서 고른 날짜"와 "그 날짜로 걸리는 답변"이 갈린다 — 이 전환이
 * 없애려는 결함이 정확히 그것이므로, 리더는 `anchor_date` 를 읽지 않는다.
 *
 * ── 왜 상관 서브쿼리를 쓰지 않는가 ──────────────────────────────────────────
 *
 * 계약 §5: 프로덕션 미러에서 상관 서브쿼리가 statement_timeout 을 낸 전례가 세 번
 * 있다. 그래서 이 모듈이 내는 형태는 둘뿐이다:
 *   ① **비상관 semi-join** — `<job_id> IN (SELECT job_id FROM … WHERE <상수 술어>)`.
 *      플래너가 hashed SubPlan 으로 1회 평가한다(`answerWhere` 의 run 스코프 술어가
 *      이미 쓰는 형태와 같다). 기간·노출 게이트·기본 엔진이 여기 들어간다.
 *   ② **명시 조인** — `JOIN scope_answer_cycle_anchors ca ON ca.job_id = <job_id>`.
 *      `round_date`·`anchor_week` 를 **식으로 꺼내야** 하는 자리(dedup 키·주 버킷·
 *      `max(round_date)`)에만 쓴다. `job_id` 가 PK 라 행이 불어나지 않는다
 *      (관측이 아니라 제약이 보장한다 — 계약 §2 의 `job_id uuid PK`).
 *
 * ── 인덱스와의 정합 ────────────────────────────────────────────────────────
 * DATA 스트림이 두는 인덱스: `(round_date, job_id)` · `(surface, round_date)` ·
 * `(project_id, round_date, measured_at_orig DESC)`. 마지막 것이 "회차마다 셀당
 * 대표 1건"(`DISTINCT ON … ORDER BY … measured_at_orig DESC`)까지 받는다.
 */
/** 앵커 테이블의 관례 별칭. 조각을 조립하는 쪽이 이 별칭으로 조인한다. */
export declare const ANCHOR_ALIAS = "ca";
/** 앵커 테이블 이름 — 리터럴을 흩지 않는다. */
export declare const ANCHOR_TABLE = "scope_answer_cycle_anchors";
/**
 * **기간 술어·dedup·달력의 키** = 회차 귀속 날짜(KST `date`).
 *
 * 표면별로 갈리지 않는다 — §9.2 가 귀속 규칙을 표면마다 다르게 정의하되 그 결과를
 * **같은 컬럼**에 굳히기 때문이다(website 의 `fleet_round_date` 분기는 폐기).
 */
export declare const anchorRoundDateSql: (alias?: string) => SQL;
/**
 * **주 버킷 키** = `round_date` 가 속한 KST 주의 월요일(`date`).
 *
 * 종전 `date_trunc('week', a.measured_at)` 은 **세션 TimeZone 으로 잘린다**
 * (`sql-day.ts` 머리 주석 — Supavisor 풀에서 앞선 세션의 GUC 가 남는 경로가 이
 * 리포에 실증돼 있다). 이 컬럼은 쓰기 시점에 KST 로 굳은 `date` 라 세션과 무관하다.
 * 그래서 앵커 축에서는 `sessionTzBucketSql` 을 **부르지 않는다**.
 */
export declare const anchorWeekSql: (alias?: string) => SQL;
/** MoM 월 키 = `round_date` 의 달 1일. */
export declare const anchorMonthSql: (alias?: string) => SQL;
/**
 * **대표 답변 정렬 키** = 원본 측정 시각(접기 이전).
 *
 * 스펙 §2-16: 접힌 `measured_at` 으로 정렬하면 날짜부가 앵커로 덮여 있어 시:분만
 * 비교하게 된다(Genesis NL 7/27 회차에서 선택 방식에 따라 인용 점유율이
 * 10.33%~19.92% 로 갈렸다). 앵커 축의 dedup 동점 처리는 반드시 이 컬럼이다.
 */
export declare const anchorMeasuredOrigSql: (alias?: string) => SQL;
/** 기본 타깃(ChatGPT·Gemini) 여부 — 엔진 필터가 비었을 때의 **기본 범위**. */
export declare const anchorDefaultEngineSql: (alias?: string) => SQL;
/**
 * **노출 게이트의 원본 값**(`date` NULL 가능. NULL = 비노출).
 *
 * 술어로 거는 자리는 `scope-answer-anchors.ts::anchorViewableSql` 이 정본이다 —
 * 이 조각은 값을 **JS 로 꺼내야** 하는 자리(미러 투영 → `AnswerAnchorFields`)에만
 * 쓴다. JS 쪽 게이트는 3값이라(`undefined` 미투영 / `null` 비노출 / 값 비교)
 * NULL 을 술어에서 접지 않고 그대로 실어야 한다.
 */
export declare const anchorViewAnchorDateSql: (alias?: string) => SQL;
/**
 * ` JOIN scope_answer_cycle_anchors ca ON ca.job_id = <jobIdCol>` — 선행 공백 포함.
 *
 * `FROM scope_answers a` 바로 뒤에 그대로 이어 붙이는 조각이다(`trendWeekKey` 의
 * `join` 과 같은 계약). **INNER** 인 이유: 앵커 행이 없는 완료 답변은 축 전환 뒤
 * 기간에 걸 수 없다 — LEFT 로 두고 NULL 을 통과시키면 기간 필터가 조용히 새고,
 * 막으면 INNER 와 같다. 백필이 전수를 채우는 것이 전제이고(스펙 §6 수용 기준),
 * 미충전 구간은 capability 프로브가 축 자체를 끈다.
 */
export declare function anchorJoinSql(jobIdCol: SQL, alias?: string): SQL;
/**
 * **비상관 semi-join** — `<jobIdCol> IN (SELECT ca.job_id FROM … WHERE <preds>)`.
 *
 * `preds` 가 비면 술어를 만들지 않고 `null` 을 돌려준다(호출부가 절을 통째로
 * 생략한다 — 빈 `WHERE` 로 전수 semi-join 을 도는 것을 막는다).
 *
 * ⚠️ `preds` 에 바깥 별칭(`a.*`)을 넣지 마라. 넣는 순간 상관 서브쿼리가 되고
 *    계약 §5 가 금지하는 형태가 된다. 이 함수가 그것을 강제할 수단은 없으므로
 *    호출부 규율이다 — 넣어야 할 값은 전부 상수 술어다(날짜·표면·플래그).
 */
export declare function anchorJobIdIn(jobIdCol: SQL, preds: SQL[], alias?: string): SQL | null;
/**
 * 기본 엔진 범위 술어 — **엔진 필터가 비어 있을 때만** 건다(계약 §3, 스펙 §2-17).
 *
 * 사용자가 엔진을 고르면 그 선택이 이긴다. 옵트인 엔진(DeepSeek 파일럿 200건·3개
 * 프로젝트)이 정규 회차 앵커를 물고 들어와 있으므로, **기본값**에서는 그것을 빼고
 * 명시 선택에서는 보여 주는 것이 맞다 — 고른 엔진이 화면에서 사라지면 그것이
 * 결함으로 읽힌다.
 *
 * 선택된 엔진이 있으면 `null`(이 축의 술어 없음) — 종전 `a.target IN (…)` 술어가
 * 그대로 범위를 정한다.
 */
export declare function anchorDefaultEngineScope(selectedEngines: string[] | undefined, alias?: string): SQL | null;
/**
 * **run 축의 비상관 semi-join** — `<runIdCol> IN (SELECT ca.run_id FROM … WHERE <preds>)`.
 *
 * `job_id` 가 없는 표(`scope_acr_rollups`)를 앵커 축에 붙이는 유일한 경로다.
 *
 * ⚠️ **성립 조건**: `round_date` 가 run 마다 **하나**여야 한다. 스펙 §3.1 이 앵커를
 * 회차 단위로 정하고 답변이 상속하게 했고(회차 = 같은 프로젝트·같은
 * `scope_runs.cycle_anchor_at` 의 run 묶음), run 은 회차 하나에만 속한다 — 그래서
 * run → `round_date` 는 함수다. **DB 로 확인하지는 못했다**(테이블이 아직 없다).
 * 이 전제가 깨지면 한 run 이 여러 회차에 걸려 기간 술어가 넓게 잡힌다.
 *
 * ⚠️ `is_default_engine` 은 **답변 단위**라 이 경로에 넣지 않는다. run 에 기본 엔진
 * 답변이 하나라도 있으면 참이 되어 의미가 없고, 넣으면 옵트인 엔진 전용 run 만
 * 걸러지는 착시를 준다.
 */
export declare function anchorRunIdIn(runIdCol: SQL, preds: SQL[], alias?: string): SQL | null;
/** 최신 회차를 고르는 서브쿼리의 내부 별칭 — 바깥 `ca` 와 절대 겹치면 안 된다. */
export declare const ANCHOR_LATEST_ALIAS = "ca2";
/**
 * **기간 미지정 기본 화면의 기준 회차** = 그 화면 범위에서 노출 가능한 가장 최신
 * `round_date` **하나** (제품 결정 2026-09-20).
 *
 * ```sql
 * ca.round_date = (SELECT max(ca2.round_date)
 *                    FROM scope_answer_cycle_anchors ca2
 *                   WHERE <범위> AND <노출 게이트>)
 * ```
 *
 * ── 왜 스칼라 서브쿼리인가 (상관 서브쿼리가 아니다) ─────────────────────────
 * `scopePreds`·`gatePreds` 는 전부 **상수 술어**(project_id 목록·표면·날짜 함수·
 * 컬럼 플래그)이고 바깥 별칭 `a.`·`ca.` 를 한 번도 참조하지 않는다. 그래서 플래너가
 * InitPlan 으로 **한 번만** 평가한다 — 계약 §5 가 금지하는 "행마다 재평가되는 상관
 * 서브쿼리"가 아니다. 그 성질은 텍스트 단언으로 고정한다(`(^|[^c])a\.` 부재).
 *
 * ── 표면 단위 **단일 날짜**인 이유 ─────────────────────────────────────────
 * `max()` 를 프로젝트별로 나누지 않는다(GROUP BY 없음). 화면 전체가 한 날짜를 보고,
 * 그 회차에 데이터가 없는 프로젝트는 빠진다(기존 `partial` 의미론과 같다). 프로젝트마다
 * 최신을 따로 고르면 한 화면에 여러 날짜가 섞여 "이 카드는 언제 기준인가"에 답이 없어진다.
 *
 * ── 노출 게이트를 **여기에도** 거는 이유 ───────────────────────────────────
 * 안 걸면 아직 노출일이 안 온 회차(또는 수집 오류로 숨긴 회차)가 기준 회차로 뽑히고,
 * 바깥 술어가 그 회차를 다시 걷어내 **화면이 통째로 빈다**. 게이트를 통과한 것 중의
 * 최신이어야 한 칸 뒤로 물러나 정상 회차를 잡는다.
 */
export declare function anchorLatestRoundDateSql(scopePreds: SQL[], gatePreds: SQL[], innerAlias?: string): SQL;
/** 위 값과 같은 회차만 남기는 술어. `outerAlias` 는 이미 조인·semi-join 안에 있는 `ca`. */
export declare function anchorLatestRoundClause(scopePreds: SQL[], gatePreds: SQL[], outerAlias?: string): SQL;
/** 파생 표의 관례 별칭. */
export declare const CYCLE_ROUND_ALIAS = "cr";
/**
 * ` LEFT JOIN (…) cr ON cr.cycle_id = <cycleIdCol>` — 선행 공백 포함(FROM 절 뒤에 잇는다).
 *
 * `LEFT` 인 이유: 앵커 행이 아직 없는 회차(백필 전·표면 밖)는 `NULL` 이어야 호출부가
 * 폴백을 고를 수 있다. `INNER` 로 두면 그 회차가 집합에서 조용히 사라진다.
 */
export declare function cycleRoundJoinSql(cycleIdCol: SQL, alias?: string, scope?: SQL): SQL;
/** 위 파생 표가 실어 주는 귀속 날짜 열. */
export declare const cycleRoundDateSql: (alias?: string) => SQL;
