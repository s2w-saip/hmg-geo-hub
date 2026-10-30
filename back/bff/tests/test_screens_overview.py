"""Overview dashboards (bff.screens.overview): rules the golden cases do not reach — 4xx paths (raised,
so the page keeps its error route), failure classification, call parameters, master-data helpers.

The two module functions below are function-golden targets (front/test/bff-golden/overview.golden.test.ts)."""
import asyncio
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from bff.screens import build
    from bff.screens import overview as ov
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_overview)") from exc


def numeric_table() -> dict:
    """Golden target: the ISO alpha-2 -> world-atlas numeric table (lib/geo-catalog/country-numeric.ts)."""
    return dict(ov.GEO_COUNTRY_NUMERIC)


def pending_of(brand: str) -> list:
    """Golden target: buildGeo with no rows -> the active brand's RHQ regions (lib/rhq)."""
    return ov.empty_geo(brand or None)["pending"]


def run(coro):
    return asyncio.run(coro)


META = {"surface": "global", "mode": "snapshot", "as_of": "2026-10-05", "cycles": ["2026-10-05"], "ignored_filters": [],
        "dropped_filters": {}, "suppressed": {}, "source": {"url_rates": "live"}}


def summary(answers: int = 100) -> dict:
    return {"data": {"visibility": {"num": 50, "den": answers}, "share_of_voice": {"num": 30, "den": 100},
                     "sentiment": {"num": 10, "den": 30}, "position": {"sum": 60, "count": 50},
                     "citation_share": {"num": 5, "den": 50},
                     "params": {"answers": answers, "measured_prompts": 1, "applied_prompts": 1,
                                "prompts_without_brand": 0, "measured_by_funnel": None}, "analysis_gap": None},
            "meta": META}


GEO = {"data": {"markets": [], "pending": [], "own_label": "HMG"}, "meta": META}


class Router:
    """bff.api.get stand-in: answers by path, raises the configured HTTP status, records the calls."""

    def __init__(self, bodies: dict, fail: dict | None = None):
        self.bodies, self.fail, self.calls = bodies, fail or {}, []

    async def get(self, path, params=None):
        from bff.api import query
        self.calls.append((path, list(query(params).multi_items())))
        key = "brand-trend" if path == "trend" and dict(query(params)).get("dimension") == "brand" else path
        if key in self.fail:
            raise HTTPException(self.fail[key], "boom")
        body = self.bodies.get(key)
        if body is None:
            raise AssertionError(f"unexpected call {path}")
        return body


def screen(name: str, qs: str, router: Router):
    with mock.patch("bff.api.get", router.get):
        return run(build(name, QueryParams(qs)))


class Failures(unittest.TestCase):
    def test_transient_classification(self):
        self.assertTrue(ov.is_transient(HTTPException(503)))
        self.assertTrue(ov.is_transient(HTTPException(500)))
        self.assertTrue(ov.is_transient(TimeoutError()))
        self.assertTrue(ov.is_transient(ConnectionResetError()))
        self.assertFalse(ov.is_transient(HTTPException(422)))
        self.assertFalse(ov.is_transient(HTTPException(404)))
        self.assertFalse(ov.is_transient(KeyError("x")))

    def test_4xx_is_raised_by_every_section(self):
        cases = [
            ("overview/as-of", "", {"kpi/summary": 422}),
            ("overview/cards", "", {"kpi/summary": 403}),
            ("overview/cards", "time=2026-09-01..2026-10-05", {"kpi/compare": 422}),
            ("overview/card-trend", "", {"trend": 422}),
            ("overview/card-competitors", "", {"mentions/brands": 422}),
            ("overview/card-competitors", "", {"brand-trend": 422}),
            ("overview/geo", "", {"geo": 403}),
            ("website/summary", "", {"kpi/summary": 401}),
            ("website/summary-deferred", "", {"kpi/engines": 403}),
            ("website/trend", "", {"trend": 422}),
            ("website/composition", "", {"citations/domains": 422}),
        ]
        bodies = {"kpi/summary": summary(), "mentions/brands": {"data": {"brands": []}, "meta": META},
                  "trend": {"data": {"bucket": "cycle", "dimension": "none", "own_label": "HMG", "buckets": [], "series": []},
                            "meta": META},
                  "brand-trend": {"data": {"bucket": "cycle", "dimension": "brand", "own_label": "HMG", "buckets": [],
                                           "series": []}, "meta": META},
                  "citations/domains": {"data": {"summary": {"own_share": {"num": 0, "den": 0}}, "items": [],
                                                 "competitor_sources": []}, "meta": META},
                  "kpi/engines": {"data": {"rows": []}, "meta": META}, "geo": {"data": {}, "meta": META},
                  "kpi/compare": {"data": [], "meta": META}}
        for name, qs, fail in cases:
            with self.subTest(name=name, fail=fail), self.assertRaises(HTTPException) as cm:
                screen(name, qs, Router(bodies, fail))
            self.assertLess(cm.exception.status_code, 500)

    def test_website_trend_failure_is_raised_but_the_deferred_tiles_keep_going(self):
        bodies = {"kpi/summary": summary(), "mentions/brands": {"data": {"brands": []}, "meta": META},
                  "kpi/engines": {"data": {"rows": []}, "meta": META}}
        with self.assertRaises(HTTPException):
            screen("website/trend", "", Router(bodies, {"trend": 503}))
        out = screen("website/summary-deferred", "", Router(bodies, {"trend": 503}))
        self.assertEqual(out["state"], "ok")


