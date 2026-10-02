# HMG-GEO 측정 연동 인터페이스

| 항목 | 내용 |
| --- | --- |
| 대상 | S2W (HMG-GEO 개발·운영) |
| 작성 | 앤서 |
| 판 | v0.1 협의안 · 2026-10-02 |
| 문의 | theo@answer.global |

HMG-GEO 는 S2W 가 개발·운영합니다. AI 답변 측정은 앤서 Scope 가 맡습니다. 이 문서에는 두 시스템이 주고받는 API 계약을 정리했습니다. 끝에 앤서 쪽 변경 사항을 OpenSpec 형식으로 붙였습니다.

각 엔드포인트에는 제공 상태를 표시했습니다.

| 표시 | 뜻 |
| --- | --- |
| **현행** | 지금 운영 중인 API 그대로 씁니다 |
| **변경 예정** | 지금도 있지만 S2W 전용 키에 맞춰 동작이 바뀝니다 |
| **신설 예정** | 새로 만듭니다. 형태는 이 문서를 따르며 일정은 따로 안내합니다 |

## 1. 역할 분담

| 앤서 Scope | S2W (HMG-GEO) |
| --- | --- |
| 프로젝트·프롬프트·측정 주기 저장 | 무엇을 측정할지 정하고 API 로 등록 |
| 정기 측정 실행, 회차 관리, 실패 재시도 | 회차 결과를 화면에 언제 공개할지 결정 |
| 수동 측정 실행 | 수동 측정 요청 |
| 측정 원문 제공: 질문, 답변, 인용, 측정 정보, 응답 원본 | 분석: 브랜드 언급, 감성, 최종 선택(ACR), 인용 분류 |
| API 키 발급·교체, 호출 한도 관리 | 키 보관, 동기화 배치, 자체 DB·화면 |

Scope 는 원문만 제공합니다. 분석 값은 S2W 분석 엔진이 원문으로 계산합니다.

## 2. 공통 규약

### 2.1 접속과 인증

전용 키와 키 관리 규칙은 변경 예정 항목입니다.

- 기본 주소와 API 키는 문서와 따로 전달합니다. 모든 경로는 기본 주소 아래 `/api/v1` 로 시작합니다.
- 모든 요청에 `Authorization: Bearer <API 키>` 헤더를 붙입니다.
- S2W 에는 전용 키를 발급합니다. 이 키로는 2.3 의 엔진 3종만 다룹니다. 응답에는 원문만 담깁니다.
- 키 발급과 교체는 앤서가 합니다. 새 키는 따로 전달합니다. 옛 키는 정한 유예 시간이 지나면 만료됩니다. S2W 키로는 키 발급·교체 API 를 쓸 수 없습니다. 교체 주기는 협의합니다(9장).

### 2.2 형식

| 항목 | 규칙 |
| --- | --- |
| 본문 | JSON, UTF-8 |
| 시각 | ISO 8601 UTC (`2026-09-28T16:00:00Z`) |
| ID | UUID |
| 국가 | ISO 3166-1 alpha-2 대문자 (`KR`, `US`, `IT`) |
| 목록 | `limit` + `cursor`. 응답의 `next_cursor` 를 다음 요청에 넣습니다. `null` 이면 끝입니다 |
| 오류 | `{"error": {"code", "message", "details"?}}`. `code` 는 `invalid_argument` · `unauthorized` · `forbidden` · `not_found` · `conflict` · `rate_limited` · `server_error` · `service_unavailable` |
| 호출 한도 | 넘으면 `429` 와 `Retry-After` 헤더를 줍니다. 남은 한도는 `X-RateLimit-*` 헤더로 알려 줍니다 |
| 중복 방지 | 측정 요청(POST)에 `Idempotency-Key: <UUID>` 를 붙이면 24시간 안의 같은 키 요청에 같은 응답을 돌려줍니다 |

### 2.3 측정 엔진

| `target` | 대상 | 국가 처리 |
| --- | --- | --- |
| `chatgpt` | ChatGPT 웹 답변 | 프로젝트 국가마다 측정 |
| `gemini` | Gemini 웹 답변 | 프로젝트 국가마다 측정 |
| `deepseek` | DeepSeek 답변 | 국가 구분 없이 프롬프트당 한 번 측정하고 `region` 은 항상 `US` 로 기록 |

목록에 없는 값을 보내면 `400 invalid_argument` 를 받습니다(변경 예정: S2W 키에 적용).

## 3. 측정 대상 관리 (현행)

