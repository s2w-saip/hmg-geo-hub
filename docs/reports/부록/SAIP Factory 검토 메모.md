# SAIP "Factory" 조사 — HMG GEO 데이터 처리 적합성

조사 범위: `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP` (S2W SAIP 플랫폼의 **프런트엔드** 저장소, `ontology-builder 1.0.0`, 마지막 커밋 2026-06-12). 서버 코드는 이 저장소에 없고, 서버 측 능력은 저장소에 스냅샷된 OpenAPI(`src/lib/api/generated/openapi.json`, 제목 "SAIP SDK API 0.9.0", 경로 110여 개·스키마 214개)와 사용 가이드(`docs/user-guide/*.md`)에서 읽어냈다. 아래에서 **[사실]** 은 파일에 적힌 내용, **[추정]** 은 그로부터 유추한 것이다. IP·키·비밀번호 값은 적지 않았다.

---

## 1. 한 줄 결론

**[사실+추정]** "SAIP Factory" 라는 이름은 이 저장소 어디에도 없고, 사용자가 말하는 "데이터 가공" 부분은 **SAIP Builder 의 Pipeline 모듈(+Datasets, 실행 엔진 Airflow)** 에 해당한다. 이 모듈은 "DB·API·파일 → 21종 변환(SQL류·Python·LLM Extract) → 자체 PostgreSQL 테이블" 을 cron 으로 돌리는 **KG 구축용 범용 ETL** 이며, HMG GEO 의 핵심 요구(답변 단위 LLM 분석·고정 모델 버전·JSON 스키마 검증·분석 버전 기록·H-Cloud Node.js/PostgreSQL 17 제약)에는 **코어 런타임으로는 맞지 않고**, 결과 테이블을 받아 온톨로지·Chat·대시보드로 보여 주는 **후방 소비자로는 부분적으로 쓸 수 있다**.

---

## 2. SAIP 개요와 "Factory" 가 가리키는 것

### 2.1 SAIP 가 무엇인가 [사실]

- "Use Case 기반 Knowledge Graph 자동 구축 플랫폼의 사용자 UI" — `README.md:3`. 도메인 데이터(Goal·Pipeline·Ontology·Workflow·Index)의 정본은 외부 **SAIP API Server**, AI 보조는 별도 서버 — `README.md:6-7`.
- 제품명은 **"SAIP Builder"** — `docs/user-guide/index.md:5`, `introduction.md:1`. 흐름: Goal → Pipeline → Datasets → Ontology → Indexing → Workflow → Chat/Dashboard — `introduction.md:11-17`.
- 사이드바 10개 메뉴: Overview, Goals, Pipelines, Datasets, Ontologies, Indexing, Workflows, Approvals, Chat, Dashboard — `getting-started.md:22-35`. 라우트는 `src/App.tsx:67-98` 와 일치(`/dashboard/governance` 추가 존재).
- 상태: "내부 PoC 프로젝트" — `README.md:112`. "PoC 단계에서는 별도의 로그인 절차가 없으며, 고정 사용자로 동작" — `getting-started.md:7`, `CLAUDE.md:273` (`VITE_SAIP_USER_ID` PoC 고정 사용자).

### 2.2 모듈별 역할 [사실]

| 모듈 | 역할 | 근거 |
|---|---|---|
| Goal | KG 목표·예상 질문 패턴·성공 기준 정의, "LLM Prompt Preview" 로 AI 에 전달되는 형식 표시 | `goals.md:5, 9-15, 57-58` |
| **Pipeline** (= 데이터 가공) | DB·API·파일 Source → Transform → Output 테이블. 저장 시 실행 엔진(Airflow) 에 동기화, 즉시 실행/cron 스케줄 | `pipelines.md:5, 17-19, 26-28` |
| Datasets | 모든 파이프라인 Output 노드가 적재한 결과 테이블 조회(전용) | `datasets.md:5, 12-16, 24` |
| Ontology | Entity Type·Property·Relation(1:1/1:N/N:1/N:M) 모델링, 데이터셋 바인딩(컬럼→Property) | `ontologies.md:5, 9-15, 33-39` |
| Indexing | Entity 데이터를 **OpenSearch** 에 색인(Recreate/Upsert/Incremental), 검색 테스트 | `indexing.md:5, 49-53` |
| Workflow | Trigger(Manual/Schedule cron/Event) → Selector(Python) → Condition(규칙/Python) → Action(HITL 승인·Pre-flight·Execution·Post-exec Email/Slack/Webhook) | `workflows.md:5, 39-43, 47-56, 62-63, 67-92` |
| Agent Panel | Goal/Pipeline/Ontology/Workflow 에디터 공통 AI 어시스턴트, 제안 → Approve/Reject | `agent-panel.md:3, 38-47` |
| Chat / Dashboard | KG 자연어 질의 + 근거(Provenance) 그래프 / 거버넌스·경영 진단 위젯 | `chat.md:5, 22-27`, `dashboard.md:5, 17-20` |

