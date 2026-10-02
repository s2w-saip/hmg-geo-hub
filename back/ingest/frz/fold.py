"""동결 층 answer_brand 운영 summary 접기(현행 프로필 brand_card_fold, DB-v2.27 P142 frz.keep_fold). 부르는 곳: S2 발행 생성(ingest.frz.freeze)·
S1 이관(ingest.frz.ops_import).

운영 규칙(hmg-geo 2670a16): 세부층이 언급을 (job, 롤업 id, 표시명)으로 접는다(lib/summary/generate/load.ts:78-98). is_competitor = 그룹 bool_or(pass)
(pass = 언급 행마다, context.ts:143-144), 언급 = 그룹 합, first_rank = 그룹 전 언급 min(avg_position)(비경쟁 언급 포함), 경쟁 순위 = is_competitor ∧
first_rank 있는 행의 표시명 단위 min(first_rank) rank()(fold.ts:319-323·492-509). 허브 rd 는 언급 행 단위 경쟁 판정으로 나눈 행(운영 미러 화면
규칙)이라 rd 는 그대로 두고, 동결 세대에서만 접는다(결정 32: 바뀐 답변만 보관).

계산: 적재기 투영 원천(ingest.project.apply.service.stage → _ig_mr: 답변 × 표시 브랜드 키 × 언급 행 경쟁 × 롤업 id rid)을 저장점 안에서 만들고
읽은 뒤 저장점을 되돌린다(E4 미리보기와 같은 방식: 이름·경쟁·롤업·엔티티 버전 규칙이 rd 투영과 한 벌). 대상은 공존 답변(같은 답변·같은 표시
브랜드 키에 경쟁·비경쟁 rd 행이 함께 있는 셀)뿐이다. 접기는 공존 답변에서만 결과가 달라질 수 있다(롤업 그룹이 섞이면 반드시 두 행이 생긴다).
안전: 같은 원천의 접지 않은 결과(_ig_ab)가 지금 rd 행과 다르면 예외(rd 가 지금 규칙과 갈림 = 재투영 먼저). 보관 함수가 합을 한 번 더 대조한다.
"""
from __future__ import annotations

import json
from typing import Any

import asyncpg

# 공존 답변: 세대 셀 중 보관 없음 또는 seat 보관(rd 위치 = rd.job), 같은 브랜드 키에 경쟁·비경쟁 rd 행이 함께 있는 것
CANDIDATES = """
SELECT coalesce(array_agg(DISTINCT c.answer_key ORDER BY c.answer_key), '{}'::int4[])
  FROM frz.cell c JOIN rd.job j ON j.answer_key = c.answer_key
  JOIN rd.answer_brand f ON f.surface = j.surface AND f.round_date = j.round_date AND f.answer_key = j.answer_key
                        AND NOT f.competitive AND f.brand_key <> 0
 WHERE c.gen_key = $1
   AND NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key AND p.src <> 'seat')
   AND EXISTS (SELECT 1 FROM rd.answer_brand t WHERE t.surface = f.surface AND t.round_date = f.round_date AND t.answer_key = f.answer_key
                 AND t.brand_key = f.brand_key AND t.competitive)
"""
_MEAS = ("own_bit, entity_rows, rid_n, mention_count, rk, s_pos, s_neu, s_neg, s_mix, t_mention, t_recommendation, t_comparison, "
         "t_definition, t_final_choice")
