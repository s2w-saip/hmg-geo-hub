"""admin.integrations.keyword_tools 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(현행 app/api/keyword/{volume,to-prompt,prompt-to-volume} 이식, DECISIONS-API Q13, 모듈-고객-관심 §2·§3)
- 검색량은 수집된 rd.kw_volume_monthly 에서 읽는다(최신 월 + 최근 12개월). 신선도 = 최근 관측(observed_at)이 7일 이내
  (현행 keyword_volume_cache SUCCESS_TTL 7일). 없거나 오래됐거나 force 면 judgment_change('dfs_fetch') 로 수집을 요청하고 202.
  같은 지역·언어의 대기·진행 중 검색량 수집(fetch volume·insight: insight 도 검색량을 포함한다)이 이미 가진 term 은 빼고 나머지만
  새로 요청한다(term 단위 dedupe, term_norm 기준 = subject_texts 겹침). 전부 겹치면 그 change_id 를 돌려준다.
  payload·주체 = core.contracts.DfsFetch(고객 관심 IN-1 과 한 벌): subject_texts = 정렬된 DB 정규화(app.term_norm, core.kw.db_term_norms),
  payload = {fetch: volume, terms(원문: sanitize 결과를 NFC 로), location_code, language_code, requested_via}. 수집·rd 반영은 적재기.
- 키워드 정규화·지역 프리셋은 core.kw(적재기와 한 벌).
- 키워드 → 프롬프트·프롬프트 → 키워드는 core.llm(OpenRouter) 호출(프롬프트 문구는 현행 그대로, 호출 상한 3분 = timeout_s 180).
  25개 초과면 10개씩 병렬 배치, 실패 배치는 빼고(현행 allSettled) 전부 실패하면 502 llm_failed(키 미설정은 503 llm_unavailable).
- 외부 호출(LLM)은 DB 커넥션 밖에서 한다(핸들러는 CurrentUserDetached): 검색량 읽기는 호출 뒤 RoSession(짧은 api_ro), 수집 요청 쓰기는
  get_db().write 짧은 트랜잭션.
"""
from __future__ import annotations

import asyncio
import logging
import unicodedata
from datetime import timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.db import RoOpener, fetch_all, fetch_val, get_db
from app.core.kw import DEFAULT_PRESET_ID, PRESET_LANGUAGES, db_term_norms, preset_by_id, preset_by_location, sanitize
from app.core.llm import LlmClient, LlmError, call_llm, llm_api_error
from app.core.write import enqueue_change

from . import queries
from .schemas import (
    FetchState,
    MonthlyVolume,
    PromptToVolumeBody,
    PromptToVolumeData,
    Question,
    Summary,
    ToPromptBody,
    ToPromptData,
    VolumeBody,
    VolumeData,
    VolumeItem,
)

log = logging.getLogger("hgh.admin.keyword_tools")
FRESH_DAYS = 7
LLM_TIMEOUT_S = 180.0                     # 현행 키워드 도구 호출 상한 3분(core.llm 기본 60초보다 길게)
BATCH_OVER = 25
BATCH_SIZE = 10
INTENTS = ("informational", "navigational", "transactional", "commercial")

QUESTIONS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"questions": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "originalInput": {"type": "string", "description": "Original input (Simple Keyword or KeywordList-Title-Description combinations)"},
            "question": {"type": "string", "description": "Natural question converted from the input"},
            "searchIntent": {"type": "string", "enum": list(INTENTS), "description": "Search intent classification"}},
        "required": ["originalInput", "question", "searchIntent"], "additionalProperties": False}}},
    "required": ["questions"], "additionalProperties": False}

KEYWORDS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"keywords": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 2}},
    "required": ["keywords"], "additionalProperties": False}


