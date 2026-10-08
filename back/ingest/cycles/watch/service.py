"""ingest.cycles.watch: 감시 태스크(6시간, 워커와 다른 스케줄. 현행 app/api/cron/cycle-chain-watch/route.ts 계승).

워커와 같은 배에 태우지 않는 이유: 현행은 동기화가 16틱 연속 타임아웃일 때 뒷단 관제가 0회 실행됐다(route.ts:21-27).
그래서 워커가 죽은 것(하트비트)도 여기서 본다. 스케줄 자체가 스로틀(하루 4회)이라 상태 표를 두지 않는다.

점검(등급 0 PASS · 1 주의 · 2 긴급, 목적지 = 알림 라우팅 룰)
  heartbeat        pull 커서 최근 시도가 하트비트 한도(기본 60분)보다 오래됨 → live 2
  ingest_backlog   blocked run · 재확인 창이 닫혔는데 미해소·분석 대기 run(rd.v_ingest_backlog 와 같은 술어) → live 1(blocked 있으면 2)
  view_lag         원장 회차가 노출 예정일 + 여유(48h)를 넘도록 노출 안 됨(표면별) → live 1(2회차 이상 밀리면 2)
  publish_backlog  닫힌 회차가 발행 판정(R08) 대기로 6시간 넘게 머묾 → code 1
  load_failures    최근 6시간 실패 적재 3건 이상 → code 1
  queue            실패·escalated_rebuild 요청(최근 6시간), 1시간 넘게 대기 중인 요청 → code 1 · live 1
  projection_gap   측정은 끝났는데(ing.answer completed·드롭 아님) 사실표(rd.answer)에 투영되지 않은 답변이 적재 뒤 1시간 넘게 남음 → live 1/2
                   (현행 hmg-geo #327 2d310ec 감시 ④ 앵커 공백의 hub 적재 경로판, 아래 절)
  publish_gate     닫혔는데 발행 게이트(DB-v2.14, 제품 결정 17)가 blocked 인 회차(활성 유닛 100% 미달) → 회차별 빠진 유닛 수·엔진×국가 분포·
                   표본 유닛과 운영자 선택지(재측정·봉인·강제 발행) → live(글로벌 포함 2, 웹사이트만 1). 회차당 1회(ing.cycle_gate.alerted_at 기록),
                   quiet(이관 당시 이미 닫힌 이관 회차) 제외. publish_backlog 는 게이트 blocked·quiet 를, view_lag 는 quiet 를 뺀다.
  review_fill      엔티티 버전 관리(E8, 제품 결정 28) 검토 대기함 채우기 + 드리프트 경보. 판정 창 = 마지막으로 판정이 끝난 적재 이후
                   (커밋 경계 ing.review_fill_state.judged_load_id 이후 커밋된 적재의 답변, 진행 중 적재 앞에서 멈춤, 판정 불가면 전진 안 함). 새 엔티티(rd.dim_entity 판정 창 첫 관측, 아직 어느
                   버전에도 분류 안 됨)·기존 엔티티의 새 표면(판정 창 언급 표면 중 판정 원장 ing.surface_seen 에 없는 것 = 처음 관측,
                   허브 표면 정의에 없음)을
                   app.ecat_review 에 쌓는다(kind 별 upsert, 카운트 누적). 새 표면이 **자사 엔티티**거나 감시 창 언급 수가 50행 이상이면
                   live 1(9/20 Hyundai 표면 `N` 22,714턴 반사실). 재알림 억제 = review 행의 alerted_at(한 표면 1회, 다른 점검의 "스케줄
                   자체가 스로틀"과 달리 **행 단위**: 카운트는 계속 누적해도 재경보하지 않는다). 새 엔티티는 경보 없이 큐만 쌓는다
                   (E6 관리 화면의 검토 대상). 아래 절.
알림 목적지: live = Slack(#ops-alerts, core.config HGH_ALERT_SLACK_WEBHOOK 이 있을 때 ingest.common.alerts.SlackAlertSink),
code = 로그(이슈 트래커 배선 전). 재알림 억제 = 이 스케줄(6시간, 현행 cycle-chain-watch route.ts "스케줄 자체가 스로틀"과 같다).
한 번 실행에 점검마다 경보 1건(묶음 요약)만 낸다. 판정 불가(문장 오류·시간 초과)는 알리지 않고 보고(rep.info)에만 싣는다(현행 감시 ③④ 규약).

투영 공백(동기화 S1 BE-10, 제품 결정 Q4 a)
  현행: 앵커 축 화면은 표시 행(scope_answer_cycle_anchors)이 없는 완료 답변을 조용히 뺀다. 1차 방어 = sync-mirror 따라잡기(20분, 틱당
  회차 20·답변 5,000), 감시 ④ = 싱크 뒤 1시간 지나도 남은 공백 → Slack. 긴급(2) = global·website 공백 ∨ 답변 1,000 이상 ∨ 싱크 뒤 24시간
  이상, 그 밖 주의(1)(lib/summary/health/cycle-chain.ts:628-720).
  hub: 표시 행이 따로 없고 적재 트랜잭션이 ing 행과 rd 투영을 함께 커밋하므로(ingest.project.apply) 공백은 불변식 위반(대량 시드·수동 보정·
  결함)일 때만 생긴다. 같은 뜻의 술어 = ing.answer status 'completed' ∧ ing.answer_drop 없음 ∧ rd.job 좌표의 rd.answer 행 없음
  (rd.job.served 정의: completed ∧ NOT dropped = rd.answer 존재). 경과 기준 = 그 행을 마지막으로 쓴 적재(ing.load)의 끝 시각(없으면 시작·
  first_seen_at). 등급은 현행 그대로(표면 = 회차 원장 표면, 없으면 rd.dim_project 표면, 둘 다 없으면 unattributed).
  자동 채움(현행 1차 방어를 따른다): rd 를 직접 쓰지 않고 판정 입력 큐에 재투영 요청 1건을 넣는다. kind = 'scope_prompt'(적재기가 스스로
  넣는 kind, DB-v2.1 P02) · subject_uuids = 공백 답변의 Scope 프롬프트 · payload.source = 'watch.projection_gap'. 큐 처리기(rejudge
  PROMPT_KINDS)는 그 프롬프트의 rd.job 답변 ∪ 미투영 ing 답변(UNPROJECTED_OF_PROMPTS)을 다시 투영한다(finalize 사슬: 결과 캐시 세대 경로).
  상한 = 예상 재투영 답변 FILL_MAX_ANSWERS(현행 틱당 5,000) 안에서 공백이 오래된 프롬프트부터, 한 프롬프트만으로 넘으면 건너뛰고 보고.
  같은 출처의 대기·실행 중 요청이 있으면 새로 넣지 않는다. prompt_id 없는 답변은 채울 수 없어 보고만 한다.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import json
import logging
import math
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.core.ecat.text import normalize_surface
from ingest.common.alerts import AlertSink, get_alert_sink, sink_label
from ingest.common.config import get_ingest_settings
from ingest.common.db import LoaderDB

log = logging.getLogger("hgh.ingest.watch")


@dataclass
class Finding:
    check: str
    severity: int
    sink: str               # live | code
    message: str
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class WatchReport:
    findings: list[Finding] = field(default_factory=list)
    checked: list[str] = field(default_factory=list)
    info: dict[str, Any] = field(default_factory=dict)       # 점검별 부가 보고(판정 불가 사유·투영 공백 요약·자동 채움)
    sink: str = ""                                           # 경보 싱크(slack | log | memory). log = Slack 미배선

    @property
    def severity(self) -> int:
        return max((f.severity for f in self.findings), default=0)


HEARTBEAT = "SELECT max(last_attempt_at) FROM ing.sync_cursor"
BACKLOG = """
SELECT count(*) FILTER (WHERE r.sync_state = 'blocked') AS blocked,
       count(*) FILTER (WHERE r.unresolved_jobs > 0 AND r.recheck_until <= $1) AS unresolved,
       count(*) FILTER (WHERE r.analysis_pending > 0 AND r.analysis_recheck_until <= $1) AS pending
  FROM ing.run r
 WHERE r.sync_state = 'blocked' OR (r.unresolved_jobs > 0 AND r.recheck_until <= $1) OR (r.analysis_pending > 0 AND r.analysis_recheck_until <= $1)