### 2.3 "Factory" 라는 이름의 실체 [사실]

저장소 전체(`src`, `docs`, `deploy`, `scripts`, `e2e`, `dummy-server`)를 대소문자 무시로 검색한 결과, "factory" 는 **제품·모듈 이름으로는 한 번도 쓰이지 않는다.** 등장하는 5곳은 전부 소프트웨어 패턴 용어다.

- `src/lib/api/queryKeys.ts:2` — "TanStack Query Key Factories" (react-query 캐시 키 생성 헬퍼)
- `src/features/workflow/stores/workflowStore.ts:23` — "기본값 팩토리" (`createDefaultDocument`)
- `src/lib/hooks/useSortableList.ts:46` — "Generic comparator factory"
- `src/features/chat/services/provenanceClient.ts:39` — Pydantic `Field(default_factory=list)` 언급
- `src/__tests__/features/pipeline/FileSourceConfigEditor.test.tsx:18` — `vi.mock` 의 factory

**[추정]** 따라서 "SAIP Factory" 는 S2W 쪽에서 쓰는 외부/영업용 명칭이거나, 백엔드 패키지(OpenAPI 설명에 `saip-data`, `saip-pipeline`, `saip_sdk` 가 보임 — `openapi.json` `PreviewColumn.type` 설명, `RunResponse.processing_engine` 설명)를 가리키는 말일 가능성이 높다. 기능적으로 대응하는 UI 모듈은 **Pipelines + Datasets** (사용 가이드가 Transform 탭을 "데이터 가공" 이라 부름 — `pipelines.md:79`), 넓게 잡으면 Workflow 까지다. **이 대응은 확인된 것이 아니므로 SAIP 팀에 확인이 필요하다(5절 Q1).**

### 2.4 런타임·배포 스택 (프런트 저장소에서 읽을 수 있는 범위)

| 구성 | 내용 | 구분 | 근거 |
|---|---|---|---|
| FE | React 18 + TS + Vite, Node ≥20 (`.nvmrc` 22), nginx:1.27-alpine 이미지가 SPA + 리버스 프록시 | 사실 | `CLAUDE.md:3`, `package.json engines`, `deploy/Dockerfile:7,34`, `deploy/PACKAGING.md:30-31` |
| Platform API | `:8093`, FastAPI/Pydantic (422 `HTTPValidationError` 99회, FE 가 "FastAPI 의 422" 처리) | 사실(FastAPI 는 강한 추정) | `src/lib/api/saipClient.ts:92-101`, `openapi.json` |
| builder-agent / decision-agent | `:8082` "SAIP Builder Agent 3.2.0-m03p1", `:8083` "SAIP Decision Agent 0.1.0-m03p1" | 사실 | `src/lib/api/generated/builder-openapi.json`, `agent-openapi.json` `info.title` |
| 파이프라인 실행 엔진 | **Apache Airflow** — dag_id `pipeline__{pipeline_id}`, `dag_registered`/`sync_status`, preview 전용 DAG `pipeline__preview`, 실패 로그 2000자 회수 | 사실 | `src/lib/api/pipelineApi.ts:13`, `types.gen.ts:3475`(DPDData), `6617`(PreviewData), `7427`(TaskErrorData) |
| 워크플로 엔진 | **Temporal** — "Temporal UI URL", "trigger_type=schedule 이면 Temporal Schedule 자동 등록", Temporal Visibility | 사실 | `types.gen.ts:8384`(WorkflowTriggerResponse), `openapi.json` `/definition/workflows` POST 설명, `ApprovalHistoryItem` 설명 |
| 변환 런타임 | Python 3.11 + **RestrictedPython** 샌드박스, pandas/numpy, preview 는 DuckDB/pandas dtype, 결과 Redis 캐시 | 사실 | `types.gen.ts:3264`(CodeValidateRequest), `7268`(SelectorSpec runtime), `6557`(PreviewColumn), `6617`(PreviewData) |
| 적재 DB | **PostgreSQL** — `canonical_<dataset>` 테이블, `postgres_type_to_simple()`, 네임스페이스 `saip:postgres://…`; 운영은 "Azure managed Postgres" | 사실 | `openapi.json` `/pipelines/datasets/{..}` 설명, `types.gen.ts:4697`(EntityVersionResponse), `deploy/PACKAGING.md:156` |
| 검색 | OpenSearch | 사실 | `indexing.md:5` |
| 문서 파서 | Kiwi(한국어), PyMuPDF/pdf2image, HWP 는 Java JAR + LibreOffice | 사실 | `openapi.json` `PUT /pipelines/{pipeline_id}` 설명(허용 확장자 표) |
| 배포 | K8s(helm/kustomize, `saip-ops`), Azure ACR, Nexus 레지스트리, 업로드 파일은 `/mnt/saip-files/pipelines/{id}/` | 사실 | `deploy/PACKAGING.md:4, 37, 83-93`, `deploy/Dockerfile:4`, `openapi.json` `DELETE /pipelines/{pipeline_id}` 설명 |
| 그래프 DB | Neo4j 등 그래프 DB 사용 근거 **없음** — KG 는 PostgreSQL 테이블 + 온톨로지 메타(entity_types) 위에 올라간 것으로 보임 | 추정 | `types.gen.ts:4697, 7126` (dataset_namespace 가 postgres), 저장소 내 neo4j 언급 1건(문맥 불명) |
| 인증 | 모든 엔드포인트 `x-user-id` 헤더 **필수**, `x-tenant-id`·`x-request-id` 선택. 토큰/세션 없음 | 사실 | `openapi.json` 전 경로 parameters, `src/lib/api/saipClient.ts:10, 164` |

