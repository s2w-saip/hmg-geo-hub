-- ============================================================================
-- 1회 채우기: ing.prompt.enabled(DB-v2.14 P84, Scope 코어 prompts.enabled) · 제품 결정 21 (2026-10-01)
-- **작성만, 실행은 제품 책임자 승인 배치에서**. 대상 = 새 DB(stg·prod). DB-v2.14 패치 뒤, 적재 틱(게이트 backfill) 전에 돈다(패치 머리말 절차 ③).
--
-- 왜: 적재기 pull 은 프롬프트를 증분(updated_from)으로 받으므로, 패치 전에 이미 받아 둔 ing.prompt 행은 enabled 가 NULL(모름 = 활성 취급)로
--   남는다. 코어에서 꺼 둔 프롬프트(예: Kia worldwide 37·Kia US 3, notes/hgh-impl/kia40-unmeasured-20261001.md)가 활성 유닛에 남으면
--   발행 게이트가 그 사이트를 매 회차 보류한다. 이 스크립트가 코어 값으로 한 번 맞춘다. 이후 변경은 pull 이 따라간다(코어 enabled 토글은
--   updated_at 을 올린다: Scope lib/prompts/store.ts updatePromptsBulk, 운영 스크립트 disable_kiaww_prompts.py 도 updated_at = now()).
-- 입력: 1단계 back/migration/prompt-enabled-core-export.sql 의 CSV(헤더 prompt_id,project_id,enabled)를 stdin 으로.
-- 무엇을: CSV 에 있는 프롬프트 중 ing.prompt 에 있고 값이 다른 행만 enabled 를 코어 값으로 바꾼다. CSV 에 없는 ing.prompt 행은 건드리지 않는다
--   (코어에서 삭제됐거나 이번 내보내기 범위 밖: NULL 유지 = 기존 동작). rd 는 바꾸지 않는다(결과 캐시 무효화 불필요).
-- 멱등: 값이 다른 행만 쓴다(두 번째 실행 = 0행). 쓰기는 트랜잭션 1개, 예상 행수와 실제 UPDATE 행수가 다르면 롤백.
-- 롤: migrator 또는 loader(ing UPDATE).
--
-- 사용(드라이런이 기본: 개수만 출력, 쓰기 없음. 접속 URL 은 env 로만):
--   psql -X -v ON_ERROR_STOP=1 -f fill-prompt-enabled.sql < prompt-enabled.csv
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -f fill-prompt-enabled.sql < prompt-enabled.csv
-- 출력 = 개수만(프롬프트 id·본문 없음).
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
SET statement_timeout = '5min';
SET lock_timeout = '30s';

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'ing.prompt'::regclass AND attname = 'enabled' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.14 이 먼저 적용돼야 한다(ing.prompt.enabled 없음)';
  END IF;
END $v$;

DROP TABLE IF EXISTS pg_temp._pe;
CREATE TEMP TABLE _pe (prompt_id uuid PRIMARY KEY, project_id uuid NOT NULL, enabled bool NOT NULL);
\copy _pe (prompt_id, project_id, enabled) FROM pstdin WITH (FORMAT csv, HEADER true)
ANALYZE _pe;

SELECT (SELECT count(*) FROM _pe) AS csv_rows,
       (SELECT count(*) FROM _pe WHERE NOT enabled) AS csv_disabled,
       (SELECT count(*) FROM _pe s JOIN ing.prompt p ON p.scope_prompt_id = s.prompt_id) AS matched,
       (SELECT count(*) FROM _pe s WHERE NOT EXISTS (SELECT 1 FROM ing.prompt p WHERE p.scope_prompt_id = s.prompt_id)) AS not_in_hub,
       (SELECT count(*) FROM _pe s JOIN ing.prompt p ON p.scope_prompt_id = s.prompt_id WHERE p.scope_project_id <> s.project_id) AS project_mismatch,
       (SELECT count(*) FROM _pe s JOIN ing.prompt p ON p.scope_prompt_id = s.prompt_id WHERE p.enabled IS DISTINCT FROM s.enabled) AS to_update,
       (SELECT count(*) FROM _pe s JOIN ing.prompt p ON p.scope_prompt_id = s.prompt_id WHERE p.enabled IS DISTINCT FROM s.enabled AND NOT s.enabled)
         AS to_disable;

\if :commit
BEGIN;
DO $f$
DECLARE
  want bigint := (SELECT count(*) FROM _pe s JOIN ing.prompt p ON p.scope_prompt_id = s.prompt_id WHERE p.enabled IS DISTINCT FROM s.enabled);
  got bigint;
BEGIN
  UPDATE ing.prompt p SET enabled = s.enabled FROM _pe s WHERE p.scope_prompt_id = s.prompt_id AND p.enabled IS DISTINCT FROM s.enabled;
  GET DIAGNOSTICS got = ROW_COUNT;
  IF got <> want THEN RAISE EXCEPTION 'UPDATE 행수 % ≠ 예상 %(롤백)', got, want; END IF;
  IF EXISTS (SELECT 1 FROM _pe s JOIN ing.prompt p ON p.scope_prompt_id = s.prompt_id WHERE p.enabled IS DISTINCT FROM s.enabled) THEN
    RAISE EXCEPTION '채운 뒤에도 코어와 다른 행이 남았다(롤백)';
  END IF;
  RAISE NOTICE 'ing.prompt.enabled 채움 %행', got;
END $f$;
COMMIT;
\endif
