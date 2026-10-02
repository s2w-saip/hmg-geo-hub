---
type: specification
title: hmg-geo-hub 분석 엔진 Python 통합·분석 버전 관리 설계 초안
description: Scope 분석 파이프라인(scope-analysis lane·코어 lib/measurement-analysis)의 설계만 가져와 허브 백엔드에 Python으로 재구현하고, 프로젝트 단위 분석 버전 바인딩(결정 33~37)을 넣는 설계 초안. 단계 지도, 경계, 실행 구조, 컨텍스트, 데이터 모델, 동치·품질 검증, 버전 전환 절차, 결정 19·25 재정의, 작업 분해를 다룬다.
tags: [hmg-geo-hub, analysis-engine, analysis-version, scope-analysis, python, llm, cutover]
timestamp: 2026-10-02
owner: 개발팀
status: 검토중
---

# hmg-geo-hub 분석 엔진 Python 통합·분석 버전 관리 설계 초안

Scope 분석 엔진의 단계 구성, 프롬프트, 파서, 리졸버, 판정 규칙을 허브 백엔드(Python)에 다시 구현합니다. 분석 결과는 답변 × 분석 버전으로 함께 저장하고, 화면은 단위별(글로벌, 웹사이트, 고객 프로젝트 각각) 바인딩을 따라 rd 한 벌을 읽습니다. 발행된 회차는 발행 당시 버전으로 고정합니다.

- 작성: 기술 리드. 설계만 했고 코드, 리포, stg, 운영 어디에도 쓰지 않았습니다. DB 접속은 0회입니다.
- 근거 코드
  - 허브: 허브 리포(be/int4) = be/int4 `72c260a3`(읽기만).
  - scope-analysis: `origin/main 10dd345`(벤더 핀 코어 `ec6bccb1`). 읽기 전용으로 확인했습니다.
  - Scope 코어: `origin/main 50adc6cc`(2026-10-01 17:12 KST). 같은 방식으로 읽었습니다.
- 표기
  - **(사실)**: 작성 시점에 코드나 문서로 확인한 것입니다.
  - **(추정)**: 계산이나 가정입니다.
  - **(제안)**: 설계안입니다.

---

## 0. 결론 요약

**한 줄 권장안.** 허브 백엔드에 `analysis` 패키지를 새로 둡니다. Scope의 턴 분석 15단계와 답변 접기, ACR 집계를 Python으로 재구현합니다. 결과는 새 스키마 `an`에 `(ana_ver, job)` 키로 저장합니다. v0(Scope 분석 수신분)은 지금의 `ing.*`를 그대로 씁니다. 투영(rd)은 한 벌만 유지하고, 답변마다 `coalesce(회차 고정 버전, 단위 바인딩 버전)`의 결과를 읽습니다. 이 방식은 엔티티 버전 `ecat_ver`가 이미 쓰는 방식과 같습니다(`queries.py:861`).

1. **설계만 가져오는 경계는 선명합니다.** 그대로 옮기는 것은 다음과 같습니다.
   - 프롬프트 문안(바이트 단위, 해시로 고정), 출력 JSON 스키마, 파서의 관용 규칙
   - 정규식 판정(품질, 역할·감성 단서, criteria 5종), 정규화(NFKC, code point 오프셋), 롤업과 ACR 규칙
   - 상수(상한, 재시도 횟수)

   허브 방식으로 바꾸는 것은 데이터 접근, 실행(DB 큐 + 워커), 저장(타입 있는 표 + 콜 원장)입니다. 버리는 것은 티켓, lease, 콜백, 컨텍스트 ref, 내부 토큰, env allowlist 게이트입니다.
2. **버전의 정체성은 이름표가 아니라 내용 해시로 잡습니다.** (사실) Scope의 `ANALYSIS_VERSION = "measurement-analysis-v1"`과 `PROMPT_VERSION = "prompt-v1"`은 고정 상수입니다(`schema.ts:3-6`). 그런데 추출 프롬프트는 2026-08-31에 바뀌었습니다(`ac114be8` 결합 브랜드 분해 문장 추가). 감성 V2, 스탠스, ACR 판정도 9월에 추가됐습니다. 그래서 Scope의 `analysis_version` 문자열은 동작을 식별하지 못합니다. 허브 버전은 엔진 리비전, 태스크별 프롬프트 md5, 모델, 호출 파라미터, 옵션을 한데 묶은 `spec_md5`가 정체성이고, 이름표(`hub-a1` 등)는 별칭일 뿐입니다.
3. **v0은 "살아 있는 외부 버전"입니다.** v0 = Scope가 계속 분석해서 pull로 들어오는 값입니다. 고정된 스냅샷이 아닙니다(Scope 소급 정리, 옵션 변경을 따라 움직입니다). v0에 묶인 단위가 남아 있는 동안에는 "Scope 언급 정리 추종" 문제(job 지문 대조)가 그대로 남습니다. 허브 버전으로 옮긴 단위에서는 이 문제가 사라집니다(9-3절).
4. **결정 37 때문에 전환 시점 이전 이력은 전부 v0입니다.** 전환 시점의 노출 회차는 모두 운영이 보여준 값, 곧 v0입니다. 따라서 결정 19·25(운영 값 예외 없는 재현)는 노출 회차에 대해 분석 버전과 무관하게 그대로 유지됩니다. 결정 36의 "시작 버전"이 실제로 바꾸는 것은 전환 시점 미노출 회차와 새 회차의 버전뿐입니다. 허브 버전으로 시작하는 단위는 추이 화면에 버전 경계가 반드시 생깁니다(9-1절, 남은 결정 Q3).
5. **동치 근거를 바로잡아야 합니다.** (사실) scope-analysis 골든 15건(무판정 13 + ACR 판정 2)에 쓰인 LLM은 녹화본이 아니라 **결정적 스텁**입니다(`analyze-turn.fixtures.ts:9-12`, "녹화 불필요"). 그래서 결정 33 각주의 "녹화된 LLM 응답 재생"에 해당하는 실물은 아직 없습니다. 이 설계는 동치를 3층으로 증명합니다(7절).
   - L1 모듈 차등 퍼징
   - L2 골든 15건 재생
   - L3 실데이터 2,000턴을 TS 오라클로 녹화한 뒤 재생(녹화 비용 추정, 금액 비공개)
6. **읽기 1초 목표 영향은 0입니다.** 조회 SQL은 바뀌지 않습니다. 추가되는 것은 추이 응답의 버전 경계 메타(`rd.cycle` 몇 행)뿐입니다. 바인딩 전환은 미노출 회차 재투영으로 처리하고, 세대가 올라가면서 결과 캐시가 자동 무효화됩니다.
7. **비용(추정).** 산식은 답변당 비용(스탠스 끔·켬) × 셀 수입니다. 글로벌 1회차(약 4.7만 셀)와 전 표면 월 비용을 8-4절에서 추정했습니다(금액 비공개).
8. **분량(추정).** 개발 약 44.5일입니다. 개발자 2~3명이 병렬로 하면 달력 약 4주이고, Scope 카탈로그 내보내기(S-A2)가 블로커입니다. 결정 34(운영 전환 전 교체)와 일정이 충돌할 위험이 상위 1번입니다(10-2절).

**코어/테넌트 판정**

| 구분 | 내용 |
| --- | --- |
| 코어(엔터프라이즈 패키지 공통) | 분석 엔진, 버전 레지스트리, 바인딩, 큐·워커, LLM 클라이언트·원장·예산, 컨텍스트 해시, 그림자 실행, 경계 표시 |
| 테넌트(HMG 전용) | 산업(자동차), 추출 프롬프트의 자동차 예시 분기, 추적 브랜드(현대·기아·제네시스), Scope 카탈로그 이관분, 단위별 바인딩 값, 승격 임계값, 예산 값 |

추출 프롬프트의 비일반 분기는 Hyundai, Kia 예시를 프롬프트 본문에 하드코딩하고 있습니다(`llm.ts:206-234`). 동치를 지키려고 그대로 옮기되, 테넌트 부채로 기록합니다.

---

## 1. 목표·범위·비목표, 결정 요약

### 1-1. 목표

- G1. 허브가 측정 답변(Scope 원문)을 스스로 분석해 언급, 발생, 스탠스, ACR 결과를 만듭니다. Scope 분석 수신 없이도 새 회차 KPI가 나와야 합니다.
- G2. 분석 버전을 레지스트리로 관리하고, 단위(글로벌, 웹사이트, 고객 프로젝트 각각)마다 바인딩합니다. 화면은 바인딩을 따릅니다.
- G3. 발행(노출) 회차는 발행 당시 버전으로 고정합니다. 새 버전은 미발행 회차부터 적용하고, 재해석 경로는 없습니다.
- G4. 새 버전은 숫자로 된 승격 기준(7-5절)을 통과해야 바인딩할 수 있습니다.

### 1-2. 범위

- 턴 분석 15단계(2절 S1~S16 중 S5·S17·S18 제외)와 답변 접기(S15), ACR 집계(S16)의 Python 재구현
- 턴 원문 수집(단일 턴 + ACR 2턴), 분석 컨텍스트(카탈로그) 구성
- `an` 스키마, 버전 레지스트리, 바인딩, 큐, LLM 원장
- 투영 연동, 발행 스탬프, 그림자 실행, 차이 보고
- 관리 API·화면, 추이 경계 표시
- 전환 체크리스트 추가 항목, Scope 요청서 초안 목록

### 1-3. 비목표

- 인용 도메인 LLM 분류(S17). 허브 KPI는 허브 규칙 `category_of`를 씁니다(`seed-3x-common.sql:349-363`). Scope 분류(`ing.citation.scope_category`)는 QA 답변 상세 화면에서만 쓰입니다(사실: `app/features/qa/answers/detail/*`). 남은 결정 Q5에서 확인합니다.
- unknown discovery(S18). LLM 추출이 켜져 있으면 Scope에서도 돌지 않습니다(사실: `store.ts:731-734`).
- Scope 측정 lane, 측정 재요청
- 발행 회차 재해석(결정 37)
- 엔티티 관리 기능 자체(결정 26~30). 이미 설계돼 있고, 여기서는 컨텍스트 연동만 다룹니다.
- TS 코드 이식, lane 배포, 티켓 계약(결정 33)

### 1-4. 결정 요약(정본: `notes/hgh-impl/a4-decisions-batch.md`)

| # | 내용 | 이 설계에서 쓰는 방식 |
| --- | --- | --- |
| 19·25 | 운영 값과 예외 없이 재현 | 노출 회차 기준으로 유지. 미노출·새 회차는 9-1절에서 재정의 |
| 26~30 | 엔티티 직접 관리, 버전 반영, 숨김·제거, 새 엔티티는 경쟁 즉시 + 검토 대기함 | 분석 컨텍스트에 활성 ecat 버전을 반영(5-3절). 투영 오버레이(E1)는 그대로 |
| 31·32 | 동결 층 = 셀 목록 고정 + 바뀐 답변만 보관 | 바인딩 전환은 미노출 회차만 건드리므로 보관 관문이 발동하지 않음(6-6절) |
| 33 | Python 통합, 설계만 가져옴 | 3절 경계 |
| 34 | 운영 전환 전 교체, 19·25 기준 재정의 | 9-1절 |
| 35 | 바인딩 단위 = 프로젝트(글로벌, 웹사이트 각 1), 답변 × 버전 공존 | 6-2·6-3절 |
| 36 | 시작 버전은 단위별 | 9-2절 체크리스트 표 |
| 37 | 노출 회차 고정, 새 버전은 미발행부터, 재해석 없음 | `rd.cycle.ana_ver` 노출 전이 스탬프(6-4절), 경계 표시(8-3절) |

### 1-5. 앞선 탐색 결과의 정정(사실)