class Calls(unittest.TestCase):
    def test_card_reads_send_the_front_parameters(self):
        router = Router({"kpi/summary": summary(), "mentions/brands": {"data": {"brands": []}, "meta": META}})
        screen("overview/cards", "brand=Kia&engine=ChatGPT", router)
        calls = dict(router.calls)
        self.assertEqual(calls["kpi/summary"], [("brand", "Kia"), ("card", "true"), ("engine", "chatgpt"),
                                                ("parts", "urls"), ("surface", "global")])
        self.assertEqual(calls["mentions/brands"], [("brand", "Kia"), ("card", "true"), ("engine", "chatgpt"),
                                                    ("include", "hmg"), ("sort", "mentions"), ("surface", "global"),
                                                    ("top_n", "20")])

    def test_open_period_sends_one_end_and_no_compare(self):
        router = Router({"kpi/summary": summary(), "mentions/brands": {"data": {"brands": []}, "meta": META}})
        out = screen("overview/cards", "time=2026-09-20..", router)
        self.assertEqual([p for p, _ in router.calls].count("kpi/compare"), 0)
        self.assertIn(("from", "2026-09-20"), dict(router.calls)["kpi/summary"])
        self.assertIsNone(out["compareTitle"])

    def test_website_without_one_active_brand_never_reads_geo(self):
        router = Router({"kpi/summary": {**summary(), "meta": {**META, "surface": "website"}},
                         "mentions/brands": {"data": {"brands": []}, "meta": META}})
        out = screen("website/geo", "ctx.admin=true&brand=Kia~Genesis", router)
        self.assertNotIn("geo", [p for p, _ in router.calls])
        self.assertEqual(out["geo"]["markets"], [])
        # a non-admin page ignores ?brand= (the website brand axis is admin only)
        router = Router(router.bodies)
        screen("website/geo", "ctx.admin=false&brand=Kia", router)
        self.assertNotIn("geo", [p for p, _ in router.calls])

    def test_website_geo_of_a_one_brand_account_is_that_brands(self):
        # the original activeBrandFor: one URL brand, else the scope's one brand (2026-10-31: website opens to
        # scoped accounts, renewal audit step 2); a scope of two brands has none
        from bff import access
        bodies = {"kpi/summary": {**summary(), "meta": {**META, "surface": "website"}},
                  "mentions/brands": {"data": {"brands": []}, "meta": META}, "geo": GEO}
        one = {"all": False, "brands": ["Genesis"], "regions": ["genesis-middle-east"], "countries": []}
        router = Router(bodies)
        with access.scoped(one):
            out = screen("website/geo", "ctx.admin=false", router)
        self.assertIn("geo", [p for p, _ in router.calls])
        self.assertTrue(out["show"])
        self.assertEqual(ov.active_brand_of({"brand": ["Genesis", "HMG"]}, one), "Genesis")
        two = {**one, "brands": ["Genesis", "Kia"], "regions": []}
        router = Router(bodies)
        with access.scoped(two):
            screen("website/geo", "ctx.admin=false", router)
        self.assertNotIn("geo", [p for p, _ in router.calls])

    def test_geo_reads_its_markets_with_the_summary(self):
        # the markets read leaves with the summary, not after it (the summary only decides whether they show)
        geo_started = asyncio.Event()

        class Gate(Router):
            async def get(self, path, params=None):
                if path == "geo":
                    geo_started.set()
                elif path == "kpi/summary":
                    await asyncio.wait_for(geo_started.wait(), 2)
                return await super().get(path, params)

        out = screen("overview/geo", "", Gate({"kpi/summary": summary(), "geo": GEO}))
        self.assertIsNotNone(out["geo"], "the summary waited for nothing: the markets read never left")
        self.assertEqual((out["geo"]["ourLabel"], out["degraded"]), ("HMG", False))

    def test_geo_markets_count_only_when_the_summary_has_answers(self):
        for fail in (403, 503):
            with self.subTest(fail=fail):
                out = screen("overview/geo", "", Router({"kpi/summary": summary(answers=0), "geo": GEO}, {"geo": fail}))
                self.assertEqual(out, {"geo": None, "degraded": False})
        out = screen("overview/geo", "", Router({"kpi/summary": summary(), "geo": GEO}, {"geo": 503}))
        self.assertEqual(out, {"geo": None, "degraded": True})
        out = screen("overview/geo", "", Router({"kpi/summary": summary(), "geo": GEO}, {"kpi/summary": 503}))
        self.assertEqual(out, {"geo": None, "degraded": False})

    def test_unknown_surface_is_refused(self):
        with self.assertRaises(HTTPException) as cm:
            screen("overview/as-of", "ctx.surface=project", Router({}))
        self.assertEqual(cm.exception.status_code, 422)


