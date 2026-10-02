"""생성 프롬프트 시드 조립·유사도(순수 함수, DB·LLM 없음).

이식 원본: front/lib/social-scraping/generate-context-prompts.ts buildSeeds(자동 '더 생성'),
          front/lib/social-scraping/selection-seeds.ts buildSelectionSeeds(구성 생성),
          front/lib/social-scraping/similarity.ts(문자 bigram 코사인, 임계 0.5).
seed_key(DB-v2.1 P14, UNIQUE(project_id, seed_key)): 현행 시드 id 형식을 유지하되 조건×조건 조합(l3-a:b)은 두 id 를 정렬해 정규화한다
(현행은 a:b 와 b:a 를 둘 다 검사했다, selection-seeds.ts:92). l3-<맥락>-<조건> 은 방향이 정해져 있어 그대로 둔다.
제외 집합 = 프로젝트의 모든 seed_key(삭제분 포함: 삭제해도 같은 시드가 다음 배치에 다시 나오지 않게).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

Layer = Literal["L1-context", "L2-condition", "L3-intersection"]
FUNNEL = ("awareness", "consideration", "purchase")

MAX_CONTEXTS, MAX_CONDITIONS, MAX_INTERSECTIONS = 6, 4, 4                     # 자동 배치 1회
MAX_SEL_CONTEXTS, MAX_SEL_CONDITIONS, MAX_SEL_COMBINATIONS, MAX_SEL_CROSSES = 10, 10, 10, 12   # 구성 1회
STRENGTH_WEIGHT = {"high": 3, "medium": 2, "low": 1}
SIMILARITY_THRESHOLD = 0.5


@dataclass(frozen=True)
class Seed:
    key: str
    layer: Layer
    source_label: str
    priority: int
    concept: str
    entity_ids: tuple[str, ...] = field(default=())


def js_round(x: float) -> int:
    return math.floor(x + 0.5)


def bucket_priority(value: int, mx: int) -> int:
    if mx <= 0:
        return 50
    return max(1, min(100, js_round(value / mx * 100)))


def bucket_strength(value: int, mx: int) -> str:
    if mx <= 0:
        return "low"
    r = value / mx
    return "high" if r >= 0.66 else "medium" if r >= 0.33 else "low"


def combo_key(a: str, b: str) -> str:
    x, y = sorted((str(a), str(b)))
    return f"l3-{x}:{y}"


def build_auto_seeds(pool: dict[str, list[dict[str, Any]]], exclude: set[str]) -> list[Seed]:
    """현행 buildSeeds: 맥락 6·조건 4·조합 4(조합 시드가 0이면 구동 관계로 대체). pool 행은 언급·동시출현 내림차순."""
    seeds: list[Seed] = []
    ctx = sorted(pool["contexts"], key=lambda c: -c["mention_count"])
    mx = ctx[0]["mention_count"] if ctx else 0
    for c in [c for c in ctx if f"l1-{c['id']}" not in exclude][:MAX_CONTEXTS]:
        seeds.append(Seed(f"l1-{c['id']}", "L1-context", c["name"], bucket_priority(c["mention_count"], mx), c["name"], (str(c["id"]),)))
    cond = sorted(pool["conditions"], key=lambda c: -c["mention_count"])
    mx = cond[0]["mention_count"] if cond else 0
    for c in [c for c in cond if f"l2-{c['id']}" not in exclude][:MAX_CONDITIONS]:
        seeds.append(Seed(f"l2-{c['id']}", "L2-condition", c["name"], bucket_priority(c["mention_count"], mx), c["name"], (str(c["id"]),)))
    combos = sorted(pool["combinations"], key=lambda c: -c["co_count"])
    mx = combos[0]["co_count"] if combos else 0
    for c in [c for c in combos if combo_key(c["cond_a"], c["cond_b"]) not in exclude][:MAX_INTERSECTIONS]:
        seeds.append(Seed(combo_key(c["cond_a"], c["cond_b"]), "L3-intersection", f"{c['a_name']} × {c['b_name']}",
                          bucket_priority(c["co_count"], mx), f"{c['a_name']} + {c['b_name']}", (str(c["cond_a"]), str(c["cond_b"]))))
    if not any(s.layer == "L3-intersection" for s in seeds):
        drives = sorted(pool["drives"], key=lambda d: -STRENGTH_WEIGHT.get(d["strength"], 0))
        for d in [d for d in drives if f"l3-{d['context_id']}-{d['condition_id']}" not in exclude][:MAX_INTERSECTIONS]:
            seeds.append(Seed(f"l3-{d['context_id']}-{d['condition_id']}", "L3-intersection", f"{d['context_name']} × {d['condition_name']}",
                              85 if STRENGTH_WEIGHT.get(d["strength"]) == 3 else 70, f"{d['context_name']} + {d['condition_name']}",
                              (str(d["context_id"]), str(d["condition_id"]))))
    return seeds


def build_selection_seeds(contexts: list[dict[str, Any]], conditions: list[dict[str, Any]], combinations: list[dict[str, Any]],
                          cross: bool, exclude: set[str]) -> tuple[list[Seed], int]:
    """현행 buildSelectionSeeds: 사용자가 고른 행 → 시드(항목별 상한, 맥락×조건 교차 12). (시드, 이미 생성돼 건너뛴 수)."""
    seeds: list[Seed] = []
    skipped = 0
    contexts, conditions, combinations = contexts[:MAX_SEL_CONTEXTS], conditions[:MAX_SEL_CONDITIONS], combinations[:MAX_SEL_COMBINATIONS]
    mx_ctx = max([0] + [c["mention_count"] for c in contexts])
    mx_cond = max([0] + [c["mention_count"] for c in conditions])
    for c in contexts:
        k = f"l1-{c['id']}"
        if k in exclude:
            skipped += 1
            continue
        seeds.append(Seed(k, "L1-context", c["name"], bucket_priority(c["mention_count"], mx_ctx), c["name"], (str(c["id"]),)))
    for c in conditions:
        k = f"l2-{c['id']}"
        if k in exclude:
            skipped += 1
            continue
        seeds.append(Seed(k, "L2-condition", c["name"], bucket_priority(c["mention_count"], mx_cond), c["name"], (str(c["id"]),)))
    for c in combinations:
        k = combo_key(c["a_id"], c["b_id"])
        if k in exclude:
            skipped += 1
            continue
        seeds.append(Seed(k, "L3-intersection", f"{c['a_name']} × {c['b_name']}", 80, f"{c['a_name']} + {c['b_name']}",
                          (str(c["a_id"]), str(c["b_id"]))))
    if cross:
        pairs = sorted(((x, y) for x in contexts for y in conditions), key=lambda t: -(t[0]["mention_count"] + t[1]["mention_count"]))
        crossed = 0
        for x, y in pairs:
            if crossed >= MAX_SEL_CROSSES:
                break
            k = f"l3-{x['id']}-{y['id']}"
            if k in exclude:
                skipped += 1
                continue
            seeds.append(Seed(k, "L3-intersection", f"{x['name']} × {y['name']}",
                              js_round((bucket_priority(x["mention_count"], mx_ctx) + bucket_priority(y["mention_count"], mx_cond)) / 2),
                              f"{x['name']} + {y['name']}", (str(x["id"]), str(y["id"]))))
            crossed += 1
    return seeds, skipped


def llm_prompt(seeds: list[Seed], brand: str | None, competitors: list[str], vehicles: list[str], keyword: str) -> str:
    """현행 buildLlmPrompt 그대로(브랜드 중립 질문, 시드마다 정확히 1개, seedId 되돌려 주기)."""
    brand_line = (f'The project tracks the brand "{brand}" in the {keyword} category.' if brand
                  else f"The project is in the {keyword} category.")
    comp = f" Competitors it monitors: {', '.join(competitors)}." if competitors else ""
    veh = f" Models of interest: {', '.join(vehicles)}." if vehicles else ""
    lines = "\n".join(f"- seedId={s.key} [{s.layer}] concept: {s.concept}" for s in seeds)
    return (f"\n{brand_line}{comp}{veh}\n\n"
            'You convert "purchase context" seeds into the underlying questions real people\n'
            "ask ChatGPT or AI chatbots when shopping in this category. Each seed is a buyer\n"
            "context, a purchase condition, or a combination of them.\n\n"
            "RULES:\n1. Produce EXACTLY one question per seed, echoing its seedId.\n"
            "2. Write questions the way people actually talk to AI (casual, short).\n"
            "3. Frame each question so it is relevant to this project's segment/competitors,\n"
            "   but keep every question BRAND-NEUTRAL: do NOT name any brand or model in the\n"
            "   question text (the point is to observe which brand an AI surfaces).\n"
            "4. Write in the same language as the seed concepts.\n"
            "5. Classify each into a funnelStage: awareness | consideration | purchase.\n\n"
            f"Seeds ({len(seeds)}):\n{lines}\n")


RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"prompts": {"type": "array", "items": {
        "type": "object",
        "properties": {"seedId": {"type": "string"}, "question": {"type": "string"},
                       "funnelStage": {"type": "string", "enum": list(FUNNEL)}},
        "required": ["seedId", "question", "funnelStage"], "additionalProperties": False}}},
    "required": ["prompts"], "additionalProperties": False}


def map_llm_output(seeds: list[Seed], data: dict[str, Any]) -> list[tuple[Seed, str, str | None]]:
    """LLM 응답 → (시드, 질문, 퍼널). 모르는 seedId·빈 질문은 버리고, 같은 시드는 첫 답만. 우선순위 내림차순."""
    by = {s.key: s for s in seeds}
    alias = {f"l3-{s.entity_ids[1]}:{s.entity_ids[0]}": s.key for s in seeds if s.key.startswith("l3-") and ":" in s.key}
    out: dict[str, tuple[Seed, str, str | None]] = {}
    for x in data.get("prompts") or []:
        if not isinstance(x, dict):
            continue
        sid = str(x.get("seedId") or "")
        s = by.get(sid) or by.get(alias.get(sid, ""))
        qt = x.get("question")
        if s is None or not isinstance(qt, str) or not qt.strip() or s.key in out:
            continue
        fs = x.get("funnelStage")
        out[s.key] = (s, qt.strip()[:1000], fs if fs in FUNNEL else None)
    return sorted(out.values(), key=lambda t: -t[0].priority)


def _norm(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isalnum())


def _bigrams(t: str) -> dict[str, int]:
    g: dict[str, int] = {}
    for i in range(len(t) - 1):
        g[t[i:i + 2]] = g.get(t[i:i + 2], 0) + 1
    return g


def text_similarity(a: str, b: str) -> float:
    na, nb = _norm(a), _norm(b)
    if len(na) < 2 or len(nb) < 2:
        return 1.0 if na == nb else 0.0
    ga, gb = _bigrams(na), _bigrams(nb)
    dot = sum(c * gb.get(k, 0) for k, c in ga.items())
    if dot == 0:
        return 0.0
    return dot / (math.sqrt(sum(c * c for c in ga.values())) * math.sqrt(sum(c * c for c in gb.values())))


def most_similar(question: str, existing: list[tuple[str, str]]) -> dict[str, Any] | None:
    """(텍스트, prompt|candidate) 중 임계 이상 최댓값. 정확히 같은 텍스트는 '추가됨' 상태라 제외(현행 annotateSimilar)."""
    best: dict[str, Any] | None = None
    for text, kind in existing:
        if text == question:
            continue
        s = text_similarity(question, text)
        if s >= SIMILARITY_THRESHOLD and (best is None or s > best["score"]):
            best = {"text": text, "score": round(s, 4), "kind": kind}
    return best
