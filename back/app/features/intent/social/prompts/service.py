"""intent.social.prompts 업무 규칙: 컨텍스트 맵 시드 → LLM 생성 프롬프트(프로젝트 로컬 생성물, 판정 입력 아님).

3단 구조(core.db 규약, 모듈-고객-관심 consistency_fixes): 권한·시드·제외 집합 읽기(RoSession 짧은 api_ro 트랜잭션, 끝나면 반납) →
LLM(core.llm, 커넥션 없음) →
INSERT … ON CONFLICT (project_id, seed_key) DO NOTHING(api_rw 짧은 트랜잭션). 통 JSON 낙관적 락(현행 0030) 대신 seed_key 유니크가
동시 생성 중복 방지선이다(DB-v2.1 P14). 동시 생성과 겹쳐 버려진 행은 skipped_existing 에 더한다.
- more: 현행 buildSeeds(맥락 6·조건 4·조합 4, 조합이 없으면 구동 관계). 남은 시드가 없으면 exhausted.
- selected: 현행 buildSelectionSeeds(id 는 서버가 스냅샷에서 다시 해석, 모르는 id 는 무시). origin = composed.
- 삭제: removed_at 소프트 삭제. seed_key 는 제외 집합에 남아 같은 시드가 다시 생성되지 않는다.
- similar_to: 조회할 때 app.prompt(삭제 제외)·app.prompt_candidate 텍스트와 bigram 코사인(저장 안 함).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import auth, errors
from app.core.auth import Principal
from app.core.codes import load_refs
from app.core.config import get_settings
from app.core.db import RoOpener, fetch_all, get_db
from app.core.llm import LlmClient, call_llm
from app.features.intent.social.context_map import queries as cq
from app.features.intent.social.context_map.service import active_snapshot
from app.features.intent.social.prompts import queries as q
from app.features.intent.social.prompts import seeds as sd
from app.features.intent.social.prompts.schemas import GeneratedPrompt, GenerateIn, GenerateOut, SimilarTo

POOL_CONTEXTS, POOL_CONDITIONS, POOL_COMBINATIONS = 150, 200, 500     # 현행 getSeedPool 기본값
MAX_REMOVE = 100


async def existing_texts(conn: AsyncConnection, project_id: uuid.UUID) -> list[tuple[str, str]]:
    return [(r["text"], r["kind"]) for r in await fetch_all(conn, q.EXISTING_TEXTS, {"pid": project_id})]


def to_model(r: dict[str, Any], existing: list[tuple[str, str]]) -> GeneratedPrompt:
    sim = sd.most_similar(r["text"], existing)
    return GeneratedPrompt(prompt_id=r["prompt_id"], seed_key=r["seed_key"], question=r["text"], layer=r["layer"],
                           funnel_stage=r["funnel_stage"], source_label=r["source_label"], priority=r["priority"], origin=r["origin"],
                           batch_no=r["batch_no"], model=r["model"], generated_at=r["generated_at"],
                           similar_to=SimilarTo(**sim) if sim else None)


async def list_prompts(conn: AsyncConnection, project_id: uuid.UUID) -> list[GeneratedPrompt]:
    rows = await fetch_all(conn, q.LIST, {"pid": project_id})
    ex = await existing_texts(conn, project_id) if rows else []
    return [to_model(r, ex) for r in rows]


async def _seed_pool(conn: AsyncConnection, snap: int) -> dict[str, list[dict[str, Any]]]:
    ctx = await fetch_all(conn, cq.POOL_ENTITIES, {"s": snap, "t": "ConsumerContext", "n": POOL_CONTEXTS})
    cond = await fetch_all(conn, cq.POOL_ENTITIES, {"s": snap, "t": "ConsumerRequirement", "n": POOL_CONDITIONS})
    cond_ids = [str(c["id"]) for c in cond]
    ctx_ids = [str(c["id"]) for c in ctx]
    combos = await fetch_all(conn, cq.POOL_COMBINATIONS, {"s": snap, "ids": cond_ids, "n": POOL_COMBINATIONS}) if cond_ids else []
    drives = await fetch_all(conn, cq.POOL_DRIVES, {"s": snap, "ctx": ctx_ids, "cond": cond_ids}) if ctx_ids and cond_ids else []
    names = {str(e["id"]): e["name"] for e in [*ctx, *cond]}
    mx = max([1] + [int(d["co_count"]) for d in drives])
    return {"contexts": ctx, "conditions": cond, "combinations": combos,
            "drives": [{"context_id": d["context_id"], "condition_id": d["requirement_id"],
                        "context_name": names.get(str(d["context_id"]), str(d["context_id"])),
                        "condition_name": names.get(str(d["requirement_id"]), str(d["requirement_id"])),
                        "strength": sd.bucket_strength(int(d["co_count"]), mx)} for d in drives]}


async def _selection_seeds(conn: AsyncConnection, snap: int, body: GenerateIn, exclude: set[str]) -> tuple[list[sd.Seed], int]:
    sel = body.selection
    if sel is None:
        raise errors.unprocessable("selected 모드는 selection 필수", details={"field": "selection"})
    ids = list(dict.fromkeys([*map(str, sel.context_ids), *map(str, sel.condition_ids),
                              *(str(x) for c in sel.combinations for x in (c.cond_a_id, c.cond_b_id))]))
    if not ids:
        raise errors.unprocessable("선택된 항목이 없다", details={"field": "selection"})
    rows = await fetch_all(conn, cq.ENTITY_SEEDS, {"s": snap, "ids": ids})
    by = {str(r["id"]): r for r in rows}

    def pick(i: uuid.UUID, t: str) -> dict[str, Any] | None:
        r = by.get(str(i))
        return {"id": str(r["id"]), "name": r["name"], "mention_count": int(r["mention_count"])} if r and r["type"] == t else None

    ctx = [x for x in (pick(i, "ConsumerContext") for i in sel.context_ids) if x]
    cond = [x for x in (pick(i, "ConsumerRequirement") for i in sel.condition_ids) if x]
    combos = []
    for c in sel.combinations:
        a, b = pick(c.cond_a_id, "ConsumerRequirement"), pick(c.cond_b_id, "ConsumerRequirement")
        if a and b:
            combos.append({"a_id": a["id"], "a_name": a["name"], "b_id": b["id"], "b_name": b["name"]})
    return sd.build_selection_seeds(ctx, cond, combos, sel.cross, exclude)


async def plan(conn: AsyncConnection, project_id: uuid.UUID, brand_code: str | None, body: GenerateIn) -> tuple[list[sd.Seed], int, str]:
    """(시드, 건너뛴 수, LLM 프롬프트). api_ro 에서 스냅샷·제외 집합·브랜드 문맥을 읽는다. 산업 라벨 = core.config context_map_keyword."""
    snap = await active_snapshot(conn)
    if snap is None:
        raise errors.conflict("no_active_snapshot", "활성 컨텍스트 맵 스냅샷 없음(준비 중)")
    sid = int(snap["snapshot_id"])
    exclude = {r["seed_key"] for r in await fetch_all(conn, q.SEED_KEYS, {"pid": project_id})}
    if body.mode == "more":
        seeds, skipped = sd.build_auto_seeds(await _seed_pool(conn, sid), exclude), 0
    else:
        seeds, skipped = await _selection_seeds(conn, sid, body, exclude)
    comps = [r["brand_name"] for r in await fetch_all(conn, q.COMPETITORS, {"pid": project_id})]
    vehs = [f"{r['brand']} {r['model']}" for r in await fetch_all(conn, q.VEHICLES, {"pid": project_id})]
    return seeds, skipped, sd.llm_prompt(seeds, brand_code, comps, vehs, get_settings().context_map_keyword)


async def generate(open_ro: RoOpener, llm: LlmClient, p: Principal, project_id: uuid.UUID, body: GenerateIn) -> GenerateOut:
    """읽기 트랜잭션(권한 operate·시드)은 LLM 전에 닫는다(LLM 을 기다리는 동안 api_ro 커넥션을 쥐지 않는다)."""
    async with open_ro() as conn:
        acc = await auth.resolve_project(conn, p, await load_refs(conn), project_id, "operate")
        seeds, skipped, prompt = await plan(conn, acc.project_id, acc.brand_code, body)
    if not seeds:
        return GenerateOut(prompts=[], exhausted=body.mode == "more", skipped_existing=skipped)
    data = await call_llm(llm, prompt, sd.RESPONSE_SCHEMA, temperature=0.5, max_tokens=8000)
    fresh = sd.map_llm_output(seeds, data)
    if not fresh:
        return GenerateOut(prompts=[], exhausted=False, skipped_existing=skipped)
    origin = "composed" if body.mode == "selected" else None
    async with get_db().write(p.user_id) as rw:
        rows = await fetch_all(rw, q.INSERT, {
            "pid": acc.project_id, "model": llm.model, "origin": origin,
            "ids": [",".join(s.entity_ids) for s, _, _ in fresh], "texts": [t for _, t, _ in fresh],
            "labels": [s.source_label for s, _, _ in fresh], "layers": [s.layer for s, _, _ in fresh],
            "funnels": [f for _, _, f in fresh], "priorities": [s.priority for s, _, _ in fresh], "keys": [s.key for s, _, _ in fresh]})
        ex = await existing_texts(rw, acc.project_id)
    rank = {s.key: i for i, (s, _, _) in enumerate(fresh)}
    rows.sort(key=lambda r: rank.get(r["seed_key"], 0))
    return GenerateOut(prompts=[to_model(r, ex) for r in rows], exhausted=False, skipped_existing=skipped + len(fresh) - len(rows))


async def remove(rw: AsyncConnection, project_id: uuid.UUID, ids: list[uuid.UUID]) -> int:
    uniq = list(dict.fromkeys(ids))
    if not 1 <= len(uniq) <= MAX_REMOVE:
        raise errors.unprocessable(f"ids 는 1~{MAX_REMOVE}건", details={"field": "ids"})
    return len(await fetch_all(rw, q.REMOVE, {"pid": project_id, "ids": [str(i) for i in uniq]}))
