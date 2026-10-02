# 대량 미러 자동 재개 — 적용 전 검토

2026-09-15. PR #265의 목표는 원본 준비부터 미러·QA·답변 본문 API 및 캐시 반영까지 1시간 이내다. 대시보드의 36시간 quiet window, 표면별 view-anchor, 주간 회차 선택은 유지한다. 처리 중인 run은 잠시 숨긴다. 기존 복구·미러 경로, 승인된 진행상태 테이블 1개(`0073_scope_mirror_progress`), 승인된 repository 조회 조건을 중심으로 구현했다.

운영 migration, 서비스 활성화, 발견 flag, Scope 키 보관 및 IAM 변경은 아직 적용하지 않았다. 9/14 회차 8의 완료 미러는 운영 성능시험이나 자동 초기 재처리 대상으로 사용하지 않는다.

## 변경과 효과

| 변경 | 처리 결과 |
| --- | --- |
| 기존 EC2 worker의 `--watch --discover` | prompts 동기화 및 20분 cron의 프로젝트 순회를 기다리지 않고 대량 run을 발견한다 |
| 기존 `/var/lib/hmg-runner`의 작은 atomic JSON 파일 | 프로젝트 순환, 과거 run cursor와 현재 페이지의 등록 위치를 재시작 후에도 이어간다. 새 저장 서비스나 DB 테이블은 추가하지 않는다 |
| 페이지별 계획·적재 checkpoint | 초기 ACR 계획도 200 jobs씩 저장한다. 적재는 페이지별, ACR은 25 prompt-run씩 커밋한다 |
| 데이터와 진행 상태의 단일 transaction, revision CAS | 종료·응답 유실·worker 중복 실행 시 완료 구간을 다시 확정하지 않는다 |
| 원시 실패 job의 상태별 count/digest | 대표 답변 선정에서 제외된 ACR 형제의 사후 복구도 감지한다. 같은 `partial_failed` 상태 안의 복구가 자동 재처리된다 |
| jobs API에 `Accept-Encoding: gzip` 지정 | 큰 JSON의 Brotli 압축 대기를 줄인다. 응답 필드·본문·분석은 그대로다 |
| 기존 QA·집계·본문 조회에 진행 중 run 제외 조건 | 일부만 적재된 데이터가 목록·상세·CSV·답변 API로 노출되지 않는다 |
| 완료 후 숨김 복원·캐시 무효화 checkpoint | 캐시 반영 실패는 해당 후처리부터 재시도한다 |

## 자동 발견과 사후 복구

worker는 root, 연결 프로젝트, website 프로젝트, 설정된 extras의 run 목록만 조회한다. 기본 발견 예산은 10초, API 동시 조회는 최대 4개다. 프로젝트당 한 페이지를 처리하며, 최근 head는 약 5분 간격으로 확인하고 과거 cursor도 계속 진행한다. 순회가 오래 걸려도 head 다음 방문에서 deep 페이지 1개를 우선 처리해 과거 작업이 밀리지 않게 했다. 등록할 run이 있는 페이지는 최대 100개의 summary와 등록 위치를 기존 atomic JSON에 먼저 저장한다. 각 등록 성공 후 위치를 갱신하고, 모두 끝난 뒤 head/deep cursor를 전진한다. 10초 예산이 페이지 중간에 끝나도 앞부분만 반복하지 않으며, head에 새 run이 들어와도 아직 등록하지 않은 항목을 잃지 않는다. 실제 함수로 100개 run을 5회 재시작에 걸쳐 모두 등록하는 것을 검증했다.

완료한 bulk receipt에는 최초 원시 계획의 queued/running/failed 집합을 상태별 count/digest로 남긴다. 약 5분 간격의 제한된 재확인에서 기존 Scope status-filter API를 조회한다. 조회 cursor도 같은 progress에 저장한다. 단순 관측은 답변·숨김 및 데이터 watermark용 `updated_at`을 바꾸지 않는다.