| 앞선 기술 | 이번 확인 |
| --- | --- |
| "벤더 핀 64de80d2의 순수 11모듈에는 ACR 집계가 없다" | 로컬 체크아웃 `3d0e397`(핀 64de80d2)은 낡은 상태였습니다. `origin/main 10dd345`의 핀은 `ec6bccb1`이고 `pure/acr-final-choice.ts`를 포함합니다(`ANALYSIS_CORE_PIN.json`, runtime 31파일). 코어 `50adc6cc`의 순수 모듈·`llm.ts`·`core.ts`·`schema.ts`와의 차이는 0입니다(`git diff --stat` 출력 없음). 다만 ACR **집계**(`computePromptRunAcr`)는 lane 밖, 코어 `store.ts:5079`에 있습니다. |
| "골든 13개 = 녹화 LLM 응답으로 바이트 동일 판정" | 15건(13 + `h-acr-final-choice-*` 2)이고, LLM은 결정적 스텁입니다(`analyze-turn.fixtures.ts:9-12`). 픽스처 JSON에는 기대 출력만 있고, 입력과 스텁은 TS 코드 안에 있습니다. |
| 워커 배치 | 허브 워커 docstring은 "ECS 서비스 1개"라고 적혀 있지만(`ingest/worker.py:1`), 인프라 스크립트는 EC2 `m7g.large` 1대입니다(`infra/40-ec2.sh:2`). 어느 쪽이 실제 상태인지 확인되지 않았습니다. |
| 단일 턴 프롬프트 문안 | Scope job 목록의 `MeasurementJob` 스키마에 프롬프트 문안이 없습니다(`openapi/v1.yaml:3154-3165`). 허브도 저장하지 않습니다(`stage.py:90-140`). 프롬프트 문안은 분석 입력이므로 수집 경로가 필요합니다(4-6절, S-A1). |

---

## 2. 분석 엔진 단계 지도

원천은 scope-analysis 벤더 사본(`packages/analysis-core/vendor/lib/...`, 핀 `ec6bccb1`)과 Scope 코어 `50adc6cc`입니다. 아래 파일 경로는 `lib/measurement-analysis/` 기준이고, 오케스트레이션 줄 번호는 `pure/analyze-turn.ts`입니다.

### 2-1. 턴 단위 단계(순서대로)

| # | 단계 | 원천(file:line) | 입력 → 출력 | LLM(태스크·라이브 모델·파라미터) | 프롬프트 위치 | 결정적 규칙의 핵심 |
| --- | --- | --- | --- | --- | --- | --- |
| S0 | 옵션 확정 | 코어 `store.ts:654-735`(resolveAnalysisOptions), `schema.ts:286-339` | env·allowlist·호출 옵션 → `AnalysisOptions` | 없음 | 없음 | 추출이 켜지면 unknown discovery는 강제로 끔(`:731-734`). ACR 판정은 추출이 켜졌을 때만 가능(`:629`) |
| S1 | 답변 품질 | `quality.ts:38-90` | 답변 본문 → `quality_state` 5종 | 없음 | 없음 | 빈 답변, 실패·쓰레기·거절 패턴, 18자 미만 또는 (2줄 이하이고 영숫자 10 미만)이면 trash. `valid_answer`가 아니면 이후 전부 생략(`core.ts:115-132`) |
| S2 | 턴 해시 | `normalize.ts:21`(turnHash), `core.ts:108-112` | (prompt, answer, raw) → `sourceTurnHash` | 없음 | 없음 | 허브에는 raw가 없음 → 3-4절 D1 |
| S3 | 결정적 매칭 | `core.ts:319`(findDeterministicMatches), `:477` 표면 항목, `:538` 정책 게이트, `:689-747` 정규화·압축 색인, `alias-policy.ts:80-218`(정책 4종), `context-redirect.ts:555`(문맥 재지정), `compound-brand.ts:31`, `normalize.ts:5·:212`(NFKC·단어 경계) | 본문 + 카탈로그 → 해결(resolved)·충돌(conflict) 언급, 후보 | 없음 | 없음 | 별칭 정책 default·blocked·case_exact·brand_context. 한 표면이 여러 엔티티에 맞으면 conflict + `reject_surface` 후보(`core.ts:142-177`). 신뢰도는 canonical_exact 1, 그 밖 0.98 |
| S4 | 기계적 의미 판정 | `core.ts:1256-1323`(inferMentionSemantics), `:1337` 순위, `:1349` 표 축, `:1404` descriptors, `:1418-1427` criteria | 언급 줄 → 역할, assertion, 감성, rank, criteria | 없음 | 없음 | 2턴 이상이고 선택 단서가 있으면 final_choice. 순위·표 엔티티 축·추천 단서가 있으면 recommend. 비교 단서가 있으면 compare. 감성은 부정 단서 우선 → 긍정 → 중립. **criteria는 정규식 5종**(price·safety·maintenance·family·performance) |
| S5 | 미지 최종 선택(결정적) | `core.ts:795`, 호출부 `:213-218` | 2턴 본문 → pending 언급·생성 후보 | 없음 | 없음 | LLM 추출이 켜져 있으면 **돌지 않음**(라이브는 켜짐) |
| S6 | LLM 언급 추출 | `llm.ts:206-234`(시스템 프롬프트), `:236-330`(호출), `catalog-projection.ts:203`(known_entities 블록), `pure/llm-mention-layer.ts:64`(병합), `:56`(짧은 별칭 확인 게이트), `pure/surface-identity.ts:196·:256`(원문 span·정체 해석) | 프롬프트 + 본문 + 카탈로그 투영 → 축자 표면 목록 → 결정적 결과와 병합한 언급층·후보 | `extract_mentions` · `openrouter/openai/gpt-5.6-luna` · temp 0, maxTokens 6000, reasoning 256(`:304-314`) · 최대 4회, 백오프 400ms(`:464-470`) | `llm.ts:206` | 축자(번역 금지), 결합 브랜드 분해, 원문 indexOf로 오프셋 계산. 품질이 낮은 표면·문법 조각·일반 범주는 제외(`llm-mention-layer.ts:386-470`) |
| S7 | 보류 언급 해소 | `llm.ts:1896`(프롬프트), `:1924`(호출), `pure/resolver-layer.ts:27` | pending 언급 + 카탈로그 → resolved, ignored, pending 유지 | `resolve_pending_mentions` · luna · temp 0, maxTokens 4000, reasoning 512(`:2017-2022`) | `llm.ts:1896` | 해소 대상 술어 `mention-classify.ts:223` |
| S8 | 제외 문맥·후보 정리 | `pure/filters.ts:16-64` | 언급·후보 → 걸러진 언급·후보 | 없음 | 없음 | 옵션 제외 단서, 대체된 결정적 최종 선택 후보 제거 |
| S9 | 추적 브랜드 증강 | `tracked-brand-augment.ts:308`, 호출부 `:395-430` | 최종 언급 + 추적 표면 → 바닥 보정 언급 | 없음 | 없음 | 추적 브랜드 표면이 본문에 있는데 롤업으로 잡힌 언급이 없을 때만 1건 추가. 기본 켜짐 |
| S10 | ACR 최종 선택 판정 | `pure/acr-final-choice.ts:705`(패스), `:121` 후보, `:430` 검증, `:573` 역할 재부여, `llm.ts:1673`(프롬프트), `:1759`(호출), 버전 `schema.ts:31` | 2턴 최종 언급 → mention_role·assertion 재부여(실패하면 정규식 결과 유지) | `acr_final_choice` · luna · temp 0, maxTokens 800 · 최대 3회(`:1603-1613`) | `llm.ts:1673` | outcome은 single·conditional_multiple·generic_category·none. 어휘 밖 값은 재시도하지 않고 폴백. 같은 계열은 접기(`:325`) |
| S11 | 언급 감성·유형 | V0: `llm.ts:522`(호출, 프롬프트 `:552~`), 조립 `:524-594` / V2: `llm.ts:700`(프롬프트), `:952`(호출), `:781` 줄 파생, `:846` evidence 검증, 조립 `:597-689` / 섀도: `:702-826` | 언급 목록 + 본문 → sentiment 덮어쓰기, `llm_mention_type` | `mention_semantics` · `openrouter/google/gemini-3.1-flash-lite` · V0 maxTokens 4000, V2 10000 · 최대 4회(`:445-452`) | `llm.ts:552`·`:700` | assertion은 덮지 않음(ACR이 assertion에 의존). V2와 섀도가 동시에 켜지면 V2가 우선 |
| S12 | 답변 브랜드 스탠스 | `pure/stance-targets.ts:58·:232`, `llm.ts:1384`(프롬프트), `:1405`(호출), 버전 `schema.ts:18` | 답변 전문 + 대상 브랜드(최대 12) → (턴 × 브랜드) 스탠스, aspects | `answer_brand_stance` · flash-lite · maxTokens 4000 · 최대 4회, 본문 2만자 절단(`:1310-1322`) | `llm.ts:1384` | 실패해도 턴은 죽지 않음(`[]`). evidence 일치 검증 |
| S13 | 오프셋 확정·정렬 | `offsets.ts:115`(code point), `pure/filters.ts:5`, 조립 `:928-933` | 언급 → code point 오프셋, 정렬된 언급 | 없음 | 없음 | 영속 직전에 한 번, 멱등(`offset_basis` 마커) |
| S14 | 롤업 | `pure/rollups.ts`(resolveRollups), `brand-grouping/lineage.ts:25` | 언급 + rels + grouping → product·brand·company 롤업 id | 없음 | 없음 | 쪼개기 규칙(엔티티, 표면) → 묶기 규칙 → 계보(MADE_BY·SUBSIDIARY_OF) 순 |

### 2-2. 답변·prompt_run 단위 단계(코어 전용, lane 밖)

| # | 단계 | 원천(코어 `store.ts` @50adc6cc) | 입력 → 출력 | LLM | 결정적 규칙의 핵심 |
| --- | --- | --- | --- | --- | --- |
| S15 | 답변 접기(job 요약) | `:5939-6054`(buildResolvedAndUnresolved), `:5883`(mentionTypeBucket), 영속 `:1119`·`:3352` | 턴 언급 행 → 엔티티별 mention_count, 감성 4, 유형 5, avg_position, surfaces, rollups, occurrences / 미해결 목록 | 없음 | 유형은 `llm_mention_type` 우선, 없으면 assertion. avg_position은 JS `Math.round(x*100)/100`. resolved이고 entity가 있는 것만 접고, 나머지는 unresolved |
| S16 | ACR 집계 | `:5079`(computePromptRunAcr), `:5262`(buildAcrRows), `:5595`(최종 선택 정규화), `:5656`(판정 single 접기), `:5676`(덜 구체적인 선택 억제), `:3153`(포함 관계) | prompt_run의 반복(iteration) × 턴 품질·언급 → 엔티티 × 레벨 ACR 행, 회차 요약 | 없음 | 반복별 1턴 유효·2턴 유효 수, 선택·조건부·미해결·일반 선택 계수 |
| S17 | 인용 도메인 분류 | `citation-classify.ts:257`(표), `:276`(LLM), `:336`, `store.ts:1317` | 호스트 → 카테고리 | `classify_citation_domain` · flash-lite | **허브 범위 밖**(1-3절) |
| S18 | unknown discovery | `llm.ts:2108` | | `unknown_discovery` | 추출이 켜지면 안 돎 → **버림** |

### 2-3. 허브 Python 모듈과 산출 표 대응(제안)

패키지 `back/analysis/` 아래에 엔진 리비전별로 불변 디렉터리를 둡니다(`engine/r1/`, 4-7절).

| 단계 | 허브 모듈 | 산출 표(6절) | 지금 허브의 v0 대응 표 |
| --- | --- | --- | --- |
| S0 | `analysis/registry.py`(버전 spec → 옵션) | `an.version` | 없음 |
| S1·S2 | `engine/r1/quality.py`, `normalize.py` | `an.turn_result.quality_state`, `turn_hash` | `ing.answer.quality_breakdown` |
| S3 | `engine/r1/match.py`, `alias_policy.py`, `context_redirect.py`, `compound_brand.py`, `surface_match.py` | (중간값) | 없음 |
| S4·S5 | `engine/r1/mention_semantics_regex.py` | `an.mention_occurrence`(role·assertion·criteria·descriptors) | `ing.mention_occurrence` |
| S6 | `engine/r1/llm_extract.py`(프롬프트·파서), `llm_mention_layer.py`, `surface_identity.py`, `catalog_projection.py` | (중간값) + `an.llm_call` | 없음 |
| S7 | `engine/r1/resolver.py` | `an.mention_unresolved`(남은 pending) | 없음(Scope에만 있음) |
| S8·S9 | `engine/r1/filters.py`, `tracked_augment.py` | (중간값) | 없음 |
| S10 | `engine/r1/acr_final_choice.py` | `an.turn_result.meta.acr_final_choice` | 없음 |
| S11 | `engine/r1/semantics.py`(V0·V2) | `an.mention_occurrence.sentiment` 등 | `ing.mention_occurrence.sentiment` |
| S12 | `engine/r1/stance.py`, `stance_targets.py` | `an.answer_stance` | `ing.answer_stance` |
| S13·S14 | `engine/r1/offsets.py`, `rollups.py`, `lineage.py` | `an.mention*` 롤업 열 | `ing.mention.*_rollup_entity_id` |
| 조립 | `engine/r1/analyze_turn.py` | `an.turn_result` | 없음 |
| S15 | `engine/r1/summary.py` | `an.mention`, `an.mention_occurrence`, `an.mention_unresolved` | `ing.mention`, `ing.mention_occurrence` |
| S16 | `engine/r1/acr_rollup.py` | `an.acr_prompt_run`, `an.acr_rollup_row` | `ing.acr_prompt_run`, `ing.acr_rollup_row` |

