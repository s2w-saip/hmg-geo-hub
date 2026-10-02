# admin.integrations.ga4 · 운영 관리 / 외부 연동 / GA4 속성

설계 단위: AD-6 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/ga4/properties` | low |
| PUT | `/v1/admin/ga4/properties/{property_id}` | low |
| DELETE | `/v1/admin/ga4/properties/{property_id}` | low |
| GET | `/v1/admin/ga4/properties/{property_id}/events` | low |
| PUT | `/v1/admin/ga4/properties/{property_id}/events` | low |
| GET | `/v1/admin/ga4/project-overrides` | low |
| GET | `/v1/admin/ga4/markets` | low |
| GET | `/v1/admin/ga4/markets/{brand_code}/{country_code}` | low |
| PUT | `/v1/admin/ga4/markets/{brand_code}/{country_code}` | low |
| DELETE | `/v1/admin/ga4/markets/{brand_code}/{country_code}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/ga4`
- `/projects/[id]/ai-funnel/conversion`
- `/website/ai-funnel/conversion`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`
- `adapters.py` GA4 Data API 접근 확인 어댑터(주입: `get_ga4_access`). 설정은 core.config(`ga4_credentials_json`·`ga4_timeout_s`)

## 구현 메모(2026-09-28, 단위 설계 없음: 현행 /admin/ga4 이식)
- PUT 속성: body `{brand_code, country_code, verify}`(브랜드·국가 둘 다 또는 둘 다 null=unmapped). verify=true 면 쓰기 전에 GA4 최소 보고서로 확인 → active,
  실패면 저장 안 함(422 `ga4_verify_failed`·502·503). 같은 브랜드·국가 다른 속성 409 `market_taken`(사전 조회 + 동시 경합은 DB 부분 유니크
  `ga4_property_market_uq` 23505 → 409 `market_taken`). 매핑·상태가 바뀌면 `judgment_change('ga4_property')`.
  외부 호출이 있어 `CurrentUserDetached`(게이트 코드 동일), 읽기 `RoSession`, 쓰기 `get_db().write`.
- 이벤트 목록: 적재된 rd.ga4_row events 보고서 최근 90일 eventCount ∪ 추적 이벤트(현행은 GA4 API 직접 호출, 새 설계는 요청 경로 외부 호출 없음).
- 이벤트 교체: 집합이 바뀌면 `judgment_change('ga4_tracked_event', payload{old, new})`. 이름 규칙 영문 시작·영숫자·밑줄 40자.
- EXPLAIN(로컬 합성): prop_key 등치 + date 범위로 창 밖 월 리프 제외, PK 인덱스 스캔.
- 비관리자 경로(2026-09-28, BG-29): 이벤트 목록 본체 `load_events`(레지스트리 존재 검사 없음)를 analytics.funnel.conversion
  `/v1/funnel/conversion/events` 가 권한 판정 뒤 부른다. 교체(`put_events`)도 같은 본체를 쓴다(같은 재판정 큐).
- BG-43(값 갭 보강, 2026-09-28, 메인 결정 = UI 를 지우지 않고 필드 추가):
  - 속성 목록 `project_overrides[]` 에 `brand_code`·`country_code`(추가형).
  - `GET /v1/admin/ga4/project-overrides`: GA4 속성을 직접 지정한 프로젝트 전부(레지스트리 밖 속성 포함, 현행 ga4/page.tsx:53-61). 필드 project_id·name·kind·
    brand_code·country_code·property_id·registered·property_status·created_at. 필터 property_id·registered, (created_at, project_id) DESC 키셋(limit ≤ 500).
  - `verified_at`·속성 없는 시장(brand×country 만 등록): core 8라운드(2026-09-29)가 DB-v2.9 P60·P61 과 API 를 반영했다(bg-admin R1·R2 (a)).
    - `Ga4Property.verified_at`: verify=true 성공 때만 now(). verify 없는 저장·매핑 변경은 유지(현행 upsertGa4Mapping 은 건드리지 않았다).
      이관은 mig_src.ga4_properties.verified_at(seed-10 4-11, 패치 P60 채움).
    - 대기 시장 `app.ga4_market_pending`: `GET /v1/admin/ga4/markets`(목록, brand_code·country_code 필터), `GET·PUT·DELETE .../markets/{brand_code}/{country_code}`
      (PUT 멱등 body `{note}`, 응답 `created`). 같은 시장에 속성이 있으면 409 `market_taken`(details.property_id), 알 수 없는 브랜드 422 `unknown_brand`.
      속성 매핑(PUT properties)은 같은 트랜잭션에서 그 시장의 대기 행을 지우고 `pending_market_cleared` 로 알린다. 두 쓰기는 시장 단위 advisory 잠금을 먼저 잡는다.
      속성 목록과 합쳐 보이는 것은 프론트 어댑터 몫(설계 부록 F 임시 규칙은 이제 필요 없다).
    - 회귀 `tests/test_d2_verified_and_markets.py`(예전 test_d2_blocked_fields 를 실제 기대로 전환).
