"""Citation screens: the rules the goldens do not pin by themselves (errors, degrade classification,
URL parsing edges, route validation, the request shapes) — bff.screens.citation / citation_model."""
import asyncio
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from bff.screens import citation as C
    from bff.screens import citation_model as M
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_citation)") from exc


def run(coro):
    return asyncio.run(coro)


META = {"as_of": "2026-09-21", "suppressed": {}, "page": {"limit": 100, "total": 3, "next_cursor": "100"}}
CAT = {"category_key": 1, "slug": "officialHmg", "name": "Official (HMG)"}


def domains_body(total=10):
    row = {"skey": "hyundai.com", "domain": "hyundai.com", "category": CAT, "citations": 5, "share": {"num": 5, "den": 10},
           "coverage": {"num": 1, "den": 4}, "is_own": True, "citing_prompts": 2, "rank": 1}
    return {"data": {"summary": {"total_citations": total, "unique_sources": 1, "own_share": {"num": 3, "den": 10}},
                     "items": [row] if total else [], "competitor_sources": [{"skey": "toyota.com", "citations": 2}]}, "meta": META}


SOURCES = {"data": {"total_citations": 10, "categories": [{"category": CAT, "citations": 10, "top_sources": []}],
                    "by_engine": [{"engine": "claude-web", "categories": [{"category_key": 1, "citations": 10}]}],
                    "tone": {"positive": {"urls": 1, "citations": 2, "answers": 1}, "negative": {"urls": 0, "citations": 0, "answers": 0}},
                    "types": []}, "meta": META}
TREND = {"data": {"bucket": "cycle", "dimension": "source", "buckets": [], "series": [], "dims": [{"dimension": "category", "series": []}]}, "meta": META}
PROMPTS = {"data": {"counts": {"owned": 2, "uncited": 3}, "items": []}, "meta": META}


def router(overrides=None):
    """A fake bff.api.get: path -> answer (an Exception instance is raised)."""
    calls = []

    async def get(path, params=None):
        calls.append((path, dict(params or {})))
        key = path
        if path == "trend":
            key = f"trend:{(params or {}).get('dimension')}"
        answer = (overrides or {}).get(key, {
            "citations/domains": domains_body(), "citations/sources": SOURCES, "trend:source": TREND,
            "trend:none": {"data": {"bucket": "cycle", "dimension": "none", "buckets": [], "series": []}, "meta": META},
            "citations/prompts": PROMPTS,
        }.get(key))
        if isinstance(answer, BaseException):
            raise answer
        if answer is None:
            raise HTTPException(404, f"no fixture {path}")
        return answer
    return get, calls


class Degrade(unittest.TestCase):
    def test_classification(self):
        self.assertTrue(C._degradable(HTTPException(503, "x")))
        self.assertTrue(C._degradable(HTTPException(500, "x")))
        self.assertTrue(C._degradable(ValueError("int('abc')")))  # a reader error is a 500 on the wire
        self.assertFalse(C._degradable(HTTPException(422, "x")))
        self.assertFalse(C._degradable(HTTPException(404, "x")))

    def test_degrade_returns_flag_and_reraises_4xx(self):
        async def ok():
            return 1

        async def down():
            raise HTTPException(503, "down")

        async def bad():
            raise HTTPException(422, "bad")
        self.assertEqual(run(C.degrade(ok())), (1, False))
        self.assertEqual(run(C.degrade(down())), (None, True))
        with self.assertRaises(HTTPException):
            run(C.degrade(bad()))


