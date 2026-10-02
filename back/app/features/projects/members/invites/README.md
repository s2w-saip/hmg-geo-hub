# projects.members.invites · 프로젝트 / 멤버 / 초대 수락·거절

설계 단위: PJ-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| POST | `/v1/projects/{project_id}/members/me/accept` | low |
| POST | `/v1/projects/{project_id}/members/me/reject` | low |
| GET | `/v1/me/project-invites` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`
