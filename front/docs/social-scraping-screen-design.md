# Social Research Agent (social-scraping) 화면설계서

> **목적**: 개발자 핸드오프용 화면설계서
> **대상 기능**: `app/sandbox/social-scraping` — 키워드 하나로 웹의 "실제 소비자 목소리"를 자율 리서치하여
> **구매 맥락 지도(Purchase Context Map)** 를 산출하는 AI 에이전트
> **경로**: `/sandbox/social-scraping` (작업용), `/public/research?session=<id>` (읽기전용 공유)
> **구현 파일**: 프론트 `app/sandbox/social-scraping/page.tsx` (단일 4692줄 클라이언트 컴포넌트) / 백엔드 `app/api/sandbox/social-scraping/**`

---

## 1. 서비스 개요

| 항목 | 내용 |
|------|------|
| 한 줄 정의 | 키워드 + 리서치 목적을 입력하면, AI **Director**가 여러 **Worker**를 파도(Wave)처럼 내보내 웹(커뮤니티/리뷰/블로그)을 검색·정독하고, "사람들이 이 제품을 고를 때 쓰는 모든 조건"을 귀납적으로 수집해 **구매 맥락 지도**로 시각화 |
| 핵심 산출물 | **Enriched Context Matrix** (구매 맥락 × 구매 조건 × 조합 패턴, 증거·출처·관점 포함) |
| 부가 산출물 | Worker 리서치 리포트, (온디맨드) 장문 마크다운 보고서, 프롬프트 CSV, Excel |
| 처리 방식 | **SSE 스트리밍** — 리서치 과정을 실시간으로 마인드맵 + 활동 로그에 렌더 |
| 사용자 개입 | 리서치 도중 채팅으로 방향 지시 / 완료 시점 컨펌(진행 vs 더 탐색) — **폴링 기반** |
| 주 LLM | Google Gemini (`gemini-3.1-pro-preview` = Director/Report, `gemini-3.5-flash` = Worker 추출/리포트), 검색은 **Firecrawl** |

### 1-1. 핵심 도메인 개념 (화면 이해를 위한 필수 용어)

| 용어 | 의미 | 화면 표현 |
|------|------|-----------|
| **Director** | 리서치 총괄 AI. Wave별 검색 전략 수립, 완료 판단 | 활동 로그의 `Wave`/`Reasoning` 카드 |
| **Worker** | 단일 검색 작업 1개를 수행(검색→소스 정독→추출→리포트) | 마인드맵의 **branch 노드** |
| **Wave** | Worker 묶음 한 차례(최대 20 Wave) | `Wave N: N tasks planned` 로그 |
| **Buyer Context (구매 맥락)** | "어떤 상황의 사람이 사는가" (예: 임산부, 1인가구) | Context Map **좌측(teal)** |
| **Purchase Condition (구매 조건)** | "어떤 조건의 제품을 원하는가" (예: 불소 없는, 가성비 좋은) | Context Map **우측(amber)** |
| **Combination** | 한 사람이 동시에 고려하는 조건 세트 | 노드 간 점선(amber) |
| **Perspective** | 발화자 관점 buyer/seller/neutral | 노드 주변 색상 링 |
| **Deep Evidence** | 정량 검증 단계(현재 **비활성화**) | 다이아몬드 노드/`DE` 태그 |

---

## 2. 전체 유저 플로우

```
┌─────────┐  키워드+목적   ┌──────────────┐  SSE 스트림    ┌───────────────────┐
│ INPUT   │ ─────────────▶ │ EXPLORING    │ ─────────────▶ │ (완료 컨펌)        │
│ 입력화면 │  Start Research │ 실시간 탐색   │  Wave 반복      │ confirmation 배너  │
└─────────┘                └──────────────┘                └─────────┬─────────┘
                                  ▲  │                               │
                          채팅개입 │  │ 사용자: "더 탐색"              │ 사용자: "진행"
                                  └──┘                               ▼
                                                          ┌───────────────────┐
   purchase-context 프리셋 ─────────────────────────────▶ │ CONTEXT-MAP       │ ◀── /public/research
   (기본): 컨텍스트 매트릭스 생성                            │ 구매 맥락 지도(메인)│     (읽기전용 진입점)
                                                          └───────────────────┘
   그 외 목적: 보고서 작성 ──────────────────────────────▶ ┌───────────────────┐
                                                          │ RESULTS           │
                                                          │ 마인드맵+마크다운보고서│
                                                          └───────────────────┘
```

