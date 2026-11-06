// Type-only snapshot; no database or server implementation is included.
import "server-only";
/**
 * **동기** 판정(`columnKnownAvailable`)이 읽는 전체 목록 = `ensureColumnAvailability`
 * 가 확정하는 전체 목록. 비동기 판정(`columnAvailable`)은 호출부가 이미 await 하므로
 * 여기 없어도 된다 — 콜드 스타트에 프로브를 늘리지 않으려고 일부러 좁게 유지한다.
 */
export declare const SYNC_PROBED_COLUMNS: readonly [readonly ["scope_prompts", "is_korean"], readonly ["scope_prompts", "regions"], readonly ["scope_citations", "url_norm"], readonly ["summary_answers", "presence_set"], readonly ["summary_trend_brands", "comp_rank_sum"]];
type SyncProbedColumn = (typeof SYNC_PROBED_COLUMNS)[number];
/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export declare function resetColumnAvailabilityForTests(): void;
/** 테스트 전용 — DB 없이 판정값을 고정한다(컬럼 있는 경로의 SQL 형태 검증용). */
export declare function setColumnAvailabilityForTests(table: string, column: string, value: boolean): void;
/**
 * 테스트 전용 — 동기 판정 **전체**를 확정 상태로 만든다(= 프로브가 이미 끝난 웜 프로세스).
 * 개별 `setColumnAvailabilityForTests` 를 나열하는 대신 이걸 쓰면, 나중에
 * `SYNC_PROBED_COLUMNS` 에 키가 늘어도 테스트가 다시 깨지지 않는다.
 */
export declare function resolveColumnAvailabilityForTests(value?: boolean): void;
/**
 * SQL 빌더(동기)가 읽는 판정값. **호출 전에 `ensureColumnAvailability()` 가 await 돼
 * 있어야 한다** — 그때는 이 함수가 확정값을 그대로 돌려준다.
 *
 * 미확정 상태로 불리면 종전처럼 폴백(false)을 내고 백그라운드 프로브를 띄우지만,
 * 그건 **결함 신호**다(첫 호출만 다른 술어 = 다른 숫자). 그래서 키마다 한 번 경고를
 * 남긴다 — 등록되지 않은 새 진입점이 생기면 로그에 이름이 찍힌다.
 */
export declare function columnKnownAvailable(...[table, column]: SyncProbedColumn): boolean;
/**
 * 동기 판정 전부를 **확정**한다. SQL 을 만들기 전에 한 번 await 하면 그 프로세스의
 * 첫 호출도 이후 호출과 같은 술어를 낸다(이 모듈 머리 주석의 계약 ①).
 *
 * · 확정된 true 는 영구 캐시라 두 번째 호출부터 쿼리가 없다(이미 resolved 된 프로미스 하나).
 * · 부재·실패는 TTL 이 지나면 다시 묻는다 — 재배포 없이 db:apply 를 따라잡는 성질 유지.
 * · 절대 throw 하지 않는다 — 프로브 실패가 화면 장애가 되지는 않게(대신 폴백이 굳지
 *   않도록 위 `PROBE_ERROR_RETRY_MS` 로 짧게 잊는다).
 * · **한 문장으로 묶어 묻는다.** 키마다 따로 물으면 왕복이 4회이고, 병렬로 묶으면
 *   이번엔 콜드 풀에 커넥션이 4개 동시에 열린다. 실측(2026-09-10, 랩톱→Supavisor,
 *   커넥션 웜업 후 3회 반복): **배치 274/355/274 ms** · 낱개 4회 병렬 1,171→275→287 ms
 *   (첫 회가 느린 것이 커넥션 3개 추가 수립분) · 낱개 4회 순차 1,060/1,193/1,164 ms.
 *   즉 콜드에서 4.3배다. 이 리포는 풀러 CONNECT_TIMEOUT 이력이 있어(lib/db/index.ts
 *   주석) 콜드에 커넥션을 더 여는 것 자체가 위험이기도 하다. 판정 **로직**은 여전히
 *   한 벌이다(같은 pg_attribute 술어 — 묶음이냐 낱개냐만 다르다).
 * · 동시에 여러 진입점이 불러도 발사는 1회다(`inflightBatch`).
 */
export declare function ensureColumnAvailability(): Promise<void>;
/**
 * 같은 판정의 **await 가능한** 형태. 호출부가 이미 async 이면 이쪽을 쓴다 —
 * 동기 판정은 첫 호출이 무조건 false 라서, **드물게 도는 경로**(런당 1회인 미러
 * 재싱크 같은)에서는 "첫 번째가 항상 폴백"이 곧 결손이 된다. 캐시·inflight 는
 * 동기 경로와 공유하므로 프로세스당 프로브는 그대로 1회다.
 */
export declare function columnAvailable(table: string, column: string): Promise<boolean>;
/**
 * 0053 의 회차 앵커 레지스트리를 쓸 수 있는가. 테이블·인덱스·`scope_anchor_fold()`
 * 함수가 한 마이그레이션에서 함께 생기므로 대표 컬럼 하나만 본다(0052 와 동일 자세).
 * 테이블이 아예 없으면 `to_regclass` 가 NULL 이라 프로브는 false 를 돌려준다.
 */
