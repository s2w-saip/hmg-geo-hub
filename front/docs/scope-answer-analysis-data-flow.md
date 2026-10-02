# SCOPE 답변 분석(Response Analysis) — 언급 분석 & 인용 분석 데이터 표현 방식

> **대상**: 개발자 핸드오프용
> **범위**: AI 답변을 분석한 결과 중 **Brand Mentions(언급 분석)** 와 **Citation Sources(인용 분석)** 두 화면이
> 데이터를 어떻게 집계하고 화면에 보여주는지.
> **메뉴 위치**: 프로젝트 사이드바 `AI Visibility` 그룹 > `Brand Mentions`, `Citation Sources`
> (`app/dashboard/project/[id]/layout-client.tsx`)

---

## 0. 공통 아키텍처 (두 화면이 동일한 패턴)

두 화면은 **거의 동일한 구조**로 설계되어 있다.

```
[available-dates API]  → 날짜/필터 옵션 로드 (마운트 시 1회)
        │
[FiltersPanel]         → 날짜·검색·AI Provider/Model·Volume·CustomAttr 필터 UI
        │ (Apply)
[stats API]            → 메인 집계 데이터 (요약 카드 + 메인 테이블 소스)
        │
[trends API]           → 일자별 Top N 트렌드 (라인 차트, stats와 별개 날짜 범위)
        │
[메인 테이블]          → 행 클릭 시 드릴다운(별도 detail API 호출)
```

| 구성 요소 | Brand Mentions | Citation Sources |
|-----------|----------------|------------------|
| 페이지 | `brand-mentions/page.tsx` | `citations/page.tsx` |
| 필터 패널 | `_components/MentionsFiltersPanel.tsx` | `_components/CitationsFiltersPanel.tsx` |
| 트렌드 차트 | `_components/MentionsTrendChart.tsx` | `_components/CitationsTrendChart.tsx` |
| 메인 테이블 | `_components/MentionsBrandsTable.tsx` | `_components/CitationsDomainsTable.tsx` |
| 타입 정의 | `_components/types.ts` | `_components/types.ts` |
| **기준 단위** | **브랜드(brand_name)** | **도메인(domain)** |
| **원천 테이블** | `brand_mentions` | `citation_analysis` |

> 핵심 차이: 언급 분석은 **브랜드 단위**로 집계(우리/경쟁사 브랜드가 AI 답변에 얼마나 등장하나),
> 인용 분석은 **도메인 단위**로 집계(AI가 답변 근거로 어떤 출처를 인용하나).

---

## 1. Brand Mentions (언급 분석)

### 1-1. 화면 제목
- `Brand Mention Analysis` — "Analyze brand visibility across AI responses and track mention trends over time"

### 1-2. API 엔드포인트

| 용도 | 엔드포인트 | 비고 |
|------|-----------|------|
| 필터 옵션 | `GET /api/project/mentions/available-dates` | `get_mention_dates` **RPC**로 날짜/provider/model DISTINCT 조회 + `prompts.custom_attr_1~10` 옵션 |
| 메인 집계 | `GET /api/project/mentions/stats` | 요약 + 브랜드별 집계 |
| 트렌드 | `GET /api/project/mentions/trends` | 일자별 Top N 브랜드 |
| 드릴다운(프롬프트) | `GET /api/project/mentions/brand-prompts` | 브랜드 행 클릭 → 해당 브랜드 언급 프롬프트 + AI 응답 |
| 드릴다운(인용) | `GET /api/project/mentions/brand-citations` | 브랜드 클릭 → 그 브랜드 답변들이 인용한 출처 도메인 |

### 1-3. stats API 응답 데이터 형태 (`StatsData`)

```ts
{
  total: number;          // 필터 범위 내 총 언급 수 (COUNT, head:true 별도 쿼리)
  uniqueBrands: number;   // 고유 브랜드 수
  totalPrompts: number;   // 필터 범위 내 프롬프트 수 (Mention Rate 분모)
  brands: BrandData[];    // 브랜드별 집계 (mention_count desc 정렬)
}

BrandData = {
  brand_name: string;
  mention_count: number;            // 언급 횟수 (같은 프롬프트 내 복수 언급도 각각 카운트)
  prompt_count: number;             // 이 브랜드가 등장한 고유 프롬프트 수
  percentage: number;               // Share %: mention_count / total * 100
  sentiment_counts: { positive, neutral, negative };
  mention_types: { mention, recommendation, comparison, definition };
  avg_position: number | null;      // 평균 언급 순위 (mention_position 평균)
  avg_volume: number | null;        // 등장 프롬프트들의 평균 검색량
}
```

