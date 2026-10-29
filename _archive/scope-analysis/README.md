# scope-analysis

Scope 코어가 발행하는 분석 티켓을 처리하는 TypeScript 서비스입니다. API와 worker를 별도 프로세스로 실행하고, 분석 전용 PostgreSQL/RDS에 티켓·리스·호출 원장을 저장합니다.
HMG Supabase나 Scope 코어 DB를 `ANALYSIS_STORE_DSN`으로 사용하지 않습니다.

## 설치·검증

CI·컨테이너 기준 Node.js 20, pnpm 9.15.0입니다.

```sh
nvm install 20
nvm use 20
npx --yes pnpm@9.15.0 install --frozen-lockfile
npx --yes pnpm@9.15.0 check:analysis-core-pin
npx --yes pnpm@9.15.0 typecheck
npx --yes pnpm@9.15.0 test
npx --yes pnpm@9.15.0 cdk:synth
```

별도 build 단계 없이 `tsx`로 실행합니다. 일반 테스트는 PGlite와 stub/녹화 응답을 사용하며 공급자 유료 호출을 하지 않습니다.
실 PostgreSQL 테스트는 별도 DSN을 요구합니다. CDK synth는 자원 배포를 수행하지 않습니다.

## 실행 설정

`.env.example`는 개발용 stub 예시입니다. 실제 서비스는 별도 환경변수와 `ANALYSIS_ENGINE=core` 설정이 필요합니다.

| 설정 | 용도 |
| --- | --- |
| `ANALYSIS_STORE_DSN` 또는 `ANALYSIS_DB_*` | 분석 전용 DB |
| `ANALYSIS_ENGINE` | `stub`: 흐름 확인, `core`: 실제 분석 |
| 공급자 키·`LLM_TASK_MODEL_*`·풀 설정 | 승인된 모델·공급자. `infra/cdk.json`의 `llmTaskModels`, `llmTaskPools` 참조 |
| `ANALYSIS_INTERNAL_CONTEXT_TOKEN`, `ANALYSIS_INTERNAL_CALLBACK_TOKEN` | 코어 통신 인증 |
| `ANALYSIS_INGRESS_CERT_SECRET_ID` | mTLS 인증서 시크릿 참조 |

core 엔진의 필수 모델 변수는 아래 5개이며, CDK 설정은 `unknown_discovery` 모델까지 요구합니다.

```text
LLM_TASK_MODEL_measurement_analysis_extract_mentions
LLM_TASK_MODEL_measurement_analysis_resolve_pending_mentions
LLM_TASK_MODEL_measurement_analysis_mention_semantics
LLM_TASK_MODEL_measurement_analysis_classify_citation_domain
LLM_TASK_MODEL_measurement_analysis_answer_brand_stance
```

환경을 인계받아 `.env.local`에 저장한 경우 각각 별도 프로세스로 실행합니다.

```sh
node --env-file=.env.local --import tsx app/main.ts
node --env-file=.env.local --import tsx worker/main.ts
```

`pnpm api`/`pnpm worker`는 `.env.local`을 자동 로드하지 않습니다.
**API와 worker는 시작 시 migration을 적용합니다.** `pnpm migrate --status`도 원장 테이블을 만들 수 있으므로 읽기 전용 점검 명령으로 사용하지 않습니다.
API는 자체 사용자 인증이 없으며 운영에서는 사설 네트워크와 mTLS ingress로 보호합니다.
기본 Compose는 `.env.example`를 읽고 8080을 전체 호스트 인터페이스에 공개하므로 격리된 개발 환경에서 접근 범위를 제한해 사용합니다.
그 조건에서 로컬 스택은 `docker compose -f deploy/compose.yml up --build`로 실행합니다. 예제 DSN의 호스트 `db`는 컨테이너 내부 전용이며, 같은 DB에 호스트 프로세스로 연결할 때는 `127.0.0.1:55433`을 사용합니다. mTLS 개발 인증서는 `deploy/certs/make-dev-certs.sh`로 만든 뒤 Compose의 `--profile mtls`를 사용합니다.

## 개발 구조·계약

