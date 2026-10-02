# 워크유닛 v2 (하루 일정): 기간 비교 Δ (GGMD-107)

기준 sha `5aa8c62`. **착수 2026-09-19(KST), 같은 날 완료 목표.** v1 의 09-28 역산 일정은 폐기.
결정 6건은 design §12 에서 닫혔다: 이노션 게이트 **해제**, 제품 책임자 승인 완료.

**스펙 워크트리**: `../hmg-geo-ggmd107` (openspec/ 만 고친다).
**구현 워크트리**: 아래 §W 판정에 따라 **담당별 3개**.

---

## W. 워크트리 판정: 담당별 3개 + 마지막 통합

하나를 순차 공유하면 G-A 가 끝날 때까지 G-B·G-C 가 대기한다. 하루 안에 안 끝난다.
**파일 집합의 교집합이 0** 이므로 나눠서 병렬이 안전하다.

| 워크트리 | 담당 | 만지는 파일 (배타) |
| --- | --- | --- |
| `hmg-geo-ggmd107-impl` (통합·기준) | 코디네이터 | 통합 머지만 |
| `hmg-geo-ggmd107-kpi` | `데이터 담당` | `lib/kpi/**` · `lib/db/repositories/summary-period-compare*` |
| `hmg-geo-ggmd107-ui` | `화면 담당` | `components/dash/**` · `app/[locale]/(dash)/**` · `messages/{ko,en}.json` |
| `hmg-geo-ggmd107-bff` | `BFF 담당` | `lib/scope/server.ts` · `lib/summary/read/**` · `scripts/db/*.sql` |

**충돌 지도**: 교집합 파일 **0건**. 유일한 주의점 둘:
- `messages/{ko,en}.json` 은 **UI 워크트리 단독**이다. bff·kpi 는 i18n 키를 만들지 말고
  design §10 / §13-3(D)3 의 키 목록을 UI 에 넘긴다.
- UI 가 `fetchPeriodCompare` 를 import 하는데 그 함수는 bff 워크트리에 있다.
  → UI 는 **design §15 시그니처대로 로컬 스텁**을 두고 개발하고, 통합 시 스텁을 지운다.

**통합 순서**(impl 워크트리에서): `kpi` → `bff` → `ui`. 각 머지 뒤
`npm run lint && npx tsc --noEmit` 을 돌린다. 머지는 로컬 브랜치명 또는 `FETCH_HEAD` 로
(클론 refspec 이 main-only라 `origin/<feature>` 는 낡은 값이다).

---

## P0. 1차 필수 (이것만 되면 GGMD-107 은 해소된다)

병렬 그룹 3개. 세 그룹이 **동시에** 착수한다.

### G-A · 데이터 담당: 산식 + 읽기

**지금 착수 가능**(결정 무관). 시그니처는 design §15 가 계약이다.

- [ ] A1 `lib/kpi/period-compare.ts`: §15 타입 전부 + `resolveWindows` · `missingShare` ·
      `graceDays` · `computeCompare`(kind `"window"` 만 먼저) + 우선순위.
      상수 `MISSING_SHARE_MAX = 0.30` · `PERIOD_COMPARE_EPOCH = "2026-09-08"`(제품 책임자 09-18: 배포 시점 최신 회차부터 적용).
- [ ] A2 `lib/kpi/period-compare-view.ts`: 칩 텍스트·캡션 키 선택 + `SUPPRESSED_GLYPH`(U+2015).
- [ ] A3 `lib/db/repositories/summary-period-compare.ts`: `resolveWindowEnd` +
      `readComparePeriods`(임의 `(key,lo,hi)` 목록, 문장 2개, `trendWhere` 재사용,
      `family` 기본값 없음, `planTrendRead` 불가 시 `null`).
- [ ] A4 테스트: 순수(경계 30%·`grace` 4값·우선순위 전수·뮤테이션 4종) +
      `*.sql.test.ts`(컴파일 SQL, 바인드 `::int` 캐스트) + `*.int.test.ts`(골든 G1~G4).
- [ ] A5 **EXPLAIN ANALYZE** 3 워크스페이스(글로벌 root 무필터 · 웹사이트 함대 95 ·
      웹사이트 단일 소형). 기준선: 글로벌 94.256 ms/6,022 · 함대 11.009 ms/2,838.

