-- ============================================================================
-- hmg-geo 재설계 DB-v2.17 보완 패치 (PostgreSQL 17, 2026-10-01) · 엔티티 직접 관리·버전 반영 E0(데이터 모델, 제품 결정 26~29)
-- 적용 순서: DB-v2.16(WU-7 웹 보고서 유닛, P91~P93) 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.17.sql = DB-v2.16.sql + 이 파일.
--   (2026-10-01 메인 결정: 엔티티 관리 패치는 WU-7 다음 번호로 밀렸다. 옛 엔티티 관리 DB-v2.16 P91~P101 = 이 패치 P94~P104)
-- 근거: notes/hgh-impl/hmg-entity-management-versioning-design-20261001.md 2절(데이터 모델)·8절 E0, a4-decisions-batch.md 26~29.
--
-- 추가형: 기존 열·값·권한·함수 불변. 기존 표에 대한 변경은 아래 넷뿐이다(전부 넓히기·열 추가, 표 재작성·검증 스캔 없음).
--   rd.answer ADD COLUMN ecat_ver int2 NOT NULL DEFAULT 1   (상수 기본값 = 메타데이터만, 기존 행은 1 로 읽힌다. 적재기는 이 열을 몰라도 1 이 들어간다)
--   rd.cycle  ADD COLUMN ecat_ver int2                        (NULL = 미노출 회차 = 활성 버전을 따른다)
--   app.judgment_change kind CHECK 에 'entity_version' 추가(DROP → ADD, DB-v2.1 P01 과 같은 방식) + payload CHECK 1개(새 kind 에만 작동)
--   app.entity_registry·app.entity_alias 에 문장 트리거 1개씩(호환 계층 쓰기 가드, 아래 P98)
--
-- P94 app.ecat_version  허브 카탈로그 버전(초안·활성·보관·폐기). 활성 1개·초안 1개(부분 유일 색인), 활성·보관·폐기 버전은 내용 불변.
--     활성 전이는 app.ecat_activate() 한 경로뿐(트리거가 hmg_owner = SECURITY DEFINER 안에서만 허용).
-- P95 app.ecat_entity   버전별 엔티티 덮어쓰기 전체 스냅샷(PK (ver, entity_id)). 역할 = own(자사, brand_code 필수)·competitor(기본)·
--     hidden(숨김: 순위·목록·경쟁사 선정에서만 뺌, KPI 불변 = 현행 excluded)·removed(제거: 딸린 언급까지 빠져 KPI 가 바뀜, 투영은 E1).
--     merge_into(A → B 접기, 자기 자신·체인 금지), parent_brand_id(브랜드 롤업 덮어쓰기). 쓰기는 초안 버전에만(트리거).
-- P96 app.ecat_surface_def(불변 표면 정의, entity_id NULL = 전역 차단) · app.ecat_surface(버전이 켜는 표면, add|block, 초안에만 쓰기).
-- P97 app.ecat_apply     반영 이벤트 원장(KPI 안정화 설계의 ing.correction 과 한 표, kind 로 원천 구분). 범위 unexposed|from_round|all,
--     상태 전이 트리거, 동시 실행 1건(부분 유일 색인 ecat_apply_one_running = ECAT_APPLY_RUNNING), 삭제 금지.
--     app.ecat_review    검토 대기함(Scope 가 새로 찾은 엔티티·기존 엔티티의 새 표면). 적재기가 쌓고 관리자가 처리한다(제품 결정 28).
-- P98 호환 계층: 기존 app.entity_registry·app.entity_alias 는 "활성 버전의 물질화 투영"이 된다(표 그대로, 읽는 쪽 무변경).
--     app.ecat_registry_rows(ver)·app.ecat_alias_rows(ver) = 버전의 기존 모양 행(hidden → 'excluded', own·hidden 행만 / merge_into 행만),
--     뷰 app.ecat_registry_active·app.ecat_alias_active = 활성 버전의 그 행. app.ecat_project_legacy() 가 차이만 기존 표에 반영하고
--     md5 동치를 단언한다. 가드 트리거: 활성 버전이 있으면 기존 표 직접 쓰기(관리 PUT·시드·TRUNCATE)를 거부한다(ECAT_LEGACY_WRITE).
--     활성 버전이 없는 동안(= v1 이관 전)은 현 동작 그대로다(시드·픽스처·관리 PUT 전부 통과).
--     뷰로 바꾸지 않은 이유: 기존 쓰기 경로가 TRUNCATE(fixture-00·seed-10), INSERT … ON CONFLICT(관리 PUT), SELECT … FOR UPDATE 를 쓴다.
--     표를 뷰로 바꾸면 이름 변경(기존 표 ALTER)과 INSTEAD OF 트리거가 필요하고, TRUNCATE 와 ON CONFLICT 는 INSTEAD OF 뷰에서 동작하지
--     않는다. 물질화 투영은 읽는 SQL(적재 _alias_map·REGISTRY_ROLE_REFRESH·rule_set 지문·관리 GET)을 한 줄도 바꾸지 않는다.
-- P99 app.ecat_activate(ver)  초안 → 활성(직전 활성 → retired, content_md5, 기존 표 투영). rd 재투영은 하지 않는다(E1·E5).
--     app.ecat_cutover_v1(actor, reason)  현행 명부(entity_registry own·excluded) ∪ 별칭(entity_alias) → v1(origin cutover, ver = 1)
--     이관 + 활성화. excluded 는 hidden 으로 옮긴다(현행 의미 유지). 이관 전후 기존 표 md5 불변·행 수를 단언한다.
--     실행 스크립트 = back/migration/ecat-v1-cutover.sql(드라이런 기본). ⚠ 실행 순간부터 기존 관리 PUT(/v1/admin/entities)이 거부된다:
--     E6(초안 편집 API) 배포와 같은 창에서 실행한다(설계 6절 T0).
--     app.ecat_content_md5(ver)  버전 내용 지문(엔티티·표면, 메모·수정자 제외).
-- P100 원천 보조: ing.hub_match(추가 표면이 저장 본문에서 찾은 결과, 월 파티션, 버전 무관) · ing.hub_match_scan(표면별 스캔 진행)
--     rd.ensure_hub_match_leaf(month) = ing.hub_match 월 leaf 헬퍼(적재기·이관 호출. rd.ensure_month_leaf 는 바꾸지 않는다).
-- P101 rd 투영 층: rd.answer.ecat_ver(그 답변의 언급 계열 열·자식 행이 계산된 버전, 조회에 안 씀), rd.cycle.ecat_ver(노출 전이 때 고정한
--     기준 버전, NULL = 미노출), judgment_change kind 'entity_version'(payload {apply_id, op}).
-- P102 app.ecat_audit_log  관리 API(E6) 감사 원장(append-only). 편집·반영 요청·승인·거절·재개·되돌리기·대기함 처리를 같은 쓰기 트랜잭션에서
--     한 행씩 남긴다(쓰기가 롤백되면 감사 행도 없다 = 누락·유령 0). actor_id 기본값 app.actor()(행위자 GUC 없으면 거부).
--     app.access_audit_log 를 쓰지 않는 이유: kind 가 조회 계열(data_access 등)로 닫혀 있고, 배치 비동기(Q4 유실 허용)라 "감사 누락 0" 이 안 된다.
-- P103 ing.surface_seen·ing.review_fill_state·ing.answer(first_seen_at) 색인: 검토 대기함(E8) 새 표면 판정을 PK 조회로(대형 엔티티 전수
--     정규화 스캔 제거), 판정 창 워터마크(판정 불가면 전진 안 함 = 다음 실행이 같은 창을 다시 판정).
-- P104 rd.v_entity_mention_surface  Scope 관측 표면(ing.mention.surfaces) 을 엔티티별로 여는 문서형 뷰(loader_ro 소유, api_ro·admin_long SELECT).
--     린트(E6)가 새 전역 차단 표면을 자사(추적) 엔티티와 자사 브랜드로 롤업되는 엔티티(예 제품 'Creta')의 관측 표면 변형과 대조한다(검증 N4).
--     열 = entity_id·run_month·surface·brand_rollup_entity_id(Scope 롤업)·display_name(접두 교정 J1 입력). 규약: run_month 하한 + (entity_id 또는
--     brand_rollup_entity_id 등치(ANY) 또는 3사 접두 표기 후보(display_name ILIKE 접두)) 전용(코드 리뷰 가드). 접두 교정 판정 함수
--     app.ecat_hmg_prefix_id = seed pg_temp.hmg_prefix_id 의 영구 사본(동치 시험 고정). security_barrier 라도 uuid_eq·date_ge 는 leakproof 라 술어가 ing.mention 까지
--     내려가 mention_entity_idx·mention_rollup_idx(BitmapOr)와 월 파티션 가지치기를 쓴다.
--
-- 계약(E1·E2·E4·E5·E6·E8 이 쓰는 이름):
--   읽기   app.ecat_version(status='active') · app.ecat_entity · app.ecat_surface ⋈ app.ecat_surface_def · 뷰 app.ecat_registry_active·
--          app.ecat_alias_active · 함수 app.ecat_registry_rows(ver)·app.ecat_alias_rows(ver)·app.ecat_content_md5(ver)
--   쓰기   E6: ecat_version(초안 INSERT·UPDATE·폐기)·ecat_entity·ecat_surface·ecat_surface_def(INSERT)·ecat_apply(요청·승인)·ecat_review(처리)
--              ·ecat_audit_log(INSERT, P102)
--          E1·E5(loader): app.ecat_activate(ver) · ecat_apply 진행 열 · rd.answer.ecat_ver · rd.cycle.ecat_ver
--          E2(loader): ing.hub_match·ing.hub_match_scan · rd.ensure_hub_match_leaf(month)
--          E8(loader): ecat_review INSERT·수 갱신·alerted_at · ing.surface_seen·ing.review_fill_state(P103)
--   에러   유일 색인 ecat_version_one_draft → ECAT_DRAFT_EXISTS(409), ecat_apply_one_running → ECAT_APPLY_RUNNING(409),
--          예외 문구 접두 'ECAT_LEGACY_WRITE'·'ECAT_IMMUTABLE'·'ECAT_MERGE_CHAIN'·'ECAT_APPLY_TRANSITION'·'ECAT_CUTOVER_DONE'
--
-- 락: rd.answer·rd.cycle(파티션 전부)·app.judgment_change·app.entity_registry·app.entity_alias 에 ACCESS EXCLUSIVE 또는 SHARE ROW EXCLUSIVE 를
--   잠깐 잡는다. judgment_change kind CHECK 재부착은 표를 한 번 훑는다(소형). lock_timeout 30s: 긴 읽기 트랜잭션이 잡고 있으면 실패하고
--   아무것도 바뀌지 않는다(재시도). 적용 창에는 API·데우기·적재를 멈춘다(v2.15 와 같다).
-- 적용 절차(stg·prod): ① 이 패치(migrator 또는 superuser) ② (T0 에만) psql -f back/migration/ecat-v1-cutover.sql -v actor=<uuid>(드라이런)
--   → -v commit=1. ②는 E6 배포와 같은 창. 배포 순서 제약: ①은 지금 코드와 무관하게 적용 가능(새 객체를 읽는 코드가 아직 없다).
-- 결과 캐시: 새 표는 추적 표가 아니다(조회 경로가 읽지 않는다: 활성 버전은 적재 투영으로만 rd 에 닿는다). 기존 표 투영이 바꾸는 것은
--   app.entity_registry·entity_alias(추적 표 아님)뿐이고, rd 반영(dim_entity.registry_role·사실 행)은 E5 반영 흐름이 세대를 올린다.
-- 규약: D8(사전 집계 없음) 준수. 새 btree 는 제자리 UPDATE 대상 열을 포함하지 않는다(HOT 유지).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('rd.web_report_prompt') IS NULL OR to_regclass('app.website_report_unit') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.16(WU-7 웹 보고서 유닛) 이 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('app.ecat_version') IS NOT NULL OR to_regclass('ing.hub_match') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('rd.answer'::regclass, 'rd.cycle'::regclass) AND attname = 'ecat_ver' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.17 이미 적용됨(app.ecat_version·ing.hub_match·rd.answer.ecat_ver 중 하나 존재)';
  END IF;
