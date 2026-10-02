"""엔티티 버전 반영 엔진: E4 미리보기 · E5 반영·되돌리기 (설계 hmg-entity-management-versioning-design-20261001.md 3·4·8절, 제품 결정 26~29).

한 반영 = app.ecat_apply 한 행(kind 'entity_version'). 적재기는 app.judgment_change(kind 'entity_version', payload {apply_id, op})
로 받는다(ingest.cycles.workers.service.process_change 가 이 모듈의 handle 을 부른다: 한 큐 처리 = 한 트랜잭션, 끝에 finalize).

범위(scope_kind, 반영 때마다 관리자가 고른다: 결정 27). 노출 = rd.cycle.servable ∧ view_date ≤ 오늘(KST, app.core.cycles 후보 술어와 같다).
  unexposed   미노출 ∧ 고정 없음(rd.cycle.ecat_ver NULL) 회차. 새 회차는 활성 버전을 따르므로 자동으로 새 버전이 된다
  from_round  unexposed ∪ round_date ≥ from_round_date 회차(노출 회차 포함 가능)
  all         전 회차
  세 범위는 포함 관계(unexposed ⊆ from_round ⊆ all). 범위에 노출(또는 이미 고정된) 회차가 있으면 승인 필요(requires_approval, 결정 27).

회차의 현재 버전 = coalesce(rd.cycle.ecat_ver 고정, 활성 버전). 영향 집합은 범위 회차를 현재 버전 v 로 묶어 ecat.impact(v, 새 버전) 을
그 회차들로 좁힌 합이다(앞선 반영이 노출 회차를 옛 버전에 고정해 둔 뒤 from_round·all 로 넓힐 때 v 가 회차마다 다르다).
작업 답변(work) = 영향 답변 ∪ 영향 ACR prompt-run 의 run 대표 답변(그 run 의 답변이 투영되면 ACR_SCOPE 가 run 의 prompt-run 전부를
다시 투영한다) ∩ 범위 회차의 서빙 답변. 서빙 답변이 없는 run 의 영향 prompt-run(고아)은 첫 청크가 직접 넘긴다.

E4 미리보기(op preview, 상태 draft·previewed·approved → previewed)
  방식 = 저장점 안 stage() + 임시 표 차이 집계 + 저장점 되돌림(rd 사실 행 쓰기 0). 판단 근거(project 전체를 돌리고 트랜잭션 롤백하는 안과 비교):
    - 롤백 안은 영향 답변의 rd 사실 행(job·answer·answer_brand·answer_stance·citation·acr_*)을 지웠다 다시 넣고 대표 재선정·게이트 전파·
      ANALYZE 까지 돈다. 그동안 그 행들에 행 잠금이 잡혀 같은 답변을 만지는 적재가 기다리고(lock_timeout 5s 로 실패), 사실 표 ANALYZE 가
      SHARE UPDATE EXCLUSIVE 를 잡고, 되돌린 뒤에도 사실 표에 죽은 튜플·WAL 이 영향 크기만큼 남는다.
    - 이 안은 stage()(범위·차원·투영 원천 임시 표)까지만 저장점 안에서 돌린다. 쓰기는 차원(추적 표, 새 표시 브랜드 이름 등)뿐이고 저장점
      되돌림으로 사라진다. NS_DIM 권고 잠금(lock_dims)도 저장점과 함께 풀린다(실측: 저장점 되돌림 뒤 pg_locks 0행). 그래서 적재를 막는 구간은
      청크 하나의 stage 시간뿐이고 사실 표는 잠기지 않는다.
    - KPI 차이는 더할 수 있는 합(답변 수·언급 수·감성 합·순위 합)이라 "전 = rd 그룹 합, 후 = 전 − 작업 답변의 rd 값 + 작업 답변의 새 값"으로
      정확히 맞출 수 있다. 새 값의 원천 _ig_own·_ig_ab 는 INSERT_ANSWER·INSERT_BRAND 가 그대로 쓰는 임시 표이고, 모수 게이트(is_rep·std_in 등)는
      버전과 무관하다(언급 보정은 ing.answer.n_mentions 로 정한 analysis_state·elig 를 바꾸지 않는다). 시험이 "미리보기 후 값 = 실제 반영 뒤
      rd 에서 같은 SQL 로 센 값"을 대조한다.
  KPI = 회차 × 국가 × 엔진 그룹, 자사 3사(비트 1·2·4)별 app.core.measure.ratios 입력 이름(answers·tracked·own_mentions·total_mentions·sent_pos·
  sent_neg·sent_all·rank_sum·ranked). 모수 = 활성 프로필의 mention_population(표면별, 프로젝트·카탈로그·관점 필터 없음 = 관리자 전체 합).
  경쟁 브랜드 = answer_brand competitive 행 언급 합 변화 상위 20. 표본 = 추가·제거·이동(병합·관계) 언급 문맥 각 20(위치 기반 본문 창).
  근사 = 발생 행 없는 작업 답변(6~8월 적재분: 일부 차단 개수 불변·재매칭 위치 없음)·ACR 답변(1턴 재매칭 불가·선택 수 재계산 없음).
  지문(preview_set_md5) = 버전·내용 지문·범위·범위 회차(미리보기 때 있던 회차)와 그 현재 버전·작업 답변과 그 ing.answer.load_id
  (미리보기 때 커밋된 load 까지). 반영 시작 때 같은 식으로 다시 세어 다르면 ECAT_PREVIEW_STALE(approved → previewed).
  미리보기 뒤 새로 적재된 답변은 지문에 들지 않는다(반영 때 영향 집합에 들어 함께 반영된다). 이미 본 답변이 다시 적재되면 달라진다.

E5 반영(op apply: approved → running → … → applied, op resume: failed → running)
  한 큐 처리 = 한 청크 트랜잭션. 청크가 남으면 judgment_change 행을 pending 으로 둔다(process_change 가 다음 반복에서 같은 행을 다시 집는다:
  재개 = 같은 행 재처리, 상태는 전부 DB 에 있다).
  첫 청크   ① 다른 반영 running·failed → EcatBusy(ECAT_APPLY_RUNNING, 큐 대기) ② 활성 ≠ from_ver → rejected(ECAT_BASE_CHANGED)
            ③ 지문 재계산 ≠ → previewed(ECAT_PREVIEW_STALE) ④ 승인 필요인데 승인자가 app.rule_param ecat_approvers 밖 → previewed
            (ECAT_EXPOSED_REQUIRES_APPROVAL) ⑤ running(started_at·load_id·cycle_keys = 지금 범위 회차·affected_answers)
            ⑥ 회차 고정: 범위 밖 고정 없음 회차(= 노출 회차) → 활성 버전, 범위 안 노출·고정 회차 → 새 버전
            ⑦ app.ecat_activate(새 버전)(범위 확장 = 새 버전이 이미 활성이면 생략) → REGISTRY_ROLE_REFRESH
            ⑧ 작업 답변의 rd.answer.ecat_ver = −새 버전(대기 표시: 재개 원장이 rd 에 있다) → 이하 청크와 같은 투영
  청크      대기 표시 답변 N개(HGH_ECAT_CHUNK) → project(ecat_ver = 새 버전) → 그 답변 ecat_ver = 새 버전(단언). 적재가 사이에 그 답변을
            다시 투영해도 활성 = 새 버전이라 같은 값이 되고 대기에서 빠진다
  표시      대기 0 이면 범위 회차의 나머지 답변 ecat_ver = 새 버전(내용은 두 버전에서 같다 = 영향 집합의 정의, HGH_ECAT_STAMP_CHUNK 씩)
  끝        범위 회차 답변 ecat_ver 전수 = 새 버전 단언 → applied(finished_at). 새 버전 origin 'rollback' 이면 되돌린 반영(ver = from_ver,
            applied) → rolled_back
  실패      청크 예외 = 그 트랜잭션 롤백 → process_change 가 새 트랜잭션에서 judgment_change failed + mark_failed(running → failed, 오류).
            첫 청크 실패는 활성화까지 롤백되므로 approved 그대로(오류 문구만). 재개 = E6 가 op resume 을 넣는다(대기 표시에서 이어받는다)
  세대      청크마다 project 가 ctx.rd_changed·surfaces 를 세우고 process_change 의 finalize 가 세대 +1(결과 캐시 무효화).
            rd.cycle·rd.dim_entity 는 추적 표(P67 트리거)라 쓰기만으로 버전이 오른다. 표시(ecat_ver)는 조회에 안 써 세대를 올리지 않는다
  되돌리기  = 되돌릴 버전 내용의 새 초안(origin 'rollback', E6 가 만든다)을 같은 흐름·같은 범위로 반영. rd 내용(ecat_ver·load_id 밖)은 반영 전과 같고
            ecat_ver 는 새 버전 번호다(버전은 불변·재활성 불가, DB-v2.17 P94)
            대상 = 버전 b(= 되돌리기 반영의 from_ver = 지금 활성)를 반영한 applied 반영 전부(원 반영 X 와 그 범위 확장들: 같은 ver).
            범위 = 요청 범위(X 와 같은 scope_kind) ∪ 원복 회차(대상 반영들이 바꾼 회차 cycle_keys 중 지금 버전이 아직 b 인 것). 원복 회차는
            반영 전 상태로 돌린다: 대상 반영 중 가장 먼저 그 회차를 바꾼 반영이 시작 때 남긴 pins_before(아래)의 고정값이 NULL 이면 고정을 풀고
            (활성 = 되돌리기 버전을 따른다: 내용 = 이전 버전), 값 c 면 c 로 다시 고정하고 그 회차는 c 로 투영한다(목표 버전이 회차마다 다를 수
            있다: 영향 집합은 (현재 버전, 목표 버전) 쌍마다 계산). 노출·고정 원복 회차가 있으면 승인 필요. 끝나면 대상 반영 전부 rolled_back
            (검증 반례 CE11: 원 반영 X1 unexposed 뒤 범위 확장 X2 all 을 X1 되돌리기로 함께 되돌린다. 전에는 X2 가 rolled_back 으로 표시되면서
            노출 회차는 b 고정으로 남았다). pins_before 기록이 없는 옛 반영의 회차는 NULL(활성 추종)로 본다.
  pins_before 첫 청크가 app.ecat_apply.preview.pins_before 에 범위 회차마다 {pin: 반영 전 rd.cycle.ecat_ver, ver: 반영 전 현재 버전} 을 남긴다
            (running 전이와 같은 트랜잭션). 되돌리기·포기(abandon)가 "반영 전 상태"를 이 기록에서 읽는다.
  표시      범위 회차 답변의 ecat_ver 목표 = coalesce(rd.cycle.ecat_ver, 새 버전)(보통 반영에서는 전부 새 버전: 범위 안 노출 회차는 새 버전으로
            고정되고 미노출은 고정이 없다. 되돌리기 원복·포기에서는 회차의 고정 버전)
  포기(op abandon: failed → rejected, 오류 ECAT_APPLY_ABANDONED) 재개하지 않고 닫는다. 활성 버전은 되돌리지 않는다(버전 불변·재활성 불가):
            범위 회차를 반영 전 현재 버전(pins_before.ver)에 고정하고(반영 전 버전이 새 버전과 같은 회차는 반영 전 고정값 그대로), 그 회차들의
            영향 답변(impact(새 버전, 반영 전 버전), 반영의 역방향 = 같은 집합)을 대기 표시로 다시 표시해 같은 청크 경로로 반영 전 버전 내용으로
            투영한다(이미 투영된 답변은 되돌리고, 아직 대기인 답변은 같은 내용을 다시 쓴다). 첫 포기 처리가 preview.abandon 에 시작을 기록하고
            (재개 경로 차단: 포기가 시작된 반영은 resume 불가), 청크가 남으면 failed 그대로 이어 처리, 끝나면 rejected. 범위 밖 회차(시작 때
            활성 버전에 고정한 노출 회차)는 그대로다. 결과: 범위 회차 = 반영 전 내용(고정), 새 회차 = 새 버전(활성). 새 버전을 범위 회차에도
            펴려면 범위 확장(활성 버전 재요청), 새 버전을 거두려면 이전 내용의 새 초안을 반영한다. pins_before 가 없는 옛 반영은 from_ver 로 본다.
  스캔 완결  미리보기·반영 시작 전에 관련 버전(새 버전·범위 회차의 현재·목표 버전)의 add 표면이 전부 전체 스캔을 마쳤는지(ing.hub_match_scan
            .scanned_to_load_id NOT NULL) 본다. 아니면 ECAT_SCAN_PENDING(미리보기 = 큐 행 failed, 반영 시작 = previewed 로 돌림: 다시 미리보기가
            prepare 로 재스캔한다). 스캔이 끝나지 않은 표면은 과거 답변 적중(ing.hub_match)이 없어 영향 집합·투영이 조용히 모자란다.
            포기(op abandon)도 첫 처리 전에 prepare 가 반영 전 버전의 add 표면을 따라잡기 스캔하고, 첫 처리가 ABANDON_SCAN_STALE 로 다시
            확인한다(실패한 반영이 열린 동안 그 버전은 적재 훅 대상이 아니었다). 미완이면 ECAT_SCAN_PENDING(failed 그대로, 다시 포기).
  숨김      role hidden(= 기존 명부 excluded)은 활성화(app.ecat_activate)로 명부에 바로 반영되어 범위와 무관하게 전 기간 즉시 적용된다(제품 결정 30, 2026-10-01: 현행 excluded 와 같이 전 기간 즉시 적용).
            미리보기 preview.hidden = {all_periods: true, note, changes[활성 → 새 버전 숨김 전환 엔티티], count}.
  재동결    동결 층(제품 결정 31·32): 사실 쓰기 관문(_write_facts → frz.keep_rewrite·keep_settle)이 동결 셀 답변의 옛 값을 보관하므로 반영만으로는
            동결 회차의 카드 값이 바뀌지 않는다(실시간 경로만 바뀐다). 결정 27(노출 회차 포함 = 승인·고지)은 승인하면 그 회차 값이 바뀌는 것을
            전제하고, 운영도 엔티티 변경은 재해석 재생성(--cycle --reinterpret) 때 카드에 반영된다. 그래서 범위 kind 가 '미노출만'(unexposed)이
            아니면, 표시·전수 단언이 끝난 뒤 범위 회차 중 활성 동결 세대가 있는 회차를 frz.regenerate(사유 = 반영 id·단계)로 재해석 재동결한다
            (S2 cycle_admin regenerate 와 같은 의미: 활성 세대 해제(보관 삭제) → 지금 판정으로 셀·축 다시 동결). 되돌리기(origin rollback)도
            같은 흐름이고, 포기(abandon)는 반영 전 버전으로 되돌린 범위 회차를 단계 'abandon' 으로 다시 재동결한다. '미노출만' 범위는 동결 회차가
            들어 있어도(정상이면 없다) 건드리지 않는다(보관 유지: 동결 시점 값).
            청크 = HGH_ECAT_REFREEZE_CHUNK 회차(기본 5, S2 실측 글로벌 회차당 약 1~4초)씩 한 트랜잭션. 회차의 세대 judgment 에 ecat_apply·
            ecat_phase 를 남겨 재개가 이미 만든 회차를 건너뛴다. 진행 = preview.refreeze_progress[단계]{total·done·cycles{cyc: from_gen·to_gen·ms}},
            감사 = app.ecat_audit_log 'apply.refreeze'(회차·옛 세대·새 세대, 행위자 = 승인자, DB-v2.31 P152), 적재 원장 = ing.load.scope_ref.ecat.
            원자성: 회차 하나의 해제·재동결은 한 트랜잭션(중간 상태 없음), 청크 실패 = 그 청크 롤백(그 회차들은 옛 세대 = 반영 전 카드 값) →
            반영 failed(재동결은 상태 전이 전: applied 가 아니다). 이미 커밋된 청크의 회차는 새 세대(새 버전 카드 값)다. 재개(resume)는 남은
            회차만 재동결해 applied, 포기는 범위 회차 전부를 반영 전 내용으로 다시 투영한 뒤 단계 'abandon' 으로 재동결한다.
            미리보기: preview.refreeze{applies·count·exposed·cycles·note(고지 '노출 회차 N개 재동결')}, KPI 행 card{before = 지금 카드 뷰(frz.card_answer),
            after = 재동결 뒤 = 셀 답변의 rd 값(보관 해제) + 작업 답변 차이}. 지문에 재동결 회차의 세대를 넣는다(미리보기 뒤 동결·재생성 = 다시 미리보기).
  증분 청크라 영향 20만 답변 초과도 leaf 재구축 없이 나눠 반영한다(Escalated 는 청크 하나가 상한을 넘을 때만: 설정 오류).

E6(관리 API, api_rw) 계약
  요청    INSERT app.ecat_apply(kind 'entity_version', ver = 초안(또는 활성 = 범위 확장), from_ver = 지금 활성, scope_kind, from_round_date,
          requested_by, reason) → core.write.enqueue_change('entity_version', payload {apply_id, op 'preview'}). 요청 전에 running·failed 반영이
          있으면 409 ECAT_APPLY_RUNNING 으로 막는다(적재기도 같은 검사로 큐를 대기시킨다).
  승인    previewed → approved(approved_by·approved_at). preview.requires_approval 이면 승인자 ∈ app.rule_param ecat_approvers(JSON 배열 또는
          {"users": [...]}) 아니면 403 ECAT_EXPOSED_REQUIRES_APPROVAL, 아니면 요청 관리자 자체 승인 가능 → enqueue op 'apply'.
  거절    draft·previewed·approved → rejected. 재개 = failed 에서 enqueue op 'resume'(failed 는 rejected 로 닫지 않는다: 대기 표시가 남는다).
  포기    failed → enqueue op 'abandon'(위 절: 대기 표시 정리·범위 회차 반영 전 버전 고정, 끝나면 rejected). 포기 시작 뒤 resume 불가.
  되돌리기 applied 반영 X(ver b, from_ver a): 새 초안(origin 'rollback', based_on a) = a 의 app.ecat_entity·app.ecat_surface 행 복사(초안이 이미
          있으면 409 ECAT_DRAFT_EXISTS) → X 와 같은 scope_kind·from_round_date 로 요청(from_ver = 지금 활성 b) → 미리보기 → 승인 → 반영.
          적재기가 끝에서 X 를 rolled_back 으로 바꾼다.
  읽기    app.ecat_apply.status·error·preview(JSON: impact·cycles·requires_approval·approx·kpi[cyc·geo·engine·exposed·before/after{Hyundai·Kia·
          Genesis: measure.ratios 입력}]·brands[bare·전후 언급·답변]·samples{added·removed·moved: context·highlight·approx}).
  오류    적재기가 app.ecat_apply.error·judgment_change.error 앞에 붙이는 코드: ECAT_PREVIEW_STALE(→ previewed), ECAT_EXPOSED_REQUIRES_APPROVAL
          (→ previewed), ECAT_BASE_CHANGED(→ rejected), ECAT_APPLY_RUNNING(큐 대기), ECAT_APPLY_INCOMPLETE, ECAT_VERSION_STATE, ECAT_APPLY_STATE,
          ECAT_NO_ACTIVE, ECAT_SCAN_FAILED, ECAT_SCAN_PENDING(미리보기 = 큐 실패, 반영 시작 = previewed), ECAT_APPLY_ABANDONED(포기로 닫힘),
          ECAT_ESCALATED, ECAT_KIND_UNSUPPORTED, ECAT_APPLY_NOT_FOUND. DB 부분 유일 색인 ecat_apply_one_running
          위반 = ECAT_APPLY_RUNNING(409).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import os
import time
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from app.core.measure import MeasureScope, mention_population, own_cols
from app.core.profile import active_profile
from ingest.common.db import LoadContext

from .ecat import EcatImpact, impact
from .rejudge import REGISTRY_ROLE_REFRESH
from .service import InvariantError, project, stage

log = logging.getLogger("hgh.ingest.ecat")

SAMPLE_N = 20
BRAND_TOP = 20
KPI_ROWS_MAX = 20_000
CONTEXT = 80
BITS = ((1, "h", "Hyundai"), (2, "k", "Kia"), (4, "g", "Genesis"))      # 자사 열 비트(app.core.codes BRAND_OWN_COLS)와 같은 순서
TODAY_OVERRIDE: dt.date | None = None                                   # 시험 전용(노출 판정 기준일 고정)


def _chunk_sizes() -> tuple[int, int]:
    return int(os.environ.get("HGH_ECAT_CHUNK", "20000")), int(os.environ.get("HGH_ECAT_STAMP_CHUNK", "100000"))


def _refreeze_chunk() -> int:
    """한 트랜잭션에서 재동결할 회차 수(S2 실측 글로벌 회차당 약 1~4초: 기본 5 = 트랜잭션당 수~20초)."""
    return max(1, int(os.environ.get("HGH_ECAT_REFREEZE_CHUNK", "5")))


def refreezes(ap: Any) -> bool:
    """이 반영이 범위의 동결 회차를 재동결하나: '미노출만'(unexposed) 범위는 하지 않는다(동결 회차가 들어 있으면 보관 유지, 결정 27 고지 대상 아님)."""
    return ap["scope_kind"] != "unexposed"


# ════════════════════════════════════════════════════════════════════════════
# 오류·결과
# ════════════════════════════════════════════════════════════════════════════
class EcatError(Exception):
    """반영 요청을 처리할 수 없다(코드 = E6 오류 코드). 큐 행 failed."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


