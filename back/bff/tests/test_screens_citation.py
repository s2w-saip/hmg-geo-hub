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
    from bff.screens.citation_geo import geo_country_for_url, url_keys
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


SOURCES = {"data": {"total_citations": 10, "categories": [{"category": CAT, "citations": 10}],
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

    def test_second_stage_waits_for_the_essentials(self):
        """D6: trends, the prompt split and the picked rows start only after domains, sources and the calendar settled."""
        order = []
        release = asyncio.Event()

        async def get(path, params=None):
            order.append(path)
            if path in ("citations/domains", "citations/sources", "filters/dates") and not params.get("skey"):
                await release.wait()
            return {"citations/domains": domains_body(), "citations/sources": SOURCES, "filters/dates": {"data": {}, "meta": META},
                    "citations/prompts": PROMPTS}.get(path, TREND)

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
        self.assertEqual(sorted(first), ["citations/domains", "citations/sources", "filters/dates"])
        self.assertEqual(sorted(order[3:]), ["citations/domains", "citations/prompts", "trend"])


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


class UrlRules(unittest.TestCase):
    def test_route_query_encoding(self):
        q = C.citation_route_query({"z": "a b~c", "tab": "x", "cf_x": "1", "a": ["*-._", "~+&"]}, "website")
        self.assertEqual(q, "a=*-._&a=%7E%2B%26&z=a+b%7Ec&surface=website")
        field = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
        self.assertEqual(C.citation_route_query({f"cf_{field}": "봄", "cf_y": "1"}, "project", "p1", [field]),
                         f"cf_{field}=%EB%B4%84&projectId=p1")

    def test_url_keys(self):
        self.assertEqual(url_keys("https://WWW.Hyundai.com/KR/ko?country=nz"), ["hyundai.com?country=NZ", "hyundai.com/kr", "hyundai.com"])
        self.assertEqual(url_keys("https://www.kia.com/./us/../kr/"), ["kia.com/kr", "kia.com"])
        self.assertEqual(url_keys("https:\\\\www.kia.com\\us"), ["kia.com/us", "kia.com"])
        self.assertIsNone(url_keys("not a url"))
        self.assertIsNone(url_keys("https://"))
        self.assertEqual(geo_country_for_url("https://www.hyundai.com/kr/ko/e"), "South Korea")
        self.assertIsNone(geo_country_for_url("https://www.hyundai.com/"))

    def test_competitor_url_semantics(self):
        # the client reads the first ?competitor= value; the server read joins every value
        sp = {"competitor": ["a.com~b.com", "c.com"]}
        self.assertEqual(C.active_competitors(sp), ["a.com", "b.com"])
        self.assertEqual(C.global_context(sp)[2], ["a.com", "b.com", "c.com"])


class Model(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
