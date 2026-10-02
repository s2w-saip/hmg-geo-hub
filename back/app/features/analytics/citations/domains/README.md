# analytics.citations.domains · 분석 조회 / 인용 / 인용 도메인 순위

설계 단위: C-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/citations/domains` | high (웹사이트 1년) / 스냅샷 low |
| GET | `/v1/citations/domains/export` | high (웹사이트 1년, 전량 5,000행 상한) |

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

## 구현 메모(an-cit-a)
- 응답: `summary{total_citations, unique_sources, own_share(Ratio), answers_den}`, `items[]`(skey 순위, 키셋 `meta.page`), `competitor_totals[]`.
- 인용 원소 스캔은 core `citation_where`·`own_expr`, 출처 키(source_key)로 먼저 접은 뒤 rd.dim_source 로 접는다(QUERY-FIXES C-1).
- `shared.py` 는 인용 네 기능 공용(필터 지원 축·읽기 문맥·응답 모델). 유효 카테고리(운영자 오버라이드 우선)·source[] 축은 core
  `measure.CATEGORY_EXPR`·`source_where`(citation_where 가 건다), 카테고리 표시 정보는 core `Refs.category_refs`.
- `limit` 는 0~200(모듈-인용 §2 PageIn, 0 = 요약 전용). `mention_brand` 는 제어문자 금지(422).
- 표면 게이트: core `auth.require_surface`(route-policy 역할 천장: global = hq·region·country·admin, website = + website, project = + vendor,
  계정 menu_groups 좁히기)를 core `resolve_read_context` 가 첫 줄에서 건다. 403 `role_forbidden`·`menu_forbidden`(회귀: tests/test_surface_gate.py).

## BG 보강(2026-09-28, bg-citations: 프론트 어댑터 값 갭 BG-20·21·22·24, 검증 수정 D1~D5 반영)
- 새 필드(선택, 기존 필드·의미 그대로): `items[].citing_prompts`(BG-24, 이 출처를 인용한 DISTINCT 프롬프트 수 = 현행 표 '프롬프트' 열),
  `items[].rank`·`items[].match_rank`(BG-21, 둘 다 인용 수 내림차순·skey 오름차순 번호). 현행 '#' 열은 표면마다 매기는 시점이 달라 두 벌을 싣는다:
  - `rank` = 경쟁사 선택(competitor[]) 뒤, 검색(q)·skey[]·정렬 전 모집단 번호 = 표준 표(citations-standard-view.tsx:559-560, applyCompetitorPick → 번호 → 검색).
  - `match_rank` = competitor[]·q·skey[] 를 모두 적용한 행 안의 번호(정렬 무관) = 웹사이트·프로젝트 표(citations-view.tsx:277-280, 검색 → 번호).
- BG-21 `q`(skey 부분 일치, 대소문자 무시, 와일드카드 글자 그대로) · `sort`(citations|share|coverage|prompts|skey) · `dir`(asc|desc,
  기본 skey = asc, 그 밖 = desc). 동률은 rank 오름차순(현행 표가 인용 순 배열을 안정 정렬하는 것과 같다). 기본 정렬 커서는 이전과 같은 모양.
  share·coverage 정렬은 원시 수가 아니라 표시값(반올림 퍼센트, 현행 pctOf = Math.round(n/d*1000)/10) 기준이다(검증 D3): 정렬 키 =
  천분율 정수 floor(n*1000/d + 0.5)(정확 소수, 내보내기 pct1 과 같은 0.5 올림), 표시값이 같은 행은 rank 순. 현행 JS 는 부동소수 나눗셈이라
  n/d*1000 이 정확히 x.5 인 경계에서만 이론상 다를 수 있다. 이 두 정렬의 커서 sort 식별자는 share_pm·coverage_pm(원시 수 커서와 구분).
- BG-20 `skey[]`(최대 100): 고른 출처 행만. `competitor[]`(최대 100) = 현행 경쟁사 선택(?competitor=, applyCompetitorPick):
  유효 카테고리가 공식(경쟁사)인 행 중 고른 skey 만 남기고 다른 카테고리 행은 그대로. rank 는 이 선택 뒤 다시 매긴다. `competitor_sources=true`: `data.competitor_sources[{skey, domain, brand, citations}]`
  (유효 카테고리 = 공식(경쟁사), 운영자 오버라이드 반영, 인용 수 내림차순, 상한 500, q·skey 무관) = 현행 competitorDomainOptions.
  설계 제안은 `/v1/filters/options.competitor_sources` 였으나 그 경로는 다른 그룹(filters) 소유라 같은 모집단을 계산하는 이 응답에 선택 필드로 둔다.
- q·sort·skey·competitor 는 행과 `meta.page.total` 만 좁힌다(limit=0 에서도 total = 좁힌 행 수, 검증 D4).
  skey[]·competitor[] 는 집합 의미라 커서 필터 해시 전에 sorted(set()) 로 정규화한다(순서·중복만 바꾼 다음 페이지 요청도 같은 커서, 검증 D5). 요약·경쟁사 합·share·coverage 분모는 전체 모집단(현행 표도 받은 전 행을 클라이언트에서
  거르고 정렬해 값은 그대로였다). 새 파라미터가 기본값이면 커서 필터 해시에서 빠진다(기본 요청 커서 = 이전과 같다).
- BG-22 `GET /v1/citations/domains/export`: 목록과 같은 필터·검색·정렬·선택으로 전량(상한 5,000행, 넘으면 `X-Export-Truncated: true`).
  `format`(xlsx 기본|csv) · `locale`(ko 기본|en: 열 이름·카테고리 표시 = front messages 와 같은 문구). 열 = 현행 onExport 7열
  (#·도메인·카테고리·인용 수·점유율·프롬프트·커버리지), 점유율·커버리지는 퍼센트 소수 1자리(0.5 올림, 현행 pctOf 와 같다).
  `rank_basis`(global|match): '#' 열 = rank|match_rank. 기본은 표면별 현행 규칙(global = 표준 표 → rank, website·project = citations-view →
  match_rank). `max_rows`(1~5,000): 정렬 뒤 상위 N 행(현행 표준 표 내보내기 = 상위 100, DOMAIN_RANK_LIMIT), 이 값으로 자른 것은
  X-Export-Truncated 를 붙이지 않는다. 표준 화면 경쟁사 선택 내보내기 = `competitor[]` + `max_rows=100`(행 구성·번호가 현행 파일과 같다).
  감사: core `access_audit(download, citations.domains.export)`. 경로는 드릴다운 `{skey:path}` 보다 먼저 등록된다(레지스트리 순서 domains → domain_detail).
- 주 스캔을 (출처, 프롬프트) 해시 집계 → 출처 합산 두 단계로 바꿨다(DISTINCT 프롬프트를 정렬 없이). 합성 200만 인용(글로벌 회차 하나,
  출처 3만·프롬프트 2천) 로컬 비교: 이전 문장(출처 인덱스 순 GroupAggregate) 중앙값 7.8s, 새 문장 4.7s, count(DISTINCT) 대안 6.6s,
  기존 열 값 동일. 파티션은 회차 월 리프 하나만 읽는다.
- 테스트: `tests/test_domains_bg.py`(준비 = prompts/tests/staged.pgsql @global + `tests/bg.pgsql`).