# 같은 원천의 접지 않은 결과(_ig_ab) 대 지금 rd 행: 다르면 그 답변 키(rd 가 지금 규칙과 갈렸다)
DRIFT = f"""
WITH u AS (SELECT answer_key, brand_key, competitive, {_MEAS} FROM _ig_ab WHERE answer_key = ANY ($1::int4[])),
r AS (SELECT b.answer_key, b.brand_key, b.competitive, {", ".join("b." + x.strip() for x in _MEAS.split(","))}
        FROM rd.job j JOIN rd.answer_brand b ON b.surface = j.surface AND b.round_date = j.round_date AND b.answer_key = j.answer_key
       WHERE j.answer_key = ANY ($1::int4[]))
SELECT coalesce(array_agg(DISTINCT answer_key ORDER BY answer_key), '{{}}'::int4[])
  FROM ((SELECT * FROM u EXCEPT ALL SELECT * FROM r) UNION ALL (SELECT * FROM r EXCEPT ALL SELECT * FROM u)) d
"""
# 운영 접기: 경쟁 = (답변, 브랜드 키, 롤업 id) 그룹 bool_or, 측정값 = 그룹 합, tp = 그룹 전 언급 min(avg_position), 순위 = 경쟁 행 rank() by tp.
# 결과가 접지 않은 행(_ig_ab)과 다른 답변만 낸다
FOLD = f"""
WITH m AS (
  SELECT r.*, bool_or(r.competitive) OVER (PARTITION BY r.answer_key, r.brand_key, r.rid) AS cg
    FROM _ig_mr r WHERE r.answer_key = ANY ($1::int4[])),
f AS (
  SELECT answer_key, brand_key, cg AS competitive, max(own_bit)::int2 AS own_bit, count(*)::int2 AS entity_rows, count(DISTINCT rid)::int2 AS rid_n,
         sum(mention_count)::int2 AS mention_count,
         sum(sentiment_positive)::int2 AS s_pos, sum(sentiment_neutral)::int2 AS s_neu, sum(sentiment_negative)::int2 AS s_neg,
         sum(sentiment_mixed)::int2 AS s_mix, sum(type_mention)::int2 AS t_mention, sum(type_recommendation)::int2 AS t_recommendation,
         sum(type_comparison)::int2 AS t_comparison, sum(type_definition)::int2 AS t_definition, sum(type_final_choice)::int2 AS t_final_choice,
         min(avg_position) AS tp
    FROM m GROUP BY 1, 2, 3),
fr AS (
  SELECT f.*, coalesce(x.rk, 0)::int2 AS rk
    FROM f LEFT JOIN (SELECT answer_key, brand_key, rank() OVER (PARTITION BY answer_key ORDER BY tp)::int2 AS rk
                        FROM f WHERE competitive AND brand_key <> 0 AND tp IS NOT NULL) x
      ON x.answer_key = f.answer_key AND x.brand_key = f.brand_key AND f.competitive),
u AS (SELECT answer_key, brand_key, competitive, {_MEAS} FROM _ig_ab WHERE answer_key = ANY ($1::int4[])),
d AS (SELECT DISTINCT answer_key FROM ((SELECT answer_key, brand_key, competitive, {_MEAS} FROM fr EXCEPT ALL SELECT * FROM u)
                                       UNION ALL (SELECT * FROM u EXCEPT ALL SELECT answer_key, brand_key, competitive, {_MEAS} FROM fr)) z)
SELECT answer_key, brand_key, competitive, {_MEAS} FROM fr WHERE answer_key IN (SELECT answer_key FROM d)
 ORDER BY answer_key, brand_key, competitive
"""
KEEP = "SELECT frz.keep_fold($1::int4, $2::jsonb)"


class FoldDrift(RuntimeError):
    """지금 규칙의 접지 않은 결과가 rd 행과 다르다(rd 재투영 먼저). 접힌 값을 rd 와 다른 근거로 보관하지 않게 멈춘다."""


class _Rollback(Exception):
    pass


def enabled() -> bool:
    from app.core.profile import active_profile

    return bool(getattr(active_profile(), "brand_card_fold", False))


async def candidates(conn: asyncpg.Connection, gen_key: int) -> list[int]:
    return [int(k) for k in (await conn.fetchval(CANDIDATES, gen_key) or [])]


async def compute(conn: asyncpg.Connection, answer_keys: list[int]) -> list[dict[str, Any]]:
    """공존 답변의 운영 접기 행(접기 결과가 rd 와 같은 답변은 빠진다). 투영 원천은 저장점 안에서 만들고 되돌린다(rd·차원 무변경)."""
    if not answer_keys:
        return []
    from ingest.common.db import LoadContext, current_rule_ver
    from ingest.project.apply.service import stage

    keys = sorted({int(k) for k in answer_keys})
    out: dict[str, Any] = {}
    try:
        async with conn.transaction():
            ctx = LoadContext(load_id=0, kind="frz_fold", rule_ver=await current_rule_ver(conn))
            await stage(conn, ctx, [], extra_keys=keys, detect_global=False, escalate_at=max(10_000, 50 * len(keys)))
            out["drift"] = [int(k) for k in (await conn.fetchval(DRIFT, keys) or [])]
            out["rows"] = [dict(r) for r in await conn.fetch(FOLD, keys)]
            raise _Rollback
    except _Rollback:
        pass
    if out["drift"]:
        raise FoldDrift(f"동결 접기: 지금 규칙의 접지 않은 결과가 rd 와 다른 답변 {len(out['drift'])}개(앞 키 {out['drift'][:5]}): rd 재투영 먼저")
    return out["rows"]


async def keep_generation(conn: asyncpg.Connection, gen_key: int) -> dict[str, int]:
    """스위치가 켜져 있으면 세대 공존 답변을 접어 보관한다. 반환 = {candidates, kept}. 꺼짐이면 아무것도 하지 않는다(끔 동작 그대로)."""
    if not enabled():
        return {"candidates": 0, "kept": 0}
    keys = await candidates(conn, gen_key)
    if not keys:
        return {"candidates": 0, "kept": 0}
    rows = await compute(conn, keys)
    n = int(await conn.fetchval(KEEP, gen_key, json.dumps(rows))) if rows else 0
    return {"candidates": len(keys), "kept": n}