"""
# 원장 회차(파생 아님, project 표면 제외): 노출 예정 = anchor_date + 표면 지연, 여유 48h 를 넘겼는데 노출 안 됨(발행 전 또는 노출일 미도래)
VIEW_LAG = """
WITH dl AS (SELECT (SELECT value FROM app.rule_param WHERE key = 'view_delay_days_by_surface') AS by_s,
                   coalesce((SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'view_delay_days'), 2) AS dflt)
SELECT c.surface, count(*) AS cycles, min(c.anchor_date) AS oldest
  FROM ing.cycle c, dl
 WHERE c.surface IN ('global', 'website') AND c.anchor_source <> 'derived' AND c.hidden_scope IS DISTINCT FROM 'all'
   AND ((c.anchor_date + coalesce((dl.by_s ->> c.surface)::int, dl.dflt))::timestamp AT TIME ZONE 'Asia/Seoul') + interval '48 hours' < $1
   AND NOT (c.status = 'published' AND c.view_anchor_at IS NOT NULL AND c.view_anchor_at <= $1)
   AND c.anchor_date >= ($1::timestamptz AT TIME ZONE 'Asia/Seoul')::date - 60
   AND NOT EXISTS (SELECT 1 FROM ing.cycle_gate g WHERE g.cycle_id = c.cycle_id AND g.quiet)
 GROUP BY c.surface
"""
PUBLISH_BACKLOG = """
SELECT count(*) FROM ing.cycle c
 WHERE c.status = 'closed' AND c.closed_at < $1::timestamptz - interval '6 hours' AND (c.surface = 'project' OR c.anchor_source <> 'derived')
   AND NOT EXISTS (SELECT 1 FROM ing.cycle_gate g WHERE g.cycle_id = c.cycle_id AND (g.verdict = 'blocked' OR g.quiet))
"""
# 발행 게이트 미달(알리지 않은 것). 이름 = 앱 프로젝트 이름 또는 웹사이트 브랜드·국가
PUBLISH_GATE = """
SELECT c.cycle_id, c.cyc_key, c.surface, c.scope_project_id, c.anchor_date, c.round_date, c.closed_by, c.analysis_done_ratio,
       g.plan_units, g.active_units, g.done_units, g.sealed_units, g.withdrawn_units, g.missing_units,
       coalesce(p.name, ws.brand_code || ' ' || ws.country_code) AS name
  FROM ing.cycle_gate g JOIN ing.cycle c ON c.cycle_id = g.cycle_id
  LEFT JOIN app.project p ON p.scope_project_id = c.scope_project_id
  LEFT JOIN app.website_site ws ON ws.scope_project_id = c.scope_project_id
 WHERE c.status = 'closed' AND g.verdict = 'blocked' AND g.alerted_at IS NULL AND NOT g.quiet
 ORDER BY (c.surface = 'global') DESC, c.anchor_date, c.cyc_key
 LIMIT $1
"""
PUBLISH_GATE_OPEN = """
SELECT count(*) FROM ing.cycle_gate g JOIN ing.cycle c ON c.cycle_id = g.cycle_id
 WHERE c.status = 'closed' AND g.verdict = 'blocked' AND NOT g.quiet
"""
PUBLISH_GATE_MARK = "UPDATE ing.cycle_gate SET alerted_at = $2 WHERE cycle_id = ANY($1::uuid[]) AND alerted_at IS NULL"
LOAD_FAILURES = "SELECT count(*) FROM ing.load WHERE status = 'failed' AND started_at > $1::timestamptz - interval '6 hours'"
QUEUE = """
SELECT count(*) FILTER (WHERE status IN ('failed', 'escalated_rebuild')
                         AND (requested_at > $1::timestamptz - interval '6 hours' OR error LIKE 'dfs_outcome_unknown:%')) AS bad,
       count(*) FILTER (WHERE (status = 'pending' AND requested_at < $1::timestamptz - interval '1 hour'
                              AND kind NOT IN ('ga4_property', 'ga4_tracked_event'))
                           OR (status = 'running' AND kind = 'dfs_fetch'
                               AND coalesce(claimed_at, requested_at) < $1::timestamptz - interval '15 minutes')) AS stale
  FROM app.judgment_change WHERE status IN ('failed', 'escalated_rebuild', 'pending', 'running')
"""

CHECKS = ("heartbeat", "ingest_backlog", "view_lag", "publish_backlog", "load_failures", "queue", "projection_gap", "publish_gate",
          "review_fill")


def resolve_checks(names: Sequence[str] | None) -> frozenset[str]:
    """돌릴 점검(빈 값 = 전부). 모르는 이름은 기동 오류(조용히 빠진 점검은 감시가 아니다)."""
    got = frozenset(n.strip() for n in (names or ()) if n and n.strip())
    bad = sorted(got - set(CHECKS))
    if bad:
        raise ValueError(f"HGH_WATCH_CHECKS 모르는 점검: {bad}(가능: {', '.join(CHECKS)})")
    return got or frozenset(CHECKS)


# ── 투영 공백(BE-10) ─────────────────────────────────────────────────────────
PROJECTION_GAP_GRACE_HOURS = 1            # 현행 ANCHOR_GAP_GRACE_HOURS(싱크 뒤 1시간)
PROJECTION_GAP_URGENT_ANSWERS = 1_000     # 현행 ANCHOR_GAP_URGENT_ANSWERS
PROJECTION_GAP_URGENT_AGE_HOURS = 24      # 현행 ANCHOR_GAP_URGENT_AGE_HOURS
PROJECTION_GAP_URGENT_SURFACES = frozenset({"global", "website"})
PROJECTION_GAP_ROW_LIMIT = 20_000         # (run, 프롬프트) 묶음 상한(넘으면 saturated 표시: 조용히 잘린 수를 보고하지 않는다)
FILL_MAX_ANSWERS = 5_000                  # 자동 채움 1회 예상 재투영 답변 상한(현행 따라잡기 틱당 답변 5,000)
FILL_SOURCE = "watch.projection_gap"

# (run, 프롬프트) 묶음. answers = 전체 공백, aged = 적재 뒤 유예(시간)가 지난 공백. rd.job PK → rd.answer PK 좌표로 존재를 본다.
PROJECTION_GAP = """
WITH g AS (
  SELECT a.run_id, a.prompt_id, count(*)::int AS answers,
         count(*) FILTER (WHERE coalesce(l.finished_at, l.started_at, a.first_seen_at) < $1::timestamptz - make_interval(hours => $2::int))::int AS aged,
         min(coalesce(l.finished_at, l.started_at, a.first_seen_at)) AS oldest_load_at
    FROM ing.answer a
    LEFT JOIN ing.load l ON l.load_id = a.load_id
   WHERE a.status = 'completed'
     AND NOT EXISTS (SELECT 1 FROM ing.answer_drop d WHERE d.job_id = a.job_id)
     AND NOT EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
                      WHERE j.answer_key = a.answer_key)
   GROUP BY a.run_id, a.prompt_id)
SELECT g.run_id, g.prompt_id, g.answers, g.aged, g.oldest_load_at, r.scope_project_id, p.name AS project_name,
       coalesce(c.surface, CASE dp.surface WHEN 1 THEN 'global' WHEN 2 THEN 'website' WHEN 3 THEN 'project' END, 'unattributed') AS surface,
       coalesce(c.cycle_anchor_at, r.cycle_anchor_at) AS anchor_at,
       coalesce(c.cycle_id::text, 'run:' || g.run_id::text) AS cycle_ref
  FROM g JOIN ing.run r ON r.run_id = g.run_id
  LEFT JOIN ing.cycle_run cr ON cr.run_id = g.run_id
  LEFT JOIN ing.cycle c ON c.cycle_id = cr.cycle_id
  LEFT JOIN rd.dim_project dp ON dp.scope_project_id = r.scope_project_id
  LEFT JOIN app.project p ON p.scope_project_id = r.scope_project_id
 ORDER BY g.oldest_load_at, g.run_id, g.prompt_id NULLS LAST
 LIMIT $3
"""
# 채움 요청이 다시 투영할 답변 수(rejudge PROMPT_KINDS 의 KEYS_OF_PROMPTS ∪ UNPROJECTED_OF_PROMPTS 와 같은 술어)
FILL_ESTIMATE = """
WITH p AS (SELECT DISTINCT x AS prompt_id FROM unnest($1::uuid[]) x),
pj AS (SELECT d.prompt_id, count(*) AS n FROM rd.job j JOIN rd.dim_prompt d ON d.prompt_key = j.prompt_key
        WHERE d.prompt_id IN (SELECT prompt_id FROM p) GROUP BY 1),
