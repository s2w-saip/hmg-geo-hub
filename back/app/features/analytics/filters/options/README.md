# analytics.filters.options · 분석 조회 / 필터 / 필터 옵션

설계 단위: F-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/filters/options` | medium (스냅샷 low, 1년 high: RDS 실측 게이트) |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/dashboard`
- `/projects/[id]`
- `/projects/[id]/analysis/citation`
- `/projects/[id]/analysis/mention`
- `/standard/ai-funnel/acr`
- `/standard/ai-funnel/conversion`
- `/standard/ai-funnel/visibility`
- `/standard/answer-analysis/citation`
- `/standard/answer-analysis/mention`
- `/website`
- `/website/ai-funnel/acr`
- `/website/ai-funnel/conversion`
- `/website/answer-analysis/citation`
- `/website/answer-analysis/mention`
- `/website/prompts`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(F-1)
- 쿼리: `surface`(필수) · `project_id`(project 필수, website 는 사이트 하나로 좁힘) · `from`·`to`(쌍, 옵션 창). 그 밖의 공통 축
  (brand·country·lang·engine·funnel·brand_presence·list_type·depth1~3·source·`cf.*`)은 결과를 좁히지 않고 `meta.ignored_filters` 로 알린다.
- 게이트: 인증(CurrentUser) → 표면 메뉴 그룹(global=standard·website·project) → core 스코프(`resolve_read_context`). project 는
  admin·활성 멤버·스코프 안 비vendor 만 보이고 나머지는 404(core `resolve_project`).
- 창: 없으면 core 함대 스냅샷, 있으면 기간(`meta.mode` = snapshot|cumulative). 매트릭스·엔진 = row 계열(전체 숨김만 배제)·`cit_in`,
  출처 카테고리 = citations 계열(`citation_where`). 창이 비면 `meta.suppressed` 에 no_active_snapshot|no_cycles_in_period, 인용 숨김이면 hidden.
- data: `geo_matrix[{brand, region(국가 코드), lang}]` · `regions[{code, area(권역), kind}]` · `languages` · `engines[{code, is_default}]` ·
  `catalog{rows, funnel, brand_presence, list_type, depth1~3}`(global·project, website null) · `source_categories[{slug, name, ord}]` ·
  `custom_fields[{field_id, label, values}]`(project 만).

## 명세와의 차이(의도, 검증 M1·M3)
- 응답 필드 이름은 현행 프론트 계약 `MeasuredScopeCombo {brand, region, lang}`(front/components/dash/dimension-filter-panel.tsx:643)을
  따른다. 모듈 문서 `docs/design/api/모듈-필터.md` §2.2 의 `geo_matrix[{brand, country, lang}]`·`countries[{code, region, kind}]` 와
  값은 같고 이름만 다르다: `country` → `region`, `countries` → `regions`, 권역 `region` → `area`. 단위 JSON 의 내부 키(brand_bit·
  region_key)는 응답에 싣지 않고 코드로 낸다. 모듈 문서 §2.2 는 이 이름으로 동기화됐다(core 5라운드).
- 스냅샷 기준일 `meta.as_of` 는 core 함대 스냅샷(row 계열, hidden_scope 1 만 배제)이다. F-2 `latest_round_date` 는 family 별이라
  같은 값이 아닐 수 있다(F-2 README 참고). 모듈 문서 §7 의 "F-1 meta.as_of = F-2 latest_round_date" 는 최신 회차가 그 family 로
  숨겨지지 않았을 때만 성립한다.

## 값 갭 보강(2026-09-28, bg-kpi-filters)
- BG-03: `catalog.rows[].depth4`(global = 루트 카탈로그 행 app.prompt.depth4, project = 프로젝트 프롬프트)와 `catalog.depth4[{code, parent_code(depth3)}]`.
  들어온 `depth4` 쿼리는 다른 값 축처럼 `meta.ignored_filters` 에 적는다(옵션은 기간만 받는다. core 표식, 검증 D2).

## 현행 프로필 filter_options(F1W4, WU-8, 제품 결정 19·25, 2026-10-01)
설정 `HGH_LEGACY_PROFILE` 에 `filter_options`(또는 `current`)가 켜지면 글로벌·웹사이트 옵션을 운영 hmg-geo 2670a16 + `read_screens` 14키(축 on)
규칙으로 낸다. 꺼짐이면 위 규칙 그대로(바이트 동일). project 표면은 대상이 아니다(아래 "남긴 차이").

