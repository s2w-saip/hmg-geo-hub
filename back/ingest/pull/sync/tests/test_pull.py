"""IG-1 pull 패스(가짜 Scope 원천 주입). 커밋하는 경로라 일회 DB(fresh_db: 이 빌더 복제본의 사본)에서 돈다.

기대값: 행 수·상태는 가짜 원천 입력의 손계산, rd 투영은 같은 DB 상태로 bulk 시드를 돌린 결과와의 행 단위 동치(ingest.testkit.bulk_equivalence).
증분 쪽은 loader 롤(SET ROLE loader)로 돌린다.
"""
from __future__ import annotations

import datetime as dt
import json

import asyncpg

from ingest.common.alerts import MemoryAlertSink
from ingest.common.config import IngestSettings
from ingest.common.db import LoaderDB
from ingest.pull.sync.service import run_pass
from ingest.pull.sync.source import FakeScopeSource
from ingest.testkit import bulk_equivalence, make_job, mention
from tests.support import needs_db

ROOT = "a0000000-0000-4000-8000-000000000001"
SP1 = "b0000000-0000-4000-8000-000000000001"
SP3 = "b0000000-0000-4000-8000-000000000003"
SP8 = "b0000000-0000-4000-8000-000000000008"
R10 = "e0000000-0000-4000-8000-000000000010"
HY = "00000000-0000-0000-0000-000000000301"
TOY = "71000000-0000-4000-8000-000000000001"
PR10 = "aa000000-0000-4000-8000-000000000010"
NOW = dt.datetime(2026, 9, 28, 6, 0, tzinfo=dt.UTC)
FIXTURE_RUNS = [  # 원장에 이미 있는 run(상태·총수 동일 → R12 건너뜀)
    {"measurement_run_id": "e0000000-0000-4000-8000-000000000001", "status": "completed", "total_jobs": 14,
     "started_at": "2026-09-14T00:30:00Z", "cycle_anchor_at": "2026-09-14T00:30:00Z"},
    {"measurement_run_id": "e0000000-0000-4000-8000-000000000003", "status": "completed", "total_jobs": 1,
     "started_at": "2026-09-07T00:30:00Z", "cycle_anchor_at": "2026-09-07T00:30:00Z"},
]


def _j(n: int) -> str:
    return f"9a000000-0000-4000-8000-{n:012d}"


def _acr(prompt_run: str) -> dict:
    return {"prompt_run_id": prompt_run, "rows": [
        {"rollupLevel": "brand", "entityId": HY, "plannedIterations": 2, "validTurn1Iterations": 2, "validAcrIterations": 1,
         "appearanceCount": 1, "choiceCount": 1, "conditionalChoiceCount": 0, "appearanceRate": 0.5, "acr": 1.0, "overallChoiceShare": 0.5,
         "offShortlistChoiceCount": 0, "unresolvedChoiceCount": 0, "genericChoiceCount": 0, "choiceOutcomeBreakdown": {"single_entity": 1}}]}


def _source(*, j102_pending: bool = False) -> FakeScopeSource:
    j101 = make_job(_j(101), SP1, "chatgpt", "US", measured_at="2026-09-28T01:00:00Z",
                    mentions=[mention(HY, "Hyundai", pos=1, avg=1.0), mention(TOY, "Toyota", avg=2.0)],
                    citations=[{"url": "https://www.hyundai.com/us/en/suv", "title": "t"}, {"url": "https://www.reddit.com/r/cars"}],
                    stances=[{"turn_index": 0, "entity_id": HY, "brand_label": "Hyundai", "stance": "positive"}])
    j102 = make_job(_j(102), SP1, "gemini", "US", measured_at="2026-09-28T01:10:00Z", with_result=False,
                    analysis_status="pending" if j102_pending else "completed",
                    mentions=[] if j102_pending else [mention(HY, "Hyundai", neg=1, avg=1.0)])
    j103 = make_job(_j(103), SP1, "deepseek", "US", status="failed", analysis_status=None)
    j104 = make_job(_j(104), SP3, "chatgpt", "US", measured_at="2026-09-28T02:00:00Z", mentions=[mention(HY, "Hyundai")], acr=_acr(PR10))
    j105 = make_job(_j(105), SP3, "chatgpt", "US", measured_at="2026-09-28T02:05:00Z", mentions=[], acr=_acr(PR10))
    return FakeScopeSource(
        projects={ROOT: {"project_id": ROOT, "regions": ["US", "KR"]}},
        prompts={ROOT: [{"prompt_id": SP1, "text": "best suv", "lang": "EN", "kind": "single", "updated_at": "2026-09-01T00:00:00Z"},
                        {"prompt_id": SP8, "text": "brand new", "lang": "EN", "kind": "single", "updated_at": "2026-09-27T00:00:00Z"}]},
        runs={ROOT: [*FIXTURE_RUNS, {"measurement_run_id": R10, "status": "completed", "total_jobs": 5, "targets": ["chatgpt", "gemini"],
                                      "regions": ["US"], "started_at": "2026-09-28T00:30:00Z", "completed_at": "2026-09-28T02:10:00Z",
                                      "cycle_anchor_at": "2026-09-28T00:30:00Z", "trigger": "schedule"}]},
        jobs={R10: [j101, j102, j103, j104, j105]},
        query_runs={_j(102): {"job_id": _j(102), "status": "completed",
                              "result": {"answer_text": "fb", "citations": [{"url": "https://kia.com/x"}], "model_slug": "g"}}},
        page_size=2)


