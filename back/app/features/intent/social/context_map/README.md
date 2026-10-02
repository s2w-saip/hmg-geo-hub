# intent.social.context_map · 고객 관심 / 소셜·컨텍스트 맵 / 컨텍스트 맵 조회·내보내기

설계 단위: IN-2, CM-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/intent/social/context-map/stats` | low |
| GET | `/v1/intent/social/context-map/contexts` | low |
| GET | `/v1/intent/social/context-map/conditions` | low |
| GET | `/v1/intent/social/context-map/combinations` | low |
| GET | `/v1/intent/social/context-map/entities/{entity_id}` | low |
| GET | `/v1/intent/social/context-map/export` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/intent/social-scraping`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 필터 결정(2026-09-28 검증 D2 반영)
- `lang` 은 export 에서만 자기 파라미터(시트·헤더 언어)다. stats·contexts·conditions·combinations·entities 에서는 공통 필터 축이라
  meta.ignored_filters 에 `lang` 을 싣는다(CM-1 filters.ignored lang[]).

## 설정·내보내기
- 활성 스냅샷을 고를 산업·LLM 산업 라벨은 core.config(`context_map_industry_entity_id`·`context_map_keyword`, env HGH_CONTEXT_MAP_*)다.
  산업 미설정이면 활성 스냅샷이 정확히 1개일 때만 쓴다.
- xlsx 는 core.xlsx(SheetSpec·auto_widths) + core.export.xlsx_response(여러 시트 스트리밍, no-store, 비ASCII 파일명 filename*)로 쓴다.
  시트명 규칙(31자·금지 문자·중복 접미)은 core.xlsx 가 적용한다.