class EcatBusy(EcatError):
    """다른 반영이 running·failed(ECAT_APPLY_RUNNING). 큐 행은 대기로 남는다(process_change deferred)."""


@dataclass
class EcatStep:
    """handle 한 번(한 트랜잭션)의 결과. done 거짓 = 큐 행을 pending 으로 두고 다시 집는다. error = 요청 거절(쓰기는 커밋, 큐 행 failed)."""
    done: bool
    phase: str
    answers: int = 0
    error: str | None = None


@dataclass
class _Scope:
    ver: int
    active: int
    rows: list[asyncpg.Record]
    in_scope: list[int] = field(default_factory=list)
    exposed_in_scope: list[int] = field(default_factory=list)
    cur_ver: dict[int, int] = field(default_factory=dict)     # 범위 회차 → 현재 버전
    tgt: dict[int, int] = field(default_factory=dict)         # 범위 회차 → 목표 버전(보통 ver, 되돌리기 원복·포기는 회차의 반영 전 버전)
    pin_now: dict[int, int | None] = field(default_factory=dict)  # 범위 회차 → 지금 rd.cycle.ecat_ver(pins_before 기록용)
    restore_pin: dict[int, int] = field(default_factory=dict)  # 되돌리기 원복: 반영 전 고정 버전으로 다시 고정할 회차
    restore_unpin: list[int] = field(default_factory=list)     # 되돌리기 원복: 고정을 풀 회차(반영 전 = 활성 추종)
    round_dates: list[dt.date] = field(default_factory=list)
    max_cyc: int = 0

    @property
    def requires_approval(self) -> bool:
        return bool(self.exposed_in_scope)


@dataclass
class _Work:
    keys: list[int] = field(default_factory=list)                 # 작업 답변(영향 ∪ run 대표) ∩ 범위 서빙
    impacted: int = 0                                           # 그중 영향 답변 수
    prompt_runs: list[Any] = field(default_factory=list)         # 범위 안 영향 prompt-run(run 대표로 덮는 것 ∪ 고아)
    orphan_prs: list[Any] = field(default_factory=list)
    entities: list[Any] = field(default_factory=list)
    impacts: dict[int, EcatImpact] = field(default_factory=dict)  # 현재 버전 v → impact(v, 새 버전)
    other: dict[tuple[int, int], EcatImpact] = field(default_factory=dict)  # (현재 v, 목표 t ≠ 새 버전) → impact(v, t): 원복·포기


# ════════════════════════════════════════════════════════════════════════════
# SQL
# ════════════════════════════════════════════════════════════════════════════
APPLY_ROW = """
SELECT a.*, v.status AS ver_status, v.origin AS ver_origin
  FROM app.ecat_apply a JOIN app.ecat_version v ON v.ver = a.ver WHERE a.apply_id = $1 FOR UPDATE OF a
"""
ACTIVE_VER = "SELECT ver FROM app.ecat_version WHERE status = 'active'"
OTHER_BUSY = "SELECT apply_id, status FROM app.ecat_apply WHERE status IN ('running', 'failed') AND apply_id <> $1 ORDER BY apply_id LIMIT 1"
LEFTOVER_PENDING = "SELECT count(*) FROM rd.answer WHERE ecat_ver < 0"
# 회차 범위. 노출 = app.core.cycles 후보 술어(servable ∧ view_date ≤ 오늘 KST). $3 = 기준일(시험 고정, NULL = rd.today_kst())
CYCLES = """
WITH c AS (SELECT c.cyc_key, c.round_date, c.surface, c.ecat_ver::int4 AS pin,
                  (c.servable AND c.view_date IS NOT NULL AND c.view_date <= coalesce($3::date, rd.today_kst())) AS exposed
             FROM rd.cycle c)
SELECT c.*,
       CASE $1::text WHEN 'all' THEN true
                     WHEN 'from_round' THEN (c.pin IS NULL AND NOT c.exposed) OR c.round_date >= $2::date
                     ELSE c.pin IS NULL AND NOT c.exposed END AS in_scope
  FROM c ORDER BY c.cyc_key
"""
KEYS_IN_CYCLES = """
SELECT j.answer_key FROM rd.job j WHERE j.answer_key = ANY($1::int4[]) AND j.served AND j.cyc_key = ANY($2::int4[])
"""
RUN_REPS = """
SELECT DISTINCT ON (p.run_id) p.run_id, j.answer_key
  FROM ing.acr_prompt_run p JOIN ing.run r ON r.run_id = p.run_id
  JOIN rd.job j ON j.run_key = r.run_key AND j.served AND j.cyc_key = ANY($2::int4[])
 WHERE p.prompt_run_id = ANY($1::uuid[])
 ORDER BY p.run_id, j.answer_key
"""
PRS_OF_RUNS = "SELECT prompt_run_id FROM ing.acr_prompt_run WHERE prompt_run_id = ANY($1::uuid[]) AND run_id = ANY($2::uuid[])"
ORPHAN_PRS = """
SELECT p.prompt_run_id FROM ing.acr_prompt_run p
 WHERE p.prompt_run_id = ANY($1::uuid[])
   AND NOT EXISTS (SELECT 1 FROM ing.run r JOIN rd.job j ON j.run_key = r.run_key AND j.served WHERE r.run_id = p.run_id)
   AND EXISTS (SELECT 1 FROM ing.cycle_run cr JOIN rd.cycle c ON c.cycle_id = cr.cycle_id WHERE cr.run_id = p.run_id AND c.cyc_key = ANY($2::int4[]))
"""
COMMITTED_WATERMARK = "SELECT coalesce(max(load_id), 0) FROM ing.load WHERE status = 'committed'"
FP_KEYS = """
SELECT k.answer_key, a.load_id FROM ing.answer_key_map k JOIN ing.answer a ON a.run_month = k.run_month AND a.job_id = k.job_id
 WHERE k.answer_key = ANY($1::int4[]) AND a.load_id <= $2 ORDER BY 1
"""
CONTENT_MD5 = "SELECT v, encode(app.ecat_content_md5(v), 'hex') FROM unnest($1::int4[]) v"
APPROVERS = "SELECT value FROM app.rule_param WHERE key = 'ecat_approvers'"

