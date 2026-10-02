"""웹 카드 경로 성능 수정(be/web-card-perf, 2026-10-01) 값 동치: 새 문장 응답 = 종전 문장 응답, 바이트 단위.

바뀐 것(값 무관):
  1. core.measure.web_unit_pred: 제외 유닛 판정 NOT EXISTS → <> ALL(ARRAY(제외 file_seq)). 두 열 NOT NULL·빈 배열 참이라 같은 집합.
  2. citations/domains 목록 문장의 합계 CTE t 를 MATERIALIZED 로.
오라클 = 같은 준비 트랜잭션에서 두 이름을 종전 식(LEGACY_PRED·legacy_perf.domains_sql)으로 바꿔 끼운 같은 요청(test_perf_equiv 와 같은 방식).
호출 = warm_calls.json 의 웹사이트 카드 호출 전부(front 가 보내는 모양) + 필터 몇 가지, 계정 = 관리자·기아 서유럽(브랜드·국가 범위).
제외 유닛 = 없음·유닛 밖 값(999)·소속 유닛(101) 세 가지: 101 은 모수를 비워 대조가 비어 있지 않음을 보인다.
"""
from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

from app.core import measure as M
from app.core.config import set_settings
from app.features.analytics.citations.domains import queries as dq
from app.features.analytics.citations.domains.tests import legacy_perf
from tests.support import ADMIN, KIA_EU, Rows, Sql, load_named_sql, needs_db, staged

pytestmark = needs_db
BACK = pathlib.Path(__file__).resolve().parents[2]
ROUNDS = load_named_sql(BACK / "app" / "features" / "analytics" / "kpi" / "summary" / "tests" / "rounds.pgsql")
# test_db_v216 과 같은 명세: Kia DE 유닛(fs 101), kia.com/de/sub 타겟(P23)은 명세 밖 → 픽스처 웹 답변이 게이트 안팎으로 갈린다
UNIT_SUB = Rows("app.website_report_unit", [{"ix": 0, "brand_code": "Kia", "country_code": "DE", "lang_code": "de", "url_like": None,
                                             "url_not_like": "kia.com/de/sub%", "spec_fs": 101}])
REFRESH = Sql("SELECT rd.refresh_web_report_prompt(NULL)")
PROFILE = "card_slot_rep,summary_all_engines,web_registered_only"


def LEGACY_PRED(a: str) -> str:
    """종전(c37de4ae) 식 그대로."""
    return (f"{a}.prompt_key IN (SELECT w.prompt_key FROM rd.web_report_prompt w "
            "WHERE NOT EXISTS (SELECT 1 FROM app.website_report_excluded x WHERE x.file_seq = w.report_fs))")


def _web_card_calls() -> list[tuple[str, dict[str, Any]]]:
    calls = json.loads((BACK / "app" / "tools" / "warm_calls.json").read_text(encoding="utf-8"))["calls"]
    out = [(c["path"], dict(c["params"])) for c in calls
           if c["params"].get("surface") == "website" and c["params"].get("card") == "true"]
    assert {p for p, _ in out} >= {"/v1/mentions/brands", "/v1/citations/domains", "/v1/geo", "/v1/kpi/summary"}
    return out


FILTERS: tuple[dict[str, Any], ...] = ({}, {"brand": "Kia"}, {"country": "DE"}, {"from": "2026-07-01", "to": "2026-09-30"})


async def _bodies(client_as, uid) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    async with client_as(uid) as c:
        for path, params in _web_card_calls():
            for f in FILTERS:
                r = await c.get(path, params={**params, **f})
                out[f"{path} {json.dumps(f)}"] = r.status_code.to_bytes(2, "big") + r.content
    return out


@pytest.mark.parametrize("excluded", [(), (999,), (101,)], ids=["none", "outside", "member"])
async def test_web_card_new_equals_legacy(client_as, settings, monkeypatch, excluded):
    steps = [Sql(ROUNDS["web_dup_prompt"]), UNIT_SUB, REFRESH]
    if excluded:
        steps.append(Rows("app.website_report_excluded", [{"file_seq": x} for x in excluded]))
    assert "NOT EXISTS" not in M.web_unit_pred("a") and "<> ALL (ARRAY(" in M.web_unit_pred("a")   # 새 식이 실제로 쓰인다
    try:
        set_settings(settings.model_copy(update={"legacy_profile": PROFILE}))
        async with staged(*steps):
            new = {uid: await _bodies(client_as, uid) for uid in (ADMIN, KIA_EU)}
            with monkeypatch.context() as m:
                m.setattr(M, "web_unit_pred", LEGACY_PRED)
                # 이전 문장 사본은 host_fold(WU-12 domains_card_by_host 전용) 이전이라 받지 않는다: 이 시험은 그 스위치가 꺼진 프로필이라 무효과
                # (be/int2 통합: wu12-domains 의 test_perf_equiv 와 같은 감쌈)
                m.setattr(dq, "domains_sql", lambda *a, host_fold=False, **k: legacy_perf.domains_sql(*a, **k))
                old = {uid: await _bodies(client_as, uid) for uid in (ADMIN, KIA_EU)}
    finally:
        set_settings(settings)
    for uid in (ADMIN, KIA_EU):
        diff = [k for k in new[uid] if new[uid][k] != old[uid][k]]
        assert not diff, (uid, diff[:5])
        assert all(v[:2] == (200).to_bytes(2, "big") for v in new[uid].values()), uid


async def test_web_card_gate_contrast(client_as, settings):
    """대조가 비어 있지 않다: 소속 유닛(101)을 제외하면 같은 카드 호출 값이 바뀐다(게이트가 실제로 걸린 호출을 비교했다)."""
    base = [Sql(ROUNDS["web_dup_prompt"]), UNIT_SUB, REFRESH]
    try:
        set_settings(settings.model_copy(update={"legacy_profile": PROFILE}))
        async with staged(*base):
            a = await _bodies(client_as, KIA_EU)
        async with staged(*base, Rows("app.website_report_excluded", [{"file_seq": 101}])):
            b = await _bodies(client_as, KIA_EU)
    finally:
        set_settings(settings)
    changed = [k for k in a if a[k] != b[k]]
    assert any(k.startswith("/v1/mentions/brands") for k in changed), changed
    assert any(k.startswith("/v1/kpi/summary") for k in changed), changed


def test_domains_t_materialized():
    """목록 문장의 합계 CTE 는 MATERIALIZED(1행 추정 시 출처 행마다 재집계 차단)."""
    src = (BACK / "app" / "features" / "analytics" / "citations" / "domains" / "queries.py").read_text(encoding="utf-8")
    assert "\nt AS MATERIALIZED (\n  SELECT coalesce(sum(s.citations), 0)::numeric AS total FROM s)," in src
