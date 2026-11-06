"""The account's scope on every read: the clamp, and the routes through the data server's app with the internal token the hub server would send."""
import os
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from data_server import access, api, screens
    from data_server.tests.signed_in import SECRET, token_for
    from data_server.tests.test_hub_editing import call, run
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_access)") from exc


def COUNTRY_TOKEN():
    return token_for(role="country", brands=["Kia"], regions=["kia-north-america"], countries=["US"])


class Clamp(unittest.TestCase):
    HQ = {"all": False, "brands": ["Genesis"], "regions": [], "countries": []}
    REGION = {"all": False, "brands": ["Kia"], "regions": ["kia-north-america"], "countries": []}
    COUNTRY = {"all": False, "brands": ["Hyundai", "Kia"], "regions": ["hyundai-europe"], "countries": ["DE", "FR"]}

    def q(self, query, scope):
        out = access.clamp(QueryParams(query), scope)
        return {k: out.getlist(k) for k in out}

    def test_every_scope_reads_as_asked(self):
        q = QueryParams("surface=website&brand=hmg&country=XX")
        self.assertIs(access.clamp(q, access.ALL), q)

    def test_brands_stay_inside_the_scope(self):
        self.assertEqual(self.q("surface=global", self.HQ), {"surface": ["global"], "brand": ["Genesis"]})
        self.assertEqual(self.q("brand=hyundai", self.HQ)["brand"], ["Genesis"])
        self.assertEqual(self.q("brand=hmg", self.HQ)["brand"], ["Genesis"])   # the umbrella is every brand
        self.assertEqual(self.q("brand=genesis&brand=kia", self.HQ)["brand"], ["genesis"])
        self.assertEqual(self.q("brand=kia", self.COUNTRY)["brand"], ["kia"])

    def test_countries_stay_inside_the_scope(self):
        self.assertEqual(self.q("country=US&country=KR", self.HQ)["country"], ["US", "KR"])   # hq: every country
        self.assertEqual(self.q("", self.REGION)["country"], ["CA", "US"])                    # the region's countries
        self.assertEqual(self.q("country=us", self.REGION)["country"], ["us"])
        self.assertEqual(self.q("country=KR", self.REGION)["country"], ["CA", "US"])          # outside: the scope's
        self.assertEqual(self.q("country=FR&country=JP", self.COUNTRY)["country"], ["FR"])
        self.assertEqual(self.q("", self.COUNTRY)["country"], ["DE", "FR"])

    def test_other_params_keep_their_order(self):
        self.assertEqual(str(access.clamp(QueryParams("to=2026-10-01&engine=chatgpt&from=2026-09-01"), self.HQ)),
                         "brand=Genesis&engine=chatgpt&from=2026-09-01&to=2026-10-01")

    def test_website_reads_inside_the_same_scope(self):
        # ⛔J (2026-10-31): the website surface is clamped as global is; its countries are site countries
        self.assertEqual(self.q("surface=website", self.HQ), {"surface": ["website"], "brand": ["Genesis"]})
        self.assertEqual(self.q("surface=website&brand=hmg&country=KR", self.REGION),
                         {"surface": ["website"], "brand": ["Kia"], "country": ["CA", "US"]})
        self.assertEqual(self.q("surface=website&country=FR&country=JP", self.COUNTRY)["country"], ["FR"])
        # a site hub (worldwide · EU · MIDDLEEAST) is not a country of a region or country account
        self.assertEqual(self.q("surface=website&country=worldwide&country=EU", self.COUNTRY)["country"], ["DE", "FR"])
        self.assertEqual(self.q("surface=website&country=worldwide", self.HQ)["country"], ["worldwide"])   # hq: every site

    def test_website_city_sites_follow_their_country(self):
        # lib/geo-catalog/pseudo-country.ts scopeParent: a scope with SA also reads the Saudi city sites (website only)
        me = {"all": False, "brands": ["Genesis"], "regions": ["genesis-middle-east"], "countries": []}
        self.assertEqual(self.q("surface=website", me)["country"],
                         ["BH", "KW", "OM", "QA", "SA", "AE", "IL", "SA-Dammam", "SA-Jeddah", "SA-Riyadh"])
        self.assertEqual(self.q("surface=website&country=SA-Dammam", me)["country"], ["SA-Dammam"])
        self.assertEqual(self.q("surface=global", me)["country"], ["BH", "KW", "OM", "QA", "SA", "AE", "IL"])
        self.assertEqual(self.q("surface=website", self.COUNTRY)["country"], ["DE", "FR"])
        self.assertEqual(access.surface_countries(me, "global"), ["BH", "KW", "OM", "QA", "SA", "AE", "IL"])
        self.assertIsNone(access.surface_countries(self.HQ, "website"))

    def test_a_scoped_read_outside_global_and_website_or_without_a_scope_is_refused(self):
        for query, scope in (("surface=project", self.REGION), ("surface=project", self.HQ),
                             ("surface=website", {**self.HQ, "brands": []}),
                             ("", {**self.HQ, "brands": []}), ("", {**self.REGION, "regions": ["nowhere"]})):
            with self.assertRaises(HTTPException) as caught:
                access.clamp(QueryParams(query), scope)
            self.assertEqual(caught.exception.status_code, 403, query)

    def test_unresolved_regions_deny_rather_than_open(self):
        self.assertEqual(access.scope_countries({"all": False, "regions": ["kia-north-america", "nowhere"]}), [])
        self.assertIsNone(access.scope_countries({"all": False, "brands": ["Kia"], "regions": []}))


