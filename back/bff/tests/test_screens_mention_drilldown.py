"""Mention drilldown screens (bff.screens.mention_drilldown): the cases the goldens cannot hold.

The goldens (golden/mention/drill-*.json) pin every {status, body} the old routes answered. Here:
failures the routes relayed through hghErrorResponse (raised, not a body), the 401 mapping, the
`ctx.params` transport (empty values, repeated keys, malformed JSON) and a few sort / parse rules."""
import asyncio
import json
import math
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from bff.screens import mention_drilldown as md
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_mention_drilldown)") from exc

PROJECT = "c0000000-0000-4000-8000-000000000003"
SCREENS = {
    "mention/drill-brand-prompts": {"mentionBrand": "Toyota"},
    "mention/drill-signal-prompts": {"signal": "positive"},
    "mention/drill-brand-citations": {"mentionBrand": "Toyota"},
    "mention/drill-answer": {"jobId": "job"},
}


def run(coro):
    return asyncio.run(coro)


def build(name: str, q: QueryParams):
    """The registered builder, called directly (no import of the other screen modules)."""
    return {"mention/drill-brand-prompts": md.brand_prompts, "mention/drill-signal-prompts": md.signal_prompts,
            "mention/drill-brand-citations": md.brand_citations, "mention/drill-answer": md.answer}[name](q)


def params(pairs) -> QueryParams:
    return QueryParams({"ctx.params": json.dumps(pairs)})


def failing(status: int):
    async def get(path, params=None):
        raise HTTPException(status, "boom")
    return get


class Transport(unittest.TestCase):
    def test_ctx_params_keep_empty_values_and_repeats(self):
        p = md.route_params(params([["geography", "US"], ["projectId", ""], ["geography", "KR"], ["skey", ""]]))
        self.assertEqual(p.get("geography"), "US")  # URLSearchParams#get: the first value
        self.assertEqual(p.sp(), {"geography": "KR", "projectId": "", "skey": ""})  # forEach: the last value
        self.assertIsNone(md.drilldown_target(p))  # an empty projectId is not a uuid -> 404
        self.assertEqual(md.drilldown_target(md.route_params(params([["surface", "website"]]))), {"surface": "website"})

    def test_plain_params_are_the_route_params(self):
        p = md.route_params(QueryParams([("mentionBrand", "A"), ("mentionBrand", "B"), ("ctx.locale", "ko")]))
        self.assertEqual((p.get("mentionBrand"), p.sp()), ("A", {"mentionBrand": "B"}))

    def test_malformed_ctx_params_is_a_422(self):
        for raw in ("{", "[1]", "[[1]]", "null"):
            with self.subTest(raw=raw), self.assertRaises(HTTPException) as cm:
                md.route_params(QueryParams({"ctx.params": raw}))
            self.assertEqual(cm.exception.status_code, 422)

    def test_empty_skey_and_project_through_ctx_params(self):
        with mock.patch("bff.api.get", failing(500)):
            r = run(build("mention/drill-brand-citations", params([["mentionBrand", "Toyota"], ["skey", ""]])))
            self.assertEqual(r, {"status": 400, "body": {"error": "invalid skey"}})
            r = run(build("mention/drill-brand-prompts", params([["mentionBrand", "Toyota"], ["projectId", ""]])))
            self.assertEqual(r, {"status": 404, "body": {"prompts": []}})


class Relay(unittest.TestCase):
    """A backend failure the route answered with hghErrorResponse is raised with its status; 401 is the
    route's {error: "unauthorized"}."""

    def test_5xx_of_the_read_is_raised(self):
        for name, query in SCREENS.items():
            for status in (500, 503):
                with self.subTest(name=name, status=status), mock.patch("bff.api.get", failing(status)):
                    with self.assertRaises(HTTPException) as cm:
                        run(build(name, QueryParams(query)))
                    self.assertEqual(cm.exception.status_code, status)

    def test_5xx_of_the_project_gate_is_raised(self):
        for name, query in SCREENS.items():
            with self.subTest(name=name), mock.patch("bff.api.get", failing(503)), self.assertRaises(HTTPException) as cm:
                run(build(name, QueryParams({**query, "projectId": PROJECT})))
            self.assertEqual(cm.exception.status_code, 503)

    def test_401_is_unauthorized(self):
        for name, query in SCREENS.items():
            for q in (query, {**query, "projectId": PROJECT}):
                with self.subTest(name=name, q=q), mock.patch("bff.api.get", failing(401)):
                    self.assertEqual(run(build(name, QueryParams(q))), {"status": 401, "body": {"error": "unauthorized"}})

    def test_a_400_of_the_read_is_raised(self):
        # The old routes mapped 422 only; any other 4xx went through hghErrorResponse.
        with mock.patch("bff.api.get", failing(400)), self.assertRaises(HTTPException) as cm:
            run(build("mention/drill-brand-prompts", QueryParams({"mentionBrand": "Toyota"})))
        self.assertEqual(cm.exception.status_code, 400)


