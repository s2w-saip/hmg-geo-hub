"""WU-12 웹 ⑥ 인용 정확도 현행 정의(web_accuracy_flat, CACC6) DB 시험(합성 픽스처, 롤백 전용). 단위 시험 = test_legacy_profile test_switch_web_accuracy_flat.
S4: 카드 몫은 웹 회차 21 동결 세대의 셀 판정(frz.card_web, 동결 때 허브 유닛 식으로 굽는다)을 센다. 기대값은 그대로 rd 행 재계산.

준비: 웹 회차 21 인용 숨김 해제, 보고서 유닛 명세 = Kia DE de 전부(rd.web_report_prompt: P21·P22 → 101, P23 → 102), k21 의 허브 tgt_cited 끔.
픽스처 인용: k21(P21) = 자기 타겟 ev9 + sub/page + P22 타겟 shop.kia.de/angebote, k22(P23) = 자기 타겟 kia.com/de/sub/x.
기대값은 rd 행을 파이썬으로 다시 센다(현행 식 그대로):
  unit   = 카드·기간 없음: 모수(유닛 게이트 ∧ 등록) 중 자사(own_url_cited) 답변, 분자 = 그중 인용 URL 이 같은 (프로젝트, report_fs) 프롬프트 타겟 중 하나
  screen = 기간 카드·비카드: 모수(유닛 게이트 없음·기본 엔진) 중 (자사 ∨ 타겟) 답변, 분자 = 인용 URL 이 화면 사이트 전체 타겟 중 하나
"""
from __future__ import annotations

from app.core.config import set_settings
from tests.support import KIA_EU, Rows, Sql, needs_db, staged

pytestmark = needs_db
URL = "/v1/kpi/summary"
UNIT = Rows("app.website_report_unit", [{"ix": 0, "brand_code": "Kia", "country_code": "DE", "lang_code": "de", "url_like": None,
                                         "url_not_like": None, "spec_fs": 101}])
# k21(P21, 유닛 101)은 같은 유닛 P22 의 타겟 shop.kia.de/angebote 도 인용한다. 자기 프롬프트 타겟 적중(허브 tgt_cited)을 끄면
# "같은 유닛 다른 프롬프트 타겟만 인용한 자사 답변"이 된다: 현행 유닛 flat 은 적중, 허브 정의는 아님(C08 3,792 대 5,037 의 형태)
UNHIDE = Sql("UPDATE rd.cycle SET hidden_scope = 0, hidden_reason = 0 WHERE cyc_key = 21")
OWN_MISS = Sql("UPDATE rd.answer SET tgt_cited = false, cit_tgt = 0 WHERE surface = 2 AND round_date = DATE '2026-09-18' AND answer_key = 21")
PREP = (UNHIDE, OWN_MISS, UNIT, Sql("SELECT rd.refresh_web_report_prompt(NULL)"), Sql("SELECT rd.refresh_web_target_url(NULL, NULL)"))
# S4: 카드 몫(유닛 flat)은 동결 층 생성 시점 셀 판정(frz.card_web)이라 web_accuracy_flat 은 freeze_at_publish 를 요구한다. 웹 회차 21 을 준비 뒤 동결한다
PROFILE = "cell_rep,summary_all_engines,web_registered_only,web_accuracy_flat,freeze_at_publish,catalog_incl_deleted,rep_pick_latest_first"
FREEZE21 = Sql("SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key = 21")

_ROWS = """
SELECT a.answer_key, a.prompt_key, a.project_key, a.engine_key, a.dflt, a.is_rep, a.cit_in, a.web_reg, a.own_url_cited, w.report_fs,
       (x.file_seq IS NOT NULL) AS excluded,
       coalesce((SELECT array_agg(u.url_norm) FROM rd.citation c JOIN rd.dim_url u ON u.url_key = c.url_key
                  WHERE c.surface = 2 AND c.round_date = DATE '2026-09-18' AND c.cyc_key = ANY('{21}'::int4[])
                    AND c.answer_key = a.answer_key), '{}') AS urls
  FROM rd.answer a LEFT JOIN rd.web_report_prompt w ON w.prompt_key = a.prompt_key
  LEFT JOIN app.website_report_excluded x ON x.file_seq = w.report_fs
 WHERE a.surface = 2 AND a.round_date = DATE '2026-09-18' AND a.cyc_key = ANY('{21}'::int4[])
"""
_TARGETS = "SELECT prompt_key, project_key, targets FROM rd.dim_prompt WHERE surface = 2"



