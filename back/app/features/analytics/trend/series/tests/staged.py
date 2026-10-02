"""T-1·GEO-1 테스트 전용: 합성 픽스처 위에 회차·사실 행을 더한다. core 롤백 전용 준비(tests.support.staged) 위의 얇은 층(검증 D5).

- Stage(추가 회차·숨김 해제)를 소유자 준비 단계로 실행하고(SQLAlchemy Core insert·update 구성: 기능 폴더 SQL 문자열이 아니다),
  요청은 같은 트랜잭션에서 api_ro 롤로 돈다(core staged: 실행 가드 설치 + get_ro_conn 덮어쓰기). 블록이 끝나면 ROLLBACK.
- 사실 행 복사는 원본 회차의 행을 3술어(surface·round_date·cyc_key)로 읽어 새 회차 키·round_date·answer_key 로 넣는다. geos 를 주면
  그 국가 행만 복사하고 국가를 바꾼다(권역 합산 시험용). 답변 인용 수 열(G-25)은 원본 그대로라 자식 합 불변식이 유지된다.
"""
from __future__ import annotations

import contextlib
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import column, insert, table, text, update
from sqlalchemy.ext.asyncio import AsyncConnection

from tests.support import staged as core_staged

FACTS = ("answer", "answer_brand", "citation")

_COLS_SQL = """
SELECT a.attname FROM pg_attribute a
 WHERE a.attrelid = CAST(:rel AS regclass) AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
 ORDER BY a.attnum
"""
_CYCLE_SQL = "SELECT c.surface, c.round_date FROM rd.cycle c WHERE c.cyc_key = :k"
_GEO_SQL = "SELECT g.code, g.geo_key FROM rd.dim_country g WHERE g.code = ANY(CAST(:codes AS text[]))"
_READ = {
    "answer": "SELECT * FROM rd.answer t WHERE t.surface = :sf AND t.round_date = :rd AND t.cyc_key = ANY(CAST(:ks AS int4[]))",
    "answer_brand": "SELECT * FROM rd.answer_brand t WHERE t.surface = :sf AND t.round_date = :rd AND t.cyc_key = ANY(CAST(:ks AS int4[]))",
    "citation": "SELECT * FROM rd.citation t WHERE t.surface = :sf AND t.round_date = :rd AND t.cyc_key = ANY(CAST(:ks AS int4[]))",
}


@dataclass(frozen=True)
class NewCycle:
    """더할 원장 회차. copy_from 을 주면 그 회차의 사실 행을 복사한다(없으면 답변 0 회차)."""
    cyc_key: int
    round_date: date
    surface: int = 1
    project_key: int = 1
    hidden_scope: int = 0          # 0 없음 1 all 2 citations 3 mentions
    hidden_reason: int = 0         # 0 없음 1 collection_error 2 operator
    copy_from: int | None = None
    geos: dict[str, str] | None = None     # 원본 국가 코드 → 새 국가 코드(주면 그 국가 행만 복사)
    # 현행 추이 격자 시험(WU-6)용 원장 열. 기본값 = 종전 삽입값(발행·서빙·노출 +2일, 앵커 = round_date, 카운터 NULL)
    anchor_date: date | None = None
    status: int = 2
    servable: bool = True
    view_days: int | None = 2              # None = view_date NULL
    expected_units: int | None = None
    completed_units: int | None = None
    completed_answers: int | None = None


@dataclass
class Stage:
    cycles: list[NewCycle] = field(default_factory=list)
    unhide: list[int] = field(default_factory=list)      # 숨김을 풀 기존 회차 키(hidden_scope·hidden_reason = 0)


async def _rows(conn: AsyncConnection, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(r._mapping) for r in (await conn.execute(text(sql), params))]


async def _insertable(conn: AsyncConnection, rel: str) -> list[str]:
    return [r["attname"] for r in await _rows(conn, _COLS_SQL, {"rel": rel})]


async def _apply(conn: AsyncConnection, st: Stage) -> None:
    cyc_cols = await _insertable(conn, "rd.cycle")
    cyc_tbl = table("cycle", *[column(c) for c in cyc_cols], schema="rd")
    for key in st.unhide:
        await conn.execute(update(cyc_tbl).where(cyc_tbl.c.cyc_key == key).values(hidden_scope=0, hidden_reason=0))
    fact_cols = {t: await _insertable(conn, f"rd.{t}") for t in FACTS}
    for c in st.cycles:
        await conn.execute(insert(cyc_tbl).values(
            cyc_key=c.cyc_key, cycle_id=uuid.uuid4(), surface=c.surface, project_key=c.project_key, ledger_backed=True,
            round_date=c.round_date, anchor_date=c.anchor_date or c.round_date, status=c.status, servable=c.servable,
            view_date=None if c.view_days is None else c.round_date + timedelta(days=c.view_days),
            hidden_scope=c.hidden_scope, hidden_reason=c.hidden_reason, generation=1, expected_units=c.expected_units,
            completed_units=c.completed_units, completed_answers=c.completed_answers))
        if c.copy_from is None:
            continue
        src = (await _rows(conn, _CYCLE_SQL, {"k": c.copy_from}))[0]
        geo: dict[int, int] | None = None
        if c.geos is not None:
            keys = {r["code"]: int(r["geo_key"]) for r in await _rows(conn, _GEO_SQL, {"codes": sorted({*c.geos, *c.geos.values()})})}
            geo = {keys[a]: keys[b] for a, b in c.geos.items()}
        offset = c.cyc_key * 1000
        for t in FACTS:
            rows = await _rows(conn, _READ[t], {"sf": src["surface"], "rd": src["round_date"], "ks": [c.copy_from]})
            out = []
            for r in rows:
                if geo is not None and int(r["geo_key"]) not in geo:
                    continue
                n = {k: r[k] for k in fact_cols[t]}
                n.update(round_date=c.round_date, cyc_key=c.cyc_key, answer_key=int(r["answer_key"]) + offset)
                if "anchor_date" in n:
                    n["anchor_date"] = c.round_date
                if geo is not None:
                    n["geo_key"] = geo[int(r["geo_key"])]
                    # 답변 region 국가(DB-v2.15 P87)도 같은 매핑으로 옮긴다(글로벌·프로젝트는 geo_key 와 같아야 한다: CHECK answer_region_geo_same)
                    if n.get("region_geo_key") is not None:
                        n["region_geo_key"] = geo.get(int(n["region_geo_key"]), n["geo_key"])
                out.append(n)
            if out:
                await conn.execute(insert(table(t, *[column(k) for k in fact_cols[t]], schema="rd")), out)


@contextlib.asynccontextmanager
async def staged(st: Stage) -> AsyncIterator[AsyncConnection]:
    """st 를 더한 롤백 전용 트랜잭션(요청 커넥션과 같다). 기대값 SQL 도 이 커넥션으로 센다."""
    async def step(conn: AsyncConnection) -> None:
        await _apply(conn, st)

    async with core_staged(step) as conn:
        yield conn


async def scalar_rows(conn: AsyncConnection, sql: str, **params: Any) -> list[dict[str, Any]]:
    """기대값 SQL(가드를 거친다) 실행 도우미."""
    return await _rows(conn, sql, params)
