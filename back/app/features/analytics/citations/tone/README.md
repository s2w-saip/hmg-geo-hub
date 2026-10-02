# analytics.citations.tone · 분석 조회 / 인용 / 답변 톤별 인용

설계 단위: C-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/citations/sources/tone` | medium~high |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/standard/answer-analysis/citation/tone-urls`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(an-cit-a)
- 파라미터: `tone`(필수 positive|negative) · `group_by`(url|source, 기본 url) · `q`(url 모드 = 화면 표시 URL, source 모드 = skey, ILIKE) · `limit`(1~200) · `cursor`.
- 정렬 = 인용 수 내림차순, 동률 url 모드 url_hash · source 모드 skey. 전체 행 수(검색 반영)는 `meta.page.total`.
- 행 `key` 는 유일 식별자(url 모드 = url_hash 16진, source 모드 = skey), 화면 라벨은 `display`(url 모드 표시 URL 은 프래그먼트·스킴만 다른 두 URL 이 같을 수 있다).
- `q` 는 제어문자 금지(422 unprocessable, loc = q).

## BG 보강(2026-09-28, bg-citations: BG-27)
- `with_counts=true` 면 `data.counts{positive, negative}` = 두 톤의 DISTINCT 인용 URL 수(= /v1/citations/sources tone.*.urls, 현행 탭 카운트).
  검색 q·group_by 와 무관하고 커서 필터 해시에도 넣지 않는다. 한 문장 추가(톤 타일 문장의 URL 열만).
- 테스트: `tests/test_tone_bg.py`.