집합 변화가 확인되면 기존 run 단건 API에서 최신 상태를 읽어 재등록한다. 다시 실행 중이면 완료 미러를 유지하고 30초 후 재확인한다. 원본 status 또는 job 수가 바뀐 경우도 기존 등록 경로에서 처리한다. 확인된 변화가 있을 때만 기존 restart/숨김 경로를 사용한다. receipt가 없는 기존 대량 미러의 동일 상태는 반복 재처리하지 않으므로 회차 8의 기존 베이스를 보존한다.

`--once`는 큐 처리만 수행한다. `--once --discover`는 제한된 발견과 큐 처리까지 수행하고, 사후 재확인은 상시 모드에서만 돈다. 미완료·blocked·실패가 남으면 종료코드 3, 설정 오류는 2, 예상 밖 오류는 1이다. 발견 파일이나 한 프로젝트의 오류가 이미 등록된 큐 처리를 막지는 않는다.

운영 wrapper는 `--budget-ms=180000`을 명시한다. CLI 기본 60초는 유지하며, 실제 진전이 있고 pending이 남은 성공 패스는 10초 poll을 생략한다. 유휴·무진전·실패 시에는 기존 대기와 재시도 backoff를 유지한다. 발견·재확인 예산은 각각 최대 10초다. 프로젝트 목록 읽기와 이미 시작한 SQL까지 합한 전체 wall-clock 상한을 뜻하지는 않는다. worker의 DB URL에만 `statement_timeout=30000`, `lock_timeout=5000`을 넣어 서버가 지연 쿼리와 잠금 대기를 실제 취소하게 했다. 전역 DB 설정은 바꾸지 않았다. 격리 DB에서 timeout transaction의 INSERT rollback(0행)과 같은 연결의 재시도 성공(1행)을 확인했다.

## 일관성 및 실패 처리

계획과 payload의 job ID·상태·셀·ACR·멘션이 다르거나, 누락·중복·cursor 반복이 발견되면 성공 처리하지 않는다. 원본 변경은 `blocked`로 두고 다음 발견에서 최신 계획을 시작한다. 손상·미지원 checkpoint는 `checkpoint-invalid`로 격리한다. 기존 숨김 소유권을 잃지 않도록 손상된 상태를 자동 초기화하지 않는다.

모든 페이지 후에는 대표 answer ID 집합과 ACR 행수를 검증한다. 기존 `scope_runs` 완료 기준점, catalog·cycle-control, 숨김 복원, 캐시 무효화를 순서대로 확정한다. 기존 cycle anchor와 원장 membership이 다르면 둘 다 보호하며, 같은 회차의 동시 bulk와 운영자의 숨김 변경도 보존한다. 일반 미러와 summary swap도 미완료 bulk를 확인한다.

QA의 답변 목록·상세·이전/다음·진행률·노트/CSV(`qa-review.ts`), 표준/admin 본문 및 snapshot·trend 공통 조건(`scope-aggregates.ts`)에 승인된 제외 조건을 적용했다. 운영자의 일반 숨김을 QA 전체에 확대하거나 조회 화면을 개편하지 않는다. `finalize/invalidate-published`는 검증·숨김 복원이 이미 커밋된 단계이므로 직접 조회에 공개하며 캐시 무효화를 이어간다.

## 성능 원인과 검증

처음에는 DB의 반복 조회, 큰 분석 JSON, 전송·압축 대기를 구분해 조사했다. 오래된 Scope checkout의 job별 N+1은 최신 코드에서 이미 배치 조회로 교체돼 있었다. HMG 로컬 전체 적재도 원본을 대체한 시험에서는 약 5분에 끝났다. 반면 실제 원본의 기본 압축 응답은 200건당 계획 9.9–11.5초, 본문 포함 20.9–25.6초가 걸렸으며 대부분은 헤더 수신 전 대기였다.

