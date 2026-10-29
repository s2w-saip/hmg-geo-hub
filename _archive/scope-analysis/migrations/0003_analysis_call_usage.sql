-- 0003 LLM 콜 원장 — 측정 lane `0014_ticket_cost_ledger.sql`(`ticket_attempt_usage`)의 동형.
--
-- ── 왜 두 곳에 원장이 있나 (스펙 §8.5)
--
--   | 원장                  | 위치      | 행 단위        | 용도                          |
--   | analysis_call_usage   | lane PG   | **LLM 콜 1회** | 운영: 풀별 실비·낭비·페일오버  |
--   | cost_ledger           | 코어 PG   | 태스크별 집계   | 과금·전사 집계                 |
--
--   코어 쪽은 `reply.evidence.llmUsage[]` 를 받아 기록한다(측정의 `evidence.apiUsage` →
--   `ticketApiUsageRecorder` 와 같은 배선). 여기 원장은 **lane 안에서만** 쓰는 운영 장부다.
--
-- ── 행의 입도가 attempt 가 아니라 **콜 1회**인 이유 (측정 0014 의 교훈 이식)
--
--   측정에서 `(ticket_id, attempt)` 유니크를 **의도적으로 두지 않았다**: 한 attempt 안에서
--   실행이 여러 번 일어나고(게이트 재시도) 각 실행이 **다른 벤더**일 수 있어, 합쳐 기록하면
--   GB 가 엉뚱한 벤더에 붙어 금액이 틀린다. 분석도 같다 — 한 티켓 안에서 extract/resolve/
--   semantics/citation 이 각각 돌고, `withRetry` 재시도와 **풀 페일오버**(429 → 다른 풀)가
--   콜 단위로 일어난다. 합산하면 단가가 잘못 배정된다. 그래서 `run_index` 로 구분한다.
--
--   NULL 의 의미: 토큰·비용이 NULL = **미계측**이지 0 이 아니다. 0 으로 위조하면 비용이 조용히
--   과소 집계된다(측정 `EvidenceV1` 의 "미측정은 null" 과 같은 규율).
--   ⚠️ 원장 쓰기가 분석을 죽이면 안 되므로 행 자체가 없을 수도 있다 — 뷰가 커버리지 카운터를
--   함께 내는 이유다.
--
-- ⚠️ 락: CREATE TABLE 은 새 relation 이라 기존 테이블을 잠그지 않는다. 단 FK 는
--    analysis_tickets 에 ShareRowExclusive 를 잠깐 잡는다.
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS analysis_call_usage (
  id           bigserial PRIMARY KEY,
  ticket_id    uuid NOT NULL REFERENCES analysis_tickets(ticket_id),
  attempt      int  NOT NULL,           -- analysis_tickets.attempt_count 스냅샷(리스 시점). 유니크 아님
  run_index    int  NOT NULL DEFAULT 1, -- 이 attempt 안에서 몇 번째 LLM 콜인가. 1-based
  worker_id    text NOT NULL,           -- = analysis_tickets.leased_by
  task         text NOT NULL CHECK (task IN ('extract','resolve','semantics','citation')),
  pool_key     text NOT NULL,           -- 'openrouter' | 'openai_direct' | 'google_direct' | ...
  model_id     text NOT NULL,           -- ⚠️ 코어 cost_ledger 에는 '<pool>/<model>' 로 간다(풀별 분리)
  outcome      text NOT NULL CHECK (outcome IN ('completed','retried','failed','failed_over','drained')),
  --   completed   = 그 콜이 유효 응답을 냈다
  --   retried     = 같은 풀로 재시도(백오프) — 실비는 나갔다
  --   failed_over = 429/5xx 로 **다른 풀**로 넘겼다. 모델은 절대 안 바뀐다(스펙 §8.3)
  --   drained     = 태스크 축소로 중단. 재시도 예산은 환불되지만 **실비는 이미 나갔다**
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL,
  latency_ms   int NOT NULL CHECK (latency_ms >= 0),
  input_tokens  bigint CHECK (input_tokens  IS NULL OR input_tokens  >= 0),  -- NULL = 미계측(0 아님)
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd     numeric(14,8) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  -- 비용의 출처. 벤더가 usage.total_cost 를 주는 풀(OpenRouter)과 레이트 테이블로 계산해야 하는
  -- 풀(직결)은 정확도가 다르다 — 행에 박아 두지 않으면 사후에 구분할 수 없다.
  cost_source  text CHECK (cost_source IS NULL OR cost_source IN ('vendor_reported','rate_table')),
  http_status  int,
  error_class  text,                    -- 분류된 실패(transient/output_contract/capacity/...)
  lane_revision text,                   -- @scope/analysis-core 버전 — 어느 순수 코드로 돈 콜인가
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_call_usage_ticket_idx ON analysis_call_usage (ticket_id);
-- "이 풀이 언제 얼마나 일했고 얼마를 태웠나" — 풀별 실비·429 비율의 접근 경로(램프 판정 A10 입력).
CREATE INDEX IF NOT EXISTS analysis_call_usage_pool_idx ON analysis_call_usage (pool_key, started_at);
CREATE INDEX IF NOT EXISTS analysis_call_usage_worker_idx ON analysis_call_usage (worker_id, started_at);

-- 티켓 1건 = 턴 1건의 비용.
CREATE OR REPLACE VIEW v_analysis_ticket_cost AS
SELECT
  u.ticket_id,
  count(*)                                                  AS calls,
  count(*) FILTER (WHERE u.outcome = 'completed')            AS completed_calls,
  count(*) FILTER (WHERE u.outcome = 'failed_over')          AS failover_calls,
  count(DISTINCT u.pool_key)                                 AS distinct_pools,
  min(u.started_at)                                          AS first_started_at,
  max(u.finished_at)                                         AS last_finished_at,
  sum(u.latency_ms)                                          AS total_latency_ms,
  sum(u.input_tokens)                                        AS input_tokens,   -- SUM 은 NULL 을 건너뛴다
  sum(u.output_tokens)                                       AS output_tokens,
  -- 커버리지: 이 값이 0 이 아니면 아래 비용은 **하한**이다. 반드시 함께 읽어라.
  count(*) FILTER (WHERE u.cost_usd IS NULL)                 AS unmetered_calls,
  sum(u.cost_usd)                                            AS cost_usd,
  -- 낭비 = 완주에 기여하지 않은 콜의 실비. 풀 전환·재시도 정책 조정의 판정 입력.
  sum(u.cost_usd) FILTER (WHERE u.outcome <> 'completed')    AS wasted_cost_usd
FROM analysis_call_usage u
GROUP BY u.ticket_id;

COMMENT ON VIEW v_analysis_ticket_cost IS
  '티켓(=턴) 1건당 LLM 비용. ⚠️ unmetered_calls > 0 이면 cost_usd 는 하한이다(그 콜의 단가를 모른다). '
  '과금 정본은 코어 cost_ledger 이고 이 뷰는 lane 운영용이다.';

-- 풀별 일 단위 실비·수율. 라우팅 가중치(스펙 §8.3)와 지출 가드(S4)의 입력.
CREATE OR REPLACE VIEW v_analysis_pool_activity AS
SELECT
  u.pool_key,
  u.task,
  (u.started_at AT TIME ZONE 'UTC')::date                    AS day_utc,
  count(*)                                                   AS calls,
  count(*) FILTER (WHERE u.outcome = 'completed')            AS completed_calls,
  count(*) FILTER (WHERE u.http_status = 429)                AS rate_limited_calls,
  round(avg(u.latency_ms))                                   AS avg_latency_ms,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY u.latency_ms) AS p95_latency_ms,
  sum(u.cost_usd)                                            AS cost_usd
FROM analysis_call_usage u
GROUP BY u.pool_key, u.task, (u.started_at AT TIME ZONE 'UTC')::date;

COMMENT ON VIEW v_analysis_pool_activity IS
  '풀×태스크 일별 수율. rate_limited_calls 비율이 헬스 게이팅(5분 창 429/5xx > 10% → 가중치 0)의 사후 검산이다.';

RESET lock_timeout;
