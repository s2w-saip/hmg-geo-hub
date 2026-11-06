"""The browser's door (hub_server/browser.py, T14.5.2): the cookie, the Origin, who opens what and which context a browser may name. What it passes on is the /v1 route's own answer."""
import asyncio
import json
import unittest
from unittest import mock
from uuid import uuid4

try:
    import httpx
    from fastapi import HTTPException

    from hub_server import browser
    from hub_server.app import app
    from shared.account import Principal
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Needs the hub server's requirements (hub_server.tests.test_browser)") from exc

PID = "843ecb1b-4713-4c2a-8592-e173eb16b7c7"
OK_ORIGIN = "http://127.0.0.1:3334"


def principal(role="admin", must_change=False):
    return Principal(user_id=uuid4(), login="a", email=None, display_name=None, role=role, brands=(), regions=(), countries=(), must_change=must_change)


class Door(unittest.TestCase):
    def setUp(self):
        self.who = principal()
        self.calls = []
        self.answer = httpx.Response(200, json={"data": {}}, headers={"content-type": "application/json"})

        async def signed_in(authorization, *, password_change=False):
            if authorization == "Bearer bad":
                raise HTTPException(401, "no")
            return self.who

        async def inner(request, method, path, query=None, *, token=None, body=None):
            self.calls.append({"method": method, "path": path, "query": list(query or []), "token": token, "body": body})
            return self.answer

        for patch in (mock.patch.object(browser.hub_auth, "principal", signed_in), mock.patch.object(browser, "inner", inner)):
            patch.start()
            self.addCleanup(patch.stop)

    def request(self, method, path, cookie="tok", origin=None, body=None):
        headers = {"host": "127.0.0.1:3334"}
        if cookie:
            headers["cookie"] = f"{browser.COOKIE}={cookie}"
        if origin:
            headers["origin"] = origin
        content = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())

        async def go():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:3334") as client:
                return await client.request(method, path, headers=headers, content=content)
        return asyncio.run(go())

    def read(self, path, **kw):
        return self.request("GET", path, **kw)

    def last(self):
        return self.calls[-1]


