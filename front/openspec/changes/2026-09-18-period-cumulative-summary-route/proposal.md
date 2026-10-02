# 기간 누적을 집계층이 직접 서빙한다 (미러 폴백 제거)

## Why

기간을 30일(2026-08-20..2026-09-18)로 지정하면 **글로벌 대시보드 KPI 카드가 비고**,
**웹사이트 오버뷰는 프로덕션에서도 빈다**. 원인은 데이터 부재가 아니라 읽기 경로다:

1. 두 페이지가 기간 유무로 `cumulative` 를 세운다
   (`app/[locale]/(dash)/dashboard/page.tsx:102`, `app/[locale]/(dash)/website/page.tsx:111`).
2. 게이트가 `cumulative` 를 **미지원 축**으로 보고 사실표 리더를 포기한다
   (`lib/summary/read/gate.ts:140`).
3. 그래서 카드가 미러 직조회로 떨어지고, 30일은 회차 4개분(글로벌) 모수라
   `MIRROR_HEAVY_PROFILES.cardsMirror`(문장 10s / 벽시계 30s,
   `lib/scope/kpi-tab-budget.ts:485`)를 넘겨 `[kpi-tabs] … timed out` 으로 degrade 된다.

같은 요청의 **추이 경로는 이미 집계층에서 4회차를 읽고 있다**
(런타임 로그 `x-hmg-summary(global S1.dashboard period): hit cycles:4`).
즉 "기간 = 회차 누적"을 집계층이 서빙할 능력은 이미 있고, 카드 경로만 그 문을 안 쓴다.

증상은 성능이지만 **결함의 자리는 라우팅**이다. statement_timeout 상향은 증상을 가릴 뿐이라
기각한다(design.md "기각한 안" 1).

## What Changes

- **게이트 판정**(`lib/summary/read/gate.ts`): `cumulative` 를 무조건 미지원 축으로 보지 않는다.
  기간이 실제로 걸린 요청은 `mode: "period"` 로 받고, 기간이 없는 `cumulative` 는
  미러 쪽 산식 정본(`cumulativeMode`, `lib/db/repositories/scope-aggregates.ts:1148`)이
  이미 스냅샷이므로 폴백 사유에서 내린다.
- **리더 라우팅**(`lib/scope/server.ts`): 카드 계열 게이트(`viaGlobalS1` :1397 · `viaTrend` :3529)가
  기간 유무로 스냅샷·기간 모드를 고르고, 기간 모드에서는 **세부층 단일 회차 폴백을 금지**한다
  (그 경로는 30일 라벨에 1회차 값을 싣는다).
- **화면 문구**(2순위, 독립 배포): 웹사이트 오버뷰가 예산 초과를 "측정 데이터가 아직 없습니다"
  로 표시하는 것(`app/[locale]/(dash)/website/page.tsx:296-303`)을 대시보드와 같은 degrade
  문구로 가른다(`dashboard/page.tsx:324` 형태).
- 마이그레이션 없음. 집계층 표·인덱스는 그대로 쓴다.
- 켜고 끄는 수단은 기존 `summary_settings.read_screens` 화면 키 하나다. 새 플래그를 만들지 않는다.

## Decisions

- **기간 의미론 정본은 그대로**(제품 책임자 2026-09-16): 기간 없음 = 최신 1회차, 기간 지정 = 그 기간에
  걸치는 회차 앵커 전부 누적. 이 변경은 그 의미론을 **어느 계층이 서빙하는가**만 바꾼다.
- **값은 바뀐다.** 집계층 누적과 미러 누적은 모수·창이 다르다(design.md §4). 그래서 이 변경은
  성능 수정이 아니라 **고객이 보는 숫자의 변경**이고, `S4.subkpi`·`S2.mention` 선례와 같은
  화면 키 opt-in 대상이다. 어떤 키를 언제 켜는가는 제품 결정(design.md §8 옵션 표).
- **웹사이트 1순위는 오늘 상태에서 발화하지 않는다.** 30일 창의 웹사이트 기간 게이트는
  회차 1건(`be63ee63…`, 프로젝트 `5de09736…`, 앵커 2026-09-14, `closed` + 생성 미실행)
  때문에 `unpublished-cycle-in-range` 로 폴백한다(실측, design.md §5). 코드만으로는 안 풀린다.
- **S6.citation·S5.mention 은 이 변경의 2차 대상**이다. 그 화면들은 기간과 무관하게
  `cumulative: true` 를 상시로 넘기므로(`citation/page.tsx:67` 등) 오늘 **항상** 미러다.
  게이트 수정만으로 경로가 바뀌므로 파급이 크고, 별도 워크유닛·별도 opt-in 으로 가른다.

## 코어/테넌트 판정

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| 게이트의 `cumulative` 판정·기간 모드 라우팅 | **코어** | 표면·테넌트 무관한 읽기 계층 규약. HMG 상수를 참조하지 않는다 |
| 기간 모드에서 세부층 단일 회차 폴백 금지 | **코어** | 같은 이유. 회차 집합 의미론의 일반 규칙 |
| degrade 문구 분기(2순위) | **코어** | i18n 키 재사용, 테넌트 문자열 없음 |
| 회차 집합 판정의 "생성 대기" 취급(§5 옵션) | **코어** | `summary_cycles` 원장 규약 |
| 30일 창의 웹사이트 구멍 회차 해소 | **테넌트 운영** | HMG 함대의 특정 회차 생성 실행 |

## 블로커

- **B1 (웹사이트 1순위)**: 위 구멍 회차. 운영 조치(생성 실행) 또는 판정 변경(§5) 중 하나가
  선행되지 않으면 S4 는 코드를 고쳐도 계속 미러로 간다.
- **B2 (값 변경 승인)**: 화면 키 opt-in 은 고객이 보는 숫자를 바꾼다. GGMD 확인 없이 켜지 않는다
  (`lib/summary/read/screens.ts` 의 `SUMMARY_SCREEN_OPT_IN` 계약과 같은 자세).
- **B3 (병합)**: GGMD-107(`feat/GGMD-107-impl`)이 통합 프리뷰 b0f4c59 에 **아직 안 들어와 있다**
  (실측: `fc9663f`·`aaed32f`·`dbca54a`·`0d8468b` 전부 NOT in HEAD). 충돌면은 design.md §9.
