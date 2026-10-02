"""WU-5 G21A(m05_den_hostless) API 값 시험: ⑤ 분모(카드·엔진·GEO)는 호스트 없는 인용을 포함하고, 도메인 목록·인용 화면 프롬프트 목록은 그대로다.

템플릿 픽스처: 글로벌 회차 2026-09-14 답변 1(answer_key 1)에 호스트 없는 인용(source_key 0) 1건(cit_n 9, cit_n_all 10, cit_in ∧ dflt).
DB 읽기 전용(ro 복제본, 설정만 바꾼다).
"""
from __future__ import annotations

from typing import Any

from app.core.config import set_settings
from tests.support import ADMIN, needs_db

pytestmark = needs_db
Q = {"surface": "global", "from": "2026-09-14", "to": "2026-09-14"}


async def _calls(client_as: Any) -> dict[str, Any]:
    async with client_as(ADMIN) as c:
        s = (await c.get("/v1/kpi/summary", params=Q)).json()["data"]
        e = (await c.get("/v1/kpi/engines", params=Q)).json()["data"]
        g = (await c.get("/v1/geo", params=Q)).json()["data"]
        d = (await c.get("/v1/citations/domains", params={**Q, "limit": "0"})).json()["data"]
        p = [(await c.get("/v1/citations/prompts", params={**Q, "owned": o, "limit": "20"})).json()["data"] for o in ("true", "false")]
    return {"summary": s, "engines": e, "geo": g, "domains": d, "prompts": p}


def _geo_den(g: Any) -> int:
    tot = 0

    def walk(x: Any) -> None:
        nonlocal tot
        if isinstance(x, dict):
            cs = x.get("citation_share")
            if isinstance(cs, dict) and "den" in cs and x.get("code") and len(str(x.get("code"))) == 2:
                tot += int(cs["den"])
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(g)
    return tot


async def test_m05_den_includes_hostless(settings, client_as):
    off = await _calls(client_as)
    set_settings(settings.model_copy(update={"legacy_profile": "m05_den_hostless"}))
    try:
        on = await _calls(client_as)
    finally:
        set_settings(settings)
    extra = 1       # 픽스처: 답변 1 의 호스트 없는 인용 1건(cit_n 9·cit_n_all 10, 모듈 머리 주석)
    so, sn = off["summary"]["citation_share"], on["summary"]["citation_share"]
    assert sn["num"] == so["num"] and sn["den"] == so["den"] + extra
    eo = sum(int(r["cit_total"] or 0) for r in off["engines"]["rows"])
    en = sum(int(r["cit_total"] or 0) for r in on["engines"]["rows"])
    assert en == eo + extra and en == sn["den"]                                   # D6: 엔진 합 = 카드
    # GEO 국가 분모: 같은 빌더(fetch_counts group_by geo)라 카드와 같은 식. 이 픽스처는 시장 트리가 비어(geo 175 권역 밖) 값 대조는 하지 않는다
    assert _geo_den(on["geo"]) - _geo_den(off["geo"]) in (0, extra)
    assert on["domains"] == off["domains"] and on["prompts"] == off["prompts"]      # 도메인 목록·프롬프트 목록은 현행도 제외