**전환 규칙 (코드 근거: `finalized` SSE 이벤트 처리)**
- `contextMatrix`가 있으면 → **CONTEXT-MAP** 뷰로 전환 (purchase-context 프리셋 기본 동작)
- 보고서만 있으면 → **RESULTS** 뷰
- `/public/research?session=` 진입 시 → 세션 복원 후 **CONTEXT-MAP만** 노출(없으면 "not available")

> ⚠️ **중요**: `normal` 모드에서는 **장문 보고서를 생성하지 않음**(`report=null`). 컨텍스트 매트릭스가 1차 산출물이고,
> 마크다운 보고서는 RESULTS 뷰의 **"Rewrite Report"는 현재 비활성(`disabled`)**, 별도 온디맨드 액션으로만 생성됨.

---

## 3. 화면 목록 (Screen Inventory)

| # | 화면 ID | 명칭 | 진입 조건 | 주요 산출물 | 공유(public) |
|---|---------|------|-----------|-------------|--------------|
| S1 | `input` | 리서치 입력 | 초기 진입 | — | 폼 숨김, "Loading/Not available"만 |
| S2 | `exploring` | 실시간 탐색 | Start Research 후 | 마인드맵 + 활동로그 | "아직 준비 안 됨" 안내 |
| S3 | `context-map` | 구매 맥락 지도 (**메인**) | 매트릭스 완성/복원 | Context Matrix | **노출 (읽기전용)** |
| S4 | `results` | 리서치 보고서 | 보고서만 존재 시 | 마인드맵 + 마크다운 보고서 | "공유 불가" 안내 |

---

## 4. 화면별 상세 설계

### S1. INPUT — 리서치 입력 화면

```
┌──────────────────────────────────────────────────────────────┐
│  Social Research Agent                                         │  ← H1 + 설명문
│  Autonomous AI agent that researches any topic...             │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ [ Keyword / Topic ........................(2col) ]  [Loc▾]│ │  ← 입력 카드
│  │   예: 스마트폰, 자동차, 전기차, 선크림           [US(en)]│ │
│  │                                                          │ │
│  │  Research Purpose                                        │ │
│  │  [ Purchase Context Exploration ▾ ]  ← 프리셋 select     │ │
│  │  ┌────────────────────────────────────────────────────┐ │ │
│  │  │ (목적 textarea: 프리셋이면 8행, custom이면 4행)      │ │ │
│  │  └────────────────────────────────────────────────────┘ │ │
│  │                                       [ 🌐 Start Research]│ │  ← 우하단 버튼
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  How it works                                                  │
│  [1.Enter Topic] [2.AI Researches] [3.Mind Map] [4.Report]     │  ← 4단계 안내 카드
└──────────────────────────────────────────────────────────────┘
```

| 요소 | 데이터 바인딩 | 인터랙션 |
|------|---------------|----------|
| Keyword 입력 | `keyword` | Enter → `startExploration()` |
| Location/Language select | `selectedPresetId` | `LOCATION_LANGUAGE_PRESETS` 옵션 (`{flag} {nameEn} ({language_code})`) |
| Research Purpose select | `selectedPreset` | 선택 시 `purpose`를 프리셋 본문으로 교체. 기본값 `purchase-context` |
| Purpose textarea | `purpose` | 자유 편집. `custom` 프리셋이면 빈 값 |
| Start Research 버튼 | — | `loading \|\| !keyword.trim()`이면 비활성. 클릭 시 root 노드 생성 → `POST /stream` |

**호출 API**: `POST /api/sandbox/social-scraping/stream`
Body: `{ keyword, purpose, locationCode, languageCode, countryName, preset }` → SSE 스트림 수신 시작

---

### S2. EXPLORING — 실시간 탐색 화면

전체화면 좌우 분할: **좌측 = 라이브 마인드맵(flex-1)** / **우측 = Activity Log 사이드바(400px)**