async def _rows(url: str, sql: str, *args):
    c = await asyncpg.connect(url)
    try:
        return await c.fetch(sql, *args)
    finally:
        await c.close()


def _settings(**kw) -> IngestSettings:
    return IngestSettings(**kw)


@needs_db
async def test_pull_pass_end_to_end_equals_bulk(fresh_db):
    src = _source()
    db = LoaderDB(fresh_db, role="loader")
    rep = await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert rep.error is None
    assert [r.status for r in rep.runs] == ["committed"]                # 원장 run 2개는 R12 로 건너뜀, 새 run 1개만
    assert rep.skipped_runs == 2
    out = rep.runs[0]
    assert (out.jobs_fetched, out.jobs_changed, out.jobs_removed) == (5, 5, 0)
    assert src.count("get_query_run", _j(102)) == 1                     # 본문 누락 job 보충
    assert src.count("list_run_jobs") == 3                             # 5 job / 페이지 2
    # ing 원본(손계산): 답변 5·언급 4(j101 2·j102 1·j104 1)·인용 3(j101 2·j102 1)·스탠스 1·ACR prompt-run 1(반복 job 2)
    n = (await _rows(fresh_db, """SELECT (SELECT count(*) FROM ing.answer WHERE run_id = $1) a,
        (SELECT count(*) FROM ing.mention m JOIN ing.answer x ON x.job_id = m.job_id WHERE x.run_id = $1) m,
        (SELECT count(*) FROM ing.citation m JOIN ing.answer x ON x.job_id = m.job_id WHERE x.run_id = $1) c,
        (SELECT count(*) FROM ing.answer_stance m JOIN ing.answer x ON x.job_id = m.job_id WHERE x.run_id = $1) s,
        (SELECT cardinality(source_job_ids) FROM ing.acr_prompt_run WHERE prompt_run_id = $2) pr""", R10, PR10))[0]
    assert tuple(n) == (5, 4, 3, 1, 2)
    run = (await _rows(fresh_db, "SELECT * FROM ing.run WHERE run_id = $1", R10))[0]
    assert run["sync_state"] == "loaded" and run["seen_jobs"] == 5 and run["completed_jobs"] == 4
    assert run["unresolved_jobs"] == 0 and run["analysis_pending"] == 0 and run["run_month"] == dt.date(2026, 9, 1)
    # 회차: (루트, 09-28 00:30) 새 회차, 월요일 = 정규 좌석
    cyc = (await _rows(fresh_db, """SELECT c.anchor_source, c.anchor_date, c.round_date, cr.attributed_by, s.basis
                                      FROM ing.cycle c JOIN ing.cycle_run cr ON cr.cycle_id = c.cycle_id
                                      JOIN ing.cycle_round s ON s.scope_project_id = c.scope_project_id AND s.anchor_date = c.anchor_date
                                     WHERE cr.run_id = $1""", R10))[0]
    assert tuple(cyc) == ("scope", dt.date(2026, 9, 28), dt.date(2026, 9, 28), "scope", "canonical")
    # rd: job 5·서빙 4, 적재 원장 committed + 카운터
    rd = (await _rows(fresh_db, """SELECT count(*) jobs, count(*) FILTER (WHERE served) served FROM rd.job j
                                     JOIN rd.dim_project d ON d.project_key = j.project_key WHERE j.run_key = (SELECT run_key FROM ing.run WHERE run_id = $1)""", R10))[0]
    assert (rd["jobs"], rd["served"]) == (5, 4)
    ld = (await _rows(fresh_db, "SELECT * FROM ing.load WHERE load_id = $1", out.load_id))[0]
    assert ld["status"] == "committed" and ld["kind"] == "run" and ld["jobs_fetched"] == 5 and ld["rd_answers_upserted"] == 4
    assert ld["rd_children_rows"] > 0
    assert (await _rows(fresh_db, "SELECT count(*) FROM ing.stage_answer WHERE load_id = $1", out.load_id))[0][0] == 0
    # 새 프롬프트 SP8 은 판정 재투영 경로로 dim_prompt 에 들어간다(bulk 과 같은 차원)
    assert (await _rows(fresh_db, "SELECT count(*) FROM rd.dim_prompt WHERE prompt_id = $1", SP8))[0][0] == 1
    reg = await _rows(fresh_db, f"SELECT regions FROM rd.dim_project WHERE scope_project_id = '{ROOT}'")
    assert reg[0][0] == ["US", "KR"]
    strict, referenced = await bulk_equivalence(fresh_db)
    assert not strict, strict
    assert not referenced, referenced


