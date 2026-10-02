# ingest.project.apply · 적재 파이프라인(워커) / 판정·읽기 투영 / 판정·투영·재판정

설계 단위: IG-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| FUNC | `ingest.project.apply / rejudge / reproject` | high |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- (화면 없음: 운영·워커)

## 구현

- `service.py` `project()` 본체 = DB-보정 §4 4~8단계: 답변 키 집합(_ig_s) 확정(바뀐 job ∪ 전역 판정 영향 ∪ 회차 이동 run ∪ ACR run-셀 형제) →
  차원(수동 int2 키는 NS_DIM 잠금 아래 max+1, IDENTITY 차원은 자동) → 옛 좌표(rd.job 경유)의 rd 행 삭제 → rd.ensure_leaf → rd.job·rd.answer·
  answer_brand·answer_stance·citation 삽입 → R05 is_rep 셀 재선정(제자리) → 전파 직전 ANALYZE → `rd.propagate_answer_gates` 5만 청크 +
  `rd.assert_answer_cit_counts(엄격)` → 당사 합·1:1 그레인 단언 → ACR(acr_cell·acr_cell_job·acr_choice, 셀 대표 재선정).
  `apply(changed, extra_runs)` 적재 경로, `reproject(keys)` 판정 입력만 바뀐 재투영.
- `rejudge.py` judgment_change IG-2 kind 14종(+scope_prompt): 영향 차원 갱신(catalog_entry·dim_taxon·dim_prompt·web_unit·dim_url.owner_key·
  dim_source 카테고리·경쟁사·dim_country.hidden_standard·dim_engine.is_default·dim_brand_name kind·own_bit·dim_entity 역할) → 영향 답변 →
  `project()`. 상한(`HGH_INGEST_ESCALATE_ANSWERS`, 기본 20만) 초과는 `Escalated` → 큐 행 escalated_rebuild.
- `queries.py` 모든 판정식 = bulk 시드 seed-30·40 의 같은 절을 _ig_s 로 좁힌 것(절 번호 주석). 판정 함수는 시드 파일을 loader 연결 pg_temp 로 올려 공유.

## 명세와 다른 점

- 재투영은 영향 답변 단위 삭제·재삽입(leaf 재구축 전용 열도 같은 경로, HOT 규율상 제자리 UPDATE 대상 열만 제자리): 명세의 "자식 삭제·재삽입"과 같고 rd.job·rd.answer 도 포함.
- 발급 원장 차원(dim_brand_name·dim_source)의 옛 키는 전역 판정 변경 뒤 참조 없는 행으로 남는다(재번호 금지). 새 bare 의 대표 표기는 이번 적재 범위 최빈.
- ANALYZE 는 DB-v2.6 P48 `rd.analyze_facts`(SECURITY DEFINER, 허용 = rd·ing 표)로 한다(loader 는 소유자가 아니다, R4 반영).

## 테스트(`tests/test_equivalence.py`)

사실·ing 유래 차원을 비우고 run 순서대로 증분 적재 = bulk 시드(행 단위) · 적재 순서에 걸리는 전역 판정(대표 표기·최빈 도메인·셀 대표·코호트 pin·새 차원) 2단 적재 = bulk ·
같은 입력 재적재 멱등(뒤집힘 0). 재판정 kind 별 bulk 동치는 `cycles/workers/tests/test_queue.py`.

## 엔티티 버전 투영 오버레이(E1, DB-v2.17)

- 답변 버전 v(a) = `rd.cycle.ecat_ver`(노출 때 고정) → 기준 버전(`project(ecat_ver=…)`, 없으면 활성 버전, 활성도 없으면 legacy = 기존 명부 그대로).
  `ecat_force=True` 는 고정을 무시하고 전부 기준 버전(미리보기·전 기간 반영). 기록 = `rd.answer.ecat_ver`. 시드는 GUC `hgh.ecat_ver`·`hgh.ecat_force`.
- 적용 순서(언급, `queries.FACT_MR` = seed-40 §5 `_meff`): ① 제거(엔티티 또는 병합 대상이 removed) ② 관계(모 브랜드 덮어쓰기, 표기 접두 교정보다 우선)
  ③ 롤업 대상이 removed 면 롤업 NULL(브랜드 귀속 상실) ④ 차단·재매칭 보정(`migration/seed/seed-4x-ecat.sql`, 시드와 같은 파일) ⑤ 병합 = 버전별
  `_alias_map` 으로 표기 쌍 rid 에서 접기(G20: 답변 × 표시 브랜드 1행, rid_n = 롤업 id 수). 스탠스·ACR 롤업 행 = 제거(+ ACR 관계)만, ACR 선택 수 재계산 없음.
