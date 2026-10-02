## 1. 집계 계층 (PR ①)

- [x] 1.1 `aggregateBrandTrendFromMirror` — 회차(measured_at 버킷)×브랜드 언급 수·노출률·점유율. `detailAnswerWhere` 재사용, 상위 N 브랜드 cap(기본 10) 파라미터
- [x] 1.2 `aggregateEngineKpiTrendFromMirror` — 엔진별 노출률·점유율 시계열 + 최신 스칼라
- [x] 1.3 `aggregateTypeKpiFromMirror` — 유형 5종(type_*)×브랜드군 노출·점유율 + 유형×감정(sentiment_*) 매트릭스
- [x] 1.4 `aggregateFirstPositionFromMirror`: 브랜드별 답변 안 경쟁 순위(min(avg_position) 위 rank())의 평균 시계열 + 최신 순위 테이블(순위 정렬). 2026-09-28 서수 이중 평균에서 개정(spec.md)
- [x] 1.5 신규 쿼리 4종 EXPLAIN — 프로덕션 실측 완료(브랜드 4,523ms·유형 3,816ms·순위 4,694ms·엔진 749ms — count(DISTINCT) 결함 2건 수정). ⚠️ MCP SELECT 제약으로 TEMP TABLE 대신 MATERIALIZED CTE 하네스 — 행 추정 과소로 실제는 같거나 빠름. PR ② 는 8s statement_timeout 가드+degrade 또는 trendDays:28 축소 필수
- [x] 1.6 단위 테스트 — 빈 회차 갭·필터 조합·브랜드 cap 경계, 기존 테스트 전량 통과

## 2. 탭 셸·필터 (PR ②)

- [x] 2.1 `KpiTabs` — `?kpi=` URL 파라미터, 탭 전환 시 필터 carry. 파서(`_data/kpi-tab.ts`)를 서버 page 와 탭 바가 공유 — 폴백 규칙 단일 정본. 쿼리는 원문 복제 후 `kpi` 만 교체(FILTER_SEP·기간 인코딩 미해석 = 왕복 무손실)
- [x] 2.2 필터 바 2행 재배치 — `FILTER_SECTIONS`(dimension/prompt 행)가 이미 정본이라 축 로직·패널 무변경. 페이지가 필터바를 flex 행으로 감싸 측정 개요 카드를 우측에 배치
- [x] 2.3 측정 개요 카드 — 적용(신규 `countCatalogPromptsFromCatalog`, 카탈로그 카운트)/측정(`measuredPrompts`)/미측정(차, 0 클램프·null 전파). 적용 카운트는 `detailAnswerWhere` 와 **같은** 카탈로그 술어를 공유(`catalogPromptPreds` 추출) + funnelStage 포함·`deleted_at` 양쪽 일치(2026-09-01 검증 F2 수정). 답변 축(국가·엔진·기간)이 걸리면 뺄셈을 멈추고 "이 조건에서 측정된 프롬프트"로 문구 전환

## 3. 탭 뷰 4종 (PR ②)