```
┌────────────────────────────────────────────────┬──────────────────────────┐
│ ┌── 상태 오버레이(좌상단) ──────────────────┐    │ Activity Log             │
│ │ ⟳ Researching: "키워드"                  │    │ ┌──────────────────────┐ │
│ │ 5 workers | 32 sources                   │    │ │▶ Sources  12:03 (8)  │ │ ← content 카드
│ │ Cost: $0.0421  Tokens: 12k in / 8k out   │    │ │  "검색어..."          │ │
│ │ Firecrawl: 14 searches                   │    │ ├──────────────────────┤ │
│ │ Director Context [▓▓▓░░] 32% (320k/1M)   │    │ │▶ Reasoning 12:03     │ │ ← reasoning(보라)
│ └──────────────────────────────────────────┘    │ ├──────────────────────┤ │
│                                                  │ │  Wave 2  12:04       │ │ ← wave(인디고)
│        ●keyword                                  │ │  8 tasks planned     │ │
│       ╱  │  ╲     (force graph: 노드 드래그/클릭) │ ├──────────────────────┤ │
│   ●branch ●branch ●branch  ← Worker (상태 링)    │ │  You: 더 깊게 파줘    │ │ ← user_message(초록)
│    ·  ·    ·  ·     ← source 점                   │ │  ...                 │ │
│   ◆evidence (다이아, 현재 거의 안 나옴)            │ └──────────────────────┘ │
│                                                  │ (자동 스크롤)             │
│  [hover/click 시 노드 툴팁: Worker 리포트 전문]   │                          │
├──────────────────────────────────────────────────────────────────────────┤
│ ⚠ Ready to generate context map?  [✓ Generate Context Map] [🔍 Keep Researching] │ ← confirmation 배너
├──────────────────────────────────────────────────────────────────────────┤
│ [ Guide the agent................................ ]              [ Send ▷ ] │ ← 사용자 메시지 입력
└──────────────────────────────────────────────────────────────────────────┘
```

#### 좌측 마인드맵 (ForceGraph2D, 커스텀 캔버스 렌더)
| 노드 타입 | 시각 표현 | 데이터 |
|-----------|-----------|--------|
| `keyword` (root) | 중앙 고정 큰 원 | `keyword` |
| `branch` (Worker) | 원 + **상태 링**: searching(점선 펄스 `W{n} 🔍`) / analyzing(회전 호 `W{n} ⚡{sourceCount}`) / completed(`W{n}`) | Worker task |
| `source` | 작은 점(브랜치색) | 출처 URL |
| `evidence` | 보라 다이아몬드 + `🔬` | Deep Evidence(비활성) |
| `finding` | 작은 원 | 발견 항목 |

- **클릭**: source → 새 탭으로 URL / branch·finding·evidence → 툴팁 **pin**(고정)
- **hover**: 툴팁 표시. branch 툴팁엔 Worker 리포트 전문(Markdown, 링크는 `[n]` 각주화), evidence 툴팁엔 supporting/contradicting/neutral 막대

#### 우측 Activity Log (로그 type별 렌더)
`content`(Sources, 펼치면 결과 카드 목록) / `reasoning`(보라) / `confirmation`(앰버) / `user_message`(초록 "You") / `wave`(인디고, strategy 포함) / 일반(색상 코드: error 빨강, search 파랑, discover 초록, worker 청록, complete 초록볼드) / 실시간 `Thinking...`(스트리밍 reasoning)

#### Confirmation 배너 (`confirmationState` 존재 시)
- 제목: purchase-context면 "Ready to generate context map?" / 그 외 "Ready to write the report?"
- `findingsSummary`, `suggestedNextSteps`, `{findings} | {branches} | {searches}` 통계
- **[Generate Context Map / Write Report]** (초록): purchase-context → `generateContextMap()`, 그 외 → `sendConfirmationResponse(true)`
- **[Keep Researching]** (앰버) → `sendConfirmationResponse(false)`

#### 사용자 메시지 입력
- `userMessage` 바인딩, Enter/Send → `sendUserMessage()` → `POST /message`. `!sessionId \|\| !loading`이면 비활성

**상태 카운터 데이터**: `currentCost`, `currentTokens`, `firecrawlSearches`, `directorContext{tokens,percent}` ← 모두 `cost_update` SSE 이벤트로 갱신

---

### S3. CONTEXT-MAP — 구매 맥락 지도 (메인 산출물 화면)

