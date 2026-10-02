# hmg-geo 재설계 DB 설계 결정 기록 (2026-09-27)

제품 결정(22:20): G-01 (a) · G-02 (c) · **v3 폭 10배 게이트 생략** · 나머지 G-03~G-26 권장안 일괄 채택.
정본 설계: [DB-보정.md](DB-보정.md) · 실행 DDL: [DB-v2.sql](DB-v2.sql) · DDL 검증: [DDL-VERIFY.md](DDL-VERIFY.md)

> v3 생략의 의미: 폭 10배(키 카디널리티 10배) 근거 없이 DDL 을 확정한다. v3 에 걸려 있던 판단(G-02 예외 발동, G-17 게이트, G-25 동시성, G-26 인덱스)은 RDS 구축 후 실데이터 실측 게이트로 옮긴다.

## G-01

**쟁점**: G-01. 언급 읽기 그레인: rd.answer_brand(답변 × 표시 브랜드 × 경쟁 여부)를 둘 것인가? 이 결정은 A17 승인 전제를 다시 연다. 명세 P2 는 '사실표·요약 테이블·그레인을 줄인 사본을 두지 않는다'(spec.template.html:146), A17 승인 근거는 '집계가 아니라 그레인이 같은 투영'(:349)이다. 그런데 이 표는 계약 §3 이 '폐기된 v1 슬림 사실표'라 부른 모양을 다시 들여오는 것이다.

**채택**: (a). 다만 v3 에서 (a)·(b) 를 같은 배치로 둘 다 재서 확정한다

> (a) 읽기 = rd.answer_brand(그레인 축소, P2 예외로 명시 승인), 쓰기 = ing.mention 원본. v2 DDL 은 이 안을 전제로 쓰여 있다

**조정**: 제품 확정 (a). v3 동조건 비교는 하지 않는다(v3 생략). P2 예외로 명세에 명시.

<details><summary>선택지·근거</summary>

- (a) 읽기 = rd.answer_brand(그레인 축소, P2 예외로 명시 승인), 쓰기 = ing.mention 원본. v2 DDL 은 이 안을 전제로 쓰여 있다
- (b) 읽기 = rd.answer_entity(ing.mention 과 1:1, 원본 그레인) + 판정 열(name_first, name_rk, competitive, own_bit). P2 를 그대로 지킨다. 영향: 10배 약 5,500만 행(answer_brand 대비 약 2.4~3.7배), M04·M11 은 name_first 행만 세고, 카드가 G-03 (a) 없이는 이 표를 스캔한다. AD-01 은 엔티티 단위로 자연스럽게 풀린다(G-23 불필요). 성능 근거는 v2b(최악 17초, 배치 결함이 섞여 있음)뿐이다
- (c) 둘 다 둔다(파생층이라 D8 위반)

근거: 명세 §6 이 M04·M11 의 단위를 '답변 × 브랜드'로 정의한다. M02·M03 은 합이라 정확히 보존된다. 현행 산식도 이 단위로 접는다(canonRollupSql scope-aggregates.ts:263, ownBrandRankPerJobSql :493). Scope 엔티티 행은 표기별 id 분할(hmg-brands.ts:35)과 오롤업(hmg-brands.ts:63)이 있어 업무 엔티티가 아니다. 반대로 (a) 는 P2 문언 위반이고, (a) 의 성능 우위 근거('v1 F03 601ms 대 v2b 10,274ms')는 이력 복제·조인형·VACUUM 누락이 섞인 대조라 정량 근거가 되지 못한다(lens3 m8). 그래서 결정 시점에 v3 의 (a)/(b) 동일 조건 비교를 요구한다. (a) 를 고르면 G-23(AD-01)을 함께 정해야 한다

</details>

## G-02

**쟁점**: G-02. 인용 읽기 그레인

**채택**: (c)

> (c) (a) 를 정본으로 두고, v3 에서 인용 계열 기능이 명세 합격선을 넘으면 그 기능에 한해 (b) 를 D8 예외로 승인

**조정**: 제품 확정 (c). 예외 발동 판정은 v3 대신 **RDS 구축 후 실데이터 콜드 실측**에서 한다.

<details><summary>선택지·근거</summary>

- (a) 인용 원소 1:1(rd.citation) 하나만
- (b) (a) + 답변 × 출처 키 × 자사 판정 표(cit_cnt) 추가(D8 예외)
- (c) (a) 를 정본으로 두고, v3 에서 인용 계열 기능이 명세 합격선을 넘으면 그 기능에 한해 (b) 를 D8 예외로 승인

근거: M05·M09·M10 단위 = 인용 행(scope-aggregates.ts:3009-3010), 자사 판정은 URL 단위(:6885). 성능 추정은 v1 이 '경계'라 적었지만 정정하면 '초과 예상'이다(웹 1년 1.7~2.0초/3 프로세스, 독점 7 프로세스 가정으로도 콜드 약 1.0~1.2초, 동시성까지 넣으면 더 나쁨). 이 배치에 직접 대응하는 실측은 없다. 따라서 (b) 예외가 필요할 가능성이 높다는 점을 미리 알린다

</details>

## G-03

**쟁점**: G-03. rd.answer 에 당사 측정값(M01 등장 비트, M04 최선 순위, M02·M03 합, 톤, M06·M07 불리언)을 판정 열로 둘 것인가

**채택**: (a)

> (a) 둔다 + 적재 불변식 단언(자사 행 합 = 답변 열, 게이트 동치) + 야간 감사

<details><summary>선택지·근거</summary>

- (a) 둔다 + 적재 불변식 단언(자사 행 합 = 답변 열, 게이트 동치) + 야간 감사
- (b) 최소(own_mask, own_rk_*, M06·M07 불리언)만 두고 M02·M03 은 rd.answer_brand FILTER
- (c) 두지 않는다

근거: 값이 답변 키에 1:1 종속이고 당사 명부가 3사로 닫혀 있다. 가장 자주 불리는 카드·추이가 자식 스캔에서 빠진다. 화면 단위 동시성(G-25)에서 CPU 여유가 가장 크게 생기는 레버다. 비용은 두 가지다. 같은 값의 원천이 둘이 되므로 불변식 단언이 필수이고, 명부 변경 시 전 기간을 재계산해야 한다. D8 긴장 ②로 분류한다