END $v$;

-- ── P94 ─────────────────────────────────────────────────────────────────────
CREATE TABLE app.ecat_version (
  ver int4 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired','discarded')),
  based_on int4 REFERENCES app.ecat_version,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  reason text,
  origin text NOT NULL DEFAULT 'admin' CHECK (origin IN ('cutover','admin','rollback')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz, activated_at timestamptz, retired_at timestamptz,
  content_md5 bytea, lint jsonb,
  CONSTRAINT ecat_version_active_stamp CHECK (status NOT IN ('active','retired') OR (activated_at IS NOT NULL AND content_md5 IS NOT NULL)),
  CONSTRAINT ecat_version_retired_stamp CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT ecat_version_md5_len CHECK (content_md5 IS NULL OR length(content_md5) = 16));
CREATE UNIQUE INDEX ecat_version_one_active ON app.ecat_version ((true)) WHERE status = 'active';
CREATE UNIQUE INDEX ecat_version_one_draft  ON app.ecat_version ((true)) WHERE status = 'draft';     -- 제품 결정 29: 초안 1개
COMMENT ON TABLE app.ecat_version IS
  '허브 카탈로그 버전(엔티티 오버레이 전체 스냅샷). 활성 1·초안 1, 활성·보관·폐기 내용 불변, 활성 전이 = app.ecat_activate 만. DB-v2.17 P94';
COMMENT ON COLUMN app.ecat_version.lint IS
  '마지막 린트 결과 = app.core.ecat LintReport.as_json() 모양(E3). L2 확인 체크 키 = Finding.key(code|target). 린트 설정 = app.rule_param 키 ecat_lint '
  '{short_ascii_allowlist, generic_words{lang: [...]}, tracked_entity_ids}(테넌트 값, 이 패치는 넣지 않는다). DB-v2.17 P94';

-- ── P95 ─────────────────────────────────────────────────────────────────────
CREATE TABLE app.ecat_entity (
  ver int4 NOT NULL REFERENCES app.ecat_version ON DELETE CASCADE,
  entity_id uuid NOT NULL,
  origin text NOT NULL DEFAULT 'scope' CHECK (origin IN ('scope','hub')),
  name text, entity_type text,
  role text NOT NULL DEFAULT 'competitor' CHECK (role IN ('own','competitor','hidden','removed')),
  brand_code text REFERENCES app.brand,
  merge_into uuid, parent_brand_id uuid, note text,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ver, entity_id),
  CONSTRAINT ecat_entity_own_brand CHECK (role <> 'own' OR brand_code IS NOT NULL),
  CONSTRAINT ecat_entity_named CHECK (role NOT IN ('own','hidden') OR name IS NOT NULL),     -- 기존 명부 모양(name NOT NULL)으로 투영된다
  CONSTRAINT ecat_entity_merge_self CHECK (merge_into IS DISTINCT FROM entity_id),
  CONSTRAINT ecat_entity_parent_self CHECK (parent_brand_id IS DISTINCT FROM entity_id));
CREATE INDEX ecat_entity_merge_idx ON app.ecat_entity (ver, merge_into) WHERE merge_into IS NOT NULL;
COMMENT ON TABLE app.ecat_entity IS
  '버전별 엔티티 덮어쓰기(행 없음 = Scope 값·기본 경쟁). role hidden = 숨김(현행 excluded, KPI 불변), removed = 제거(딸린 언급까지, KPI 변경). DB-v2.17 P95';
