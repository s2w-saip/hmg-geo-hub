# GA4 / Conversion 백로그 액션플랜

이번 작업(conversion 필터 GA4 데이터화 + 프로젝트 페이지 연동 + 측정대기 빈처리, 커밋 `af83a28`)과 ICT 월간 GA4 리포트 초안(Confluence GVN/48136221) 검토에서 도출된 후속 항목.

- **단위 기준**: 본 리포트(ICT) = 세션 기준 / 전체 트래픽. 우리 GEO conversion = activeUsers 기준 / AI 유입 cohort. 비교 시 단위·관점 차이 항상 전제.
- **현 상태**: conversion 필터(geography·engine·device·visitorType)는 GA4 실배선 + 라이브 검수 통과(engine/device 완벽 파티션, andGroup 정상). 관련: `lib/ga4/conversion.ts`, `lib/ga4/property-map.ts`.

---

## ✅ 확정 신규 sub-KPI — AI 유입 사이트 방문 수

정의·단위·feasibility 확정 (2026-06-25, 라이브 검수 `npm run ga4:probe -- --visits`).

> **정의**: AI 모델(ChatGPT·Gemini·Claude 등)을 통해 유입된 당사 브랜드 사이트 방문 수
> **산식**: AI Assistant 채널의 **세션(sessions) 수** · **단위: 회(Visits)**
> **Dimension**: 입구 페이지(landingPage)별 분해

**단위 = sessions(회) 확정 이유**: sub-KPI는 **core KPI가 안 보여주는 것**을 보는 의도. Core(`trafficConversion`)는 activeUsers 기준 **전환율(%)** — 이 sub-KPI는 일부러 **다른 렌즈**:
1. **절대 유입 규모/추이** — core의 율(%)이 아닌 raw 방문 규모.
2. **방문 빈도(재방문)** — sessions(회)는 재방문 포함. core의 activeUsers(명)는 순방문자라 빈도 못 봄 (실측 sessions/user = 1.18).
3. **페이지별 유입 분포** — 어느 입구 페이지로 AI가 오는지. core 전환율 집계엔 없음.

**Feasibility (Kia/IT 90일 실측)**: AI cohort sessions=146 / activeUsers=124 / pageViews=308. landingPage 30개 분해 정상. cohort 정의(`sessionDefaultChannelGroup = "AI Assistant"`)는 이미 구현됨.

**액션**:
- `conversion.ts`에 AI cohort `sessions` fetch + landingPage별 분해 추가 (activeUsers 인프라 재사용).
- KPI 타일(방문 수, 회) + 추이 + 입구 페이지 테이블.
- 표본 작음 주의(페이지당 1~11회/90일) → 백로그 #3 경고와 연동. landingPage **필터 조합**은 502 위험이므로 단순 dimension read만.

**규모**: 작음. **우선**: 높음.

---

## 우선순위 요약

| # | 항목 | 우선 | 규모 | 의존성 |
|---|---|---|---|---|
| 1 | 속성별 lead event-map (전환 정의) | 높음 | 중 | 속성별 이벤트 목록 |
| 2 | 전환 종류 breakdown / 정의 노출 | 높음 | 중 | #1 |
| 3 | 표본 작음 경고 배지 | 높음 | 소 | — |
| 4 | 유입 추이 sub-KPI 단위 결정 (세션 vs 사용자) | 중 | 소(결정) | 현업 협의 |
| 5 | AI 유입 cohort 기준 추가 테이블 (평균세션시간·이탈률) | 중 | 중 | — |
| 6 | Key Highlights AI 자동 작성 | 낮음 | 중 | 데이터 안정화 |
| 7 | rollup geography 다국가 검증 | 보류 | 소 | 시장 온보딩 |
| 8 | engine copilot/perplexity 노출 결정 | 낮음 | 사소 | — |

---

## 1. 속성별 Lead Event Map (전환 정의)

**배경**: 리드/전환 이벤트명이 속성(브랜드/국가)마다 다름. 예) 시승 `test_drive`(CCI) vs `test_drive_request`(Kia/IT) · 예약 `book_now` vs `book_a_car`. 현재 우리 전환은 GA4 'key event' 라벨 이벤트만 집계.

