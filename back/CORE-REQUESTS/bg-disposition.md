# BG CORE-REQUESTS 처분표 (core 8라운드, 2026-09-29)

기준: stg f1b6c4f(값 갭 보강 BG 10그룹 통합) 위 feat/core. 대상 = 이 폴더의 `bg-*.md` 8개. 결정 원칙은 이전 라운드와 같다:
현행 front 동작이 기준이고, 넓히는 변경은 하지 않으며, 좁히는 변경은 A4(고지) 목록 후보로 올린다.
처분 = 반영(이번 라운드 코드·DDL) / 확인(이미 들어가 있음) / 보류(결정·후속 대기) / 기각.

| 그룹 | 항목 | 처분 | 처리·근거 |
| --- | --- | --- | --- |
| bg-admin | R1 `app.ga4_property.verified_at` (BG-43) | 반영 | DB-v2.9 P60(열 + mig_src 채움), seed-10 4-11, `Ga4Property.verified_at`. verify=true 성공 때만 now(), 매핑이 바뀌어도 유지(현행 upsertGa4Mapping 은 건드리지 않았다) |
| bg-admin | R2 속성 없는 시장 (a) 별도 표 | 반영 | DB-v2.9 P61 `app.ga4_market_pending`(+ 원천 이관), `GET /v1/admin/ga4/markets`, `GET·PUT·DELETE /v1/admin/ga4/markets/{brand_code}/{country_code}`. 속성 매핑 때 같은 트랜잭션에서 대기 행 삭제(`pending_market_cleared`), 같은 시장 속성이 있으면 409 `market_taken`(현행 brand×country 유일). 회귀 `test_d2_blocked_fields` → `test_d2_verified_and_markets` |
| bg-funnel | 1 BG-32 GA4 창 사용자 수 원천 | 보류 | 제품 결정 G-12 대기: (a) 사용자 수 미제공(카드·열 숨김) / (b) D8 예외로 `rd.ga4_window_total` 저장 + IG-4 창 적재. DDL·적재기 모두 결정 뒤 |
| bg-funnel | 2 참고(엔드포인트 2개, admin.ga4 service 공용) | 확인 | 경로 수는 통합(f1b6c4f)에 들어갔다. funnel → admin.integrations.ga4 service import 는 같은 그룹 소유라 유지(대분류 간 import 규칙이 생기면 core 로 올린다) |
| bg-funnel | 3.1 검증 D1(다른 시장 GA4 속성 지정) | 보류(결정) | 제품 결정: (가) funnel 쪽 '프로젝트 몫' 규칙만(권장, projects PATCH 는 현행대로 저장) / (나) projects PATCH 도 비관리자 거절. 둘 다 현행보다 좁히는 변경이라 A4 후보에 올린다((가)는 이미 들어가 있다) |
| bg-intent | BG-39 연관어 원래 총수 | 반영 | DB-v2.9 P62 `rd.kw_suggestion.total_count`(ext.dfs_call 채움), 적재기 KW_SUGGEST, `Related.total_count`·`LookupRow.total_count`(null 이면 프론트는 found_count 폴백) |
| bg-intent | BG-40 경쟁도 라벨 | 반영 | DB-v2.9 P62 `rd.kw_volume_monthly.competition`(CHECK LOW·MEDIUM·HIGH, 채움), 적재기 KW_VOLUME(세 값 밖 NULL), `VolumeItem.competition`. research `TrendPoint.competition` 은 쓰는 화면이 없어 넣지 않았다 |
| bg-intent | R1 OpenAPI 수 상수 | 확인 | 통합에서 183·147, 이번 라운드 GA4 대기 시장 +4·+2 로 187·149 |
| bg-kpi-filters | R1 카드 applied_prompts 시장 게이트 | 보류(결정) | 현행 유지(b): 카드는 시장 무관(현행 catalogPromptCountWhere 와 같음). (a)는 카드 값을 좁히는 변경 → A4 후보, 제품 결정(모듈-KPI Q10) |
| bg-kpi-filters | R2 택소노미 축 관점 브랜드 한정 | 보류(결정) | 기존 축 값이 바뀌는 좁히는 변경 → A4 후보. 다만 타 브랜드 카탈로그 행 값의 존재·연결 오라클(보안) 성격이 있어 제품 결정 목록에 올린다 |
| bg-kpi-filters | R3 카탈로그 depth4 선언 | 확인 | `catalog/prompts/catalog/service.py` CATALOG_SUPPORT.global_ 에 DEPTH4_AXIS 유지(회귀 `tests/core/test_bg_core.py`) |
| bg-kpi-filters | R4 known_diff K-1b | 반영 | DB-v2.9 P64 (`K-1b`, `analytics.kpi.summary`, `unmeasured%`, input) |
| bg-mentions-answers | R1 known_diff M-3 | 확인(철회) | 요청 철회(값이 현행과 같다). 조치 없음 |
| bg-mentions-answers | R2 split_own 행 키 core 한 곳 | 반영 | `core.measure.split_own_label(refs, bit)` 한 정의, trend `_own_parts`·mentions `own_brand_code_of_bit` 가 부른다(회귀 `test_bg_core.py`) |
| bg-mentions-answers | R3 통합 순서 | 확인 | 통합 완료(core.measure 같은 바이트), 조치 없음 |
| bg-projects | R1 생성 선택지 순서 열 | 보류 | 막힌 기능 없음(어댑터가 front 상수로 재정렬해 현행 순서와 같다). 순서 열(ord·geo_ord)은 표시 전용 DDL 이라 다음 DDL 묶음으로 미룬다 |
| bg-qa-platform | R1 `rd.v_answer_body` run_id·region·prompt_run_id | 반영 | DB-v2.9 P63(뷰 끝 열), `QaAnswerHead.run_id·region·prompt_run_id`(`GET /v1/qa/answers/{job_id}`) |
| bg-qa-platform | R2 `rd.v_acr_cell_run` | 반영 | DB-v2.9 P63(새 뷰, 소유자 loader_ro, api_ro·admin_long·qa_gate), `QaAcrCell.prompt_run_id` |
| bg-qa-platform | R3 url trim(NBSP) 차이 | 보류(c 현행 유지·문서화) | 영향 = rd.dim_url 에 없는 비서빙 인용 URL 이 앞뒤에 비ASCII 공백을 가질 때만 한 글자 차이. (a)·(b)는 추적 URL 정규화·rd.dim_url 재계산을 바꾸므로 결정 목록(낮음)에 올린다 |
| bg-qa-platform | D2 신뢰 중계 IP | 확인 | `core.auth.relay_client_ip`(HGH_RELAY_SECRET 16자 이상, 상수 시간 비교, IP 형식·길이 검증, 불일치 폴백), 회귀 `qa/review/sessions/tests/test_bg_qa_platform.py` 6건. 배포 조건(CloudFront 헤더 통과·Vercel 서버 env)은 운영 몫 |
| bg-trend-geo | R1 known_diff BG-07 | 반영 | DB-v2.9 P64. M-2 미결 1번(competitive 술어)과 함께 F08·F10 패리티로 확정 |
| bg-trend-geo | R2 known_diff BG-10 | 반영 | DB-v2.9 P64. A4 고지 문안: "커버리지 라벨 N일 = 엔진 합집합 KST 일수(셀 대표 여부 무관)" |
| bg-trend-geo | R3·R4 D13 split_own 키 계약·단일 정의 | 반영 | DECISIONS-API core 8라운드 절에 기록, core 한 정의(`split_own_scopes` + `split_own_label`) |