COMMENT ON COLUMN app.ecat_entity.role IS
  'own(자사, brand_code 필수) · competitor(기본) · hidden(순위·목록·경쟁사 선정에서만 뺌, KPI 불변, 기존 명부에는 excluded 로 투영) · removed(언급·스탠스·ACR 행 제거, 투영 E1)';

-- ── P96 ─────────────────────────────────────────────────────────────────────
CREATE TABLE app.ecat_surface_def (
  surface_id int4 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id uuid,                                            -- NULL = 전역 차단 표면
  surface text NOT NULL CHECK (length(btrim(surface)) > 0),
  surface_norm text NOT NULL CHECK (length(surface_norm) > 0),
  lang text,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ecat_surface_def_uniq UNIQUE NULLS NOT DISTINCT (entity_id, surface_norm, lang));
COMMENT ON TABLE app.ecat_surface_def IS
  '표면 정의(불변). surface_norm = 파이썬 app.core.ecat.text.normalize_surface 값(DB 함수로 따로 계산하지 않는다). entity_id NULL = 전역 차단 표면. DB-v2.17 P96';
CREATE TABLE app.ecat_surface (
  ver int4 NOT NULL REFERENCES app.ecat_version ON DELETE CASCADE,
  surface_id int4 NOT NULL REFERENCES app.ecat_surface_def,
  action text NOT NULL CHECK (action IN ('add','block')),
  PRIMARY KEY (ver, surface_id));
COMMENT ON TABLE app.ecat_surface IS '버전이 켜는 표면. add = 저장 본문 재매칭(엔티티 필수), block = 차단(엔티티 한정 또는 전역). DB-v2.17 P96';

-- ── P97 ─────────────────────────────────────────────────────────────────────
CREATE TABLE app.ecat_apply (
  apply_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL DEFAULT 'entity_version' CHECK (kind IN ('entity_version','scope_retro','late','operator')),
  ver int4 REFERENCES app.ecat_version, from_ver int4 REFERENCES app.ecat_version,
  scope_kind text NOT NULL CHECK (scope_kind IN ('unexposed','from_round','all')),
  from_round_date date,
  cycle_keys int4[], affected_answers int, preview jsonb, preview_set_md5 bytea,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','previewed','approved','running','applied','rejected','failed','rolled_back')),
  requested_by uuid NOT NULL, approved_by uuid, reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, started_at timestamptz, finished_at timestamptz,
  load_id bigint, error text,
  CONSTRAINT ecat_apply_ver_kind CHECK (kind <> 'entity_version' OR ver IS NOT NULL),
  CONSTRAINT ecat_apply_from_round CHECK ((scope_kind = 'from_round') = (from_round_date IS NOT NULL)),
  CONSTRAINT ecat_apply_approved CHECK (status NOT IN ('approved','running','applied','failed','rolled_back')
                                        OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT ecat_apply_started CHECK (status NOT IN ('running','applied','failed','rolled_back') OR started_at IS NOT NULL),
  CONSTRAINT ecat_apply_finished CHECK (status NOT IN ('applied','rolled_back') OR finished_at IS NOT NULL),
  CONSTRAINT ecat_apply_md5_len CHECK (preview_set_md5 IS NULL OR length(preview_set_md5) = 16));
CREATE UNIQUE INDEX ecat_apply_one_running ON app.ecat_apply ((true)) WHERE status = 'running';     -- 동시 반영 금지
CREATE INDEX ecat_apply_ver_idx ON app.ecat_apply (ver, apply_id);
COMMENT ON TABLE app.ecat_apply IS
  '반영 이벤트 원장(엔티티 버전·Scope 소급·지각·운영 정정 공용, kind). 범위 unexposed|from_round|all, 노출 회차 포함은 승인 필요(E6). 삭제 금지. DB-v2.17 P97';

CREATE TABLE app.ecat_review (
  review_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('new_entity','new_surface')),
  entity_id uuid NOT NULL, surface text, surface_norm text,
  display_name text, entity_type text,
  first_load_id bigint, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  n_mentions bigint NOT NULL DEFAULT 0, n_answers bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','dismissed')),
  resolved_ver int4 REFERENCES app.ecat_version, decided_by uuid, decided_at timestamptz, note text,
  alerted_at timestamptz, alert_grade int2 CHECK (alert_grade IS NULL OR alert_grade IN (0,1,2)),
  CONSTRAINT ecat_review_uniq UNIQUE NULLS NOT DISTINCT (kind, entity_id, surface_norm),
  CONSTRAINT ecat_review_surface CHECK ((kind = 'new_surface') = (surface_norm IS NOT NULL)),
  CONSTRAINT ecat_review_decided CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)));
CREATE INDEX ecat_review_pending_idx ON app.ecat_review (kind, last_seen_at DESC) WHERE status = 'pending';
COMMENT ON TABLE app.ecat_review IS
  '검토 대기함: Scope 가 새로 찾은 엔티티(경쟁 기본으로 즉시 반영됨)·기존 엔티티의 새 표면. 적재기가 쌓고(E8) 관리자가 다음 버전에서 처리(E6). DB-v2.17 P97';

-- ── P100 ─────────────────────────────────────────────────────────────────────
CREATE TABLE ing.hub_match (
  surface_id int4 NOT NULL REFERENCES app.ecat_surface_def,
  run_month date NOT NULL, job_id uuid NOT NULL, turn_index int2 NOT NULL,
  entity_id uuid NOT NULL,
  n_occ int2 NOT NULL CHECK (n_occ > 0),
  first_start int NOT NULL CHECK (first_start >= 0),
  starts int[] NOT NULL,
  ends int[] NOT NULL,                                       -- 원문 길이가 표면 길이와 다를 수 있어(정규화) 겹침 판정에 끝 위치가 필요하다
  answer_hash bytea NOT NULL,                                -- 스캔 당시 ing.answer.content_hash
  load_id bigint NOT NULL,
  CONSTRAINT hub_match_occ_arrays CHECK (cardinality(starts) = n_occ AND cardinality(ends) = n_occ),
  PRIMARY KEY (surface_id, run_month, job_id, turn_index)) PARTITION BY RANGE (run_month);
COMMENT ON TABLE ing.hub_match IS
  '추가 표면(app.ecat_surface_def)이 저장 본문에서 찾은 결과. 버전 무관(버전은 어느 surface_id 를 켤지만 정한다). 쓰기 = 적재기 재스캔(E2). '
  '행 = 매처 SurfaceScan(surface_id, entity_id, starts, ends) 한 건(스캔 단위 = (job, turn) 본문 하나, 본문 없는 ACR 1턴 제외). '
  'starts·ends = 원문 코드포인트 오프셋, 끝 배타(PostgreSQL substr 좌표), n_occ = 원소 수, first_start = 매처 값 그대로. DB-v2.17 P100';
CREATE TABLE ing.hub_match_scan (
  surface_id int4 PRIMARY KEY REFERENCES app.ecat_surface_def,
  scanned_to_load_id bigint, answers_scanned bigint NOT NULL DEFAULT 0, hits bigint NOT NULL DEFAULT 0,
  scanned_at timestamptz NOT NULL DEFAULT now());
COMMENT ON TABLE ing.hub_match_scan IS '추가 표면 스캔 진행(어느 load 까지 훑었는지). 적재 훅이 새 답변만 이어 스캔한다(E2). DB-v2.17 P100';