같은 요청에서 압축 방식만 비교했다. 계획 5,371,766 bytes는 Brotli 약 10.6초, gzip 약 2.2초였다. 본문 포함 10,571,057 bytes는 Brotli 23.370초, gzip 2.265초였으며 해제된 응답의 SHA-256이 동일했다. 따라서 Scope API·DB 구조를 추가 변경하는 대신 HMG jobs 요청의 헤더만 바꿨다. 다른 API 요청과 timeout은 유지한다. 12개 연속 페이지의 전후 표본은 `notes/readiness/throughput-probe.json`과 `throughput-gzip.json`에 있다. 표본의 외삽은 전체 운영 완료시간 실측과 구분한다.

격리된 localhost PostgreSQL과 운영과 같은 Node 22.23.2/2GB heap 조건에서 합성 66,144 jobs를 실행했다. 331 계획 페이지와 331 payload 페이지, 대표 답변 38,748건, ACR 120,000건을 실제 bulk 코드로 298.433초에 처리했다. 해당 시험은 약 996MB의 합성 입력을 사용했으며 운영 원본 전송·catalog/cycle-control·실제 캐시 API 지연을 포함하지 않는다. macOS에서 수행했으므로 Linux 전체 운영 성능을 대신하지 않는다.

별도 600건 장애 시험에서는 첫 200건 커밋 직후 child를 SIGKILL하고, 재시작 첫 요청이 다음 cursor인 것을 확인했다. 최종 600건/ACR 24,000건이 일치했다. 공개 후 캐시 callback 실패는 `finalize/invalidate-published`를 보존했고, 다음 실행은 원본 재조회·답변 재작성 없이 완료했다. 실제 운영 캐시 HTTP 장애 시험은 포함하지 않았다.

실제 Scope 원본 66,144건도 GET으로 읽어 별도 localhost DB에 끝까지 적재했다. 331 계획 페이지와 331 payload 페이지, 해제된 JSON 약 5.42GB를 처리했고 최종 receipt는 `complete/done`, revision 789였다. 대표 답변 38,748건의 ID 집합, ACR 120,989건을 검증했으며 mentions 628,565건, occurrences 1,156,760건, citations 266,106건을 저장했다. 이 원본의 stances는 0건이며 스탠스 저장은 별도 합성/통합 시험으로 검증했다.

원본 연결 중단 후 계획 revision 204, 본문 revision 357에서 각각 재개했다. 세 구간의 실제 처리 시간 합은 **52분 10.825초**, 수동 재개 대기는 **29분 59.871초**, 전체 경과는 **82분 10.696초**다. 마지막 구간은 307페이지를 오류 없이 읽었고 저장된 cursor에서 시작했다. 시간 정본은 `notes/readiness/bulk-live-read-aggregate.json`이며 원시 단일 구간 결과의 누적시간 필드를 사용하지 않는다. 이 시험은 Node 22/2GB heap, macOS·로컬 DB pool 4, 실제 bulk 코드와 모의 cache callback 조건이다. 운영 pool 2, worker 발견/대기 주기, `finishBulkMetadata`, 운영 DB·캐시 API는 포함하지 않아 운영의 1시간 달성을 증명하지는 않는다.

보완본은 전체 제품 Vitest 295 files / 3,804 tests 통과(112 skipped), 별도 PostgreSQL 5 files / 29 tests 통과, Next build·앱/worker TypeScript·ESLint·migration check·shell/CLI·diff 검사까지 11개 단계를 통과했다. 검사 중 소스 해시는 동일했다. 결과는 `notes/readiness/bulk-final-results.json`에 있다. 수정 전 동작을 의도적으로 재현하는 로컬 조사 파일은 제품 테스트 실행에서 제외했다. 실제 원본→격리 DB 전체 재현은 위 결과와 별도 로그로 보존한다. 기존 베이스 3곳은 HEAD·status·추적 파일 4,542개의 해시로 보존 여부를 검사한다. 새 성능 시험은 기존 `scope-sandbox-pg`와 별도인 `hmg-mirror-readiness-20260915` 컨테이너만 사용한다.