async def _fetch(conn):
    from app.core.db import fetch_all
    rows = [dict(r) for r in await fetch_all(conn, _ROWS, {})]
    targets = [dict(r) for r in await fetch_all(conn, _TARGETS, {})]
    wrp = {int(r["prompt_key"]): int(r["report_fs"]) for r in await fetch_all(conn, "SELECT prompt_key, report_fs FROM rd.web_report_prompt", {})}
    unit_t: dict[tuple[int, int], set[str]] = {}
    screen_t: set[str] = set()
    for t in targets:
        screen_t |= set(t["targets"] or ())
        fs = wrp.get(int(t["prompt_key"]))
        if fs is not None:
            unit_t.setdefault((int(t["project_key"]), fs), set()).update(t["targets"] or ())
    unit_pop = [r for r in rows if r["is_rep"] and r["cit_in"] and r["web_reg"] and r["report_fs"] is not None and not r["excluded"]]
    u_den = [r for r in unit_pop if r["own_url_cited"]]
    u_num = [r for r in u_den if set(r["urls"]) & unit_t.get((r["project_key"], r["report_fs"]), set())]
    s_pop = [r for r in rows if r["is_rep"] and r["cit_in"] and r["dflt"]]
    s_hit = [r for r in s_pop if set(r["urls"]) & screen_t]
    s_den = [r for r in s_pop if r["own_url_cited"] or r in s_hit]
    hub = [r for r in unit_pop if r["own_url_cited"]]
    return (len(u_num), len(u_den)), (len(s_hit), len(s_den)), len(hub)


async def test_web_accuracy_current_paths(client_as, settings):
    try:
        set_settings(settings.model_copy(update={"legacy_profile": PROFILE}))
        async with staged(*PREP, FREEZE21) as conn:
            unit, screen, _ = await _fetch(conn)
            async with client_as(KIA_EU) as c:
                card = (await c.get(URL, params={"surface": "website", "card": "true"})).json()
                period = (await c.get(URL, params={"surface": "website", "card": "true", "from": "2026-09-01", "to": "2026-09-30"})).json()
                plain = (await c.get(URL, params={"surface": "website"})).json()
                trend = (await c.get("/v1/trend", params={"surface": "website", "card": "true", "bucket": "cycle", "measured_days": "false",
                                                          "metrics": "citation_accuracy"})).json()
        set_settings(settings.model_copy(update={"legacy_profile": "cell_rep,summary_all_engines,web_registered_only"}))
        async with staged(*PREP), client_as(KIA_EU) as c:
            hubv = (await c.get(URL, params={"surface": "website", "card": "true"})).json()
    finally:
        set_settings(settings)

    def pair(body):
        r = body["data"]["citation_accuracy"]
        return (r["num"], r["den"]) if r else None
    assert unit[1] > 0 and screen[1] > 0
    assert pair(card) == unit                                     # 카드·기간 없음 = 집계층 유닛 flat
    assert pair(period) == screen and pair(plain) == screen       # 기간 카드·비카드 = 미러 정의
    assert pair(hubv)[1] == unit[1]                               # 꺼짐 = 허브 정의: 분모(자사 인용 답변)는 같고 분자만 자기 프롬프트 타겟
    pts = [p for s in trend["data"]["series"] if s["metric"] == "citation_accuracy" for p in s["points"] if p.get("ratio")]
    # S4b: 웹 회차 하나(09-18) = 현행 웹 추이 주 1개 → 미러(server.ts:4767·4828 weeks < 2), 허브 = agg-single-cycle 비카드(미러 정의 screen).
    # 이 준비에서는 미러 정의 값과 유닛 값이 같다
    assert [(p["ratio"]["num"], p["ratio"]["den"]) for p in pts] == [screen] == [unit]
    assert unit == (2, 2) and pair(hubv) == (1, 2)                # 준비가 허브 정의와 현행 유닛 정의를 가른다(k21)


