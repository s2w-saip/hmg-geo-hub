# catalog.prompts.catalog · 프롬프트 카탈로그 / 프롬프트 / 카탈로그·측정 메타

설계 단위: P-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/prompts?surface=global` | medium (10배 약 2.4만 행 페이로드) |
| GET | `/v1/prompts?surface=website` | high (기본 정렬 last_measured 가 매 페이지 전 기간 rd.answer_w 집계) |
| GET | `/v1/prompts?format=csv` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/standard/prompts`
- `/website/prompts`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`
- `screen_export.py` 웹사이트 내보내기 화면 모양(BG-35) · `names_data.py` 국가·언어 표시명 표(생성물, 손으로 고치지 않는다) · `names_gen.mjs` 그 생성기(Node, `node names_gen.mjs`)

## 구현 요약(2026-09-28, core 6라운드 반영)
- 경로 하나(`GET /v1/prompts`)가 세 변형을 맡는다. 라우트 게이트: global = hq·region·country·admin ∧ 메뉴 standard, website = + website 역할 ∧ 메뉴 website(vendor 403). 판정은 `core.auth.check_role`·`check_menu_group`.
- 응답: `data.items` + `meta.page{next_cursor, limit, total}`(core.envelope 규약), `meta.mode = catalog`, website 는 `meta.generation`.
- global: 루트 카탈로그(soft-delete 제외), 스코프 = 브랜드 ∪ 엄브렐러(app.brand.is_umbrella)·NULL ∩ 대상 시장 3분기(B1). 술어는 `core.filters` 의 `catalog_brand_scope`·`catalog_market_scope`·`catalog_market_filter`(P-2 와 한 벌). 키셋 정렬 depth1·depth2·depth3(NULL 뒤)·left(text,256)·prompt_id, limit 기본·상한 500(Q19 서버 페이징).
  필터: brand·country(regions 정확 포함)·lang·funnel·brand_presence(파생값)·list_type·depth1~3·depth4·kind·measured·search. 택소노미 값은 app.prompt 열 값 그대로 비교한다(`resolve_read_context(..., resolve_taxonomy=False)`: rd.dim_taxon 사전 밖 값도 dropped 없이 매칭, 미발행 행 전용 값 포함. catalog #8 = front prompt-list-readonly.tsx:172-182).
- website: 사이트 브랜드 비트 ∈ ReadContext.bgrps(가상 브랜드 코드 반영) ∧ 스코프 국가. 요청 국가 축은 `ReadContext.website_site_ok(국가, 사이트 브랜드 비트)` 행 필터(ISO ∪ 가상 브랜드 합집합, catalog #9 = front websiteSiteGeoPred).
  사이트 해석은 카탈로그 전용(app.website_site 기준, 측정 이력 없는 사이트 포함): catalog #10 처분(core 해석은 분석용 rd.dim_project 기준이라 이관 기각).
  측정 메타 = rd.answer(surface 2) 원시 카운트, 게이트 없는 측정 회차 전부(`resolve_window(all_visible=True, ungated=True)` + `Window.where(keys=win.all_keys())`: 발행·노출일·숨김 무관, catalog #11 = front website-sites.ts:386-407). 렌즈 engine[]·from/to(round_date)는 행을 거르지 않는다(from/to 가 있으면 그 기간, 없으면 측정 회차 전부).
  정렬 prompt·brand·country·lang·target_url(모양 A: 행 키셋 후 페이지 키만 집계) / answers·last_measured(모양 B: 전 범위 집계 후 키셋, 커서에 세대 → 바뀌면 409 cursor_stale, OpenAPI 409 문서화). limit 기본 50·상한 200.
  키셋 키 = (sn NULL 플래그, sk 정렬값, website_prompt_id). last_measured 의 미측정(NULL)은 방향과 무관하게 뒤(sn), 자리값은 실날짜 1900-01-01
  (date.min 은 asyncpg 가 -infinity 로 인코딩해 커서 비교가 깨졌다: 검증 D1).
  project_id(사이트 좁히기) = app.website_site 의 site_id 또는 scope_project_id, 스코프(bgrps·스코프 국가) 안에서 해석. 측정 이력 없는 사이트도 된다(검증 D7).
  404 는 스코프 밖·없는 사이트만이다. 요청 국가(country)는 해석 뒤 행 필터라 스코프 안 사이트와 어긋나면 200 빈 목록(검증 catalog N1).
- format=csv|xlsx: `core.export.export_response`(CSV UTF-8 BOM·수식 주입 무력화, xlsx 스트리밍·인라인 문자열 셀, Content-Disposition·no-store·X-Export-Truncated). 같은 필터·정렬 상한 50,000. 다운로드 접근 감사(kind download).
- (BG-34, 2026-09-28 값 갭 보강) global `all=true` = 전량 모드(선택 파라미터, 기본 false): 같은 키셋 한 페이지를 상한
  `service.GLOBAL_ALL_MAX`(25,000)까지 준다. 넘으면 조용히 자르지 않고 `meta.page.next_cursor` 로 이어 받는다(`meta.page.limit` = 25,000).
  함께 준 `limit` 은 all 없이와 같은 형식 검증(1~500, 밖이면 422)을 거치고, 형식이 맞으면 쓰지 않은 값으로 `meta.ignored_filters` 에 `limit` 을 드러낸다(검증 m-1).
  `all`·`columns`·`locale` 은 필터 해시에서 뺀다(행 집합·정렬 불변: 전량 모드 커서를 일반 키셋으로 이어도 되고, 추가 전 커서도 그대로 유효).
  website 의 all 은 `meta.ignored_filters`. front 근거 = standard/prompts/page.tsx:43 listStandardCatalogScoped(전량 적재, 클라이언트 필터).
  성능(로컬 합성 25,006행, admin 스코프): 쿼리 실행 167ms(Seq Scan 782 버퍼 + Sort external merge 6.8MB, 행 전부를 정렬하므로 인덱스 이득 없음),
  요청 전체 약 390ms·응답 11MB. Kia US 스코프 11,253행 74ms·요청 약 200ms. 이전 방식(500×커서 연쇄)은 같은 규모에서 51회 × 약 50ms.
  현행 규모(2,431행)는 한 번 호출로 끝난다.
- (BG-35) 웹사이트 내보내기 `columns=screen`(선택, 기본 api) · `locale=ko|en`(선택, 기본 ko, screen 과 함께만) = 현행 화면 파일 모양
  (front app/api/website/prompts/export/route.ts:63-98, lib/website/prompt-export.ts:55-83): 8열(프롬프트·브랜드·국가·언어·타겟 URL·측정 횟수·
  최근 측정·측정 엔진), 머리글·'측정 없음'·시트 이름·파일 이름 `웹사이트-프롬프트-<KST 오늘>.xlsx`(ASCII 대체 website-prompts-…) =
  messages/{ko,en}.json website.prompts.* 값(`screen_export.LABELS`), 국가·언어 = 표시명(의사 국가 코드 정본 라벨 → Intl.DisplayNames 를 옮긴
  표 + 조립 규칙 `names_data.py`(생성물, 생성기 `names_gen.mjs`, Node 26.8.1·ICU 78.3) → 모르면 Intl 과 같은 코드 정규화), 측정 횟수 = 숫자 셀,
  최근 측정 = YYYY-MM-DD 또는 '측정 없음', 엔진 = 코드 ', ' 연결.
  표시명 범위(검증 m-2 반영): 언어 두 글자·세 글자, 문자 체계(sr-Latn·zh-Hans-CN), 지역 두 글자·숫자(419·150·001), 별칭(840 → US·UK → GB·
  SU → 언어별 대표 지역·sh → sr-Latn·sgn-US → ase), 방언 이름(de-CH '고지 독일어(스위스)'·nl-BE '플라망어'), 한정어 안 괄호 → 대괄호.
  대조: '언어-지역'·'언어-문자' 전수(각 로케일 약 90만 태그)와 '언어-문자-지역' 표본 30만 태그를 Node Intl 과 비교해 불일치 0(생성기 출력·로컬 대조).
  회귀: 테스트 `test_names_match_intl_sample`(생성기가 뽑은 Intl 표본 tests/names_intl_sample.json)·`test_language_name_matches_intl_regressions`.
  행 집합·정렬·측정 메타는 api 모양 파일과 같은 조회다(바뀌는 것은 열 모양뿐). csv 도 같은 모양(수식 주입 무력화는 core.export 그대로).
  잘못된 조합은 422: screen 을 global·json 에, screen 의 locale 이 ko|en 밖(빈 값·KO 포함), columns 가 api|screen 밖.
  locale 은 columns=screen 일 때만 쓴다. screen 이 아니면(추가 전처럼) 값과 무관하게 무시한다: 파일은 locale 없이와 바이트가 같고,
  json 목록은 meta.ignored_filters 에 locale(검증 m4: front 내보내기 링크 export-button.tsx:22-26 는 늘 &locale= 를 싣는다).
  어댑터가 현행 파일 모양을 원하면 columns=screen 을 붙여야 한다(없으면 api 모양). 다운로드 감사 detail 에 columns·locale 을 더한다.
  파일 행 순서 = 현행 파일(동점 website_prompt_id ASC, 다른 점 2).
- 커서 복원 뒤 DB 입력 오류는 `fetch_keyset(..., cursor=cur)` 로 422 cursor_invalid(core 최후 방어).
- 렌즈 회차 키는 `cyc_key = ANY(배열)` 그대로다. 배열 1,000 초과 시 차원 semi-join(catalog #6)은 성능 전용이라 stg 실측 게이트(웹사이트 기본 뷰 1초) 결과로 판단한다(보류).

## 명세와 다른 점(모듈-프롬프트.md 대비, 테크 리드 확인 대상)
| # | 명세 | 구현 | 이유 | 결정 |
| --- | --- | --- | --- | --- |
| 1 | 측정 메타에 servable(발행) 게이트를 걸지 않음(8절 열린 질문 5, 현행 패리티) | 현행 패리티 반영: 발행·노출일·숨김 게이트 없는 측정 회차 전부(core `ungated`·`all_visible`·`Window.all_keys`) | 메인 결정 catalog #11(front website-sites.ts:386-407 websitePromptLens) | **반영**. 테스트 `test_website_lens_uses_core_visible_window`(core 창 인자)·`test_website_lens_ungated_parity`(비발행·미래 노출·hidden_scope 1 회차를 staged 로 만들어 손계산 대조) |
| 2 | 동점은 website_prompt_id asc | json 목록(키셋)만 동점도 요청 dir 과 같은 방향. 내보내기(csv·xlsx, columns api·screen 모두)는 키셋이 아니라 명세대로 동점 website_prompt_id ASC(= 현행 파일 front website-sites.ts:500-504 'wp.id ASC', 검증 m1) | core.pagination.keyset_predicate 는 행 값 비교(모든 열 같은 방향)만 지원 | 목록은 필요하면 core 에 혼합 방향 키셋 요청. 회귀 test_export_tie_order_matches_current_file |
| 3 | 긴 본문 정렬(prompt·target_url)은 전체 문자열 | 앞 256자(left) 후 id(유지) | DB 에 본문 길이 상한이 없어(app.prompt.text·website_prompt.prompt_text·target_url 모두 text) 전체 문자열 키는 커서가 쿼리 문자열 상한(cursor max_length 4096)을 넘을 수 있다. core `decode_cursor(text_max=…)` 는 8192 까지 넓힐 수 있지만 URL 길이가 먼저 막힌다. 256자는 기본 text_max(512) 안 | 유지(앞 256자가 같은 행끼리만 순서가 id 로 갈린다) |
| 4 | 요청 country[] 의 의사 시장 코드 | 지리 의사 시장 코드 x:WW·x:EU·x:ME 는 시장 필터 값(스코프 검사 없음, regions 정확 포함·정규화), 허용목록 밖 x:* 는 dropped | 메인 결정 catalog #7 = front 현행(prompt-markets.ts:25 GEO_PSEUDO·:54-57 isGeoFilterable·:110-118 matchesMarket) | 반영: `core.filters.split_geo_pseudo`·`GEO_PSEUDO_MARKETS`(P-1·P-2 공통), 회귀 test_global_geo_pseudo_market_filter |
| 5 | global 은 전량(cursor·limit 무시) | 기본은 키셋 500 유지, 전량은 `all=true`(상한 25,000, 넘으면 next_cursor) | 기존 응답 의미 보호(기본 limit 500·상한 501 은 422 유지) + 무상한 금지 | BG-34 반영(추가형) |
| 6 | 국가·언어 표시명은 front Intl.DisplayNames | 같은 Intl 결과를 표 + 조립 규칙(names_data.py, 생성기 names_gen.mjs)으로. 규칙 = 언어 이름 + (문자, 지역), ko '언어(한정어)'·en '언어 (한정어)', 한정어 안 괄호는 대괄호, 별칭 정규화 후 방언 이름(ko de-CH '고지 독일어(스위스)'·nl-BE '플라망어'·fa-AF '다리어'·ro-MD '몰도바어', en de-AT 'Austrian German' 등)은 표. 3글자 언어·문자 체계·숫자 지역(M.49)·폐지 지역(SU 등)도 Intl 과 같다 | 백엔드에 ICU 없음(pip 금지). 남은 차이: 변이·확장 하위 태그(en-US-POSIX 등, Intl '영어(미국, Computer)')는 코드 그대로(현행 데이터 모양 밖: 사이트 언어 태그는 언어[-지역]) | BG-35 반영(검증 m-2 로 범위 확대). ICU 버전이 바뀌면 `cd back/app/features/catalog/prompts/catalog && node names_gen.mjs` 로 재생성(입력 파일 없음: 코드 공간 전수, 약 40초, 산출 names_data.py·tests/names_intl_sample.json, 표본은 시드 고정이라 재실행 결과가 같다) |