-- ── P103 검토 대기함 새 표면 판정 원장(E8 review_fill) ────────────────────────
-- ing.surface_seen: 이미 관측된 (엔티티, 정규형 표면). 새 표면 판정 = 이 표의 PK 조회(엔티티의 과거 언급 전수를 정규화해 훑지 않는다).
--   정규형 = seed-3x-common §10 pg_temp.ecat_norm 과 같은 식(감시가 인라인). 첫 가동 기준선은 감시가 월별로 채우고(재개 가능),
--   이후 판정한 창의 표면을 같은 트랜잭션에서 더한다(판정이 실패하면 함께 롤백 = 다음 실행이 같은 창을 다시 판정).
-- ing.review_fill_state: 1행. judged_to = 판정이 끝난 답변 first_seen_at 상한(창 = (judged_to, 지금]), 기준선 진행, 연속 판정 불가 수.
-- ing.answer(first_seen_at) 색인: 감시 창 답변만 읽는다(그 열은 적재 뒤 바뀌지 않아 HOT 를 깨지 않는다).
CREATE TABLE ing.surface_seen (
  entity_id uuid NOT NULL, surface_norm text NOT NULL,
  first_seen_at timestamptz NOT NULL, first_load_id bigint,
  PRIMARY KEY (entity_id, surface_norm));
COMMENT ON TABLE ing.surface_seen IS
  '검토 대기함 새 표면 판정 원장: 관측된 (엔티티, 정규형 표면). 쓰기 = 감시 review_fill(기준선·판정 창). DB-v2.17 P103';