class Session(Door):
    def test_the_token_stays_in_an_http_only_cookie(self):
        self.answer = httpx.Response(200, json={"data": {"token": "secret-token", "expiresAt": 2000000000, "user": {"id": "u"}}})
        out = self.request("POST", "/api/hub/session", cookie=None, origin=OK_ORIGIN, body={"login": "a", "password": "b"})
        self.assertEqual((out.status_code, out.json()), (200, {"user": {"id": "u"}}))
        self.assertNotIn("secret-token", out.text)
        cookie = out.headers["set-cookie"]
        self.assertIn(f"{browser.COOKIE}=secret-token", cookie)
        for flag in ("HttpOnly", "SameSite=strict", "Path=/", "expires="):
            self.assertIn(flag.lower(), cookie.lower())
        self.assertNotIn("secure", cookie.lower())
        self.assertEqual(self.last()["path"], "/v1/auth/login")

    def test_a_refused_login_passes_on_and_sets_nothing(self):
        self.answer = httpx.Response(401, json={"error": {"code": "invalid_credentials"}})
        out = self.request("POST", "/api/hub/session", cookie=None, origin=OK_ORIGIN, body={"login": "a", "password": "b"})
        self.assertEqual((out.status_code, out.json()["error"]["code"]), (401, "invalid_credentials"))
        self.assertNotIn("set-cookie", out.headers)

    def test_a_write_needs_this_sites_origin(self):
        for origin in (None, "http://evil.test", "not a url"):
            out = self.request("POST", "/api/hub/session", cookie=None, origin=origin, body={"login": "a", "password": "b"})
            self.assertEqual((out.status_code, out.json()["error"]["code"]), (403, "forbidden"), origin)
            self.assertEqual(self.request("DELETE", "/api/hub/session", origin=origin).status_code, 403, origin)
            self.assertEqual(self.request("POST", "/api/hub/password", origin=origin, body={"current": "a", "new": "b"}).status_code, 403, origin)
            self.assertEqual(self.request("POST", "/api/hub/accounts", origin=origin, body={}).status_code, 403, origin)
        self.assertEqual(self.calls, [])

    def test_a_bad_body_stops_here(self):
        for body in (b"not json", {"login": "a"}, {"login": 1, "password": "b"}, [1]):
            self.assertEqual(self.request("POST", "/api/hub/session", cookie=None, origin=OK_ORIGIN, body=body).status_code, 422, body)
        self.assertEqual(self.request("POST", "/api/hub/password", origin=OK_ORIGIN, body={"current": "a"}).status_code, 422)

    def test_sign_out_clears_the_cookie(self):
        out = self.request("DELETE", "/api/hub/session", origin=OK_ORIGIN)
        self.assertEqual(out.status_code, 204)
        self.assertIn(f'{browser.COOKIE}=""', out.headers["set-cookie"])
        self.assertIn("max-age=0", out.headers["set-cookie"].lower())

    def test_a_password_change_renews_the_cookie(self):
        self.answer = httpx.Response(200, json={"data": {"token": "fresh", "expiresAt": 2000000000, "user": {"id": "u"}}})
        out = self.request("POST", "/api/hub/password", origin=OK_ORIGIN, body={"current": "a", "new": "b"})
        self.assertEqual(out.json(), {"user": {"id": "u"}})
        self.assertIn(f"{browser.COOKIE}=fresh", out.headers["set-cookie"])
        self.assertEqual((self.last()["path"], self.last()["token"]), ("/v1/auth/password", "tok"))
        self.assertEqual(self.request("POST", "/api/hub/password", cookie=None, origin=OK_ORIGIN, body={"current": "a", "new": "b"}).status_code, 401)

    def test_reading_the_session(self):
        self.assertEqual(self.read("/api/hub/session", cookie=None).json(), {"user": None})
        self.answer = httpx.Response(401, json={})
        self.assertEqual(self.read("/api/hub/session").json(), {"user": None})
        self.answer = httpx.Response(200, json={"data": {"user": {"id": "u"}}})
        self.assertEqual(self.read("/api/hub/session").json(), {"user": {"id": "u"}})
        self.answer = httpx.Response(503, json={"error": {"code": "unavailable"}})
        self.assertEqual(self.read("/api/hub/session").status_code, 503)


class Families(Door):
    def test_the_cookie_becomes_the_token_and_the_path_stays(self):
        out = self.request("POST", f"/api/hub/projects/{PID}/measurement", origin=OK_ORIGIN, body={"expectedVersion": 1})
        self.assertEqual(out.status_code, 200)
        self.assertEqual(out.headers["cache-control"], "no-store")
        self.assertEqual({k: self.last()[k] for k in ("method", "path", "token")}, {"method": "POST", "path": f"/v1/hub/projects/{PID}/measurement", "token": "tok"})
        self.assertEqual(json.loads(self.last()["body"]), {"expectedVersion": 1})
        self.read("/api/hub/source-seeds/history?key=instagram.com/x&key=b")
        self.assertEqual((self.last()["path"], self.last()["query"]), ("/v1/hub/source-seeds/history", [("key", "instagram.com/x"), ("key", "b")]))
        self.request("DELETE", f"/api/hub/saved-filters/{PID}", origin=OK_ORIGIN)
        self.assertEqual((self.last()["method"], self.last()["body"]), ("DELETE", None))

    def test_nothing_else_is_reached(self):
        for path in ("/api/hub/operations", "/api/hub/accounts/a..b", "/api/hub/accounts/a.b/c"):
            self.assertIn(self.read(path).status_code, (404,), path)
        self.assertEqual(self.read("/api/hub/accounts", cookie=None).status_code, 401)
        self.assertEqual(self.calls, [])


