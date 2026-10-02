"""검토 대기함 채우기 + 드리프트(E8, 제품 결정 28). 일회 DB(fresh_db). Slack 실제 발송 없음(MemoryAlertSink).

강제 픽스처 3종(설계 1-3절 9/20 Hyundai 표면 `N` 반사실을 재현):
  1) 새 엔티티(rd.dim_entity 최근 첫 관측) → 검토 대기함 적재, 경보 없음.
  2) 비자사(Toyota) 새 표면 `Xtra`, 3행(50 미만) → 검토 대기함 적재, 경보 없음(비자사·저볼륨은 큐만).
  3) 자사(Hyundai) 새 표면 `N7`, 60행 → 검토 대기함 적재 + 등급 1 경보(가짜 전송기 도달, 자사라 볼륨과 무관) →
     재실행은 재알림 없음(행 단위 억제, N 사고 반사실의 핵심).
"""
from __future__ import annotations

import datetime as dt
import uuid

import asyncpg

from ingest.common.alerts import MemoryAlertSink
from ingest.common.db import LoaderDB
from ingest.cycles.watch.service import merge_surface_candidates, watch
from tests.support import needs_db

NOW = dt.datetime(2026, 10, 10, 6, 0, tzinfo=dt.UTC)
HYUNDAI = uuid.UUID("00000000-0000-0000-0000-000000000301")   # app.brand.canonical_entity_id(is_hmg_own)
TOYOTA = uuid.UUID("71000000-0000-4000-8000-000000000001")    # 픽스처 기존 경쟁사(비자사, rd.dim_entity 기존 행. "새 엔티티" 아님)
NEW_CO = uuid.UUID("71000000-0000-4000-8000-000000000099")    # 픽스처 밖 신규 경쟁사(허브가 처음 보는 엔티티)
LOW_VOL_SURFACE = "Xtra"     # 비자사(Toyota) 새 표면, 3행(50 미만, 비자사라 임계 미달) → 큐만
HIGH_VOL_SURFACE = "N7"      # Hyundai(자사) 새 표면, 60행 → 자사 조건만으로도 경보 대상(고볼륨은 곁다리 근거)


async def _setup(url: str) -> None:
    c = await asyncpg.connect(url)
    try:
        async with c.transaction():
            lid = await c.fetchval("INSERT INTO ing.load (kind, rule_ver, started_at, status) VALUES ('run', 1, $1, 'committed') "
                                   "RETURNING load_id", NOW - dt.timedelta(hours=1))
            run_id = uuid.uuid4()

            async def add(entity_id: uuid.UUID, surfaces: list[str] | None, n: int, *, display_name: str = "", entity_type: str = "Brand") -> None:
                for _ in range(n):
                    jid = uuid.uuid4()
                    ak = await c.fetchval("INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ($1, '2026-09-01') "
                                         "RETURNING answer_key", jid)
                    await c.execute("""INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, target, status, measured_at,
                                                              n_mentions, content_hash, first_seen_at, load_id)
                                       VALUES ('2026-09-01', $1, $2, $3, 'chatgpt', 'completed', $4, 1, '\\x00', $4, $5)""",
                                    jid, ak, run_id, NOW - dt.timedelta(hours=1), lid)
                    await c.execute("""INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type,
                                                                mention_count, surfaces, type_mention)
                                       VALUES ('2026-09-01', $1, 1, $2, $3, $4, 1, $5, 1)""",
                                    jid, entity_id, display_name or None, entity_type, surfaces)

            # 1) 새 엔티티: rd.dim_entity 최근 첫 관측 + 언급 4건(카운트 재료)
            await c.execute("INSERT INTO rd.dim_entity (entity_id, entity_type, rep_name, first_seen) VALUES ($1, 'Brand', 'NewCo', $2)",
                            NEW_CO, NOW - dt.timedelta(hours=1))
            await add(NEW_CO, ["NewCo"], 4, display_name="NewCo")
            # 2) 비자사(Toyota) 새 표면(저볼륨, 3행 < 50): 큐만, 경보 없음
            await add(TOYOTA, [LOW_VOL_SURFACE], 3, display_name="Toyota")
            # 3) 자사(Hyundai) 새 표면(60행): 자사라 볼륨과 무관하게 경보 대상
            await add(HYUNDAI, [HIGH_VOL_SURFACE], 60, display_name="Hyundai")
    finally:
        await c.close()


async def _review_rows(url: str) -> list[dict]:
    c = await asyncpg.connect(url)
    try:
        rows = await c.fetch("SELECT review_id, kind, entity_id, surface_norm, n_mentions, n_answers, alerted_at, alert_grade "
                             "FROM app.ecat_review ORDER BY kind, surface_norm NULLS FIRST")
        return [dict(r) for r in rows]
    finally:
        await c.close()