상단 헤더 + (그래프 flex-1) + (사이드바 340px) + (상세 슬라이드오버 400px, 선택 시)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◀ Purchase Context Map: "키워드"   42 contexts, 88 conditions, 60 rel...   │
│   120 workers, 540 sources  12 DE  $1.84   [⬇Export Excel] [⬇Prompts(.csv)]│ ← 헤더
├──────────────────────────────────────┬──────────────────┬──────────────────┤
│ [Physics ⚙]            (bipartite)    │ Context Map      │ (상세 슬라이드오버) │
│                                       │ ┌──┬──┬──┬──┐    │  선택된 노드 상세   │
│   ▣Context Theme    ●keyword   Cond▣  │ │42│88│60│540│  │  - 통계            │
│   (teal, 좌측)        │      (amber,우)│ │Ctx│Cnd│Rel│Src│  - Perspective 막대 │
│    ○context ───drives──▶ ○condition   │ └──┴──┴──┴──┘    │  - Evidence Quotes │
│    (관점 링)      ⋯combo⋯  (DE 점선링) │ Perspective:     │  - Sources by Domain│
│                                       │ [All|Buyer|Sell| │  - (조건) Deep Ev.  │
│  [Legend: Context/Condition/Drives/   │  Neutral]        │  - Driven By/Related│
│   Combo/B·S·N]                        │ ▼ Contexts (teal)│                  │
│                                       │   임신/육아  (12) │  (selectedAttr /  │
│                                       │ ▼ Purchase Cond. │   selectedCtx /   │
│                                       │   성분안전성 (24)│   selectedCombo)  │
│                                       │ ▼ Combination... │                  │
└──────────────────────────────────────┴──────────────────┴──────────────────┘
```

#### 좌측 Bipartite Force Graph
- **좌(teal)**: Context Theme(둥근 사각 `CTX`) → Context(원, 주변 **관점 링** buyer초록/seller빨강/neutral회색, 중앙 mention 수)
- **우(amber)**: Condition Category(둥근 사각 `COND`) → Condition(원, `deep_evidence` 있으면 **보라 점선 링** + 중앙 source 수)
- **링크**: `drives`(인디고 화살표, context→condition) / `combination`(앰버 곡선 점선, 빈도별 굵기) / hierarchy(회색 실선)
- **클릭**: condition → `selectedAttr`+하이라이트 / context → `selectedCtx` / category·theme → 사이드바 해당 섹션 펼침
- **하이라이트**: 선택 노드의 의미연결(drives/combination)만 BFS로 강조, 나머지는 디밍
- **Physics 패널**: Repulsion/Link distance/Node spacing/Link strength 슬라이더 + Reheat/Fit View

#### 우측 사이드바 (340px)
1. **요약 4칸**: Contexts / Conditions / Relations / Sources (`total_*_found`, `total_relationships`, `total_sources`)
2. **Perspective Filter**: All/Buyer/Seller/Neutral → 리스트 항목 디밍
3. **Contexts 섹션**(teal): 테마별 접기/펼치기, 각 context 클릭 시 그래프 줌+`selectedCtx`
4. **Purchase Conditions 섹션**(amber): 카테고리별, 각 condition 클릭 시 `selectedAttr`, `DE` 태그/소스바
5. **Combination Patterns**: `attr × attr` 칩 + 빈도 pill + `frequency_justification`("7/120 speakers (6%)")

#### 상세 슬라이드오버 (400px, 노드/항목 선택 시)
- **Context 상세**: sources/domains/mentions, Perspective 막대, **Driven Conditions**(클릭 시 점프), Evidence Quotes, Sources by Domain
- **Condition 상세**: 위 + **Deep Evidence**(claim/supporting/contradicting/neutral/confidence/샘플), **Driven By Contexts**, Related Conditions
- **Combination 상세**: co-occurrence/overlap rate, Scenario(description), Evidence Quotes, Source URLs(최대 20)

#### 헤더 액션
| 버튼 | 동작 | 출력 |
|------|------|------|
| Export Excel | `exportContextMatrixToExcel()` | 3시트 xlsx (Contexts/Conditions/Combinations) |
| Prompts (.csv) | `generatePromptsAndDownload()` → `POST /generate-prompts` | 프롬프트 CSV (개수 1~5000 입력) |
| ◀ Back | input으로 리셋 (public이면 숨김) | — |

---

### S4. RESULTS — 리서치 보고서 화면

헤더 + 좌우 50:50 분할 (**좌 마인드맵 / 우 마크다운 보고서**)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◀ Research Report: "키워드"  120 findings across 18 branches from 540...   │
│   [Rewrite Report(비활성)] [Context Map] [Backfill+Map] [⬇.md] [⬇.pdf] [Prompts.csv]│
├────────────────────────────────────┬───────────────────────────────────────┤
│        (마인드맵 - S2와 동일)        │ Summary (파란 배너: reportSummary)     │
│         ●keyword                    │ ─────────────────────────────────────  │
│        ╱ │ ╲                        │ # 보고서 본문 (report, Markdown)       │
│     ●branch ●branch                 │ ## 챕터들...                           │
│                                     │ (prose 스타일, GFM 테이블)             │
└────────────────────────────────────┴───────────────────────────────────────┘
```

| 버튼 | 동작 | 비고 |
|------|------|------|
| Rewrite Report | `rewriteReport()` | **현재 `disabled={true}` 하드코딩** (UI로 도달 불가) |
| Context Map | `generateContextMap()` | `enrich_context_map` 모드 → context-map 뷰 |
| Backfill + Map | `backfillAndEnrich()` | 레거시 세션 구조화 추출 보강 후 매트릭스 |
| Export (.md/.pdf) | `exportReport()` / `exportPdf()` | `report` 없으면 비활성 |
| Prompts (.csv) | `generatePromptsAndDownload()` | |

---

