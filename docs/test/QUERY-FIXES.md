# 설계 단위 쿼리 결함 3건: 교정 식 (구현 빌더 참조용)

작성: 대조·성능 빌더 C, 2026-09-28. 근거는 stg RDS(hmg DB, rd 투영, seed-40 0078 수정본 `b49b5af5f6a665dd`)에서 돌린 결과다.
- 대조 러너: `parity/runner.py`(mode=new 가 아래 교정 식으로 돈다), 결과 `parity/run-final/`(값·분류), 최신 값 `parity/res/values-192312/`
- 결함 식과 교정 식을 같은 데이터에서 나란히 센 프로브: `parity/sql/x25-queryfix.sql`(C01 = 글로벌 최신 회차 873, 현대 계정, 기본 엔진)

**상태**: 세 결함 모두 단위 설계 JSON 에 남아 있다. 모듈 통합 단계 문서는 해소 방향을 적어 두었다(`modules/모듈-언급.json:59`,
`modules/모듈-인용.json:88`, `modules/모듈-KPI.json:65`, `modules/전체-통합.json:1468` core.measure `own_expr(surface)`·
`allowed_owner_keys`). 다만 단위 JSON 의 `query_design` 을 그대로 옮기면 결함이 그대로 들어간다. **구현은 이 파일의 교정 식을 따른다.**

