# analytics.citations.targets · 분석 조회 / 인용 / 타겟·자사 URL 인용률

설계 단위: C-4 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/citations/targets` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/website/answer-analysis/citation`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28, an-cit-b)
- 응답: `data{measured, target: Ratio|null, owned: Ratio|null}`(퍼센트는 프론트). `meta.source` = 발행값 `{origin: report, publication_slugs}`
  (합산에 실제로 들어간 발행물만) 또는 라이브 `{origin: live, reason}`(core R09_* 사유: engine_axis·period_range·no_publication·
  not_website·empty_window). 출처·사유 판정은 core `url_rates` 한 곳에 있다(core 5라운드 an-cit-b R4·R7).
- 값: `core.measure.url_rates`(K-1 과 공유). 웹사이트 스냅샷(또는 회차 하나를 고른 기간 from = to) + 활성 웹사이트 발행물 + 기본 엔진이면
  발행값(R09, 헤드라인 풀 규칙은 core), 그 밖은 라이브.
- 표면: website·project 가 값. global = 422 `surface_unsupported`. project 분모 = cit_in 답변 전체(web_reg 게이트 없음, Q5·core D-url-denominator).
- 억제(지표 키 target_url_rate·owned_url_rate): hidden(인용 숨김 회차) · source_filter(source[] 가 오면 현행처럼 카드 생략) · no_measurement(분모 0) · `*: no_active_snapshot`.

## 명세·현행과 다른 점(2026-09-28 2차, 검증 D1~D6 반영)
- provenance 키: 명세 `publication_slug`(단수) 대신 `publication_slugs`(목록). 브랜드 범위 발행물이 한 회차에 여럿일 수 있어서다.
  목록은 합산에 들어간 발행물만이다(검증 D1: 관점 밖 brand_scope 발행물 slug 비노출).
- 헤드라인 풀(검증 D2 → core D-headline): 선택에 풀 유닛이 있으면 풀 유닛만 합친다(현행 publishedSubtotal 과 같다). 출처 목록도 풀 유닛 발행물만.
- 하루짜리 기간(검증 D3 → core D-R09): `from = to` 가 발행 회차면 스냅샷처럼 발행값(현행 resolveReportTruthRoute 와 같다).
- 테스트: `tests/test_citations_targets_staged.py` 가 `prompts/tests/staged.pgsql` 조각(@website·@pub_*)을 core 롤백 전용 준비로 넣는다.

## BG 보강(2026-09-28, bg-citations: BG-26 인용 URL 카드 부분)
- 발행값이면 `meta.source.publications[{slug, cycle_label, cycle_label_en, round_date, site_count, headline_pool_applied, manifest_verified}]`
  를 더한다(현행 카드 툴팁의 회차 라벨 ko·en·기준일·사이트 수). 값은 core `report_publications`(추가형, 발행값 합산 report_values_sql 과 같은
  선택 술어: 스코프·요청 축·헤드라인 풀)에서 오고 `publication_slugs` 에 든 발행물만. 라이브면 키를 더하지 않는다(기존 모양).
- 테스트: `tests/test_citations_targets_bg.py`(발행물별 site_count 합 = report_values_sql units 대조 포함).
