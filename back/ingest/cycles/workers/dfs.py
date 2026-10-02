"""DataForSEO 어댑터(주입 가능)와 dfs_fetch 적재(Q13: 운영자 요청 → 비동기 judgment_change 'dfs_fetch' → 적재기 빠른 경로).

페이로드 계약 = core.contracts.DfsFetch(운영자 키워드 도구 AD-4·고객 관심 IN-1 공용, core 6라운드 통일):
  {fetch: volume|insight|related|search, terms: [원문], location_code, language_code, depth(insight serp 깊이, 기본 10), project_id?, force?}
  subject_texts = 정렬된 DB 정규화(app.term_norm) 목록. fetch → 엔드포인트: volume = search_volume, insight = search_volume + serp_organic(term 마다),
  related = keyword_suggestions(term 마다, seed 제외), search = keyword_suggestions(term 마다, include_seed, seed 행 is_seed).
엔드포인트별 응답 모양은 현행 lib/keyword/dataforseo.ts(search_volume)·dataforseo-discovery.ts(serp_organic·keyword_suggestions)와 같다.
키워드 정규화(rd.dim_keyword.term_norm)는 DB 정본 app.term_norm(DB-v2.7 P55, API 조회·중복 판정과 한 벌).
옛 payload(endpoint·keywords, core 6라운드 전 형식)는 legacy_dfs 가 1회 새 계약으로 바꿔 받는다(검증 m-6, 전환 전 큐 비우기 권장).
쓰기: ext.dfs_call(엔드포인트별 1행, request/response 원본) + rd.dim_keyword·kw_volume_monthly·kw_serp·kw_suggestion 을 한 트랜잭션.
인증은 HTTP Basic(login:password, env HGH_DFS_LOGIN·HGH_DFS_PASSWORD). 외부 호출은 DB 트랜잭션 밖에서 한다.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
from dataclasses import dataclass, field
from typing import Any, Protocol

import asyncpg

from . import queries as q

ENDPOINTS = {
    "search_volume": "/v3/keywords_data/google_ads/search_volume/live",
    "serp_organic": "/v3/serp/google/organic/live/advanced",
    "keyword_suggestions": "/v3/dataforseo_labs/google/keyword_suggestions/live",
}


class DfsSource(Protocol):
    async def call(self, endpoint: str, request: list[dict[str, Any]]) -> tuple[int, dict[str, Any], float | None]: ...


class HttpDfsSource:
    def __init__(self, base_url: str, login: str, password: str, *, client: Any = None):
        import httpx
        self._base = base_url.rstrip("/")
        tok = base64.b64encode(f"{login}:{password}".encode()).decode()
        self._headers = {"Authorization": f"Basic {tok}", "Content-Type": "application/json"}
        self._client = client or httpx.AsyncClient(timeout=60.0)

    async def call(self, endpoint: str, request: list[dict[str, Any]]) -> tuple[int, dict[str, Any], float | None]:
        r = await self._client.post(self._base + ENDPOINTS[endpoint], json=request, headers=self._headers)
        body = r.json() if r.content else {}
        return r.status_code, body, body.get("cost") if isinstance(body, dict) else None


@dataclass
class FakeDfsSource:
    responses: dict[str, dict[str, Any]] = field(default_factory=dict)
    calls: list[tuple[str, list[dict[str, Any]]]] = field(default_factory=list)
    status: int = 200

    async def call(self, endpoint: str, request: list[dict[str, Any]]) -> tuple[int, dict[str, Any], float | None]:
        self.calls.append((endpoint, request))
        return self.status, self.responses.get(endpoint, {"status_code": 20000, "tasks": []}), 0.01


def request_for(endpoint: str, keywords: list[str], loc: int | None, lang: str | None, *, depth: int = 10,
                include_seed: bool = True) -> list[dict[str, Any]]:
    base: dict[str, Any] = {}
    if loc:
        base["location_code"] = loc
    if lang:
        base["language_code"] = lang
    if endpoint == "search_volume":
        return [{"keywords": keywords, "sort_by": "search_volume", **base}]
    if endpoint == "serp_organic":
        return [{"keyword": keywords[0], "depth": depth, **base}]
    return [{"keyword": keywords[0], "limit": 50, "include_seed_keyword": include_seed, **base}]


_LEGACY_FETCH = {"search_volume": "volume", "serp_organic": "insight", "keyword_suggestions": "search"}
_LEGACY_SUBJECT = ("search_volume:", "serp_organic:", "keyword_suggestions:")


def legacy_dfs(payload: dict[str, Any] | None, subject_texts: list[str] | None) -> tuple[dict[str, Any], tuple[str, ...] | None] | None:
    """옛 payload({endpoint, keywords 또는 terms, location_code, language_code, project_id?}) → (새 계약 payload, 엔드포인트 고정).
    옛 형식이 아니면 None. endpoint 하나만 호출한다(serp_organic 만이었던 요청에 검색량 호출을 더하지 않는다). 키워드가 없으면
    subject_texts 에서 옛 운영자 도구의 'search_volume:<loc>:<lang>' 접두 주체를 뺀 나머지를 쓴다. 옛 keyword_suggestions 는 seed 포함."""
    if not isinstance(payload, dict) or "fetch" in payload or "endpoint" not in payload:
        return None
    ep = payload.get("endpoint")
    if ep not in _LEGACY_FETCH:
        return None
    terms = [t for t in (payload.get("keywords") or payload.get("terms") or []) if t] or \
        [t for t in (subject_texts or []) if t and not t.startswith(_LEGACY_SUBJECT)]
    new = {"fetch": _LEGACY_FETCH[ep], "terms": terms, "location_code": payload.get("location_code"),
           "language_code": payload.get("language_code"), "project_id": payload.get("project_id"),
           "requested_via": payload.get("requested_via") or "legacy_payload"}
    return {k: v for k, v in new.items() if v is not None}, (ep,)


def plan_calls(d: Any, endpoints: tuple[str, ...] | None = None) -> list[tuple[str, list[str], list[dict[str, Any]]]]:
    """DfsFetch → [(엔드포인트, 키워드, 요청 본문)]. search_volume 은 한 번에, serp·suggestions 는 term 마다.
    endpoints 를 주면(옛 payload 변환) 그 엔드포인트만."""
    loc, lang = d.location_code, d.language_code
    out: list[tuple[str, list[str], list[dict[str, Any]]]] = []
    for ep in endpoints or d.endpoints:
        if ep == "search_volume":
            out.append((ep, list(d.terms), request_for(ep, list(d.terms), loc, lang)))
        else:
            for t in d.terms:
                out.append((ep, [t], request_for(ep, [t], loc, lang, depth=d.depth, include_seed=d.include_seed)))
    return out


def _tasks_result(body: dict[str, Any]) -> list[Any]:
    tasks = body.get("tasks") or []
    if not tasks:
        return []
    t = tasks[0]
    if t.get("status_code") not in (None, 20000):
        raise ValueError(f"DataForSEO task error: {t.get('status_message')}")
    return t.get("result") or []


async def _kw(conn: asyncpg.Connection, term: str) -> int:
    return int(await conn.fetchval(q.KW_KEY, term))


COMPETITION = ("LOW", "MEDIUM", "HIGH")      # rd.kw_volume_monthly.competition CHECK(DB-v2.9 P62)


def _competition(v: Any) -> str | None:
    return v if isinstance(v, str) and v in COMPETITION else None


def _total_count(v: Any) -> int | None:
    """keyword_suggestions total_count: 0 이상 int4 정수만(bool·실수·문자열·범위 밖은 NULL, rd.kw_suggestion CHECK total_count ≥ 0)."""
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 2_147_483_647 else None


async def write_dfs(conn: asyncpg.Connection, *, endpoint: str, keywords: list[str], loc: int | None, lang: str | None,
                    request: list[dict[str, Any]], status: int, body: dict[str, Any], cost: float | None, requested_by: Any,
                    project_id: Any, now: dt.datetime) -> dict[str, int]:
    """ext.dfs_call 1행 + rd.kw_* . 반환 = 표별 행 수."""
    await conn.execute("SELECT rd.ensure_month_leaf('ext.dfs_call'::regclass, $1::date)", now.date())
    call_id = int(await conn.fetchval(q.DFS_CALL, endpoint, loc, lang, keywords, json.dumps(request), json.dumps(body), status,
                                      cost, requested_by, project_id, now))
    out = {"call_id": call_id, "volume": 0, "serp": 0, "suggestion": 0}
    if status >= 400:
        return out
    res = _tasks_result(body)
    l_, g_ = loc or 0, lang or ""
    if endpoint == "search_volume":
        for row in res:
            if not row.get("keyword"):
                continue
            k = await _kw(conn, row["keyword"])
            for ms in row.get("monthly_searches") or []:
                month = dt.date(int(ms["year"]), int(ms["month"]), 1)
                await conn.execute(q.KW_VOLUME, k, l_, g_, month, ms.get("search_volume"), row.get("competition_index"), row.get("cpc"),
                                   call_id, now, _competition(row.get("competition")))
                out["volume"] += 1
    elif endpoint == "serp_organic":
        k = await _kw(conn, keywords[0])
        items = (res[0].get("items") if res else None) or []
        for it in items:
            if it.get("type") != "organic" or not it.get("url"):
                continue
            await conn.execute(q.KW_SERP, call_id, k, l_, g_, int(it.get("rank_group") or it.get("rank_absolute") or 0),
                               it["url"], it.get("domain"), it.get("title"), it.get("description"), now)
            out["serp"] += 1
    else:
        seed = await _kw(conn, keywords[0])
        items = (res[0].get("items") if res else None) or []
        total = _total_count(res[0].get("total_count")) if res else None
        for pos, it in enumerate(items, start=1):
            if not it.get("keyword"):
                continue
            k = await _kw(conn, it["keyword"])
            await conn.execute(q.KW_SUGGEST, call_id, seed, l_, g_, pos, k, (it.get("keyword_info") or {}).get("search_volume"),
                               (it.get("search_intent_info") or {}).get("main_intent"), k == seed,      # 같은 정규화 = 같은 kw_key
                               now, total)
            out["suggestion"] += 1
    return out
