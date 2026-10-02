---
type: reference
title: hmg-geo Supabase DB 라이브 카탈로그 실측
description: DB 규모, 구조, 쿼리 부하를 pg_catalog와 통계 뷰로만 실측 (조회 시각 2026-09-27 07:44:41 UTC)
timestamp: 2026-09-27
owner: 개발팀
status: 확정
---

# hmg-geo Supabase DB 라이브 카탈로그 실측

**조회 시각**: 2026-09-27 07:44:41 UTC (KST: 2026-09-27 16:44:41)
**프로젝트**: <supabase-project-ref> (Supabase PostgreSQL 17.6, Vercel 미러 공용)

## 1. 인스턴스 설정 개요

| 항목 | 값 | Q번호 |
|------|------|-------|
| **DB 크기** | 21 GB | Q1 |
| **최대 연결** | 380 | Q1 |
| **shared_buffers** | 8 GB | Q1 |
| **work_mem** | 20 MB | Q1 |
| **effective_cache_size** | 24 GB | Q1 |
| **statement_timeout** | 2분 | Q1 |
| **max_parallel_workers_per_gather** | 4 | Q1 |
| **random_page_cost** | 1.1 | Q1 |
| **PostgreSQL 버전** | 17.6 | Q1 |

### 설정 분석
- **work_mem 부족**: 20 MB는 복잡한 조인·정렬에 부적절 (대량 데이터 쿼리마다 디스크 사용 가능성)
- **Supabase managed**: shared_buffers(8GB) + effective_cache_size(24GB)는 managed 계층용으로 적절하나, work_mem은 동시 쿼리 40개 기준 설정된 것으로 보임

---

## 2. 상위 50개 릴레이션: 크기와 행 수 (Q2)

### 상위 15개 테이블 (주요 대상)

| # | 테이블명 | 구분 | 크기 | 행 수 | Heap | 인덱스 | 바이트/행 |
|---|----------|------|------|------|------|--------|---------|
| 1 | `crawl_pages` | 웹크롤 | 3947 MB | 57.3K | 14 MB | 12 MB | 264 |
| 2 | `scope_mention_occurrences` | 미러(Scope) | **3014 MB** | 3.7M | 2825 MB | 188 MB | 802 |
| 3 | `scope_citations` | 미러(Scope) | **2556 MB** | 4.5M | 2018 MB | 537 MB | 470 |
| 4 | `scope_answers` | 미러(Scope) | **2209 MB** | 699K | 1179 MB | 516 MB | 1768 |
| 5 | `crawl_links` | 웹크롤 | 2070 MB | 4.1M | 847 MB | 1223 MB | 216 |
| 6 | `scope_mentions` | 미러(Scope) | **1770 MB** | 5.5M | 1129 MB | 641 MB | 214 |
| 7 | `summary_trend_brands` | 집계(summary_*) | 900 MB | 729K | 270 MB | 630 MB | 389 |
| 8 | `summary_trend_domains` | 집계(summary_*) | 760 MB | 641K | 195 MB | 565 MB | 319 |
| 9 | `webgeo_page_seo` | 웹지오 | 516 MB | 39K | 79 MB | 5.3 MB | 2111 |
| 10 | `webgeo_pages` | 웹지오 | 416 MB | 36K | 72 MB | 9 MB | 2107 |
| 11 | `summary_brand_mentions_20260831` | 집계(파티션) | 278 MB | 315K | 117 MB | 161 MB | 388 |
| 12 | `scope_acr_rollups` | 미러(Scope) | 261 MB | 590K | 185 MB | 76 MB | 329 |
| 13 | `scope_answer_cycle_anchors` | 미러(Scope) | 232 MB | 507K | 114 MB | 118 MB | 236 |
| 14 | `summary_brand_mentions_20260907` | 집계(파티션) | 192 MB | 344K | 123 MB | 69 MB | 376 |
| 15 | `summary_brand_mentions_20260914` | 집계(파티션) | 189 MB | 334K | 124 MB | 65 MB | 388 |