@needs_db
async def test_second_pass_skips_settled_run_and_writes_nothing(fresh_db):
    src = _source()
    db = LoaderDB(fresh_db, role="loader")
    await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    before = await _rows(fresh_db, "SELECT count(*), max(load_id) FROM ing.load")
    gen = await _rows(fresh_db, "SELECT surface, generation FROM rd.surface_generation ORDER BY 1")
    rep = await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert rep.runs == [] and rep.skipped_runs == 3 and rep.prompts_changed == 0
    assert await _rows(fresh_db, "SELECT count(*), max(load_id) FROM ing.load") == before
    assert await _rows(fresh_db, "SELECT surface, generation FROM rd.surface_generation ORDER BY 1") == gen
    # force 재pull: R12 를 건너뛰고 전량 다시 당기지만 해시가 같아 원본·투영 쓰기 0(DN-7).
    #   첫 force 는 원장 이관 회차(10·11)의 완료 답변 카운터를 소속 run 답변으로 다시 세어(seed-20 §7-6 규칙) rd.cycle 이 바뀔 수 있다.
    rep = await run_pass(db, src, project=ROOT, now=NOW, force=True, settings=_settings())
    assert [(r.status, r.jobs_changed) for r in rep.runs if str(r.run_id) == R10] == [("committed", 0)]
    gen = await _rows(fresh_db, "SELECT surface, generation FROM rd.surface_generation ORDER BY 1")
    rep = await run_pass(db, src, project=ROOT, now=NOW, force=True, settings=_settings())
    assert all(r.status == "committed" and r.jobs_changed == 0 for r in rep.runs) and len(rep.runs) == 3
    assert await _rows(fresh_db, "SELECT surface, generation FROM rd.surface_generation ORDER BY 1") == gen   # 바뀐 rd 없음 → 세대 불변


@needs_db
async def test_recheck_picks_up_late_analysis(fresh_db):
    """R12: 분석이 늦게 붙은 완료 job(현행 결함 #1) → 재확인 창 안에서 다시 당겨 반영."""
    db = LoaderDB(fresh_db, role="loader")
    rep = await run_pass(db, _source(j102_pending=True), project=ROOT, now=NOW, settings=_settings())
    assert rep.runs[0].status == "committed"
    run = (await _rows(fresh_db, "SELECT analysis_pending, recheck_until, analysis_recheck_until FROM ing.run WHERE run_id = $1", R10))[0]
    assert run["analysis_pending"] == 1 and run["analysis_recheck_until"] > NOW
    gap = await _rows(fresh_db, "SELECT j.analysis_code FROM rd.job j JOIN ing.answer_key_map k ON k.answer_key = j.answer_key WHERE k.job_id = $1", _j(102))
    assert gap[0][0] == 2                                              # 분석 미도착 = 결손(A16)
    rep = await run_pass(db, _source(), project=ROOT, now=NOW + dt.timedelta(hours=1), settings=_settings())
    assert [(r.status, r.jobs_changed) for r in rep.runs] == [("committed", 1)]
    gap = await _rows(fresh_db, "SELECT j.analysis_code FROM rd.job j JOIN ing.answer_key_map k ON k.answer_key = j.answer_key WHERE k.job_id = $1", _j(102))
    assert gap[0][0] == 0
    strict, referenced = await bulk_equivalence(fresh_db)
    assert not strict and not referenced, (strict, referenced)


