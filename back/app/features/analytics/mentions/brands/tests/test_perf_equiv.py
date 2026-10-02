"""성능 라운드 A4(2026-09-30) 동치: brand_extras_sql 2단 집계 = 이전 한 단계 count(DISTINCT) 식(legacy_perf).

1) 문장 단위: 같은 스코프·창에서 두 문장의 결과 행(값과 파이썬 형)이 같다. multi_prompts(복수 언급 행이 있는 프롬프트 수)·
   prompts(프롬프트 수)는 count(DISTINCT) 를 안쪽 그룹 수로 바꾼 식이라 따로 단언한다.
2) 응답 단위: GET /v1/mentions/brands include=prompts·multi·types 를 새 식·이전 식으로 불러 봉투 바이트가 같다.
준비(perf_seed.pgsql): 회차 11·10 에 합성 경쟁 행(같은 프롬프트가 여러 답변·엔진·국가에, 복수 언급은 일부 프롬프트에만, 숨김 시장 ID·
비경쟁·비표준·비기본 엔진 행 포함).
"""
from __future__ import annotations

import pathlib
from typing import Any

import pytest

from app.core.auth import load_principal
from app.core.db import fetch_all
from app.core.errors import ApiError
from app.core.filters import CommonFilters
from app.features.analytics.mentions.brands import queries as q
from app.features.analytics.mentions.brands import service
from app.features.analytics.mentions.brands.common import read_scope
from app.features.analytics.mentions.brands.tests import legacy_perf
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, KIA_US, SqlFile, needs_db, staged

SEED = pathlib.Path(__file__).with_name("perf_seed.pgsql")
URL = "/v1/mentions/brands"
FILTERS: list[dict[str, Any]] = [
    {"surface": "global"},
    {"surface": "global", "from": "2026-09-01", "to": "2026-09-30"},
    {"surface": "global", "engine": ["gemini"]},
    {"surface": "global", "country": ["US", "DE"]},
    {"surface": "global", "brand": ["Kia"]},
    {"surface": "website"},
]


class _Req:
    query_params: dict[str, Any] = {}


def _key(r: dict[str, Any]) -> tuple[int, int]:
    return int(r["brand_key"]), int(r["own_bit"])


def _typed(rows: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    return sorted(tuple((k, type(v).__name__, v) for k, v in r.items()) for r in rows)


@needs_db
@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI, KIA_US, KIA_EU], ids=["admin", "hq_hyundai", "kia_us", "kia_eu"])
async def test_brand_extras_statement_equiv(uid):
    async with staged(SqlFile(SEED)) as conn:
        p = await load_principal(conn, uid)
        seen = 0
        for f in FILTERS:
            try:
                ctx, win = await read_scope(conn, p, CommonFilters(**f), _Req())    # type: ignore[arg-type]
            except ApiError:                         # 이 계정이 볼 수 없는 표면·축(403·422)은 건너뛴다
                continue
            if win.empty:
                continue
            ms = ctx.measure()
            new_q, old_q = q.brand_extras_sql(ms, win), legacy_perf.brand_extras_sql(ms, win)
            new = await fetch_all(conn, new_q.text, new_q.params)
            old = await fetch_all(conn, old_q.text, old_q.params)
            assert _typed(new) == _typed(old), f
            assert sorted(_key(r) for r in new) == sorted(_key(r) for r in old)
            seen += len(new)
            by_old = {_key(r): r for r in old}
            for r in new:
                o = by_old[_key(r)]
                assert (r["prompts"], r["multi_prompts"]) == (o["prompts"], o["multi_prompts"])
        assert seen > 0


PARAMS: list[dict[str, Any]] = [
    {"include": ["prompts", "multi", "types"]},
    {"include": ["prompts", "multi", "types", "hmg"], "full": "true"},
    {"include": ["prompts", "multi", "types"], "split_own": "true", "top_n": 5},
    {"include": ["multi", "types"], "group_by": "engine", "top_n": 3},
    {"include": ["prompts", "multi"], "sort": "avg_rank", "q": "o"},
]


@needs_db
@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI, KIA_US], ids=["admin", "hq_hyundai", "kia_us"])
async def test_mentions_brands_response_equiv(client_as, monkeypatch, uid):
    async with staged(SqlFile(SEED)):
        nonzero = 0
        for f in FILTERS[:5]:
            for extra in PARAMS:
                params = {**f, **extra}
                async with client_as(uid) as c:
                    new = await c.get(URL, params=params)
                    with monkeypatch.context() as m:
                        m.setattr(service, "brand_extras_sql", legacy_perf.brand_extras_sql)
                        old = await c.get(URL, params=params)
                assert new.status_code == old.status_code, (params, new.text, old.text)
                assert new.content == old.content, params
                if new.status_code == 200:
                    nonzero += sum(1 for b in new.json()["data"]["brands"] if (b.get("multi") or {}).get("prompts"))
        assert nonzero > 0                      # 복수 언급 프롬프트 값이 실제로 실린 응답이 있다(빈 값끼리의 동치가 아니다)