**설계 원칙(제안).** `an.*` 표는 `ing.*`와 열 모양이 같고 맨 앞 키에 `ana_ver`만 더합니다. 그래야 투영 SQL(`FACT_MR` 등, `queries.py:1050-1090`)이 원천 표 이름만 바꿔 그대로 돕니다. 엔진의 S15 출력도 Scope job 응답(`resolved_mentions`·`brand_stances`·`acr_summary`)과 같은 모양으로 만들고, `stage.job_rows`(`stage.py:90-140`)와 같은 행 변환을 거쳐 씁니다.

---

## 3. "설계만 가져온다"의 경계

### 3-1. 그대로 가져올 것(동치의 대상)

| 항목 | 방식 |
| --- | --- |
| 프롬프트 문안 6종(extract, resolve, semantics V0·V2, stance, acr) + 카탈로그 범례(`catalog-projection.ts:60-68`) | 바이트 단위로 복사하고, 태스크별 md5를 버전 spec에 넣습니다. 동치 시험에서 요청 바디 md5가 같은지 단언합니다(scope-analysis `tests/request-body-golden.test.ts`와 같은 발상) |
| 출력 JSON 스키마(zod) | pydantic 모델로 옮기되 **관용 규칙까지** 같게 합니다. 원소별 파싱, 깨진 원소 제외(`llm.ts:470-475`), `parser_partial`, `malformed_count`, confidence 강등(`:1225-1236`) |
| 정규식·사전 | 품질 패턴, 역할·감성 단서, criteria 5종, 표 헤더 사전, 한국어 문법 조각, 장식 문자, 일반 범주 사전 |
| 정규화·오프셋 | NFKC, `toLocaleLowerCase("und")`(`core.ts:698`), 압축 매칭, 단어 경계, UTF-16 → code point 변환 |
| 판정 순서·상한 | 조립 순서(S1→S14), 상한(STANCE_BRAND_CAP 12, 본문 2만자, ACR 1.2만자, V2 언급 150 등), 태스크별 재시도 횟수 |
| 접기·ACR 규칙 | S15·S16의 계수 규칙과 반올림 |

### 3-2. 허브 방식으로 바꿀 것

| Scope(lane·코어) | 허브 |
| --- | --- |
| 데이터 접근: 코어 DB(`query_runs`·`turn_runs`), 컨텍스트 ref HTTP + 내부 토큰 | `ing.answer`·`ing.turn`(신설), `an.context` 스냅샷(DB), Scope 공개 API만 사용 |
| 실행: 티켓 → lane 큐(lease) → 워커 → 콜백 → 코어 persist | 허브 DB 큐 `an.task`(SKIP LOCKED) → 분석 워커 → 같은 트랜잭션에서 `an.*` 쓰기 → 투영 요청 |
| 옵션: env + 프로젝트 allowlist(`store.ts:520-640`) | 버전 spec에 고정. env로 바꿀 수 없음 |
| 모델: `LLM_TASK_MODEL_*` env, 없으면 haiku로 폴백 | 버전 spec에 태스크별 모델을 고정. **빠지면 기동 거부**(폴백 금지). lane B2 교훈(`worker/llm-pools.ts:205-221`: 폴백으로 단가 17배·오답) |
| 저장: `measurement_mentions` + `extraction_metadata` JSON | 타입 있는 `an.*` + 작은 `meta jsonb` + 콜 원장 `an.llm_call` |
| 로그·관측: 구조화 로그 | `an.llm_call`·`an.turn_result` 카운터 + 감시 1종(4-5절) |
| 후보·자동 시딩·검토 | `an.mention_unresolved` → 엔티티 관리 검토 대기함(`app.ecat_review`) |

### 3-3. 버릴 것

티켓 id(uuid5), lease, deadline, deferred, 콜백·doorbell, 컨텍스트 ref·내부 토큰, `citationHostsToClassify`, 계약 v1 검증, lane 처리량 조율(rolling quota·vCPU 예산), lane 원장 마이그레이션, 직결 풀 페일오버 가드 일부(4-3절 참고), S5(결정적 미지 최종 선택, 기본 꺼짐으로 이식만 하거나 생략), S17, S18.

### 3-4. 의도적으로 다르게 하는 지점(근거)

| ID | 차이 | 근거 |
| --- | --- | --- |
| D1 | `sourceTurnHash`: 허브에는 rawResponse가 없습니다. 같은 함수를 이식하되 운영에서는 raw=None으로 계산하므로 Scope 값과 비교할 수 없습니다 | Scope 공개 API는 raw를 주지 않습니다(`PromptRunTurn`, `v1.yaml:2834-2845`). 동치 시험(L2)에서는 픽스처의 raw를 넣어 같은지 확인합니다 |
| D2 | 컨텍스트를 **회차 시작 시점에 고정**합니다(Scope는 run마다 라이브 카탈로그) | 한 회차 안의 답변이 같은 카탈로그로 분석돼야 회차 내 비교가 성립합니다. 결정 16(회차 시작 시점 활성 유닛 스냅샷)과 같은 발상입니다 |
| D3 | 옵션·모델을 버전 spec에 고정합니다(env 게이트 제거) | 결정 35 바인딩이 의미를 가지려면 버전이 동작을 완전히 정해야 합니다 |
| D4 | luna 태스크(extract·resolve·acr)는 OpenRouter 단일 풀입니다 | OpenAI 직결은 temperature 0을 거부합니다(`llm-pools.ts:336-345`). lane도 같은 결론으로 직결 standby를 뺐습니다(`infra/cdk.json:47`) |
| D5 | 인용 LLM 분류 없음 | 허브 KPI가 쓰지 않습니다(1-3절) |
| D6 | 재시도 백오프 jitter는 `Math.random`이라 시각만 다릅니다. 결과에는 영향이 없습니다 | `llm.ts:454-458` |

### 3-5. 이식 함정 목록(L1 차등 퍼징의 표적)

- JS 정규식과 Python `re`의 차이: `\p{L}`·`u` 플래그(→ `regex` 모듈 필요), `/i`의 비ASCII 대소문자, `\b` 의미, `lastIndex` 상태
- `String.toLowerCase()`는 길이가 바뀔 수 있습니다(터키어 İ, 합자 ﬁ). 원천도 이를 의식합니다(`surface-match.ts:105`). Python `str.lower()`와 결과가 다른 문자가 있습니다
- `toLocaleLowerCase("und")`와 Python `lower()`·`casefold()`의 차이
- UTF-16 인덱스(JS)와 code point 인덱스(Python): 오프셋 계산 전 구간에서 서로게이트 처리가 필요합니다. astral 골든 6건이 이를 겨냥합니다
- `Math.round`(0.5를 +무한대 쪽으로)와 Python `round`(은행가 반올림): avg_position(`store.ts:6048`) 등
- 정렬 안정성과 비교자: JS `sort` 비교자 반환값, `localeCompare` 사용 여부
- JSON 직렬화: 키 순서, 숫자 표기, `undefined` 키 생략과 `None`

---

## 4. 실행 구조

### 4-1. 작업 큐: DB 표 기반(권장)

**근거.** 허브는 이미 DB 표 기반 큐를 운영합니다(`app.judgment_change` 소비, `ingest/worker.py:4-6`). 적재(ing)와 같은 트랜잭션에서 작업을 넣을 수 있어 유실·이중 투입이 없습니다. 규모는 주 수만~수십만 작업으로 PostgreSQL `FOR UPDATE SKIP LOCKED`로 충분합니다(추정). SQS 등 새 인프라는 필요 없습니다.

`an.task`(제안 열)는 다음과 같습니다.

- `task_id`
- `kind`: `analyze_job`·`fetch_turns`·`rollup_acr`·`project`
- `ana_ver`, `run_month`, `job_id`, `prompt_run_id`
- `run_id`: 그림자 실행 id, NULL이면 바인딩 작업
- `context_ver`, `input_fp`(턴 해시 묶음 지문)
- `status`: queued·leased·done·failed·cancelled
- `attempts`, `lease_until`, `next_at`, `error`, `created_at`
- 유일 색인 `(kind, ana_ver, job_id, input_fp) WHERE status IN ('queued','leased')`

**생산자**

1. pull 적재: 답변 본문(`content_hash` 중 본문 부분)이 바뀐 완료 job에 대해 작업을 만듭니다. 대상은 단위 바인딩 버전(허브 버전일 때)과 진행 중인 그림자 실행 버전입니다.
2. 바인딩 전환: 미노출 회차 중 결과가 없는 답변을 채웁니다.
3. 그림자 실행 생성(8절)
4. 실패 재시도

**작업 입도.** `analyze_job` 1건 = job 1개의 모든 턴입니다. 턴 분석은 서로 독립이지만, 접기(S15)가 job 단위라 쓰기 원자성을 job 단위로 맞춥니다. `rollup_acr`은 prompt_run의 모든 반복이 끝난 뒤 1건이고, `fetch_turns`는 ACR 턴 원문을 가져옵니다.

**멱등.** 결과 키는 `(ana_ver, run_month, job_id)`입니다. `an.turn_result.input_fp`와 `context_ver`가 같으면 건너뜁니다. 쓰기는 job 단위로 지운 뒤 다시 넣고(`an.*` 전부), 한 트랜잭션에서 처리합니다.

**투영 연결.** 쓴 job이 투영 대상 버전(회차 고정 버전 또는 바인딩)이면 같은 트랜잭션에서 `app.judgment_change`(kind `analysis`, payload `{ana_ver, answer_keys}`)를 넣습니다. 기존 재투영 경로(`apply.reproject`, `service.py:1-15`)가 소비합니다.

### 4-2. 워커

새 프로세스 `python -m analysis.worker`를 systemd 유닛 1개로 둡니다(제안).

- 루프: 큐 리스(배치 64) → asyncio로 LLM 동시 처리(세마포어 기본 64, 상한 128) → CPU 단계(S3·S4·S13·S15)는 `ProcessPoolExecutor` 2개로 돌립니다.
- 리스 만료는 10분입니다. 워커가 죽으면 다른 워커나 다음 기동이 이어받습니다(재개 = 큐 재조회, 스냅샷 아님).

**기존 EC2 타이머·유닛과의 관계(사실).** 적재 워커는 pull 20분, queue 60초, cycles_tick 20분 주기로 돌고, 감시는 별도 6시간 스케줄입니다(`ingest/worker.py:1-8`). 분석 워커는 이들과 **별도 프로세스**로 둡니다. 이유는 둘입니다.

- LLM 대기 동안 적재 루프를 막지 않아야 합니다.
- 분석 실패가 적재·발행을 죽이지 않아야 합니다.

**배치 위치.** 앱·적재와 같은 `m7g.large`(2 vCPU, 8GB)에 두면 결정적 매칭 CPU가 API 1초 목표를 해칠 수 있습니다(추정). 그래서 별도 소형 인스턴스를 권장합니다(남은 결정 Q8). 같은 박스에 둘 경우 `CPUQuota=50%`, `MemoryMax=3G`로 제한합니다.

### 4-3. LLM 공급자 클라이언트(`analysis/llm/`)

