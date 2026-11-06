# 조회용 테이블 범위표 (T9.7 · T9.6)

2026-11-07 코드와 로컬 DB 기준이다. 순서와 담당은 `docs/handoff/architecture-rebuild.md`의 '개발 순서'를 따른다. 줄 번호는 `back/bff`를 옮기기 전의 값이다.

화면과 읽기 SQL은 그대로 두고, `gold_db`의 조회용 테이블 내용을 가상 OBT에서 다시 채운 뒤 필터 조회를 그쪽으로 돌린다. `gold_current` · `gold_reader`가 이미 이 테이블을 읽으므로 새 코드의 중심은 적재 잡이다. Silver 어댑터(`silver_obt.py`)는 최후 집계에만 남는다.

확인 방법: `gold.*`를 읽는 코드를 `back/bff`에서 검색했고, 계약 컬럼은 `silver_contract` 표본 행으로 봤다. 표본은 Global 2026-10-05 회차다. 실제 Silver는 접속 정보가 없어 보지 못했다.

## 1. 옮기는 범위

| 구분 | 테이블 | 채우는 근거 |
|---|---|---|
| Silver에서 | `answer_fact` · `answer_brand_fact` · `citation_fact` · `answer_stance_fact` · `answer_mention_raw` · `answer_occurrence` · `answer_stance_raw` · `answer_body` · `job_index` · `acr_cell_fact` · `acr_entity_fact` · `dim_url` · `dim_source` · `dim_entity` · `dim_brand` · `entity_mention_total` · `entity_mention_surface` | 계약 컬럼과 `metrics/judgments.py`. 읽는 컬럼만 채운다. `answer_fact`에서 읽는 곳이 없는 컬럼 60개(`elig` · `std_in` · `own_mask` 등)는 채우지 않는다 |
| 입력 DB에서 | `dim_prompt` · `dim_project` · `catalog_entry` · `dim_custom_field` · `prompt_custom_value` · `dim_taxon` 등 코드표 · `dim_owned_base` | 서비스 원본. 삭제 전 카탈로그 소속 115개는 지금 `gold.dim_prompt` 값을 유지한다. 반영 시점은 3절 |
| 매니페스트에서 | `dim_cycle` · `build` · `release_item` · `active_release` | T7.6과 함께 정한다. `hidden_scope`는 계약에 없고 '옛 값이 숨긴 회차도 센다'로 이미 정해졌다. `expected_units`(`gold_reader/compare.py:85`)의 대체는 설계에서 확인한다 |
| 그대로 | `kw_*` · `ctx_*` · `page_*` · `ga4_*` | D-24대로 Silver 연결 때 정한다 |
| 안 옮김 | `kpi_cell` · `citation_cell` · `brand_cell` · `kpi_rollup` · `url_prompt_cell` · `pub_*` · `answer_citation_raw` · `report_value` | 읽는 코드가 없다. 약 25 GB, T12.1 철거 후보 |

크기: 옮기는 테이블은 지금 약 16 GB, 맥 디스크 여유 788 GB. 적재 시간은 재지 않았다.

## 2. 계약에 값이 없는 것 (`LEFT_ON_GOLD` 7종의 새 회차 출처)

| 값 | 쓰는 곳 | 확인 | 처리 |
|---|---|---|---|
| `is_social` | `domain_rows` · `source_counts` | 레거시 규칙 `group_key<>domain`(`back/ingest/project/apply/queries.py:687`)이 표본 출처 26,627건 모두와 같다 | Silver에서 채운다 |
| 카테고리 목록 · 적용 프롬프트 | `source_categories` · `applied_prompts` | 테이블과 입력 DB에서 셀 수 있다 | 해소 |
| `owned_brand_bit` · `competitor_brand_key` | `rival_citations` 등 | 레거시가 쓴 토큰 테이블이 입력 DB에 없다. `is_owned`는 경쟁사에도 true이고 `matched_brand`는 경쟁사에 비어 있다(표본) | 있는 출처는 유지, 새 출처는 빈칸 |
| 제품 이름 `rep_name` · `display_name` | `acr_model_counts`, 답변 상세, Admin 엔티티 | OBT `brand`는 '(이름 없음)'이고 `surfaces`는 표시 이름과 다르다(표본) | 있는 엔티티는 유지, 새 엔티티는 빈칸 |
| ACR 반복별 승자 · 후보 `acr_iter_*` | `acr_duel_counts` | 계약에는 셀 집계만 있다 | 있는 회차는 유지, 새 회차는 빈칸 |