SET_PREVIEWED = """
UPDATE app.ecat_apply SET status = 'previewed', preview = $2::jsonb, preview_set_md5 = $3, cycle_keys = $4::int4[], affected_answers = $5,
       error = NULL WHERE apply_id = $1
"""
SET_STATUS_ERROR = "UPDATE app.ecat_apply SET status = $2, error = $3 WHERE apply_id = $1"
SET_ERROR = "UPDATE app.ecat_apply SET error = $2 WHERE apply_id = $1"
SET_RUNNING = """
UPDATE app.ecat_apply SET status = 'running', started_at = coalesce(started_at, now()), load_id = coalesce(load_id, $2), cycle_keys = $3::int4[],
       affected_answers = $4, error = NULL WHERE apply_id = $1
"""
SET_RESUMED = "UPDATE app.ecat_apply SET status = 'running', error = NULL WHERE apply_id = $1"
SET_APPLIED = "UPDATE app.ecat_apply SET status = 'applied', finished_at = now(), error = NULL WHERE apply_id = $1"
MARK_ROLLED_BACK = """
UPDATE app.ecat_apply SET status = 'rolled_back'
 WHERE kind = 'entity_version' AND ver = $1 AND status = 'applied' AND apply_id <> $2 RETURNING apply_id
"""
MARK_FAILED = """
UPDATE app.ecat_apply SET status = CASE WHEN status = 'running' THEN 'failed' ELSE status END, error = $2
 WHERE apply_id = $1 AND status IN ('running', 'approved', 'previewed', 'draft')
"""
LOAD_NOTE = "UPDATE ing.load SET scope_ref = coalesce(scope_ref, '{}'::jsonb) || jsonb_build_object('ecat', $2::jsonb) WHERE load_id = $1"
# 회차 고정(rd.cycle 은 추적 표: 결과 캐시 버전이 트리거로 오른다)
PIN_CYCLES = "UPDATE rd.cycle SET ecat_ver = $1::int2 WHERE cyc_key = ANY($2::int4[]) AND ecat_ver IS DISTINCT FROM $1::int2"
PIN_UNPINNED = "UPDATE rd.cycle SET ecat_ver = $1::int2 WHERE cyc_key = ANY($2::int4[]) AND ecat_ver IS NULL"
ACTIVATE = "SELECT app.ecat_activate($1)"

# 반영 원장(rd.answer.ecat_ver). 대기 표시 = −새 버전. 세대 전용 표 쓰기라 결과 캐시 분류(tests/core/rcache_writers.py)에 등록한다.
MARK_PENDING = """
UPDATE rd.answer a SET ecat_ver = (-$1::int4)::int2
  FROM rd.job j
 WHERE j.answer_key = ANY($2::int4[]) AND a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   AND a.ecat_ver IS DISTINCT FROM (-$1::int4)::int2
"""
PENDING_CHUNK = """
SELECT a.answer_key FROM rd.answer a
 WHERE a.cyc_key = ANY($2::int4[]) AND a.round_date = ANY($3::date[]) AND a.ecat_ver = (-$1::int4)::int2
 ORDER BY a.cyc_key, a.answer_key LIMIT $4
"""
PENDING_LEFT = """
SELECT count(*) FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
 WHERE j.answer_key = ANY($2::int4[]) AND a.ecat_ver = (-$1::int4)::int2
"""
# 표시 목표 = 회차 고정 버전(없으면 새 버전 = 활성): 보통 반영은 전부 새 버전, 되돌리기 원복·포기 회차는 그 고정 버전
STAMP_CHUNK = """
WITH t AS (SELECT a.surface, a.round_date, a.answer_key, coalesce(c.ecat_ver, $1::int2) AS v
             FROM rd.answer a JOIN rd.cycle c ON c.cyc_key = a.cyc_key
            WHERE a.cyc_key = ANY($2::int4[]) AND a.round_date = ANY($3::date[]) AND a.ecat_ver >= 0
              AND a.ecat_ver <> coalesce(c.ecat_ver, $1::int2)
            LIMIT $4)
UPDATE rd.answer a SET ecat_ver = t.v FROM t
 WHERE a.surface = t.surface AND a.round_date = t.round_date AND a.answer_key = t.answer_key
"""
NOT_STAMPED = """
SELECT count(*) FROM rd.answer a JOIN rd.cycle c ON c.cyc_key = a.cyc_key
 WHERE a.cyc_key = ANY($2::int4[]) AND a.round_date = ANY($3::date[]) AND a.ecat_ver <> coalesce(c.ecat_ver, $1::int2)
"""
UNPIN_CYCLES = "UPDATE rd.cycle SET ecat_ver = NULL WHERE cyc_key = ANY($1::int4[]) AND ecat_ver IS NOT NULL"
RECORD_PINS = """
UPDATE app.ecat_apply SET preview = coalesce(preview, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE apply_id = $1
"""
# 되돌리기 대상 = 되돌릴 버전(= 되돌리기 반영의 from_ver)을 반영한 applied 반영 전부(원 반영 + 범위 확장), 먼저 반영한 순
# 포기 스캔 완결: 되돌아갈 버전들의 add 표면 중 전체 스캔 미완이거나, 지금 적재 훅 대상(활성·초안·회차 고정, ingest.ecat SURFACES_LIVE)이
#   아닌데 범위 회차에 그 표면의 스캔 경계(scanned_to_load_id) 뒤에 적재된 답변이 있는 것(그 적재 때 훅이 그 표면을 스캔했다는 보장이 없다)
ABANDON_SCAN_STALE = """
SELECT DISTINCT s.surface_id FROM app.ecat_surface s LEFT JOIN ing.hub_match_scan h ON h.surface_id = s.surface_id
 WHERE s.ver = ANY($1::int4[]) AND s.action = 'add'
   AND (h.scanned_to_load_id IS NULL
        OR (NOT EXISTS (SELECT 1 FROM app.ecat_surface ls JOIN app.ecat_version lv ON lv.ver = ls.ver
                         WHERE ls.surface_id = s.surface_id AND ls.action = 'add'
                           AND (lv.status IN ('active', 'draft') OR lv.ver IN (SELECT DISTINCT ecat_ver::int4 FROM rd.cycle WHERE ecat_ver IS NOT NULL)))
            AND EXISTS (SELECT 1 FROM rd.job j JOIN ing.answer_key_map k ON k.answer_key = j.answer_key
                          JOIN ing.answer a ON a.run_month = k.run_month AND a.job_id = k.job_id
                         WHERE j.cyc_key = ANY($2::int4[]) AND a.load_id > h.scanned_to_load_id)))
 ORDER BY 1
"""
PINNED_VERSIONS = "SELECT DISTINCT ecat_ver::int4 FROM rd.cycle WHERE ecat_ver IS NOT NULL"
ROLLBACK_TARGETS = """
SELECT apply_id, cycle_keys, preview->'pins_before' AS pins FROM app.ecat_apply
 WHERE kind = 'entity_version' AND ver = $1 AND status = 'applied' AND apply_id <> $2 ORDER BY apply_id
"""
# 스캔 완결: 버전들의 add 표면 중 전체 스캔이 끝나지 않은 것(진행 원장 없음·미완 = scanned_to_load_id NULL)
SCAN_PENDING = """
SELECT DISTINCT s.surface_id FROM app.ecat_surface s LEFT JOIN ing.hub_match_scan h ON h.surface_id = s.surface_id
 WHERE s.ver = ANY($1::int4[]) AND s.action = 'add' AND h.scanned_to_load_id IS NULL ORDER BY 1
"""
# 숨김 전환(활성 → 새 버전): 숨김은 활성화로 명부에 바로 반영되어 전 기간 즉시 적용된다(범위 무관)
HIDDEN_CHANGES = """
WITH a AS (SELECT * FROM app.ecat_entity WHERE ver = $1), b AS (SELECT * FROM app.ecat_entity WHERE ver = $2)
SELECT coalesce(b.entity_id, a.entity_id) AS entity_id, coalesce(b.name, a.name) AS name, coalesce(a.role, 'competitor') AS from_role,
       coalesce(b.role, 'competitor') AS to_role
  FROM a FULL JOIN b ON b.entity_id = a.entity_id
 WHERE (coalesce(a.role, 'competitor') = 'hidden') <> (coalesce(b.role, 'competitor') = 'hidden')
 ORDER BY 2 NULLS LAST, 1
"""
HIDDEN_MAX = 500
SIM_PINS = """
UPDATE rd.cycle c SET ecat_ver = t.v::int2 FROM unnest($1::int4[], $2::int4[]) AS t(k, v)
 WHERE c.cyc_key = t.k AND c.ecat_ver IS DISTINCT FROM t.v::int2
"""
SET_ABANDONED = "UPDATE app.ecat_apply SET status = 'rejected', finished_at = coalesce(finished_at, now()), error = $2 WHERE apply_id = $1"
# ── 동결 회차 재동결(제품 결정 27·31·32, 머리 주석 재동결 절) ──
# 범위 회차 중 활성 동결 세대가 있는 발행 global·website 회차(frz.freeze_cycle 이 다시 만들 수 있는 회차만: 그 밖의 세대는 해제하면
# 다시 만들지 못한다 = 건드리지 않는다). by_apply·by_phase = 그 세대를 이 반영의 어느 단계가 만들었나(재개 = 이미 만든 회차를 건너뛴다)
REFREEZE_TARGETS = """
SELECT g.cyc_key, g.gen_key, i.cycle_id, rc.round_date, rc.surface,
       g.judgment->>'ecat_apply' AS by_apply, g.judgment->>'ecat_phase' AS by_phase
  FROM frz.generation g JOIN ing.cycle i ON i.cyc_key = g.cyc_key JOIN rd.cycle rc ON rc.cyc_key = g.cyc_key
 WHERE g.state = 'active' AND g.cyc_key = ANY($1::int4[]) AND i.surface IN ('global', 'website') AND i.status = 'published'
 ORDER BY g.cyc_key
"""
REGENERATE = "SELECT frz.regenerate($1::uuid, $2, $3::jsonb)::text"
SET_ACTOR = "SELECT set_config('app.actor_id', $1, true), set_config('app.actor_type', 'system', true)"
AUDIT_REFREEZE = "INSERT INTO app.ecat_audit_log (action, ver, apply_id, detail) VALUES ('apply.refreeze', $1, $2, $3::jsonb)"
RECORD_REFREEZE = """
UPDATE app.ecat_apply
   SET preview = jsonb_set(coalesce(preview, '{}'::jsonb), '{refreeze_progress}',
                           coalesce(preview->'refreeze_progress', '{}'::jsonb) || jsonb_build_object($2::text,
                             coalesce(preview->'refreeze_progress'->$2, '{}'::jsonb) || $3::jsonb
                             || jsonb_build_object('cycles', coalesce(preview->'refreeze_progress'->$2->'cycles', '{}'::jsonb) || $4::jsonb)))
 WHERE apply_id = $1
"""
# 미리보기 카드 값: 재동결 회차의 지금 동결 셀(카드 뷰와 같은 in_full_cycle 게이트), 재동결 뒤 값 = 셀 답변의 rd 값(보관 해제)
PV_CELLS = """
CREATE TEMP TABLE _pv_cells ON COMMIT DROP AS
SELECT c.answer_key, c.surface, c.round_date, c.cyc_key
  FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active'
  JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key AND q.in_full_cycle
 WHERE c.cyc_key = ANY($1::int4[])
"""
PV_CARD_LIVE = """
CREATE UNIQUE INDEX ON _pv_cells (answer_key, cyc_key);
CREATE TEMP TABLE _pv_card ON COMMIT DROP AS
SELECT x.* FROM rd.answer x JOIN _pv_cells c ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key
                                              AND x.answer_key = c.answer_key;
UPDATE _pv_card SET is_rep = true;
"""
PV_CARD_CHUNK = """
DROP TABLE IF EXISTS _pv_cold, _pv_cnew;
CREATE TEMP TABLE _pv_cold ON COMMIT DROP AS SELECT o.* FROM _pv_old o JOIN _pv_cells c ON c.answer_key = o.answer_key AND c.cyc_key = o.cyc_key;
CREATE TEMP TABLE _pv_cnew ON COMMIT DROP AS SELECT n.* FROM _pv_new n JOIN _pv_cells c ON c.answer_key = n.answer_key AND c.cyc_key = n.cyc_key;
UPDATE _pv_cold SET is_rep = true;
UPDATE _pv_cnew SET is_rep = true;
"""