| 항목 | 설계 |
| --- | --- |
| 공급자 | OpenRouter 단일 풀이 기본입니다. flash-lite 태스크(semantics·stance)만 Google 직결 standby를 선택적으로 둡니다(lane `cdk.json:48-54`와 같은 짝). luna 태스크는 직결 금지(D4) |
| 모델 고정 | 버전 spec의 `models{task: id}`만 씁니다. 빠진 태스크가 하나라도 있으면 워커가 기동을 거부합니다(`ANA_MODEL_UNPINNED`). 응답의 실제 모델 slug를 원장에 남기고, spec과 다르면 해당 콜을 실패로 처리합니다 |
| 키 | Secrets Manager의 허브 prod 시크릿(`HMG-GEO-HUB_prod`)에 OpenRouter 키를 추가하고 인스턴스 롤로 읽습니다. argv·로그·예외 문구에 넣지 않습니다(secrets-handling 6). stg는 별도 키와 낮은 상한을 씁니다 |
| 레이트 리밋 | 공급자 단위 토큰 버킷(RPM) + 태스크별 동시성. 429를 받으면 적응형으로 감속합니다. 참고로 lane은 동시 800콜, 분당 620턴을 처리했습니다(사실: `scope-analysis-lane-throughput-cadence-anchor-billing-2026-09-14.md`). 허브는 그 1/6 수준으로 시작합니다 |
| 재시도 | 두 축을 분리합니다. ① 파싱 실패 재시도는 태스크별 Scope 값과 같습니다(extract·semantics·stance 4회, ACR 3회, 백오프 400ms 지수 + jitter). ② 전송 실패(타임아웃·5xx·연결)는 별도 3회입니다. lane 실측 ETIMEDOUT이 16~26%였습니다(사실: `cdk.json:47`). 어휘 밖 출력(ACR outcome 등)은 재시도하지 않고 폴백합니다(원천 규칙) |
| 타임아웃 | 콜당 extract 90초, 그 밖 60초(제안). 턴 전체 상한은 6분입니다 |
| 멱등·재사용 | 콜 키 = sha256(모델, messages, 파라미터). 작업이 재시도될 때 이미 성공한 콜의 응답을 원장에서 재생해 이중 과금을 막습니다 |
| 콜 원장 `an.llm_call` | 콜 키, task, model_slug, ana_ver, job_id, turn_index, attempt, status, 입력·출력 토큰, 비용(단가표 버전과 함께), latency_ms, 응답 본문(zstd)과 보존 만료일, run_id |
| 비용 | OpenRouter `usage` 실비를 우선 씁니다. `total_cost=0`이 오면 단가표로 역산하고(사실: luna A/B 문서에 그 전례), 단가표 버전을 기록합니다 |
| 상한 | ① 환경별 일 상한(prod·stg 별도 값, 금액 비공개)을 넘으면 큐 디스패치를 정지하고 Slack 운영 알림 채널에 등급 2 알림을 보냅니다. ② 그림자 실행별 예산(`an.run.budget_usd`)을 넘으면 그 실행만 정지합니다. ③ 바인딩 작업은 일 상한의 80%에서 등급 1 경고를 보냅니다 |
| 응답 본문 보존 | 30일 뒤 삭제하고, 평가 표본 1%와 그림자 실행분은 영구 보존합니다. 근거: 본문까지 영구 보존하면 월 수 GB 규모입니다(추정) |

### 4-4. 1회차 처리 시간(추정)

- 턴당 LLM 직렬 체인: extract(코어 p50 16.1초, 사실: `cdk.json:34` 주석) + resolve(일부 턴) + semantics(5~10초) + stance(5~10초) + ACR(2턴만) ≈ **30~45초**(추정)
- 처리량 = 동시성 ÷ 턴당 시간. 동시 64이면 약 1.6턴/초, 96이면 약 2.4턴/초입니다(추정)
- 글로벌 1회차 약 4.7만 셀(사실: `wu12/card-snapshot-design.md` 12.5): 동시 96에서 **약 5.5시간**, 동시 128에서 약 4시간입니다(추정). 실제로는 측정이 며칠에 걸쳐 드레인되므로(사실: 메모리 "앵커 vs 측정시각" 27% 날짜 불일치) 증분으로 들어와 피크가 낮습니다
- 그림자 실행(같은 회차 전량): 위와 같은 시간에 바인딩 처리와 동시성을 나눠 씁니다. 그림자 실행 우선순위는 낮게 둡니다

### 4-5. 감시

- `analysis_lag`: 바인딩 버전 결과가 없는 완료 답변 중 24시간 넘은 수(> 0이면 등급 1)
- `analysis_fail_rate`: 최근 6시간 `an.turn_result.status='failed'` 비율(> 2%이면 등급 2)
- `budget_burn`: 일 상한의 80%·100%

모두 기존 감시 스케줄(`python -m ingest.cli watch`, 6시간)에 한 줄씩 추가합니다(자기 감시 사각 방지).

### 4-6. 턴 원문 수집(`ing.turn`, 신설)

| 경우 | 원천(사실) | 허브 처리 |
| --- | --- | --- |
| 단일 턴 답변 | `ing.answer.answer_text`(`DB-v2.sql:281-287`) | `ing.turn(turn_index=1)`에 복사(또는 뷰). 프롬프트 문안은 job 목록에 없습니다(`v1.yaml:3154-3165`) → S-A1 `include=turns` 요청. 그 전까지는 `GET /query/{job}`의 `prompt` 필드(사실: `v1.yaml:2829` 근처 `prompt`)로 보충하고, 실패하면 `ing.prompt.text`로 근사합니다(`source='catalog_text'` 표시, 동치 위험) |
| ACR 2턴(완료 답변의 약 4.4%, 사실: 엔티티 설계 부록 A 27,692/625,977) | `GET /measurements/{prompt_run_id}`의 `iterations[].turns[]`(`turn_index`·`prompt_text`·`answer_text`·`citations`, `v1.yaml:406-425`·`:2834-2861`) | `fetch_turns` 작업을 prompt_run당 1콜로 처리하고 반복별로 `ing.turn`에 씁니다. 결정 37 때문에 새 회차와 그림자 대상만 필요하고, 회차당 ACR prompt_run은 수천 건 이하입니다(추정) |

`ing.turn` 열(제안): `run_month, job_id, turn_index, prompt_text, answer_text, text_md5, source(job·query_api·prompt_run_api·catalog_text), fetched_at`. PK는 `(run_month, job_id, turn_index)`이고 월 파티션입니다.

### 4-7. 엔진 리비전과 다중 버전 실행

발행 회차에 늦게 도착하는 답변은 그 회차의 고정 버전으로 분석해야 합니다(결정 37). 그래서 **은퇴하지 않은 버전은 실행 가능해야 합니다.**

- 엔진 코드는 `engine/r1/`, `engine/r2/`처럼 리비전별 불변 디렉터리로 둡니다. 버전 spec이 리비전을 가리킵니다.
- 리비전 디렉터리는 머지 뒤 수정을 금지합니다. CI 정적 가드로 파일 해시를 고정합니다(scope-analysis `check:analysis-core-pin`과 같은 발상).
- 은퇴 조건: 바인딩 0 ∧ 그 버전으로 고정된 회차의 늦은 답변 창 종료(제안: 회차 마감 + 14일) ∧ 진행 중 그림자 실행 0.
- 공급자 모델 단종으로 강제 은퇴하면, 그 뒤 늦은 답변은 `analysis_state=3`(실패·갭)으로 남기고 등급 1 알림을 보냅니다.

---

## 5. 분석 컨텍스트

### 5-1. Scope 분석이 요구하는 것과 허브가 가진 것

| 컨텍스트 항목(원천) | Scope에서의 출처(사실) | 허브 보유(사실) | 메우는 방법(제안) |
| --- | --- | --- | --- |
| 엔티티(id, type, canonicalName) | `loadOntologyCatalog`(산업 스코프, `store.ts:2170`), 스키마 `schema.ts:256-281` | 관측된 엔티티만 있습니다: `rd.dim_entity` 12,920(엔티티 설계 부록 A), 덮어쓰기는 `app.ecat_entity`. 한 번도 언급되지 않은 카탈로그 엔티티는 없습니다(메모리: "HMG-GEO는 엔티티 카탈로그 미수신") | Scope 카탈로그 **1회 이관**(S-A2) → `an.catalog_base`, 이후 변경분 주기 이관 |
| 별칭(alias, language, matchPolicy, matchForms) | 같은 곳, 정책 4종 `alias-policy.ts:80-218` | 관측 표면(`ing.mention.surfaces`, 브랜드 롤업 24,715종)과 허브 추가·차단 표면(`app.ecat_surface_def`) | 이관 + ecat 추가 표면은 `default` 별칭, 차단 표면은 `blocked` 정책으로 합성 |
| 관계 rels(MADE_BY, SUBSIDIARY_OF, IN_INDUSTRY, 포함 관계) | `loadRelationships`(`store.ts:3128`), ACR 포함 `:3153` | 언급별 롤업 id만 있습니다(`ing.mention.*_rollup_entity_id`) | 이관. ecat `parent_brand_id`는 투영 오버레이로 유지(5-3절) |
| 묶음 규칙 grouping | `loadActiveGrouping`(프로젝트별) | 없음(허브 표시 브랜드 접기는 투영 규칙) | 이관(HMG 프로젝트에 규칙이 있으면) |
| 추적 브랜드 대상 | `loadTrackedBrandAugmentTargets`(`store.ts:2407`, 프로젝트 `tracked_brands`) | `app.brand` 3사, 프로젝트 `brand_code`, own 역할 엔티티(명부 own 10) | 허브 own 엔티티 + 별칭에서 생성. 동치 확인을 위해 Scope 설정과 1회 대조 |
| 산업 {ids, name, source} | `resolveMeasurementIndustryScope`(`store.ts:2560`), 계약 `contracts/v1.ts:173-179` | 없음 | 테넌트 상수(자동차) + 이관한 산업 id |
| 문맥 재지정 규칙 | 코드 상수(`context-redirect.ts`) | 해당 없음 | 엔진 코드로 이식 |
| 옵션·모델 | env·allowlist(`store.ts:497-640`), lane `cdk.json:36-44` | 해당 없음 | 버전 spec. HMG 프로젝트의 라이브 옵션 확인 필요(S-A3) |

**미확인.** Scope 카탈로그의 자동차 산업 스코프 크기(엔티티·별칭 수)는 보지 않았습니다. AE7에서 실측합니다.

### 5-2. contextVersion의 허브 정의(제안)

- 형식: `hub:<unit>:<sha256(정규 JSON{catalog, rels, grouping, trackedAugmentTargets, industry})[:16]>`
- Scope 정의(`contracts/v1.ts:213-217`, 네 원천의 정규 JSON 해시)에 industry를 더한 것입니다. 정규화는 키 정렬과 기본값 키 생략이고, Scope와 같은 바이트 규칙을 씁니다(`schema.ts:262-268` 주석: 정책이 default인 별칭은 키를 싣지 않음).
- `an.context(context_ver PK, unit, base_import_id, ecat_ver, content zstd, content_md5, created_at)`
- **회차 고정**: `an.cycle_context(cyc_key, ana_ver, context_ver)`. 그 회차에서 그 버전의 첫 분석이 일어날 때 그 시점 컨텍스트를 고정하고, 회차가 끝날 때까지 바꾸지 않습니다(D2). 미노출 회차를 다시 분석할 때도 고정값을 씁니다. 바꾸려면 관리자가 "컨텍스트 갱신"을 명시 요청해야 하고, 그 회차 전량이 재분석 대상이 됩니다.

### 5-3. 허브 엔티티 카탈로그(결정 26~30)와의 관계(권장안, 남은 결정 Q4)

| ecat 편집 | 분석 컨텍스트(새 회차부터) | 투영 오버레이(E1, 기존 설계 그대로) |
| --- | --- | --- |
| 허브 엔티티 추가 | 카탈로그에 포함(LLM이 resolved로 잡고 감성·스탠스까지 매김) | 저장 본문 재매칭(`ing.hub_match`)은 과거 미노출 회차용으로 유지 |
| 별칭 추가 | `default` 별칭으로 포함 | 같음 |
| 표면 차단 | `blocked` 정책으로 포함(결정적 매칭이 끊김) | 차단 규칙은 v0 데이터와 회차 고정분에도 적용 |
| 숨김·제거·병합·관계 덮어쓰기 | **반영하지 않음**(분석은 정체성만, 귀속은 투영) | 그대로 |

근거는 셋입니다.

- 분석은 "무엇을 가리키는가", 투영은 "어떻게 셀 것인가"로 층을 나눠야 엔티티 버전 되돌리기가 재분석 없이 됩니다.
- Scope 롤업 해석도 같은 원칙을 씁니다("정체성 해석과 별개의 뒷단계", `pure/rollups.ts` 머리 주석).
- 새 회차부터 컨텍스트에 들어가므로 노출 회차는 바뀌지 않아 결정 37과 충돌하지 않습니다.

**새 엔티티의 흐름(허브가 분석을 소유한 뒤).** 결정 28은 "Scope가 새로 찾은 엔티티 → 경쟁 즉시 반영 + 검토 대기함"이었습니다. 허브 버전 단위에서는 새 엔티티 신호가 두 갈래가 됩니다.

