# 16주차 IA 최신화 — AS-IS / TO-BE (WBS 0 · 전체 메뉴트리 정의)

> 정본 = **앱 현재 구현**(route-policy.ts `ROUTES` + sidebar.tsx `*_SUB_ITEMS` 트리, 2026-07-24 실측).
> 목적 = 16주차 지표 고도화(Dimension 시각화·도메인 인용수·경쟁 추이·Core 시각화)를 **어디에 배치할지** 확정하고, 현재 IA의 숨김·단일자식 부채를 정리.
> 범위 = GNB(1depth 그룹) + 각 그룹 SNB(2·3depth) + 프로젝트 상세 서브내비. 데이터·권한 로직은 별도 트랙.

---

## 1. AS-IS — 현재 메뉴트리 (정본)

**GNB 1depth** = 역할별 노출 그룹 4개. 순서 `Global → Website → Project → Admin`.
역할: `hq / region / country`(내부 3역), `admin`(슈퍼), `vendor`(외부 수행사), `website`(사이트 전용 열람).

```
Global (group: standard) — hq·region·country·admin
├─ Dashboard                         /dashboard
├─ Global prompts                    /standard/prompts
├─ Answer analysis                   /standard/answer-analysis  → Mention 리다이렉트
│  ├─ Mention                        /standard/answer-analysis/mention
│  └─ Citation                       /standard/answer-analysis/citation
├─ AI Agent Funnel                   /standard/ai-funnel        → ACR 리다이렉트
│  ├─ AI Visibility                  /standard/ai-funnel/visibility   ⚠ 숨김(mock-only)
│  ├─ ACR                            /standard/ai-funnel/acr
│  └─ AI Conversion                  /standard/ai-funnel/conversion
└─ Customer interest                 /customer-interest         ⚠ 그룹 전체 숨김
   ├─ Google keywords                /customer-interest/google-keywords   ⚠ 숨김
   └─ Social Scraping                /customer-interest/social-scraping   ⚠ 숨김

Website (group: website) — + website 역할
├─ Dashboard                         /website
├─ Prompts                           /website/prompts   (웹사이트 전용 카탈로그)
├─ Answer analysis                   /website/answer-analysis
│  ├─ Mention                        /website/answer-analysis/mention
│  └─ Citation                       /website/answer-analysis/citation
└─ AI Agent Funnel                   /website/ai-funnel  → Conversion 리다이렉트
   ├─ ACR                            /website/ai-funnel/acr           ⚠ 숨김(ACR은 Global 전용)
   └─ AI Conversion                  /website/ai-funnel/conversion

Project (group: project) — + vendor
├─ Project list                      /projects
└─ (새 프로젝트 마법사               /projects/new  — 숨김, /projects CTA로 진입)
   └─ 〈프로젝트 상세〉 /projects/[id]/*
      ├─ Dashboard                   (bare)
      ├─ Intent
      │  ├─ Google Keyword           intent/google-keyword
      │  └─ Social Scraping          intent/social-scraping
      ├─ Prompt                      prompt
      ├─ Analysis
      │  ├─ Mention                  analysis/mention
      │  └─ Citation                 analysis/citation
      ├─ AI Agent Funnel
      │  ├─ AI Visibility            ai-funnel/visibility   ⚠ 숨김(mock-only)
      │  ├─ ACR                      ai-funnel/acr          ⚠ 숨김(ACR은 Global 전용)
      │  └─ AI Conversion            ai-funnel/conversion   ← 유일 노출 자식
      └─ Setting
         ├─ General                  setting
         └─ Member                   member

Admin (group: admin) — admin 전용
├─ User management                   /admin
├─ Global config                     /admin/standards
│  ├─ Global prompts                 /admin/standards/prompts
│  ├─ Customer interest config       /admin/standards/customer-interest
│  └─ Entity catalog                 /admin/standards/entities
└─ Keyword tools                     /admin/keyword-tools
```

### AS-IS에서 드러나는 IA 부채