## 그룹 간 중복 core 추가분 정리

- split_own: 판정(`split_own_scopes`)은 이미 하나였고 행 키 식이 두 기능에 따로 있었다 → `split_own_label` 로 합쳤다.
- 그 밖에 BG 그룹이 core 에 더한 것(`applied_prompt_keys_sql(catalog_row_pred)`·`measured_prompt_where`·`report_publications`·`relay_client_ip`·
  `normalize_url_base_for_match`·`_taxonomy_prompt_keys_global(pop_bits)`)은 기능 쪽에 두 번째 정의가 없다(grep 확인).

## A4(고지) 후보로 올린 좁히는 변경

- bg-funnel 3.1 (가) 프로젝트 맥락 GA4 읽기·이벤트 쓰기를 '속성 시장 = 프로젝트 시장 ∨ 미귀속'으로 제한(현행은 제한 없음).
- bg-kpi-filters R1 (a)·R2 를 채택하면 카드·택소노미 결과가 줄어든다(지금은 미채택).
- 계정 스코프: front pseudo-country.ts:32-46 scopeParent(SA 계정이 SA-Riyadh·Dammam·Jeddah 사이트를 자동으로 봄)를 백엔드가 적용하지 않는다
  (core.filters website 사이트 술어 `scope.country_allowed(사이트 코드)`·core.auth DataScope.country_allowed 가 코드 그대로 upper 비교: 코드로 확인, 실측 미실행).
  이번 변경이 만든 것이 아니라 기존 차이다(account-migration.md R3 3차).
