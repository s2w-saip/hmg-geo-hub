# 워크유닛

담당·배타 파일·의존 순서를 함께 못 박는다. **배타 파일이 겹치는 유닛은 동시에 돌리지 않는다.**
검증은 항상 `독립 검증` 를 구현자와 분리해 별도로 수행한다(렌즈 지정).

| 유닛 | 담당 | 배타 파일 | 선행 |
| --- | --- | --- | --- |
| W0 | (운영) | 없음(원장) | 없음 |
| W1 | `화면 담당` | `app/[locale]/(dash)/website/page.tsx` | 없음 |
| W2 | `데이터 담당` | `lib/summary/read/gate.ts`, `lib/summary/read/gate*.test.ts` | 없음 |
| W3 | `데이터 담당` | `lib/scope/server.ts` | W2 |
| W4 | `데이터 담당` | `lib/db/repositories/summary-global-aggregates.ts` 외 리더 | W3 |
| W5 | `데이터 담당` | `scripts/summary/explain-s1.ts`, `scripts/summary/explain-s4.ts` | W3 |
| W6 | `독립 검증` | 없음(읽기·실행 전용) | W1~W5 |
| W7 | `데이터 담당` | `lib/summary/read/screens.ts`, `scripts/summary/read-switch.ts` | W6 |

---

## W0. (운영) 웹사이트 구멍 회차 해소 - 1순위 웹사이트의 선행 블로커

- [ ] 0.1 design.md §8 D1 결정. D1-1 채택 시 `be63ee63-72d3-44d9-bbc4-5fa360c8965d`
      (프로젝트 `5de09736…`, 앵커 2026-09-14) 생성 실행. **쓰기 작업이므로 제품 책임자 승인 후.**
- [ ] 0.2 실행 후 재실측: 창 2026-08-20..09-18 의 website 구멍이 0인지 확인
      (`scripts/summary/probe-period-gate.ts`, 읽기 전용).
- [ ] 0.3 재발 빈도 기록: 최근 8주 동안 같은 형태(`closed` + `gap<=MAX` + generation 없음)가
      몇 번 있었는지 원장 조회로 남긴다. D1-2 결정의 근거가 된다.

## W1. (2순위, 독립) 웹사이트 오버뷰 degrade 문구

값·산식·경로 무변경. **이 유닛만 따로 배포·체리픽할 수 있어야 한다.**

- [ ] 1.1 `app/[locale]/(dash)/website/page.tsx:296-303` 의 빈 상태를
      `wasDegraded("websiteAggregates") ? tKpi("degraded") : t("empty")` 로 가른다.
      대시보드(`dashboard/page.tsx:324`)와 **같은 i18n 키**를 쓴다(새 키 금지).
- [ ] 1.2 `fetchWebsiteAggregates` 의 degrade 라벨이 `"websiteAggregates"` 인지 확인
      (`lib/scope/server.ts:3579`). 라벨이 다르면 문구가 영원히 안 뜬다.
- [ ] 1.3 렌더 테스트 ko/en: (a) 데이터 없음 (b) degrade 두 경우가 서로 다른 문구를 내는지.
      `wasDegraded` 는 RSC 요청 스코프 밖에서 fail-closed 이므로 테스트는 스코프를 세워야 한다
      (`dashboard/_components/degrade-notice.tsx:40` 주석 참고).
- [ ] 1.4 `npm run check:strings` 통과.

**수용 기준 W1**
- AC1.1 웹사이트 오버뷰가 예산 초과로 빈 경우, 화면 문구가 `dashboard.kpi.degraded` 와 **동일 문자열**이다.
- AC1.2 데이터가 실제로 없는 경우(필터 공집합) 문구는 종전 `empty` 그대로다.
- AC1.3 신규 i18n 키 0개. `messages/{ko,en}.json` diff 없음.

## W2. 게이트 판정 (코어)

- [ ] 2.1 `lib/summary/read/gate.ts::commonUnsupportedReason` 의 `cumulative` 분기를
      "미러가 실제로 누적이 되는 조건"으로 좁힌다(design.md §6-1).
      판정 술어는 **한 곳에서만** 정의한다(`cumulativeMode` 와 같은 명제임을 주석으로 못 박는다).
- [ ] 2.2 `mode` 를 넘기지 않는 기존 호출부의 판정이 **바이트 동일**하게 유지되는지 테스트로 고정
      (기간 있는 `cumulative` 는 여전히 `"cumulative"`, 기간 없는 `cumulative` 만 통과).
- [ ] 2.3 `gate.test.ts` 에 4조합 표 추가: {cumulative 유·무} x {기간 유·무} x {snapshot, period}.
- [ ] 2.4 기간 없는 요청이 `mode: "period"` 로 들어오면 **판정 불가로 거부**하는 가드를 넣는다
      (무경계 `pickCyclesInRange` 방지, design.md §6-1 경고).

