"""WU-12 현행 프로필 domains_card_by_host: 대시보드 도메인 목록(card=true 또는 host_fold=true) = 도메인(호스트) 단위.

현행 대시보드 도메인(집계층 summary_trend_domains axis 'domain', 미러 GROUP BY c2.domain)은 공식 소셜 계정 그룹 키를 그 도메인 행에 합친다
(WU-11 대조 C01 facebook.com 2,570 대 허브 2,567, C04 youtube.com 5,839 대 5,838). 인용 화면 도메인 표(그룹 키 단위)는 그대로.
준비(롤백 전용, bg.pgsql @host_row): 템플릿 답변 1 의 계정 출처 linkedin.com/hyundai-motor-group 인용 1건 + 같은 답변 도메인 행 linkedin.com 1건.
"""
from __future__ import annotations

import pathlib
from typing import Any

import pytest

from app.core.config import set_settings
from tests.support import ADMIN, Sql, load_named_sql, needs_db, staged

pytestmark = needs_db
BG = load_named_sql(pathlib.Path(__file__).with_name("bg.pgsql"))
Q = {"surface": "global", "from": "2026-09-14", "to": "2026-09-14", "limit": "50"}
ACCT, HOST = "linkedin.com/hyundai-motor-group", "linkedin.com"


async def _get(client_as: Any, params: dict[str, str]) -> dict[str, Any]:
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/citations/domains", params=params)
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _rows(d: dict[str, Any]) -> dict[str, tuple[int, int, str, int | None]]:
    return {x["skey"]: (x["citations"], x["citing_answers"], x["domain"], x["citing_prompts"]) for x in d["items"]}


@pytest.mark.parametrize("spec", ["off", "domains_card_by_host"])
async def test_host_fold(settings, client_as, spec):
    set_settings(settings.model_copy(update={"legacy_profile": spec}))
    try:
        async with staged(Sql(BG["host_row"])):
            plain = await _get(client_as, Q)
            card = await _get(client_as, {**Q, "card": "true"})
            hostf = await _get(client_as, {**Q, "host_fold": "true"})
            tot0 = await _get(client_as, {**Q, "limit": "0", "card": "true"})
    finally:
        set_settings(settings)
    base = _rows(plain)
    assert base[ACCT] == (1, 1, HOST, 1) and base[HOST] == (1, 1, HOST, 1)                # 인용 화면(그룹 키 단위)은 스위치와 무관
    if spec == "off":
        assert _rows(card) == base and _rows(hostf) == base
        assert tot0["summary"] == plain["summary"]
        return
    for d in (card, hostf):
        rows = _rows(d)
        # 계정 키가 도메인 행에 합쳐진다(인용·인용 답변 가산, 인용 프롬프트는 같은 프롬프트라 1 = 서로 다른 프롬프트 수)
        assert ACCT not in rows and rows[HOST][:3] == (2, 2, HOST) and rows[HOST][3] == 1
        assert {k: v for k, v in rows.items() if k != HOST} == {k: v for k, v in base.items() if k not in (HOST, ACCT)}
        assert d["summary"]["total_citations"] == plain["summary"]["total_citations"]
        assert d["summary"]["unique_sources"] == plain["summary"]["unique_sources"] - 1
    assert tot0["summary"]["unique_sources"] == plain["summary"]["unique_sources"] - 1   # limit=0(대시보드 D8) 도 같은 접기
    assert tot0["summary"]["total_citations"] == plain["summary"]["total_citations"]


def test_fold_anchor_must_appear_exactly_once():
    """접기 치환 앵커가 문장 모양 변경으로 없거나 둘 이상이면 조용히 미적용되지 않고 멈춘다(int2 검증 저위험 지적)."""
    from app.features.analytics.citations.domains.queries import _replace_once

    assert _replace_once("a\nWITH g AS (x)", "\nWITH g AS (", "\nWITH f AS (") == "a\nWITH f AS (x)"
    for txt, n in (("a", 0), ("\nWITH g AS (\nWITH g AS (", 2)):
        with pytest.raises(RuntimeError, match=f"{n}번 있다"):
            _replace_once(txt, "\nWITH g AS (", "x")