# ── 지역 ──
def resolve_location(country: str | None, location_code: int | None, language_code: str | None) -> tuple[int, str]:
    if country is not None:
        pr = preset_by_id(country)
        if pr is None:
            raise errors.unprocessable("알 수 없는 지역 프리셋", code="unknown_location", details={"field": "country"})
    elif location_code is not None:
        pr = preset_by_location(location_code)
        if pr is None:
            raise errors.unprocessable("지원하지 않는 location_code(프리셋 밖)", code="unknown_location", details={"field": "location_code"})
    else:
        pr = preset_by_id(DEFAULT_PRESET_ID)
    assert pr is not None
    if not language_code:
        return pr.location_code, pr.language_code
    # 언어는 프리셋 언어 집합만(대소문자 무시, 정본 표기로 맞춤). 형식이 틀린 값('a:b:c' 등)이 유료 수집 요청·주체에 실리지 않게 한다(검증 D4)
    lang = PRESET_LANGUAGES.get(language_code.strip().lower())
    if lang is None:
        raise errors.unprocessable("지원하지 않는 language_code(프리셋 언어 밖)", code="unknown_language",
                                   details={"field": "language_code", "allowed": sorted(set(PRESET_LANGUAGES.values()))})
    return pr.location_code, lang


# ── 검색량 조회 + 수집 요청 ──
async def _enqueue_fetch(p: Principal, terms: dict[str, str], loc: int, lang: str, via: str) -> FetchState:
    """terms = {term_norm: 원문}. term 단위 dedupe: 같은 지역·언어의 대기·진행 중 검색량 수집(volume·insight)이 이미 가진 term(주체
    term_norm)은 빼고 나머지만 새로 요청한다(검증 D4). 전부 겹치면 새 요청 없이 pending(가장 이른 change_id). 일부만 겹치면 queued +
    겹친 term·요청을 pending_* 에 싣는다. 응답의 terms·pending_terms 는 term_norm."""
    norms = sorted(terms)
    try:
        async with get_db().write(p.user_id) as rw:
            covered: dict[str, int] = {}
            for r in await fetch_all(rw, queries.PENDING_OVERLAP_SQL, {"loc": str(loc), "lang": lang, "norms": norms}):
                for n in r["subject_texts"] or []:
                    covered.setdefault(n, int(r["change_id"]))
            hit = [n for n in norms if n in covered]
            rest = [n for n in norms if n not in covered]
            pend_ids = sorted({covered[n] for n in hit})
            if not rest:
                return FetchState(status="pending", change_id=pend_ids[0], terms=norms, pending_terms=hit, pending_change_ids=pend_ids)
            # 같은 주체라도 지역·언어·종류가 다르면 다른 요청이다(주체에 지역 접두가 없다: core.contracts dfs_fetch)
            cid = await enqueue_change(rw, "dfs_fetch", subject_texts=rest,
                                       dedupe_key={"fetch": "volume", "location_code": loc, "language_code": lang},
                                       payload={"fetch": "volume", "terms": [unicodedata.normalize("NFC", terms[n]) for n in rest],
                                                "location_code": loc, "language_code": lang, "requested_via": via})
        return FetchState(status="queued", change_id=cid, terms=rest, pending_terms=hit, pending_change_ids=pend_ids)
    except errors.ApiError as e:
        if e.code == "duplicate_pending" and isinstance(e.details, dict):
            return FetchState(status="pending", change_id=e.details.get("change_id"), terms=norms)
        raise


async def lookup_volumes(ro: AsyncConnection, p: Principal, keywords: list[str], loc: int, lang: str, *, force: bool,
                         via: str) -> tuple[list[VolumeItem], list[str], FetchState]:
    cleaned = [s for s in (sanitize(k) for k in keywords) if s]
    nm = await db_term_norms(ro, cleaned)                    # 정규화 정본 = DB app.term_norm(검증 m-5): 조회·중복 주체 모두
    pairs: dict[str, str] = {}
    for s in cleaned:
        pairs.setdefault(nm[s], s)
    if not pairs:
        raise errors.unprocessable("유효한 키워드가 없다(괄호·쉼표 제거 후 1~99자)", code="no_keywords", details={"field": "keywords"})
    rows = await fetch_all(ro, queries.VOLUMES_SQL, {"terms": sorted(pairs), "loc": loc, "lang": lang})
    now = await fetch_val(ro, queries.NOW_SQL)
    by: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by.setdefault(r["term_norm"], []).append(r)
    items, missing, refetch = [], [], []
    for norm, disp in pairs.items():
        rs = by.get(norm)
        if not rs:
            missing.append(norm)
            refetch.append(norm)
            continue
        observed = max(r["observed_at"] for r in rs)
        fresh = now - observed <= timedelta(days=FRESH_DAYS)
        if force or not fresh:
            refetch.append(norm)
        top = rs[0]
        items.append(VolumeItem(keyword=disp, term_norm=norm, search_volume=top["search_volume"], competition_index=top["competition_index"],
                                competition=top["competition"], cpc=float(top["cpc"]) if top["cpc"] is not None else None, month=top["month"],
                                monthly_searches=[MonthlyVolume(month=r["month"], search_volume=r["search_volume"]) for r in rs[:12]],
                                observed_at=observed, freshness="fresh" if fresh else "stale"))
    items.sort(key=lambda i: (-(i.search_volume or 0), i.term_norm))
    fetch = await _enqueue_fetch(p, {n: pairs[n] for n in refetch}, loc, lang, via) if refetch else FetchState(status="fresh")
    return items, missing, fetch