**수용 기준 W2**
- AC2.1 `{cumulative:true}`(기간 없음) + snapshot: 종전 `fallback:cumulative` 였던 것이 **통과**한다.
- AC2.2 `{cumulative:true, dateFrom}` + snapshot: 여전히 `fallback:cumulative`.
- AC2.3 `{}` + snapshot: 판정 결과가 이 change 이전과 **문자열까지 동일**.
- AC2.4 기간 없는 `mode:"period"` 호출은 폴백 사유를 내고, `pickCyclesInRange` 를 호출하지 않는다.

## W3. 리더 라우팅 (코어)

- [ ] 3.1 `viaGlobalS1`(server.ts:1397) / `viaTrend`(:3529)에 모드 선택을 넣는다.
      규칙은 `dateFrom || dateTo` 하나.
- [ ] 3.2 **기간 모드에서 `agg-fold-missing`·`agg-empty`·`agg-widget-empty` 의 목적지를
      미러로 바꾼다.** 세부층(단일 회차)으로 가지 않는다(design.md §6-3).
      스냅샷 모드의 목적지는 종전 그대로 세부층이다.
- [ ] 3.3 기간 모드 로그를 `x-hmg-summary(<surface> <screen> period): …` 형태로 통일해
      `cycles:<n>`·`skipped:<n>` 이 남게 한다.
- [ ] 3.4 캐시 키: 기간 모드의 `cycleKey` 를 안정 해시로 접는다(design.md §6-4).
      회차 1개(스냅샷)에서는 **종전 키 문자열을 유지**한다(셀 무효화 방지).
- [ ] 3.5 단위 테스트: 기간 모드에서 세부층 폴백이 **호출되지 않음**을 스텁으로 단언.
      (이 테스트가 없으면 §6-3 의 위험이 조용히 돌아온다.)

**수용 기준 W3**
- AC3.1 30일 요청의 글로벌 카드 경로 로그가 `fallback:cumulative` 가 아니라
      `hit cycles:4`(또는 그날의 회차 수)를 낸다.
- AC3.2 기간 모드에서 어떤 폴백 사유로도 세부층 리더가 호출되지 않는다(테스트 단언).
- AC3.3 기간 미지정 요청의 SQL·캐시 키·로그 문자열이 이 change 이전과 동일하다(회귀 0).

## W4. 프롬프트 수 계열 (D3 결정 후)

- [ ] 4.1 D3 결정 반영. 권장안(1) 채택 시: 세부층 `summary_answers` 를 회차 집합 전체로 읽어
      `count(DISTINCT prompt_id)` 를 낸다. 주 파티션 프루닝은 `dateArray(set.weeks)`
      **스칼라 펼침**으로만 한다(`sql.param(배열)::date[]` 금지, `cycle-set.ts` 계약 ②).
- [ ] 4.2 집계층 `prompts_measured`·`prompts_tracked` 를 **여전히 SELECT 하지 않는다**는
      불변식을 테스트로 고정(회차 간 SUM 이중 계상 차단).
- [ ] 4.3 화면 캡션·툴팁이 그 셀의 의미("기간 내 고유 프롬프트 수")를 말하는지 확인.

**수용 기준 W4**
- AC4.1 30일 기간에서 프롬프트 수가 회차 수 배수로 부풀지 않는다
      (독립 SQL `count(DISTINCT prompt_id)` 와 오차 0).
- AC4.2 기간 없음에서 그 값이 종전과 동일하다.

## W5. 성능 근거 (실문장 EXPLAIN)

design.md §7-1 은 **근사**다. 여기서 실제 리더 문장으로 대체한다.

- [ ] 5.1 `scripts/summary/explain-s1.ts` 의 `loadSet()` 을 회차 N개(기간 창) 로 확장한다
      (읽기 전용·쓰기 0 유지). `--from=YYYY-MM-DD --to=YYYY-MM-DD` 인자.
- [ ] 5.2 `scripts/summary/explain-s4.ts` 도 동일 확장.
- [ ] 5.3 **조합 최소 3종을 반드시 잰다**: (a) 무필터 함대 (b) 단일 브랜드
      (c) 소형(단일 브랜드 + 단일 국가). 한 조합만 재고 결론짓지 않는다.
      (2026-09-17 #708 선례: 작은 워크스페이스가 statement_timeout 으로 죽는 형태가
      최대 워크스페이스에서는 +5% 로만 보였다.)
- [ ] 5.4 각 조합에서 회차 1개 vs 기간 회차 N개를 **같은 세션 A/B 교대**로 잰다.
- [ ] 5.5 오늘의 미러 문장을 `scripts/summary/explain-mirror-heavy.ts --explain` 으로 재고
      서버측 exec 을 기록한다. **라이브 고객 DB 부하이므로 제품 책임자 승인 후 실행**하고,
      승인이 없으면 "미실행 + 사유"로 남긴다(추정치를 실측처럼 쓰지 않는다).

**수용 기준 W5**
- AC5.1 3조합 x {1회차, N회차} = 6개 측정의 Execution Time 표가 남는다.
- AC5.2 회차 수에 대한 증가가 선형 이하임을 그 표가 보인다(초선형이면 인덱스 재검토).
- AC5.3 무필터 함대 기준 집계층 read 합이 `MIRROR_HEAVY_PROFILES.summaryRead`
      (문장 15s / 벽시계 20s) 안에 **콜드 배수 1.7 을 곱하고도** 들어간다.