</details>

## G-04

**쟁점**: G-04. 명세의 '앵커 날짜'를 어느 컬럼에 매핑할 것인가

**채택**: (a)

> (a) round_date(정규 요일 귀속), anchor_date 는 기록용

<details><summary>선택지·근거</summary>

- (a) round_date(정규 요일 귀속), anchor_date 는 기록용
- (b) anchor_date

근거: 현행 화면 시계가 이미 round_date 이다(anchorDateColumnSql lib/db/repositories/scope-answer-anchors.ts:380). 명세 R02·R05·R06 문구를 정정해야 한다

</details>

## G-05

**쟁점**: G-05. A16 분석 결손 원천과 R12 재확인 창

**채택**: (a)

> (a) Scope analysis.status 저장·판정(completed·partial = 분석됨), 과거분은 재수집, 못 채우면 대용식 + 표시, 분석 재확인 창 7일

<details><summary>선택지·근거</summary>

- (a) Scope analysis.status 저장·판정(completed·partial = 분석됨), 과거분은 재수집, 못 채우면 대용식 + 표시, 분석 재확인 창 7일
- (b) 대용식만
- (c) 언급 행이 없으면 결손

근거: 미러는 분석 여부를 구분하지 못한다(REPORT-addendum2 §2). status 타입은 이미 있다(lib/scope/types.ts:466). 라이브 응답이 이 값을 채우는지는 미확인이다

</details>

## G-06

**쟁점**: G-06. 설정 의존 게이트를 사실 행에 굳힐 범위

**채택**: (a)

> (a) 프롬프트·국가 단위 게이트는 굳히고 judgment_change 로 재판정, 회차 상태는 rd.cycle 허용 배열, 택소노미·태그는 prompt_key 집합(1,000 초과면 semi-join)

<details><summary>선택지·근거</summary>

- (a) 프롬프트·국가 단위 게이트는 굳히고 judgment_change 로 재판정, 회차 상태는 rd.cycle 허용 배열, 택소노미·태그는 prompt_key 집합(1,000 초과면 semi-join)
- (b) 전부 조회 시
- (c) 회차 상태까지 굳힌다

근거: v1 의 모순(배열이 수천 개면 흔들린다고 하면서 택소노미를 배열로 푼 것, lens3 m6)은 1,000 초과 semi-join 전환 규칙으로 해소했다. 두 경로 모두 v3 에서 잰다

</details>

## G-07

**쟁점**: G-07. 자식 표 기간 가지치기

**채택**: (a)

> (a) 공동 파티션 + partitionwise join

<details><summary>선택지·근거</summary>

- (a) 공동 파티션 + partitionwise join
- (b) 키 범위 BRIN
- (c) 없음

근거: (b) 는 증분 적재에서 무너진다(v2 10배). (a) 는 어느 프로토에서도 재지 않았으므로 v3 에서 계획 시간·안정성을 확인해야 한다(lens3 B4)

</details>

## G-08

**쟁점**: G-08. 문서형 데이터 읽기 경로

**채택**: (a)

> (a) rd 뷰 6개(v_answer_body, v_answer_mention_raw, v_answer_occurrence, v_answer_stance_raw, v_answer_registry + 인용은 rd.citation⋈dim_url)로 answer_key 등치 조회만, 뷰는 rd.job 스코프 열을 포함하고 소유자는 loader_ro

<details><summary>선택지·근거</summary>

- (a) rd 뷰 6개(v_answer_body, v_answer_mention_raw, v_answer_occurrence, v_answer_stance_raw, v_answer_registry + 인용은 rd.citation⋈dim_url)로 answer_key 등치 조회만, 뷰는 rd.job 스코프 열을 포함하고 소유자는 loader_ro
- (b) rd 로 복제
- (c) 드릴다운만 ing 직접 조회

근거: v1 은 뷰 3개만 두고 기능 매핑이 ing 를 직접 읽는 모순이 있었다(lens1 B1). 필요한 PK 조회를 전부 뷰로 열거했다. 스코프 열을 포함해 fail-open 도 막는다(lens2 m8)

</details>

## G-09

**쟁점**: G-09. summary_cycles·summary_cycle_runs 처리와 원장 카운터

**채택**: (a)

> (a) 운영자 필드를 ing.cycle·cycle_run 으로 이관하고 표는 폐기. 카운터는 R01·R08 근거로만 두고 D8 예외 ③으로 명시

<details><summary>선택지·근거</summary>

- (a) 운영자 필드를 ing.cycle·cycle_run 으로 이관하고 표는 폐기. 카운터는 R01·R08 근거로만 두고 D8 예외 ③으로 명시
- (b) 재계산
- (c) 이름만 변경

근거: 두 표는 원장이고 재계산으로 복원되지 않는다(0078_answer_cycle_anchor_hot_path.sql:479-489). 카운터는 답변을 가로지르는 합이므로 예외 목록에 명시했다(lens1 m4)

</details>

## G-10

**쟁점**: G-10. 이관 시드 원천과 병행 기간 적재 원천

**채택**: (a)

> (a) 미러 COPY 시드(measured_at 원복) + 새 로더는 Scope API 직접 pull

<details><summary>선택지·근거</summary>

- (a) 미러 COPY 시드(measured_at 원복) + 새 로더는 Scope API 직접 pull
- (b) 병행 기간에 미러 증분 복사
- (c) 전 기간 Scope API

근거: 입력을 같게 해야 차이를 규칙으로 귀속할 수 있다. Scope API 이중 pull 을 Scope 쪽이 수용하는지는 미확인이다

</details>

## G-11

**쟁점**: G-11. ACR 시간축·숨김·롤업 PK

**채택**: (a)

> (a) A1·R05 적용, mentions 숨김, PK 에 rollup_level

<details><summary>선택지·근거</summary>

- (a) A1·R05 적용, mentions 숨김, PK 에 rollup_level
- (b) 현행 유지

근거: 한 화면에 두 시간 규칙이 생기는 것을 막는다. 현행 레벨 접기는 임시 조치다(lib/scope/mirror/sync.ts:1149)

</details>

## G-12

**쟁점**: G-12. GA4 저장 그레인·분모·기본 기간, DataForSEO 신선도

**채택**: (a)

