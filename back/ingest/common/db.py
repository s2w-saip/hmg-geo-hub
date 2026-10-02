"""loader 직접 연결·트랜잭션·잠금·LoadContext(ing.load 생명주기).

규약(모듈-적재-파이프라인.md §4, 전체-통합 shared)
- 워커는 loader 롤로 직접 연결한다(PgBouncer 미경유). asyncpg statement 캐시는 끈다(PgBouncer 로 옮겨도 안전하게).
- 잠금은 트랜잭션 형태만(xact). 순서 surface(NS 1) → project(NS 2) → dim(NS 3) 고정(교착 방지).
- ing.load: open_load = 짧은 별도 트랜잭션(스테이지 태깅용 load_id 선발급) → 적재 트랜잭션 → finalize(같은 트랜잭션 끝) →
  실패 시 롤백 후 fail_load(새 트랜잭션). 세대 증가는 finalize 1회뿐(rd 행이 바뀐 커밋만).
- 세션 상태: TimeZone UTC(시드와 같은 시각 표기), 판정 규칙 함수·규칙 표는 pg_temp(연결 수명, ingest.common.rules).
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from ingest.common.config import IngestSettings, get_ingest_settings

log = logging.getLogger("hgh.ingest.db")

NS_SURFACE = 1
NS_PROJECT = 2
NS_DIM = 3
LOAD_KINDS = ("run", "recheck", "judgment", "cycle_admin", "rebuild", "ga4", "dfs", "report", "seed")
ERROR_MAX = 2000


class LoaderDB:
    """loader 연결 공장. 테스트는 dsn·role 을 직접 준다."""

    def __init__(self, dsn: str, *, role: str | None = None, statement_timeout: str = "180s"):
        self._dsn = dsn
        self.role = role
        self.statement_timeout = statement_timeout

    @classmethod
    def from_settings(cls, s: IngestSettings | None = None) -> LoaderDB:
        s = s or get_ingest_settings()
        if s.db_url is None:
            raise RuntimeError("HGH_INGEST_DB_URL(또는 HGH_DB_URL) 미설정")
        return cls(s.db_url.get_secret_value(), role=s.db_role, statement_timeout=s.statement_timeout)

    async def connect(self) -> asyncpg.Connection:
        """core.db.loader_connect(statement 캐시 끔·TimeZone UTC·롤은 시작 파라미터)."""
        from app.core.db import loader_connect

        return await loader_connect(dsn=self._dsn, role=self.role or "")

    @asynccontextmanager
    async def session(self) -> AsyncIterator[asyncpg.Connection]:
        conn = await self.connect()
        try:
            yield conn
        finally:
            await conn.close()

    @asynccontextmanager
    async def tx(self, conn: asyncpg.Connection, *, statement_timeout: str | None = None) -> AsyncIterator[asyncpg.Connection]:
        """트랜잭션 1개. 문장·잠금 상한은 트랜잭션 로컬(set_config(..., true))."""
        async with conn.transaction():
            await conn.execute("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '5s', true)",
                               statement_timeout or self.statement_timeout)
            yield conn


# ── 잠금(트랜잭션 형태만) ──
async def lock_surface_shared(conn: asyncpg.Connection, surface: int) -> None:
    await conn.execute("SELECT pg_advisory_xact_lock_shared($1::int4, $2::int4)", NS_SURFACE, surface)


async def lock_surface_exclusive(conn: asyncpg.Connection, surface: int) -> None:
    await conn.execute("SELECT pg_advisory_xact_lock($1::int4, $2::int4)", NS_SURFACE, surface)


async def try_lock_project(conn: asyncpg.Connection, scope_project_id: Any) -> bool:
    return bool(await conn.fetchval("SELECT pg_try_advisory_xact_lock($1::int4, hashtext($2::text))", NS_PROJECT, str(scope_project_id)))


async def lock_dims(conn: asyncpg.Connection) -> None:
    """수동 int2 키 차원 발급(max+1)을 직렬화한다."""
    await conn.execute("SELECT pg_advisory_xact_lock($1::int4, 0)", NS_DIM)


# ── LoadContext ──
@dataclass
class LoadContext:
    load_id: int
    kind: str
    rule_ver: int
    scope_project_id: Any = None
    surfaces: set[int] = field(default_factory=set)            # rd 가 바뀐 표면(세대 증가 대상)
    touched_cycle_ids: set[Any] = field(default_factory=set)   # rd.cycle 을 다시 투영한 회차
    rd_changed: bool = False
    counters: dict[str, int] = field(default_factory=lambda: {
        "jobs_fetched": 0, "jobs_changed": 0, "jobs_removed": 0, "rd_answers_upserted": 0,
        "rd_gate_propagated": 0, "rd_rep_flips": 0, "rd_children_rows": 0})

    def add(self, key: str, n: int) -> None:
        self.counters[key] = self.counters.get(key, 0) + int(n or 0)


async def current_rule_ver(conn: asyncpg.Connection) -> int:
    v = await conn.fetchval("SELECT max(rule_ver) FROM app.rule_set")
    if v is None:
        raise RuntimeError("app.rule_set 비어 있음: 규칙 세트 없이 적재 불가")
    return int(v)


async def open_load(db: LoaderDB, kind: str, *, run_id: Any = None, scope_ref: dict[str, Any] | None = None,
                    scope_project_id: Any = None) -> LoadContext:
    """짧은 별도 트랜잭션으로 ing.load(status running) 1행. load_id 를 스테이지 태깅에 먼저 쓴다."""
    if kind not in LOAD_KINDS:
        raise ValueError(f"load kind: {kind}")
    async with db.session() as conn, db.tx(conn):
        rv = await current_rule_ver(conn)
        lid = await conn.fetchval(
            "INSERT INTO ing.load (kind, run_id, scope_ref, rule_ver, status) VALUES ($1, $2, $3::jsonb, $4, 'running') RETURNING load_id",
            kind, run_id, json.dumps(scope_ref or {}, default=str), rv)
    return LoadContext(load_id=int(lid), kind=kind, rule_ver=rv, scope_project_id=scope_project_id)


async def begin_load(conn: asyncpg.Connection, kind: str, *, run_id: Any = None, scope_ref: dict[str, Any] | None = None,
                     scope_project_id: Any = None) -> LoadContext:
    """같은 트랜잭션 안에서 ing.load 를 연다(큐·틱처럼 스테이지가 없는 짧은 적재). 실패하면 롤백으로 함께 사라지므로
    호출자는 실패를 fail_load 대신 큐 상태·로그로 남긴다."""
    rv = await current_rule_ver(conn)
    lid = await conn.fetchval(
        "INSERT INTO ing.load (kind, run_id, scope_ref, rule_ver, status) VALUES ($1, $2, $3::jsonb, $4, 'running') RETURNING load_id",
        kind, run_id, json.dumps(scope_ref or {}, default=str), rv)
    return LoadContext(load_id=int(lid), kind=kind, rule_ver=rv, scope_project_id=scope_project_id)


_AS_OF_SQL = """
SELECT max(round_date) FROM rd.cycle c
 WHERE c.surface = $1 AND c.servable AND c.view_date <= rd.today_kst() AND c.hidden_scope <> 1