- (a) Scope 카탈로그 변경분 이관: 다음 회차 컨텍스트에 경쟁 역할로 자동 포함하고 검토 대기함에도 넣습니다(결정 28과 같은 동작).
- (b) 허브 분석의 미해결 pending 표면(`an.mention_unresolved`): 엔티티가 없으니 KPI에 들어가지 않습니다. 회차당 빈도 상위를 검토 대기함에 넣습니다.

(b)는 Scope의 자동 시딩·큐레이션을 허브가 대신하지 않는다는 뜻이므로, Scope 카탈로그 성장이 계속 들어오는 (a)가 중요합니다.

---

## 6. 데이터 모델과 버전

DB 패치 번호는 미정입니다(현재 최신 `DB-v2.32-patch.sql`의 다음 번호, 운영 배정). 모든 변경은 추가형이고 기존 열·값은 바꾸지 않습니다.

### 6-1. 분석 버전 레지스트리 `an.version`

| 열 | 뜻 |
| --- | --- |
| `ana_ver int2 PK` | 0 = v0(Scope 수신), 1부터 허브 |
| `label text UNIQUE` | `v0`, `hub-a1`, `hub-a2` 등 |
| `kind` | `scope_pull` 또는 `hub` |
| `engine_rev` | `r1` 등(4-7절 디렉터리) |
| `spec jsonb` | `{engine_rev, prompts{task: md5}, prompt_versions{extract:'prompt-v1', stance:'stance-v2', acr:'acr-final-choice-v2', ...}, parser_rev, models{task: id}, llm_params{task:{temperature, max_tokens, reasoning}}, options(AnalysisOptions 전체), context_policy{source:'scope_import+ecat', pin:'cycle'}, origin{scope_analysis:'10dd345', core_pin:'ec6bccb1', core:'50adc6cc'}}` |
| `spec_md5 bytea UNIQUE` | 정규 JSON md5 = **정체성** |
| `status` | `draft`→`candidate`(골든·재생 통과)→`approved`(그림자 + 제품 책임자 승인)→`retired` |
| `created_by, approved_by, approved_at, retired_at, notes` | 감사 |

- 상태가 `candidate` 이상이면 spec을 바꿀 수 없습니다(트리거, `app.tg_append_only` 재사용).
- v0 행: `kind='scope_pull'`, `spec={source:'scope api pull', include:'result,occurrences,stances'}`. 답변별 Scope 문자열 `ing.answer.analysis_version`은 이미 저장 중입니다(`DB-v2.sql:284`). 다만 1-0절 2번에서 본 것처럼 이 문자열은 동작을 식별하지 못합니다. **v0은 움직이는 버전**임을 화면과 문서에 표시합니다.

### 6-2. ing·an 층의 버전 축

| 표 | 키 | 비고 |
| --- | --- | --- |
| `ing.*`(기존) | 변경 없음 | = v0. "ing = Scope 원본 보존" 원칙 유지(엔티티 설계 2-1절) |
| `ing.turn`(신설) | `(run_month, job_id, turn_index)` | Scope 원문(4-6절), 버전 무관 |
| `an.turn_result` | `(ana_ver, run_month, job_id, turn_index)` | quality_state, turn_hash, context_ver, input_fp, status(completed·partial·failed), meta jsonb(ACR 판정·파서 진단), 콜 수·비용 합, analyzed_at |
| `an.mention` | `(ana_ver, run_month, job_id, ord)` | `ing.mention`과 같은 열 |
| `an.mention_occurrence` | `(ana_ver, run_month, job_id, ord)` | `ing.mention_occurrence`와 같은 열 + sentiment_evidence·reason·source(V2) |
| `an.mention_unresolved` | `(ana_ver, run_month, job_id, ord)` | surface, status(pending·conflict), turn_index, role, assertion, candidate_signature |
| `an.answer_stance` | `(ana_ver, run_month, job_id, turn_index, entity_id)` | `ing.answer_stance`와 같은 열 + aspects jsonb |
| `an.acr_prompt_run`·`an.acr_rollup_row` | `ana_ver` + 기존 키 | `ing.acr_*`와 같은 열 |
| `an.context`·`an.cycle_context`·`an.catalog_base` | 5절 | |
| `an.task`·`an.llm_call`·`an.run`(그림자 실행: 버전, 대상 단위·회차, 예산, 상태, 승인자, 보고서) | 4절·8절 | |

- 파티션: `an.mention*`은 `ing`과 같은 `run_month` 범위 파티션입니다. `ana_ver`는 키 맨 앞이므로 버전 삭제(채택하지 않은 그림자)는 `DELETE ... WHERE ana_ver=<버전>` 청크로 처리합니다. 큰 버전이 쌓이면 LIST(ana_ver) 하위 파티션을 2단계로 검토합니다.
- 기존 `ing.*`에 `ana_ver` 열을 추가하는 안은 기각했습니다. `ing.mention` 1.5GB, `ing.mention_occurrence` 3.75GB(사실: 엔티티 설계 부록 A)의 PK를 재작성해야 하고, "ing = Scope 원본" 원칙과도 섞이기 때문입니다.

### 6-3. 바인딩 `an.binding`(이력·승인)

| 열 | 뜻 |
| --- | --- |
| `binding_id bigint PK` | |
| `unit text` | `global` / `website` / `project:<project_id>`. 웹사이트는 사이트 전체가 한 단위(결정 35). `app.website_site.scope_project_id` 여러 개가 같은 unit으로 묶입니다(`DB-v2.sql:172-174`) |
| `ana_ver int2` | |
| `status` | `requested`→`approved`→`activating`→`active`→`superseded` / `rejected` |
| `requested_by, approved_by, reason, shadow_run_id, created_at, approved_at, activated_at` | |

- 단위당 `active`는 1개입니다(부분 유일 색인). append-only이고 이력은 지우지 않습니다.
- 매핑 함수 `an.unit_of(scope_project_id)`: 글로벌 루트(`app.project.kind='standard_root'`, `DB-v2.sql:114-119`), 웹사이트 사이트, 고객 프로젝트.
- 승인자: `app.rule_param ana_approvers`(기본 제품 책임자). 엔티티 설계의 `ecat_approvers`와 같은 방식입니다.
- `activating` 전제: 그 단위의 미노출 회차 완료 답변 전량에 대해 새 버전 결과가 있어야 합니다(커버리지 100%). 없으면 채움 작업을 넣고 기다립니다. 다 채워지면 미노출 회차 재투영 후 `active`로 바꿉니다.

### 6-4. rd 한 벌과 발행 고정(결정 37)

- `rd.cycle ADD COLUMN ana_ver int2`: NULL = 미노출(바인딩을 따름). **노출 전이 때 그 시점 바인딩으로 고정**합니다. `ecat_ver`와 같은 순간에 같은 방식으로 찍습니다(사실: `DB-v2.17-patch.sql:9`).
  - 글로벌·웹사이트: R08 발행 때(`ingest/cycles/ledger/queries.py:11`)
  - 프로젝트 표면: 마감 즉시 노출(결정 18)이므로 마감 때
- `rd.answer ADD COLUMN ana_ver int2 NOT NULL DEFAULT 0`: 장부 열입니다(조회에 쓰지 않음, 적재·감사·전환 대상 선정용). 동결 보관 비교에서 빼도록 `frz._value_cols` 제외 목록에 추가합니다(사실: 제외 목록 = is_rep·load_id·ecat_ver·rule_ver, `card-snapshot-design.md` 12.11, `DB-v2.21-patch.sql:163`).
- 투영(`FACT_SRC`)에 한 줄을 추가합니다. `ecat_ver`를 고르는 방식(`queries.py:861`)과 같습니다.

  ```
  coalesce(c.ana_ver, an.binding_active(unit_of(rc.scope_project_id))) AS ana_ver
  ```

- `FACT_MR`·occurrence·stance·ACR 원천: `ana_ver=0`이면 `ing.*`, 아니면 `an.* WHERE ana_ver=$v`. **두 갈래 INSERT**로 `_ig_m` 임시표를 채우고 UNION 뷰는 쓰지 않습니다. 파티션 가지치기와 계획을 유지하기 위해서입니다.
- `analysis_state`(`queries.py:896-901`): v0은 지금처럼 `ing.answer.analysis_status`에서 나옵니다. 허브 버전은 `an.turn_result`가 completed·partial이면 0·1(언급 유무), 결과 없음이면 2(갭), failed면 3입니다.
- **R08 발행 게이트**: `ing.cycle.gap_answers`(`DB-v2.sql:335-338`)가 그 회차 바인딩 버전 기준 갭을 세도록 합니다. 그렇지 않으면 허브 분석이 덜 끝난 채 발행돼 갭이 동결됩니다. 발행 뒤 들어오는 늦은 분석은 고정 버전으로 채워지고, 카드 경로는 동결 층이 지킵니다.

### 6-5. 저장 크기(추정)

- 버전 1개의 월 증분: `ing.mention`+`ing.mention_occurrence` 약 5.25GB / 6~9월 약 4개월 → **월 약 1.3GB**(엔티티 설계 부록 A 기반 비례 추정, 9월에 발생 행이 몰려 있어 과대일 수 있음)
- 그림자 1회(글로벌 1회차): 4.7만 / 62.6만 × 5.25GB ≈ **0.4GB**
- `an.llm_call` 메타 행: 답변당 3~5콜 × 월 약 30만 답변 ≈ 월 100만~150만 행(본문 제외 약 300MB)

### 6-6. 결정 32(사실 표 전체 복사 금지)와의 정합

- rd는 한 벌만 유지합니다. 버전 공존은 `an`의 분석 결과(원천 성격)이지 rd 사실 행의 사본이 아닙니다.
- 바인딩 전환은 **미노출 회차만** 재투영합니다. 동결된(노출) 회차 셀의 rd 행을 다시 쓰지 않으므로 보관 관문(`frz.keep_rewrite`)이 발동하지 않습니다. 늦은 답변이 노출 회차에 들어오는 경로는 지금과 같습니다.
- 채택하지 않은 그림자 버전 결과는 결정 후 30일 뒤 지우고, 차이 보고서와 표본 1%만 남깁니다(제안).

### 6-7. 읽기 1초 목표 영향

- 기능 쿼리는 변경이 없습니다(rd 열·표 그대로).
- 추가는 추이·카드 응답 meta의 버전 경계 하나뿐입니다. `rd.cycle`(색인 `cycle_pick_idx`, `DB-v2.sql:431`)에서 창 안 회차의 `ana_ver`를 읽습니다(수 ms, 추정).
- 결과 캐시: 응답 모양이 바뀌므로 빌드 id가 바뀌어 자동으로 새 키가 됩니다. 바인딩 전환 재투영은 세대를 올려 무효화합니다(`app/core/result_cache.py` 머리 주석).

---

## 7. 동치·품질 검증

### 7-1. 4층 구조

| 층 | 무엇을 증명하나 | 방법 | LLM 비용 |
| --- | --- | --- | --- |
| L1 모듈 차등 퍼징 | 결정적 모듈 단위로 TS와 Python 출력이 같음 | 대상: 정규화, 단어 경계, 표면 매칭, 별칭 정책, 문맥 재지정, 결합 브랜드, 오프셋, 품질, criteria·역할 정규식, 롤업, 접기, ACR 집계. 같은 무작위 입력(한·영·중·아랍·astral·표·목록)을 node(TS 원천, 시험 전용)와 Python에 넣고 정규 JSON을 비교합니다. 함정 목록(3-5절)을 시드 사전으로 씁니다 | 0 |
| L2 골든 재생 | 턴 파이프라인 조립이 같음(스텁 LLM) | scope-analysis 골든 15건의 입력, 컨텍스트, 스텁 응답, 기대 출력을 TS 일회성 추출기로 JSON 픽스처화(`analyze-turn.fixtures.ts` → `back/analysis/tests/golden/*.json`) → Python `analyze_turn` 출력 정규 JSON = 기대 출력. 요청 바디 md5도 대조합니다 | 0 |
| L3 실데이터 녹화 재생 | 실제 LLM 응답 분포에서도 파서·병합·판정이 같음 | 허브 stg 데이터에서 2,000턴을 층화 표본으로 뽑습니다(ACR 2턴 300, astral·CJK·아랍어 포함, 국가·엔진 층). 허브 컨텍스트 스냅샷을 TS 모양으로 바꿔 **TS 엔진(scope-analysis core-engine, 로컬 실행)에 녹화 인보커**를 붙여 실행하고 응답·출력을 녹화합니다 → Python이 같은 녹화 응답을 재생해 출력이 같은지 확인합니다 | 금액 비공개(2,000 × 답변당 비용, 추정) |
| L4 그림자 vs v0 | 허브 버전의 실제 품질·KPI 차이 | 미노출 회차 전량을 허브 버전으로 분석하고 같은 답변의 v0(Scope 수신)과 비교합니다. 대조군 = LLM 비결정성 기준선(아래) | 회차 비용(8-4절) |