pu AS (SELECT a.prompt_id, count(*) AS n FROM ing.answer a
        WHERE a.prompt_id IN (SELECT prompt_id FROM p) AND NOT EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = a.answer_key) GROUP BY 1)
SELECT p.prompt_id, (coalesce(pj.n, 0) + coalesce(pu.n, 0))::int AS est FROM p LEFT JOIN pj USING (prompt_id) LEFT JOIN pu USING (prompt_id)
"""
FILL_OPEN = """
SELECT change_id FROM app.judgment_change
 WHERE kind = 'scope_prompt' AND status IN ('pending', 'running') AND payload @> jsonb_build_object('source', $1::text)
 ORDER BY change_id LIMIT 1
"""
FILL_ENQUEUE = """
INSERT INTO app.judgment_change (kind, subject_uuids, payload, requested_by)
VALUES ('scope_prompt', $1::uuid[], $2::jsonb, $3::uuid) RETURNING change_id
"""


@dataclass
class ProjectionGapVerdict:
    severity: int = 0
    answers: int = 0                                          # 유예가 지난 공백 답변 합(경보 대상)
    fresh: int = 0                                            # 유예 안의 공백(경보하지 않음, 자동 채움 대상)
    cycles: int = 0
    by_surface: dict[str, int] = field(default_factory=dict)
    top: list[dict[str, Any]] = field(default_factory=list)   # 답변 수 상위 (표면, 프로젝트) 묶음 5개
    oldest: dict[str, Any] | None = None                      # 가장 오래된 회차 앵커와 그 묶음
    oldest_age_hours: int = 0                                 # 가장 오래된 적재 뒤 경과(시간, 내림)
    saturated: bool = False


def judge_projection_gap(rows: Sequence[Mapping[str, Any]], now: dt.datetime, *, saturated: bool = False) -> ProjectionGapVerdict:
    """순수 판정(현행 judgeAnchorGap): 유예가 지난 공백만 센다. 긴급 = global·website 공백 ∨ 합 1,000 이상 ∨ 가장 오래된 적재 뒤 24시간 이상."""
    v = ProjectionGapVerdict(saturated=saturated)
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    oldest_load: dt.datetime | None = None
    for r in rows:
        v.fresh += int(r["answers"]) - int(r["aged"])
        n = int(r["aged"])
        if n <= 0:
            continue
        key = (str(r["surface"]), str(r["scope_project_id"]))
        g = groups.setdefault(key, {"surface": key[0], "scope_project_id": key[1], "project_name": r.get("project_name"),
                                    "answers": 0, "cycle_refs": set(), "oldest_anchor_at": None, "oldest_load_at": None})
        g["answers"] += n
        g["cycle_refs"].add(r["cycle_ref"])
        a, lo = r.get("anchor_at"), r.get("oldest_load_at")
        if a is not None and (g["oldest_anchor_at"] is None or a < g["oldest_anchor_at"]):
            g["oldest_anchor_at"] = a
        if lo is not None and (g["oldest_load_at"] is None or lo < g["oldest_load_at"]):
            g["oldest_load_at"] = lo
        if lo is not None and (oldest_load is None or lo < oldest_load):
            oldest_load = lo
    for g in groups.values():
        v.answers += g["answers"]
        v.cycles += len(g["cycle_refs"])
        v.by_surface[g["surface"]] = v.by_surface.get(g["surface"], 0) + g["answers"]
        if g["oldest_anchor_at"] is not None and (v.oldest is None or g["oldest_anchor_at"] < v.oldest["anchor_at"]):
            v.oldest = {"anchor_at": g["oldest_anchor_at"], "scope_project_id": g["scope_project_id"],
                        "project_name": g["project_name"], "surface": g["surface"]}
    v.top = [{"surface": g["surface"], "scope_project_id": g["scope_project_id"], "project_name": g["project_name"],
              "answers": g["answers"], "cycles": len(g["cycle_refs"]), "oldest_anchor_at": g["oldest_anchor_at"],
              "oldest_load_at": g["oldest_load_at"]}
             for g in sorted(groups.values(), key=lambda g: (-g["answers"], g["scope_project_id"]))[:5]]
    if oldest_load is not None:
        v.oldest_age_hours = max(0, math.floor((now - oldest_load).total_seconds() / 3600))
    if v.answers > 0:
        urgent = (any(s in PROJECTION_GAP_URGENT_SURFACES for s, n in v.by_surface.items() if n > 0)
                  or v.answers >= PROJECTION_GAP_URGENT_ANSWERS or v.oldest_age_hours >= PROJECTION_GAP_URGENT_AGE_HOURS)
        v.severity = 2 if urgent else 1
    return v


@dataclass
class FillPlan:
    prompts: list[uuid.UUID] = field(default_factory=list)   # 이번 요청 대상(공백이 오래된 순으로 고른 뒤 정렬)
    gap_answers: int = 0                                      # 대상 프롬프트의 공백 답변 합
    estimated: int = 0                                        # 예상 재투영 답변 합(≤ cap)
    too_large: list[dict[str, Any]] = field(default_factory=list)   # 한 프롬프트만으로 cap 초과(건너뜀: 사람이 재구축·수동 요청)
    deferred: int = 0                                         # cap 때문에 다음 실행으로 미룬 프롬프트 수
    unfillable: int = 0                                       # prompt_id 없는 공백 답변(프롬프트 요청으로 채울 수 없다)


def plan_fill(rows: Sequence[Mapping[str, Any]], estimates: Mapping[Any, int], *, cap: int = FILL_MAX_ANSWERS) -> FillPlan:
    """순수 계획: 공백 프롬프트를 가장 오래된 적재 순으로 훑어 예상 재투영 합이 cap 안인 것만 고른다(현행 따라잡기 틱 상한과 같은 뜻)."""
    plan = FillPlan()
    per: dict[Any, dict[str, Any]] = {}
    for r in rows:
        if r["prompt_id"] is None:
            plan.unfillable += int(r["answers"])
            continue
        p = per.setdefault(r["prompt_id"], {"answers": 0, "oldest": r["oldest_load_at"]})
        p["answers"] += int(r["answers"])
        if r["oldest_load_at"] is not None and (p["oldest"] is None or r["oldest_load_at"] < p["oldest"]):
            p["oldest"] = r["oldest_load_at"]
    far = dt.datetime.max.replace(tzinfo=dt.UTC)
    for pid, p in sorted(per.items(), key=lambda kv: (kv[1]["oldest"] or far, str(kv[0]))):
        est = max(int(estimates.get(pid, 0)), p["answers"])
        if est > cap:
            plan.too_large.append({"prompt_id": str(pid), "gap_answers": p["answers"], "estimated": est})
        elif plan.estimated + est <= cap:
            plan.prompts.append(pid)
            plan.gap_answers += p["answers"]
            plan.estimated += est
        else:
            plan.deferred += 1
    plan.prompts.sort(key=str)
    return plan


async def _projection_gap(db: LoaderDB, conn: Any, rep: WatchReport, now: dt.datetime, *, grace_hours: int,
                          fill: bool, system_actor: uuid.UUID | None) -> Finding | None:
    """투영 공백 판정 + 자동 채움 요청. 판정 불가(문장 오류)는 None 과 rep.info 사유(경보 없음)."""
    try:
        async with db.tx(conn, statement_timeout="120s"):
            rows = [dict(r) for r in await conn.fetch(PROJECTION_GAP, now, grace_hours, PROJECTION_GAP_ROW_LIMIT)]
            saturated = len(rows) >= PROJECTION_GAP_ROW_LIMIT
            v = judge_projection_gap(rows, now, saturated=saturated)
            prompts = sorted({r["prompt_id"] for r in rows if r["prompt_id"] is not None}, key=str)
            est = {r["prompt_id"]: int(r["est"]) for r in await conn.fetch(FILL_ESTIMATE, prompts)} if (fill and prompts) else {}
    except Exception as e:  # noqa: BLE001 (판정 불가: 알리지 않는다)
        rep.info["projection_gap"] = {"checked": False, "reason": type(e).__name__, "error": str(e)[:300]}
        log.warning("투영 공백 판정 불가: %s", type(e).__name__)
        return None
    info: dict[str, Any] = {"checked": True, "answers": v.answers, "fresh": v.fresh, "cycles": v.cycles, "by_surface": v.by_surface,
                            "severity": v.severity, "saturated": v.saturated}
    rep.info["projection_gap"] = info
    if not rows:
        return None
    fill_info: dict[str, Any] = {"status": "off"}
    if fill:
        plan = plan_fill(rows, est)
        fill_info = {"status": "none", "prompts": len(plan.prompts), "gap_answers": plan.gap_answers, "estimated": plan.estimated,
                     "deferred_prompts": plan.deferred, "too_large": plan.too_large[:5], "unfillable_answers": plan.unfillable}
        try:
            async with db.tx(conn):
                open_id = await conn.fetchval(FILL_OPEN, FILL_SOURCE)
                if open_id is not None:
                    fill_info.update(status="pending", change_id=int(open_id))      # 같은 출처 요청이 아직 처리 전: 겹쳐 넣지 않는다
                elif plan.prompts:
                    payload = {"source": FILL_SOURCE, "gap_answers": plan.gap_answers, "estimated_answers": plan.estimated}
                    cid = await conn.fetchval(FILL_ENQUEUE, plan.prompts, json.dumps(payload), system_actor)
                    fill_info.update(status="requested", change_id=int(cid))
        except Exception as e:  # noqa: BLE001 (요청 실패는 감시·경보를 막지 않는다)
            fill_info.update(status="failed", error=type(e).__name__)
            log.warning("투영 공백 재투영 요청 실패: %s", type(e).__name__)
    info["fill"] = fill_info
    if v.severity == 0:
        return None
    surfaces = " · ".join(f"{s} {n}" for s, n in sorted(v.by_surface.items(), key=lambda kv: (-kv[1], kv[0])))
    msg = (f"투영 공백: 완료 답변 {v.answers}건 · 회차 {v.cycles}개 ({surfaces}), 적재 뒤 {grace_hours}시간 넘게 rd.answer 없음"
           f"{' (상한 도달, 실제는 더 많다)' if v.saturated else ''}. 재투영 요청 {fill_info['status']}")
    detail = {"answers": v.answers, "cycles": v.cycles, "by_surface": v.by_surface, "top": v.top, "oldest": v.oldest,
              "oldest_age_hours": v.oldest_age_hours, "fresh": v.fresh, "fill": fill_info,
              "recover": "큐 재투영(자동 채움 change_id) 처리 확인 → 남으면 해당 프롬프트 judgment_change('scope_prompt') 또는 표면 재구축"}
    return Finding("projection_gap", v.severity, "live", msg, detail)


# ── 발행 게이트 미달(제품 결정 17) ────────────────────────────────────────────
PUBLISH_GATE_CYCLE_LIMIT = 200          # 한 실행에 알리는 회차 상한(넘으면 다음 실행)
PUBLISH_GATE_DETAIL_CYCLES = 20         # 유닛 분포·표본을 싣는 회차 수
PUBLISH_GATE_SAMPLE_UNITS = 10          # 회차당 표본 유닛 수
PUBLISH_GATE_CHOICES = ("재측정(manual 측정, 채워지면 다음 틱에 자동 발행)", "봉인(cycle_admin seal, 사유 필수)",
                        "강제 발행(cycle_admin force_publish, 사유 필수)")


def summarize_missing(units: Sequence[Mapping[str, Any]], *, sample: int = PUBLISH_GATE_SAMPLE_UNITS) -> dict[str, Any]:
    """빠진 유닛 → 엔진×국가 분포(많은 순)·표본(정렬 순 앞에서 sample 개). 순수 함수."""
    by: dict[tuple[str, str], int] = {}
    for u in units:
        k = (str(u["target"]), str(u["region"]))
        by[k] = by.get(k, 0) + 1
    return {"units": len(units),
            "by_engine_region": [{"target": t, "region": r, "units": n} for (t, r), n in sorted(by.items(), key=lambda kv: (-kv[1], kv[0]))],
            "sample": [{"prompt_id": str(u["prompt_id"]), "target": u["target"], "region": u["region"]} for u in list(units)[:sample]]}


async def _publish_gate(db: LoaderDB, conn: Any, rep: WatchReport, now: dt.datetime) -> Finding | None:
    """게이트 blocked 인 닫힌 회차 알림(회차당 1회). 판정 불가(문장 오류)는 None 과 rep.info 사유(경보 없음)."""
    from ingest.cycles.ledger import service as ledger
    try:
        async with db.tx(conn, statement_timeout="120s"):
            rows = [dict(r) for r in await conn.fetch(PUBLISH_GATE, PUBLISH_GATE_CYCLE_LIMIT)]
            unresolved = int(await conn.fetchval(PUBLISH_GATE_OPEN))
            cycles: list[dict[str, Any]] = []
            for i, r in enumerate(rows):
                item = {"cycle_id": str(r["cycle_id"]), "cyc_key": r["cyc_key"], "surface": r["surface"], "name": r["name"],
                        "anchor_date": str(r["anchor_date"]), "round_date": str(r["round_date"]), "closed_by": r["closed_by"],
                        "active_units": r["active_units"], "done_units": r["done_units"], "missing_units": r["missing_units"],
                        "sealed_units": r["sealed_units"], "withdrawn_units": r["withdrawn_units"], "plan_units": r["plan_units"],
                        "analysis_done_ratio": None if r["analysis_done_ratio"] is None else float(r["analysis_done_ratio"])}
                if i < PUBLISH_GATE_DETAIL_CYCLES:
                    item["missing"] = summarize_missing(await ledger.missing_units(conn, r["cycle_id"]))
                cycles.append(item)
            if rows:
                await conn.execute(PUBLISH_GATE_MARK, [r["cycle_id"] for r in rows], now)
    except Exception as e:  # noqa: BLE001 (판정 불가: 알리지 않는다)
        rep.info["publish_gate"] = {"checked": False, "reason": type(e).__name__, "error": str(e)[:300]}
        log.warning("발행 게이트 점검 불가: %s", type(e).__name__)
        return None
    rep.info["publish_gate"] = {"checked": True, "new": len(rows), "unresolved": unresolved}
    if not rows:
        return None
    sev = 2 if any(r["surface"] == "global" for r in rows) else 1
    heads = " · ".join(f"{c['surface']} {c['name'] or c['cycle_id'][:8]} {c['anchor_date']} 빠짐 {c['missing_units']}/{c['active_units']}"
                       for c in cycles[:5])
    msg = (f"발행 게이트 미달: 닫힌 회차 {len(rows)}개 자동 발행 보류(활성 유닛 100% 미완료). {heads}"
           f"{' 외' if len(rows) > 5 else ''}. 선택: " + " / ".join(PUBLISH_GATE_CHOICES))
    return Finding("publish_gate", sev, "live", msg, {"cycles": cycles, "unresolved": unresolved, "choices": list(PUBLISH_GATE_CHOICES)})


# ── 검토 대기함 채우기 + 드리프트(E8, 제품 결정 28) ───────────────────────────
# 설계 정본: notes/hgh-impl/hmg-entity-management-versioning-design-20261001.md 1-3절·8절 E8.
# 판정 창 = 커밋 순서(적재 원장) 기준: load_id ∈ (state.judged_load_id, W] 인 적재가 쓴 답변. W = 커밋이 끝난 load 경계(진행 중인 load 가
#   있으면 그 직전까지, ingest.ecat 스캔 워터마크와 같은 규칙: LOAD_WATERMARK). 시각 창 (judged_to, now] 은 first_seen_at 기본값 now() =
#   적재 트랜잭션 시작 시각이라, 판정보다 먼저 시작해 판정 뒤에 커밋된 적재(한 run 답변 전체가 한 트랜잭션)의 답변이 창 밖(이미 지난 시각)이
#   되어 그 run 에서 처음 나온 표면이 영영 판정되지 않았다(검증 반례 N5). 지금은 그 적재가 진행 중이면 W 가 그 앞에서 멈추고, 커밋되면 다음
#   판정 창에 든다. 창 답변은 first_seen_at ≥ 창 적재들의 최소 started_at 로 색인(answer_first_seen_idx)을 먼저 타고 load_id 로 거른다(새
#   답변의 first_seen_at = 그 적재 트랜잭션 시작 ≥ 적재 행 started_at). 오래 running 으로 남은 죽은 적재(started_at < now − 24시간)는 W 를 묶지
#   않는다(rep.info stale_running). 대신 이월 목록(state.carry_load_ids)에 남겨 커밋되면 그 적재 답변을 따로 판정한다(N6, CARRY_SKIPPED 절). 판정이 끝나면(같은 트랜잭션) judged_load_id = W·judged_to = now 로 전진하고, 판정 불가(시간 초과·
#   문장 오류)면 롤백되어 전진하지 않는다 = 다음 실행이 같은 창을 다시 판정한다(검증 반례 N3). 판정 불가 수(연속)는 state.fail_count·
#   rep.info 에 남긴다(경보 없음). 재적재로 load_id 가 바뀐 옛 답변은 first_seen_at 이 창 하한보다 이르면 다시 보지 않는다(표면은 처음
#   적재 때 이미 판정됐다).
# 새 엔티티 = rd.dim_entity 행(적재기 INSERT ... WHERE NOT EXISTS 라 first_seen 은 진짜 최초 관측 시각, queries.py:786-792)이
#   판정 창 적재들이 시작한 뒤 생겼고(first_seen ≥ 창 하한) 판정 창 답변에 언급되며, 아직 어느 버전에도 분류되지 않음(app.ecat_entity 에 행
#   없음 = 관리자가 손댄 적 없음).
# 새 표면 = 판정 창 답변의 언급 표면(ing.mention.surfaces 원문)을 정규화해
#   (entity_id, 정규형)이 판정 원장 ing.surface_seen 에 없는 것(= 처음 관측, 검증 반례 CE9). 원장 조회는 PK 조회라 대형 엔티티(Hyundai
#   언급 수십만)도 그 엔티티의 과거 언급을 훑지 않는다(검증 반례 N3). 정규화는 창의 서로 다른 원문 표면에만 한다. 정규형 = seed-3x-common
#   §10 pg_temp.ecat_norm 과 같은 식(_surface_norm_sql). 이미 대기(pending) 검토 행이 있는 표면은 원장에 있어도 계속 카운트를 누적한다.
#   허브가 이미 아는 표면(app.ecat_surface_def)은 올리지 않는다. 판정 창의 표면은 같은 트랜잭션에서 원장에 더한다(상한으로 잘린 새 표면은
#   더하지 않는다: 다시 나오면 그때 새 표면으로 잡힌다).
# 첫 가동(원장 기준선): state 가 없으면 창 시작 = now − lookback, 그때까지 시작한 적재(started_at ≤ 창 시작, 워터마크 이하)의 마지막
#   load_id 를 기준선 경계로 두고 그 이하 load 가 쓴 답변 표면을 run_month 별 트랜잭션으로 원장에 채운다(커서 = baseline_cursor, 중단 뒤
#   이어받음). 창 앞 적재가 하나도 없으면(허브 첫 적재·빈 DB) 워터마크까지 기준선으로 채우고 큐·경보를
#   하지 않는다(rep.info baseline). "회차당" 임계는 판정 창 합으로 근사한다(projection_gap·다른 점검과 같은 근사 원칙).
# 재알림 억제는 다른 점검(스케줄 자체가 스로틀)과 달리 **행 단위**(app.ecat_review.alerted_at): 한 번 경보한 (entity_id, surface_norm) 은
#   다시 울리지 않는다(관리자가 검토·해소할 때까지). 새 엔티티는 경보하지 않는다(E6 관리 화면의 검토 대상). 자사 엔티티 판정은
#   app.brand(is_hmg_own·canonical_entity_id) ∪ 그 별칭(app.entity_alias).
REVIEW_LOOKBACK_HOURS = 6                  # 첫 가동 판정 창 길이(감시 주기와 같다). 그 뒤 창은 judged_to 부터
REVIEW_ROW_LIMIT = 500                     # 한 실행에 다루는 후보 상한(kind 별). 넘으면 saturated 표시
REVIEW_SURFACE_ALERT_MENTIONS = 50         # 설계 1-3절 "회차당 50행 이상"(근사: 판정 창 합)
REVIEW_TIMEOUT = "120s"

OWN_ENTITY_IDS = """
SELECT canonical_entity_id AS entity_id FROM app.brand WHERE is_hmg_own AND canonical_entity_id IS NOT NULL
UNION
SELECT a.alias_entity_id FROM app.entity_alias a JOIN app.brand b ON b.canonical_entity_id = a.canon_entity_id WHERE b.is_hmg_own
"""


def _surface_norm_sql(col: str) -> str:
    """표면 정규형 SQL(seed-3x-common §10 pg_temp.ecat_norm 본문과 같은 식, 대조 시험 test_ecat_sql_parity 의 짝). 결과 정렬 규칙을
    기본으로 되돌린다(소문자화의 ICU 정렬 규칙이 결과에 남으면 ing.surface_seen PK(기본 정렬 규칙) 비교가 색인 조건이 못 되고 필터가 된다)."""
    return (f"(normalize(btrim(regexp_replace(replace(replace(lower(normalize({col}, NFKC) COLLATE \"und-x-icu\"), 'ß', 'ss'), 'ς', 'σ'), "
            f"'\\s+', ' ', 'g'), ' '), NFC) COLLATE \"default\")")


RF_STATE_INIT = "INSERT INTO ing.review_fill_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING"
RF_STATE = "SELECT * FROM ing.review_fill_state WHERE id FOR UPDATE"
RF_STATE_SET = """
UPDATE ing.review_fill_state SET judged_to = $1, baseline_to = $2, baseline_cursor = $3, baseline_done = $4, judged_load_id = $5, updated_at = now()
 WHERE id