class Loaders(unittest.TestCase):
    def test_view_core_outage_is_degraded_not_empty(self):
        get, _ = router({"citations/domains": HTTPException(503, "down")})
        with mock.patch("bff.api.get", get):
            view = run(C.load_view(C.Reads({"cumulative": True}, {"surface": "global", "scope": {"all": True}})))
        self.assertEqual([view["live"], view["table"], view["competitorOptions"], view["degraded"]["data"]], [None, None, [], True])

    def test_view_4xx_reaches_the_page(self):
        get, _ = router({"citations/sources": HTTPException(422, "bad")})
        with mock.patch("bff.api.get", get), self.assertRaises(HTTPException):
            run(C.load_view(C.Reads({"cumulative": True}, {"surface": "global", "scope": {"all": True}})))

    def test_view_requests_per_surface(self):
        get, calls = router()
        with mock.patch("bff.api.get", get):
            run(C.load_view(C.Reads({"cumulative": True}, {"surface": "global", "scope": {"all": True}}, ["b.com", "a.com", "a.com"])))
        domains = [p for path, p in calls if path == "citations/domains"]
        main = next(p for p in domains if p.get("competitor_sources"))
        self.assertEqual([main["limit"], main["competitor"], main["include_competitor_totals"]], [100, ["a.com", "b.com"], False])
        picked = next(p for p in domains if p.get("skey"))
        self.assertEqual([picked["limit"], picked["skey"]], [200, ["a.com", "b.com"]])
        prompts = next(p for path, p in calls if path == "citations/prompts")
        self.assertEqual([prompts["owned"], prompts["limit"], prompts["include_refs"], prompts["fields"]], [True, 1, False, "text"])
        trend = next(p for path, p in calls if path == "trend")
        self.assertEqual([trend["dimension"], trend["top"], trend["dims"], trend["measured_days"]], ["source", 15, ["category@13"], False])
        get, calls = router()
        with mock.patch("bff.api.get", get):
            run(C.load_view(C.Reads({"cumulative": True}, {"surface": "website", "scope": {"all": True}}, ["x.com"])))
        main = next(p for path, p in calls if path == "citations/domains")
        self.assertEqual([main["surface"], main["limit"], "competitor" in main, "competitor_sources" in main], ["website", 200, False, False])
        sources = next(p for path, p in calls if path == "citations/sources")
        self.assertEqual([sources["include_tone"], sources["include_types"]], [False, False])
        prompts = next(p for path, p in calls if path == "citations/prompts")
        self.assertEqual([prompts["limit"], prompts["both_buckets"]], [5, True])

    def test_target_card_skipped_under_a_source_filter(self):
        get, calls = router()
        with mock.patch("bff.api.get", get):
            out = run(C.load_target_hit_rate(C.Reads({"sourceCategory": ["Official (HMG)"]}, {"surface": "website", "scope": {"all": True}})))
        self.assertEqual(out, M.empty_target_hit_rate())
        self.assertEqual(calls, [])

    def test_reads_start_at_once(self):
        """The screen answers once every read settled, so no read waits for another (2026-10-27): staged
        behind domains, sources and the calendar (the old page's D6), the page took both stages in turn."""
        order = []
        release = asyncio.Event()

        async def get(path, params=None):
            order.append(path)
            await release.wait()
            return {"citations/domains": domains_body(), "citations/sources": SOURCES, "citations/prompts": PROMPTS}.get(path, TREND)

        async def scenario():
            task = asyncio.ensure_future(C.load_view(C.Reads({"cumulative": True}, {"surface": "global", "scope": {"all": True}}, ["a.com"])))
            for _ in range(5):
                await asyncio.sleep(0)
            first = list(order)
            release.set()
            await task
            return first
        with mock.patch("bff.api.get", get):
            first = run(scenario())
        self.assertEqual(sorted(first), ["citations/domains", "citations/domains", "citations/prompts", "citations/sources", "trend"])


SUMMARY = {"data": {"url_prompts": {"measured_prompts": 10, "target_prompts": 6, "owned_prompts": 8}}, "meta": META}


def share_trend(points):
    """A dimension=none trend answer: (round, owned citations, all citations) per round."""
    keys = [k for k, _, _ in points]
    return {"data": {"bucket": "cycle", "dimension": "none", "buckets": [{"key": k, "round_dates": [k]} for k in keys],
                     "series": [{"metric": "visibility", "points": [{"bucket": k, "ratio": {"num": 1, "den": 2}} for k in keys]},
                                {"metric": "citation_share", "points": [{"bucket": k, "ratio": {"num": o, "den": t}} for k, o, t in points]}]},
            "meta": META}


