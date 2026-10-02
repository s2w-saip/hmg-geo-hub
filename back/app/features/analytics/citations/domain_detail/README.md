# analytics.citations.domain_detail · 분석 조회 / 인용 / 도메인 드릴다운

설계 단위: C-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/citations/domains/{skey}` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/analysis/citation`
- `/projects/[id]/analysis/mention`
- `/standard/answer-analysis/citation`
- `/standard/answer-analysis/mention`
- `/website/answer-analysis/citation`
- `/website/answer-analysis/mention`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(an-cit-a)
- 경로 skey 는 공식 소셜 계정 키처럼 `/` 를 포함할 수 있어 path 변환기로 받는다(OpenAPI 경로는 `{skey}` 그대로). 모르는 skey 는 404.
- 상한은 현행 계승: URL 10 · 프롬프트 12 · 프롬프트당 답변 참조 8. urls[].country 는 자사 URL 의 owned base 국가(그 밖 null). dim_url.geo_code 판정 열은 보류(DECISIONS-API 5라운드).
- 답변 참조는 (인용 수 내림차순, answer_key) 로 8건을 자른 뒤에만 rd.job PK 로 job_id 를 붙인다(최대 96행, C-3 과 같은 규약).
- 경로 skey·mention_brand 는 제어문자 금지(core 값 규칙과 같음, 422). 표면 게이트는 core `require_surface`(resolve_read_context).

## BG 보강(2026-09-28, bg-citations: BG-23·BG-25)
- BG-25 `urls_limit`(1~200, 기본 10) · `prompts_limit`(1~100, 기본 12) · `answers_limit`(1~20, 기본 8): 기본값은 현행 상한 그대로.
  새 필드 `url_total`·`prompt_total` = 자르기 전 전체 수(긴 꼬리 표시). rd.job PK 조인은 여전히 자른 표본(rs)에만(최대 100 × 20).
  embed(도메인 순위 선적재)는 하지 않는다(갭 표 BG-25 에서 선택). 근거: 어댑터 설계 컴포넌트 수정 #6(front-adapter-plan.md:378,
  :1476 '펼칠 때 조회'): 표 행마다 미리 부르지 않고 행을 펼칠 때 이 경로를 부른다.
- BG-23 `urls[].prompt_text`: 그 URL 의 가장 이른 인용(round_date·answer_key·ord 순) 프롬프트 텍스트(톤 드릴다운 prompt_text 와 같은 규칙,
  현행 CitationUrlLive.promptText 는 measured_at 순 첫 인용).
- 테스트: `tests/test_domain_detail_bg.py`.