CREATE TABLE ing.review_fill_state (
  id bool PRIMARY KEY DEFAULT true CHECK (id),
  judged_to timestamptz, judged_load_id bigint, carry_load_ids bigint[] NOT NULL DEFAULT '{}', baseline_to timestamptz, baseline_cursor date, baseline_done bool NOT NULL DEFAULT false,
  fail_count int NOT NULL DEFAULT 0, last_error text, last_fail_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
COMMENT ON TABLE ing.review_fill_state IS
  '검토 대기함 채우기 진행(1행): 판정 끝 커밋 경계(judged_load_id = 이 load 이하가 쓴 답변은 판정됨, 실패 시 전진 안 함)·시각(judged_to, 보고용)·이월 적재(carry_load_ids: 워터마크가 넘어간 24시간 넘은 running 적재, 커밋되면 따로 판정)·기준선 진행·연속 판정 불가 수. DB-v2.17 P103';
CREATE INDEX answer_first_seen_idx ON ing.answer (first_seen_at);

CREATE FUNCTION rd.ensure_hub_match_leaf(p_month date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE lo date := date_trunc('month', p_month)::date; hi date := (date_trunc('month', p_month) + interval '1 month')::date;
        leaf text := 'hub_match_' || to_char(date_trunc('month', p_month), 'YYYYMM');
BEGIN
  IF to_regclass('ing.' || leaf) IS NULL THEN                -- 카탈로그 선확인(IF NOT EXISTS 는 락을 먼저 잡는다)
    EXECUTE format('CREATE TABLE ing.%I PARTITION OF ing.hub_match FOR VALUES FROM (%L) TO (%L)', leaf, lo, hi);
  END IF;
END $f$;
COMMENT ON FUNCTION rd.ensure_hub_match_leaf(date) IS 'ing.hub_match 월 leaf 선생성(적재기·이관). DB-v2.17 P100';

-- ── P101 ─────────────────────────────────────────────────────────────────────
ALTER TABLE rd.answer ADD COLUMN ecat_ver int2 NOT NULL DEFAULT 1;
COMMENT ON COLUMN rd.answer.ecat_ver IS
  '이 답변의 언급 계열 열·자식 행(answer_brand·answer_stance)이 계산된 app.ecat_version.ver. 조회에 안 씀(적재·감사·반영 대상 선정). DB-v2.17 P101';
ALTER TABLE rd.cycle ADD COLUMN ecat_ver int2;
COMMENT ON COLUMN rd.cycle.ecat_ver IS '노출 전이 때 고정한 기준 엔티티 버전. NULL = 미노출 회차(활성 버전을 따른다). DB-v2.17 P101';

ALTER TABLE app.judgment_change DROP CONSTRAINT judgment_change_kind_check;
ALTER TABLE app.judgment_change ADD CONSTRAINT judgment_change_kind_check CHECK (kind IN (
    'catalog','prompt_kind','entity','brand_rule','competitor_token','hidden_market','citation_override','owned_base',
    'website_catalog','project_setting','project_owned_base','project_target_url','rule_param','scope_prompt',
    'cycle_admin','anchor_pin','answer_drop','report_publication',
    'dfs_fetch','ga4_property','ga4_tracked_event',
    'entity_version'));
ALTER TABLE app.judgment_change ADD CONSTRAINT judgment_change_entity_version_payload
  CHECK (kind <> 'entity_version' OR coalesce(payload ? 'apply_id' AND payload ? 'op', false));

-- ── 불변·상태 전이 트리거 ────────────────────────────────────────────────────
-- 버전 행: 초안만 자유 편집(폐기 포함). 활성·보관 전이는 hmg_owner(= app.ecat_activate 안)만. 활성 → 보관 외에는 내용 불변.
CREATE FUNCTION app.tg_ecat_version_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'ECAT_IMMUTABLE: 버전 % (%) 삭제 불가(초안만 삭제)', OLD.ver, OLD.status; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND current_user <> 'hmg_owner' THEN
      RAISE EXCEPTION 'ECAT_IMMUTABLE: 새 버전은 초안으로만 만든다(활성화 = app.ecat_activate)';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.ver <> OLD.ver THEN RAISE EXCEPTION 'ECAT_IMMUTABLE: ver 변경 불가'; END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status IN ('active','retired') AND current_user <> 'hmg_owner' THEN
      RAISE EXCEPTION 'ECAT_IMMUTABLE: 활성화는 app.ecat_activate 로만';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'retired' AND current_user = 'hmg_owner'
     AND (to_jsonb(NEW) - 'status' - 'retired_at') = (to_jsonb(OLD) - 'status' - 'retired_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ECAT_IMMUTABLE: 버전 % (%) 는 바꿀 수 없다', OLD.ver, OLD.status;
END $f$;
CREATE TRIGGER ecat_version_guard BEFORE INSERT OR UPDATE OR DELETE ON app.ecat_version
  FOR EACH ROW EXECUTE FUNCTION app.tg_ecat_version_guard();

-- 버전 내용 행(엔티티·표면): 소속 버전이 초안일 때만 쓰기. 초안 삭제의 CASCADE 는 부모가 이미 없어서 통과한다.
CREATE FUNCTION app.tg_ecat_draft_only() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE v int4 := CASE WHEN TG_OP = 'DELETE' THEN OLD.ver ELSE NEW.ver END; st text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.ver <> OLD.ver THEN RAISE EXCEPTION 'ECAT_IMMUTABLE: % 행의 ver 변경 불가', TG_TABLE_NAME; END IF;
  SELECT status INTO st FROM app.ecat_version WHERE ver = v;
  IF st IS NULL AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'ECAT_IMMUTABLE: 버전 % (%) 의 % 는 바꿀 수 없다(초안만 편집)', v, coalesce(st, '없음'), TG_TABLE_NAME;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $f$;
CREATE TRIGGER ecat_entity_draft_only BEFORE INSERT OR UPDATE OR DELETE ON app.ecat_entity
  FOR EACH ROW EXECUTE FUNCTION app.tg_ecat_draft_only();
CREATE TRIGGER ecat_surface_draft_only BEFORE INSERT OR UPDATE OR DELETE ON app.ecat_surface
  FOR EACH ROW EXECUTE FUNCTION app.tg_ecat_draft_only();

-- 병합 체인 금지: 병합 원본의 대상이 다시 병합 원본이거나, 병합 원본을 누가 대상으로 삼으면 거부(순서 무관, 같은 버전 안).
CREATE FUNCTION app.tg_ecat_merge_check() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.merge_into IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM app.ecat_entity e WHERE e.ver = NEW.ver AND e.entity_id = NEW.merge_into AND e.merge_into IS NOT NULL) THEN
      RAISE EXCEPTION 'ECAT_MERGE_CHAIN: % → % 의 대상이 다시 병합 원본이다(버전 %)', NEW.entity_id, NEW.merge_into, NEW.ver;
    END IF;
    IF EXISTS (SELECT 1 FROM app.ecat_entity e WHERE e.ver = NEW.ver AND e.merge_into = NEW.entity_id) THEN
      RAISE EXCEPTION 'ECAT_MERGE_CHAIN: % 를 대상으로 삼는 병합이 있어 % 는 병합 원본이 될 수 없다(버전 %)', NEW.entity_id, NEW.entity_id, NEW.ver;
    END IF;
  END IF;
  RETURN NULL;
END $f$;
CREATE TRIGGER ecat_entity_merge_check AFTER INSERT OR UPDATE OF merge_into, entity_id ON app.ecat_entity
  FOR EACH ROW EXECUTE FUNCTION app.tg_ecat_merge_check();

-- 표면: add 는 엔티티 한정 정의만. 정의는 불변.
CREATE FUNCTION app.tg_ecat_surface_check() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.action = 'add' AND (SELECT d.entity_id FROM app.ecat_surface_def d WHERE d.surface_id = NEW.surface_id) IS NULL THEN
    RAISE EXCEPTION 'ECAT_SURFACE_ADD_GLOBAL: 표면 % 는 전역 정의라 add 할 수 없다(block 만)', NEW.surface_id;
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER ecat_surface_check BEFORE INSERT OR UPDATE ON app.ecat_surface
  FOR EACH ROW EXECUTE FUNCTION app.tg_ecat_surface_check();
CREATE TRIGGER ecat_surface_def_ao BEFORE UPDATE OR DELETE ON app.ecat_surface_def
  FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();

-- 반영 원장 상태 전이. 같은 상태 안의 진행 열 갱신은 허용(running 중 load_id·affected_answers 등). 요청 열은 초안에서만 바뀐다.
CREATE FUNCTION app.tg_ecat_apply_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ECAT_IMMUTABLE: 반영 원장은 삭제하지 않는다(rejected 로 닫는다)'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'ECAT_APPLY_TRANSITION: 새 반영은 draft 로만'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.apply_id <> OLD.apply_id THEN RAISE EXCEPTION 'ECAT_IMMUTABLE: apply_id 변경 불가'; END IF;
  IF OLD.status IN ('rejected','rolled_back') THEN
    RAISE EXCEPTION 'ECAT_APPLY_TRANSITION: 반영 % 는 닫혔다(%)', OLD.apply_id, OLD.status;
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('draft','previewed'), ('draft','rejected'),
       ('previewed','approved'), ('previewed','rejected'), ('previewed','draft'),
       ('approved','running'), ('approved','previewed'), ('approved','rejected'),
       ('running','applied'), ('running','failed'),
       ('failed','running'), ('failed','rejected'),
       ('applied','rolled_back')) THEN
    RAISE EXCEPTION 'ECAT_APPLY_TRANSITION: % → % 불가(반영 %)', OLD.status, NEW.status, OLD.apply_id;
  END IF;
  IF OLD.status <> 'draft'
     AND (NEW.kind, NEW.ver, NEW.from_ver, NEW.scope_kind, NEW.from_round_date, NEW.requested_by, NEW.reason, NEW.requested_at)
         IS DISTINCT FROM (OLD.kind, OLD.ver, OLD.from_ver, OLD.scope_kind, OLD.from_round_date, OLD.requested_by, OLD.reason, OLD.requested_at) THEN
    RAISE EXCEPTION 'ECAT_IMMUTABLE: 반영 % 의 요청 열(버전·범위·사유·요청자)은 draft 에서만 바뀐다', OLD.apply_id;
  END IF;
  IF OLD.status = 'applied' AND (to_jsonb(NEW) - 'status' - 'finished_at' - 'error') <> (to_jsonb(OLD) - 'status' - 'finished_at' - 'error') THEN
    RAISE EXCEPTION 'ECAT_IMMUTABLE: 적용된 반영 % 는 되돌림 표시만 가능', OLD.apply_id;
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER ecat_apply_guard BEFORE INSERT OR UPDATE OR DELETE ON app.ecat_apply
  FOR EACH ROW EXECUTE FUNCTION app.tg_ecat_apply_guard();

-- ── P98 호환 계층 ────────────────────────────────────────────────────────────
CREATE FUNCTION app.ecat_registry_rows(p_ver int4)
RETURNS TABLE (entity_id uuid, name text, role text, brand_code text, updated_by uuid, updated_at timestamptz)
LANGUAGE sql STABLE AS $f$
  SELECT e.entity_id, e.name, CASE e.role WHEN 'hidden' THEN 'excluded' ELSE e.role END, e.brand_code, e.updated_by, e.updated_at
    FROM app.ecat_entity e WHERE e.ver = p_ver AND e.role IN ('own','hidden')
$f$;
COMMENT ON FUNCTION app.ecat_registry_rows(int4) IS
  '버전의 기존 app.entity_registry 모양 행(own·hidden 만, hidden → excluded). competitor = 행 없음(현행 파생 기본값), removed = 행 없음(E1 이 언급을 뺀다). DB-v2.17 P98';
CREATE FUNCTION app.ecat_alias_rows(p_ver int4) RETURNS TABLE (alias_entity_id uuid, canon_entity_id uuid)
LANGUAGE sql STABLE AS $f$
  SELECT e.entity_id, e.merge_into FROM app.ecat_entity e WHERE e.ver = p_ver AND e.merge_into IS NOT NULL
$f$;
COMMENT ON FUNCTION app.ecat_alias_rows(int4) IS '버전의 기존 app.entity_alias 모양 행(merge_into 가 있는 엔티티). DB-v2.17 P98';
CREATE VIEW app.ecat_registry_active AS
  SELECT r.* FROM app.ecat_version v CROSS JOIN LATERAL app.ecat_registry_rows(v.ver) r WHERE v.status = 'active';
CREATE VIEW app.ecat_alias_active AS
  SELECT r.* FROM app.ecat_version v CROSS JOIN LATERAL app.ecat_alias_rows(v.ver) r WHERE v.status = 'active';
COMMENT ON VIEW app.ecat_registry_active IS '활성 버전의 명부 모양 행 = 투영 뒤 app.entity_registry 와 행 단위 같다(md5 단언). DB-v2.17 P98';
COMMENT ON VIEW app.ecat_alias_active IS '활성 버전의 별칭 모양 행 = 투영 뒤 app.entity_alias 와 행 단위 같다(md5 단언). DB-v2.17 P98';

-- 표 지문(정렬 고정, 모든 열). rule_set 지문(seed-10·fixture-00)과 같은 방식에 updated_* 를 더한 것.
CREATE FUNCTION app.ecat_legacy_md5() RETURNS TABLE (registry_md5 text, alias_md5 text, registry_rows bigint, alias_rows bigint)
LANGUAGE sql STABLE AS $f$
  SELECT (SELECT md5(coalesce(string_agg(concat_ws('|', entity_id, name, role, brand_code, updated_by, updated_at), E'\n' ORDER BY entity_id), ''))
            FROM app.entity_registry),
         (SELECT md5(coalesce(string_agg(concat_ws('|', alias_entity_id, canon_entity_id), E'\n' ORDER BY alias_entity_id), '')) FROM app.entity_alias),
         (SELECT count(*) FROM app.entity_registry), (SELECT count(*) FROM app.entity_alias)
$f$;
CREATE FUNCTION app.ecat_active_md5() RETURNS TABLE (registry_md5 text, alias_md5 text, registry_rows bigint, alias_rows bigint)
LANGUAGE sql STABLE AS $f$
  SELECT (SELECT md5(coalesce(string_agg(concat_ws('|', entity_id, name, role, brand_code, updated_by, updated_at), E'\n' ORDER BY entity_id), ''))
            FROM app.ecat_registry_active),
         (SELECT md5(coalesce(string_agg(concat_ws('|', alias_entity_id, canon_entity_id), E'\n' ORDER BY alias_entity_id), '')) FROM app.ecat_alias_active),
         (SELECT count(*) FROM app.ecat_registry_active), (SELECT count(*) FROM app.ecat_alias_active)
$f$;

-- 기존 표 쓰기 가드: 활성 버전이 있으면 app.ecat_project_legacy(hmg_owner + 투영 표시) 밖의 쓰기를 거부한다.
CREATE FUNCTION app.tg_ecat_legacy_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM app.ecat_version WHERE status = 'active')
     AND NOT (current_user = 'hmg_owner' AND current_setting('app.ecat_projecting', true) = 'on') THEN
    RAISE EXCEPTION 'ECAT_LEGACY_WRITE: % 는 활성 엔티티 버전의 투영이다. 편집은 초안(app.ecat_entity)으로 하고 반영으로 바꾼다', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END $f$;