### 1-4. stats API 집계 로직 (`app/api/project/mentions/stats/route.ts`)

순서대로:
1. `prompts`에서 `project_id` + `is_user_added=true` 프롬프트 ID 전체 조회
2. 날짜/AI필터가 있으면 `prompt_queries`에서 범위 내 `query_id` 수집 (**200개씩 batch** — `.in()` URL 길이 제한 회피)
3. Volume/CustomAttr 필터가 있으면 해당 `prompt_id` 별도 필터링
4. `brand_mentions` 총 카운트 (`count: 'exact', head: true` — row fetch와 분리)
5. 분모용 `totalPrompts` 계산
6. `brand_mentions` 실데이터 fetch (batch당 limit 10000) → `brand_name, mention_position, mention_type, brand_sentiment, prompt_id`
7. `prompts`에서 volume/text 매핑
8. **메모리에서 브랜드별 집계** (Map) → sentiment/mention_type 카운트, position·volume 평균

> ⚠️ 집계는 DB 집계가 아니라 **앱 메모리에서 수행**. batch size 200, 페이지당 10000행 제한이 곳곳에 있음.

### 1-5. 화면에 보여주는 것

**(a) 필터 패널** — 날짜 범위, 브랜드 검색, AI Provider/Model, Volume Min/Max, Custom Attr 1~10

**(b) 트렌드 차트** (`MentionsTrendChart`)
- `trends` API: 일자별 Top 10 브랜드의 언급 수 라인. 응답: `{ dates, brands, trendData:[{date, brandCounts:{[brand]:n}, totalCount}], totalBrandsTracked }`
- 트렌드 날짜 범위는 **메인 필터와 독립** (별도 state). 차트의 날짜 클릭 시 메인 필터를 그 날짜로 좁힘

**(c) 메인 테이블** "Top Brands by Mention Count" (`MentionsBrandsTable`, 상위 100개)

| 컬럼 | 의미 |
|------|------|
| Brand | 브랜드명 + `tracked_brands` alias 카탈로그가 있으면 `+N` 배지(병합된 별칭 hover) |
| Mentions | 언급 횟수 |
| Share % | 언급 ÷ 전체 언급 × 100 (같은 프롬프트 복수 언급 각각 카운트 / 상위100 합은 100% 미만 가능) |
| Avg. Position | 평균 언급 순위 |
| Prompts | 등장 고유 프롬프트 수 |
| Mention Rate | 등장 프롬프트 ÷ 전체 프롬프트 × 100 (한 프롬프트는 1회만) |

- 컬럼 헤더 클릭 정렬, **Export Excel**(`lib/excel/export`) 지원
- alias 소스는 경쟁사 master를 직접 읽지 않고 프로젝트별 `tracked_brands` 카탈로그를 기준으로 병합한다. 설정 화면에서 `지정 브랜드/모델`을 추가·삭제하면 카탈로그가 재계산된다.
- 모델 alias canonicalization은 `브랜드 + alias`를 우선 사용하고, mirror merge key도 `brand_rollup_entity_id`를 포함한다. 따라서 서로 다른 브랜드의 동명 모델/공통 약칭은 한 row로 합쳐지지 않는다.
- **드릴다운 (행 클릭 시 2단 탭)**:
  - `Prompts` 탭 → `brand-prompts` API. 프롬프트별 언급 수/Share/Volume/Funnel/Providers, 다시 클릭하면 **AI 응답 원문**(ReactMarkdown), Context, Position/Type/Sentiment 배지, citation 파싱한 Sources 링크
  - `Citation Sources` 탭 → `brand-citations` API. 그 브랜드 답변들이 인용한 도메인 테이블(Domain/Category/Citations/Share/URLs/Prompts/Providers) → 도메인 클릭 시 URL 목록

---

## 2. Citation Sources (인용 분석)

### 2-1. 화면 제목
- `Citations Analysis` — "Analyze citation sources with LLM categorization"
- 데이터 없으면: *"Please run 'Analyze Citations' from the Overview page first."* (Overview에서 인용 분석을 먼저 실행해야 데이터가 생김)

### 2-2. API 엔드포인트

