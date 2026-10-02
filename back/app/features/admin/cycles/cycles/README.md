# admin.cycles.cycles · 운영 관리 / 회차 운영 / 회차 숨김·마감·노출일

설계 단위: AD-4 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/cycles` | low |
| GET | `/v1/admin/cycles/{cyc_key}` | medium |
| POST | `/v1/admin/cycles/{cyc_key}/hide` | low |
| POST | `/v1/admin/cycles/{cyc_key}/unhide` | low |
| POST | `/v1/admin/cycles/{cyc_key}/close` | low |
| PUT | `/v1/admin/cycles/{cyc_key}/view-date` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- (화면 없음: 운영·워커)

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28)
- 경로 `{cyc_key}` 는 cycle_id(uuid, 공개 식별자)를 받는다. 운영 스크립트 호환으로 정수 cyc_key 도 받지만 응답에는 cycle_id 만 싣는다
  (경로 이름은 taxonomy 경로 계약 고정: ad-ops R9 기각).
- 목록: 공통 필터 `surface`(필수)·`project_id`(프로젝트 또는 웹사이트 사이트)·`from/to`(기본 최근 26주), (round_date, cycle_id) DESC 키셋, 대기 중 cycle_admin 요청 동봉.
- 상세: rd.cycle 카운터(Q2 개정으로 expected_units 등 노출) + rd.job 분포 + rd.answer 분석 상태(admin_long, 숨김 무관).
- 쓰기: `judgment_change('cycle_admin', subject_uuids=[cycle_id])` 요청만(202). `dry_run` 이면 경고·대상 상태만(200).
  중복 판정은 같은 회차·같은 op 만(dedupe_key `{op}`): 숨김 대기 중에도 노출일 요청은 받는다.
  `expected_generation` 불일치 409, 같은 상태 409 `state_mismatch`, 숨김 범위 all·citations 만(Q18), 가상 회차 마감 409.
  숨김 경고는 현행 hideCycleWarnings 이식(같은 주 = 월요일 시작, 더 최신 비숨김 회차 수).