# ── 미리보기 임시 표(저장점 안에서 stage() 뒤에 만든다) ──
# 저장점 안에서만 만든다(저장점 되돌림이 지운다). 인자 있는 문장은 하나씩(asyncpg 확장 프로토콜)
PV_OLD = """
CREATE TEMP TABLE _pv_old ON COMMIT DROP AS
SELECT a.* FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
 WHERE j.answer_key = ANY($1::int4[])
"""
PV_NEW = """
CREATE UNIQUE INDEX ON _pv_old (answer_key);
DROP TABLE IF EXISTS _pv_new;
CREATE TEMP TABLE _pv_new ON COMMIT DROP AS SELECT * FROM _pv_old;
UPDATE _pv_new n SET cyc_key = s.cyc_key, geo_key = s.geo_key, engine_key = s.engine_key, surface = s.surface, round_date = s.round_date,
       own_mask = coalesce(o.own_mask, 0), own_rk_h = coalesce(o.own_rk_h, 0), own_rk_k = coalesce(o.own_rk_k, 0), own_rk_g = coalesce(o.own_rk_g, 0),
       ment_total = coalesce(o.ment_total, 0), ment_h = coalesce(o.ment_h, 0), ment_k = coalesce(o.ment_k, 0), ment_g = coalesce(o.ment_g, 0),
       sent_pos_h = coalesce(o.sent_pos_h, 0), sent_pos_k = coalesce(o.sent_pos_k, 0), sent_pos_g = coalesce(o.sent_pos_g, 0),
       sent_neg_h = coalesce(o.sent_neg_h, 0), sent_neg_k = coalesce(o.sent_neg_k, 0), sent_neg_g = coalesce(o.sent_neg_g, 0),
       sent_all_h = coalesce(o.sent_all_h, 0), sent_all_k = coalesce(o.sent_all_k, 0), sent_all_g = coalesce(o.sent_all_g, 0),
       t_own = coalesce(o.t_own, 0)
  FROM _ig_ans s LEFT JOIN _ig_own o ON o.answer_key = s.answer_key
 WHERE s.answer_key = n.answer_key;
DROP TABLE IF EXISTS _pv_bold;
CREATE TEMP TABLE _pv_bold ON COMMIT DROP AS
SELECT b.answer_key, b.surface, b.brand_key, b.competitive, b.own_bit, b.entity_rows, b.rid_n, b.mention_count, b.rk, b.s_pos, b.s_neu, b.s_neg,
       b.s_mix, b.is_rep, b.std_in, b.std_in_nc, b.elig, b.dflt
  FROM rd.answer_brand b JOIN _pv_old o ON o.surface = b.surface AND o.round_date = b.round_date AND o.answer_key = b.answer_key;
DROP TABLE IF EXISTS _pv_bnew;
CREATE TEMP TABLE _pv_bnew ON COMMIT DROP AS
SELECT x.answer_key, n.surface, x.brand_key, x.competitive, x.own_bit, x.entity_rows, x.rid_n, x.mention_count::int2 AS mention_count, x.rk,
       x.s_pos, x.s_neu, x.s_neg, x.s_mix, n.is_rep, n.std_in, n.std_in_nc, n.elig, n.dflt
  FROM _ig_ab x JOIN _pv_new n ON n.answer_key = x.answer_key;
"""
# 게이트 이동(버전과 무관해야 하는 열이 rd 와 다른 작업 답변 수: 0 이 정상. 0 이 아니면 rd 가 판정 입력보다 낡았다 = 대기 중인 재판정)
PV_DRIFT = """
SELECT count(*) FROM _pv_old o LEFT JOIN _ig_ans s ON s.answer_key = o.answer_key
 WHERE s.answer_key IS NULL
    OR (o.cyc_key, o.geo_key, o.engine_key, o.surface, o.round_date, o.elig, o.elig_nc, o.dflt, o.std_in, o.std_in_nc, o.acr_in, o.gap)
       IS DISTINCT FROM (s.cyc_key, s.geo_key, s.engine_key, s.surface, s.round_date, s.elig, s.elig_nc, s.dflt, s.std_in, s.std_in_nc,
                         s.acr_in, s.gap)
"""
PV_CHANGED = """
WITH own AS (
  SELECT o.answer_key FROM _pv_old o JOIN _pv_new n ON n.answer_key = o.answer_key
   WHERE (o.own_mask, o.own_rk_h, o.own_rk_k, o.own_rk_g, o.ment_total, o.ment_h, o.ment_k, o.ment_g, o.sent_pos_h, o.sent_pos_k, o.sent_pos_g,
          o.sent_neg_h, o.sent_neg_k, o.sent_neg_g, o.sent_all_h, o.sent_all_k, o.sent_all_g)
         IS DISTINCT FROM
         (n.own_mask, n.own_rk_h, n.own_rk_k, n.own_rk_g, n.ment_total, n.ment_h, n.ment_k, n.ment_g, n.sent_pos_h, n.sent_pos_k, n.sent_pos_g,
          n.sent_neg_h, n.sent_neg_k, n.sent_neg_g, n.sent_all_h, n.sent_all_k, n.sent_all_g)),
br AS (
  SELECT coalesce(bo.answer_key, bn.answer_key) AS answer_key
    FROM _pv_bold bo FULL JOIN _pv_bnew bn ON bn.answer_key = bo.answer_key AND bn.brand_key = bo.brand_key AND bn.competitive = bo.competitive
   WHERE bo.answer_key IS NULL OR bn.answer_key IS NULL
      OR (bo.own_bit, bo.entity_rows, bo.rid_n, bo.mention_count, bo.rk, bo.s_pos, bo.s_neu, bo.s_neg, bo.s_mix)
         IS DISTINCT FROM (bn.own_bit, bn.entity_rows, bn.rid_n, bn.mention_count, bn.rk, bn.s_pos, bn.s_neu, bn.s_neg, bn.s_mix))
SELECT count(*) FROM (SELECT answer_key FROM own UNION SELECT answer_key FROM br) x
"""
# 재매칭 추가 표본(겹침 제거 뒤 남은 적중, 이번 차이의 add 표면만): seed-4x-ecat E3 _ecat_hk ⋈ E1 _ecat_hm
PV_ADD_SAMPLES = """
SELECT hk.answer_key, hm.job_id, hm.run_month, hm.entity_id, hm.surface_id, hk.s, u.e
  FROM _ecat_hk hk
  JOIN _ecat_hm hm ON hm.answer_key = hk.answer_key AND hm.turn_index = hk.turn_index AND hm.entity_id = hk.entity_id
  CROSS JOIN LATERAL unnest(hm.starts, hm.ends) AS u(s, e)
 JOIN unnest($2::int4[]) k(answer_key) ON k.answer_key = hk.answer_key
 WHERE u.s = hk.s AND hm.surface_id = ANY($1::int4[])
 ORDER BY hk.answer_key, hk.s LIMIT $3
"""
BRAND_NAMES = "SELECT brand_key, bare FROM rd.dim_brand_name WHERE brand_key = ANY($1::int4[])"
GROUP_LABELS = """
SELECT c.cyc_key, c.round_date, c.surface, c.project_key FROM rd.cycle c WHERE c.cyc_key = ANY($1::int4[])
"""
GEO_LABELS = "SELECT geo_key, code FROM rd.dim_country WHERE geo_key = ANY($1::int2[])"
ENGINE_LABELS = "SELECT engine_key, code FROM rd.dim_engine WHERE engine_key = ANY($1::int2[])"
APPROX = """
SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ing.mention_occurrence o WHERE o.run_month = k.run_month AND o.job_id = k.job_id)
                           AND EXISTS (SELECT 1 FROM ing.mention m WHERE m.run_month = k.run_month AND m.job_id = k.job_id)) AS no_occurrence,
       count(*) FILTER (WHERE a.prompt_run_id IS NOT NULL) AS acr
  FROM ing.answer_key_map k JOIN ing.answer a ON a.run_month = k.run_month AND a.job_id = k.job_id
 WHERE k.answer_key = ANY($1::int4[])
"""
ENTITY_ROWS = """
SELECT ver, entity_id, name, role, merge_into, parent_brand_id, origin FROM app.ecat_entity WHERE ver = ANY($1::int4[]) AND entity_id = ANY($2::uuid[])
"""
SURFACE_DEFS = "SELECT surface_id, entity_id, surface, surface_norm FROM app.ecat_surface_def WHERE surface_id = ANY($1::int4[])"
VER_SURFACES = "SELECT ver, surface_id, action FROM app.ecat_surface WHERE ver = ANY($1::int4[])"
OCC_OF_ENTITIES = """
SELECT k.answer_key, o.run_month, o.job_id, o.ord, o.entity_id, o.brand_rollup_entity_id, o.surface_text, o.source_start, o.source_end,
       o.turn_index, o.context_snippet
  FROM ing.answer_key_map k JOIN ing.mention_occurrence o ON o.run_month = k.run_month AND o.job_id = k.job_id
 WHERE k.answer_key = ANY($1::int4[]) AND (o.entity_id = ANY($2::uuid[]) OR o.brand_rollup_entity_id = ANY($2::uuid[]))
 ORDER BY k.answer_key, o.ord LIMIT $3
"""
OCC_OF_SURFACES = """
SELECT k.answer_key, o.run_month, o.job_id, o.ord, o.entity_id, o.brand_rollup_entity_id, o.surface_text, o.source_start, o.source_end,
       o.turn_index, o.context_snippet, b.surface_id
  FROM ing.answer_key_map k JOIN ing.mention_occurrence o ON o.run_month = k.run_month AND o.job_id = k.job_id
  JOIN unnest($2::text[], $3::uuid[], $4::int4[]) AS b(norm, entity_id, surface_id)
    ON normalize(b.norm, NFC) = pg_temp.ecat_norm(o.surface_text) AND (b.entity_id IS NULL OR b.entity_id = o.entity_id)
 WHERE k.answer_key = ANY($1::int4[])
 ORDER BY k.answer_key, o.ord LIMIT $5
"""
MENTIONS_NO_OCC = """
SELECT k.answer_key, m.run_month, m.job_id, m.ord, m.entity_id, m.brand_rollup_entity_id, m.surfaces
  FROM ing.answer_key_map k JOIN ing.mention m ON m.run_month = k.run_month AND m.job_id = k.job_id
 WHERE k.answer_key = ANY($1::int4[]) AND (m.entity_id = ANY($2::uuid[]) OR m.brand_rollup_entity_id = ANY($2::uuid[]))
   AND NOT EXISTS (SELECT 1 FROM ing.mention_occurrence o WHERE o.run_month = m.run_month AND o.job_id = m.job_id)
 ORDER BY k.answer_key, m.ord LIMIT $3
"""
BODIES = """
SELECT k.answer_key, a.job_id, a.answer_text, (CASE WHEN a.prompt_run_id IS NOT NULL THEN 2 ELSE 1 END) AS body_turn, j.cyc_key
  FROM ing.answer_key_map k JOIN ing.answer a ON a.run_month = k.run_month AND a.job_id = k.job_id
  JOIN rd.job j ON j.answer_key = k.answer_key
 WHERE k.answer_key = ANY($1::int4[])
"""


# ════════════════════════════════════════════════════════════════════════════
# KPI SQL(차이 집계 = 더할 수 있는 합). 모수 식은 app.core.measure.mention_population(활성 프로필)을 표면별로 쓴다
# ════════════════════════════════════════════════════════════════════════════
def _pop_case(alias: str, table: str) -> str:
    prof = active_profile()
    whens = []
    for sf in (1, 2, 3):
        ms = MeasureScope(sf=sf, project_keys=(), own_bits=(1,), bgrps=None, profile=prof)
        whens.append(f"WHEN {sf} THEN ({mention_population(ms, alias, table)})")   # type: ignore[arg-type]
    return f"(CASE {alias}.surface {' '.join(whens)} ELSE false END)"