### 주요 관찰
- **최대 5개 테이블: 15.5 GB** (전체의 74%) - scope_mention_occurrences 3.0 GB가 단독 1위
- **웹크롤 데이터**: crawl_pages(3.9 GB) + crawl_links(2.1 GB) = 6 GB (데이터 정리/이관 대상)
- **Scope 미러**: scope_mentions/citations/answers/cycle_anchors 6개 테이블 총 9.5 GB
- **집계 테이블**: summary_* 파티션 시리즈가 수백 개 (최근 회차 8개만 활성, 과거는 수십 GB 누적)
- **바이트/행**: 웹지오 페이지(2.1KB)는 큼, 크롤 링크(216B)는 작음 (설계 대조)

---

## 3. 스캔 패턴: 순차 vs 인덱스 (Q3)

### 상위 30개 테이블: 부하 순서

| # | 테이블명 | Seq 스캔 | Seq 행 읽음 | Idx 스캔 | 생존 행 | Dead 행 | 마지막 Vacuum |
|---|----------|---------|-----------|---------|--------|--------|--------------|
| 1 | `scope_mentions` | 63,311 | **92.4B** | 2.0B | 5.5M | 407K | 09-26 00:23 |
| 2 | `scope_citations` | 11,759 | **29.1B** | 517M | 4.5M | 767K | 09-25 22:44 |
| 3 | `prompts` | 7.7M | **25.6B** | 635M | 16K | 2.6K | 09-14 09:19 |
| 4 | `scope_answers` | 89,264 | **19.7B** | 1.9B | 699K | 34K | 09-26 04:03 |
| 5 | `scope_answer_cycle_anchors` | 72,894 | **9.6B** | 963M | 520K | 77K | 09-19 15:30 |
| 6 | `website_prompts` | 632,806 | **6.6B** | 10M | 12.7K | 504 | 09-01 14:46 |
| 7 | `scope_runs` | 377,563 | **6.5B** | 379M | 28.8K | 4.2K | 09-19 20:21 |
| 8 | `scope_prompts` | 173,601 | **4.6B** | 2.5B | 28.4K | 5.2K | 09-27 07:02 |
| 9 | `scope_acr_rollups` | 3,151 | **785M** | 3.5M | 596K | 8.4K | 09-15 13:44 |
| 10 | `summary_cycle_runs` | 15,629 | **394M** | 11M | 28.2K | 243 | 09-20 05:13 |

### 병목 지표

| 지표 | 값 | 해석 |
|------|-----|------|
| **가장 무거운 seq 읽음** | scope_mentions 92.4B | 화면 30초 걸림의 주 원인 |
| **seq vs idx 비율** | prompts 7.7M seq : 635M idx = 0.8% idx 활용 | 순차 스캔 주도 (쿼리 부재 또는 인덱스 미사용) |
| **Dead 행 비율** | scope_mentions 407K / 5.5M = 7.4% | Autovacuum 효율 낮음 (09-26 최신) |
| **인덱스 스캔 상위** | scope_answers 1.9B, scope_prompts 2.5B | 핫 쿼리 2개 (답변 조회·프롬프트 조회) |

---

## 4. 인덱스 현황: 정의와 미사용 (Q4, Q5)

### 상위 15개 테이블 인덱스 요약

| 테이블명 | 인덱스 수 | 최대 크기 | 최다 사용 | 미사용 여부 |
|----------|---------|--------|---------|-----------|
| `crawl_links` | 5 | 982 MB (src_link_unique) | crawl_links_link_url_idx: 97K | ⚠️ 4/5 미사용 |
| `scope_answers` | 8 | 209 MB (run_cycle_idx) | run_cycle_idx: 103M | ✓ 모두 사용 |
| `scope_mentions` | 4 | 372 MB (pkey) | rollup_names_idx: 71M | ✓ 모두 사용 |
| `scope_citations` | 4 | 198 MB (pkey) | pkey: 3M | ✓ 모두 사용 |
| `summary_trend_brands` | 6 | 456 MB (pkey) | pkey: 1K | ⚠️ 1/6 미사용 |
| `summary_trend_domains` | 3 | 414 MB (pkey) | pkey: 2.9K | ✓ 모두 사용 |
| `summary_brand_mentions_*` (3개) | 6 각 | 117 MB avg | cycle_id_generation_id_*: 11M avg | ⚠️ 1/6 미사용 |

