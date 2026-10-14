# analytics.citations.sources · 분석 조회 / 인용 / 출처 카테고리

설계 단위: C-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/citations/sources` | high (웹사이트 1년) / 스냅샷 low |
| GET | `/v1/citations/sources/types` | medium~high |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/analysis/citation`
- `/standard/answer-analysis/citation`
- `/standard/answer-analysis/citation/tone-urls`
- `/website/answer-analysis/citation`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(an-cit-a)
- `/sources` = 카테고리 분포(M09) + 엔진×카테고리 + 톤 타일 + 유형×카테고리(Q19 로 `/sources/types` 를 합침). 요청당 문장 2개
  (성능 R2 2026-10-01: 카테고리·유형 = 인용 1회 스캔, 톤 = 톤 있는 답변만 (톤, url) 해시 집계 + 답변 수는 rd.answer.cit_n. 종전 3문장과 동치:
  `tests/test_sources_equiv.py`, stg hmg_r2 9/28 무필터 EXPLAIN 1,969 → 916ms).
- `/sources/types` 경로는 taxonomy 정본이라 유지하고 같은 계산의 types 부분만 낸다.
- source[] 는 분포·톤 타일·유형 모두에 적용(모듈-인용 §8 열린 질문 1 권장안, A4 고지 대상).
- 표면 게이트는 core `require_surface`(core `resolve_read_context` 첫 줄, 403 role_forbidden·menu_forbidden).

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `include_tone`(B098): false = 톤 타일 문장을 돌리지 않고 `data.tone` = 0 타일.
- `include_types`(B098): false = 유형 × 카테고리(답변 열 65열·유형 플래그·당사 유형 재집계)를 계산하지 않고 `data.types` = [](빈 배열).
- categories·by_engine·total_citations 는 같다. 웹사이트·프로젝트 인용 화면은 둘 다 false 로 보낸다(톤·유형을 그리지 않는다).
