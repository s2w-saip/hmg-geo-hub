# 미러 대량 처리 — 1차 안정화

이 문서는 1차 패치의 조사·검증 기록이다. PR #265의 최종 대량 자동 발견·구간 재개·조회 제외·운영 적용 범위는 [대량 미러 자동 재개](mirror-bulk-resume.md)를 따른다.

기준 커밋은 `3431f9b90b4969f5281b0b8818707f28b1e81b79`(#258)이다. 이 변경은 정상 동기화의 처리 순서·조회 마감·복구 완료 판정을 고치고, 앵커 복구용 읽기 전용 대조 도구를 제공한다. 운영 DB 마이그레이션이나 데이터 보정은 포함하지 않는다.

## 문제와 변경

- root가 항상 첫 번째여서 이전 시도 시각을 갱신해도 다른 프로젝트가 앞설 수 없었다. root도 마지막 시도 시각에 따른 순회에 포함한다. 같은 시각이면 root 우선순위는 유지한다.
- 시간 예산은 페이지 조회가 끝난 뒤에야 검사됐다. 미러 GET 요청에 개별 `AbortSignal`을 전달하고 deadline에 취소한다. 반환이 늦은 페이지나 일부 jobs를 완전한 run으로 저장하지 않는다. shared Scope client는 수정하지 않는다.
- 패스 예산은 함수 진입부터 계산한다. `projectBudgetMs`로 한 프로젝트의 상한을 별도 설정할 수 있다. 기본은 기존 전체 예산을 유지한다. 지금 루트 카탈로그 조회가 오래 걸릴 수 있으므로 임의로 60초로 줄여 루트가 영원히 run 처리에 도달하지 못하게 만들지 않는다. 이미 시작된 DB 트랜잭션은 강제로 취소하지 않는다.
- `maxRuns: 50`은 CLI 옵션/env로 조절한다. 다음 처리 대상이 남으면 `runLimitHits`에 project ID와 next run ID를 반환한다. 정확히 마지막 대상에서 한도에 닿은 경우는 불완료로 오판하지 않는다.
- CLI는 프로젝트 오류, budget 중단, 미처리 프로젝트, 찾지 못한 프로젝트, 페이지 절단, oversized/truncated run, 재확인 상한, run 한도 초과가 남으면 종료코드 3을 반환한다. 잘못된 인자와 누락된 live 설정은 쓰기 모듈을 로드하기 전에 종료코드 2로 거부한다.

## 복구 CLI

도움말은 환경이나 DB 없이 실행할 수 있다.

```sh
npm run mirror:local-resync -- --help
```

인자:

```text
<runsSince ISO> <runsUntil ISO> [projectId]
  --max-runs N
  --resync-before ISO
  --prompts-updated-from ISO
  --prompts-updated-to ISO
```

모든 timestamp는 timezone을 포함한다. run 범위는 `[since, until)`이며 since < until이어야 한다. `--max-runs`가 `MIRROR_RESYNC_MAX_RUNS`보다 우선하고, 미지정 시 50이다. `MIRROR_LOCAL_BUDGET_MS` 기본값은 6시간이다. 인증 정보는 종전처럼 실행 환경에만 제공한다.

첫 패스는 시작 시각을 `resyncBefore`로 출력한다. 이후 패스에 **같은 값**을 `--resync-before` 또는 `MIRROR_RESYNC_BEFORE`로 넘기면 해당 시각 이후 미러된 run을 건너뛴다. 새 패스의 시작 시각을 매번 사용하면 앞부분을 다시 처리할 수 있다. `nextRunId`는 남은 작업을 설명하는 정보이며, 서버가 제공하는 페이지 커서로 사용할 수 없다.

이 기능은 기존 `synced_at` 기준의 run 재개다. source revision이나 chunk checkpoint를 제공하지 않는다. 동시 cron이 쓴 run도 cutoff 판정에 영향을 주므로, 회복 작업은 겹치지 않는 대상/시간 창으로 조율하고 종료 후 원본과 대조해야 한다. 같은 run 안에서 변경된 분석을 증명하는 수단으로 `synced_at`을 사용하지 않는다.

`pageCapHits`에는 prompt 카탈로그 절단도 포함된다. 필요하면 명시적인 prompt 수정 시간 창으로 나눠 회수하고, 출력된 창별 완전성을 검증한다. prompt 창을 좁히는 것은 전체 카탈로그 회복의 증거가 아니다. 이 변경은 cron의 page cap을 높이지 않는다.

종료코드:

| 값 | 의미 |
| --- | --- |
| 0 | 요청한 범위에서 미처리·오류 표지가 없음 |
| 1 | 예기치 못한 실행 예외 |
| 2 | 잘못된 인자 또는 live 설정 누락 |
| 3 | 일부 처리했으나 오류/상한/시간 예산/미처리 소스가 남음 |

## 앵커 복구

[`anchor-audit.ts`](../scripts/scope/anchor-audit.ts)는 추출된 메타데이터만 읽으며 DB 연결·HTTP 호출·UPDATE를 하지 않는다. 부모 `measurement_runs`와 자식 `query_runs`, 미러 `scope_runs`, 회차 멤버십을 같은 run ID로 대조한다. 불완전하거나 상충하는 snapshot은 BLOCK으로 보고한다. 자세한 입력 계약과 추출 SQL은 [대조 절차](mirror-anchor-reconciliation.md)에 있다.

이번 사고의 수정 대상은 자식만이 아니다. run 목록 API는 부모 `measurement_runs.cycle_anchor_at`을 반환한다. 자식 수정만으로는 API·미러 앵커가 갱신되지 않는다. 실제 보정 단계에서는 대상 manifest와 원본 timestamp를 백업한 후 부모/자식/API/미러 정합성, 원장 멤버 귀속, expected/completed 재산정, 집계 세대·공개 상태를 각각 확인해야 한다.

## 검증과 후속 범위

격리된 main에서 먼저 실제 함수 호출로 root 예산 독점과 CLI exit 0 오류를 재현했다. 수정 후에는 fake timer와 HTTP fetch mock을 사용해 조회 중단·다음 프로젝트 진전·이미 완료한 run 보존·CLI 실패 판정을 검증한다. 기존 repository 경계, ACR 대표 접기와 run 단위 원자성은 회귀 대상으로 둔다.

2026-09-15 격리 워크트리 검증:

- 전체 Vitest: 279개 파일, 3,608개 테스트 통과. DB 연결을 제거한 환경에서 DB 통합 테스트 등 21개 파일·92개 테스트는 건너뛰었다.
- 마지막 앵커 입력 계약 보완 후 해당 테스트 19개, 전체 TypeScript 검사, 변경 파일 ESLint를 다시 통과했다. 문서 JSON 예제를 실제 CLI로 읽어 MATCH·추천 CSV·누락 시 BLOCK·빈 대상 오류·도움말을 확인했다.
- `npm run build`: 컴파일, 타입 검사 및 100개 정적 페이지 생성 성공.
- `npm run lint`: 통과. 기존 수정 범위 밖 경고는 남아 있다.
- 기존 hmg-geo 두 베이스와 Scope 베이스의 HEAD, 작업 상태, 추적 파일 상태를 시작 시점 기록과 대조해 동일함을 확인했다.

운영 연결·배포·DB 보정 없이 검증했다. mock 테스트와 로컬 빌드는 운영 처리 시간이나 DB 트랜잭션 비용을 증명하지 않는다. 릴리스 전에는 격리된 검증 환경에서 root/일반 프로젝트의 순회 진전, deadline 취소, 중단 후 재시도, ACR/답변/카탈로그 정합성을 실측해야 한다.

후속으로 #260의 슬라이스 적재를 별도 검토하고, 전용 runner의 lease/checkpoint와 source snapshot·generation 공개 계약을 추가해야 한다. **이 1차 패치만으로 66,144-job run 자동 동기화나 부분 세대 비노출을 보장하지 않는다.** 현재 main의 oversized 차단을 유지한다. 미검토 #260을 이번 브랜치에 합쳐 운영 적재 방식을 동시에 바꾸지 않는다.

원인 가설 중 단순 네트워크 장애는 운영 root 순회 독점과 CLI의 false success를 설명하지 못했고, ACR PK 하나라는 가설은 #258의 dedup 이후에도 남은 timeout/편중을 설명하지 못했다. 대형 run을 무조건 더 많이 메모리에 올리는 방향은 이전 OS kill·DB timeout 기록 때문에 채택하지 않았다.
