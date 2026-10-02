# analytics.mentions.brands · 분석 조회 / 언급 / 브랜드·경쟁사 비교

설계 단위: M-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/mentions/brands` | medium (1년 high) |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/dashboard`
- `/projects/[id]`
- `/projects/[id]/analysis/mention`
- `/standard/answer-analysis/mention`
- `/website`
- `/website/answer-analysis/mention`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현(2026-09-28)
- 파라미터: 공통 필터(`MENTIONS_SUPPORT`: global = brand·country·lang·engine·period·택소노미, website = brand·country·lang·engine·period,
  project = country·engine·period·택소노미·custom, source 는 전 표면 ignored) + `top_n`(1~100, 10) · `sort`(mentions|share|avg_rank) · `brand_key[]`(각 1~2^31-1, 넘으면 422).
- 응답 `data`: `totals{answers, mentions_total, brand_count}` · `own{vp_label, brands, rank, mentions, exposure, share, avg_rank}` ·
  `brands[]{brand_key, name, is_own, rank, mentions, exposure, share, avg_rank, sentiment}`. 비율 = Ratio, 평균 순위 = RankAvg|null.
- 원천: 당사 = `core.measure.fetch_counts`(rd.answer 당사 열), 경쟁 = `core.measure.brand_rows`(QUERY-FIXES M-1), 순위 = `rank_brand_items`,
  당사 감성 4계열 = rd.answer_brand 당사 행(`queries.own_sentiment_sql`). brand_key 0(이름 없음) 제외.
- 필터 지원·창·억제는 `common.py`(언급 세 기능 공용). 표면 경로 게이트는 core `require_surface`(resolve_read_context 첫 줄).

## 값 갭 보강(BG 라운드, 2026-09-28). 전부 선택 인자: 주지 않으면 응답 모양·값이 위와 같다
- `split_own`(D13, bool): 관점 비트가 둘 이상이면 당사 행을 관점 브랜드별로 가른다. 판정은 trend 그룹과 공용인 `core.measure.split_own_scopes(ms)`
  (비트 오름차순, 비트 하나면 `()`), 행 키 `own_brand_code` = 그 비트의 부모 브랜드 코드(`common.own_brand_code_of_bit` =
  `Refs.brand_code_of_bit`, trend/series `_own_parts` 와 같은 식: 관점이 [Hyundai N, Kia] 여도 비트 1 키는 `Hyundai`). 가른 행 = 그 비트만
  관점으로 둔 당사 열·감성. 당사 합계는 관점 전체 + 비트별을 rd.answer 한 번 스캔(`own_counts_sql`, 비트마다 FILTER, 엔진별도 한 번)으로 센다
  (예전에는 비트마다 fetch_counts 를 다시 불렀다, 검증 D7). 가른 행 `brand_key` = 행 키 이름의 rd.dim_brand_name 키(없으면 null).
  순위·`totals.brand_count` 는 가른 행 기준, `own` 블록은 합친 관점 그대로. 관점 비트가 하나면 가르지 않는다
  (응답이 split_own 없이 부른 것과 같고 `own_brand_code` 키가 없다). 추이(`/v1/trend?split_own=true`, feat/bg-trend-geo)·유형(M-2)도 같은 판정·행 키다:
  같은 관점이면 두 그룹 분리 행의 (own_brand_code, brand_key) 집합이 같다(`tests/test_mentions_brands_fix2.py` 계약 시험, trend 통합 전에는 건너뜀).
  합친 1행(단일 관점)의 `brand_key` 는 두 그룹의 종전 계약 그대로다(여기는 관점 코드 키, trend 합친 'own' 계열은 null).
- `include[]`(prompts·multi·types·hmg): `prompts`(등장 고유 프롬프트 수, BG-12) · `multi{mentions, answers, prompts}`(한 답변 안 언급 ≥ 2, BG-13) ·
  `types{mention, recommendation, comparison, definition, final_choice}` + `data.types_total`(당사 + 전 경쟁 행 합, 컷 이전, BG-14) ·
  `is_hmg_own`(rd.dim_brand_name.own_bit ≠ 0, 관점 밖 형제 포함, BG-15). 당사 행 prompts·multi 는 rd.answer 당사 열(`own_extras_sql`),
  경쟁 행·유형은 rd.answer_brand 경쟁 행(`brand_extras_sql`).
- `group_by=engine`(BG-16): `data.by_engine[]{engine, totals, brands[]}` = 엔진마다 같은 순위·선택 규칙(당사 + 경쟁 상위 top_n). 엔진별 행은
  `own_brand_code`·`is_hmg_own` 만 싣는다. 엔진별 값 = `engine=<e>` 필터로 부른 값. 블록 = 창 안 std_in 답변이 있는 엔진만(answers 0 블록 없음,
  검증 D4: 창 WHERE 가 cit_in 이라 분석 대기 답변만 있는 엔진이 빈 블록으로 나왔다). 블록 answers 합 = `totals.answers`.
- `q`(BG-19): 경쟁 브랜드 이름 부분 일치(대소문자 무시, 1~100자). `full`(BG-19): 경쟁 행 전량(top_n 무시, 상한 `FULL_CAP` 2000) + `data.truncated`.
