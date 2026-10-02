# admin.changes.queue · 운영 관리 / 변경 요청 큐 / 재판정·운영 요청 조회

설계 단위: SHARED · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/changes` | low |
| GET | `/v1/admin/changes/{change_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/keyword-tools`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28)
- 목록: `kind[]`(core.write.ChangeKind)·`status[]`·`requested_by`·`subject`(UUID 면 subject_uuids, 아니면 subject_texts 원소), change_id DESC 키셋(기본 50, 최대 200).
- 요청자 이메일 동봉. 단건 없으면 404. 테스트 파일은 `test_ad_ops_changes_queue.py`(`queue` 가 표준 라이브러리와 겹쳐 고유 파일명으로 둔다. 수집 방식 개정은 보류: ad-ops R8 처분).