"""
RF_STATE_JUDGED = """
UPDATE ing.review_fill_state SET judged_to = greatest(coalesce(judged_to, $1), $1), judged_load_id = greatest(coalesce(judged_load_id, $2), $2),
       fail_count = 0, last_error = NULL, updated_at = now() WHERE id
"""
# 커밋 경계(ingest.ecat.queries.WATERMARK 와 같은 규칙 + 죽은 running 제외): 이 load_id 이하가 쓴 답변은 다 커밋됐다
LOAD_WATERMARK = """
SELECT least(coalesce((SELECT max(load_id) FROM ing.load), 0),
             coalesce((SELECT min(load_id) - 1 FROM ing.load
                        WHERE status = 'running' AND started_at >= $1::timestamptz - interval '24 hours'
                          AND NOT (kind = 'rebuild' AND coalesce(scope_ref->>'source', '') = 'ecat_scan')), 9223372036854775807))
"""
STALE_RUNNING = "SELECT count(*) FROM ing.load WHERE status = 'running' AND started_at < $1::timestamptz - interval '24 hours'"
# 이월(검증 반례 N6): 워터마크가 넘어간 범위 안에서 아직 running 인 적재(= 24시간 넘은 running, 워터마크를 묶지 않았다). pull 적재는 스테이지
#   중단 뒤 같은 load_id 로 이어받아 하루 넘게 걸려 커밋될 수 있다 → state.carry_load_ids 에 남기고, 이후 실행에서 committed 가 되면 그 적재의
#   답변을 따로 판정한 뒤 지운다(failed·없음 = 답변을 커밋하지 않는다 → 지운다, running = 남긴다). 판정 실패면 트랜잭션 롤백 = 목록 그대로(N3).
CARRY_SKIPPED = "SELECT coalesce(array_agg(load_id ORDER BY load_id), '{}') FROM ing.load WHERE load_id > $1 AND load_id <= $2 AND status = 'running'"
CARRY_STATUS = "SELECT load_id, status, started_at FROM ing.load WHERE load_id = ANY($1::bigint[])"
CARRY_SET = "UPDATE ing.review_fill_state SET carry_load_ids = $1::bigint[], updated_at = now() WHERE id"
# 기준선 경계: 창 시작까지 시작한 적재의 마지막 load_id(워터마크 이하)
BASELINE_LOAD = "SELECT max(load_id) FROM ing.load WHERE started_at <= $1::timestamptz AND load_id <= $2"
# 창 적재들의 최소 시작 시각(창 답변의 first_seen_at 하한)
WINDOW_LO = "SELECT min(started_at) FROM ing.load WHERE load_id > $1 AND load_id <= $2"
WINDOW_ANS_DROP = "DROP TABLE IF EXISTS _rf_wa"
WINDOW_ANSWERS = """
CREATE TEMP TABLE _rf_wa ON COMMIT DROP AS
SELECT a.run_month, a.job_id, a.load_id, a.first_seen_at FROM ing.answer a
 WHERE a.first_seen_at >= $3::timestamptz AND a.load_id > $1 AND a.load_id <= $2