@needs_db
async def test_interrupted_stage_resumes_from_cursor(fresh_db):
    """수신 중단(2번째 페이지 503) → run 은 staging·stage_cursor 보존 → 다음 패스가 그 페이지부터 이어받아 완료."""
    src = _source()
    src.fail_on[("list_run_jobs", R10, 1)] = 1
    db = LoaderDB(fresh_db, role="loader")
    rep = await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert rep.runs[0].status == "failed"
    run = (await _rows(fresh_db, "SELECT sync_state, stage_cursor, attempts, last_load_id FROM ing.run WHERE run_id = $1", R10))[0]
    assert run["sync_state"] == "staging" and '"cursor": "2"' in run["stage_cursor"] and run["attempts"] == 1
    assert (await _rows(fresh_db, "SELECT count(*) FROM rd.job j JOIN ing.answer_key_map k ON k.answer_key = j.answer_key WHERE k.job_id = $1",
                        _j(101)))[0][0] == 0                             # 부분 run 은 rd 에 보이지 않는다(DN-9)
    src.calls.clear()
    rep = await run_pass(db, src, project=ROOT, now=NOW + dt.timedelta(hours=2), settings=_settings())
    assert [r.status for r in rep.runs] == ["committed"]
    pages = [c[2] for c in src.calls if c[0] == "list_run_jobs"]
    assert pages[0] == "2"                                             # 처음부터가 아니라 중단 지점부터
    assert rep.runs[0].jobs_fetched == 5
    strict, referenced = await bulk_equivalence(fresh_db)
    assert not strict and not referenced, (strict, referenced)


@needs_db
async def test_load_failure_rolls_back_and_blocks_after_max_attempts(fresh_db):
    """적재 트랜잭션 실패(앵커·측정·시작 시각이 모두 없는 run: 회차를 정할 수 없음) → 롤백·load failed·스테이지 삭제·blocked + 경보."""
    src = _source()
    bad = "e0000000-0000-4000-8000-000000000011"
    src.runs[ROOT] = [{"measurement_run_id": bad, "status": "completed", "total_jobs": 1, "started_at": None, "cycle_anchor_at": None}]
    src.jobs[bad] = [make_job(_j(111), SP1, "chatgpt", "US", status="queued", analysis_status=None, measured_at=None)]
    alerts = MemoryAlertSink()
    db = LoaderDB(fresh_db, role="loader")
    rep = await run_pass(db, src, project=ROOT, now=NOW, settings=_settings(max_attempts=1), alerts=alerts)
    assert rep.runs[0].status == "failed" and "회차를 정할 수 없다" in rep.runs[0].error
    ld = (await _rows(fresh_db, "SELECT status, error FROM ing.load WHERE load_id = $1", rep.runs[0].load_id))[0]
    assert ld["status"] == "failed" and ld["error"]
    run = (await _rows(fresh_db, "SELECT sync_state, attempts FROM ing.run WHERE run_id = $1", bad))[0]
    assert (run["sync_state"], run["attempts"]) == ("blocked", 1)
    assert (await _rows(fresh_db, "SELECT count(*) FROM ing.answer_key_map WHERE job_id = $1", _j(111)))[0][0] == 0   # 롤백
    assert (await _rows(fresh_db, "SELECT count(*) FROM ing.stage_answer WHERE load_id = $1", rep.runs[0].load_id))[0][0] == 0
    assert alerts.sent and alerts.sent[0][0] == "live"
    cur = (await _rows(fresh_db, "SELECT last_error FROM ing.sync_cursor WHERE scope_project_id = $1", ROOT))[0]
    assert cur["last_error"]


@needs_db
async def test_scope_prompt_change_rejudges_without_queue(fresh_db):
    """Scope 쪽 프롬프트 시장 변경(SP6 regions {US} → {DE}) → 프롬프트 증분이 rejudge('scope_prompt') 를 직접 불러 답변 5(DE)가 모수로 들어온다.
    loader 는 큐를 거치지 않고, 감사는 ing.load kind 'judgment'·scope_ref.source 'scope_prompt'."""
    sp6 = "b0000000-0000-4000-8000-000000000006"
    src = _source()
    src.runs[ROOT] = list(FIXTURE_RUNS)
    src.prompts[ROOT] = [{"prompt_id": sp6, "text": "us only", "lang": "EN", "kind": "single", "regions": ["DE"],
                          "updated_at": "2026-09-27T00:00:00Z"}]
    before = await _rows(fresh_db, """SELECT a.elig FROM rd.answer a JOIN rd.job j ON j.surface = a.surface AND j.round_date = a.round_date
                                      AND j.answer_key = a.answer_key WHERE j.job_id = '90000000-0000-4000-8000-000000000005'""")
    assert before[0][0] is False
    rep = await run_pass(LoaderDB(fresh_db, role="loader"), src, project=ROOT, now=NOW, settings=_settings())
    assert rep.prompts_changed == 1 and rep.runs == []
    after = await _rows(fresh_db, """SELECT a.elig FROM rd.answer a JOIN rd.job j ON j.surface = a.surface AND j.round_date = a.round_date
                                     AND j.answer_key = a.answer_key WHERE j.job_id = '90000000-0000-4000-8000-000000000005'""")
    assert after[0][0] is True
    ld = await _rows(fresh_db, "SELECT kind, status, scope_ref->>'source' FROM ing.load ORDER BY load_id DESC LIMIT 1")
    assert tuple(ld[0]) == ("judgment", "committed", "scope_prompt")
    assert (await _rows(fresh_db, "SELECT count(*) FROM app.judgment_change WHERE kind = 'scope_prompt'"))[0][0] == 0
    strict, referenced = await bulk_equivalence(fresh_db)
    assert not strict and not referenced, (strict, referenced)