class Helpers(unittest.TestCase):
    def test_rhq_regions_and_empty_geo(self):
        self.assertEqual(ov.rhq_region_ids_for_brand("Genesis"),
                         ["genesis-asia-pacific", "genesis-middle-east", "genesis-north-america", "genesis-europe",
                          "genesis-africa"])
        self.assertEqual(ov.empty_geo(None), {"markets": [], "pending": [], "ourLabel": "HMG"})

    def test_own_label(self):
        self.assertEqual(ov.own_label_of({"brand": ["Kia", "HMG", "Genesis"]}), "Kia, Genesis")
        self.assertEqual(ov.own_label_of({"brand": ["HMG"]}), "HMG")
        self.assertEqual(ov.own_label_of({}), "HMG")

    def test_delta_mark(self):
        self.assertIsNone(ov.delta_mark("visibility", None))
        self.assertEqual(ov.delta_mark("visibility", 0.04), {"r": 0, "tone": "flat"})
        self.assertEqual(ov.delta_mark("visibility", -0.05), {"r": 0, "tone": "flat"})  # Math.round(-0.5) = -0
        self.assertEqual(ov.delta_mark("visibility", 0.05), {"r": 0.1, "tone": "good"})
        self.assertEqual(ov.delta_mark("position", 0.25), {"r": 0.3, "tone": "bad"})
        self.assertEqual(ov.delta_mark("position", -1.25), {"r": -1.2, "tone": "good"})

    def test_tile_goodness(self):
        self.assertEqual([ov.goodness(d, b) for d in ("up", "down", "flat") for b in ("higher", "lower")],
                         ["good", "bad", "bad", "good", "flat", "flat"])

    def test_geo_view_sorts_countries_by_the_localized_name(self):
        live = {"ourLabel": "HMG", "pending": [], "markets": [
            {"region": "", "hmgSov": 1, "metrics": None, "topBrand": {"name": "HMG", "sov": 1}, "topRival": None,
             "countries": [{"code": c, "hmgSov": 1, "metrics": None, "topBrand": None, "topRival": None}
                           for c in ("US", "KR", "DE", "SA-Dammam")]}]}
        ko = ov.geo_view(__import__("copy").deepcopy(live), "ko")
        en = ov.geo_view(__import__("copy").deepcopy(live), "en")
        self.assertEqual(ko["countryOrder"], ["KR", "DE", "US", "SA-Dammam"])  # 대한민국 독일 미국 사우디 아라비아 - 담맘
        self.assertEqual(en["countryOrder"], ["DE", "SA-Dammam", "KR", "US"])  # Germany, Saudi Arabia - Dammam, South Korea, United States
        self.assertFalse(ko["markets"][0]["showLead"])
        self.assertEqual(ko["markets"][0]["numerics"], ["840", "410", "276"])


