-- 성능저하 재발 대응 인덱스 4종 (RCA: workspace (내부 설계 문서))
--
-- ⚠️ IF NOT EXISTS 는 no-op 이어도 ACCESS EXCLUSIVE 락을 먼저 잡는다(실측: 797초 대기).
--    프로덕션에는 CREATE INDEX CONCURRENTLY 로 선적용하고, 이 파일은 카탈로그를
--    먼저 확인하는 DO 블록으로 "이미 있으면 락 없이 통과"하게 둔다.

-- ① 스냅샷 DISTINCT ON (prompt_id, target, region) ORDER BY measured_at DESC
--    → 정렬 제거. 07-22 감사가 권장했으나 미실행이던 것.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'scope_answers_snapshot_idx') THEN
    CREATE INDEX scope_answers_snapshot_idx
      ON public.scope_answers (prompt_id, target, region, measured_at DESC)
      WHERE status = 'completed';
  END IF;
END $$;

-- ② 측정 시간창 seek. 기존 scope_answers_prompt_lens_idx 는 선두가 target 이라
--    measured_at 단독 조건에서 인덱스 전체를 훑는다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'scope_answers_measured_at_idx') THEN
    CREATE INDEX scope_answers_measured_at_idx
      ON public.scope_answers (measured_at DESC)
      WHERE status = 'completed';
  END IF;
END $$;

-- ③ ROLLUP_NAMES CTE(브랜드 표기 정본 990건)가 scope_mentions 193만행을
--    Seq Scan + external merge sort(Disk 25.5MB) 하던 것을 인덱스 스캔으로.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'scope_mentions_rollup_names_idx') THEN
    CREATE INDEX scope_mentions_rollup_names_idx
      ON public.scope_mentions (entity_type, entity_id, brand)
      WHERE brand IS NOT NULL;
  END IF;
END $$;

-- ④ 인용 집계는 전부 lower(c.domain) 로 조회하는데 기존 인덱스는 (domain) 이라
--    함수 적용으로 무력화됐다(실측: nested loop 32,146회·4.5s).
--    데이터는 이미 전량 소문자(domain <> lower(domain) = 0/2,385,891행)지만,
--    판정 불변을 위해 코드를 건드리지 않고 표현식 인덱스로 살린다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'scope_citations_lower_domain_idx') THEN
    CREATE INDEX scope_citations_lower_domain_idx
      ON public.scope_citations ((lower(domain)), job_id);
  END IF;
END $$;
