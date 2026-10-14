# projects.prompts.candidates · 프로젝트 / 프로젝트 프롬프트 / 후보 풀

설계 단위: PJ-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects/{project_id}/prompt-candidates` | low |
| POST | `/v1/projects/{project_id}/prompt-candidates/select` | low |
| DELETE | `/v1/projects/{project_id}/prompt-candidates/{candidate_id}` | low |
| POST | `/v1/projects/{project_id}/prompt-candidates/bulk-delete` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]`
- `/projects/[id]/intent/social-scraping`
- `/projects/[id]/prompt`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 권한: 목록 = 활성 멤버 또는 admin(core.auth.resolve_project active_member, 비멤버 404: 현행 prompt/page.tsx:43, 메인 정정 2026-09-28), 승격·삭제 = 활성 Owner 또는 admin. 라우터 공통 = 역할(hq·region·country·admin·vendor) + 메뉴 project.
- 목록 키셋(created_at DESC, candidate_id DESC, 기본 200). 공통 필터 축은 지원하지 않고 meta.ignored_filters 로 표기.
- 다른 프로젝트 후보 id 는 not_found 로 돌려주고, 한 건도 없으면 404 candidate_not_found. 승격 원본은 풀에 남는다.

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `GET /v1/projects/{project_id}/prompt-candidates?include_total=false`(B023): 전체 건수 COUNT 를 세지 않고 `meta.page.total` = null(행·커서는 같다).
  건수를 따로 아는 화면(홈 타일은 상세 candidate_count)용. front `fetchRecentCandidates(..., {include_total: false})`.
- `POST …/prompt-candidates/screen` 은 ids_only 묶음이 없다(행 읽기 상한 1~500 그대로).