OFFICIAL_COMPETITOR = {"category_key": 2, "slug": "officialCompetitor", "name": "Official (Competitor)"}
DEALER = {"category_key": 3, "slug": "dealerMarketplace", "name": "Dealer & Marketplace"}


def citation_share_row(sources: list[dict]) -> list[dict]:
    """The AI 인용 점유율 card's competitor row over the official competitor sources the reader sends."""
    domains = {"data": {"summary": {"own_share": {"num": 0, "den": 1000}}, "competitor_sources": sources}, "meta": META}
    router = Router({"mentions/brands": {"data": {"brands": []}, "meta": META}, "citations/domains": domains},
                    {"brand-trend": 503})
    return screen("overview/card-competitors", "", router)["rows"]["citationShare"]


def source(domain: str, citations: int, brand: str, category: dict = OFFICIAL_COMPETITOR) -> dict:
    return {"skey": domain, "domain": domain, "citations": citations, "competitor_brand": brand, "category": category}


class CompetitorCitations(unittest.TestCase):
    """2026-10-29 metric review ⚠️: the competitor row guessed each source's brand from its domain (a token table
    from the old front) and called every source official; the attribution is Gold's (competitor_brand, category)."""

    def test_sources_fold_to_the_brand_gold_gives_them(self):
        # the table read none of bydauto.com.br, wrote smart for Gold's Smart and folded maybach.com into Mercedes-Benz
        row = citation_share_row([source("bydauto.com.br", 50, "BYD"), source("smart.com", 40, "Smart"),
                                  source("byd.com", 30, "BYD"), source("maybach.com", 20, "Maybach"),
                                  source("mercedes-benz.com", 10, "Mercedes-Benz")])
        self.assertEqual(row, [{"brand": "BYD", "value": 8.0}, {"brand": "Smart", "value": 4.0},
                               {"brand": "Maybach", "value": 2.0}, {"brand": "Mercedes-Benz", "value": 1.0}])

    def test_only_sources_gold_files_as_official_competitor_count(self):
        row = citation_share_row([source("toyotacertified.com", 90, "Toyota", DEALER), source("toyota.com", 30, "Toyota")])
        self.assertEqual(row, [{"brand": "Toyota", "value": 3.0}])



class BrandMatrixFailures(unittest.TestCase):
    """Gold metric review ⚠️ Overview #31 #32 (2026-10-29): the brand table dropped what failed — a competitor read
    that failed left 당사 alone under "경쟁사 값을 제공하지 않는 지표입니다", a failed trend left the Δ out without a
    word. The table names the parts that failed (the old degrade labels); a failed summary is raised, so the page
    shows the table's failure instead of no table."""

    BODIES = {"kpi/summary": summary(), "mentions/brands": {"data": {"brands": []}, "meta": META},
              "trend": {"data": {"bucket": "cycle", "dimension": "none", "own_label": "HMG", "buckets": [], "series": []},
                        "meta": META},
              "brand-trend": {"data": {"bucket": "cycle", "dimension": "brand", "own_label": "HMG", "buckets": [],
                                       "series": []}, "meta": META},
              "citations/domains": {"data": {"summary": {"own_share": {"num": 0, "den": 0}}, "items": [],
                                             "competitor_sources": []}, "meta": META}}

    def matrix(self, fail: dict):
        return screen("overview/brand-matrix", "", Router(self.BODIES, fail))

    def test_nothing_failed_names_nothing(self):
        out = self.matrix({})
        self.assertEqual(sorted(out), ["cols", "rows"])

    def test_the_parts_that_failed_are_named(self):
        cases = [({"mentions/brands": 503}, ["standardMentions"]),
                 ({"brand-trend": 503}, ["brandTrend", "firstPosition"]),
                 ({"citations/domains": 503}, ["standardCitationDomains"]),
                 ({"trend": 503}, ["standardTrend:day"]),
                 ({"mentions/brands": 503, "trend": 503}, ["standardMentions", "standardTrend:day"])]
        for fail, labels in cases:
            with self.subTest(fail=fail):
                out = self.matrix(fail)
                self.assertEqual(out["degraded"], labels)
                self.assertEqual(out["rows"][0]["own"], True)

    def test_a_failed_summary_is_raised(self):
        with self.assertRaises(HTTPException) as cm:
            self.matrix({"kpi/summary": 503})
        self.assertEqual(cm.exception.status_code, 503)