| # | 현상 | 원인 | 영향 |
|---|---|---|---|
| D1 | **AI Visibility** 3면(Global·Project) 모두 숨김 | Y축(AI 크롤 로그) 데이터 부재 → mock-only (정합 #2) | 코어 KPI "노출률"의 상세 뷰가 없음. 이 뷰 안에 **SOV×우호도 산점(Core 시각화)이 갇혀 있음** |
| D2 | **AI Agent Funnel**(Project) = 자식 3개 중 2개 숨김 → 노출은 **AI Conversion 1개뿐** | Visibility·ACR 숨김 | 부모-단일자식 트리 = 불필요한 깊이 |
| D3 | **Customer interest**(Global) 그룹 전체 숨김 | 표준(전사 측정)과 성격 상이 → 프로젝트 Intent가 동일 컴포넌트 재사용 | Global GNB엔 없고 Project·Admin에만 사실상 존재 |
| D4 | **ACR** Website·Project 숨김, Global만 노출 | ACR은 전사 측정 지표로 한정 | 면별 퍼널 구성 불일치(의도된 것이나 문서화 필요) |

---

## 2. 16주차 신규/변경 요소 → IA 배치 필요성

정본 로드맵 = `docs/kpi-menu-mapping.md` §2.2. as-is 감사(2026-07-24) 결과 Core 분자·분모·Sub 집계·#16은 이미 구현, **진짜 남은 것은 아래 시각화 4종**.

| 요소 | 성격 | 신규 화면? | 배치 후보 |
|---|---|---|---|
| **Dimension 교차 시각화** (주제×경쟁사×AI엔진 셀별 노출률·SOV·우호도·우선노출도 히트맵) | 미러 재집계 + 신규 뷰 | ✅ **신규 메뉴 필요** | Answer analysis 하위 신규 leaf |
| **도메인 인용수 다축** (경쟁사×엔진×하위URL별 인용수) | 기존 Citation 뷰 심화 | ❌ 메뉴 불필요 | Citation 뷰 내부 확장 |
| **Core 시각화** (SOV×우호도 산점) | 이미 구현(visibility-view) — 단, 숨김 뷰에 갇힘 | ❌ 이전만 | Dashboard로 승격(D1 동반 해소) |
| **경쟁사 비교 추이 확대** (노출률·SOV·우호도·우선노출도 브랜드 시계열) | 기존 추이 확장 | ❌ 메뉴 불필요 | Dashboard/Mention 추이 내 확장 (scope 시계열 갭 의존) |

→ **순 신규 메뉴는 "Dimension" leaf 1종뿐.** 나머지는 기존 화면 심화(메뉴 변화 없음). IA 변경 최소화.

---

## 3. TO-BE — 개정 메뉴트리

변경 범례: **[+] 신규 · [↑] 승격(숨김→노출) · [~] 뷰 내부 심화(메뉴 불변) · [⇱] 평탄화 · [=] 현행 유지**

```
Global (standard)
├─ Dashboard                         [~] Core 산점(SOV×우호도) 승격 + 경쟁 추이 확장
├─ Global prompts                    [=]
├─ Answer analysis
│  ├─ Mention                        [~] 경쟁사 브랜드 시계열 확장
│  ├─ Citation                       [~] 도메인 인용수 다축(경쟁사×엔진×하위URL)
│  └─ Dimension                      [+] 주제×경쟁사×엔진 교차 히트맵  ★16주차 신규
├─ AI Agent Funnel
│  ├─ ACR                            [=]
│  └─ AI Conversion                  [=]
│     (AI Visibility [↑] — 뷰는 은퇴, 산점은 Dashboard로 이관 → D1 해소)
└─ Customer interest                 [=] 현행 숨김 유지(Project Intent가 실사용 홈)

Website (website)
├─ Dashboard                         [~] Core 산점 승격(Global과 동일 컴포넌트 재사용)
├─ Prompts                           [=]
├─ Answer analysis
│  ├─ Mention                        [~]
│  ├─ Citation                       [~] 도메인 인용수 다축
│  └─ Dimension                      [+] 교차 히트맵  ★16주차 신규
└─ AI Agent Funnel
   └─ AI Conversion                  [=] (ACR 숨김 유지)

Project (project) — 〈프로젝트 상세〉
├─ Dashboard                         [~] Core 산점 승격
├─ Intent (Google Keyword / Social Scraping)   [=]
├─ Prompt                            [=]
├─ Analysis
│  ├─ Mention                        [~]
│  ├─ Citation                       [~] 도메인 인용수 다축
│  └─ Dimension                      [+] 교차 히트맵  ★16주차 신규
├─ AI Conversion                     [⇱] 단일자식 "AI Agent Funnel" 평탄화 → 직접 leaf (D2 해소)
└─ Setting (General / Member)        [=]

Admin (admin)                        [=] 16주차 IA 변경 없음
```

### 변경 요약표

| 그룹·위치 | 변경 | 유형 | 근거 |
|---|---|---|---|
| Answer analysis > **Dimension** (Global·Website·Project) | 신규 leaf | [+] | 16주차 flagship. Mention/Citation과 같은 미러 위 교차 분석이라 Answer analysis에 귀속 |
| Citation 뷰 (3면) | 도메인 인용수 다축 패널 | [~] | 인용의 심화 — 별도 메뉴 불필요 |
| Dashboard (3면) | SOV×우호도 산점 표시 | [↑] | Core KPI 타일과 같은 자리에 Core 시각화. D1(산점이 숨김 뷰에 갇힘) 동시 해소 |
| Dashboard/Mention 추이 (3면) | 경쟁사 시계열 확장 | [~] | scope 시계열 갭 해소 시. 메뉴 불변 |
| Project **AI Conversion** | 부모 평탄화 | [⇱] | 단일 노출 자식(D2) — 부모 없이 직접 leaf가 더 얕고 명확 |
| Global **AI Visibility** 뷰 | 메뉴 은퇴 확정 | [↑/retire] | mock-only(정합 #2). 유용한 산점만 Dashboard로 이관, 라우트는 재사용 위해 존치 |

---

## 4. 미결 결정 포인트 (사용자 확정 필요)

1. **Dimension leaf의 이름·위치**
   - (A·추천) Answer analysis 하위 3번째 자식 "Dimension"(교차 분석)
   - (B) 독립 2depth 섹션 "심층 분석 / Deep dive"로 승격(향후 Core 산점·경쟁추이까지 모아 담기)
   - → A는 IA 최소 변경, B는 확장 여지. 어느 쪽?

2. **AI Visibility 처리**
   - (A·추천) 메뉴 영구 은퇴 + 산점만 Dashboard 이관
   - (B) GSC + citation 재정의(옵션2)로 Y축 복원해 부활 — 별도 데이터 트랙
   - → 16주차 IA에선 A로 두고 B는 백로그?

3. **Project AI Conversion 평탄화**(D2) — 단일자식 부모 제거에 동의? (라벨/URL 유지, 트리 깊이만 감소)

4. **경쟁 추이 확장**은 scope 시계열 갭 의존 — 16주차 IA엔 "예정" 표기만, 실배선은 갭 해소 후?

---

## 5. 반영 지점 (확정 후 코드 변경 맵)

- **route-policy.ts `ROUTES`**: `*/answer-analysis/dimension` 3건 추가(Global·Website·Project는 상세 서브내비라 sidebar만). Project AI Conversion 평탄화 시 부모 표기 조정.
- **sidebar.tsx**: `STANDARD_SUB_ITEMS`·`WEBSITE_SUB_ITEMS`의 Answer analysis children에 Dimension 추가. `PROJECT_SUB_ITEMS` analysis children에 dimension 추가 + ai-funnel 단일자식 평탄화. `ROUTE_ICON`에 dimension 아이콘(예: `Grid3x3`).
- **messages/{ko,en}.json**: `nav.answerAnalysisDimension` / `nav.projectDetail.analysisDimension` 라벨.
- **신규 뷰 컴포넌트**: `standard/answer-analysis/_components/dimension-view.tsx`(집계는 mentions 미러 재집계, 축 조합만 추가) — Website·Project가 재사용.
- **Dashboard**: `SummaryTiles` 인근에 Core 산점 컴포넌트(visibility-view의 ScatterChart 추출·재사용).

> 이 문서는 **as-is=코드 실측 / to-be=제안**. §4 확정 후 §5 순서로 배선. 신규 KPI 그룹핑·카테고리는 1.1.2 별도.
