# 파생 컬럼 전환 전 EXPLAIN 기준선 (Task 0, 2026-09-05)

> 플랜: `internal-kb/hmg-geo-summary-derived-columns-plan-2026-09-05.md` Task 0 Step 2.
> 이후 Phase D 의 각 PR(Task 13~16)이 **같은 6문장**을 같은 조건으로 다시 떠서 "전/후"를 비교한다.
> 산정 정본: `internal-kb/hmg-geo-summary-table-value-inventory-2026-09-05.md`.

## 조건

- 코드: `feat/derived-columns` = `origin/main c4c8d1a`(#207) · 컬럼 프로브는 라이브와 동일하게 **있음**으로 고정(`is_korean`·`regions`·`url_norm`)
- DB: 프로덕션 미러(Supabase, 세션 모드 5432, 롤 `postgres`) · **읽기 전용**(TEMP 테이블만, 트랜잭션 롤백) · 캡처 2026-09-05T09:41:05.469Z
- 호출: admin · 무필터(`{}`) · 기본 창(루트 7일 / 웹사이트 창 없음) · 카탈로그 owned 프리픽스 170개 · 웹사이트 프로젝트 128개(선언 base 109개)
- 방법: `@/lib/db` 를 로거 달린 drizzle 로 바꿔 **앱 집계 함수가 실제로 보낸 문장·바인드 값**을 잡고, 같은 값으로 `EXPLAIN (ANALYZE, BUFFERS)` 를 2패스 재실행. `_answer_set` 이 필요한 문장은 잡아둔 `CREATE TEMP TABLE` 을 같은 트랜잭션에서 먼저 재실행 + `ANALYZE`. 하네스: workspace `notes/hmg-perf/baseline-explain.int.test.ts` (+ `run-baseline-explain.sh`).
- 서버: PG 17.6 · work_mem 16MB · shared_buffers 4GB · effective_cache_size 12GB · jit off · statement_timeout 2min · random_page_cost 1.1

| 테이블 | reltuples(추정) | 전체 크기 | 힙 |
| --- | ---: | ---: | ---: |
| `prompts` | 14,870 | 7848 kB | 6056 kB |
| `scope_answers` | 534,099 | 1198 MB | 557 MB |
| `scope_citations` | 2,910,547 | 2143 MB | 1715 MB |
| `scope_mentions` | 2,935,079 | 933 MB | 588 MB |
| `scope_prompts` | 26,962 | 6832 kB | 5760 kB |
| `scope_runs` | 25,295 | 5128 kB | 3704 kB |

## 앱 함수 호출(벽시계, 로거 캡처 기준)

| 호출 | 벽시계 | 문장 수 | 비고 |
| --- | ---: | ---: | --- |
| standard | 19.65 s | 9 | `aggregateStandardFromMirror` — ①·④ 포함 (SET LOCAL·CREATE TEMP·ANALYZE + 코어 5 + 구성) |
| mentions | 18.90 s | 8 | `aggregateMentionsFromMirror(…,'none')` — ②·③ 포함. ③은 앱에서 8s 가드(statement_timeout)로 잘려 추이 null 로 degrade |
| website | 4.19 s | 1 | `aggregateWebsiteCitationAccuracy` — ⑤ 단일 문장 |
| regions | 465 ms | 1 | `listMeasuredRegions(rootScoped)` — ⑥ 단일 문장 |

## 기준선 요약 (EXPLAIN ANALYZE, BUFFERS · 2패스)

| # | 문장 | exec p1 | exec p2 | planning | shared hit / read (p1) | temp written | 루트 노드 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | ① 루트 스냅샷 답변셋 — rootFullCycleAnswerIds (CREATE TEMP _answer_set 의 SELECT) | **2.31 s** | 2.34 s | 2 ms | 706,769 / 0 | 2,025 | `Nested Loop Semi Join  (cost=144260.42..145059.14 rows=515 width=27) (` |
| 2 | ② 언급 헤드라인 brandRows — ROLLUP_NAMES 재귀 CTE + canonRollup regex + 비경쟁 제외 | **4.94 s** | 4.93 s | 7 ms | 81,705 / 0 | 3,002 | `Sort  (cost=210926.86..210927.36 rows=200 width=73) (actual time=4936.` |
| 3 | ③ 언급 주별 추이 — allRuns 120일 DISTINCT ON(주,셀) + mention 조인 (앱은 8s 가드) | **32.14 s** | 32.68 s | 6 ms | 186,129 / 0 | 17,581 | `HashAggregate  (cost=310337.31..368481.50 rows=435741 width=68) (actua` |
| 4 | ④ 코어 KPI ⑤ 인용 점유율 — c2/ub (카탈로그 base 프리픽스 LIKE ANY) | **2.96 s** | 3.05 s | 1 ms | 219,793 / 0 | 19,057 | `Aggregate  (cost=1195565.43..1195565.44 rows=1 width=12) (actual time=` |
| 5 | ⑤ 웹사이트 ⑥ 타겟 출처 인용률 — snap + target_set + 선언 base 판정 | **4.49 s** | 4.50 s | 2 ms | 440,297 / 0 | 29,288 | `Aggregate  (cost=930436.88..930436.90 rows=1 width=8) (actual time=445` |
| 6 | ⑥ listMeasuredRegions — 루트 카탈로그 게이트 + 기본 창 DISTINCT region | **135 ms** | 132 ms | 1 ms | 31,045 / 0 | 0 | `Sort  (cost=54193.36..54193.53 rows=67 width=3) (actual time=134.603..` |

- exec = Execution Time(서버 측). p1/p2 가 거의 같으면 캐시 상태가 아니라 CPU 작업이 지배한다는 뜻.
- shared read 가 0에 가까우면 버퍼 캐시 히트 — 이 기준선은 **워밍된 캐시** 상태의 하한에 가깝다. 콜드(서버리스 첫 요청·다른 리전 캐시 미스)는 더 길다.
- temp written > 0 은 work_mem 초과 스필(정렬·해시). 산정 감사 F7 의 139 MB 스필은 추이 인용 문장이라 여기 6종엔 없다.

## 문장별 상세 — 뜨거운 노드(포함 시간 = actual end × loops 상위)


### ① 루트 스냅샷 답변셋 — rootFullCycleAnswerIds (CREATE TEMP _answer_set 의 SELECT)

- exec **2.31 s** (p2 2.34 s) · planning 2 ms · `Buffers: shared hit=706769, temp read=2024 written=2025`

| 포함 시간 | 노드 | rows | loops |
| ---: | --- | ---: | ---: |
| 2.31 s | `Nested Loop Semi Join` | 37,570 | 1 |
| 2.15 s | `Nested Loop` | 56,386 | 1 |
| 1.88 s | `HashAggregate` | 56,386 | 1 |
| 1.84 s | `Unique` | 56,386 | 1 |
| 1.82 s | `Merge Join` | 88,488 | 1 |
| 1.53 s | `GroupAggregate` | 22,740 | 1 |
| 682 ms | `Sort` | 30,348 | 3 |
| 638 ms | `Sort` | 330,803 | 1 |

<details><summary>문장 (바인드 값 제외)</summary>

```sql
SELECT a.job_id, a.region, a.measured_at FROM scope_answers a WHERE a.status = 'completed' AND a.job_id IN (
    WITH active_cells AS (
      SELECT DISTINCT a.target, a.region
      FROM scope_answers a
      JOIN scope_runs r ON r.run_id = a.run_id
      WHERE true AND r.status IN ('completed', 'partial_failed') AND a.status = 'completed'
        AND r.started_at >= now() - interval '7 days'
        AND a.region NOT IN ($1)
        AND NOT (
    a.region <> 'KR'
    AND a.prompt_id IS NOT NULL
    AND a.prompt_id IN (SELECT sp.prompt_id FROM scope_prompts sp WHERE sp.is_korean)
  )
        AND (
    a.prompt_id IS NULL
    OR a.prompt_id NOT IN (
      SELECT sp.prompt_id FROM scope_prompts sp
      WHERE sp.prompt_id IS NOT NULL
        AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
    OR (a.prompt_id, a.region) IN (
      SELECT sp.prompt_id, r FROM scope_prompts sp, unnest(sp.regions) AS r
      WHERE sp.prompt_id IS NOT NULL
        AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
  )
    ),
    cell_counts AS (
      SELECT a.prompt_id,
        count(DISTINCT (a.target, a.region)) FILTER (
          WHERE (a.target, a.region) IN (SELECT ac.target, ac.region FROM active_cells ac)
        ) AS expected_cells,
        count(DISTINCT (a.target, a.region)) FILTER (WHERE r.started_at >= now() - interval '7 days') AS window_cells
      FROM scope_answers a
      JOIN scope_runs r ON r.run_id = a.run_id
      WHERE true AND r.status IN ('completed', 'partial_failed') AND a.status = 'completed'
        AND a.region NOT IN ($2)
        AND NOT (
    a.region <> 'KR'
    AND a.prompt_id IS NOT NULL
    AND a.prompt_id IN (SELECT sp.prompt_id FROM scope_prompts sp WHERE sp.is_korean)
  )
        AND (
    a.prompt_id IS NULL
    OR a.prompt_id NOT IN (
      SELECT sp.prompt_id FROM scope_prompts sp
      WHERE sp.prompt_id IS NOT NULL
        AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
    OR (a.prompt_id, a.region) IN (
      SELECT sp.prompt_id, r FROM scope_prompts sp, unnest(sp.regions) AS r
      WHERE sp.prompt_id IS NOT NULL
        AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
  )
      GROUP BY a.prompt_id
    )
    SELECT DISTINCT ON (a.prompt_id, a.target, a.region) a.job_id
    FROM scope_answers a
    JOIN scope_runs r ON r.run_id = a.run_id
    JOIN cell_counts cc ON cc.prompt_id = a.prompt_id AND cc.window_cells >= cc.expected_cells
    WHERE true
      AND r.status IN ('completed', 'partial_failed')
      AND a.status = 'completed'
      AND r.started_at >= now() - interval '7 days'
      AND a.region NOT IN ($3)
      AND NOT (
    a.region <> 'KR'
    AND a.prompt_id IS NOT NULL
    AND a.prompt_id IN (SELECT sp.prompt_id FROM scope_prompts sp WHERE sp.is_korean)
  )
      AND (
    a.prompt_id IS NULL
    OR a.prompt_id NOT IN (
      SELECT sp.prompt_id FROM scope_prompts sp
      WHERE sp.prompt_id IS NOT NULL
        AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
    OR (a.prompt_id, a.region) IN (
      SELECT sp.prompt_id, r FROM scope_prompts sp, unnest(sp.regions) AS r
      WHERE sp.prompt_id IS NOT NULL
        AND sp.regions IS NOT NULL AND cardinality(sp.regions) > 0
    )
  )
    ORDER BY a.prompt_id, a.target, a.region, a.measured_at DESC
  ) AND a.region NOT IN ($4) AND a.prompt_id IN (SELECT scope_prompt_id FROM prompts WHERE project_id = $5 AND scope_prompt_id IS NOT NULL)
```
</details>

<details><summary>EXPLAIN (ANALYZE, BUFFERS) 전문 — pass 1</summary>

```text
Nested Loop Semi Join  (cost=144260.42..145059.14 rows=515 width=27) (actual time=1866.915..2307.518 rows=37570 loops=1)
  Buffers: shared hit=706769, temp read=2024 written=2025
  ->  Nested Loop  (cost=144260.13..144784.62 rows=869 width=43) (actual time=1866.900..2150.280 rows=56386 loops=1)
        Buffers: shared hit=555397, temp read=2024 written=2025
        ->  HashAggregate  (cost=144259.71..144261.71 rows=200 width=16) (actual time=1866.869..1882.625 rows=56386 loops=1)
              Group Key: a_1.job_id
              Batches: 1  Memory Usage: 6177kB
              Buffers: shared hit=329663, temp read=2024 written=2025
              ->  Unique  (cost=98511.13..144244.29 rows=1233 width=50) (actual time=1134.283..1841.814 rows=56386 loops=1)
                    Buffers: shared hit=329663, temp read=2024 written=2025
                    ->  Merge Join  (cost=98511.13..144235.05 rows=1233 width=50) (actual time=1134.282..1817.977 rows=88488 loops=1)
                          Merge Cond: (a_1.prompt_id = a_2.prompt_id)
                          Buffers: shared hit=329663, temp read=2024 written=2025
                          ->  Gather Merge  (cost=42638.29..43068.98 rows=3698 width=50) (actual time=231.444..267.731 rows=91043 loops=1)
                                Workers Planned: 2
                                Workers Launched: 2
                                Buffers: shared hit=113629
                                ->  Sort  (cost=41638.26..41642.12 rows=1541 width=50) (actual time=224.329..227.413 rows=30348 loops=3)
                                      Sort Key: a_1.prompt_id, a_1.target, a_1.region, a_1.measured_at DESC
                                      Sort Method: quicksort  Memory: 4074kB
                                      Buffers: shared hit=113629
                                      Worker 0:  Sort Method: quicksort  Memory: 2709kB
                                      Worker 1:  Sort Method: quicksort  Memory: 2692kB
                                      ->  Hash Join  (cost=4409.70..41556.67 rows=1541 width=50) (actual time=38.920..204.210 rows=30348 loops=3)
                                            Hash Cond: (a_1.run_id = r.run_id)
                                            Buffers: shared hit=113583
                                            ->  Parallel Index Only Scan using scope_answers_run_cycle_idx on scope_answers a_1  (cost=3433.42..40406.95 rows=66064 width=66) (actual time=11.120..179.936 rows=110268 loops=3)
                                                  Filter: ((region <> 'ID'::text) AND ((region = 'KR'::text) OR (prompt_id IS NULL) OR (NOT (ANY (prompt_id = (hashed SubPlan 1).col1)))) AND ((prompt_id IS NULL) OR (NOT (ANY (prompt_id = (hashed SubPlan 2).col1))) OR (ANY ((prompt_id = (hashed SubPla …[+53 chars]
                                                  Rows Removed by Filter: 15385
                                                  Heap Fetches: 83357
                                                  Buffers: shared hit=112152
                                                  SubPlan 1
                                                    ->  Seq Scan on scope_prompts sp  (cost=0.00..989.62 rows=2262 width=16) (actual time=0.036..3.711 rows=2262 loops=3)
                                                          Filter: is_korean
                                                          Rows Removed by Filter: 24700
                                                          Buffers: shared hit=2160
                                                  SubPlan 2
                                                    ->  Seq Scan on scope_prompts sp_1  (cost=0.00..1124.43 rows=3976 width=16) (actual time=0.029..5.103 rows=11929 loops=3)
                                                          Filter: ((regions IS NOT NULL) AND (cardinality(regions) > 0))
                                                          Rows Removed by Filter: 15033
                                                          Buffers: shared hit=2160
                                                  SubPlan 3
                                                    ->  Nested Loop  (cost=0.00..1283.47 rows=7952 width=48) (actual time=0.050..20.197 rows=19929 loops=3)
                                                          Buffers: shared hit=2160
                                                          ->  Seq Scan on scope_prompts sp_2  (cost=0.00..1124.43 rows=3976 width=50) (actual time=0.031..5.390 rows=11929 loops=3)
                                                                Filter: ((regions IS NOT NULL) AND (cardinality(regions) > 0))
                                                                Rows Removed by Filter: 15033
                                                                Buffers: shared hit=2160
                                                          ->  Function Scan on unnest r_2  (cost=0.00..0.02 rows=2 width=32) (actual time=0.001..0.001 rows=2 loops=35787)
                                            ->  Hash  (cost=968.90..968.90 rows=590 width=16) (actual time=8.342..8.343 rows=734 loops=3)
                                                  Buckets: 1024  Batches: 1  Memory Usage: 43kB
                                                  Buffers: shared hit=1431
                                                  ->  Seq Scan on scope_runs r  (cost=0.00..968.90 rows=590 width=16) (actual time=6.528..8.184 rows=734 loops=3)
                                                        Filter: ((status = ANY ('{completed,partial_failed}'::text[])) AND (started_at >= (now() - '7 days'::interval)))
                                                        Rows Removed by Filter: 24576
                                                        Buffers: shared hit=1431
                          ->  GroupAggregate  (cost=55872.84..101074.00 rows=5639 width=32) (actual time=902.832..1527.003 rows=22740 loops=1)
                                Group Key: a_2.prompt_id
                                Filter: (count(DISTINCT ROW(a_2.target, a_2.region)) FILTER (WHERE (r_1.started_at >= (now() - '7 days'::interval))) >= count(DISTINCT ROW(a_2.target, a_2.region)) FILTER (WHERE (ANY ((a_2.target = (hashed SubPlan 10).col1) AND (a_2.region = (hashed SubPlan 10).col2)) …[+3 chars]
                                Rows Removed by Filter: 3332
                                Buffers: shared hit=216034, temp read=2024 written=2025
                                ->  Sort  (cost=55872.84..56127.39 rows=101820 width=34) (actual time=583.671..638.477 rows=330803 loops=1)
                                      Sort Key: a_2.prompt_id
                                      Sort Method: external merge  Disk: 16192kB
                                      Buffers: shared hit=105827, temp read=2024 written=2025
                                      ->  Hash Join  (cost=4415.66..47403.63 rows=101820 width=34) (actual time=16.354..418.680 rows=330803 loops=1)
                                            Hash Cond: (a_2.run_id = r_1.run_id)
                                            Buffers: shared hit=105827
                                            ->  Index Only Scan using scope_answers_run_cycle_idx on scope_answers a_2  (cost=3433.42..46005.12 rows=158553 width=42) (actual time=7.797..332.587 rows=330803 loops=1)
                                                  Filter: ((region <> 'ID'::text) AND ((region = 'KR'::text) OR (prompt_id IS NULL) OR (NOT (ANY (prompt_id = (hashed SubPlan 4).col1)))) AND ((prompt_id IS NULL) OR (NOT (ANY (prompt_id = (hashed SubPlan 5).col1))) OR (ANY ((prompt_id = (hashed SubPla …[+53 chars]
                                                  Rows Removed by Filter: 46154
                                                  Heap Fetches: 83357
                                                  Buffers: shared hit=105364
                                                  SubPlan 4
                                                    ->  Seq Scan on scope_prompts sp_3  (cost=0.00..989.62 rows=2262 width=16) (actual time=0.020..3.451 rows=2262 loops=1)
                                                          Filter: is_korean
                                                          Rows Removed by Filter: 24700
                                                          Buffers: shared hit=720
                                                  SubPlan 5
                                                    ->  Seq Scan on scope_prompts sp_4  (cost=0.00..1124.43 rows=3976 width=16) (actual time=0.027..5.109 rows=11929 loops=1)
                                                          Filter: ((regions IS NOT NULL) AND (cardinality(regions) > 0))
                                                          Rows Removed by Filter: 15033
                                                          Buffers: shared hit=720
                                                  SubPlan 6
                                                    ->  Nested Loop  (cost=0.00..1283.47 rows=7952 width=48) (actual time=0.037..20.122 rows=19929 loops=1)
                                                          Buffers: shared hit=720
                                                          ->  Seq Scan on scope_prompts sp_5  (cost=0.00..1124.43 rows=3976 width=50) (actual time=0.025..5.556 rows=11929 loops=1)
                                                                Filter: ((regions IS NOT NULL) AND (cardinality(regions) > 0))
                                                                Rows Removed by Filter: 15033
                                                                Buffers: shared hit=720
                                                          ->  Function Scan on unnest r_3  (cost=0.00..0.02 rows=2 width=32) (actual time=0.001..0.001 rows=2 loops=11929)
                                            ->  Hash  (cost=779.19..779.19 rows=16244 width=24) (actual time=8.542..8.543 rows=16259 loops=1)
                                                  Buckets: 16384  Batches: 1  Memory Usage: 1018kB
                                                  Buffers: shared hit=463
                                                  ->  Seq Scan on scope_runs r_1  (cost=0.00..779.19 rows=16244 width=24) (actual time=0.026..5.475 rows=16259 loops=1)
                                                        Filter: (status = ANY ('{completed,partial_failed}'::text[]))
                                                        Rows Removed by Filter: 9051
                                                        Buffers: shared hit=463
                                SubPlan 10
                                  ->  Unique  (cost=42638.29..42698.26 rows=201 width=10) (actual time=308.240..319.112 rows=102 loops=1)
                                        Buffers: shared hit=110207
                                        ->  Gather Merge  (cost=42638.29..42696.25 rows=402 width=10) (actual time=308.239..319.076 rows=203 loops=1)
                                              Workers Planned: 2
                                              Workers Launched: 1
                                              Buffers: shared hit=110207
                                              ->  Unique  (cost=41638.26..41649.82 rows=201 width=10) (actual time=297.626..307.462 rows=102 loops=2)
                                                    Buffers: shared hit=110207
                                                    ->  Sort  (cost=41638.26..41642.12 rows=1541 width=10) (actual time=297.624..300.606 rows=45522 loops=2)
                                                          Sort Key: a_3.target, a_3.region
                                                          Sort Method: quicksort  Memory: 3067kB
                                                          Buffers: shared hit=110207
                                                          Worker 0:  Sort Method: quicksort  Memory: 2851kB
                                                          ->  Hash Join  (cost=4409.70..41556.67 rows=1541 width=10) (actual time=33.304..252.616 rows=45522 loops=2)
                                                                Hash Cond: (a_3.run_id = r_5.run_id)
                                                                Buffers: shared hit=110199
                                                                ->  Parallel Index Only Scan using scope_answers_run_cycle_idx on scope_answers a_3  (cost=3433.42..40406.95 rows=66064 width=26) (actual time=10.391..220.409 rows=165402 loops=2)
                                                                      Filter: ((region <> 'ID'::text) AND ((region = 'KR'::text) OR (prompt_id IS NULL) OR (NOT (ANY (prompt_id = (hashed SubPlan 7).col1)))) AND ((prompt_id IS NULL) OR (NOT (ANY (prompt_id = (hashed SubPlan 8).col1))) OR (ANY ((prompt …[+73 chars]
                                                                      Rows Removed by Filter: 23077
                                                                      Heap Fetches: 83357
                                                                      Buffers: shared hit=109252
                                                                      SubPlan 7
                                                                        ->  Seq Scan on scope_prompts sp_6  (cost=0.00..989.62 rows=2262 width=16) (actual time=0.029..3.623 rows=2262 loops=2)
                                                                              Filter: is_korean
                                                                              Rows Removed by Filter: 24700
                                                                              Buffers: shared hit=1440
                                                                      SubPlan 8
                                                                        ->  Seq Scan on scope_prompts sp_7  (cost=0.00..1124.43 rows=3976 width=16) (actual time=0.025..5.019 rows=11929 loops=2)
                                                                              Filter: ((regions IS NOT NULL) AND (cardinality(regions) > 0))
                                                                              Rows Removed by Filter: 15033
                                                                              Buffers: shared hit=1440
                                                                      SubPlan 9
                                                                        ->  Nested Loop  (cost=0.00..1283.47 rows=7952 width=48) (actual time=0.042..20.389 rows=19929 loops=2)
                                                                              Buffers: shared hit=1440
                                                                              ->  Seq Scan on scope_prompts sp_8  (cost=0.00..1124.43 rows=3976 width=50) (actual time=0.030..5.547 rows=11929 loops=2)
                                                                                    Filter: ((regions IS NOT NULL) AND (cardinality(regions) > 0))
                                                                                    Rows Removed by Filter: 15033
                                                                                    Buffers: shared hit=1440
                                                                              ->  Function Scan on unnest r_4  (cost=0.00..0.02 rows=2 width=32) (actual time=0.001..0.001 rows=2 loops=23858)
                                                                ->  Hash  (cost=968.90..968.90 rows=590 width=16) (actual time=8.013..8.014 rows=734 loops=2)
                                                                      Buckets: 1024  Batches: 1  Memory Usage: 43kB
                                                                      Buffers: shared hit=947
                                                                      ->  Seq Scan on scope_runs r_5  (cost=0.00..968.90 rows=590 width=16) (actual time=6.384..7.863 rows=734 loops=2)
                                                                            Filter: ((status = ANY ('{completed,partial_failed}'::text[])) AND (started_at >= (now() - '7 days'::interval)))
                                                                            Rows Removed by Filter: 24576
                                                                            Buffers: shared hit=947
        ->  Index Scan using scope_answers_pkey on scope_answers a  (cost=0.42..2.61 rows=1 width=43) (actual time=0.004..0.004 rows=1 loops=56386)
              Index Cond: (job_id = a_1.job_id)
              Filter: ((region <> 'ID'::text) AND (status = 'completed'::text))
              Buffers: shared hit=225628
  ->  Index Scan using prompts_scope_prompt_id_idx on prompts  (cost=0.29..0.31 rows=1 width=16) (actual time=0.002..0.002 rows=1 loops=56386)
        Index Cond: ((scope_prompt_id = a.prompt_id) AND (scope_prompt_id IS NOT NULL))
        Filter: (project_id = '26751906-c175-485c-9e69-29fc68d0fdbb'::uuid)
        Rows Removed by Filter: 0
        Buffers: shared hit=151372
Planning:
  Buffers: shared hit=66
Planning Time: 2.189 ms
Execution Time: 2313.627 ms
```
</details>

### ② 언급 헤드라인 brandRows — ROLLUP_NAMES 재귀 CTE + canonRollup regex + 비경쟁 제외

- exec **4.94 s** (p2 4.93 s) · planning 7 ms · `Buffers: shared hit=81705, local hit=320, temp read=3001 written=3002`
- `_answer_set` 선행: 잡아둔 `CREATE TEMP TABLE _answer_set ON COMMIT DROP AS …`(① 과 같은 SELECT) + `ANALYZE` 를 같은 트랜잭션에서 재실행한 뒤 측정

| 포함 시간 | 노드 | rows | loops |
| ---: | --- | ---: | ---: |
| 4.94 s | `Sort` | 921 | 1 |
| 4.94 s | `GroupAggregate` | 921 | 1 |
| 4.86 s | `Sort` | 145,754 | 1 |
| 4.51 s | `Hash Left Join` | 145,754 | 1 |
| 4.25 s | `Hash` | 921 | 1 |
| 4.25 s | `Subquery Scan on p` | 921 | 1 |
| 4.25 s | `HashAggregate` | 921 | 1 |
| 4.22 s | `HashAggregate` | 92,986 | 1 |

<details><summary>문장 (바인드 값 제외)</summary>

```sql
WITH names AS (
  WITH RECURSIVE _rn_pairs AS (
    (SELECT m.entity_id, m.brand FROM scope_mentions m
      WHERE m.entity_type = 'Brand' AND m.brand IS NOT NULL
      ORDER BY m.entity_id, m.brand LIMIT 1)
    UNION ALL
    SELECT nx.entity_id, nx.brand FROM _rn_pairs p
    CROSS JOIN LATERAL (
      SELECT m.entity_id, m.brand FROM scope_mentions m
      WHERE m.entity_type = 'Brand' AND m.brand IS NOT NULL
        AND (m.entity_id, m.brand) > (p.entity_id, p.brand)
      ORDER BY m.entity_id, m.brand LIMIT 1
    ) nx
  )
  SELECT DISTINCT ON (entity_id) entity_id, brand
  FROM _rn_pairs ORDER BY entity_id, (brand ~ '^[A-Za-z]') DESC, brand
),
    mm AS MATERIALIZED (
      SELECT (CASE COALESCE(n.brand, m.brand) WHEN $1 THEN $2 WHEN $3 THEN $4 WHEN $5 THEN $6 WHEN $7 THEN $8 WHEN $9 THEN $10 WHEN $11 THEN $12 WHEN $13 THEN $14 WHEN $15 THEN $16 WHEN $17 THEN $18 WHEN $19 THEN $20 WHEN $21 THEN $22 WHEN $23 THEN $24 WHEN $25 THEN $26 WHEN $27 THEN $28 WHEN $29 THEN $30 WHEN $31 THEN $32 WHEN $33 THEN $34 WHEN $35 THEN $36 WHEN $37 THEN $38 WHEN $39 THEN $40 WHEN $41 THEN $42 WHEN $43 THEN $44 WHEN $45 THEN $46 WHEN $47 THEN $48 WHEN $49 THEN $50 WHEN $51 THEN $52 WHEN $53 THEN $54 WHEN $55 THEN $56 WHEN $57 THEN $58 WHEN $59 THEN $60 WHEN $61 THEN $62 WHEN $63 THEN $64 WHEN $65 THEN $66 WHEN $67 THEN $68 WHEN $69 THEN $70 WHEN $71 THEN $72 WHEN $73 THEN $74 WHEN $75 THEN $76 ELSE COALESCE(n.brand, m.brand) END) AS name,
        m.job_id, a.prompt_id, m.mention_count, m.avg_position,
        (CASE WHEN m.brand_rollup_entity_id IS NULL THEN m.brand_rollup_entity_id WHEN m.brand ~* $77 THEN $78 WHEN m.brand ~* $79 THEN $80 WHEN m.brand ~* $81 THEN $82 ELSE (CASE m.brand_rollup_entity_id WHEN $83 THEN $84 WHEN $85 THEN $86 WHEN $87 THEN $88 WHEN $89 THEN $90 WHEN $91 THEN $92 WHEN $93 THEN $94 WHEN $95 THEN $96 ELSE m.brand_rollup_entity_id END) END) IN ($97, $98, $99, $100, $101, $102, $103, $104, $105, $106) AS is_trk,
        m.type_mention, m.type_recommendation, m.type_comparison,
        m.type_definition, m.type_final_choice
      FROM scope_mentions m
      JOIN _answer_set a ON a.job_id = m.job_id
      LEFT JOIN names n ON n.entity_id = (CASE WHEN m.brand_rollup_entity_id IS NULL THEN m.brand_rollup_entity_id WHEN m.brand ~* $107 THEN $108 WHEN m.brand ~* $109 THEN $110 WHEN m.brand ~* $111 THEN $112 ELSE (CASE m.brand_rollup_entity_id WHEN $113 THEN $114 WHEN $115 THEN $116 WHEN $117 THEN $118 WHEN $119 THEN $120 WHEN $121 THEN $122 WHEN $123 THEN $124 WHEN $125 THEN $126 ELSE m.brand_rollup_entity_id END) END)
      WHERE m.brand_rollup_entity_id IS NOT NULL
        AND COALESCE(n.brand, m.brand) IS NOT NULL
        AND (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $127 THEN $128 WHEN $129 THEN $130 WHEN $131 THEN $132 WHEN $133 THEN $134 WHEN $135 THEN $136 WHEN $137 THEN $138 WHEN $139 THEN $140 WHEN $141 THEN $142 WHEN $143 THEN $144 WHEN $145 THEN $146 WHEN $147 THEN $148 WHEN $149 THEN $150 WHEN $151 THEN $152 WHEN $153 THEN $154 WHEN $155 THEN $156 WHEN $157 THEN $158 WHEN $159 THEN $160 WHEN $161 THEN $162 WHEN $163 THEN $164 WHEN $165 THEN $166 WHEN $167 THEN $168 WHEN $169 THEN $170 WHEN $171 THEN $172 WHEN $173 THEN $174 WHEN $175 THEN $176 WHEN $177 THEN $178 WHEN $179 THEN $180 WHEN $181 THEN $182 WHEN $183 THEN $184 WHEN $185 THEN $186 WHEN $187 THEN $188 WHEN $189 THEN $190 WHEN $191 THEN $192 WHEN $193 THEN $194 WHEN $195 THEN $196 WHEN $197 THEN $198 WHEN $199 THEN $200 WHEN $201 THEN $202 ELSE COALESCE(n.brand, m.brand) END), $203)) NOT IN ($204, $205, $206, $207, $208, $209, $210, $211, $212, $213, $214, $215, $216, $217, $218, $219, $220, $221, $222, $223, $224, $225, $226, $227, $228, $229, $230, $231, $232, $233, $234, $235, $236, $237, $238, $239, $240, $241, $242, $243, $244, $245, $246, $247, $248, $249, $250, $251, $252, $253, $254, $255, $256, $257, $258, $259, $260, $261, $262, $263, $264, $265, $266, $267, $268, $269, $270, $271, $272, $273, $274, $275, $276, $277, $278, $279, $280, $281, $282, $283, $284, $285, $286, $287, $288, $289, $290, $291, $292, $293, $294, $295, $296, $297, $298, $299, $300, $301, $302, $303, $304, $305, $306, $307, $308, $309, $310, $311, $312, $313, $314, $315, $316, $317, $318, $319, $320, $321, $322, $323, $324, $325, $326, $327, $328, $329, $330, $331, $332, $333, $334, $335, $336, $337, $338, $339, $340, $341, $342, $343, $344, $345, $346, $347, $348, $349, $350, $351, $352, $353, $354, $355, $356, $357, $358, $359, $360, $361) OR (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $362 THEN $363 WHEN $364 THEN $365 WHEN $366 THEN $367 WHEN $368 THEN $369 WHEN $370 THEN $371 WHEN $372 THEN $373 WHEN $374 THEN $375 WHEN $376 THEN $377 WHEN $378 THEN $379 WHEN $380 THEN $381 WHEN $382 THEN $383 WHEN $384 THEN $385 WHEN $386 THEN $387 WHEN $388 THEN $389 WHEN $390 THEN $391 WHEN $392 THEN $393 WHEN $394 THEN $395 WHEN $396 THEN $397 WHEN $398 THEN $399 WHEN $400 THEN $401 WHEN $402 THEN $403 WHEN $404 THEN $405 WHEN $406 THEN $407 WHEN $408 THEN $409 WHEN $410 THEN $411 WHEN $412 THEN $413 WHEN $414 THEN $415 WHEN $416 THEN $417 WHEN $418 THEN $419 WHEN $420 THEN $421 WHEN $422 THEN $423 WHEN $424 THEN $425 WHEN $426 THEN $427 WHEN $428 THEN $429 WHEN $430 THEN $431 WHEN $432 THEN $433 WHEN $434 THEN $435 WHEN $436 THEN $437 ELSE COALESCE(n.brand, m.brand) END), $438)) = $439 AND m.brand ~* $440) OR (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $441 THEN $442 WHEN $443 THEN $444 WHEN $445 THEN $446 WHEN $447 THEN $448 WHEN $449 THEN $450 WHEN $451 THEN $452 WHEN $453 THEN $454 WHEN $455 THEN $456 WHEN $457 THEN $458 WHEN $459 THEN $460 WHEN $461 THEN $462 WHEN $463 THEN $464 WHEN $465 THEN $466 WHEN $467 THEN $468 WHEN $469 THEN $470 WHEN $471 THEN $472 WHEN $473 THEN $474 WHEN $475 THEN $476 WHEN $477 THEN $478 WHEN $479 THEN $480 WHEN $481 THEN $482 WHEN $483 THEN $484 WHEN $485 THEN $486 WHEN $487 THEN $488 WHEN $489 THEN $490 WHEN $491 THEN $492 WHEN $493 THEN $494 WHEN $495 THEN $496 WHEN $497 THEN $498 WHEN $499 THEN $500 WHEN $501 THEN $502 WHEN $503 THEN $504 WHEN $505 THEN $506 WHEN $507 THEN $508 WHEN $509 THEN $510 WHEN $511 THEN $512 WHEN $513 THEN $514 WHEN $515 THEN $516 ELSE COALESCE(n.brand, m.brand) END), $517)) = $518 AND m.brand ~* $519) OR (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $520 THEN $521 WHEN $522 THEN $523 WHEN $524 THEN $525 WHEN $526 THEN $527 WHEN $528 THEN $529 WHEN $530 THEN $531 WHEN $532 THEN $533 WHEN $534 THEN $535 WHEN $536 THEN $537 WHEN $538 THEN $539 WHEN $540 THEN $541 WHEN $542 THEN $543 WHEN $544 THEN $545 WHEN $546 THEN $547 WHEN $548 THEN $549 WHEN $550 THEN $551 WHEN $552 THEN $553 WHEN $554 THEN $555 WHEN $556 THEN $557 WHEN $558 THEN $559 WHEN $560 THEN $561 WHEN $562 THEN $563 WHEN $564 THEN $565 WHEN $566 THEN $567 WHEN $568 THEN $569 WHEN $570 THEN $571 WHEN $572 THEN $573 WHEN $574 THEN $575 WHEN $576 THEN $577 WHEN $578 THEN $579 WHEN $580 THEN $581 WHEN $582 THEN $583 WHEN $584 THEN $585 WHEN $586 THEN $587 WHEN $588 THEN $589 WHEN $590 THEN $591 WHEN $592 THEN $593 WHEN $594 THEN $595 ELSE COALESCE(n.brand, m.brand) END), $596)) = $597 AND m.brand ~* $598) OR (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $599 THEN $600 WHEN $601 THEN $602 WHEN $603 THEN $604 WHEN $605 THEN $606 WHEN $607 THEN $608 WHEN $609 THEN $610 WHEN $611 THEN $612 WHEN $613 THEN $614 WHEN $615 THEN $616 WHEN $617 THEN $618 WHEN $619 THEN $620 WHEN $621 THEN $622 WHEN $623 THEN $624 WHEN $625 THEN $626 WHEN $627 THEN $628 WHEN $629 THEN $630 WHEN $631 THEN $632 WHEN $633 THEN $634 WHEN $635 THEN $636 WHEN $637 THEN $638 WHEN $639 THEN $640 WHEN $641 THEN $642 WHEN $643 THEN $644 WHEN $645 THEN $646 WHEN $647 THEN $648 WHEN $649 THEN $650 WHEN $651 THEN $652 WHEN $653 THEN $654 WHEN $655 THEN $656 WHEN $657 THEN $658 WHEN $659 THEN $660 WHEN $661 THEN $662 WHEN $663 THEN $664 WHEN $665 THEN $666 WHEN $667 THEN $668 WHEN $669 THEN $670 WHEN $671 THEN $672 WHEN $673 THEN $674 ELSE COALESCE(n.brand, m.brand) END), $675)) = $676 AND m.b
-- …[+22822 chars 생략 — 바인드 플레이스홀더 목록]
```
</details>

<details><summary>EXPLAIN (ANALYZE, BUFFERS) 전문 — pass 1</summary>

```text
Sort  (cost=210926.86..210927.36 rows=200 width=73) (actual time=4936.833..4936.980 rows=921 loops=1)
  Sort Key: ((sum(mm.mention_count))::integer) DESC
  Sort Method: quicksort  Memory: 91kB
  Buffers: shared hit=81705, local hit=320, temp read=3001 written=3002
  CTE mm
    ->  Hash Left Join  (cost=1227.92..167376.26 rows=202830 width=93) (actual time=183.293..4165.142 rows=145754 loops=1)
          Hash Cond: (CASE WHEN (m_2.brand_rollup_entity_id IS NULL) THEN m_2.brand_rollup_entity_id WHEN (m_2.brand ~* '^[	

                  　﻿]*(Genesis|제네시스|جينيسيس)([^[:alnum:]]|$)'::text) THEN '00000000-0000-0000-0000-000000000304'::uuid WHEN (m_2.brand ~* '^[	

                  　﻿]*(Hyundai|현대자동차|현대차|현대|هيونداي|יונדאי)([^[:alnum:]]|$)'::text) THEN '00000000-0000-0000-0000-000000000301'::uuid WHEN (m_2.brand ~* '^[	

                  　﻿]*(Kia|기아|كيا|קיה)([^[:alnum:]]|$)'::text) THEN '00000000-0000-0000-0000-000000000302'::uuid ELSE CASE m_2.brand_rollup_entity_id WHEN 'e0348d5f-afe4-48e6-aa99-1dee566f2822'::uuid THEN '00000000-0000-0000-0000-000000000301'::uuid WHEN 'c6dc2ca3-0fc9-42bc-b255-6fbfdb394e45'::uu …[+607 chars]
          Filter: ((COALESCE(n.brand, m_2.brand) IS NOT NULL) AND ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text …[+1351 chars]

                  　﻿'::text)) <> ALL ('{apple,google,samsung,pilot,falcon,century,element,lightning,punch,one,integra,bolt,fit,focus,legacy,charger,city,edge,is,vision,volt,crown,golf,transit,gravity,fastback,"dual electronics",across,advanced,clever,contact,dealership,drift,five,flat,guest,impac …[+2879 chars]

                  　﻿'::text)) = 'smart'::text) AND (m_2.brand ~* '^[	

                  　﻿]*smart[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1340 chars]

                  　﻿'::text)) = 'cruise'::text) AND (m_2.brand ~* '^[	

                  　﻿]*cruise[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيو …[+1341 chars]

                  　﻿'::text)) = 'international'::text) AND (m_2.brand ~* '^[	

                  　﻿]*international[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WH …[+1348 chars]

                  　﻿'::text)) = 'pilot'::text) AND (m_2.brand ~* '^[	

                  　﻿]*pilot[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1340 chars]

                  　﻿'::text)) = 'falcon'::text) AND (m_2.brand ~* '^[	

                  　﻿]*falcon[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيو …[+1341 chars]

                  　﻿'::text)) = 'century'::text) AND (m_2.brand ~* '^[	

                  　﻿]*century[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هي …[+1342 chars]

                  　﻿'::text)) = 'element'::text) AND (m_2.brand ~* '^[	

                  　﻿]*element[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هي …[+1342 chars]

                  　﻿'::text)) = 'lightning'::text) AND (m_2.brand ~* '^[	

                  　﻿]*lightning[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN ' …[+1344 chars]

                  　﻿'::text)) = 'punch'::text) AND (m_2.brand ~* '^[	

                  　﻿]*punch[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1340 chars]

                  　﻿'::text)) = 'one'::text) AND (m_2.brand ~* '^[	

                  　﻿]*one[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوندا …[+1338 chars]

                  　﻿'::text)) = 'integra'::text) AND (m_2.brand ~* '^[	

                  　﻿]*integra[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هي …[+1342 chars]

                  　﻿'::text)) = 'bolt'::text) AND (m_2.brand ~* '^[	

                  　﻿]*bolt[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوند …[+1339 chars]

                  　﻿'::text)) = 'fit'::text) AND (m_2.brand ~* '^[	

                  　﻿]*fit[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوندا …[+1338 chars]

                  　﻿'::text)) = 'focus'::text) AND (m_2.brand ~* '^[	

                  　﻿]*focus[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1340 chars]

                  　﻿'::text)) = 'legacy'::text) AND (m_2.brand ~* '^[	

                  　﻿]*legacy[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيو …[+1341 chars]

                  　﻿'::text)) = 'charger'::text) AND (m_2.brand ~* '^[	

                  　﻿]*charger[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هي …[+1342 chars]

                  　﻿'::text)) = 'city'::text) AND (m_2.brand ~* '^[	

                  　﻿]*city[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوند …[+1339 chars]

                  　﻿'::text)) = 'edge'::text) AND (m_2.brand ~* '^[	

                  　﻿]*edge[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوند …[+1339 chars]

                  　﻿'::text)) = 'is'::text) AND (m_2.brand ~* '^[	

                  　﻿]*is[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي …[+1337 chars]

                  　﻿'::text)) = 'vision'::text) AND (m_2.brand ~* '^[	

                  　﻿]*vision[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيو …[+1341 chars]

                  　﻿'::text)) = 'volt'::text) AND (m_2.brand ~* '^[	

                  　﻿]*volt[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوند …[+1339 chars]

                  　﻿'::text)) = 'crown'::text) AND (m_2.brand ~* '^[	

                  　﻿]*crown[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1340 chars]

                  　﻿'::text)) = 'golf'::text) AND (m_2.brand ~* '^[	

                  　﻿]*golf[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوند …[+1339 chars]

                  　﻿'::text)) = 'transit'::text) AND (m_2.brand ~* '^[	

                  　﻿]*transit[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هي …[+1342 chars]

                  　﻿'::text)) = 'gravity'::text) AND (m_2.brand ~* '^[	

                  　﻿]*gravity[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هي …[+1342 chars]

                  　﻿'::text)) = 'fastback'::text) AND (m_2.brand ~* '^[	

                  　﻿]*fastback[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m_2.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'ه …[+1343 chars]

                  　﻿'::text)) = 'dual electronics'::text) AND (m_2.brand ~* '^[	

                  　﻿]*dual electronics[^[:alnum:]]'::text))))
          Rows Removed by Filter: 26240
          Buffers: shared hit=81705, local hit=320
          ->  Hash Join  (cost=1165.33..123822.10 rows=970686 width=86) (actual time=164.995..1040.591 rows=171994 loops=1)
                Hash Cond: (m_2.job_id = a.job_id)
                Buffers: shared hit=75207, local hit=320
                ->  Seq Scan on scope_mentions m_2  (cost=0.00..104557.79 rows=2237900 width=70) (actual time=0.019..708.426 rows=2194902 loops=1)
                      Filter: (brand_rollup_entity_id IS NOT NULL)
                      Rows Removed by Filter: 695595
                      Buffers: shared hit=75207
                ->  Hash  (cost=695.70..695.70 rows=37570 width=32) (actual time=13.027..13.028 rows=37570 loops=1)
                      Buckets: 65536  Batches: 1  Memory Usage: 2861kB
                      Buffers: local hit=320
                      ->  Seq Scan on _answer_set a  (cost=0.00..695.70 rows=37570 width=32) (actual time=0.009..4.578 rows=37570 loops=1)
                            Buffers: local hit=320
          ->  Hash  (cost=60.91..60.91 rows=101 width=48) (actual time=17.966..17.972 rows=1568 loops=1)
                Buckets: 2048 (originally 1024)  Batches: 1 (originally 1)  Memory Usage: 106kB
                Buffers: shared hit=6498
                ->  Subquery Scan on n  (cost=59.40..60.91 rows=101 width=48) (actual time=17.091..17.652 rows=1568 loops=1)
                      Buffers: shared hit=6498
                      ->  Unique  (cost=59.40..59.90 rows=101 width=49) (actual time=17.089..17.442 rows=1568 loops=1)
                            Buffers: shared hit=6498
                            CTE _rn_pairs
                              ->  Recursive Union  (cost=0.43..53.76 rows=101 width=26) (actual time=0.038..15.422 rows=1569 loops=1)
                                    Buffers: shared hit=6498
                                    ->  Limit  (cost=0.43..0.46 rows=1 width=26) (actual time=0.036..0.038 rows=1 loops=1)
                                          Buffers: shared hit=4
                                          ->  Index Only Scan using scope_mentions_rollup_names_idx on scope_mentions m  (cost=0.43..34902.92 rows=1041953 width=26) (actual time=0.035..0.036 rows=1 loops=1)
                                                Index Cond: (entity_type = 'Brand'::text)
                                                Heap Fetches: 0
                                                Buffers: shared hit=4
                                    ->  Nested Loop  (cost=0.43..5.23 rows=10 width=26) (actual time=0.009..0.009 rows=1 loops=1569)
                                          Buffers: shared hit=6494
                                          ->  WorkTable Scan on _rn_pairs p_1  (cost=0.00..0.20 rows=10 width=48) (actual time=0.000..0.000 rows=1 loops=1569)
                                          ->  Limit  (cost=0.43..0.49 rows=1 width=26) (actual time=0.009..0.009 rows=1 loops=1569)
                                                Buffers: shared hit=6494
                                                ->  Index Only Scan using scope_mentions_rollup_names_idx on scope_mentions m_1  (cost=0.43..21848.74 rows=347318 width=26) (actual time=0.008..0.008 rows=1 loops=1569)
                                                      Index Cond: ((entity_type = 'Brand'::text) AND (ROW(entity_id, brand) > ROW(p_1.entity_id, p_1.brand)))
                                                      Heap Fetches: 760
                                                      Buffers: shared hit=6494
                            ->  Sort  (cost=5.63..5.89 rows=101 width=49) (actual time=17.088..17.182 rows=1569 loops=1)
                                  Sort Key: _rn_pairs.entity_id, ((_rn_pairs.brand ~ '^[A-Za-z]'::text)) DESC, _rn_pairs.brand
                                  Sort Method: quicksort  Memory: 120kB
                                  Buffers: shared hit=6498
                                  ->  CTE Scan on _rn_pairs  (cost=0.00..2.27 rows=101 width=49) (actual time=0.070..16.688 rows=1569 loops=1)
                                        Buffers: shared hit=6498
  ->  GroupAggregate  (cost=36944.98..43542.95 rows=200 width=73) (actual time=4828.038..4936.474 rows=921 loops=1)
        Group Key: mm.name
        Buffers: shared hit=81705, local hit=320, temp read=3001 written=3002
        ->  Sort  (cost=36944.98..37452.05 rows=202830 width=97) (actual time=4828.008..4860.024 rows=145754 loops=1)
              Sort Key: mm.name, mm.job_id
              Sort Method: external merge  Disk: 12304kB
              Buffers: shared hit=81705, local hit=320, temp read=3001 written=3002
              ->  Hash Left Join  (cost=7966.79..12567.10 rows=202830 width=97) (actual time=4429.287..4510.732 rows=145754 loops=1)
                    Hash Cond: (mm.name = p.name)
                    Buffers: shared hit=81705, local hit=320, temp read=1463 written=1463
                    ->  CTE Scan on mm  (cost=0.00..4056.60 rows=202830 width=89) (actual time=183.296..206.334 rows=145754 loops=1)
                          Buffers: shared hit=16617, local hit=320, temp read=1463 written=1
                    ->  Hash  (cost=7964.29..7964.29 rows=200 width=40) (actual time=4245.978..4245.980 rows=921 loops=1)
                          Buckets: 1024  Batches: 1  Memory Usage: 54kB
                          Buffers: shared hit=65088, temp written=1462
                          ->  Subquery Scan on p  (cost=7959.79..7964.29 rows=200 width=40) (actual time=4245.449..4245.765 rows=921 loops=1)
                                Buffers: shared hit=65088, temp written=1462
                                ->  HashAggregate  (cost=7959.79..7962.29 rows=200 width=40) (actual time=4245.448..4245.654 rows=921 loops=1)
                                      Group Key: mm_1.name
                                      Batches: 1  Memory Usage: 209kB
                                      Buffers: shared hit=65088, temp written=1462
                                      ->  HashAggregate  (cost=5577.82..6443.99 rows=86617 width=52) (actual time=4196.601..4222.418 rows=92986 loops=1)
                                            Group Key: mm_1.name, mm_1.job_id
                                            Batches: 1  Memory Usage: 12305kB
                                            Buffers: shared hit=65088, temp written=1462
                                            ->  CTE Scan on mm mm_1  (cost=0.00..4056.60 rows=202830 width=52) (actual time=0.002..4109.446 rows=145754 loops=1)
                                                  Filter: (avg_position IS NOT NULL)
                                                  Buffers: shared hit=65088, temp written=1462
Planning:
  Buffers: shared hit=21
Planning Time: 6.833 ms
Execution Time: 4942.693 ms
```
</details>

### ③ 언급 주별 추이 — allRuns 120일 DISTINCT ON(주,셀) + mention 조인 (앱은 8s 가드)

- exec **32.14 s** (p2 32.68 s) · planning 6 ms · `Buffers: shared hit=186129, temp read=17581 written=17581`

| 포함 시간 | 노드 | rows | loops |
| ---: | --- | ---: | ---: |
| 32.13 s | `HashAggregate` | 2,473 | 1 |
| 31.87 s | `Hash Join` | 776,104 | 1 |
| 29.68 s | `Hash` | 1,952,960 | 1 |
| 28.76 s | `Hash Left Join` | 1,952,960 | 1 |
| 1.14 s | `Seq Scan on scope_mentions m` | 2,194,902 | 1 |
| 569 ms | `CTE Scan on ans` | 100,130 | 1 |
| 542 ms | `Unique` | 100,130 | 1 |
| 510 ms | `Sort` | 132,693 | 1 |

<details><summary>문장 (바인드 값 제외)</summary>

```sql
WITH names AS (
  WITH RECURSIVE _rn_pairs AS (
    (SELECT m.entity_id, m.brand FROM scope_mentions m
      WHERE m.entity_type = 'Brand' AND m.brand IS NOT NULL
      ORDER BY m.entity_id, m.brand LIMIT 1)
    UNION ALL
    SELECT nx.entity_id, nx.brand FROM _rn_pairs p
    CROSS JOIN LATERAL (
      SELECT m.entity_id, m.brand FROM scope_mentions m
      WHERE m.entity_type = 'Brand' AND m.brand IS NOT NULL
        AND (m.entity_id, m.brand) > (p.entity_id, p.brand)
      ORDER BY m.entity_id, m.brand LIMIT 1
    ) nx
  )
  SELECT DISTINCT ON (entity_id) entity_id, brand
  FROM _rn_pairs ORDER BY entity_id, (brand ~ '^[A-Za-z]') DESC, brand
),
    ans AS MATERIALIZED (
      SELECT DISTINCT ON (a.prompt_id, a.target, a.region, date_trunc('week', a.measured_at))
        a.job_id, date_trunc('week', a.measured_at) AS wk
      FROM scope_answers a
      WHERE a.measured_at IS NOT NULL AND a.measured_at >= now() - interval '120 days' AND a.status = 'completed' AND a.run_id IN (SELECT run_id FROM scope_runs WHERE true) AND a.region NOT IN ($1) AND a.prompt_id IN (SELECT scope_prompt_id FROM prompts WHERE project_id = $2 AND scope_prompt_id IS NOT NULL)
      ORDER BY a.prompt_id, a.target, a.region, date_trunc('week', a.measured_at),
        a.measured_at DESC
    )
    SELECT to_char(ans.wk, 'YYYY-MM-DD') AS day,
      (CASE COALESCE(n.brand, m.brand) WHEN $3 THEN $4 WHEN $5 THEN $6 WHEN $7 THEN $8 WHEN $9 THEN $10 WHEN $11 THEN $12 WHEN $13 THEN $14 WHEN $15 THEN $16 WHEN $17 THEN $18 WHEN $19 THEN $20 WHEN $21 THEN $22 WHEN $23 THEN $24 WHEN $25 THEN $26 WHEN $27 THEN $28 WHEN $29 THEN $30 WHEN $31 THEN $32 WHEN $33 THEN $34 WHEN $35 THEN $36 WHEN $37 THEN $38 WHEN $39 THEN $40 WHEN $41 THEN $42 WHEN $43 THEN $44 WHEN $45 THEN $46 WHEN $47 THEN $48 WHEN $49 THEN $50 WHEN $51 THEN $52 WHEN $53 THEN $54 WHEN $55 THEN $56 WHEN $57 THEN $58 WHEN $59 THEN $60 WHEN $61 THEN $62 WHEN $63 THEN $64 WHEN $65 THEN $66 WHEN $67 THEN $68 WHEN $69 THEN $70 WHEN $71 THEN $72 WHEN $73 THEN $74 WHEN $75 THEN $76 WHEN $77 THEN $78 ELSE COALESCE(n.brand, m.brand) END) AS key,
      sum(m.mention_count)::int AS n
    FROM scope_mentions m
    JOIN ans ON ans.job_id = m.job_id
    LEFT JOIN names n ON n.entity_id = (CASE WHEN m.brand_rollup_entity_id IS NULL THEN m.brand_rollup_entity_id WHEN m.brand ~* $79 THEN $80 WHEN m.brand ~* $81 THEN $82 WHEN m.brand ~* $83 THEN $84 ELSE (CASE m.brand_rollup_entity_id WHEN $85 THEN $86 WHEN $87 THEN $88 WHEN $89 THEN $90 WHEN $91 THEN $92 WHEN $93 THEN $94 WHEN $95 THEN $96 WHEN $97 THEN $98 ELSE m.brand_rollup_entity_id END) END)
    WHERE m.brand_rollup_entity_id IS NOT NULL AND COALESCE(n.brand, m.brand) IS NOT NULL
      AND (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $99 THEN $100 WHEN $101 THEN $102 WHEN $103 THEN $104 WHEN $105 THEN $106 WHEN $107 THEN $108 WHEN $109 THEN $110 WHEN $111 THEN $112 WHEN $113 THEN $114 WHEN $115 THEN $116 WHEN $117 THEN $118 WHEN $119 THEN $120 WHEN $121 THEN $122 WHEN $123 THEN $124 WHEN $125 THEN $126 WHEN $127 THEN $128 WHEN $129 THEN $130 WHEN $131 THEN $132 WHEN $133 THEN $134 WHEN $135 THEN $136 WHEN $137 THEN $138 WHEN $139 THEN $140 WHEN $141 THEN $142 WHEN $143 THEN $144 WHEN $145 THEN $146 WHEN $147 THEN $148 WHEN $149 THEN $150 WHEN $151 THEN $152 WHEN $153 THEN $154 WHEN $155 THEN $156 WHEN $157 THEN $158 WHEN $159 THEN $160 WHEN $161 THEN $162 WHEN $163 THEN $164 WHEN $165 THEN $166 WHEN $167 THEN $168 WHEN $169 THEN $170 WHEN $171 THEN $172 WHEN $173 THEN $174 ELSE COALESCE(n.brand, m.brand) END), $175)) NOT IN ($176, $177, $178, $179, $180, $181, $182, $183, $184, $185, $186, $187, $188, $189, $190, $191, $192, $193, $194, $195, $196, $197, $198, $199, $200, $201, $202, $203, $204, $205, $206, $207, $208, $209, $210, $211, $212, $213, $214, $215, $216, $217, $218, $219, $220, $221, $222, $223, $224, $225, $226, $227, $228, $229, $230, $231, $232, $233, $234, $235, $236, $237, $238, $239, $240, $241, $242, $243, $244, $245, $246, $247, $248, $249, $250, $251, $252, $253, $254, $255, $256, $257, $258, $259, $260, $261, $262, $263, $264, $265, $266, $267, $268, $269, $270, $271, $272, $273, $274, $275, $276, $277, $278, $279, $280, $281, $282, $283, $284, $285, $286, $287, $288, $289, $290, $291, $292, $293, $294, $295, $296, $297, $298, $299, $300, $301, $302, $303, $304, $305, $306, $307, $308, $309, $310, $311, $312, $313, $314, $315, $316, $317, $318, $319, $320, $321, $322, $323, $324, $325, $326, $327, $328, $329, $330, $331, $332, $333) OR (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $334 THEN $335 WHEN $336 THEN $337 WHEN $338 THEN $339 WHEN $340 THEN $341 WHEN $342 THEN $343 WHEN $344 THEN $345 WHEN $346 THEN $347 WHEN $348 THEN $349 WHEN $350 THEN $351 WHEN $352 THEN $353 WHEN $354 THEN $355 WHEN $356 THEN $357 WHEN $358 THEN $359 WHEN $360 THEN $361 WHEN $362 THEN $363 WHEN $364 THEN $365 WHEN $366 THEN $367 WHEN $368 THEN $369 WHEN $370 THEN $371 WHEN $372 THEN $373 WHEN $374 THEN $375 WHEN $376 THEN $377 WHEN $378 THEN $379 WHEN $380 THEN $381 WHEN $382 THEN $383 WHEN $384 THEN $385 WHEN $386 THEN $387 WHEN $388 THEN $389 WHEN $390 THEN $391 WHEN $392 THEN $393 WHEN $394 THEN $395 WHEN $396 THEN $397 WHEN $398 THEN $399 WHEN $400 THEN $401 WHEN $402 THEN $403 WHEN $404 THEN $405 WHEN $406 THEN $407 WHEN $408 THEN $409 ELSE COALESCE(n.brand, m.brand) END), $410)) = $411 AND m.brand ~* $412) OR (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $413 THEN $414 WHEN $415 THEN $416 WHEN $417 THEN $418 WHEN $419 THEN $420 WHEN $421 THEN $422 WHEN $423 THEN $424 WHEN $425 THEN $426 WHEN $427 THEN $428 WHEN $429 THEN $430 WHEN $431 THEN $432 WHEN $433 THEN $434 WHEN $435 THEN $436 WHEN $437 THEN $438 WHEN $439 THEN $440 WHEN $441 THEN $442 WHEN $443 THEN $444 WHEN $445 THEN $446 WHEN $447 THEN $448 WHEN $449 THEN $450 WHEN $451 THEN $452 WHEN $453 THEN $454 WHEN $455 THEN $456 WHEN $457 THEN $458 WHEN $459 THEN $460 WHEN $461 THEN $462 WHEN $463 THEN $464 WHEN $465 THEN $466 WHEN $467 THEN $468 WHEN $469 THEN $470 WHEN $471 THEN $472 WHEN $473 THEN $474 WHEN $475 THEN $476 WHEN $477 THEN $478 WHEN $479 THEN $480 WHEN $481 THEN $482 WHEN $483 THEN $484 WHEN $485 THEN $486 WHEN $487 THEN $488 ELSE COALESCE(n.brand, m.brand) END), $489)) = $490 AND m.brand ~* $491) OR (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $492 THEN $493 WHEN $494 THEN $495 WHEN $496 THEN $497 WHEN $498 THEN $499 WHEN $500 THEN $501 WHEN $502 THEN $503 WHEN $504 THEN $505 WHEN $506 THEN $507 WHEN $508 THEN $509 WHEN $510 THEN $511 WHEN $512 THEN $513 WHEN $514 THEN $515 WHEN $516 THEN $517 WHEN $518 THEN $519 WHEN $520 THEN $521 WHEN $522 THEN $523 WHEN $524 THEN $525 WHEN $526 THEN $527 WHEN $528 THEN $529 WHEN $530 THEN $531 WHEN $532 THEN $533 WHEN $534 THEN $535 WHEN $536 THEN $537 WHEN $538 THEN $539 WHEN $540 THEN $541 WHEN $542 THEN $543 WHEN $544 THEN $545 WHEN $546 THEN $547 WHEN $548 THEN $549 WHEN $550 THEN $551 WHEN $552 THEN $553 WHEN $554 THEN $555 WHEN $556 THEN $557 WHEN $558 THEN $559 WHEN $560 THEN $561 WHEN $562 THEN $563 WHEN $564 THEN $565 WHEN $566 THEN $567 ELSE COALESCE(n.brand, m.brand) END), $568)) = $569 AND m.brand ~* $570) OR (lower(btrim((CASE COALESCE(n.brand, m.brand) WHEN $571 THEN $572 WHEN $573 THEN $574 WHEN $575 THEN $576 WHEN $577 THEN $578 WHEN $579 THEN $580 WHEN $581 THEN $582 WHEN $583 THEN $584 WHEN $585 THEN $586 WHEN $587 THEN $588 WHEN $589 THEN $590 WHEN $591 THEN $592 WHEN $593 THEN $594 WHEN $595 THEN $596 WHEN $597 THEN $598 WHEN $599 THEN $600 WHEN $601 THEN $602 WHEN $603 THEN $604 WHEN $605 THEN $606 WHEN $607 THEN $608 WHEN $609 THEN $610 WHEN $611 THEN $612 WHEN $613 THEN $614 WHEN $615 THEN $616 WHEN $617 THEN $618 WHEN $619 THEN $620 WHEN $621 THEN $622 WHEN $623 THEN $624 WHEN $625 THEN $626 WHEN $627 THEN $628 WHEN $629 THEN $630 WHEN $631 THEN $632 WHEN $633 THEN $634 WHEN $635 THEN $636 WHEN $637 THEN $638 WHEN $639 THEN $640 WHEN $641 THEN $642 WHEN $643 THEN $644 WHEN $645 THEN $646 ELSE COALESCE(n.brand, m.brand) END), $64
-- …[+21810 chars 생략 — 바인드 플레이스홀더 목록]
```
</details>

<details><summary>EXPLAIN (ANALYZE, BUFFERS) 전문 — pass 1</summary>

```text
HashAggregate  (cost=310337.31..368481.50 rows=435741 width=68) (actual time=32132.171..32133.880 rows=2473 loops=1)
  Group Key: to_char(ans.wk, 'YYYY-MM-DD'::text), CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي'::text THEN 'Hyun …[+1313 chars]
  Planned Partitions: 4  Batches: 1  Memory Usage: 6417kB
  Buffers: shared hit=186129, temp read=17581 written=17581
  CTE ans
    ->  Unique  (cost=71688.86..74475.61 rows=80712 width=58) (actual time=492.408..542.071 rows=100130 loops=1)
          Buffers: shared hit=104424
          ->  Sort  (cost=71688.86..72246.21 rows=222940 width=58) (actual time=492.406..509.909 rows=132693 loops=1)
                Sort Key: a.prompt_id, a.target, a.region, (date_trunc('week'::text, a.measured_at)), a.measured_at DESC
                Sort Method: quicksort  Memory: 14148kB
                Buffers: shared hit=104424
                ->  Hash Join  (cost=2114.16..46975.02 rows=222940 width=58) (actual time=14.901..327.409 rows=132693 loops=1)
                      Hash Cond: (a.run_id = scope_runs.run_id)
                      Buffers: shared hit=104424
                      ->  Hash Semi Join  (cost=1082.03..44800.21 rows=222940 width=66) (actual time=6.654..261.570 rows=132693 loops=1)
                            Hash Cond: (a.prompt_id = prompts.scope_prompt_id)
                            Buffers: shared hit=103961
                            ->  Index Only Scan using scope_answers_run_cycle_idx on scope_answers a  (cost=0.43..39693.07 rows=376376 width=66) (actual time=0.030..179.591 rows=368033 loops=1)
                                  Index Cond: ((measured_at IS NOT NULL) AND (measured_at >= (now() - '120 days'::interval)))
                                  Filter: (region <> 'ID'::text)
                                  Rows Removed by Filter: 8924
                                  Heap Fetches: 83357
                                  Buffers: shared hit=103204
                            ->  Hash  (cost=942.88..942.88 rows=11098 width=16) (actual time=6.537..6.539 rows=12282 loops=1)
                                  Buckets: 16384  Batches: 1  Memory Usage: 704kB
                                  Buffers: shared hit=757
                                  ->  Seq Scan on prompts  (cost=0.00..942.88 rows=11098 width=16) (actual time=0.019..4.184 rows=12282 loops=1)
                                        Filter: ((scope_prompt_id IS NOT NULL) AND (project_id = '26751906-c175-485c-9e69-29fc68d0fdbb'::uuid))
                                        Rows Removed by Filter: 2595
                                        Buffers: shared hit=757
                      ->  Hash  (cost=715.95..715.95 rows=25295 width=16) (actual time=8.230..8.238 rows=25310 loops=1)
                            Buckets: 32768  Batches: 1  Memory Usage: 1443kB
                            Buffers: shared hit=463
                            ->  Seq Scan on scope_runs  (cost=0.00..715.95 rows=25295 width=16) (actual time=0.020..3.572 rows=25310 loops=1)
                                  Buffers: shared hit=463
  ->  Hash Join  (cost=157310.46..212644.88 rows=435741 width=68) (actual time=30175.017..31867.015 rows=776104 loops=1)
        Hash Cond: (ans.job_id = m.job_id)
        Buffers: shared hit=186129, temp read=17581 written=17581
        ->  CTE Scan on ans  (cost=0.00..1614.24 rows=80712 width=24) (actual time=492.414..569.102 rows=100130 loops=1)
              Buffers: shared hit=104424
        ->  Hash  (cost=146441.20..146441.20 rows=467621 width=62) (actual time=29680.553..29680.560 rows=1952960 loops=1)
              Buckets: 524288 (originally 524288)  Batches: 8 (originally 2)  Memory Usage: 28673kB
              Buffers: shared hit=81705, temp written=11929
              ->  Hash Left Join  (cost=62.57..146441.20 rows=467621 width=62) (actual time=18.037..28757.059 rows=1952960 loops=1)
                    Hash Cond: (CASE WHEN (m.brand_rollup_entity_id IS NULL) THEN m.brand_rollup_entity_id WHEN (m.brand ~* '^[	

                  　﻿]*(Genesis|제네시스|جينيسيس)([^[:alnum:]]|$)'::text) THEN '00000000-0000-0000-0000-000000000304'::uuid WHEN (m.brand ~* '^[	

                  　﻿]*(Hyundai|현대자동차|현대차|현대|هيونداي|יונדאי)([^[:alnum:]]|$)'::text) THEN '00000000-0000-0000-0000-000000000301'::uuid WHEN (m.brand ~* '^[	

                  　﻿]*(Kia|기아|كيا|קיה)([^[:alnum:]]|$)'::text) THEN '00000000-0000-0000-0000-000000000302'::uuid ELSE CASE m.brand_rollup_entity_id WHEN 'e0348d5f-afe4-48e6-aa99-1dee566f2822'::uuid THEN '00000000-0000-0000-0000-000000000301'::uuid WHEN 'c6dc2ca3-0fc9-42bc-b255-6fbfdb394e45'::uuid …[+603 chars]
                    Filter: ((COALESCE(n.brand, m.brand) IS NOT NULL) AND ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis' …[+1355 chars]

                  　﻿'::text)) <> ALL ('{apple,google,samsung,pilot,falcon,century,element,lightning,punch,one,integra,bolt,fit,focus,legacy,charger,city,edge,is,vision,volt,crown,golf,transit,gravity,fastback,"dual electronics",across,advanced,clever,contact,dealership,drift,five,flat,guest,impac …[+2875 chars]

                  　﻿'::text)) = 'smart'::text) AND (m.brand ~* '^[	

                  　﻿]*smart[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوندا …[+1336 chars]

                  　﻿'::text)) = 'cruise'::text) AND (m.brand ~* '^[	

                  　﻿]*cruise[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوند …[+1337 chars]

                  　﻿'::text)) = 'international'::text) AND (m.brand ~* '^[	

                  　﻿]*international[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN …[+1344 chars]

                  　﻿'::text)) = 'pilot'::text) AND (m.brand ~* '^[	

                  　﻿]*pilot[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوندا …[+1336 chars]

                  　﻿'::text)) = 'falcon'::text) AND (m.brand ~* '^[	

                  　﻿]*falcon[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوند …[+1337 chars]

                  　﻿'::text)) = 'century'::text) AND (m.brand ~* '^[	

                  　﻿]*century[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1338 chars]

                  　﻿'::text)) = 'element'::text) AND (m.brand ~* '^[	

                  　﻿]*element[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1338 chars]

                  　﻿'::text)) = 'lightning'::text) AND (m.brand ~* '^[	

                  　﻿]*lightning[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هي …[+1340 chars]

                  　﻿'::text)) = 'punch'::text) AND (m.brand ~* '^[	

                  　﻿]*punch[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوندا …[+1336 chars]

                  　﻿'::text)) = 'one'::text) AND (m.brand ~* '^[	

                  　﻿]*one[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي' …[+1334 chars]

                  　﻿'::text)) = 'integra'::text) AND (m.brand ~* '^[	

                  　﻿]*integra[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1338 chars]

                  　﻿'::text)) = 'bolt'::text) AND (m.brand ~* '^[	

                  　﻿]*bolt[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي …[+1335 chars]

                  　﻿'::text)) = 'fit'::text) AND (m.brand ~* '^[	

                  　﻿]*fit[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي' …[+1334 chars]

                  　﻿'::text)) = 'focus'::text) AND (m.brand ~* '^[	

                  　﻿]*focus[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوندا …[+1336 chars]

                  　﻿'::text)) = 'legacy'::text) AND (m.brand ~* '^[	

                  　﻿]*legacy[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوند …[+1337 chars]

                  　﻿'::text)) = 'charger'::text) AND (m.brand ~* '^[	

                  　﻿]*charger[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1338 chars]

                  　﻿'::text)) = 'city'::text) AND (m.brand ~* '^[	

                  　﻿]*city[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي …[+1335 chars]

                  　﻿'::text)) = 'edge'::text) AND (m.brand ~* '^[	

                  　﻿]*edge[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي …[+1335 chars]

                  　﻿'::text)) = 'is'::text) AND (m.brand ~* '^[	

                  　﻿]*is[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي': …[+1333 chars]

                  　﻿'::text)) = 'vision'::text) AND (m.brand ~* '^[	

                  　﻿]*vision[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوند …[+1337 chars]

                  　﻿'::text)) = 'volt'::text) AND (m.brand ~* '^[	

                  　﻿]*volt[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي …[+1335 chars]

                  　﻿'::text)) = 'crown'::text) AND (m.brand ~* '^[	

                  　﻿]*crown[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيوندا …[+1336 chars]

                  　﻿'::text)) = 'golf'::text) AND (m.brand ~* '^[	

                  　﻿]*golf[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيونداي …[+1335 chars]

                  　﻿'::text)) = 'transit'::text) AND (m.brand ~* '^[	

                  　﻿]*transit[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1338 chars]

                  　﻿'::text)) = 'gravity'::text) AND (m.brand ~* '^[	

                  　﻿]*gravity[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيون …[+1338 chars]

                  　﻿'::text)) = 'fastback'::text) AND (m.brand ~* '^[	

                  　﻿]*fastback[^[:alnum:]]'::text)) OR ((lower(btrim(CASE COALESCE(n.brand, m.brand) WHEN '기아'::text THEN 'Kia'::text WHEN '현대'::text THEN 'Hyundai'::text WHEN '현대차'::text THEN 'Hyundai'::text WHEN '현대자동차'::text THEN 'Hyundai'::text WHEN '제네시스'::text THEN 'Genesis'::text WHEN 'هيو …[+1339 chars]

                  　﻿'::text)) = 'dual electronics'::text) AND (m.brand ~* '^[	

                  　﻿]*dual electronics[^[:alnum:]]'::text))))
                    Rows Removed by Filter: 241942
                    Buffers: shared hit=81705
                    ->  Seq Scan on scope_mentions m  (cost=0.00..104557.79 rows=2237900 width=46) (actual time=0.027..1143.805 rows=2194902 loops=1)
                          Filter: (brand_rollup_entity_id IS NOT NULL)
                          Rows Removed by Filter: 695595
                          Buffers: shared hit=75207
                    ->  Hash  (cost=60.91..60.91 rows=101 width=48) (actual time=17.873..17.879 rows=1568 loops=1)
                          Buckets: 2048 (originally 1024)  Batches: 1 (originally 1)  Memory Usage: 106kB
                          Buffers: shared hit=6498
                          ->  Subquery Scan on n  (cost=59.40..60.91 rows=101 width=48) (actual time=17.010..17.569 rows=1568 loops=1)
                                Buffers: shared hit=6498
                                ->  Unique  (cost=59.40..59.90 rows=101 width=49) (actual time=17.008..17.351 rows=1568 loops=1)
                                      Buffers: shared hit=6498
                                      CTE _rn_pairs
                                        ->  Recursive Union  (cost=0.43..53.76 rows=101 width=26) (actual time=0.032..15.331 rows=1569 loops=1)
                                              Buffers: shared hit=6498
                                              ->  Limit  (cost=0.43..0.46 rows=1 width=26) (actual time=0.030..0.031 rows=1 loops=1)
                                                    Buffers: shared hit=4
                                                    ->  Index Only Scan using scope_mentions_rollup_names_idx on scope_mentions m_1  (cost=0.43..34902.92 rows=1041953 width=26) (actual time=0.029..0.029 rows=1 loops=1)
                                                          Index Cond: (entity_type = 'Brand'::text)
                                                          Heap Fetches: 0
                                                          Buffers: shared hit=4
                                              ->  Nested Loop  (cost=0.43..5.23 rows=10 width=26) (actual time=0.009..0.009 rows=1 loops=1569)
                                                    Buffers: shared hit=6494
                                                    ->  WorkTable Scan on _rn_pairs p  (cost=0.00..0.20 rows=10 width=48) (actual time=0.000..0.000 rows=1 loops=1569)
                                                    ->  Limit  (cost=0.43..0.49 rows=1 width=26) (actual time=0.008..0.009 rows=1 loops=1569)
                                                          Buffers: shared hit=6494
                                                          ->  Index Only Scan using scope_mentions_rollup_names_idx on scope_mentions m_2  (cost=0.43..21848.74 rows=347318 width=26) (actual time=0.008..0.008 rows=1 loops=1569)
                                                                Index Cond: ((entity_type = 'Brand'::text) AND (ROW(entity_id, brand) > ROW(p.entity_id, p.brand)))
                                                                Heap Fetches: 760
                                                                Buffers: shared hit=6494
                                      ->  Sort  (cost=5.63..5.89 rows=101 width=49) (actual time=17.007..17.102 rows=1569 loops=1)
                                            Sort Key: _rn_pairs.entity_id, ((_rn_pairs.brand ~ '^[A-Za-z]'::text)) DESC, _rn_pairs.brand
                                            Sort Method: quicksort  Memory: 120kB
                                            Buffers: shared hit=6498
                                            ->  CTE Scan on _rn_pairs  (cost=0.00..2.27 rows=101 width=49) (actual time=0.041..16.631 rows=1569 loops=1)
                                                  Buffers: shared hit=6498
Planning:
  Buffers: shared hit=27
Planning Time: 6.316 ms
Execution Time: 32141.212 ms
```
</details>

### ④ 코어 KPI ⑤ 인용 점유율 — c2/ub (카탈로그 base 프리픽스 LIKE ANY)

- exec **2.96 s** (p2 3.05 s) · planning 1 ms · `Buffers: shared hit=219793, local hit=320, temp read=14813 written=19057`
- `_answer_set` 선행: 잡아둔 `CREATE TEMP TABLE _answer_set ON COMMIT DROP AS …`(① 과 같은 SELECT) + `ANALYZE` 를 같은 트랜잭션에서 재실행한 뒤 측정

| 포함 시간 | 노드 | rows | loops |
| ---: | --- | ---: | ---: |
| 2.93 s | `Aggregate` | 1 | 1 |
| 2.90 s | `Sort` | 183,330 | 1 |
| 2.81 s | `Merge Right Join` | 183,330 | 1 |
| 2.01 s | `Sort` | 106,986 | 1 |
| 1.60 s | `CTE Scan on ub` | 106,986 | 1 |
| 1.53 s | `Subquery Scan on d` | 106,986 | 1 |
| 1.46 s | `HashAggregate` | 106,986 | 1 |
| 1.23 s | `CTE Scan on c2 c2_1` | 183,330 | 1 |

<details><summary>문장 (바인드 값 제외)</summary>

```sql
WITH c2 AS MATERIALIZED (
      SELECT c.job_id, c.url, c.url_base_norm AS bk
      FROM scope_citations c WHERE c.job_id IN (SELECT job_id FROM _answer_set)
    ),
    ub AS MATERIALIZED (
    SELECT url, (split_part(base, '/', 1) = ANY(ARRAY[$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43]::text[]) AND (base = ANY(ARRAY[$44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58, $59, $60, $61, $62, $63, $64, $65, $66, $67, $68, $69, $70, $71, $72, $73, $74, $75, $76, $77, $78, $79, $80, $81, $82, $83, $84, $85, $86, $87, $88, $89, $90, $91, $92, $93, $94, $95, $96, $97, $98, $99, $100, $101, $102, $103, $104, $105, $106, $107, $108, $109, $110, $111, $112, $113, $114, $115, $116, $117, $118, $119, $120, $121, $122, $123, $124, $125, $126, $127, $128, $129, $130, $131, $132, $133, $134, $135, $136, $137, $138, $139, $140, $141, $142, $143, $144, $145, $146, $147, $148, $149, $150, $151, $152, $153, $154, $155, $156, $157, $158, $159, $160, $161, $162, $163, $164, $165, $166, $167, $168, $169, $170, $171, $172, $173, $174, $175, $176, $177, $178, $179, $180, $181, $182, $183, $184, $185, $186, $187, $188, $189, $190, $191, $192, $193, $194, $195, $196, $197, $198, $199, $200, $201, $202, $203, $204, $205, $206, $207, $208, $209, $210, $211, $212, $213]::text[]) OR base LIKE ANY(ARRAY[$214, $215, $216, $217, $218, $219, $220, $221, $222, $223, $224, $225, $226, $227, $228, $229, $230, $231, $232, $233, $234, $235, $236, $237, $238, $239, $240, $241, $242, $243, $244, $245, $246, $247, $248, $249, $250, $251, $252, $253, $254, $255, $256, $257, $258, $259, $260, $261, $262, $263, $264, $265, $266, $267, $268, $269, $270, $271, $272, $273, $274, $275, $276, $277, $278, $279, $280, $281, $282, $283, $284, $285, $286, $287, $288, $289, $290, $291, $292, $293, $294, $295, $296, $297, $298, $299, $300, $301, $302, $303, $304, $305, $306, $307, $308, $309, $310, $311, $312, $313, $314, $315, $316, $317, $318, $319, $320, $321, $322, $323, $324, $325, $326, $327, $328, $329, $330, $331, $332, $333, $334, $335, $336, $337, $338, $339, $340, $341, $342, $343, $344, $345, $346, $347, $348, $349, $350, $351, $352, $353, $354, $355, $356, $357, $358, $359, $360, $361, $362, $363, $364, $365, $366, $367, $368, $369, $370, $371, $372, $373, $374, $375, $376, $377, $378, $379, $380, $381, $382, $383]::text[]) OR base = ANY(ARRAY[$384, $385, $386, $387, $388, $389, $390, $391, $392, $393, $394, $395, $396, $397, $398, $399, $400, $401, $402, $403, $404, $405, $406, $407, $408, $409, $410, $411, $412, $413, $414, $415, $416, $417, $418, $419, $420, $421, $422, $423, $424, $425, $426, $427, $428, $429, $430, $431, $432, $433, $434, $435, $436, $437, $438, $439, $440, $441, $442, $443, $444, $445, $446, $447, $448, $449, $450, $451, $452, $453, $454, $455, $456, $457, $458, $459, $460, $461, $462, $463, $464, $465, $466, $467, $468, $469, $470, $471, $472, $473, $474, $475, $476, $477, $478, $479, $480, $481, $482, $483, $484, $485, $486, $487, $488, $489, $490, $491, $492, $493, $494, $495, $496, $497, $498, $499, $500, $501, $502, $503, $504, $505, $506, $507, $508, $509, $510, $511, $512, $513, $514, $515, $516, $517, $518, $519, $520, $521, $522, $523, $524, $525, $526, $527, $528, $529, $530, $531, $532, $533, $534, $535, $536, $537, $538, $539, $540, $541, $542, $543, $544, $545, $546, $547, $548, $549, $550, $551, $552, $553]::text[]))) AS owned
    FROM (SELECT url, coalesce(bk, citation_url_base_norm(url)) AS base
        FROM (SELECT url, max(bk) AS bk FROM c2 GROUP BY url) d) x
  )
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE COALESCE(ub.owned, false))::int AS owned,
      count(DISTINCT c2.job_id)::int AS with_cit
    FROM c2 LEFT JOIN ub ON ub.url = c2.url
```
</details>

<details><summary>EXPLAIN (ANALYZE, BUFFERS) 전문 — pass 1</summary>

```text
Aggregate  (cost=1195565.43..1195565.44 rows=1 width=12) (actual time=2926.239..2926.248 rows=1 loops=1)
  Buffers: shared hit=219793, local hit=320, temp read=14813 written=19057
  CTE c2
    ->  Hash Semi Join  (cost=1165.33..287246.76 rows=2679800 width=209) (actual time=11.733..1109.456 rows=183330 loops=1)
          Hash Cond: (c.job_id = _answer_set.job_id)
          Buffers: shared hit=219523, local hit=320
          ->  Seq Scan on scope_citations c  (cost=0.00..248628.47 rows=2910547 width=209) (actual time=0.015..363.994 rows=2873956 loops=1)
                Buffers: shared hit=219523
          ->  Hash  (cost=695.70..695.70 rows=37570 width=16) (actual time=11.645..11.647 rows=37570 loops=1)
                Buckets: 65536  Batches: 1  Memory Usage: 2274kB
                Buffers: local hit=320
                ->  Seq Scan on _answer_set  (cost=0.00..695.70 rows=37570 width=16) (actual time=0.011..4.225 rows=37570 loops=1)
                      Buffers: local hit=320
  CTE ub
    ->  Subquery Scan on d  (cost=66995.96..112175.98 rows=145742 width=33) (actual time=1389.192..1533.471 rows=106986 loops=1)
          Buffers: shared hit=219529, local hit=320, temp read=1611 written=9060
          ->  HashAggregate  (cost=66995.00..68452.42 rows=145742 width=64) (actual time=1389.180..1458.816 rows=106986 loops=1)
                Group Key: c2_1.url
                Batches: 5  Memory Usage: 32817kB  Disk Usage: 15280kB
                Buffers: shared hit=219529, local hit=320, temp read=1611 written=9060
                ->  CTE Scan on c2 c2_1  (cost=0.00..53596.00 rows=2679800 width=64) (actual time=11.736..1230.088 rows=183330 loops=1)
                      Buffers: shared hit=219523, local hit=320, temp written=5953
  ->  Sort  (cost=769344.69..776044.19 rows=2679800 width=17) (actual time=2874.080..2901.132 rows=183330 loops=1)
        Sort Key: c2.job_id
        Sort Method: quicksort  Memory: 13306kB
        Buffers: shared hit=219793, local hit=320, temp read=14813 written=19057
        ->  Merge Right Join  (cost=403412.24..451037.45 rows=2679800 width=17) (actual time=2562.481..2805.313 rows=183330 loops=1)
              Merge Cond: (ub.url = c2.url)
              Buffers: shared hit=219793, local hit=320, temp read=14813 written=19057
              ->  Sort  (cost=15414.44..15778.80 rows=145742 width=33) (actual time=1972.198..2009.034 rows=106986 loops=1)
                    Sort Key: ub.url
                    Sort Method: external merge  Disk: 22200kB
                    Buffers: shared hit=219653, local hit=320, temp read=4386 written=14581
                    ->  CTE Scan on ub  (cost=0.00..2914.84 rows=145742 width=33) (actual time=1389.195..1600.951 rows=106986 loops=1)
                          Buffers: shared hit=219529, local hit=320, temp read=1611 written=11805
              ->  Materialize  (cost=387997.79..401396.79 rows=2679800 width=48) (actual time=590.272..697.509 rows=183330 loops=1)
                    Buffers: shared hit=104, temp read=10427 written=4476
                    ->  Sort  (cost=387997.79..394697.29 rows=2679800 width=48) (actual time=590.267..667.156 rows=183330 loops=1)
                          Sort Key: c2.url
                          Sort Method: external merge  Disk: 35784kB
                          Buffers: shared hit=104, temp read=10427 written=4476
                          ->  CTE Scan on c2  (cost=0.00..53596.00 rows=2679800 width=48) (actual time=0.057..41.615 rows=183330 loops=1)
                                Buffers: temp read=5954 written=1
Planning:
  Buffers: shared hit=13
Planning Time: 0.753 ms
Execution Time: 2956.124 ms
```
</details>

### ⑤ 웹사이트 ⑥ 타겟 출처 인용률 — snap + target_set + 선언 base 판정

- exec **4.49 s** (p2 4.50 s) · planning 2 ms · `Buffers: shared hit=440297, temp read=18957 written=29288`

| 포함 시간 | 노드 | rows | loops |
| ---: | --- | ---: | ---: |
| 4.45 s | `Aggregate` | 1 | 1 |
| 4.45 s | `Hash Left Join` | 28,108 | 1 |
| 3.98 s | `Hash` | 24,978 | 1 |
| 3.97 s | `Subquery Scan on cit` | 24,978 | 1 |
| 3.97 s | `HashAggregate` | 24,978 | 1 |
| 3.90 s | `Merge Join` | 202,023 | 1 |
| 2.92 s | `Sort` | 143,903 | 1 |
| 2.36 s | `CTE Scan on ub` | 143,903 | 1 |

<details><summary>문장 (바인드 값 제외)</summary>

```sql
WITH snap AS MATERIALIZED (SELECT a.job_id FROM scope_answers a WHERE a.status = 'completed' AND a.job_id IN (
    SELECT DISTINCT ON (a.prompt_id, a.target, a.region) a.job_id
    FROM scope_answers a
    JOIN scope_runs r ON r.run_id = a.run_id
    WHERE r.project_id IN ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58, $59, $60, $61, $62, $63, $64, $65, $66, $67, $68, $69, $70, $71, $72, $73, $74, $75, $76, $77, $78, $79, $80, $81, $82, $83, $84, $85, $86, $87, $88, $89, $90, $91, $92, $93, $94, $95, $96, $97, $98, $99, $100, $101, $102, $103, $104, $105, $106, $107, $108, $109, $110, $111, $112, $113, $114, $115, $116, $117, $118, $119, $120, $121, $122, $123, $124, $125, $126, $127, $128)
      AND r.status IN ('completed', 'partial_failed')
      AND a.status = 'completed'
    ORDER BY a.prompt_id, a.target, a.region, a.measured_at DESC
  )),
    target_set AS MATERIALIZED (
    SELECT DISTINCT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(regexp_replace(wp.target_url, '^\s+|\s+$', '', 'g')), '^https?://', ''), '^www\.', ''), '#.*$', ''), $129, '', 'g'), $130, '?'), $131, ''), '/+$', '') AS turl
    FROM website_prompts wp
    JOIN website_sites ws ON ws.id = wp.site_id
    WHERE ws.scope_project_id::text IN ($132, $133, $134, $135, $136, $137, $138, $139, $140, $141, $142, $143, $144, $145, $146, $147, $148, $149, $150, $151, $152, $153, $154, $155, $156, $157, $158, $159, $160, $161, $162, $163, $164, $165, $166, $167, $168, $169, $170, $171, $172, $173, $174, $175, $176, $177, $178, $179, $180, $181, $182, $183, $184, $185, $186, $187, $188, $189, $190, $191, $192, $193, $194, $195, $196, $197, $198, $199, $200, $201, $202, $203, $204, $205, $206, $207, $208, $209, $210, $211, $212, $213, $214, $215, $216, $217, $218, $219, $220, $221, $222, $223, $224, $225, $226, $227, $228, $229, $230, $231, $232, $233, $234, $235, $236, $237, $238, $239, $240, $241, $242, $243, $244, $245, $246, $247, $248, $249, $250, $251, $252, $253, $254, $255, $256, $257, $258, $259) AND wp.target_url <> ''),
    
    c2 AS MATERIALIZED (
      SELECT c.job_id, coalesce(c.url, '') AS uk, coalesce(c.domain, '') AS dk, c.url_norm AS nk
      FROM scope_citations c JOIN snap ON snap.job_id = c.job_id
    ),
    un AS MATERIALIZED (
      SELECT uk, dk, coalesce(nk, citation_url_norm(nullif(uk, ''))) AS n
      FROM (SELECT uk, dk, max(nk) AS nk FROM c2 GROUP BY uk, dk) d
    ),
    ub AS MATERIALIZED (
      SELECT uk, dk, (split_part(n, '/', 1) = ANY(ARRAY[$260, $261, $262, $263, $264, $265, $266, $267, $268, $269, $270, $271, $272, $273, $274, $275, $276, $277, $278, $279, $280, $281, $282, $283, $284, $285]::text[]) AND (n = ANY(ARRAY[$286, $287, $288, $289, $290, $291, $292, $293, $294, $295, $296, $297, $298, $299, $300, $301, $302, $303, $304, $305, $306, $307, $308, $309, $310, $311, $312, $313, $314, $315, $316, $317, $318, $319, $320, $321, $322, $323, $324, $325, $326, $327, $328, $329, $330, $331, $332, $333, $334, $335, $336, $337, $338, $339, $340, $341, $342, $343, $344, $345, $346, $347, $348, $349, $350, $351, $352, $353, $354, $355, $356, $357, $358, $359, $360, $361, $362, $363, $364, $365, $366, $367, $368, $369, $370, $371, $372, $373, $374, $375, $376, $377, $378, $379, $380, $381, $382, $383, $384, $385, $386, $387, $388, $389, $390, $391, $392, $393, $394]::text[]) OR n LIKE ANY(ARRAY[$395, $396, $397, $398, $399, $400, $401, $402, $403, $404, $405, $406, $407, $408, $409, $410, $411, $412, $413, $414, $415, $416, $417, $418, $419, $420, $421, $422, $423, $424, $425, $426, $427, $428, $429, $430, $431, $432, $433, $434, $435, $436, $437, $438, $439, $440, $441, $442, $443, $444, $445, $446, $447, $448, $449, $450, $451, $452, $453, $454, $455, $456, $457, $458, $459, $460, $461, $462, $463, $464, $465, $466, $467, $468, $469, $470, $471, $472, $473, $474, $475, $476, $477, $478, $479, $480, $481, $482, $483, $484, $485, $486, $487, $488, $489, $490, $491, $492, $493, $494, $495, $496, $497, $498, $499, $500, $501, $502, $503]::text[]) OR n = ANY(ARRAY[$504, $505, $506, $507, $508, $509, $510, $511, $512, $513, $514, $515, $516, $517, $518, $519, $520, $521, $522, $523, $524, $525, $526, $527, $528, $529, $530, $531, $532, $533, $534, $535, $536, $537, $538, $539, $540, $541, $542, $543, $544, $545, $546, $547, $548, $549, $550, $551, $552, $553, $554, $555, $556, $557, $558, $559, $560, $561, $562, $563, $564, $565, $566, $567, $568, $569, $570, $571, $572, $573, $574, $575, $576, $577, $578, $579, $580, $581, $582, $583, $584, $585, $586, $587, $588, $589, $590, $591, $592, $593, $594, $595, $596, $597, $598, $599, $600, $601, $602, $603, $604, $605, $606, $607, $608, $609, $610, $611, $612]::text[]))) AS owned,
        (n IN (SELECT turl FROM target_set)) AS target
      FROM un
    ),
    cit AS (
      SELECT c2.job_id,
        bool_or(ub.owned) AS owned,
        bool_or(ub.target) AS target
      FROM c2 JOIN ub ON ub.uk = c2.uk AND ub.dk = c2.dk
      GROUP BY c2.job_id
    )
    SELECT
      count(*) FILTER (WHERE cit.owned)::int AS owned_answers,
      count(*) FILTER (WHERE cit.owned AND cit.target)::int AS target_answers
    FROM snap LEFT JOIN cit ON cit.job_id = snap.job_id
```
</details>

<details><summary>EXPLAIN (ANALYZE, BUFFERS) 전문 — pass 1</summary>

```text
Aggregate  (cost=930436.88..930436.90 rows=1 width=8) (actual time=4452.647..4452.664 rows=1 loops=1)
  Buffers: shared hit=440297, temp read=18957 written=29288
  CTE snap
    ->  Nested Loop  (cost=55645.47..56136.44 rows=38388 width=16) (actual time=461.709..596.424 rows=28108 loops=1)
          Buffers: shared hit=219587, temp read=1454 written=1455
          ->  HashAggregate  (cost=55645.05..55647.05 rows=200 width=16) (actual time=461.673..469.180 rows=28108 loops=1)
                Group Key: a_1.job_id
                Batches: 1  Memory Usage: 3617kB
                Buffers: shared hit=106952, temp read=1454 written=1455
                ->  Unique  (cost=53308.68..54977.42 rows=53410 width=50) (actual time=392.422..452.858 rows=28108 loops=1)
                      Buffers: shared hit=106952, temp read=1454 written=1455
                      ->  Sort  (cost=53308.68..53725.87 rows=166874 width=50) (actual time=392.420..419.720 rows=179989 loops=1)
                            Sort Key: a_1.prompt_id, a_1.target, a_1.region, a_1.measured_at DESC
                            Sort Method: external merge  Disk: 11632kB
                            Buffers: shared hit=106952, temp read=1454 written=1455
                            ->  Hash Join  (cost=1012.28..38833.70 rows=166874 width=50) (actual time=10.666..196.222 rows=179989 loops=1)
                                  Hash Cond: (a_1.run_id = r.run_id)
                                  Buffers: shared hit=106952
                                  ->  Index Only Scan using scope_answers_run_cycle_idx on scope_answers a_1  (cost=0.42..36814.00 rows=383875 width=66) (actual time=0.018..124.431 rows=376957 loops=1)
                                        Heap Fetches: 83365
                                        Buffers: shared hit=103207
                                  ->  Hash  (cost=874.41..874.41 rows=10996 width=16) (actual time=10.631..10.633 rows=9970 loops=1)
                                        Buckets: 16384  Batches: 1  Memory Usage: 596kB
                                        Buffers: shared hit=3745
                                        ->  Index Scan using scope_runs_project_idx on scope_runs r  (cost=0.29..874.41 rows=10996 width=16) (actual time=0.030..8.421 rows=9970 loops=1)
                                              Index Cond: (project_id = ANY ('{0b0edbae-526f-4933-b74a-f9b9c7c5b8fc,0bc1e0cd-9d80-421e-8f0f-acb5eaf7e8cf,0e2c6dfc-9fbf-4c7c-957c-4021a80a6475,0e2e20e4-f596-466a-9dc2-c478665bb5af,0f27a013-583f-4f0b-9996-421edc7eeb77,10d780ba-911d-47b8-ba81-083a927fa94e …[+4526 chars]
                                              Filter: (status = ANY ('{completed,partial_failed}'::text[]))
                                              Rows Removed by Filter: 7382
                                              Buffers: shared hit=3745
          ->  Index Scan using scope_answers_pkey on scope_answers a  (cost=0.42..2.61 rows=1 width=16) (actual time=0.004..0.004 rows=1 loops=28108)
                Index Cond: (job_id = a_1.job_id)
                Filter: (status = 'completed'::text)
                Buffers: shared hit=112523
  CTE target_set
    ->  HashAggregate  (cost=1278.37..1542.37 rows=8123 width=32) (actual time=188.567..191.311 rows=12683 loops=1)
          Group Key: regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(regexp_replace(wp.target_url, '^\s+|\s+$'::text, ''::text, 'g'::text)), '^https?://'::text, ''::text), '^www\.'::text, ''::text), '#.*$'::text, ''::text), '&(utm[a-z_]* …[+385 chars]
          Batches: 1  Memory Usage: 2449kB
          Buffers: shared hit=879
          ->  Hash Join  (cost=5.20..1258.07 rows=8123 width=32) (actual time=0.476..182.906 rows=12685 loops=1)
                Hash Cond: (wp.site_id = ws.id)
                Buffers: shared hit=879
                ->  Seq Scan on website_prompts wp  (cost=0.00..1035.66 rows=12692 width=76) (actual time=0.016..5.109 rows=12685 loops=1)
                      Filter: (target_url <> ''::text)
                      Buffers: shared hit=877
                ->  Hash  (cost=4.20..4.20 rows=80 width=16) (actual time=0.090..0.091 rows=128 loops=1)
                      Buckets: 1024  Batches: 1  Memory Usage: 14kB
                      Buffers: shared hit=2
                      ->  Seq Scan on website_sites ws  (cost=0.32..4.20 rows=80 width=16) (actual time=0.031..0.065 rows=128 loops=1)
                            Filter: (scope_project_id = ANY ('{0b0edbae-526f-4933-b74a-f9b9c7c5b8fc,0bc1e0cd-9d80-421e-8f0f-acb5eaf7e8cf,0e2c6dfc-9fbf-4c7c-957c-4021a80a6475,0e2e20e4-f596-466a-9dc2-c478665bb5af,0f27a013-583f-4f0b-9996-421edc7eeb77,10d780ba-911d-47b8-ba81-083a927fa94e,13a9bdea-a017-4 …[+4510 chars]
                            Buffers: shared hit=2
  CTE c2
    ->  Hash Join  (cost=1247.61..288172.10 rows=2738147 width=142) (actual time=157.866..1247.432 rows=202023 loops=1)
          Hash Cond: (c.job_id = snap_1.job_id)
          Buffers: shared hit=332154
          ->  Seq Scan on scope_citations c  (cost=0.00..248628.47 rows=2910547 width=224) (actual time=0.016..364.120 rows=2873956 loops=1)
                Buffers: shared hit=219523
          ->  Hash  (cost=767.76..767.76 rows=38388 width=16) (actual time=150.239..150.240 rows=28108 loops=1)
                Buckets: 65536  Batches: 1  Memory Usage: 1830kB
                Buffers: shared hit=112631
                ->  CTE Scan on snap snap_1  (cost=0.00..767.76 rows=38388 width=16) (actual time=0.000..142.769 rows=28108 loops=1)
                      Buffers: shared hit=112631
  CTE un
    ->  Subquery Scan on d  (cost=75299.04..76699.04 rows=40000 width=96) (actual time=1567.932..1720.413 rows=143903 loops=1)
          Buffers: shared hit=332170, temp read=2804 written=11358
          ->  HashAggregate  (cost=75299.04..75699.04 rows=40000 width=96) (actual time=1567.930..1684.814 rows=143903 loops=1)
                Group Key: c2_1.uk, c2_1.dk
                Batches: 5  Memory Usage: 32817kB  Disk Usage: 23840kB
                Buffers: shared hit=332170, temp read=2804 written=11358
                ->  CTE Scan on c2 c2_1  (cost=0.00..54762.94 rows=2738147 width=96) (actual time=157.870..1384.489 rows=202023 loops=1)
                      Buffers: shared hit=332154, temp written=6301
  CTE ub
    ->  CTE Scan on un  (cost=183.38..7233.38 rows=40000 width=66) (actual time=1766.987..2259.128 rows=143903 loops=1)
          Buffers: shared hit=333049, temp read=2804 written=15912
          SubPlan 5
            ->  CTE Scan on target_set  (cost=0.00..162.46 rows=8123 width=32) (actual time=188.569..195.238 rows=12683 loops=1)
                  Buffers: shared hit=879
  ->  Hash Left Join  (cost=499580.99..500449.53 rows=40805 width=2) (actual time=4438.549..4450.139 rows=28108 loops=1)
        Hash Cond: (snap.job_id = cit.job_id)
        Buffers: shared hit=440297, temp read=18957 written=29288
        ->  CTE Scan on snap  (cost=0.00..767.76 rows=38388 width=16) (actual time=461.711..464.725 rows=28108 loops=1)
              Buffers: shared hit=106956, temp read=1454 written=1455
        ->  Hash  (cost=499070.92..499070.92 rows=40805 width=18) (actual time=3976.815..3976.819 rows=24978 loops=1)
              Buckets: 65536  Batches: 1  Memory Usage: 1732kB
              Buffers: shared hit=333341, temp read=17503 written=27833
              ->  Subquery Scan on cit  (cost=498254.82..499070.92 rows=40805 width=18) (actual time=3961.013..3970.742 rows=24978 loops=1)
                    Buffers: shared hit=333341, temp read=17503 written=27833
                    ->  HashAggregate  (cost=498254.82..498662.87 rows=40805 width=18) (actual time=3961.011..3967.832 rows=24978 loops=1)
                          Group Key: c2.job_id
                          Batches: 1  Memory Usage: 3601kB
                          Buffers: shared hit=333341, temp read=17503 written=27833
                          ->  Merge Join  (cost=422655.78..477718.72 rows=2738147 width=18) (actual time=3565.338..3898.427 rows=202023 loops=1)
                                Merge Cond: ((ub.uk = c2.uk) AND (ub.dk = c2.dk))
                                Buffers: shared hit=333341, temp read=17503 written=27833
                                ->  Sort  (cost=3857.54..3957.54 rows=40000 width=66) (actual time=2848.529..2918.030 rows=143903 loops=1)
                                      Sort Key: ub.uk, ub.dk
                                      Sort Method: external merge  Disk: 28384kB
                                      Buffers: shared hit=333143, temp read=6352 written=22981
                                      ->  CTE Scan on ub  (cost=0.00..800.00 rows=40000 width=66) (actual time=1766.990..2357.208 rows=143903 loops=1)
                                            Buffers: shared hit=333049, temp read=2804 written=19431
                                ->  Materialize  (cost=418798.24..432488.97 rows=2738147 width=80) (actual time=716.799..842.440 rows=202023 loops=1)
                                      Buffers: shared hit=166, temp read=11151 written=4852
                                      ->  Sort  (cost=418798.24..425643.61 rows=2738147 width=80) (actual time=716.794..808.566 rows=202023 loops=1)
                                            Sort Key: c2.uk, c2.dk
                                            Sort Method: external merge  Disk: 38792kB
                                            Buffers: shared hit=166, temp read=11151 written=4852
                                            ->  CTE Scan on c2  (cost=0.00..54762.94 rows=2738147 width=80) (actual time=0.053..46.724 rows=202023 loops=1)
                                                  Buffers: temp read=6302 written=1
Planning:
  Buffers: shared hit=36
Planning Time: 1.624 ms
Execution Time: 4493.659 ms
```
</details>

### ⑥ listMeasuredRegions — 루트 카탈로그 게이트 + 기본 창 DISTINCT region

- exec **135 ms** (p2 132 ms) · planning 1 ms · `Buffers: shared hit=31045`

| 포함 시간 | 노드 | rows | loops |
| ---: | --- | ---: | ---: |
| 135 ms | `Sort` | 44 | 1 |
| 135 ms | `HashAggregate` | 44 | 1 |
| 121 ms | `Hash Semi Join` | 61,163 | 1 |
| 91 ms | `Nested Loop` | 95,928 | 1 |
| 73 ms | `Index Scan using scope_answers_run_idx on scope_answers` | 122 | 787 |
| 7 ms | `Seq Scan on scope_runs r` | 787 | 1 |
| 7 ms | `Hash` | 12,282 | 1 |
| 4 ms | `Seq Scan on prompts` | 12,282 | 1 |

<details><summary>문장 (바인드 값 제외)</summary>

```sql
SELECT DISTINCT region FROM scope_answers
    WHERE region IS NOT NULL AND region <> 'UNKNOWN' AND prompt_id IN (SELECT scope_prompt_id FROM prompts WHERE project_id = $1 AND scope_prompt_id IS NOT NULL) AND run_id IN (SELECT r.run_id FROM scope_runs r WHERE r.started_at >= now() - interval '7 days') AND region NOT IN ($2)
    ORDER BY region
```
</details>

<details><summary>EXPLAIN (ANALYZE, BUFFERS) 전문 — pass 1</summary>

```text
Sort  (cost=54193.36..54193.53 rows=67 width=3) (actual time=134.603..134.610 rows=44 loops=1)
  Sort Key: scope_answers.region
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=31045
  ->  HashAggregate  (cost=54190.66..54191.33 rows=67 width=3) (actual time=134.557..134.570 rows=44 loops=1)
        Group Key: scope_answers.region
        Batches: 1  Memory Usage: 24kB
        Buffers: shared hit=31045
        ->  Hash Semi Join  (cost=1082.02..54162.49 rows=11269 width=3) (actual time=13.470..121.188 rows=61163 loops=1)
              Hash Cond: (scope_answers.prompt_id = prompts.scope_prompt_id)
              Buffers: shared hit=31045
              ->  Nested Loop  (cost=0.42..52877.40 rows=19025 width=19) (actual time=5.835..91.338 rows=95928 loops=1)
                    Buffers: shared hit=30288
                    ->  Seq Scan on scope_runs r  (cost=0.00..905.66 rows=919 width=16) (actual time=5.806..7.180 rows=787 loops=1)
                          Filter: (started_at >= (now() - '7 days'::interval))
                          Rows Removed by Filter: 24523
                          Buffers: shared hit=463
                    ->  Index Scan using scope_answers_run_idx on scope_answers  (cost=0.42..55.86 rows=69 width=35) (actual time=0.011..0.093 rows=122 loops=787)
                          Index Cond: (run_id = r.run_id)
                          Filter: ((region IS NOT NULL) AND (region <> 'UNKNOWN'::text) AND (region <> 'ID'::text))
                          Rows Removed by Filter: 4
                          Buffers: shared hit=29825
              ->  Hash  (cost=942.88..942.88 rows=11098 width=16) (actual time=6.672..6.673 rows=12282 loops=1)
                    Buckets: 16384  Batches: 1  Memory Usage: 704kB
                    Buffers: shared hit=757
                    ->  Seq Scan on prompts  (cost=0.00..942.88 rows=11098 width=16) (actual time=0.019..4.241 rows=12282 loops=1)
                          Filter: ((scope_prompt_id IS NOT NULL) AND (project_id = '26751906-c175-485c-9e69-29fc68d0fdbb'::uuid))
                          Rows Removed by Filter: 2595
                          Buffers: shared hit=757
Planning:
  Buffers: shared hit=23
Planning Time: 0.633 ms
Execution Time: 134.677 ms
```
</details>

## 재실행 방법 (Phase D 각 PR 의 "후" 측정)

```bash
# workspace 루트에서. 하네스는 읽기 전용(TEMP + 롤백). 롤은 postgres(0052 함수 EXECUTE 필요).
cp notes/hmg-perf/baseline-explain.int.test.ts ../hmg-geo-derived/lib/db/repositories/_baseline-explain.int.test.ts
bash notes/hmg-db-exec.sh ../hmg-geo-derived npx vitest run lib/db/repositories/_baseline-explain.int.test.ts
rm ../hmg-geo-derived/lib/db/repositories/_baseline-explain.int.test.ts
python3 notes/hmg-perf/gen-baseline-record.py   # → 이 문서 형식으로 재생성 (DST 경로를 after 파일로 바꿔서)
```

- 전환 후에는 같은 6문장의 **형태가 바뀐다**(①은 `scope_answers` 단독, ②③은 `rollup_canon_id`·`summary_brand_dim`, ④는 `catalog_matches_base`). 하네스의 `pick()` 술어(`posagg AS`·`ub AS MATERIALIZED`·`date_trunc('week'…)`·`target_set AS`·`DISTINCT region`)가 새 문장에 안 맞으면 술어를 갱신하고 이 문서에 병기한다.
- 비교 기준은 exec p2(워밍) 와 shared hit 합 — 캐시 상태 변동에 덜 민감하다. planning 시간도 함께 본다(재귀 CTE·정규식 CASE 제거로 플래닝도 줄어야 정상).

## 이 기준선이 말하는 것 (플랜 §Phase D 우선순위 확인)

- ③ 언급 주별 추이가 **32.14 s** 로 압도적 — 앱은 8s 가드로 자르므로 admin 무필터 언급 화면의 추이는 지금 **항상 null**("준비 중" 카드). Task 14(범위 술어) + Task 15(컬럼·dim) 가 첫 수혜.
- ② brandRows **4.94 s** + 선행 답변셋 ① **2.31 s** — 언급 헤드라인 한 번에 ≈ 7.26 s. Task 13(① scope_answers 단독) 과 Task 15 가 각각 줄인다.
- ④ 인용 owned **2.96 s** — 0052 로 정규화는 이미 컬럼이고 남은 건 LIKE ANY 프리픽스 매칭(Task 16 `catalog_matches_base`).
- ⑤ 웹사이트 ⑥ **4.49 s** — 창 없는 latest-per-cell DISTINCT ON 이 본체(Task 13 `cell_rank_desc = 1`).
- ⑥ 옵션 국가 목록 **135 ms** — 이미 싸다. 전환 대상에서 후순위(Task 17 옵션 5종은 공유 답변셋 재사용이 목적).

---
*생성: `notes/hmg-perf/gen-baseline-record.py` ← `baseline-explain.json` (2026-09-05T09:41:05.469Z)*
