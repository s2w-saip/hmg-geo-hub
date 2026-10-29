-- 0006 `project_id` NOT NULL 해제 — 코어 계약이 **nullable** 이기 때문이다.
--
-- ── 왜 필요한가 (2026-09-13 계약 재동기)
--
--   코어 정본 `AnalysisLineageSchema.projectId` 는 `z.guid().nullable().default(null)` 이고,
--   발행부는 bare query_run(프로젝트에 매이지 않은 측정)에서 `null` 을 싣는다
--   (코어 `analysis-ticket-submitter.ts:470` `projectId ?? "unscoped"`). 계약만 넓히고 컬럼을
--   그대로 두면 스키마는 통과한 티켓이 **INSERT 에서 NOT NULL 위반**으로 죽는다 — 그때 API 는
--   400 이 아니라 **500** 을 내고, 코어 클라이언트는 5xx 를 transient 로 보고 같은 티켓을
--   영원히 재시도한다(`client.ts:45` `isTransientAnalysisTicketError`). 계약 수정과 **한 벌**이다.
--
--   같은 이유로 `analysis_contexts.project_id` 도 푼다: 그 값은 `contextVersion` 접두사에서
--   파생되는데 bare 경로에서는 접두사가 `unscoped` 라 uuid 가 아니다(코어 `context-snapshot.ts:100`).
--   lane 은 이제 uuid 일 때만 값을 넣고 아니면 NULL 을 넣는다
--   (`contracts/v1.ts` `parseContextVersionProjectId`). 초판은 `'unscoped'` 를 uuid 컬럼에
--   넣으려다 캐시 적재가 매번 실패했을 것이다 — 그 실패는 삼켜지므로(적중률만 떨어진다)
--   **조용한** 성능 퇴행이다.
--
-- ── 락
--
--   `ALTER TABLE … DROP NOT NULL` 은 카탈로그 변경이라 **테이블 스캔이 없다**(제약 추가와 다르다).
--   그래도 `ACCESS EXCLUSIVE` 는 잡으므로 `lock_timeout` 을 건다 — 워커가 도는 중에 배포하면
--   리스 UPDATE 와 부딪힐 수 있고, 그때는 배포가 죽는 편이 낫다(무한 대기로 큐를 세우지 않는다).
--
--   ⚠️ **`IF EXISTS` 류로 조건 없이 돌리지 않는다** — no-op 이어도 락을 먼저 잡는다
--   (workspace 룰: PG 마이그레이션 락 함정). 카탈로그를 먼저 보고 필요할 때만 ALTER 한다.
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'analysis_tickets' AND column_name = 'project_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE analysis_tickets ALTER COLUMN project_id DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'analysis_contexts' AND column_name = 'project_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE analysis_contexts ALTER COLUMN project_id DROP NOT NULL;
  END IF;
END $$;