class WebsiteRenewal(unittest.TestCase):
    """citation/website ctx.variant=renewal: the renewal page on the website surface + the 공식(당사) tile."""

    def answer(self, qs, overrides=None):
        get, calls = router({"kpi/summary": SUMMARY, **(overrides or {})})
        seen = {}
        real = C.renewal_vm

        def spy(live, deltas, parts, degraded, sp, **kw):
            seen["deltas"] = deltas
            return real(live, deltas, parts, degraded, sp, **kw)
        with mock.patch("bff.api.get", get), mock.patch.object(C, "renewal_vm", spy):
            out = run(C.website(QueryParams(qs)))
        return out, seen, calls

    def test_the_card_delta_is_own_not_the_hmg_category(self):
        """The share trend counts the site's own brands on the website (2026-10-30: 공식(당사) 24.9 % vs 공식(HMG)
        61.7 %), so the card Δ goes to the 공식(당사) tile and the categories keep their own Δ."""
        trend = share_trend([("2026-10-02", 285, 1000), ("2026-10-09", 249, 1000)])
        out, seen, _ = self.answer("ctx.variant=renewal&ctx.role=admin", {"trend:none": trend})
        self.assertIsNone(seen["deltas"]["officialDelta"])
        self.assertEqual(out["own"], {"value": 30.0, "delta": {"value": -3.6, "basis": "card", "date": "2026-10-02"},
                                      "spark": [28.5, 24.9], "sparkOn": True})
        self.assertNotEqual(out["rn"]["lens"]["hmg"]["delta"]["basis"], "card")
        self.assertEqual(sorted(out), ["dataDegraded", "live", "own", "periodView", "prevCategories", "reach", "rn", "sectionDegraded",
                                       "tableSource", "toneSummary"])
        self.assertEqual([out["reach"]["status"], out["reach"]["ownedRate"], out["reach"]["targetRate"], out["tableSource"]["query"]],
                         ["ok", 80.0, 60.0, "surface=website"])

    def test_without_the_variant_the_original_body(self):
        out, seen, calls = self.answer("ctx.role=admin")
        self.assertEqual(sorted(out), ["dataDegraded", "degradedSections", "live", "tableSource", "targetHitRate", "vm"])
        self.assertEqual([seen, [p for path, p in calls if path == "trend" and p.get("dimension") == "none"]], [{}, []])

    def test_period_mode_compares_own_with_the_period_before(self):
        out, _, calls = self.answer("ctx.variant=renewal&time=2026-09-01..2026-09-30", {"kpi/compare": HTTPException(503, "down")})
        self.assertEqual(out["own"]["delta"], {"value": 0.0, "basis": "period", "date": "2026-08-31", "from": "2026-08-01"})
        before = [p for path, p in calls if path == "citations/domains" and p.get("limit") == 1]
        self.assertEqual([(p["from"], p["to"]) for p in before], [("2026-08-01", "2026-08-31")])

    def test_a_source_filter_drops_the_line_and_the_round_delta(self):
        out, _, calls = self.answer("ctx.variant=renewal&source=Official+%28HMG%29")
        self.assertEqual(out["own"], {"value": 30.0, "delta": {"value": None, "basis": None, "date": None}, "spark": [], "sparkOn": False})
        self.assertEqual([p for path, p in calls if path == "trend" and p.get("dimension") == "none"], [])

    def reach(self, filters, prev=None, day="2026-10-02"):
        """load_url_reach with the page's previous round `day` (citation/website takes it from load_deltas)."""
        get, calls = router({"kpi/summary": SUMMARY})

        async def routed(path, params=None):
            if prev is not None and path == "kpi/summary" and (params or {}).get("to") == day:
                calls.append((path, dict(params or {})))
                return prev
            return await get(path, params)

        async def scenario():
            r = C.Reads({"cumulative": True, **filters}, {"surface": "website", "scope": {"all": True}})
            deltas = asyncio.ensure_future(asyncio.sleep(0, result={"prevCategories": {"asOf": day} if day else None}))
            return await C.load_url_reach(r, deltas)
        with mock.patch("bff.api.get", routed):
            return run(scenario()), calls

    def test_reach_compares_with_the_page_round_and_splits_by_engine(self):
        """The funnel's Δ reads one K-1 answer of the page's previous round; each engine of the citation read gets the
        same funnel (website 2026-10-30: 88.0 % · 66.6 %, ChatGPT 80.0 % · 53.2 %)."""
        prev = {"data": {"url_prompts": {"measured_prompts": 10, "target_prompts": 5, "owned_prompts": 9}}, "meta": META}
        out, calls = self.reach({}, prev)
        self.assertEqual([out["status"], out["measured"], out["owned"], out["target"], out["ownedRate"], out["targetRate"]],
                         ["ok", 10, 8, 6, 80.0, 60.0])
        self.assertEqual(out["delta"], {"ownedRate": -10.0, "targetRate": 10.0, "basis": "round", "date": "2026-10-02"})
        self.assertEqual(out["prev"]["ownedRate"], 90.0)
        self.assertEqual([(e["engine"], e["ownedRate"]) for e in out["engines"]], [(M.provider_label("claude-web"), 80.0)])
        summaries = [p for path, p in calls if path == "kpi/summary"]
        self.assertIn(("2026-10-02", "2026-10-02"), [(p.get("from"), p.get("to")) for p in summaries])
        self.assertIn(["claude-web"], [p.get("engine") for p in summaries])

    def test_reach_compares_one_value_source_only(self):
        """A published answer beside a live one is two measurements: no Δ."""
        prev = {"data": {"url_prompts": {"measured_prompts": 10, "target_prompts": 5, "owned_prompts": 9}},
                "meta": {**META, "source": {"url_rates": "report", "publication_details": [{"cycle_label": "9월"}]}}}
        out, _ = self.reach({}, prev)
        self.assertEqual([out["prev"], out["delta"]], [None, {"ownedRate": None, "targetRate": None, "basis": None, "date": None}])

    def test_reach_without_a_round_or_under_a_source_filter(self):
        out, _ = self.reach({}, day=None)
        self.assertEqual([out["delta"]["ownedRate"], out["delta"]["basis"]], [None, None])
        out, calls = self.reach({"sourceCategory": ["Official (HMG)"]})
        self.assertEqual([out, calls], [{"status": "notComputed"}, []])

    def test_sub_pages_read_the_website_filters(self):
        tone = {"data": {"items": [], "counts": {"positive": 1, "negative": 0}}, "meta": {"page": {"limit": 50, "total": 0, "next_cursor": None}}}
        get, calls = router({"citations/sources/tone": tone})
        with mock.patch("bff.api.get", get):
            run(C.prompts(QueryParams("ctx.surface=website&ctx.role=admin&geography=US&tab=uncited")))
            run(C.tone_urls(QueryParams("ctx.surface=website&ctx.role=admin&geography=US")))
            run(C.prompts(QueryParams("geography=US")))
        self.assertEqual([(p["surface"], p.get("country")) for _, p in calls], [("website", ["US"]), ("website", ["US"]), ("global", ["US"])])


