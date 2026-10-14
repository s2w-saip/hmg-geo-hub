# analytics.trend.series · 분석 조회 / 추이 / 지표 추이

설계 단위: T-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/trend` | medium (dimension=brand·source 1년 high) |

## 파라미터·응답(구현)
- 공통 필터(`CommonFilters`, 지원 축 = `core.filters.KPI_SUPPORT` + `source`(T-1 명세) + 글로벌 `lang`(BG-01), 밖의 축은 `meta.ignored_filters`)
  + `bucket`(cycle·week·month, 기본 cycle) · `dimension`(none·engine·brand·source·category·type, 기본 none) · `metrics`(M01~M08 또는 이름, 콤마·반복)
  · `top`(1~50, 기본 10) · `brand_key[]`(dimension=brand 전용, BG-11) · `split_own`(dimension=brand 전용, D13, 기본 false).
- 기간 미지정 = 최근 12 버킷(Q9). 원장 자리(R11) 버킷만 만들고, 수집 오류 숨김 회차는 갭 자리(`gap_reason=collection_error`), 운영자 전체 숨김 회차는 자리 아님.
- `data.series[].points` 는 `data.buckets` 와 같은 순서. 값은 `ratio{num,den}` 또는 `rank{sum,count}`(M04). 갭 사유 no_answer·analysis_pending·hidden·collection_error.
- 웹사이트 M06·M07: 차원 none·기본 엔진이면 bucket=cycle 은 회차별 R09 발행값(`origin=report`) 또는 라이브(`origin=live`).
  주·월 버킷(core 9라운드, fe-u4 요청 3)은 그 버킷의 인용 계열 회차가 하나면 그 회차 값(발행이면 report), 둘 이상이면 버킷 라이브.
  현행 front 웹사이트 추이는 M06·M07 을 그리지 않아(live-trend-chart.tsx:39-46, trend-kpi-family.ts:26) 카드 규칙 truth-axes.ts:95-101 을
  버킷에 옮겼다. 엔진 분리·그 밖 표면은 라이브. 회귀 test_d5_website_r09_report_origin·test_week_bucket_r09_folds_only_single_round.
- 인용 정확도 `citation_accuracy`(코드 ACC, website·project, **요청할 때만**: 기본 목록·기존 응답 불변. WU-9 2026-10-01): 현행 웹사이트 추이 ⑥ 선
  (front website/_data/live.ts:246-272 = 회차별 타겟∧자사 답변 ÷ 자사 URL 인용 답변, 발행값을 읽지 않음)과 같은 쌍 `(tgt_own_hits, own_url_hits)`,
  항상 버킷 라이브(`origin` null). M06·M07 이 발행값인 회차에서도 라이브다. 회귀 `tests/test_trend_accuracy.py`.
- 자리 있는 버킷의 `no_answer` 는 계열별 모수로 판정한다: 언급 계열 = 언급 계열 회차 답변, 인용 계열 = 인용 계열 회차의 cit_in 답변(검증 D1:
  언급만 숨긴 회차의 인용 지점이 비지 않는다).
- `source[]`(인용 출처 카테고리 slug): M05·M09·M10 을 그 카테고리 출처의 인용으로 좁힌다(분자·분모 모두). 언급 계열·M06·M07 에는 적용하지 않고,
  요청에 적용 대상 계열이 없으면 `meta.ignored_filters` 에 `source`. 모르는 slug 는 `dropped_filters`.
- `surface=global` 에 `project_id` 를 주면 값은 루트 프로젝트 그대로이고 `meta.ignored_filters` 에 `project_id`(검증 D4 방어).

### 값 갭 보강(BG 라운드, 전부 추가형)
| 항목 | 요청 | 응답 | 규칙 |
| --- | --- | --- | --- |
| BG-01 | 글로벌 `lang[]` | 값에 적용 | 답변 언어 축(core 빌더 lang_key). 글로벌 M05 는 언어로 좁힌 자사 허용 배열(원소 스캔). 모르는 값은 `dropped_filters` |
| BG-07 | `dimension=type`(metrics 생략 또는 M08·type_exposure) | 유형 5종 계열(key = mention·recommendation·comparison·definition·final_choice) | 분자 = 그 유형 신호가 있는 당사 답변(`/v1/mentions/types` 당사 행 술어), 분모 = 버킷 답변(M01 분모). 갭은 언급 계열 규칙 |
| BG-09 | (없음) | sentiment(M03) 지점 `negative` | 부정 신호 수(분모 = `ratio.den`). 당사 = rd.answer sent_neg, 경쟁 = answer_brand s_neg. 다른 계열·갭은 null |
| BG-10 | (없음) | `buckets[].measured_days` | 버킷 답변(cit_in, 필터 축, 계열 합집합 회차)의 rd.job.measured_at KST 고유 일수. 답변 없는 자리는 0 |
| 성능 A1(core 10) | `measured_days`(쿼리, 기본 true) | `buckets[].measured_days` | false 면 계산하지 않고 모든 버킷 null(rd.job 조인 문장 생략). 값을 쓰지 않는 호출(KPI 탭 커버리지 라벨 밖)용. 결과 캐시 선언 파라미터(원문 쿼리로 키에 들어간다) |
| BG-11 | `brand_key[]` | top 밖 경쟁 계열 추가, 경쟁 계열 `brand_key` | 창에 행 있는 요청 브랜드(순위순) 뒤에 행 없는 요청 브랜드(이름순, 0 지점). 모르는 키·관점 브랜드 키·창에 competitive 행이 없는 비경쟁 브랜드(`rd.dim_brand_name.kind` 3, 검증 V2·D6)는 `dropped_filters.brand_key`. 다른 차원이면 422 |
| BG-48 | (없음) | `own_label`·당사 계열 `label` | `/v1/mentions/brands` `own.vp_label` 과 같은 규칙(관점 하나 = brand_code, 여럿 = 엄브렐러 brand_code) |
| D13 | `split_own=true` | 관점 비트가 둘 이상이면 당사 계열을 브랜드별로(key = `own_brand_code` = brand_code, is_own, `brand_key` = 같은 이름의 `rd.dim_brand_name` 키, 없으면 null) | core `measure.split_own_scopes`(비트 오름차순, 모수·필터는 관점 전체, own_bits 만 분리). 관점 하나면 기존 'own'. 다른 차원이면 422. 행 키 계약: 정본 키 = `own_brand_code` = 그 비트의 부모 브랜드 코드(`Refs.brand_code_of_bit`: 관점 [Hyundai N, Kia] → Hyundai·Kia, 하위 브랜드 단독 관점은 비트 하나라 가르지 않는다), mentions 그룹과 잇는 키 = `brand_key`(`/v1/mentions/brands` 당사 행과 같은 조회 규칙: 이름 = 관점 brand_code, 검증 V1). core 공용 판정은 `split_own_scopes(ms)` 하나(mentions 그룹 9f33bb5 도 같은 함수·같은 키 식, 검증 2차 D1) |
- 게이트: 인증 + 표면별 메뉴 그룹(global = standard, website = website, project = project). 스코프·관점은 `core.filters.resolve_read_context`.

## 명세(T-1)와 다른 점
| 항목 | 명세 | 구현 | 근거 |
| --- | --- | --- | --- |
| 값 모양 | 비율 값 | 정수 쌍 `ratio{num,den}`·`rank{sum,count}` | P3(퍼센트는 프론트) |
| 엔진 분리 | `engine_split=true` | `dimension=engine`(시리즈 key = 엔진 코드) | Q9, 차원 파라미터 하나로 통일 |
| 당사 라벨 | (meta) | `data.own_label` | core Meta 공통 필드로 올리지 않음(Meta 확장은 상속 규약, core envelope 머리) |
| source[] 와 다른 계열 | 시리즈별 ignored 미정(열린 질문) | 적용 대상(M05·M09·M10)이 하나라도 있으면 표시 없음, 없으면 `ignored_filters` | meta 가 요청 단위라 시리즈별 목록을 담을 곳이 없다 |
| source[] 지원 축 | 지원 | 기능이 `KPI_SUPPORT + source` 로 선언, 값은 core source 축(M05 원소 스캔·M09·M10 queries.mix_counts_sql, 술어 = core citation_where) | 엔드포인트별 지원 축 선언은 기능 소유(계약 §4) |

## 현행과 다른 값(known_diff 후보, A4 고지 대상)
등록은 mig 소관이라 `back/CORE-REQUESTS/bg-trend-geo.md` 에 요청했다. 값은 아래 규칙으로 고정했고 회귀 테스트가 차이를 재현한다(`tests/test_trend_bg_fix.py`).

| id | 계열 | 현행 front | API | 확정 경로 |
| --- | --- | --- | --- | --- |
| V3·D4 (BG-07) | `dimension=type` 분자 | 당사 롤업 행 전부(비경쟁 표기 포함)의 유형 bool_or(scope-aggregates.ts:10568-10596) | competitive 당사 행만(`/v1/mentions/types` M-2 와 같은 술어). 적재 규칙상 당사 행도 competitive 거짓일 수 있어 분자가 현행 이하 | M-2 F08·F10 패리티 대조로 확정(모듈-언급 미결 1번과 같은 쟁점). M-2 결정이 바뀌면 `queries.type_counts_sql` 의 `b.competitive` 를 같이 바꾼다 |
| V4·D3 (BG-10) | `buckets[].measured_days` | (프롬프트·엔진·국가) 셀 대표 1건(kpiTabCellSnapshot DISTINCT ON, scope-aggregates.ts:9730)만 → 엔진별 `date_trunc('day', measured_at)`(DB 세션 TZ) 고유 일수 → max(scope-aggregates.ts:10551·10563) | 차이 셋: (1) 셀 대표가 아니라 버킷 답변 전부(is_rep 무관, cit_in·필터 축·계열 합집합 회차: core 지표 분모와 같은 답변 집합), (2) 엔진 합집합, (3) KST 날짜(설계 A-G5). 합집합·전부이므로 현행 이상. 재현: 회차 10(09-07) k16(비대표, 09-07)·k17(대표, 09-21)·k18(대표, 09-21) → API 2, 현행 1 | 패리티 대조. 현행 값을 유지해야 하면 `dimension=engine` 계열별 measured_days 선택 필드를 추가형으로 더한다 |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/dashboard`
- `/projects/[id]`
- `/projects/[id]/analysis/citation`
- `/projects/[id]/analysis/mention`
- `/standard/answer-analysis/citation`
- `/standard/answer-analysis/mention`
- `/website`
- `/website/answer-analysis/citation`
- `/website/answer-analysis/mention`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `dims[]`(B101, 최대 5, 반복): 같은 요청에서 함께 낼 차원. 항목 = `dimension[:metric,…][@top]`(dimension = none|engine|type|source|category,
  brand 는 기본 `dimension` 으로만). metric 생략 = 그 차원 기본 세트, top 생략 = 요청 top. 형식 오류·중복(기본 dimension 포함)·top 1~50 밖은 422,
  지표 오류는 기존 `unknown_metric`·`metric_not_supported` 422.
- 응답 `data.dims[]` = 항목 순서의 `{dimension, series, meta}`. 그 차원만 따로 부른 응답(같은 필터·bucket·card·measured_days)의 series·meta 와 같다.
  buckets·own_label 은 공유, 최상위 data·meta = 기본 dimension. dims 를 주지 않으면 키가 없다.
- 보내는 곳: front `trend.ts` `fetchTrendDims`(언급 = engine + none·type, 인용 = source + category).
- 내부 생략(파라미터 없음, 값 같음): brand 계열 base·비트별 당사 합계 한 문장·요청 지표 열만(B100), url_rates 가 main 문장 urls 열 재사용(B102).