class Screens(Door):
    def query(self):
        return self.last()["query"]

    def test_the_account_says_role_and_admin_and_filters_stay_repeated(self):
        self.who = principal("country")
        out = self.read("/api/screens/mention/rn-page?brand=kia&brand=hyundai&empty=&ctx.role=admin&ctx.admin=true&ctx.other=x&ctx.locale=ko&ctx.surface=website")
        self.assertEqual(out.status_code, 200)
        query = self.query()
        self.assertEqual(self.last()["path"], "/v1/screens/mention/rn-page")
        self.assertEqual([v for k, v in query if k == "brand"], ["kia", "hyundai"])
        self.assertIn(("empty", ""), query)
        self.assertEqual(dict(query)["ctx.role"], "country")
        self.assertEqual(dict(query)["ctx.admin"], "false")
        self.assertEqual(dict(query)["ctx.surface"], "website")
        self.assertEqual(dict(query)["ctx.locale"], "ko")
        self.assertNotIn("ctx.other", dict(query))
        self.assertEqual(sum(1 for k, _ in query if k == "ctx.role"), 1)

    def test_a_context_value_is_one_value(self):
        self.read("/api/screens/overview/cards?ctx.kpi=a&ctx.kpi=b")
        self.assertEqual(sum(1 for k, _ in self.query() if k == "ctx.kpi"), 1)

    def test_the_screen_decides_the_surface_not_the_browser(self):
        for name, surface in (("website/summary", "website"), ("citation/project", "project"), ("catalog/prompts-page", "global"), ("citation/standard", "global"), ("acr/renewal", "global")):
            self.read(f"/api/screens/{name}?ctx.surface=website&ctx.project_id={PID}")
            self.assertEqual(dict(self.query())["ctx.surface"], surface, name)

    def test_citation_screens_are_the_renewal_variant(self):
        self.read("/api/screens/citation/standard?ctx.variant=old")
        self.assertEqual(dict(self.query())["ctx.variant"], "renewal")
        self.assertEqual(sum(1 for k, _ in self.query() if k == "ctx.variant"), 1)

    def test_refusals(self):
        self.assertEqual((self.read("/api/screens/overview/cards", cookie=None).status_code), 401)
        self.assertEqual((self.read("/api/screens/overview/cards", cookie="bad").status_code), 401)
        self.assertEqual(self.read("/api/screens/citation/domains").json()["error"]["code"], "not_found")
        self.assertEqual(self.read("/api/screens/overview/cards?surface=mars").json()["error"]["code"], "invalid_surface")
        self.assertEqual(self.read("/api/screens/projects/settings?ctx.project_id=nope").json()["error"]["code"], "invalid_project_id")
        self.assertEqual(self.read("/api/screens/overview/cards?ctx.locale=fr").json()["error"]["code"], "invalid_locale")
        self.who = principal(must_change=True)
        self.assertEqual(self.read("/api/screens/overview/cards").json()["error"]["code"], "password_change_required")
        self.assertEqual(self.calls, [])

    def test_only_the_administrator_opens_project_screens(self):
        for role in ("hq", "region", "country"):
            self.who = principal(role)
            for path in ("/api/screens/projects/list", f"/api/screens/projects/settings?ctx.project_id={PID}", f"/api/screens/citation/as-of?ctx.surface=project&ctx.project_id={PID}"):
                self.assertEqual(self.read(path).json()["error"]["code"], "forbidden", path)
            self.assertEqual(self.read("/api/screens/overview/cards").status_code, 200, role)
            self.assertEqual(self.read("/api/screens/website/summary").status_code, 200, role)
        self.who = principal("admin")
        self.assertEqual(self.read("/api/screens/projects/list").status_code, 200)

    def test_an_unknown_role_opens_nothing_but_the_service_week(self):
        self.who = principal("vendor")
        self.assertEqual(self.read("/api/screens/overview/cards").status_code, 403)
        self.assertEqual(self.read("/api/screens/shared/service-week").status_code, 200)


