"""intent.keywords.serp_drafts 업무 규칙: SERP 행 LLM 프롬프트 초안(현행 lib/keyword/insight.ts draftPrompts 이식).

3단 구조(core.db 규약): 읽기(RoSession 짧은 api_ro 트랜잭션, 끝나면 반납) → LLM(core.llm, 커넥션 없음) →
쓰기(api_rw 짧은 트랜잭션, app.kw_prompt_draft 만). 계정은 CurrentUserDetached 가 자체 짧은 트랜잭션에서 읽는다.
- 대상: ranks 생략 = 초안이 하나도 없는 상위 8행(현행 MAX_SERP_ROWS), 지정 = 그 행 재생성(gen = 기존 max + 1).
- LLM 입력 = "[term]-title - snippet" 400자 절단(현행 형식 그대로), 출력은 originalInput 으로 매칭하고 없으면 순서로.
  현행은 실패 시 term 으로 폴백해 저장했지만 여기서는 저장하지 않는다(초안 없음 = suggested_prompt null, 화면 폴백은 프론트).
- LLM 실패는 core.llm.call_llm 이 503 llm_unavailable(키 미설정)·502 llm_failed 로 바꾼다. 비용 기록 없음(모듈-고객-관심 열린 질문 4).
- 권한: project_id 가 있으면 메뉴 project + core.auth.resolve_project(operate) + SERP 가 그 프로젝트 추적 키워드(유효 국가)와 일치.
  아니면(없거나 불일치) 메뉴 standard + admin·전역 운영자 + 그 SERP 국가가 스코프 안(검증 D3·D5).
- kw_prompt_draft 는 판정 입력이 아니다(judgment_change 없음). 동시 생성이 같은 gen 을 노리면 PK 충돌로 건너뛴다.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import auth, errors
from app.core.auth import Principal
from app.core.codes import load_refs
from app.core.db import RoOpener, fetch_all, get_db
from app.core.kw import preset_by_location
from app.core.llm import LlmClient, call_llm
from app.features.intent.keywords.research.intent_common import require_global_operator
from app.features.intent.keywords.research.service import project_tracked
from app.features.intent.keywords.serp_drafts import queries as q
from app.features.intent.keywords.serp_drafts.schemas import Draft, DraftIn, DraftResult

MAX_SERP_ROWS = 8
INPUT_MAX = 400

QUESTIONS_SCHEMA: dict[str, Any] = {   # 현행 keyword-to-prompt.ts QUESTIONS_SCHEMA 그대로
    "type": "object",
    "properties": {"questions": {"type": "array", "items": {
        "type": "object",
        "properties": {"originalInput": {"type": "string"}, "question": {"type": "string"},
                       "searchIntent": {"type": "string", "enum": ["informational", "navigational", "transactional", "commercial"]}},
        "required": ["originalInput", "question", "searchIntent"], "additionalProperties": False}}},
    "required": ["questions"], "additionalProperties": False}


def build_prompt(inputs: list[str]) -> str:
    """현행 generateNaturalQuestions 프롬프트 요지(모든 입력 1:1 변환, 입력 언어 유지, 브랜드명 금지)."""
    n = len(inputs)
    lines = "\n".join(f"{i + 1}. {x}" for i, x in enumerate(inputs))
    return (f"You MUST convert ALL {n} input items into natural questions. Do not skip any items.\n\n"
            "Convert the following input items into underlying questions that people would actually ask ChatGPT or AI chatbots.\n"
            "Each input is a KeywordList-Title-Description combination \"[keyword]-Title - Description\" describing a web document "
            "that ranks for the keyword in Google SERP. Create the underlying question that connects the keyword with the "
            "document's purpose. Include the keyword naturally only if it fits.\n\n"
            "CRITICAL REQUIREMENTS:\n"
            f"1. Generate EXACTLY {n} questions (one for each input), echoing each input verbatim as originalInput\n"
            "2. Casual, informal, short, the way people talk to AI\n"
            "3. Search intent: informational, navigational, transactional, commercial\n"
            "4. Same language as the inputs and NO brand names\n\n"
            f"Input list ({n} items):\n{lines}\n")


def make_input(term: str, title: str | None, snippet: str | None) -> str:
    return f"[{term}]-{title or ''} - {snippet or ''}"[:INPUT_MAX]


async def plan(conn: AsyncConnection, p: Principal, body: DraftIn) -> list[dict[str, Any]]:
    """권한 확인 + 대상 행 선정(api_ro).
    project_id 있음 = 메뉴 project + resolve_project(operate), 그리고 그 SERP 의 (키워드, location, language)가 프로젝트 추적 키워드
    (유효 국가 포함)와 맞아야 프로젝트 권한으로 허용한다. 안 맞거나 project_id 없음 = 메뉴 standard + admin·전역 운영자 + 국가 스코프
    (검증 D3·D5: 배정 운영자가 자기 프로젝트 id 로 무관한 국가 SERP 의 전역 초안을 쓰지 못하게)."""
    refs = await load_refs(conn)
    acc = None
    if body.project_id is not None:
        auth.require_surface(p, "project")          # 역할 천장 PROJECT_VIEWERS + 메뉴 project(검증 m-7)
        acc = await auth.resolve_project(conn, p, refs, body.project_id, "operate")
    rows = await fetch_all(conn, q.SERP_ROWS, {"cid": body.serp_call_id})
    if not rows:
        raise errors.not_found("SERP 호출 없음")
    head = rows[0]
    bound = acc is not None and any(
        n == head["term_norm"] and pr.location_code == head["location_code"] and pr.language_code == head["language_code"]
        for n, pr in await project_tracked(conn, acc))
    if not bound:
        preset = preset_by_location(head["location_code"])
        require_global_operator(p, refs, preset if preset is not None and preset.language_code == head["language_code"] else None)
    if body.ranks:
        by_rank = {int(r["rank"]): r for r in rows}
        unknown = sorted({x for x in body.ranks if x not in by_rank})
        if unknown:
            raise errors.unprocessable("SERP 에 없는 순위", code="unknown_rank", details={"field": "ranks", "value": unknown})
        return [by_rank[x] for x in dict.fromkeys(body.ranks)]
    return [r for r in rows[:MAX_SERP_ROWS] if r["max_gen"] is None]


async def generate(llm: LlmClient, rows: list[dict[str, Any]]) -> dict[int, str]:
    """LLM 1회(커넥션 없음). rank → 초안."""
    inputs = [make_input(r["term"], r["title"], r["snippet"]) for r in rows]
    data = await call_llm(llm, build_prompt(inputs), QUESTIONS_SCHEMA, temperature=0.5, max_tokens=20000)
    qs = data.get("questions")
    if not isinstance(qs, list):
        raise errors.upstream("LLM 응답 형식 오류", code="llm_failed")
    by_input = {x.get("originalInput"): x.get("question") for x in qs if isinstance(x, dict)}
    out: dict[int, str] = {}
    for i, (r, inp) in enumerate(zip(rows, inputs, strict=True)):
        qtext = by_input.get(inp)
        if not qtext and i < len(qs) and isinstance(qs[i], dict):
            qtext = qs[i].get("question")
        if isinstance(qtext, str) and qtext.strip():
            out[int(r["rank"])] = qtext.strip()[:1000]
    return out


async def save(p: Principal, call_id: int, drafts: dict[int, str], model: str) -> list[Draft]:
    if not drafts:
        return []
    ranks = sorted(drafts)
    async with get_db().write(p.user_id) as rw:
        rs = await fetch_all(rw, q.INSERT, {"cid": call_id, "ranks": ranks, "prompts": [drafts[r] for r in ranks], "model": model})
    return [Draft(**r) for r in sorted(rs, key=lambda x: x["rank"])]


async def run(open_ro: RoOpener, llm: LlmClient, p: Principal, body: DraftIn) -> DraftResult:
    """읽기 트랜잭션은 plan 까지만 열고 닫는다(LLM 을 기다리는 동안 api_ro 커넥션을 쥐지 않는다, core.db 규약)."""
    async with open_ro() as conn:
        rows = await plan(conn, p, body)
    if not rows:
        return DraftResult(serp_call_id=body.serp_call_id, drafts=[], skipped_count=0)
    drafts = await generate(llm, rows)
    saved = await save(p, body.serp_call_id, drafts, llm.model)
    return DraftResult(serp_call_id=body.serp_call_id, drafts=saved, skipped_count=len(rows) - len(saved))
