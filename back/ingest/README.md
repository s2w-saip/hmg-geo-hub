# 적재 파이프라인(ingest) · IG-1·IG-2·IG-3

Scope API 를 당겨 `ing`(넓은 원본, 판정 없음)에 해시 diff 로 반영하고, 같은 적재 트랜잭션에서 `rd`(좁은 투영: 판정 열·자식·회차·세대)를
갱신한다. `rd`·`ing` 의 유일한 쓰기 주체(loader 롤)이고, 다른 모듈의 app 편집은 `app.judgment_change` 큐로 받아 반영한다.
설계: `docs/design/api/모듈-적재-파이프라인.md`, 단위 `IG-1`·`IG-2`·`IG-3`, 결정 `DECISIONS-API.md`(Q2·Q3·Q13·Q15).

## 구조

| 경로 | 기능 | 표면 |
| --- | --- | --- |
| `pull/sync` | ingest.pull.sync (IG-1) | 워커 pull 20분 · CLI `sync` |
| `pull/ops` | ingest.pull.ops (IG-1) | GET `/v1/admin/ingest/{status,backlog,loads}` (admin) |
| `project/apply` | ingest.project.apply (IG-2) | FUNC `apply`·`reproject`·`rejudge` |
| `cycles/ledger` | ingest.cycles.ledger (IG-3) | FUNC `attribute`·`reevaluate`·`project_cycles`·운영 요청 처리 |
| `cycles/workers` | ingest.cycles.workers (IG-3) | 워커 `cycles_tick`·`queue`·`outbox`·`dfs_fetch` |
| `cycles/watch` | ingest.cycles.watch (IG-3) | 별도 스케줄 6시간 · CLI `watch` |
| `common` | 공용 기반 | 설정·loader 연결·잠금·LoadContext·판정 규칙 세션 로더·경보 |
| `worker.py`·`cli.py` | 진입점 | `python -m ingest.worker` · `python -m ingest.cli …` |
| `testkit.py` | 테스트 도구 | bulk 시드 실행기(psql 메타 명령 해석)·자연 키 스냅샷·동치 판정 |

## 실행

```bash
# 설정(env 만. 비밀값은 argv·로그 금지): HGH_INGEST_DB_URL(loader 직접 연결), HGH_INGEST_DB_ROLE(로컬 = loader),
#   HGH_SCOPE_API_URL·HGH_SCOPE_API_KEY, HGH_DFS_API_URL·HGH_DFS_LOGIN·HGH_DFS_PASSWORD, HGH_INGEST_SYSTEM_ACTOR
python -m ingest.cli sync --project <scope_project_uuid> [--force] [--max-runs N]
python -m ingest.cli tick [--daily] | queue | outbox | dfs | watch
python -m ingest.worker          # 상시 루프(pull 20분·queue 60초·cycles_tick 20분 + KST 날짜가 바뀐 첫 틱에 파티션 선생성)
```

## 판정 동치(핵심 수용 기준)

IG-2 는 bulk 시드(`migration/seed/seed-30-dims.sql`·`seed-40-facts.sql`)의 판정식을 **답변 키 집합으로 좁혀** 그대로 실행한다.
판정 함수·규칙 표(`seed-00-fn`·`seed-3x-rules`·`seed-3x-common` §1·2·3·4·7·9)는 시드 파일을 loader 연결의 `pg_temp` 로 올려 공유한다
(DB 함수 한 벌, G-16). 전 ing 를 읽는 시드 전용 표(`_names`·`_bn_pair`·`_acr_nm`)는 같은 식을 범위로 좁혀 만든다.

전역 판정(한 답변의 입력이 다른 답변의 판정을 바꾸는 경우)은 바뀐 job 기준으로 감지해 영향 답변을 함께 재투영한다.

- 대표 표기(names: 엔티티의 Brand 언급 중 라틴 우선·사전순 첫 표기)가 바뀌어 bare 가 달라진 엔티티 → 그 엔티티로 rid 가 풀리는 답변
- URL 최빈 도메인·자사 항목(owner_key)이 바뀐 URL → 그 URL 을 인용한 답변
- 줄어드는 방향(재pull·재분석으로 바뀐 job 의 인용·언급이 빠짐): 적재기가 ing 자식 행을 지우기 전에 `capture_prior` 로 옛 URL·엔티티·옛 대표 표기를
  잡아 두고, apply 가 새 집합과 합쳐 위 두 판정을 다시 센다. 원천 행이 0 이 된 `rd.dim_url`·`rd.dim_entity` 행은 같은 트랜잭션에서 지운다
  (bulk = 전 ing 행에서 발급). ing 자식 행을 바꾸는 새 경로는 반드시 `capture_prior` 를 먼저 불러야 한다.
  ACR 롤업 행(`ing.acr_rollup_row`)은 sync `_write_acr` 가 prompt-run 단위로 지우고 다시 쓰므로, 지우기 직전에 실제로 다시 쓸 prompt-run 목록으로
  `capture_prior_acr` 를 불러 옛 롤업 엔티티를 같은 스냅샷에 넣는다(옛 `source_job_ids` 로 추정하면 반복 job 이 새로 붙은 경우를 놓친다).
