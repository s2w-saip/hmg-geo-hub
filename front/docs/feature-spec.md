# HMG GEO 모니터링 — 기능·화면 명세서

> 생성형 엔진 최적화(GEO) 측정 대시보드. Answer scope 측정 엔진 위의 thin client + BFF.
> 본 문서는 **현재까지 구현 완료된 화면 기준** 명세이며, 코드(`app/[locale]/(dash)/**`)에서 직접 추출했다.
> 기준일: 2026-06-19 · 작성 근거: page.tsx / `_components` / `lib/auth` / `messages/ko.json`

---

## 1. 개요

- **제품 정의**: Hyundai·Kia·Genesis(HMG)의 AI 검색(ChatGPT, Gemini 등) 노출·인용·전환을 측정·시각화하는 모니터링 대시보드. "GEO"는 Generative Engine Optimization이며 지리 데이터가 아니다.
- **측정 로직**: 별도 측정 엔진 `scope`에 위치. 본 앱은 인증, 역할별 범위 뷰, BFF, 시각화만 담당.
- **데이터 성숙도 3계층**: ① **라이브**(scope BFF / GA4) → ② **집계 미러**(DB scope-aggregates) → ③ **샘플 fixture**(데모용). 화면별 성숙도는 §7 참조.

---

## 2. 정보구조(IA) & 네비게이션

GNB(상단 그룹) → SNB(좌측 트리)로 2~3 depth 구성. **메뉴 라벨(GNB·SNB)은 ko/en 로케일 모두 영문으로 통일** — 정본은 `messages/{ko,en}.json::nav` (두 파일 동일 값). 아래 트리는 그 영문 라벨 기준이다.

```
Standard (전사 표준 프롬프트 기준 집계)
├─ Dashboard                /dashboard
├─ Standard prompts         /standard/prompts            (읽기 전용)
├─ Answer analysis          /standard/answer-analysis
│   ├─ Mention              …/mention
│   └─ Citation             …/citation
├─ AI Agent Funnel          /standard/ai-funnel          (→ acr 리다이렉트)
│   ├─ AI Visibility        …/visibility                 (SNB 숨김 — mock-only)
│   ├─ ACR                  …/acr
│   └─ AI Conversion        …/conversion
└─ Customer interest        /customer-interest           (→ google-keywords 리다이렉트)
    ├─ Google keywords      …/google-keywords
    └─ Social Scraping      …/social-scraping

Project (개별 프로젝트 범위)
├─ Project list             /projects
├─ Create project           /projects/new
└─ Project detail           /projects/[id]
    ├─ Dashboard            /projects/[id]
    ├─ Intent               …/intent          (→ google-keyword 리다이렉트)
    │   ├─ Google Keyword   …/intent/google-keyword
    │   └─ Social Scraping  …/intent/social-scraping
    ├─ Prompt               …/prompt
    ├─ AI Agent Funnel      …/ai-funnel/{visibility,acr,conversion}
    ├─ Analysis             …/analysis/{mention,citation}
    ├─ Member               …/member
    └─ Setting              …/setting

Admin (admin 전용)
├─ User management          /admin
└─ Standard config          /admin/standards            (→ prompts 리다이렉트)
    ├─ Standard prompts     …/standards/prompts
    └─ Customer interest config   …/standards/customer-interest
```

> **표준 뷰 ↔ 프로젝트 뷰는 동일 컴포넌트(VisibilityView/AcrView/ConversionView/MentionsView/CitationsView)를 공유**한다. 차이는 범위뿐: 표준은 전사 집계 후 필터, 프로젝트는 해당 프로젝트의 브랜드/국가로 잠금(Dimension Lock Chip).

---

## 3. 역할 · 화면 접근 매트릭스

역할 5종: `admin / hq / region / country / vendor`. 접근(어디 갈 수 있나)은 `lib/auth/route-policy.ts`, 데이터 범위(무엇을 보나)는 `lib/auth/scope-policy.ts::deriveScopeFilter`에서 결정. **클라이언트가 보낸 위치 파라미터는 무시**한다.

### 3.1 메뉴 가시성 · 데이터 범위

