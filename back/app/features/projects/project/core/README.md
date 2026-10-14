# projects.project.core · 프로젝트 / 프로젝트 / 프로젝트 CRUD

설계 단위: PJ-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects` | low |
| POST | `/v1/projects` | low |
| GET | `/v1/projects/creation-options` | low |
| GET | `/v1/projects/by-scope/{scope_project_id}` | low |
| GET | `/v1/projects/{project_id}` | low |
| PATCH | `/v1/projects/{project_id}` | low |
| DELETE | `/v1/projects/{project_id}` | low |

## 값 갭 보강(bg-projects, 추가형)
- BG-36 `GET /v1/projects/by-scope/{scope_project_id}`: Scope 콘솔 딥링크 해석. 고객 프로젝트(admin ∨ 활성 멤버) → `{kind:"project", project_id}`,
  아니면 웹사이트 사이트(웹사이트 표면 게이트 + 분석 읽기 문맥과 같은 브랜드·국가 스코프) → `{kind:"website", brand_code, country_code}`, 그 밖 404.
  프로젝트 행이 있으면 사이트로 넘어가지 않는다(현행 by-scope/[scopeId]/page.tsx 순서).
  404 본문은 하나다(`{code:not_found, message:"대상 없음"}`): 미지 id·standard_root·비멤버 프로젝트·스코프 밖 사이트를 구분할 수 없게 한다
  (검증 D1, resolve_project 의 존재 은닉과 같은 원칙).
- BG-37 `GET /v1/projects/creation-options`: 생성 폼 선택지. 게이트·어휘가 POST 와 같다(비생성자 403 operator_forbidden).
  A-10(결정 13, 2026-09-30): 계정 `scope_brands` 가 app.brand 전 코드(엄브렐러 포함)를 담으면(이관 R1 이 현행 빈 brands 계정에 채운 값,
  `brand_scope_covers_all`) 현행 빈 brands 분기처럼 권역 정본 브랜드만 준다(Hyundai N·HMG 제외, POST 도 같은 판정이라 403 brand_forbidden).
  조회 가시성(DataScope)은 이 판정을 쓰지 않는다(Hyundai N 웹사이트 사이트 조회 유지). 결과는 늘 계정 목록의 부분집합이다.
- BG-38 `GET /v1/projects/{project_id}` 에 선택 필드 prompt_counts·candidate_count·active_member_count·last_run_at·target_brand·recent_prompts
  (POST·PATCH 응답은 null). recent_prompts = 삭제 제외 프롬프트 updated_at 내림차순 상위 5(`{prompt_id, text, status, updated_at}`, 동률 prompt_id
  내림차순). 현행 대시보드 '최근 프롬프트'(project-dashboard.tsx:120-122)가 목록 전량 순회 없이 채워진다(검증 D4, 목록 API 는 created_at 순만 준다).

### 선택지 순서(creation-options, 검증 D2·D3)
| 값 | 서버 순서 | 현행 화면 순서 | 화면 동일을 위한 어댑터 처리 |
| --- | --- | --- | --- |
| brands(계정 브랜드 스코프 있음) | 계정 `scope_brands` 저장 순 | 같음(scope.brands) | 없음 |
| brands(전체) | `app.brand.sort_order`(Hyundai·Kia·Genesis, qa 옵션과 같은 DB 표시 순) | GEO_BRANDS 첫 등장 순(Hyundai·Genesis·Kia, lib/geo-catalog/index.ts:26) | front `GEO_BRANDS` 인덱스로 재정렬 |
| brands(전 코드 목록 계정, A-10) | `app.brand.sort_order`(Hyundai·Kia·Genesis) | 현행(빈 brands) GEO_BRANDS 순(Hyundai·Genesis·Kia) | 어댑터는 세션 brands(4개 목록) 순으로 재정렬해 Hyundai·Kia·Genesis 로 보인다(집합 같음, 순서만 다름) |
| countries(계정 국가 스코프 있음) | 계정 `scope_countries` 저장 순(중복은 첫 등장) | 같음(scope.countries.filter) | 없음 |
| countries(국가 스코프 없음) | 국가 코드 순 | 권역 정의 순(허용 브랜드 순 → rhq-map.json 권역 순 → 권역 안 국가 순, scope-policy.ts:297-307) | front `projectCreationOptions` 와 같은 순회로 만든 순서의 인덱스로 재정렬(집합은 서버 값) |

- 서버가 현행 순서를 못 주는 이유: 카탈로그 첫 등장 순과 권역·권역 국가 정의 순이 DB 에 없다(app.brand.sort_order 는 다른 순서, app.rhq_region·
  app.rhq_region_country 에 순서 열 없음). 순서 열 추가는 DB 변경이라 CORE-REQUESTS/bg-projects.md R1 로 요청했다. 들어오면 서버 정렬로 옮기고 어댑터 재정렬을 뺀다.
- 권역 선택 뒤 국가 목록(`countriesForRhq(region) ∩ allowed`)은 현행도 front rhq 상수로 만들고 이 API 값은 집합(allowedSet)으로만 쓰인다.
- BG-47 `GET /v1/filters/options?surface=project` custom_fields 순서 = 생성 순(created_at, field_id). 파일은 analytics.filters.options/queries.py.

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects`
- `/projects/[id]`
- `/projects/[id]/ai-funnel/acr`
- `/projects/[id]/ai-funnel/conversion`
- `/projects/[id]/ai-funnel/visibility`
- `/projects/[id]/analysis/citation`
- `/projects/[id]/analysis/mention`
- `/projects/[id]/intent/google-keyword`
- `/projects/[id]/intent/social-scraping`
- `/projects/[id]/member`
- `/projects/[id]/prompt`
- `/projects/[id]/setting`
- `/projects/new`
- `/projects/by-scope/[scopeId]`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 선택 파라미터(백로그 P1~P12, 2026-10-14). 전부 선택 인자: 주지 않으면 응답 모양·값·문장이 종전과 같다
- `GET /v1/projects/{project_id}?view=gate`(B020): 프로젝트 게이트용 경량 조회. 같은 접근 판정·같은 404, 게이트 행(GATE_DETAIL)만 읽고
  effective_engines·요약 필드는 null(target_brand 는 같은 문장에서 채운다). 기본 full = 종전(상세 + 요약 BG-38).
  front `fetchProjectGate(id, {light: true})`·`requireProjectPage` 가 고른다.
