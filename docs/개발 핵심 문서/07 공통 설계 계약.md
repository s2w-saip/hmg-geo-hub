# hmg-geo 재설계 · 기능 단위 모듈 설계 공용 계약 (v2, 2026-09-27: DB 설계 v2 확정 반영)

모든 설계 작업(API 단위 설계·모듈 설계·통합)이 따르는 기준. 결정은 이미 끝났다: 다시 논의하지 말고 설계에 반영한다.

## 1. 확정 결정 (명세서 §11)
- D1 기간 누적 = 앵커 날짜(KST)가 기간 안인 **모든 완료 측정** 합산. D2 H-Cloud 미고려, 백엔드 FastAPI. D3 RDS for PostgreSQL 17. D4 이관 범위 전체.
- D5 우선 노출도 = 평균 순위(순위 합 / 순위 있는 답변). D6 카드 = 같은 기간 추이 버킷 합(단위 통일). D7 HMG 보안 요구(AFW) 제외.
- **D8 파생 층 없음**: 요약 사실표·사전 집계·매트뷰·결과 캐시 금지. DB 구조 재설계와 쿼리 최적화만으로 성능을 만든다.
- A1 스냅샷 = 최신 노출 회차의 모든 완료 측정. A2 URL 인용률 = 측정 단위(가산형). A3 mixed 감성은 분모 포함·긍정 제외. A4 과거 회차 재계산 + 1회 고지. A5 리포트 발행값 우선 유지. A6 기간 비교 Δ 켬.
- A7 프론트 Vercel(icn1). A8 Supabase Auth 유지 + FastAPI 가 JWT(JWKS) 검증. A10 Scope API 20분 pull, 적재 트랜잭션 안에서 판정. A12 원천 있으면 실데이터, 없으면 "준비 중". A13 병행 운영·화면 그룹 순차 전환. A14 서울 + CDK.
- A15 ACR 반복 측정은 표준 지표 모수에 run-셀당 1건. A16 언급 분석 없는 측정은 모수에서 빼고 결손 표시. **A17 같은 DB 안 읽기·쓰기 스키마 분리**: 쓰기 = 넓은 원본(적재 최적화), 읽기 = 같은 그레인의 좁은 투영(정수 키·판정 컬럼·파티션·커버링 인덱스), 적재 트랜잭션 안에서 함께 갱신.

## 2. 규칙·지표·필터 (명세서 정본)
- 명세서 템플릿: `notes/hmg-refactor-spec/spec.template.html`
  §2 원칙 P1~P7 · §4 공통 필터 모델 · §5 규칙 R01~R13 · §6 지표 M01~M12 · §8 API 초안·응답 공통 형태 · §9 권한.
- 응답 공통 형태: `{ data, meta: { surface, mode, as_of, cycles, generation, ignored_filters, dropped_filters, suppressed } }`.
- 공통 필터 모델(모든 읽기 API 공유, FastAPI query parameter model): surface, own_brand(서버 결정), brand[], country[], lang[], engine[], from/to(앵커 날짜), funnel[], brand_presence[], list_type[], depth1~3[], source[]. 지원하지 않는 축은 `meta.ignored_filters`, 권한 밖 값은 `meta.dropped_filters`. 권한 스코프는 서버가 계산해 교집합(default-deny).
- 관점 브랜드 X 의 모수 = 카탈로그 brand X ∪ 공통(HMG) 프롬프트(`components/dash/standard-filters.ts:64`).

