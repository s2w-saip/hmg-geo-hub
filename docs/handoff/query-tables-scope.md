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
| 제품 이름 `rep_name` · `display_name` | `acr_model_counts`, 답변 상세, Admin 엔티티 | OBT `brand`는 '(이름 없음)'이고 `surfaces`는 표시 이름과 다르다(표본) | 있는 엔티티는 유지, 새 엔티티는 빈칸. 새 답변의 `display_name`은 엔티티의 `rep_name`(교차검증 1회차) |
| ACR 반복별 승자 · 후보 `acr_iter_*` | `acr_duel_counts` | 계약에는 셀 집계만 있다 | 있는 회차는 유지, 새 회차는 빈칸 |

실제 Silver에도 이 값이 없으면 새 회차부터 ACR 모델 표 · 맞대결 · 경쟁사별 인용이 비거나 줄어든다. 추정해 채우지 않는다(`CLAUDE.md` 1절). T9.1에서 실제 컬럼을 확인한다.

재분석이 바꾼 값: `dim_source`의 카테고리 · 판정 방식과 `dim_entity`의 브랜드는 그 출처 · 엔티티를 가진 가장 늦은 회차(세 표면 통틀어)의 값을 따른다. 적재 때 달라진 것만 고치고, 고치면 세 표면의 `active_release.version`을 올려 다시 센다. `dim_url`은 주소와 제목만 읽으므로 고치지 않고, 인용의 출처 · 소유는 `citation_fact` 행이 적재마다 새로 가진다. 입력에 없는 프롬프트의 답변(`skipped`)과 서비스 표에 없는 코드(`unknown_codes`)는 적재 결과와 로그에 나온다. 지금 둘 다 0건이다.

그 밖의 답:

- D-26 저장 확인값: `dim_category` · `dim_entity` · `entity_mention_surface`를 그대로 읽는다. 위치가 바뀌지 않아 1f 코드와 부딪히지 않는다.
- `dim_*` 새 행: 쓴다. 새 답변의 URL · 출처 · 엔티티에 키가 필요하다. T10.1이 T9.7보다 먼저인 이유다.
- 키: OBT `answer_key`(uuid)는 `gold.job_index.job_id`와 같다(표본 2,000/2,000). 정수 키는 유지하고 새 답변만 발급한다.
- 답변 수: OBT 800,951건, `job_index` 830,336건. 차이 29,385건은 매니페스트 `ready` 스냅샷 34개의 행 수와 같다. 운영 스냅샷만 적재하므로 이 답변은 테이블에서 빠지고, 지금 OBT 계산과 같은 모수가 된다.
- T7.6 건식: 매니페스트의 마지막 `public` 주는 2026-10-05 주로 기록된 기준 주와 같다(메모리 계산).

## 3. 입력 반영 (2026-11-07 정함)

입력은 즉시 반영한다(결정 기록 '입력은 즉시 반영'). 지금도 캐시 키가 바뀌는 입력은 소유 URL과 제외 역할뿐이고, 나머지는 캐시에 없는 조회만 새 값을 본다. 그래서 다음처럼 둔다.

| 입력 | 반영 |
|---|---|
| 소유 URL · 제외 역할 | 지금처럼 읽을 때 본다(`gold_judged.read_inputs`, 5초) |
| 프롬프트 정의(`dim_prompt`) | 잡이 돌 때 행 단위로 맞춘다. 전 프롬프트 28,750개에서 값이 같음을 확인했다 |
| 저장된 판정의 입력(카탈로그 소속 · 국가 조건 · 자사 명부 · 숨긴 시장) | 잡이 지문(`gold.silver_load.inputs_digest`)을 비교해 바뀌면 모든 회차를 다시 적재한다(전체 약 7분) |

다른 안: 읽을 때마다 입력 DB를 붙이기(읽기 SQL 21곳을 고치고 2,800만 건 규모 조인의 플랜 위험이 크다), 입력 저장 때 허브 서버가 잡을 부르기(서버 간 쓰기 호출이 생긴다).

## 4. 진행 규칙

B 세션이 맡는다. 세션 분할은 결정 기록에 있다.

