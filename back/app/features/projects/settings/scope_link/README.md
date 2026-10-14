# projects.settings.scope_link · 프로젝트 / 프로젝트 설정 / Scope 연결 진단

설계 단위: PJ-4 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects/{project_id}/settings/scope-link` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/setting`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `include_recent=false`(B018): 최근 아웃박스 10행(OUTBOX_RECENT)을 읽지 않고 `outbox.recent` = [](건수·상태·회차는 같다). 설정 화면 진단 블록
  (front `loadScopeLink`)이 보낸다. scope_project_id 는 접근 판정이 읽은 프로젝트 행 값을 쓴다(재조회 문장 없음).