@needs_db
async def test_scope_prompt_enabled_is_pulled_without_rejudge(fresh_db):
    """Scope 프롬프트 응답의 enabled(코어 prompts.enabled, DB-v2.14 P84 제품 결정 21) → ing.prompt.enabled. 판정 입력이 아니라 재판정 없음.
    응답에 enabled 가 없으면 기존 값을 지우지 않는다(NULL = 모름). 발행 게이트 활성 유닛(ing.active_units)에서 꺼진 프롬프트가 빠진다."""
    sp6 = "b0000000-0000-4000-8000-000000000006"
    src = _source()
    src.runs[ROOT] = list(FIXTURE_RUNS)
    base = {"prompt_id": sp6, "text": "us only", "lang": "EN", "kind": "single", "regions": ["US"]}
    db = LoaderDB(fresh_db, role="loader")
    assert (await _rows(fresh_db, "SELECT enabled FROM ing.prompt WHERE scope_prompt_id = $1", sp6))[0][0] is None
    units = "SELECT count(*) FROM ing.active_units($1) WHERE prompt_id = $2"
    assert (await _rows(fresh_db, units, ROOT, sp6))[0][0] == 2                      # NULL = 활성 취급(기본 엔진 2 × US)
    src.prompts[ROOT] = [{**base, "enabled": False, "updated_at": "2026-09-27T00:00:00Z"}]
    rep = await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert rep.error is None and rep.prompts_changed == 0                             # enabled 는 판정 입력이 아니다
    assert (await _rows(fresh_db, "SELECT enabled FROM ing.prompt WHERE scope_prompt_id = $1", sp6))[0][0] is False
    assert (await _rows(fresh_db, units, ROOT, sp6))[0][0] == 0
    src.prompts[ROOT] = [{**base, "text": "us only!", "updated_at": "2026-09-27T01:00:00Z"}]      # enabled 키 없음
    await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert tuple((await _rows(fresh_db, "SELECT text, enabled FROM ing.prompt WHERE scope_prompt_id = $1", sp6))[0]) == ("us only!", False)
    src.prompts[ROOT] = [{**base, "enabled": True, "updated_at": "2026-09-27T02:00:00Z"}]
    await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert (await _rows(fresh_db, "SELECT enabled FROM ing.prompt WHERE scope_prompt_id = $1", sp6))[0][0] is True
    assert (await _rows(fresh_db, units, ROOT, sp6))[0][0] == 2


@needs_db
async def test_transient_failures_retry_after_backoff(fresh_db, monkeypatch):
    """① 첫 페이지부터 수신 실패 → 이어받을 스테이지가 없어 load 는 failed 로 닫히고 run 은 deferred(백오프).
    ② 적재 트랜잭션의 일시 오류 → 롤백·deferred → 백오프 시각 뒤 다음 패스가 재시도해 committed(새 run 이 영영 건너뛰어지지 않는다)."""
    from ingest.cycles.ledger import service as ledger_service
    db = LoaderDB(fresh_db, role="loader")
    src = _source()
    src.fail_on[("list_run_jobs", R10, 0)] = 1
    rep = await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert rep.runs[0].status == "failed"
    ld = (await _rows(fresh_db, "SELECT status FROM ing.load WHERE load_id = $1", rep.runs[0].load_id))[0]
    run = (await _rows(fresh_db, "SELECT sync_state, attempts, next_attempt_at FROM ing.run WHERE run_id = $1", R10))[0]
    assert ld["status"] == "failed" and run["sync_state"] == "deferred" and run["attempts"] == 1
    # 백오프 전 패스는 건너뛴다
    rep = await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert rep.runs == []
    real = ledger_service.attribute
    calls = {"n": 0}

    async def flaky(conn, ctx, run_ids):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("일시 오류")
        return await real(conn, ctx, run_ids)

    monkeypatch.setattr(ledger_service, "attribute", flaky)
    later = run["next_attempt_at"] + dt.timedelta(minutes=1)
    rep = await run_pass(db, src, project=ROOT, now=later, settings=_settings())
    assert rep.runs[0].status == "failed" and "일시 오류" in rep.runs[0].error
    assert (await _rows(fresh_db, "SELECT count(*) FROM rd.job j JOIN ing.answer_key_map k ON k.answer_key = j.answer_key WHERE k.job_id = $1",
                        _j(101)))[0][0] == 0                                          # 롤백: 부분 반영 없음
    run = (await _rows(fresh_db, "SELECT sync_state, attempts, next_attempt_at FROM ing.run WHERE run_id = $1", R10))[0]
    assert run["sync_state"] == "deferred" and run["attempts"] == 2
    rep = await run_pass(db, src, project=ROOT, now=run["next_attempt_at"] + dt.timedelta(minutes=1), settings=_settings())
    assert [r.status for r in rep.runs] == ["committed"]
    assert (await _rows(fresh_db, "SELECT count(*) FROM ing.load WHERE status = 'running'"))[0][0] == 0      # 고아 running load 없음
    strict, referenced = await bulk_equivalence(fresh_db)
    assert not strict and not referenced, (strict, referenced)


