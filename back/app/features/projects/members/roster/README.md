# projects.members.roster · 프로젝트 / 멤버 / 멤버 목록·역할

설계 단위: PJ-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects/{project_id}/members` | low |
| POST | `/v1/projects/{project_id}/members` | low |
| PATCH | `/v1/projects/{project_id}/members/{user_id}` | low |
| DELETE | `/v1/projects/{project_id}/members/{user_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]`
- `/projects/[id]/member`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`
