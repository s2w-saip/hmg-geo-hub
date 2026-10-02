# intent.keywords.serp_drafts · 고객 관심 / 키워드 / SERP 프롬프트 초안

설계 단위: IN-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| POST | `/v1/intent/serp-drafts` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/intent/google-keyword`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 권한 결정(2026-09-28 검증 D3·D5 반영)
- 초안은 전역(serp_call_id 단위)이라 표준 화면 insight 에도 노출된다. 그래서 프로젝트 권한(메뉴 project + resolve_project(operate))으로 허용하는 것은
  그 SERP 의 (키워드 term_norm, location, language)가 그 프로젝트 추적 키워드(유효 국가 = 저장 국가, 없으면 프로젝트 국가)와 맞을 때뿐이다.
- 안 맞거나 project_id 가 없으면 메뉴 standard + admin·전역 운영자 + 그 SERP 국가가 스코프 안.

## LLM·커넥션
- LLM 은 core.llm(LlmDep·call_llm, 설정 core.config openrouter_*)으로 부른다. 키 미설정 503 llm_unavailable, 호출 실패 502 llm_failed.
- LLM 을 기다리는 동안 요청 커넥션을 쥐지 않는다: 계정 CurrentUserDetached, 읽기 RoSession(plan 까지만), 쓰기 get_db().write 짧은 트랜잭션.