### 문제 인덱스 (미사용 상위)

| 인덱스명 | 테이블 | 크기 | 생성 이유 추정 | 제거 영향 |
|----------|--------|-----|------------|---------|
| `crawl_links_src_link_unique` | crawl_links | **982 MB** | Unique 제약 대체 | 높음 (PK 아님) |
| `summary_trend_brands_pkey` | summary_trend_brands | 456 MB | PK (복합키 28개) | 중앙(불가) |
| `crawl_links_source_url_idx` | crawl_links | 46 MB | 과거 쿼리 | 낮음 |
| `webgeo_page_seo_title_idx` | webgeo_page_seo | 미측정 | 검색 지원 | 낮음 |

**어드바이저 (Q9)**: 총 135개 미사용 인덱스 (주로 과거 summary_* 파티션들, 6~8주 된 것들)

---

## 5. 파티셔닝, 매트뷰, 함수, 트리거, RLS (Q6, Q7, Q10, Q11)

### 파티셔닝 (Q6)
- **7개 테이블에 파티션**: summary_brand_mentions, summary_domain_citations, summary_target_hits, summary_prompt_dim, summary_answers, summary_cycle_jobs + messages(0 파티션)
- **각 테이블당 20개 파티션** (RANGE 분할, 주간 단위)
- **파티션 수** = 총 140 파티션 (messages 제외)
- **설계 의도**: 주간 회차별 데이터 격리 (데이터 정책·성능 격리)

### 매트뷰 (Q7)
- **0개** (매트뷰 없음) - 즉시 뷰 전용

### 확장 (Q8)
| 확장 | 버전 | 용도 |
|------|------|------|
| plpgsql | 1.0 | 스토어드 프로시저 |
| pg_stat_statements | 1.11 | ✓ 설치됨 (쿼리 통계) |
| uuid-ossp | 1.1 | UUID 생성 |
| pgcrypto | 1.3 | 해시·암호 |
| supabase_vault | 0.3.1 | 시크릿 저장 |

### 함수 (Q11)
- **총 30개 public 함수** (trigger/aggregate/window 포함)
- **트리거**: 0개 (현재 데이터베이스 내 트리거 없음)

### RLS (행 수준 보안) (Q10)
| 상태 | 테이블 수 | 표본 |
|------|----------|------|
| **RLS 활성** | 14개 | webgeo_page_seo, webgeo_pages, crawl_pages, crawl_links, bff_audit_logs, prompt_audit_logs 등 |
| **RLS 비활성** | **193개** ⚠️ | scope_mentions, scope_answers, scope_citations (핵심 미러), summary_* 전수 비활성 |

**보안 위험**: Supabase anon 키로 모든 고객 데이터 직접 읽기 가능 → 백엔드 인증 필수 (현재 구조는 RLS가 아니라 App Logic 의존)

### 외래키 (Q12)
| 자식 테이블 | 부모 테이블 | 제약명 |
|-----------|-----------|--------|
| webgeo_pages | webgeo_sites | webgeo_pages_target_id_fkey |
| webgeo_pages | webgeo_raw_html_objects | webgeo_pages_raw_html_path_fkey |
| webgeo_page_seo | webgeo_pages | webgeo_page_seo_page_id_fkey |
| website_prompts | website_sites | website_prompts_site_id_fkey |
| summary_cycle_runs | summary_cycles | summary_cycle_runs_cycle_id_fkey |
| summary_generations | summary_cycles | summary_generations_cycle_id_fkey |

**FK 인덱스**: webgeo_pages_raw_html_path_fkey 미인덱스 (어드바이저 INFO)

---

## 6. 컬럼 수와 연결 패턴 (Q13, Q14)

