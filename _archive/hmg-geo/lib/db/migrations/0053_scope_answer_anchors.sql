-- 0053: 회차 앵커 레지스트리 — measured_at 접기를 재싱크가 소비하는 입력으로 승격.
-- 적용: npm run db:apply -- 0053   (운영자 실행. drizzle-kit migrate 금지)
--
-- ── 왜 ────────────────────────────────────────────────────────────────────────
-- 미러의 `scope_answers.measured_at` 은 벽시계 완료 시각이 아니라 **소속 회차의
-- 앵커 날짜**를 가리킨다(시각 보존). 정본 = (내부 설계 문서)
-- hmg-website-measured-at-anchor-normalization-2026-08-25.md §3.
--
-- 그 접기를 지금까지는 **미러 행 위의 일회성 UPDATE** 로만 했다. 그래서
-- `scope_mirror.ts::replaceRun`(run 단위 delete + insert)이 그 run 을 다시 훑는
-- 순간 scope 원본 measured_at 으로 덮이며 접기가 소멸한다. 2026-08-31 04:12Z 의
-- 회수 재싱크(force 아님 — **정규 경로**)가 8/25 접기 중 **18,890행**을 되돌렸고,
-- website 주간 추이에 7/20 주(42사이트 547건)·7/27 캠페인 분절이 되살아났다(§9).
-- 두 번째 재발이므로 대증요법(다시 접기)을 반복하지 않고 저장 구조를 바꾼다.
--
-- 설계: 접힌 답변 하나 = 이 테이블의 한 행. `replaceRun` 은 answers 삽입 직후
-- **같은 트랜잭션 안에서** 이 레지스트리를 재적용한다. 이후 몇 번을 재싱크해도
-- measured_at 은 앵커로 수렴한다(멱등).
--
-- additive-only: 신규 테이블 1개 + 신규 함수 1개. 기존 테이블 ALTER 없음
-- (0007 prod 장애 교훈). `_bak_anchor_fold` 는 **지우지 않는다** — 8/25·09-01
-- 접기의 원본 measured_at 정본이자 이 시드의 출처다(§5.1 가역성).

