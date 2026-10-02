# projects.prompts.fields · 프로젝트 / 프로젝트 프롬프트 / 커스텀 필드

설계 단위: PJ-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects/{project_id}/prompt-fields` | low |
| POST | `/v1/projects/{project_id}/prompt-fields` | low |
| POST | `/v1/projects/{project_id}/prompt-fields/{field_id}/archive` | low |
| POST | `/v1/projects/{project_id}/prompt-fields/{field_id}/restore` | low |
| DELETE | `/v1/projects/{project_id}/prompt-fields/{field_id}` | low |
| PUT | `/v1/projects/{project_id}/prompts/{prompt_id}/fields/{field_id}` | low |
| POST | `/v1/projects/{project_id}/prompt-fields/{field_id}/bulk-set` | low |
| DELETE | `/v1/projects/{project_id}/prompts/{prompt_id}/fields/{field_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/prompt`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 목록(member)은 value_count 포함. 추가·보관·복구·삭제·값 쓰기는 Owner.
- 예약어(brand·category·prompttype·브랜드·카테고리)는 API 상수 → 422 reserved_label, 같은 이름(대소문자 무시)은 409 duplicate.
- 모든 field_id·prompt_id 는 프로젝트 소속 재검증(아니면 404). 일괄 적용은 한 건이라도 소속 밖이면 전체 404(쓰기 없음).
- 커스텀 필드는 판정 입력이 아니다(프로젝트 표면 필터가 조회 시 app 을 직접 읽음) → judgment_change 없음.