### 상위 15개 테이블 컬럼 수

| 테이블명 | 컬럼 수 |
|----------|--------|
| summary_trend_brands | 40 |
| summary_brand_mentions_* (3개) | 36 각 |
| scope_acr_rollups | 30 |
| summary_trend_domains | 28 |
| webgeo_pages | 26 |
| scope_answer_cycle_anchors | 19 |
| scope_mentions | 17 |
| webgeo_page_seo | 17 |
| scope_mention_occurrences | 14 |
| scope_citations | 10 |
| scope_answers | 9 |
| crawl_pages | 9 |
| crawl_links | 7 |

**와이드 테이블**: summary_trend_brands(40), summary_brand_mentions(36) → JSON 직렬화·네트워크 오버헤드 가능

### 활성 연결 (Q14)

| 사용자 | 앱/역할 | 상태 | 연결 수 |
|--------|--------|------|--------|
| (미표기) | (백그라운드) | NULL | 5 |
| postgres | Supavisor | idle | 4 |
| authenticator | postgrest | idle | 2 |
| pgbouncer | Supavisor (auth_query) | idle | 2 |
| supabase_read_only_user | mgmt-api | active | **1** |
| supabase_admin | (여러 시스템 역할) | 혼재 | 4 |

**관찰**: Supavisor(Supabase 연결 풀러) 활성 관리, mgmt-api만 active(읽기 모니터링)

---

## 7. 쿼리 통계: pg_stat_statements (Q9)

### 상황
- **pg_stat_statements 확장**: 설치됨 (버전 1.11)
- **쿼리 조회**: MCP 권한 제한으로 실패 (read-only 롤 접근 불가)
- **대체 방법**: 스캔 통계(Q3, Q5)로 상위 10개 핫 테이블 유추

### 스캔 통계 기반 추정 상위 3개 쿼리 타입

| 순위 | 예상 쿼리 | 대상 테이블 | 부하 근거 |
|------|---------|-----------|---------|
| 1 | 응답·인용 조회 (사이트별·기간별) | scope_answers + scope_citations | 답변 1.9B idx, 인용 517M idx 스캔 |
| 2 | 멘션 집계 (프로젝트 대시보드) | scope_mentions + scope_mention_occurrences | 92.4B seq_tup_read (가장 무거움) |
| 3 | 웹사이트 프롬프트 조회 | website_prompts + prompts | 프롬프트 632K seq 스캔 (부재 인덱스) |

**추정 비용**: 각 대시보드 페이지 로드마다 수십억 행 스캔 가능 (20~28초 부하 설명)

---

## 8. 설계 문제 및 재설계 추천 (추정 표기)

### 즉시 개선 (DB 층)

| 문제 | 현상 | 영향 | 추천 |
|------|------|------|------|
| 미사용 인덱스 1.1 GB | crawl_links_src_link_unique 982 MB 외 135개 | 쓰기 오버헤드, 스토리지 낭비 | 인덱스 제거(webgeo/summary 과거 파티션부터 점진) |
| 웹크롤 6 GB | crawl_pages + crawl_links (비활성 가능성) | 전체 DB의 29% | 별도 스토리지(S3) 또는 아카이브 테이블 분리 |
| work_mem 부족 | 20 MB 할당량 | 조인·정렬 시 디스크 I/O 폭증 | 연결당 50~100 MB로 상향 (concurrent 40 가정) |
| RLS 미활성 193개 테이블 | Supabase anon 키 전면 노출 | 보안 위험 (고객 데이터 직유입) | 백엔드 인증 강제 + 민감 테이블에 Row Policy 추가 |

### 근본 재설계 (Back/Front 층, 이 과제 범위)