-- 락 대기 상한. 이 파일은 전부 신규 객체라 기존 테이블 락을 잡지 않지만,
-- 시드가 `_bak_anchor_fold` 를 읽는 동안 걸릴 수 있는 대기를 짧게 끊는다.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "scope_answer_anchors" (
  "job_id" uuid PRIMARY KEY,
  -- 이 답변이 속한 회차의 앵커 날짜(UTC 기준).
  "anchor" date NOT NULL,
  -- 접기 직전의 scope 원본 measured_at. 원복 근거 — 앵커 모델을 폐기해도
  -- 이 값이 있으면 되돌릴 수 있다.
  "source_measured_at" timestamp with time zone,
  "folded_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- 어느 접기 배치가 등록했는지(감사용).
  "reason" text
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "scope_answer_anchors_anchor_idx" ON "scope_answer_anchors" ("anchor");--> statement-breakpoint

-- ⚠️ LOCKDOWN COVERAGE (0033·0042·0043 선례와 동일): 신규 테이블은 lockdown.sql
-- 재실행 전까지 anon/authenticated 가드가 없다. 적용 후 확인:
--   SELECT has_table_privilege('anon','public.scope_answer_anchors','SELECT');  -- expect false
REVOKE ALL ON "scope_answer_anchors" FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- 접기 산술의 **정본**. 날짜부만 앵커로 옮기고 시각은 보존한다.
-- 소비처: ① scope-mirror.ts::anchorReapplySql (재싱크 재적용)
--        ② 새 회차 접기 SQL (아래 "새 회차를 접을 때" 절차)
-- TS 로 한 벌 더 계산하지 않는다 — 0052 의 citation_url_norm 과 같은 이유로,
-- 정의가 두 벌이 되면 같은 답변이 경로마다 다른 날짜를 받는다.
--
-- STABLE(IMMUTABLE 아님): `timestamptz AT TIME ZONE text` 는 PG 에서 STABLE 이다
-- (존 정의는 런타임 tzdata 에 의존). 이 함수는 인덱스식으로 쓰지 않으므로 무해하다.
--
-- 검산(2026-09-03, 프로덕션 읽기 전용 — _bak_anchor_fold 156,689행 전수):
--   접은 결과의 UTC 날짜 ≠ 앵커 인 행 0 · UTC 시각이 원본과 다른 행 0.
CREATE OR REPLACE FUNCTION scope_anchor_fold(ts timestamptz, anchor date)
RETURNS timestamptz
LANGUAGE sql STABLE PARALLEL SAFE STRICT AS $fn$
  SELECT ts - (((ts AT TIME ZONE 'UTC')::date - anchor) * INTERVAL '1 day')
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION scope_anchor_fold(timestamptz, date) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- ── 시드: `_bak_anchor_fold` → 레지스트리 ─────────────────────────────────────
-- 백업 테이블은 "접혀서 **움직인** 행"만 담는다(원래 앵커 날짜였던 행은 없다).
-- 레지스트리도 같은 집합이면 충분하다 — 안 움직인 행은 scope 원본이 이미
-- 앵커 날짜라 재적용 술어가 잡지 않는다.
--
-- anchor_eff = 8/25 과병합 롤백 반영. gap≤2 클러스터링이 8/19 소규모 측정일과
-- 8/21 정규 회차를 한 회차로 붙여 4,938+366 건을 8/19 로 백데이트했고, 그것은
-- 롤백됐다(§4). 백업 테이블에는 **롤백 전 값(anchor=8/19)** 이 남아 있으므로
-- 그대로 시드하면 그 사고를 되살린다. 실측(2026-09-03): anchor=8/19 인 5,304행은
-- **전부** 원본이 8/21 이후라 규칙 적용 후 8/19 로 남는 행이 0 이다.
--
-- ON CONFLICT DO NOTHING = 재실행 안전. 이미 등록된 job 의 앵커는 **덮지 않는다** —
-- 나중 회차 접기가 등록한 값이 낡은 백업으로 되돌아가면 안 된다.
--
-- 기대 rowcount (2026-09-03 프로덕션 읽기 전용 실측): 156,689
--   (= _bak_anchor_fold 전량 · job_id 중복 0 · 전부 scope_answers 에 존재)
DO $do$
BEGIN
  IF to_regclass('public._bak_anchor_fold') IS NULL THEN
    RAISE NOTICE '_bak_anchor_fold 없음 — 시드 건너뜀 (개발 DB 정상 경로)';
    RETURN;
  END IF;
  INSERT INTO scope_answer_anchors (job_id, anchor, source_measured_at, reason)
  SELECT b.job_id,
         CASE WHEN b.anchor = DATE '2026-08-19'
                   AND (b.measured_at AT TIME ZONE 'UTC')::date >= DATE '2026-08-21'
              THEN DATE '2026-08-21' ELSE b.anchor END,
         b.measured_at,
         'seed:_bak_anchor_fold(2026-08-25,2026-09-01) +0819rollback'
    FROM _bak_anchor_fold b
   WHERE b.job_id IS NOT NULL AND b.anchor IS NOT NULL
  ON CONFLICT (job_id) DO NOTHING;
END
$do$;

-- ── 적용 후 검증 (읽기) ───────────────────────────────────────────────────────
--   -- 1) 시드 행수·앵커 분포 (8/19 가 0 이어야 한다)
--   SELECT anchor, count(*) FROM scope_answer_anchors GROUP BY 1 ORDER BY 1;
--   -- 2) 앵커에서 벗어난 행 = 0 이어야 한다 (재싱크 직후에도)
--   SELECT count(*) FROM scope_answer_anchors r JOIN scope_answers a USING (job_id)
--    WHERE a.measured_at IS NOT NULL
--      AND (a.measured_at AT TIME ZONE 'UTC')::date IS DISTINCT FROM r.anchor;
--   -- 3) 원복이 가능한가 (source_measured_at 보존)
--   SELECT count(*) FROM scope_answer_anchors WHERE source_measured_at IS NULL;
--
-- ── 새 회차를 접을 때 (지금은 수동 — 자동화는 후속) ──────────────────────────
-- 접기 UPDATE 를 직접 쓰지 말고 **레지스트리에 등록한 뒤 재적용**한다.
-- 그래야 다음 재싱크가 다시 풀지 않는다.
--
--   INSERT INTO scope_answer_anchors (job_id, anchor, source_measured_at, reason)
--   SELECT a.job_id, DATE '<앵커>', a.measured_at, 'fold:<YYYY-MM-DD> <사유>'
--     FROM scope_answers a
--    WHERE <회차 조건>
--   ON CONFLICT (job_id) DO NOTHING;
--
--   UPDATE scope_answers a SET measured_at = scope_anchor_fold(a.measured_at, r.anchor)
--     FROM scope_answer_anchors r
--    WHERE a.job_id = r.job_id
--      AND a.measured_at IS NOT NULL
--      AND (a.measured_at AT TIME ZONE 'UTC')::date IS DISTINCT FROM r.anchor;
--
-- 앵커 산정 규칙(§7.1): 클러스터 경계 = **측정 공백**(gap≤2 는 8/25 과병합의
-- 직접 원인이라 폐기), 앵커 = 클러스터 내 **최다 측정일**, 양쪽이 둘 다 회차급
-- 규모면 병합 금지.