**메모.** L3의 TS 실행은 **시험 오라클 전용**입니다(배포하지 않고 운영 경로에 없음). 결정 33의 "TS 코드는 쓰지 않음"과 충돌하는지 확인이 필요합니다(남은 결정 Q10). 이 오라클이 없으면 L3를 "Scope가 녹화 응답을 제공"(S-A5)하는 방식으로 대체해야 하는데, Scope는 지금 원응답을 저장하지 않습니다(추정: 영속 대상은 출력 행과 trace id뿐, `analyze-turn.ts:1011-1014`).

### 7-2. L4 비교 지표

- **언급**: 턴별 언급 표면 Jaccard. 엔티티 존재 일치율(자사 3사와 상위 20 경쟁 브랜드, 롤업 기준). 미해결 비율
- **역할·감성**: 같은 표면 매칭 언급에서 final_choice 일치율, 감성 일치율(Scope 게이트③과 같은 단위, 사실: `scope-analysis-lane-quality-gate3-2026-09-13.md`)
- **스탠스**: (턴, 브랜드) 스탠스 일치율, evidence 일치 분포
- **ACR**: prompt_run별 선택 엔티티 일치율
- **인용**: 분석 대상이 아니므로 KPI 차이 **0이어야 함**(인용 계열 단언: 회귀 탐지용)
- **KPI**: 회차 × 국가 × 엔진 셀별 자사 노출률, SoV, 평균 순위, 감성 비율, ACR 선택률. 차이 분포(중앙값, p95)와 표본 수가 작은 셀 표시

### 7-3. 대조군(LLM 비결정성 기준선)

Scope 게이트③ 방식을 그대로 씁니다. 같은 답변을 **v0 엔진 사양 그대로 두 번** 돌린 차이(A1↔A2)가 대조군이고, v0↔허브(A1↔B)가 실험군입니다. 허브에서는 L3 녹화 러너로 같은 표본을 TS 오라클로 무캐시 재실행해 A2를 만듭니다. 게이트③ 실측 A2 비용(100턴)이 기준입니다(사실, 금액 비공개).

### 7-4. 차이의 원인 분해

실험군 차이 = ① LLM 비결정성(대조군) + ② 컨텍스트 차이(허브 스냅샷 vs Scope 라이브 카탈로그) + ③ 옵션·모델 차이(HMG 라이브 옵션 미확인, S-A3) + ④ 이식 결함.

④는 L1~L3가 0으로 만듭니다. ②는 L3 재생에서 허브 컨텍스트와 Scope 컨텍스트 두 벌로 같은 녹화 응답을 재생해 따로 잴 수 있습니다(추정).

### 7-5. 승격 기준안(제안 숫자, 남은 결정 Q6)

| # | 기준 | 임계 |
| --- | --- | --- |
| P1 | L1 퍼징 | 모듈당 10만 입력에서 불일치 0 |
| P2 | L2 골든 | 15/15 정규 JSON 동일, 요청 바디 md5 15/15 동일 |
| P3 | L3 재생 | 2,000/2,000 동일(허브 컨텍스트 기준) |
| P4 | L4 언급 | 턴별 표면 Jaccard 평균 ≥ 대조군 −5pp이고 ≥ 0.95(게이트③과 같은 기준) |
| P5 | L4 역할·감성 | final_choice·감성 일치율 ≥ 대조군 −5pp(단측) |
| P6 | L4 KPI | 표본 ≥ 200인 셀에서 자사 노출률 차이 ≤ 1.0pp, SoV 차이 ≤ 1.0pp, ACR 선택률 차이 ≤ 2.0pp(셀 95% 이상이 충족), 인용 계열 차이 0 |
| P7 | 운영성 | 턴 분석 실패율 ≤ 0.5%(재시도 후), 미분석 0, 답변당 비용이 추정 ±30% 안 |

P4~P6은 "v0과 같아야 한다"가 아니라 "v0 대비 비결정성 수준 이상으로 벗어나지 않는다"는 기준입니다. 의도적으로 동작을 바꾸는 버전(예: 새 프롬프트)은 P4~P6 대신 **차이 보고서 + 제품 책임자 승인**으로 승격합니다(P1~P3, P7은 유지).

---

## 8. 버전 전환 절차, 경계 표시, 비용

### 8-1. 절차

| 단계 | 내용 | 산출·에러 코드 |
| --- | --- | --- |
| ① 등록 | spec 작성 → `an.version(draft)`. CI가 L1·L2·L3를 돌리고 통과하면 `candidate` | `ANA_SPEC_IMMUTABLE`(candidate 이후 수정 시) |
| ② 그림자 실행 요청 | 대상 단위·회차(미노출 회차 우선, 비교용 최근 노출 회차 표본 허용), 예산, 사유 → `an.run(requested)`. 예산 승인은 제품 책임자(유료 실행 = 승인 게이트) | `ANA_RUN_REQUIRES_APPROVAL`(403) |
| ③ 실행 | 바인딩보다 낮은 우선순위로 큐에 넣음. rd에는 쓰지 않음. 예산을 넘으면 정지 | `ANA_BUDGET_EXCEEDED`, 등급 2 알림 |
| ④ 차이 보고 | 7-2절 지표, 대조군, 원인 분해, 표본 문맥(추가·제거 언급 각 20), 비용 실측을 `an.run.report`와 관리 화면에서 확인 | 보고서 md5 |
| ⑤ 승격 | P1~P7 판정표 + 제품 책임자 승인 → `approved` | |
| ⑥ 바인딩 전환 | 단위별 요청 → 제품 책임자 승인 → `activating`(커버리지 100% 채움) → 미노출 회차 재투영 → `active`. 직전 바인딩은 `superseded` | `ANA_BINDING_REQUIRES_APPROVAL`(403), `ANA_VERSION_NOT_APPROVED`(409), `ANA_BINDING_COVERAGE`(409, 강제 활성화 시도 시), `ANA_BINDING_RUNNING`(409, 동시 전환) |
| ⑦ 발행 고정 | 노출 전이 때 `rd.cycle.ana_ver` 스탬프(자동) | |
| ⑧ 되돌리기 | 바인딩을 직전 버전으로 다시 전환(⑥과 같은 흐름, 미노출 회차만). 노출 회차는 되돌리지 않음(결정 37) | |
| ⑨ 감사 | 모든 단계를 `app.ecat_audit_log`와 같은 형식의 `an.audit_log`에 남김(쓰기와 같은 트랜잭션) | |

### 8-2. 권한

- 등록·그림자 요청: admin
- 그림자 예산 승인, 버전 승격, 바인딩 승인: `ana_approvers`(기본 제품 책임자)
- 비관리자는 모든 엔드포인트에서 403

### 8-3. 추이 화면의 버전 경계 표시(제안)

- **API**: 추이·카드·비교 응답 `meta.analysis_marks: [{round_date, ana_ver_label, prev_label}]`. 창 안에서 그 단위의 `rd.cycle.ana_ver`가 바뀌는 첫 회차입니다. 웹사이트 화면은 단위가 하나이므로 경계도 하나입니다. 여러 단위를 합친 화면(있다면)은 `mixed: true`.
- **추이 차트**: 경계 회차에 세로 점선 + 범례 칩 "분석 엔진 변경: hub-a2".
  - 툴팁(ko): "이 회차부터 분석 엔진 hub-a2를 적용했습니다. 이전 회차와의 차이에는 엔진 차이가 포함됩니다."
  - 툴팁(en): "Analysis engine hub-a2 applies from this round. Differences from earlier rounds include engine changes."
- **기간 비교 Δ**: 비교 창이 경계를 넘으면 Δ는 표시하고 경계 아이콘과 주석을 붙입니다(권장, 남은 결정 Q7).
- **보내기(CSV·xlsx)**: 회차 행에 `analysis_version` 열을 추가합니다.
- **관리 화면**: 단위별 바인딩 이력, 회차별 고정 버전 표.

### 8-4. 비용 추정(근거 표기)

| 항목 | 값 | 근거 |
| --- | --- | --- |
| 턴당(extract + resolve + semantics) | (금액 비공개) | 사실(그 표본): 게이트③ A2 100턴 실측 비용 ÷ 턴 수, 209콜 |
| 스탠스 답변당 | (금액 비공개) | 추정: lane `cdk.json` `_decision_stance_model_20260915`(flash-lite 환산) |
| ACR 판정 콜당 | (금액 비공개), ACR 답변 4.4%만 | 추정: lane `cdk.json` `_decision_acr_final_choice_model_20260930` |
| 답변당 합 | (금액 비공개: 스탠스 끔·켬 두 값과 넓은 범위) | 추정. 넓은 범위는 앞선 탐색의 추정 |
| 글로벌 1회차(약 4.7만 셀) | (금액 비공개: 범위와 중앙값) | 셀 수 사실(`card-snapshot-design.md` 12.5) × 답변당 범위. 셀 ≠ 답변(재측정·반복 포함 시 증가) |
| 전 표면 주간 새 셀 약 6.6만 | 주 비용 → 월 비용(금액 비공개) | 추정(12.6 "주당 약 6.6만" × 4.3주) |
| L3 녹화 2,000턴 | (금액 비공개) | 추정 |
| 단가 위험 | luna OpenRouter 50% 할인이 끝나면 luna 태스크 비용 2배 | 사실: `scope-analysis-llm-gpt56-luna-ab-2026-07-31.md` 단가표 |

---

## 9. 운영 값 재현 기준 재정의, 전환 체크리스트, Scope 정리 추종, Scope 요청

### 9-1. 결정 19·25 재정의안(제안)

| 기준 | 대상 | 정의 |
| --- | --- | --- |
| R-A | 전환 시점 **노출 회차**(모든 단위) | 결정 19·25 그대로: 운영 값과 예외 없이 일치. 이 회차들은 모두 v0이고 결정 37로 고정됩니다. 분석 버전과 무관합니다 |
| R-B | 전환 시점 **미노출 회차**(글로벌·웹사이트의 열린·마감 미발행 회차) | 시작 버전 v0 단위는 R-A와 같습니다(T0까지 운영이 계산한 값과 대조). 시작 버전이 허브 버전인 단위는 **재현 대상에서 빠지고**, 승격 기준(7-5절) 통과 + 고지 목록 "분석 버전 경계" 항목으로 대체합니다 |
| R-C | 전환 뒤 **새 회차** | 운영이 꺼지므로 운영 대조 기준이 사라집니다. v0 단위는 "Scope 수신값 + 운영 규칙(현행 프로필)" 투영으로 신구 대조 하네스를 병행 기간 동안 재사용합니다. 허브 단위는 버전 동치(L1~L3), 결정성(같은 녹화 → 같은 출력), 버전별 승격 기준 |

이 정의의 결과를 짚어 둡니다. **어느 단위든 허브 버전으로 시작하면 추이에 T0 경계가 생깁니다.** 전환 직전에 한 번만 과거를 허브 버전으로 재해석해 경계를 없애는 안은 결정 37("재해석 경로 없음")과 R-A(운영 값 재현)를 동시에 깹니다. 그래서 권장하지 않습니다(남은 결정 Q3).

### 9-2. 전환 체크리스트 추가 항목(`cutover-checklist.md`에 넣을 것)