### 3.1 프로젝트

| 메서드·경로 | 용도 |
| --- | --- |
| `POST /projects` | 프로젝트 생성 |
| `GET /projects` · `GET /projects/{project_id}` | 조회 |
| `PATCH /projects/{project_id}` | 수정 |
| `DELETE /projects/{project_id}` | 삭제 |

생성 본문의 주요 필드:

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `name` | O | 프로젝트 이름 |
| `domain` | | 자사 도메인 (`kia.com`) |
| `tracked_brands` | O | 추적 브랜드 `[{brand_name, alternative_names?, aliases?}]` |
| `regions` | O | 측정 국가 목록. 이 프로젝트에서 측정하는 국가의 상한입니다 |

```json
POST /api/v1/projects
{
  "name": "Kia IT",
  "domain": "kia.com",
  "tracked_brands": [{ "brand_name": "Kia" }],
  "regions": ["IT"]
}
```

### 3.2 프롬프트

| 메서드·경로 | 용도 |
| --- | --- |
| `POST /projects/{project_id}/prompts` | 등록 |
| `GET /projects/{project_id}/prompts?limit=&cursor=&updated_from=` | 조회. `updated_from` 을 주면 그 뒤에 바뀐 것만 옵니다 |
| `PATCH /projects/{project_id}/prompts/{prompt_id}` | 수정·일시정지 |
| `DELETE /projects/{project_id}/prompts/{prompt_id}` | 삭제 |

| 필드 | 설명 |
| --- | --- |
| `text` | 질문 문장 (필수) |
| `keywords` | 분류 태그. 현재 HMG-GEO 는 `hmg:brand:<브랜드>` · `hmg:category:<분류>` 형식을 씁니다 |
| `regions` | 이 프롬프트만 측정할 국가. 프로젝트 `regions` 안에서 고릅니다. `null` 이면 프로젝트 전체를 따릅니다 |
| `lang` | 질문 언어 (`KO`, `EN` 등). 표시·필터용이며 측정 국가에는 영향이 없습니다 |
| `enabled` | `false` 면 정기 측정에서 빠집니다 |

### 3.3 정기 측정 주기

| 메서드·경로 | 용도 |
| --- | --- |
| `GET /projects/{project_id}/schedule` | 조회 |
| `PUT /projects/{project_id}/schedule` | 설정 `{enabled, interval_days, targets}` |

- `interval_days` 는 1~30 입니다. 같은 프롬프트·엔진·국가 조합은 이 주기마다 한 번 측정합니다.
- `targets` 는 2.3 의 엔진 중에서 고릅니다. 국가는 프로젝트 `regions` 를 따릅니다.
- 정기 측정은 Scope 가 주기에 맞춰 실행합니다. S2W 가 따로 호출하지 않아도 됩니다.

## 4. 수동 측정 (변경 예정: S2W 키에 개방)

정기 주기와 별개로 지금 바로 측정해야 할 때 씁니다.

```json
POST /api/v1/projects/{project_id}/measurements
Idempotency-Key: 7c0e…
{ "targets": ["chatgpt", "gemini"], "regions": ["KR"], "prompt_ids": ["…"] }
```

| 필드 | 설명 |
| --- | --- |
| `targets` | 측정할 엔진 (필수) |
| `regions` | 생략하면 프로젝트 `regions` 전체 |
| `prompt_ids` | 생략하면 프로젝트의 활성 프롬프트 전체 |
| `skip_fresh` | `true` 면 정기 주기 안에서 이미 측정한 조합은 건너뜁니다 |

응답은 `202` 이고 본문에 `measurement_run_id` 와 생성된 측정 목록(`jobs[]`)이 들어 있습니다. 결과는 6장의 원문 조회로 받습니다.

이용 규칙:

- 수동 측정은 새 회차를 열지 않습니다. 결과에는 직전 정기 회차의 `cycle_anchor_at` 이 붙습니다. 실제 측정 시각은 반복마다 `measured_at` 으로 확인합니다.
- 같은 프롬프트를 정기 주기보다 짧은 간격으로 계속 수동 측정하면 다음 정기 측정이 "이미 측정됨"으로 판단돼 열리지 않을 수 있습니다.
- 한 번에 몰아서 요청하지 말고 나눠서 보냅니다. 키마다 하루 측정 한도를 둡니다. 한도 값은 협의합니다(9장). 한도를 넘으면 `429 rate_limited` 를 받습니다.

## 5. 측정 실행 현황 (현행)