CREATE TRIGGER ecat_legacy_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON app.entity_registry
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_ecat_legacy_guard();
CREATE TRIGGER ecat_legacy_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON app.entity_alias
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_ecat_legacy_guard();

-- 활성 버전 → 기존 표(차이만). 반환 = 바뀐 행 수(삭제 + 삽입 + 갱신). 끝에 md5 동치 단언.
CREATE FUNCTION app.ecat_project_legacy() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE n int := 0; k int; a record; l record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.ecat_version WHERE status = 'active') THEN
    RAISE EXCEPTION 'ecat_project_legacy: 활성 버전이 없다';
  END IF;
  PERFORM set_config('app.ecat_projecting', 'on', true);
  DELETE FROM app.entity_registry r WHERE NOT EXISTS (SELECT 1 FROM app.ecat_registry_active x WHERE x.entity_id = r.entity_id);
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  INSERT INTO app.entity_registry AS r (entity_id, name, role, brand_code, updated_by, updated_at)
  SELECT x.entity_id, x.name, x.role, x.brand_code, x.updated_by, x.updated_at FROM app.ecat_registry_active x
  ON CONFLICT (entity_id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, brand_code = EXCLUDED.brand_code,
    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
   WHERE (r.name, r.role, r.brand_code, r.updated_by, r.updated_at)
         IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.role, EXCLUDED.brand_code, EXCLUDED.updated_by, EXCLUDED.updated_at);
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM app.entity_alias r WHERE NOT EXISTS (SELECT 1 FROM app.ecat_alias_active x WHERE x.alias_entity_id = r.alias_entity_id);
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  INSERT INTO app.entity_alias AS r (alias_entity_id, canon_entity_id)
  SELECT x.alias_entity_id, x.canon_entity_id FROM app.ecat_alias_active x
  ON CONFLICT (alias_entity_id) DO UPDATE SET canon_entity_id = EXCLUDED.canon_entity_id WHERE r.canon_entity_id IS DISTINCT FROM EXCLUDED.canon_entity_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  PERFORM set_config('app.ecat_projecting', '', true);
  SELECT * INTO a FROM app.ecat_active_md5();
  SELECT * INTO l FROM app.ecat_legacy_md5();
  IF (a.registry_md5, a.alias_md5, a.registry_rows, a.alias_rows) IS DISTINCT FROM (l.registry_md5, l.alias_md5, l.registry_rows, l.alias_rows) THEN
    RAISE EXCEPTION 'ecat_project_legacy: 투영 뒤 기존 표와 활성 버전이 다르다(명부 % / %, 별칭 % / %)',
      l.registry_rows, a.registry_rows, l.alias_rows, a.alias_rows;
  END IF;
  RETURN n;
END $f$;
COMMENT ON FUNCTION app.ecat_project_legacy() IS
  '활성 버전 → app.entity_registry·entity_alias 차이만 반영(가드 통과 표시), 끝에 md5·행 수 동치 단언. 반환 = 바뀐 행 수. DB-v2.17 P98';

-- ── P99 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.ecat_content_md5(p_ver int4) RETURNS bytea LANGUAGE sql STABLE AS $f$
  SELECT decode(md5(
    coalesce((SELECT string_agg(concat_ws('|', e.entity_id, e.origin, e.name, e.entity_type, e.role, e.brand_code, e.merge_into, e.parent_brand_id),
                                E'\n' ORDER BY e.entity_id) FROM app.ecat_entity e WHERE e.ver = p_ver), '')
    || E'\n#\n' ||
    coalesce((SELECT string_agg(concat_ws('|', s.surface_id, s.action, d.entity_id, d.surface_norm, d.lang), E'\n' ORDER BY s.surface_id)
                FROM app.ecat_surface s JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id WHERE s.ver = p_ver), '')), 'hex')
$f$;
COMMENT ON FUNCTION app.ecat_content_md5(int4) IS '버전 내용 지문(엔티티 의미 열 + 켠 표면. 메모·수정자·시각 제외). DB-v2.17 P99';

CREATE FUNCTION app.ecat_activate(p_ver int4) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM app.ecat_version WHERE ver = p_ver FOR UPDATE;
  IF st IS NULL THEN RAISE EXCEPTION 'ecat_activate: 버전 % 없음', p_ver; END IF;
  IF st <> 'draft' THEN RAISE EXCEPTION 'ecat_activate: 버전 % 는 초안이 아니다(%)', p_ver, st; END IF;
  UPDATE app.ecat_version SET status = 'retired', retired_at = now() WHERE status = 'active';
  UPDATE app.ecat_version SET status = 'active', activated_at = now(), content_md5 = app.ecat_content_md5(p_ver) WHERE ver = p_ver;
  RETURN app.ecat_project_legacy();
END $f$;
COMMENT ON FUNCTION app.ecat_activate(int4) IS
  '초안 → 활성(직전 활성 → retired, content_md5 기록, 기존 명부·별칭 표 투영). 반환 = 기존 표에서 바뀐 행 수. rd 재투영은 하지 않는다(E5). DB-v2.17 P99';

CREATE FUNCTION app.ecat_cutover_v1(p_actor uuid, p_reason text DEFAULT 'T0 운영 명부 이관')
RETURNS TABLE (ver int4, registry_rows bigint, alias_rows bigint, entity_rows bigint, overlap_rows bigint,
               own_rows bigint, hidden_rows bigint, legacy_changed int, registry_md5 text, alias_md5 text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
#variable_conflict use_column
DECLARE b record; a record; n int; ne bigint; nov bigint;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'ecat_cutover_v1: 행위자 필수'; END IF;
  IF EXISTS (SELECT 1 FROM app.ecat_version) THEN
    RAISE EXCEPTION 'ECAT_CUTOVER_DONE: 이미 엔티티 버전이 있다(v1 이관은 한 번만)';
  END IF;
  LOCK TABLE app.entity_registry, app.entity_alias IN SHARE ROW EXCLUSIVE MODE;   -- 이관 중 기존 표 쓰기 차단(읽기는 허용)
  SELECT * INTO b FROM app.ecat_legacy_md5();
  INSERT INTO app.ecat_version (ver, status, title, reason, origin, created_by) OVERRIDING SYSTEM VALUE
  VALUES (1, 'draft', 'v1 운영 명부 이관', p_reason, 'cutover', p_actor);
  PERFORM setval(pg_get_serial_sequence('app.ecat_version', 'ver'), 1, true);   -- 드라이런이 번호를 소비했어도 v1 = 1, 다음 = 2
  INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, updated_by, updated_at)
  SELECT 1, coalesce(r.entity_id, al.alias_entity_id), 'scope', coalesce(r.name, d.rep_name), d.entity_type,
         CASE r.role WHEN 'own' THEN 'own' WHEN 'excluded' THEN 'hidden' ELSE 'competitor' END,
         r.brand_code, al.canon_entity_id, r.updated_by, coalesce(r.updated_at, now())
    FROM app.entity_registry r
    FULL JOIN app.entity_alias al ON al.alias_entity_id = r.entity_id
    LEFT JOIN rd.dim_entity d ON d.entity_id = coalesce(r.entity_id, al.alias_entity_id);
  GET DIAGNOSTICS ne = ROW_COUNT;
  SELECT count(*) INTO nov FROM app.entity_registry r JOIN app.entity_alias al ON al.alias_entity_id = r.entity_id;
  n := app.ecat_activate(1);
  SELECT * INTO a FROM app.ecat_legacy_md5();
  IF n <> 0 OR (a.registry_md5, a.alias_md5, a.registry_rows, a.alias_rows) IS DISTINCT FROM (b.registry_md5, b.alias_md5, b.registry_rows, b.alias_rows)
     OR ne <> b.registry_rows + b.alias_rows - nov THEN
    RAISE EXCEPTION 'ecat_cutover_v1: 이관 전후 불일치(바뀐 행 %, 명부 % → %, 별칭 % → %, 엔티티 % ≠ % + % − %)',
      n, b.registry_rows, a.registry_rows, b.alias_rows, a.alias_rows, ne, b.registry_rows, b.alias_rows, nov;
  END IF;
  RETURN QUERY SELECT 1, b.registry_rows, b.alias_rows, ne, nov,
    (SELECT count(*) FROM app.ecat_entity e WHERE e.ver = 1 AND e.role = 'own'),
    (SELECT count(*) FROM app.ecat_entity e WHERE e.ver = 1 AND e.role = 'hidden'), n, b.registry_md5, b.alias_md5;