KPI_METRICS = ("answers", "total_mentions") + tuple(f"{m}_{c}" for _, c, _ in BITS for m in
                                                  ("tracked", "own_mentions", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked"))


def kpi_sql(src: str, where: str) -> str:
    """회차 × 국가 × 엔진 그룹 합(열 = KPI_METRICS). src 는 rd.answer 모양 행(rd.answer·_pv_old·_pv_new), where 는 고정 술어 조각.
    시험이 반영 뒤 rd.answer 에 같은 SQL 을 돌려 미리보기 후 값과 대조한다."""
    pop = _pop_case("a", "answer")
    cols = [f"count(*) FILTER (WHERE {pop}) AS answers", f"coalesce(sum(a.ment_total) FILTER (WHERE {pop}), 0) AS total_mentions"]
    for bit, c, _ in BITS:
        oc = own_cols([bit], "a")
        cols += [f"count(*) FILTER (WHERE {pop} AND (a.own_mask & {oc.mask}) <> 0) AS tracked_{c}",
                 f"coalesce(sum({oc.ment}) FILTER (WHERE {pop}), 0) AS own_mentions_{c}",
                 f"coalesce(sum({oc.sent_pos}) FILTER (WHERE {pop}), 0) AS sent_pos_{c}",
                 f"coalesce(sum({oc.sent_neg}) FILTER (WHERE {pop}), 0) AS sent_neg_{c}",
                 f"coalesce(sum({oc.sent_all}) FILTER (WHERE {pop}), 0) AS sent_all_{c}",
                 f"coalesce(sum({oc.rank}) FILTER (WHERE {pop} AND {oc.ranked}), 0) AS rank_sum_{c}",
                 f"count(*) FILTER (WHERE {pop} AND {oc.ranked}) AS ranked_{c}"]
    return f"SELECT a.cyc_key, a.geo_key, a.engine_key, {', '.join(cols)} FROM {src} a WHERE {where} GROUP BY 1, 2, 3"


def brand_sql(src: str, where: str) -> str:
    """경쟁 브랜드 언급 합(answer_brand 모양 행). 모수 = mention_population(table 'brand'), 경쟁 행만."""
    pop = _pop_case("b", "brand")
    return (f"SELECT b.brand_key, coalesce(sum(b.mention_count) FILTER (WHERE {pop} AND b.competitive), 0) AS mentions, "
            f"count(*) FILTER (WHERE {pop} AND b.competitive AND b.mention_count > 0) AS answers FROM {src} b WHERE {where} GROUP BY 1")


def _grp(r: asyncpg.Record) -> tuple[int, int, int]:
    return int(r["cyc_key"]), int(r["geo_key"]), int(r["engine_key"])


def _vals(r: asyncpg.Record) -> list[int]:
    return [int(r[m]) for m in KPI_METRICS]


def _add(acc: dict[Any, list[int]], k: Any, v: Sequence[int], sign: int = 1) -> None:
    cur = acc.setdefault(k, [0] * len(v))
    for i, x in enumerate(v):
        cur[i] += sign * x


def kpi_rows(metrics: Sequence[int]) -> dict[str, dict[str, int]]:
    """KPI_METRICS 값 → 자사 브랜드별 app.core.measure.ratios 입력 행."""
    d = dict(zip(KPI_METRICS, metrics, strict=True))
    out = {}
    for _, c, code in BITS:
        out[code] = {"answers": d["answers"], "total_mentions": d["total_mentions"], "tracked": d[f"tracked_{c}"],
                     "own_mentions": d[f"own_mentions_{c}"], "sent_pos": d[f"sent_pos_{c}"], "sent_neg": d[f"sent_neg_{c}"],
                     "sent_all": d[f"sent_all_{c}"], "rank_sum": d[f"rank_sum_{c}"], "ranked": d[f"ranked_{c}"]}
    return out


# ════════════════════════════════════════════════════════════════════════════
# 범위·작업 집합·지문
# ════════════════════════════════════════════════════════════════════════════
def _today() -> dt.date | None:
    return TODAY_OVERRIDE


async def _active(conn: asyncpg.Connection) -> int:
    v = await conn.fetchval(ACTIVE_VER)
    if v is None:
        raise EcatError("ECAT_NO_ACTIVE", "활성 엔티티 버전이 없다(v1 이관 전)")
    return int(v)


def _pins_json(v: Any) -> dict[str, Any]:
    d = json.loads(v) if isinstance(v, str) else v
    return d if isinstance(d, dict) else {}


async def _rollback_priors(conn: asyncpg.Connection, ap: asyncpg.Record) -> dict[int, int | None]:
    """되돌리기 반영의 원복 회차 → 반영 전 고정값(None = 활성 추종). 대상 반영(ver = from_ver, applied) 중 그 회차를 먼저 바꾼 반영의 기록."""
    prior: dict[int, int | None] = {}
    for r in await conn.fetch(ROLLBACK_TARGETS, int(ap["from_ver"]), int(ap["apply_id"])):
        pins = _pins_json(r["pins"])
        for k in r["cycle_keys"] or []:
            k = int(k)
            if k in prior:
                continue
            rec = pins.get(str(k))
            pin = rec.get("pin") if isinstance(rec, dict) else None
            prior[k] = int(pin) if pin is not None else None
    return prior


async def scope_of(conn: asyncpg.Connection, ap: asyncpg.Record, active: int, *, today: dt.date | None = None) -> _Scope:
    rows = await conn.fetch(CYCLES, ap["scope_kind"], ap["from_round_date"], today or _today())
    sc = _Scope(ver=int(ap["ver"]), active=active, rows=list(rows))
    restore = await _rollback_priors(conn, ap) if ap.get("ver_origin") == "rollback" else {}
    base = int(ap["from_ver"]) if ap["from_ver"] is not None else active
    dates: set[dt.date] = set()
    for r in rows:
        k = int(r["cyc_key"])
        sc.max_cyc = max(sc.max_cyc, k)
        cur = int(r["pin"]) if r["pin"] is not None else active
        back = k in restore and cur == base            # 원복 회차: 대상 반영들이 바꿨고 지금도 되돌릴 버전
        if not (r["in_scope"] or back):
            continue
        sc.in_scope.append(k)
        sc.cur_ver[k] = cur
        sc.pin_now[k] = int(r["pin"]) if r["pin"] is not None else None
        sc.tgt[k] = sc.ver
        if back:
            if restore[k] is None:
                sc.restore_unpin.append(k)
            else:
                sc.restore_pin[k] = sc.tgt[k] = int(restore[k])  # type: ignore[arg-type]
        dates.add(r["round_date"])
        if r["exposed"] or r["pin"] is not None:
            sc.exposed_in_scope.append(k)
    sc.round_dates = sorted(dates)
    return sc


async def work_of(conn: asyncpg.Connection, sc: _Scope) -> _Work:
    """범위 회차를 (현재 버전, 목표 버전) 쌍으로 묶어 impact(현재, 목표) 를 그 회차로 좁힌 합(읽기 전용). 목표 = 새 버전이 보통이고
    되돌리기 원복·포기 회차는 회차별 반영 전 버전이다(w.other)."""
    w = _Work()
    by_pair: dict[tuple[int, int], list[int]] = defaultdict(list)
    for k, v in sc.cur_ver.items():
        t = sc.tgt.get(k, sc.ver)
        if v != t:
            by_pair[(v, t)].append(k)
    keys: set[int] = set()
    impacted: set[int] = set()
    prs: set[Any] = set()
    orphans: set[Any] = set()
    ents: set[Any] = set()
    for v, t in sorted(by_pair):
        cyc = sorted(by_pair[(v, t)])
        imp = await impact(conn, v, t)
        if t == sc.ver:
            w.impacts[v] = imp
        else:
            w.other[(v, t)] = imp
        ents |= set(imp.entities)
        if imp.answer_keys:
            got = {int(r[0]) for r in await conn.fetch(KEYS_IN_CYCLES, imp.answer_keys, cyc)}
            keys |= got
            impacted |= got
        if imp.prompt_run_ids:
            reps = await conn.fetch(RUN_REPS, imp.prompt_run_ids, cyc)
            keys |= {int(r["answer_key"]) for r in reps}
            if reps:
                prs |= {r[0] for r in await conn.fetch(PRS_OF_RUNS, imp.prompt_run_ids, [r["run_id"] for r in reps])}
            orph = {r[0] for r in await conn.fetch(ORPHAN_PRS, imp.prompt_run_ids, cyc)}
            orphans |= orph
            prs |= orph
    w.keys = sorted(keys)
    w.impacted = len(impacted)
    w.prompt_runs = sorted(prs, key=str)
    w.orphan_prs = sorted(orphans, key=str)
    w.entities = sorted(ents, key=str)
    return w


async def fingerprint(conn: asyncpg.Connection, ap: asyncpg.Record, sc: _Scope, w: _Work, watermark: int, max_cyc: int) -> bytes:
    """영향 집합 지문(16바이트). 미리보기 때 있던 회차(cyc_key ≤ max_cyc)·커밋된 load(≤ watermark)가 쓴 답변만 센다."""
    vers = sorted({sc.ver, *sc.cur_ver.values(), *sc.tgt.values()})
    cm = {int(r[0]): r[1] for r in await conn.fetch(CONTENT_MD5, vers)}
    keys = [(int(r[0]), int(r[1])) for r in await conn.fetch(FP_KEYS, w.keys, watermark)]
    doc = {"ver": sc.ver, "from_ver": int(ap["from_ver"]), "active": sc.active, "content": {str(v): cm.get(v) for v in vers},
           "scope": [ap["scope_kind"], ap["from_round_date"].isoformat() if ap["from_round_date"] else None],
           "cycles": [[k, sc.cur_ver[k]] for k in sorted(sc.cur_ver) if k <= max_cyc], "keys": keys}
    other = [[k, sc.tgt[k]] for k in sorted(sc.tgt) if k <= max_cyc and sc.tgt[k] != sc.ver] + \
            [[k, None] for k in sorted(sc.restore_unpin) if k <= max_cyc]
    if other:                                   # 되돌리기 원복 회차(보통 반영의 지문은 전과 같은 모양)
        doc["restore"] = other
    if refreezes(ap) and sc.in_scope:           # 재동결 회차와 그 세대(미리보기의 카드 전 값 원천): 미리보기 뒤 동결·재생성되면 다시 미리보기
        rf = [[int(r["cyc_key"]), int(r["gen_key"])] for r in await conn.fetch(REFREEZE_TARGETS, sc.in_scope)]
        if rf:
            doc["refreeze"] = rf
    return hashlib.md5(json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()).digest()


async def _busy_check(conn: asyncpg.Connection, apply_id: int) -> None:
    other = await conn.fetchrow(OTHER_BUSY, apply_id)
    if other is not None:
        raise EcatBusy("ECAT_APPLY_RUNNING", f"반영 {other['apply_id']} 가 {other['status']} 상태다(끝나거나 재개될 때까지 대기)")


def _scope_versions(sc: _Scope) -> list[int]:
    return sorted({sc.ver, *sc.cur_ver.values(), *sc.tgt.values()})


async def scan_pending(conn: asyncpg.Connection, sc: _Scope) -> list[int]:
    """관련 버전의 add 표면 중 전체 스캔(ing.hub_match_scan)이 끝나지 않은 surface_id(빈 목록 = 완결)."""
    return [int(r[0]) for r in await conn.fetch(SCAN_PENDING, _scope_versions(sc))]


def _scan_msg(pending: Sequence[int]) -> str:
    head = ", ".join(map(str, pending[:20])) + (" 외" if len(pending) > 20 else "")
    return (f"ECAT_SCAN_PENDING: 추가 표면 {len(pending)}개({head})의 과거 답변 스캔(ing.hub_match_scan)이 끝나지 않았다"
            "(다시 미리보기: 미리보기가 재스캔한다)")


# ════════════════════════════════════════════════════════════════════════════
# E4 미리보기
# ════════════════════════════════════════════════════════════════════════════
async def compute_preview(conn: asyncpg.Connection, ctx: LoadContext, ap: asyncpg.Record, *, today: dt.date | None = None,
                          chunk: int | None = None) -> tuple[dict[str, Any], bytes, _Scope, _Work]:
    """미리보기 계산(rd 사실 행 쓰기 0: 청크마다 저장점 안에서 stage() → 차이 집계 → 저장점 되돌림). 호출자 트랜잭션 안에서 부른다."""
    active = await _active(conn)
    sc = await scope_of(conn, ap, active, today=today)
    pending_scan = await scan_pending(conn, sc)
    if pending_scan:
        raise EcatError("ECAT_SCAN_PENDING", _scan_msg(pending_scan).split(": ", 1)[1])
    w = await work_of(conn, sc)
    wm = int(await conn.fetchval(COMMITTED_WATERMARK))
    fp = await fingerprint(conn, ap, sc, w, wm, sc.max_cyc)
    size = chunk or _chunk_sizes()[0]
    b = sc.ver
    all_imps = [*w.impacts.values(), *w.other.values()]

    delta: dict[tuple[int, int, int], list[int]] = {}
    bdelta: dict[str, list[int]] = {}           # bare → [전 언급, 후 언급, 전 답변, 후 답변](작업 답변 한정)
    drift = changed = 0
    add_sids = sorted({s for imp in all_imps for s in imp.add_surfaces})
    added_hub: list[asyncpg.Record] = []
    # 목표 버전이 회차마다 다르면(되돌리기 원복) 저장점 안에서 범위 회차를 목표 버전에 임시 고정하고 고정을 따르는 stage 로 센다
    # (저장점 되돌림이 고정을 지운다). 보통 미리보기는 전과 같이 고정 무시(force) + 새 버전
    sim = bool(w.other)
    # 재동결 회차(범위의 동결 회차, '미노출만' 범위는 없음): 카드 값 전 = 지금 카드 뷰, 후 = 셀 답변의 지금 rd 값(보관 해제) + 작업 답변 차이
    rf_rows = list(await conn.fetch(REFREEZE_TARGETS, sc.in_scope)) if refreezes(ap) and sc.in_scope else []
    rf_keys = [int(r["cyc_key"]) for r in rf_rows]
    card_delta: dict[tuple[int, int, int], list[int]] = {}
    if rf_keys:
        await conn.execute("DROP TABLE IF EXISTS _pv_cells, _pv_card")
        await conn.execute(PV_CELLS, rf_keys)
        await conn.execute(PV_CARD_LIVE)
    for i in range(0, len(w.keys), size):
        part = w.keys[i:i + size]
        sp = conn.transaction()
        await sp.start()
        try:
            if sim:
                await conn.execute(SIM_PINS, sc.in_scope, [sc.tgt[k] for k in sc.in_scope])
            await stage(conn, ctx, [], extra_keys=part, detect_global=False, ecat_ver=b, ecat_force=not sim, escalate_at=max(size * 4, 1))
            await conn.execute(PV_OLD, part)
            await conn.execute(PV_NEW)
            drift += int(await conn.fetchval(PV_DRIFT))
            changed += int(await conn.fetchval(PV_CHANGED))
            for r in await conn.fetch(kpi_sql("_pv_old", "true")):
                _add(delta, _grp(r), _vals(r), -1)
            for r in await conn.fetch(kpi_sql("_pv_new", "true")):
                _add(delta, _grp(r), _vals(r), 1)
            if rf_keys:
                await conn.execute(PV_CARD_CHUNK)
                for r in await conn.fetch(kpi_sql("_pv_cold", "true")):
                    _add(card_delta, _grp(r), _vals(r), -1)
                for r in await conn.fetch(kpi_sql("_pv_cnew", "true")):
                    _add(card_delta, _grp(r), _vals(r), 1)
            bo = {int(r[0]): (int(r[1]), int(r[2])) for r in await conn.fetch(brand_sql("_pv_bold", "true"))}
            bn = {int(r[0]): (int(r[1]), int(r[2])) for r in await conn.fetch(brand_sql("_pv_bnew", "true"))}
            names = {int(r[0]): r[1] for r in await conn.fetch(BRAND_NAMES, sorted(set(bo) | set(bn)))}
            for k in set(bo) | set(bn):
                o, n = bo.get(k, (0, 0)), bn.get(k, (0, 0))
                _add(bdelta, names.get(k, f"#{k}"), [o[0], n[0], o[1], n[1]])
            if add_sids and len(added_hub) < SAMPLE_N and await conn.fetchval("SELECT to_regclass('pg_temp._ecat_hk') IS NOT NULL"):
                added_hub += await conn.fetch(PV_ADD_SAMPLES, add_sids, part, SAMPLE_N - len(added_hub))
        finally:
            await sp.rollback()

    card: dict[tuple[int, int, int], tuple[list[int], list[int]]] = {}
    if rf_keys:
        cb = {_grp(r): _vals(r) for r in await conn.fetch(kpi_sql("frz.card_answer", "a.cyc_key = ANY($1::int4[])"), rf_keys)}
        ca = {_grp(r): _vals(r) for r in await conn.fetch(kpi_sql("_pv_card", "true"))}
        for g, d in card_delta.items():
            _add(ca, g, d)
        zero = [0] * len(KPI_METRICS)
        card = {g: (cb.get(g, zero), ca.get(g, zero)) for g in set(cb) | set(ca)}
    touched = sorted({g[0] for g in delta} | {g[0] for g, (x, y) in card.items() if x != y})
    before: dict[tuple[int, int, int], list[int]] = {}
    if touched:
        dates = sorted({r["round_date"] for r in sc.rows if int(r["cyc_key"]) in set(touched)})
        for r in await conn.fetch(kpi_sql("rd.answer", "a.cyc_key = ANY($1::int4[]) AND a.round_date = ANY($2::date[])"), touched, dates):
            before[_grp(r)] = _vals(r)
    kpi = await _kpi_table(conn, sc, before, delta, card)
    brands = _top_brands(bdelta)
    await _brand_totals(conn, brands, sc)
    approx = dict(await conn.fetchrow(APPROX, w.keys)) if w.keys else {"no_occurrence": 0, "acr": 0}
    samples = await _samples(conn, sc, w, added_hub)
    exposed_rows = {int(r["cyc_key"]): r for r in sc.rows}
    hidden = [{"entity_id": str(r["entity_id"]), "name": r["name"], "from_role": r["from_role"], "to_role": r["to_role"]}
              for r in await conn.fetch(HIDDEN_CHANGES, active, b)] if b != active else []
    preview = {
        "v": 1, "apply_id": int(ap["apply_id"]), "ver": b, "from_ver": int(ap["from_ver"]), "active_ver": active,
        "scope_kind": ap["scope_kind"], "from_round_date": ap["from_round_date"].isoformat() if ap["from_round_date"] else None,
        "computed_at": dt.datetime.now(dt.UTC).isoformat(), "watermark_load_id": wm, "max_cyc_key": sc.max_cyc,
        "impact": {"entities": len(w.entities), "block_surfaces": sorted({s for x in all_imps for s in x.block_surfaces}),
                   "add_surfaces": add_sids, "impacted_answers": w.impacted, "work_answers": len(w.keys), "changed_answers": changed,
                   "prompt_runs": len(w.prompt_runs), "orphan_prompt_runs": len(w.orphan_prs), "gating_drift": drift,
                   "by_version": {str(v): {"answers": len(x.answer_keys), "prompt_runs": len(x.prompt_run_ids)} for v, x in w.impacts.items()},
                   "restore_by_version": {f"{v}->{t}": {"answers": len(x.answer_keys), "prompt_runs": len(x.prompt_run_ids)}
                                          for (v, t), x in w.other.items()}},
        "cycles": {"in_scope": len(sc.in_scope), "exposed_in_scope": sc.exposed_in_scope,
                   "pin_to_active": sorted(int(r["cyc_key"]) for r in sc.rows if int(r["cyc_key"]) not in sc.cur_ver and r["pin"] is None),
                   "restore_pin": {str(k): v for k, v in sorted(sc.restore_pin.items())}, "restore_unpin": sorted(sc.restore_unpin),
                   "exposed_labels": [{"cyc_key": k, "round_date": exposed_rows[k]["round_date"].isoformat(),
                                       "surface": int(exposed_rows[k]["surface"])} for k in sc.exposed_in_scope]},
        "requires_approval": sc.requires_approval,
        "refreeze": _refreeze_plan(ap, sc, rf_rows),
        "hidden": {"all_periods": True, "count": len(hidden), "changes": hidden[:HIDDEN_MAX], "truncated": len(hidden) > HIDDEN_MAX,
                   "note": "숨김은 반영 범위와 무관하게 전 기간 즉시 적용된다(활성화 때 명부 제외로 반영, 현행 제외와 같다)"},
        "approx": {"no_occurrence_answers": int(approx["no_occurrence"] or 0), "acr_answers": int(approx["acr"] or 0),
                   "note": "발생 행 없는 답변(6~8월 적재분)은 일부 표면 차단 시 개수 불변·재매칭 위치 없음, ACR 답변은 1턴 재매칭·선택 수 재계산 없음"},
        "kpi_metrics": list(KPI_METRICS), **kpi, "brands": brands, "samples": samples,
    }
    return preview, fp, sc, w


def _refreeze_plan(ap: Any, sc: _Scope, rf_rows: Sequence[asyncpg.Record]) -> dict[str, Any]:
    """미리보기 재동결 계획(고지 문구 포함). '미노출만' 범위는 동결 회차가 있어도 재동결하지 않는다(보관 유지)."""
    exposed = set(sc.exposed_in_scope)
    cycles = [{"cyc_key": int(r["cyc_key"]), "gen_key": int(r["gen_key"]), "round_date": r["round_date"].isoformat(),
               "surface": int(r["surface"]), "exposed": int(r["cyc_key"]) in exposed} for r in rf_rows]
    n_exp = sum(1 for c in cycles if c["exposed"])
    if not refreezes(ap):
        note = "미노출만 범위: 동결 회차는 재동결하지 않는다(카드 값 = 동결 시점 보관 값 유지)"
    elif cycles:
        note = (f"노출 회차 {n_exp}개 재동결(동결 회차 전체 {len(cycles)}개): 반영이 끝나면 그 회차의 카드 값이 새 버전 기준으로 바뀐다"
                "(재해석 재동결 = 운영 --cycle --reinterpret 재생성과 같은 의미)")
    else:
        note = "범위에 동결 회차 없음(재동결 없음)"
    return {"applies": refreezes(ap), "count": len(cycles), "exposed": n_exp, "cycles": cycles, "note": note,
            "approx": "카드 후 값 = 지금 동결 셀의 rd 값(보관 해제) + 작업 답변 차이. 재동결은 셀 집합을 지금 판정으로 다시 고르므로 "
                      "동결 뒤 새로 적재된 답변이 있으면 셀이 달라질 수 있다. 운영 summary 접기(현행 프로필 brand_card_fold)가 켜져 있으면 "
                      "공존 답변의 접기 몫은 후 값에 없다(재동결이 새 세대를 다시 접는다)"}


async def _kpi_table(conn: asyncpg.Connection, sc: _Scope, before: dict, delta: dict,
                     card: dict[tuple[int, int, int], tuple[list[int], list[int]]] | None = None) -> dict[str, Any]:
    """KPI 전후 표. card = 재동결 회차 그룹의 카드 값 (전 = 지금 카드 뷰, 후 = 재동결 뒤): 행의 card 필드. 실시간 값은 그대로인데 카드 값만
    바뀌는 그룹(보관 해제만으로 달라지는 셀)도 행으로 낸다."""
    card = card or {}
    rows = []
    zero = [0] * len(KPI_METRICS)
    for g in sorted(set(delta) | {g for g, (x, y) in card.items() if x != y}):
        d = delta.get(g, zero)
        cg = card.get(g)
        if not any(d) and (cg is None or cg[0] == cg[1]):
            continue
        b0 = before.get(g, zero)
        rows.append((g, b0, [x + y for x, y in zip(b0, d, strict=True)]))
    cyc = {int(r["cyc_key"]): r for r in await conn.fetch(GROUP_LABELS, sorted({g[0] for g, _, _ in rows}))}
    geo = {int(r[0]): r[1] for r in await conn.fetch(GEO_LABELS, sorted({g[1] for g, _, _ in rows}))}
    eng = {int(r[0]): r[1] for r in await conn.fetch(ENGINE_LABELS, sorted({g[2] for g, _, _ in rows}))}
    exposed = set(sc.exposed_in_scope)
    out = []
    for g, b0, a0 in rows[:KPI_ROWS_MAX]:
        c = cyc.get(g[0])
        out.append({"cyc_key": g[0], "round_date": c["round_date"].isoformat() if c else None, "surface": int(c["surface"]) if c else None,
                    "project_key": int(c["project_key"]) if c else None, "exposed": g[0] in exposed,
                    "geo_key": g[1], "geo": geo.get(g[1]), "engine_key": g[2], "engine": eng.get(g[2]),
                    "before": kpi_rows(b0), "after": kpi_rows(a0),
                    **({"card": {"before": kpi_rows(card[g][0]), "after": kpi_rows(card[g][1])}} if g in card else {})})
    return {"kpi": out, "kpi_truncated": len(rows) > KPI_ROWS_MAX, "kpi_groups_changed": len(rows)}


def _top_brands(bdelta: dict[str, list[int]]) -> list[dict[str, Any]]:
    items = [(bare, v) for bare, v in bdelta.items() if v[1] != v[0] or v[3] != v[2]]
    items.sort(key=lambda x: (-abs(x[1][1] - x[1][0]), -abs(x[1][3] - x[1][2]), x[0]))
    return [{"bare": bare, "delta_mentions": v[1] - v[0], "delta_answers": v[3] - v[2]} for bare, v in items[:BRAND_TOP]]


async def _brand_totals(conn: asyncpg.Connection, brands: list[dict[str, Any]], sc: _Scope) -> None:
    """상위 브랜드의 범위 회차 전체 합(전 = rd, 후 = 전 + 차이). 저장점 밖(rd 그대로)에서 센다. 새 표시 브랜드는 전 0."""
    if not brands or not sc.in_scope:
        return
    bares = [b["bare"] for b in brands]
    sql = ("SELECT d.bare, x.mentions, x.answers FROM (" + brand_sql(
        "rd.answer_brand", "b.cyc_key = ANY($1::int4[]) AND b.round_date = ANY($2::date[]) AND b.brand_key IN "
                           "(SELECT brand_key FROM rd.dim_brand_name WHERE bare = ANY($3::text[]))") +
           ") x JOIN rd.dim_brand_name d ON d.brand_key = x.brand_key")
    tot = {r[0]: (int(r[1]), int(r[2])) for r in await conn.fetch(sql, sc.in_scope, sc.round_dates, bares)}
    for b in brands:
        m0, a0 = tot.get(b["bare"], (0, 0))
        b.update({"before_mentions": m0, "after_mentions": m0 + b["delta_mentions"], "before_answers": a0,
                  "after_answers": a0 + b["delta_answers"]})


# ── 표본(위치 기반 본문 창) ──
def _window(text: str | None, s: int | None, e: int | None) -> tuple[str | None, list[int] | None]:
    if not text or s is None or e is None or s < 0 or e > len(text) or s >= e:
        return None, None
    lo, hi = max(0, s - CONTEXT), min(len(text), e + CONTEXT)
    return text[lo:hi], [s - lo, e - lo]


async def _samples(conn: asyncpg.Connection, sc: _Scope, w: _Work, added_hub: Sequence[asyncpg.Record]) -> dict[str, list[dict[str, Any]]]:
    """추가·제거·이동 언급 표본 각 SAMPLE_N(작업 답변, 이번 버전 차이에 해당하는 언급만)."""
    if not w.keys:
        return {"added": [], "removed": [], "moved": []}
    vers = sorted({sc.ver, *w.impacts})
    ent_rows = await conn.fetch(ENTITY_ROWS, vers, w.entities) if w.entities else []
    by: dict[Any, dict[int, asyncpg.Record]] = defaultdict(dict)
    for r in ent_rows:
        by[r["entity_id"]][int(r["ver"])] = r
    removed_e, moved_e, restored_e = set(), set(), set()
    for e in w.entities:
        new = by[e].get(sc.ver)
        new_role = new["role"] if new else "competitor"
        for v in w.impacts:
            old = by[e].get(v)
            old_role = old["role"] if old else "competitor"
            if new_role == "removed" and old_role != "removed":
                removed_e.add(e)
            elif old_role == "removed" and new_role != "removed":
                restored_e.add(e)
            elif (old["merge_into"] if old else None) != (new["merge_into"] if new else None) or \
                    (old["parent_brand_id"] if old else None) != (new["parent_brand_id"] if new else None):
                moved_e.add(e)
    vs = {(int(r["ver"]), int(r["surface_id"])): r["action"] for r in await conn.fetch(VER_SURFACES, vers)}
    blk_new = sorted({s for (v, s), a in vs.items() if v == sc.ver and a == "block"} -
                     {s for (v, s), a in vs.items() if v in w.impacts and a == "block"})
    blk_old = sorted({s for (v, s), a in vs.items() if v in w.impacts and a == "block"} -
                     {s for (v, s), a in vs.items() if v == sc.ver and a == "block"})
    defs = {int(r["surface_id"]): r for r in await conn.fetch(SURFACE_DEFS, blk_new + blk_old)}
    names = {r["entity_id"]: r["name"] for r in ent_rows if r["name"]}

    def occ_item(r: asyncpg.Record, change: str) -> dict[str, Any]:
        return {"answer_key": int(r["answer_key"]), "job_id": str(r["job_id"]), "entity_id": str(r["entity_id"]),
                "name": names.get(r["entity_id"]), "surface": r["surface_text"], "change": change, "start": int(r["source_start"]),
                "end": int(r["source_end"]), "turn": r["turn_index"], "snippet": r["context_snippet"]}

    removed: list[dict[str, Any]] = []
    added: list[dict[str, Any]] = []
    moved: list[dict[str, Any]] = []
    if removed_e:
        removed += [occ_item(r, "remove") for r in await conn.fetch(OCC_OF_ENTITIES, w.keys, sorted(removed_e, key=str), SAMPLE_N)]
    if blk_new and len(removed) < SAMPLE_N:
        rs = await conn.fetch(OCC_OF_SURFACES, w.keys, [defs[s]["surface_norm"] for s in blk_new], [defs[s]["entity_id"] for s in blk_new],
                              blk_new, SAMPLE_N - len(removed))
        removed += [occ_item(r, "block") for r in rs]
    if removed_e and len(removed) < SAMPLE_N:              # 발생 행 없는 답변(6~8월): 표면 배열로 본문을 찾는다(근사)
        for r in await conn.fetch(MENTIONS_NO_OCC, w.keys, sorted(removed_e, key=str), SAMPLE_N - len(removed)):
            removed.append({"answer_key": int(r["answer_key"]), "job_id": str(r["job_id"]), "entity_id": str(r["entity_id"]),
                            "name": names.get(r["entity_id"]), "surface": (r["surfaces"] or [None])[0], "change": "remove",
                            "start": None, "end": None, "turn": None, "snippet": None, "approx": True})
    for r in added_hub[:SAMPLE_N]:
        added.append({"answer_key": int(r["answer_key"]), "job_id": str(r["job_id"]), "entity_id": str(r["entity_id"]),
                      "name": names.get(r["entity_id"]), "surface": None, "change": "add", "surface_id": int(r["surface_id"]),
                      "start": int(r["s"]), "end": int(r["e"]), "turn": None, "snippet": None})
    if restored_e and len(added) < SAMPLE_N:
        added += [occ_item(r, "restore") for r in await conn.fetch(OCC_OF_ENTITIES, w.keys, sorted(restored_e, key=str), SAMPLE_N - len(added))]
    if blk_old and len(added) < SAMPLE_N:
        rs = await conn.fetch(OCC_OF_SURFACES, w.keys, [defs[s]["surface_norm"] for s in blk_old], [defs[s]["entity_id"] for s in blk_old],
                              blk_old, SAMPLE_N - len(added))
        added += [occ_item(r, "unblock") for r in rs]
    if moved_e:
        moved += [occ_item(r, "move") for r in await conn.fetch(OCC_OF_ENTITIES, w.keys, sorted(moved_e, key=str), SAMPLE_N)]

    items = removed[:SAMPLE_N] + added[:SAMPLE_N] + moved[:SAMPLE_N]
    bodies = {int(r["answer_key"]): r for r in await conn.fetch(BODIES, sorted({x["answer_key"] for x in items}))} if items else {}
    for x in items:
        b = bodies.get(x["answer_key"])
        text = b["answer_text"] if b else None
        x["cyc_key"] = int(b["cyc_key"]) if b else None
        if x["change"] == "add":
            if text:
                x["surface"] = text[x["start"]:x["end"]]
        else:
            turn = x.get("turn")
            body_turn = int(b["body_turn"]) if b else 1
            if x.get("start") is not None and (turn if turn is not None else (1 if body_turn == 1 else None)) != body_turn:
                x["approx"] = True                                       # 다른 턴의 발생(ACR 1턴): 본문 위치가 아니다 → 발생 문맥
                x["start"] = x["end"] = None
            if x.get("start") is None and text and x.get("surface"):     # 위치 없음: 본문에서 표면 첫 위치(대소문자 무시, 근사)
                p = text.lower().find(str(x["surface"]).lower())
                if p >= 0:
                    x["start"], x["end"] = p, p + len(str(x["surface"]))
                    x["approx"] = True
        ctxt, hl = _window(text, x.get("start"), x.get("end"))
        x["context"] = ctxt if ctxt is not None else x.get("snippet")
        x["highlight"] = hl
        x.setdefault("approx", False)
        x.pop("snippet", None)
        x.pop("turn", None)
    return {"removed": removed[:SAMPLE_N], "added": added[:SAMPLE_N], "moved": moved[:SAMPLE_N]}


async def preview(conn: asyncpg.Connection, ctx: LoadContext, apply_id: int, *, today: dt.date | None = None,
                  chunk: int | None = None) -> EcatStep:
    """op preview: 계산 → app.ecat_apply preview·지문·범위 회차·작업 답변 수 → previewed. rd 불변."""
    ap = await _load(conn, apply_id)
    if ap["status"] not in ("draft", "previewed", "approved"):
        raise EcatError("ECAT_APPLY_STATE", f"미리보기는 draft·previewed·approved 에서만(현재 {ap['status']})")
    await _busy_check(conn, apply_id)
    if int(await conn.fetchval(LEFTOVER_PENDING)):
        raise EcatError("ECAT_APPLY_INCOMPLETE", "끝나지 않은 반영의 대기 표시(rd.answer.ecat_ver < 0)가 남아 있다: 그 반영을 재개한다")
    active = await _active(conn)
    if active != int(ap["from_ver"]):
        await conn.execute(SET_STATUS_ERROR, apply_id, "rejected",
                           f"ECAT_BASE_CHANGED: 요청 기준 버전 {ap['from_ver']} ≠ 활성 {active}(새로 요청한다)")
        return EcatStep(True, "preview", error=f"ECAT_BASE_CHANGED: from_ver {ap['from_ver']} ≠ active {active}")
    if ap["ver_status"] not in ("draft", "active") or (ap["ver_status"] == "active" and int(ap["ver"]) != active):
        raise EcatError("ECAT_VERSION_STATE", f"반영 버전 {ap['ver']} 은 {ap['ver_status']}(초안 또는 활성 범위 확장만)")
    pv, fp, sc, w = await compute_preview(conn, ctx, ap, today=today, chunk=chunk)
    await conn.execute(SET_PREVIEWED, apply_id, json.dumps(pv, ensure_ascii=False, default=str), fp, sc.in_scope, len(w.keys))
    await _note(conn, ctx, apply_id, "preview", {"work_answers": len(w.keys), "changed_answers": pv["impact"]["changed_answers"]})
    return EcatStep(True, "preview", answers=len(w.keys))


# ════════════════════════════════════════════════════════════════════════════
# E5 반영·되돌리기
# ════════════════════════════════════════════════════════════════════════════
async def _load(conn: asyncpg.Connection, apply_id: int) -> asyncpg.Record:
    ap = await conn.fetchrow(APPLY_ROW, apply_id)
    if ap is None:
        raise EcatError("ECAT_APPLY_NOT_FOUND", f"반영 {apply_id} 없음")
    if ap["kind"] != "entity_version":
        raise EcatError("ECAT_KIND_UNSUPPORTED", f"반영 {apply_id} kind {ap['kind']} 는 이 엔진이 처리하지 않는다")
    return ap


def _approvers(value: Any) -> set[str]:
    v = json.loads(value) if isinstance(value, str) else value
    if isinstance(v, dict):
        v = v.get("users") or []
    return {str(x).lower() for x in (v or [])}


async def _note(conn: asyncpg.Connection, ctx: LoadContext, apply_id: int, phase: str, extra: dict[str, Any]) -> None:
    await conn.execute(LOAD_NOTE, ctx.load_id, json.dumps({"apply_id": apply_id, "phase": phase, **extra}, default=str))


async def apply_step(conn: asyncpg.Connection, ctx: LoadContext, apply_id: int, op: str = "apply", *, today: dt.date | None = None,
                     chunk: int | None = None, stamp_chunk: int | None = None) -> EcatStep:
    """op apply·resume·abandon 한 트랜잭션 분량. 반환 done 거짓 = 이어서 다시 부른다."""
    ap = await _load(conn, apply_id)
    st = ap["status"]
    size, ssize = _chunk_sizes()
    size, ssize = chunk or size, stamp_chunk or ssize
    if op == "abandon":
        if st != "failed":
            raise EcatError("ECAT_APPLY_STATE", f"포기는 failed 에서만(현재 {st})")
        return await _abandon(conn, ctx, ap, today=today, size=size, ssize=ssize)
    if _abandoning(ap) and op in ("apply", "resume"):
        raise EcatError("ECAT_APPLY_STATE", f"반영 {apply_id} 는 포기가 시작됐다(op abandon 으로 마저 닫는다)")
    if op == "apply" and st == "approved":
        return await _start(conn, ctx, ap, today=today, size=size, ssize=ssize)
    if op == "resume" and st == "failed":
        await _busy_check(conn, apply_id)
        await conn.execute(SET_RESUMED, apply_id)
        await _note(conn, ctx, apply_id, "resume", {})
        return await _advance(conn, ctx, ap, size=size, ssize=ssize)
    if st == "running" and op in ("apply", "resume"):
        return await _advance(conn, ctx, ap, size=size, ssize=ssize)
    raise EcatError("ECAT_APPLY_STATE", f"op {op} 는 상태 {st} 에서 처리할 수 없다(apply = approved·running, resume = failed·running, abandon = failed)")


def _preview_of(ap: asyncpg.Record) -> dict[str, Any]:
    pv = ap["preview"] if isinstance(ap["preview"], dict) else json.loads(ap["preview"] or "null")
    return pv if isinstance(pv, dict) else {}


def _abandoning(ap: asyncpg.Record) -> bool:
    return bool(_preview_of(ap).get("abandon"))


async def _start(conn: asyncpg.Connection, ctx: LoadContext, ap: asyncpg.Record, *, today: dt.date | None, size: int, ssize: int) -> EcatStep:
    apply_id = int(ap["apply_id"])
    await _busy_check(conn, apply_id)
    if int(await conn.fetchval(LEFTOVER_PENDING)):
        raise EcatError("ECAT_APPLY_INCOMPLETE", "끝나지 않은 반영의 대기 표시(rd.answer.ecat_ver < 0)가 남아 있다")
    active = await _active(conn)
    b = int(ap["ver"])
    if active != int(ap["from_ver"]):
        msg = f"ECAT_BASE_CHANGED: 요청 기준 버전 {ap['from_ver']} ≠ 활성 {active}"
        await conn.execute(SET_STATUS_ERROR, apply_id, "rejected", msg)
        return EcatStep(True, "start", error=msg)
    if not (ap["ver_status"] == "draft" or (ap["ver_status"] == "active" and b == active)):
        raise EcatError("ECAT_VERSION_STATE", f"반영 버전 {b} 은 {ap['ver_status']}(초안 또는 활성 범위 확장만)")
    pv = _preview_of(ap)
    if not pv or ap["preview_set_md5"] is None:
        msg = "ECAT_PREVIEW_STALE: 미리보기 없음(미리보기 뒤 승인한다)"
        await conn.execute(SET_STATUS_ERROR, apply_id, "previewed", msg)
        return EcatStep(True, "start", error=msg)
    sc = await scope_of(conn, ap, active, today=today)
    pending_scan = await scan_pending(conn, sc)
    if pending_scan:
        msg = _scan_msg(pending_scan)
        await conn.execute(SET_STATUS_ERROR, apply_id, "previewed", msg)
        return EcatStep(True, "start", error=msg)
    w = await work_of(conn, sc)
    fp = await fingerprint(conn, ap, sc, w, int(pv["watermark_load_id"]), int(pv["max_cyc_key"]))
    if fp != bytes(ap["preview_set_md5"]):
        msg = "ECAT_PREVIEW_STALE: 미리보기 뒤 원천(영향 답변·범위 회차·버전 내용)이 바뀌었다(다시 미리보기)"
        await conn.execute(SET_STATUS_ERROR, apply_id, "previewed", msg)
        return EcatStep(True, "start", error=msg)
    if sc.requires_approval:
        allowed = _approvers(await conn.fetchval(APPROVERS))
        if str(ap["approved_by"]).lower() not in allowed:
            msg = f"ECAT_EXPOSED_REQUIRES_APPROVAL: 노출 회차 {len(sc.exposed_in_scope)}개가 범위에 있어 승인자(app.rule_param ecat_approvers) 승인이 필요하다"
            await conn.execute(SET_STATUS_ERROR, apply_id, "previewed", msg)
            return EcatStep(True, "start", error=msg)
    try:
        await conn.execute(SET_RUNNING, apply_id, ctx.load_id, sc.in_scope, len(w.keys))
    except asyncpg.UniqueViolationError as e:                       # ecat_apply_one_running(동시 시작 경합)
        raise EcatBusy("ECAT_APPLY_RUNNING", f"다른 반영이 방금 running 이 됐다({e.constraint_name})") from e
    # 반영 전 회차 상태(되돌리기·포기가 읽는다): 고정을 바꾸기 전에 남긴다
    pins_before = {str(k): {"pin": sc.pin_now.get(k), "ver": sc.cur_ver[k]} for k in sc.in_scope}
    await conn.execute(RECORD_PINS, apply_id, "pins_before", json.dumps(pins_before))
    # ⑥ 회차 고정: 범위 밖 고정 없음(= 노출) → 활성 버전, 범위 안 노출·고정 → 새 버전, 되돌리기 원복 회차 → 반영 전 고정(없으면 풂)
    restore = set(sc.restore_pin) | set(sc.restore_unpin)
    out_unpinned = [int(r["cyc_key"]) for r in sc.rows if int(r["cyc_key"]) not in sc.cur_ver and r["pin"] is None]
    pinned_out = _n(await conn.execute(PIN_UNPINNED, active, out_unpinned)) if out_unpinned else 0
    to_new = [k for k in sc.exposed_in_scope if k not in restore]
    pinned_in = _n(await conn.execute(PIN_CYCLES, b, to_new)) if to_new else 0
    restored = _n(await conn.execute(UNPIN_CYCLES, sc.restore_unpin)) if sc.restore_unpin else 0
    by_pin: dict[int, list[int]] = defaultdict(list)
    for k, v in sc.restore_pin.items():
        by_pin[v].append(k)
    for v, ks in sorted(by_pin.items()):
        restored += _n(await conn.execute(PIN_CYCLES, v, sorted(ks)))
    # ⑦ 활성화(범위 확장이면 생략) → 차원 역할
    if b != active:
        await conn.execute(ACTIVATE, b)
    await conn.execute(REGISTRY_ROLE_REFRESH)
    # ⑧ 대기 표시 → 첫 청크
    marked = _n(await conn.execute(MARK_PENDING, b, w.keys)) if w.keys else 0
    await _note(conn, ctx, apply_id, "start", {"work_answers": len(w.keys), "marked": marked, "pinned_out": pinned_out, "pinned_in": pinned_in,
                                               "restored": restored, "cycles": len(sc.in_scope), "orphan_prompt_runs": len(w.orphan_prs)})
    ap2 = await _load(conn, apply_id)
    return await _advance(conn, ctx, ap2, size=size, ssize=ssize, first=(w.orphan_prs, w.entities))


async def _abandon(conn: asyncpg.Connection, ctx: LoadContext, ap: asyncpg.Record, *, today: dt.date | None, size: int,
                   ssize: int) -> EcatStep:
    """op abandon(머리 주석 포기 절). 첫 처리 = 범위 회차 반영 전 버전 고정 + 역방향 영향 답변 대기 표시 + 첫 청크, 이후 = 청크 이어 처리."""
    apply_id, b = int(ap["apply_id"]), int(ap["ver"])
    if _abandoning(ap):
        return await _advance(conn, ctx, ap, size=size, ssize=ssize, abandon=True)
    await _busy_check(conn, apply_id)
    cyc = [int(k) for k in (ap["cycle_keys"] or [])]
    pins = _pins_json(_preview_of(ap).get("pins_before"))
    base = int(ap["from_ver"]) if ap["from_ver"] is not None else b
    rows = {int(r["cyc_key"]): r for r in await conn.fetch("SELECT cyc_key, round_date, ecat_ver FROM rd.cycle WHERE cyc_key = ANY($1::int4[])", cyc)}
    sc = _Scope(ver=b, active=b, rows=[])
    dates: set[dt.date] = set()
    repin: dict[int, list[int]] = defaultdict(list)
    keep: dict[int, int | None] = {}
    for k in cyc:
        r = rows.get(k)
        if r is None:                                               # 회차가 사라졌다(재구축): 되돌릴 행이 없다
            continue
        rec = pins.get(str(k)) if isinstance(pins.get(str(k)), dict) else {}
        prior_ver = int(rec["ver"]) if rec.get("ver") is not None else base
        dates.add(r["round_date"])
        sc.in_scope.append(k)
        sc.cur_ver[k] = int(r["ecat_ver"]) if r["ecat_ver"] is not None else b
        if prior_ver == b:                                          # 반영 전에도 새 버전(범위 확장의 미노출 회차): 반영 전 고정 그대로
            keep[k] = int(rec["pin"]) if rec.get("pin") is not None else None
            sc.tgt[k] = b
        else:
            repin[prior_ver].append(k)
            sc.tgt[k] = prior_ver
    sc.round_dates = sorted(dates)
    stale = [int(r[0]) for r in await conn.fetch(ABANDON_SCAN_STALE, _scope_versions(sc), sc.in_scope)]
    if stale:      # 재스캔(prepare)이 따라잡지 못했다: 포기하지 않고 failed 그대로(다시 포기하면 prepare 가 재스캔한다)
        raise EcatError("ECAT_SCAN_PENDING", _scan_msg(stale).split(": ", 1)[1])
    w = await work_of(conn, sc)
    n_pin = 0
    for v, ks in sorted(repin.items()):
        n_pin += _n(await conn.execute(PIN_CYCLES, v, sorted(ks)))
    for k, pin in keep.items():
        n_pin += _n(await conn.execute(PIN_CYCLES, pin, [k])) if pin is not None else _n(await conn.execute(UNPIN_CYCLES, [k]))
    marked = _n(await conn.execute(MARK_PENDING, b, w.keys)) if w.keys else 0
    await conn.execute(RECORD_PINS, apply_id, "abandon", json.dumps({"started_at": dt.datetime.now(dt.UTC).isoformat(), "load_id": ctx.load_id,
                                                                    "repin": {str(v): sorted(ks) for v, ks in repin.items()},
                                                                    "work_answers": len(w.keys)}))
    await conn.execute(SET_ERROR, apply_id, f"ECAT_APPLY_ABANDONING: 포기 진행 중(범위 회차 {len(sc.in_scope)}개를 반영 전 버전으로)")
    await _note(conn, ctx, apply_id, "abandon", {"work_answers": len(w.keys), "marked": marked, "pinned": n_pin})
    ap2 = await _load(conn, apply_id)
    return await _advance(conn, ctx, ap2, size=size, ssize=ssize, first=(w.orphan_prs, w.entities), abandon=True)


async def _advance(conn: asyncpg.Connection, ctx: LoadContext, ap: asyncpg.Record, *, size: int, ssize: int,
                   first: tuple[list[Any], list[Any]] | None = None, abandon: bool = False) -> EcatStep:
    """청크 하나(대기 표시 답변 투영) + 대기가 끝났으면 표시 청크 하나 + 전부 끝났으면 마무리. 한 트랜잭션.
    abandon = 포기 경로(같은 청크·표시, 끝 = rejected ECAT_APPLY_ABANDONED)."""
    apply_id, b = int(ap["apply_id"]), int(ap["ver"])
    cyc = list(ap["cycle_keys"] or [])
    dates = [r[0] for r in await conn.fetch("SELECT DISTINCT round_date FROM rd.cycle WHERE cyc_key = ANY($1::int4[])", cyc)]
    pending = [int(r[0]) for r in await conn.fetch(PENDING_CHUNK, b, cyc, dates, size)]
    orphans, ents = first or ([], [])
    n = 0
    if pending or orphans or ents:
        await project(conn, ctx, [], extra_keys=pending, extra_prompt_runs=orphans or None, extra_entities=ents or None,
                      detect_global=False, ecat_ver=b)
        left = int(await conn.fetchval(PENDING_LEFT, b, pending)) if pending else 0
        if left:
            raise InvariantError(f"반영 {apply_id}: 투영 뒤에도 대기 표시 {left} 답변(ecat_ver = −{b})")
        n = len(pending)
        await _note(conn, ctx, apply_id, "abandon_project" if abandon else "project", {"answers": n, "orphan_prompt_runs": len(orphans)})
        if len(pending) == size:
            return EcatStep(False, "project", answers=n)
    stamped = _n(await conn.execute(STAMP_CHUNK, b, cyc, dates, ssize)) if cyc else 0
    if stamped:
        await _note(conn, ctx, apply_id, "stamp", {"answers": stamped})
    if stamped == ssize:
        return EcatStep(False, "stamp", answers=n + stamped)
    bad = int(await conn.fetchval(NOT_STAMPED, b, cyc, dates)) if cyc else 0
    if bad:
        raise InvariantError(f"반영 {apply_id}: 범위 회차 답변 {bad} 의 ecat_ver ≠ 회차 목표 버전(전수 단언)")
    if cyc and refreezes(ap):                                     # 범위의 동결 회차 재해석 재동결(청크, 끝나야 applied·rejected)
        done_now, left = await _refreeze(conn, ctx, ap, [int(k) for k in cyc], "abandon" if abandon else "apply", _refreeze_chunk())
        if left:
            return EcatStep(False, "refreeze", answers=n + stamped + done_now)
    if abandon:
        await conn.execute(SET_ABANDONED, apply_id,
                           f"ECAT_APPLY_ABANDONED: 포기로 닫힘(범위 회차 = 반영 전 버전 고정, 활성 버전 v{b} 는 그대로: 새 회차는 v{b})")
        await _note(conn, ctx, apply_id, "abandoned", {"stamped": stamped})
        return EcatStep(True, "abandoned", answers=n + stamped)
    await conn.execute(SET_APPLIED, apply_id)
    rolled = []
    if ap["ver_origin"] == "rollback":
        rolled = [int(r[0]) for r in await conn.fetch(MARK_ROLLED_BACK, int(ap["from_ver"]), apply_id)]
    await _note(conn, ctx, apply_id, "done", {"stamped": stamped, "rolled_back": rolled})
    return EcatStep(True, "done", answers=n + stamped)


async def _regenerate(conn: asyncpg.Connection, cycle_id: Any, reason: str, judgment: str) -> dict[str, Any]:
    """회차 하나 재해석 재동결(frz.regenerate = 활성 세대 해제(보관 삭제) → 지금 판정으로 다시 동결, 같은 트랜잭션). 시험이 실패를 주입하는 자리.
    운영 summary 접기(현행 프로필 brand_card_fold, DB-v2.27·v2.28 frz.keep_fold): S2 발행 생성·cycle_admin regenerate(ingest.frz.freeze)와 같이
    새 세대의 공존 답변을 지금 rd(새 버전 투영) 기준으로 다시 접어 보관한다. 옛 세대의 'fold' 보관은 frz.regenerate 해제가 지웠다. 접기 실패
    (FoldDrift·keep_fold 불변식 예외)는 이 청크 롤백(옛 세대 그대로) = 접히지 않은 카드 값을 동결하지 않는다. 꺼짐이면 할 일 없음."""
    from ingest.frz import fold as frz_fold

    out = json.loads(await conn.fetchval(REGENERATE, cycle_id, reason, judgment))
    if out.get("status") == "frozen":
        out["fold"] = await frz_fold.keep_generation(conn, int(out["gen_key"]))
    return out


async def _refreeze(conn: asyncpg.Connection, ctx: LoadContext, ap: asyncpg.Record, cyc: list[int], phase: str, n: int) -> tuple[int, int]:
    """범위 회차 중 활성 동결 세대가 있고 이 반영의 이 단계(apply·abandon)가 아직 다시 만들지 않은 회차를 n 개까지 재동결한다.
    반환 (이번에 한 회차 수, 남은 회차 수). 진행 = app.ecat_apply.preview.refreeze_progress[단계], 감사 = app.ecat_audit_log 'apply.refreeze'
    (회차·옛 세대·새 세대·소요 ms), 적재 원장 = ing.load.scope_ref.ecat. 실패 = 예외(이 트랜잭션 롤백: 이번 청크의 회차는 옛 세대 그대로)."""
    from ingest.frz.freeze import judgment_pointer

    apply_id = int(ap["apply_id"])
    rows = await conn.fetch(REFREEZE_TARGETS, cyc)
    todo = [r for r in rows if not (r["by_apply"] == str(apply_id) and r["by_phase"] == phase)]
    if not todo:
        return 0, 0
    reason = f"엔티티 반영 {apply_id} {phase}(v{int(ap['ver'])}, 범위 {ap['scope_kind']})"
    judgment = json.dumps({**judgment_pointer(), "ecat_apply": str(apply_id), "ecat_phase": phase, "ecat_ver": int(ap["ver"])})
    done: dict[str, dict[str, Any]] = {}
    for r in todo[:n]:
        t0 = time.monotonic()
        out = await _regenerate(conn, r["cycle_id"], reason, judgment)
        if out.get("status") != "frozen":
            raise InvariantError(f"반영 {apply_id}: 회차 {r['cyc_key']} 재동결 결과 {out.get('status')}(frozen 아님)")
        done[str(int(r["cyc_key"]))] = {"from_gen": int(r["gen_key"]), "to_gen": int(out["gen_key"]), "cells": out.get("cells"),
                                        "fold": out.get("fold"), "round_date": r["round_date"].isoformat(), "surface": int(r["surface"]),
                                        "ms": round((time.monotonic() - t0) * 1000)}
    left = len(todo) - len(done)
    prog = {"total": len(rows), "done": len(rows) - left, "updated_at": dt.datetime.now(dt.UTC).isoformat()}
    await conn.execute(RECORD_REFREEZE, apply_id, phase, json.dumps(prog), json.dumps(done))
    await conn.execute(SET_ACTOR, str(ap["approved_by"] or ap["requested_by"]))
    await conn.execute(AUDIT_REFREEZE, int(ap["ver"]), apply_id, json.dumps({"phase": phase, "reason": reason, **prog, "cycles": done}))
    await _note(conn, ctx, apply_id, f"refreeze_{phase}", {**prog, "cycles": {k: [v["from_gen"], v["to_gen"], v["ms"]] for k, v in done.items()}})
    return len(done), left


def _n(tag: str) -> int:
    try:
        return int(str(tag).split()[-1])
    except (ValueError, IndexError):
        return 0


# ════════════════════════════════════════════════════════════════════════════
# 큐 연결(ingest.cycles.workers.service.process_change)
# ════════════════════════════════════════════════════════════════════════════
def op_of(payload: Any) -> str:
    p = json.loads(payload) if isinstance(payload, str) else (payload or {})
    return str(p.get("op") or "")


async def handle(conn: asyncpg.Connection, ctx: LoadContext, payload: dict[str, Any]) -> EcatStep:
    """judgment_change 'entity_version' 한 행 처리(process_change 트랜잭션 안). 계약 검증은 호출자(parse_change)가 했다."""
    apply_id, op = int(payload["apply_id"]), str(payload["op"])
    if op == "preview":
        return await preview(conn, ctx, apply_id)
    return await apply_step(conn, ctx, apply_id, op)


async def prepare(db: Any, payload: Any) -> None:
    """미리보기·포기 전(트랜잭션 밖): 관련 버전의 add 표면 재스캔을 최신으로(E2 ensure_scanned, 자기 트랜잭션들). 관련 버전 = 반영 버전·
    기준 버전 ∪ 회차 고정 버전(rd.cycle.ecat_ver) ∪ 되돌리기 대상 반영의 pins_before 고정 버전(원복이 다시 고정할 버전: 한동안 적재 훅
    대상이 아니었을 수 있다) ∪ (포기) 범위 회차의 반영 전 버전(pins_before.ver: 실패한 반영이 열려 있는 동안 활성·고정이 아니어서 적재 훅이
    그 버전에만 있는 add 표면을 스캔하지 않았다). 반영·재개 op 는 하지 않는다(미리보기가 맞춘 뒤 새 본문은 적재 훅이 활성·초안·회차 고정
    버전 add 표면으로 같은 트랜잭션에서 스캔한다). 포기는 첫 처리 전에만(포기가 시작되면 이후 청크는 건너뛴다)."""
    p = json.loads(payload) if isinstance(payload, str) else (payload or {})
    if p.get("op") not in ("preview", "abandon"):
        return
    from ingest.ecat.scan import ensure_scanned

    async with db.session() as conn:
        sids = await prepare_surface_ids(conn, int(p["apply_id"]), str(p["op"]))
    if sids:
        await ensure_scanned(db, surface_ids=sids)


async def prepare_surface_ids(conn: asyncpg.Connection, apply_id: int, op: str) -> list[int]:
    """prepare 가 재스캔할 add 표면(읽기 전용). 포기가 이미 시작된 반영은 빈 목록."""
    row = await conn.fetchrow("SELECT ver, from_ver, preview FROM app.ecat_apply WHERE apply_id = $1", apply_id)
    if row is None:
        return []
    pv = _pins_json(row["preview"])
    if op == "abandon" and pv.get("abandon"):
        return []
    vers = {int(row["ver"])} | ({int(row["from_ver"])} if row["from_ver"] is not None else set())
    vers |= {int(r[0]) for r in await conn.fetch(PINNED_VERSIONS)}
    for r in await conn.fetch(ROLLBACK_TARGETS, row["from_ver"], apply_id) if row["from_ver"] is not None else []:
        vers |= {int(x["pin"]) for x in _pins_json(r["pins"]).values() if isinstance(x, dict) and x.get("pin") is not None}
    if op == "abandon":
        vers |= {int(x["ver"]) for x in _pins_json(pv.get("pins_before")).values() if isinstance(x, dict) and x.get("ver") is not None}
    return sorted({int(r[0]) for r in await conn.fetch(
        "SELECT surface_id FROM app.ecat_surface WHERE ver = ANY($1::int4[]) AND action = 'add'", sorted(vers))})


async def mark_failed(conn: asyncpg.Connection, change_id: int, message: str) -> None:
    """process_change 실패 트랜잭션 안: 큐 행의 반영을 running → failed(그 밖 상태는 오류 문구만)."""
    payload = await conn.fetchval("SELECT payload FROM app.judgment_change WHERE change_id = $1", change_id)
    p = json.loads(payload) if isinstance(payload, str) else (payload or {})
    if p.get("apply_id"):
        await conn.execute(MARK_FAILED, int(p["apply_id"]), message)


__all__ = ["EcatBusy", "EcatError", "EcatStep", "KPI_METRICS", "apply_step", "brand_sql", "compute_preview", "fingerprint", "handle",
           "kpi_rows", "kpi_sql", "mark_failed", "op_of", "prepare", "preview", "scope_of", "work_of"]

