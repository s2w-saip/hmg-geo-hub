"""언급 모듈(M-1·M-2·M-3) 시험 공용 도구. 시험 파일이 아니다(pytest 수집 밖, 이름이 test_ 로 시작하지 않음).

1) 정수 키 조회: brand_key·prompt_key·cyc_key·루트 project_key 를 픽스처에서 이름·UUID·날짜로 찾는다(tests/README §4, 하드코딩 금지).
2) 롤백 트랜잭션 합성 사실 행: core 롤백 전용 준비(tests.support.staged·stage) 위의 얇은 층. rollback_tx() 가 준 커넥션은 진짜
   SQLAlchemy AsyncConnection(api_ro 롤, 실행 가드 설치)이라 기능 서비스(mention_brands·mention_types·mention_prompts)를 그대로 부른다.
   insert_answers 는 stage() 로 소유자가 rd.job·rd.answer·rd.answer_brand 행을 넣는다(같은 트랜잭션, 블록 끝에 ROLLBACK).
3) 창 덮어쓰기(monkeypatch): rd.cycle 쓰기는 기능 시험 정적 가드(G6) 밖이라, 회차 숨김·세대 변경은 core.filters.ReadContext.window
   결과를 바꿔 HTTP 경로(라우터 → 억제 → 서비스 → 봉투)를 탄다. DB → 창 해석 자체는 core 시험 범위다.
"""
from __future__ import annotations

import dataclasses
import uuid
from collections.abc import AsyncIterator, Callable, Iterable, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from typing import Any

from app.core.cycles import CycleRow, Window, build_window
from app.core.db import fetch_all
from app.core.filters import ReadContext
from tests.support import Rows, raw_fetch, stage, staged

GLOBAL_SNAPSHOT = date(2026, 9, 14)      # 픽스처 글로벌 스냅샷 회차 round_date(tests/README §4)
GLOBAL_PREV = date(2026, 9, 7)           # 직전 서빙 회차 round_date


# ── 1) 정수 키 조회 ──────────────────────────────────────────────────────────
async def brand_keys(conn: Any, names: Sequence[str]) -> dict[str, int]:
    rows = await fetch_all(conn, "SELECT n.brand_key, n.name FROM rd.dim_brand_name n WHERE n.name = ANY(CAST(:names AS text[]))",
                           {"names": list(names)})
    got = {r["name"]: int(r["brand_key"]) for r in rows}
    missing = set(names) - set(got)
    assert not missing, f"픽스처에 브랜드 없음: {missing}"
    return got


async def prompt_key(conn: Any, prompt_id: str) -> int:
    rows = await fetch_all(conn, "SELECT p.prompt_key FROM rd.dim_prompt p WHERE p.prompt_id = CAST(:pid AS uuid)", {"pid": prompt_id})
    assert rows, f"픽스처에 프롬프트 없음: {prompt_id}"
    return int(rows[0]["prompt_key"])


async def cycle_row(conn: Any, surface: int, round_date: date) -> CycleRow:
    rows = await fetch_all(conn, "SELECT c.cyc_key, c.project_key, c.round_date, c.hidden_scope FROM rd.cycle c "
                                 "WHERE c.surface = CAST(:sf AS int2) AND c.round_date = CAST(:d AS date)", {"sf": surface, "d": round_date})
    assert len(rows) == 1, rows
    r = rows[0]
    return CycleRow(int(r["cyc_key"]), int(r["project_key"]), r["round_date"], int(r["hidden_scope"]))


def root_project_key(refs: Any) -> int:
    return next(p.project_key for p in refs.projects if p.surface == 1 and p.is_root)


# ── 2) 롤백 트랜잭션(core staged) ─────────────────────────────────────────────
class Raw:
    """독립 기대값 조회용(드라이버 직접, $n 인자). 같은 준비 트랜잭션을 본다. conn = staged 커넥션(insert_answers 가 쓴다)."""

    def __init__(self, conn: Any):
        self.conn = conn

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        return await raw_fetch(self.conn, sql, *args)

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        rows = await raw_fetch(self.conn, sql, *args)
        return rows[0] if rows else None


_JOB = ("answer_key", "job_id", "run_key", "prompt_key", "cyc_key", "round_date", "measured_at", "surface", "project_key", "engine_key",
        "geo_key", "lang_key", "bgrp", "status_code", "analysis_code", "dropped", "served", "load_id")
_ANS = ("round_date", "answer_key", "anchor_date", "cyc_key", "run_key", "prompt_key", "surface", "project_key", "engine_key", "geo_key",
        "lang_key", "cat_mask", "bgrp", "anchor_src", "analysis_state", "own_mask", "own_rk_h", "ment_total", "ment_h", "elig", "dflt",
        "is_rep", "rule_ver", "load_id", "own_rk_k", "own_rk_g", "ment_k", "ment_g")
_AB = ("round_date", "answer_key", "brand_key", "cyc_key", "prompt_key", "surface", "project_key", "engine_key", "geo_key", "lang_key", "bgrp",
       "own_bit", "entity_rows", "mention_count", "rk", "s_pos", "s_neu", "s_neg", "s_mix", "t_mention", "t_recommendation", "t_comparison",
       "t_definition", "t_final_choice", "competitive", "std_in", "elig", "dflt", "rule_ver")