## 3. 데이터 모델 (확정 DB 설계 v2, 2026-09-27)
- **확정 DDL(정본)**: `notes/hmg-refactor-design/db/DB-v2.sql` (빈 PG17 적용·스모크 통과, `db/DDL-VERIFY.md`). 설계 설명: `db/DB-보정.md`. 결정 26건: `db/DECISIONS.md`.
- **스키마 경계(A17)**: 기능 API(api_ro)는 `rd`·`app`·`ext` 만 읽는다. `ing`(쓰기 원본)은 적재 모듈만. 원문·엔티티 원본·발생·스탠스 근거·고정/드롭 사유는 `rd.v_answer_body`·`rd.v_answer_mention_raw`·`rd.v_answer_occurrence`·`rd.v_answer_stance_raw`·`rd.v_answer_registry` 뷰로 answer_key 등치 조회만. 인용 원문 목록은 `rd.citation ⋈ rd.dim_url`. 앱 쓰기(api_rw)는 `app` 과 `app.judgment_change`(재판정·운영 요청 큐) INSERT 만이고, `rd`·`ing` 반영은 적재기가 한다.
- **읽기 표와 그레인**: `rd.job`(Scope job 1건, 모든 status·드롭 포함: QA·드릴다운 색인, job_id↔answer_key) · `rd.answer`(완료·비드롭 job 1건, D1 모수) · `rd.answer_brand`(답변 × 표시 브랜드 × 경쟁 여부: G-01 제품 확정, 언급 계열 M01~M04·M08·M11) · `rd.answer_stance`(job × 턴 × 엔티티) · `rd.citation`(인용 원소 1건: G-02, M05·M09·M10) · `rd.cycle`·`rd.surface_generation`(회차·세대) · `rd.catalog_entry`(카탈로그 행, M12·택소노미) · `rd.dim_*`(engine·region·country·lang·project·taxon·prompt·brand_name·entity·source·url, `rd.web_unit`) · `rd.acr_cell`·`rd.acr_choice`·`rd.acr_cell_job`(ACR) · `rd.ga4_*`(GA4 행 원본) · `rd.kw_*`(DataForSEO) · `rd.report_unit_value`(발행값 A5).
- **술어 규약**: 시간 축 = `round_date`(필터·추이·파티션 키, G-04). 파티션 = LIST(surface) → RANGE(round_date) 이므로 모든 사실 표 질의에 `surface = ` 와 `round_date` 범위를 준다. 언급 계열 모수 = `std_in`, 인용 계열 모수 = `cit_in`(분석 결손 무관, G-21 g), 기본 엔진 = `dflt`. WHERE 는 불리언·`= ANY(상수 배열)` 만(배열 1,000 초과면 차원 semi-join), 비트 식(`bgrp`·`cat_mask`·`own_mask`)은 FILTER 안에서만. 카드·추이의 당사 수치는 `rd.answer` 당사 열(own_mask·own_rk_*·ment_*·sent_*·tgt_cited·own_url_cited, G-03)로 자식 스캔 없이. `is_rep` 은 드릴다운·리포트 대조에만(A1: 카드 모수 아님). 조회 시 계산 허용(P1 예외): 관점별 톤 비교, M05 owner_key 허용 배열, M04 HMG = 3사 순위 중 0 을 뺀 최솟값, R03 view_date ≤ 오늘, 프롬프트 수 count(DISTINCT).
- **D8 예외는 넷뿐**: ① rd.answer_brand 그레인 ② rd.answer 당사 열 ③ 회차 완료·결손 카운터(ing.cycle, rd.cycle 에 1:1 투영해 기간 비교 누락 비중·운영 진행률로 노출 허용: 2026-09-28 제품 책임자 Q2 개정) ④ 인용 도메인 접기 표(RDS 실측에서 1초 초과 기능에 한해, 아직 없음).
- **G-25 결정(제품 책임자 2026-09-28, stg 실측 근거)**: 동시 5명에서 웹사이트 1년 summary·trend p95 1.1~1.5초(인용 원소 스캔 + 4 vCPU 포화) → **rd.answer 에 답변당 인용 수 열 추가**(D8 예외 ② 확장: G-03 당사 열과 같은 답변 1:1 판정 열, 자식 합 = 답변 열 불변식 단언). summary·trend 의 인용 계열은 rd.citation 을 스캔하지 않는다. DB-v2.2 로 반영 후 동시성 재측정.
- **쿼리 교정(stg 대조로 확정, `docs/test/QUERY-FIXES.md`)**: M-1 경쟁사 = `NOT (own_bit = ANY(:관점 비트))`(own_bit = 0 금지), C-1·G-1 자사 인용 = 표면별 판정식(글로벌 `owner_key = ANY(:allowed_owner_keys)`, `owner_key <> 0`·`loc_owned OR tgt_hit` 금지).
- **프론트는 그대로 가져온다(제품 책임자 2026-09-28)**: 현행 Next.js 화면·컴포넌트를 유지하고, 화면이 부르던 서버 데이터 함수만 API 호출로 교체한다. API 응답은 현행 컴포넌트가 쓰는 타입에 맞추고(어댑터는 프론트 데이터 계층 한 곳), 각 단위의 current_refs 가 교체 대상 목록이다. API 명세 정본은 사내 공유 사이트 폴더 HMG-GEO-HUB 의 hmg-geo-hub-api(나만보기).
- **API 결정(2026-09-28, `modules/DECISIONS-API.md`)**: 스냅샷 = 함대 규칙 · 엔드포인트 병합 금지(동시 호출 불합격 시에도 기능 = API 하나, 대응은 호출 예산·지연 로드·사양) · QA 는 계정 없는 별도 게이트 유지 · 접근 감사는 민감 조회만 비동기. 그 밖의 사전 집계·요약 표·매트뷰·결과 캐시·새 누적 카운터는 제안하지 않는다. 컬럼 추가가 필요하면 "제안"으로 표시하고 근거를 적는다.
- **성능 근거의 한계(중요)**: 프로토 v1·v2 의 "10배"는 과거 회차 복제(이력 10배)였고 폭 10배(프롬프트·URL·브랜드 키 10배) 근거는 없다. 제품 결정으로 v3 실측을 생략하고, 성능 판정은 RDS 구축 후 실데이터 실측 게이트에서 한다. 설계자는 엔드포인트마다 10배에서 읽는 행 규모·파티션 가지치기 조건·필요 인덱스를 적고 위험(low·medium·high)을 표시한다. 알려진 고위험: 웹사이트 인용 1년 조합(원소 그레인 1.7~2.0초 추정), 화면당 API 5개 이상 동시 호출(G-25).
- **알려진 미결**: 접근 감사 로그(`app.access_audit_log`) 쓰기 주체 없음(api_ro 는 읽기 전용): AU-1 에서 안을 낸다. answer_key 전역 유일성은 rd.job 이 원장(파티션 표 제약으로 보장 불가).
- 참고(폐기): 프로토 v1 `proto/ddl/`, v2 `proto/v2/ddl/`. 산식 참고용으로만 읽는다.