1. **단위별 시작 버전 표**: 단위, 시작 버전(v0 또는 허브 라벨), 근거(그림자 보고서 id), 승인자·일시. 글로벌 1, 웹사이트 1, 이관 대상 고객 프로젝트 전부(데모 프로젝트는 결정 9로 제외).
2. `an` 패치 적용 → 레지스트리에 v0·`hub-a1` 등록 → 모든 단위 바인딩을 시작 버전으로 `active` 생성(감사 행 포함).
3. Scope 카탈로그 이관 스냅샷 id, 컨텍스트 해시, 자동차 산업 스코프 크기 기록.
4. LLM 키를 prod 시크릿에 넣고, 일 상한 값 설정, Slack 운영 알림 채널 등급 2 도달 실증(강제 초과 픽스처). stg는 낮은 상한과 별도 키.
5. 턴 원문 수집 경로 확인: ACR prompt_run API 응답 표본 10건, 단일 턴 프롬프트 문안 출처 비율(`ing.turn.source`).
6. R08 갭 판정이 바인딩 버전 기준인지 시험(허브 단위 회차에서 미분석 답변이 있으면 발행 보류).
7. 허브 시작 단위는 그림자 보고서(P1~P7 판정표)를 첨부.
8. v0 단위가 남아 있는 동안 "Scope 쪽 언급 정리 추종"(job 지문 대조)을 유지. 마지막 v0 단위가 이탈하는 날 Scope 분석 필드 수신 중단 시점을 결정(9-3절).
9. 고지 목록(A4)에 "분석 버전 경계·의미" 항목 추가(허브 시작 단위가 있을 때).
10. 분석 워커 유닛 기동 순서: 패치 → 백엔드 배포 → 컨텍스트 이관 → 분석 워커 기동(바인딩 작업만) → 적재 워커. 분석 워커가 적재 워커보다 먼저 떠야 첫 pull분이 큐에 바로 잡힙니다.

### 9-3. "Scope 쪽 언급 정리 추종" 문제는 이렇게 바뀝니다

- **허브 버전 단위**: 문제가 사라집니다. 허브 결과는 허브가 다시 분석하기 전에는 바뀌지 않습니다. 대신 Scope가 하던 별칭 위생(일반어 별칭 정리, N·Epit·Plus·Modern 류)을 허브가 직접 해야 합니다. 경로는 ecat 차단 표면 → 다음 회차 컨텍스트 `blocked`(5-3절) + 엔티티 관리 린트(E3)이고, 린트 대상을 분석 컨텍스트까지 넓힙니다.
- **v0 단위**: 지금과 같습니다. job 지문 대조와 Scope 변경 신호 요청(기존)이 필요합니다.
- **모든 단위가 v0을 떠난 뒤**: pull에서 분석 필드(`include=occurrences,stances`) 수신을 멈추고 `ing.*` 분석 계열을 그 시점 값으로 동결하도록 제안합니다. 그 뒤 Scope 소급 정리는 v0 이력(노출 회차)을 건드리지 않습니다. 카드 경로 밖의 읽기도 보호됩니다(지금은 카드 경로만 동결 층이 보호).

### 9-4. Scope에 요청할 것(요청서 초안은 AE0 산출물, `docs/scope-requests/`)

| ID | 요청 | 용도 | 블로커 여부 |
| --- | --- | --- | --- |
| S-A1 | job 목록 `include=turns`(턴별 `turn_index`, `prompt_text`, `answer_text`), 단일 턴·ACR 공통 | 분석 입력 원문(특히 단일 턴 프롬프트 문안, 사실: 현재 job 목록에 없음) | 아님(대안: `/query/{job}`·`/measurements/{prompt_run_id}` 개별 호출. 호출 수가 늘고 문안 근사 위험) |
| S-A2 | HMG 워크스페이스 산업 스코프 카탈로그 내보내기(엔티티, 별칭: 언어·match_policy·match_forms, relationships, grouping, tracked_brands, industry ids). 1회 전량 + 변경분(주기) | 분석 컨텍스트(5절) | **블로커**(AE7) |
| S-A3 | HMG 프로젝트별 라이브 분석 옵션·모델 명세(semantics V2·섀도 allowlist 포함 여부, stance, ACR 판정 allowlist, short alias gate, tracked augment, 태스크 모델) | `hub-a1` spec = 현행 동작 | **블로커**(`hub-a1` 등록) |
| S-A4 | v0 지속 약속(HMG 워크스페이스 분석 계속, 종료 예고 기간) + 기존 요청 "job 단위 언급 개정 번호" | v0 바인딩 단위 유지 | 아님(전제 조건) |
| S-A5 | (선택) 분석 LLM 원응답 표본 제공 | L3 대체 경로(TS 오라클을 허용하지 않을 때) | 아님 |
| S-A6 | `GET /measurements/{prompt_run_id}`의 HMG API 키 레이트 리밋·과거 prompt_run(미러 시드분) 서빙 범위 확인 | ACR 턴 원문 | 아님(문서상 존재는 사실: `v1.yaml:406-425`) |

Scope 계약 협상과 확정은 제품 책임자의 몫입니다. 이 설계의 산출물은 요청서 초안까지입니다.

---

## 10. 워크유닛 분해, 위험, 남은 결정

### 10-1. 워크유닛(OpenSpec change 1개 = 유닛 1개, 스펙 승인 뒤 착수)

| WU | 담당 | 내용 | 수용 기준(숫자·에러 코드·계측) | 인일(추정) | 의존 |
| --- | --- | --- | --- | --- | --- |
| AE0 | 기술 리드 | OpenSpec change 분해, 코어/테넌트 기록, 요청서 S-A1~S-A6 초안 | change 13건, 요청서 6건(초안) | 1.5 | 없음 |
| AE1 | 데이터 담당 | 동치 하네스: 골든 15건 JSON 추출기(TS 일회성), L1 차등 퍼징 러너(node + Python), L3 녹화·재생 러너 | 픽스처 15건 생성, 퍼저가 함정 목록(3-5절) 변이 7종을 전부 잡음(변이 시험), 녹화 러너 100턴 시운전 비용 기록 | 3 | AE0 |
| AE2 | 데이터 담당 | DB 패치: `an` 스키마 전부, `ing.turn`, `rd.cycle.ana_ver`·`rd.answer.ana_ver`, `frz._value_cols` 제외 추가, 레지스트리·바인딩·큐·원장·감사 | 합본 적용 후 pg_dump 차이 = 패치 객체만, 기존 시험 전부 통과, v0 레지스트리 1행, 바인딩 부분 유일 색인 위반 시 `ANA_BINDING_RUNNING` | 2 | AE0 |
| AE3 | 데이터 담당 | 결정적 모듈 이식(S1~S4, S8, S9, S13, S14 + S5 기본 꺼짐) | L1 모듈당 10만 입력 불일치 0, 골든 a·g(결정적) 4건 동일 | 7 | AE1·AE2 |
| AE4 | 데이터 담당 | LLM 단계 이식(S6, S7, S10~S12, 파서) + `analyze_turn` 조립 | P2 15/15, 요청 바디 md5 15/15, P3 2,000/2,000 | 7 | AE3·AE6 |
| AE5 | 데이터 담당 | 접기(S15)·ACR 집계(S16) | L1(접기·ACR) 불일치 0, 같은 녹화 입력에서 Scope job 응답 모양(`resolved_mentions`·`acr_summary`) 동일 | 3 | AE3 |
| AE6 | 데이터 담당 | LLM 클라이언트: 풀, 재시도 2축, 타임아웃, 콜 키 재사용, 원장, 일 상한·실행 예산, 시크릿 | 모델 누락 시 기동 거부(`ANA_MODEL_UNPINNED`), 녹화 fetch로 429·타임아웃·깨진 JSON 시나리오 통과, 재시도 중복 과금 0, 상한 초과 시 디스패치 0 + Slack 등급 2 도달 실증 | 3 | AE2 |
| AE7 | 데이터 담당 | 컨텍스트: Scope 카탈로그 이관 적재기, ecat 합성, 해시, 회차 고정 | 같은 입력이면 해시 동일(멱등), ecat 추가·차단이 별칭·정책으로 반영(픽스처), 자동차 스코프 크기 실측 기록 | 3 | AE2, **S-A2** |
| AE8 | 데이터 담당 | 큐·워커·턴 원문 수집·pull 연동·R08 갭 연동·감시 3종 | pull 1회 뒤 대상 job 전부 큐에 들어감(누락 0), 워커 강제 종료 후 재기동 시 이중 쓰기 0, ACR 턴 수집 성공률 기록, R08이 바인딩 갭에서 보류 | 3.5 | AE2·AE6 |
| AE9 | 데이터 담당 | 투영 연동: `FACT_SRC` 버전 분기, 두 갈래 원천, `analysis_state`, 바인딩 전환 재투영, 노출 스탬프 | v0만 있을 때 전량 재투영 결과 = 현행 rd leaf md5 차이 0, 전환 뒤 노출 회차 rd md5 불변, 미노출 회차 `rd.answer.ana_ver` 전수 = 새 버전 | 3 | AE2·AE5 |
| AE10 | 데이터 담당 | 그림자 실행·차이 보고서(7-2~7-4절) | stg 미노출 회차 1개 실행 보고서 생성, 인용 계열 차이 0 단언, 예산 정지 시험 | 2.5 | AE4~AE9 |
| AE11 | BFF 담당 | 관리 API: 버전 등록·조회, 그림자 요청·예산 승인, 승격, 바인딩 요청·승인·되돌리기, 감사 | 비관리자 403 전 엔드포인트, 승인자 외 승인 403 `ANA_BINDING_REQUIRES_APPROVAL`, 미승인 버전 바인딩 409 `ANA_VERSION_NOT_APPROVED`, 감사 누락 0 | 2 | AE2 |
| AE12 | 화면 담당 | 버전·바인딩 관리 화면, 그림자 보고서 화면, 추이·카드 경계 표시, 보내기 열, ko/en | 기본 창 첫 응답 p50 ≤ 1s 유지(전후 3회), Playwright ≤ 6회로 등록 → 그림자 → 승격 → 바인딩 → 경계 표시 흐름 통과, i18n 누락 0 | 3.5 | AE11 |
| AE13 | delivery | LLM 외부 송출 보안 메모(H-Cloud·온프렘 이전 시 송출 경로, 보내는 데이터 범위) | 메모 1건 | 0.5 | AE0 |
| V | 독립 검증 | 렌즈: 데이터 정확성(AE3~AE5·AE9: L1~L3 독립 재실행, v0 재투영 md5 0), 권한 레드팀(AE11), UI 실측(AE12) | 판정표 | 별도 | 각 WU |

- 합계 약 **44.5 인일**입니다.
- 순서: AE0 → AE2 → (AE1·AE6·AE7 병렬) → AE3 → (AE4·AE5) → AE8·AE9 → AE10 → AE11·AE12, AE13은 병렬입니다.
- 달력은 약 4주(개발자 2~3명)입니다(추정).
- 엔티티 관리 E1(투영 `_ig_meff`)과 같은 `queries.py` 절을 바꾸므로 **E1 머지 뒤 AE9 착수**입니다.

### 10-2. 위험 상위

1. **전환 일정 충돌.** 결정 34(전환 전 교체) + 44.5 인일 + S-A2 블로커. 완화: T0에 엔진은 통합·가동하되 모든 단위를 v0으로 시작하고 그림자만 돌리면(Q2 권장), T0이 승격에 묶이지 않습니다.
2. **동치의 착시.** 골든 15건은 합성 카탈로그·스텁이라 범위가 좁습니다. 실데이터 차이는 컨텍스트, 옵션, 프롬프트 문안 출처에서 납니다. 완화: L3 실데이터 재생, 원인 분해(7-4절), S-A3로 옵션 확정.
3. **v0이 움직임.** Scope 버전 문자열은 동작을 식별하지 못합니다(1-0절 2). v0 단위의 새 회차 값은 Scope 변경에 따라 조용히 바뀝니다. 완화: v0 단위의 지문 대조 유지, 이른 이탈 계획.
4. **별칭 위생 책임 이전.** 허브 단위는 Scope 큐레이션의 혜택을 변경분 이관으로만 받습니다. 완화: 린트 대상 확대, 미해결 표면 상위를 검토 대기함에 넣기.
5. **고객 혼란.** 추이에 경계가 생기고 Δ가 엔진 차이를 포함합니다. 완화: 경계 표시, 고지, 보내기 열.
6. **늦은 답변과 은퇴 버전.** 모델 단종 시 고정 회차의 늦은 답변이 갭이 됩니다. 완화: 은퇴 조건, 알림(4-7절).
7. **비용 변동.** luna 할인 종료 시 2배, 재시도 폭주. 완화: 일 상한, 실행 예산, 콜 재사용.
8. **외부 송출.** HMG 전용 시스템이 측정 답변 원문을 LLM 공급자로 보냅니다. Scope도 이미 보내는 데이터이지만, 허브 보안 심사·H-Cloud 이전 때 송출 경로가 쟁점이 될 수 있습니다(AE13).
9. **박스 자원.** 앱과 같은 2 vCPU에서 CPU 단계가 1초 목표를 해칠 수 있습니다(Q8).