@dataclasses.dataclass(frozen=True)
class BrandRow:
    """합성 answer_brand 행(경쟁 행). own_bit = 관점 비트(당사 1·2·4), 비당사 0.
    types = 유형 5종(t_mention·t_recommendation·t_comparison·t_definition·t_final_choice), 없으면 (mentions, 0, 0, 0, 0)."""
    brand_key: int
    own_bit: int
    mentions: int
    rk: int = 0
    pos: int = 0
    neu: int = 0
    neg: int = 0
    mix: int = 0
    types: tuple[int, int, int, int, int] | None = None


@dataclasses.dataclass(frozen=True)
class SynthAnswer:
    """글로벌 표면 std_in 답변 1건. 당사 요약 열(own_mask·own_rk_{h,k,g}·ment_{h,k,g})은 own_bit 1·2·4 행에서 적재기와 같은 식으로
    채운다(순위 = 그 비트 행 rk 의 최소, 언급 = 합). run_key·load_id 는 기존 픽스처 job 에서 빌린다."""
    answer_key: int
    cyc: CycleRow
    prompt_key: int
    engine_key: int
    geo_key: int
    lang_key: int
    bgrp: int
    brands: tuple[BrandRow, ...]
    is_rep: bool = True
    measured_at: datetime | None = None


async def insert_answers(c: Raw, answers: Iterable[SynthAnswer], *, run_key: int, load_id: int) -> None:
    jobs: list[dict[str, Any]] = []
    ans: list[dict[str, Any]] = []
    abr: list[dict[str, Any]] = []
    for a in answers:
        d = a.cyc.round_date
        ment_total = sum(b.mentions for b in a.brands)
        ment = {bit: sum(b.mentions for b in a.brands if b.own_bit == bit) for bit in (1, 2, 4)}
        rk = {bit: min((b.rk for b in a.brands if b.own_bit == bit and b.rk), default=0) for bit in (1, 2, 4)}
        own_mask = sum(bit for bit in (1, 2, 4) if ment[bit])
        at = a.measured_at or datetime(d.year, d.month, d.day, 1, tzinfo=UTC)
        jobs.append(dict(zip(_JOB, (a.answer_key, uuid.UUID(int=a.answer_key), run_key, a.prompt_key, a.cyc.cyc_key, d, at, 1,
                                    a.cyc.project_key, a.engine_key, a.geo_key, a.lang_key, a.bgrp, 0, 0, False, True, load_id), strict=True)))
        ans.append(dict(zip(_ANS, (d, a.answer_key, d, a.cyc.cyc_key, run_key, a.prompt_key, 1, a.cyc.project_key, a.engine_key, a.geo_key,
                                   a.lang_key, a.bgrp, a.bgrp, 2, 0, own_mask, rk[1], ment_total, ment[1], True, True,
                                   a.is_rep, 1, load_id, rk[2], rk[4], ment[2], ment[4]), strict=True)))
        abr += [dict(zip(_AB, (d, a.answer_key, b.brand_key, a.cyc.cyc_key, a.prompt_key, 1, a.cyc.project_key, a.engine_key, a.geo_key,
                               a.lang_key, a.bgrp, b.own_bit, 1, b.mentions, b.rk, b.pos, b.neu, b.neg, b.mix,
                               *(b.types or (b.mentions, 0, 0, 0, 0)), True, True, True, True, 1), strict=True)) for b in a.brands]
    await stage(c.conn, Rows("rd.job", jobs), Rows("rd.answer", ans), Rows("rd.answer_brand", abr))


async def borrowed_run(c: Raw, job_id: str) -> tuple[int, int]:
    """기존 픽스처 job 의 (run_key, load_id): 합성 행이 같은 run·적재에 속하게 한다."""
    r = await c.fetchrow("SELECT j.run_key, j.load_id FROM rd.job j WHERE j.job_id = $1::uuid", job_id)
    assert r is not None
    return int(r["run_key"]), int(r["load_id"])


@asynccontextmanager
async def rollback_tx() -> AsyncIterator[tuple[Raw, Any]]:
    """(독립 조회·행 추가용 Raw, 서비스에 넘길 AsyncConnection). 둘 다 같은 롤백 전용 트랜잭션이다."""
    async with staged() as conn:
        yield Raw(conn), conn


# ── 3) 창 덮어쓰기 ────────────────────────────────────────────────────────────
def patch_window(monkeypatch: Any, change: Callable[[Window], Window]) -> None:
    """core.filters.ReadContext.window 결과에 change 를 적용한다(요청 하나하나에)."""
    orig = ReadContext.window

    async def _window(self: ReadContext, conn: Any, **kw: Any) -> Window:
        return change(await orig(self, conn, **kw))

    monkeypatch.setattr(ReadContext, "window", _window)


def hide(round_dates: Sequence[date], scope: int = 3) -> Callable[[Window], Window]:
    """그 round_date 회차의 hidden_scope 를 바꾼 창(3 = mentions, rd.cycle.hidden_scope 코드)."""
    def change(w: Window) -> Window:
        rows = [dataclasses.replace(r, hidden_scope=scope) if r.round_date in round_dates else r for r in w.cycles]
        pks = tuple(sorted({r.project_key for r in w.cycles} | set(w.missing_project_keys))) or (0,)
        return build_window(surface=w.surface, mode=w.mode, rows=rows, lo=w.lo, hi=w.hi, generation=w.generation, project_keys=pks)
    return change


def bump_generation(w: Window) -> Window:
    return dataclasses.replace(w, generation=(w.generation or 0) + 1)