- 규칙 표(버전별, seed-3x-common §4): `_ecat_cfg`·`_ecat_vset`·`_ecat_reg`·`_ecat_ali`·`_alias_map(ver,…)`·`_roster(ver,…)`·`_ecat_x`·`_ecat_blk`·`_ecat_add`·
  `_ecat_hent`. 표기 쌍은 `(ver, 표기, 롤업, ovr)` 키, 차원(대표 표기 가중치·엔티티 표시 브랜드)은 기준 버전의 원본 쌍.
- 차단 비교 = `pg_temp.ecat_norm`(원문) = NFC(`surface_norm`), 재매칭 겹침 제거 = `pg_temp.ecat_resolve`: 파이썬 정본(`app.core.ecat`)과 대조 시험
  `tests/core/test_ecat_sql_parity.py`. 재매칭 행 = `ing.hub_match`(본문 해시 = 지금 해시인 행만, E2 가 적재 전에 재스캔해야 한다).
- 반영 영향 집합(E4·E5 계약): `ecat.impact(conn, from_ver, to_ver)`(읽기 전용). 쓰기 순서는 `ecat.py` 머리 주석.
- 시험 `tests/test_ecat_overlay.py`: v1 전량 재투영 md5 차이 0, v2 픽스처 손 계산 행, G20, 감성 분모, 영향 집합 재투영 = bulk, 회차 고정·되돌리기.

## 엔티티 버전 미리보기·반영·되돌리기(E4·E5, `ecat_engine.py`)

- 큐 = `app.judgment_change` kind `entity_version`, payload `{apply_id, op: preview|apply|resume}`(`core.contracts.EntityVersion`). 한 처리 = 한 청크
  트랜잭션(`process_change`), 청크가 남으면 행을 pending 으로 두고(`QueueOutcome.status = 'progress'`) 같은 행을 다시 집는다. 미리보기 전 add 표면
  재스캔(`ecat_engine.prepare` → E2 `ensure_scanned`)은 큐 트랜잭션 밖. 잠금: 반영·재개 = 표면 배타, 미리보기 = 표면 공유.
- 범위 `unexposed ⊆ from_round ⊆ all`(노출 = servable ∧ view_date ≤ 오늘 KST). 회차의 현재 버전 = coalesce(`rd.cycle.ecat_ver`, 활성)로 묶어
  `ecat.impact(v, 새 버전)` 을 범위 회차로 좁힌다. 범위에 노출·고정 회차가 있으면 승인 필요(`app.rule_param ecat_approvers`).
- 미리보기: 청크마다 저장점 안 `service.stage()`(사실 행 쓰기 없음, 차원·`lock_dims` 는 저장점과 함께 되돌림) → `_ig_own`·`_ig_ab` 로 KPI 차이
  (회차 × 국가 × 엔진, 자사 3사 `measure.ratios` 입력 이름, 모수 = 활성 프로필 `mention_population`) → 저장점 되돌림. 후 = rd 그룹 합 + 차이.
  경쟁 브랜드 상위 20, 추가·제거·이동 표본(위치 기반 본문 창), 근사(발생 행 없음·ACR), 지문 `preview_set_md5`.
- 반영: 거절 검사(다른 반영 running·failed = 대기, 기준 버전 변경, 지문 불일치 `ECAT_PREVIEW_STALE`, 승인자) → running → 회차 고정 → 활성화 →
  작업 답변 대기 표시(`rd.answer.ecat_ver = −새 버전`) → 청크 투영(`HGH_ECAT_CHUNK`, 기본 2만) → 범위 회차 표시(`HGH_ECAT_STAMP_CHUNK`, 기본 10만)
  → 전수 단언 → applied. 실패 = failed(대기 표시가 재개 원장), `op resume` 로 이어받는다. 되돌리기 = 되돌릴 버전 내용의 새 초안(origin rollback)을
  같은 범위로 반영(끝에 되돌린 반영 rolled_back).
- 시험 `tests/test_ecat_apply.py`: 미리보기 KPI = 반영 뒤 rd 같은 SQL, 미리보기 뒤 rd 전 표 md5 불변, 노출 회차 불변·고정, 청크 반영 = bulk,
  되돌리기 = 반영 전 사실 표 md5, 지문(재적재·초안 편집) 거절, 동시 반영, 승인자, 청크 실패 → 재개.