| 역할 | 메뉴 | 데이터 범위 (브랜드 × 권역 × 국가) | 필터 잠금 |
|---|---|---|---|
| **admin** (이노션/시스템 관리자) | 표준 + 프로젝트 + 관리자 | 전체 × 전체 × 전체 (제한 없음) | 잠금 없음 |
| **hq** (본사) | 표준 + 프로젝트 | 자사 브랜드(고정) × 전체 × 전체 | 브랜드 |
| **region** (권역/법인 담당) | 표준 + 프로젝트 | 자사 브랜드 × 자기 권역 × 전체 | 브랜드 + 권역 |
| **country** (국가 실행 담당) | 표준 + 프로젝트 | 자사 브랜드 × 자기 권역 × 자기 국가 | 브랜드 + 권역 + 국가 |
| **vendor** (GEO 수행사) | 프로젝트만 | 할당된 범위 (미할당 시 접근 불가) | 할당 범위 내 선택 |

### 3.2 필터 잠금 UI 정책 (`isDimensionLockedByRole` / `resolveDimensionState`)

| 차원 | admin | hq | region | country |
|---|---|---|---|---|
| 브랜드 | 🔓 자유 | 🔒 고정 | 🔒 고정 | 🔒 고정 |
| 권역 | 🔓 자유 | 🔓 자유 | 🔒 고정 | 🔒 고정 |
| 국가 | 🔓 자유 | 🔓 자유 | 🔓 자유 | 🔒 고정 |

- 🔓 열림: 드롭다운 활성, 선택 가능 / 🔒 잠금: 비활성, 현재 범위 값만 회색 표시(왜 좁혀졌는지 사용자가 인지).
- **GEO 스냅샷**(권역별 비교 카드)은 admin/hq에만 노출 — region/country는 권역·국가가 1개로 고정되어 비교 의미가 없으므로 숨김.

### 3.3 범위 필터링 규칙

- admin → 필터 없음(전 행). non-admin → `{brands, regions, countries}` 배열로 `inArray` 필터.
- **브랜드 null 행(공통 프롬프트)** 은 모든 브랜드-scoped 사용자에게 노출. 단 **권역/국가 null 행은 명시적 일치만** 통과(자동 pass 없음).
- DB는 RLS 미사용 → `lib/db/scoped.ts::scopeWhere`(default-deny)가 보상 통제. 순수 함수 `isInScope`와 SQL 술어가 동일하게 단위 테스트됨.

---

## 4. 화면 명세 — 표준(전사) 뷰

### 4.1 성과 요약 (대시보드) · `/dashboard`
- **목적**: HMG 전사 AI 검색 가시성 핵심 지표 + 시장별 경쟁 현황을 한눈에.
- **구성**: 차원 필터 패널(지역/엔진/프롬프트 맥락/카테고리, sticky) · **7개 KPI 타일**(노출률·점유율·우호도·우선노출도·인용점유율·타겟URL인용률·AI유입전환율, 호버 시 정의/산식 툴팁) · 측정 기준 시계열 추이 차트(주/일 버킷 정규화) · GEO 스냅샷 카드(권역→국가 점유율/순위) · 경쟁 가시성 랭킹(도메인 인용·브랜드 언급 2열, 왕관 배지로 HMG 강조).
- **데이터**: scope BFF + DB 미러 + GA4(전환 KPI). 필터는 URL 파라미터.
- **③ 우호도 단위(2026-07-29)**: 답변 단위 우세(dominant) 분류가 아니라 **언급 단위 긍정률** — 당사 언급에 매겨진 감정 신호 합에서 `긍정 ÷ (긍정+중립+부정+혼합) × 100`(Scope 정본 `getTrackedKpiAggregate` 정렬). 신호 합 0이면 0%가 아니라 "측정 대기". 답변분석 감정 분포의 긍정 세그먼트 비율과 항상 동일(parity), 부정 언급 비율은 같은 분모의 부정 세그먼트다.
- **상호작용**: 필터 변경 시 Suspense 경계 내 콘텐츠만 갱신(이전 결과 유지). 미측정 KPI는 "측정 대기" 칩, null 처리로 실측만 노출. 시계열 미비 시 안내 메시지.

### 4.2 표준 프롬프트 · `/standard/prompts` (읽기 전용)
- **목적**: 표준 측정 프롬프트 카탈로그 열람(CRUD는 관리자 전용).
- **구성**: 총 건수 + 테이블(카탈로그ID/프롬프트명/설명/적용범위). 세션 scope 기반 자동 필터(예: kia-fr 계정은 Kia 프롬프트만).
- **데이터**: DB `listStandardCatalogScoped`.

