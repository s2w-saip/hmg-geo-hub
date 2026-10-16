"""리팩터 #13·DC-23 프로젝트 ⑥ 인용 정확도 현행 정의(project_accuracy_single_base) DB 시험(합성 픽스처, 롤백 전용).
단위 시험 = test_legacy_profile test_switch_project_accuracy_single_base.

현행(hmg-geo 2670a16 aggregateCitationAccuracy·aggregateCitationAccuracyTrend, scope-aggregates.ts:8392-8559, 호출 projects/[id]/_data/live.ts:225-268):
  P = normalizeUrlForMatch(유효 owned base 하나: 설정 base 1개, 없으면 project.domain), 자사 답변 = 인용 정규형이 P 이거나 P/ 하위인 인용이 있는 답변,
  분모 = 자사 답변, 분자 = 그중 인용 정규형이 추적 URL 정규형에 든 답변. 설정 base 2개 이상·추적 URL 0개 = 값 없음.
준비(CLONE): 고객 프로젝트(회차 31) 답변 k31 을 둘 복제한다. 9031 = 추적 URL landing(자사 접두 /news 밖)만 인용, 9032 = /news 하위만 인용.
  복제 답변의 인용 수 열은 복제한 인용(적재 판정 loc_owned·tgt_hit 그대로)에서 적재기 식(_ig_citc·_ig_citf)으로 다시 센다.
  허브 기본 = 분모 own_url_cited(loc_owned ∨ tgt_hit) {k31, 9031, 9032}, 분자 tgt_cited {k31, 9031} → (2, 3).
  현행 = 분모 {k31, 9032}, 분자 {k31} → (1, 2).
기대값은 rd 인용 정규형을 파이썬으로 다시 센다(현행 식 그대로, 접두는 현행 normalizeUrlForMatch 결과를 글자로 적는다).
"""
from __future__ import annotations

import pytest
from starlette.datastructures import QueryParams

from app.core.config import set_settings
from tests.support import CUST_PROJECT, VENDOR, Sql, needs_db, raw_fetch, staged

pytestmark = needs_db
SUMMARY = "/v1/kpi/summary"
P = {"surface": "project", "project_id": str(CUST_PROJECT)}
TREND = {**P, "bucket": "cycle", "measured_days": "false", "metrics": "citation_accuracy"}
ON = "project_accuracy_single_base"
TARGETS = ("mybrand.example.com/landing",)          # 추적 URL https://mybrand.example.com/landing 의 정규형

CLONE = Sql("""
DO $$
DECLARE ac text; cc text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO ac FROM pg_attribute
   WHERE attrelid = 'rd.answer'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' AND attname <> 'answer_key';
  EXECUTE format('INSERT INTO rd.answer (answer_key, %1$s) SELECT n.k, %1$s FROM rd.answer, (VALUES (9031), (9032)) n(k)'
                 ' WHERE surface = 3 AND round_date = DATE ''2026-09-20'' AND answer_key = 31', ac);
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cc FROM pg_attribute
   WHERE attrelid = 'rd.citation'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' AND attname NOT IN ('answer_key', 'ord');
  EXECUTE format('INSERT INTO rd.citation (answer_key, ord, %1$s) SELECT n.k, 1, %1$s FROM rd.citation, (VALUES (9031, 2), (9032, 1)) n(k, o)'
                 ' WHERE surface = 3 AND round_date = DATE ''2026-09-20'' AND answer_key = 31 AND ord = n.o', cc);
END $$;
UPDATE rd.answer a SET has_cit = x.n > 0, tgt_cited = x.tgt > 0, own_url_cited = x.lt > 0,
       cit_n = x.n, cit_loc = x.loc, cit_tgt = x.tgt, cit_loc_tgt = x.lt, cit_off = 0,
       cit_own_h = 0, cit_own_k = 0, cit_own_g = 0, cit_own_hc = 0, cit_own_kc = 0, cit_own_gc = 0, cit_own_x = 0,
       cit_n_all = NULL, cit_c1 = NULL, cit_c2 = NULL, cit_c3 = NULL, cit_c4 = NULL, cit_c5 = NULL, cit_c6 = NULL, cit_c7 = NULL,
       cit_c8 = NULL, cit_c9 = NULL, cit_c10 = NULL, cit_c11 = NULL, cit_c12 = NULL, cit_c13 = NULL
  FROM (SELECT answer_key, count(*) FILTER (WHERE source_key <> 0)::int2 AS n,
               count(*) FILTER (WHERE source_key <> 0 AND loc_owned)::int2 AS loc,
               count(*) FILTER (WHERE source_key <> 0 AND tgt_hit)::int2 AS tgt,
               count(*) FILTER (WHERE source_key <> 0 AND (loc_owned OR tgt_hit))::int2 AS lt
          FROM rd.citation WHERE surface = 3 AND round_date = DATE '2026-09-20' AND answer_key IN (9031, 9032) GROUP BY answer_key) x
 WHERE a.surface = 3 AND a.round_date = DATE '2026-09-20' AND a.answer_key = x.answer_key;
""")
PID = "'c0000000-0000-4000-8000-000000000003'"
BASE_LANDING = Sql(f"UPDATE app.project_owned_base SET base_url = 'https://mybrand.example.com/landing', base_norm = 'mybrand.example.com/landing'"
                   f" WHERE project_id = {PID}")