def engine(code: str, answers: int, tracked: int, mentions: tuple, sent: tuple, rank: tuple, cit: tuple) -> dict:
    """One kpi/engines row: (tracked, total) mentions, (positive, all) signals, (rank_sum, ranked), (own, total) citations."""
    return {"engine": code, "answers": answers, "tracked": tracked, "multi": 0, "top1": 0, "top3": 0,
            "rank_sum": rank[0], "ranked": rank[1], "total_mentions": mentions[1], "tracked_mentions": mentions[0],
            "sent_mentions": sent[1], "positive_mentions": sent[0], "negative_mentions": 0,
            "cit_total": cit[1], "cit_owned": cit[0]}


class WebsiteBreakdowns(unittest.TestCase):
    """Renewal Website Overview (2026-10-30, W1): the per-engine and per-brand breakdowns are the Gold values
    the page already reads, laid out — the engine rows behind the 엔진 간 일관성 badge, and the brand tiles
    read with one brand each. Nothing is judged: best / worst follow each KPI's direction only."""

    ENGINES = {"data": {"rows": [engine("chatgpt", 200, 190, (95, 100), (30, 100), (210, 190), (40, 100)),
                                 engine("gemini", 100, 33, (40, 50), (20, 40), (40, 33), (10, 80))]}, "meta": META}

    def test_engine_values_are_the_badge_rows(self):
        out = screen("website/engines", "ctx.admin=true", Router({"kpi/engines": self.ENGINES}))
        self.assertFalse(out["degraded"])
        rows = {r["engine"]: r for r in out["engines"]}
        self.assertEqual(rows["chatgpt"]["answers"], 200)
        self.assertEqual(rows["chatgpt"]["values"], {"visibility": 95.0, "shareOfVoice": 95.0, "sentiment": 30.0,
                                                     "position": 1.1, "citationShare": 40.0})
        self.assertEqual(rows["gemini"]["values"], {"visibility": 33.0, "shareOfVoice": 80.0, "sentiment": 50.0,
                                                    "position": 1.2, "citationShare": 12.5})
        self.assertEqual(rows["gemini"]["ratios"]["visibility"], {"num": 33, "den": 100})
        self.assertEqual(rows["gemini"]["ratios"]["position"], {"sum": 40, "count": 33})
        # the badge's numbers, from the same rows
        self.assertEqual(out["consistency"]["visibility"], 34.7)
        self.assertEqual(out["consistency"]["position"], round(100 * (210 / 190) / (40 / 33), 1))
        # best / worst by the KPI's direction (rank: lower is better)
        self.assertEqual(out["extremes"]["visibility"], {"best": {"engine": "chatgpt", "value": 95.0},
                                                         "worst": {"engine": "gemini", "value": 33.0}})
        self.assertEqual(out["extremes"]["position"]["best"]["engine"], "chatgpt")
        self.assertEqual(out["extremes"]["sentiment"]["best"]["engine"], "gemini")
        # the widest spread = the lowest consistency
        self.assertEqual(out["widest"], "citationShare")

    def test_the_consistency_is_the_badge_on_the_tiles(self):
        bodies = {"kpi/summary": {**summary(), "meta": {**META, "surface": "website"}},
                  "mentions/brands": {"data": {"brands": []}, "meta": META}, "kpi/engines": self.ENGINES,
                  "trend": {"data": {"bucket": "cycle", "dimension": "none", "own_label": "HMG", "buckets": [], "series": []},
                            "meta": META}}
        tiles = screen("website/summary-deferred", "", Router(bodies))["tiles"]
        badges = {t["key"]: t["engineConsistency"] for g in tiles["groups"] for t in g["tiles"] if "engineConsistency" in t}
        self.assertEqual(badges, screen("website/engines", "", Router(bodies))["consistency"])

    def test_one_engine_has_no_extremes(self):
        one = {"data": {"rows": self.ENGINES["data"]["rows"][:1]}, "meta": META}
        out = screen("website/engines", "ctx.admin=true&engine=chatgpt", Router({"kpi/engines": one}))
        self.assertEqual(len(out["engines"]), 1)
        self.assertEqual(out["extremes"], {})
        self.assertIsNone(out["widest"])

    def test_engines_degrade_on_a_transient_failure_and_raise_a_4xx(self):
        out = screen("website/engines", "", Router({}, {"kpi/engines": 503}))
        self.assertEqual(out, {"engines": [], "consistency": {}, "extremes": {}, "widest": None, "degraded": True})
        with self.assertRaises(HTTPException):
            screen("website/engines", "", Router({}, {"kpi/engines": 422}))

    BRAND_BODIES = {"kpi/summary": {**summary(), "meta": {**META, "surface": "website"}},
                    "mentions/brands": {"data": {"brands": []}, "meta": META},
                    "kpi/engines": {"data": {"rows": []}, "meta": META},
                    "trend": {"data": {"bucket": "cycle", "dimension": "none", "own_label": "HMG", "buckets": [], "series": []},
                              "meta": META},
                    "filters/options": {"data": {"regions": [], "languages": [],
                                                 "geo_matrix": [{"brand": "Kia"}, {"brand": "Hyundai"}, {"brand": "Genesis"}]},
                                        "meta": META}}

    def test_brands_side_by_side_for_an_administrator_without_a_brand_pick(self):
        router = Router(self.BRAND_BODIES)
        out = screen("website/brands", "ctx.admin=true&geography=US", router)
        self.assertEqual([b["brand"] for b in out["brands"]], ["Genesis", "Hyundai", "Kia"])
        summaries = [dict(c) for p, c in router.calls if p == "kpi/summary"]
        self.assertEqual(sorted(c["brand"] for c in summaries), ["Genesis", "Hyundai", "Kia"])
        self.assertTrue(all(c["country"] == "US" for c in summaries))
        row = out["brands"][0]
        self.assertEqual(row["state"], "ok")
        cell = row["cells"]["visibility"]
        self.assertEqual((cell["value"], cell["unit"], cell["pending"]), (50.0, "percent", False))
        # every brand ties on the stand-in values: each is the best, the bars are full
        self.assertEqual([b["cells"]["visibility"]["best"] for b in out["brands"]], [True, True, True])
        self.assertEqual(cell["bar"], 100)

    def test_no_brands_without_the_brand_axis_or_with_a_pick(self):
        for qs in ("ctx.admin=false", "ctx.admin=true&brand=Kia"):
            with self.subTest(qs=qs):
                router = Router(self.BRAND_BODIES)
                self.assertEqual(screen("website/brands", qs, router), {"brands": None})
                self.assertEqual(router.calls, [])


