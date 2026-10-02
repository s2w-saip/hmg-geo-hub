# ingest.pull.ops · 적재 파이프라인(워커) / Scope pull·쓰기 스키마 / 적재 운영 조회

설계 단위: IG-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/ingest/status` | low |
| GET | `/v1/admin/ingest/backlog` | low |
| GET | `/v1/admin/ingest/loads` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- (화면 없음: 운영·워커)

## 구현

- 권한: `require_admin`(role='admin' 하나, 현행 /admin ADMIN_ONLY). operator 축은 쓰지 않는다. 비관리자 403 `admin_only`, 무인증·정지 401.
- 원천: api_ro 가 읽는 rd 운영 조회 뷰 `rd.v_ingest_status`·`rd.v_ingest_backlog`·`rd.v_ingest_load`(DB-v2.1 P09-d, 소유 loader_ro).
  ing 를 직접 읽지 않는다(A17). 사실 표가 아니라 surface·round_date·cyc_key 가지치기 대상이 아니다.
- 공통 필터: 지원 축 없음(`FilterSupport.of()`). 들어온 공통 필터 키는 `meta.ignored_filters` 에 축 이름으로(brand·country·period·custom …).
  `surface` 는 status·backlog 의 자체 파라미터, loads 에서는 무시 목록.
- 페이지: backlog 키셋 (started_at 오름차순, NULL 센티넬 1970-01-01, run_id), loads 키셋 load_id 내림차순. 커서는 core.pagination
  (필터 해시 대조: 다른 필터로 재사용하면 422 cursor_invalid). limit 기본 50, 최대 200. loads 필터 kind[]·status[]·started_from/started_to(적재 시각 축).
- 응답: `{data: {items: [...]}, meta: {mode: admin, surface, ignored_filters, page}}`.

## 성능(EXPLAIN, 로컬 합성 DB·api_ro)

status: sync_cursor 순차 + run_project_idx 인덱스 스캔(프로젝트별 LATERAL). backlog·loads: 뷰가 security_barrier 라 정렬·LIMIT 이 뷰 위에서 돈다
(키셋 술어 `load_id < :k` 는 PK 인덱스 조건으로 내려간다). 원장 규모(10배에서도 수십만 이하)에서 위험 low. 첫 페이지 정렬 비용(R7 security_barrier)은 보류(원장 규모 low, 실측 게이트 뒤 판단).

## 테스트(`tests/test_ops.py`)

값(ing 원장 독립 SQL·손계산), 표면 필터·무시된 공통 필터, 비관리자 4종 403·누출 0·정지 401·무인증 401, backlog 페이지·빈 결과·잘못된 커서·limit 422,
loads 필터·기간·페이지·잘못된 kind·기간 역전 422, EXPLAIN 실행.
