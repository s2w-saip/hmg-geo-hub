"""결과 캐시 시험 공용 호출 목록: 허용 목록(core.result_cache.ALLOWLIST) 전 엔드포인트 × 대표 파라미터 × 계정.

동치 시험(test_result_cache.py: 캐시 끔 = 미스 = 적중 바이트)과 표 커버 시험(test_result_cache_tables.py: 실행 문장이 읽는 표)이 같은
목록을 쓴다. 기본 화면 호출(app/tools/warm_calls.json)에 더해 필터 축 분기(국가·브랜드·언어·엔진·기간·택소노미·depth4·출처·cf.*)를
하나씩 태워 조회 시점에 읽히는 app 표가 빠지지 않게 한다. {SKEY} 는 시험이 도메인 목록 첫 행의 skey 로 바꾼다.
"""
from __future__ import annotations

import importlib
import json
import pathlib

from sqlalchemy import event
from sqlalchemy.engine import Engine

from app.features import FEATURE_ROUTERS
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, VENDOR, WEBSITE_KIA

BACK = pathlib.Path(__file__).resolve().parents[2]
WARM_CALLS = BACK / "app" / "tools" / "warm_calls.json"
P = str(CUST_PROJECT)
TREND_BRAND = {"bucket": "cycle", "dimension": "brand", "metrics": ["visibility", "share_of_voice", "position"], "split_own": "true", "top": "20"}


def warm_calls() -> list[tuple[str, dict]]:
    """기본 화면 호출(데우기 목록) 그대로: (경로, 파라미터)."""
    d = json.loads(WARM_CALLS.read_text(encoding="utf-8"))
    return [(c["path"], c["params"]) for c in d["calls"]]


# (계정, 경로, 파라미터). 파라미터 값 목록 = 같은 키 반복(요청 순서 그대로)
EXTRA: list[tuple[object, str, dict]] = [
    # 표면·계정 변형
    (HQ_HYUNDAI, "/v1/trend", {"surface": "global"}),
    (KIA_US, "/v1/trend", {"surface": "global", **TREND_BRAND}),
    (KIA_EU, "/v1/mentions/brands", {"surface": "global", "top_n": "20", "include": "hmg"}),
    (WEBSITE_KIA, "/v1/kpi/summary", {"surface": "website"}),
    (WEBSITE_KIA, "/v1/filters/options", {"surface": "website"}),
    (KIA_EU, "/v1/geo", {"surface": "website"}),
    (ADMIN, "/v1/trend", {"surface": "project", "project_id": P}),
    (VENDOR, "/v1/trend", {"surface": "project", "project_id": P}),
    (HQ_HYUNDAI, "/v1/kpi/summary", {"surface": "project", "project_id": P}),
    (ADMIN, "/v1/mentions/brands", {"surface": "project", "project_id": P}),
    (VENDOR, "/v1/filters/options", {"surface": "project", "project_id": P}),
    (ADMIN, "/v1/kpi/engines", {"surface": "project", "project_id": P, "part": "all"}),
    # 필터 축 분기(조회 시점 app 표: app.prompt·app.prompt_custom_field_value·app.project_custom_field·rd.dim_taxon 등)
    (ADMIN, "/v1/trend", {"surface": "global", "country": ["US", "KR", "ZZ"], "brand": ["Kia", "Hyundai"]}),
    (ADMIN, "/v1/trend", {"surface": "global", "lang": ["en"], "engine": ["chatgpt"], "from": "2026-09-01", "to": "2026-09-20"}),
    (ADMIN, "/v1/trend", {"surface": "global", "funnel": ["awareness"], "depth1": ["x"], "depth4": ["x"]}),
    (ADMIN, "/v1/trend", {"surface": "project", "project_id": P, "cf.00000000-0000-4000-8000-00000000abcd": "v", "funnel": ["x"]}),
    (ADMIN, "/v1/kpi/summary", {"surface": "global", "depth4": ["x"], "list_type": ["x"]}),
    (ADMIN, "/v1/kpi/unmeasured-prompts", {"surface": "global"}),
    (ADMIN, "/v1/kpi/unmeasured-prompts", {"surface": "project", "project_id": P, "depth4": ["x"]}),
    (ADMIN, "/v1/kpi/compare", {"surface": "global"}),
    (ADMIN, "/v1/kpi/compare", {"surface": "global", "kind": "cycle"}),
    (ADMIN, "/v1/citations/domains", {"surface": "global", "source": ["officialHmg"], "q": "a"}),
    (ADMIN, "/v1/citations/domains/{SKEY}", {"surface": "global"}),
    (ADMIN, "/v1/citations/sources/types", {"surface": "global"}),
    (ADMIN, "/v1/citations/sources/tone", {"surface": "global", "tone": "positive"}),
    (ADMIN, "/v1/citations/sources/tone", {"surface": "global", "tone": "negative", "group_by": "source", "with_counts": "true"}),
    (ADMIN, "/v1/citations/prompts", {"surface": "global", "owned": "false"}),
    (ADMIN, "/v1/citations/targets", {"surface": "website"}),
    (ADMIN, "/v1/mentions/types", {"surface": "global", "split_own": "true"}),
    (ADMIN, "/v1/filters/dates", {"surface": "project", "project_id": P}),
    (ADMIN, "/v1/filters/options", {"surface": "project", "project_id": P, "cf.00000000-0000-4000-8000-00000000abcd": "v"}),
    (ADMIN, "/v1/funnel/acr", {"surface": "global"}),
    (ADMIN, "/v1/funnel/acr", {"surface": "project", "project_id": P}),
    (ADMIN, "/v1/geo", {"surface": "global", "from": "2026-09-01", "to": "2026-09-20"}),
]


def all_calls() -> list[tuple[object, str, dict]]:
    """관리자 기본 화면 호출 전부 + 변형."""
    return [(ADMIN, path, params) for path, params in warm_calls()] + EXTRA


# ── 시험 도우미 ──────────────────────────────────────────────────────────────
def feature_routes() -> list:
    return [r for _, mod in FEATURE_ROUTERS for r in importlib.import_module(mod).router.routes]


async def get(client_as, uid, path: str, params: dict):
    async with client_as(uid) as c:
        return await c.get(path, params=params)


async def resolve_skey(client_as) -> str:
    r = await get(client_as, ADMIN, "/v1/citations/domains", {"surface": "global", "limit": "5"})
    assert r.status_code == 200, r.text[:300]
    items = r.json()["data"]["items"]
    assert items, "픽스처 인용 도메인 없음"
    return items[0]["skey"]


def materialize(path: str, skey: str) -> str:
    return path.replace("{SKEY}", skey)


class Stmts:
    """이 블록에서 실행된 SQL 문장(모든 엔진)."""

    def __init__(self) -> None:
        self.seen: list[str] = []

    def __enter__(self) -> Stmts:
        event.listen(Engine, "before_cursor_execute", self._before)
        return self

    def __exit__(self, *a: object) -> None:
        event.remove(Engine, "before_cursor_execute", self._before)

    def _before(self, conn, cursor, statement, parameters, context, executemany) -> None:  # noqa: ANN001
        self.seen.append(statement)