실제 Silver에도 이 값이 없으면 새 회차부터 ACR 모델 표 · 맞대결 · 경쟁사별 인용이 비거나 줄어든다. 추정해 채우지 않는다(`CLAUDE.md` 1절). T9.1에서 실제 컬럼을 확인한다.

그 밖의 답:

- D-26 저장 확인값: `dim_category` · `dim_entity` · `entity_mention_surface`를 그대로 읽는다. 위치가 바뀌지 않아 1f 코드와 부딪히지 않는다.
- `dim_*` 새 행: 쓴다. 새 답변의 URL · 출처 · 엔티티에 키가 필요하다. T10.1이 T9.7보다 먼저인 이유다.
- 키: OBT `answer_key`(uuid)는 `gold.job_index.job_id`와 같다(표본 2,000/2,000). 정수 키는 유지하고 새 답변만 발급한다.
- 답변 수: OBT 800,951건, `job_index` 830,336건. 차이 29,385건은 매니페스트 `ready` 스냅샷 34개의 행 수와 같다. 운영 스냅샷만 적재하므로 이 답변은 테이블에서 빠지고, 지금 OBT 계산과 같은 모수가 된다.
- T7.6 건식: 매니페스트의 마지막 `public` 주는 2026-10-05 주로 기록된 기준 주와 같다(메모리 계산).

## 3. 설계에서 먼저 정할 것

입력은 즉시 반영한다(결정 기록 '입력은 즉시 반영'). 지금 Silver 어댑터는 읽을 때마다 입력 DB를 본다(`silver_obt.py`의 `current_inputs`, 5초 캐시). 잡이 `dim_prompt` · `catalog_entry` · `own_bit`를 저장하면 다음 적재까지 늦는다. 읽을 때 붙일지, 저장 시 다시 적재할지 첫 항목으로 정한다.

## 4. 진행 규칙

B 세션이 맡는다. 세션 분할은 결정 기록에 있다.

- 1b 커밋 뒤 별도 `git worktree`(브랜치 없음, `HEAD:main`으로 푸시)에서 작업한다. 데이터 서버는 :5575로 직접 띄우고 `start-local.sh`는 쓰지 않는다.
- 1g 전에는 별도 스키마에 적재만 한다. 화면 읽기 경로 · `gold.metric_row` · `cache_db`를 건드리지 않고 `manage.py rollup`을 돌리지 않는다. T7.6은 건식 실행과 보고만 하고 커밋하지 않는다.
- 저장 확인값 코드(`source_overrides` · `entity_roles` · `source_lists` · `interest`)는 1f 전에 고치지 않는다.
- 1g 뒤 순서: D-25 커밋과 사전 집계 재실행 → 기준값 재계산(약 52분) → T9.7 대조 → 재계산을 끝낸 뒤 읽는 곳 교체. 먼저 바꾸면 최후 집계(중앙값 15.5초)로 빠진다.

## 5. 통과선

- 테이블로 다시 센 `metric_row`가 지금 OBT로 센 값(52.9만 행)과 차이 0건이거나 결정 기록으로 설명된다.
- 필터 · 드릴다운 · `gold_db`를 읽는 Admin 경로 12개는 표본 대조한다.
- 사전 집계 시간을 기록한다(지금 약 52분).
- Silver 어댑터는 최후 집계에서만 호출된다.

남는 위험: 실제 Silver가 가상 OBT와 다를 수 있다. SSOT는 Silver를 '추출 컬럼만'으로 적었고(`shared/project-architecture.md` 45줄) T9.6은 `answer_text`에 기댄다. T9.1에서 드러나며 재작업이 생길 수 있다.