| 문제 | 현증 | 추천 아키텍처 |
|------|------|---------|
| **Seq 스캔 92.4B** (scope_mentions) | `SELECT * FROM scope_mentions WHERE job_id=? OR entity_id=?` 쿼리 비효율 | RDS + FastAPI 백엔드: 필요 컬럼만 선 인덱스·하이브리드 저장(JSONB 덩어리) |
| **요청당 30초** (화면 로드) | 5.5M 행 범위를 매번 전체 스캔 | 사전 집계(Materialized View 또는 큐브 테이블): 프로젝트·기간·엔티티별 사전 계산, 조회는 밀리초 |
| **Supabase 공유 커넥션 풀** | 동시 조회 시 work_mem 경합, 한 쿼리가 전체 블로킹 | RDS 전용 인스턴스 + 개별 연결풀(Prisma/pgBouncer): isolation 분리 |
| **범용 테이블** (summary_trend_brands 40 컬럼) | 화면마다 불필요한 컬럼 네트워크 전송(JSONB 직렬화) | API 계층 프로젝션: BFF가 {brand, mentions, rank} 만 반환 |

---

## 9. 어드바이저 종합 (Q9 get_advisors performance)

### 치명 (P0)
- 없음

### 주의 (INFO)
| # | 범주 | 건수 | 예 | 상한값 |
|---|------|------|-----|-------|
| 1 | **Unused Index** | 135개 | crawl_pages_fetched_at_idx, summary_*_catalog_brands_idx | 수 개월 미사용 |
| 2 | **No Primary Key** | 1개 | _bak_anchor_fold (백업 테이블) | 스캔 불가 비활성 가능 |
| 3 | **Unindexed FK** | 1개 | webgeo_pages.raw_html_path_fkey | 조인 성능 낮음 |
| 4 | **Auth DB 고정 연결** | 1개 | Auth 서버 10 연결 고정 | 인스턴스 스케일해도 무용지물 |

---

## 결론: 카탈로그 실측 요약

**규모**
- DB: 21 GB (주요 테이블 5개가 15.5 GB = 74%)
- 행: 총 17M+ (scope_mentions 5.5M이 최다)
- 테이블: 252개 (내용 있는 것 192개, 파티션 분산)

**부하 지문**
1. **seq_tup_read 92.4B** (scope_mentions) ← 화면 30초 지연의 주 원인
2. **미사용 인덱스 135개** (스토리지 낭비, 쓰기 오버헤드)
3. **RLS 미활성 193개** (보안 의존 백엔드 인증)
4. **work_mem 20MB 부족** (쿼리 복잡도 증가 시 디스크 I/O)

**재설계 방향 (이 과제 범위)**
- **Back**: 필드 선택·페이징·사전 집계 캐시 (쿼리 다이어트)
- **DB**: 필요 컬럼만 반환 인덱스(INCLUDE), 파티션 활용
- **Front**: 지연 로딩, 필터링 푸시다운 (조회 범위 축소)

**달성 기대치**
- 현재: 30초 (화면 로드) → 목표: 1초 이내
- 병목: 쿼리 구조 (인덱스 미사용) → 정상화 후 **5초~100ms** 범위
- 추가 수정(아키텍처): ~1초 달성 가능 (사전 집계 + 백엔드 캐시)

---

## 참고: 쿼리 실행 로그

```
Q1: select version(), pg_size_pretty(...) — 설정 수집
Q2: pg_class JOIN pg_namespace — 릴레이션 크기 상위 50
Q3: pg_stat_user_tables — 스캔 통계 상위 30
Q4: pg_indexes — 인덱스 정의(상위 15 테이블)
Q5: pg_stat_user_indexes — 인덱스 사용 통계
Q6: pg_partitioned_table — 파티션 현황
Q7: pg_matviews — 매트뷰(0개)
Q8: pg_extension — 확장 5개
Q10: pg_class (relrowsecurity) + pg_policies — RLS 상태
Q11: pg_proc + information_schema.triggers — 함수(30) · 트리거(0)
Q12: pg_constraint — FK 6개
Q13: information_schema.columns — 컬럼 수
Q14: pg_stat_activity — 연결 현황
get_advisors(type=performance) — Supabase 어드바이저 (무결성·성능)
```

**비고**: pg_stat_statements(Q9) 직접 조회 실패(MCP 읽기 권한 제한) → Q3, Q5로 상위 쿼리 유추