END $f$;
COMMENT ON FUNCTION app.ecat_cutover_v1(uuid, text) IS
  '현행 명부(own·excluded → own·hidden)·별칭(→ merge_into) → v1(ver 1, origin cutover) + 활성화. 기존 표 md5·행 수 불변, 엔티티 행 = 명부 + 별칭 − 겹침 단언. DB-v2.17 P99';

-- ── P102 ─────────────────────────────────────────────────────────────────────
CREATE TABLE app.ecat_audit_log (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL DEFAULT app.actor(),
  action text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),       -- <대상>.<동작>, 예 draft.create · entity.upsert · apply.approve
  ver int4, apply_id bigint, review_id bigint, entity_id uuid, surface_id int4,
  detail jsonb, request_id uuid);
CREATE INDEX ecat_audit_ver_idx ON app.ecat_audit_log (ver, audit_id) WHERE ver IS NOT NULL;
CREATE INDEX ecat_audit_apply_idx ON app.ecat_audit_log (apply_id, audit_id) WHERE apply_id IS NOT NULL;
CREATE TRIGGER ecat_audit_ao BEFORE UPDATE OR DELETE OR TRUNCATE ON app.ecat_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_append_only();
COMMENT ON TABLE app.ecat_audit_log IS
  '엔티티 버전 관리 API(E6) 감사 원장(append-only). 쓰기와 같은 트랜잭션에서 한 행(롤백 = 행 없음). detail = 전후 값·범위·사유. DB-v2.17 P102';

-- ── P104 ────────────────────────────────────────────────────────────────────
CREATE VIEW rd.v_entity_mention_surface WITH (security_barrier) AS
  SELECT m.entity_id, m.run_month, s.surface, m.brand_rollup_entity_id,      -- 표면 없는 언급 = surface NULL 1행(롤업만 읽을 때)
         m.display_name                                                           -- 접두 교정(J1) 입력
    FROM ing.mention m LEFT JOIN LATERAL unnest(m.surfaces) AS s(surface) ON true;
