# ingest.cycles.workers · 적재 파이프라인(워커) / 회차·큐·아웃박스 / cycles_tick·queue·outbox·dfs_fetch

설계 단위: IG-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| WORKER | `hmg.ingest.worker: cycles_tick (20분 + 일 1회) · queue (60초) · outbox · dfs_fetch 빠른 경로` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- (화면 없음: 운영·워커)

## 구현

- `cycles_tick(now, daily)`: 열린·닫힌 회차와 노출일 경계 회차를 재평가(R01·R08·노출일) → 좌석 이동 재투영 → 세대. 바뀐 것이 없으면 트랜잭션을 되돌려 빈 ing.load 를 남기지 않는다.
  daily(KST 날짜가 바뀐 첫 틱): rd 사실 표 leaf(표면별, 3개월 앞) · ing 원본 5종 · ing/rd GA4 · **app.access_audit_log** · ext.dfs_call 월 leaf 선생성.
- `run_queue`: judgment_change FOR UPDATE SKIP LOCKED(change_id 순), 한 행 = 한 트랜잭션. 잠금 규약: 전역 규칙 kind = 표면 배타(1→2→3),
  프로젝트 kind = 표면 공유 + 프로젝트 try(못 잡으면 대기 유지, 이번 틱 제외), 그 밖 = 표면 공유. 성공 applied·applied_load_id, 실패는 롤백 뒤 새 트랜잭션에서
  failed·error, 상한 초과는 escalated_rebuild. ga4_property·ga4_tracked_event 는 집지 않는다(외부 적재 소유 미정).
- `run_outbox`: app.scope_outbox 5분 임대 → Scope 쓰기(트랜잭션 밖) → 생성 응답 Scope id 를 app.project·app.prompt 에 되쓰기(행위자 = 시스템 사용자,
  app.prompt 트리거가 감사·catalog 요청을 남긴다) → done. 갱신·삭제는 Scope id 가 생길 때까지 백오프. 같은 대상은 outbox_id 순.
  payload 는 core.contracts 로 검증(위반 = failed). 한 번에 한 행만 임대하며 같은 틱에서 같은 행을 다시 집지 않는다.
  완료·실패·Scope ID 되쓰기는 `done_at IS NULL`과 자신이 받은 `next_attempt_at` 임대값을 함께 확인한다.
  API가 토글을 superseded로 닫았거나 다른 워커가 임대를 가져갔으면 덮지 않는다.
  생성은 전송 전에 `scope_outcome_unknown:` 표시를 커밋한다. 요청 기한은 120초이며, 응답의 0이 아닌 UUID를 검증한 뒤
  로컬 ID 되쓰기와 완료를 같은 트랜잭션에 저장한다. 생성 응답 누락·중단·되쓰기 실패는 자동 재시도하지 않는다.
  Scope HTTP 어댑터의 POST도 429/5xx 자동 재시도를 하지 않는다. 외부 중복 생성 여부를 확인한 뒤 아래 절차로 복구한다.
- `run_dfs`(dfs_fetch 빠른 경로): claim(running) → DataForSEO 호출(트랜잭션 밖, `dfs.py` 어댑터·가짜) → ext.dfs_call + rd.dim_keyword·kw_volume_monthly·
  kw_serp·kw_suggestion(observed_at = 호출 시각) 한 트랜잭션 → applied. 페이로드 계약 = core.contracts.DfsFetch
  {fetch: volume|insight|related|search, terms, location_code, language_code, depth, project_id?} + 주체 = 정렬된 DB 정규화(app.term_norm).
  volume = search_volume, insight = search_volume + serp_organic(term 마다), related·search = keyword_suggestions(term 마다, search 만 seed 포함).
  호출 하나라도 HTTP 오류면 요청 전체 failed(부분 적재 없음). 운영 큐(IG-3) payload 도 계약으로 검증한다.
  외부 호출 전체 기한은 600초, running 임대는 15분이다. 만료된 running은 `dfs_outcome_unknown:` 실패로 수렴하며
  유료 호출을 자동으로 다시 보내지 않는다. 완료·실패는 `claimed_at` 소유권을 확인해 이전 워커의 늦은 응답을 차단한다.
  옛 형식(endpoint·keywords)은 `legacy_dfs` 가 1회 변환해 그 엔드포인트만 호출한다(검증 m-6). 배포: 새 계약 배포 전 dfs_fetch 큐를 비우길 권장.
  rd.dim_keyword.term_norm 은 DB `app.term_norm`(DB-v2.7 P55)으로 쓴다(API 조회·중복 판정과 같은 함수).
