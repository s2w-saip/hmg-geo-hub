# qa.answers.list · 검수 콘솔 / 검수 대상 / 목록·진행률·이웃·필터

설계 단위: QA-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/qa/answers` | medium |
| GET | `/v1/qa/answers/progress` | medium |
| GET | `/v1/qa/answers/{job_id}/neighbors` | low |
| GET | `/v1/qa/filters` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/raw-data-qa/answers`
- `/raw-data-qa/answers/[jobId]`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 인증: 검수 게이트(Q17, HMAC 쿠키 `raw_data_qa` → qa_gate 풀) + 세션 행 존재 확인(core.auth.QaLiveConn). 일반 계정 JWT 로는 401, 폐기(행 삭제)된 세션도 401.
- 필터: `q` 는 앞뒤 공백을 다듬고 비면 필터 없음(현행 filters.ts). QA 가 지원하지 않는 공통 필터 축(택소노미·출처·`project_id`·`cf.<field_id>`·`own_brand`)은 core.filters.ignored_axes 로 `meta.ignored_filters` 에 알리고, `cf.*` 키·값 형식 오류는 core.parse_custom_fields 와 같이 422.
- 필터 옵션 reviewer: 서버 검수 범위 안 job 을 판정한 이름만.
- 공용 구성요소(`scope.py`): 서버 고정 검수 범위(core.config qa_surfaces·qa_since = HGH_QA_SURFACES·HGH_QA_SINCE), QaFilter·QaNoteFilter, job 술어 빌더, 좌표. qa 7개 기능이 함께 쓴다.
- 표면 이름은 core 어휘(global|website|project). 현행 화면의 'standard' 는 프론트 어댑터에서 global 로 바꾼다.
- 브랜드 좌표·필터·옵션은 app.brand(qa_gate SELECT, DB-v2.6 P47)로 푼다. 좌표는 app.brand 정렬 순 목록, 카탈로그 밖(bgrp 0)은 빈 목록.