@needs_db
async def test_review_fill_queues_and_alerts_high_volume_own_surface(fresh_db):
    await _setup(fresh_db)
    db = LoaderDB(fresh_db, role="loader")
    sink = MemoryAlertSink()
    rep = await watch(db, now=NOW, alerts=sink, checks=["review_fill"])

    rows = await _review_rows(fresh_db)
    by_key = {(r["kind"], r["surface_norm"]): r for r in rows}
    assert ("new_entity", None) in by_key
    ne = by_key[("new_entity", None)]
    assert ne["entity_id"] == NEW_CO and ne["n_mentions"] == 4 and ne["n_answers"] == 4 and ne["alerted_at"] is None

    low = by_key[("new_surface", "xtra")]     # normalize_surface casefolds "Xtra" → "xtra"
    assert low["entity_id"] == TOYOTA and low["n_mentions"] == 3 and low["alerted_at"] is None   # 비자사·50 미만: 큐만

    high = by_key[("new_surface", "n7")]
    assert high["entity_id"] == HYUNDAI and high["n_mentions"] == 60 and high["alerted_at"] is not None and high["alert_grade"] == 1

    # 등급 1 경보가 가짜 전송기(Slack 대체)에 실제로 도달했는지: 새 엔티티·저볼륨 새 표면은 경보하지 않고, 고볼륨 자사 표면 1건만
    rf = [f for f in rep.findings if f.check == "review_fill"]
    assert len(rf) == 1 and (rf[0].severity, rf[0].sink) == (1, "live")
    assert rf[0].detail["alerted"] == [{"review_id": high["review_id"], "entity_id": str(HYUNDAI), "surface": HIGH_VOL_SURFACE,
                                        "surface_norm": "n7", "display_name": "Hyundai", "n_mentions": 60, "own": True}]
    assert len(sink.sent) == 1 and sink.severities == [1]
    assert "n7" in sink.sent[0][1] or HIGH_VOL_SURFACE in sink.sent[0][1]
    # 새 표면 3건: Hyundai n(3)·n7(60) + NewCo 의 초기 표면 newco(4, 새 엔티티라 표면도 같이 큐에 오른다. 중복 아님, 별개 관점)
    info = dict(rep.info["review_fill"])
    base = info.pop("baseline")                                                # 첫 가동: 창 앞(6시간 전까지) 표면을 판정 원장에 채운 기준선
    assert base["quiet"] is False and base["baseline_to"] == (NOW - dt.timedelta(hours=6)).isoformat()
    assert info == {"checked": True, "new_entity": 1, "new_entity_saturated": False, "new_surface": 3,
                    "new_surface_saturated": False, "alerted": 1}

    # 재알림 억제(행 단위, 같은 표면 1회): 같은 시각으로 다시 돌려도 창이 비어(판정 끝) 다시 울리지 않는다. 뒤 창의 재관측 누적은
    # test_review_fill_first_seen 이 본다
    sink2 = MemoryAlertSink()
    rep2 = await watch(db, now=NOW, alerts=sink2, checks=["review_fill"])
    assert [f for f in rep2.findings if f.check == "review_fill"] == [] and sink2.sent == []
    rows2 = await _review_rows(fresh_db)
    by_key2 = {(r["kind"], r["surface_norm"]): r for r in rows2}
    assert by_key2[("new_surface", "n7")]["n_mentions"] == 60                 # 같은 창은 이미 판정됨(워터마크 judged_to): 다시 세지 않는다
    assert "baseline" not in rep2.info["review_fill"] and rep2.info["review_fill"]["new_surface"] == 0
    assert by_key2[("new_surface", "n7")]["alert_grade"] == 1                 # alerted_at·등급은 1회차 값 그대로


@needs_db
async def test_review_fill_clean_state_is_quiet(fresh_db):
    """이 감시 창에 아무 신규 엔티티·표면이 없으면(합성 픽스처 그대로) review_fill 은 무경보."""
    db = LoaderDB(fresh_db, role="loader")
    sink = MemoryAlertSink()
    rep = await watch(db, now=NOW, alerts=sink, checks=["review_fill"])
    assert rep.findings == [] and sink.sent == []
    info = dict(rep.info["review_fill"])
    assert info.pop("baseline")["quiet"] is False
    assert info == {"checked": True, "new_entity": 0, "new_entity_saturated": False, "new_surface": 0,
                    "new_surface_saturated": False, "alerted": 0}


def test_merge_surface_candidates_folds_same_normal_form():
    """순수 함수: 대소문자만 다른 원문 두 표면이 정규형 하나로 합쳐지고 카운트가 더해진다."""
    eid = uuid.uuid4()
    rows = [{"entity_id": eid, "surface": "N", "display_name": "Hyundai", "entity_type": "Brand", "n_mentions": 3, "n_answers": 3,
             "first_load_id": 5},
            {"entity_id": eid, "surface": "n", "display_name": "Hyundai", "entity_type": "Brand", "n_mentions": 2, "n_answers": 2,
             "first_load_id": 7}]
    out = merge_surface_candidates(rows)
    assert len(out) == 1 and out[0].surface_norm == "n" and out[0].n_mentions == 5 and out[0].first_load_id == 5
