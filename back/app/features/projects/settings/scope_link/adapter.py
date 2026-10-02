"""Scope 라이브 진단 어댑터(주입 가능). 기본 = 꺼짐(DisabledProbe).

계약(DESIGN-CONTRACT §5, core.write 머리 주석): 요청 경로에서 Scope API 를 부르지 않는다. 그래서 운영 기본값은 호출하지 않는
DisabledProbe 이고, 진단은 DB(rd·outbox)만으로 한다. 라이브 확인이 필요해지면 이 프로토콜의 구현을 FastAPI 의존성
override(get_scope_probe)로 꽂는다. 구현은 conn 인자를 받지 않는다(core.db: 외부 호출 중 커넥션 점유 금지 규약). 라우터는
CurrentUserDetached + RoSession 으로 진단 읽기를 끝내고 커넥션을 돌려준 뒤 probe 를 부른다(router.py 머리말).
테스트는 가짜 구현을 주입해 배선(호출 여부·응답 반영·접근 감사 scope_call)을 확인한다.
"""
from __future__ import annotations

import uuid
from typing import Any, Protocol


class ScopeProbe(Protocol):
    name: str

    async def probe(self, scope_project_id: uuid.UUID) -> dict[str, Any] | None:
        """Scope 프로젝트 라이브 상태(없거나 꺼져 있으면 None)."""
        ...


class DisabledProbe:
    name = "disabled"

    async def probe(self, scope_project_id: uuid.UUID) -> dict[str, Any] | None:
        return None


def get_scope_probe() -> ScopeProbe:
    return DisabledProbe()
