# GA4 중앙 소비 시나리오 — ICT 협의용

> 대상: ICT · 작성: Answer GEO(hmg-geo) · 2026-07-23
> 관련: 오픈이슈 **GA-3**(ICT 전권역 GA 통합 계획) · 내부 규격 [ga4-connection-permission-design.md](ga4-connection-permission-design.md)

## 0. 요청 요지

ICT의 **전 권역 GA 통합 수집·관리** 계획이 확정될 경우, GEO 측정(hmg-geo)은 각 시장 GA4 속성을 개별 연동하는 대신 **ICT 중앙 지점에서 데이터를 소비**하고자 합니다. 이를 위해 필요한 접근·데이터 형태를 정리하여 협의를 요청드립니다.

## 1. 배경 — GEO가 GA4를 쓰는 목적

- hmg-geo는 AI 생성엔진 유입(ChatGPT·Gemini·Claude 등)의 **사이트 전환·방문 KPI**를 산출합니다.
- 현행: GEO 측정 계정(Google OAuth 사용자, `geo-ops@example.com`)을 각 시장 GA4 속성에 **뷰어(Viewer)** 로 추가 → GA4 **Data API**로 읽습니다. 현재 **Kia/IT 1개 라이브**, 시장별 개별 연동.
- 개별 연동은 시장 확장에 비효율적이라, ICT 중앙화가 확정되면 **중앙 소비로 전환**하는 것이 합리적입니다.

## 2. GEO가 GA4에서 읽는 것 (소비 요건)

중앙 데이터에서도 아래가 보존되어야 GEO KPI 산출이 가능합니다.

- **AI cohort 식별**: `sessionDefaultChannelGroup = "AI Assistant"`(또는 동등 정의)로 **AI 유입 세션을 분리**하는 것이 핵심. 이 채널 그룹이 중앙에서도 유지되어야 함.
- **지표**: `activeUsers`(전환 분모) · `sessions`(방문 수) · `screenPageViews` · **전환 key event** · `landingPage`.
- **분해 축**: **brand × country 식별 가능해야 함** — 속성 자체가 시장 단위이든, 데이터 내 차원(속성/스트림/커스텀 차원)이든, GEO가 시장별로 가를 수 있어야 함.
- **기간·신선도**: 최소 최근 90일 롤링, 일 단위 갱신.

## 3. 중앙 소비 형태 옵션 (ICT 제공 방식별)

| # | ICT 제공 | GEO 소비 | 장점 | 유의 |
|---|---|---|---|---|
| **1. 중앙 GA4 속성 뷰어** *(권고)* | 통합 GA4 속성(권역/브랜드별)에 GEO 계정을 뷰어 부여 | 현행 Data API 그대로 | **전환 비용 최소**(파이프라인 재사용) | brand×country 분해가 속성/차원으로 가능해야 |
| 2. BigQuery Export | GA4 native BQ 링크로 원천 이벤트를 BQ 적재, GEO에 데이터셋 접근 부여 | BQ 쿼리로 cohort 산출 | 원천 데이터·유연·대량 | conversion 파이프라인을 BQ로 교체(규모 큼)·BQ 비용 |
| 3. 정제 API/피드 | ICT가 집계 결과를 API·파일로 제공 | 결과만 소비 | GEO의 GA 접근 불필요 | ICT 부담↑·cohort/축 정의 사전 합의 필요 |

**GEO 권고 = 옵션 1(중앙 속성 뷰어)** — 현행 Data API·AI cohort·landingPage 파이프라인을 그대로 재사용해 전환 비용이 가장 작습니다. 단 brand×country 분해 조건 충족 시.

## 4. 역할 경계 (제안)

- **ICT**: GA4 속성 통합 · 태깅/채널 표준 · 데이터 수집·보존 · 접근 권한 관리.
- **Answer GEO**: AI cohort 정의 · GEO KPI 산출(전환율·AI 유입 방문) · 시각화 · BFF.
- **공동**: 전환 key event 정의(권역·브랜드별 상이 — 오픈이슈 GA-1) 정합 · brand×country 식별 규약.

## 5. ICT에 대한 요청·확인 사항

1. 통합 방향: 속성 통합 / BigQuery export / 정제 피드 중 어느 쪽인지.
2. 옵션 1이면: 중앙 속성 구조(권역·브랜드·국가 단위?)와 **GEO 계정 뷰어 부여** 가능 여부.
3. AI 유입 채널 그룹(`AI Assistant` 등) 정의가 중앙에서 **보존·표준화**되는지.
4. **brand × country 식별 방법**(속성 분리 / 커스텀 차원 / 데이터 스트림).
5. **전환 key event 표준**(권역별 상이 이슈 GA-1) 공동 정리 가능 여부.
6. 접근 자격 관리·로테이션 정책.

## 6. 전환 시 GEO 측 변경 (참고)

- **옵션 1**: 속성 매핑 레지스트리가 개별 속성 대신 **ICT 중앙 속성**을 가리키게 + 뷰어 부여 대상 변경. 측정 파이프라인(`conversion.ts` 등)은 대부분 무변.
- **옵션 2**: `conversion.ts`를 BigQuery 쿼리 경로로 교체(대규모) + BQ 클라이언트·인증 추가.
- 권한 모델은 **현행 OAuth 유지**(별도 결정, 2026-07-23) — 중앙 속성에도 GEO OAuth 계정을 뷰어로 부여받는 형태.

---

*본 문서는 협의 출발점입니다. ICT의 통합 계획 상세(속성 구조·일정·접근 정책)를 공유해 주시면 옵션·경계·일정을 구체화하겠습니다.*
