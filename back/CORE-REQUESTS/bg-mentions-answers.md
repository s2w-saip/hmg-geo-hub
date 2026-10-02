# core·DB 요청: bg-mentions-answers (analytics.mentions.brands·types·prompts 값 갭 보강)

작성: bg-mentions-answers 빌더, 2026-09-28 수정 라운드(검증 ff74b52 결함 D-1~D-5, 2차 검증 D1~D8 반영). 기능 코드는 아래 요청을 우회하지 않았다.

| # | 무엇 | 막힌 기능 | 긴급 |
| --- | --- | --- | --- |
| R1 | (철회) `mig.known_diff` M-3 terms 행: model 표기를 현행과 같게 되돌려 불필요 | 없음 | 없음 |
| R2 | split_own 행 키 규칙을 core 한 곳에 둘지 결정 | 없음(두 그룹이 같은 식을 쓴다) | 낮음 |
| R3 | 통합 순서: trend(818b56f·5bc1924) 와 이 브랜치의 core.measure 는 같은 바이트 | 없음 | 정보 |

## R1. (철회) mig.known_diff 행 등록(M-3 terms)

- 2차 검증(ff74b52 D3)에 따라 `/v1/mentions/prompts?terms=true` 의 model 표기를 현행 `highlightTermsForBrand`(front/lib/scope/result-adapter.ts:326-340)와
  같게 롤업으로만 잇도록 되돌렸다(`prompts/service.py build_terms`: 엔티티 자기 정본 브랜드 `e_bk` 조건 제거). 현행과 값이 같으므로 known_diff 행이 필요 없다.
- mode=signal 의 `terms` 는 현행 신호 드릴다운(하이라이트 없음)에 없는 확장이다. 화면을 그대로 두는 어댑터는 signal 에 terms 를 요청하지 않는다
  (모듈-언급 §3.3.1). 어댑터가 쓰기로 정하면 그때 known_diff 등록을 다시 요청한다.

## R2. split_own 행 키 규칙의 위치

- **현황**: 판정은 trend 그룹이 먼저 만든 `core.measure.split_own_scopes(ms) -> ((bit, 스코프), ...)` 하나만 쓴다(이 브랜치의 core 추가분은 걷었다, 검증 D-1).
  행 키는 두 그룹이 같은 식을 각자 쓴다: trend `trend/series/service.py _own_parts` = `ctx.refs.brand_code_of_bit(bit) or str(bit)`,
  언급 `mentions/brands/common.py own_brand_code_of_bit` = 같은 식. 회귀 시험이 ADMIN brand=[Hyundai N, Kia] 에서 키 `Hyundai`·`Kia` 를 고정한다.
- **제안(택1)**: (1) core 에 `split_own_label(refs, bit) -> str` 을 추가형으로 두고 두 그룹이 그것을 부른다(통합 후 한 커밋). (2) 지금처럼 둔다(식이 한 줄이고 시험이 고정).
  빌더 권장은 (1) 을 통합 뒤에(trend 와 동시 수정이 필요해 이 브랜치 단독으로 하면 다시 충돌 원인이 된다).

## R3. 통합 순서(정보)

- 이 브랜치의 `back/app/core/measure.py` 는 feat/bg-trend-geo 818b56f·5bc1924 의 같은 파일과 바이트까지 같다. 두 브랜치는 이 파일 밖에서 겹치는 파일이 없어
  어느 순서로 합쳐도 충돌이 없다.
- 2차 수정 라운드 확인: 5bc1924 의 변경 파일을 이 브랜치 작업 트리에 얹은 합친 트리(core 는 같은 바이트)에서 언급·trend 시험을 함께 돌려 194 통과
  (그룹 간 계약 시험 `mentions/brands/tests/test_mentions_brands_fix2.py::test_split_own_contract_with_trend` 6개 관점이 건너뛰지 않고 통과:
  ADMIN 전체·[Kia, Hyundai N]·[Hyundai]·[Hyundai N], HQ_HYUNDAI, KIA_US).