UNION ALL                                                       -- 이월 적재 중 이번에 커밋이 확인된 것(범위 (lo, hi] 밖, 겹침 없음)
SELECT a.run_month, a.job_id, a.load_id, a.first_seen_at FROM ing.answer a
 WHERE a.first_seen_at >= $5::timestamptz AND a.load_id = ANY($4::bigint[]) AND a.load_id <= $1
"""
RF_STATE_FAIL = """
UPDATE ing.review_fill_state SET fail_count = fail_count + 1, last_error = $1, last_fail_at = $2, updated_at = now() WHERE id
RETURNING fail_count, judged_to, judged_load_id, cardinality(carry_load_ids) AS carry
"""
MONTH_RANGE = "SELECT min(run_month), max(run_month) FROM ing.answer"
# 표면 정규형 길이 상한(바이트): ing.surface_seen PK·app.ecat_review UNIQUE 는 (엔티티, 정규형) btree 라 키 하나가 2,704 바이트를 넘으면
#   문장 전체가 실패한다(be/int3-prior: 적재기 _ig_prior_url 의 긴 URL 과 같은 결함 유형). 표면은 Scope 원천 문자열이라 길이 보장이 없다.
#   상한을 넘는 표면은 엔티티 이름 표기가 아니므로(원장·검토 대기함 모두) 건너뛴다. 정규형(NFKC 확장 뒤) 기준으로 잰다.
SURFACE_MAX_BYTES = 1000
# 기준선 한 달치: 서로 다른 원문 표면만 정규화해 원장에 더한다(같은 쌍이 여러 달이면 가장 이른 관측)
BASELINE_MONTH = f"""
INSERT INTO ing.surface_seen AS s (entity_id, surface_norm, first_seen_at, first_load_id)
SELECT y.entity_id, y.norm, min(y.fs), min(y.lid)
  FROM (SELECT x.entity_id, {_surface_norm_sql("x.raw")} AS norm, x.fs, x.lid
          FROM (SELECT m.entity_id, u.surface AS raw, min(a.first_seen_at) AS fs, min(a.load_id) AS lid
                  FROM ing.answer a
                  JOIN ing.mention m ON m.run_month = a.run_month AND m.job_id = a.job_id
                  CROSS JOIN LATERAL unnest(coalesce(m.surfaces, '{{}}'::text[])) AS u(surface)
                 WHERE a.run_month = $1::date AND m.run_month = $1::date AND a.load_id <= $2::bigint AND length(btrim(u.surface)) > 0
                 GROUP BY 1, 2) x) y
 WHERE octet_length(y.norm) <= {SURFACE_MAX_BYTES}
 GROUP BY 1, 2