## 5. SSE 이벤트 → 화면 반응 매핑 (개발 핵심)

화면은 **이벤트 구동**. `POST /stream` 응답을 줄 단위 SSE로 파싱해 `handleSSEEvent`가 처리.

| 이벤트 `type` | 화면 반응 | 주요 필드 |
|--------------|-----------|-----------|
| `session_created` | URL에 `?session=` 기록, sessionId 설정 | `sessionId` |
| `wave_started` | `Wave N` 로그 카드 | `wave, taskCount, strategy` |
| `worker_dispatched` | **branch 노드 추가**(searching) | `branchId, branchLabel, query, parentId, wave` |
| `worker_sources_fetched` | branch→analyzing, **source 노드들 추가** | `sourceCount, sourceUrls[]` |
| `worker_completed` | branch→completed, **Worker 리포트 첨부** | `report, sourcesReferenced[]` |
| `wave_completed` | discover 로그 | `coverageAssessment, gapsIdentified, isComplete` |
| `cost_update` | **비용/토큰/Firecrawl/Director Context 카운터 갱신** | `cost, inputTokens, outputTokens, firecrawlSearches, directorContextPercent` |
| `reasoning` / `thinking` | reasoning/info 로그 | `message` |
| `confirmation_requested` | **Confirmation 배너 표시** | `findingsSummary, suggestedNextSteps, stats` |
| `research_paused` | 일시중지 로그, loading 해제 | `reason:'timeout'` |
| `context_matrix_extracted` | "N contexts/conditions discovered" 로그 | `totalContexts, totalConditions` |
| `context_matrix_complete` | **매트릭스 → 그래프 빌드** | `matrix` (EnrichedContextMatrix) |
| `finalized` | **stats 설정 + 뷰 전환**(context-map/results) | `contextMatrix?, stats` |
| `user_message_received` | (no-op) | `messages[]` |
| `error` / `done` | 에러 로그 / 종료 | |

> 보조 스트림(`rewriteReport`/`generateContextMap`/`backfillAndEnrich`)은 `chapter_started/completed`, `report_submitted` 등 추가 이벤트를 자체 switch로 처리.

---

## 6. 데이터 산출물 (Deliverables)

### 6-1. Enriched Context Matrix (★ 1차 산출물, `social_scraping_sessions.context_matrix` jsonb)

```ts
EnrichedContextMatrix {
  context_themes: [{          // 구매 맥락(좌, teal)
    theme_name, description,
    contexts: [{
      name,                    // 예: "임산부"
      mention_count,           // 검증된 언급 수(distinct worker)
      total_workers, mention_rate,
      evidence_quotes: [{quote, source_title, source_url, perspective}],
      unique_source_count, source_urls[], source_domains: {domain: count},
      perspective_breakdown: {buyer, seller, neutral},
      driven_conditions: [{name, strength}]   // 이 맥락이 유발하는 조건
    }]
  }],
  condition_categories: [{    // 구매 조건(우, amber)
    category_name, description,
    conditions: [{
      name,                    // 예: "불소 없는"
      mention_count, total_workers, mention_rate,
      evidence_quotes[], branch_labels[], related_conditions[],
      unique_source_count, source_urls[], source_domains,
      perspective_breakdown,
      driven_by_contexts: [{name, strength}],
      deep_evidence?: {claim, supporting, contradicting, neutral, total_scanned, confidence, sample_quotes[]}
    }]
  }],
  combinations: [{            // 동시 고려 조건 세트(점선)
    attributes:[a,b], frequency:'high|medium|low', description,
    co_occurrence_count, total_speakers, co_occurrence_rate,
    unique_source_count, source_urls[], frequency_justification
  }],
  total_context_themes, total_contexts_found,
  total_condition_categories, total_conditions_found,
  enrichment_stats: {total_workers, total_speakers, total_sources, perspective_breakdown, total_relationships, deep_evidence_linked}
}
```

### 6-2. Worker 리포트 (`social_scraping_results`, Worker당 1행)
`question`(검색어), `worker_report`(300~500단어 분석), `cluster_name`(브랜치), `frequency`(정독 소스 수), `source_urls[]`, `source_contexts[]`(`[title](url): relevance`), `context_attributes`(`{contexts[], conditions[]}` — Phase0/0.5의 핵심 원천), `parent_topic`

### 6-3. 프롬프트 CSV (`POST /generate-prompts`)
컨텍스트 매트릭스를 소비자 질문으로 변환. 컬럼: `question, funnel_stage, layer(L1-context/L2-condition/L3-intersection), context_theme, condition_category, source_context, source_condition, mention_rate, evidence_count, priority_score, data_sources`