class Reads(Door):
    def query(self):
        return dict(self.last()["query"])

    def test_service_week_passes_the_site_picks_only(self):
        self.read("/api/service-week?brand=kia&geography=KR&language=ko&engine=x&time=2026&ctx.role=admin")
        self.assertEqual(self.last()["path"], "/v1/screens/shared/service-week")
        self.assertEqual(self.query(), {"brand": "kia", "geography": "KR", "language": "ko", "engine": "x"})
        self.assertEqual(self.read("/api/service-week", cookie=None).status_code, 401)

    def test_filter_options(self):
        self.read("/api/filters/options?area=analysis&surface=global&time=a..b&brand=kia&engine=x&project_id=nope")
        self.assertEqual(self.last()["path"], "/v1/screens/filters/options")
        self.assertEqual(self.query(), {"time": "a..b", "brand": "kia", "surface": "global"})
        self.read(f"/api/filters/options?area=funnel&surface=project&project_id={PID}&engine=x")
        self.assertEqual(self.query(), {"engine": "x", "surface": "project", "project_id": PID})
        for bad in ("area=x&surface=global", "area=analysis&surface=x", "area=analysis&surface=project", "area=analysis&surface=website&project_id=nope"):
            self.assertEqual(self.read(f"/api/filters/options?{bad}").json()["error"]["code"], "invalid_value", bad)
        self.assertEqual(self.read("/api/filters/options?area=analysis&surface=global", cookie=None).status_code, 401)
        self.who = principal("hq")
        self.assertEqual(self.read(f"/api/filters/options?area=analysis&surface=project&project_id={PID}").status_code, 403)

    def test_a_drill_sends_its_params_as_they_came(self):
        self.answer = httpx.Response(404, json={"available": False})
        out = self.read("/api/scope/answer?jobId=1&brand=a&brand=b&empty=&surface=website")
        self.assertEqual((out.status_code, out.json()), (404, {"available": False}))
        self.assertEqual(self.last()["path"], "/v1/drill/mention/drill-answer")
        self.assertEqual(json.loads(self.query()["ctx.params"]), [["jobId", "1"], ["brand", "a"], ["brand", "b"], ["empty", ""], ["surface", "website"]])
        for route, target in (("brand-citations", "mention/drill-brand-citations"), ("brand-mention-prompts", "mention/drill-brand-prompts"), ("signal-prompts", "mention/drill-signal-prompts"),
                              ("missing-prompts", "mention/drill-missing-prompts"), ("market-evidence", "overview/market-evidence")):
            self.read(f"/api/scope/{route}")
            self.assertEqual(self.last()["path"], f"/v1/drill/{target}")
        self.assertEqual(self.read("/api/scope/answer", cookie=None).status_code, 401)
        self.assertEqual(self.read("/api/scope/nope").status_code, 404)

    def test_mention_compare(self):
        self.read(f"/api/scope/mention-compare?surface=project&projectId={PID}&admin=1&target=kia&ctx.role=x")
        self.assertEqual(self.last()["path"], "/v1/screens/mention/view-compare")
        self.assertEqual(self.query(), {"target": "kia", "ctx.surface": "project", "ctx.project_id": PID, "ctx.admin": "true"})
        self.who = principal("hq")
        self.read("/api/scope/mention-compare?admin=1")
        self.assertEqual(self.query(), {"ctx.surface": "website"})
        self.assertEqual(self.read("/api/scope/mention-compare?surface=project").json(), {"error": "projectId required"})
        self.assertEqual(self.read("/api/scope/mention-compare", cookie=None).status_code, 401)

    def test_the_prompt_lists_and_the_acr_sheet(self):
        self.read("/api/standard/acr/sheet?sheet=KR&ctx.role=admin")
        self.assertEqual((self.last()["path"], self.query()), ("/v1/screens/acr/renewal-sheet", {"sheet": "KR"}))
        for view, target in (("page", "catalog/prompts-page"), ("export", "catalog/prompts-export"), ("history", "catalog/prompts-history"), ("timeline", "catalog/prompts-timeline")):
            self.read(f"/api/standard/prompts/{view}?q=a&ctx.admin=true")
            self.assertEqual((self.last()["path"], self.query()), (f"/v1/screens/{target}", {"q": "a"}))
        self.who = principal("hq")
        for view, target in (("page", "website/prompts-page"), ("rows", "website/prompts-rows"), ("insights", "website/prompts-insights")):
            self.read(f"/api/website/prompts/{view}?q=a&ctx.admin=true")
            self.assertEqual((self.last()["path"], self.query()), (f"/v1/screens/{target}", {"q": "a", "ctx.admin": "false"}))
        for path in ("/api/standard/prompts/nope", "/api/website/prompts/nope"):
            self.assertEqual(self.read(path).status_code, 404, path)
        for path in ("/api/standard/acr/sheet", "/api/standard/prompts/page", "/api/website/prompts/page"):
            self.assertEqual(self.read(path, cookie=None).status_code, 401, path)


