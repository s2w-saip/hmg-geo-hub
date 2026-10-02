# core 요청: an-trend-geo (analytics.trend.series T-1 · analytics.geo.markets GEO-1)

작성: an-trend-geo 기능 빌더, 2026-09-28. 기준 커밋 stg 0092400.
막힌 기능은 없다. 아래는 모두 **기능이 core 공개 API 만으로 우회 중**인 항목이고, core 가 받아 주면 기능 쪽 우회 코드를 지운다.
술어를 기능 안에 재구현한 곳은 없다(사실 표 집계는 전부 core.measure 빌더, 창은 core.cycles).

## 1. `core.cycles.CycleRow` 에 `hidden_reason` 싣기

- **무엇**: `_SNAPSHOT_SQL`·`_RANGE_SQL` 이 `c.hidden_reason` 을 함께 읽고 `CycleRow(cyc_key, project_key, round_date, hidden_scope, hidden_reason: int = 0)` 로 싣는다.
- **왜**: T-1 R11 은 "수집 오류로 숨긴 회차(hidden_reason 1 collection_error)는 갭 자리로 남기고, 운영자가 전체 숨김한 회차(2 operator)는 자리가 아니다"를
  가른다. 지금 `CycleRow` 에는 hidden_scope 만 있어 기능이 `rd.cycle` 을 cyc_key 로 한 번 더 읽는다
  (`app/features/analytics/trend/series/queries.py` `HIDDEN_REASON_SQL`, 숨김 회차가 있을 때만 실행).
- **제안 시그니처**: `CycleRow.hidden_reason: int = 0`(기본값이 있어 기존 호출부 무변경). `Window` 에 `def collection_error(self, cyc_key) -> bool` 이 있으면 더 좋다.
- **막힌 기능**: 없음(추가 문장 1개로 우회).

## 2. 최근 N 버킷 창(`resolve_window` 확장)

- **무엇**: 기간 미지정일 때 "최근 N 버킷" 창을 core 가 계산한다.
- **왜**: Q9 기본 창 = 회차 12자리·주 12·월 12. `resolve_window` 는 스냅샷(offset 0|1)과 기간 모드만 있어서, 기능이 `resolve_window(date_from=2000-01-01,
  date_to=9999-12-31)` 로 후보 원장 전체(rd.cycle 만, 사실 표 아님)를 읽은 뒤 마지막 12 버킷의 시작일부터 `build_window` 로 창을 다시 만든다
  (`trend/series/service.py` `trend_window`). 원장 행 수는 회차 × 프로젝트(웹사이트는 사이트 수 × 주 52)라 수천 행 규모지만, 다른 추이 기능
  (FU-1 ACR 추이 기본 12회차 등)도 같은 요구가 있어 core 한 곳이 맞다.
- **제안 시그니처**: `resolve_window(conn, *, surface, project_keys, date_from, date_to, last_n: int | None = None,
  bucket: Literal["cycle","week","month"] = "cycle", ...)`. `last_n` 이 있고 from/to 가 없으면 `SELECT DISTINCT <bucket 식> ... ORDER BY 1 DESC LIMIT :n`
  으로 하한을 정해 기간 모드와 같은 `Window` 를 돌려준다. 자리 판정(1번의 collection_error 포함)을 core 가 같이 해야 기능 간 창이 갈리지 않는다.
- **막힌 기능**: 없음.

## 3. 표면별 메뉴 게이트·GEO 화면 게이트 헬퍼(`core.auth`)

- **무엇**: `SURFACE_MENU = {"global": "standard", "website": "website", "project": "project"}` 와 `async def require_surface_menu(p, surface)`,
  그리고 `def shows_geo_map(p) -> bool`(현행 `lib/auth/scope-policy.ts:264` showsGeoMap: scope_all ∨ 역할 hq·region, admin 은 Q16 으로 scope_all).
- **왜**: 메뉴 그룹이 쿼리 파라미터 surface 에 따라 달라 라우터 `dependencies=` 로 걸 수 없다. 기능은 지금 core 게이트 함수를 그대로 호출한다
  (`require_menu_group(group).dependency(p)`, `require_role("admin","hq","region").dependency(p)`). 모든 분석 기능이 같은 매핑을 따로 두면 드리프트한다.
- **막힌 기능**: 없음.

## 4. `core.measure.brand_rows` 에 HMG 형제 브랜드 제외 옵션

- **무엇**: `competitor_rows_sql(ms, win, *, group_by=(), hmg_siblings: bool = True)`. False 면 WHERE 에 `b.own_bit = 0`(불리언 비교라 술어 규약 안).
- **왜**: GEO-1 은 브랜드 격리(현행 `marketStats`: 권한 밖 형제 HMG 브랜드는 경쟁사 목록·순위에 없고 분모에만 남음)가 필요하다. core 경쟁 규칙
  (QUERY-FIXES M-1: 형제 브랜드는 경쟁 행에 남는다)은 M-1·T-1 용이라 맞고, GEO 는 기능이 `rd.dim_brand_name.own_bit` 를 따로 읽어 파이썬에서 거른다
  (`geo/markets/queries.py` `BRAND_NAMES_SQL`). 옵션이 생기면 형제 행을 읽지 않고 이름 조회만 남는다.
- **막힌 기능**: 없음.

## 5. (참고·DB) `rd.answer_brand` 의 회차 술어 인덱스 확인 요청