class Rules(unittest.TestCase):
    def test_rank_order_puts_no_rank_last_ascending_and_first_descending(self):
        rows = [{"promptText": "a", "bestRank": None, "mentions": 1, "share": 1, "funnelStage": None, "providers": []},
                {"promptText": "b", "bestRank": 2, "mentions": 1, "share": 1, "funnelStage": "x", "providers": ["A"]},
                {"promptText": "c", "bestRank": None, "mentions": 1, "share": 1, "funnelStage": "", "providers": []},
                {"promptText": "d", "bestRank": 1.5, "mentions": 1, "share": 1, "funnelStage": None, "providers": []}]
        orders = md.prompt_orders(rows)
        self.assertEqual(orders["rank"], {"asc": [3, 1, 0, 2], "desc": [0, 2, 1, 3]})
        self.assertEqual(orders["funnel"]["asc"], [0, 2, 3, 1])

    def test_best_rank_skips_missing_and_non_positive_positions(self):
        self.assertEqual(md.prompt_best_rank([{"position": None}, {"position": 0}, {"position": -2}, {"position": 3}, {"position": 2.5}]), 2.5)
        self.assertIsNone(md.prompt_best_rank([]))
        self.assertEqual(md.to_mentions_prompt({"prompt_id": "p", "count": 1, "providers": [], "answers": [{"job_id": "j", "position": 3}]}, "brand")["topRank"], True)

    def test_unknown_category_without_name_drops_the_key(self):
        row = md.to_citation_domain({"skey": "x", "citations": 1, "is_own": False, "category": {"slug": "zzz"}})
        self.assertNotIn("category", row)
        self.assertEqual(md.to_citation_domain({"skey": "x", "category": {"slug": "zzz", "name": None}})["category"], None)

    def test_iso_instant_keeps_what_it_cannot_read(self):
        self.assertEqual(md.iso_instant("2026-10-04T21:46:47"), "2026-10-04T21:46:47")  # no offset: kept (Gold always sends one)
        self.assertEqual(md.iso_instant("2026-10-04T21:46:47.1239+01:00"), "2026-10-04T20:46:47.123Z")
        self.assertIsNone(md.iso_instant(""))

    def test_hostname(self):
        cases = {"https://WWW.Kia.com:443/x": "www.kia.com", "http://0x7f.1": "127.0.0.1", "https://a@b@c.com/": "c.com",
                 "https://[2001:db8:0:0:0:0:0:1]/": "[2001:db8::1]", "https://foo.123/": None, "http://:80/": None,
                 "https://host:65536/": None, "https://ex%2Fa.com/": None, "https://%41bc.com/": "abc.com", "http:\\\\\\a.com": "a.com"}
        for url, host in cases.items():
            with self.subTest(url=url):
                self.assertEqual(md.whatwg_hostname(url), host)

    def test_no_nan_or_inf_in_a_body(self):
        body = {"data": {"items": [{"prompt_id": "p", "prompt_text": "t", "count": 1, "share": {"num": 1, "den": 0}, "providers": [],
                                    "answers": [{"job_id": "j", "engine": "x", "value": 1, "position": None}]}]},
                "meta": {"page": {"total": 1}}}
        with mock.patch("bff.api.get", mock.AsyncMock(return_value=body)):
            r = run(build("mention/drill-brand-prompts", QueryParams({"mentionBrand": "Toyota"})))
        text = json.dumps(r, allow_nan=False)
        self.assertNotIn("Infinity", text)
        self.assertTrue(math.isfinite(r["body"]["prompts"][0]["share"]))


