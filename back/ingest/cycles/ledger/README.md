# ingest.cycles.ledger · 적재 파이프라인(워커) / 회차·큐·아웃박스 / 회차 귀속·재평가

설계 단위: IG-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| FUNC | `ingest.cycles.attribute / reevaluate` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- (화면 없음: 운영·워커)

## 구현

- `attribute(run_ids)`: 미귀속 run → (프로젝트, run 앵커) 회차(없으면 개설, cycle_id = md5('derived|프로젝트|앵커 µs'), seed-20 §7-4 와 같은 재료) 또는
  앵커 없는 run 은 같은 KST 측정일 파생 회차. 좌석(R02)은 현행 hmg_assign_cycle_rounds 이식(정규 요일 global 월·website 금·project 없음,
  prev_empty·next_empty·nearest·merged, 과거 배정 불변). 닫힘·발행 회차에 붙으면 'late' + 발행 회차 stale_since.
- `reevaluate(cycle_ids, now)`: 카운터(셀 수·완료 답변·결손, 원장 이관 회차의 유닛은 동결) → 발행 게이트 계획 채움 → R01 3팔(다음 앵커 ∧ 멤버 /
  100% ∧ 정온 36h / 재확인 창 3일, started_at NULL 이면 닫지 않음) → 게이트 판정 → R08 발행(view_anchor_at = 앵커 + 표면 지연 KST 자정) → rd.cycle 투영.
- 발행 게이트(DB-v2.14, 제품 결정 16~18, global·website 비파생만. project 는 현행처럼 닫히면 노출):
  - 계획 = 회차 개설 시점 `ing.active_units(scope_project_id)` 스냅샷(`ing.cycle_unit`, plan_source open). 활성 유닛 = 카탈로그 프롬프트(app.prompt 삭제 아님 /
    app.website_prompt) × 엔진(app.project.ai_engines → rule_param default_engines) × 국가(ing.prompt.regions → ing.sync_cursor.regions),
    rule_param `unmeasurable_units`([{target, region}])·Scope 에서 꺼 둔 프롬프트(`ing.prompt.enabled = false`, 제품 결정 21, NULL = 모름 = 활성) 제외. 계획 없는 미발행 대상(이관·배포 창)은 재평가가 backfill(앵커 뒤 등록 프롬프트 제외,
    이미 닫혀 있던 이관 회차 quiet).
  - 판정(`ing.cycle_gate`) 분모 = 계획 ∩ 현재 활성(도중 비활성 제외) − 봉인, pass = 빠짐 0. R08 = forced ∨ (pass ∧ 분석 비율 ≥ analysis_publish_ratio).
    값이 바뀔 때만 쓴다(틱 무변화 판정). 발행 뒤 동결.
- `project_cycles`: rd.cycle 1:1(seed-40 §1). 좌석이 바뀐 회차의 run 을 돌려준다(사실 행 파티션 이동 → IG-2 reproject).
- 운영 요청: cycle_admin {cycle_id, op: hide|unhide|close|set_view_date|seal|force_publish|regenerate, hidden_scope, reason, view_date, units, reinterpret}
  (regenerate = 동결 세대 재생성(DB-v2.22 frz.regenerate: 활성 세대 해제 뒤 지금 판정으로 다시 동결), 사유 필수·reinterpret=true 만(재해석 없는 재생성 거부),
   발행된 global·website 회차만. 발행 직후 동결 세대 생성 = ingest.frz.freeze.freeze_published(재평가 호출 3곳, 좌석 재투영 뒤 같은 트랜잭션, 회차별 세이브포인트) ·
   seal = 빠진 유닛 전부 또는 units 지정 봉인, force_publish = 열려 있으면 운영자 마감 뒤 강제 발행, 둘 다 사유 필수·게이트 대상만, 워커가 곧바로 재평가) · report_publication(발행 round_date 단위
  rd.report_unit_value 교체) · anchor_pin {job_id, anchor, reason, op: set|remove} · answer_drop {job_id, reason, op: drop|restore}
  (ing 레지스트리 origin 'operator'·change_id, 재투영은 IG-2).

## 테스트(`tests/test_ledger.py`)

좌석 규칙 5종·과거 배정 불변 · 귀속(열린 원장·늦은 귀속·새 회차·파생 회차 묶음·결정론적 id) · 종결 3팔·started_at NULL·발행 비율·노출일 ·
cycle_admin 4종과 잘못된 페이로드 · 발행값 교체 · 앵커 고정·드롭·복원 재투영 = bulk 시드.

`tests/test_publish_gate.py`(준비 = `tests/gate_support.py`): 합본 = v2.13 + 패치·재적용 거부 · 계약(사유 필수) · 개설 시점 계획과 100% 발행·발행 뒤 동결 ·
미완료 1유닛 보류(옛 R08 이면 발행)·봉인 거절 2종·봉인 뒤 발행 · 지정 봉인·강제 발행(사유 거절·열린 회차 마감·감사 열) · project 무변화·이관 발행 회차 불변 ·
도중 비활성(삭제·시장 제외)·구조적 불가 조합 · backfill 계획(앵커 뒤 등록 제외·quiet·무변화 재평가) · Scope 꺼짐(개설 전 제외·도중 제외·카탈로그 불변).
