"""Scope 원천 어댑터(주입 가능). 현행 인터페이스 대응: front/lib/scope/client.ts(ScopeClient)·http.ts(HttpScopeClient).

  list_prompts(project, updated_from, updated_to)  GET /projects/{id}/prompts?updated_from&updated_to (페이지 전량)
  get_project(project)                             GET /projects/{id}                     (regions: 시장 설정, DB-v2.1 P05)
  list_runs(project)                               GET /projects/{id}/measurements        (페이지 전량, cycle_anchor_at 포함)
  list_run_jobs(project, run, cursor)              GET /projects/{id}/measurements/{run}/jobs?include=result,occurrences,stances&limit=200
  get_query_run(job)                               GET /query/{job}                       (완료 job 의 본문 누락 보충)
  write_project / write_prompt / write_schedule    아웃박스 드레인(app.scope_outbox)용 쓰기

HTTP 구현은 httpx 비동기, API 키는 env(HGH_SCOPE_API_KEY) → Authorization 헤더(argv·로그 금지). 429·5xx 는 지수 백오프.
테스트·로컬은 FakeScopeSource(메모리 원천, 호출 기록·실패 주입)를 주입한다. 외부 네트워크 호출은 HTTP 구현만 한다.
"""
from __future__ import annotations

import asyncio
import copy
import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

log = logging.getLogger("hgh.ingest.scope")

JOB_PAGE = 200
INCLUDE = "result,occurrences,stances"


class ScopeError(Exception):
    """원천 호출 실패(상태 코드·경로만, 비밀·본문 원문 없음)."""

    def __init__(self, status: int, path: str, code: str | None = None):
        super().__init__(f"scope {status} {code or ''} at {path}".strip())
        self.status = status
        self.path = path
        self.code = code


class ScopeSource(Protocol):
    async def list_prompts(self, project_id: str, *, updated_from: str | None = None, updated_to: str | None = None) -> list[dict[str, Any]]: ...
    async def get_project(self, project_id: str) -> dict[str, Any]: ...
    async def list_runs(self, project_id: str) -> list[dict[str, Any]]: ...
    async def list_run_jobs(self, project_id: str, run_id: str, cursor: str | None) -> tuple[list[dict[str, Any]], str | None]: ...
    async def get_query_run(self, job_id: str) -> dict[str, Any]: ...
    async def write(self, aggregate: str, op: str, aggregate_id: str, payload: dict[str, Any]) -> dict[str, Any]: ...


