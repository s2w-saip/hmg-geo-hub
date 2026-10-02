-- 프로젝트 프롬프트 라벨링 통폐합 — 프레임워크 축 → 커스텀 필드 이관 (WBS 4.1.5, 2026-07-23)
--
-- 배경: `prompts`에는 3사 framework 축(list_type/depth1~4/funnel_stage/brand_presence)이
-- 있으나, 이는 표준 root 카탈로그(project_id = STANDARD_ROOT_PROJECT_ID)를 위한 것이고
-- scope-aggregates가 표준 대시보드에서 읽는다. 고객 프로젝트 프롬프트 UI/Excel에서는
-- 이 축을 없애고 프로젝트별 커스텀 필드(project_custom_fields)로 통일한다.
--
-- 이 마이그레이션은 컬럼을 삭제하지 않는다(표준이 읽으므로 보존). 대신 비-root 프로젝트가
-- 이미 넣어둔 프레임워크 값을 커스텀 필드로 "복사"해 프로젝트가 새 방식으로 계속 관리하게 한다.
-- 감사(2026-07-23): 비-root에서 값이 있는 프로젝트는 CCI GEO PoC(list_type/depth1/funnel_stage),
-- 현대 GEO 모니터링(funnel_stage)뿐. depth4는 전량 null, brand_presence는 고객 프로젝트 미사용.
--
-- 멱등: ON CONFLICT DO NOTHING (project_custom_fields는 (project_id,label) unique,
-- prompt_custom_field_values는 (prompt_id,field_id) PK). 재실행 안전.
--
-- root id는 standards.ts의 기본값을 하드코딩. env로 override한 환경이면 그 프로젝트가
-- 표준 root이므로 아래 제외 대상을 맞춰야 한다(기본 환경은 이 값이 정본).

DO $$
DECLARE
  root_id uuid := '26751906-c175-485c-9e69-29fc68d0fdbb';
  axis    record;
BEGIN
  FOR axis IN
    SELECT * FROM (VALUES
      ('list_type',    '목록 유형'),
      ('depth1',       '분류 1'),
      ('depth2',       '분류 2'),
      ('depth3',       '분류 3'),
      ('funnel_stage', '퍼널 단계')
    ) AS t(col, label)
  LOOP
    -- 1) 값이 있는 비-root 프로젝트마다 커스텀 필드 생성
    EXECUTE format($f$
      INSERT INTO project_custom_fields (project_id, label, created_by)
      SELECT DISTINCT p.project_id, %L, pr.created_by
      FROM prompts p
      JOIN projects pr ON pr.id = p.project_id
      WHERE p.project_id <> %L
        AND nullif(p.%I, '') IS NOT NULL
      ON CONFLICT (project_id, label) DO NOTHING
    $f$, axis.label, root_id, axis.col);

    -- 2) 각 프롬프트의 프레임워크 값을 해당 커스텀 필드 값으로 복사
    EXECUTE format($f$
      INSERT INTO prompt_custom_field_values (prompt_id, field_id, value)
      SELECT p.id, f.id, p.%I
      FROM prompts p
      JOIN project_custom_fields f
        ON f.project_id = p.project_id AND f.label = %L
      WHERE p.project_id <> %L
        AND nullif(p.%I, '') IS NOT NULL
      ON CONFLICT (prompt_id, field_id) DO NOTHING
    $f$, axis.col, axis.label, root_id, axis.col);
  END LOOP;
END $$;