class Routes(unittest.TestCase):
    def test_route_target_validation(self):
        with self.assertRaises(HTTPException):
            C._route_target({"surface": "elsewhere"})
        with self.assertRaises(HTTPException):
            C._route_target({"surface": "project", "project_id": "../x"})
        self.assertEqual(C._route_target({}), ("global", None))
        self.assertEqual(C._route_target({"surface": "website", "project_id": "p"}), ("website", None))

    def test_export_relays_the_gold_404(self):
        get, calls = router({"citations/domains/export": HTTPException(404, "Source not present in Gold")})
        with mock.patch("bff.api.get", get), self.assertRaises(HTTPException) as err:
            run(C.domains_export(QueryParams("ctx.surface=global&q=+kia+&sort=share&dir=asc&locale=en&max_rows=0100&competitor=b~a")))
        self.assertEqual(err.exception.status_code, 404)
        path, params = calls[0]
        self.assertEqual([path, params["q"], params["sort"], params["dir"], params["locale"], params["format"], params["max_rows"], params["competitor"]],
                         ["citations/domains/export", "kia", "share", "asc", "en", "xlsx", 100, ["a", "b"]])

    def test_domains_page_numbering_and_offset(self):
        body = domains_body()
        body["data"]["items"] = [dict(body["data"]["items"][0], rank=None, skey=s) for s in ("a", "b")]
        get, calls = router({"citations/domains": body})
        with mock.patch("bff.api.get", get):
            web = run(C.domains(QueryParams("ctx.surface=website&cursor=200&limit=100&q=x")))
            glob = run(C.domains(QueryParams("ctx.surface=global&competitor=t.com")))
        self.assertEqual([r["no"] for r in web["rows"]], [201, 202])
        self.assertEqual([r["no"] for r in glob["rows"]], [1, 2])
        self.assertEqual(web["views"][""]["idx"], [0, 1])
        self.assertEqual([calls[0][1]["cursor"], calls[0][1]["limit"], calls[0][1]["q"]], ["200", 100, "x"])
        self.assertEqual(calls[1][1]["competitor"], ["t.com"])

    def test_detail_share_and_orders(self):
        detail = {"data": {"citations": 8, "urls": [], "prompts": [
            {"prompt_id": "1", "text": "b", "citations": 2, "engines": [], "answers": []},
            {"prompt_id": "2", "text": "A", "citations": 4, "engines": [], "answers": []},
            {"prompt_id": "3", "text": "가", "citations": 2, "engines": [], "answers": []}], "url_total": 0, "prompt_total": 3}, "meta": META}
        get, calls = router({"citations/domains/instagram.com/hyundai": detail})
        with mock.patch("bff.api.get", get):
            out = run(C.domain_detail(QueryParams("ctx.surface=global&ctx.skey=instagram.com/hyundai")))
        self.assertEqual(calls[0][0], "citations/domains/instagram.com/hyundai")
        self.assertEqual([(p["id"], p["share"]) for p in out["promptList"]], [("2", 50.0), ("1", 25.0), ("3", 25.0)])
        self.assertEqual(out["promptOrders"]["citations"], {"asc": [1, 2, 0], "desc": [0, 1, 2]})
        self.assertEqual(out["promptOrders"]["share"], out["promptOrders"]["citations"])
        self.assertNotIn("urlTotal", out)