- 1b 커밋 뒤 별도 `git worktree`(브랜치 없음, `HEAD:main`으로 푸시)에서 작업한다. 데이터 서버는 :5575로 직접 띄우고 `start-local.sh`는 쓰지 않는다.
- (끝남) 1g 전에는 별도 DB `gold_next` · `cache_next`(`back/hub_storage/build_query_next.py`)에서만 적재하고 재계산한다. 읽기 SQL이 `gold.`을 고정으로 쓰므로 별도 스키마보다 별도 DB가 낫다. `gold_db` · `cache_db` · 화면 읽기 경로는 건드리지 않는다. T7.6은 건식 실행과 보고만 하고 커밋하지 않는다.
- 저장 확인값 코드(`source_overrides` · `entity_roles` · `source_lists` · `interest`)는 1f 전에 고치지 않는다.
- 1g 뒤 순서: D-25 커밋과 사전 집계 재실행 → 기준값 재계산(약 52분) → T9.7 대조 → 재계산을 끝낸 뒤 읽는 곳 교체. 먼저 바꾸면 최후 집계(중앙값 15.5초)로 빠진다.

## 5. 통과선

- 테이블로 다시 센 `metric_row`가 지금 OBT로 센 값(52.9만 행)과 차이 0건이거나 결정 기록으로 설명된다.
- 필터 · 드릴다운 · `gold_db`를 읽는 Admin 경로 12개는 표본 대조한다.
- 사전 집계 시간을 기록한다(지금 약 52분).
- Silver 어댑터는 최후 집계에서만 호출된다. 2026-11-07부터 그중에서도 테이블이 표면의 운영 스냅샷을 다 갖지 못했을 때만 호출된다.

### 2026-11-07 시험 결과 (`gold_next`, 읽기 전환 전)

전체 적재 스냅샷 1,253개, 답변 65만 건, 인용 697만 건, 약 11분. 다른 세션과 겹친 측정이다. 사전 집계는 테이블 기준으로 110초다(지금 약 52분).

저장해 둔 `metric_row` 52.9만 행과 값 349만 개를 대조해 4,906개(0.14%)가 다르다. D-25 뒤 정의 버전 `2026-11-07.1`로 다시 재도 같다.

| 차이 | 값 수 | 원인 |
|---|---|---|
| ACR 모델 표 · 맞대결 | 2,540 | 지금은 옛 행을 읽고(`LEFT_ON_GOLD`), 적재 뒤에는 나머지 ACR과 같은 셀 규칙을 쓴다. 결정 '어댑터 ②의 판정 입력' |
| Project 언급 · 순위 | 1,206 | 어댑터는 읽는 범위 안에서 브랜드 이름을 접어 필터에 따라 이름이 달라진다. 새 테이블은 회차 전체 기준이고 원래 `gold_db` 행과 거의 같다(11,804행 중 3행 없음, 순위 8건 다름) |
| Global `citation_counts.owned` | 434 | `owned=False` 호출의 값이다. 이 호출에서는 `cit_owned`를 읽지 않는다 |
| Global 인용 수 | 58 | `https://www.`처럼 호스트가 없어 출처가 없는 URL(10-05에 6건). 결정 '출처가 있는 인용만 센다'대로 테이블은 빼고 어댑터는 셌다. 답변 모수는 양쪽이 같다(45,281건) |
| Global · Website 엔진 필터 순위 | 약 600 | 위와 같은 필터 범위 문제 |
| Website 인용 수 | 74 | 어댑터 415,273, 테이블 415,271. 원래 `gold_db` 값과 같다 |
| 그 밖 | 약 50 | 대표 답변 규칙이 옛 표시와 다른 회차의 프롬프트 수 |

옛 행과 다른 나머지는 이미 정한 것이다: 대표 답변 규칙(옛 5개 회차), ACR 반복 번호, 사우디 도시 통합(`geo_key`), 카탈로그 소속 변경 뒤의 `bgrp`, 태도의 `first_turn`(어댑터와 같이 `turn_index=1`).

이 대조의 어댑터 쪽과 테이블 쪽은 ACR 반복 번호를 같은 오름차순으로 매겨 그 결함을 드러내지 못했다. T9.8에서 찾아 `a457847`로 고쳤다(`kept-metric-parity.md`). 옛 행과 다른 것 중 'ACR 반복 번호'는 그래서 해소됐다.

### 2026-11-07 교체 뒤 화면 대조 (세션 A, 171개 요청)

128개가 같고 43개가 달랐다. 상태 코드 차이는 0건이다. 표는 달랐던 것의 결론이고, 정의 버전 `2026-11-07.3` 기준이다.