@needs_db
async def test_registers_new_app_project_cursor_and_dims(fresh_db):
    """app 에 Scope 프로젝트가 생기면(아웃박스 되쓰기 등) 다음 패스가 커서·rd.dim_project·app 유래 국가 차원을 만든다(bulk 과 같은 차원)."""
    new_scope = "a0000000-0000-4000-8000-0000000000aa"
    c = await asyncpg.connect(fresh_db)
    try:
        await c.execute("SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', false)")
        await c.execute(f"""INSERT INTO app.project (project_id, kind, name, brand_code, country_code, scope_project_id, created_by)
                            VALUES (gen_random_uuid(), 'customer', 'n', 'Kia', 'NZ', '{new_scope}', '5eed0000-0000-4000-8000-000000000001')""")
    finally:
        await c.close()
    src = _source()
    src.runs[ROOT] = list(FIXTURE_RUNS)
    rep = await run_pass(LoaderDB(fresh_db, role="loader"), src, project=ROOT, now=NOW, settings=_settings())
    assert rep.registered == 1
    cur = await _rows(fresh_db, "SELECT surface FROM ing.sync_cursor WHERE scope_project_id = $1", new_scope)
    dp = await _rows(fresh_db, "SELECT surface, is_root FROM rd.dim_project WHERE scope_project_id = $1", new_scope)
    assert cur[0][0] == "project" and tuple(dp[0]) == (3, False)
    assert (await _rows(fresh_db, "SELECT kind FROM rd.dim_country WHERE code = 'NZ'"))[0][0] == "iso"
    strict, referenced = await bulk_equivalence(fresh_db)
    assert not strict and not referenced, (strict, referenced)


class _Crash(BaseException):
    """프로세스 사망 흉내(except Exception 을 지나친다)."""


@needs_db
async def test_crash_after_observing_run_does_not_skip_new_jobs(fresh_db, monkeypatch):
    """결함 D3: 정착한 loaded run 에 Scope 가 job 을 더 붙였다(총수 5 → 7). 수신 전에 프로세스가 죽으면 다음 패스가 그 run 을 건너뛰면 안 된다.
    Scope 관측 상태(상태·총수·완료 시각·앵커)는 적재 트랜잭션에서만 기록되므로 죽은 뒤에도 원장은 옛 총수 → R12 가 다시 고른다."""
    from ingest.pull.sync import service as sync_service
    db = LoaderDB(fresh_db, role="loader")
    rep = await run_pass(db, _source(), project=ROOT, now=NOW, settings=_settings())
    assert [r.status for r in rep.runs] == ["committed"]
    src = _source()
    run10 = next(r for r in src.runs[ROOT] if r["measurement_run_id"] == R10)
    run10["total_jobs"] = 7
    src.jobs[R10] += [make_job(_j(106), SP1, "chatgpt", "KR", measured_at="2026-09-28T02:20:00Z", mentions=[mention(HY, "Hyundai")]),
                      make_job(_j(107), SP1, "gemini", "KR", measured_at="2026-09-28T02:25:00Z", mentions=[])]
    later = NOW + dt.timedelta(days=30)                                 # 재확인 창도 닫혔다(정착 + 창 닫힘 = 총수 동일이면 건너뛸 run)

    async def crash(*a, **kw):
        raise _Crash()

    monkeypatch.setattr(sync_service, "_stage_run", crash)
    try:
        await run_pass(db, src, project=ROOT, now=later, settings=_settings())
        raise AssertionError("crash 가 전파돼야 한다")
    except _Crash:
        pass
    monkeypatch.undo()
    run = (await _rows(fresh_db, "SELECT total_jobs, sync_state FROM ing.run WHERE run_id = $1", R10))[0]
    assert run["total_jobs"] == 5                                      # 관측 상태가 적재 전에 커밋되지 않았다
    rep = await run_pass(db, src, project=ROOT, now=later, settings=_settings())
    assert [(str(r.run_id), r.status, r.jobs_fetched, r.jobs_changed) for r in rep.runs] == [(R10, "committed", 7, 2)]
    run = (await _rows(fresh_db, "SELECT total_jobs, sync_state FROM ing.run WHERE run_id = $1", R10))[0]
    assert (run["total_jobs"], run["sync_state"]) == (7, "loaded")
    assert (await _rows(fresh_db, "SELECT count(*) FROM ing.answer WHERE run_id = $1", R10))[0][0] == 7
    strict, referenced = await bulk_equivalence(fresh_db)
    assert not strict and not referenced, (strict, referenced)


