---
type: analysis
title: hmg-geo 재설계 자료조사 종합
description: DB(RDS PostgreSQL) / Back(EC2+FastAPI) / Front(Next.js) 재설계 전 자료조사 10갈래를 교차 검증해 현황·기능 카탈로그·방향·결정 항목으로 정리
tags: [hmg-geo, refactor, performance, architecture]
timestamp: 2026-09-27
owner: 개발팀
status: 초안
---

# hmg-geo 재설계 자료조사 종합

기준 코드: hmg-geo 통합 프리뷰 `preview/2026-09-16-three-tracks` HEAD `7639b9e` (2026-09-27 14:38 KST, main 보다 281커밋 앞섬).
원자료: 같은 폴더 `01`~`09` 보고서 + 운영 담당 교차 검증. 보고서별 신뢰도는 §6.

## 0. 결론 요약

1. **규모 문제가 아니라 구조 문제다.** 대시보드가 읽는 미러는 답변 70만 행, 언급 550만 행, 인용 450만 행(약 10GB)이다. 1초 목표는 OLAP 엔진 없이 PostgreSQL 17 단독으로 도달 가능한 규모다(판단, §7 프로토타입으로 증명할 것).
2. **느린 원인은 읽기 시점의 판정 반복과 경로 이중화다.** 같은 판정을 요청마다 수십 곳에서 다시 계산하고, 사실표가 일부 화면만 덮어서 나머지는 미러 폴백(30초 이상)으로 떨어진다. 캐시는 콜드 경로를 가린다.
3. **기능은 작다.** KPI 6종, 필터 6축, 시간·노출 규칙 9개가 핵심이고, KPI 가 전부 "분자 합 / 분모 합" 형태로 표현된다. 판정을 적재 시점에 한 번 굳힌 사실표 위에서 기능마다 GROUP BY 한 번으로 답하는 구조가 가능하다.
4. **1초 at any scale 은 지표 정의가 가산형이어야 성립한다.** 기간 = 누적(측정 합산)은 이미 가산형이다(2026-09-16 확정). 비가산은 프롬프트 단위 고유 개수(⑥ "기간 중 한 번이라도 인용된 프롬프트")뿐이고, 기간 누적의 모수(모든 측정 vs 회차 대표)는 값 정의 결정으로 남는다(§5 D1).
5. **H-Cloud 제약**: 제출 사양은 WAS = Node.js(표준 예외 1건), DB = PostgreSQL 17.6 설치형이다. FastAPI 는 사양에 없어 예외 추가 협의가 필요할 수 있고, RDS 는 순수 PostgreSQL 기능만 써야 H-Cloud 로 이식된다(§4).

## 1. 현재 상태 (사실)

### 1-1. 규모 (라이브 DB 카탈로그, 2026-09-27 16:44 KST, 통계 뷰만 조회)

| 구분 | 테이블 | 크기 | 추정 행 |
| --- | --- | --- | --- |
| 미러 | scope_mention_occurrences | 3.0GB | 3.7M |
| 미러 | scope_citations | 2.6GB | 4.5M |
| 미러 | scope_answers | 2.2GB | 699K |
| 미러 | scope_mentions | 1.8GB | 5.5M |
| 집계 | summary_trend_brands / summary_trend_domains | 0.9GB / 0.8GB | 729K / 641K |
| 크롤(별기능) | crawl_pages / crawl_links | 3.9GB / 2.1GB | 57K / 4.1M |

- DB 전체 21GB, PostgreSQL 17.6, shared_buffers 8GB, work_mem 20MB, max_connections 380, statement_timeout 2분.
- summary 계열은 0059~ 마이그레이션의 17개 테이블, 주간 RANGE 파티션 약 140개. 집계층 인덱스 228MB/주 중 212MB(93%)가 19~20컬럼 자연 PK(`hmg-geo-perf-pr3-trend-and-hygiene-plan-2026-09-11.md:23`).
- 스캔 지문: scope_mentions 누적 순차 읽기 924억 행, prompts(16K 행) 순차 스캔 770만 회. pg_stat_statements 는 설치돼 있으나 MCP 읽기 롤로 조회 실패(쿼리별 시간은 미확보).

### 1-2. 느린 원인

