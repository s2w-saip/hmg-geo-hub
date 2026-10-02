"""intent.candidates.submit 업무 규칙: 후보 풀 추가(IN-1·IN-2 공용, 현행 addCandidates 규칙 _actions.ts:96-141).

- 권한: core.auth.resolve_project(operate)(canOperateProject 이식, 비용 액션 게이트). 쓰기 SQL 은 전부 project_id 조건.
- 텍스트 trim, 빈 값 제외, 요청 안 중복 제외, 프로젝트에 이미 있는 텍스트 제외(앱 단 dedup). source_keyword 는 trim·빈 값 NULL.
- 남는 항목이 없으면 422(현행 "전송할 프롬프트가 없습니다"), 전부 기존 중복이면 200 added 0.
- 후보는 판정 입력이 아니다(judgment_change 없음, 후보→프롬프트 승격은 projects 모듈).
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all
from app.features.intent.candidates.submit import queries as q
from app.features.intent.candidates.submit.schemas import CandidateIn, CandidateOut


async def submit(rw: AsyncConnection, project_id: uuid.UUID, body: CandidateIn) -> CandidateOut:
    rows = [(it.text.strip(), (it.source_keyword or "").strip() or None) for it in body.items]
    rows = [r for r in rows if r[0]]
    if not rows:
        raise errors.unprocessable("전송할 후보가 없다(빈 텍스트만)", details={"field": "items"})
    await fetch_all(rw, q.LOCK_PROJECT, {"pid": project_id})
    texts = list(dict.fromkeys(t for t, _ in rows))
    existing = {r["text"] for r in await fetch_all(rw, q.EXISTING_TEXTS, {"pid": project_id, "texts": texts})}
    seen: set[str] = set()
    fresh: list[tuple[str, str | None]] = []
    for t, kw in rows:
        if t in existing or t in seen:
            continue
        seen.add(t)
        fresh.append((t, kw))
    ids: list[uuid.UUID] = []
    if fresh:
        rs = await fetch_all(rw, q.INSERT, {"pid": project_id, "source": body.source,
                                            "texts": [t for t, _ in fresh], "kws": [k for _, k in fresh]})
        ids = [r["candidate_id"] for r in rs]
    return CandidateOut(added_count=len(ids), skipped_count=len(body.items) - len(ids), candidate_ids=ids)