ON CONFLICT (entity_id, surface_norm) DO UPDATE SET first_seen_at = least(s.first_seen_at, EXCLUDED.first_seen_at),
       first_load_id = least(s.first_load_id, EXCLUDED.first_load_id)
"""
# 새 엔티티 후보: 창 적재들이 시작한 뒤 처음 관측(first_seen ≥ 창 하한) ∧ 창 답변에 언급 ∧ 아직 어느 버전에도 분류 안 됨
NEW_ENTITY = """
SELECT d.entity_id, d.entity_type, d.rep_name, d.first_seen
  FROM rd.dim_entity d
 WHERE d.first_seen >= $1::timestamptz
   AND EXISTS (SELECT 1 FROM ing.mention m JOIN _rf_wa w ON w.run_month = m.run_month AND w.job_id = m.job_id WHERE m.entity_id = d.entity_id)
   AND NOT EXISTS (SELECT 1 FROM app.ecat_entity e WHERE e.entity_id = d.entity_id)
 ORDER BY d.first_seen
 LIMIT $2
"""
NEW_ENTITY_COUNTS = """
SELECT m.entity_id, count(*)::bigint AS n_mentions, count(DISTINCT (m.run_month, m.job_id))::bigint AS n_answers,
       min(a.load_id) AS first_load_id
  FROM ing.mention m JOIN ing.answer a ON a.run_month = m.run_month AND a.job_id = m.job_id
 WHERE m.entity_id = ANY($1::uuid[])
 GROUP BY m.entity_id
"""
# 판정 창의 (엔티티, 원문 표면) 집계 → 정규형 → 원장 대조(PK). 임시 표는 같은 트랜잭션의 후보 추출·원장 추가가 함께 쓴다
WINDOW_DROP = "DROP TABLE IF EXISTS _rf_w"
WINDOW_SURFACES = f"""
CREATE TEMP TABLE _rf_w ON COMMIT DROP AS
WITH w AS (
  SELECT m.entity_id, max(m.display_name) AS display_name, max(m.entity_type) AS entity_type, u.surface AS surface,
         count(*)::bigint AS n_mentions, count(DISTINCT (m.run_month, m.job_id))::bigint AS n_answers, min(a.load_id) AS first_load_id,
         min(a.first_seen_at) AS first_seen_at
    FROM _rf_wa a
    JOIN ing.mention m ON m.run_month = a.run_month AND m.job_id = a.job_id
    CROSS JOIN LATERAL unnest(coalesce(m.surfaces, '{{}}'::text[])) AS u(surface)
   WHERE length(btrim(u.surface)) > 0
   GROUP BY m.entity_id, u.surface)
SELECT v.* FROM (SELECT w.*, {_surface_norm_sql("w.surface")} AS norm FROM w) v
 WHERE octet_length(v.norm) <= {SURFACE_MAX_BYTES}                 -- 표면 정규형 길이 상한(SURFACE_MAX_BYTES)
"""
# 후보 = 원장에 없는 쌍(처음 관측) ∪ 이미 대기 중인 검토 행의 쌍(카운트 누적). 원장 대조는 창의 쌍마다 PK 조회(LATERAL … LIMIT 1 =
#   매개변수 색인 조회 고정: 원장이 커져도(100만 쌍대) 원장 전수 해시를 만들지 않는다. 비용 = 창 쌍 수 × PK 조회)
WINDOW_ANALYZE = "ANALYZE _rf_w"
WINDOW_CANDIDATES = """
SELECT w.entity_id, w.display_name, w.entity_type, w.surface, w.n_mentions, w.n_answers, w.first_load_id, w.norm
  FROM _rf_w w
  LEFT JOIN LATERAL (SELECT 1 AS hit FROM ing.surface_seen s WHERE s.entity_id = w.entity_id AND s.surface_norm = w.norm LIMIT 1) s ON true
 WHERE s.hit IS NULL
    OR EXISTS (SELECT 1 FROM app.ecat_review r WHERE r.kind = 'new_surface' AND r.status = 'pending' AND r.entity_id = w.entity_id
                                                 AND r.surface_norm = w.norm)
 ORDER BY w.n_mentions DESC, w.entity_id, w.surface
 LIMIT $1
"""
# 판정한 창의 쌍을 원장에 더한다. $1·$2 = 상한으로 잘려 다루지 못한 새 쌍(더하지 않는다)
WINDOW_TO_SEEN = """
INSERT INTO ing.surface_seen AS s (entity_id, surface_norm, first_seen_at, first_load_id)
SELECT w.entity_id, w.norm, min(w.first_seen_at), min(w.first_load_id) FROM _rf_w w
 WHERE (w.entity_id, w.norm) NOT IN (SELECT * FROM unnest($1::uuid[], $2::text[]))
 GROUP BY 1, 2
ON CONFLICT (entity_id, surface_norm) DO NOTHING
"""
# 허브가 이미 아는 표면(전역 차단 포함 여부는 무관, entity_id 한정만 본다): 있으면 검토 대기함에 올리지 않는다
KNOWN_SURFACE_DEF = """
SELECT entity_id, surface_norm FROM app.ecat_surface_def
 WHERE (entity_id, surface_norm) IN (SELECT * FROM unnest($1::uuid[], $2::text[]))
"""
REVIEW_UPSERT_ENTITY = """
INSERT INTO app.ecat_review (kind, entity_id, display_name, entity_type, first_load_id, n_mentions, n_answers)
VALUES ('new_entity', $1, $2, $3, $4, $5, $6)
ON CONFLICT (kind, entity_id, surface_norm) DO UPDATE
   SET n_mentions = app.ecat_review.n_mentions + EXCLUDED.n_mentions, n_answers = app.ecat_review.n_answers + EXCLUDED.n_answers,
       last_seen_at = now(), display_name = coalesce(app.ecat_review.display_name, EXCLUDED.display_name),
       entity_type = coalesce(app.ecat_review.entity_type, EXCLUDED.entity_type)