| 용도 | 엔드포인트 |
|------|-----------|
| 필터 옵션(날짜) | `GET /api/project/citations/available-dates` |
| Custom Attr 옵션 | `GET /api/project/citations/unique-attributes` |
| 메인 집계 | `GET /api/project/citations/stats` |
| 트렌드 | `GET /api/project/citations/trends` |
| 드릴다운(도메인 URL) | `GET /api/project/citations/domain-details` |
| 드릴다운(도메인 프롬프트) | `GET /api/project/citations/domain-prompts` |
| 드릴다운(프롬프트 상세) | `GET /api/project/citations/prompt-details` |
| 드릴다운(URL별 프롬프트) | `GET /api/project/citations/url-prompts` |
| YouTube 메타 동기화 | `GET /api/project/citations/sync-youtube` |

### 2-3. stats API 응답 데이터 형태 (`StatsData`) — **계층 구조**

```ts
{
  total: number;          // 총 인용 수
  uniqueDomains: number;  // 고유 도메인 수
  totalPrompts: number;   // 프롬프트 수
  categories: CategoryData[];   // Category > Subcategory > Domain > URL 4단 계층
}

CategoryData    = { name, count, percentage, subcategories: SubcategoryData[] }
SubcategoryData = { name, count, domains: DomainData[] }
DomainData      = { domain, count, avgVolume, promptCount, urls: CitationURL[] }
CitationURL     = { url, title, count, aiProvider, aiModel, funnelStage, volume,
                    queryCreatedAt, promptText, promptTexts[], channelTitle?, channelId? }
```

> 언급 분석은 flat한 `brands[]` 인 반면, 인용 분석은 **Category → Subcategory → Domain → URL** 4단 트리.
> 카테고리/서브카테고리는 `citation_analysis`에 LLM이 분류해 둔 `category`/`subcategory` 컬럼 기반.

### 2-4. stats API 집계 로직 (`app/api/project/citations/stats/route.ts`)

1. `citation_analysis`를 **페이지네이션(10000행 단위)** 으로 필터 적용해 전부 조회
   - 컬럼: `url, domain, title, category, subcategory, ai_provider, ai_model, funnel_stage, prompt_volume, query_created_at, prompt_text, custom_attr_1, custom_attr_2`
   - 필터: 날짜(`query_created_at`), category, ai_provider/model, funnel_stage, volume, domainSearch(ilike), customAttr1~3
2. `totalPrompts` 계산 — 날짜 필터 시 `prompt_queries`를 **200 UUID씩 chunk + 1000행씩 페이지네이션** (큰 `.in()` URL이 70KB 넘어 silently null 반환되는 이슈 회피 — 코드 주석에 명시)
3. **YouTube 보강**: `domain === 'youtube.com'` 인 URL은 `video_id` 추출 후 `youtube_video_metadata`에서 채널명/ID 조회 (없으면 custom_attr fallback)
4. **메모리에서 4단 계층 Map 구성** → count 집계, avgVolume, 고유 프롬프트 수, URL 중복 머지(promptTexts Set)
5. 각 계층 `count` desc 정렬, category `percentage` 계산

### 2-5. 화면에 보여주는 것

**(a) 필터 패널** — 날짜, 도메인 검색, Category, AI Provider/Model, Funnel Stage, Volume, Custom Attr 1~3
> 필터 옵션(provider/model/funnel)은 `stats` 응답을 `useMemo`로 순회해 추출. Custom Attr 값만 별도 `unique-attributes` API.

**(b) 요약 카드 3개** — Total Citations / Unique Domains / Categories

**(c) 트렌드 차트** (`CitationsTrendChart`)
- `trends` API: 일자별 Top 10 도메인의 인용 수. 응답: `{ ..., trendData:[{date, domainCounts:{[domain]:n}, totalCount}] }`
- 기본 범위 최근 30일, 메인 필터와 독립

**(d) 메인 테이블** "Domains" (`CitationsDomainsTable`)

| 컬럼 | 의미 |
|------|------|
| Rank / Domain / Category | 순위, 도메인, `Category / Subcategory` |
| Citations | 인용 수 |
| Share % | 인용 ÷ 전체 인용 |
| Prompts | 고유 프롬프트 수 |
| Coverage Rate | 인용 프롬프트 ÷ 전체 프롬프트 |

- 정렬 가능, **Export All** 지원
- **드릴다운 (도메인 행 → 2가지 펼침)**:
  - URL 목록: `domain-details` API → Path/Title/Citations/Share/Prompts/Total Volume (URL 정렬 가능), YouTube면 `sync-youtube`로 채널정보 보강
  - 프롬프트 목록: `domain-prompts` API → Prompt/AI Models/Citations → 프롬프트 클릭 시 `prompt-details`로 상세