@needs_db
async def test_repull_that_drops_children_equals_bulk(fresh_db):
    """결함 D2·D6(적재기 경로): 재분석으로 j101 의 언급(Toyota)·인용(reddit)이 빠진 재pull → 줄어든 방향의 전역 판정(URL·대표 표기·엔티티 차원)이
    bulk 와 같고, 인용이 0 이 된 URL 의 dim_url 행이 남지 않는다."""
    only = "https://only.drop-example.net/a"                          # j101 만 인용하는 URL
    db = LoaderDB(fresh_db, role="loader")
    src = _source()
    next(j for j in src.jobs[R10] if j["job_id"] == _j(101))["result"]["citations"].append({"url": only, "title": "x"})
    await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert (await _rows(fresh_db, "SELECT count(*) FROM rd.dim_url WHERE url = $1", only))[0][0] == 1
    src = _source()
    j101 = next(j for j in src.jobs[R10] if j["job_id"] == _j(101))
    j101["analysis"]["resolved_mentions"] = [m for m in j101["analysis"]["resolved_mentions"] if m["entity_id"] != TOY]
    rep = await run_pass(db, src, project=ROOT, now=NOW, force=True, settings=_settings())
    assert [(r.status, r.jobs_changed) for r in rep.runs if str(r.run_id) == R10] == [("committed", 1)]
    gone = await _rows(fresh_db, "SELECT count(*) FROM rd.dim_url WHERE url = $1", only)
    cited = await _rows(fresh_db, "SELECT count(*) FROM ing.citation WHERE url = $1", only)
    assert (gone[0][0], cited[0][0]) == (0, 0)
    strict, referenced = await bulk_equivalence(fresh_db)
    assert not strict and not referenced, (strict, referenced)


XR = "71000000-0000-4000-8000-00000000abcd"                           # ACR 롤업에만 나오는 엔티티(언급·스탠스 없음)


def _with_rollup_only_entity(src: FakeScopeSource) -> FakeScopeSource:
    """j104 의 acr_summary.rows 에 롤업 전용 엔티티 XR 행을 덧붙인다(그 job 의 언급·스탠스에는 없다)."""
    j104 = next(j for j in src.jobs[R10] if j["job_id"] == _j(104))
    j104["analysis"]["acr_summary"]["rows"].append(
        {"rollupLevel": "brand", "entityId": XR, "appearanceCount": 1, "choiceCount": 0, "conditionalChoiceCount": 0, "appearanceRate": 0.5,
         "acr": 0.0, "overallChoiceShare": 0.0, "offShortlistChoiceCount": 0, "unresolvedChoiceCount": 0, "genericChoiceCount": 0})
    return src


@needs_db
async def test_repull_drops_acr_rollup_only_entity_equals_bulk(fresh_db):
    """결함 N1: 1차(총수 4, j105 없음) = PR10 의 롤업을 j104 가 정하고 롤업 전용 엔티티 XR 이 들어간다. 2차(총수 5, j105 추가, j104 불변) =
    가장 늦은 측정 job 인 j105 의 롤업으로 PR10 을 다시 쓰며 XR 이 빠진다. 바뀐 job(j105)은 PR10 의 옛 source_job_ids({j104})에 없지만
    _write_acr 가 다시 쓰는 prompt-run 이므로 옛 롤업 엔티티를 스냅샷해 dim_entity 고아가 남지 않아야 한다(bulk 과 같음)."""
    db = LoaderDB(fresh_db, role="loader")
    src = _with_rollup_only_entity(_source())
    next(r for r in src.runs[ROOT] if r["measurement_run_id"] == R10)["total_jobs"] = 4
    src.jobs[R10] = [j for j in src.jobs[R10] if j["job_id"] != _j(105)]
    rep = await run_pass(db, src, project=ROOT, now=NOW, settings=_settings())
    assert [r.status for r in rep.runs] == ["committed"]
    assert (await _rows(fresh_db, "SELECT count(*) FROM ing.acr_rollup_row WHERE entity_id = $1", XR))[0][0] == 1
    assert (await _rows(fresh_db, "SELECT count(*) FROM rd.dim_entity WHERE entity_id = $1", XR))[0][0] == 1
    assert await bulk_equivalence(fresh_db) == ({}, {})
    rep = await run_pass(db, _with_rollup_only_entity(_source()), project=ROOT, now=NOW, settings=_settings())
    assert [(str(r.run_id), r.status, r.jobs_changed) for r in rep.runs] == [(R10, "committed", 1)]
    assert (await _rows(fresh_db, "SELECT count(*) FROM ing.acr_rollup_row WHERE entity_id = $1", XR))[0][0] == 0
    assert (await _rows(fresh_db, "SELECT count(*) FROM rd.dim_entity WHERE entity_id = $1", XR))[0][0] == 0
    assert await bulk_equivalence(fresh_db) == ({}, {})