### 4.3 답변 분석 > 언급 분석 · `/standard/answer-analysis/mention`
- **목적**: AI 답변에서 우리 브랜드가 얼마나/어떻게 등장하는지(Brand Mentions).
- **구성**: 필터(지역/엔진/맥락/브랜드포함/리스트타입/Depth) · 브랜드 검색 · 요약 카드 3종(총 언급/유니크 브랜드/총 프롬프트) · 브랜드 테이블(언급수·점유율·평균순위·프롬프트수·언급률, 정렬/드릴다운/CSV) · 행 클릭 시 프롬프트별 드릴다운.
- **데이터**: scope BFF(`fetchStandardMentions`, **LIVE only, 샘플 없음**).
- **준비 중**: 감정/유형 분석, 일별 시계열(classification backfill·scope 시계열 갭 대기).

### 4.4 답변 분석 > 인용 분석 · `/standard/answer-analysis/citation`
- **목적**: AI 답변이 인용하는 도메인 출처 분포 + 타겟 URL 정확도.
- **구성**: 필터 + 도메인 검색 + 요약 카드 3종 + 도메인 테이블(순위·인용수·점유율·프롬프트수·커버리지율) + 파이 차트 + 2모드 드릴다운(URLs / Prompts, Answer Modal 상세).
- **데이터**: scope BFF(`fetchStandardCitations`, **LIVE only**). 카테고리 taxonomy·시계열은 준비 중.

### 4.5 AI Agent Funnel — 3단계
3계단이 순차 영향도를 측정한다.

| 단계 | 경로 | 핵심 질문 / KPI |
|---|---|---|
| **AI 가시성** | …/ai-funnel/visibility | AI 엔진이 우리 페이지를 실제로 **읽는가**(AI Crawl vs SEO) |
| **ACR 선택률** | …/ai-funnel/acr | AI 최종 추천에서 우리 브랜드가 **선택되는가**(Top1/Top5 ACR%) |
| **AI 유입 전환** | …/ai-funnel/conversion | AI 경유 방문이 실제 **행동으로 이어지는가**(GA4 전환율) |

- **가시성**: 4분면 진단 카드(Star / AI Gap / SEO Gap / Dead Zone) + Scatter(X=SEO 노출, Y=AI 크롤, 중앙값 4분면) + 페이지 테이블. 임계값은 분위수 기반 동적 계산.
  - **⚠️ SNB 숨김 (2026-06-23, 표준·프로젝트 양쪽)**: 두 축(GSC SEO 노출 + AI 봇 크롤 로그)은 **scope 측정 surface 밖**이라 채울 DB 데이터가 없고, 현재 UI는 `SAMPLE_VISIBILITY_PAGES` 하드코딩 fixture로만 동작(view에 `aggregateVisibility*` 미존재, 분위수 동적 분류도 ReferenceLine 위치에만 적용). 실데이터 파이프라인(GSC API + 서버 access-log) 합의·연동 전까지 메뉴에서 숨김. **라우트 접근은 유지**(부모 `…/ai-funnel`은 acr로 리다이렉트). 복원 지점: route-policy `hidden` 플래그 + sidebar `PROJECT_SUB_ITEMS` 리프 + 양쪽 redirect 대상. → 백로그 #7 데이터 컨트랙트 의존.
- **ACR**: 브랜드 필(Top1/Top5 ACR%) + KPI 카드 4종 + 시계열(브랜드 비교) + Battle Grid(프롬프트×모델 최종 선택) + Model Conversion 표(shortlist→top1) + Territory Map(언어×모델 지배 현황). 데이터: DB(Brand Mentions 백로그).
- **AI 유입 전환**: KPI 카드 3종(AI 전환율·일반 전환율·Lift±pp) + 시계열. **모드별 조건부 렌더링** — Country-leaf+GA4매핑: 페이지별 표+단일 KPI / Country-leaf+미매핑: "GA4 미연동 시장" 안내 / Region·HQ: 국가별 표+가중 합산 KPI+커버리지 / 샘플 fixture: 데모. 데이터: **GA4 라이브**(28일 집계) + DB fallback 샘플.

---

## 5. 화면 명세 — 프로젝트 뷰

### 5.1 프로젝트 목록 · `/projects`
- 대기 초대 패널(수락/거절) · 집계 타일 4종(전체/활성멤버/최근7일 신규/실행대기 프롬프트) + 브랜드·국가 분포 차트 · 프로젝트 카드 그리드(소유권/도메인/프롬프트수/멤버수) · 검색+역할필터+정렬(4축). admin은 전체, 일반은 소속만. 데이터: DB.