- 회차 귀속(R02 코호트: pin → 원장 → run 앵커)이 바뀐 run → 그 run 의 job 전부(파티션 이동은 삭제·재삽입)
- ACR run-셀 형제(acr_iter_rank), R05 셀 대표(is_rep 은 제자리 재선정), ACR 셀 대표

테스트는 같은 DB 상태에서 bulk 시드를 롤백 트랜잭션으로 돌려 기준값을 만들고(`testkit.bulk_equivalence`) 증분 결과와 **행 단위**로 대조한다
(정수 키는 자연 키로 바꿔 비교: `rd.citation.scope_key` 는 표면별로 global·project = scope_project_id, website = scope_project_id#file_seq.
load_id·세대·first_seen 제외. 대조 표 = 사실 8종·rd.cycle·report_unit_value·차원 8종·rd.catalog_entry·rd.web_unit·rd.web_report_prompt,
열 = 발급 키·적재 메타 밖 전부: DB-v2.15 열 포함, 빠진 열이 생기면 tests/test_incr_parity.py 가 실패). 현행 프로필(투영 스위치)을 켠 동치는
`test_incr_parity.py` 가 새 적재·재적재·재제출 run 세 경로로 본다(bulk = `testkit.bulk_seed_profile`, 같은 스위치를 시드 입력으로). 발급 원장 차원
(`rd.dim_brand_name`·`rd.dim_source` 둘뿐)은 전역 판정이 뒤 적재에서 바뀌면 옛 키가 참조 없는 행으로 남는다(재번호·재사용 금지. GC 여부 R10 은 보류: 메인 결정 2026-09-28, 발급 키 안정성):
동치 판정은 "bulk ⊆ 증분 ∧ 차이 행은 어떤 사실·차원도 참조하지 않음". `rd.dim_url`·`rd.dim_entity` 는 엄격 대조다.

## 명세와 다르게 구현한 점

| 항목 | 명세 | 구현 | 이유 |
| --- | --- | --- | --- |
| 모듈 경로 | `hmg.ingest.worker`·`hmg.ingest.cli` | `ingest.worker`·`ingest.cli` | 리포에 `hmg` 패키지가 없다(`back/` 가 pythonpath) |
| loader 연결 | core.db 풀 | `core.db.loader_connect`(asyncpg 직접 연결 1개, SQLAlchemy 엔진 가드 밖) + `ingest.common.db.LoaderDB`(트랜잭션·잠금·원장) | 워커 SQL 은 ing·rd 쓰기라 API 경계 가드 대상이 아니다. 연결·비밀값 키는 core.config(R1 반영) |
| 기능 파일 | router·schemas·service·queries | HTTP 가 없는 기능은 router·schemas 없음 | FUNC·WORKER·TASK 표면 |
| 원장 이관 회차 카운터 | 동결 | 기대·완료 유닛은 동결(원장 값 우선), 완료 답변·결손은 소속 run 답변으로 다시 셈 | seed-20 §7-6 규칙과 같다 |
| 늦은 귀속 | 'late' | 닫힘·발행 회차에 붙으면 'late' + 발행 회차 stale_since 표시(상태는 발행 유지) | stale 전이 규칙 미정 |
| 발행(R08) | closed ∧ 비율 ≥ 0.95 | 파생(derived) 글로벌·웹사이트 회차는 발행하지 않음, project 표면은 닫히면 노출 | 현행 hmg_anchor_view_date ②·③ |
| 제거된 job | 미정(열린 질문 7) | ing 원본 불변, rd 유지, `jobs_removed` 로만 센다 | 규칙 미정 |
| 표시 브랜드 대표 표기 | 전역 최빈 | 새 bare 는 이번 적재 범위 최빈, 규칙 재판정(brand_rule·entity·competitor_token) 때 다시 고름 | 전역 가중치를 매 적재 다시 세지 않는다(D8·성능) |
| Scope run 관측 상태 기록 | 미정 | 새 run 만 적재 전에 원장 행을 만들고, 기존 run 의 상태·총수·완료 시각·앵커는 적재 트랜잭션(RUN_LOADED 와 같은 커밋)에서 기록 | 적재 전에 커밋하면 크래시 뒤 R12 가 처리 안 한 run 을 건너뛴다(검증 결함 D3) |
| app 단방향 동기화 잡(Q15) | ingest 소유 | 미구현 | 쓰기 롤·원천 계약·동결 규칙 미정(R8 보류: 메인 결정 2026-09-28, 병행 운영 전환 단계. stg 배포는 막지 않는다) |
| 아웃박스 → Scope 요청 본문 | op 별 Scope API 본문 | payload 를 그대로(또는 payload.body) 보낸다(`pull.sync.source.HttpScopeSource.write`), payload 는 core.contracts 로 검증 | Scope 쓰기 API 본문 계약 미확정(op 별 매핑은 Scope 연동 단계) |
