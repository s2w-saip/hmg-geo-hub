"""운영 summary 접기의 독립 오라클(시험 도우미). 구현(ingest.frz.fold·적재기 stage)을 쓰지 않고 운영 2670a16 규칙을 파이썬으로 다시 쓴다.
출처: 56dc4161 독립 검증 notes/hgh-impl/wu12/v-smartfold/oracle_probe.py 의 oracle()(답변 하나 → 허브 행 모양)을 옮겼다.

규칙(2670a16): 언급(롤업 있음) → 롤업 id = 접두 교정(app.brand_name_prefix) → 별칭 정본(app.entity_alias) → 롤업, 표시명 = 롤업 대표 표기(원장
ing.entity_brand_name, 없으면 Brand 행 표기: 라틴 우선 → 사전순) 없으면 자기 표기, 정본 표기(app.brand_display_alias). pass = bare(표시명 트림·소문자)
가 비경쟁 명부(app.non_competitor_name)에 없거나, bare-only 이름이면 자기 표기가 되살리기 패턴에 맞음. 세부층 그룹 (롤업 id, 표시 브랜드 키):
is_competitor = any(pass), 측정값 = 합, first_rank = min(avg_position)(pass 무관)(lib/summary/generate/load.ts:78-98). 허브 행 모양 = (키, 경쟁)으로
모은다(롤업 수 = 그룹 수). 경쟁 순위 = 경쟁 행의 min(first_rank) rank()(동률 같은 순위, 다음 건너뜀)(fold.ts:319-323·492-509).
"""
from __future__ import annotations

import re
import uuid

import asyncpg

MEAS = ("mention_count", "s_pos", "s_neu", "s_neg", "s_mix", "t_mention", "t_recommendation", "t_comparison", "t_definition", "t_final_choice")
MCOLS = ("mention_count, sentiment_positive AS s_pos, sentiment_neutral AS s_neu, sentiment_negative AS s_neg, sentiment_mixed AS s_mix, "
         "type_mention AS t_mention, type_recommendation AS t_recommendation, type_comparison AS t_comparison, type_definition AS t_definition, "
         "type_final_choice AS t_final_choice")
HCOLS = "brand_key, competitive, own_bit, entity_rows, rid_n, rk, " + ", ".join(MEAS)
ROW_KEYS = ("own_bit", "entity_rows", "rid_n", "rk", *MEAS)


def pgrx(p: str) -> re.Pattern:
    """POSIX 패턴(비경쟁 되살리기·접두)을 파이썬 정규식으로(대소문자 무시, [:alnum:] 은 ASCII 부분)."""
    return re.compile(p.replace("[^[:alnum:]]", "[^0-9A-Za-z]"), re.I)