> (a) GA4 는 보고서 행 원본 그레인(rd.ga4_row, 채널·소스 보존, is_ai·engine·is_conv 는 판정 열), 전환율 분모 = 세션, 사용자 수는 행 사이 합산 금지(기간 사용자 수는 제공하지 않음), 기본 90일. DataForSEO 는 원본 응답 적재 + 수집 정책

<details><summary>선택지·근거</summary>

- (a) GA4 는 보고서 행 원본 그레인(rd.ga4_row, 채널·소스 보존, is_ai·engine·is_conv 는 판정 열), 전환율 분모 = 세션, 사용자 수는 행 사이 합산 금지(기간 사용자 수는 제공하지 않음), 기본 90일. DataForSEO 는 원본 응답 적재 + 수집 정책
- (b) (a) + 기간 사용자 수가 꼭 필요하면 GA4 창 합계를 D8 예외로 저장
- (c) 현행 직결

근거: v1 의 일 합산 표는 그레인 축소라 A17 승인 범위 밖이었다(lens1 B2). 원본 그레인으로 되돌렸다. 활성 사용자는 비가산이라 합산하면 과대 계상된다(lens1 m9)

</details>

## G-13

**쟁점**: G-13. crawl·webgeo·컨텍스트 맵 이관

**채택**: (a)

> (a) crawl S3 보관, webgeo ext 정적, 컨텍스트 맵 스냅샷

<details><summary>선택지·근거</summary>

- (a) crawl S3 보관, webgeo ext 정적, 컨텍스트 맵 스냅샷
- (b) 전부 RDS
- (c) crawl 폐기

근거: crawl_* 참조가 0건이다(03-db-live-catalog.md §4). 용도가 미확인이라 폐기는 금지한다

</details>

## G-14

**쟁점**: G-14. 앱 정본 분류·전파·소급

**채택**: (a)

> (a) app 은 OLTP, 판정 입력 변경은 judgment_change 로 비동기 재판정(rd 쓰기는 적재기만), 현행 카탈로그 소급

<details><summary>선택지·근거</summary>

- (a) app 은 OLTP, 판정 입력 변경은 judgment_change 로 비동기 재판정(rd 쓰기는 적재기만), 현행 카탈로그 소급
- (b) app 을 rd 로 복제하고 동기 재판정
- (c) 소급 없음

근거: v1 의 앱 트리거가 rd.catalog_entry 를 직접 쓰던 경로를 제거했다(lens1 B4). 카탈로그 투영과 답변 판정이 한 트랜잭션에서 바뀐다

</details>

## G-15

**쟁점**: G-15. 판정 규칙 정본과 비트 공간

**채택**: (a)

> (a) DB 참조 표(app.*, 경쟁사 도메인 토큰 포함) + rule_set 지문 13개 필수 + 단일 비트 공간

<details><summary>선택지·근거</summary>

- (a) DB 참조 표(app.*, 경쟁사 도메인 토큰 포함) + rule_set 지문 13개 필수 + 단일 비트 공간
- (b) Python 상수
- (c) TS 상수 + 복제

근거: v1 에는 경쟁사 도메인 규칙이 빠져 있었다(lens2 m3). 지문 목록을 CHECK 로 강제해 누락을 막는다

</details>

## G-16

**쟁점**: G-16. 적재·재계산 방식

**채택**: (a)

> (a) 해시 diff, DB 함수 한 벌, 스테이지 단일 반영, 반복 job 보존, 게이트 전파 함수, leaf 스왑

<details><summary>선택지·근거</summary>

- (a) 해시 diff, DB 함수 한 벌, 스테이지 단일 반영, 반복 job 보존, 게이트 전파 함수, leaf 스왑
- (b) 현행 방식

근거: 전면 교체 비용, 청크 커밋의 부분 가시 상태, 원본 손실을 막는다. 게이트 사본 전파를 함수로 강제한다(lens1 B3)

</details>

## G-17

**쟁점**: G-17. 10배 정의·기간 상한·v3 게이트

**채택**: (a)

> (a) SLO 기준 = 폭 10배(키 카디널리티 10배 합성) × 최대 창 1년 × 이력 1년. v3 게이트(perf_evidence 명세)를 DDL 확정 전에 통과해야 하고, 불합격 계열은 창 상한 13주 또는 G-02 예외

**조정**: 권장 (a) 의 'v3 게이트를 DDL 확정 전에 통과'는 제품 결정(v3 생략)으로 **RDS 구축 후 실측 게이트**로 옮긴다. SLO 정의(폭 10배 × 1년 창)는 유지하되 폭 10배 근거 없이 진행하는 위험을 수용.

<details><summary>선택지·근거</summary>

- (a) SLO 기준 = 폭 10배(키 카디널리티 10배 합성) × 최대 창 1년 × 이력 1년. v3 게이트(perf_evidence 명세)를 DDL 확정 전에 통과해야 하고, 불합격 계열은 창 상한 13주 또는 G-02 예외
- (b) 이력 10배(현 하네스) 기준으로 확정
- (c) 창 상한 없이 사양만 키움

근거: 지금까지의 실측은 이력 10배였다(lens3 B1). 폭 10배 근거가 0 이므로 합성 방법을 게이트에 명시하지 않으면 같은 복제법이 되풀이된다. D8 안에서 쓸 수 있는 레버는 가지치기·병렬도·사양·창 상한뿐이다

</details>

## G-18

**쟁점**: G-18. 운영 화면 범위: 엔티티 카탈로그·인용 큐레이션 기간, QA 신원, 감사 보존

**채택**: (a)

> (a) AD-01·인용 출처 큐레이션(citation-overrides.ts:137 전 기간 상위 500) 모두 기간 필수(기본 최신 노출 회차), admin_long 롤로 최대 1년. QA = Supabase 계정 + is_qa_reviewer. 접근 로그 13개월

<details><summary>선택지·근거</summary>

- (a) AD-01·인용 출처 큐레이션(citation-overrides.ts:137 전 기간 상위 500) 모두 기간 필수(기본 최신 노출 회차), admin_long 롤로 최대 1년. QA = Supabase 계정 + is_qa_reviewer. 접근 로그 13개월
- (b) 현행 유지

근거: 전 기간 전수 집계는 10배에서 1초가 불가능하고, 카운터는 D8 위반이다. 큐레이션 화면을 범위에 추가했다(lens2 m9)