---

## 3. 기능표 — Pipeline/데이터 처리 능력

표기: **있음** / **부분** / **없음** / **불명**(프런트 저장소만으로 판단 불가)

### 3.1 데이터 소스

| 기능 | 판정 | 근거 |
|---|---|---|
| RDB 소스 (PostgreSQL / MySQL / MSSQL) | 있음 | `src/lib/api/saip-types.ts:517` `RDBEngine = 'postgresql' \| 'mysql' \| 'mssql'`; `pipelines.md:68`; introspect/query 프록시 `types.gen.ts:6973` |
| RDB 배치(기간 분할) / 증분(커서 timestamp·integer·date) | 있음 | `src/features/pipeline/types/index.ts:141-150`; `pipelines.md:74-75` |
| HTTP API 소스 — GET/POST, 헤더·쿼리·바디, 인증 none/bearer/api_key/basic, 응답 root path | 있음 | `types.gen.ts:2634`(APIFetchRequest), `2590`(APIAuthConfig); FE `types/index.ts:109-128` |
| API 페이지네이션 none / offset / **cursor**(cursor_field, cursor_param, page_size ≤1000) | 있음 | `types.gen.ts:2675`(APIPagination) |
| API 호출 상한 — "SSRF 4-layer, 50 page cap, 10 MB cap, partial success" | 있음(제한) | `openapi.json` `POST /pipelines/sources/api/fetch` 설명; 응답 `truncated_reason: row_limit/byte_cap/page_limit/upstream_error` `types.gen.ts:2605` |
| API 소스의 실행 간 커서 **영속**(마지막 커서부터 재개) | 불명(근거 없음) | 증분 설정은 SQL Source 에만 문서화 `pipelines.md:72-75`; APIPagination 에 상태 저장 필드 없음 |
| 2단 호출(목록 → 항목별 상세) 을 설정만으로 표현 | 없음 | API 노드는 단일 엔드포인트 1개 (`APIFetchRequest` 필드 구성). 우회는 Python 노드 + `requests` |
| 파일 업로드 (CSV·XLSX·PDF·DOCX·PPTX·HWP·HWPX·TXT·JSON) | 있음 | `src/features/pipeline/types/constants.ts:45`; `pipelines.md:70` |
| 메시지 큐 / 스트리밍 소스 | 없음 | 소스 타입은 `dataset \| rdb \| api \| file_upload`(+docx) 만 — `types/index.ts:153`, `openapi.json` `POST /pipelines/` 설명 |

### 3.2 변환 노드