## W6. 독립 검증 (`독립 검증`, 구현자와 분리)

렌즈 3종을 **명시 지정**해 수행한다. 입력은 산출물 + 아래 수용 기준뿐이다.

- [ ] 6.1 **렌즈 A 데이터 정확성**
      - 30일·14일·7일·기간 없음 네 창에서, 화면 값과 **독립 SQL**(검증자가 직접 작성)의
        회차 집합 SUM 이 일치하는가. 허용 오차 **0**(정수 카운터), 비율은 표시 반올림 단위
        (소수 첫째 자리)까지 일치.
      - 비율 지표가 "회차별 비율의 평균"이 아니라 **분자 합 / 분모 합**인가.
      - 기간 없음 = 최신 1회차 스냅샷인가(의미론 정본).
      - 7일과 30일의 값 관계가 모순되지 않는가(30일 모수 >= 7일 모수).
      - **미러와의 차이는 수용 기준이 아니다**(design.md §4-3). 대신 차이를 항목별로
        분해해 "설명되지 않는 잔차가 있는가"를 본다.
- [ ] 6.2 **렌즈 B UI 실측**
      - Vercel 프리뷰에서 30일 응답 시간. 상한은 AC-G3.
      - 캐시 우회(`x-hmg-perf-nocache`, ACK 확인)와 warm 을 모두 잰다.
      - 기본 화면(기간 없음) 회귀 0: 값·기준일 pill·문구·응답 시간.
      - 런타임 로그에 `fallback:cumulative` 가 **0건**인가.
- [ ] 6.3 **렌즈 C 권한 레드팀**
      - 기간 모드 전환이 role 스코프를 우회하지 않는가. `deriveScopeFilter` 가 만든
        필터가 회차 집합 판정 **앞**에 적용되는가(국가 담당 계정이 30일로 전 세계를 보지 않는가).
      - degrade 문구가 권한 실패를 삼키지 않는가(`isTimeoutFailure` 허용 목록이 여전히
        57014 + 마감 초과 둘뿐인가).

## W7. 스위치 (제품 책임자 승인 후)

- [ ] 7.1 D2 결정 반영. opt-in 을 가른다면 `lib/summary/read/screens.ts` 에 키를 추가하고
      `SUMMARY_SCREEN_OPT_IN` 에 등재한다(값이 바뀌는 키는 `screens all` 로 안 켜진다).
- [ ] 7.2 `scripts/summary/read-switch.ts` 로 켜는 절차와 되돌리는 절차를 한 줄씩 기록.
- [ ] 7.3 켠 직후 `x-hmg-summary` 헤더로 실제 경로 전환을 확인하고, 되돌릴 조건
      (예: 값 이상 신고 1건)을 미리 적어 둔다.

---

## 전역 수용 기준 (검증자가 구현 맥락 없이 판정 가능한 형태)

| ID | 기준 | 판정 방법 |
| --- | --- | --- |
| AC-G1 | 30일·14일·7일·기간 없음 네 창에서 화면 값 = 독립 SQL 회차 집합 SUM. 정수 오차 **0**, 비율은 표시 자릿수 일치 | 검증자 자작 SQL vs 화면 |
| AC-G2 | 런타임 로그에 `fallback:cumulative` **0건**(대상 화면 키 한정) | 프리뷰 로그 grep |
| AC-G3 | 30일 응답: 글로벌 대시보드 **콜드 p95 <= 12s · warm <= 6s**, 웹사이트 오버뷰 동일 상한. 상한 근거는 "기간 없음 실측 3.9s x 콜드 1.7 x 여유 1.3 = 8.6s" 에 회차 4배분 여유를 더한 값이고, W5 실측 후 조정 가능 | 6표본 p50/p95, ACK 확인된 nocache 5회 + warm 2회 |
| AC-G4 | 기본 화면(기간 없음) 회귀 **0**: 값·측정 기준일·문구·SQL 텍스트·캐시 키 | 단위 테스트(SQL 텍스트 동일성) + 화면 대조 |
| AC-G5 | 기간 모드에서 세부층 단일 회차 폴백이 호출되지 않음 | 스텁 단언 테스트 |
| AC-G6 | 프롬프트 수 계열이 회차 수 배수로 부풀지 않음 | 독립 SQL `count(DISTINCT prompt_id)` |
| AC-G7 | 마이그레이션 0개. `npm run db:check` 무변경, `meta/_journal.json` diff 0 | git diff |
| AC-G8 | `npm test` · `npm run lint` · `npm run build` · `npm run check:strings` 통과 | 명령 실행 |

⚠️ AC-G1 의 대조 상대는 **집계층 독립 SQL** 이지 미러 직조회가 아니다. 미러와의 일치를
기준으로 삼으면 설계상 통과할 수 없다(design.md §4-3).