class Failures(Door):
    def test_a_read_failure_says_only_its_code_and_an_edit_keeps_its_details(self):
        self.answer = httpx.Response(422, json={"error": {"code": "invalid_value", "message": "sheet must be <country>|<engine>"}})
        self.assertEqual(self.read("/api/standard/acr/sheet?sheet=KR").json(), {"error": {"code": "invalid_value"}})
        self.answer = httpx.Response(409, json={"error": {"code": "version_conflict", "message": "m", "details": {"currentVersion": 3}}})
        out = self.request("POST", f"/api/hub/projects/{PID}/measurement", origin=OK_ORIGIN, body={})
        self.assertEqual(out.json()["error"]["details"], {"currentVersion": 3})

    def test_every_route_without_a_session_answers_alike(self):
        for path in ("/api/service-week", "/api/screens/overview/cards", "/api/scope/answer", "/api/scope/mention-compare", "/api/standard/prompts/page", "/api/website/prompts/page",
                     "/api/citations/domains", "/api/filters/options?area=analysis&surface=global", "/api/hub/accounts", "/api/standard/acr/sheet"):
            out = self.read(path, cookie=None)
            self.assertEqual((out.status_code, out.json()["error"]["code"]), (401, "unauthorized"), path)


class Citations(Door):
    def query(self):
        return dict(self.last()["query"])

    def test_the_target_and_the_route_context(self):
        self.read("/api/citations/domains?sort=share&dir=asc&limit=50&q=kia&ctx.skey=x")
        self.assertEqual(self.last()["path"], "/v1/screens/citation/domains")
        self.assertEqual(self.query(), {"sort": "share", "dir": "asc", "limit": "50", "q": "kia", "ctx.surface": "global", "ctx.role": "admin"})
        self.read(f"/api/citations/domains?projectId={PID}")
        self.assertEqual((self.query()["ctx.surface"], self.query()["ctx.project_id"]), ("project", PID))
        self.read("/api/citations/domains?surface=website")
        self.assertEqual(self.query()["ctx.surface"], "website")

    def test_bad_values(self):
        for bad in ("sort=x", "dir=x", "limit=0", "limit=201", "limit=1.5", "q=" + "a" * 201, "q=%01", "projectId=nope"):
            self.assertEqual(self.read(f"/api/citations/domains?{bad}").json()["error"]["code"], "invalid_value", bad)
        for bad in ("locale=fr", "max_rows=5001", "max_rows=0", "sort=x"):
            self.assertEqual(self.read(f"/api/citations/domains/export?{bad}").json()["error"]["code"], "invalid_value", bad)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.read("/api/citations/domains", cookie=None).status_code, 401)
        self.who = principal("hq")
        self.assertEqual(self.read(f"/api/citations/domains?projectId={PID}").status_code, 403)

    def test_a_source_key_in_the_path(self):
        import base64
        segment = base64.urlsafe_b64encode(b"instagram.com/hyundai").decode().rstrip("=")
        self.read(f"/api/citations/domains/{segment}")
        self.assertEqual((self.last()["path"], self.query()["ctx.skey"]), ("/v1/screens/citation/domain-detail", "instagram.com/hyundai"))
        for bad in ("a", "!!!!", base64.urlsafe_b64encode(b"a\x01").decode().rstrip("="), "aGk="):
            self.assertEqual(self.read(f"/api/citations/domains/{bad}").status_code, 422, bad)

    def test_the_export_is_a_download(self):
        out = self.read("/api/citations/domains/export?locale=en&max_rows=10")
        self.assertEqual(self.last()["path"], "/v1/screens/citation/domains-export")
        self.assertEqual((out.headers["content-disposition"], out.headers["x-content-type-options"], out.headers["cache-control"]), ("attachment", "nosniff", "no-store"))


if __name__ == "__main__":
    unittest.main()
