-- 0008 콜 원장에 **무캐시 태세** 표기 — 게이트③ (테오 결정 2026-09-13).
--
-- ── 왜 컬럼인가 (`error_class` 를 재활용하지 않는 이유)
--
--   `analysis_call_usage` 에는 자유 `metadata` 가 없고 남는 자리는 `error_class` 뿐이다.
--   그런데 그 컬럼은 **실패의 분류 어휘**이고(`transient`·`rate_limited`·`truncated_empty` …)
--   `v_analysis_pool_activity` 를 비롯한 운영 판정이 그 값을 읽는다. 성공한 콜에 `cache_bust`
--   같은 태세 문자열을 끼워 넣으면 ① 실패 어휘가 오염되고 ② `error_class IS NOT NULL` 을
--   "실패" 로 읽는 모든 질의가 **성공 콜을 실패로 센다**. 축이 다르면 컬럼도 달라야 한다.
--
-- ── 왜 필요한가 (실측)
--
--   같은 번들을 몇 분 간격으로 두 번 돌리면 luna 콜 실비가 −55%(OpenAI 프롬프트 캐시 히트)이고
--   결과 일치가 0.978 로 뛴다. 캐시가 식은 뒤 재면 0.857 이다. lane shadow 는 인라인 직후에 돌아
--   그 이득을 그대로 받아 0.987 을 냈다 — 품질 증거가 아니다. 컷오버 후 lane 은 혼자 도므로
--   이득이 없다. 그래서 게이트 창은 `ANALYSIS_LLM_CACHE_BUST=true` 로 돌리고, **어느 행이 그
--   창의 것인지**를 행 자신이 들고 있어야 한다. 시간 범위로 사후 재구성하면 배포·재기동 경계가
--   섞이고, 그 오염은 "실패" 가 아니라 **오답**이라 아무 알람도 울지 않는다.
--
-- ── 락
--
--   `ADD COLUMN ... boolean NOT NULL DEFAULT false` 는 PG 11+ 에서 **테이블 재작성이 없다**
--   (비휘발성 기본값은 카탈로그에만 적힌다). 그래도 `ACCESS EXCLUSIVE` 는 잠깐 잡으므로
--   `lock_timeout` 을 걸어 **못 잡으면 빨리 실패**시킨다 — 배포가 서는 것이 조용히 오래 잡는
--   것보다 낫다(0007 헤더와 같은 규율).
--
--   ⚠️ `IF NOT EXISTS` 를 쓰지 않고 **카탈로그 선확인 DO 블록**이다. `ALTER TABLE ... ADD COLUMN
--      IF NOT EXISTS` 는 no-op 인 경우에도 락을 **먼저** 잡는다(워크스페이스 흉터 2026-07-31:
--      no-op 이 797초 대기·44세션 적체). 러너는 미적용분 전부를 한 트랜잭션에서 돌리므로
--      (`app/migrate.ts` `applyMigrations` = `pg_advisory_xact_lock` 안) 여기서 오래 잡으면
--      마이그레이션 전체가 매달린다.
--
-- ⚠️ `false` 는 "캐시를 껐다고 기록되지 않았다" 다. 0008 이전 행은 그 스위치가 존재하지도
--    않았으므로 false 가 사실이다(기본 태세 = 캐시 켜짐).
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  -- ⚠️ `information_schema.columns` 를 **안 쓴다** — 그 뷰는 `table_name` 만으로 찾으면
  --    search_path 밖 동명 테이블까지 잡는다. `to_regclass` 는 0007 과 같은 관례이고
  --    search_path 를 그대로 따른다(= 러너가 실제로 고칠 그 테이블을 본다).
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('analysis_call_usage')
      AND attname = 'cache_bust'
      AND NOT attisdropped
  ) THEN
    EXECUTE 'ALTER TABLE analysis_call_usage ADD COLUMN cache_bust boolean NOT NULL DEFAULT false';
  END IF;
END
$$;

COMMENT ON COLUMN analysis_call_usage.cache_bust IS
  '이 콜이 프롬프트 캐시 무효화 태세(ANALYSIS_LLM_CACHE_BUST)에서 나갔는가. 게이트③ 무캐시 측정의 행 단위 근거.';

-- 게이트③ 판정용 집계. **기존 뷰를 고치지 않는다** — `CREATE OR REPLACE VIEW` 는 선행 컬럼을
-- 바꿀 수 없고, GROUP BY 축을 늘리려면 DROP 이 필요해 그 사이 운영 질의가 깨진다. 축이 새로
-- 생겼으면 뷰도 새로 만드는 쪽이 싸다.
CREATE OR REPLACE VIEW v_analysis_cache_bust_cost AS
SELECT
  u.cache_bust,
  u.task,
  u.pool_key,
  u.model_id,
  (u.started_at AT TIME ZONE 'UTC')::date                    AS day_utc,
  count(*)                                                   AS calls,
  count(*) FILTER (WHERE u.outcome = 'completed')            AS completed_calls,
  -- 커버리지: 0 이 아니면 아래 비용·토큰은 **하한**이다(0003 의 NULL = 미계측 규율).
  count(*) FILTER (WHERE u.cost_usd IS NULL)                 AS unmetered_calls,
  sum(u.input_tokens)                                        AS input_tokens,
  sum(u.output_tokens)                                       AS output_tokens,
  sum(u.cost_usd)                                            AS cost_usd,
  round(avg(u.latency_ms))                                   AS avg_latency_ms,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY u.latency_ms) AS p95_latency_ms
FROM analysis_call_usage u
GROUP BY u.cache_bust, u.task, u.pool_key, u.model_id, (u.started_at AT TIME ZONE 'UTC')::date;

COMMENT ON VIEW v_analysis_cache_bust_cost IS
  '무캐시 태세(cache_bust) 별 콜 실비·토큰·지연. 게이트③ 판정의 lane 쪽 입력 — 캐시 히트로 낮아진 '
  '입력 토큰·실비가 무캐시 구간과 섞이지 않게 축으로 갈라 둔다. ⚠️ unmetered_calls > 0 이면 cost_usd 는 하한이다.';

RESET lock_timeout;