| 경로 | 역할 |
| --- | --- |
| `app/` | HTTP API, DB, migration, 티켓·큐·리스 |
| `contracts/` | 요청·상태·답장 스키마, ID 규칙, 코어 호환 fixture |
| `worker/` | 분석 엔진, 공급자 풀, 동시성·재시도·콜백 |
| `packages/analysis-core/` | 고정된 분석 코드·연결 shim |
| `migrations/` | 전용 DB 스키마 변경 |
| `deploy/`, `infra/`, `tests/` | 컨테이너, AWS CDK, 회귀 테스트 |

API는 `/v1/analysis-tickets`에 POST로 접수하고 `/{id}`로 상태, `/{id}/reply`로 결과를 조회합니다.
`/healthz`는 프로세스 생존, `/readyz`는 DB 연결만 확인합니다.
컨텍스트·콜백 URL은 코어가 티켓의 `context.ref`/`callbackUrl`로 전달합니다. 내부 토큰은 코어의 `ANALYSIS_LANE_CONTEXT_SECRET`/`ANALYSIS_LANE_CALLBACK_SECRET`와 각각 일치해야 합니다.

티켓·답장 계약의 정본은 Scope 코어이며 `contracts/v1.ts`는 그 사본입니다. 공유 계약 변경 시 코어와 분석 서비스 양쪽을 맞추고 `contracts/fixtures/core-mirror/` 및 계약 테스트를 갱신합니다.
답장의 `answerStances` 등 필드가 현재 코어/측정 worker에서 수용되는지 확인한 후 배포합니다.
벤더 코드는 `ANALYSIS_CORE_PIN.json`으로 고정됩니다. 직접 수정하지 않고 upstream 코어 변경 후 `pnpm sync:analysis-core <core-checkout>`으로 갱신하고 pin·golden 검사를 수행합니다. 재동기화에는 별도의 코어 저장소 접근권한이 필요합니다.

## 배포·정지 시 필수 조건

- 기존 AWS 계정·네트워크·ECR·시크릿 참조는 `infra/cdk.json`과 workflow에서 인수 대상과 대조합니다. 이미지 push는 `push-images-stage.yml`의 수동 실행입니다.
- 인증서 JSON 필드는 `server_cert_pem`, `server_key_pem`, `client_ca_pem`입니다. 개인키는 소스·이미지에 넣지 않습니다.
- 최초 신규 인프라는 이미지가 준비되기 전 `-c apiDesired=0 -c workerMin=0`으로 시작합니다. 이미지 3종과 인증서·토큰을 준비한 뒤 API·worker를 올립니다. 기존 운영 자원을 인수하는 경우 이 초기화 절차를 반복하지 않습니다.
- 운영 중 worker 정지는 `infra/`에서 `../node_modules/.bin/cdk deploy ScopeAnalysis-stage --exclusively -c workerMin=0`으로 autoscaling 하한을 낮춘 뒤 ECS worker desired count를 0으로 내립니다. 위 스택명은 기본 stage 기준이므로 실제 인수 대상과 AWS 계정을 먼저 확인합니다. desired count만 바꾸면 autoscaling이 다시 올릴 수 있습니다. 재개 시 workerMin을 운영값으로 복원합니다. API는 별도이므로 정지 중에도 티켓이 쌓일 수 있습니다.
- `lane-health.yml`은 30분 schedule이 이미 켜져 있습니다. 새 저장소의 최초 업로드 전에 Actions를 비활성화합니다. 이미지 push·health workflow의 OIDC 역할은 기존 저장소 기준이므로 IAM trust의 저장소/브랜치 sub 조건과 immutable subject 사용 여부를 확인하고 인수 저장소에 맞춥니다. 대상 자원·알림까지 확인한 뒤 활성화합니다. `contract-mirror-check.yml`의 수동 비교에는 코어 저장소용 토큰이 필요합니다.

운영 인수 검수는 티켓 접수 → worker 처리 → reply 조회 → 코어 반영까지 수행하고, 실패·대기열·리스·콜백 로그 및 알림 수신을 확인합니다.