### 5.2 프로젝트 만들기 · `/projects/new`
- 5필드 폼(이름·설명·도메인·브랜드·국가). 브랜드/국가 드롭다운은 **scope 권한으로 필터된 옵션**. 제출 시 scope 재검증 → Project + ProjectMember(Owner) 삽입 → 상세로 리다이렉트. vendor가 scope 미할당이면 옵션이 비어 생성 차단.

### 5.3 프로젝트 현황 · `/projects/[id]`
- 차원 필터(지역/엔진/맥락) · 요약 타일 4종(프롬프트수·후보수·멤버수·마지막 AI 실행) · KPI 7종(프로젝트 scope, live) · 프롬프트 상태 분포 막대 · 최근 후보/프롬프트 2열 · 빠른 액션 3링크. 데이터: DB + scope BFF.

### 5.4 프로젝트 AI 퍼널 / 답변 분석 · …/ai-funnel/\*, …/analysis/\*
- 표준 뷰와 **동일 컴포넌트**, 브랜드/국가가 프로젝트 값으로 잠김(Dimension Lock Chip). 헤더는 PageHeader 대신 인라인 h2.
- **현재 상태**: 가시성/ACR/Conversion은 `loadProjectFunnelContext`로 동작. **언급/인용도 라이브** — `fetchProjectMentions`/`fetchProjectCitations`(withProject seam)가 프로젝트 scope 미러(scope_runs→answers→mentions/citations)를 집계해 렌더한다. `scope_project_id`가 없거나 미러 답변이 0인(미측정) 프로젝트만 EmptyState. (검증 2026-07-24: CCI GEO PoC 언급 4,401·브랜드 49·프롬프트 217 실데이터 렌더)

### 5.5 프롬프트 · `/projects/[id]/prompt`
- 2열: 좌측 후보 풀(다중 선택→선정, 출처 배지 google_keyword/social_scraping/manual) / 우측 수동 입력. 하단 전체 프롬프트 테이블(텍스트/타입/카테고리/상태, 인라인 편집, CSV). "저장+실행" → 대기 프롬프트 실행 트리거 후 Analysis로 이동. Owner만 편집, Viewer 읽기 전용.

### 5.6 멤버 · `/projects/[id]/member`
- 초대 폼(이메일, Owner만) · 멤버 테이블(이메일/역할/상태/초대일시, 권한 변경·제거) · 감사 로그(행위자/대상/액션/컨텍스트, 최근 20). Owner=CRUD, Viewer=읽기, admin=전 프로젝트 관리.

### 5.7 설정 · `/projects/[id]/setting`
- 일반(이름·설명·도메인·브랜드, Owner만 편집) · 추적 대상(지정 브랜드·모델 2열, 삭제 시 재처리 confirm) · 위험 영역(프로젝트 삭제, Owner만). 비멤버는 404.
- `지정 브랜드`는 프로젝트 분석에 사용할 상위 brand dimension이며, 저장된 값을 "경쟁사 master"로 취급하지 않는다. 경쟁사는 답변에 언급된 브랜드 중 자사 명부에 속하지 않는 항목으로 집계 시 파생한다.
- KPI #16의 선택 토글은 `타겟 경쟁사`가 아니라 `비교 기준 브랜드` 의미이며, 미지정 시에는 해당 집계 창의 외부 브랜드 SOV 1위가 자동 선택된다.

---

## 6. 화면 명세 — 고객 관심(Intent) & 관리자

### 6.1 고객 관심 > 구글 키워드 · `/customer-interest/google-keywords`
- 검색량 추이·SERP 기반 표준 키워드 풀 **읽기 전용** 조회. 키워드 탭 · 기간/국가 필터 · 관련 검색어 트리 · 관심도 추이 차트 + 게이지 · SERP 테이블(순위/URL/제목/스니펫/제안 프롬프트). **데이터: 샘플 fixture(mock), canEdit=false.**

### 6.2 고객 관심 > 커뮤니티 수집 · `/customer-interest/social-scraping`
- 소셜/커뮤니티 언급을 구매 맥락 매트릭스(고객 맥락/구매 조건/컴비네이션)로 가시화. 3스테이지 중 CONTEXT-MAP만 활성(INPUT·EXPLORING 스킵). 각 행 자세히보기 Dialog(인용문/감정/출처). **데이터: 완전 mock(읽기 전용).**

