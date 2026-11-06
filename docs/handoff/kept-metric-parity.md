# 유지 지표 값 대조 (T7.5)

리뉴얼에서도 유지하는 지표(`screen-read-map.md`의 88개)가 레거시와 리뉴얼에서 같은 값인지 확인한 기록이다.

**결론: 대조한 39건이 모두 같다. 88개 중 45개를 대조했고, 43개는 대조하지 않았다.** 계획한 약 22개(유지 지표의 1/4)보다 많지만, 한 번 받은 응답에서 함께 비교해 수집을 더 하지는 않았다.

- **기준:** 2026-11-06 12:56, 지표 정의 버전 `2026-11-06.3`, 커밋 전 작업 트리. Global 2026-10-05 회차, Website 2026-10-09 회차.
- **방법:** 첫 화면 빌더(`bff/metrics/first_screens.py`)의 Global · Website(관리자) 호출 108개를 한 프로세스에서 돌려 응답을 비교했다. 오류는 0건이다. 지표 · 캐시 DB를 연결하지 않아 전부 조회 시점에 계산했고, 아무것도 저장하지 않았다.
- **증명하는 것:** 두 화면의 값이 같다는 것까지다. 두 화면이 같은 BFF를 읽으므로 정의가 맞다는 증거는 아니다(`CLAUDE.md` 6절). 정의 쪽 대조는 `bff.tests.test_metrics_live`가 맡는다.
- **대조하지 않은 조건:** 필터 · 기간을 건 조회, 기간 Δ, Project 표면, 비관리자 Website 응답. Δ는 첫 화면의 직전 회차 Δ 4건만 봤다.

## Global Mention

앞서 7d가 대조한 노출률 · 점유율 · 우호도 · 우선 노출도(Global)와 노출률(Website)은 여기에 다시 적지 않았다.

| 지표 | 표면 | 두 화면의 값 | 레거시 ↔ 리뉴얼 빌더 |
|---|---|---|---|
| 멘션 유형별 노출 · 단순 언급 | Global | 59.4%, 신호 191,588 | kpi-types ↔ rn-rate-types |
| 멘션 유형별 노출 · 추천 | Global | 36.6%, 신호 75,576 | kpi-types ↔ rn-rate-types |
| 멘션 유형별 노출 · 비교 | Global | 29.1%, 신호 47,404 | kpi-types ↔ rn-rate-types |
| 멘션 유형별 노출 · 정의 | Global | 4.3%, 신호 2,953 | kpi-types ↔ rn-rate-types |
| 멘션 유형별 노출 · 최종 선택 | Global | 6.9%, 신호 5,745 | kpi-types ↔ rn-rate-types |
| 유형 안 점유율 | Global | 단순 언급 61.7 · 추천 26.7 · 비교 23.4 · 정의 49.1 · 최종 선택 20.2 | kpi-types ↔ rn-rate-types |
| 감정 분포 4종 | Global | 긍정 174,341(53.9%) · 중립 135,760(42.0%) · 혼합 7,042(2.2%) · 부정 6,123(1.9%) | favor-sentiment ↔ rn-favor-dist |
| 부정 비율 | Global | 1.9 | favor-hero ↔ rn-favor-hero |
| 유형별 긍정 비율 | Global | 전체 57.9%, 유형 5개 행 | favor-matrix ↔ rn-favor-matrix |
| 브랜드별 노출률 · 언급 수 | Global | 9개 행 | kpi-competitors ↔ rn-rate-hero |
| 엔진별 노출률 | Global | chatgpt 78.1% · gemini 75.0% | kpi-engines ↔ rn-rate-engines |
| 브랜드별 우선 노출도 | Global | 11개 행 | first-rank ↔ rn-rank |
| Δ 노출률 | Global | -0.2 | kpi-hero-delta ↔ rn-rate-hero |
| Δ 점유율 | Global | -2.0 | kpi-hero-delta ↔ rn-rate-hero |
| Δ 우호도 · 부정 | Global | 2.0 · 0.3 | favor-delta ↔ rn-favor-hero |
| Δ 우선 노출도 | Global | 0.0 | first-rank ↔ rn-rank |

## Website Mention

| 지표 | 표면 | 두 화면의 값 | 레거시 ↔ 리뉴얼 빌더 |
|---|---|---|---|
| Top 3 노출 비율 | Website | 99.9%(17,781/17,796) | mention/view ↔ mention/view-cards |
| 멘션 유형별 신호 수 | Website | 단순 언급 234,621 · 추천 20,904 · 비교 10,970 · 정의 3,482 · 최종 선택 270 | mention/view ↔ rn-rate-types |
| AI 점유율 | Website | 96.3 | website/summary ↔ rn-rate-value |
| AI 우호도 | Website | 25.5 | website/summary ↔ rn-favor-hero |
| AI 우선 노출도 | Website | 1.0 | website/summary ↔ rn-rank |
| 전체 언급 수 | Website | 280,499 | mention/view ↔ rn-rate-value |
| 긍정 키워드 언급 수 | Website | 68,934 | mention/view ↔ rn-favor-hero |
| 경쟁사 대비 SOV | Website | 410.71배 | website/summary(공용) ↔ rn 언급 수로 재계산 |

## Citation

Citation은 레거시와 리뉴얼이 같은 빌더를 `ctx.variant`만 바꿔 부른다. 공통 수치를 경로별로 비교했고, 인용 비중 · 커버리지 · 미인용 프롬프트 · 공식(당사) URL 인용 프롬프트 · 도메인 인용 점유율 · 도메인 인용 프롬프트 · 전체 인용 수 · 인용 도메인 수가 여기에 든다. Global의 긍정 · 부정 답변 인용 수도 공통 수치다.