class BrandTargets(unittest.TestCase):
    """2026-10-31 renewal audit 7-2: the brand row's tabs read that brand. A competitor row names its brand (the reader
    resolves mention_brand); the 당사 row (own=1) asks for 당사 on both tabs: its label (HMG under the HMG perspective) is
    no Gold brand, so its citation sources are those of the answers where an own brand is mentioned (mention_own)."""

    def reads(self, screen: str, query: dict) -> list[tuple[str, dict]]:
        seen = []

        async def get(path, params=None):
            seen.append((path, dict(params or {})))
            return {"data": {"items": [], "urls": [], "prompts": []}, "meta": {"page": {"total": 0}}}
        with mock.patch("bff.api.get", get):
            run(build(screen, QueryParams(query)))
        return seen

    def test_a_competitor_row_names_its_brand(self):
        for query in ({"mentionBrand": "Toyota"}, {"mentionBrand": "Toyota", "skey": "kia.com"}):
            ((path, q),) = self.reads("mention/drill-brand-citations", query)
            self.assertEqual((q.get("mention_brand"), q.get("mention_own")), ("Toyota", None), path)
        ((_, q),) = self.reads("mention/drill-brand-prompts", {"mentionBrand": "Toyota"})
        self.assertEqual((q.get("mention_brand"), q.get("own")), ("Toyota", None))

    def test_the_own_row_asks_for_own_on_both_tabs(self):
        for query in ({"mentionBrand": "HMG", "own": "1"}, {"mentionBrand": "HMG", "own": "1", "skey": "kia.com"}):
            ((path, q),) = self.reads("mention/drill-brand-citations", query)
            self.assertEqual((q.get("mention_own"), q.get("mention_brand")), (True, None), path)
        ((_, q),) = self.reads("mention/drill-brand-prompts", {"mentionBrand": "HMG", "own": "1"})
        self.assertEqual((q.get("own"), q.get("mention_brand")), (True, None))


if __name__ == "__main__":
    unittest.main()


class MissingPrompts(unittest.TestCase):
    """mention/drill-missing-prompts (2026-10-30, the renewal Website Mention's 미언급 프롬프트 list): the card's
    count members under the page's filters on the website surface, each a prompt row without a 당사 mention."""

    def test_the_list_reads_the_website_filters_and_maps_the_rows(self):
        seen = []

        async def get(path, params=None):
            seen.append((path, dict(params or {})))
            return {"data": {"items": [{"prompt_id": "p1", "prompt_text": "Q?", "funnel_code": None, "answers_total": 3,
                                        "brand_mentions": 4, "providers": ["gemini", "chatgpt"],
                                        "answers": [{"job_id": "j1", "engine": "chatgpt", "region": "US",
                                                     "measured_at": "2026-10-09T01:00:00Z"}]}]},
                    "meta": {"page": {"limit": 1000, "total": 836, "next_cursor": None}}}
        with mock.patch("bff.api.get", get):
            got = run(md.missing_prompts(params([["geography", "US"], ["promptContext", "x"], ["surface", "website"]])))
        path, q = seen[0]
        self.assertEqual(path, "mentions/missing-prompts")
        self.assertEqual((q["surface"], q["country"], q["limit"], q["answers_limit"]), ("website", ["US"], md.MISSING_PROMPTS_LIMIT, md.MISSING_ANSWERS_LIMIT))
        self.assertNotIn("prompt_context", q)
        self.assertEqual(got["status"], 200)
        self.assertEqual(got["body"]["total"], 836)
        row = got["body"]["prompts"][0]
        self.assertEqual((row["id"], row["mentions"], row["answersTotal"], row["brandMentions"], row["providers"]),
                         ("p1", 0, 3, 4, ["Gemini", "ChatGPT"]))
        self.assertEqual((row["answers"][0]["jobId"], row["answers"][0]["mentionCount"]), ("j1", 0))

    def test_the_segments_are_counted_over_every_member(self):
        """2026-10-30 W6 review: the drawer's 다른 브랜드 언급 / 브랜드 언급 없음 counts come from the reader's counts of
        every member, not the loaded rows (the list stops at its limit, the no-brand prompts last)."""
        async def get(path, params=None):
            return {"data": {"items": [], "counts": {"with_brands": 980, "no_brands": 73}},
                    "meta": {"page": {"limit": 1000, "total": 1053, "next_cursor": "1000"}}}
        with mock.patch("bff.api.get", get):
            got = run(md.missing_prompts(params([["engine", "gemini"], ["surface", "website"]])))
        self.assertEqual((got["body"]["total"], got["body"]["counts"]), (1053, {"withBrands": 980, "noBrands": 73}))

    def test_refusals_are_empty_lists(self):
        for status, code in ((403, 200), (404, 200), (422, 400)):
            with mock.patch("bff.api.get", failing(status)):
                got = run(md.missing_prompts(params([["surface", "website"]])))
            self.assertEqual((got["status"], got["body"]), (code, {"prompts": []}))