@needs_db
async def test_crash_inside_load_tx_resumes_in_one_pass(fresh_db, monkeypatch):
    """결함 N2: 스테이지를 전량 받은 뒤 적재 트랜잭션 안(IG-3 attribute)에서 프로세스가 죽으면 run 은 staging(stage_cursor.cursor = null)·
    load running·스테이지 잔존으로 남는다. 다음 패스는 같은 load 로 1페이지부터 다시 받는데, 페이지 스테이지가 job 단위 교체라
    자식 스테이지(언급·출현·스탠스·인용)가 중복되지 않고 그 한 번에 committed 된다(거짓 실패·백오프 없음)."""
    from ingest.cycles.ledger import service as ledger_service
    db = LoaderDB(fresh_db, role="loader")
    rep = await run_pass(db, _source(), project=ROOT, now=NOW, settings=_settings())
    assert [r.status for r in rep.runs] == ["committed"]
    src = _source()
    next(r for r in src.runs[ROOT] if r["measurement_run_id"] == R10)["total_jobs"] = 6
    src.jobs[R10].append(make_job(_j(106), SP1, "chatgpt", "KR", measured_at="2026-09-28T02:20:00Z",
                                  mentions=[mention(HY, "Hyundai"), mention(TOY, "Toyota")],
                                  citations=[{"url": "https://www.hyundai.com/kr/ko/suv", "title": "k"}],
                                  stances=[{"turn_index": 0, "entity_id": HY, "brand_label": "Hyundai", "stance": "positive"}]))
    later = NOW + dt.timedelta(days=30)

    async def crash(*a, **kw):
        raise _Crash()

    monkeypatch.setattr(ledger_service, "attribute", crash)
    try:
        await run_pass(db, src, project=ROOT, now=later, settings=_settings())
        raise AssertionError("crash 가 전파돼야 한다")
    except _Crash:
        pass
    monkeypatch.undo()
    run = (await _rows(fresh_db, "SELECT total_jobs, sync_state, stage_cursor, attempts FROM ing.run WHERE run_id = $1", R10))[0]
    assert (run["total_jobs"], run["sync_state"], run["attempts"]) == (5, "staging", 0)
    assert '"cursor": null' in run["stage_cursor"]                    # 전량 수신 뒤 사망: 재개는 1페이지부터
    crashed = json.loads(run["stage_cursor"])["load_id"]
    assert (await _rows(fresh_db, "SELECT status FROM ing.load WHERE load_id = $1", crashed))[0][0] == "running"
    src.calls.clear()
    rep = await run_pass(db, src, project=ROOT, now=later, settings=_settings())
    assert [(str(r.run_id), r.status, r.load_id, r.jobs_fetched, r.jobs_changed) for r in rep.runs] == \
        [(R10, "committed", crashed, 6, 1)], [r.error for r in rep.runs]
    assert [c[2] for c in src.calls if c[0] == "list_run_jobs"] == [None, "2", "4"]
    run = (await _rows(fresh_db, "SELECT total_jobs, sync_state, attempts, next_attempt_at FROM ing.run WHERE run_id = $1", R10))[0]
    assert tuple(run) == (6, "loaded", 0, None)
    n = (await _rows(fresh_db, """SELECT (SELECT count(*) FROM ing.mention WHERE job_id = $1), (SELECT count(*) FROM ing.mention_occurrence WHERE job_id = $1),
        (SELECT count(*) FROM ing.answer_stance WHERE job_id = $1), (SELECT count(*) FROM ing.citation WHERE job_id = $1)""", _j(106)))[0]
    assert tuple(n) == (2, 2, 1, 1)
    assert (await _rows(fresh_db, "SELECT count(*) FROM ing.load WHERE status = 'running'"))[0][0] == 0
    left = await _rows(fresh_db, """SELECT (SELECT count(*) FROM ing.stage_answer) + (SELECT count(*) FROM ing.stage_mention)
        + (SELECT count(*) FROM ing.stage_occurrence) + (SELECT count(*) FROM ing.stage_stance) + (SELECT count(*) FROM ing.stage_citation)
        + (SELECT count(*) FROM ing.stage_acr)""")
    assert left[0][0] == 0
    assert await bulk_equivalence(fresh_db) == ({}, {})