| 지표 | 표면 | 두 화면의 값 | 레거시 ↔ 리뉴얼 빌더 |
|---|---|---|---|
| 인용 비중 · 커버리지 · 미인용 프롬프트 | Global | 공통 수치 1948개 | citation/standard ↔ ctx.variant=renewal(같은 빌더, 공통 수치) |
| 인용 비중 · 커버리지 · 미인용 프롬프트 | Website | 공통 수치 1519개 | citation/website ↔ ctx.variant=renewal(같은 빌더, 공통 수치) |
| AI 인용 점유율 | Global | 25.0 | overview/cards(공용) ↔ citation/standard 리뉴얼 |
| AI 인용 점유율 | Website | 24.9 | citation/website 레거시 ↔ 리뉴얼 |
| AI 인용 점유율(Overview 타일) | Website | 24.9 | website/summary(공용) ↔ citation/website 리뉴얼 |
| 자사 URL 인용률 | Website | 87.2%(8,736/10,021) | website/summary(공용) ↔ citation/website 리뉴얼 |
| 타겟 URL 인용률 | Website | 66.6%(6,673/10,021) | website/summary(공용) ↔ citation/website 리뉴얼 |
| 자사 URL 인용률(Citation 화면) | Website | 87.2%(8,736/10,021) | citation/website 레거시 targetHitRate ↔ 리뉴얼 reach |
| 타겟 URL 인용률(Citation 화면) | Website | 66.6%(6,673/10,021) | citation/website 레거시 targetHitRate ↔ 리뉴얼 reach |

## ACR

| 지표 | 표면 | 두 화면의 값 | 레거시 ↔ 리뉴얼 빌더 |
|---|---|---|---|
| 측정 셀 · 반복 · 프롬프트 | Global | 3,761 · 35,927 · 924 | acr/standard ↔ acr/renewal |
| 당사 Top1 ACR · 후보군 포함율 · 선택 수 | Global | 12.4% · 92.2% · 4,441 | acr/standard ↔ acr/renewal |
| 브랜드별 Top1 ACR · 후보군 포함율 | Global | 12개 행 | acr/standard ↔ acr/renewal |
| 차종별 선택 전환율 | Global | 12개 행 | acr/standard ↔ acr/renewal(같은 행 수) |
| 프롬프트 × 엔진 1위 브랜드 | Global | 프롬프트 908개 | acr/standard ↔ acr/renewal(같은 프롬프트 수) |
| 선택 분포(브랜드별 선택 수, CA · chatgpt) | Global | 프롬프트 89개 | acr/standard ↔ acr/renewal(같은 프롬프트 수) |

## 대조하지 않은 43개

| 까닭 | 개수 | 지표 |
|---|---:|---|
| 두 화면을 비교할 수 없음 | 3 | 맞대결 · 당사 상태(리뉴얼에만 있음), AI 타겟 출처 인용률(공용 빌더 한 곳에만 있음, 65.3% 9,829/15,062) |
| 첫 화면 수집 밖 | 8 | AI 가시성 5개, 고객 관심 2개, AI Conversion |
| 이번에 비교하지 않음: 언급 | 15 | 1위 답변 비율, 회차별 언급 순위, 언급 프롬프트, 모그룹 묶음, 순위 칩, 격차, 엔진 간 일관성, 브랜드 포함 · 미포함 값, 부정 키워드 언급 수, 언급 브랜드 수, 미언급 프롬프트 수, 다른 브랜드 언급 등 분해, 브랜드 언급 없는 답변, 브랜드 포함(시장별), 프롬프트별 값 |
| 이번에 비교하지 않음: 인용 | 8 | 주별 도메인 순위, 경쟁사 공식 출처 인용 점유율, 엔진 × 출처 카테고리, 멘션 유형 × 출처 카테고리, 출처별 구성비, 공식(HMG) 순위, 도메인 서랍, 프롬프트별 인용 수 |
| 이번에 비교하지 않음: ACR · 측정 규모 | 9 | 당사 순위 · 1위와 격차, 답변 수, 측정 프롬프트, 프롬프트 측정 횟수, 프로젝트 현황, 프롬프트 상태 수, 측정 회차, 최근 회차 측정, 답변 한 건의 언급 · 인용 수 |

## 대조하며 본 것

두 화면 값은 같으므로 대조 불일치는 아니다.

| 항목 | 내용 | 상태 |
|---|---|---|
| ACR 측정 셀 | 화면은 같은 회차의 재측정을 별도 셀로 세어 3,761셀 · 35,927반복이다. SSOT 셀(프롬프트 × 엔진 × 국가)은 3,567개, 대표 셀만 세면 34,406반복이다. 그렇게 세면 당사 Top1 ACR 12.36 → 12.40%, 후보군 포함율 92.21 → 92.09%다 | 7d에 전달. 고치면 정의 변경이고 **분석팀 리뷰 필요** |
| 자사 URL 인용 프롬프트 | 한 응답 안에 8,736과 8,815로 갈려 있던 값이 `2026-11-06.3`에서 8,736으로 같아졌다 | 해결 |
| Website Citation의 '자사 몫 88%' | 인용이 있는 프롬프트 기준(8,736 ÷ 9,946)이고, 자사 URL 인용률 87.2%는 측정 프롬프트 기준(8,736 ÷ 10,021)이다. 다른 지표라 값이 다르다 | 정상 |
| 전체 인용 수 | 화면 값 935,078은 호스트 없는 인용 6건을 포함하고, AI 인용 점유율 분모 935,072는 포함하지 않는다 | 기존 동작, 두 화면 같음 |
| Top 3 노출 비율 | 두 화면 모두 Website Mention에만 있고 Global Mention에는 없다 | 기존 동작 |