NO_BASE = Sql(f"DELETE FROM app.project_owned_base WHERE project_id = {PID}")     # 유효 base = project.domain(https://mybrand.example.com/)
TWO_BASES = Sql(f"INSERT INTO app.project_owned_base (project_id, base_url, base_norm, created_by) VALUES ({PID}, 'https://mybrand.example.com/landing',"
                f" 'mybrand.example.com/landing', '5eed0000-0000-4000-8000-000000000001')")
NO_TRACKED = Sql(f"DELETE FROM app.project_tracked_url WHERE project_id = {PID}")

# 모수 = 허브 ⑥ 과 같은 답변(창 회차 31 · 프로젝트 · 기본 엔진 · cit_in). 인용은 그 답변의 전부
_ROWS = """
SELECT a.answer_key, a.own_url_cited, a.tgt_cited,
       coalesce((SELECT array_agg(u.url_norm) FROM rd.citation c JOIN rd.dim_url u ON u.url_key = c.url_key
                  WHERE c.surface = 3 AND c.round_date = DATE '2026-09-20' AND c.answer_key = a.answer_key), '{}') AS urls
  FROM rd.answer a JOIN rd.dim_project dp ON dp.project_key = a.project_key
 WHERE a.surface = 3 AND a.round_date = DATE '2026-09-20' AND a.cyc_key = 31 AND a.cit_in AND a.dflt AND dp.project_id = $1
"""


def _legacy(rows: list[dict], prefix: str, targets: tuple[str, ...]) -> tuple[int, int]:
    """현행 식(scope-aggregates.ts:8434-8455): 자사 = 정규형 = P ∨ LIKE P || '/%'(접두에 % _ 없음 = startswith), 분자 = 자사 ∧ 타겟."""
    own = [r for r in rows if any(u and (u == prefix or u.startswith(prefix + "/")) for u in r["urls"])]
    hit = [r for r in own if set(r["urls"]) & set(targets)]
    return len(hit), len(own)


def _hub(rows: list[dict]) -> tuple[int, int]:
    den = [r for r in rows if r["own_url_cited"]]
    return len([r for r in den if r["tgt_cited"]]), len(den)


def _pair(body: dict) -> tuple[int, int] | None:
    r = body["data"]["citation_accuracy"]
    return (r["num"], r["den"]) if r else None


def _trend_pairs(body: dict) -> list[tuple[int, int] | None]:
    return [((p["ratio"]["num"], p["ratio"]["den"]) if p.get("ratio") else None)
            for s in body["data"]["series"] if s["metric"] == "citation_accuracy" for p in s["points"]]


async def _run(client_as, settings, profile: str, *steps):
    try:
        set_settings(settings.model_copy(update={"legacy_profile": profile}))
        async with staged(CLONE, *steps) as conn:
            rows = await raw_fetch(conn, _ROWS, CUST_PROJECT)
            async with client_as(VENDOR) as c:
                s = await c.get(SUMMARY, params=P)
                t = await c.get("/v1/trend", params=TREND)
                assert s.status_code == 200 and t.status_code == 200, (s.text, t.text)
                return rows, s.json(), t.json()
    finally:
        set_settings(settings)


