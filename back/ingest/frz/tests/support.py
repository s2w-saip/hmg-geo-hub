"""동결 층 시험 공용(DB-v2.21 frz). 합성 데이터만, 호출자 트랜잭션 안에서 쓰고 시험이 롤백한다."""
from __future__ import annotations

import uuid
from typing import Any

import asyncpg

# 시험용 허브 동결(S2 발행 생성 규칙이 아니다): 회차의 지금 rd 대표 답변을 셀로, 셀 프롬프트를 축으로(in_full_cycle 참) 굳히고 활성화한다
FREEZE_GEN = "INSERT INTO frz.generation (cyc_key, surface, source) SELECT cyc_key, surface, 'hub' FROM rd.cycle WHERE cyc_key = $1 RETURNING gen_key"
FREEZE_CELLS = """
INSERT INTO frz.cell (gen_key, answer_key, surface, cyc_key, round_date, prompt_key, engine_key, geo_key)
SELECT $1::int4, a.answer_key, a.surface, a.cyc_key, a.round_date, a.prompt_key, a.engine_key, a.geo_key
  FROM rd.answer a WHERE a.cyc_key = $2::int4 AND a.is_rep
"""
FREEZE_PROMPTS = """
INSERT INTO frz.prompt (gen_key, prompt_key, cyc_key, in_full_cycle, in_root_catalog, catalog_deleted, cat_mask)
SELECT DISTINCT $1::int4, c.prompt_key, c.cyc_key, true, d.in_root_catalog, false, d.cat_mask
  FROM frz.cell c JOIN rd.dim_prompt d ON d.prompt_key = c.prompt_key WHERE c.gen_key = $1::int4
"""

VIEWS = ("answer", "answer_brand", "citation")
# 장부 열(DB-v2.21 P117 보관 비교에서 빼는 열, 조회가 읽지 않는다): 적재 번호·엔티티 반영 원장·규칙 세트 번호. is_rep 은 동결 뷰에서 참 고정
LEDGER = "'{load_id,ecat_ver,rule_ver}'::text[]"
LEDGER_REP = "'{is_rep,load_id,ecat_ver,rule_ver,gen_key}'::text[]"


async def freeze(c: asyncpg.Connection, cyc_keys: list[int]) -> dict[int, int]:
    """회차마다 세대 1개(cyc_key → gen_key)."""
    out: dict[int, int] = {}
    for k in cyc_keys:
        g = await c.fetchval(FREEZE_GEN, k)
        await c.execute(FREEZE_CELLS, g, k)
        await c.execute(FREEZE_PROMPTS, g)
        await c.execute("SELECT frz.activate($1)", g)
        await c.fetchval("SELECT frz.assert_generation($1)", g)
        out[k] = g
    return out


async def view_rows(c: asyncpg.Connection) -> dict[str, list[str]]:
    """동결 읽기 뷰 3개 전체 행(텍스트, 정렬). 장부 열(load_id·ecat_ver·rule_ver, 조회가 읽지 않는다)은 뺀다: 같은 값 재적재·엔티티 반영 원장
    표시는 장부 열만 바꾼다(보관 관문도 장부 열을 비교하지 않는다)."""
    return {v: [r[0] for r in await c.fetch(f"SELECT (to_jsonb(x) - {LEDGER})::text FROM frz.{v} x ORDER BY 1")] for v in VIEWS}


async def rd_rows_of(c: asyncpg.Connection, keys: list[int]) -> dict[str, list[str]]:
    """그 답변들의 지금 rd 행(is_rep·load_id 를 뺀 jsonb 텍스트, 정렬). 보관 행 대조용."""
    out = {}
    for t in VIEWS:
        out[t] = [r[0] for r in await c.fetch(
            f"SELECT (to_jsonb(x) - {LEDGER_REP})::text FROM rd.{t} x WHERE x.answer_key = ANY ($1::int4[]) ORDER BY 1", keys)]
    return out


async def keep_rows_of(c: asyncpg.Connection, keys: list[int]) -> dict[str, list[str]]:
    out = {}
    for t in VIEWS:
        out[t] = [r[0] for r in await c.fetch(
            f"SELECT (to_jsonb(x) - {LEDGER_REP})::text FROM frz.keep_{t} x WHERE x.answer_key = ANY ($1::int4[]) ORDER BY 1",
            keys)]
    return out


async def kept(c: asyncpg.Connection) -> dict[int, str]:
    """답변 키 → 보관 출처(세대가 여럿이면 아무 세대 하나: 시험은 대개 세대 1개). 세대까지 보려면 kept_pairs."""
    return {int(r["answer_key"]): r["src"] for r in await c.fetch("SELECT answer_key, src FROM frz.kept")}


async def kept_pairs(c: asyncpg.Connection) -> dict[tuple[int, int], str]:
    return {(int(r["gen_key"]), int(r["answer_key"])): r["src"] for r in await c.fetch("SELECT gen_key, answer_key, src FROM frz.kept")}


async def frozen_keys(c: asyncpg.Connection) -> list[int]:
    return [int(r[0]) for r in await c.fetch("SELECT DISTINCT answer_key FROM frz.cell ORDER BY 1")]


async def job_of(c: asyncpg.Connection, answer_key: int) -> uuid.UUID:
    return await c.fetchval("SELECT job_id FROM rd.job WHERE answer_key = $1", answer_key)


async def frz_counts(c: asyncpg.Connection) -> dict[str, Any]:
    return dict(await c.fetchrow(
        "SELECT (SELECT count(*) FROM frz.generation) AS gens, (SELECT count(*) FROM frz.generation WHERE state = 'active') AS active, "
        "(SELECT count(*) FROM frz.cell) AS cells, (SELECT count(*) FROM frz.prompt) AS prompts, (SELECT count(*) FROM frz.kept) AS kept, "
        "(SELECT count(*) FROM frz.keep_answer) AS keep_answer, (SELECT count(*) FROM frz.keep_answer_brand) AS keep_brand, "
        "(SELECT count(*) FROM frz.keep_citation) AS keep_citation"))
