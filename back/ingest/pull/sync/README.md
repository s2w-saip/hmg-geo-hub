# ingest.pull.sync · 적재 파이프라인(워커) / Scope pull·쓰기 스키마 / 20분 pull·CLI

설계 단위: IG-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| WORKER | `hmg.ingest.worker: pull (20분)` | high |
| CLI | `python -m hmg.ingest.cli sync --project <uuid> [--force] [--max-runs N]` | medium |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- (화면 없음: 운영·워커)

## 구현

- `source.py` Scope 원천 어댑터(주입 가능): `ScopeSource` 프로토콜 · `HttpScopeSource`(httpx, 429·5xx 지수 백오프, 키는 env) · `FakeScopeSource`(테스트·로컬: 페이지 크기·실패 주입·호출 기록).
  현행 인터페이스 대응 front/lib/scope/client.ts·http.ts(listPrompts·getProject·listMeasurementRuns·listRunJobs include=result,occurrences,stances·getQueryRun).
- `stage.py` job 응답 → ing 스테이지 행(판정 없음, 원본 그대로)·content_hash(정규 JSON sha256, 휘발 필드 제외). 매핑 근거 현행 appendJobRows sync.ts:1250-1340.
- `service.py` 패스: 프로젝트 등록 동기화 → 커서 임대(FOR UPDATE SKIP LOCKED, last_attempt_at 선기록) → 프롬프트 증분(판정 입력 변경·새 프롬프트는
  별도 트랜잭션에서 `rejudge('scope_prompt')` 직접 호출, 큐 미경유, ing.load kind judgment) → run 대조(R12) → run 1개 = 적재 트랜잭션 1개.
  프롬프트 응답의 `enabled`(코어 prompts.enabled, Scope lib/prompts/store.ts serialize)는 `ing.prompt.enabled`(DB-v2.14 P84, 제품 결정 21)로 받는다.
  판정 입력이 아니라 재판정하지 않고, 응답에 없으면 기존 값을 지우지 않는다. 발행 게이트 활성 유닛(`ing.active_units`)만 읽는다. 응답의 `active` 는
  '삭제 아님'이라 쓰지 않는다. 패치 전에 받아 둔 행의 1회 채움 = `back/migration/prompt-enabled-core-export.sql` → `fill-prompt-enabled.sql`.
- 재개: 페이지마다 `ing.run.stage_cursor = {load_id, cursor}` 저장. 수신 중단은 스테이지·load 를 남기고 백오프 뒤 그 페이지부터 이어받는다.
  첫 페이지부터 실패하거나 UNLOGGED 스테이지가 유실됐으면 load 를 failed 로 닫고 처음부터(멱등). 적재 트랜잭션 실패는 롤백 → load failed·스테이지 삭제·
  attempts+1·지수 백오프(연속 `HGH_INGEST_MAX_ATTEMPTS` 회면 blocked + live 경보).
- 이미 반영한 run 은 R12 로 건너뛰고, force 재pull 도 해시가 같으면 원본·투영 쓰기 0(DN-7, 세대 불변).

## 명세와 다른 점

- `hmg.ingest.*` → `ingest.*`(패키지 이름). HTTP 수동 트리거 없음(CLI 로 대체, 크론 비밀 폐기).
- 등록 가능 도메인(ing.citation.domain_label)은 2단 공개 접미사 목록 근사(PSL 이관 요청 R6). 현행 미러의 언급 정본화·대소문자 보정(canonicalize·
  correctCaseSensitiveBrandMention)은 판정이라 ing 에 두지 않는다(원본 불변, A17).
- 본문 보충 실패 job 은 answer_text 없이 들이고 unresolved 로 세어 재확인 창 안에서 다시 당긴다.
- app 단방향 동기화 잡(Q15)은 미구현(쓰기 롤·원천 계약·화면 그룹 동결 규칙 미정: R8 보류, 메인 결정 2026-09-28).

## 테스트(`tests/`, 일회 DB)

`test_pull.py` 종단 패스(가짜 원천 → ing·회차·rd, 그리고 같은 DB 로 돌린 bulk 시드와 행 단위 동치) · R12 건너뜀·force 쓰기 0 · 늦은 분석 재확인 ·
중단 페이지 재개 · 적재 실패 롤백·blocked·경보 · 일시 실패 뒤 백오프 재시도 · Scope 프롬프트 시장 변경 재판정. `test_cli.py` CLI 인자·종료 코드.