class SubPages(unittest.TestCase):
    def test_page_param_is_parse_int(self):
        cases = {None: 1, "": 1, "2": 2, " 7x": 7, "0": 1, "-4": 1, "abc": 1, "1e3": 1}
        for raw, expected in cases.items():
            self.assertEqual(C.page_param({} if raw is None else {"page": raw}), expected, raw)
        self.assertEqual(C.page_param({"page": ["3", "9"]}), 3)

    def test_cursor_param(self):
        self.assertEqual([C.read_cursor_param(v) for v in ("50", "../x", "", ["50"], None, "a_b-C")], ["50", None, None, None, None, "a_b-C"])

    def test_prompts_degraded_page(self):
        get, _ = router({"citations/prompts": ValueError("bad cursor")})
        with mock.patch("bff.api.get", get):
            out = run(C.prompts(QueryParams("ctx.surface=global&tab=uncited&cursor=zz&q=+ev+")))
        self.assertEqual(out, {"tab": "uncited", "q": " ev ", "page": None, "ownedCount": None, "uncitedCount": None})

    def test_tone_counts_reuse_only_on_an_in_page_move(self):
        body = {"data": {"items": []}, "meta": {"page": {"limit": 50, "total": 0, "next_cursor": None}}}
        get, calls = router({"citations/sources/tone": body})
        with mock.patch("bff.api.get", get):
            moved = run(C.tone_urls(QueryParams("ctx.client_nav=1&cursor=50&tone=negative")))
            blank = run(C.tone_urls(QueryParams("ctx.client_nav=1&q=+++")))
            document = run(C.tone_urls(QueryParams("cursor=50")))
        self.assertEqual([moved["counts"], blank["counts"], document["counts"]], [None, {"positive": None, "negative": None}, {"positive": None, "negative": None}])
        self.assertEqual([("with_counts" in p) for _, p in calls], [False, True, True])
        self.assertEqual([moved["tone"], moved["page"]["win"]], ["negative", {"page": 1, "pages": 1, "from": 0, "to": 0}])

    def test_page_without_cursor_is_page_one(self):
        """A link with ?page=N and no cursor (an old link or bookmark) reads the first rows, so its window is page one:
        it said "51–100 · 2/3" over rows 1–50 (2026-10-29 metric review, sub pages #17). A cursor keeps its page."""
        page = {"limit": 50, "total": 120, "next_cursor": "50"}
        prompts = {"data": {"counts": {"owned": 120, "uncited": 3},
                            "items": [{"prompt_id": "p1", "text": "t", "funnel": None, "citations": 1, "providers": [], "answers": []}]},
                   "meta": {"page": page}}
        tone = {"data": {"items": [], "counts": {"positive": 120, "negative": 4}}, "meta": {"page": page}}
        get, _ = router({"citations/prompts": prompts, "citations/sources/tone": tone})
        with mock.patch("bff.api.get", get):
            bare = run(C.prompts(QueryParams("page=2")))
            bare_tone = run(C.tone_urls(QueryParams("page=3")))
            kept = run(C.prompts(QueryParams("page=2&cursor=50")))
        first = {"page": 1, "pages": 3, "from": 1, "to": 50}
        self.assertEqual([bare["page"]["page"], bare["page"]["win"]], [1, first])
        self.assertEqual([bare_tone["page"]["page"], bare_tone["page"]["win"]], [1, first])
        self.assertEqual([kept["page"]["page"], kept["page"]["win"]], [2, {"page": 2, "pages": 3, "from": 51, "to": 100}])


class UrlRules(unittest.TestCase):
    def test_route_query_encoding(self):
        q = C.citation_route_query({"z": "a b~c", "tab": "x", "cf_x": "1", "a": ["*-._", "~+&"]}, "website")
        self.assertEqual(q, "a=*-._&a=%7E%2B%26&z=a+b%7Ec&surface=website")
        field = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
        self.assertEqual(C.citation_route_query({f"cf_{field}": "봄", "cf_y": "1"}, "project", "p1", [field]),
                         f"cf_{field}=%EB%B4%84&projectId=p1")

    def test_competitor_url_semantics(self):
        # the client reads the first ?competitor= value; the server read joins every value
        sp = {"competitor": ["a.com~b.com", "c.com"]}
        self.assertEqual(C.active_competitors(sp), ["a.com", "b.com"])
        self.assertEqual(C.global_context(sp)[2], ["a.com", "b.com", "c.com"])


