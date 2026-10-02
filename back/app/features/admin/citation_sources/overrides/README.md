# admin.citation_sources.overrides · 운영 관리 / 인용 출처 / 도메인 카테고리 오버라이드

설계 단위: AD-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/admin/citation-overrides` | low |
| GET | `/v1/admin/citation-overrides/candidates` | medium (website 1년) |
| GET | `/v1/admin/citation-overrides/categories` | low |
| PUT | `/v1/admin/citation-overrides/{domain}` | low |
| DELETE | `/v1/admin/citation-overrides/{domain}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/standards/citation-sources`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28)
- 권한: 인증 + role=admin + 메뉴 그룹 admin. 스코프 교집합 없음(관리자 전량). 관리 기능이라 후보 조회에 표면 경로 게이트를 걸지 않는다
  (`resolve_read_context(surface_gate=False)`: 관리 메뉴만 가진 admin 도 surface=global 후보 200). cf.* 는 core 가 쿼리에서 읽는다(무시 축).
- 후보: 공통 필터 `surface`(필수)·`from/to`(기본 = core 함대 스냅샷 최신 노출 회차, 최대 366일 초과 422 `window_too_large`)·`source[]`(카테고리 slug,
  명세의 `category[]`)·`limit`(기본 500, 최대 5000). 인용 계열 창(숨김 {1,2} 배제), 모수 `cit_in`·`source_key <> 0`.
  창이 날짜 하나면 api_ro, 여러 날짜면 admin_long(`meta.source.pool`). 오버라이드 도메인은 상위 N 밖·0건이어도 포함, `override.propagated` 로 적재 반영 여부 표시.
- 쓰기: upsert·삭제 + 분류가 바뀌면 같은 트랜잭션 `judgment_change('citation_override', subject_texts=[domain], payload{op, old, new, category_key})`.
  노트만 바뀌면 요청 없음(`propagation none`). 같은 도메인 대기 요청 중이면 409 `duplicate_pending`(롤백). 도메인은 소문자·선행 www. 제거.
- EXPLAIN(로컬 합성): 스냅샷 `citation_g_202609`·웹사이트 `citation_w_202609` 리프만 스캔(surface·round_date 가지치기).
- BG-42(값 갭 보강, 2026-09-28): 후보 행에 `shadows_owned`(bool, 추가형) = 오버라이드가 있고 그 도메인이 당사 공식 도메인이면 참(현행
  `overrideShadowsOwned` source.ts:44-50, 경고 배지). 당사 판정 = 현행 `ownedBrandOf`(owned.ts:108): 도메인이 당사 등록 도메인과 같거나
  `.등록 도메인` 으로 끝남(서브도메인 포함). 원천 두 가지를 OR(CASE 로 오버라이드 행만): ① `app.owned_base` kind 'base' 의 host(서로 다른 host 43개 =
  규칙 목록 GEO_OWNED_DOMAINS 42개 + kia.com 서브도메인 worldwide.kia.com, EXCLUDED_OWNED_DOMAINS 반영 후) ② 적재기 선계산
  `rd.dim_source.owned_brand_bit ≠ 0` 비소셜 출처 키. 둘 다 서픽스 일치라 인용 적재 이력이 없는 당사 도메인(genesis.com)·당사 서브도메인
  (news.hyundai.com)도 참이고, notkia.com·kia.com.evil.io 같은 문자열 우연 일치와 카탈로그 제외 도메인(kia.by)은 거짓이다.
  - 검증 결함 D1(e172d92, 2026-09-28): 첫 구현은 `skey = domain` 정확 일치만 봐서 위 두 부류가 항상 거짓이었다. 회귀 = `test_d1_*`
    (독립 기대값은 이관 규칙 원천 `migration/seed/seed-3x-rules.sql` `_r_owned_domain` 을 파이썬으로 서픽스 판정).
  - 2차 검증 결함 N1(6f0eefb, 2026-09-29): D1 의 보강 경로 ②를 `right(domain, len(skey)+1) = '.'||skey` 로 비교해 `owned_brand_bit`
    (인덱스 없음) 조건으로 오버라이드 행마다 `rd.dim_source` 를 전체 스캔했다. 도메인의 점 단위 접미 후보 배열
    (`a.b.hyundai.com` → `{a.b.hyundai.com, b.hyundai.com, hyundai.com, com}`, 빈 라벨 제외)을 LATERAL 로 오버라이드 행만 만들고
    `skey = ANY(후보)` 로 바꿔 유일 인덱스 `dim_source_skey_key` 를 탄다. ① owned_base(표 210행, kind 'base' 170행)도 같은 후보 배열과
    등호로 본다. 판정 의미는 같다.
    EXPLAIN(hmg_tpl v2.8 복제본, 비당사 dim_source 30만 행 + 오버라이드 300행, ANALYZE 후 EMPTY_CTE·lim 50, 한 트랜잭션 롤백, 각 3회):
    수정 전 `SubPlan Seq Scan on dim_source loops=301`(Rows Removed by Filter 300012/루프) Execution 2,338~2,443ms →
    수정 후 `Index Scan using dim_source_skey_key on dim_source loops=301`(`Index Cond: skey = ANY(...)`) Execution 12.8~13.0ms.
    접미 배열은 행당 1회 계산(SubPlan loops=301)이고, 남는 비용은 owned_base 행당 순차 필터(루프당 0.033ms)다.
    회귀 = `test_n1_*`(3만 행 합성: 계획에 dim_source Seq Scan 없음·skey 인덱스 조회, 수정 전 식은 Seq Scan loops ≥ 300 재현,
    판정 결과가 수정 전 서픽스 식과 행 단위로 같음·경계 사례 10종). 수정 전 SQL 로 돌리면 인덱스 단언이 실패함을 확인했다.
  - 남는 한계: 당사 등록 도메인 목록은 app.owned_base(이관 시드) 기준이다. 현행 front 의 카탈로그(GEO_ENTRIES·EXCLUDED)가 바뀌면 시드
    재적재 전까지 어긋날 수 있다(적재기 owned_brand_bit 와 같은 조건).
