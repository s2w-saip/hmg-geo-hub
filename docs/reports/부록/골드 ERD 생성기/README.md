# 골드 ERD 생성기 (v8 작업 중)

워크스페이스 루트의 `GEO HUB 골드 ERD.html` 을 v8 로 다시 만드는 키트입니다. 목표는 **현재 서비스의 모든 화면 기능 100% 커버**입니다. 커버리지는 숫자를 손으로 적지 않고, 페이지가 열릴 때 스스로 계산해 검증합니다.

- 루트 HTML 은 아직 v7 입니다. 이 폴더의 `erd_v7.html` 이 같은 파일의 사본입니다.
- v8 은 아직 빌드하지 않았습니다.

## 커버리지 기준

| 기준 | 원천 | 규모 |
|---|---|---|
| 화면 항목 | ★ 점검표 생성기 인벤토리(`../지표 점검표 생성기`)를 `dump_inventory.py` 로 읽기 전용 덤프 → `inventory.json` | 화면 항목 775 (48 라우트) + 화면 밖 14 = 789 |
| BE 라우트 | `routes_ast.py` 가 router.py 를 AST 로 읽음 → `routes_ast.json` | 216 (OpenAPI 219 와 대조) |
| 항목 → 라우트 매칭 | `match_routes.py` → `item_routes.json` | API 717 매칭. 남은 72 = 정적 표본 · 픽스처 · 클라이언트 내보내기 · 프론트 크론 → `manual_map.py` 로 수동 매핑 |
| BE 가 실제로 읽는 현행 객체 | `be_scan.py` (주석 · docstring · description 문자열 제외) → `be_scan.json` | rd 44 · frz 14 · ext 6 |
| 현행 열 | dev-pg `hmg_tpl` 카탈로그 → `db_cols.tsv`, `db_funcs.txt` | 객체 65 · 열 1,039 |

## 검증 3종 (`v8_cov.js` 의 `@cov-core`, 페이지와 `node_check.js` 가 같은 코드 사용)

1. **현행 열 → 골드 열 (COLMAP):** 모든 열이 같은 이름 · 이름 변경 · 동결 경로 · 파생 · 함수 대체 중 하나로 골드에 있어야 합니다.
2. **BE 모듈:** 각 모듈의 직접 참조와 공통 경로(core) 객체가 전부 COLMAP 으로 덮여야 합니다.
3. **화면 항목 789:** 각 항목이 BE 모듈 · 골드 열 · app 테이블 · 원 항목(내보내기 · 조작) · 데이터 없음 사유 중 하나 이상으로 대응해야 합니다.

ERD 무결성(FK 대상 · FK 표기 · 탭 배치 · 열 중복)도 함께 검사합니다.

## 지금까지 반영한 것

**`patches_tables.py` · 1단계 (라이브 누락 · 품질)**
- `cycle_pick_basis` 테이블 신설.
- 누락 열 보강: `ga4_property.conv_basis`, `kw_volume_monthly.competition`, `kw_suggestion.total_count`, `dim_*.first_seen · rule_ver`, `acr_cell_fact.rule_ver`.
- 현행 열 이름 복원: `sentiment_positive …`, `entity_mention_total.entity_id`, 발행 세대 `gen_key` + ops 원값 열, `pub_prompt.*_key`.
- `active_release` 에 현행 `surface_generation` 열 보존.
- 좌표 열을 펼침 목록(c[4])으로 명시.
- 버전 정책:
  - `job_index` 는 현재 상태 원장이고, `last_build_id` 를 둡니다.
  - `catalog_entry` 는 PK 에 `build_id` 를 넣어 build 로 버전을 나눕니다.
  - 차원은 build 로 나누지 않는 현재값이고, 바뀌면 `data_version` 을 올립니다.
- `data_version` 신설 (현행 rcache 트리거 대체).
- FK 정정: `page_visibility_daily.lang_key → dim_lang`, `acr_cell_run` · `entity_mention_surface` 를 PF 로.
- 문서 정정: 셀 키 12열, 탭 수 자동 계산, serve 잔재 제거.

**`patches_static.py` · 2단계 (정적 표본 · 사용자 수 · depth4)**
- depth4: `dim_taxon` 축 + `catalog_entry.depth4_key`.
- GA4:
  - `ga4_users_window` 를 필터 조합 비트마스크로 바꿈 (cohort ai · total · general, 0 = 필터 없음, `window_days` 1 = 일별).
  - `ga4_value.url_key` 추가.
- Visibility:
  - `page_*` 테이블에 inputs · uses · rules 를 채움.
  - `page_seo_device_daily` · `page_priority` 신설.
  - `dim_url` 에 자사 페이지 행을 추가.
- ACR: `acr_iter_fact` · `acr_iter_shortlist` 신설.
- 소셜:
  - `ctx_*` 열 추가.
  - `ctx_group` · `ctx_combination_evidence` · `ctx_claim(_quote)` · `ctx_research_run/wave/worker/log` 신설.
  - 새 탭 '소셜 리서치'.
- `judgment_change` kind 에 `ctx_research` 추가 (23종).
- `NEWREQ`(데이터 분석팀 신규 요청 목록)를 작성.

`python patch_tables.py` 가 위 두 단계를 오류 없이 적용합니다. 결과는 `v8_tables.js` · `v8_render_base.js` 입니다.

## 남은 일 (이 순서로)

1. **`manual_map.py` 채우기.** 지금은 빈 틀입니다. 정적 · 수동 72 항목과, API 에 매칭됐지만 현행 BE 가 데이터를 주지 않는 항목에 골드 열을 보강합니다. 할 일은 `조사 메모/이어서 할 일.md` 를 따릅니다.
2. **`build_v8.py` 가 읽는 4개 파일 작성.** `v8_consts.js`(KGROUP · SRC_LABEL), `v8_sections.html`(신규 요청 · 기능 전수 대응 · 현행 열 대응 · BE 모듈 섹션), `v8_flow_screens.svg`(흐름 그림의 화면 상자, `data-kg` 숫자 자리), `v8_extra.css`(fx · md · nr · cov-alert 스타일).
3. **재생성 후 빌드 · 검증.**
   - `python gen_data.py <repo>/back/app` 로 `coverage_data.js` 를 재생성합니다.
   - `python build_v8.py <출력 경로>` 로 빌드합니다.
   - `node node_check.js <출력 경로>` 가 **미대응 0 · 무결성 오류 0** 이어야 합니다.
4. **탭 레이아웃 겹침을 검사하고 좌표를 조정합니다.** 상자 높이 = 50 + 18 × 열 수.
5. **브라우저로 확인한 뒤 루트 `GEO HUB 골드 ERD.html` 을 교체합니다.** 루트 파일이 결과물입니다.

## 다시 뽑는 법 (코드 · DB 가 바뀌었을 때)

```
python dump_inventory.py "<repo>/docs/reports/부록/지표 점검표 생성기" inventory.json
python routes_ast.py <repo>/back/app routes_ast.json
python match_routes.py
python be_scan.py <repo>/back/app db_cols.tsv db_funcs.txt be_scan.json
python gen_data.py <repo>/back/app
```

- `db_cols.tsv` · `db_funcs.txt` 는 dev-pg 의 `hmg_tpl` 에서 뽑았습니다 (`pg_class` · `pg_attribute` · `pg_proc`, 스키마 rd · frz · ext · app · ing · rcache · mig).
- `dump_inventory.py` 는 점검표 생성기를 읽기만 하고, 출력 HTML 은 쓰지 않습니다.
- 모든 스크립트는 같은 폴더의 데이터 파일을 읽습니다.