| # | 원인 | 근거 |
| --- | --- | --- |
| 1 | 읽기 시점 판정 반복: 브랜드 롤업 식 39개 콜사이트, `ROLLUP_NAMES` 재귀 CTE 12곳(요청마다 193만 행 정렬해 990행 룩업), 셀당 최신 1건 선택 6곳 따로 구현 | 02a §2-2 (쿼리 비효율 감사 09-04) |
| 2 | 사실표 부분 커버: 사실표 경로는 1.3s 인데 커버 못 하는 축(depth2·3, 다중 브랜드, 기간 누적, 경쟁사 추이)은 미러 폴백 20~38s | 02a §1·§4, 02b §5 |
| 3 | 캐시가 콜드를 가림: unstable_cache 웜 1.4~1.9s, 미스 시 11~30s | 02a §2-6 |
| 4 | 같은 값의 이중 경로(사실표 + 미러)가 상시 병존 → 값 불일치 감시 비용 | 02b §6 |
| 5 | 인프라: 서울 사용자 ↔ Vercel bom1 TTFB 366~368ms, 리전 홉 481~625ms, 함수 콜드스타트 +0.95~7.3s. 함수↔DB(ap-south-1)는 동일 리전 | `hmg-geo-perf-pr3-trend-and-hygiene-plan-2026-09-11.md:22,53` |

현재 실측(09-10 프로브 콜드): 글로벌 대시보드 무필터 36.8~38.3s, 웹사이트 27.8~28.6s, 30일 기간 지정 글로벌 28.1s·웹사이트 20.8s(09-18).

### 1-3. 스파게티 정량 (프리뷰 7639b9e, 테스트 제외, git grep)

| 항목 | 값 |
| --- | --- |
| `lib/db/repositories` | 47파일 29,903줄, 그중 `scope-aggregates.ts` 단일 11,748줄 |
| `lib/summary` (집계층 생성·읽기) | 6,537줄 |
| `summary_` 참조 | 92파일 1,426회 |
| `unstable_cache` / `revalidateTag` | 20파일 102회 / 10파일 49회 |
| `_FORCE` 환경 플래그 / `read_screens` 키 | 8파일 58회 / 9파일 31회 |
| fallback 분기 | 131파일 488회 |
| statement_timeout 지정 | 29파일 165회 |

## 2. 기능 카탈로그 (성능 배관 제거 후)

> 화면별 상세 카탈로그는 `04b-feature-catalog-verified.md`(검증 강제 재조사) 도착 후 보강.

### 2-1. KPI 6종 (정본: `lib/kpi/overview-card-values.ts`, `lib/db/repositories/scope-aggregates.ts`)