### G-B · BFF 담당: 게이트웨이 · 캐시 · epoch

A1·A3 의 **시그니처만** 필요하므로 스텁으로 동시에 진행한다.

- [ ] B1 `fetchPeriodCompare(filters, opts)`: 세션·감사·스코프 주입 경로 유지.
      **진입부 1곳**에 `if (cur.hi < epoch) return null` (design §14-2).
- [ ] B2 캐시 셀 TTL **600 s**, 태그 `[MIRROR_AGGREGATE_TAG, SUMMARY_TAG]`,
      **키에 해소된 `E` 포함**. `MIRROR_CACHE_BASE_GENERATION` 은 올리지 않는다.
- [ ] B3 설정 `period_compare`(기본 off) + `period_compare_epoch` 읽기 + env 오버라이드.
      off 에서 **DB 왕복·페이로드 증가 0** 을 테스트로 고정.
- [ ] B4 서버 페이지가 `E` 를 필터 패널로 내리는 경로(`collectionStartDay → minDay` 와 같은 배선에
      `latestAnchorDay` 추가). **함대 앵커 불일치 시 로그 1줄**(design §13-4).

### G-C · 화면 담당: 칩 · 프리셋 · 지면

- [ ] C1 `components/dash/delta-chip.tsx` 신설(값/억제 3상태, U+2015, `aria-label`).
      ⚠️ `components/kpi-card.tsx` 는 앱이 안 쓴다(import 0건). **거기 고치지 말 것.**
- [ ] C2 `presetRange(preset, endDay, minDay)` + `endDay` 미지정 시 오늘 폴백. 순수 함수 테스트.
- [ ] C3 i18n ko/en 신규 키(design §10, Q3=a "지난 7일 대비" 계열) + `check:strings` +
      ko/en 키 집합 동일성·**U+2014 0건** 테스트.
- [ ] C4 **지면 1~5 배선**(대시보드 카드 ①~⑤ · 경쟁사 미니값 · 웹사이트 타일 ·
      글로벌 언급 히어로 · 인용 현황). 나머지 7개는 P2.
- [ ] C5 라벨 정정 4건(design §10-1): **문구 전용 별도 커밋**(값 diff 0).

### G-D · 독립 검증: 검증 (G-A~C 통합 후)

**빌더와 컨텍스트 미공유. 고정 sha 의 별도 워크트리.**

- [ ] D1 렌즈 ① 데이터 정확성: 골든 G1~G4 **독립 SQL 재계산**, 창 경계, 억제 경계 30%,
      `hidden_scope` 계열 분기, 비율 합산 vs 평균, epoch 분기가 1곳인지.