"""


async def finalize(conn: asyncpg.Connection, ctx: LoadContext, *, run_state: str | None = None) -> dict[int, int]:
    """적재 트랜잭션 끝(같은 트랜잭션): rd 가 바뀐 표면만 세대 +1, 그 회차의 rd.cycle.generation = 새 세대 값(SET),
    엔티티별 전 기간 합계(rd.entity_mention_total) 증분 반영, ing.load committed·카운터, 이 load 의 스테이지 삭제. 반환 = {surface: 새 세대}."""
    gens: dict[int, int] = {}
    if ctx.rd_changed:
        for s in sorted(ctx.surfaces):
            as_of = await conn.fetchval(_AS_OF_SQL, s)
            g = await conn.fetchval("""
                INSERT INTO rd.surface_generation AS g (surface, generation, last_load_id, rule_ver, as_of, updated_at)
                VALUES ($1, 1, $2, $3, $4, now())
                ON CONFLICT (surface) DO UPDATE SET generation = g.generation + 1, last_load_id = EXCLUDED.last_load_id,
                       rule_ver = EXCLUDED.rule_ver, as_of = EXCLUDED.as_of, updated_at = now()
                RETURNING generation""", s, ctx.load_id, ctx.rule_ver, as_of)
            gens[s] = int(g)
        if ctx.touched_cycle_ids:
            await conn.execute("""
                UPDATE rd.cycle c SET generation = g.generation
                  FROM rd.surface_generation g
                 WHERE c.cycle_id = ANY($1::uuid[]) AND g.surface = c.surface AND c.generation IS DISTINCT FROM g.generation""",
                list(ctx.touched_cycle_ids))
    # 관리 엔티티 목록 합계(DB-v2.25 P134): ing.mention·ing.answer_drop 트리거가 쌓은 차분을 더한다(바뀐 엔티티만, 결과 캐시 추적 표)
    await conn.fetchval("SELECT rd.flush_entity_mention_total()")
    c = ctx.counters
    await conn.execute("""
        UPDATE ing.load SET status = 'committed', finished_at = clock_timestamp(),
               jobs_fetched = $2, jobs_changed = $3, jobs_removed = $4, rd_answers_upserted = $5,
               rd_gate_propagated = $6, rd_rep_flips = $7, rd_children_rows = $8
         WHERE load_id = $1""", ctx.load_id, c["jobs_fetched"], c["jobs_changed"], c["jobs_removed"], c["rd_answers_upserted"],
                            c["rd_gate_propagated"], c["rd_rep_flips"], c["rd_children_rows"])
    await delete_stage(conn, ctx.load_id)
    return gens


async def delete_stage(conn: asyncpg.Connection, load_id: int) -> None:
    for t in ("stage_answer", "stage_mention", "stage_occurrence", "stage_stance", "stage_citation", "stage_acr"):
        await conn.execute(f"DELETE FROM ing.{t} WHERE load_id = $1", load_id)


async def fail_load(db: LoaderDB, load_id: int, error: BaseException | str) -> None:
    """롤백 뒤 새 트랜잭션에서 실패 기록. 오류 문자열은 사유를 앞에 두고 2000자로 자른다(현행 describeSyncError 계승)."""
    msg = describe_error(error)
    async with db.session() as conn, db.tx(conn):
        await conn.execute("UPDATE ing.load SET status = 'failed', finished_at = clock_timestamp(), error = $2 WHERE load_id = $1",
                           load_id, msg)


def describe_error(error: BaseException | str) -> str:
    if isinstance(error, str):
        return error[:ERROR_MAX]
    parts = [type(error).__name__]
    code = getattr(error, "sqlstate", None)
    if code:
        parts.append(f"code={code}")
    for attr in ("constraint_name", "table_name"):
        v = getattr(error, attr, None)
        if v:
            parts.append(f"{attr}={v}")
    parts.append(str(error))
    return " ".join(parts)[:ERROR_MAX]


async def analyze(conn: asyncpg.Connection, tables: Iterable[str]) -> tuple[int, int]:
    """트랜잭션 안 ANALYZE(방금 채운 leaf 는 통계가 없어 전파 조인이 중첩 루프로 퇴화: seed-40 §8 실측).
    loader 는 소유자가 아니라 DB-v2.6 P48 rd.analyze_facts(SECURITY DEFINER, 허용 = rd·ing 표)로 한다(ingest R4 반영).
    반환 = (ANALYZE 한 표 수, 권한 없어 건너뛴 표 수)(DB-v2.7 P56, 파티션 트리 기준). 건너뛴 것이 있으면 경고."""
    names = [t for t in tables if t]
    if not names:
        return 0, 0
    r = await conn.fetchrow("SELECT analyzed, skipped FROM rd.analyze_facts($1::regclass[])", names)
    analyzed, skipped = int(r["analyzed"]), int(r["skipped"])
    if skipped:
        log.warning("ANALYZE 건너뜀 %d표(권한 없음): %s", skipped, ",".join(names))
    return analyzed, skipped
