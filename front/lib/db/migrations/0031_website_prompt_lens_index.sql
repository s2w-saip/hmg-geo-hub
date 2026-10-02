-- 웹사이트 프롬프트 조회(/website/prompts) 측정 렌즈 인덱스 (2026-07-16)
--
-- 왜: 프롬프트 목록의 "측정 횟수 / 최근 측정일" 컬럼은 선택한 엔진·기간 범위로
-- scope_answers 를 프롬프트 단위 집계해 만든다(측정 렌즈 — 행을 거르지 않고
-- 컬럼 값의 계산 범위만 정한다). 질의 형태는 항상:
--   WHERE status='completed' AND target IN (?) AND measured_at >= ? AND measured_at < ?
--   GROUP BY prompt_id
-- 이 집계는 정렬 가능한 컬럼이라 페이지 단위로 좁힐 수 없고(측정일 정렬 = 전체
-- 집계 후 정렬), 매 조회마다 전 구간을 훑는다.
--
-- 문제: 기존 scope_answers_target_idx 로는 target 매칭 행의 힙을 전부 읽는다.
-- scope_answers 는 answer_text(본문)를 품어 행이 넓다 — 124k행이 힙 블록 14,238개라
-- 한 페이지 여는 데 실측 1,175ms(Bitmap Heap Scan 684ms, Rows Removed by Filter 94,557).
--
-- 해결: 집계가 읽는 세 컬럼(target·measured_at·prompt_id)을 모두 인덱스에 담아
-- 힙을 건너뛴다(Index Only Scan). status='completed' 부분 인덱스라 실패 런은
-- 인덱스에 들어가지도 않는다 — 앱의 다른 집계와 같은 'completed' 만 세는 규약.
-- 실측: 1,175ms → 44.6ms (동일 질의, 9,569행 × chatgpt × 07-01~07-13).
--
-- 컬럼 순서: 등치(target) → 범위(measured_at) → 집계 키(prompt_id). 선두 두 컬럼이
-- WHERE 를 인덱스 순회로 처리하고 prompt_id 는 힙 회피용 payload 다. prompt_id 를
-- 앞에 두면 target/measured_at 을 인덱스로 좁히지 못해 의미가 없다.
--
-- 적용: npm run db:apply -- 0031
-- 이 리포는 0020부터 수동 SQL 관리라 drizzle 저널 밖이며, 파일은 idempotent 여야 한다.

CREATE INDEX IF NOT EXISTS "scope_answers_prompt_lens_idx"
  ON "scope_answers" ("target", "measured_at", "prompt_id")
  WHERE "status" = 'completed';
