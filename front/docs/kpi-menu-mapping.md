# 메뉴별 KPI 매핑 + 고도화 계획 (WBS 1.1.1)

> 상태: **v3 (2026-07-31, 현재 main=016cbff 기준 갱신)** · 정본 = 앱 현재 구현(실측), Confluence GVN 61210634(v1.1)는 16주차~ 지표 고도화 로드맵(참조).
> 완료 기준: Global / Website / Project별 KPI 세트 합의(=현재 앱 실측) + 고도화 계획.
>
> v3 갱신 요지(이번 세션 반영): ① Dimension 교차 시각화는 만들었다가 **롤백**됨(#17) → 다시 갭. ② 프로젝트 구성비(#21·22)는 **이미 구현됨**(project-dashboard). ③ Core 산점은 구현돼 있으나 **숨김 뷰에만** 있어 대시보드 승격 필요. ④ GA4 이벤트 추적 선택·전환 재배선(#19·20), 언급 집계 SQL 성능/crash(#27·28), 필터/차트 정합(#29~33) 신규 반영. 상세 = §2.5.

## 0. 정본·참조 구분

- **1.1.1 현재 정의 = 앱에 개발된 것**(아래 §1, 코드 실측). "무엇을 지금 보여주나"의 baseline.
- **Confluence v1.1(GVN 61210634) = 지표 고도화 목표(16주차~)**. Core 분자·분모 표시, Dimension 시각화, Sub 지표 확장, Action Plan. baseline엔 병합하지 않고 §2 로드맵으로 둔다.

## 1. 면별 KPI 매핑표 (앱 실측 = 정본)

**코어 KPI** (대시보드 `SummaryTiles`가 content/source/conversion 그룹으로 렌더):

| KPI | Global(표준) | Website | Project | 비고(앱 실측) |
|---|:-:|:-:|:-:|---|
| 노출률(Visibility) | ✅ | ✅ | ✅ | |
| 점유율(SOV) | ✅ | ✅ | ✅ | SOV 카드에 **경쟁사 대비 SOV(#16)** 부가행 |
| 우호도(Sentiment) | ✅ | ✅ | ✅ | |
| 우선노출도(Avg Position) | ✅ | ✅ | ✅ | |
| 인용점유율(Citation Share) | ✅ | ✅ | ✅ | |
| 타겟URL인용률(#6) | (타깃 있을 때) | (타깃) | ✅ | Confluence: **프로젝트 중심**. `SummaryTiles`는 미지원 KPI 자동 생략 |
| AI유입전환율(#7) | ✅(GA4 매핑 country-leaf) | ✅ | ✅(GA 매핑 시) | Website·Project 미매핑 시 안내(+프로젝트는 설정 바로가기) |

**퍼널 스테이지** (면별 노출):

| 스테이지 | Global | Website | Project |
|---|:-:|:-:|:-:|
| ACR(선택률) | ✅ | ⬜ 숨김(route-policy) | ✅ |
| 전환 | ✅ | ✅ | ✅ |
| 가시성 | 🔶 숨김 | 🔶 숨김 | 🔶 숨김 (#2: Y축 크롤로그 부재) |

- **Website = Global과 동일 코어 7**(표준 대시보드 컴포넌트 `SummaryTiles`/`GeoSnapshot` 등을 그대로 재사용, 데이터만 오피셜 사이트 스코프+language 필터). 차이 = **ACR·가시성 숨김**. → 앞서 논의한 "Website 인용 4만" 안은 **앱과 불일치라 철회**; "우선노출도 제외·우호도 서브" 등 조정은 고도화/변경 제안으로 별도 다룬다.
- **Project**: 코어 7 전부(#6 포함). 정합 이슈 #1 해결로 언급/인용도 라이브.
- **데이터 성숙도**: 언급/인용 = scope 미러 라이브(측정분) · 전환 = GA4(매핑 시) · ACR = DB · 가시성 = 숨김.

## 2. KPI 고도화 구현 계획 (16주차~, 정본: Confluence GVN 61210634 v1.1)

Semrush/HAVAS 대비 우위 Action Plan을 앱 구현 관점으로 재정리.

### 2.0 as-is 감사 (실측 2026-07-24) — 로드맵 상당수 이미 구현됨

Confluence 반영상태보다 **앱이 앞서 있음**(#1·8주차와 동일 패턴). 코드 실측:

| 로드맵 항목 | 앱 실측 | 근거 |
|---|---|---|
| **8주차 Core 분자·분모 표시** | ✅ **이미 구현** | `dashboard/_data/live.ts::buildMirrorKpis`가 Core ①~⑤(노출률·SOV·우호도·우선노출도·인용점유율)에 `ratio{numerator,denominator}` 채움 + `SummaryTiles` 렌더. #6·#7도 ratio 있음 |
| **Core 분자·분모 — 프로젝트도** | ✅ 구현 | `projects/[id]/_data/live.ts`가 **동일 `buildMirrorKpis` 재사용** → 프로젝트 카드도 ratio 동일 배선(§2.1 잔여 점검 종결) |
| **Sub 집계 #9 미언급·#15 복수언급·#20 Top3** | ✅ 구현(표준+프로젝트) | `live.ts::applySubKpis`가 Core 카드 `subs`로 부착 — `missingPromptCount`·`multiMentionAnswers`·`top3Rate`(+`acrTop1`·`positiveKeywords`·`negativeKeywords`·`engineConsistency`). 프로젝트도 같은 헬퍼 |
| **Core 시각화 — SOV×우호도 산점** | ✅ **이미 구현** | `standard/ai-funnel/_components/visibility-view.tsx` `ScatterChart`(scatter.x/y·median 가이드) |
| **프로젝트 KPI 파리티**(브랜치 목표) | ✅ 완료 | `getProjectDashboard`가 `buildMirrorKpis`+`applySubKpis`+`applyCompetitorSov`+`applyTrendDeltas` 전부 재사용, 모집단만 scopeProjectId로 제한 |
| #16 경쟁사대비SOV | ✅ 구현(표준+프로젝트) | `applyCompetitorSov` — `SummaryTiles` competitorSov 부가행(4.1.7 head-to-head) |
| #21·#22 구성비(주제·출처) | ✅ 구현(표준) | `CompositionPanel` |
| #8 브랜드 언급답변수 | ✅ 구현 | mentions-view 요약(총 언급) |
| 정합 #1 프로젝트 언급/인용 | ✅ 구현 | 측정분 라이브(별도 정정) |

→ 2026-07-24 감사 시점 "유일 갭"이던 Dimension 교차 시각화는 이후 구현(7e77d74)됐다가 **2026-07-31 롤백(#17)** — 현재 main엔 없음(§2.5). 나머지 로드맵 항목은 표준·프로젝트 양면에서 이미 구현됨. 착수 전 각 항목도 이 방식으로 as-is 재확인할 것.

### 2.1 8주차 — Core 분자·분모 표시  ✅ (as-is: 이미 구현, §2.0)
- 표준·프로젝트 모두 `buildMirrorKpis`로 ratio 배선 확인 완료(2026-07-24). 잔여 = 툴팁 문구 정합 미세 점검뿐.

### 2.2 16주차 — Dimension 시각화 · 도메인 인용수 · 경쟁 추이 · Core 시각화

현재 main(2026-07-31) 기준 4종 상태:

- **Dimension 전체 구성 시각화** — ❌ **갭(롤백됨)**: "프롬프트 주제 × 경쟁사 × AI엔진"을 표 하나로 한눈에 보는 매트릭스/히트맵. 지금은 필터로 한 조합씩만 볼 수 있고, 전체를 펼쳐 보는 화면이 없음. 7e77d74로 구현했으나 #17로 롤백 → **재작업하려면 신규 뷰**(집계는 mentions 미러 재집계, 축 조합만 추가).
- **도메인 인용수 다축 분해** — 🔶 **부분 구현**: 도메인별 인용 표(`citation-domain-table`: 인용수/점유율/프롬프트수/커버리지)는 있음. **없는 것 = 경쟁사×엔진×하위URL로 쪼개 보는 분해뷰**. → 기존 표 확장.
- **경쟁사 비교 추이 확대** — 🔶 **외부 의존**: 특정 시점 head-to-head 비교(4.1.7)는 됨. **브랜드별 시계열(주간 추이) 확장은 scope가 시계열 데이터를 안 주는 갭 때문에 대기**.
- **Core SOV×우호도 산점** — ⚠️ **구현됐으나 숨김 뷰에만**: `visibility-view.tsx`에 ScatterChart(중앙값 가이드 포함)로 있으나, 이 화면은 route-policy로 **숨김** 상태 → **대시보드로 승격(노출)**해야 실사용됨.

### 2.3 연말 — 열람·구성비 고도화
- **지표별 프롬프트·답변 열람**: 미언급/우위/열위 답변의 프롬프트·답변 드릴다운(일부 answer-modal·mention drilldown 존재 → 확장).
- **프롬프트 주제별 구성비**(Lv1 주제→Lv2 인텐트), **출처별 구성비**(URL/도메인타입×엔진) 고도화.

### 2.4 Sub 지표 백로그 (Confluence #8~25) — 구현 그룹핑

| 그룹 | KPI | 구현 접근 | 선행 |
|---|---|---|---|
| **집계만 추가**(데이터 있음) | 브랜드 언급답변수(8, 완료)·복수언급(15)·미언급 프롬프트(9)·Top3 노출(20)·경쟁사대비SOV(16, 완료)·구성비(21·22, 표준완료) | mentions/citations 미러 재집계 | — |
| **scope 분류 backfill 의존** | 우호도 기반 부정 언급 비율(19, 언급 단위)·긍/부정 키워드(17·18)·엔진 간 일관성(24) | 감정/유형/순위 분류 데이터 필요 | scope classification backfill(현재 "준비 중") |
| **프로젝트 확장** | ACR(10)·구성비(21·22)·경쟁사대비SOV(16) — **셋 다 프로젝트에도 이미 구현**(project-dashboard가 CompositionPanel·applyCompetitorSov 재사용) | 표준 로직을 프로젝트 scope로 | 프로젝트 미러(#1 해결됨) |
| **2차('27+)** | 내부채널 인용/점유율(11·12)·GEO 가이드 적용률(13)·인용 정확도(23)·페이지 Action(25) | 신규 파이프라인(내부채널·크롤·GA action) | 별도 데이터 컨트랙트 |

### 2.5 현재 main(2026-07-31, 016cbff) 반영 상태 + 남은 범위

**이번 세션에 라이브 반영된 것 (git 완료증거)**

- **GA4 이벤트 추적 선택 + 전환 KPI 재배선**(#19·20): admin/project/website에서 "전환으로 셀 GA4 이벤트"를 골라 저장 → 전환 KPI(#7) 분자가 그 선택으로 계산(선택 없으면 GA4 key events 그대로). 국가(property) 단위로 각 담당자가 편집.
- **언급 집계 성능/장애 해소**(#27·28): 무거운 필터 조합에서 답변분석>언급이 타임아웃(server-side exception)나던 것을 SQL GROUP BY로 전환해 <12s. 이때 언급 숫자가 대시보드 정합값으로 통일됨(승인). 주간 추이도 MATERIALIZED CTE로 정상 표시.
- **필터/차트 정합**(#29~33): 전 차트 툴팁 순위순 정렬+겹침 해소, 추이 시리즈를 "창 내 어느 주차든 top-10" 합집합으로, 프로젝트 카드 긴 이름 깨짐, 그리고 **표준 geography 필터가 실제 측정 국가(루트 6개국)만 표시**하도록 수정(전엔 전 프로젝트 61개가 새어 "유럽 37" 오표시).
- **프롬프트/태그**: 커스텀 태그 열 강제 삭제(#18). (프롬프트 라이프사이클 #26은 팀 병행 머지.)

**현재 남은 고도화 범위**

즉시 착수 가능(데이터 있음):
1. Dimension 교차 시각화 재작업(롤백돼 다시 없음) — 주제×경쟁사×AI엔진 매트릭스 신규 뷰.
2. Core SOV×우호도 산점 **대시보드 승격**(현재 숨김 visibility-view에만).
3. 도메인 인용수 다축 분해(경쟁사×엔진×하위URL) — Citation 뷰 확장.
4. 지표별 프롬프트·답변 드릴다운 확장.

이번 세션 발생 후속·기술부채:
5. 언급 **드릴다운 SQL 전환** — 헤드라인은 SQL(포함적)인데 드릴다운은 아직 JS(과소)라 브랜드별 합이 어긋날 수 있고, 무거운 필터에서 느림.
6. 경쟁사 표기변형 정규화(메르세데스-벤츠↔Mercedes-Benz) — 로컬 정본 이름 소스 없음.
7. root-gate 감사 — #33과 같은 부류(`getLatestMeasuredAt` 등 표준 표면의 다른 옵션/표시 함수도 루트 게이트 적용 확인).

데이터/외부 의존(대기):
- #17·18(긍/부정 키워드)·#19(부정비율)·#24(엔진 일관성) → scope 감정/유형 분류 backfill("준비 중") 의존.
- 경쟁사 비교 추이(시계열) → scope 시계열 갭.
- 가시성(#2) → AI 크롤 로그(Y축) 부재 / GSC 배관 보류.

2차('27+): #11·12 내부채널 인용/점유율 · #13 GEO 가이드 적용률 · #23 인용 정확도 · #25 페이지 Action.

## 3. 참조

- **KPI 고도화 정본(로드맵)**: Confluence GVN 61210634 "[7주차] 피드백 반영 KPI v1.1" — 25 KPI 정의·산식·Tier·반영현황·Action Plan(8/16/연말).
- 가시성(#2): Y축(AI 크롤 로그) 부재 → 옵션 2(scope citation 재정의 + GSC 배관)로 복원 가능. 별도 트랙.
- 신규 KPI 그룹핑/카테고리 = **1.1.2**.