</details>

## G-19

**쟁점**: G-19. 전환 게이트와 순서

**채택**: (a)

> (a) 그룹 순차, 연속 2회차 무결점, R12 재수집 먼저

<details><summary>선택지·근거</summary>

- (a) 그룹 순차, 연속 2회차 무결점, R12 재수집 먼저
- (b) 1회차 + 7일
- (c) 3회차 + 30일

근거: 두 코호트로 재현성을 확인한다. 표본 run 953eb87f-da37-4a7b-9360-059b4b095255 로 늦은 분석 재수집이 되는지 먼저 확인한다

</details>

## G-20

**쟁점**: G-20. 언급 계열 정의 변경 묶음(A4 1회 고지)

**채택**: (a)

> (a) 표시 브랜드 수준 자사, 유형×감성·엔티티 행 수를 브랜드 등장 단위로, M08 = 유형별 답변 수, 비경쟁은 competitive=false 로 보존

<details><summary>선택지·근거</summary>

- (a) 표시 브랜드 수준 자사, 유형×감성·엔티티 행 수를 브랜드 등장 단위로, M08 = 유형별 답변 수, 비경쟁은 competitive=false 로 보존
- (b) 행 rid 기준 유지

근거: G-01 (a) 를 전제로 한다. (b) 를 고르면 G-01 (b) 가 필요하다

</details>

## G-21

**쟁점**: G-21. 인용 계열 정의 변경 묶음(A4 1회 고지)

**채택**: (a)

> (a) 호스트 없는 인용 전 기능 제외, Scope 행 카테고리 무시, 도메인 표 프롬프트 수는 측정 단위, 타겟은 프롬프트 자신 기준, owner_key + 허용 배열, 유닛 키 (사이트, file_seq), 그리고 (g) 언급 분석 결손 답변의 인용도 인용 지표 모수에 포함(cit_in = elig ∧ acr_in)

<details><summary>선택지·근거</summary>

- (a) 호스트 없는 인용 전 기능 제외, Scope 행 카테고리 무시, 도메인 표 프롬프트 수는 측정 단위, 타겟은 프롬프트 자신 기준, owner_key + 허용 배열, 유닛 키 (사이트, file_seq), 그리고 (g) 언급 분석 결손 답변의 인용도 인용 지표 모수에 포함(cit_in = elig ∧ acr_in)
- (b) 현행 유지
- (c) (a) 에서 (g) 만 빼고 인용 모수에서 결손 답변을 제외(std_in, 프로토 v2 와 같음)

근거: 인용은 result.citations 에서 오고 언급 분석에 의존하지 않는다. v1 은 결손 답변을 조용히 빼는 정의 변경을 고지 목록에 넣지 않았다(lens1 m7). (g) 를 명시 항목으로 올렸고, 호환 비교를 위해 gap 사본을 보존한다

</details>

## G-22

**쟁점**: G-22. 리포트 발행값 적용 범위

**채택**: (a)

> (a) 발행 회차는 모든 모드에서 대체, 미지원 축은 라이브 + 표식

<details><summary>선택지·근거</summary>

- (a) 발행 회차는 모든 모드에서 대체, 미지원 축은 라이브 + 표식
- (b) 스냅샷 카드만

근거: D6(카드 = 추이 합)을 지키기 위해서다. rd.report_unit_value 는 적재기가 쓴다

</details>

## G-23 (신설, lens2 B1)

**쟁점**: G-23 (신설, lens2 B1). AD-01 엔티티 카탈로그의 엔티티별 언급 수·답변 수를 어떻게 제공할 것인가. 현행 listDiscoveredBrands(lib/db/repositories/entity-registry.ts:79)는 entity_id 단위 집계이다. G-01 (a) 의 rd.answer_brand 에서는 한 표시 브랜드로 접히는 여러 entity_id 를 가를 수 없다

**채택**: (a). 운영자가 엔티티별 빈도를 꼭 필요로 하면 (b)

> (a) 재정의: 엔티티 목록(rd.dim_entity ⋈ app.entity_registry, entity_type·대표 표기·귀속 브랜드·역할)은 엔티티 단위로, 언급 수·답변 수는 표시 브랜드 단위(rd.answer_brand, 기간 필수)로 제공. 엔티티별 수는 제공하지 않음

<details><summary>선택지·근거</summary>

- (a) 재정의: 엔티티 목록(rd.dim_entity ⋈ app.entity_registry, entity_type·대표 표기·귀속 브랜드·역할)은 엔티티 단위로, 언급 수·답변 수는 표시 브랜드 단위(rd.answer_brand, 기간 필수)로 제공. 엔티티별 수는 제공하지 않음
- (b) 관리자 전용 예외: admin_long 롤이 기간 상한(최대 1회차)을 둔 SECURITY DEFINER 함수로 ing.mention 을 범위 스캔(계약 §5 의 단일 명시 예외, 1초 SLO 제외)
- (c) G-01 (b) 를 채택해 rd.answer_entity 에서 자연스럽게 계산

근거: (a) 는 계약을 지킨다. 역할 지정(own·excluded)은 엔티티 목록과 소속 브랜드만 보고도 할 수 있다. (b) 는 계약 예외를 하나 여는 대신 현행 기능을 보존한다. 엔티티 누적 카운터는 D8 위반이라 선택지에 없다

</details>

## G-24 (신설, lens2 B2(다))

**쟁점**: G-24 (신설, lens2 B2(다)). QA 검수 모집단

**채택**: (a)

> (a) 모든 Scope job(비완료·드롭 포함, 현행 qa-review.ts:217-224 와 같음), 목록에 status·드롭 표시, 상세에서 드롭 사유 표시

<details><summary>선택지·근거</summary>

- (a) 모든 Scope job(비완료·드롭 포함, 현행 qa-review.ts:217-224 와 같음), 목록에 status·드롭 표시, 상세에서 드롭 사유 표시
- (b) 완료 job 만(드롭 포함)
- (c) 서빙 답변(rd.answer)만

근거: 현행 동작을 보존한다. rd.job 이 모든 job 을 담으므로 추가 비용 없이 가능하다. (c) 로 하면 드롭·비완료 job 이 목록에서 사라져 운영 검수 경로가 끊긴다