공통 기호
- `:vp` 관점 브랜드의 own_bit 목록(현대 계정 = `{1}`, 기아 = `{2}`, 제네시스 = `{4}`, admin 전사 = `{1,2,4}`). Hyundai N 표시명은 own_bit 1(A4 #11).
- `:bgrps` 관점 모수. 글로벌 = 카탈로그 비트 `{v | v & (own_bits | 8) <> 0}`(당사 ∪ HMG 공통, `standard-filters.ts:64`),
  웹 = 사이트 브랜드 비트 `{own_bit}`. WHERE 에는 비트식 대신 이 상수 배열을 `= ANY` 로 쓴다(DESIGN-CONTRACT §3).
- `<engine>` = 엔진 필터가 있으면 `x.engine_key = ANY(:engines)`, 없으면 `x.dflt`.
- `<own_expr(c)>`(인용 자사, 표면별 하나):
  - global: `c.owner_key = ANY(:allowed_owner_keys)`
  - website: `(c.loc_owned OR c.tgt_hit)`
  - project: `c.loc_owned`
- `:allowed_owner_keys` = `app.owned_base` 에서 `brand_code` ∈ 관점 브랜드인 행(kind `base`·`root_home` 모두). 국가 필터가 있으면
  `geo_code` ∈ 선택 국가로 좁히되, 좁힌 결과가 비면 좁히지 않는다. 언어 필터도 같은 방식으로 좁힌다(`ownedBasePrefixesForScope`
  `lib/scope/hmg-brands.ts:242-272`, 7639b9e). 요청마다 앱에서 한 번 계산한다(P1 예외 "M05 owner_key 허용 배열").

---

## 1. M-1 브랜드·경쟁사 비교: 경쟁 행에서 형제 HMG 브랜드가 사라짐

**위치**: `notes/hmg-refactor-design/modules/M-1-브랜드-경쟁사-비교.json:75`(`query_design` 의 "2) 경쟁사 행")

**결함 식**
```sql
FROM rd.answer_brand
WHERE surface = :surface AND round_date BETWEEN :from AND :to AND std_in
  AND competitive AND own_bit = 0                                   -- ← 관점과 무관한 절대 자사 판정
  AND project_key = ANY(:project_keys) AND engine_key = ANY(:engine_keys)
  AND geo_key = ANY(:geo_keys) AND lang_key = ANY(:lang_keys)
  AND (:brand_filter IS NULL OR brand_key = ANY(:brand_filter))     -- ← brand[] 를 표시 브랜드로 오해(모수 bgrp 누락)
GROUP BY brand_key ORDER BY :sort_column DESC LIMIT :top_n;          -- ← LIMIT 로 당사 순위(rank)를 못 냄
```

**교정 식**
```sql
SELECT b.brand_key,
       sum(b.mention_count)                              AS mentions,
       count(*)                                          AS exposure_answers,   -- PK (answer, brand, competitive) 라 competitive 한정 시 답변당 1행
       coalesce(sum(b.rk) FILTER (WHERE b.rk > 0), 0)   AS rank_sum,
       count(*) FILTER (WHERE b.rk > 0)                  AS ranked_rows,
       sum(b.s_pos) AS s_pos, sum(b.s_neu) AS s_neu, sum(b.s_neg) AS s_neg, sum(b.s_mix) AS s_mix
  FROM rd.answer_brand b
 WHERE b.surface = :surface
   AND b.round_date BETWEEN :lo AND :hi AND b.cyc_key = ANY(:cyc_keys)     -- 창(스냅샷이면 lo = hi = 최신 노출 round_date)
   AND b.bgrp = ANY(:bgrps)                                              -- 관점 모수(카탈로그 당사 ∪ 공통 / 사이트 브랜드)
   AND <engine(b)> [AND b.geo_key = ANY(:geos)] [AND b.lang_key = ANY(:langs)]
   AND b.std_in AND b.competitive
   AND NOT (b.own_bit = ANY(:vp))                                        -- 관점 브랜드만 뺀다. 형제 HMG 브랜드는 경쟁 행에 남는다
 GROUP BY b.brand_key;
-- 당사 행은 rd.answer 당사 열(G-03)로 따로 낸다: sum(ment_<own>) 언급, count(*) FILTER (own_mask & :vp_mask <> 0) 노출,
--   own_rk_<own> 합/건수. 순위(rank)는 당사 행 + 전체 경쟁 행을 언급 수 내림차순으로 앱에서 매긴다(SQL LIMIT 금지).
--   동률은 현행처럼 이름 localeCompare(ICU 루트) 순. 이 정렬을 흉내 내지 않으면 C07(비교 대상 전체)의 순위 키 41개가 1씩 밀린다.
```

**근거**
- 현행 대시보드 브랜드 표는 관점 브랜드만 추적(isTracked)으로 두고 형제 HMG 브랜드는 경쟁 행에 남긴다
  (`trackedRollupIn scope-aggregates.ts:195` = 관점 ∩ 3사, 하네스 F03).
- stg 실측(C01 현대 관점):
  - 결함 식(`own_bit = 0`)에서는 Kia·Genesis 행이 없다(언급 NULL).
  - 교정 식에서는 Kia 17,225, Genesis 1,949.
  - 교정 식 결과 현행 F03 과 순위가 같다: C01 Kia rank 4 = old 4, C02(기아 관점) Hyundai rank 3 = old 3.
- `LIMIT :top_n` 을 두면 11위 밖 브랜드의 rank 와 당사 순위를 못 낸다. 반환 행은 C05(1년) 약 1,160, C07 380 수준이라
  전량 반환 후 앱에서 자른다.

---

## 2. C-1 인용 도메인 상위: 관점 밖 HMG 브랜드 인용이 자사로 잡힘

**위치**: `notes/hmg-refactor-design/modules/C-1-인용-도메인-상위.json:62`(`query_design` ④)

**결함 식**
```sql
-- ④ 도메인 집계
GROUP BY u.domain, count(*) citations, count(*) FILTER (WHERE u.owner_key <> 0) own_citations   -- ← 어느 HMG 브랜드든 자사
```

**교정 식**
```sql
WITH g AS (
  SELECT c.source_key,
         count(*)                                   AS citations,
         count(*) FILTER (WHERE <own_expr(c)>)      AS own_citations,
         count(*) FILTER (WHERE c.tgt_hit)          AS target_citations
    FROM rd.citation c
   WHERE c.surface = :surface
     AND c.round_date BETWEEN :lo AND :hi AND c.cyc_key = ANY(:cyc_keys)
     AND c.bgrp = ANY(:bgrps) AND <engine(c)> [AND c.geo_key = ANY(:geos)] [AND c.lang_key = ANY(:langs)]
     AND c.cit_in AND c.source_key <> 0                 -- 인용 모수(G-21 g) + 호스트 있는 인용만(G-21 a)
   GROUP BY c.source_key)
SELECT s.domain, sum(g.citations) AS citations, sum(g.own_citations) AS own_citations, sum(g.target_citations) AS target_citations
  FROM g JOIN rd.dim_source s ON s.source_key = g.source_key
 GROUP BY s.domain
 ORDER BY 2 DESC, 1
 LIMIT :top_n;          -- 공식 도메인 전부 포함 규칙이 있으면 OR own_citations > 0 행을 따로 합친다
```

**근거**
- stg 실측(C01 현대 관점):
  - 결함 식: kia.com 자사 790, genesis.com 자사 41.
  - 교정 식: kia.com 0, genesis.com 0. hyundai.com 11,970 은 두 식이 같다.
  - 현행 F04 도 C01 에서 kia.com owned 0 이다.
- 도메인 키는 `rd.dim_url` 을 인용 행마다 조인하지 않고, `source_key` 로 먼저 모은 뒤 `rd.dim_source.domain` 으로 접는다.
  - 두 도메인 열이 다른 URL 은 1,424,200 중 5건이다.
  - 현행 모사(emu)가 이 방식으로 F04 old 키를 C08 1건(beijing-hyundai.com.cn owned 881 vs 877, 미해명)을 빼고 전부 재현했다.
  - 1년 조합에서 인용 수백만 행 × dim_url 조인을 피한다. C11 F04 웜 p95 192ms.
- 웹사이트 표면은 `owner_key` 가 아니라 유닛 판정(`loc_owned`)과 프롬프트 타겟(`tgt_hit`)이다
  (`websiteTargetOwnedClause scope-aggregates.ts:8655`). C08·C09 F04 owned 가 이 식으로 old 와 같다.

---

## 3. G-1(GEO-1) 국가별 현황: 글로벌 자사 인용이 항상 0

**위치**
- `notes/hmg-refactor-design/modules/G-1-국가별-현황.json:83`(`query_design` 7) cit CTE)
- 같은 파일 `:54`(metrics_rules M05 문구 "own_url_cited 계열")