### 6-4. 장문 보고서 (`rewrite_report` 모드만)
Executive Summary → Introduction → 12~18 챕터 → Strategic Takeaways → Appendix. `report`(markdown) + `summary`

### 6-5. Excel (3시트)
Contexts / Conditions / Combinations — 각 행에 mention/perspective/evidence/domain 포함

---

## 7. 데이터 모델 (Supabase, 5개 테이블)

| 테이블 | 생성 주체 | 핵심 컬럼 | 용도 |
|--------|-----------|-----------|------|
| `social_scraping_sessions` | stream | `id`(=공유토큰), `keyword`, `status`(in_progress→completed), `ontology_graph`, `context_matrix`, `report`, `total_questions_found/clusters/sources_searched`, `location_code/language_code/country_name` | 세션 메타 + 산출물 |
| `social_scraping_results` | stream(worker) | `session_id`, `question`, `worker_report`, `cluster_name`, `cluster_rank`, `frequency`, `source_urls`, `source_contexts`, `context_attributes` | Worker 결과 |
| `social_scraping_user_messages` | message API(insert) / stream(poll·`processed=true`) | `session_id`, `message`, `processed`(소비 플래그) | 사용자 개입 채널 |
| `social_scraping_search_cache` | stream(search) | `cache_key`(unique=`query_lang`), `results`(jsonb `{title,url,markdown,description}[]`), `expires_at`(7일 TTL) | Firecrawl 캐시 |
| `social_scraping_deep_evidence` | deep-evidence(**비활성**) | `claim`, `supporting/contradicting/neutral_count`, `confidence`, `sample_evidence` | 정량 검증(현재 미생성) |

**보조 API**
- `GET /session?id=` → `{session, results, deepEvidence}` (admin 클라이언트, 세션 UUID가 곧 공유 토큰)
- `POST /message {sessionId, message}` → `user_messages` insert (세션 `in_progress`일 때만)
- `GET /source-content?url=` → 캐시된 소스 markdown
- `POST /generate-prompts {sessionId, targetCount}` → 프롬프트 배열 (매트릭스 필수)
- `test-extract` → **localhost 전용** 단일소스 추출 디버그 하네스(Swagger)

---

## 8. 개발자 인수인계 시 주의사항 (코드 근거 기반)

1. **`normal` 모드는 보고서를 만들지 않음** — `report=null`. 컨텍스트 매트릭스가 메인. 보고서는 `rewrite_report` 모드 온디맨드. RESULTS 화면의 **Rewrite Report 버튼은 `disabled` 하드코딩**.
2. **Deep Evidence 단계는 현재 비활성** (`route.ts` 주석 "[DISABLED]"). UI의 다이아몬드 노드/`DE` 태그/deep_evidence 패널은 **현재 빌드에선 거의 비어있음**. 코드는 보존됨.
3. **사용자 개입은 폴링 기반** (메시지 큐/웹소켓 아님). `user_messages.processed` 플래그가 커서. 완료 컨펌 게이트는 **3초 간격, 30분 타임아웃**(초과 시 `research_paused`, 자동 진행 안 함).
4. **세션 UUID = 공유 토큰** — `/public/research?session=`는 admin 클라이언트로 인증 없이 읽음(RLS 우회). 공유 시 보안 고려 필요.
5. **`generate-prompts`의 `assignFunnelStage`에 한국어 카테고리명 하드코딩** (예: '성분 안전성 및 자연 유래') — 미매칭은 `consideration` fallback. 다국어/타도메인 확장 시 포팅 필요.
6. **레거시 세션 호환** — 구버전 매트릭스(pipe-delimited)는 `normalizeToEnriched()`로 변환. `Backfill + Map`은 구조화 추출이 없는 옛 세션 보강용.
7. **단일 4692줄 컴포넌트** — 모든 뷰/그래프 렌더/SSE 핸들링이 `page.tsx` 한 파일. 유지보수 시 뷰 단위 분할 검토 권장.
8. **비용 주의** — Wave 최대 20, Worker 동시 실행(검색 동시성 10), 소스당 LLM 추출(100% 커버리지). 대형 키워드는 비용·시간 큼. `cost_update`로 실시간 노출됨.

---

## 9. 관련 파일 인덱스