## 명시적인 계약 한계

원본 API에는 payload revision/updated marker가 없다. 같은 terminal status, 같은 job 수 및 미완료 ID 집합에서 본문·인용·분석 내용만 바뀌는 경우를 완료 receipt의 상태 재확인으로 감지하지는 못한다. 계획 fingerprint도 result·occurrences·stances 전체를 포함한 원본 snapshot 보증이 아니다. 일반적인 실패→완료 복구와 run 상태 변경은 이번 자동화에 포함된다.

발견의 pending 페이지는 당시 읽은 run summary를 보존하며 재개 때 매 항목을 다시 조회하지 않는다. 저장 이후 원본이 다시 실행되는 상황까지 summary의 최신성을 보장하지 않는다. 계획/payload 일치 검증, source-change 격리 및 다음 발견·사후 복구 확인을 사용한다.

1시간은 무제한 동시 작업에 대한 용량 보증이 아니다. 신규 대량 run의 원본 준비→발견→계획/적재→검증/캐시→QA·본문 API 시간을 운영에서 관측해야 한다. `readyObservedAt`은 발견 시각이므로 원본 준비 시각을 대신하지 않는다. 공개 정책에 따른 회차 대기는 이 시간에서 구분한다.

## 운영 적용안 — 승인 후 실행

1. 최종 PR SHA와 기존 runner의 접근 권한을 고정한다. 기존 HMG Scope 키를 `hmg-geo/prod/scope-api-key`에 보관하고 `hmg-summary-runner-role`에 그 실제 ARN의 `GetSecretValue`만 추가한다. 기존 DB/CRON secret과 writer 역할은 유지한다. 값은 파일·명령 인자·로그에 남기지 않는다.
2. 승인된 기존 적용기로 **0073만** 적용한다(`npm run db:apply -- 0073`). 과거 migration 재실행 위험이 있는 `db:migrate`는 사용하지 않는다.
3. 웹의 조회 제외 조건과 cron 코드를 발견 flag가 꺼진 상태로 배포한다. warm process의 테이블 존재 probe가 갱신됐는지와 QA/body 조건을 확인한다.
4. 기존 뭄바이 EC2 `i-0123456789abcdef0`의 별도 release directory에 같은 SHA를 설치한다. unit의 release path와 비밀값을 제외한 설정을 확정하고 `npm ci --include=dev`, worker help, unit 검증을 수행한다. 기존 current symlink, 이전 release, summary service/timer는 보존한다.
5. 빈 큐의 `--once`를 먼저 확인한다. `hmg-mirror.service`를 활성화하면 `--watch --discover`가 자체 발견을 시작한다. 웹 cron의 보조 발견 flag `MIRROR_BULK_ENABLED=1`도 적용하고 상시 발견·재개 로그를 확인한다.
6. 다음 신규 대량 run에서 전체 1시간 목표와 기존 공개 정책을 각각 확인한다. 회차 8을 운영 시험으로 재처리하지 않는다.

이전 `b32db8c`로 EC2에 준비한 candidate는 이번 보완본과 다르다. 그 설치 성공을 최신 코드의 설치 검증으로 보고하지 않는다. 최종 SHA로 별도 release를 준비해야 한다.

중지할 때는 웹 flag를 끄고 **`systemctl stop hmg-mirror.service`도 함께 실행한다**. 웹 flag만 꺼도 worker의 자체 발견은 계속된다. progress와 임시 숨김은 유지하고, 같은 코드로 다시 켜면 다음 구간부터 재개한다. 미완료 progress가 있는 동안 제외 조건이 없는 예전 웹/writer로 되돌리거나 테이블·숨김을 임의로 제거하지 않는다.