| 기능 | 판정 | 근거 |
|---|---|---|
| 기본 변환 9종 (filter/select/drop/rename/derive/sort/fillNull/cast/sample) | 있음 | `constants.ts:78-86`; `pipelines.md:85-93` |
| 집합·구조 7종 (join/union/deduplicate/aggregate/split/pivot/unpivot) | 있음 | `constants.ts:87-93`; `pipelines.md:99-105` |
| Validate (규칙 위반 시 row/skip/fail) | 있음 | `constants.ts:94`; `pipelines.md:111` |
| Python 변환 `def transform(inputs) -> DataFrame`, pandas/numpy, **requests 허용**, 파일시스템 차단, 입력 최대 16개 | 있음 | `pipelines.md:117-130`; `constants.ts:113`; `openapi.json` `/sandbox/validate-code` 설명(허용 모듈 28개, 50 KB, SEC001~005 블랙리스트) |
| Python 노드 실행 시간 제한 | 있음(노드별 `timeoutSeconds`) | `docs/demo-sources/sksm-workflow/seed-pipeline.json:43` |
| 문서 파싱 (Docs Parse / Auto Parse + VLM) | 있음 | `constants.ts:96-97`; `pipelines.md:136-137` |
| **LLM Extract** — openai_compatible/openrouter, baseUrl·apiKey·model·apiMode, temperature/maxTokens/topP, 프롬프트, 출력 컬럼(6 타입)·keyColumn, format json | 있음 | `types/index.ts:617-669`; `openapi.json` `POST /pipelines/` 설명 "transform / llmExtract" |
| LLM Extract 가 **행마다** 호출 | 없음 | "앞 노드들의 출력을 **전부 모아 LLM 을 1회 호출**… 행 수 = LLM 응답 항목 수" — `openapi.json` `POST /pipelines/` 설명 |
| LLM 응답 JSON Schema 검증 / 실패 행 기록 | 없음 | "출력 포맷 규칙은 플랫폼이 자동 주입", 실패·파싱 오류 시 **0행 반환**, 사유는 Airflow 로그에만 — 같은 설명; FE `types/index.ts:623-624` |
| LLM 모델 버전 고정 | 부분 | `model` 문자열을 사용자가 지정(공급자 모델 ID 그대로) — 고정 여부는 공급자 의존. 별도 버전 핀 개념 없음 |
| 행 단위 LLM 변환(`llmTransform`) | 불명 | OpenAPI 설명이 "기존 `llmTransform`(EPIC-11-M04, 행 텍스트→단일 컬럼)" 을 언급하지만 FE 팔레트 21종(`constants.ts:77-99`)에 없음 → 서버에만 있거나 폐기 |
| LLM 호출 재시도·레이트리밋·토큰/비용 집계 | 없음(확인 범위) | LlmExtract 설정에 해당 필드 없음 (`types/index.ts:626-669`) |
| API 키 보관 | 부분(우려) | "노드 config SSoT(ENV fallback 없음). 로그/스냅샷 자동 마스킹" — `types/index.ts:632`; RDB 비밀번호도 노드 JSON 에 평문 (`seed-pipeline.json:27`) |

### 3.3 출력·스케줄·실행