</details>

## G-25 (신설, lens3 B3)

**쟁점**: G-25 (신설, lens3 B3). 명세 '모든 기능 API 콜드 p95 ≤ 1초'의 동시성 조건. 화면 하나가 API 5개 이상을 동시에 부르므로 쿼리당 병렬 워커를 독점한다는 가정이 성립하지 않는다

**채택**: (a). 필요하면 (c) 를 함께

> (a) 명세를 그대로 두고 '화면 단위 동시 호출 상태(사용자 1·3·5명)에서 각 API 콜드 p95 ≤ 1초'로 v3 게이트에 적용. 미달이면 사양 상향(16 vCPU)·읽기 복제본·max_parallel_workers_per_gather 조정으로 대응

**조정**: 권장 (a). 동시성 조건 측정도 RDS 구축 후 실측 게이트에서.

**반영(2026-09-28, DB-v2.2)**: stg 실측(동시 5명 웹사이트 1년 summary·trend p95 1.1~1.5초)으로 제품 책임자가 rd.answer 답변당 인용 수 열을 결정(DESIGN-CONTRACT §3 G-25).
`back/db/DB-v2.2-patch.sql`: `cit_n`(호스트 있는 인용), `cit_own_h/k/g`(owner_key 브랜드별 자사), `cit_own_hc/kc/gc`(소유 베이스 국가 = 답변 국가),
`cit_own_x`(교차 국가 자사, 다국가 필터 시 원소 조회 표식), `cit_loc`·`cit_tgt`·`cit_loc_tgt`(프로젝트·타겟·웹사이트 자사). 전부 int2 NOT NULL DEFAULT 0,
btree 제외(HOT). 불변식 = `rd.assert_answer_cit_counts`(자식 합) + CHECK `answer_cit_bounds`·`answer_cit_flags`. 빌더 = `app.core.measure`.

<details><summary>선택지·근거</summary>

- (a) 명세를 그대로 두고 '화면 단위 동시 호출 상태(사용자 1·3·5명)에서 각 API 콜드 p95 ≤ 1초'로 v3 게이트에 적용. 미달이면 사양 상향(16 vCPU)·읽기 복제본·max_parallel_workers_per_gather 조정으로 대응
- (b) 명세 완화: 동시 N 에서 p95 ≤ 1.5초 허용(명세 변경)
- (c) 화면별 API 를 병합해 동시 호출 수를 줄이는 것을 API 설계 조건으로 추가

근거: v1 이 '동시 4 p95 ≤ 1.5초'를 G-17 옵션 문장 안에 묻어 명세를 완화했던 것을 분리했다. 완화는 제품 책임자만 결정할 수 있다

</details>

## G-26 (신설, lens1 m6)

**쟁점**: G-26 (신설, lens1 m6). A17·P6 이 정한 '커버링 인덱스' 수단에서 벗어나는 것

**채택**: (a)

> (a) 사실 표에 넓은 커버링 인덱스를 두지 않고, 좁은 월 leaf 병렬 순차 스캔 + HOT 규율을 쓴다. v3 에서 필터 옵션 전 기간 등 특정 경로가 불합격하면 재판정 열을 빼고 만든 커버링 인덱스를 경로별로 추가

**조정**: 권장 (a). 'v3 조건부 추가'는 RDS 실측 조건부로.

<details><summary>선택지·근거</summary>

- (a) 사실 표에 넓은 커버링 인덱스를 두지 않고, 좁은 월 leaf 병렬 순차 스캔 + HOT 규율을 쓴다. v3 에서 필터 옵션 전 기간 등 특정 경로가 불합격하면 재판정 열을 빼고 만든 커버링 인덱스를 경로별로 추가
- (b) A17·P6 문언대로 ix_answer_pick 류 넓은 커버링 인덱스(판정 열 INCLUDE)를 둔다

근거: 판정 열 INCLUDE 는 재판정 UPDATE 의 HOT 을 깨고, 가시성 맵이 비면 heap fetch 로 무너진다(v2 10배 C01 F01 heap_fetches 2,618,962). 다만 (a) 의 성능 근거도 이 배치에서는 미측정이라 v3 조건부다

</details>

---

### DB-v2.5 (2026-09-28, core 5라운드) P42 rd.answer_stance.cyc_key

스탠스 표에만 회차 키가 없어 사실 표 3술어(surface·round_date·cyc_key, SQL 경계 가드 G1)와 회차 숨김(hidden_scope 3·1) 판정을 걸 수 없었다.
가드 예외(rd.answer 조인 면제)가 아니라 다른 사실 표(answer_brand·citation)와 같은 투영 규칙으로 연다: `cyc_key int4 NOT NULL`(기본값 없음,
적재 투영 누락은 INSERT 실패로 드러난다), 기존 행은 rd.answer 등치 조인으로 채우고 고아 0 단언, `rd.propagate_answer_gates` 가 std_in 과 함께
cyc_key 를 맞추고 단언, 인덱스 `st_cyc_idx (cyc_key)`(rd.answer answer_cyc_idx 와 같은 규칙: cyc_key 는 rd.answer 쪽도 btree 에 있어 새 HOT 제약
아님). 패치 `back/db/DB-v2.5-patch.sql`, 합본 `DB-v2.5.sql` = v2.4 + 패치.

### DB-v2.6 (2026-09-28, core 6라운드) P43~P52 비분석·적재 요청