def _summary(requested: int, items: list[VolumeItem]) -> Summary:
    vols = [i.search_volume or 0 for i in items]
    return Summary(requested=requested, found=len(items), total_search_volume=sum(vols),
                   avg_search_volume=round(sum(vols) / len(vols)) if vols else None)


async def volume(ro: AsyncConnection, p: Principal, body: VolumeBody) -> VolumeData:
    loc, lang = resolve_location(body.country, body.location_code, body.language_code)
    items, missing, fetch = await lookup_volumes(ro, p, body.keywords, loc, lang, force=body.force, via="admin.keyword_tools.volume")
    return VolumeData(location_code=loc, language_code=lang, keywords=items, missing=missing,
                      summary=_summary(len(items) + len(missing), items), fetch=fetch)


# ── LLM(core.llm: 실패 = 503 llm_unavailable · 502 llm_failed) ──
def questions_prompt(items: list[str]) -> str:
    """현행 generateNaturalQuestions 프롬프트(문구 그대로)."""
    n = len(items)
    listing = "\n".join(f"{i + 1}. {k}" for i, k in enumerate(items))
    return f"""
You MUST convert ALL {n} input items into natural questions. Do not skip any items.

Convert the following input items into underlying questions that people would actually ask ChatGPT or AI chatbots.

The input can be in two different formats:

1. **Simple keywords** (e.g., "electric car", "smartphones", "notion app")
   - Convert these into underlying questions that someone searching for this keyword would have
   - Focus on what the person really wants to know when they search for this term

2. **KeywordList-Title-Description combinations** (e.g., "[노션 사용법,노션 튜토리얼,notion guide]-노션 쓰는 방법 - 완벽한 노션 사용 가이드")
   - Format: "[keyword1,keyword2,keyword3]-Title - Description"
   - This represents a web document (Title-Description) that ranks for multiple keywords in SERP
   - The keywords inside the brackets are what this document ranks for
   - Create an underlying question that encompasses the intent behind these ranking keywords and the document content
   - Focus on the underlying question that connects the ranking keywords with the document's purpose
   - Try to include the one of the keywords in the question naturally, but do not force them in if it doesn't fit

CRITICAL REQUIREMENTS:
1. You MUST process ALL {n} input items below
2. Generate EXACTLY {n} questions (one for each input)
3. Make them sound like how people actually talk to AI (casual, informal, short)
4. Understand the underlying search intent behind each item and convert appropriately
5. Search intent categories: informational, navigational, transactional, commercial
6. For KeywordList-Title-Description format, analyze both the ranking keywords and the document content to understand the underlying user intent
7. Focus on the core underlying intent rather than trying to include every detail
8. Make sure all questions are in same language as the Inputs and contain NO brand names

Input list ({n} items):
{listing}

IMPORTANT: Your response must contain exactly {n} questions, one for each numbered input item above.
"""


def keywords_prompt(prompt_text: str) -> str:
    """현행 prompt-to-volume 시스템 프롬프트(문구 그대로)."""
    return f"""Convert the given user prompt into Google search keywords that would help find the information the user is looking for.

Instructions:
- Analyze what the user is trying to find or learn from their prompt
- Convert it into 1-2 relevant Google search keywords in the SAME LANGUAGE as the prompt
- If the prompt is in Korean, return Korean keywords
- If the prompt is in English, return English keywords
- Focus on keywords that have reasonable search volume (not too long-tail)
- Include both broad and moderately specific keywords
- Think about what someone would actually type into Google to find this information

User Prompt: {prompt_text}"""