| 표면·축 | 현행 규칙(2670a16) | 켜짐 구현 |
| --- | --- | --- |
| 글로벌 국가(`regions`) | `listMeasuredRegions`(scope-aggregates.ts:7698, rootScoped·dateRange): 루트 카탈로그 ∧ 옵션 창 `optionAnchorJobClause`(:2073-2088, 회차 창 + 기본 엔진) ∧ 숨김 ∧ 스코프. 답변 상태·지역 스코핑(한국어 비-KR·시장 태그)·run 상태 술어 없음 | `queries.legacy_global_sql`: rd.job(모든 status, 드롭 제외) ⋈ rd.dim_prompt.in_root_catalog, 창 = core 창(row 계열), 엔진 = 기본 엔진 키, 스코프 = core `scope_where` + `expand_brands` |
| 글로벌 매트릭스·언어 | `listMeasuredScopeMatrix`(:7846)·`listMeasuredStandardLanguages`(:7889): 같은 창 + `status = 'completed'` | 같은 소집합의 served 행만(`build_legacy_global`). 그래서 `regions` ⊇ 매트릭스 국가(현행 두 목록과 같다) |
| 웹사이트 국가 | `listWebsiteCountries`(website-sites.ts:258-281): 등록 사이트 country_code ∪ 사이트 브랜드 가상 코드, 전용 사이트 계정은 그 코드만. 측정 창 무관 | `build_legacy_website`: app.website_site(관점 브랜드 비트 ∧ `DataScope.site_allowed`) |
| 웹사이트 매트릭스·언어 | `listWebsiteScopeMatrix`(:216-254)·`listMeasuredLanguages`(:176-197): website_prompts ⋈ website_sites (사이트 브랜드, 국가, lang_code 원값) + 가상 코드 행, 전용 계정은 모 브랜드 | 같은 규칙(app.website_prompt) |
| 엔진(글로벌·웹사이트) | 정적 `["chatgpt","gemini"]`(dimension-filter-panel.tsx:165, 두 페이지가 engineOptions 를 넘기지 않음) | `default_engines`: rd.dim_engine.is_default 전부(창·스코프 무관). 창이 비어도 억제하지 않는다 |

- 권한: 스코프 교집합(관점 브랜드·스코프 국가·권역 전개·전용 사이트 코드)은 켜짐에서도 그대로다. 켜짐이 새로 여는 행(실패 답변·지역 스코핑 밖
  답변·측정 없는 등록 사이트)도 같은 술어를 지난다(`tests/test_legacy_switch.py` 레드팀: 계정 유형별 스코프 밖 국가·브랜드 0).
- 웹사이트 숨김 시장(app.hidden_market website)은 켜짐에서도 뺀다(현행에는 이 개념이 없다. 허브 데이터 축이 버리는 시장을 옵션만 되살리면
  죽은 옵션이 되므로 좁히는 쪽을 유지).
- 결과 캐시: app.website_site·app.website_prompt 는 추적 표가 아니다. 켜짐 + website 요청은 끝점 추가 키 `legacy_web`(두 표 md5 지문,
  요청마다 같은 스냅샷에서 다시 읽음)를 키에 싣는다(`tests/core/test_wu8_options_cache.py`, 표 커버 = `test_result_cache_tables.py` SIGNATURE).
- 남긴 차이(이 스위치 밖, 결정 필요): project 표면 국가(현행 = 계정의 전 기간·전 프로젝트 측정 국가 `listMeasuredRegions(scope)`,
  projects/[id]/page.tsx:76, U4-N10)·엔진(U4-N11). 현행을 재현하면 vendor(브랜드 스코프 없음)에게 HMG 전체 측정 국가 목록이 보인다.

## WU-12(2026-10-01): 선택 브랜드 좁힘·출처 카테고리 명시 요청
- 선택 브랜드(filter_options 켜짐): 현행 옵션 함수는 `optionScope = narrowScopeBrands(user.scope, filters.brand)`(hmg-brands.ts:177-186)를 받는다.
  글로벌은 국가·언어만 좁히고 매트릭스는 계정 스코프 그대로(dashboard/page.tsx:195-215), 웹사이트는 국가·매트릭스·언어 모두(website/page.tsx:167-173).
  브랜드 스코프 계정은 readStandardFilters 하드락(standard-filters.ts:73-76)으로 URL brand 를 무시하므로 허브도 무시한다(ignored 유지).
  웹사이트의 현행 판정은 역할(admin)이지만 결과 캐시 키에 역할이 없어 전체 스코프로 판정한다(admin ⇒ 전체 스코프, Q16).
  모르는 브랜드 코드는 현행처럼 공통 행만 남기고 meta.dropped_filters.brand 에 적는다(결과 캐시에 저장하지 않는다).
- 출처 카테고리: `include=source_categories` 를 줄 때만 계산하고 주지 않으면 `data.source_categories = null`(meta.suppressed 에도 없음).
  현행 화면의 출처 필터는 정적 목록(dimension-filter-panel.tsx DIMENSIONS.source = CITATION_CATEGORIES)이고 허브 프론트도 이 필드를
  읽지 않는다(lib/hgh/adapters/filters.ts toPanelOptions). 계산할 때의 문장은 DISTINCT source_key 를 먼저 접는 형태(queries.py 주석, 결과 동일).
  stg hmg_r2 서버 시간(ASGI 직접, cache-miss, 3회): 글로벌 무필터 815 → 143ms, 웹 1년 1,185 → 39~86ms, include 지정 시 글로벌 356ms·웹 1년 336ms.
