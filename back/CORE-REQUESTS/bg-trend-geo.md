# core·mig 요청: bg-trend-geo (analytics.trend.series T-1 · analytics.geo.markets G-1, BG 라운드)

작성: bg-trend-geo 기능 빌더, 2026-09-28. 기준 커밋 818b56f(독립 검증 conditional, 결함 V1~V5) 위 수정 라운드.
막힌 기능은 없다. 코드 결함(V1·V2)과 명세 반영(V5)은 기능 안에서 고쳤고, 아래는 기능이 고칠 수 없는 등록·결정 두 건이다.
두 건 모두 값은 이미 한 규칙으로 고정했고 회귀 테스트가 현행과의 차이를 재현한다
(`app/features/analytics/trend/series/tests/test_trend_bg_fix.py` test_v3·test_v4).

## R1. mig.known_diff 등록: T-1 M08 유형 추이 분자(검증 V3·2차 D4) (기술 리드·mig)

- **무엇**: `/v1/trend?dimension=type` 의 분자 = 그 유형 신호가 있는 **competitive** 당사 답변(`queries.type_counts_sql` `b.competitive`,
  `GET /v1/mentions/types` M-2 당사 행과 같은 술어). 현행 front typeTrend(scope-aggregates.ts:10568-10596)는 당사 롤업 행 전부(비경쟁 표기 포함)의
  유형 플래그를 센다. 적재 규칙상 당사 행도 brand_competitive(bare, disp)가 거짓일 수 있어 API 분자가 현행 이하가 된다.
- **재현**: 합성 DB global 09-14, k12 현대 당사 행을 competitive=false·t_comparison 1 로 두면 API mention 1·comparison 0, 현행 규칙 2·1.
- **요청**: (1) M-2 미결 1번(모듈-언급.md:181, 같은 쟁점)과 함께 F08·F10 패리티 대조로 확정한다. (2) 확정 전까지 mig.known_diff 에
  `('BG-07', 'analytics.trend.series', 'type_exposure%', 'input', ...)` 로 등록한다. M-2 결정이 competitive 무시로 바뀌면 기능은
  `type_counts_sql` 의 `b.competitive` 한 줄을 M-2 와 같이 바꾼다(두 기능이 같은 술어를 유지해야 카드 = 버킷 합이 성립).
- **막힌 기능**: 없음.

## R2. mig.known_diff 등록: T-1 measured_days(검증 V4·2차 D3) (기술 리드·mig)

- **무엇**: `buckets[].measured_days` = 버킷 답변(cit_in, 필터 축, 계열 합집합 회차)의 measured_at **KST 고유 일수, 엔진 합집합**(설계 A-G5 가 KST 를 명시).
  현행 엔진 추이(scope-aggregates.ts:10551·10653)는 엔진별 `date_trunc('day', measured_at)`(DB 세션 TZ) 고유 일수의 max 다.
- **재현**: k2(gemini)를 09-14 16:30Z(= KST 09-15)로 옮기면 엔진별 일수는 chatgpt 1·gemini 1(max 1), API 는 2.
- **셋째 차이(검증 2차 D3)**: 현행은 (프롬프트·엔진·국가) 셀 대표 1건(kpiTabCellSnapshot DISTINCT ON, scope-aggregates.ts:9730)만 센다.
  API 는 is_rep 과 무관하게 버킷 답변 전부를 센다(core 지표 분모 fetch_counts 도 셀 대표로 거르지 않으므로 같은 답변 집합이 일관된 선택).
  재현: 픽스처 회차 10(09-07) k16(is_rep 거짓, 09-07 측정)·k17(is_rep 참, 09-21)·k18(is_rep 참, 09-21) → API 2, 현행 1
  (`test_trend_bg_fix.py` test_d3). 따라서 등록 문안은 "셀 대표 아님·엔진 합집합·KST" 세 차이를 모두 적는다.
- **요청**: mig.known_diff 에 `('BG-10', 'analytics.trend.series', 'measured_days', 'input', ...)` 등록, A4 고지 문안에 "커버리지 라벨 N일은
  엔진 합집합 KST 일수"를 넣는다. 현행 값을 유지해야 한다고 결정되면 기능이 `dimension=engine` 계열별 measured_days 선택 필드를
  추가형으로 더한다(core 변경 불필요).