- [x] 3.1 노출률 탭 — `KpiHero`(게이지+Δpp) · `KpiTrendChart`(커스텀 툴팁·커버리지 라벨·`connectNulls={false}`) · `CompetitorKpiTable`(도넛+바·스파크라인·WoW·Gap·경쟁사 선택) · `EngineKpiSection` · `TypeKpiSection`(자사만/타사 포함). 값=스냅샷 / 추이=회차 집계로 열을 분리
- [x] 3.2 점유율 탭 — 같은 컴포넌트에 `metric="sov"` 주입(히어로만 게이지→큰 수+경쟁사 미니 카드 변형). 분기 정본은 `_data/kpi-view.ts` 순수 함수 한 곳
- [x] 3.2b 독립 검증(2026-09-01) 지적 수정 — F1 스파크라인 갭 축 통일·WoW 규약 통일·커버리지 표기 / F2 카운트 술어 정합 / F3 도넛 집합 라벨 / F4 노출률 타사 포함 독립 막대 / F5 "추이 미산출" 구분 / F6 권한 실패 재throw / F7 히어로 창 84일 분리(EXPLAIN 실측) / F8 Gap null 전파 / F9 갭 예산 per-hole. 회귀 테스트 F1~F9 추가
- [x] 3.2c 재검증(2026-09-01) 지적 수정 — C1 `statement_timeout`=문장당임을 반영해 문장 상한(8s)과 벽시계 마감을 분리(실효 최악 = budget + statement) / C2 엔진 1단계 프로덕션 실측(≈2.97s) 후 예산 12s 재설정 + **추이 단계만 degrade**(엔진 바 생존) / C3 축을 창 경계까지(앞뒤 결측 회차 복원) / C4 degrade 를 57014·마감 초과만 허용하는 허용목록으로 / C5 M9·M10 뮤테이션 회귀 테스트 / C6 카운트 jsdoc 상대를 `answerWhere` 로 정정 / C7 `initialScope` seam 으로 parallel 분기 렌더 검증
- [ ] 3.2a (이월) 점유율 히어로 우측을 디자인의 **다중 브랜드 라인**으로 — 현재는 당사 KPI 단일 라인(툴팁 항목은 디자인과 일치). 하단 "주별 상위 10개 브랜드"(4.1)와 중복이라 PR ③ 에서 함께 판단
- [x] 3.3 우호도 탭(2026-09-02) — `FavorabilityKpiTab`: 긍정/부정 비율 카드 2장(Sub KPI Q3, Δ=직전 스냅샷) · 긍정/부정 추이(엔진 추이 집계 per_job 스캔에 감정 합 3열 추가 — 별도 쿼리 없음, 초록/빨강) · 감정 분포 4분류(클릭 → 기존 `signal-prompts-dialog`) · 멘션 유형별 감정 매트릭스(전체+5유형, 우측=긍정 비율, 비율↔건수 토글). 렌더 테스트 ko/en
- [x] 3.4 우선 노출도 탭(2026-09-02) — `FirstRankKpiTab`: 히어로(당사 가중 평균 순위 + Δ=회차 마지막 두 칸, 경쟁사 미니 카드 4) · `RankTrendChart`(y축 반전, 갭 유지) · 순위 테이블(순위·바·직전 4회차 스파크·WoW, 경쟁사 선택) · 래더(순위별 보기 토글, 관측 최선~최악 정규화). 산식 캡션 명시. `aggregateFirstPositionFromMirror` 에 문장 상한·마감 배선(종전 미배선). 순위 없음 = "측정 없음"(null 전파) 테스트

## 4. 공통 하단 (PR ③)

- [x] 4.1 주별 상위 10 브랜드 라인(2026-09-02) — 기존 `MentionTrendChart` 를 export 해 공통 하단에서 재사용. 추이 롤업 degrade(`trendDegraded`)는 캐시에 저장하지 않도록 차단 + 문장 상한 8s→20s
- [x] 4.2 브랜드 언급 순위 Top100(2026-09-02) — 표를 `brand-rank-table.tsx` 로 추출(website/project 는 기본 옵션 = 종전 마크업). 표준만 `multiToggle`(서버 집계 `multi` 필드: 답변 내 2회 이상 언급 기준)·`limit=100`. 검색·Excel·useDeferredValue 보존
- [x] 4.3 드릴다운(2026-09-02) — 기존 프롬프트/인용 출처 탭 유지 + `showRank`(표준만): 순위 열(답변 중 최소 position)·"언급 TOP 3 이내" 배지. 표준 하단은 `MentionsPromptsSection`(요약 카드·헤드투헤드·감정/유형 카드는 탭이 담당하므로 제외)

## 5. i18n·검증 (PR ③)

- [x] 5.1 `messages/{ko,en}.json` 신규 키(favorability.* · firstRank.*), `npm run check:strings` 통과 (2026-09-02, 탭 3.3/3.4 분)
- [ ] 5.2 회귀 — website/project mention 화면 렌더 무변화 확인 (공용 컴포넌트 추출 파급 차단)
- [ ] 5.3 hmg-geo-독립 검증 — 렌즈 ① 데이터 정확성(탭 지표↔집계 SQL 손대조·빈 회차·필터 조합 경계) ② UI 실측(Vercel 프리뷰, sync-mirror 프로브 금지)
- [ ] 5.4 `npm test` · `npm run lint` · `npm run build` 통과