### 6.3 프로젝트 > 관심 파악 > Google Keyword · `/projects/[id]/intent/google-keyword`
- 6.1과 동일 레이아웃이나 **canEdit=true**. 키워드 추가/삭제, 관련 검색어 일괄 추가, SERP 행 "+" → `addCandidate()` Server Action(source=google_keyword)으로 **실제 DB 저장**(성공 시 녹색 체크). **하이브리드**: 프로젝트 메타/권한은 라이브 DB, 키워드/SERP는 mock.

### 6.4 프로젝트 > 관심 파악 > Social Scraping · `/projects/[id]/intent/social-scraping`
- 3스테이지 전부 활성: INPUT(키워드/목적/위치) → EXPLORING(모의 스트림 타임라인, 850ms 틱) → CONTEXT-MAP(매트릭스). 프롬프트 카탈로그 행 → `addCandidate()`(source=social_scraping)로 실제 저장. **하이브리드**: 메타/권한 라이브, 매트릭스·EXPLORING은 mock/시뮬레이션.

### 6.5 관리자 > 사용자 관리 · `/admin`
- 사용자 목록(이메일/역할/허용 범위/생성일/최근 로그인, 검색) · 행 클릭 편집(역할·브랜드/권역/국가 범위·삭제) · 사용자 추가(이메일 → 임시 비밀번호 1회 토스트). 데이터: `profileRepository`. 가드: `canAccessAdmin`.

### 6.6 관리자 > 표준 프롬프트 관리 · `/admin/standards/prompts`
- 통계 스트립(전체/사용중/미추적/scope 단독) · 카탈로그 테이블(프롬프트/유형/브랜드 포함/브랜드/프레임워크 7차원/카테고리/추적상태/액션) · 필터(추적상태/Depth1/퍼널) · 인라인 편집·활성화 토글·CSV. 데이터: `listStandardCatalog`(STANDARD_ROOT_PROJECT_ID prompts ⨝ scope_prompts).

### 6.7 관리자 > 고객 관심 데이터 관리 · `/admin/standards/customer-interest`
- ① 소셜 리서치 플로우(`SocialScrapingFlow mode="admin"`) ② 표준 키워드 카탈로그(키워드/소스/브랜드/메모/활성, 인라인) ③ 표준 소스 URL 화이트리스트(URL/채널/브랜드/메모/활성). 데이터: `standardKeywordRepository`, `standardSourceRepository`.

---

## 7. 데이터 성숙도 요약

| 화면 | 라이브 | 집계 미러 | mock/샘플 | 비고 |
|---|---|---|---|---|
| 성과 요약 | ✅ scope+GA4 | ✅ | — | 시계열 일부 갭 |
| 표준 언급/인용 분석 | ✅ scope BFF | — | — | 감정/유형/시계열 준비 중 |
| 표준 AI 가시성/ACR | — | ✅ DB | — | |
| 표준 AI 유입 전환 | ✅ GA4 | △ fallback | △ | 매핑된 country-leaf만 라이브 |
| 프로젝트 AI 퍼널 | △ | ✅ | — | 가시성/ACR/Conversion 동작 |
| 프로젝트 언급/인용 | ✅ scope BFF(미러) | — | — | 측정 데이터 있는 프로젝트만 라이브, 미측정은 EmptyState |
| 고객 관심(2화면) | — | — | ✅ | 읽기 전용 mock |
| 프로젝트 Intent(2화면) | △ 메타 | — | ✅ SERP/매트릭스 | 후보 저장은 실제 DB |
| 관리자(3화면) | ✅ DB | — | — | |

**미구현/placeholder**: Google Trends·SERP 스크래핑 파이프라인, 실제 커뮤니티 웹 스크래핑+AI 분석(EXPLORING은 시뮬레이션), SERP 재검색 버튼, 프로젝트 scope 미러(언급/인용).

---

## 8. 용어집

| 용어 | 의미 |
|---|---|
| GEO | Generative Engine Optimization — AI 검색 노출 최적화(지리 아님) |
| scope | Answer의 GEO 측정 엔진(별도 시스템). 본 앱은 그 위의 thin client+BFF |
| 표준 프롬프트 | 전사 공통 측정 프롬프트 카탈로그 |
| ACR | Answer Choice Rate — AI 추천에서 브랜드 선택률(Top1/Top5) |
| AI 유입 전환 | GA4 'AI Assistant' 채널 유입의 사이트 내 전환율 |
| Dimension Lock | 역할/프로젝트로 고정된 필터 차원(회색 칩) |
| 권역(RHQ) | Regional HQ — 지역 본부 단위 |