**(e) 파이 차트 2개**
- 좌: `Citations by Category` (조각 클릭 시 드릴다운)
- 우: 선택된 카테고리의 `Subcategories` (없으면 전체 서브카테고리)
- 색상: `COLORS` 팔레트 10색 (`types.ts`)

---

## 3. 언급 vs 인용 — 한눈 비교

| 항목 | Brand Mentions (언급) | Citation Sources (인용) |
|------|----------------------|------------------------|
| 질문 | "AI 답변에 어떤 **브랜드**가 얼마나?" | "AI가 어떤 **출처**를 근거로?" |
| 원천 테이블 | `brand_mentions` | `citation_analysis` |
| 집계 단위 | brand_name (flat 리스트) | Category→Subcat→Domain→URL (트리) |
| 핵심 지표 | Mentions, Share%, Avg.Position, Mention Rate, Sentiment, Mention Type | Citations, Share%, Coverage Rate, Category 분포 |
| 트렌드 키 | `brandCounts` | `domainCounts` |
| 특수 처리 | tracked_brands alias 병합 배지 | YouTube 채널 메타 보강, LLM 카테고리 분류 |
| 시각화 | 테이블 + 라인 트렌드 | 테이블 + 라인 트렌드 + **파이(카테고리/서브카테고리)** |

---

## 4. 개발자가 알아야 할 구현상 주의점 (코드 근거)

1. **집계는 DB가 아니라 앱 메모리에서 수행** — stats API들이 raw row를 다 가져와 JS Map으로 집계.
   대용량 프로젝트에서 메모리/응답시간 부담 → 향후 DB 집계(RPC/뷰) 이전 고려 대상.
2. **`.in()` URL 길이 제한 회피 패턴이 곳곳에 존재** —
   - mentions/stats: `BATCH_SIZE = 200`
   - citations/stats: `PROMPT_ID_CHUNK = 200`, `ROW_PAGE = 1000`
   - 주석: *"200 UUIDs ~= 8KB URL, 큰 .in()은 70KB 넘어 PostgREST/proxy 한계로 silently null 반환"*
   → 새 쿼리 작성 시 동일 패턴 필수.
3. **페이지당 10000행 limit** — mentions는 batch당 10000, citations는 10000 페이지네이션 루프.
   초대형 데이터셋에서 10000 초과 누락 가능성 점검 필요(mentions batch는 `.limit(10000)` 단일).
4. **stats와 trends는 날짜 범위가 독립** — 메인 테이블과 트렌드 차트가 서로 다른 기간을 볼 수 있음(의도된 동작).
5. **공유 리포트(shareToken) 분기** — 테이블 컴포넌트들은 `shareToken`이 있으면 `/api/report/{shareToken}/data?type=...`로,
   없으면 일반 `/api/project/...`로 호출. 신규 드릴다운 추가 시 양쪽 경로 모두 지원해야 함.
6. **YouTube 보강 의존성** — citations에서 youtube.com 도메인은 `youtube_video_metadata` 테이블/`sync-youtube`에 의존.
   메타 없으면 `custom_attr_1/2` fallback (코드에 임시 fallback 주석 있음 — 정리 대상).
7. **인용 데이터는 사전 실행 필요** — `citation_analysis`는 Overview의 "Analyze Citations" 실행으로 채워짐.
   비어 있으면 안내 메시지만 표시.

---

## 5. 관련 파일 인덱스

```
app/dashboard/project/[id]/
├── brand-mentions/
│   ├── page.tsx                      # 상태/필터 오케스트레이션
│   └── _components/
│       ├── MentionsFiltersPanel.tsx
│       ├── MentionsTrendChart.tsx
│       ├── MentionsBrandsTable.tsx   # 메인 테이블 + 2단 드릴다운
│       └── types.ts                  # StatsData/BrandData/TrendData
└── citations/
    ├── page.tsx                      # 상태/필터 + 요약카드 + 파이차트
    └── _components/
        ├── CitationsFiltersPanel.tsx
        ├── CitationsTrendChart.tsx
        ├── CitationsDomainsTable.tsx # 메인 테이블 + 다단 드릴다운
        └── types.ts                  # 4단 계층 StatsData

app/api/project/
├── mentions/{available-dates, stats, trends, brand-prompts, brand-citations}/route.ts
└── citations/{available-dates, unique-attributes, stats, trends,
              domain-details, domain-prompts, prompt-details, url-prompts, sync-youtube}/route.ts
```
