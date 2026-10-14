# analytics.geo.markets · 분석 조회 / 국가별 / 국가별 현황

설계 단위: GEO-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/geo` | medium (1년 high) |

## 파라미터·응답(구현)
- 공통 필터: global = brand·country·lang·engine·period + 택소노미 6축(funnel·brand_presence·list_type·depth1~3), website = brand·country·lang·engine·period.
  그 밖 축은 `meta.ignored_filters`. `surface=project` 는 422 `surface_not_supported`(Q8).
  (BG-01·BG-02 보강: 글로벌 lang[] 은 답변 언어 축, 글로벌 M05 는 언어로 좁힌 자사 허용 배열이면 core 원소 스캔. 택소노미는 rd.catalog_entry 로 푼 prompt_keys)
- 기간 미지정 = 함대 스냅샷(Q1), 기간 지정 = D1 누적. 권역 트리는 관점 브랜드가 하나일 때만(아니면 `markets=[]`, `meta.suppressed.markets=brand_required`).
- 국가·권역 행: 당사 M01~M05(`ratio`·`rank`), 순위(our·field_size), 선두 자사 브랜드, 최대 경쟁사(형제 HMG 브랜드 제외: 브랜드 격리). 권역 = 국가 원시값 합.
- 웹사이트는 언급 수 지표만(Q8): 점유율·순위·경쟁사만 채우고 나머지는 null + `meta.suppressed` 사유 `website_mentions_only`.
  사실 집계도 그 범위만 센다(B094, 파라미터 없음): core `fetch_counts` part `sov`(답변 수·당사 언급·전체 언급)와 `brand_rows(mentions_only=True)`
  (경쟁 행 언급 수). 노출·감성·순위 열은 계산하지 않고, 응답은 전 열로 센 종전 응답과 바이트가 같다(`test_geo.py` B094 시험).
- `surface=global` 에 `project_id` 를 주면 값은 그대로이고 `meta.ignored_filters` 에 `project_id`(검증 D4 방어).
- 게이트: 인증 + 현행 showsGeoMap(scope_all 또는 admin·hq·region) + 표면별 메뉴 그룹(global = standard, website = website).

## 명세(GEO-1)와 다른 점
| 항목 | 명세 | 구현 | 근거 |
| --- | --- | --- | --- |
| 값 모양 | `{value, numerator, denominator}` | 정수 쌍 `Ratio{num,den}`·`RankAvg{sum,count}` | P3 |
| 국가 표시명 | `GeoCountryRow.country_name` | 싣지 않음(`code` 만) | `rd.dim_country` 에 표시명 열 없음. 현행도 프론트 정적 카탈로그 `geoLocateByCode`(로케일 의존)로 붙인다. 프론트 유지(DECISIONS-API GEO-1) |
| 최대 경쟁사 | `top_rival{brand, share_of_voice}` | `top_rival{brand, metrics{visibility, share_of_voice, sentiment, position, citation_share}}` | 현행 marketStats 가 경쟁사 지표 묶음을 낸다. 점유율은 `metrics.share_of_voice`(검증 D3) |
| 당사 라벨 | `meta.own_label` | `data.own_label`(BG-48: `/v1/mentions/brands` `own.vp_label` 과 같은 규칙, 여럿이면 엄브렐러 brand_code) | core Meta 공통 필드로 올리지 않음(Meta 확장은 상속 규약) |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/dashboard`
- `/website`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`
