-- 0005 워커 게이지 원장 + 마감 스윕 부분 인덱스 정정 (골격 검증 F2·F3).
--
-- ── ① analysis_worker_gauges — **워커가 자기 in-flight 콜 수를 원장에 적는다**
--
--   `/v1/capacity` 의 `inflightCalls`·`workerCount` 가 **0 으로 위조되고 있었다**: api 는 워커의
--   세마포어를 볼 수 없는데 `deps.inflightCalls` 가 미배선이라 항상 0 을 냈고, CDK 의
--   `InflightCallsFilter` 는 게이지 로그에 **존재하지도 않는 필드**(`$.inflightCalls`)를 보고
--   있었다. 즉 "상한 대비 얼마나 쓰고 있나" 라는 램프(300 → 640)의 유일한 판정 입력이 통째로
--   비어 있었다.
--
--   경로로 HTTP(`POST /v1/workers/heartbeat`)가 아니라 **DB 테이블**을 고른 이유:
--     · 워커 SG 는 api 로 가는 인바운드 경로가 없다(인그레스는 NLB 8443 mTLS, 코어 전용).
--       HTTP 를 쓰려면 워커에 클라이언트 인증서를 주고 SG 를 뚫어야 한다 — 경계가 넓어진다.
--     · 워커는 이미 이 DB 에 붙어 있다. 새 표면이 0 이다.
--     · api 가 재기동해도 값이 안 사라진다(프로세스 메모리가 아니다).
--
--   ⚠️ **신선도가 정확성이다.** 보고가 끊긴 워커의 행을 그대로 더하면 죽은 함대의 in-flight 가
--      살아 있는 것처럼 보인다. 읽는 쪽이 `reported_at` 창으로 자르고, 창 밖 행은 **0 으로
--      대체하지 않고 "모름"으로 표면화**한다(`app/tickets.ts` workerGauges).
--   워커는 정상 종료 시 자기 행을 지운다 — 스케일인된 태스크가 영원히 stale 로 남지 않게.
--
-- ── ② analysis_tickets_deadline_sweep_all_idx — 0002 의 부분 인덱스가 술어와 안 맞았다
--
--   0002:44~50 의 부분 술어는 `status IN ('queued','deferred')` 인데 `expire_deadlines` 는
--   `status IN ('queued','deferred','leased','running')` 을 스윕한다. 플래너의 함의 증명은
--   **동일 표현식에 대해서만 확실하다**(0002 헤더가 인용한 측정 lane 0006 의 결론) — 술어가
--   넓으면 그 인덱스는 못 탄다. 리퍼는 원장 **전체**를 도는 쿼리라 이것이 곧 Seq Scan 이다.
--
--   고치는 방향을 **인덱스 추가**로 잡은 이유: 반대(쿼리를 queued/deferred 로 좁히기)는
--   마감이 지난 **leased/running 티켓을 리스 만료까지 방치**한다(최악 1,200s + 하트비트 연장).
--   마감 초과분은 지금 끊어야 LLM 실비가 안 나간다.
--
--   0002 의 인덱스는 남겨 둔다 — `reap_expired`(여집합 술어)가 그 자매 인덱스를 쓰고,
--   `DROP INDEX` 는 이 파일이 되돌릴 수 없는 변경이 된다(additive 만).
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS analysis_worker_gauges (
  worker_id      text PRIMARY KEY,
  -- **정본 단위 = in-flight LLM 콜**(스펙 §8.2). 유닛은 파생이다.
  inflight_calls int NOT NULL CHECK (inflight_calls >= 0),
  call_slots     int NOT NULL CHECK (call_slots >= 0),      -- 이 워커가 쥔 세마포어 상한
  leased_units   int NOT NULL CHECK (leased_units >= 0),    -- 이 워커가 처리 중인 티켓 수
  lane_revision  text,
  reported_at    timestamptz NOT NULL DEFAULT now()
);

-- 신선도 창 컷의 접근 경로(행 수는 함대 크기 = 최대 16 이지만 술어를 인덱스에 맞춰 둔다).
CREATE INDEX IF NOT EXISTS analysis_worker_gauges_fresh_idx ON analysis_worker_gauges (reported_at);

DO $$
BEGIN
  -- `expire_deadlines` 의 술어와 **글자 그대로** 같다. 바꿀 때는 둘을 함께 바꾼다.
  IF to_regclass('analysis_tickets_deadline_sweep_all_idx') IS NULL THEN
    EXECUTE $ddl$
      CREATE INDEX analysis_tickets_deadline_sweep_all_idx
        ON analysis_tickets (deadline_at)
        WHERE status IN ('queued','deferred','leased','running') AND failure_class IS DISTINCT FROM 'deadline'
    $ddl$;
  END IF;
END $$;

RESET lock_timeout;
