"""Renewal AI Visibility screen: the derived numbers on a small reader answer checked by hand."""
import json
import unittest
from pathlib import Path
from unittest import mock

try:
    from starlette.datastructures import QueryParams
    from bff.screens import visibility as vis
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_visibility)") from exc

DAYS = [f"2026-10-{d:02d}" for d in range(6, 20)]  # 14 days
PREV_DAYS = [f"2026-09-{d:02d}" for d in range(22, 31)] + [f"2026-10-{d:02d}" for d in range(1, 6)]
SITES = [{"project_key": 1, "site_brand_bit": 1, "country": "US"}, {"project_key": 2, "site_brand_bit": 2, "country": "DE"}]
GPT, GEM = ("GPTBot", "chatgpt"), ("GoogleOther", "gemini")


def every(n, days=DAYS):
    return [n] * len(days)


def answer(pages, days=DAYS, reason=None):
    """The reader's answer after the JSON round trip: per page {pk, uk, url, prio, seo (per day | None), bots {bot: hits per day}, q}."""
    rows, devices, bots, prios = [], [], [], []
    for p in pages:
        for bot, hits in p["bots"].items():
            for d, h in zip(days, hits):
                if h:
                    bots.append({"project_key": p["pk"], "url_key": p["uk"], "date": d, "bot": bot[0], "engine": bot[1], "hits": h})
        if p["seo"] is not None:
            for d in days:
                devices.append({"project_key": p["pk"], "url_key": p["uk"], "date": d, "device": "mobile", "seo_impressions": p["seo"] * 6 // 10})
                devices.append({"project_key": p["pk"], "url_key": p["uk"], "date": d, "device": "desktop", "seo_impressions": p["seo"] * 4 // 10})
        ai = sum(sum(h) for h in p["bots"].values())
        rows.append({"project_key": p["pk"], "url_key": p["uk"], "url": p["url"], "title": p.get("title"), "country": None,
                     "seo_impressions": None if p["seo"] is None else p["seo"] * len(days), "ai_crawls": ai, "quadrant": p.get("q")})
        if p.get("prio") is not None:
            prios.append({"project_key": p["pk"], "url_key": p["uk"], "priority": p["prio"]})
    data = {"kind": "visibility", "period": {"from": days[0], "to": days[-1], "days": len(days)}, "properties": SITES, "pages": rows,
            "devices": devices, "bots": bots, "priorities": prios, "trend": [{"date": d} for d in days]}
    return {"data": data, "meta": {"reason": reason}}


def day0(n):
    return [n] + [0] * (len(DAYS) - 1)


CUR = [
    {"pk": 1, "uk": 10, "url": "https://www.hyundai.com/us/en", "prio": 1, "seo": 100, "bots": {GPT: every(2), GEM: every(1)}, "q": "both"},
    {"pk": 1, "uk": 11, "url": "https://www.hyundai.com/us/en/shopping-tools/offers", "prio": 2, "seo": 50, "bots": {GPT: day0(1)}, "q": "seo_only"},
    {"pk": 1, "uk": 12, "url": "https://www.hyundai.com/us/en/vehicles/ioniq-5", "prio": 1, "seo": 20, "bots": {}, "q": "neither"},
    {"pk": 2, "uk": 20, "url": "https://www.kia.com/de/de/vehicles/ev6", "prio": 1, "seo": 10, "bots": {GPT: every(1)}, "q": "crawl_only"},
    {"pk": 2, "uk": 21, "url": "https://www.kia.com/de/de/news", "prio": 3, "seo": None, "bots": {GPT: day0(5)}, "q": None},
]
PREV = [
    {"pk": 1, "uk": 10, "url": CUR[0]["url"], "prio": 1, "seo": 100, "bots": {GPT: [2] * 14 + [], GEM: [0] * 12 + [1, 1]}},
    {"pk": 1, "uk": 11, "url": CUR[1]["url"], "prio": 2, "seo": 50, "bots": {}},
    {"pk": 1, "uk": 12, "url": CUR[2]["url"], "prio": 1, "seo": 20, "bots": {GPT: [3] + [0] * 13}},
    {"pk": 2, "uk": 20, "url": CUR[3]["url"], "prio": 1, "seo": 10, "bots": {GPT: every(1, PREV_DAYS)}},
]


def run(coro):
    import asyncio
    return asyncio.run(coro)


class UrlRules(unittest.TestCase):
    def test_period_params(self):
        self.assertEqual(vis.period_params({}), {"days": "28"})
        self.assertEqual(vis.period_params({"days": "90"}), {"days": "90"})
        self.assertEqual(vis.period_params({"days": "0"}), {"days": "28"})
        self.assertEqual(vis.period_params({"days": "x"}), {"days": "28"})
        self.assertEqual(vis.period_params({"from": "2026-10-19", "to": "2026-09-01", "days": "7"}), {"from": "2026-09-01", "to": "2026-10-19"})
        self.assertEqual(vis.period_params({"from": "2026-13-01", "to": "2026-10-19"}), {"to": "2026-10-19"})

    def test_period_choice(self):
        self.assertEqual(vis.period_choice({}), {"preset": 28, "days": 28, "from": None, "to": None})
        self.assertEqual(vis.period_choice({"days": "14"}), {"preset": None, "days": 14, "from": None, "to": None})
        self.assertEqual(vis.period_choice({"from": "2026-09-01", "to": "2026-09-30"}), {"preset": None, "days": None, "from": "2026-09-01", "to": "2026-09-30"})

    def test_reader_query_keeps_the_axes_and_drops_the_tab(self):
        q = vis.reader_query({"geography": "US~DE", "engine": "chatgpt", "device": "mobile", "view": "engine", "days": "7"})
        self.assertEqual(q["country"], ["US", "DE"])
        self.assertEqual(q["engine"], ["chatgpt"])
        self.assertEqual(q["device"], ["mobile"])
        self.assertEqual(q["days"], "7")
        self.assertNotIn("view", q)

    def test_section_of_skips_locale_segments(self):
        self.assertEqual(vis.section_of("https://www.hyundai.com/us/en/shopping-tools/offers"), "/shopping-tools")
        self.assertEqual(vis.section_of("https://www.kia.com/de/de/news"), "/news")
        self.assertEqual(vis.section_of("https://www.genesis.com/kr/ko"), "/")
        self.assertEqual(vis.section_of("https://www.hyundai.com/en-gb/vehicles"), "/vehicles")
        self.assertEqual(vis.section_of("https://example.com/careers/jobs"), "/careers")

    def test_rank_levels_share_ties(self):
        self.assertEqual(vis.rank_levels([100, 100, 100]), [2, 2, 2])
        self.assertEqual(vis.rank_levels([1, 2, 3, None]), [0, 2, 4, None])
        self.assertEqual(vis.rank_levels([1, 2, 3], higher_better=False), [4, 2, 0])
        self.assertEqual([vis.fixed_level(v) for v in (100, 90, 75, 60, 10, None)], [4, 3, 2, 1, 0, None])


class View(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.v = vis.visibility_view(answer(CUR)["data"], answer(PREV, PREV_DAYS)["data"], [], [])

    def test_totals_leave_the_incomplete_page_out(self):
        t = self.v["totals"]
        self.assertEqual((t["pages"], t["complete"], t["incomplete"], t["sites"]), (5, 4, 1, 2))
        self.assertEqual((t["seo"], t["ai"]), (2520, 57))
        self.assertAlmostEqual(t["int"], 57 / 2520 * 1e4)
        self.assertEqual(t["cov"], 75.0)
        self.assertAlmostEqual(t["cov1"], 200 / 3)
        self.assertEqual((t["p1"], t["stale1"]), (3, 1))
        self.assertAlmostEqual(t["top10"], 42 / 57 * 100)
        self.assertEqual(t["topN"], 1)

    def test_expected_band_read_and_last_crawl(self):
        rows = {r["path"]: r for r in self.v["rows"]}
        home, offers, ioniq, ev6, news = (rows[p] for p in ("/us/en", "/us/en/shopping-tools/offers", "/us/en/vehicles/ioniq-5", "/de/de/vehicles/ev6", "/de/de/news"))
        r = 57 / 2520
        self.assertAlmostEqual(offers["exp"], 700 * r)
        self.assertAlmostEqual(offers["short"], 700 * r - 1)
        self.assertEqual([x["band"] for x in (home, offers, ioniq, ev6, news)], ["high", "low", "none", "high", None])
        self.assertEqual((home["read"], offers["read"], ioniq["read"]), (1.0, 1 / 14, 0.0))
        self.assertEqual((home["ago"], offers["ago"], ioniq["ago"]), (0, 13, None))
        self.assertEqual(self.v["work"]["p12"], [offers["id"], ioniq["id"]])
        self.assertIsNone(news["short"])

    def test_tiers_sections_engines_combos(self):
        self.assertEqual([(t["prio"], t["pages"], t["freq"]) for t in self.v["tiers"]], [(1, 3, [2, 0, 0, 1]), (2, 1, [0, 0, 1, 0])])
        self.assertEqual([(s["sec"], s["pages"]) for s in self.v["sections"]], [("/", 1), ("/shopping-tools", 1), ("/vehicles", 2)])
        e = {x["engine"]: x for x in self.v["engines"]}
        self.assertEqual([x["engine"] for x in self.v["engines"]], ["chatgpt", "gemini"])
        self.assertEqual((e["chatgpt"]["hits"], e["gemini"]["hits"]), (48, 14))
        self.assertEqual((e["chatgpt"]["cov"], e["gemini"]["cov"]), (75.0, 25.0))
        self.assertEqual([(c["set"], c["n"]) for c in self.v["combos"]], [(["chatgpt"], 2), (["chatgpt", "gemini"], 1), ([], 1)])
        self.assertEqual(self.v["blocks"], [["2026-10-06", "2026-10-12"], ["2026-10-13", "2026-10-19"]])
        self.assertEqual(self.v["spark"]["stale1"], [1, 1])

    def test_previous_period(self):
        t, c, rows = self.v["totals"], self.v["changes"], self.v["rows"]
        self.assertTrue(self.v["prevOk"])
        self.assertAlmostEqual(t["dAi"], (57 - 47) / 47 * 100)
        by = {r["path"]: r["id"] for r in rows}
        self.assertEqual(c["fresh"], [by["/us/en/shopping-tools/offers"]])
        self.assertEqual(c["lost"], [by["/us/en/vehicles/ioniq-5"]])
        self.assertEqual(c["up"][0], by["/us/en"])

    def test_orders_and_findings(self):
        rows, o = self.v["rows"], self.v["orders"]
        # never read sorts as the stalest; a page without a 부족분 (incomplete) is last both ways
        self.assertEqual(rows[o["ago"]["desc"][0]]["path"], "/us/en/vehicles/ioniq-5")
        self.assertEqual(rows[o["short"]["desc"][-1]]["path"], "/de/de/news")
        self.assertEqual(rows[o["short"]["asc"][-1]]["path"], "/de/de/news")
        codes = [f["code"] for f in self.v["findings"]]
        self.assertEqual(codes[:3], ["stale", "shortfall", "engineCoverage"])
        self.assertEqual(len(codes), 4)

    def test_no_previous_period(self):
        v = vis.visibility_view(answer(CUR)["data"], None, [], [])
        self.assertFalse(v["prevOk"])
        self.assertIsNone(v["changes"])
        self.assertNotIn("dAi", v["totals"])

    def test_engine_and_device_filters(self):
        v = vis.visibility_view(answer(CUR)["data"], None, ["gemini"], ["mobile"])
        home = next(r for r in v["rows"] if r["path"] == "/us/en")
        self.assertEqual(v["trend"]["ai"][0], 1)  # gemini only (the reader's ai_crawls already follow the filter)
        self.assertEqual(v["trend"]["seo"][0], 60 + 30 + 12 + 6)
        self.assertEqual({d["device"]: d["on"] for d in v["devices"]}, {"mobile": True, "desktop": False})
        self.assertEqual({e["engine"]: e["on"] for e in v["engines"]}, {"chatgpt": False, "gemini": True})
        self.assertEqual(home["eng"], [28, 14])


class Screens(unittest.TestCase):
    def call(self, query, *answers):
        get = mock.AsyncMock(side_effect=list(answers))
        with mock.patch("bff.api.get", get), mock.patch.object(vis, "load_panel_options", mock.AsyncMock(return_value={"geographyOptions": ["US", "DE"]})):
            out = run(vis.renewal(QueryParams(query)))
        return out, get

    def test_ok_reads_the_previous_period_of_the_same_length(self):
        out, get = self.call("days=14", answer(CUR), answer(PREV, PREV_DAYS))
        self.assertEqual(out["props"], {"stage": "visibility", "geographyOptions": ["US", "DE"]})
        self.assertEqual(out["body"]["state"], "ok")
        self.assertEqual(out["body"]["prev"], {"from": "2026-09-22", "to": "2026-10-05"})
        prev_query = get.await_args_list[1].args[1]
        self.assertEqual((prev_query["from"], prev_query["to"]), ("2026-09-22", "2026-10-05"))
        self.assertNotIn("days", prev_query)
        self.assertTrue(out["body"]["view"]["prevOk"])

    def test_states(self):
        for query, reason, state in (("", "source_unavailable", "down"), ("", "no_sites", "nosite"), ("geography=JP", "no_sites", "nomatch"), ("", "no_measurements", "empty")):
            out, get = self.call(query, answer([], reason=reason))
            self.assertEqual(out["body"]["state"], state, reason)
            self.assertIsNone(out["body"]["view"])
            self.assertEqual(get.await_count, 1)

    def test_header_is_the_url_only(self):
        self.assertEqual(run(vis.renewal_header(QueryParams("days=7"))), {"preset": 7, "days": 7, "from": None, "to": None})


FRONT_FIXTURE = Path(__file__).parents[3] / "front/app/[locale]/(renewal)/renewal/standard/ai-funnel/visibility/_components/vis-body.fixture.json"


class FrontFixture(unittest.TestCase):
    """The page's render test draws this screen's own output; regenerate the fixture when the model changes."""

    @unittest.skipUnless(FRONT_FIXTURE.exists(), "front checkout not present (BFF image)")
    def test_front_fixture_is_current(self):
        view = json.loads(json.dumps(vis.visibility_view(answer(CUR)["data"], answer(PREV, PREV_DAYS)["data"], [], [])))
        self.assertEqual(json.loads(FRONT_FIXTURE.read_text(encoding="utf-8"))["view"], view)


if __name__ == "__main__":
    unittest.main()