class Model(unittest.TestCase):
    def test_domain_url_country_is_golds(self):
        # The site country of a cited URL is the one the Gold read sends (dim_url.owner_key -> dim_owned_base.geo_code);
        # the screen keeps no URL -> country table of its own, so a URL Gold leaves without a country shows none.
        urls = [{"url": "https://www.hyundai.com/kr/ko/e", "title": "a", "citations": 3, "engines": ["chatgpt"], "country": "KR"},
                {"url": "https://www.hyundai.com/in/en", "title": "b", "citations": 2, "engines": ["gemini"], "country": None},
                {"url": "https://www.kia.com/ie", "title": "c", "citations": 1, "engines": []}]
        out = M.to_domain_drilldown({"urls": urls, "prompts": []})
        self.assertEqual([u["country"] for u in out["urls"]], ["KR", None, None])

    def test_status_basis(self):
        prev = {"totals": {"total": 100, "byCategory": {"Official (HMG)": 10}}, "asOf": "2026-09-14"}
        self.assertEqual(M.delta_basis({"delta": 1.5, "basisDate": "2026-09-14"}, None),
                         {"kind": "card", "ownDate": "2026-09-14", "categoryDate": "2026-09-14"})
        self.assertEqual(M.delta_basis(None, prev), {"kind": "category", "categoryDate": "2026-09-14"})
        self.assertIsNone(M.delta_basis(None, None))

    def test_prev_category_share_vs_round1(self):
        # Math.round(1000 * 247 / 2000) / 10 (prevCategoryShare) and round1(100 * 247 / 2000) (categoryShare)
        prev = {"totals": {"total": 2000, "byCategory": {"x": 247}}}
        self.assertEqual(M.prev_category_share(prev, "x"), 12.4)
        self.assertEqual(M.category_share([{"name": "x", "value": 247}, {"name": "y", "value": 1753}], "x"), 12.4)

    def test_lens_view(self):
        lens = {"hmg": {"value": 10.0, "delta": {}, "spark": [None, 3.0]}, "dealer": {"value": None, "delta": {}, "spark": [1.0]},
                "split": {"kind": "ok", "owned": 57, "uncited": 39}}
        out = M.lens_view(lens)
        self.assertEqual([out["hmg"]["sparkOn"], out["dealer"]["sparkOn"], out["split"]["ownedPct"], out["split"]["uncitedPct"]], [True, False, 59, 41])
        self.assertNotIn("ownedPct", lens["split"])
        self.assertEqual(M.lens_view({**lens, "split": {"kind": "ok", "owned": 0, "uncited": 0}})["split"]["ownedPct"], None)

    def test_table_views(self):
        rows = [{"category": "A", "citations": 3, "coverageRate": 0.5}, {"category": None, "citations": 9, "coverageRate": 2},
                {"category": "A", "citations": 0, "coverageRate": 0}]
        self.assertEqual(M.table_views(rows), {"": {"idx": [0, 1, 2], "maxCit": 9, "maxCov": 2}, "A": {"idx": [0, 2], "maxCit": 3, "maxCov": 1}})


HMG, AUTO = "Official (HMG)", "Automotive Media"