## 4. 현행 기능 근거
- 화면 × 구획 × 함수 추적(검증됨): `notes/hmg-refactor-research/10-feature-trace.tsv`(열: route, section_ko, i18n_key, fn, fn_def, computes, filters, read_path, tables, evidence) · 요약 `10-feature-trace.md`
- 현행 코드(읽기 전용, 통합 프리뷰 7639b9e): `../hmg-geo-research-preview-7639b9e`. 메인 클론과 다른 워크트리는 열지 않는다.
- 신구 대조 하네스(기능 F01~F07 의 현행 값 캐시): `notes/hmg-refactor-proto/harness/README.md`, `runs/20260927-1714-full/values-old.jsonl`.
- 기술 스택 조사: `notes/hmg-refactor-research/08-ext-fastapi-nextjs.md`(일부 주장 미검증).

## 5. 기술 기준
- Python 3.12, FastAPI(APIRouter 기능 모듈, 경로 접두 `/v1`), Pydantic v2, SQLAlchemy 2 Core + asyncpg(분석 쿼리는 Core/텍스트 SQL, ORM 모델 최소), 커넥션 풀은 PgBouncer transaction 모드 호환(prepared statement 캐시 끔).
- 프론트는 OpenAPI 에서 TypeScript 클라이언트 생성(openapi-typescript + openapi-fetch).
- 모든 조회는 읽기 스키마만 본다. 쓰기 스키마·Scope API 는 적재 모듈만 만진다.

## 6. 작업 규칙
- 읽기 전용: 파일을 쓰지 않는다(결과는 구조화 출력으로 반환). DB 접속 금지(프로토타입 DB 는 삭제됨, 프로덕션 금지). git 상태 변경 금지. 컨테이너·포트 기동 금지.
- 적는 함수명·파일·테이블은 `git grep -n` 이나 열람으로 실재를 확인한 것만 쓰고 file:line 을 붙인다. 모르면 "미확인".
- 한국어로 쓰고, 대시 문자(—, –) 대신 콜론·괄호를 쓴다.