export declare function anchorRegistryAvailable(): Promise<boolean>;
/**
 * 0077 의 **답변 단위 회차 앵커 전수 테이블**을 쓸 수 있는가. 테이블·인덱스와
 * `refresh_answer_cycle_anchors()`·`hmg_anchor_*()` 함수가 한 마이그레이션에서 함께
 * 생기므로 대표 컬럼 하나만 본다(0052~0054 와 같은 자세).
 *
 * 없으면:
 *   · 쓰기 — 미러 싱크가 앵커 행을 **만들지 않는다**(0 건 통과, 에러 아님). 적용 후
 *     백필(`npm run db:backfill:answer-anchors -- --apply`)이 그 창을 회수한다.
 *   · 읽기 — `listSelectableAnchorDates` 가 **빈 목록**을 돌려준다. 달력은 종전대로
 *     동작해야 하며(비활성 날짜 없음), 조용히 다른 시계로 대체하지 않는다
 *     (`answerStancesAvailable` 주석이 경계하는 "조용한 회귀"와 같은 규율).
 */
export declare function answerCycleAnchorsAvailable(): Promise<boolean>;
/**
 * 0054 의 답변 드롭 레지스트리를 쓸 수 있는가. 테이블과 `scope_answer_drop_apply()`
 * 함수가 한 마이그레이션에서 함께 생기므로 대표 컬럼 하나만 본다(0053 과 동일 자세).
 */
export declare function dropRegistryAvailable(): Promise<boolean>;
/**
 * 0052 의 인용 URL 정규화 컬럼이 쓸 수 있는가. 세 컬럼과 세 SQL 함수는 같은
 * 마이그레이션에서 함께 생기므로 대표 컬럼 하나만 본다 — 부분 적용된 상태는
 * 이 리포의 적용 경로(파일 = 한 트랜잭션)에서 만들어질 수 없다.
 */
export declare function citationNormColumnsAvailable(): boolean;
/**
 * 0070 의 **회차 원장 숨김**(`summary_cycles.hidden_reason` / `hidden_at`)을 쓸 수 있는가.
 * 두 컬럼과 CHECK 제약이 한 마이그레이션에서 함께 생기므로 대표 컬럼 하나만 본다
 * (0052~0054 와 같은 자세). 이 리포는 머지 = 무인 배포이고 마이그레이션은 사람이
 * 따로 적용하므로 **코드가 컬럼 없는 DB 에 먼저 갈 수 있다**(그 반대도).
 *
 * 없으면 숨김은 **아무 일도 하지 않는다** — 리더 술어에서 절이 빠지고, 회차 픽은
 * 종전 술어 그대로이며, 갭 슬롯 목록은 빈 배열이다. 즉 0070 적용 전 배포는 현행
 * 화면과 **바이트 동일**하다(그 성질을 테스트가 고정한다).
 */
export declare function hiddenCycleColumnsAvailable(): Promise<boolean>;
/**
 * 0071 의 **숨김 범위**(`summary_cycles.hidden_scope`)를 쓸 수 있는가.
 *
 * ⚠️ 0070 프로브(`hiddenCycleColumnsAvailable`)에 컬럼을 **더하지 않는다.** 더하면
 * "0070 은 적용됐는데 0071 은 아직" 인 배포에서 숨김 기능 자체가 통째로 꺼져
 * 8/24 골짜기가 화면에 돌아온다(= 0070 이전 상태로의 조용한 회귀). 두 마이그레이션은
 * 따로 적용되므로 프로브도 따로 둔다.
 *
 * 교차 배포 4상태 — 전부 안전해야 한다:
 *   0070 ✗ / 0071 ✗ → 숨김 없음(0070 이전 화면)
 *   0070 ✓ / 0071 ✗ → **회차 전체 숨김**(0071 이전 화면) ← 이 프로브가 false
 *   0070 ✓ / 0071 ✓ + 구 코드 → hidden_scope 무시 = 회차 전체 숨김
 *   0070 ✓ / 0071 ✓ + 신 코드 → 계열 분리(인용만 숨김)
 */
export declare function hiddenCycleScopeAvailable(): Promise<boolean>;
/**
 * 0061 의 발생 단위 언급 미러(scope_mention_occurrences)를 쓸 수 있는가. 머지 = 배포라
 * 테이블보다 코드가 먼저 갈 수 있다 — 없으면 답변 모달은 밑줄 없이 종전대로 그린다.
 */
export declare function mentionOccurrencesAvailable(): Promise<boolean>;
/**
 * 0072 의 **답변 단위 브랜드 스탠스 미러**(scope_answer_stances)를 쓸 수 있는가.
 * 0061 프로브(`mentionOccurrencesAvailable`)와 같은 자세 — 머지 = 무인 배포라 코드가
 * 테이블보다 먼저 갈 수 있다.
 *
 * 없으면:
 *   · 쓰기 — 미러 싱크가 스탠스를 **삭제도 삽입도 하지 않는다**(0 건 통과, 에러 아님).
 *   · 읽기 — 답변 모달은 스탠스 태그 없이 종전대로, 우호도 탭은 스탠스 카드가
 *     "측정 대기" 문구로 떨어진다. **발생 감성으로 조용히 대체하지 않는다**
 *     (위 `hiddenCycleScopeAvailable` 주석이 경계하는 "조용한 회귀"와 같은 규율).
 */
export declare function answerStancesAvailable(): Promise<boolean>;
/**
 * 0082 의 **증분 읽기 워터마크**(scope_sync_watermarks)를 쓸 수 있는가. 0061·0072 프로브와
 * 같은 자세 — 코드가 표보다 먼저 배포될 수 있다.
 *
 * 없으면 미러 싱크는 **종전 전량 읽기**로 돌고 워터마크를 읽지도 쓰지도 않는다
 * (lib/scope/mirror/sync.ts 의 loadSyncWatermarks → null). 즉 0082 적용 전 배포는
 * 종전 크론과 동작이 같다.
 */
export declare function syncWatermarksAvailable(): Promise<boolean>;
export {};