class EmptyColumns(unittest.TestCase):
    """2026-10-31 renewal audit 9-1: a matrix column with no citations (a mention type no answer of the filter carries;
    U9: single brands, July rounds, engine × country — Genesis AT and Hyundai CH on 10-05 have all five at 0) has no
    share. It showed 0.0% in every row, was coloured, set the colour cap and made findings ('추천 답변 0.0% — 60pp
    낮음'); the original type chart showed '—'."""

    @staticmethod
    def types(**totals):
        mix = {"mention": {HMG: 6, AUTO: 4}, "comparison": {HMG: 2, AUTO: 18}}
        return [{"type": t, "total": totals.get(t, 0), "byCategory": mix.get(t, {}) if totals.get(t) else {}} for t in M.MENTION_TYPES]

    def test_a_column_without_citations_has_no_share(self):
        m = M.type_matrix(self.types(mention=10, comparison=20), [HMG, AUTO])
        self.assertEqual([c["key"] for c in m["cols"]], ["final_choice", "recommendation", "comparison", "definition", "mention"])
        empty = {c["key"]: c["shares"] for c in m["cols"] if c["n"] == 0}
        self.assertEqual(empty, {k: {HMG: None, AUTO: None} for k in ("final_choice", "recommendation", "definition")})
        self.assertEqual(m["live"], ["comparison", "mention"])
        self.assertEqual(m["cap"], 34)                                  # |60 − 26.7|, not |0 − 73.3|
        view = M.matrix_view(m, False)
        self.assertEqual(view["gaps"]["recommendation"], {HMG: None, AUTO: None})
        self.assertAlmostEqual(view["gaps"]["mention"][HMG], 60 - 800 / 30)

    def test_no_finding_reads_an_empty_column(self):
        m = M.type_matrix(self.types(mention=10, comparison=20), [HMG, AUTO])
        split = {"kind": "noOwned"}
        kinds = [f["kind"] for f in M.findings([], None, [], None, m, split, None)]
        self.assertNotIn("typeGap", kinds)                              # 추천 has no answers: nothing to compare
        skew = M.strongest_skew(None, m)
        self.assertEqual([skew["col"], skew["category"]], ["mention", AUTO])
        both = M.type_matrix(self.types(mention=10, recommendation=20), [HMG, AUTO])
        self.assertIn("typeGap", [f["kind"] for f in M.findings([], None, [], None, both, split, None)])

    def test_one_valued_column_is_not_coloured(self):
        m = M.type_matrix(self.types(mention=10), [HMG, AUTO])
        self.assertEqual([m["live"], m["cap"]], [[], 3])

    def test_every_column_empty_says_so(self):
        live = {"categories": [{"name": HMG, "value": 6, "top": []}], "domains": [], "trend": None, "engineCategories": None}
        deltas = {"officialDelta": None, "prevCategories": None}
        vm = C.renewal_vm(live, deltas, {"typeCategories": self.types()}, {}, {})
        self.assertEqual(vm["typeMatrix"], {"status": "empty", "m": None})
        vm = C.renewal_vm(live, deltas, {"typeCategories": self.types(mention=10)}, {}, {})
        self.assertEqual(vm["typeMatrix"]["status"], "ok")


class CitationTrendZero(unittest.TestCase):
    """2026-10-31 renewal audit 9-4, not reproduced: U2 found no zero rows in Gold's cell tables (citation_cell citations ≥ 1)
    and one entity catalogue for every round, so a source without a row in a round that has citations was cited 0
    times. The trend draws 0 there; a round without any value stays a gap."""

    def test_no_row_in_a_valued_round_is_zero(self):
        data = {"dimension": "source", "buckets": [{"key": "2026-09-28"}, {"key": "2026-10-05"}, {"key": "2026-10-12"}],
                "series": [{"key": "a.com", "points": [{"bucket": "2026-09-28", "ratio": {"num": 3}}, {"bucket": "2026-10-05", "ratio": {"num": 2}}]},
                           {"key": "b.com", "points": [{"bucket": "2026-09-28", "ratio": {"num": 1}}]}]}
        out = M.to_citation_trend(data)
        self.assertEqual([(p["a.com"], p["b.com"]) for p in out["points"]], [(3, 1), (2, 0), (None, None)])
        self.assertEqual(out["points"][2]["gap"], {"reason": "no_value"})


class CategoryBySlug(unittest.TestCase):
    """2026-10-31 renewal audit 9-8, not reproduced: every category name the citation model compares comes from
    category_label_of, the taxonomy label of Gold's slug (dim_category.slug); Gold's name (the HUB code table's, an
    admin may edit it) is read only for a slug the taxonomy does not know. So a renamed 공식(경쟁사) is still the one the
    competitor pick and the hidden row find, and a name copied onto another category is not."""

    def test_the_pick_follows_the_slug(self):
        renamed = {"category_key": 2, "slug": "officialCompetitor", "name": "공식 경쟁사"}
        lookalike = {"category_key": 3, "slug": "dealerMarketplace", "name": "Official (Competitor)"}
        rows = [M.to_citation_domain({"skey": s, "citations": n, "category": c, "share": {"num": n, "den": 10}, "coverage": {"num": 1, "den": 4}})
                for s, n, c in (("toyota.com", 5, renamed), ("bmw.com", 3, renamed), ("cars.com", 2, lookalike))]
        self.assertEqual([r["category"] for r in rows], ["Official (Competitor)", "Official (Competitor)", "Dealer & Marketplace"])
        self.assertEqual([r["domain"] for r in M.apply_competitor_pick(rows, ["toyota.com"])], ["toyota.com", "cars.com"])
        cats = M.to_category_slices({"total_citations": 10, "categories": [{"category": renamed, "citations": 8, "top_sources": []},
                                                                           {"category": lookalike, "citations": 2, "top_sources": []}]})
        self.assertEqual([c["name"] for c in cats], ["Official (Competitor)", "Dealer & Marketplace"])
        live = {"categories": cats, "domains": rows, "categoryTrend": None}
        out = {r["name"]: (r["value"], r["deltaHidden"]) for r in M.category_rows(live, None, None, ["toyota.com"])}
        self.assertEqual(out, {"Official (Competitor)": (5, True), "Dealer & Marketplace": (2, False)})


