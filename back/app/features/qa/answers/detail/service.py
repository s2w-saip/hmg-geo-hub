"""qa.answers.detail 업무 규칙: 검수 상세 낱알 전량(비서빙 job 포함: 멘션·인용·ACR·앵커/드롭).

- 존재·범위: rd.job(서버 검수 범위) 에 없으면 404(core.errors.not_found, IDOR 은폐와 같은 형태).
- 원문(rd.v_answer_body)이 없는 job(대기·실패)은 answer_text 등이 null 이다.
- 롤업 부모 이름: 같은 답변의 display_name 이 먼저, 없으면 rd.dim_entity.rep_name(현행 qa-review.ts:689-698 계승).
- is_own·is_excluded 는 registry_role('own'·'excluded') 로 판정한다.
- 인용 유효 분류 = 오버라이드 ?? 저장값(현행 qa-review.ts:717-738). 오버라이드 키 = host 소문자·www 제거.
- ACR 비율은 정수 쌍(Ratio)으로 낸다(P3): appearance_rate = appearance/valid_turn1, acr = overall_choice_share = choice/valid_acr.
- BG-46: 인용 url_norm·url_base_norm = rd.citation(서빙 답변만) ⋈ rd.dim_url 을 ord 로 붙인다(URL 없음은 null).
  rd.citation 행이 없는 인용(비서빙 = 비완료·드롭 job)은 원문 url 이 rd.dim_url 에 있으면(url_hash = sha256(url)) 그 저장값을,
  없으면 원문 url 에 적재기와 같은 정규화(core.urls.normalize_url_for_match·normalize_url_base_for_match = pg_temp.cit_norm·
  cit_base_norm 이식)를 적용해 채운다(검증 D-01·BG46-NONSERVED: 현행 미러 qa-review.ts:701 은 전 job 에 값이 있었다).
  ACR 셀에는 acr_cell_key 를 싣는다. answer.run_id·region·prompt_run_id 와 ACR 셀 prompt_run_id 는 ing 원값을 DB 뷰로 받는다
  (DB-v2.9 P63: rd.v_answer_body 끝 열·rd.v_acr_cell_run, back/CORE-REQUESTS/bg-qa-platform.md R1·R2, fe-u12 요청 2: 필드 이름 고정).
- app.prompt(16열)·app.citation_domain_override·app.citation_category·app.brand 는 qa_gate 가 읽는다(DB-v2.6 P47, qa R1).
- 원문 열람 감사(Q4)는 라우터가 성공 응답 뒤 core.write.access_audit_qa(kind data_access)로 남긴다.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.db import fetch_all, fetch_one
from app.core.envelope import ratio
from app.core.urls import normalize_url_base_for_match, normalize_url_for_match
from app.features.qa.answers.detail import queries as Q
from app.features.qa.answers.detail.schemas import (
    QaAcrCell,
    QaAcrChoice,
    QaAnchor,
    QaAnswerDetail,
    QaAnswerHead,
    QaCitation,
    QaDerived,
    QaDrop,
    QaMention,
    QaPrompt,
    QaPromptCatalog,
)
from app.features.qa.answers.list.scope import JOB_STATUS, assert_job_in_scope, coords, load_qa_refs, qa_meta

ACR_LEVELS = [1, 2, 3]


def norm_domain(host: str | None) -> str | None:
    if not host:
        return None
    h = host.strip().lower()
    return h[4:] if h.startswith("www.") else h


def _uuid(v: Any) -> uuid.UUID | None:
    return uuid.UUID(str(v)) if v is not None else None


async def _mentions(conn: AsyncConnection, k: int) -> list[QaMention]:
    rows = await fetch_all(conn, Q.MENTIONS_SQL, {"k": k})
    names = {str(r["entity_id"]): r["display_name"] for r in rows if r["entity_id"] is not None and r["display_name"]}
    missing = sorted({str(r["brand_rollup_entity_id"]) for r in rows
                      if r["brand_rollup_entity_id"] is not None and str(r["brand_rollup_entity_id"]) not in names})
    reps: dict[str, str | None] = {}
    if missing:
        reps = {str(x["entity_id"]): x["rep_name"] for x in await fetch_all(conn, Q.ENTITY_NAMES_SQL, {"ids": missing})}
    out = []
    for r in rows:
        rid = str(r["brand_rollup_entity_id"]) if r["brand_rollup_entity_id"] is not None else None
        role = r["registry_role"]
        out.append(QaMention(
            ord=int(r["ord"]), entity_id=_uuid(r["entity_id"]), display_name=r["display_name"], entity_type=r["entity_type"],
            mention_count=int(r["mention_count"] or 0), avg_position=float(r["avg_position"]) if r["avg_position"] is not None else None,
            surfaces=list(r["surfaces"]) if r["surfaces"] is not None else None, brand_rollup_entity_id=_uuid(r["brand_rollup_entity_id"]),
            rollup_parent_name=(names.get(rid) or reps.get(rid)) if rid else None, registry_role=role,
            is_own=role == "own", is_excluded=role == "excluded",
            **{c: int(r[c] or 0) for c in ("sentiment_positive", "sentiment_neutral", "sentiment_negative", "sentiment_mixed",
                                          "type_mention", "type_recommendation", "type_comparison", "type_definition", "type_final_choice")}))
    return out


async def _citation_urls(conn: AsyncConnection, job: dict[str, Any]) -> dict[int, dict[str, Any]]:
    """ord → {url_norm, url_base_norm}(BG-46). 비서빙 job 은 rd.citation 행이 없으므로 조회하지 않는다(_raw_url_norms 로 채움)."""
    if not bool(job["served"]):
        return {}
    k = int(job["answer_key"])
    cyc = await fetch_one(conn, Q.JOB_CYCLE_SQL, {"k": k})
    if cyc is None:
        return {}
    rows = await fetch_all(conn, Q.CITATION_URLS_SQL, {"s": int(job["surface"]), "rd": job["round_date"], "cyc": [int(cyc["cyc_key"])], "k": k})
    return {int(r["ord"]): r for r in rows}


def _raw_url_norms(r: dict[str, Any]) -> dict[str, str | None]:
    """rd.citation 행이 없는 인용(비서빙 job)의 정규화 URL. URL 없음은 null.

    1순위: 원문 url 이 rd.dim_url 에 있으면(url_hash 일치) 적재기가 저장한 값(검증 BG46-NONSERVED).
    2순위: dim_url 에 없는 URL 은 원문 url 에 적재기 정규화 식을 그대로 적용한다(검증 D-01)."""
    url = r["url"]
    if not url:
        return {}
    if r["hash_url_norm"] is not None or r["hash_url_base_norm"] is not None:
        return {"url_norm": r["hash_url_norm"], "url_base_norm": r["hash_url_base_norm"]}
    return {"url_norm": normalize_url_for_match(url), "url_base_norm": normalize_url_base_for_match(url)}


async def _citations(conn: AsyncConnection, k: int, job_id: uuid.UUID, job: dict[str, Any] | None = None) -> list[QaCitation]:
    rows = await fetch_all(conn, Q.CITATIONS_SQL, {"k": k})
    overrides: dict[str, str] = {}
    domains = sorted({d for d in (norm_domain(r["host"] or r["domain_label"]) for r in rows) if d})
    if domains:
        overrides = {x["domain"]: x["slug"] for x in await fetch_all(conn, Q.OVERRIDES_SQL, {"domains": domains})}
    urls = await _citation_urls(conn, job) if job is not None and rows else {}
    out = []
    for r in rows:
        dom = norm_domain(r["host"] or r["domain_label"])
        ov = overrides.get(dom) if dom else None
        u = urls.get(int(r["ord"])) or _raw_url_norms(r)
        out.append(QaCitation(ord=int(r["ord"]), target_key=f"{job_id}:{int(r['ord'])}", ref_index=r["ref_index"], url=r["url"],
                              title=r["title"], host=r["host"], domain=r["domain_label"], stored_category=r["scope_category"],
                              override_category=ov, effective_category=ov if ov is not None else r["scope_category"],
                              url_norm=u.get("url_norm"), url_base_norm=u.get("url_base_norm")))
    return out


async def _acr(conn: AsyncConnection, k: int) -> list[QaAcrCell]:
    cells = await fetch_all(conn, Q.ACR_CELLS_SQL, {"k": k})
    if not cells:
        return []
    choices = await fetch_all(conn, Q.ACR_CHOICES_SQL, {"levels": ACR_LEVELS, "cells": [int(c["acr_cell_key"]) for c in cells]})
    by_cell: dict[int, list[dict[str, Any]]] = {}
    for ch in choices:
        by_cell.setdefault(int(ch["acr_cell_key"]), []).append(ch)
    out = []
    for c in cells:
        vt1, vacr = int(c["valid_turn1"]), int(c["valid_acr"])
        out.append(QaAcrCell(
            acr_cell_key=int(c["acr_cell_key"]), prompt_run_id=_uuid(c["prompt_run_id"]), round_date=c["round_date"], planned=int(c["planned"]), valid_turn1=vt1, valid_acr=vacr,
            **{f: int(c[f]) for f in ("co_single", "co_conditional", "co_generic", "co_off_shortlist", "co_unresolved", "co_none")},
            is_rep=bool(c["is_rep"]),
            choices=[QaAcrChoice(
                level=int(ch["level"]), entity_id=_uuid(ch["entity_id"]), name=ch["rep_name"], brand=ch["brand"], parent_brand=ch["parent_brand"],
                entity_type=ch["entity_type"],
                **{f: int(ch[f]) for f in ("appearance", "choice", "cond_choice", "off_shortlist", "unresolved", "generic")},
                appearance_rate=ratio(ch["appearance"], vt1), acr=ratio(ch["choice"], vacr), overall_choice_share=ratio(ch["choice"], vacr))
                for ch in by_cell.get(int(c["acr_cell_key"]), [])]))
    return out


async def get_detail(conn: AsyncConnection, job_id: uuid.UUID) -> tuple[QaAnswerDetail, Any]:
    job = await assert_job_in_scope(conn, job_id)
    refs = await load_qa_refs(conn)
    k = int(job["answer_key"])
    body = await fetch_one(conn, Q.BODY_SQL, {"k": k}) or {}
    c = coords(job, refs)
    head = QaAnswerHead(
        job_id=job_id, surface=c.surface, brand=c.brand, country=c.country, engine=c.engine, lang=c.lang, round_date=job["round_date"],
        measured_at=job["measured_at"], job_status=JOB_STATUS.get(int(job["status_code"]), "other"), dropped=bool(job["dropped"]),
        served=bool(job["served"]), status=body.get("status"), analysis_status=body.get("analysis_status"),
        model_slug=body.get("model_slug"), answer_text=body.get("answer_text"), run_id=_uuid(body.get("run_id")),
        region=body.get("region"), prompt_run_id=_uuid(body.get("prompt_run_id")))

    pk = int(job["prompt_key"])
    p = await fetch_one(conn, Q.PROMPT_SQL, {"pk": pk}) if pk != 0 else None
    catalog = None
    if p is not None:
        cat = await fetch_one(conn, Q.CATALOG_SQL, {"pid": p["prompt_id"]})
        catalog = QaPromptCatalog(**cat) if cat else None
    prompt = QaPrompt(prompt_id=_uuid(p["prompt_id"]) if p else None, text=p["text"] if p else None, kind=p["kind"] if p else None,
                      lang=(p["lang"] or None) if p else None, funnel=p["funnel"] if p else None,
                      regions=list(p["regions"]) if p and p["regions"] is not None else None,
                      is_korean=bool(p["is_korean"]) if p else None, catalog=catalog)

    reg = await fetch_one(conn, Q.REGISTRY_SQL, {"k": k}) or {}
    derived = QaDerived(
        anchor=QaAnchor(anchor=reg["pin_anchor"], reason=reg.get("pin_reason"), source_measured_at=reg.get("pin_source_measured_at"))
        if reg.get("pin_anchor") is not None else None,
        drop=QaDrop(reason=reg.get("drop_reason"), dropped_at=reg.get("dropped_at"), source_measured_at=reg.get("drop_source_measured_at"))
        if reg.get("drop_reason") is not None or reg.get("dropped_at") is not None else None)

    detail = QaAnswerDetail(answer=head, prompt=prompt, mentions=await _mentions(conn, k),
                            citations=await _citations(conn, k, job_id, job), acr=await _acr(conn, k), derived=derived)
    return detail, qa_meta()