class HttpScopeSource:
    """httpx 구현. 인스턴스는 워커 프로세스당 1개(연결 재사용)."""

    def __init__(self, base_url: str, api_key: str, *, timeout_s: float = 60.0, retries: int = 4, client: Any = None):
        import httpx
        base = base_url.rstrip("/")
        if base.endswith("/api/v1"):
            base = base[: -len("/api/v1")]
        self._base = base + "/api/v1"
        self._headers = {"Authorization": f"Bearer {api_key}", "Accept-Encoding": "gzip"}
        self._client = client or httpx.AsyncClient(timeout=timeout_s)
        self._retries = retries

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _req(self, method: str, path: str, *, params: dict[str, Any] | None = None, body: Any = None) -> Any:
        q = {k: v for k, v in (params or {}).items() if v not in (None, "")}
        delay = 1.0
        for attempt in range(self._retries + 1):
            r = await self._client.request(method, self._base + path, params=q, json=body, headers=self._headers)
            if method != "POST" and (r.status_code == 429 or r.status_code >= 500) and attempt < self._retries:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)
                continue
            if r.status_code >= 400:
                code = None
                try:
                    code = (r.json().get("error") or {}).get("code")
                except Exception:  # noqa: BLE001  오류 본문이 JSON 이 아니면 코드 없음
                    code = None
                raise ScopeError(r.status_code, path, code)
            return None if r.status_code == 204 else r.json()
        raise ScopeError(599, path, "retries_exhausted")

    async def _pages(self, path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        cursor: str | None = None
        for _ in range(10_000):
            page = await self._req("GET", path, params={**params, "cursor": cursor})
            out.extend(page.get("data") or [])
            cursor = page.get("next_cursor")
            if not cursor:
                return out
        raise ScopeError(599, path, "page_cap")

    async def list_prompts(self, project_id: str, *, updated_from: str | None = None, updated_to: str | None = None) -> list[dict[str, Any]]:
        return await self._pages(f"/projects/{project_id}/prompts", {"limit": 100, "updated_from": updated_from, "updated_to": updated_to})

    async def get_project(self, project_id: str) -> dict[str, Any]:
        return await self._req("GET", f"/projects/{project_id}")

    async def list_runs(self, project_id: str) -> list[dict[str, Any]]:
        return await self._pages(f"/projects/{project_id}/measurements", {"limit": 100})

    async def list_run_jobs(self, project_id: str, run_id: str, cursor: str | None) -> tuple[list[dict[str, Any]], str | None]:
        page = await self._req("GET", f"/projects/{project_id}/measurements/{run_id}/jobs",
                               params={"limit": JOB_PAGE, "cursor": cursor, "include": INCLUDE})
        return list(page.get("data") or []), page.get("next_cursor")

    async def get_query_run(self, job_id: str) -> dict[str, Any]:
        return await self._req("GET", f"/query/{job_id}")

    async def write(self, aggregate: str, op: str, aggregate_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """아웃박스 반영. op: create|update|delete (project·prompt), put (schedule)."""
        if aggregate == "project":
            if op == "create":
                return await self._req("POST", "/projects", body=payload)
            if op == "delete":
                return await self._req("DELETE", f"/projects/{payload['scope_project_id']}") or {}
            return await self._req("PATCH", f"/projects/{payload['scope_project_id']}", body=payload.get("body", payload))
        if aggregate == "prompt":
            pid = payload["scope_project_id"]
            if op == "create":
                return await self._req("POST", f"/projects/{pid}/prompts", body=payload.get("body", payload))
            if op == "delete":
                return await self._req("DELETE", f"/projects/{pid}/prompts/{payload['scope_prompt_id']}") or {}
            return await self._req("PATCH", f"/projects/{pid}/prompts/{payload['scope_prompt_id']}", body=payload.get("body", payload))
        if aggregate == "schedule":
            return await self._req("PUT", f"/projects/{payload['scope_project_id']}/schedule", body=payload.get("body", payload))
        raise ValueError(f"아웃박스 aggregate: {aggregate}")


@dataclass
class FakeScopeSource:
    """메모리 원천(테스트·로컬). jobs[run_id] 는 페이지 크기 page_size 로 잘라 준다.
    fail_on: {(메서드, 키): 남은 실패 횟수} 로 실패를 주입한다(예 ("list_run_jobs", run_id, 1) → 두 번째 페이지에서 실패)."""
    projects: dict[str, dict[str, Any]] = field(default_factory=dict)
    prompts: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    runs: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    jobs: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    query_runs: dict[str, dict[str, Any]] = field(default_factory=dict)
    page_size: int = 2
    calls: list[tuple] = field(default_factory=list)
    fail_on: dict[tuple, int] = field(default_factory=dict)
    writes: list[tuple] = field(default_factory=list)
    write_result: dict[str, Any] = field(default_factory=dict)

    def _maybe_fail(self, key: tuple) -> None:
        n = self.fail_on.get(key, 0)
        if n > 0:
            self.fail_on[key] = n - 1
            raise ScopeError(503, "/fake/" + "/".join(str(k) for k in key), "injected")

    async def list_prompts(self, project_id: str, *, updated_from: str | None = None, updated_to: str | None = None) -> list[dict[str, Any]]:
        self.calls.append(("list_prompts", project_id, updated_from))
        self._maybe_fail(("list_prompts", project_id))
        rows = self.prompts.get(project_id, [])
        if updated_from:
            rows = [p for p in rows if (p.get("updated_at") or p.get("created_at") or "") >= updated_from]
        return copy.deepcopy(rows)

    async def get_project(self, project_id: str) -> dict[str, Any]:
        self.calls.append(("get_project", project_id))
        self._maybe_fail(("get_project", project_id))
        return copy.deepcopy(self.projects.get(project_id, {"project_id": project_id, "regions": []}))

    async def list_runs(self, project_id: str) -> list[dict[str, Any]]:
        self.calls.append(("list_runs", project_id))
        self._maybe_fail(("list_runs", project_id))
        return copy.deepcopy(self.runs.get(project_id, []))

    async def list_run_jobs(self, project_id: str, run_id: str, cursor: str | None) -> tuple[list[dict[str, Any]], str | None]:
        self.calls.append(("list_run_jobs", run_id, cursor))
        start = int(cursor or 0)
        self._maybe_fail(("list_run_jobs", run_id, start // max(self.page_size, 1)))
        allj = self.jobs.get(run_id, [])
        page = allj[start:start + self.page_size]
        nxt = str(start + self.page_size) if start + self.page_size < len(allj) else None
        return copy.deepcopy(page), nxt

    async def get_query_run(self, job_id: str) -> dict[str, Any]:
        self.calls.append(("get_query_run", job_id))
        self._maybe_fail(("get_query_run", job_id))
        if job_id not in self.query_runs:
            raise ScopeError(404, f"/query/{job_id}", "not_found")
        return copy.deepcopy(self.query_runs[job_id])

    async def write(self, aggregate: str, op: str, aggregate_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("write", aggregate, op, aggregate_id))
        self._maybe_fail(("write", aggregate, aggregate_id))
        self.writes.append((aggregate, op, aggregate_id, copy.deepcopy(payload)))
        return copy.deepcopy(self.write_result.get(str(aggregate_id), {}))

    def count(self, method: str, *keys: Iterable[Any]) -> int:
        return sum(1 for c in self.calls if c[0] == method and all(k in c for k in keys))


def source_from_settings() -> ScopeSource:
    from ingest.common.config import get_ingest_settings
    s = get_ingest_settings()
    if not s.scope_api_url or s.scope_api_key is None:
        raise RuntimeError("HGH_SCOPE_API_URL·HGH_SCOPE_API_KEY 미설정")
    return HttpScopeSource(s.scope_api_url, s.scope_api_key.get_secret_value())