| 차이 | 결론 |
|---|---|
| Project 브랜드 이름 · SOV(`Mitsubishi` → `Škoda`, 57.6 → 57.3) | 지금 값이 맞다. 행의 `brand`와 `brand_rollup_entity_id`가 갈리는 행이고, 어댑터는 읽는 범위 안에서만 이름을 접었다. 옛 `answer_brand_fact`와 같다. 추출 쪽 이상값이라 통보에 넣는다 |
| ACR 12개 브랜드, 시트 +1(IT · CZ · SE) | 정한 규칙. 10-05 6셀이 옛 표시 false → 규칙 true, 셀 3,567 → 3,573. 옛 값의 근거인 `run_status`가 가상 OBT에 없다 |
| Global 언급 · 인용 소폭 | 결함이었고 고쳤다. 인용 수는 교체 전 935,072로 돌아왔고, `noBrandAnswers` · `missing` 합계도 돌아왔다(1,610 · 3,425) |
| Mercedes 08-31 −16 | Project와 같은 이름 접기. `Mercedes-Benz`로 적힌 17 언급의 롤업이 `Mercedes-AMG`다. 위 결함 수정 뒤 값은 20,720 |
| Website SA-Riyadh · SA-Jeddah 필터 없어짐, `unmeasured` −2 | 2026-11-06 결정 'Website SA 통합'이 화면에 나타난 것 |
| Admin 엔티티 12,523행 | 결함이었고 고쳤다(`72fb857`), 1,927행 |
| `release.as_of` 10-27 → 10-05, `generation` +3 | 정상. `release`는 진단 경로 `/v1/source`에만 나가고 화면은 `meta.as_of`를 읽는다. generation은 적재마다 올라 커서가 다시 시작한다 |

남는 위험: 실제 Silver가 가상 OBT와 다를 수 있다. SSOT는 Silver를 '추출 컬럼만'으로 적었고(`shared/project-architecture.md` 45줄) T9.6은 `answer_text`에 기댄다. T9.1에서 드러나며 재작업이 생길 수 있다.

## 6. T12.1 철거 대상

T9.7 교체 뒤 서버 코드가 읽지 않는 `gold_db` 테이블이다(`silver-load.sql`은 가상 OBT를 만들 때 3개를 읽는다). 2026-11-07 재검토: 실제 Silver 대조 · 분석팀 리뷰 · VM 반영 뒤로 미루는 것을 추천한다(`architecture-rebuild.md` '결정 대기'). 삭제는 되돌릴 수 없어 스크립트만 만들고(`back/hub_storage/teardown-t12.sql`, `manage.py`가 돌리지 않는다) 실행은 사용자 확인 뒤에 한다. 2026-11-07 확인: 17개 테이블에 뷰 · FK 의존 0, 화면 캡처 171개와 필터 조회 9개 동안 스캔 0, 스크립트는 되돌리는 트랜잭션에서 끝까지 돈다. `gold_before_t97`를 지워도 데이터는 덤프(`.local/gold-copy/gold-20261106T033018Z.dump`)에 남는다. 가상 OBT(`build_virtual_obt.py`)를 다시 만들려면 덤프를 별도 DB에 복원하고 `SOURCE`를 그 DB로 바꾼다(복원은 돌려 보지 않았다). 교체는 `gold_next`를 `gold_db`로 이름을 바꾸는 방식이라, 이전 DB 전체가 한 번에 철거 대상이 된다. 남는 테이블의 구조는 `metrics-005a.sql`이 기록이다(`gold_reader/source-schema.json`을 대신한다).

| 묶음 | 대상 | 비고 |
|---|---|---|
| 이전 DB | 교체 전 `gold_db`(이름을 바꿔 보관) | 약 40 GB. 값 대조가 끝난 뒤 삭제 |
| 새 DB의 빈 테이블 | `kpi_cell` · `citation_cell` · `brand_cell` · `kpi_rollup` · `url_prompt_cell` · `answer_citation_raw` | 읽는 코드 없음, `gold_next`에는 행이 없다 |
| 복사돼 있지만 읽지 않음 | `pub_cell` · `pub_cell_web` · `pub_prompt` · `pub_prompt_axis` · `pub_brand_name` · `report_value` · `answer_registry` · `acr_cell_job` | 읽는 코드 없음 |
| T7.6 뒤 읽지 않음 | `publication` · `cycle_pick_basis` · `data_version` | 기준 주가 매니페스트로 옮겨 간 뒤 |
| 운영 스냅샷이 없는 회차의 옛 행 | `job_index` Website 29,385행 · `answer_mention_raw` 77,814행(`ready` 스냅샷 34개) | 화면은 `servable`로 걸러 읽고 답변 본문은 없다. Admin 엔티티 합계(`refresh_entity_totals`)는 이 행도 센다. 그 회차가 운영 반영되면 적재가 덮어쓴다 |