async def test_switch_off_issues_no_accuracy_statement(client_as, settings, monkeypatch):
    """스위치 끔(기본) = ⑥ 추가 문장 없음(지연 영향 0): 요약·추이가 accuracy_counts 를 부르지 않는다. 켜면 부른다(대조)."""
    from app.features.analytics.kpi.summary import service as summary_svc
    from app.features.analytics.trend.series import service as trend_svc
    calls: list[str] = []

    async def spy(*a, **k):
        calls.append(k.get("mode", "?"))
        return [] if k.get("group_by") else [{"own_url_hits": 0, "tgt_own_hits": 0}]
    monkeypatch.setattr(summary_svc, "accuracy_counts", spy)
    monkeypatch.setattr(trend_svc, "accuracy_counts", spy)

    async def run(profile: str) -> None:
        set_settings(settings.model_copy(update={"legacy_profile": profile}))
        async with staged(*PREP, FREEZE21), client_as(KIA_EU) as c:
            for params in ({"surface": "website", "card": "true"}, {"surface": "website", "from": "2026-09-01", "to": "2026-09-30"}):
                assert (await c.get(URL, params=params)).status_code == 200
            assert (await c.get("/v1/trend", params={"surface": "website", "card": "true", "bucket": "cycle", "measured_days": "false",
                                                     "metrics": "citation_accuracy"})).status_code == 200
    try:
        await run("off")
        await run("cell_rep,summary_all_engines,web_registered_only")
        assert calls == []
        await run(PROFILE)
        # 요약 카드 = unit, 기간 = screen, 추이 카드 = screen(S4b: 웹 회차 하나 = 주 1개라 현행 추이는 미러, server.ts:4767·4828)
        assert calls == ["unit", "screen", "screen"]
    finally:
        set_settings(settings)


async def test_web_target_url_refresh_semantics():
    """DB-v2.20 P111·P112: 기대값 = 웹 프롬프트 타겟 정규형과 url_norm 이 같은 dim_url 행(프로젝트·언어 단위). 범위 맞추기는 그 범위만,
    바뀐 행만 쓰고(두 번째 = 0), 단언이 어긋남을 잡는다."""
    from app.core.db import fetch_one
    async with staged(role=None) as conn:
        n0 = (await fetch_one(conn, "SELECT rd.refresh_web_target_url(NULL, NULL) AS n", {}))["n"]
        assert (await fetch_one(conn, "SELECT rd.refresh_web_target_url(NULL, NULL) AS n", {}))["n"] == 0
        total = (await fetch_one(conn, "SELECT rd.assert_web_target_url() AS n", {}))["n"]
        want = (await fetch_one(conn, """SELECT count(*) AS n FROM (SELECT DISTINCT d.project_key, d.lang_key, u.url_key
                  FROM rd.dim_prompt d, unnest(d.targets) t, rd.dim_url u WHERE d.surface = 2 AND u.url_norm = t) x""", {}))["n"]
        assert total == want and total > 0 and n0 >= 0
        # 타겟을 바꾸면(정규형 하나 추가) 그 (프로젝트, 언어) 범위 맞추기만 행이 늘고, url_key 범위로도 같은 결과가 된다
        r = await fetch_one(conn, """SELECT d.prompt_key, d.project_key::int4 * 65536 + d.lang_key::int4 AS g FROM rd.dim_prompt d
                                       WHERE d.surface = 2 AND cardinality(d.targets) > 0 ORDER BY d.prompt_key LIMIT 1""", {})
        extra = await fetch_one(conn, """SELECT u.url_key, u.url_norm FROM rd.dim_url u WHERE u.url_norm IS NOT NULL
                                           AND u.url_norm NOT IN (SELECT t FROM rd.dim_prompt d, unnest(d.targets) t) ORDER BY u.url_key LIMIT 1""", {})
        from sqlalchemy import text
        await conn.execute(text(f"UPDATE rd.dim_prompt SET targets = targets || ARRAY['{extra['url_norm']}'] WHERE prompt_key = {r['prompt_key']}")
                           .execution_options(hgh_sql_guard=False))
        assert (await fetch_one(conn, f"SELECT rd.refresh_web_target_url(NULL, ARRAY[{r['g']}]) AS n", {}))["n"] >= 1
        assert (await fetch_one(conn, "SELECT rd.assert_web_target_url() AS n", {}))["n"] > total
        sp = await conn.begin_nested()
        try:
            await conn.execute(text(f"DELETE FROM rd.web_target_url WHERE url_key = {extra['url_key']}").execution_options(hgh_sql_guard=False))
            try:
                await conn.exec_driver_sql("SELECT rd.assert_web_target_url()")
                raise AssertionError("단언이 어긋남을 못 잡았다")
            except Exception as e:                                                        # noqa: BLE001
                assert "기대값" in str(e)
        finally:
            await sp.rollback()