```
app/sandbox/social-scraping/
├── page.tsx                       # 전체 4개 뷰 (단일 클라이언트 컴포넌트)
└── test-extract/                  # localhost 전용 추출 디버그(Swagger)

app/api/sandbox/social-scraping/
├── stream/
│   ├── route.ts                   # SSE 오케스트레이션(4모드: normal/rewrite_report/enrich_context_map/backfill_and_enrich)
│   ├── director.ts                # Wave 계획·리뷰 (gemini-3.1-pro-preview)
│   ├── worker.ts                  # 검색→소스추출→리포트 (gemini-3.5-flash)
│   ├── search.ts                  # Firecrawl /v2/search + 캐시
│   ├── context-matrix.ts          # Phase0 census + Phase0.5 enrichment
│   ├── categorization.ts / synonym.ts  # 테마/카테고리 분류, 동의어 병합
│   ├── deep-evidence.ts           # 정량 검증(비활성)
│   ├── report.ts                  # 장문 보고서(Phase1~3)
│   └── schemas.ts / types.ts / helpers.ts
├── session/route.ts               # GET 세션 복원
├── message/route.ts               # POST 사용자 개입
├── generate-prompts/route.ts      # POST 프롬프트 CSV 생성
└── source-content/route.ts        # GET 캐시 소스 markdown
```

---

## 10. HMG (hmg-geo) 적용 — 수정 유저플로우 & 구현

> 위 1~9는 **원본 독립형 리서치 에이전트**(scope 기반, SSE 스트리밍, ForceGraph2D, 단일 4692줄)의 설계서다.
> hmg-geo(thin client + BFF)에서는 social-scraping이 **독립 도구가 아니라 "관심사 파악 → 프롬프트 후보 풀"
> 파이프라인의 한 단계**다. 아래는 그에 맞게 **수정한 유저플로우와 실제 구현**이다. (현 단계 **데이터는 전부 fake**)

### 10-1. 수정 유저플로우 (3뷰 + 후보 연결)

```
┌─────────┐  키워드+목적   ┌──────────────┐  타이머 fold   ┌───────────────────┐  [프롬프트 후보 생성]  ┌────────────────────┐
│ INPUT   │ ─────────────▶ │ EXPLORING    │ ─────────────▶ │ CONTEXT-MAP        │ ──────────────────▶ │ 프롬프트 후보 다이얼로그 │
│ S1      │  리서치 시작    │ (가짜 스트림) │  Wave 시뮬레이션│ 구매 맥락 지도(메인)│  소비자 질문 L1/L2/L3 │ → 후보 풀로 전송(toast) │
└─────────┘                └──────┬───────┘                └─────────┬─────────┘                     └────────────────────┘
                                  │ [더 탐색] → 추가 Wave             │ ◀ 처음으로
                                  └──────────────────────────────────┘
```

