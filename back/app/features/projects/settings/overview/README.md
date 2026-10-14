# projects.settings.overview · 프로젝트 / 프로젝트 설정 / 설정 묶음

설계 단위: PJ-4 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects/{project_id}/settings` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]`
- `/projects/[id]/analysis/mention`
- `/projects/[id]/setting`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `GET /v1/projects/{project_id}/settings?view=card`(B022): 홈 KPI 카드용. engines·brand_aliases·vehicles = null, competitors = 지정 비교
  브랜드(is_target) 행만. domain·owned_bases·tracked_url_count 는 같다. 기본 full = 종전. front `fetchProjectSettings(..., {view: "card"})`.
- 문장 수(B022, 값 같음): 접근 판정 뒤 프로젝트 행·추적 URL 건수·자사 브랜드 별칭 행·기본 엔진을 한 문장(service `PROJECT_BUNDLE`)으로 읽고
  목록 표(owned base·경쟁사·차종)만 따로 읽는다.