- 진입점 `ingest/worker.py`(Scheduler.step(now) = 한 틱, 시계 주입) · `ingest/cli.py`(tick·queue·outbox·dfs).
- 실행 루프는 queue·pull·cycles_tick을 독립 태스크로 시작한다. 같은 종류는 중복 실행하지 않고, 주기 작업의 기한은 1,800초다.
  daily는 성공한 날만 완료로 기록하고 실패 시 30초부터 최대 900초까지 백오프한다(완료 시점 기준). daily 기한은 300초이며
  일반 cycles_tick과 잠금을 공유한다. 프로세스 종료 시 실행 중 태스크를 취소하고 정리한다.

## 결과가 불확실한 외부 호출의 복구

`scope_outcome_unknown:` / `dfs_outcome_unknown:`는 실패 원인을 숨기지 않기 위한 운영 상태다. 재시작만으로 재실행하지 않는다.
운영 감시는 만료된 DFS running과 이 표시가 남은 DFS 실패를 계속 경고한다. Scope는 `app.scope_outbox`의 미완료 행과
`last_error`를 직접 조회해 확인한다. 이번 변경에 Scope outbox 전용 경보는 포함하지 않았다.

1. 관련 워커와 해당 대상의 추가 요청을 멈춘 후 outbox/change ID, 대상 ID, 요청 시각·내용을 확인한다. 비밀 값은 기록하지 않는다.
2. 공급자 측에서 동일 요청이 실행됐는지 조회한다. 시간 초과는 외부 실패의 증명이 아니므로 실행되지 않았다고 추정하지 않는다.
3. Scope 생성이 확인되면 정확한 외부 UUID를 대상에 연결하고 해당 outbox 행의 완료를 같은 트랜잭션으로 처리한다.
   대상과 임대값·미완료 상태를 다시 확인하며, prompt 되쓰기는 기존 시스템 행위자·감사 규칙을 적용한다.
4. 생성이 없다는 근거를 확보한 경우에만 해당 행의 오류 표시를 해제하고 재시도 시점을 설정한다. 결과가 불명확하면 보류를 유지한다.
   DFS도 외부 실행·과금 결과를 확인하고 새 유료 요청이 필요한지 결정한 뒤 명시적으로 재요청한다.
5. 복구 근거와 변경한 행을 기록하고 워커를 재개한다. 일괄 오류 초기화나 전체 pending 전환은 하지 않는다.

로컬 회귀 시험은 가짜 외부 공급자와 합성 PostgreSQL 데이터만 사용한다. 이 변경의 검증을 위해 운영 Scope·DataForSEO를 호출하지 않는다.

## 테스트(`tests/`, 일회 DB)

`test_queue.py` IG-2 kind(카탈로그·kind 트리거, 프로젝트 3종, 전역 규칙 5종, 브랜드 규칙·엔티티·웹사이트 카탈로그) 처리 후 bulk 시드와 행 단위 동치 · 멱등 재처리 ·
IG-3 kind 4종 · 실패 기록 · escalated_rebuild · 잠금 충돌 대기 · 소유 밖 kind 대기 유지. `test_workers.py` 틱 종결·파티션 선생성·빈 틱 무기록 ·
아웃박스 생성 되쓰기·재시도·순서 · DataForSEO 3 엔드포인트·잘못된 요청·재수집 갱신 · 스케줄러 한 틱.

`test_worker_recovery.py`: DFS 임대 회수·기한·늦은 쓰기 차단, Scope UUID 검증·생성 중단·소유권·되쓰기 원자성·POST 중복 방지.
`test_scheduler_recovery.py`: 긴 작업의 다른 작업 차단 방지, daily 실패 재시도, 실행 중 중복 방지·종료 정리.