async def test_project_accuracy_current_definition(client_as, settings):
    rows, on, ton = await _run(client_as, settings, ON)
    _, off, toff = await _run(client_as, settings, "off")
    assert sorted(r["answer_key"] for r in rows) == [31, 9031, 9032]              # 준비: 같은 모수에 복제 답변 둘
    want, hub = _legacy(rows, "mybrand.example.com/news", TARGETS), _hub(rows)
    assert want == (1, 2) and hub == (2, 3)                                       # 준비가 현행 정의와 허브 정의를 가른다
    assert _pair(on) == want and _trend_pairs(ton) == [want]                      # 켜짐 = 현행: 카드·추이(회차 31 한 점)가 같은 쌍
    assert _pair(off) == hub and _trend_pairs(toff) == [hub]                      # 꺼짐 = 허브 기본(종전 응답)
    assert "citation_accuracy" not in on["meta"]["suppressed"]
    # 모수·다른 URL 인용률은 스위치와 무관하다(판정만 바뀐다)
    for k in ("target_url_rate", "owned_url_rate", "visibility", "citation_share"):
        assert on["data"][k] == off["data"][k], k


@pytest.mark.parametrize("step,prefix", [
    (BASE_LANDING, "mybrand.example.com/landing"),     # 접두 등치 분기: k31·9031(landing) 자사·타겟, 9032(/news) 밖 → (2, 2)
    (NO_BASE, "mybrand.example.com"),                  # 설정 base 0개 = project.domain https://mybrand.example.com/ → 셋 다 자사 → (2, 3)
])
async def test_project_accuracy_effective_base(client_as, settings, step, prefix):
    rows, on, ton = await _run(client_as, settings, ON, step)
    want = _legacy(rows, prefix, TARGETS)
    assert want == {"mybrand.example.com/landing": (2, 2), "mybrand.example.com": (2, 3)}[prefix]
    assert _pair(on) == want and _trend_pairs(ton) == [want]


@pytest.mark.parametrize("step", [TWO_BASES, NO_TRACKED], ids=["two_bases", "no_tracked_url"])
async def test_project_accuracy_no_value(client_as, settings, step):
    """현행은 ⑥ 을 조회하지 않는다(유효 base 2개 이상 · 추적 URL 0개): 카드 값 없음(no_data), 추이 점 값 없음."""
    _, on, ton = await _run(client_as, settings, ON, step)
    assert _pair(on) is None and on["meta"]["suppressed"]["citation_accuracy"] == "no_data"
    assert _trend_pairs(ton) == [None]


async def test_switch_off_issues_no_project_accuracy_statement(client_as, settings, monkeypatch):
    """스위치 끔(기본) = 판정 입력·⑥ 추가 문장 없음(지연 영향 0). 켜면 요약·추이가 한 번씩 부른다(대조)."""
    from app.features.analytics.kpi.summary import service as summary_svc
    from app.features.analytics.trend.series import service as trend_svc
    calls: list[str] = []

    async def spy(conn, ms, win, *, group_by=()):
        calls.append("trend" if group_by else "card")
        return [] if group_by else [{"own_url_hits": 0, "tgt_own_hits": 0}]
    monkeypatch.setattr(summary_svc, "project_accuracy_counts", spy)
    monkeypatch.setattr(trend_svc, "project_accuracy_counts", spy)
    await _run(client_as, settings, "off")
    assert calls == []
    await _run(client_as, settings, ON)
    assert calls == ["card", "trend"]


async def test_project_accuracy_cache_key(settings):
    """결과 캐시 끝점 추가 키: 켜짐 ∧ project 표면이면 판정 입력(base·domain·추적 URL) 지문, 편집하면 바뀐다. 그 밖 None(문장 없음)."""
    from app.core.measure import project_accuracy_cache_key
    q = QueryParams(P)
    try:
        set_settings(settings.model_copy(update={"legacy_profile": "off"}))
        async with staged() as conn:
            assert await project_accuracy_cache_key(conn, q) is None
        set_settings(settings.model_copy(update={"legacy_profile": ON}))
        async with staged() as conn:
            k0 = await project_accuracy_cache_key(conn, q)
            assert isinstance(k0, str) and len(k0) == 32
            assert await project_accuracy_cache_key(conn, QueryParams({**P, "surface": "website"})) is None
            assert await project_accuracy_cache_key(conn, QueryParams({**P, "project_id": "x"})) is None
        async with staged(BASE_LANDING) as conn:
            k1 = await project_accuracy_cache_key(conn, q)
        async with staged(NO_TRACKED) as conn:
            k2 = await project_accuracy_cache_key(conn, q)
        assert len({k0, k1, k2}) == 3
    finally:
        set_settings(settings)
