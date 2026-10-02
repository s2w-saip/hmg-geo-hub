# intent.social.prompts · 고객 관심 / 소셜·컨텍스트 맵 / 생성 프롬프트

설계 단위: IN-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/intent/social/prompts?project_id=` | low |
| POST | `/v1/intent/social/prompts?project_id=` | medium |
| DELETE | `/v1/intent/social/prompts?project_id=&ids=` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/intent/social-scraping`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## LLM·커넥션
- LLM 은 core.llm(LlmDep·call_llm)으로 부른다. 키 미설정 503 llm_unavailable, 호출 실패 502 llm_failed. 산업 라벨 = core.config context_map_keyword.
- 생성(POST)은 LLM 을 기다리는 동안 요청 커넥션을 쥐지 않는다: 계정 CurrentUserDetached, 권한(operate)·시드 읽기 RoSession 짧은 트랜잭션,
  쓰기 get_db().write. 메뉴 게이트는 라우터 dependencies 대신 경로별(GET·DELETE require_menu_group, POST 핸들러 안 check_menu_group).
