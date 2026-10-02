# core·DB 요청: bg-admin 그룹 (값 갭 보강 라운드 BG-42·BG-43·BG-44)

작성: bg-admin 빌더 (2026-09-28, 브랜치 feat/bg-admin, 기준 stg 8890406). BG-42·BG-44 는 추가형으로 끝났다(DDL 불필요).
BG-43 은 메인 결정(UI 를 지우지 않고 필드 추가) 중 두 값이 DDL 없이는 만들 수 없어 보류했다. 아래가 그 요청이다.
각 항목은 무엇·왜·제안 DDL·이관·API 반영 순서로 적는다. API 쪽 반영(아래 "API 반영")은 DDL 이 들어오면 이 그룹이 한다.

## R1. app.ga4_property.verified_at (BG-43 verified_at)

- 무엇: GA4 속성의 마지막 검증 성공 시각. 현행 화면 `/admin/ga4` 표의 "검증일" 열(front ga4-registry-client.tsx:151·170, 값 = ga4_properties.verified_at,
  verifyGa4Mapping `_actions.ts:56` 이 검증 성공 때마다 now() 로 갱신).
- 왜 DDL: 새 DB 의 app.ga4_property 에는 updated_at 만 있다(DB-v2.7.sql:180). 변경 원장(app.judgment_change 'ga4_property')으로 근사하면
  "상태가 바뀐 검증"만 남고, 이미 active 인 속성을 다시 검증한 시각은 남지 않는다(put_property 는 상태·매핑이 같으면 요청을 만들지 않는다).
  이관 데이터(현행 verified_at)도 원장에 없어 전부 null 이 된다. 의미가 다른 근사값을 같은 이름으로 내지 않으려고 보류했다.
- 제안 DDL(추가형):
  ```sql
  ALTER TABLE app.ga4_property ADD COLUMN verified_at timestamptz;   -- 마지막 GA4 읽기 권한 확인 성공 시각(PUT verify=true 성공)
  ```
  api_rw 쓰기 권한이 열 단위라면 `GRANT UPDATE (verified_at) ON app.ga4_property TO api_rw` 도 함께.
- 이관: migration/seed/seed-10-app.body.sql 4-11 의 INSERT 에 `g.verified_at` 추가(원본 mig_src.ga4_properties.verified_at 있음, mirror-schema.sql:64).
- API 반영(이 그룹): UPSERT_SQL 에 verify 성공 시 `verified_at = now()`(실패·미요청은 유지), 매핑이 바뀌면 null 로 초기화할지 결정 필요
  (현행은 upsert 가 verified_at 을 건드리지 않아 유지). Ga4Property 에 `verified_at: datetime | None` 추가.

## R2. 속성 없는 시장(brand×country 만 등록) (BG-43 속성 없는 시장)

- 무엇: 현행은 브랜드·국가만 먼저 등록하고 속성 id 는 나중에 넣을 수 있다(front ga4-registry-client.tsx:121 입력 선택, status unmapped,
  ga4_properties.property_id nullable + brand×country 유일).
- 왜 DDL: 새 DB 는 PK 가 property_id(DB-v2.7.sql:180)라 속성 없는 행을 담을 수 없고, 이관도 그런 행을 버린다(seed-10-app.body.sql 4-11
  `WHERE g.property_id IS NOT NULL`). API 경로도 `/v1/admin/ga4/properties/{property_id}`(숫자 필수)다.
- 제안(둘 중 하나, 결정 필요):
  - (a) 별도 표(권장, 기존 PK·적재기 영향 없음):
    ```sql
    CREATE TABLE app.ga4_market_pending (brand_code text NOT NULL REFERENCES app.brand, country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
      note text, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (brand_code, country_code));
    GRANT SELECT ON app.ga4_market_pending TO api_ro; GRANT SELECT, INSERT, UPDATE, DELETE ON app.ga4_market_pending TO api_rw;
    ```
    적재기는 이 표를 읽지 않는다(속성 없는 시장은 GA4 행이 없다). 속성 등록(PUT properties/{id} 매핑) 때 같은 시장 행을 같은 트랜잭션에서 지운다.
    이관: 원본 property_id NULL 행을 이 표로.
  - (b) app.ga4_property 에 대리키를 두고 property_id nullable. 적재기(rd.ga4_dim_property.property_id)·judgment_change subject_texts 계약이
    property_id 를 키로 쓰므로 영향이 크다. 권장하지 않는다.
- API 반영(이 그룹, (a) 기준): `GET·PUT·DELETE /v1/admin/ga4/markets/{brand_code}/{country_code}`(대기 시장), 속성 목록과 합쳐 보이는 것은 프론트 어댑터가 한다.

## 참고: 이번 라운드에 core·DB 변경 없음

- 검증 수정 라운드(D1~D4) 상태: BG-43 은 partial 유지(R1·R2 대기, 검증 D2). 회귀 `app/features/admin/integrations/ga4/tests/test_d2_blocked_fields.py` 가
  DDL 도착(verified_at 열·ga4_market_pending 표·property_id nullable)을 감지하면 실패하므로, R1·R2 반영 시 이 그룹이 API 를 붙이고 테스트를 뒤집는다.
- D3(메뉴 게이트)·D4(쓰기 응답 표식)는 기능 코드만 고쳤다(core 변경 없음).
- 2차 재검증 수정 라운드(N1·D2·N2, 2026-09-29): hmg_tpl(v2.8) 복제본에서도 app.ga4_property 열은 property_id·brand_code·country_code·status·
  updated_by·updated_at 뿐이고 app.ga4_market_pending 표는 없다. R1·R2 는 여전히 대기, BG-43 partial 유지(test_d2_blocked_fields 통과 = 아직 DDL 없음).

- BG-42 shadows_owned 는 app.owned_base(kind 'base' host, DB-v2.7.sql:59)와 rd.dim_source.owned_brand_bit(DB-v2.7.sql:413, 적재기 선계산)를
  서픽스 일치로 읽는다(검증 결함 D1 수정: 적재 이력 없는 당사 도메인·당사 서브도메인). 둘 다 기존 표 읽기라 core·DB 요청 없음.
  서픽스 일치는 도메인의 점 단위 접미 후보와 등호(`skey = ANY(후보)`)로 판정해 기존 유일 인덱스 dim_source_skey_key 를 탄다(재검증 결함 N1).
  owned_brand_bit 인덱스는 요청하지 않는다.
- BG-44 outbox_pending·outbox_error 는 app.scope_outbox + scope_outbox_aggregate_idx(DB-v2.7.sql:1186)만 쓴다.
- BG-43 의 프로젝트 지정 brand·country 와 새 목록 엔드포인트는 app.project·app.ga4_property 읽기만 한다.