- [ ] D2 렌즈 ② 성능: EXPLAIN 3 워크스페이스 직접 재현, "창 2배 = 문장 수 불변" 컴파일 SQL 확인.
- [ ] D3 렌즈 ③ UI 실측: 프리뷰 DOM: U+2014 0건 · 억제 칩 U+2015 · ko/en · **스위치 off 회귀 0**.
- [ ] D4 판정문: 항목별 통과/실패/**미검증**.

---

## P1. 달력 월 프리셋 + MoM 이식 (Q2b)

P0 와 **병렬 가능**하지만 자원이 부족하면 **가장 먼저 자른다**(§자를 순서).

- [ ] E1 (kpi) `lib/kpi/calendar-month-compare.ts`: `mom.ts` 복사·개명, 공용 타입은
      `period-compare.ts` import 로 교체. `computeCompare(kind:"calendarMonth", before)` 분기.
      `start_month` 2단 판정 + 신규 인입 **첫째 주 7일** 유지. 테스트 동반 복사.
- [ ] E2 (kpi) 달력 월 3구간(`before`·`prev`·`cur`)을 `readComparePeriods` 의 `windows` 로
      해소. **`summary-mom-aggregates.ts` 는 이식하지 않는다**(design §13-3 B).
      mom `int.test` 의 2026-07/08/09 골든을 새 읽기 위에서 재현해 **동치 증명**.
- [ ] E3 (ui) 프리셋 2종 `thisMonth`·`lastMonth` + i18n("이번 달"/"지난달") + 월 경계(KST).
- [ ] E4 (ui) `components/dash/mom-delta-line.tsx` 복사 + 칩 import 를 C1 로 교체.
      `mom-delta-line.render.test.tsx` 복사.
- [ ] E5 (bff) 화면 키 `S2.momDelta` 를 `SUMMARY_SCREEN_KEYS` + `SUMMARY_SCREEN_OPT_IN` 에 +
      `lib/summary/read/mom-flag.ts` 복사 + `scripts/db/enable-mom-delta-screen.sql` 복사.

---

## P2. 나머지 지면 (밀려도 되는 것)

- [ ] F1 (ui) 지면 6~12 배선: 4KPI 탭 경쟁사 미니카드·경쟁사 표·우호도·우선노출도·
      웹사이트/프로젝트 언급 요약. 프로젝트 표면은 Q5=a 로 **제외**(`unsupported` 캡션).
- [ ] F2 (ui) 기존 Δ 칩 6곳을 C1 공용 프리미티브로 통합(**값 diff 0** 리팩터).
- [ ] F3 (ui) `yearly` 프리셋: 지금은 항상 억제라 값이 없다.

---

## 자를 순서 (범위 축소 시 이 순서로)

시간이 모자라면 **아래에서 위로** 자른다. 각 항목은 자른 뒤에도 화면이 정합하다.

| 순 | 자르는 것 | 왜 안전한가 | 잃는 것 |
| --- | --- | --- | --- |
| 1 | **P1 달력 월 프리셋 전체(E1~E5)** | 신규 프리셋 2종이라 기존 화면에 **무영향**. GGMD-107 원문 요구는 N일 프리셋이다 | MoM 정책 화면 노출. 태블로(Data Inside) 쪽은 영향 없음 |
| 2 | **F3 `yearly`** | 직전 1년 창에 회차 0이라 어차피 "―" 만 나온다 | 없음(문구만 종전) |
| 3 | **F2 칩 통합 리팩터** | 1차는 기존 칩 6곳에 **억제 상태만 최소 추가**로 대체 가능 | 6곳이 갈릴 위험(후속에서 통합) |
| 4 | **F1 지면 6~12** | 1차는 지면 1~5(대시보드·인용 현황). 나머지는 종전 Δ 유지 | 답변분석 탭의 기간 비교 |
| 5 | **C5 라벨 정정** | 문구 전용이라 언제든 별도로 나간다 | 라벨 불일치 잔존 |
| 6 | **`biweekly`(14일)** | 프리셋 하나만 종전 Δ | 2주간 비교 |

⚠️ **자르지 않는 것**: A5(EXPLAIN 3 워크스페이스) · D1~D4(검증) · B3(off 회귀 0) ·
C3 의 U+2014 0건 테스트. 범위를 줄이되 **검증은 줄이지 않는다.**

**1 을 가장 먼저 자르는 판단은 제품 책임자가 뒤집을 수 있다**: Q2b 를 명시 결정한 것이 제품 책임자이므로,
P1 을 살리고 대신 P2(F1) 를 먼저 자르는 선택지도 등가로 열어 둔다.

---

## 하루 타임라인 (KST, 2026-09-19)

| 시각 | G-A (kpi) | G-B (bff) | G-C (ui) |
| --- | --- | --- | --- |
| ~10:00 | A1 산식 | B1 스텁 위 게이트웨이 | C1 공용 칩 · C2 presetRange |
| ~13:00 | A2 · A3 읽기 | B2 캐시 · B3 스위치 | C3 i18n |
| ~15:00 | A4 테스트 · **A5 EXPLAIN** | B4 `E` 전달 배선 | C4 지면 1~5 |
| ~16:00 | (여유) P1 E1·E2 | (여유) P1 E5 | C5 라벨 · (여유) P1 E3·E4 |
| ~17:00 | **통합** impl 워크트리: kpi → bff → ui · `lint` + `tsc --noEmit` | | |
| ~18:00 | G-D 검증(별도 워크트리·고정 sha) | | |
| ~20:00 | 지적 수리 → 제품 책임자 판정 → 프리뷰 | | |

**체크포인트 15:00**: A5 EXPLAIN 이 예산을 넘거나 A3 이 안 끝났으면 그 시점에
"자를 순서" 1·2 를 즉시 적용하고 제품 책임자에게 한 줄 통보한다.
