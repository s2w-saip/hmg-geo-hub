"""Scope job 응답 → ing 스테이지 행(판정 없음, 원본 그대로) · content_hash.

매핑 근거(현행 appendJobRows lib/scope/mirror/sync.ts:1250-1340, ACR collectAcrPromptRuns·acrRollupRows :1100-1216)
  ing.answer            job 본문·status·measured_at·analysis.status·analysis_version·quality_breakdown·result.answer_text·model_slug
  ing.mention           analysis.resolved_mentions[] 배열 순서 ord 1..n (현행 미러의 canonicalize·대소문자 보정은 판정이라 여기서 하지 않는다)
  ing.mention_occurrence resolved_mentions[].occurrences[] 를 job 안 순번 ord 1..n
  ing.answer_stance     analysis.brand_stances[] ((turn_index, entity_id) 중복은 첫 행)
  ing.citation          result.citations[] 배열 순서 ord 1..n, host = 응답 host 또는 URL host, domain_label = 등록 가능 도메인
  ing.acr_prompt_run    analysis.acr_summary(prompt_run_id 단위, 같은 prompt-run 의 반복 job 들이 같은 rows 를 반복 반환)
content_hash = sha256(정규 JSON: 위 원본 필드 전부, 키 정렬, 수신 시각 같은 휘발 필드 제외). 분석이 늦게 붙으면 해시가 바뀐다(DN-7).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import ipaddress
import json
from typing import Any
from urllib.parse import urlsplit

# 등록 가능 도메인(현행 registrableDomainOfHost sync.ts:1341 은 PSL 전체). 여기서는 2단 공개 접미사 목록만 둔다
# (ingest R6 PSL 데이터 이관은 보류: 현행 lib/public-suffix/data.ts 전량 이관·대조 테스트가 필요하다. 그때까지 근사, 목록 밖 다단 접미사는 마지막 두 라벨).
TWO_LEVEL_SUFFIXES = frozenset({
    "co.uk", "org.uk", "ac.uk", "gov.uk", "co.kr", "or.kr", "go.kr", "ac.kr", "ne.kr", "co.jp", "or.jp", "ne.jp", "ac.jp",
    "com.au", "net.au", "org.au", "edu.au", "gov.au", "com.br", "net.br", "org.br", "gov.br", "com.cn", "net.cn", "org.cn", "gov.cn",
    "com.mx", "org.mx", "gob.mx", "co.il", "org.il", "com.tw", "org.tw", "co.in", "net.in", "org.in", "gov.in", "com.ua", "org.ua",
    "com.tr", "org.tr", "gov.tr", "co.za", "org.za", "com.ar", "com.co", "com.pe", "com.sg", "com.my", "com.ph", "com.vn", "co.id",
    "or.id", "go.id", "co.th", "in.th", "com.hk", "com.sa", "com.eg", "co.nz", "org.nz", "com.kz", "com.mm", "com.pk", "com.ng",
})


def host_of(url: str | None) -> str | None:
    """URL 호스트(소문자, 선행 www. 제거: 현행 미러 url_host 0052 citation_url_host 와 같은 모양)."""
    if not url:
        return None
    try:
        h = urlsplit(url.strip()).hostname
    except ValueError:
        return None
    if not h:
        return None
    h = h.lower()
    return h[4:] if h.startswith("www.") else h


def registrable_domain(host: str | None) -> str | None:
    if not host:
        return None
    h = host.lower().strip(".")
    if h.startswith("www."):
        h = h[4:]
    try:
        ipaddress.ip_address(h)
        return h
    except ValueError:
        pass
    labels = h.split(".")
    if len(labels) <= 2:
        return h
    if ".".join(labels[-2:]) in TWO_LEVEL_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def _ts(v: Any) -> dt.datetime | None:
    if v is None or v == "":
        return None
    if isinstance(v, dt.datetime):
        return v if v.tzinfo else v.replace(tzinfo=dt.UTC)
    s = str(v).replace("Z", "+00:00")
    t = dt.datetime.fromisoformat(s)
    return t if t.tzinfo else t.replace(tzinfo=dt.UTC)


def content_hash(job: dict[str, Any], result: dict[str, Any] | None) -> bytes:
    """정규 JSON sha256. 휘발 필드(latency_ms 등 수신 부산물)는 제외한다."""
    a = job.get("analysis") or {}
    body = {
        "job_id": job.get("job_id"), "prompt_id": job.get("prompt_id"), "target": job.get("target"), "region": job.get("region"),
        "status": job.get("status"), "measured_at": job.get("measured_at"),
        "analysis": {k: a.get(k) for k in ("status", "analysis_version", "quality_breakdown", "resolved_mentions", "brand_stances", "acr_summary")},
        "result": None if not result else {k: result.get(k) for k in ("answer_text", "citations", "model_slug")},
    }
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str).encode()).digest()


def job_rows(job: dict[str, Any], *, run_id: Any, run_month: dt.date, load_id: int, result: dict[str, Any] | None,
             fallback: bool) -> dict[str, list[tuple]]:
    """job 1개 → 스테이지 행 묶음(answer 1·mention n·occurrence n·stance n·citation n). answer_key 는 적재 트랜잭션에서 채운다
    (스테이지는 NULL: DB-v2.6 P51. 키 누락이 ing.answer INSERT 의 NOT NULL 로 드러난다)."""
    a = job.get("analysis") or {}
    mentions = a.get("resolved_mentions") or []
    cits = (result or {}).get("citations") or []
    jid = job["job_id"]
    acr = a.get("acr_summary") or {}
    out: dict[str, list[tuple]] = {"answer": [], "mention": [], "occurrence": [], "stance": [], "citation": []}
    out["answer"].append((
        run_month, jid, None, run_id, job.get("prompt_id"), job.get("target") or "", job.get("region"), job.get("status") or "unknown",
        _ts(job.get("measured_at")), (result or {}).get("model_slug"), acr.get("prompt_run_id"), a.get("status"), a.get("analysis_version"),
        json.dumps(a.get("quality_breakdown")) if a.get("quality_breakdown") is not None else None, (result or {}).get("answer_text"),
        len(mentions), len(cits), fallback, content_hash(job, result), "scope_api", load_id))
    occ_ord = 0
    for i, m in enumerate(mentions, start=1):
        s = m.get("sentiment") or {}
        t = m.get("type_breakdown") or {}
        r = m.get("rollups") or {}
        out["mention"].append((
            load_id, run_month, jid, i, m.get("entity_id"), m.get("display_name"), m.get("entity_type"), int(m.get("mention_count") or 0),
            int(s.get("positive") or 0), int(s.get("neutral") or 0), int(s.get("negative") or 0), int(s.get("mixed") or 0),
            m.get("avg_position"), m.get("surfaces"), r.get("brand_entity_id"), r.get("product_entity_id"), r.get("company_entity_id"),
            int(t.get("mention") or 0), int(t.get("recommendation") or 0), int(t.get("comparison") or 0), int(t.get("definition") or 0),
            int(t.get("final_choice") or 0)))
        for o in m.get("occurrences") or []:
            occ_ord += 1
            out["occurrence"].append((
                load_id, run_month, jid, occ_ord, m.get("entity_id"), r.get("brand_entity_id"), o.get("turn_index"),
                int(o.get("source_start") or 0), int(o.get("source_end") or 0), o.get("surface_text") or "", o.get("sentiment") or "neutral",
                o.get("mention_role"), o.get("assertion"), o.get("context_snippet"), list(o.get("descriptors") or []), list(o.get("criteria") or [])))
    seen: set[tuple] = set()
    for st in a.get("brand_stances") or []:
        k = (int(st.get("turn_index") or 0), st.get("entity_id"))
        if k in seen or not st.get("entity_id"):
            continue
        seen.add(k)
        es, ee = st.get("evidence_start"), st.get("evidence_end")
        if (es is None) != (ee is None):
            es = ee = None
        out["stance"].append((
            load_id, run_month, jid, k[0], st.get("entity_id"), st.get("brand_label"), bool(st.get("is_tracked") or False), st.get("stance"),
            st.get("confidence"), st.get("evidence_text"), es, ee, st.get("reason"), st.get("model_slug")))
    for i, c in enumerate(cits, start=1):
        host = c.get("host") or host_of(c.get("url"))
        host = host.lower().removeprefix("www.") if host else None
        out["citation"].append((load_id, run_month, jid, i, c.get("url"), c.get("title"), c.get("refIndex"), c.get("category"), host,
                                registrable_domain(host_of(c.get("url")) or host)))
    return out


def acr_payload(job: dict[str, Any]) -> dict[str, Any] | None:
    a = job.get("analysis") or {}
    acr = a.get("acr_summary")
    if not acr or not acr.get("prompt_run_id"):
        return None
    return {"prompt_run_id": acr["prompt_run_id"], "job_id": job["job_id"], "prompt_id": job.get("prompt_id"), "target": job.get("target"),
            "region": job.get("region"), "measured_at": job.get("measured_at"), "rows": acr.get("rows") or [],
            "names": {m.get("entity_id"): {"name": m.get("display_name"), "brand": (m.get("rollups") or {}).get("brand_entity_id")}
                      for m in (a.get("resolved_mentions") or []) if m.get("entity_id")}}