| 패치 | 내용 | 근거 |
| --- | --- | --- |
| P43 | `rd.kw_suggestion.observed_at timestamptz NOT NULL`(기존 행 = `ext.dfs_call.requested_at`, NULL 0 단언) | intent R4: related·search 신선도(TTL 7일)를 rd 만으로 |
| P44 | `app.project_tracked_keyword.term_norm` 생성 열 = `lower(btrim(normalize(term, NFC), 공백류 29자))` + 유니크 `(project_id, term_norm, coalesce(country_code, ''))`. 기존 행 중 프로젝트 국가와 같은 country_code 는 NULL 로 정규화, 중복이 남으면 적용 중단 | intent R10: 'A'·'a', NULL·'kr' 이중 행. 식은 `core.kw.term_norm`(NFC → str.strip → lower) 과 골든 세트로 대조(tests/core/test_round6.py) |
| P45 | `app.ga4_property (brand_code, country_code)` 부분 유니크(brand_code NOT NULL) | ad-ops R7: 동시 PUT 경합 |
| P46 | `GRANT EXECUTE rd.today_kst() TO admin_long` | ad-content R2: 관리 조회가 같은 스냅샷에서 창 해석 |
| P47 | qa_gate SELECT: `app.brand`·`app.citation_category`·`app.citation_domain_override` 전체, `app.prompt` 16열 | qa R1 |
| P48 | `rd.analyze_facts(regclass[])` SECURITY DEFINER(허용 = rd·ing 표, 소유자 = rd.answer 소유자), EXECUTE → loader | ingest R4. PG17 `GRANT MAINTAIN` 은 파티션마다 검사해(부모에만 주면 leaf 전부 경고 후 건너뜀, 로컬 실측) 새 leaf 마다 부여가 필요해 기각 |
| P49 | `ing.citation USING hash (url)` | ingest R5 |
| P50 | 제약 트리거 `ua_last_admin`(AFTER UPDATE OR DELETE, DEFERRABLE INITIALLY DEFERRED): 실효 admin(role admin ∧ active ∧ menu_groups NULL ∨ 'admin' 포함)이 0 이 되면 23514 | ad-ops R11(메인 결정: 운영 사고 방지). 앱은 먼저 409 |
| P51 | `ing.stage_answer.answer_key` NULL 허용 | ingest R11: 0 대신 NULL(키 누락이 ing.answer NOT NULL 로 드러남) |
| P52 | `mig.known_diff` AD-2(엔티티 수치: 모수 게이트 std_in ∧ dflt·표시 브랜드 단위·기간 필수, A4 고지) | ad-content R7(메인 결정: 게이트 유지) |

패치 `back/db/DB-v2.6-patch.sql`(재적용 거부·행 수 단언), 합본 `DB-v2.6.sql` = v2.5 + 패치. qa R5(노트 커서 인덱스 방향)·intent R9(ctx_combination
인덱스)는 소량·실측 게이트 전이라 넣지 않았다.

### DB-v2.7 (2026-09-28, core 6라운드 독립 검증 수정) P53~P56

| 패치 | 내용 | 근거 |
| --- | --- | --- |
| P53 | `app.tg_last_admin_guard` 가 판정 전에 남은 실효 admin 행을 FOR SHARE 로 잠근다(SECURITY DEFINER, 소유자 = app.user_account 소유자). READ COMMITTED 는 재평가 뒤 23514, REPEATABLE READ·SERIALIZABLE 은 40001, 서로의 행을 잠근 경우 40P01 | 검증 m-2: v2.6 은 RR 트랜잭션 둘이 admin 2명을 각각 정지시키면 둘 다 커밋됐다(로컬 재현: RC 교차·RR 교차·RR 순차 3조합 실패 → 수정 뒤 6조합 통과) |
| P54 | `app.project_tracked_keyword.country_code` = `app.project.country_code` 와 같은 ISO 대문자. 기존 행 upper(btrim) → 프로젝트 국가와 같으면 NULL → 중복 0 단언 → CHECK `ptk_country_upper` | 검증 m-4 |
| P55 | `app.term_norm(text)` IMMUTABLE(식 = lower(btrim(normalize(t, NFC), 공백류 29자))), 생성 열 `term_norm` 을 `SET EXPRESSION AS (app.term_norm(term))` 로(값 불변 단언). 유일성·중복 판정·rd.dim_keyword 쓰기·조회의 정본. 한계: 파이썬 str.lower 와 다른 문자(İ·어말 Σ)가 있어 파이썬 값은 표시용 | 검증 m-5 |
| P56 | `rd.analyze_facts(regclass[], OUT analyzed int, OUT skipped int)`: 권한 없어 건너뛴 표 수를 따로 반환(파티션 트리 기준, MAINTAIN 권한) | 검증 정보 사항 |

패치 `back/db/DB-v2.7-patch.sql`(재적용 거부·함수 본문·제약·권한 단언), 합본 `DB-v2.7.sql` = v2.6 + 패치.

### DB-v2.8 (2026-09-28, core 6라운드 5.1 좁은 검증 수정) P57·P58 + v2.7 P54 순서 수정

| 패치 | 내용 | 근거 |
| --- | --- | --- |
| P57 | 마지막 실효 admin 트리거를 둘로: `ua_last_admin`(AFTER UPDATE, WHEN OLD 실효 admin ∧ NEW 실효 admin 아님)·`ua_last_admin_del`(AFTER DELETE, WHEN OLD 실효 admin). 함수도 NEW 가 여전히 실효 admin 인 UPDATE 는 잠금 전에 돌아간다 | 검증 N-1(P53 회귀): 역할 무관 열(display_name 등) 편집에도 발동해 RC 두 트랜잭션이 서로 다른 admin 이름만 고쳐도 40P01. 쓰기 요청의 40001·40P01 은 API 409 `retry_conflict`(core.errors, users 쓰기 경로 포함) |
| P58 | `app.term_norm` 소유자 = `app.project_tracked_keyword` 소유자(hmg_owner), GRANT 재확인 | 검증 I-1: v2.7 은 패치 적용 롤(dev postgres, stg hmgadmin) 소유라 hmg_owner 에 EXECUTE 가 없었다 |
| v2.7 P54 수정 | 중복 사전 단언을 정규화 UPDATE 앞으로(정규화 식으로 세고 0 이 아니면 건수와 함께 RAISE). 이미 적용된 stg 는 영향 없음, prod·새 환경용. `DB-v2.7-patch.sql`·`DB-v2.7.sql` 둘 다 | 검증 N-2: 뒤에 있던 단언은 죽은 코드(중복이면 날것의 23505) |

패치 `back/db/DB-v2.8-patch.sql`(추가·교체형, 열·표 변경 없음, 재적용 거부·트리거·함수·소유자·권한 단언), 합본 `DB-v2.8.sql` = v2.7 + 패치.
회귀: `back/tests/core/test_db_v28.py`(이름 동시 편집 3격리·강등+이름 RC·m-2 행렬 24·재시도 매핑·P54 재현·소유자).
적재기 KW_KEY 의 표시용 term 트림(I-3, 선택)은 이번 수정 범위(DB 패치·errors·users) 밖이라 넣지 않았다: rd.dim_keyword.term 의 NBSP 류가 남을 수 있다(판정 키 term_norm 은 영향 없음).