class ToneUrlCategory(unittest.TestCase):
    def test_a_source_without_a_category_is_not_other(self):
        # 2026-10-31 renewal audit 9-6: a URL row whose source has no category (the reader's LEFT JOIN; Gold leaves the
        # column nullable, 0 rows on 2026-10-31) read 'Other', Gold's own category 13; it now has none ('—' on screen)
        row = {"skey": "x.com", "citations": 2, "engines": ["chatgpt"]}
        self.assertIsNone(M.to_tone_url_row({**row, "category": None}, "url")["category"])
        other = {"category_key": 13, "slug": "other", "name": "Other"}
        self.assertEqual(M.to_tone_url_row({**row, "category": other}, "source")["category"], "Other")


class WebsiteAccountRule(unittest.TestCase):
    """2026-10-31 renewal audit 9-7: the website domain table, drawer and export read the page's URL with the global
    account rule (route_context, `standard`), the body with the website one. A scoped account's city site (SA-Dammam,
    a site of SA) is no country of the global rule, so the table and drawer fell back to the scope (every site of it)
    while the body read the city site."""

    ME = {"all": False, "brands": ["Genesis"], "regions": ["genesis-middle-east"], "countries": []}

    def test_table_and_drawer_read_the_bodys_sites(self):
        from bff import access
        detail = {"data": {"citations": 0, "urls": [], "prompts": [], "url_total": 0, "prompt_total": 0}, "meta": META}
        get, calls = router({"citations/domains/kia.com": detail})
        sp = {"geography": "SA-Dammam"}
        with mock.patch("bff.api.get", get), access.scoped(self.ME):
            body = C.common_of(*C.website_context(sp, None))["country"]
            run(C.domains(QueryParams("ctx.surface=website&geography=SA-Dammam")))
            run(C.domain_detail(QueryParams("ctx.surface=website&ctx.skey=kia.com&geography=SA-Dammam")))
        self.assertEqual(body, ["SA-Dammam"])
        # the global rule left the scope's countries out of the query (the clamp adds every scope site)
        self.assertEqual([p.get("country") for _, p in calls], [body, body])


class WebsiteTableAll(unittest.TestCase):
    """2026-10-31 renewal audit 10-2: the website domain table shows every row it loaded (the screen's first page of
    200, then 200 more per '더 보기', the original's pages). Its category select reads the screen's views, which
    covered the first 100 rows only (the standard table's cut), so rows 101+ were out of every category. The website
    page's views and every route page's views cover all their rows; the standard page keeps its top 100."""

    @staticmethod
    def body(n):
        body = domains_body()
        row = body["data"]["items"][0]
        body["data"]["items"] = [dict(row, skey=f"d{i}.com", domain=f"d{i}.com", citations=n - i, rank=i + 1) for i in range(n)]
        return body

    def test_the_website_views_cover_every_row(self):
        get, _ = router({"citations/domains": self.body(230), "kpi/summary": SUMMARY})
        with mock.patch("bff.api.get", get):
            web = run(C.website(QueryParams("ctx.variant=renewal&ctx.role=admin")))
            std = run(C.standard(QueryParams("ctx.variant=renewal")))
        self.assertEqual([len(web["rn"]["table"]["rows"]), web["rn"]["table"]["views"][""]["idx"]], [230, list(range(230))])
        self.assertEqual(web["rn"]["table"]["views"]["Official (HMG)"]["maxCit"], 230)
        self.assertEqual(std["rn"]["table"]["views"][""]["idx"], list(range(100)))

    def test_a_route_page_has_views_of_all_its_rows(self):
        get, _ = router({"citations/domains": self.body(200)})
        with mock.patch("bff.api.get", get):
            page = run(C.domains(QueryParams("ctx.surface=website&cursor=200&limit=200")))
        self.assertEqual([page["rows"][0]["no"], page["rows"][-1]["no"], page["views"][""]["idx"]], [201, 400, list(range(200))])


if __name__ == "__main__":
    unittest.main()
