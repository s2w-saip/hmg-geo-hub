# core·DB 요청: bg-projects 그룹(BG-36·BG-37·BG-38·BG-47)

작성: bg-projects 빌더(feat/bg-projects, 검증 수정 라운드). 막힌 기능은 없다(전 엔드포인트 구현·테스트 통과). 아래는 기능 안에서 추가형으로
고칠 수 없어 어댑터 재정렬로 우회한 항목이다.

## R1. 생성 선택지 표시 순서 열(검증 D2·D3)

- 무엇: 현행 화면 순서를 DB 가 들고 있게 순서 열을 추가한다(추가형 DDL).
  - `app.rhq_region.ord int2`(브랜드 안 권역 정의 순, front lib/rhq/_data/rhq-map.json 의 regions 배열 순)
  - `app.rhq_region_country.ord int2`(권역 안 국가 순, 같은 파일 countries 배열 순)
  - 브랜드 카탈로그 순(front GEO_BRANDS = web-geo-final.json 첫 등장 순 Hyundai·Genesis·Kia). `app.brand.sort_order`(Hyundai·Kia·Genesis)는
    qa 옵션 등이 이미 쓰는 표시 순이라 바꾸지 않고, 별도 열(`app.brand.geo_ord int2`)로 둔다.
  - 시드: fixture-00-rules.sql 의 `_rr`·`_rc` 가 이미 rhq-map.json 순서로 적혀 있으므로 VALUES 순번(WITH ORDINALITY)을 그대로 넣으면 된다.
  - `core.codes._REFS_SQL` 의 rhq 집계 `ORDER BY r.region_id`·`ORDER BY c.country_code` 를 ord 순으로 바꾸거나, Refs 에 ord 를 싣는다
    (현 코드 순 정렬에 기대는 소비자가 없는지 core 가 확인).
- 왜: GET /v1/projects/creation-options 가 현행 폼 드롭다운 순서(scope-policy.ts:286 fromRegions 삽입 순, GEO_BRANDS 순)를 서버에서 재현할 수 없다.
  지금은 서버가 결정적 순서(브랜드 sort_order, 국가 코드 순)를 주고 어댑터가 front 상수로 재정렬한다(기능 README '선택지 순서').
- 들어오면: service.creation_options 를 ord 순으로 바꾸고 어댑터 재정렬을 뺀다. 계정 스코프 순서 경로는 이미 현행과 같다.
- 막힌 기능: 없음.