| 메서드·경로 | 주는 것 |
| --- | --- |
| `GET /projects/{project_id}/measurements?limit=&cursor=&status=&trigger=&date_from=&date_to=` | 측정 실행(run) 목록. `limit` 최대 100 |
| `GET /projects/{project_id}/measurements/{run_id}` | run 상세 (엔진, 국가, 프롬프트 수 포함) |

run 의 주요 필드:

| 필드 | 설명 |
| --- | --- |
| `measurement_run_id` | run ID |
| `status` | `queued` · `running` · `completed` · `partial_failed` · `failed` |
| `trigger` | `scheduled`(정기) · `manual`(수동) |
| `started_at` · `completed_at` | 실행 시작·완료 시각 |
| `total_jobs` · `completed_jobs` · `failed_jobs` | 측정 건수 |
| `cycle_anchor_at` | 이 run 이 속한 **회차**의 기준 시각 |

회차는 run 과 다릅니다. 한 회차의 측정이 여러 날, 여러 run 에 나뉘어 들어오기도 합니다. 회차별로 묶을 때는 `cycle_anchor_at` 을 기준으로 씁니다.

## 6. 원문 조회 (신설 예정)

### 6.1 run 단위 원문 목록

측정 단위는 **프롬프트 × 엔진 × 국가 × 반복 × 턴**입니다. 한 프롬프트를 같은 조건으로 여러 번 잴 때 그 한 번 한 번이 반복입니다. 이어지는 질문이 있는 대화에서는 질문과 답변 한 쌍이 턴입니다.

```json
GET /api/v1/projects/{project_id}/measurements/{run_id}/raw?limit=50&cursor=
{
  "data": [{
    "prompt_run_id": "…", "prompt_id": "…",
    "target": "chatgpt", "region": "KR",
    "cycle_anchor_at": "2026-09-28T16:00:00Z",
    "iterations": [{
      "iteration_index": 1, "status": "completed",
      "measured_at": "2026-09-29T02:14:07Z", "updated_at": "2026-09-29T02:14:09Z",
      "model_slug": "…",
      "turns": [{
        "turn_id": "…", "turn_index": 1,
        "prompt_text": "…", "answer_text": "…",
        "citations": [{ "url": "https://…", "title": "…", "domain": "…" }],
        "response_content_type": "text/event-stream", "response_bytes": 183204
      }]
    }]
  }],
  "next_cursor": null
}
```

| 필드 | 설명 |
| --- | --- |
| `prompt_run_id` | 프롬프트 × 엔진 × 국가 측정 묶음의 ID |
| `iteration_index` | 반복 번호 (1부터) |
| `status` | `completed` · `failed`. 실패한 반복도 빠짐없이 싣습니다 |
| `measured_at` | 실제 측정 시각 |
| `updated_at` | 이 반복이 마지막으로 바뀐 시각. 재측정으로 바뀌면 갱신됩니다 |
| `model_slug` | 답변한 모델 이름(제공사 표기) |
| `turns[].prompt_text` · `answer_text` | 질문과 답변 텍스트 |
| `turns[].citations` | 제공사가 준 인용 그대로: `url`, `title`, `domain` |
| `response_content_type` · `response_bytes` | 6.2 에서 받을 응답 원본의 형식과 크기 |

한 run 의 원문 목록에는 그 run 에서 측정한 반복만 들어 있습니다. 보충 측정은 같은 `prompt_run_id` 의 빠진 반복을 다른 run 에서 채울 수 있으므로, 저장 키는 `(prompt_run_id, iteration_index)` 로 잡습니다.

응답에 들어가지 않는 것: 브랜드 언급·감성·최종 선택 같은 분석 값, 인용 분류(매체 유형 등). 모두 S2W 가 원문으로 만듭니다.

### 6.2 턴 단위 응답 원본

```
GET /api/v1/turns/{turn_id}/response
→ 200, Content-Type = response_content_type
```

- 제공사가 보낸 응답 본문입니다. 스트리밍 원문, JSON 등 형식은 엔진·수집 경로마다 다르고 `Content-Type` 으로 표시합니다.
- 측정 환경 정보(세션 식별자, 과금 정보 등)를 담은 일부 필드는 빼고 드립니다. 엔진별 제외 필드 목록과 샘플은 따로 드립니다.
- 원본이 없는 턴은 `404 not_found` 입니다.

## 7. 동기화 권장 절차

