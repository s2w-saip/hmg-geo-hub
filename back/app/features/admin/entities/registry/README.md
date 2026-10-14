# admin.entities.registry · 운영 관리 / 엔티티 / 엔티티 레지스트리

설계 단위: AD-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/entities` | high (1년 창) |
| PUT | `/v1/admin/entities/{entity_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/standards/entities`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28, ad-content)
- GET: surface 필수, from/to(없으면 최신 노출 회차, 366일 초과 422 `period_too_long`). 행 = rd.dim_entity(Brand) ∪ 등재만 된 엔티티.
  수치(2026-10-01 엔티티 관리 5차 항목 1, B안·결정 25로 교체) = 엔티티별 전 기간 answers(job distinct)·mentions(mention_count 합),
  운영 hmg-geo 2670a16 listDiscoveredBrands 정의(entity-registry.ts:118-136: scope_mentions entity_type='Brand' ∧ 표시명 있음, 기간·게이트 없음,
  드롭 답변 미러 삭제 = ing.answer_drop 제외). 원천 = rd.entity_mention_total(DB-v2.25 P132, 적재 마무리 finalize 가 트리거 차분을 반영,
  이관·복구 = migration/fill-v225.sql). 엔티티 관리(병합·제거)는 원천 합이라 영향 없음(운영과 같다).
  이전 정의(표시 브랜드 단위 G-23 a, 창 Window.where, 게이트 std_in ∧ dflt, 메인 2026-09-28, mig.known_diff `AD-2`)는 대체됐다.
  유효 귀속 own_brand = 활성 버전 기준 RollupRule.entity_own(versions.service.active_own_brands, 버전 상세 effective_own_brand 와 같은 판정: 덮어쓰기·제거 반영, 검증 5차 CE25). 창(from·to)은 키셋 세대·meta 에만 쓴다(기간 지정 시 admin_long).
  meta.source = {count_grain: entity_all_time, count_table: rd.entity_mention_total, pool}. 목록 조회 = 합계 표 PK 조인(합성 2,008 엔티티·
  Hyundai 언급 160만에서 2.6~4.4 ms). 키셋(세대 변경 시 409 cursor_stale).
- PUT(컷오버 뒤): 활성 엔티티 버전(app.ecat_version active)이 있으면 409 `ECAT_LEGACY_WRITE`(쓰기 0). 편집은 admin.entities.versions(E6) 초안으로 한다.
- PUT: own(brand_code 필수, 엄브렐러 불가)·excluded = upsert, competitor = 삭제. 같은 트랜잭션에서 `enqueue_change('entity', payload{op, entity_id, old, new})`.
  같은 엔티티 대기 요청이 있으면 409 `duplicate_pending`(쓰기 롤백). 변경 없음 = applied false·요청 없음. 응답 warnings `full_rebuild`.
- EXPLAIN(로컬 합성 DB): 기본 창·1개월 창 모두 answer_brand 리프 1개(`answer_brand_g_202609`)만 스캔(파티션 가지치기 확인).

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `GET /v1/admin/entities?fields=names`(B088): 이름·유형만 쓰는 호출(검토함 병합 후보)용. 유효 귀속 판정(own_brand)을 하지 않고 null.
  행·순서·이름·유형·역할·수치·커서는 full(기본, 종전)과 같다.