**액션**:
- `property-map.ts`와 유사한 `lib/ga4/event-map.ts` — 속성(또는 brand×country)별 `{ 표준전환유형 → GA4 eventName[] }` 매핑.
- 표준 전환 유형: 딜러찾기 / 시승 / 견적 / 예약 / 문의 / 컨피규레이터 완료 / 브로셔.
- conversion 집계 시 keyEvents 합산을 이 매핑 기준으로 명시 (현재는 GA4 keyEvents 메트릭 일괄).
- 문서/툴팁에 "GA4 key event 라벨 이벤트만 추적" 명시.

**의존성**: 각 속성의 실제 이벤트·key event 목록 (probe `--dimensions`의 eventName 분포로 1차 수집 가능).

## 2. 전환 종류 Breakdown / 정의 노출

**배경**: AI cohort의 key event가 희소(~5건/90일)해 필터 축으로는 부적합 → 대신 **전환 구성 breakdown**으로 노출(예: config 87% / brochure 12% …). ICT 리포트의 Lead Conversion 섹션과 동일 관점.

**액션**:
- conversion view에 전환 유형별 건수 breakdown(테이블 또는 툴팁) 추가, #1 event-map 기준.
- KPI 정의 툴팁에 전환 구성 mix 표기 (기존 `conversion.ts` 주석의 정의를 UI로).

**의존성**: #1.

## 3. 표본 작음 경고 배지

**배경**: AI cohort 90일 ~118명·key event ~5건. engine×device로 더 쪼개면 전환율 통계적으로 불안정. 검수 중 newVsReturning은 activeUsers 비가산(중복 ~8.5%) 확인 — 버킷 합산 금지.

**액션**:
- 필터 적용 시 표본수(users/keyEvents)가 임계값 미만이면 conversion KPI 카드/표에 "표본 작음, 참고용" 배지.
- 임계값 한 곳 상수화 (`lib/ga4/conversion.ts`).
- 합산 금지 주석/가드 (newVsReturning 버킷 합).

## 4. 유입 추이 Sub-KPI 단위 결정

**배경**: "사이트 유입 추이"를 **세션 수**로 볼지 **총 사용자 수**로 볼지 미결. ICT 리포트는 세션·총사용자 둘 다 노출 → 기준 힌트.

**액션**: 현업 협의로 단위 확정 후 sub-KPI 정의. (전환은 activeUsers 유지, 유입 추이 단위는 별도 결정.)

**의존성**: 현업 협의.

## 5. AI 유입 Cohort 기준 추가 테이블

**배경**: AI 유입 활성사용자를 라벨링할 수 있으므로(`sessionDefaultChannelGroup = AI Assistant`), ICT 리포트의 평균 세션 시간·이탈률 테이블을 **AI 유입 cohort 기준**으로도 구성 가능. 일반 트래픽 vs AI 유입 비교 관점.

**액션**:
- conversion.ts에 AI cohort의 `averageSessionDuration`·`bounceRate`(또는 engagementRate) fetch 추가.
- device / 신규vs재방문 / 채널별 비교 테이블 (AI cohort).

## 6. Key Highlights AI 자동 작성

**배경**: ICT 리포트 ①의 주요 시사점 문구를 매월 수기 갱신 → AI 초안 작성 검토.

**액션**: 당월 GA4 데이터 요약 → LLM으로 주요 시사점 초안 생성(검토 후 게시). 데이터 안정화(누적) 후 착수.

## 7. Rollup Geography 다국가 검증 (보류)

**배경**: rollup geography 필터 배선 완료되나 `property-map.ts` MAP에 Kia/IT 단일 → 다국가 검증 불가.

**액션**: 시장 온보딩(MAP + env 추가) 후 검증.

## 8. engine copilot/perplexity 노출 결정 (사소)

**배경**: 현재 패널 engine = [chatgpt, gemini]만 노출(copilot/perplexity는 90일 3명이라 제외). 매핑 테이블(`ENGINE_SOURCE`)엔 4종 다 존재.

**액션**: 정책 결정만 — 노출 시 `DIMENSIONS.engine`에 추가(단, 타 화면 scope engine 오염 주의 → conversion 전용 옵션 오버라이드 필요).