- **원본 대비 변경점**
  | 원본 | hmg-geo 적용 |
  |------|--------------|
  | 4뷰(INPUT/EXPLORING/CONTEXT-MAP/**RESULTS 장문보고서**) | **3뷰** — RESULTS 보고서 뷰 **제거**(우리 산출물은 보고서가 아니라 프롬프트 후보) |
  | 산출물 = Enriched Context Matrix + 보고서 + CSV | 산출물 = **구매 맥락 지도 → 프롬프트 후보**(`prompt_candidates`) |
  | "Prompts (.csv)" 다운로드 | **"프롬프트 후보 풀로 전송"**(standard) / **"표준 프롬프트 카탈로그로 전송"**(admin) |
  | 실제 SSE 스트림(`POST /stream`) | **결정론적 타임라인 fold**(`reduceExploring`) — 타이머가 step prefix를 snapshot으로 환원 |
  | ForceGraph2D 커스텀 캔버스 | **Cytoscape + fcose**(이미 설치된 의존성) 이분 force graph |
  | `/public/research` 읽기전용 공유 | (미적용 — 보안 검토 필요, 후속) |
  | Deep Evidence 다이아 노드 | (미적용 — 원본도 비활성) |

### 10-2. 진입점 2곳 (동일 플로우 재사용)

같은 `<SocialScrapingFlow />`를 두 라우트에 마운트한다(사용자 요청: "admin 고객관심사 설정도 같은 유저플로우").

| 라우트 | 역할 | mode | 후보 전송 대상(개념) |
|--------|------|------|----------------------|
| `/customer-interest/social-scraping` | 표준 메뉴 — hq/region/country가 실행·열람 | `standard` | 프로젝트 프롬프트 후보 풀(`prompt_candidates`) |
| `/admin/standards/customer-interest` | 관리자 — 표준 키워드/소스 카탈로그 **위에** 동일 리서치 섹션 추가 | `admin` | 표준 프롬프트 카탈로그 |

`mode`는 마지막 "후보 전송" 버튼 문구만 바꾼다(현재 전송은 모두 fake toast).

### 10-3. 화면별 매핑 (원본 §4 → 구현)

- **S1 INPUT** (`input-view.tsx`): 키워드(+시드 칩) / 지역·언어 select / 목적 프리셋(구매맥락·경쟁사VoC·기능수요·직접입력) + textarea / How it works 4단계. 시드 칩은 admin `standard_keywords(source_type='community_voc')`를 대체하는 fake.
- **S2 EXPLORING** (`exploring-view.tsx`): 상단 카운터(워커/소스/비용/검색) + Wave별 Worker 칩(searching🔍/analyzing⚡/completed✓) + 우측 활동 로그(자동 스크롤, type별 색) + 완료 컨펌 배너([더 탐색]/[구매 맥락 지도 생성]) + 사용자 가이드 입력. `EXPLORING_STEPS`를 `TICK_MS`마다 한 step씩 공개.
- **S3 CONTEXT-MAP** (`context-map-view.tsx` + `context-graph.tsx`): 좌 그래프(이분 force) + 우 레일. 폭 제약(`max-w-6xl`)상 원본의 사이드바+슬라이드오버를 **단일 우측 레일이 browse↔detail 토글**하도록 적응. 헤더에 통계 + [Excel](toast) + [프롬프트 후보 생성]. 관점 필터(전체/구매자/판매자/중립)로 리스트 디밍, 노드 클릭 시 의미연결(drives/combination) BFS 하이라이트.
- **(신규) 프롬프트 후보 다이얼로그** (`prompt-candidates-dialog.tsx`): 매트릭스 → 소비자 질문(L1-맥락/L2-조건/L3-교차 + 퍼널 + 우선순위) 표, 체크 선택 후 전송. 원본 §6-3 generate-prompts의 UI 대체.

### 10-4. DB 스키마 매핑 (`lib/db/schema.ts`)

| 화면 산출물 | 테이블 / 컬럼 | 비고 |
|-------------|---------------|------|
| 프롬프트 후보 전송 | `prompt_candidates` (`source='social_scraping'`, `source_keyword`) | 현재 fake — 실제 insert는 후속 |
| INPUT 시드 키워드 | `standard_keywords` (`source_type='community_voc'`) | admin이 관리, 시드 칩으로 노출 |
| 수집 소스 화이트리스트 | `standard_sources` (`channel='community'` 등) | admin 카탈로그(기존) |
| (개념) 세션/결과/매트릭스 | 원본 `social_scraping_sessions/results`(미생성) | hmg-geo는 scope 위임 — 본 레포 미보유 |

### 10-5. 구현 파일 인덱스

```
components/social-scraping/          # 두 라우트가 공유하는 기능 모듈
├── social-scraping-flow.tsx         # 오케스트레이터(input→exploring→context-map 상태기계)
├── input-view.tsx                   # S1
├── exploring-view.tsx               # S2 (reduceExploring로 가짜 스트림)
├── context-map-view.tsx             # S3 (그래프+우측 레일 browse/detail)
├── context-graph.tsx                # Cytoscape+fcose 이분 force graph (dynamic import, SSR-safe)
├── prompt-candidates-dialog.tsx     # 매트릭스 → 프롬프트 후보 브리지
├── sample-data.ts                   # fake EnrichedContextMatrix + 타임라인 + 후보 (키워드 "패밀리 SUV")
├── types.ts                         # 공유 타입(원본 §6-1 EnrichedContextMatrix의 간소화 슬라이스)
└── cytoscape-fcose.d.ts             # cytoscape-fcose 앰비언트 선언

messages/{ko,en}.json                # socialScraping 네임스페이스(108키, 한/영 parity)
app/[locale]/(dash)/customer-interest/social-scraping/page.tsx   # <SocialScrapingFlow mode="standard"/>
app/[locale]/(dash)/admin/standards/customer-interest/page.tsx   # + <SocialScrapingFlow mode="admin"/> 섹션
```

### 10-6. 알려진 단순화(후속 연결 지점)

1. **데이터 fake** — `sample-data.ts` 고정 시나리오. 실데이터는 scope 위임 경로(BFF) 확정 후 교체.
2. **후보 전송은 시뮬레이션** — toast만. 실제론 `addCandidate(…, 'social_scraping', …)` / 표준 카탈로그 insert로 연결.
3. **EXPLORING은 SSE 아님** — 타이머 fold. 실 스트림 도입 시 `reduceExploring` 입력만 SSE 이벤트로 교체.
4. **그래프 i18n/색상** — 캔버스 렌더 특성상 `context-graph.tsx`에 색 리터럴 상수 유지(citations-view 선례). 라벨은 데이터(맥락/조건명)라 한국어이며 로케일 비반영(기존 sample.ts 컨벤션과 동일).
5. **국가/언어·관점 필터는 클라이언트 표시 전용** — scope-policy 서버 필터와 연동은 게이트웨이 enforcing 후.
