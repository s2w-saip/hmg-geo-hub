"""원장 발행 때 동결 세대 생성(결정 31·32 S2, DB-v2.22 frz.freeze_cycle). 규칙 근거는 패치 머리(DB-v2.22-patch.sql P120~P122).

부르는 곳: 원장 재평가(ingest.cycles.ledger.reevaluate)로 회차가 발행된 직후, 좌석 이동 재투영(moved_runs)까지 끝난 같은 적재 트랜잭션.
  cycles.workers.service.cycles_tick · process_change(cycle_admin close·seal·force_publish) · pull.sync.service(run 적재) 세 곳.
실패 처리: 회차마다 세이브포인트. 생성이 실패해도 발행은 커밋한다(그 회차는 동결 세대 없음 = 카드 동결 읽기는 실패 닫힘, S3).
  실패는 경고 로그 + 반환값에 남고, 운영자가 cycle_admin regenerate(사유)로 다시 만든다.
판정 입력 포인터: 활성 프로필의 투영·읽기 스위치(값이 아니라 켜진 이름 목록)를 함께 남긴다(DB 쪽 포인터: 엔티티 버전·회차 핀·규칙 세트·세대).
운영 summary 접기(현행 프로필 brand_card_fold, DB-v2.27): 새 세대의 공존 답변을 접어 보관한다(ingest.frz.fold). 같은 저장점 안이라 접기가
  실패하면 그 회차의 세대도 만들지 않는다(접히지 않은 카드 값을 동결하지 않는다 = 실패 닫힘). 꺼짐이면 할 일 없음.
"""
from __future__ import annotations

import json
import logging
from typing import Any

import asyncpg

from ingest.frz import fold as frz_fold

log = logging.getLogger("hgh.ingest.frz")

FREEZE = "SELECT frz.freeze_cycle($1::uuid, $2::jsonb)::text"
REGENERATE = "SELECT frz.regenerate($1::uuid, $2, $3::jsonb)::text"
TARGETS = ("SELECT cycle_id FROM ing.cycle WHERE cycle_id = ANY($1::uuid[]) AND surface IN ('global', 'website') AND status = 'published' "
           "ORDER BY cyc_key")


def judgment_pointer() -> dict[str, Any]:
    """판정 입력 버전 포인터의 앱 쪽 절반: 활성 프로필에서 켜진 스위치 이름."""
    from app.core.profile import SWITCHES, active_profile

    prof = active_profile()
    return {"profile_on": sorted(n for n in SWITCHES if getattr(prof, n, False))}


async def freeze_published(conn: asyncpg.Connection, cycle_ids: list[Any]) -> dict[str, Any]:
    """발행된 global·website 회차의 동결 세대를 만든다(활성 세대가 있으면 그대로). 반환 = {frozen, already, failed: [{cycle, error}]}."""
    out: dict[str, Any] = {"frozen": [], "already": [], "failed": []}
    if not cycle_ids:
        return out
    j = json.dumps(judgment_pointer())
    for (cid,) in await conn.fetch(TARGETS, list(cycle_ids)):
        try:
            async with conn.transaction():
                r = json.loads(await conn.fetchval(FREEZE, cid, j))
                if r.get("status") == "frozen":
                    r["fold"] = await _fold(conn, int(r["gen_key"]))
        except (asyncpg.PostgresError, frz_fold.FoldDrift) as e:
            log.warning("동결 세대 생성 실패(발행은 유지) cycle=%s: %s", str(cid)[:8], e)
            out["failed"].append({"cycle": str(cid), "error": str(e)[:300]})
            continue
        out["frozen" if r.get("status") == "frozen" else "already"].append({"cycle": str(cid), **r})
    return out


async def regenerate(conn: asyncpg.Connection, cycle_id: Any, reason: str) -> dict[str, Any]:
    """재생성(재해석): 활성 세대 해제 → 지금 판정으로 다시 동결. 실패는 예외(운영 요청 행이 failed 로 남는다)."""
    j = json.dumps(judgment_pointer())
    async with conn.transaction():
        r = json.loads(await conn.fetchval(REGENERATE, cycle_id, reason, j))
        if r.get("status") == "frozen":
            r["fold"] = await _fold(conn, int(r["gen_key"]))
    return r


async def _fold(conn: asyncpg.Connection, gen_key: int) -> dict[str, int]:
    """새 세대의 운영 summary 접기 보관(brand_card_fold). 보관 함수가 세대 구조를 다시 단언하고 row_counts.kept_fold 를 남긴다."""
    return await frz_fold.keep_generation(conn, gen_key)