RETURNING review_id, alerted_at
"""
REVIEW_UPSERT_SURFACE = """
INSERT INTO app.ecat_review (kind, entity_id, surface, surface_norm, display_name, entity_type, first_load_id, n_mentions, n_answers)
VALUES ('new_surface', $1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (kind, entity_id, surface_norm) DO UPDATE
   SET n_mentions = app.ecat_review.n_mentions + EXCLUDED.n_mentions, n_answers = app.ecat_review.n_answers + EXCLUDED.n_answers,
       last_seen_at = now(), display_name = coalesce(app.ecat_review.display_name, EXCLUDED.display_name),
       entity_type = coalesce(app.ecat_review.entity_type, EXCLUDED.entity_type)
RETURNING review_id, alerted_at, n_mentions
"""
REVIEW_MARK_ALERTED = "UPDATE app.ecat_review SET alerted_at = $2, alert_grade = $3 WHERE review_id = ANY($1::bigint[])"


@dataclass
class SurfaceCandidate:
    entity_id: uuid.UUID
    surface_norm: str
    surface: str
    display_name: str | None
    entity_type: str | None
    n_mentions: int
    n_answers: int
    first_load_id: int


def merge_surface_candidates(rows: Sequence[Mapping[str, Any]]) -> list[SurfaceCandidate]:
    """순수 함수: 원문 표면을 normalize_surface 로 접어 합친다(두 원문이 같은 정규형이면 카운트를 더한다). 빈 정규형은 버린다."""
    merged: dict[tuple[uuid.UUID, str], SurfaceCandidate] = {}
    for r in rows:
        norm = normalize_surface(str(r["surface"]))
        if not norm:
            continue
        key = (r["entity_id"], norm)
        c = merged.get(key)
        if c is None:
            merged[key] = SurfaceCandidate(entity_id=r["entity_id"], surface_norm=norm, surface=str(r["surface"]),
                                           display_name=r.get("display_name"), entity_type=r.get("entity_type"),
                                           n_mentions=int(r["n_mentions"]), n_answers=int(r["n_answers"]),
                                           first_load_id=int(r["first_load_id"]))
        else:
            c.n_mentions += int(r["n_mentions"])
            c.n_answers += int(r["n_answers"])
            c.first_load_id = min(c.first_load_id, int(r["first_load_id"]))
    return list(merged.values())


def _ts(v: Any) -> str | None:
    return v.isoformat() if isinstance(v, dt.datetime) else None


async def _review_baseline(db: LoaderDB, conn: Any, now: dt.datetime, lookback_hours: int) -> dict[str, Any] | None:
    """원장 기준선(첫 가동, 재개 가능: 달마다 트랜잭션). 반환 = 이번 실행의 기준선 보고(None = 이미 끝남). 기준선이 창까지 덮었으면
    (창 앞 답변 없음) quiet = 참: 이번 실행은 큐·경보 없이 끝난다."""
    async with db.tx(conn, statement_timeout=REVIEW_TIMEOUT):
        await conn.execute(RF_STATE_INIT)
        st = await conn.fetchrow(RF_STATE)
        if st["baseline_done"]:
            return None
        to, lid = st["baseline_to"], st["judged_load_id"]
        if to is None or lid is None:
            start = now - dt.timedelta(hours=lookback_hours)
            wm = int(await conn.fetchval(LOAD_WATERMARK, now))
            hist = await conn.fetchval(BASELINE_LOAD, start, wm)
            to, lid = (start, int(hist)) if hist is not None else (now, wm)
            await conn.execute(RF_STATE_SET, None, to, None, False, lid)
        lo, hi = await conn.fetchrow(MONTH_RANGE)
        cursor = st["baseline_cursor"]
    months = 0
    if lo is not None:
        m = lo if cursor is None else (cursor.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
        while m <= hi:
            async with db.tx(conn, statement_timeout=REVIEW_TIMEOUT):
                await conn.fetchrow(RF_STATE)
                await conn.execute(BASELINE_MONTH, m, lid)
                await conn.execute("UPDATE ing.review_fill_state SET baseline_cursor = $1, updated_at = now() WHERE id", m)
            months += 1
            m = (m + dt.timedelta(days=32)).replace(day=1)
    async with db.tx(conn, statement_timeout=REVIEW_TIMEOUT):
        await conn.fetchrow(RF_STATE)
        await conn.execute(RF_STATE_SET, to, to, hi, True, lid)
        await conn.execute(CARRY_SET, await conn.fetchval(CARRY_SKIPPED, 0, lid))   # 기준선 경계 아래에서 아직 running 인 적재(N6)
        seen = int(await conn.fetchval("SELECT count(*) FROM ing.surface_seen"))
    return {"months": months, "baseline_to": _ts(to), "baseline_load_id": lid, "surfaces": seen, "quiet": to >= now}


async def _review_fill(db: LoaderDB, conn: Any, rep: WatchReport, now: dt.datetime, *, lookback_hours: int) -> Finding | None:
    """검토 대기함 채우기(새 엔티티·새 표면) + 자사·고볼륨 새 표면 드리프트 경보. 판정 불가는 None + rep.info 사유(경보 없음, 창 전진 없음)."""
    base: dict[str, Any] | None = None
    try:
        base = await _review_baseline(db, conn, now, lookback_hours)
        if base is not None and base["quiet"]:
            rep.info["review_fill"] = {"checked": True, "baseline": True, "new_entity": 0, "new_entity_saturated": False, "new_surface": 0,
                                       "new_surface_saturated": False, "alerted": 0}
            return None
        async with db.tx(conn, statement_timeout=REVIEW_TIMEOUT):
            st = await conn.fetchrow(RF_STATE)
            lo_id = int(st["judged_load_id"] or 0)
            hi_id = max(int(await conn.fetchval(LOAD_WATERMARK, now)), lo_id)
            stale = int(await conn.fetchval(STALE_RUNNING, now))
            carry = [int(x) for x in (st["carry_load_ids"] or [])]
            cst = {int(r["load_id"]): r for r in (await conn.fetch(CARRY_STATUS, carry) if carry else [])}
            done = [k for k in carry if k in cst and cst[k]["status"] == "committed"]
            keep = [k for k in carry if k in cst and cst[k]["status"] == "running"]                # failed·없음 = 지운다
            skipped = [int(x) for x in await conn.fetchval(CARRY_SKIPPED, lo_id, hi_id)] if hi_id > lo_id else []
            lo_ts = await conn.fetchval(WINDOW_LO, lo_id, hi_id) if hi_id > lo_id else None
            done_ts = min((cst[k]["started_at"] for k in done), default=None)
            lo_all = min((t for t in (lo_ts, done_ts) if t is not None), default=None)
            await conn.execute(WINDOW_ANS_DROP)
            await conn.execute(WINDOW_ANSWERS, lo_id, hi_id, lo_ts or now, done, done_ts or now)  # 빈 창이면 하한 = now(행 없음)
            ent_rows = [dict(r) for r in await conn.fetch(NEW_ENTITY, lo_all, REVIEW_ROW_LIMIT)] if lo_all else []
            ent_saturated = len(ent_rows) >= REVIEW_ROW_LIMIT
            ent_ids = [r["entity_id"] for r in ent_rows]
            ent_counts = {r["entity_id"]: dict(r) for r in (await conn.fetch(NEW_ENTITY_COUNTS, ent_ids) if ent_ids else [])}
            n_entity_queued = 0
            for r in ent_rows:
                cnt = ent_counts.get(r["entity_id"], {"n_mentions": 0, "n_answers": 0, "first_load_id": None})
                await conn.fetchrow(REVIEW_UPSERT_ENTITY, r["entity_id"], r.get("rep_name"), r.get("entity_type"),
                                    cnt["first_load_id"], cnt["n_mentions"], cnt["n_answers"])
                n_entity_queued += 1

            await conn.execute(WINDOW_DROP)
            await conn.execute(WINDOW_SURFACES)
            await conn.execute(WINDOW_ANALYZE)
            surf_raw = [dict(r) for r in await conn.fetch(WINDOW_CANDIDATES, REVIEW_ROW_LIMIT + 1)]
            surf_saturated = len(surf_raw) > REVIEW_ROW_LIMIT
            cut = surf_raw[REVIEW_ROW_LIMIT:]
            surf_raw = surf_raw[:REVIEW_ROW_LIMIT]
            candidates = merge_surface_candidates(surf_raw)
            if candidates:
                known = {(r["entity_id"], r["surface_norm"])
                         for r in await conn.fetch(KNOWN_SURFACE_DEF, [c.entity_id for c in candidates], [c.surface_norm for c in candidates])}
            else:
                known = set()
            own_ids = {r["entity_id"] for r in await conn.fetch(OWN_ENTITY_IDS)}
            to_alert: list[dict[str, Any]] = []
            n_surface_queued = 0
            for c in candidates:
                if (c.entity_id, c.surface_norm) in known:
                    continue
                row = await conn.fetchrow(REVIEW_UPSERT_SURFACE, c.entity_id, c.surface, c.surface_norm, c.display_name, c.entity_type,
                                          c.first_load_id, c.n_mentions, c.n_answers)
                n_surface_queued += 1
                is_own = c.entity_id in own_ids
                if row["alerted_at"] is None and (is_own or int(row["n_mentions"]) >= REVIEW_SURFACE_ALERT_MENTIONS):
                    to_alert.append({"review_id": int(row["review_id"]), "entity_id": str(c.entity_id), "surface": c.surface,
                                     "surface_norm": c.surface_norm, "display_name": c.display_name, "n_mentions": int(row["n_mentions"]),
                                     "own": is_own})
            if to_alert:
                await conn.execute(REVIEW_MARK_ALERTED, [a["review_id"] for a in to_alert], now, 1)
            # 창의 쌍을 원장에 더하고(상한으로 잘린 새 쌍은 빼고) 창을 전진: 여기까지 같은 트랜잭션(실패면 전부 롤백 = 다시 판정)
            await conn.execute(WINDOW_TO_SEEN, [r["entity_id"] for r in cut], [r["norm"] for r in cut])
            await conn.execute(RF_STATE_JUDGED, now, hi_id)
            await conn.execute(CARRY_SET, sorted(set(keep) | set(skipped)))
    except Exception as e:  # noqa: BLE001 (판정 불가: 알리지 않는다. 창은 전진하지 않는다)
        fail = None
        with contextlib.suppress(Exception):
            async with db.tx(conn, statement_timeout="10s"):
                fail = await conn.fetchrow(RF_STATE_FAIL, f"{type(e).__name__}: {str(e)[:300]}", now)
        rep.info["review_fill"] = {"checked": False, "reason": type(e).__name__, "error": str(e)[:300],
                                   "fail_count": int(fail["fail_count"]) if fail else None,
                                   "unjudged_from": _ts(fail["judged_to"]) if fail else None,
                                   "unjudged_from_load_id": fail["judged_load_id"] if fail else None,
                                   "carry": int(fail["carry"]) if fail else None, "baseline": base}
        log.warning("검토 대기함 채우기 판정 불가: %s", type(e).__name__)
        return None
    rep.info["review_fill"] = {"checked": True, "new_entity": n_entity_queued, "new_entity_saturated": ent_saturated,
                               "new_surface": n_surface_queued, "new_surface_saturated": surf_saturated, "alerted": len(to_alert)}
    if base is not None:
        rep.info["review_fill"]["baseline"] = base
    if stale:
        rep.info["review_fill"]["stale_running"] = stale          # 24시간 넘게 running 인 적재(워터마크를 묶지 않음)
    if skipped or keep or done:                                   # 이월(N6): 이번에 건너뛴 적재·남은 목록·커밋돼 판정한 적재
        rep.info["review_fill"].update({"carry_skipped": len(skipped), "carry": len(set(keep) | set(skipped)), "carry_judged": len(done)})
    if not to_alert:
        return None
    heads = " · ".join(f"{a['display_name'] or a['entity_id'][:8]} 표면 '{a['surface']}'"
                       f"{'(자사)' if a['own'] else ''} {a['n_mentions']}행" for a in to_alert[:5])
    msg = (f"검토 대기함 드리프트: 새 표면 {len(to_alert)}건 경보 대상(자사 또는 {REVIEW_SURFACE_ALERT_MENTIONS}행 이상). {heads}"
           f"{' 외' if len(to_alert) > 5 else ''}. 관리 화면 검토 대기함에서 반영·기각 결정")
    return Finding("review_fill", 1, "live", msg, {"alerted": to_alert})


async def watch(db: LoaderDB, *, now: dt.datetime | None = None, heartbeat_minutes: int = 60, alerts: AlertSink | None = None,
                checks: Sequence[str] | None = None, projection_gap_grace_hours: int = PROJECTION_GAP_GRACE_HOURS,
                fill_gaps: bool | None = None, system_actor: uuid.UUID | None = None) -> WatchReport:
    """checks·fill_gaps 가 None 이면 ingest 설정(HGH_WATCH_CHECKS·HGH_WATCH_FILL)."""
    s = get_ingest_settings()
    on = resolve_checks(s.watch_checks if checks is None else checks)
    fill = s.watch_fill if fill_gaps is None else fill_gaps
    now = now or dt.datetime.now(dt.UTC)
    alerts = alerts or get_alert_sink()
    rep = WatchReport(sink=sink_label(alerts))
    async with db.session() as conn:
        if "heartbeat" in on:
            hb = await conn.fetchval(HEARTBEAT)
            rep.checked.append("heartbeat")
            if hb is None or hb < now - dt.timedelta(minutes=heartbeat_minutes):
                rep.findings.append(Finding("heartbeat", 2, "live", f"pull 워커 하트비트 지연: 마지막 시도 {hb}", {"last_attempt_at": str(hb)}))
        if "ingest_backlog" in on:
            b = await conn.fetchrow(BACKLOG, now)
            rep.checked.append("ingest_backlog")
            if b and (b["blocked"] or b["unresolved"] or b["pending"]):
                rep.findings.append(Finding("ingest_backlog", 2 if b["blocked"] else 1, "live",
                                            f"적재 적체: blocked {b['blocked']} · 미해소 {b['unresolved']} · 분석 대기 {b['pending']}", dict(b)))
        if "view_lag" in on:
            rep.checked.append("view_lag")
            for r in await conn.fetch(VIEW_LAG, now):
                rep.findings.append(Finding("view_lag", 2 if r["cycles"] >= 2 else 1, "live",
                                            f"노출 지체 {r['surface']}: {r['cycles']}회차(가장 오래된 앵커 {r['oldest']})", dict(r)))
        if "publish_backlog" in on:
            n = await conn.fetchval(PUBLISH_BACKLOG, now)
            rep.checked.append("publish_backlog")
            if n:
                rep.findings.append(Finding("publish_backlog", 1, "code", f"발행 판정 대기 회차 {n}(6시간 초과)", {"cycles": n}))
        if "load_failures" in on:
            n = await conn.fetchval(LOAD_FAILURES, now)
            rep.checked.append("load_failures")
            if n and n >= 3:
                rep.findings.append(Finding("load_failures", 1, "code", f"최근 6시간 실패 적재 {n}건", {"failed": n}))
        if "queue" in on:
            qrow = await conn.fetchrow(QUEUE, now)
            rep.checked.append("queue")
            if qrow and qrow["bad"]:
                rep.findings.append(Finding("queue", 1, "code", f"판정 입력 큐 실패·이관 {qrow['bad']}건(최근 6시간)", {"bad": qrow["bad"]}))
            if qrow and qrow["stale"]:
                rep.findings.append(Finding("queue", 1, "live", f"판정 입력 큐 장기 대기·실행 임대 만료 {qrow['stale']}건", {"stale": qrow["stale"]}))
        if "projection_gap" in on:
            rep.checked.append("projection_gap")
            gap = await _projection_gap(db, conn, rep, now, grace_hours=projection_gap_grace_hours, fill=fill,
                                        system_actor=system_actor or s.system_actor)
            if gap is not None:
                rep.findings.append(gap)
        if "publish_gate" in on:
            rep.checked.append("publish_gate")
            pg = await _publish_gate(db, conn, rep, now)
            if pg is not None:
                rep.findings.append(pg)
        if "review_fill" in on:
            rep.checked.append("review_fill")
            rf = await _review_fill(db, conn, rep, now, lookback_hours=REVIEW_LOOKBACK_HOURS)
            if rf is not None:
                rep.findings.append(rf)
    for f in rep.findings:
        with contextlib.suppress(Exception):     # 전송 실패는 감시를 막지 않는다
            await alerts.send(f.sink, f"[{f.check}/{f.severity}] {f.message}", f.detail, severity=f.severity)  # type: ignore[arg-type]
    return rep