### 10-3. 제품 책임자에게 물을 남은 결정

**Q1. v0의 정의**
- (권장) 살아 있는 v0: Scope 분석 수신을 계속하고, 마지막 v0 단위가 이탈할 때 수신을 멈추고 동결합니다.
- 동결 v0: T0에 이관분으로 고정하고, 전환 뒤 새 회차는 모든 단위를 허브 버전으로 강제합니다.

**Q2. T0 시작 버전의 기본값(결정 36의 운용)**
- (권장) 모든 단위 v0으로 시작하고, 허브 버전은 그림자로 돌립니다. 승격 기준을 통과한 단위부터 다음 미발행 회차에 전환합니다.
- 글로벌·웹사이트는 v0, 고객 프로젝트는 허브 버전으로 시작합니다.
- 모든 단위를 허브 버전으로 시작합니다(T0이 승격에 묶임).

**Q3. 전환 직전 1회 이력 재해석 예외**
- (권장) 두지 않습니다. 결정 37 그대로이고, 허브 시작 단위는 T0 경계를 감수합니다.
- 전환 직전 1회만 과거 회차를 허브 버전으로 재해석해 경계를 없앱니다. 운영 값 재현(R-A)을 포기합니다.

**Q4. 분석 컨텍스트에 엔티티 버전(ecat)을 반영하는 방식**
- (권장) 회차 시작 시점 스냅샷: Scope 이관 기반 + 활성 ecat의 허브 엔티티·추가·차단 표면. 숨김·제거·병합·관계는 투영에서만.
- 컨텍스트를 분석 버전에 고정합니다. 카탈로그를 바꾸려면 새 분석 버전을 만들어야 합니다(재현성 최고, 운영 부담 큼).
- 컨텍스트에 ecat을 반영하지 않습니다(투영 오버레이와 재매칭만, 허브 엔티티는 감성 미상).

**Q5. 인용 도메인 LLM 분류**
- (권장) 허브 엔진 범위 밖에 둡니다. 허브 `category_of` 유지, QA 상세의 Scope 분류는 v0 데이터에서만.
- 이식합니다(QA 상세의 Scope 분류 유지 목적, 비용 소폭 증가).

**Q6. 승격 기준 숫자(7-5절 P1~P7)**
- (권장) 제안값 그대로 승인합니다.
- KPI 임계(P6)를 0.5pp로 강화합니다(그림자 표본 증가 필요).
- 수정값을 지정합니다.

**Q7. 기간 비교 Δ가 버전 경계를 넘을 때**
- (권장) 값은 표시하고 경계 아이콘과 주석을 붙입니다.
- '―'로 억제합니다.
- 표시 변화 없이 그대로 둡니다.

**Q8. 분석 워커 배치**
- (권장) 별도 소형 인스턴스(앱 박스 2 vCPU 보호, 추가 월 비용 있음, 금액 비공개).
- 같은 EC2에 별도 유닛(CPU·메모리 쿼터).

**Q9. 비용 상한**
- (권장) prod·stg 환경별 일 상한(금액 비공개). 초과 시 큐를 정지하고 Slack 운영 알림 채널에 등급 2. 그림자 실행은 건별 예산 승인.
- 월 상한만 둡니다.
- 상한을 두지 않습니다.

**Q10. TS 원천을 시험 오라클로 쓰는 것(L1 퍼징·L3 녹화, 배포·운영 경로 없음)**
- (권장) 허용합니다(결정 33은 운영 코드 금지로 해석).
- 불허합니다. L1은 수작업 벡터, L3는 S-A5(Scope 원응답 표본)에 의존합니다.

---

## 부록 A. 코드 앵커

### A-1. 허브(허브 리포(be/int4) @ `72c260a3`)

| 대상 | 위치 |
| --- | --- |
| `app.project`(standard_root·customer, scope_project_id) | `back/db/DB-v2.sql:114-119` |
| `app.website_site` | `back/db/DB-v2.sql:172-174` |
| `ing.sync_cursor`·`ing.load`·`ing.run` | `back/db/DB-v2.sql:262-279` |
| `ing.answer`(analysis_version, answer_text, content_hash) | `back/db/DB-v2.sql:281-287` |
| `ing.mention` | `back/db/DB-v2.sql:290-297` |
| `ing.mention_occurrence`(turn_index) | `back/db/DB-v2.sql:298-301` |
| `ing.answer_stance`(PK에 turn_index) | `back/db/DB-v2.sql:302-305` |
| `ing.citation`(scope_category) | `back/db/DB-v2.sql:306-307` |
| `ing.acr_prompt_run`·`ing.acr_rollup_row` | `back/db/DB-v2.sql:308-321` |
| `ing.cycle`(gap_answers, analysis_done_ratio) | `back/db/DB-v2.sql:329-346` |
| `rd.dim_entity`·`rd.dim_source` | `back/db/DB-v2.sql:406-416` |
| `rd.cycle` | `back/db/DB-v2.sql:426-432` |
| `rd.answer`(analysis_state, 장부 열) | `back/db/DB-v2.sql:455-476` |
| `ecat_ver` 열(rd.answer·rd.cycle), ecat 표 | `back/db/DB-v2.17-patch.sql:8-9`, `:87-101` |
| `frz._value_cols` | `back/db/DB-v2.21-patch.sql:163` |
| Scope 응답 매핑·content_hash·job_rows | `back/ingest/pull/sync/stage.py:1-10`, `:76-87`, `:90-140` |
| Scope 원천 어댑터(include, 엔드포인트) | `back/ingest/pull/sync/source.py:1-11`, `:47-127` |
| 투영 서비스(delete-then-insert) | `back/ingest/project/apply/service.py:1-15` |
| `DIM_SOURCE`(허브 인용 카테고리) | `back/ingest/project/apply/queries.py:686-699` |
| `FACT_SRC`(ecat_ver 선택식) | `back/ingest/project/apply/queries.py:837-870`(선택식 `:861`) |
| `analysis_state` 산식 | `back/ingest/project/apply/queries.py:896-901` |
| `ECAT_IN`·`FACT_MR` | `back/ingest/project/apply/queries.py:1039-1047`, `:1050-1090` |
| `category_of` | `back/migration/seed/seed-3x-common.sql:349-363` |
| R08 발행 게이트 | `back/ingest/cycles/ledger/queries.py:11`, `:152-164` |
| 동결 생성·재생성 | `back/ingest/frz/freeze.py:37`, `:57` |
| 현행 프로필 스위치 | `back/app/core/profile.py:1-14` |
| 결과 캐시 | `back/app/core/result_cache.py:1-30` |
| 적재 워커 주기 | `back/ingest/worker.py:1-8` |
| EC2 사양 | `infra/40-ec2.sh:2` |

### A-2. scope-analysis(`origin/main 10dd345`, 벤더 핀 `ec6bccb1`, 경로 접두 `packages/analysis-core/vendor/lib/`)

| 대상 | 위치 |
| --- | --- |
| 핀 | `packages/analysis-core/ANALYSIS_CORE_PIN.json`(coreSha ec6bccb1, runtime 31) |
| 버전 상수 | `measurement-analysis/schema.ts:3-6`, `:18`, `:31` |
| 카탈로그 엔티티 스키마·옵션 | `measurement-analysis/schema.ts:256-281`, `:286-339` |
| 턴 조립 | `measurement-analysis/pure/analyze-turn.ts:157-216`(S1~S3), `:227-350`(S6·S7), `:357-430`(S8·S9), `:440-463`(S10), `:471-826`(S11), `:837-921`(S12), `:928-1014`(S13·메타) |
| 품질 | `measurement-analysis/quality.ts:38-90` |
| 결정적 매칭·의미 판정 | `measurement-analysis/core.ts:103-298`, `:319`, `:477`, `:538`, `:689-747`, `:795`, `:1256-1323`, `:1418-1427` |
| 별칭 정책·문맥 재지정·결합 브랜드 | `measurement-analysis/alias-policy.ts:80-218`, `context-redirect.ts:555`, `compound-brand.ts:31` |
| 정규화·오프셋·표면 매칭 | `measurement-analysis/normalize.ts:5`, `:21`, `:212`, `offsets.ts:115`, `surface-match.ts:56·:93·:105` |
| 프롬프트·호출 | `measurement-analysis/llm.ts:206`(extract), `:236-330`, `:445-470`(재시도 상수), `:522`·`:552`(semantics V0), `:700`·`:952`(V2), `:1310-1322`(스탠스 상한), `:1384`·`:1405`(stance), `:1603-1613`(ACR 상수), `:1673`·`:1759`(ACR), `:1896`·`:1924`(resolve), `:2108`(unknown) |
| 순수 계층 | `pure/llm-mention-layer.ts:56·:64`, `pure/surface-identity.ts:196·:256`, `pure/resolver-layer.ts:27`, `pure/filters.ts:5-64`, `pure/acr-final-choice.ts:121·:325·:430·:573·:705`, `pure/stance-targets.ts:58·:232`, `pure/rollups.ts`, `brand-grouping/lineage.ts:25`, `tracked-brand-augment.ts:308`, `catalog-projection.ts:60-68·:203` |
| 골든 | `pure/analyze-turn.fixtures.ts:1-16`(스텁 명시), `:169-511`(축 A~G), `:565`·`:634`(ACR 2건), `__fixtures__/pure/*.json`(15), `tests/golden-analysis-core.test.ts:1-22` |
| 계약(contextVersion, 턴, 요청) | `contracts/v1.ts:124-133`, `:148-159`, `:173-179`, `:200-211`, `:213-235`, `:401-458` |
| 모델·풀·폴백 교훈 | `worker/llm-pools.ts:205-260`, `:330-370`, `infra/cdk.json:34-58`, `tests/model-parity.test.ts:62-76` |

### A-3. Scope 코어(`origin/main 50adc6cc`, `lib/measurement-analysis/`)

| 대상 | 위치 |
| --- | --- |
| 공유 컨텍스트·옵션 | `store.ts:259-284`, `:497-640`, `:654-735` |
| 질의 단위 분석·영속 | `store.ts:806`, `:950-1117`, `:1119`, `:1317`, `:3352` |
| 카탈로그·추적·산업 | `store.ts:2170`, `:2407`, `:2560`, 관계 `:3128`, ACR 포함 `:3153` |
| ACR 집계 | `store.ts:5079`, `:5262`, `:5595`, `:5656`, `:5676` |
| 답변 접기 | `store.ts:5883`, `:5939-6054` |
| 순수 모듈 동일성 | `git diff --stat ec6bccb1 origin/main -- pure llm.ts core.ts schema.ts context-redirect.ts alias-policy.ts tracked-brand-augment.ts` 출력 없음 |
| 버전 상수가 고정된 채 프롬프트가 바뀐 이력 | `ac114be8`(2026-08-31 결합 브랜드), `0e51e6e4`(09-17 감성 V2), `8ee0f619`(09-14 스탠스), `585644b5`·`ec6bccb1`(09-30·10-01 ACR) |
| 공개 API | `openapi/v1.yaml:406-425`(`/measurements/{prompt_run_id}`), `:773-830`(job 목록 include), `:2834-2861`(PromptRunTurn·Iteration), `:3154-3165`(MeasurementJob, 프롬프트 문안 없음) |

### A-4. KB·결정 문서

- `notes/hgh-impl/a4-decisions-batch.md`(결정 19·25~37), `cutover-checklist.md`("Scope 쪽 언급 정리 추종")
- `notes/hgh-impl/hmg-entity-management-versioning-design-20261001.md`(E0~E9, 부록 A 실측)
- `notes/hgh-impl/wu12/card-snapshot-design.md`(12장 결정 32, 12.5·12.6 셀 수, 12.11 보관 관문)
- `internal-kb/scope-analysis-lane-quality-gate3-2026-09-13.md`(대조군 설계, A2 비용)
- `internal-kb/scope-analysis-lane-throughput-cadence-anchor-billing-2026-09-14.md`(lane 처리량)
- `internal-kb/scope-analysis-llm-gpt56-luna-ab-2026-07-31.md`(단가·할인)
- `internal-kb/scope-analysis-lane-spec-2026-09-12.md`, `scope-analysis-pure-extraction-refactor-plan-2026-09-12.md`, `scope-analysis-lane-design-review-2026-09-13.md`(이번에는 목록만 확인했고 본문은 인용하지 않음)