### DB-v2.11 (2026-09-30, 데이터 버전 기반 결과 캐시, 제품 책임자 승인) P66~P68

| 패치 | 내용 | 근거 |
| --- | --- | --- |
| P66 | 스키마 `rcache`(소유자 hmg_owner, 풀 롤 USAGE 없음). `rcache.entry` UNLOGGED(키 sha256 32바이트 PK·라우트·데이터 버전·코덱 identity\|zlib·응답 바이트·원본/저장 크기·생성 시각, 색인 (data_version, created_at)), `rcache.stat` UNLOGGED 한 행(저장 크기·행 수 누적), `rcache.data_version` LOGGED(표 이름 PK·단조 카운터, 추적 표 26개 + `*manual*`) | 두 uvicorn 워커·호스트 공유. UNLOGGED 두 표는 장애 복구 때 함께 비워져 누적이 어긋나지 않는다. 카운터는 장애 뒤에도 되돌아가면 안 되므로 LOGGED |
| P67 | `rcache.tg_bump()` SECURITY DEFINER + 문장 트리거 104개(표마다 4): app 11개(brand·citation_category·citation_domain_override·hidden_market·owned_base·prompt·project_custom_field·prompt_custom_field_value·report_publication·rhq_region·rhq_region_country) + rd 15개(dim_country·dim_region·dim_project·dim_brand_name·dim_engine·dim_entity·dim_lang·dim_prompt·dim_source·dim_taxon·dim_url·catalog_entry·web_unit·report_unit_value·cycle) 에 AFTER INSERT·UPDATE(전이 표 NEW)·DELETE(OLD) = 바뀐 행이 있을 때만, TRUNCATE = 항상 카운터 +1 | app 표는 조회 시점에 바로 읽혀 세대(적재 finalize)가 덮지 못한다. rd 차원·파생 표는 세대 없이 바뀌는 적재 경로가 있다(검증 D1: register_projects 가 finalize 없이 rd.dim_project·dim_country, sync_prompts 첫 트랜잭션, rejudge REGISTRY_ROLE_REFRESH·국가 병합, project() 차원 삽입의 rd_changed 조건). 과무효화를 받아들인다. 세대만으로 덮는 사실 7개(answer·answer_brand·answer_stance·citation·job·acr_cell·acr_choice)는 쓰기 위치를 정적 시험이 강제한다(tests/core/test_result_cache_writers.py). 카운터 행 UPDATE 는 쓰기와 같은 트랜잭션이라 커밋과 함께 보이고, 같은 표 동시 쓰기는 커밋 순서대로 오른다 |
| P68 | SECURITY DEFINER 함수(소유자 hmg_owner, search_path pg_catalog, PUBLIC 회수): `app.result_cache_version()`(g=표면별 generation·last_load_id·updated_at, jc=max(judgment_change.change_id), tv=카운터 합, d=rd.today_kst()), `app.result_cache_lookup(bytea)`(같은 스냅샷 버전 + 키 = sha256(접두‖버전) 행, 왕복 1회), `app.result_cache_put(…)`(4 MiB 상한, 새로 들어간 행만 stat 에 더함, 다른 버전·10분 지난 행을 색인 범위 삭제·stat 차감, stat 이 256 MiB 를 넘을 때만 오래된 행부터 삭제, 누적은 0 아래로 내려가지 않게), `app.result_cache_invalidate()`(migrator, *manual* +1·전 행 삭제·stat 차감). api_ro = version·lookup·put 실행만 | api_ro 가 캐시 행을 직접 읽거나 쓰지 못하게(설계 결정 4). put 이 호출마다 표 전체를 두 번 훑던 첫 판(검증 N4)을 누적 카운터·색인 범위로 바꿨다: 표 1만 행에서 호출당 중앙값 1.0 → 0.35ms. put 은 요청 트랜잭션(READ ONLY)이 아니라 응답 뒤 짧은 api_ro 쓰기 트랜잭션에서 부른다 |

패치 `back/db/DB-v2.11-patch.sql`(추가형, 기존 표·열·권한 의미 불변, 재적용 거부·트리거 104·카운터 행 27·UNLOGGED·색인·권한·정의자 읽기 단언), 합본 `DB-v2.11.sql` = v2.10 + 패치.
dev-db 템플릿은 v2.11 합본으로 만든다. v2.10 템플릿(hmg_tpl)이 남은 동안은 결과 캐시 시험 픽스처 `rcache_db`(back/tests/core/conftest.py)가 복제본에만 패치를 1회 적용한다.
운영 주의: 세대만으로 덮는 사실 표는 적재 finalize(`ctx.rd_changed`)에 기댄다. DB 패치 적용 뒤와 적재 경로 밖 SQL(수동 수정·재구축 seed·이관·psql 보정) 뒤에는 `SELECT app.result_cache_invalidate()`(migrator). 트리거를 끄는 세션(session_replication_role=replica)도 같다.
엔드포인트 허용 목록·키 구성·표 커버 근거: `docs/design/api/DECISIONS-API.md` "결과 캐시".

### DB-v2.12 (2026-09-30, core 10: 제품 책임자 전환 결정 3·4) P69·P70

| 패치 | 내용 | 근거 |
| --- | --- | --- |
| P69 | `app.user_account` CHECK `ua_country_scope` = `role <> 'country' OR scope_all OR cardinality(scope_countries) + cardinality(scope_regions) > 0`(ua_region_scope 와 같은 식). 종전 = 국가 필수 | 결정 4(중동 country 계정 bd942069 권역 단위 유지). 국가로 펼치면 데이터 범위는 같지만 비멤버 프로젝트 가시성(front projectInScope = 백엔드 project_in_scope, 계정 국가가 있으면 국가 조건)이 좁아져 중동 밖 브랜드 공통 프로젝트 9개(stg)가 빠졌다. 현행 profiles 에는 CHECK 가 없다. 국가·권역 둘 다 없는 country 계정은 여전히 거부 |
| P70 | `app.tg_user_account_scope` 정본 표기 순서 = 대소문자 무시 일치 → rd.dim_country 코드(빈 코드 제외) → app.rhq_region_country → 원문(참조 거부). 종전 P59 = rhq 먼저 | 결정 3(계정 국가 표기를 정본으로). rd.dim_country 코드가 API 응답·옵션 코드의 정본(F1 CANON_ORDER, P65 upper 유일). 두 원천 표기가 같으면 결과 동일(stg 실측 비정본 0) |