| # | 지표 | 분자 / 분모 | 단위 행 | 가산성 |
| --- | --- | --- | --- | --- |
| ① | 노출률 | 당사 등장 답변 / 답변 | 답변 | 가산 |
| ② | 점유율(SOV) | 당사 언급 / 전체 언급 | 언급 | 가산 |
| ③ | 우호도 | 긍정 언급 / 감성 채점 언급 (07-29 이후 LLM 기준) | 언급 | 가산 |
| ④ | 우선노출도 | 브랜드별 순위 합 / 순위 답변 → 브랜드 간 순위(PR #223) | 답변×브랜드 | 브랜드별 합이 가산이면 순위는 조회 시 계산 가능 |
| ⑤ | 인용 점유율 | 자사 인용 / 전체 인용 (타겟 일치 = 자사, 루트 홈 = 전 언어 자사) | 인용 | 가산 |
| ⑥ | 타겟 URL 인용률 (website) | 타겟 일치 / 기준 | 프롬프트·유닛 | **현행 기간 누적은 비가산**(두 회차 중 한 번이라도 인용되면 분자) |

데이터 인사이드 마트가 이미 "비율 금지, 평균 금지(순위는 합과 건수 분리)" 규칙으로 ①~⑤를 정수 분자·분모로 내보내고 있다(02b §2). 새 읽기 모델도 이 형태가 기본이다.

### 2-2. 필터 6축

브랜드 · 권역(rhq) · 국가 · 언어(website) · 엔진 · 기간(프리셋 + 직접 선택). 캐스케이드(브랜드 → 권역 → 국가 → 언어), 옵션 창 = 데이터 창, 권한 스코프(default-deny) 교집합. 화면마다 지원 축이 다르다(website 는 region 대신 websiteCountry, admin 만 brand).

### 2-3. 보존할 비즈니스 규칙 (버리면 값이 바뀜, 02b §6-1)

회차 원장(종결: 다음 앵커 / 100% / 3일 창) · 앵커 귀속(registry → ledger → run → measured) · 노출 게이트(view_anchor ≤ today) · 함대 숨김·hidden_scope · 대표 답변 선택(셀당 최신 1건) · 분모·분자 게이트(발행·상태·카탈로그·태깅·완주·제외 지역) · dedup · 리포트 발행값 우선 · 분석 갭 게이트(completed 언급 95% 초과).

### 2-4. 화면 → 데이터 함수 지도 (기계 추출, `screen-fn-map.tsv`, `extract_screen_map.py`)

- 라우트 56개: 데이터 함수를 부르는 화면 25개, 12~13줄 리다이렉트 셸 9개(탭 그룹 진입점), 나머지는 관리·로그인·QA·가드 페이지.
- 화면이 부르는 고유 데이터 함수 **84개**, 그중 **50개가 BFF `lib/scope/server.ts`(5,732줄)** 한 파일에 정의. 나머지는 `dashboard/_data/live.ts`·`website/_data/live.ts`·`lib/db/repositories/*`.
- 화면별 함수 수: `/website` 35 · `/dashboard` 23 · 표준 언급 19 · 표준 인용 16 · 웹사이트 언급 10 · 프로젝트 언급 9 · 웹사이트 인용 8 · 웹사이트 프롬프트 7 · 프로젝트 상세 7 · 표준 ACR 6 · 프로젝트 인용 6 · 그 외 1~3.
- 표준과 웹사이트가 같은 기능을 `fetchStandard*` / `fetchWebsite*` 두 벌로 따로 부른다(언급·인용·Sub-KPI 등, 04b §6). 기능 단위 API 로 합칠 1순위.
- 샘플·미완성: 프로젝트 AI 퍼널 conversion(샘플 참조 13곳), acr·visibility(28줄 셸), 고객관심 구글 키워드(샘플 `DEFAULT_KEYWORD_TERMS`). 이관 범위(D4) 판단 자료.
- 한계: page 와 같은 라우트의 상대 import 1단계만 따라갔다. `components/` 경유 클라이언트 호출(소셜 스크레이핑 탭 등)과 함수 → 테이블 추적은 명세 단계에서.

### 2-5. 폐기 대상 성능 배관 (버려도 값이 같아야 함, 02b §6-2)

사실표 사본 경로와 gate 판정 · 미러 폴백 · unstable_cache 셀 · read_screens·`*_FORCE` 옵트인 · standard_snapshots · 이중 경로 일치 감시. 생성기 원자성(세대 스왑) 개념은 새 적재 파이프라인에 흡수.

## 3. 재설계 방향 (판단, 프로토타입으로 검증할 가설)

### 3-1. 원칙

1. **판정은 적재 시점에 한 번.** 브랜드 롤업, 도메인 소유·타겟 일치, 앵커 귀속, 대표 답변, 노출일, 카탈로그·게이트 플래그를 적재(미러 동기화 직후) 단계에서 컬럼으로 굳힌다. 조회 경로에는 판정 로직이 없다.
2. **읽기 모델은 하나.** "빠른 사본 + 느린 원본" 이중 경로를 두지 않는다. 미러 원본은 적재 입력과 드릴다운(원문)용으로만 남긴다.
3. **지표는 가산형 정수로 저장.** 비율·평균은 조회 시 SUM/SUM 으로만 만든다. 어떤 필터 조합도 같은 사실표의 부분합이다.
4. **기능 API = 사실표에 대한 GROUP BY 한 번.** 기능마다 쿼리 하나, 산식 정의는 한 곳.
5. **캐시는 보조.** 데이터가 회차 발행으로만 바뀌므로 "발행 세대 번호"를 키에 넣는 방식 하나면 충분하다. 콜드 경로가 1초 안이어야 한다.

### 3-2. 읽기 모델 초안

| 테이블 | 그레인 | 주요 컬럼 |
| --- | --- | --- |
| dim_cycle | 회차 | anchor_date(KST), view_anchor_date, hidden_scope, status, 발행 세대 |
| dim_prompt | 프롬프트 | 브랜드, funnel_stage, depth1~3, list_type, 카탈로그·태깅 플래그 |
| dim_geo / dim_engine / dim_brand | 국가·언어·권역 / 엔진 / 롤업 브랜드·경쟁사 여부 | 정수 surrogate key |
| fact_answer | 회차 × 프롬프트 × 엔진 × 국가(× 언어) 대표 답변 1행 | 자사 관점별 노출·언급·긍정·채점·순위합·인용 정수 |
| fact_brand | fact_answer × 롤업 브랜드 | 언급 수, 긍정, 채점, 순위 |
| fact_citation | fact_answer × 레지스트러블 도메인(× URL) | 소유·타겟 일치·카테고리 |

- 파티션: 회차 또는 월 RANGE. 기간 필터는 파티션 프루닝으로 줄인다.
- 인덱스: 필터 축 선두 복합 인덱스 + INCLUDE(정수 측정값) 로 index-only scan. 자연 PK 대신 surrogate key.
- 규모가 10배 이상 커질 때만 fact_answer 위에 prompt_id 를 뺀 롤업을 추가(가산형이므로 정의 변화 없음).

### 3-3. API 경계 초안 (FastAPI, `/v1`)

| 모듈 | 엔드포인트 예 | 원천 |
| --- | --- | --- |
| filters | `GET /v1/filters?surface=` (옵션 매트릭스·기간 범위) | dim_* |
| kpi | `GET /v1/kpi/summary`, `/v1/kpi/compare` (Δ, 억제 사유) | fact_answer |
| trend | `GET /v1/trend?bucket=cycle\|week\|month` | fact_answer × dim_cycle |
| mentions | `GET /v1/mentions/brands`, `/types` | fact_brand |
| citations | `GET /v1/citations/domains`, `/prompts`, `/targets` | fact_citation |
| geo | `GET /v1/geo` | fact_answer × dim_geo |
| answers | `GET /v1/answers/{id}` (원문 드릴다운) | 미러 원본 |
| admin / projects / qa | CRUD | 앱 테이블 |

공통 필터 모델 하나(Pydantic query parameter model, 다중 선택)를 모든 읽기 엔드포인트가 공유하고, 권한 스코프는 서버가 계산해 교집합한다(현행 `scopeWhere` default-deny 계승).

### 3-4. 인프라

- 리전: 서울(ap-northeast-2). 현재 사용자 ↔ 함수 홉 366~625ms 와 함수 콜드스타트가 사라진다.
- DB: RDS for PostgreSQL 17 + 순수 PostgreSQL 기능(파티셔닝, pg_partman·pg_cron·pg_stat_statements). Aurora 전용 기능·RDS Proxy 에 의존하지 않는다(H-Cloud 이식성).
- 연결: FastAPI 프로세스 풀 + PgBouncer(transaction mode). 현행 코드가 이미 transaction mode 전제(`prepare: false`, `SET LOCAL`)로 짜여 있다.
- 적재: Scope API pull(20분)은 유지하고 적재 직후 판정·사실표 갱신을 같은 배치에서. 배치는 EC2(H-Cloud 사양의 Batch 1대와 대응).

### 3-5. 외부 조사에서 채택하지 않는 것

| 항목 | 사유 |
| --- | --- |
| Aurora / Redshift zero-ETL / ClickHouse (07 권장) | 약 10GB 규모에 과잉, H-Cloud(PG 17.6 설치형) 이식 불가, 운영 계층 증가 |
| 매트뷰 REFRESH CONCURRENTLY 를 증분 갱신으로 사용 (07 §3-1) | 사실 오류: CONCURRENTLY 는 읽기를 막지 않을 뿐 전체 재계산이다. 회차 단위 INSERT 로 대체 |
| RDS Proxy (07·08) | H-Cloud 에 없음. PgBouncer 로 통일 |

## 4. 제약 (06 보고서, 원문 대조 확인)

- H-Cloud 제출 사양(`hmg-ggmd-hcloud-infra-spec.md:102·104·186`, 07-29 발송, 검토중): Web nginx 2 · WAS Node.js LTS 22 2대(**표준 예외 ①**, 표준은 Tomcat) · Batch 1 · DB PostgreSQL 17.6 설치형 Primary + Standby · Object Storage.
- FastAPI(Python)는 사양에 역할이 없다 → WAS 예외 추가 협의 필요 가능성(추정, 이노션 확인 필요).
- 보안: HMG SSO OIDC 필수(연동 가이드 08-06 요청 후 미수령), MPASS 부가인증, 60분 idle 로그오프, 이중 접속 제한, 5회 실패 잠금, 초대 발급만, 로그 보존(권한 5년·로그인 3년·접속 3년), outbound allowlist 3건(Scope API·DataForSEO·GA4), `/admin` 사내망 한정.
- 이미 설계해 둔 인증 스키마: users · local_credentials · invitations · sessions · login_logs · permission_audit_logs · tenants(`hmg-ggmd-db-schema-sso-2026-09-03.md`). 새 백엔드가 그대로 이어받을 수 있다.
- 고객 약속: 데이터 영향 변경 5단계 게이트(사전 스냅샷 · 백업·롤백 · 카나리 · 배포 · 사후 대조). **재설계 전환 자체가 "집계·KPI 산식 변경"에 해당**하므로 신구 값 대조가 전환 조건이다.

## 5. 결정 필요 항목

| # | 결정 | 선택지 |
| --- | --- | --- |
| D1 | 기간 누적의 모수 | 기간 = 누적은 2026-09-16 제품 확정(`lib/scope/result-adapter.ts:467` 주석). 남은 결정은 모수다: 기간 내 완료된 모든 측정(현 미러 경로, 30일 169,152) / 회차별 대표만(현 집계층 경로, 30일 122,358). **둘 다 가산형이라 1초와 무관한 값 정의 문제**. 비가산은 프롬프트 단위 고유 개수(⑥ "기간 중 한 번이라도 인용된 프롬프트")뿐이며 프로토타입에서 비용을 잰다 |
| D2 | 백엔드 런타임과 H-Cloud | **(권장) FastAPI 유지 + H-Cloud WAS 예외 추가 협의를 지금 착수** / TypeScript 백엔드(Fastify 등)로 Node 예외 1건 안에 수용 |
| D3 | DB | **(권장) RDS PostgreSQL 17, 순수 PG 기능만** / Aurora |
| D4 | 이관 범위 | 크롤·webgeo(6.5GB)·소셜 스크레이핑·키워드·GA4·QA 콘솔·컨텍스트 맵 포함 여부 (04b 결과로 화면별 판단 자료 보강) |
| D5 | KPI 단일 정의 | ④ 우선노출도(첫 등장 vs 평균 순위), 카드 vs 추이 단위 통일, ③ mixed 처리, ⑥ 기간 정의 |

## 6. 조사 품질 메모 (교차 검증에서 잡은 것)

| 보고서 | 신뢰도 | 교차 검증 결과 |
| --- | --- | --- |
| 01 현행 구조 | 중 | 인수인계 문서(07-08 코드리뷰 포함) 기준이라 "미러 5테이블" 등 프리뷰와 어긋남. 결함 목록은 프리뷰에서 재확인 필요 |
| 02a·02b 성능 이력·집계층 | 상 | KB 문서 요약, 수치 출처 명시 |
| 03 라이브 DB | 중상 | 수치는 카탈로그 실측. 단 "anon 키로 전 고객 데이터 노출"은 오류(`scripts/db/lockdown.sql` 로 회수), "summary 파티션 수십 GB"는 DB 21GB 와 모순, 예시 쿼리는 지어낸 것 |
| 04 화면·쿼리 매핑 | 하 | 함수·테이블명 27개 중 11개(41%) 코드에 없음. 대시보드·웹사이트 절만 유효 → 04b 재조사 |
| 04b 검증 강제 재조사 | 중 | 적은 이름은 실재 확인됨. 단 화면 절반·함수→테이블 추적은 미완(haiku 가 긴 호출 체인에서 멈춤) → 운영 담당이 화면 지도를 기계 추출(§2-4) |
| 05 스키마·파이프라인 | 중상 | "summary 테이블 스키마 미등재"는 오류(0059~ 17개 실재) |
| 06 제약 | 상 | H-Cloud 원문과 대조 일치 |
| 07 AWS DB | 중 | 확장 지원 목록은 공식 문서 인용. REFRESH CONCURRENTLY 설명 오류, 비용은 미검증 추정 |
| 08 FastAPI·Next.js | 중 | 구조·필터 모델은 공식 문서. "RDS Proxy 가 asyncpg 핀닝 해결", "ORJSONResponse deprecated" 는 미검증, 비용 추정(db.t3.micro)은 이 규모에 부적합 |
| 09 KPI 인벤토리 | 상 | 산식 위치 스팟 체크 일치(`overview-card-values.ts:63`) |

## 7. 다음 단계 제안

1. **기능 명세서 v0**: 04b + 09 로 화면 × 기능 × 산식 × 필터 × 가산성 표를 확정하고 D1·D5 를 결정.
2. **읽기 모델 프로토타입으로 1초 증명**: 미러를 읽기 전용으로 덤프해 로컬 PostgreSQL 17 에 §3-2 사실표를 만들고, 최악 필터 조합(무필터 1년·다중 브랜드·경쟁사 추이)을 EXPLAIN ANALYZE 로 측정. 행 수만이 아니라 폭·연관 테이블까지 10배로 합성 확장해 "커져도 1초"를 확인.
3. **신구 값 대조 하네스**: 현행 화면 값(리포트 발행값 포함)과 새 쿼리 값을 회차·필터별로 전수 대조. 고객 약속 5단계 게이트의 사후 대조와 같은 도구.
4. **API 계약(OpenAPI) 초안**: §3-3 모듈 단위, 공통 필터 모델 포함.