ALTER VIEW rd.v_entity_mention_surface OWNER TO loader_ro;
GRANT SELECT ON rd.v_entity_mention_surface TO api_ro, admin_long;
-- 접두 교정(J1) 판정 함수: migration/seed/seed-3x-common.sql §2 pg_temp.rx_escape·rx_lead_trim·hmg_prefix_id 본문을 이름만 바꿔 그대로 옮긴 것.
--   린트(API 연결)는 세션 임시 함수(pg_temp)를 쓸 수 없어 영구 사본을 둔다. 엔진 원본과의 동치는 시험(ingest/project/apply/tests/
--   test_ecat_lint_parity.py)이 같은 입력에서 두 함수 결과를 대조해 고정한다(원본이 바뀌면 그 시험이 실패한다).
CREATE OR REPLACE FUNCTION app.ecat_rx_escape(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $f$
  SELECT regexp_replace(t, '([.*+?^${}()|\[\]\\])', '\\\1', 'g')
$f$;
CREATE OR REPLACE FUNCTION app.ecat_rx_lead_trim() RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT E'[\u0009\u000a\u000b\u000c\u000d                  　﻿]*'
$f$;
CREATE OR REPLACE FUNCTION app.ecat_hmg_prefix_id(disp text) RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT b.canonical_entity_id FROM app.brand_name_prefix p JOIN app.brand b ON b.brand_code = p.brand_code
   WHERE disp ~* ('^' || app.ecat_rx_lead_trim() || '(' || app.ecat_rx_escape(p.prefix) || ')([^[:alnum:]]|$)')
   ORDER BY p.eval_order LIMIT 1
$f$;
ALTER FUNCTION app.ecat_rx_escape(text) OWNER TO hmg_owner;
ALTER FUNCTION app.ecat_rx_lead_trim() OWNER TO hmg_owner;
ALTER FUNCTION app.ecat_hmg_prefix_id(text) OWNER TO hmg_owner;
GRANT EXECUTE ON FUNCTION app.ecat_rx_escape(text), app.ecat_rx_lead_trim(), app.ecat_hmg_prefix_id(text) TO api_ro, admin_long, loader, migrator;
COMMENT ON VIEW rd.v_entity_mention_surface IS
  'Scope 관측 표면(ing.mention.surfaces 원문)·Scope 브랜드 롤업·표시명(접두 교정 입력) 엔티티별. entity_id 또는 brand_rollup_entity_id 등치(ANY) + run_month 하한 전용(범위 스캔 금지). 린트 전역 차단 대조(E6, 검증 N4: 자사 엔티티와 자사로 롤업되는 엔티티). DB-v2.17 P104';

-- ── 소유자·권한(이 패치는 superuser·migrator 로 적용되므로 명시 이전·부여) ──
ALTER TABLE app.ecat_version OWNER TO hmg_owner;
ALTER TABLE app.ecat_entity OWNER TO hmg_owner;
ALTER TABLE app.ecat_surface_def OWNER TO hmg_owner;
ALTER TABLE app.ecat_surface OWNER TO hmg_owner;
ALTER TABLE app.ecat_apply OWNER TO hmg_owner;
ALTER TABLE app.ecat_review OWNER TO hmg_owner;
ALTER TABLE ing.hub_match OWNER TO hmg_owner;
ALTER TABLE ing.hub_match_scan OWNER TO hmg_owner;
ALTER TABLE ing.surface_seen OWNER TO hmg_owner;
ALTER TABLE ing.review_fill_state OWNER TO hmg_owner;
ALTER VIEW app.ecat_registry_active OWNER TO hmg_owner;
ALTER VIEW app.ecat_alias_active OWNER TO hmg_owner;
ALTER TABLE app.ecat_audit_log OWNER TO hmg_owner;
DO $o$ DECLARE f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['rd.ensure_hub_match_leaf(date)', 'app.tg_ecat_version_guard()', 'app.tg_ecat_draft_only()', 'app.tg_ecat_merge_check()',
                           'app.tg_ecat_surface_check()', 'app.tg_ecat_apply_guard()', 'app.ecat_registry_rows(int4)', 'app.ecat_alias_rows(int4)',
                           'app.ecat_legacy_md5()', 'app.ecat_active_md5()', 'app.tg_ecat_legacy_guard()', 'app.ecat_project_legacy()',
                           'app.ecat_content_md5(int4)', 'app.ecat_activate(int4)', 'app.ecat_cutover_v1(uuid,text)']::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hmg_owner', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $o$;
-- 읽기: 버전·표면·원장·대기함은 관리 화면(api_ro·admin_long)·적재기·이관이 읽는다
GRANT SELECT ON app.ecat_version, app.ecat_entity, app.ecat_surface_def, app.ecat_surface, app.ecat_apply, app.ecat_review,
  app.ecat_registry_active, app.ecat_alias_active TO api_ro, api_rw, admin_long, loader, migrator;
-- api_rw(관리 API, E6): 초안·표면 정의·반영 요청/승인·대기함 처리. 불변·전이는 트리거가 강제
GRANT INSERT, UPDATE, DELETE ON app.ecat_version, app.ecat_entity, app.ecat_surface TO api_rw;
GRANT INSERT ON app.ecat_surface_def TO api_rw;
GRANT INSERT, UPDATE ON app.ecat_apply TO api_rw;
GRANT UPDATE (status, resolved_ver, decided_by, decided_at, note) ON app.ecat_review TO api_rw;
-- 감사(P102): api_rw 는 INSERT 만(UPDATE·DELETE·TRUNCATE 는 트리거로도 거부), 읽기는 관리 화면·이관
GRANT SELECT ON app.ecat_audit_log TO api_ro, api_rw, admin_long, loader, migrator;
GRANT INSERT ON app.ecat_audit_log TO api_rw;
-- loader(적재기 E1·E2·E5·E8): 반영 진행 열, 대기함 적재, 원천 보조
GRANT UPDATE (status, cycle_keys, affected_answers, preview, preview_set_md5, started_at, finished_at, load_id, error) ON app.ecat_apply TO loader;
GRANT INSERT ON app.ecat_review TO loader;
GRANT UPDATE (display_name, entity_type, last_seen_at, n_mentions, n_answers, alerted_at, alert_grade) ON app.ecat_review TO loader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ing.hub_match, ing.hub_match_scan TO loader, migrator;
GRANT SELECT ON ing.hub_match, ing.hub_match_scan TO loader_ro;
GRANT SELECT, INSERT, UPDATE ON ing.surface_seen, ing.review_fill_state TO loader, migrator;
GRANT SELECT ON ing.surface_seen, ing.review_fill_state TO loader_ro;
-- 함수: 호환 투영 읽기 함수는 읽는 롤 전부, 상태 전이·이관·leaf 는 적재기·이관만
GRANT EXECUTE ON FUNCTION app.ecat_registry_rows(int4), app.ecat_alias_rows(int4), app.ecat_content_md5(int4), app.ecat_legacy_md5(),
  app.ecat_active_md5() TO api_ro, api_rw, admin_long, loader, migrator;
GRANT EXECUTE ON FUNCTION app.ecat_activate(int4), app.ecat_project_legacy(), rd.ensure_hub_match_leaf(date) TO loader, migrator;
GRANT EXECUTE ON FUNCTION app.ecat_cutover_v1(uuid, text) TO migrator;
-- 트리거 함수(app.tg_ecat_*)는 EXECUTE 권한 없이 트리거로만 불린다(호출자 권한으로 돈다: 가드가 current_user 를 본다)

-- ── 적용 단언 ────────────────────────────────────────────────────────────────
DO $v$
DECLARE bad text;
BEGIN
  SELECT string_agg(x.r, ', ') INTO bad
    FROM unnest(ARRAY['app.ecat_version','app.ecat_entity','app.ecat_surface_def','app.ecat_surface','app.ecat_apply','app.ecat_review',
                      'ing.hub_match','ing.hub_match_scan','app.ecat_registry_active','app.ecat_alias_active','app.ecat_audit_log',
                      'ing.surface_seen','ing.review_fill_state']) x(r)
   WHERE (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = x.r::regclass) <> 'hmg_owner';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'P94~P104 실패: 소유자 %', bad; END IF;
  IF NOT has_table_privilege('loader', 'ing.surface_seen', 'insert') OR NOT has_table_privilege('loader', 'ing.review_fill_state', 'update')
     OR to_regclass('ing.answer_first_seen_idx') IS NULL THEN
    RAISE EXCEPTION 'P103 실패: 판정 원장 권한·색인';
  END IF;
  IF NOT has_table_privilege('api_rw', 'app.ecat_audit_log', 'insert') OR has_table_privilege('api_rw', 'app.ecat_audit_log', 'update')
     OR has_table_privilege('api_rw', 'app.ecat_audit_log', 'delete') OR NOT has_table_privilege('api_ro', 'app.ecat_audit_log', 'select') THEN
    RAISE EXCEPTION 'P102 실패: 감사 원장 권한';
  END IF;
  -- rd.answer.ecat_ver: 파티션 전부에 전파, NOT NULL·기본값 1(메타데이터 기본값), rd.cycle.ecat_ver: NULL·기본값 없음
  SELECT string_agg(t.r::text, ', ') INTO bad
    FROM (SELECT 'rd.answer'::regclass AS r UNION ALL SELECT i.inhrelid::regclass FROM pg_inherits i WHERE i.inhparent = 'rd.answer'::regclass
          UNION ALL SELECT i2.inhrelid::regclass FROM pg_inherits i1 JOIN pg_inherits i2 ON i2.inhparent = i1.inhrelid
           WHERE i1.inhparent = 'rd.answer'::regclass) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.r AND a.attname = 'ecat_ver' AND NOT a.attisdropped
                      AND a.atttypid = 'int2'::regtype AND a.attnotnull AND a.atthasdef);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'P101 실패: rd.answer.ecat_ver 전파 %', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.cycle'::regclass AND attname = 'ecat_ver' AND NOT attisdropped
                   AND atttypid = 'int2'::regtype AND NOT attnotnull AND NOT atthasdef) THEN
    RAISE EXCEPTION 'P101 실패: rd.cycle.ecat_ver';
  END IF;
  IF position('entity_version' in (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                    WHERE conrelid = 'app.judgment_change'::regclass AND conname = 'judgment_change_kind_check')) = 0 THEN
    RAISE EXCEPTION 'P101 실패: judgment_change kind';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'ecat_legacy_guard' AND NOT tgisinternal
        AND tgrelid IN ('app.entity_registry'::regclass, 'app.entity_alias'::regclass)) <> 2 THEN
    RAISE EXCEPTION 'P98 실패: 기존 표 가드 트리거';
  END IF;
  IF NOT has_function_privilege('migrator', 'app.ecat_cutover_v1(uuid,text)', 'execute')
     OR has_function_privilege('api_rw', 'app.ecat_cutover_v1(uuid,text)', 'execute')
     OR has_function_privilege('api_rw', 'app.ecat_activate(int4)', 'execute')
     OR NOT has_function_privilege('loader', 'app.ecat_activate(int4)', 'execute')
     OR NOT has_function_privilege('loader', 'rd.ensure_hub_match_leaf(date)', 'execute')
     OR has_function_privilege('api_ro', 'app.ecat_project_legacy()', 'execute') THEN
    RAISE EXCEPTION 'P98~P100 실패: 함수 실행 권한';
  END IF;
  -- 패치 직후: 버전 없음 → 기존 표 쓰기 가드는 열려 있다(현 동작 그대로). 뷰는 빈 결과
  IF EXISTS (SELECT 1 FROM app.ecat_version) OR EXISTS (SELECT 1 FROM app.ecat_registry_active) THEN
    RAISE EXCEPTION 'P98 실패: 패치 직후 버전이 있다';
  END IF;
  IF (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'rd.v_entity_mention_surface'::regclass) <> 'loader_ro'
     OR NOT has_table_privilege('api_ro', 'rd.v_entity_mention_surface', 'select')
     OR NOT has_table_privilege('admin_long', 'rd.v_entity_mention_surface', 'select')
     OR has_table_privilege('api_rw', 'rd.v_entity_mention_surface', 'select')
     OR NOT has_function_privilege('admin_long', 'app.ecat_hmg_prefix_id(text)', 'execute') THEN
    RAISE EXCEPTION 'P104 실패: 관측 표면 뷰 소유자·권한';
  END IF;
  PERFORM app.ecat_content_md5(0);
END $v$;

COMMIT;
