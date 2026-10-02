#!/usr/bin/env python3
"""1회 재투영(stg·이미 적재된 DB): 현행 프로필 resub_phantom_exclude(RESUB, WU-3b) 2단계 = 회차 좌석 투영 + 답변 회차 귀속 재투영.

1단계 fill-attrib-member-seat.sql(ing.cycle 좌석 이관, migrator) 뒤에 돈다. 적재기 경로 그대로(트랜잭션 1개):
  ① ledger.project_cycles: rd.cycle.round_date ≠ ing.cycle.round_date 인 회차를 투영(좌석 이동 회차의 run = 사실 행 이동 대상)
  ② 투영된 답변 회차(rd.job.cyc_key)가 run 원장 멤버십과 다른 run(선정 술어는 tests test_attrib_member.ATTRIB_RUNS 와 같다) ∪ ①의 run 을
     apply.reproject(extra_runs): RUNC 가 적재기 활성 프로필(resub_phantom_exclude 켜짐)로 회차를 다시 판정하고 사실 표·자식·ACR·셀 대표를
     새 회차로 옮긴다(옛 좌표 삭제 → 삽입, 대표 재선정·게이트 전파·단언 포함)
  ③ 단언: 운영자 pin 코호트 밖에서 멤버십과 다른 job 0, 답변 좌표 = 회차 좌표(대상 회차) → finalize(표면 세대 +1)
stg hmg_r2 2026-10-01 읽기 전용 실측 기준 예상: 좌석 회차 30, 재투영 run 465, 답변 13,853(자식 answer_brand 24,974·answer_stance 65·
citation 150,212), rd 파티션 이동 없음(두 규칙의 답변 좌석이 같다: 07-24·09-18).
전제: 1단계 적용, 적재 워커 정지(표면 배타 잠금으로도 막지만 대기열이 쌓인다), 이 스크립트와 워커의 HGH_LEGACY_PROFILE 이 같고
resub_phantom_exclude 가 켜져 있음(켜지지 않은 워커가 뒤에 이 run 을 다시 적재하면 hub 규칙으로 되돌린다).
락: 표면 1·2·3 배타 advisory(적재기끼리만, API 읽기 무관) + 대상 행 ROW EXCLUSIVE. 소요 예상 1~3분(stg, 답변 1.4만·인용 15만 삭제·삽입).
뒤처리: migrator 로 `SELECT app.result_cache_invalidate();`(결과 캐시 DB-v2.11 규약).

사용(back/ 에서, 적재 워커와 같은 env: HGH_INGEST_DB_URL·HGH_INGEST_DB_ROLE·HGH_LEGACY_PROFILE):
  python migration/reproject-attrib-member.py            # 드라이런: 읽기 전용 트랜잭션에서 개수만
  python migration/reproject-attrib-member.py --commit   # 실행(트랜잭션 1개, 실패하면 전부 롤백)
출력 = 요약 JSON 한 줄(개수·회차 키만, 비밀값·답변 본문 없음).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

SEAT_CYCLES = """
SELECT i.cycle_id, i.cyc_key, i.round_date AS new_rd, c.round_date AS old_rd
  FROM ing.cycle i JOIN rd.cycle c ON c.cycle_id = i.cycle_id
 WHERE c.round_date IS DISTINCT FROM i.round_date ORDER BY i.cyc_key"""
ATTRIB_RUNS = """
SELECT DISTINCT r.run_id FROM rd.job j JOIN ing.run r ON r.run_key = j.run_key
  JOIN ing.cycle_run cr ON cr.run_id = r.run_id JOIN ing.cycle m ON m.cycle_id = cr.cycle_id
 WHERE j.cyc_key IS DISTINCT FROM m.cyc_key"""
ATTRIB_LEFT = """
SELECT count(*) FROM rd.job j JOIN ing.run r ON r.run_key = j.run_key
  JOIN ing.cycle_run cr ON cr.run_id = r.run_id JOIN ing.cycle m ON m.cycle_id = cr.cycle_id
 WHERE j.cyc_key IS DISTINCT FROM m.cyc_key
   AND NOT EXISTS (SELECT 1 FROM ing.answer a JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id
                    WHERE a.run_id = r.run_id AND p.origin = 'operator')"""
SCALE = """
SELECT (SELECT count(*) FROM rd.job j JOIN ing.run r ON r.run_key = j.run_key WHERE r.run_id = ANY($1::uuid[])) AS jobs,
       (SELECT count(*) FROM rd.answer a JOIN ing.run r ON r.run_key = a.run_key WHERE r.run_id = ANY($1::uuid[])) AS answers,
       (SELECT count(*) FROM rd.answer_brand b JOIN rd.answer a ON a.surface = b.surface AND a.round_date = b.round_date AND a.answer_key = b.answer_key
          JOIN ing.run r ON r.run_key = a.run_key WHERE r.run_id = ANY($1::uuid[])) AS answer_brand,
       (SELECT count(*) FROM rd.answer_stance b JOIN rd.answer a ON a.surface = b.surface AND a.round_date = b.round_date AND a.answer_key = b.answer_key
          JOIN ing.run r ON r.run_key = a.run_key WHERE r.run_id = ANY($1::uuid[])) AS answer_stance,
       (SELECT count(*) FROM rd.citation b JOIN rd.answer a ON a.surface = b.surface AND a.round_date = b.round_date AND a.answer_key = b.answer_key
          JOIN ing.run r ON r.run_key = a.run_key WHERE r.run_id = ANY($1::uuid[])) AS citation,
       (SELECT count(*) FROM ing.answer_anchor_pin WHERE origin = 'operator') AS operator_pins"""
# 답변 좌표 = 회차 좌표(seed-40 불변식 ③ 을 대상 회차로 좁힘)
COORD_BAD = """
SELECT count(*) FROM rd.answer a JOIN rd.cycle c ON c.cyc_key = a.cyc_key
 WHERE a.cyc_key IN (SELECT cyc_key FROM rd.cycle WHERE cycle_id = ANY($1::uuid[]))
   AND (a.round_date, a.anchor_date, a.surface, a.project_key) IS DISTINCT FROM (c.round_date, c.anchor_date, c.surface, c.project_key)"""


async def main(commit: bool) -> tuple[int, dict]:
    from app.core.profile import active_profile
    from ingest.common.db import LoaderDB, begin_load, finalize, lock_surface_exclusive
    from ingest.cycles.ledger.service import project_cycles
    from ingest.project.apply.service import reproject

    prof = active_profile()
    out: dict = {"mode": "commit" if commit else "dry-run", "profile": prof.spec}
    if not prof.resub_phantom_exclude:
        return 2, {**out, "error": "HGH_LEGACY_PROFILE 에 resub_phantom_exclude 가 없다(워커와 같은 프로필로 켜고 실행)"}
    db = LoaderDB.from_settings()
    async with db.session() as conn:
        if not commit:
            async with conn.transaction(readonly=True):
                seat = await conn.fetch(SEAT_CYCLES)
                runs = [r[0] for r in await conn.fetch(ATTRIB_RUNS)]
                sc = await conn.fetchrow(SCALE, runs)
                out.update(seat_cycles=len(seat), seat_keys=[int(r["cyc_key"]) for r in seat][:60],
                           seat_pairs=sorted({f"{r['old_rd']}→{r['new_rd']}" for r in seat}), attrib_runs=len(runs), **dict(sc))
            return 0, out
        async with db.tx(conn, statement_timeout="1800s"):
            for s in (1, 2, 3):
                await lock_surface_exclusive(conn, s)
            ctx = await begin_load(conn, "judgment", scope_ref={"source": "reproject-attrib-member", "switch": "resub_phantom_exclude"})
            seat = await conn.fetch(SEAT_CYCLES)
            seat_ids = [r["cycle_id"] for r in seat]
            moved = await project_cycles(conn, ctx, seat_ids)
            runs = [r[0] for r in await conn.fetch(ATTRIB_RUNS)]
            targets = sorted(set(runs) | set(moved), key=str)
            sc = await conn.fetchrow(SCALE, targets)
            res = await reproject(conn, ctx, [], extra_runs=targets)
            left = int(await conn.fetchval(ATTRIB_LEFT))
            touched = list({*seat_ids, *[r[0] for r in await conn.fetch(
                "SELECT DISTINCT cr.cycle_id FROM ing.cycle_run cr WHERE cr.run_id = ANY($1::uuid[])", targets)]})
            bad = int(await conn.fetchval(COORD_BAD, touched))
            if left or bad:
                raise RuntimeError(f"단언 실패: 멤버십과 다른 job {left}, 답변·회차 좌표 불일치 {bad}(롤백)")
            gens = await finalize(conn, ctx)
            out.update(load_id=ctx.load_id, seat_cycles=len(seat), moved_runs=len(moved), attrib_runs=len(runs), reprojected_runs=len(targets),
                       **dict(sc), rd_answers=res.answers, rep_flips=res.rep_flips, children=res.children, generations=gens)
    return 0, out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    a = ap.parse_args()
    from ingest.common.config import install_worker_settings

    install_worker_settings()
    code, summary = asyncio.run(main(a.commit))
    print(json.dumps(summary, ensure_ascii=False, default=str))
    raise SystemExit(code)