**결함 식**
```sql
-- 7) cit CTE: pop 조인
SELECT a.geo_key, count(*) AS cit_total, count(*) FILTER (WHERE loc_owned OR tgt_hit) AS cit_owned   -- ← 글로벌은 두 열이 적재 시 false
  FROM rd.citation c JOIN pop a ON ...                                                              -- ← pop(std_in)으로 인용 모수를 좁힘
 WHERE c.surface = :surface AND cit_in
 GROUP BY a.geo_key;
```

**교정 식**
```sql
SELECT c.geo_key,
       count(*)                                AS cit_total,
       count(*) FILTER (WHERE <own_expr(c)>)   AS cit_owned
  FROM rd.citation c                           -- 인용 표에 게이트·축 사본(cit_in·dflt·bgrp·geo_key·cyc_key)이 있어 pop 조인이 필요 없다
 WHERE c.surface = :surface
   AND c.round_date BETWEEN :lo AND :hi AND c.cyc_key = ANY(:cyc_keys)
   AND c.bgrp = ANY(:bgrps) AND <engine(c)> AND c.geo_key = ANY(:allowed_geo_keys)
   AND c.cit_in AND c.source_key <> 0
 GROUP BY c.geo_key;
-- M05 문구 교정(:54): "M05 인용 점유율 = <own_expr> 인 rd.citation 행 / cit_in ∧ 호스트 있는 rd.citation 행.
--   글로벌 owner_key 허용 배열은 국가 행마다 바꾸지 않고 요청 필터 기준 하나(현행 fetchStandardGeoKpi 와 같음)."
```

**근거**
- seed-40 §6 은 글로벌 `loc_owned`·`tgt_hit` 를 false 로 적재한다(글로벌 자사 = owner_key + 허용 배열, P1 예외).
  결함 식의 C01 자사 인용은 0 이고, 교정 식은 14,598 / 121,177 이다.
- pop(std_in) 조인은 분석 결손 답변(gap)의 인용을 뺀다. 이는 G-21 (g)(인용 모수 = cit_in, 결손 답변 포함)과 어긋난다.
- 교정 식으로 C01 국가별 인용 점유율 34개국 중 31개국이 현행 F05 와 정확히 또는 반올림 범위로 일치했다.
  예: US 271/3,474 = old 271/3,474, PR 은 호스트 없는 인용 1건 차이(G-21 a)로 반올림 범위다.
  나머지 3개국(FR·KR·SK)은 스냅샷 모수 정의(A1: 셀 대표 → 모든 완료 측정) 차이다.
  현행 모사(emu, 셀 대표)는 이 3개국도 old 와 같게 재현한다.
- 허용 배열을 국가 행마다 그 국가로 좁히지 않는 것이 현행과 같다. 그렇게 좁히면 C01 국가별 값이 old 와 갈린다.

**함께 고칠 것(같은 단위)**: 1) pop CTE 의 "brand[] 단일 선택 시 rd.catalog_entry 조인"을 `a.bgrp = ANY(:bgrps)` 로 바꾼다.
관점 모수는 적재 시 `bgrp`(글로벌 = cat_mask)로 이미 굳어 있다. 행마다 카탈로그를 조인하면 D8·술어 규약상 불필요한 조인이다.

---

## 참고: 같은 계열로 이미 정정된 곳
- K-1 `modules/K-1-KPI-요약-카드.json:45` M05 "loc_owned true 인 rd.citation 행": 글로벌에서 같은 결함이 있다.
  `modules/모듈-KPI.json:65`(F5)에서 표면별 식으로 정정됐다. 대조 러너 F01 은 정정 식으로 돌았고,
  C01 인용 점유율 14,477/119,971 이 현행 모사와 정확히 같다.
- 세 식의 정본은 `core.measure.own_expr(surface)`·`allowed_owner_keys(own_brands, countries, langs)` 한 곳에 둔다
  (`modules/전체-통합.json:1468`). 기능별로 식을 다시 쓰지 않는다.