def compare_item(metric: str, unit: str, cycles: tuple) -> dict:
    """One kpi/compare answer: the period's (cur, prev) rounds, nothing suppressed."""
    num = {"prev": {"num": 40, "den": 100}, "cur": {"num": 50, "den": 100}}
    if unit == "rank":
        num = {"prev": {"sum": 60, "count": 30}, "cur": {"sum": 50, "count": 25}}
    return {"metric": metric, "family": "citation" if metric == "citation_share" else "mention", "unit": unit, **num,
            "delta": None, "suppressed": False, "reason": None, "missing_share_prev": 0, "missing_share_cur": 0,
            "cycles_cur": cycles[0], "cycles_prev": cycles[1], "planned_prev": 10, "planned_cur": 10}


def compare_body(cycles: dict) -> dict:
    """kpi/compare for the five Overview metrics, each with its own (cur, prev) rounds."""
    units = {"visibility": "pp", "share_of_voice": "pp", "sentiment": "pp", "position": "rank", "citation_share": "pp"}
    return {"data": [compare_item(m, u, cycles.get(m, (3, 3))) for m, u in units.items()], "meta": META}


class CompareLabels(unittest.TestCase):
    """Renewal audit 3-4 · 3-5 (2026-10-31). The renewal Overview header named compare[0]'s label for every card, though
    a window compare counts its rounds per metric (현재 3회차 / 직전 0회차 on one card, 2 / 1 on the next); the website
    header said '바로 앞 같은 길이의 기간' whatever the compare was (a calendar month compares the month before).
    compareTitle is now the label every compared card shares, None when they differ (each card names its own)."""

    WINDOW = "time=2026-09-01..2026-10-05&ctx.today=2026-10-26"
    MONTH = "time=2026-10-01..2026-10-31&ctx.today=2026-10-26"

    def bodies(self, cycles: dict | None = None, surface: str = "global") -> dict:
        return {"kpi/summary": {**summary(), "meta": {**META, "surface": surface}},
                "mentions/brands": {"data": {"brands": []}, "meta": META},
                "kpi/compare": compare_body(cycles or {}),
                "kpi/engines": {"data": {"rows": []}, "meta": META},
                "trend": {"data": {"bucket": "cycle", "dimension": "none", "own_label": "HMG", "buckets": [], "series": []},
                          "meta": META}}

    def test_cards_counting_different_rounds_name_their_own_compare(self):
        out = screen("overview/cards", self.WINDOW, Router(self.bodies({"visibility": (3, 0), "share_of_voice": (2, 1)})))
        labels = {c["key"]: c["period"]["label"] for c in out["cards"]}
        self.assertEqual(labels["visibility"], {"key": "window", "params": {"curCycles": 3, "prevCycles": 0}})
        self.assertEqual(labels["shareOfVoice"], {"key": "window", "params": {"curCycles": 2, "prevCycles": 1}})
        self.assertIsNone(out["compareTitle"])

    def test_cards_counting_the_same_rounds_share_the_header_label(self):
        out = screen("overview/cards", self.WINDOW, Router(self.bodies()))
        self.assertEqual(out["compareTitle"], {"key": "window", "params": {"curCycles": 3, "prevCycles": 3}})
        month = screen("overview/cards", self.MONTH, Router(self.bodies()))
        self.assertEqual(month["compareTitle"], {"key": "label.thisMonth", "params": {}})

    def test_website_tiles_name_the_compare_kind(self):
        for screen_name in ("website/summary", "website/summary-deferred"):
            with self.subTest(screen=screen_name):
                tiles = screen(screen_name, self.MONTH, Router(self.bodies(surface="website")))["tiles"]
                self.assertEqual(tiles["compareTitle"], {"key": "label.thisMonth", "params": {}})
                compared = [t for g in tiles["groups"] for t in g["tiles"] if t["period"]]
                self.assertTrue(compared)
                self.assertTrue(all(t["periodLabel"] == {"key": "label.thisMonth", "params": {}} for t in compared))

    def test_website_tiles_counting_different_rounds_name_their_own_compare(self):
        tiles = screen("website/summary", self.WINDOW, Router(self.bodies({"visibility": (3, 0)}, "website")))["tiles"]
        self.assertIn("compareTitle", tiles)
        self.assertIsNone(tiles["compareTitle"])
        by_key = {t["key"]: t for g in tiles["groups"] for t in g["tiles"]}
        self.assertEqual(by_key["visibility"]["periodLabel"], {"key": "window", "params": {"curCycles": 3, "prevCycles": 0}})
        self.assertEqual(by_key["shareOfVoice"]["periodLabel"], {"key": "window", "params": {"curCycles": 3, "prevCycles": 3}})

    def test_website_tiles_without_a_period_carry_no_compare_label(self):
        tiles = screen("website/summary", "", Router(self.bodies(surface="website")))["tiles"]
        self.assertNotIn("compareTitle", tiles)
        self.assertFalse(any("periodLabel" in t for g in tiles["groups"] for t in g["tiles"]))