class Reads(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.dict(os.environ, {"HGH_INTERNAL_TOKEN_SECRET": SECRET})
        patch.start()
        self.addCleanup(patch.stop)

    def test_screens_and_reads_run_in_the_accounts_scope(self):
        seen = {}

        async def build(path, q):
            seen["scope"] = access.reader_scope()
            seen["read"] = str(await api.get("summary", {"surface": "global", "brand": ["Hyundai", "Kia"], "country": ["KR"]}))
            return {}

        async def read(path, q):
            return {"path": path, "q": str(q)}

        with mock.patch.object(screens, "build", build), mock.patch.object(api, "read", read):
            self.assertEqual(run(call("GET", "/v1/screens/overview"))[0], 401)
            self.assertEqual(run(call("GET", "/v1/summary"))[0], 401)
            token = COUNTRY_TOKEN()
            self.assertEqual(run(call("GET", "/v1/screens/overview", token=token))[0], 200)
            self.assertEqual(seen["scope"], {"all": False, "brands": ["Kia"], "regions": ["kia-north-america"], "countries": ["US"]})
            self.assertEqual(seen["read"], "{'path': 'summary', 'q': 'brand=Kia&country=US&surface=global'}")
            status, out = run(call("GET", "/v1/summary?brand=hmg&country=KR", token=token))
            self.assertEqual((status, out["q"]), (200, "brand=Kia&country=US"))
            status, out = run(call("GET", "/v1/summary?surface=website", token=token))
            self.assertEqual((status, out["q"]), (200, "brand=Kia&country=US&surface=website"))
            status, out = run(call("GET", "/v1/summary?surface=project&project_id=x", token=token))
            self.assertEqual((status, out["error"]["code"]), (403, "out_of_scope"))
            status, out = run(call("GET", "/v1/summary?surface=website&brand=hmg", token=token_for()))
            self.assertEqual((status, out["q"]), (200, "surface=website&brand=hmg"))
        self.assertEqual(access.reader_scope(), access.ALL)   # the request's scope does not outlive it

    def test_project_identities_stay_refused_to_a_scoped_account(self):
        # F20 (2026-11-03): the project list and a project's prompts (gold/projects) are the project surface read
        # without a surface param; a scoped account was clamped as a global read and listed every project.
        async def read(path, q):
            return {"data": {"items": [], "project": {}, "prompts": []}}

        with mock.patch.object(api, "read", read):
            token = COUNTRY_TOKEN()
            for path in ("/v1/gold/projects", "/v1/gold/projects/x", "/v1/screens/projects/list",
                         "/v1/screens/projects/detail?ctx.project_id=x"):
                status, out = run(call("GET", path, token=token))
                self.assertEqual((status, (out.get("error") or {}).get("code")), (403, "out_of_scope"), path)
            admin = token_for()
            for path in ("/v1/gold/projects", "/v1/screens/projects/list"):
                self.assertEqual(run(call("GET", path, token=admin))[0], 200, path)


if __name__ == "__main__":
    unittest.main()