- **막힌 기능**: 없음.

## R3. 결정 기록: D13 split_own 행 키 계약(검증 V1) (메인)

- **무엇**: split_own 분리 당사 계열은 정본 키 `own_brand_code`(= key = 관점 brand_code)와 함께 `brand_key`(같은 이름의 rd.dim_brand_name 키,
  없으면 null)를 싣는다. `/v1/mentions/brands` 당사 행의 brand_key 조회 규칙(`brand_names_sql`: name = 관점 brand_code)과 같다.
- **왜**: 설계 A-G7(front-adapter-plan.md:1204)이 "관점 브랜드별 행(각 brand_key)"을 요청했고, mentions 그룹이 같은 split 을 넣을 때
  두 응답의 당사 행을 잇는 키가 필요하다. 이 그룹 안에서는 mentions 쪽 구현을 확인할 수 없어 계약을 여기와 T-1 명세(`bg_additions`)에 적었다.
- **요청**: DECISIONS-API 에 한 줄 기록(mentions 그룹의 split 당사 행도 같은 두 키를 싣는다). 동시 수정 충돌을 피하려고 이 그룹은
  DECISIONS-API 를 고치지 않았다.
- **막힌 기능**: 없음.

## R4. 결정 기록·머지 순서: D13 split_own core 공용 판정 하나(검증 2차 D1) (메인)

- **무엇**: 818b56f 검증 시점에는 이 그룹과 mentions 그룹(ff74b52)이 core/measure.py 같은 자리에 서로 다른 계약의 `split_own_scopes` 를
  추가해 merge-tree 충돌이 났다. mentions 그룹이 9f33bb5 에서 core 추가분(OwnSplit·SPLIT_OWN_*)을 걷고 이 그룹의 `split_own_scopes(ms)`
  (818b56f 와 같은 바이트)를 그대로 호출하도록 바꿨다. 행 키도 같은 식(`Refs.brand_code_of_bit`, mentions/brands/common.own_brand_code_of_bit).
  이 라운드 실측: `git merge-tree --write-tree` 이 그룹 HEAD × feat/bg-mentions-answers 9f33bb5 무충돌.
- **키 규칙(하위 브랜드)**: 관점 [Hyundai N, Kia] 의 분리 키 = Hyundai·Kia(비트 1 의 부모 코드). 검증자 권고(OwnSplit 규칙: 하위 브랜드 단독이면
  그 코드)는 채택하지 않았다. 이유: (1) mentions 그룹이 이미 부모 코드 규칙으로 수렴해 지금 되돌리면 충돌·불일치가 다시 생긴다,
  (2) 분리 값은 비트 단위(own_mask·ment_h 등 G-03 열)라 비트 1 행은 Hyundai 전체 값이다(Hyundai N 만의 값이 아니다),
  (3) 고정색 키(mentions-view.tsx:605 OWN_TREND_COLORS Hyundai/Kia/Genesis)와 맞는다. 하위 브랜드 단독 관점은 비트가 하나라 가르지 않으므로
  own_label 'Hyundai N' 과 분리 키가 한 응답에 같이 나오는 경우는 없다. 두 응답(mentions·trend) 모두 같은 요청 인자에서 같은 키를 내므로
  front trackedBrands 조인(mentions-view.tsx:638)이 맞는다. 회귀: `test_trend_bg_fix.py` test_d1 두 건(키 규칙, core 단일 정의 계약).
- **머지 순서**: 어느 순서든 core 충돌 없음(두 그룹의 measure.py 가 같은 바이트). 권장 = bg-trend-geo 먼저(정의를 처음 추가한 쪽), 이어서
  bg-mentions-answers. 뒤에 들어오는 그룹이 core 에 split 관련 정의를 새로 추가하면 안 된다(test_d1_core_split_own_single_definition_contract 가 막는다).
- **요청**: DECISIONS-API 에 "D13 분리 행 키 = 비트의 부모 brand_code, brand_key = 같은 이름 조회" 한 줄 기록(R3 와 함께).
- **막힌 기능**: 없음.
- **참고(검증 2차 D7)**: feat/bg-kpi-filters(25ae72c)와의 test_trend.py 같은 줄 충돌은 이 그룹이 kpi-filters 문구로 맞춰 해소했다(동작 무관).