class CompetitorSov(unittest.TestCase):
    """Renewal audit 3-3 (2026-10-31): without 당사's share-of-voice numerator the competitor ratio took 당사's mentions as
    0 and the website tile read '0.0배'. No numerator = no ratio."""

    BRANDS = {"brands": [{"name": "Toyota", "mentions": 120, "is_own": False, "is_hmg_own": False}]}

    def sov_tile(self, sov):
        s = summary()
        if sov == "absent":
            del s["data"]["share_of_voice"]
        else:
            s["data"]["share_of_voice"] = sov
        return next(k for k in ov.to_dashboard_kpis(s, self.BRANDS, True) if k["key"] == "shareOfVoice")

    def test_no_own_numerator_has_no_ratio(self):
        for sov in (None, {"num": None, "den": 0}, "absent"):
            with self.subTest(sov=sov):
                self.assertEqual(self.sov_tile(sov)["competitorSov"], {"brand": "Toyota", "value": None})

    def test_an_own_count_of_zero_is_a_ratio_of_zero(self):
        self.assertEqual(self.sov_tile({"num": 0, "den": 100})["competitorSov"], {"brand": "Toyota", "value": 0.0})
        self.assertEqual(self.sov_tile({"num": 30, "den": 100})["competitorSov"], {"brand": "Toyota", "value": 25.0})


if __name__ == "__main__":
    unittest.main()