패치 `back/db/DB-v2.12-patch.sql`(교체형, 표·열 불변, 재적용 거부·제약 정의·검증됨·정본 순서·소유자·트리거 연결 단언), 합본 `DB-v2.12.sql` = v2.11 + 패치.
dev-db 템플릿·CI 는 바꾸지 않았다(템플릿 hmg_tpl 은 v2.10 그대로): 시험 픽스처 `db_v212`(back/tests/core/conftest.py)가 복제본에만 적용한다.
이미 이관된 stg 계정 보정 = `back/migration/fix-core10-account-scope.sql`(이 패치 뒤 1회, 드라이런 기본). 이관 스크립트(인프라 스크래치 acct/load-accounts.tpl.sh)는 DB-v2.12 선행을 단언하고 R2 를 전개하지 않는다.
운영: 패치 적용 뒤와 보정 SQL COMMIT 뒤 `SELECT app.result_cache_invalidate()`(migrator, DB-v2.11 무효화 절차).

### DB-v2.13 (2026-09-30, 동기화 S1 BE-B: 제품 결정 Q2 (a)) P71·P72

| 패치 | 내용 | 근거 |
| --- | --- | --- |
| P71 | `rd.answer.cit_off int2 NOT NULL DEFAULT 0` = 호스트 있는 인용(rd.citation source_key <> 0, G-25 cit_n 과 같은 모수) 중 출처 차원 카테고리(`rd.dim_source.category_key`)가 app.citation_category name `Official (HMG)` 인 수. CHECK `answer_cit_off_bounds`(0 ≤ cit_off ≤ cit_n). 기존 행은 DEFAULT 0(메타데이터만), 값은 `back/migration/fill-cit-off.sql` | 글로벌 ⑤ 인용 점유율 분자 = 출처 카테고리 Official (HMG) 인용 수(hmg-geo 2670a16 #320 783478c·#321 feddea7, lib/kpi/official-hmg-citations.ts). Q2 (a): 답변 열(조회 시 원소 스캔 (b) 대신, 카드·추이 비용 그대로). D8 예외 ②(답변 1:1 판정 열, G-25 와 같다). 새 btree 없음(HOT 유지) |
| P72 | 불변식 ① 확장: `rd.answer_cit_counts(int4[])` 반환 열 끝에 cit_off(반환 형이 바뀌어 DROP → CREATE, 소유자·권한 재부여), `rd._assert_answer_cit_counts(int4[])` 가 cit_off 까지 자식 합과 대조. 공개 단언 `rd.assert_answer_cit_counts(int4[], bool)·(int4[])` 은 그대로(내부 위임), 예외 문구도 종전 'G-25 불변식' | G-25 때 인용 수 열과 같은 방식(열 = 자식 합, 적재 트랜잭션 안 단언). 적재기(apply.project 5만 청크 엄격)·seed-40 §8 청크·채우기 배치가 새 열을 자동으로 단언한다 |

패치 `back/db/DB-v2.13-patch.sql`(추가형, v2.12 선행·G-25 함수 존재·재적용 거부 단언, 끝에 구조 자체 단언: 열 형·NOT NULL·기본값·leaf 전파·CHECK 검증됨·
반환 열·단언 본문·소유자·loader 실행·api_ro 비실행·공개 단언 경로), 합본 `DB-v2.13.sql` = v2.12 + 패치. 공식 카테고리 키는 실행 시점에 이름으로 푼다
(빈 DB 합본 적용 때 코드표 행이 아직 없어 선행 단언하지 않는다: CI 리허설에서 발견·수정). dev-db 템플릿·CI 는 **v2.13 합본으로 바꿨다**(seed-40 이
v2.13 을 선행 단언). 로컬 공유 템플릿 hmg_tpl(v2.10)은 다시 만들지 않았고, 시험은 루트 conftest `_db_latest`(tests/dbforward.py)가 복제본에만
v2.11 → v2.12 → v2.13 → 채우기를 적용한다.

이 열을 쓰는 곳(같은 트랜잭션): 적재 FACT `_ig_citc` → `INSERT_ANSWER`(apply.project), bulk seed-40 §6 `_citc` → §7, 재판정 citation_override(공식 여부가
바뀐 출처를 인용한 답변을 apply.project 로 재투영), 1회 채우기 SQL(대역 밖). 결과 캐시: rd.answer 는 세대로만 덮는 사실 표라 쓰기 위치는 FINALIZE_WRITERS 의
INSERT_ANSWER 하나(정적 시험), 채우기·패치 뒤에는 `SELECT app.result_cache_invalidate()`.

운영 절차(stg·prod, 순서 고정, **실행은 메인 결정 뒤**): ① 패치(migrator) ② `psql -X -v ON_ERROR_STOP=1 -f back/migration/fill-cit-off.sql`(드라이런) →
`-v commit=1`(배치 2만 기본, `-v full_assert=1` 이면 끝에 전수 단언) ③ back 배포 ④ migrator `SELECT app.result_cache_invalidate();`.
①~③ 사이 옛 적재기는 cit_off 를 채우지 않아 공식 인용 답변에서 단언이 실패한다(적재 트랜잭션 롤백, 데이터 불변) → 적재 워커가 있으면 멈춘다(stg 는 없음).
stg 규모(2026-09-30 읽기 전용 s1beb-probe1): rd.answer 537,167행(159 MB, leaf 8)·rd.citation 433만(715 MB), 공식(HMG) 출처 263/56,407(공식 소셜 9·공식 도메인 42·
규칙 187·시드 25, 오버라이드 0), 채우기 대상 237,503 답변·공식 인용 1,942,191. 대상 선택 0.38 s, 배치 1개(2만 키) 읽기 약 0.38 s, CHECK 검증 = rd.answer
전량 스캔 0.04 s, 전수 단언 NULL 분기 집계 1.2 s → 12 배치, UPDATE·배치 단언을 더해 채우기 전체 수십 초 추정(쓰기 비용은 READ ONLY 라 미실측).