- 로컬 합성 DB EXPLAIN(ANALYZE, `enable_seqscan=off`)에서 `rd.answer` 는 `answer_cell_idx(surface, round_date, cyc_key, …)` 를 Index Cond 로 쓰지만,
  `rd.answer_brand` 는 선두가 (surface, round_date) 인 btree 가 없어 `ab_brand_idx(brand_key, round_date)` 를 round_date 비선두로 훑는다
  (기본 플랜은 리프 Seq Scan + BRIN). 표면 LIST 가지치기는 확인됨(global → `*_g_*` 리프만, website → `*_w_*` 리프만), 합성 DB 에 월 리프가
  2026-09 하나뿐이라 RANGE 가지치기 효과는 로컬에서 보이지 않는다.
- 통합 설계(전체-통합 §4.3 기각)가 answer_brand geo 커버링 인덱스를 기각했으므로 인덱스를 요청하지 않는다. **stg 실측 게이트에서 GEO 1년·T-1 dimension=brand 1년
  EXPLAIN ANALYZE 로 확인**해 달라는 메모다.

## 6. (선택) `core.envelope.Meta.own_label`

- GEO-1 명세 response 는 `meta.own_label` 이지만 `Meta` 에 필드가 없어 `data.own_label` 로 실었다(T-1 도 같은 위치). 공통 meta 로 올릴지 결정 요청.

## 7. T-1 지원 축에 source[] (검증 D2, 2026-09-28 수정 라운드)

- **무엇**: `core.filters` 에 T-1 용 지원 축 `TREND_SUPPORT = KPI_SUPPORT + source`(세 표면)를 두거나, `KPI_SUPPORT` 에 source 를 더하고 쓰지 않는 기능이
  ignored 로 표시하게 한다.
- **왜**: T-1 명세 filters.supported 가 `source[](citation_share 계열에만 적용)` 를 지원 축으로 둔다. 1차 구현은 `KPI_SUPPORT` 를 그대로 써서 source 가
  `ignored_filters` 로만 갔다(검증 D2). 지금은 기능이 `FilterSupport(KPI_SUPPORT.* | {"source"})` 로 선언하고, M05 는
  `core.measure.citation_counts(group_by + source)` 결과를 출처 카테고리로 걸러 센다(`trend/series/service.py` `TREND_SUPPORT`·`source_filtered_share`).
- **선택 요청**: `citation_counts_sql` 에 출처 카테고리 축(`c.source_key = ANY(:카테고리에 속한 출처 키)` 또는 `rd.citation` 에 category_key 열)을 받는
  인자가 있으면 기능의 출처별 집계·파이썬 거르기가 한 문장이 된다. 막힌 기능은 없다.

## 8. surface=global 의 project_id 를 조용히 무시하지 않기(검증 D4)

- **무엇**: `resolve_read_context` 가 `surface=global` 에서 `project_id` 를 받으면 `ignored_filters` 에 `project_id` 를 싣거나 422 로 거절한다.
- **왜**: 글로벌 표면은 루트 프로젝트 고정이라 project_id 가 값을 바꾸지 않는데, 지금은 meta 표시 없이 무시된다(`/v1/trend`·`/v1/geo` 둘 다 200,
  ignored·dropped 빈 값). 모든 분석 기능이 같은 동작이라 core 한 곳이 맞다.
- **기능 방어(지금)**: 두 기능이 응답 meta 에 `project_id` 를 직접 더한다(`mark_ignored`, core 가 표시하면 중복 없이 그대로 둔다).

## 9. 기능 테스트용 staged 픽스처(가드 예외 명시)

- **무엇**: `tests/support` 에 "합성 픽스처 위에 회차·사실 행을 더한 트랜잭션을 RoConn 으로 꽂고 ROLLBACK" 하는 공용 헬퍼.
- **왜**: 숨김 회차·다국가·R09 발행 경로는 템플릿 픽스처에 없어 기능이 행을 더해야 시험할 수 있다(검증 D5). 기능 폴더의 SQL 문자열은 정적 가드가
  API 규칙(G6 rd 쓰기 금지·G5 set_config role 금지)으로 검사하므로, 이 기능은 SQLAlchemy Core insert·update 구성으로 행을 더하고 준비 뒤에
  `install_engine_guard` 를 건다(`trend/series/tests/staged.py`). 이 때문에 요청이 api_ro 가 아니라 소유자 롤로 돈다(권한 시험은 헬퍼 없는 테스트가 맡는다).
  core 가 가드 예외가 명시된 공용 헬퍼(롤 내리기 포함)를 두면 교체한다. 다른 빌더(an-cit-b `staged_db.py`)도 같은 요구다.

## 10. (결정 요청) GEO-1 국가 표시명·최대 경쟁사 모양(검증 D3)

- `GeoCountryRow.country_name`: `rd.dim_country` 에 표시명 열이 없고 현행 표시명은 프론트 `lib/geo-catalog` `geoLocateByCode`(로케일 의존)가 붙인다.
  **프론트 유지**로 결정해 DECISIONS-API 에 기록해 달라(서버가 싣게 하려면 dim_country 에 표시명 열 또는 app 참조 표가 필요하다).
- `top_rival`: 명세 `{brand, share_of_voice}` 대신 `{brand, metrics{...}}`(현행 marketStats 모양, P3 정수 쌍). 명세 차이로 기록 요청.
