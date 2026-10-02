"""대분류 경계 DB 되돌림(시험 정리 장치): 한 번의 pytest 가 여러 대분류(tests/core · app/features/<x> · ingest)를 같은 복제본에서 돌 때,
대분류가 바뀌는 첫 시험 전에 복제본을 세션 시작 상태로 되돌린다.

왜: 쓰기 시험 일부는 행을 커밋하고 남긴다(카탈로그 seed.py 사이트·프롬프트, admin 표준 프롬프트 생성 등. 감사 원장이 append-only 라 지우지
않는 설계). tests/run-areas.sh(공식 게이트)는 대분류마다 새 복제본이라 문제가 없지만, `python -m pytest`(전체) 한 번은 앞 대분류가 남긴 행이
뒤 대분류의 기대값·bulk 동치 대조를 바꿨다(2026-10-01 be/int-incr 실측: 단일 DB 전체 83건 실패, 대분류별 실행은 0건).
방식(run-areas 와 같은 격리 단위): 세션 첫 시험 전에 복제본을 최신 패치·시험 프로필 투영까지 올린 뒤(_db_latest 와 같은 함수, 멱등) 그 상태를
<db>_pristine 으로 복제해 두고, 대분류가 바뀌면 복제본을 DROP(FORCE) → pristine 에서 다시 만든다. 공용 계정 행(seeded 픽스처, 세션 1회)은
되돌린 뒤 다시 넣는다. 대분류 하나만 도는 실행(run-areas·단일 파일)은 아무것도 하지 않는다. 끄기: HGH_TEST_AREA_RESET=0.
같은 대분류 안의 순서 의존은 이 장치 밖이다(run-areas 와 같은 규약: 대분류 단독 두 번 실행 = 재진입 안전).
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import threading
from typing import Any
from urllib.parse import urlsplit, urlunsplit

PRISTINE_SUFFIX = "_pristine"


def area_of(path: pathlib.Path, root: pathlib.Path) -> str:
    """대분류(run-areas.sh 와 같은 단위): tests/core · app/features/<x> · ingest. 그 밖은 첫 경로 성분."""
    try:
        parts = path.resolve().relative_to(root.resolve()).parts
    except ValueError:
        return str(path)
    if len(parts) >= 3 and parts[0] == "app" and parts[1] == "features":
        return "/".join(parts[:3])
    if len(parts) >= 2 and parts[0] == "tests":
        return "/".join(parts[:2])
    return parts[0] if parts else ""


def _with_db(url: str, name: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, "/" + name, p.query, p.fragment))


def _db_name(url: str) -> str:
    return urlsplit(url).path.lstrip("/")


def _run(coro_fn: Any) -> None:
    """pytest-asyncio 세션 루프와 섞이지 않게 별도 스레드·새 루프에서 돈다(예외는 호출자에게 다시 올린다)."""
    err: list[BaseException] = []

    def target() -> None:
        try:
            asyncio.run(coro_fn())
        except BaseException as e:  # noqa: BLE001 (스레드 밖으로 그대로 다시 올린다)
            err.append(e)

    t = threading.Thread(target=target, name="hgh-area-reset")
    t.start()
    t.join()
    if err:
        raise err[0]


class AreaReset:
    def __init__(self, db_url: str, profile_spec: str) -> None:
        self.url = db_url
        self.db = _db_name(db_url)
        self.pristine = self.db + PRISTINE_SUFFIX
        self.profile_spec = profile_spec
        self.current: str | None = None
        self.ready = False
        self.resets = 0

    def _guard(self) -> None:
        from tests.dbforward import TEMPLATE_NAMES

        if self.db in TEMPLATE_NAMES or self.db.endswith(PRISTINE_SUFFIX):
            raise RuntimeError(f"대분류 경계 되돌림은 복제본에서만 한다(현재 DB {self.db})")

    def snapshot(self) -> None:
        """세션 첫 시험 전: 최신 패치·시험 프로필 투영(멱등) → pristine 복제."""
        self._guard()

        async def go() -> None:
            import asyncpg

            from app.core.profile import parse_profile
            from tests.dbforward import ensure_latest, project_test_profile

            c = await asyncpg.connect(self.url)
            try:
                await ensure_latest(c)
                await project_test_profile(c, parse_profile(self.profile_spec))
            finally:
                await c.close()
            a = await asyncpg.connect(_with_db(self.url, "postgres"))
            try:
                await a.execute(f'DROP DATABASE IF EXISTS "{self.pristine}" WITH (FORCE)')
                await a.execute(f'CREATE DATABASE "{self.pristine}" TEMPLATE "{self.db}"')
            finally:
                await a.close()

        _run(go)
        self.ready = True

    def reset(self) -> None:
        """복제본 = pristine(DROP FORCE → CREATE TEMPLATE) + 공용 계정 행(seeded 와 같은 문장)."""
        self._guard()

        async def go() -> None:
            import asyncpg

            from tests.support import ACCOUNTS_SQL

            a = await asyncpg.connect(_with_db(self.url, "postgres"))
            try:
                await a.execute(f'DROP DATABASE IF EXISTS "{self.db}" WITH (FORCE)')
                await a.execute(f'CREATE DATABASE "{self.db}" TEMPLATE "{self.pristine}"')
            finally:
                await a.close()
            c = await asyncpg.connect(self.url)
            try:
                await c.execute(ACCOUNTS_SQL)
                await c.execute("SELECT rd.ensure_month_leaf('app.access_audit_log'::regclass, current_date)")
            finally:
                await c.close()

        _run(go)
        self.resets += 1

    def drop_pristine(self) -> None:
        if not self.ready:
            return

        async def go() -> None:
            import asyncpg

            a = await asyncpg.connect(_with_db(self.url, "postgres"))
            try:
                await a.execute(f'DROP DATABASE IF EXISTS "{self.pristine}" WITH (FORCE)')
            finally:
                await a.close()

        _run(go)
        self.ready = False


def enabled() -> bool:
    return (os.environ.get("HGH_TEST_AREA_RESET") or "1").strip() != "0"