1. `GET …/prompts?updated_from=<마지막 동기화 시각>` 으로 바뀐 프롬프트를 받습니다.
2. `GET …/measurements` 로 run 목록을 받아 새 run 과 아직 끝나지 않은 run 을 고릅니다.
3. 고른 run 마다 `GET …/measurements/{run_id}/raw` 를 끝까지 넘겨 받습니다.
4. 반복은 `(prompt_run_id, iteration_index)` 로 저장합니다. `updated_at` 이 저장본보다 새로우면 덮어씁니다.
5. 끝난 run 도 그 회차가 열려 있는 동안은 주기적으로 다시 받습니다. 재측정·보충으로 바뀐 반복은 `updated_at` 으로 골라 반영합니다. 다음 회차가 시작된 뒤에는 이전 회차의 run 을 다시 받지 않아도 됩니다.
6. 응답 원본(6.2)은 필요한 턴만 받습니다.

## 8. 운영 연락

theo@answer.global 로 연락합니다. 앤서는 아래 상황을 이 주소로 S2W 담당자에게 알립니다. S2W 도 같은 주소로 문의·장애 신고를 보냅니다.

- 정기 측정 지연, 회차가 열리지 않는 경우
- API 키 교체
- API 변경(필드 추가, 신설 엔드포인트 개시)

## 9. 협의할 사항

| # | 항목 | 내용 |
| --- | --- | --- |
| C1 | 과거 회차 분석 값 | 지금 HMG-GEO DB 에 있는 과거 분석 값을 그대로 쓸지, 과거 원문을 받아 S2W 분석 엔진으로 다시 계산할지 |
| C2 | 수동 측정 한도와 비용 | 키당 하루 한도, 넘었을 때 처리, 비용 정산 |
| C3 | 호출 한도와 동기화 주기 | 동기화 배치가 쓰는 호출량 기준 |
| C4 | 키 교체 주기와 전달 경로 | 키 값은 문서에 쓰지 않고 따로 전달 |
| C5 | 전환 일정 | 신설 API 개시일, 현재 HMG-GEO 연동 종료일 |

---

## 부록. OpenSpec 변경안

앤서 Scope 가 S2W 전용 키에 맞춰 바꾸는 내용입니다. 4장·6장 및 2.3 의 엔진 제한이 여기에 해당합니다.

### change: `partner-raw-measurement-api`

파일 두 개로 구성합니다. 아래 블록은 파일 원문 그대로입니다.

#### `openspec/changes/partner-raw-measurement-api/proposal.md`

```markdown
# Change: 파트너 키 원문 전용 측정 API

## Why

HMG-GEO 는 S2W 가 운영합니다. 분석도 S2W 분석 엔진이 맡습니다. 지금 Scope API 는 분석 값을 원문과 섞어서 줍니다. 멀티턴 대화의 전체 원문을 한 번에 받을 경로도 없습니다. 또 API 키 하나가 워크스페이스 전체 권한이라 키 단위로 엔진이나 수동 측정 한도를 제한할 수 없습니다.

## What Changes

- API 키에 파트너 정책을 붙입니다: 허용 엔진, 원문 전용 응답, 수동 측정 하루 한도, 키 관리 API 차단.
- run 단위 원문 목록 `GET /projects/{project_id}/measurements/{run_id}/raw` 를 새로 만듭니다.
- 턴 단위 응답 원본 `GET /turns/{turn_id}/response` 를 새로 만듭니다. 엔진별 허용 필드만 남깁니다.
- 반복마다 `updated_at` 을 둡니다.
- 수동 측정 `POST /projects/{project_id}/measurements` 를 파트너 키에 엽니다.

## Impact

- 영향 받는 API: 프로젝트·프롬프트·주기(엔진 검증), 측정 실행(수동 측정), API 키 관리(파트너 키 차단), 신설 원문 API 2종.
- 기존 키와 기존 응답 형태는 바뀌지 않습니다. 파트너 정책이 붙은 키에만 적용됩니다.
```

#### `openspec/changes/partner-raw-measurement-api/specs/partner-measurement-api/spec.md`