| 기능 | 판정 | 근거 |
|---|---|---|
| Output → PostgreSQL 테이블, writeMode replace/append/**upsert**(PK 필수) | 있음 | `constants.ts:51-64`; `pipelines.md:146-154`; `openapi.json` `POST /pipelines/` "EPIC-09-M02" |
| 출력 컬럼 타입 | 부분 | 6종만: INTEGER/FLOAT/BOOLEAN/STRING/DATETIME/JSON — `constants.ts:37`. NUMERIC/정밀도 지정 없음 |
| 테이블명 제약 | 있음(제한) | `^[a-z][a-z0-9_]{2,29}$`, **전역 UNIQUE**, 같은 이름이 entity_type·OpenSearch alias `saip_{label}` 로 자동 파생 — `openapi.json` `POST /pipelines/` "Output 노드 label 규칙" |
| 외부(고객) DB 로 직접 적재 | 없음 | Output 노드는 "Dataset Output" 단일 종류 (`pipelines.md:146`); 적재 대상은 SAIP 자체 PG (`canonical_*`) |
| cron 스케줄 + 타임존 (파이프라인 단위) | 있음 | `types.gen.ts:7206`(ScheduleUpdateRequest), `3475`(DPDData.cron/timezone); FE `ScheduleDialog.tsx` |
| 즉시 실행(params, logical_date) / 백필(기간) | 있음 | `types.gen.ts:99, 79`; `saip-types.ts:479-506` |
| 실행 이력·상태 (DAG runs, task instances try_number, task-errors max_tries + 로그 2000자, 노드별 row_count·elapsed·preview·version) | 있음 | `types.gen.ts:139, 7427, 7473, 5755`; `pipelines.md:27, 158-160` |
| 재시도 횟수 **설정** | 불명 | `TaskErrorData.max_tries` 로 Airflow 재시도가 존재함은 보이나(`types.gen.ts:7427`), PipelineCreateRequest/ScheduleUpdateRequest 에 retry 필드 없음 |
| 실패 알림(파이프라인) | 없음 | Overview "주의 필요" 패널만 (`overview.md:36`). Email/Slack/Webhook 은 **Workflow** post-execution 에만 (`workflows.md:87-92`) |
| 멱등성 | 부분 | upsert+PK; 파싱 행 id 결정론적 해시; 같은 파일 재업로드 no-op — `openapi.json` `PreviewData` 설명, `PUT /pipelines/{id}` 설명 §3. API 수집 run 단위 중복 방지 키는 없음 |
| 파이프라인 정의 버전 | 있음(디버그) | `definition_snapshots` sha256 + version 카운터 — `types.gen.ts:4033`; 노드 실행 이력에 "파이프라인 버전" — `5755`. 조회 경로는 `/debug/governance/*` ([DEBUG] 태그) |
| 행 단위 버전 체인·리니지 | 있음(디버그) | `entity_versions`(diff_from_previous, writer_run_id) `types.gen.ts:4697`; `run_entity_edges` `7126`; `/governance/provenance-trail` `798` |
| 프롬프트 버전 관리 | 없음(별도) | 프롬프트는 노드 config 안의 문자열(`types/index.ts:666`). 정의 스냅샷에 묶여 간접 캡처될 뿐(추정) |
| 감사 로그 | 있음(디버그) | `/governance/audit` 필터(user/target/action/status/기간) — `types.gen.ts:678`; 태그 `[DEBUG] Governance` |
| 권한 체크 / 사용자 | 있음(디버그) | `/governance/permissions/check`, `/governance/users` — [DEBUG] 태그; UI 로그인 없음 (`getting-started.md:7`) |
| 멀티테넌트 | 부분/불명 | `x-tenant-id` 선택 헤더만 존재; FE 는 보내지 않음 (`saipClient.ts:163-166`) |
| 집계 읽기 API (대시보드용) | 있음 | `/governance/data-view` — 온톨로지 화이트리스트 기반 GROUP BY, limit ≤10000 — `types.gen.ts:738, 3671` |
| 워크플로 트리거 Manual / Schedule(cron 5·6필드, tz) / Event | 있음 | `types.gen.ts:7657, 7185`; `workflows.md:39-43` |
| 워크플로 HITL 승인·선택지, signal approve/reject | 있음 | `types.gen.ts:8300`; `workflows.md:69-73, 98-114` |
| 워크플로 Action `entity_crud` | 부분(결함 보고) | 2026-06-12 실측 "canonical 테이블에 쓰지 못한다… `execution.code` + `sdk.create_object` 가 유일한 완전 경로" — `docs/demo-sources/sksm-workflow/README.md:63-74` |

---

## 4. HMG GEO 적합성 (a~e)

전제(HMG 쪽 요구): Scope raw API(커서 페이지네이션 run 목록 → 턴별 응답 본문, Bearer 키)를 주기 수집 → 답변 단위 LLM 분석(브랜드 언급·별칭 사전, 언급별 감성, 최종 선택/ACR, 인용 도메인 분류; 고정 모델 버전, JSON 스키마 검증, 결과별 분석 버전 저장) → PostgreSQL 읽기 테이블(명시적 분모 KPI, 주 단위) → Next.js 대시보드. H-Cloud: WAS=Node.js, DB=PostgreSQL 17 만, Python/FastAPI 는 예외 승인 필요.

### a. 외부 REST(Scope raw API) 주기 수집 — **부분**

맞는 부분 [사실]
- Bearer 인증, 커서 페이지네이션(cursor_field/cursor_param/page_size), 응답 root path, cron 스케줄이 API Source 노드 설정으로 존재 — `types.gen.ts:2590, 2675, 7206`.

안 맞는 부분
- **[사실]** 노드 하나 = 엔드포인트 하나. "run 목록 → run 별 턴 본문" 2단 호출은 설정으로 표현 불가. Python 노드에서 `requests` 로 직접 구현해야 함(`pipelines.md:129`) — 이 경우 SAIP 가 제공하는 것은 스케줄과 테이블 적재뿐.
- **[사실]** 수집 프록시 상한 "50 page cap, 10 MB cap"(`openapi.json` `/pipelines/sources/api/fetch`). **[불명]** 이 상한이 DAG 실행 시에도 같은지. 턴 응답 본문(수 KB~수십 KB × 수천 건)이면 바이트 캡에 걸릴 가능성.
- **[불명→사실상 없음]** API 소스의 "마지막 커서부터 재개" 상태 저장이 문서화되지 않음(증분은 SQL Source 전용 — `pipelines.md:72-75`). 주기 수집의 중복/누락 제어는 upsert PK 에 의존해야 함.
- **[사실]** Bearer 키가 노드 config JSON 에 저장됨(`types/index.ts:632` 의 apiKey 정책과 동일 구조). 비밀 관리 정책과 충돌 소지.
- **[사실]** 응답이 중첩 JSON 이면 Cast(JSON)/Derive 로는 평탄화가 제한적 — Python 노드 필요.

### b. 답변 단위 LLM 분석 — **안 맞음** (관리형 LLM Extract 노드 기준; Python 노드로 자체 구현하면 **부분**)

- **[사실]** LLM Extract 는 노드 실행당 **LLM 1회 호출**, 업스트림 행 전체를 한 프롬프트에 직렬화, 출력 행 수 = LLM 응답 항목 수 — `openapi.json` `POST /pipelines/`. 답변 1건 ↔ 분석 1건의 대응이 보장되지 않고, 수백~수천 건 답변이면 컨텍스트에 들어가지 않음.
- **[사실]** JSON Schema 검증 없음(출력 컬럼 이름·6종 타입만), 실패·파싱 오류 시 **0행 반환**, 사유는 Airflow 로그에만 — "stored analysis-version per result" 와 정면 충돌.
- **[사실]** 공급자 openai_compatible / openrouter 만(`types/index.ts:628`). 모델은 문자열 지정 — 버전 고정은 공급자 모델 ID 에 의존, 플랫폼 차원 핀/기록 없음.
- **[사실]** 별칭 사전·감성·ACR·인용 도메인 분류 같은 다단 규칙은 LLM Extract 의 "프롬프트 + 컬럼" 모델로 표현 불가. Python 노드(RestrictedPython, 허용 모듈 28개, 코드 50 KB, 파일시스템 차단, `timeoutSeconds`)에서 `requests` 로 LLM 을 직접 호출하면 가능하지만, 재시도·레이트리밋·비용 집계·부분 실패 기록을 전부 샌드박스 안에서 손수 짜야 하고, 샌드박스 제약(`import` 블랙리스트, dunder 금지)과 충돌할 수 있음 — `openapi.json` `/sandbox/validate-code`.
- **[사실]** 분석 버전 컬럼은 Derive 로 상수 컬럼을 붙이거나 Python 에서 넣을 수 있음. 정의 스냅샷(`definition_snapshots`)이 파이프라인 정의 해시를 남기지만 [DEBUG] 경로임 — `types.gen.ts:4033`.
- **[불명]** 서버에 행 단위 `llmTransform` 이 있다는 언급(EPIC-11-M04)이 있으나 FE 에 노출되지 않음 — 확인 필요(Q5).

### c. PostgreSQL 읽기 테이블 집계 → Next.js 대시보드 — **부분**

맞는 부분 [사실]
- Aggregate(GROUP BY SUM/AVG/COUNT/MIN/MAX/FIRST/LAST), Derive(formula/case), Join, Pivot, 주 단위 cron, Output upsert — `pipelines.md:89, 99-104, 146-152`. "명시적 분모" 는 분자·분모를 Aggregate 로 각각 만들고 Join+Derive 로 비율을 내는 식으로 표현 가능(추정).

안 맞는 부분
- **[사실]** 적재 대상이 **SAIP 자체 PostgreSQL**(`canonical_<label>`, 운영은 Azure managed Postgres — `deploy/PACKAGING.md:156`). HMG 의 PostgreSQL 17 로 쓰는 Output 은 없음. Next.js 가 읽으려면 (1) SAIP DB 에 직접 붙거나 (2) `/governance/data-view`(limit ≤10000, 온톨로지 화이트리스트) 를 호출해야 함 — 둘 다 데이터가 HMG 밖(S2W/Azure) 에 머무는 구조.
- **[사실]** 테이블명 ≤30자·전역 UNIQUE·snake_case, 타입 6종(NUMERIC 없음) — `openapi.json` `POST /pipelines/`, `constants.ts:37`.
- **[사실]** 기본 writeMode replace 는 재실행 시 전체 truncate — 누적 테이블은 append/upsert 로 바꿔야 하며, 그 함정이 데모 문서에 기록됨 — `sksm-workflow/README.md:130-135`.

### d. 운영(재시도·멱등·모니터링·감사·비용) 및 H-Cloud 제약 — **안 맞음**

- **[사실]** SAIP 백엔드 스택 = Python/FastAPI(Platform API) + Airflow + Temporal + Redis + OpenSearch + PostgreSQL + Java/LibreOffice(HWP), K8s/Azure 배포(2.4 절). H-Cloud "WAS=Node.js, DB=PostgreSQL 17 만" 에 들이려면 FastAPI 한 건이 아니라 **스택 전체의 예외**가 필요. 프런트만 Node 빌드(`node:20-alpine`) 이고 런타임은 nginx 다 — `deploy/Dockerfile:7, 34`.
- 재시도: **[사실]** Airflow 재시도 존재는 보임(`try_number/max_tries` — `types.gen.ts:7427`), **[불명]** 설정 경로 없음. LLM 호출 재시도는 없음.
- 멱등: **[사실]** upsert+PK, 파싱 행 결정론적 id — 부분. 수집 run 단위 멱등 키 없음.
- 모니터링: **[사실]** 실행 이력·태스크 오류·노드별 row_count 조회 있음(`types.gen.ts:139, 2003`); 파이프라인 실패 알림 채널 없음(Workflow 의 Email/Slack/Webhook 은 별도 — `workflows.md:87-92`).
- 감사: **[사실]** `/governance/audit` 존재하나 [DEBUG] 태그, 사용자 식별이 평문 헤더 `x-user-id` 하나 — `saipClient.ts:164`.
- 비용 제어: **[없음, 확인 범위]** 토큰·비용 필드 없음.
- 품질 신호: **[사실]** Workflow `entity_crud` no-op 결함(2026-06-12), Python 파일 읽기 계약 "전환 중"(`src/features/pipeline/utils/pythonFileSnippets.ts:4-11`), API 버전 0.9.0, 다수 [DEBUG] 엔드포인트, 로그인 부재 — PoC 단계.

### e. SAIP 도입의 가치 vs 리스크 — **부분** (후방 소비자로 한정할 때)

가치 [사실 기반 추정]
- 브랜드·모델·소스(인용 도메인)·질의 패턴을 Entity Type/Relation 으로 올려 Chat(근거 그래프)·Dashboard(data-view 위젯, "분석" 버튼 → AI 원인 분석)로 탐색하는 경험은 HMG 가 자체 Next.js 로 짧은 기간에 만들기 어려운 차별점 — `chat.md:22-27`, `dashboard.md:28-35`.
- 리니지(run ↔ dataset edge, 행 버전 diff)가 자동으로 남음 — 분석 결과의 출처 추적에 유용 — `types.gen.ts:4697, 7126`.
- HITL 워크플로(승인 대기함·선택지)는 "이상 징후 → 사람 확인" 류 운영에 재사용 가능 — `workflows.md:98-118`.

리스크 [사실]
- **데이터 상주**: 적재 DB·파일·OpenSearch 가 S2W 운영 K8s(Azure) 에 있음(2.4 절). HMG 원문 답변을 외부에 보관하는 문제.
- **추가 의존 체인**: Airflow+Temporal+Redis+OpenSearch+PG+LLM 공급자 — 장애 지점·운영 주체가 늘어남.
- **미검증 워크로드**: 데모가 보험 약관 PDF·SKSM 월 매출 수십 행 수준(`docs/demo-sources/*/README.md`). 수천 건 답변 × 다단 LLM 분석을 돌린 흔적 없음.
- **보안 성숙도**: 고정 사용자·평문 헤더·노드 config 내 키 보관·[DEBUG] 거버넌스 API.
- **종속**: 결과 테이블 이름·타입이 SAIP 규칙(≤30자, 6종 타입)에 묶이고, 온톨로지 entity_type 이름과 테이블명이 1:1 강결합(`openapi.json` `POST /pipelines/` "label 하나에서… 전부 자동 파생").

**권고 [추정]**: HMG GEO v1 의 수집·LLM 분석·집계 코어는 H-Cloud 안의 Node.js 워커 + PostgreSQL 17 로 두고, SAIP 는 (원한다면) 완성된 읽기 테이블을 SQL Source 로 끌어가 온톨로지·Chat·대시보드 데모를 얹는 **선택적 후방 소비자**로만 검토한다. 그 경우에도 어떤 데이터가 S2W 쪽 DB 로 복제되는지(원문 답변 포함 여부) 를 먼저 정해야 한다.

---

## 5. 확인 못 한 것 · SAIP 팀에 물을 질문

### 5.1 프런트 저장소만으로 판단 불가한 것

1. "SAIP Factory" 의 정확한 범위(Pipeline 만인지, Workflow·Datasets 까지인지, 백엔드 패키지명인지).
2. API Source 의 DAG 실행 시 상한(50 page / 10 MB 가 프록시 테스트용인지 런타임에도 적용되는지), 커서 영속 여부, 타임아웃.
3. Airflow 재시도·동시성·SLA 설정 가능 여부와 기본값; 파이프라인 실패 알림 채널.
4. LLM Extract 내부: 배치 분할 여부, 토큰 상한, JSON 파싱 실패 처리, 재시도, 로그 보존 기간; 행 단위 `llmTransform` 의 존재·노출 계획.
5. Python 샌드박스 허용 모듈 28개의 목록, 메모리/CPU 제한, 외부 네트워크 egress 정책(`requests` 허용 범위), 패키지 추가 가능 여부.
6. 비밀(API 키·DB 비밀번호) 저장 방식(암호화? Vault?), 마스킹 범위.
7. 적재 DB 위치·소유(고객 PG 로 직접 쓰기 옵션? 외부 DB Output 로드맵?), 데이터 상주·백업·삭제 정책.
8. 인증·권한 로드맵(SSO, 테넌트 분리 — `x-tenant-id` 의 실제 동작), [DEBUG] 거버넌스 API 의 정식화 시점.
9. 온프레미스/고객 VPC 패키징 가능 여부와 최소 스택(Airflow·Temporal·Redis·OpenSearch 를 뺄 수 있는지), Node.js 만 허용되는 환경에서의 배치 옵션.
10. 라이선스·과금·지원 범위, 운영 주체(S2W 운영형인지 고객 설치형인지).
11. 성능 실적: 최대 처리 행 수, 노드당 실행 시간, LLM 노드 대량 처리 사례.
12. `entity_crud` no-op 결함(2026-06-12 실측)의 수정 여부 등 현재 알려진 결함 목록.

### 5.2 바로 던질 질문(요약)

- Q1. "SAIP Factory" 가 가리키는 모듈/패키지는 무엇인가? 이 저장소의 Pipeline+Datasets 와 같은가?
- Q2. API Source 로 "run 목록(커서) → run 별 턴 본문" 2단 수집을 설정만으로 할 수 있는가? 아니면 Python 노드가 필수인가? 런타임 페이지/바이트 상한과 커서 재개는?
- Q3. LLM Extract 를 **행 단위**로 호출하고, 실패 행을 결과에 남기고(0행 아님), JSON Schema 로 검증하고, 모델 버전·프롬프트 버전을 결과 컬럼에 기록할 수 있는가? `llmTransform` 은 쓸 수 있는가?
- Q4. 결과를 고객(HMG) PostgreSQL 17 로 직접 적재하는 Output 이 있는가? 없다면 로드맵은?
- Q5. 백엔드 스택 전체(FastAPI·Airflow·Temporal·Redis·OpenSearch·PG·Java/LibreOffice)를 고객 환경에 설치해야 하는가? Node.js/PostgreSQL 17 만 허용되는 환경에서 가능한 배치 형태는?
- Q6. 재시도·알림·비용(토큰) 집계·감사 로그를 운영 수준으로 제공하는가? [DEBUG] 태그 API 의 정식화 일정은?
- Q7. API 키·DB 비밀번호가 노드 config 에 저장되는데, 저장 시 암호화·접근 통제는 어떻게 되는가?
- Q8. 데이터 상주: 적재 데이터·업로드 파일·OpenSearch 인덱스가 어디(어느 클라우드·리전)에 있고, 고객 전용 격리가 가능한가?

---

## 부록 — 주요 근거 파일 (절대 경로)

- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\README.md`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\CLAUDE.md`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\docs\user-guide\{index,introduction,getting-started,overview,pipelines,datasets,ontologies,indexing,workflows,agent-panel,chat,dashboard}.md`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\src\lib\api\generated\openapi.json` (SAIP SDK API 0.9.0 스냅샷) 및 `types.gen.ts`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\src\lib\api\{saipClient.ts,pipelineApi.ts,saip-types.ts,queryKeys.ts}`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\src\features\pipeline\types\{index.ts,constants.ts}`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\src\features\pipeline\utils\pythonFileSnippets.ts`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\src\features\workflow\stores\workflowStore.ts`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\deploy\{Dockerfile,PACKAGING.md,nginx\default.conf.template}`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\docs\demo-sources\sksm-workflow\{README.md,seed-pipeline.json}`
- `C:\Users\tae_h\OneDrive\바탕 화면\dev\SAIP\docs\demo-sources\insurance\README.md`
