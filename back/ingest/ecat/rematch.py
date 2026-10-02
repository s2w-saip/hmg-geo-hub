"""재매칭 언급 읽기 계약(E1 투영·E4 미리보기가 쓴다). 쓰기 없음(임시 표 materialize 만).

입력: 켜진 add 표면 집합(버전의 app.ecat_surface action='add'), 선택적으로 답변 키 목록. 호출 전에 ingest.ecat.scan.ensure_scanned 로
그 표면들의 스캔을 최신으로 맞춘다(여기는 스캔하지 않는다).

턴 하나(= ing.hub_match 의 (run_month, job_id, turn_index))마다
  hits            그 턴의 유효 행(answer_hash = 지금 content_hash) 전부 → matcher.hits_of
  occupied        같은 턴 Scope 발생 ing.mention_occurrence(source_start, source_end). 턴 번호 NULL 은 단일 턴 답변이면 턴 1 로 본다
  positions_known 그 턴에 Scope 발생 행이 하나라도 있다(9월 이후 적재분). 6~8월(발생 행 0%)은 False → 새 언급 위치 NULL
  scope_mentions  job 의 Scope 언급 엔티티(ing.mention 은 job 단위). 이 턴에 발생이 있으면 first_start = 이 턴 최소 source_start,
                  없으면 None(= 존재만 인정: 재매칭이 개수를 더하지 않는다. ACR 2턴에서 1턴에만 나온 엔티티도 여기에 든다)
  → matcher.resolve_overlaps(hits, occupied) → matcher.build_rematch_mentions(본문, …)
결과 1행 = 턴 × 엔티티. is_new=True 는 새 언급(감성 미상 = 감성 4종 0·sentiment_known False, 유형은 type_mention 만),
is_new=False 는 기존 Scope 언급에 **더할** 개수(위치 불변).
"""
from __future__ import annotations

import datetime as dt
import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import asyncpg

from app.core.ecat.matcher import RematchMention, ScopeMention, SurfaceScan, build_rematch_mentions, hits_of, resolve_overlaps

from . import queries as q

Key = tuple[dt.date, uuid.UUID]


@dataclass(frozen=True, slots=True)
class RematchRow:
    run_month: dt.date
    job_id: uuid.UUID
    turn_index: int
    positions_known: bool
    mention: RematchMention

    def record(self) -> tuple[Any, ...]:
        """queries.REMATCH_COLUMNS 순서의 임시 표 레코드."""
        m = self.mention
        return (self.run_month, self.job_id, self.turn_index, m.entity_id, m.is_new, m.mention_count, m.first_start, list(m.starts),
                list(m.surface_ids), list(m.surfaces), m.avg_position, self.positions_known, m.sentiment_positive, m.sentiment_neutral,
                m.sentiment_negative, m.sentiment_mixed, m.sentiment_known, m.type_mention, m.type_recommendation, m.type_comparison,
                m.type_definition, m.type_final_choice, m.extraction_source)


def _keys_arrays(keys: Sequence[Key] | None) -> tuple[list[dt.date] | None, list[uuid.UUID] | None]:
    if keys is None:
        return None, None
    return [k[0] for k in keys], [k[1] for k in keys]


async def rematch_rows(conn: asyncpg.Connection, surface_ids: Sequence[int], *, keys: Sequence[Key] | None = None) -> list[RematchRow]:
    """켜진 add 표면들의 재매칭 언급(겹침 제거 뒤). keys 없음 = 적중이 있는 모든 답변. 결과 순서 = (run_month, job_id, 턴, 첫 발생)."""
    sids = sorted({int(s) for s in surface_ids})
    if not sids:
        return []
    ms, js = _keys_arrays(keys)
    by_turn: dict[tuple[dt.date, uuid.UUID, int], list[SurfaceScan]] = defaultdict(list)
    for r in await conn.fetch(q.REMATCH_HITS, sids, ms, js):
        by_turn[(r["run_month"], r["job_id"], int(r["turn_index"]))].append(
            SurfaceScan(int(r["surface_id"]), r["entity_id"], tuple(r["starts"]), tuple(r["ends"])))
    if not by_turn:
        return []
    jobs = sorted({(k[0], k[1]) for k in by_turn})
    jm, jj = [k[0] for k in jobs], [k[1] for k in jobs]
    bodies = {(r["run_month"], r["job_id"]): (r["answer_text"], int(r["body_turn"])) for r in await conn.fetch(q.REMATCH_BODIES, jm, jj)}
    occ: dict[tuple[dt.date, uuid.UUID, int], list[asyncpg.Record]] = defaultdict(list)
    occ_entities: dict[Key, set[Any]] = defaultdict(set)
    for r in await conn.fetch(q.REMATCH_OCC, jm, jj):
        k = (r["run_month"], r["job_id"])
        t = r["turn_index"]
        if t is None:
            t = 1 if bodies.get(k, (None, 1))[1] == 1 else None
        occ_entities[k].add(r["entity_id"])
        if t is not None:
            occ[(k[0], k[1], int(t))].append(r)
    mentioned: dict[Key, set[Any]] = defaultdict(set)
    for r in await conn.fetch(q.REMATCH_MENTIONS, jm, jj):
        mentioned[(r["run_month"], r["job_id"])].add(r["entity_id"])

    out: list[RematchRow] = []
    for tk in sorted(by_turn):
        jk = (tk[0], tk[1])
        text = bodies.get(jk, (None, 0))[0]
        if not text:
            continue
        o = occ.get(tk, [])
        occupied = [(int(x["source_start"]), int(x["source_end"])) for x in o]
        first: dict[Any, int] = {}
        for x in o:
            e, s = x["entity_id"], int(x["source_start"])
            if e not in first or s < first[e]:
                first[e] = s
        scope = [ScopeMention(e, first.get(e)) for e in sorted(mentioned.get(jk, set()) | set(first), key=str)]
        resolved = resolve_overlaps(hits_of(by_turn[tk]), occupied)
        known = bool(o)
        for m in build_rematch_mentions(text, resolved, scope_mentions=scope, positions_known=known):
            out.append(RematchRow(tk[0], tk[1], tk[2], known, m))
    return out


async def materialize_rematch(conn: asyncpg.Connection, surface_ids: Sequence[int], *, keys: Sequence[Key] | None = None,
                              table: str = "_ecat_rematch") -> int:
    """rematch_rows 를 임시 표(ON COMMIT DROP, 열 = queries.REMATCH_COLUMNS)로 만든다. 트랜잭션 안에서 부른다. 반환 = 행 수.
    투영 SQL(E1 _ig_meff)·미리보기(E4)는 이 표를 ing.mention 모양 원천에 UNION(is_new) 또는 개수 가산(NOT is_new)으로 붙인다."""
    if not table.isidentifier() or not table.startswith("_"):
        raise ValueError("임시 표 이름은 밑줄로 시작하는 식별자")
    await conn.execute(q.REMATCH_TEMP.format(table=table))
    rows = await rematch_rows(conn, surface_ids, keys=keys)
    if rows:
        await conn.copy_records_to_table(table, columns=list(q.REMATCH_COLUMNS), records=[r.record() for r in rows])
    return len(rows)
