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
  payload 는 core.contracts 로 검증(위반 = failed). 완료 표시는 `done_at IS NULL` 조건(API 가 토글을 superseded 로 닫았으면 덮지 않는다).
- `run_dfs`(dfs_fetch 빠른 경로): claim(running) → DataForSEO 호출(트랜잭션 밖, `dfs.py` 어댑터·가짜) → ext.dfs_call + rd.dim_keyword·kw_volume_monthly·
  kw_serp·kw_suggestion(observed_at = 호출 시각) 한 트랜잭션 → applied. 페이로드 계약 = core.contracts.DfsFetch
  {fetch: volume|insight|related|search, terms, location_code, language_code, depth, project_id?} + 주체 = 정렬된 DB 정규화(app.term_norm).
  volume = search_volume, insight = search_volume + serp_organic(term 마다), related·search = keyword_suggestions(term 마다, search 만 seed 포함).
  호출 하나라도 HTTP 오류면 요청 전체 failed(부분 적재 없음). 운영 큐(IG-3) payload 도 계약으로 검증한다.
  옛 형식(endpoint·keywords)은 `legacy_dfs` 가 1회 변환해 그 엔드포인트만 호출한다(검증 m-6). 배포: 새 계약 배포 전 dfs_fetch 큐를 비우길 권장.
  rd.dim_keyword.term_norm 은 DB `app.term_norm`(DB-v2.7 P55)으로 쓴다(API 조회·중복 판정과 같은 함수).
- 진입점 `ingest/worker.py`(Scheduler.step(now) = 한 틱, 시계 주입) · `ingest/cli.py`(tick·queue·outbox·dfs).

## 테스트(`tests/`, 일회 DB)

`test_queue.py` IG-2 kind(카탈로그·kind 트리거, 프로젝트 3종, 전역 규칙 5종, 브랜드 규칙·엔티티·웹사이트 카탈로그) 처리 후 bulk 시드와 행 단위 동치 · 멱등 재처리 ·
IG-3 kind 4종 · 실패 기록 · escalated_rebuild · 잠금 충돌 대기 · 소유 밖 kind 대기 유지. `test_workers.py` 틱 종결·파티션 선생성·빈 틱 무기록 ·
아웃박스 생성 되쓰기·재시도·순서 · DataForSEO 3 엔드포인트·잘못된 요청·재수집 갱신 · 스케줄러 한 틱.