async def oracle(c: asyncpg.Connection, job: uuid.UUID) -> dict[tuple[int, bool], dict[str, int]]:
    """답변(job)의 운영 접기 결과를 허브 행 모양((브랜드 키, 경쟁) → 측정값)으로."""
    ms = await c.fetch(f"SELECT ord, entity_id, display_name, entity_type, brand_rollup_entity_id AS rollup, avg_position, {MCOLS} "
                       "FROM ing.mention WHERE job_id = $1 AND brand_rollup_entity_id IS NOT NULL", job)
    ealias = {r[0]: r[1] for r in await c.fetch("SELECT alias_entity_id, canon_entity_id FROM app.entity_alias")}
    dalias = {r[0]: r[1] for r in await c.fetch("SELECT alias, canonical_name FROM app.brand_display_alias")}
    nc = {r[0]: r[1] for r in await c.fetch("SELECT name, bare_only_pattern FROM app.non_competitor_name")}
    bn = {r[0]: (int(r[1]), int(r[2])) for r in await c.fetch("SELECT name, brand_key, own_bit FROM rd.dim_brand_name")}
    pfx = [(pgrx("^[\\s]*(" + re.escape(r[0]) + ")([^[:alnum:]]|$)"), r[1]) for r in await c.fetch(
        "SELECT p.prefix, b.canonical_entity_id FROM app.brand_name_prefix p JOIN app.brand b ON b.brand_code = p.brand_code ORDER BY p.eval_order")]

    async def rep(rid):
        r = await c.fetchrow("SELECT display_name FROM ing.entity_brand_name WHERE entity_id = $1 "
                             "ORDER BY (display_name ~ '^[A-Za-z]') DESC, display_name COLLATE \"en-US-x-icu\" LIMIT 1", rid)
        if r:
            return r[0]
        r = await c.fetchrow("SELECT display_name FROM ing.mention WHERE entity_id = $1 AND entity_type = 'Brand' AND display_name IS NOT NULL "
                             "ORDER BY (display_name ~ '^[A-Za-z]') DESC, display_name COLLATE \"en-US-x-icu\" LIMIT 1", rid)
        return r[0] if r else None

    grp: dict[tuple, dict] = {}
    for m in ms:
        disp = m["display_name"]
        hit = next((cid for rx, cid in pfx if disp is not None and rx.match(disp)), None)
        rid = hit if hit is not None else ealias.get(m["rollup"], m["rollup"])
        name = (await rep(rid)) or disp
        name = dalias.get(name, name)
        bare = (name or "").strip().lower()
        if bare == "":
            comp = False
        elif bare not in nc:
            comp = True
        elif nc[bare] is not None:
            comp = bool(pgrx(nc[bare]).match(disp or ""))
        else:
            comp = False
        bk, ob = bn.get(name, (0, 0))
        g = grp.setdefault((rid, bk), {"comp": False, "n": 0, "fr": None, "ob": ob, **{k: 0 for k in MEAS}})
        g["comp"] = g["comp"] or comp
        g["n"] += 1
        for k in MEAS:
            g[k] += int(m[k])
        if m["avg_position"] is not None:
            g["fr"] = m["avg_position"] if g["fr"] is None else min(g["fr"], m["avg_position"])
    rows: dict[tuple[int, bool], dict] = {}
    for (rid, bk), g in grp.items():
        r = rows.setdefault((bk, g["comp"]), {"entity_rows": 0, "rids": set(), "tp": None, "own_bit": 0, **{k: 0 for k in MEAS}})
        r["entity_rows"] += g["n"]
        r["rids"].add(rid)
        r["own_bit"] = max(r["own_bit"], g["ob"])
        for k in MEAS:
            r[k] += g[k]
        if g["fr"] is not None:
            r["tp"] = g["fr"] if r["tp"] is None else min(r["tp"], g["fr"])
    ranked = [(r["tp"], bk) for (bk, comp), r in rows.items() if comp and bk != 0 and r["tp"] is not None]
    rk = {bk: 1 + sum(1 for t, _ in ranked if t < tp) for tp, bk in ranked}
    return {(bk, comp): {"own_bit": r["own_bit"], "entity_rows": r["entity_rows"], "rid_n": len(r["rids"]),
                         "rk": rk.get(bk, 0) if comp else 0, **{k: r[k] for k in MEAS}} for (bk, comp), r in rows.items()}


def answer_cols(rows: dict[tuple[int, bool], dict[str, int]]) -> dict[str, int]:
    """접힌 행 → 답변 당사 요약 열(적재기 _ig_own 과 같은 정의를 독립으로): 분모·당사 언급 = 경쟁 행, 순위 = 0 아닌 최소, 감성 = 당사 행 전부."""
    out = {"own_mask": 0, "ment_total": 0}
    for b in "hkg":
        for p in ("ment", "own_rk", "sent_pos", "sent_neg", "sent_all"):
            out[f"{p}_{b}"] = 0
    bit = {1: "h", 2: "k", 4: "g"}
    for (_bk, comp), r in rows.items():
        ob = r["own_bit"]
        if ob:
            out["own_mask"] |= ob
        if comp:
            out["ment_total"] += r["mention_count"]
        if ob in bit:
            b = bit[ob]
            if comp:
                out[f"ment_{b}"] += r["mention_count"]
            if r["rk"] > 0:
                out[f"own_rk_{b}"] = r["rk"] if not out[f"own_rk_{b}"] else min(out[f"own_rk_{b}"], r["rk"])
            out[f"sent_pos_{b}"] += r["s_pos"]
            out[f"sent_neg_{b}"] += r["s_neg"]
            out[f"sent_all_{b}"] += r["s_pos"] + r["s_neu"] + r["s_neg"] + r["s_mix"]
    return out


async def rows_of(c: asyncpg.Connection, src: str, answer_key: int) -> dict[tuple[int, bool], dict[str, int]]:
    """허브 행(src = rd: rd.job 위치의 rd 행, card: 카드 읽기 뷰, keep: 보관 표)을 오라클과 같은 모양으로."""
    q = {"rd": f"SELECT {HCOLS} FROM rd.job j JOIN rd.answer_brand b ON b.surface = j.surface AND b.round_date = j.round_date "
               "AND b.answer_key = j.answer_key WHERE j.answer_key = $1",
         "card": f"SELECT {HCOLS} FROM frz.card_answer_brand WHERE answer_key = $1",
         "keep": f"SELECT {HCOLS} FROM frz.keep_answer_brand WHERE answer_key = $1"}[src]
    return {(int(r["brand_key"]), r["competitive"]): {k: int(r[k]) for k in ROW_KEYS} for r in await c.fetch(q, answer_key)}
