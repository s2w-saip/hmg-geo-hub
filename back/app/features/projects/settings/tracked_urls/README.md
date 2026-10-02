# projects.settings.tracked_urls · 프로젝트 / 프로젝트 설정 / 추적 URL

설계 단위: PJ-4 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects/{project_id}/settings/tracked-urls` | low |
| POST | `/v1/projects/{project_id}/settings/tracked-urls` | low |
| DELETE | `/v1/projects/{project_id}/settings/tracked-urls` | low |
| GET | `/v1/projects/{project_id}/settings/tracked-urls/export` | low |
| POST | `/v1/projects/{project_id}/settings/tracked-urls/import` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/setting`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 조회·내보내기 = 활성 멤버 또는 admin(core resolve_project active_member), 쓰기·가져오기 = 활성 Owner 또는 admin(owner, members_only). 비멤버 404.
- xlsx: 읽기 = `core.xlsx.XlsxReader`(스트리밍, 이 기능 예산 `service.BUDGET`: 업로드 5MB·부분 파일 20MB·데이터 행 5,000·64열 밖 버림),
  쓰기 = `core.export.xlsx_response`(시트 tracked-urls, 열 url_norm·url·label). 파일 오류는 422(core XlsxError.code 그대로).
- 가져오기 본문: multipart/form-data 의 file 필드 또는 xlsx 본문(하위 호환). 권한 판정 뒤 `core.upload.read_upload_request` 로 읽는다(검증 D7),
  5MB 초과 413 payload_too_large, 빈 본문 422 invalid_upload.
- judgment_change('project_target_url')는 매 편집 1행(대기 행 합치기를 쓰지 않는 이유: `project/core/shared.py` JUDGMENT_DEDUPE 주석).
