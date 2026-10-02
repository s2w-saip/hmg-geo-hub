# intent.keywords.tracked · 고객 관심 / 키워드 / 추적 키워드

설계 단위: IN-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/intent/keywords?project_id=` | low |
| POST | `/v1/intent/keywords?project_id=` | low |
| DELETE | `/v1/intent/keywords?project_id=&ids=` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/intent/google-keyword`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 중복 결정(2026-09-28 검증 D6 반영, DB-v2.6 P44)
- 중복 = 같은 프로젝트에 term_norm(NFC·trim·lower)과 유효 국가(저장 국가, 없으면 프로젝트 국가)가 같은 행 → 409 duplicate_keyword.
- 저장 국가가 프로젝트 국가와 같으면 NULL 로 저장한다. 판정은 DB 유니크 `project_tracked_keyword_norm_uq`
  (project_id, term_norm 생성 열, coalesce(country_code, ''))가 하고 INSERT … ON CONFLICT DO NOTHING 으로 받는다. 현행(원문 유니크)과의 이탈이다.
- term_norm 정본 = DB `app.term_norm`(DB-v2.7 P55, 생성 열도 이 함수). 목록의 최신 검색량 조인도 생성 열 값을 쓴다(파이썬 정규화 안 씀, 검증 m-5).
- 저장 국가 = `app.project.country_code` 와 같은 ISO 대문자(DB-v2.7 P54 CHECK `ptk_country_upper`, 검증 m-4). 응답 `country_code` = 저장값(대문자),
  `country` = 프리셋 id(소문자).
