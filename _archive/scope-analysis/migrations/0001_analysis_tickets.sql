-- 0001 티켓 원장(분석 lane 정본). additive 변경만; 깨는 변경은 새 마이그레이션 번호로.
--
-- 골격은 측정 lane `migrations/0001_tickets.sql` 을 그대로 이식했다(스펙 §3.1 "동형으로 신설").
-- 다른 점 셋:
--   ① 좌표가 측정의 (queryRunId, iterationIndex) 가 아니라 **턴**이다 — 티켓 1건 = 턴 1건(D1).
--      turn_run_id·analysis_version 을 request jsonb 에서 파내지 않고 **컬럼으로 승격**한다:
--      중복 판정·꼬리 집계·관측이 전부 이 축이라 jsonb 경로 인덱스로 감당할 축이 아니다.
--   ② `terminal_reason` 컬럼이 처음부터 있다 — 측정은 2026-09-01 사고 뒤에 붙였다(그 전까지
--      모든 실패가 `ticket_failed:failed` 로 뭉개졌다). 같은 값을 두 번 치르지 않는다.
--   ③ 큐가 PG 이고 SQS 가 아니므로 **DLQ 라는 것이 없다.** 실패의 종착지는 티켓 행의 터미널
--      상태(`failed` + terminal_reason='cap_exhausted')이고 회복 대기는 `deferred` 다(스펙 §8.1).
--
-- ⚠️ **lane 은 exactly-once 의 주인이 아니다.** 그것은 코어 아웃박스 원장의
--    `UNIQUE (workspace_id, turn_run_id, analysis_version)` 이 맡는다(스펙 §7.1 가드 3겹 ①).
--    lane 쪽 가드는 `ticket_id` PK 멱등(③)뿐이고, 아래 (turn_run_id, analysis_version) 인덱스는
--    **UNIQUE 가 아니다** — 코어가 attempt 를 올려 재발행하면 같은 턴·같은 버전에 대해
--    **다른 ticket_id 의 새 티켓**이 정당하게 도착하기 때문이다.

CREATE TABLE IF NOT EXISTS analysis_tickets (
  ticket_id        uuid PRIMARY KEY,
  trace_id         uuid NOT NULL,
  status           text NOT NULL CHECK (status IN ('queued','leased','running','completed','deferred','failed','cancelled')),
  priority         text NOT NULL CHECK (priority IN ('manual','scheduled')),

  -- 좌표(컬럼 승격분). request jsonb 에도 같은 값이 들어 있지만 정본은 이 컬럼들이다.
  workspace_id     uuid NOT NULL,
  project_id       uuid NOT NULL,
  query_run_id     uuid NOT NULL,
  prompt_run_id    uuid,                      -- NULL = bare query_run (G9)
  turn_run_id      uuid NOT NULL,
  turn_index       int  NOT NULL CHECK (turn_index >= 1),
  analysis_version text NOT NULL,
  context_version  text NOT NULL,

  request          jsonb NOT NULL,
  deadline_at      timestamptz NOT NULL,
  callback_url     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  attempt_count    int  NOT NULL DEFAULT 0,
  failure_class    text,
  failure_reason   text,
  terminal_reason  text CHECK (terminal_reason IS NULL OR terminal_reason IN ('cap_exhausted','deadline_exceeded','permanent')),
  lease_token      uuid,
  leased_until     timestamptz,
  leased_by        text,
  -- 리스 누적 시간(초). lease TTL 은 1,200s 지만 하트비트로 무한 연장되면 포이즌 유닛 하나가
  -- 워커를 영원히 잡는다 — 누적 2,400s 를 넘으면 갱신을 멈춘다(스펙 §8.1).
  lease_elapsed_s  numeric(12,3) NOT NULL DEFAULT 0,
  reply            jsonb,
  finished_at      timestamptz
);

-- 픽 인덱스(측정 0001 과 같은 자리). 상태별 세부 부분 인덱스는 0002.
CREATE INDEX IF NOT EXISTS analysis_tickets_pull_idx ON analysis_tickets (status, next_eligible_at, priority, created_at);
CREATE INDEX IF NOT EXISTS analysis_tickets_lease_idx ON analysis_tickets (leased_until) WHERE status IN ('leased','running');

-- 중복 완주 감지·비용 가드의 접근 경로. **UNIQUE 아님**(위 ⚠️).
CREATE INDEX IF NOT EXISTS analysis_tickets_unit_idx ON analysis_tickets (turn_run_id, analysis_version, created_at DESC);
-- 꼬리 작업(그 query_run 의 턴이 전부 터미널인가)은 코어가 판정하지만, lane 쪽 관측·디버깅에도 필요하다.
CREATE INDEX IF NOT EXISTS analysis_tickets_run_idx ON analysis_tickets (query_run_id, status);

CREATE TABLE IF NOT EXISTS analysis_ticket_events (
  id          bigserial PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES analysis_tickets(ticket_id),
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS analysis_ticket_events_ticket_idx ON analysis_ticket_events (ticket_id, id);

-- 콜백 아웃박스: 답장은 트랜잭션 안에서 여기 적히고, 발송기가 따로 민다.
-- at-least-once — 코어는 ticketId 로 멱등하다. **본문은 doorbell 신호이고 권위 있는 본문은
-- 코어가 `GET /v1/analysis-tickets/{id}/reply` 로 되읽는다**(스펙 §7.3 ②).
-- 그래서 콜백에 서명이 없다는 사실(측정 `worker/callbacks.py:27` — 헤더가 X-Ticket-Id·
-- Content-Type 뿐)이 무해해진다.
CREATE TABLE IF NOT EXISTS analysis_callback_outbox (
  ticket_id    uuid PRIMARY KEY REFERENCES analysis_tickets(ticket_id),
  url          text NOT NULL,
  body         jsonb NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  next_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error   text,
  lease_token  uuid,
  leased_until timestamptz
);
CREATE INDEX IF NOT EXISTS analysis_callback_outbox_due_idx ON analysis_callback_outbox (next_at) WHERE delivered_at IS NULL;

-- 전역 스윕 클레임(측정 0006 승계). advisory try-lock 은 **동시성**만 막는다 — 각 워커의
-- 타이머가 기동 시점 기준이라 fleet 에서 엇갈리고, 리퍼 트랜잭션은 ~ms 라 엇갈린 틱이 전부
-- 완주했다(0.2s 차 2틱 실측). 이 한 행이 "마지막 스윕이 interval 안이면 skip" 을 락 안에서
-- 원자적으로 판정한다 → 전역 ≤1회/interval.
CREATE TABLE IF NOT EXISTS analysis_reaper_state (
  id            smallint PRIMARY KEY CHECK (id = 1),
  last_sweep_at timestamptz NOT NULL DEFAULT to_timestamp(0)
);
INSERT INTO analysis_reaper_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