def _parse_questions(data: dict[str, Any]) -> list[dict[str, str]]:
    qs = data.get("questions")
    if not isinstance(qs, list):
        raise LlmError("invalid", "questions 없음")
    out = []
    for q in qs:
        if not isinstance(q, dict) or q.get("searchIntent") not in INTENTS or not isinstance(q.get("question"), str) \
                or not isinstance(q.get("originalInput"), str):
            raise LlmError("invalid", "question 항목 형식 오류")
        out.append({"original_input": q["originalInput"], "question": q["question"], "search_intent": q["searchIntent"]})
    return out


async def _questions(llm: LlmClient, items: list[str]) -> list[dict[str, str]]:
    """배치 하나(실패는 LlmError 로 올려 호출자가 배치 단위로 센다)."""
    data = await llm.complete_json(questions_prompt(items), QUESTIONS_SCHEMA, temperature=0.5, max_tokens=20000, timeout_s=LLM_TIMEOUT_S)
    return _parse_questions(data)


def attach_volume(original: str, vmap: dict[str, int] | None) -> int | None:
    """현행 attachVolumes: 대소문자·공백 정규화 맵, '[kw1,kw2]-제목' 행은 괄호 안 키워드 볼륨 합."""
    if not vmap:
        return None
    norm = {k.strip().lower(): v for k, v in vmap.items()}
    if original.startswith("[") and "]-" in original:
        total, hit = 0, False
        for kw in original.split("]-")[0][1:].split(","):
            v = norm.get(kw.strip().lower())
            if v is not None:
                total += v
                hit = True
        return total if hit else None
    return norm.get(original.strip().lower())


async def to_prompt(llm: LlmClient, body: ToPromptBody) -> ToPromptData:
    limited = body.keywords[: body.max_questions]
    failed = 0
    try:
        if len(body.keywords) > BATCH_OVER:
            batches = [limited[i:i + BATCH_SIZE] for i in range(0, len(limited), BATCH_SIZE)]
            res = await asyncio.gather(*(_questions(llm, b) for b in batches), return_exceptions=True)
            qs: list[dict[str, str]] = []
            for r in res:
                if isinstance(r, BaseException):
                    if not isinstance(r, LlmError):
                        raise r
                    failed += 1
                    log.warning("키워드→프롬프트 배치 실패: %s", r.kind)
                else:
                    qs.extend(r)
            if failed == len(batches):                   # 기한 초과가 섞였으면 그것(504)을 올린다: 다시 보내도 같은 기한에 걸린다
                errs = [r for r in res if isinstance(r, LlmError)]
                raise next((r for r in errs if r.kind == "deadline"), errs[0])
        else:
            qs = await _questions(llm, limited)
    except LlmError as e:
        raise llm_api_error(e) from e
    questions = [Question(**q, volume=attach_volume(q["original_input"], body.keyword_volume_map)) for q in qs]
    return ToPromptData(questions=questions, total_questions=len(questions), source_keywords=len(body.keywords), failed_batches=failed)


async def prompt_to_volume(open_ro: RoOpener, p: Principal, llm: LlmClient, body: PromptToVolumeBody) -> PromptToVolumeData:
    """LLM 호출(커넥션 없음) → 짧은 api_ro 로 검색량 읽기(+ 부족분 수집 요청 쓰기)."""
    loc, lang = resolve_location(body.country, body.location_code, body.language_code)
    data = await call_llm(llm, keywords_prompt(body.prompt_text), KEYWORDS_SCHEMA, temperature=0.3, max_tokens=200,
                          timeout_s=LLM_TIMEOUT_S)
    kws = data.get("keywords")
    if not isinstance(kws, list) or not all(isinstance(k, str) for k in kws):
        raise llm_api_error(LlmError("invalid", "keywords 형식 오류"))
    kws = [k for k in kws if sanitize(k)][:2]
    if not kws:
        return PromptToVolumeData(volume=None, keywords=[], location_code=loc, language_code=lang, volumes=[], fetch=FetchState(status="fresh"))
    async with open_ro() as ro:
        items, _missing, fetch = await lookup_volumes(ro, p, kws, loc, lang, force=body.force, via="admin.keyword_tools.prompt_to_volume")
    top = max((i.search_volume or 0 for i in items), default=0)
    return PromptToVolumeData(volume=top if top > 0 else None, keywords=kws, location_code=loc, language_code=lang, volumes=items,
                              fetch=fetch)