```markdown
## ADDED Requirements

### Requirement: 파트너 키 엔진 제한

파트너 정책이 붙은 키는 허용 엔진(`chatgpt`, `gemini`, `deepseek`)만 다룰 수 있어야 한다(SHALL). 허용 밖 엔진을 지정한 쓰기 요청은 거부해야 한다.

#### Scenario: 허용 밖 엔진으로 주기 설정

- **WHEN** 파트너 키로 `PUT /projects/{id}/schedule` 에 `targets: ["chatgpt", "unknown-engine"]` 을 보낸다
- **THEN** `400 invalid_argument` 를 받고 주기는 바뀌지 않는다

### Requirement: 파트너 키의 키 관리 차단

파트너 키로는 API 키를 발급·교체·폐기할 수 없어야 한다(SHALL). 키 관리는 앤서만 한다.

#### Scenario: 키 발급 시도

- **WHEN** 파트너 키로 `POST /api-keys` 를 호출한다
- **THEN** `403 forbidden` 을 받고 키는 만들어지지 않는다

### Requirement: 원문 전용 응답

파트너 키의 응답에는 분석 값과 인용 분류가 들어가지 않아야 한다(SHALL).

#### Scenario: 분석 필드 없음

- **WHEN** 파트너 키로 원문 목록을 조회한다
- **THEN** 응답에 `analysis` 키가 없다
- **AND** `citations[]` 의 각 항목은 `url`, `title`, `domain` 만 가진다

### Requirement: run 단위 원문 목록

`GET /projects/{project_id}/measurements/{run_id}/raw` 는 run 의 측정을 `prompt_run` 단위로 묶어 반복 × 턴 원문을 돌려줘야 한다(SHALL).

#### Scenario: 멀티턴 측정

- **GIVEN** 2턴 대화 프롬프트를 3번 반복 측정한 run 이 있다
- **WHEN** 원문 목록을 조회한다
- **THEN** 그 `prompt_run` 항목은 `iterations` 3개를 가지고 각 반복은 `turns` 2개를 가진다

#### Scenario: 실패한 반복 포함

- **GIVEN** 3번 중 1번이 실패했다
- **WHEN** 원문 목록을 조회한다
- **THEN** 실패한 반복도 `status: "failed"` 로 들어 있고 `turns` 는 비어 있을 수 있다

#### Scenario: 페이지 넘김

- **WHEN** 결과가 `limit` 보다 많다
- **THEN** `next_cursor` 가 온다
- **AND** 그 값으로 이어서 조회하면 빠짐·중복 없이 끝까지 받는다

### Requirement: 턴 단위 응답 원본

`GET /turns/{turn_id}/response` 는 제공사 응답 본문을 엔진별 허용 필드만 남겨 돌려줘야 한다(SHALL).

#### Scenario: 원본 조회

- **WHEN** 파트너 키로 원문 목록에 있던 `turn_id` 의 응답 원본을 요청한다
- **THEN** `200` 과 함께 `response_content_type` 과 같은 `Content-Type` 의 본문을 받는다

#### Scenario: 다른 워크스페이스의 턴

- **WHEN** 파트너 키의 워크스페이스에 속하지 않은 `turn_id` 를 요청한다
- **THEN** `404 not_found` 를 받는다

### Requirement: 반복 변경 시각

모든 반복은 `updated_at` 을 가져야 한다(SHALL). 재측정·보충으로 내용이 바뀌면 이 값을 갱신해야 한다(SHALL).

#### Scenario: 재측정

- **GIVEN** S2W 가 반복 1을 `updated_at = T1` 으로 저장했다
- **WHEN** 그 반복이 재측정된다
- **THEN** 다음 조회에서 그 반복의 `updated_at` 은 T1 보다 늦다

### Requirement: 파트너 키 수동 측정

파트너 키로 수동 측정을 요청할 수 있어야 한다(SHALL). 키별 하루 한도를 넘는 요청은 거부해야 한다(SHALL).

#### Scenario: 한도 안 요청

- **WHEN** 파트너 키로 허용 엔진의 수동 측정을 요청한다
- **THEN** `202` 와 `measurement_run_id` 를 받는다
- **AND** 그 run 의 `trigger` 는 `manual` 이고 `cycle_anchor_at` 은 직전 정기 회차 값이다

#### Scenario: 한도 초과

- **WHEN** 오늘 요청한 측정 건수에 이번 요청을 더하면 하루 한도를 넘는다
- **THEN** `429 rate_limited` 를 받고 측정은 하나도 만들어지지 않는다

### Requirement: deepseek 국가 처리

`deepseek` 측정은 프로젝트 국가 수와 관계없이 프롬프트당 한 번 실행하고 `region` 을 `US` 로 기록해야 한다(SHALL).

#### Scenario: 여러 국가 프로젝트

- **GIVEN** `regions: ["KR", "IT"]` 인 프로젝트
- **WHEN** `deepseek` 을 포함해 측정한다
- **THEN** `deepseek` 결과는 프롬프트마다 `region: "US"` 한 묶음만 생긴다
```
