"""HUB accounts (Admin › 사용자 관리) and the account scope on reads: the role and scope rules, the read clamp,
and the routes end to end through the ASGI app against in-memory account tables (no database)."""
import os
import unittest
from contextlib import asynccontextmanager
from datetime import timedelta
from unittest import mock
from uuid import uuid4

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from bff import access, api, screens
    from bff.hub_stores import accounts as acc
    from bff.hub_stores import hub_auth, passwords
    from bff.tests.test_hub_editing import SECRET, T0, Ctx, Pool, call, run
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_hub_accounts)") from exc

PASSWORD = "correct horse battery"


# ═══ fakes ═══════════════════════════════════════════════════════════════════════════════════════════════

class Tables:
    """system.user_account + user_credential + global_role + audit_event, answering the SQL constants sent."""

    def __init__(self):
        self.accounts, self.creds, self.roles, self.audit, self.clock, self.locks = {}, {}, {}, [], 0, 0

    def tick(self):
        self.clock += 1
        return T0 + timedelta(seconds=self.clock)

    def add(self, login, role="admin", brands=(), regions=(), countries=(), password=PASSWORD, must_change=False):
        uid = uuid4()
        self.accounts[uid] = {"subject": login, "display_name": None, "email": None, "status": "active",
                              "created_at": self.tick(), "last_sign_in_at": None}
        self.creds[uid] = {"password_hash": passwords.hash_password(password), "must_change": must_change, "changed_at": self.tick()}
        if role:
            self.roles[uid] = {"role": role, "brands": list(brands), "regions": list(regions), "countries": list(countries)}
        return uid

    def row(self, uid):
        if uid not in self.accounts:
            return None
        a, c, g = self.accounts[uid], self.creds.get(uid), self.roles.get(uid) or {}
        return {"user_id": uid, **a, "has_password": c is not None, "password_hash": c and c["password_hash"],
                "must_change": c and c["must_change"], "changed_at": c and c["changed_at"], "role": g.get("role"),
                "brands": g.get("brands"), "regions": g.get("regions"), "countries": g.get("countries"), "updated_at": T0}


class Conn:
    def __init__(self, t):
        self.t = t

    def transaction(self):
        return Ctx()

    async def fetchrow(self, sql, value):
        t = self.t
        if sql == hub_auth.ACCOUNT_SQL.format(where=hub_auth.BY_LOGIN):
            return next((t.row(u) for u, a in t.accounts.items() if a["subject"].lower() == value.lower()), None)
        if sql in (hub_auth.ACCOUNT_SQL.format(where=hub_auth.BY_ID), acc.ONE_SQL):
            return t.row(value)
        raise AssertionError(sql)

    async def fetch(self, sql, *args):
        t = self.t
        if sql is acc.LIST_SQL:
            return sorted((t.row(u) for u in t.accounts), key=lambda r: r["created_at"])
        if sql is acc.HISTORY_SQL:
            uid, login = args
            out = [e for e in t.audit if (e["action"].startswith("account.") and e["details"]["user_id"] == uid)
                   or (e["action"].startswith("hub_login.") and e["details"].get("login") == login)]
            return list(reversed(out))
        raise AssertionError(sql)

    async def fetchval(self, sql, *args):
        if sql is acc.TAKEN_SQL:
            return 1 if any(a["subject"].lower() == args[0].lower() for a in self.t.accounts.values()) else None
        raise AssertionError(sql)

    async def execute(self, sql, *args):
        t = self.t
        if sql is acc.LOCK_SQL:
            t.locks += 1
        elif sql is acc.INSERT_ACCOUNT_SQL:
            uid, login, name, email = args
            t.accounts[uid] = {"subject": login, "display_name": name, "email": email, "status": "active",
                               "created_at": t.tick(), "last_sign_in_at": None}
        elif sql is acc.UPDATE_ACCOUNT_SQL:
            uid, name, email = args
            t.accounts[uid].update(display_name=name, email=email)
        elif sql is acc.STATUS_SQL:
            t.accounts[args[0]]["status"] = args[1]
        elif sql is acc.SIGNED_IN_SQL:
            t.accounts[args[0]]["last_sign_in_at"] = t.tick()
        elif sql is acc.ROLE_SQL:
            uid, role, brands, regions, countries = args
            t.roles[uid] = {"role": role, "brands": brands, "regions": regions, "countries": countries}
        elif sql is acc.PASSWORD_SQL:
            uid, digest, must_change = args
            t.creds[uid] = {"password_hash": digest, "must_change": must_change, "changed_at": t.tick()}
        elif sql is acc.AUDIT_SQL:
            import json
            actor, action, details = args
            t.audit.append({"event_id": len(t.audit) + 1, "action": action, "details": json.loads(details), "occurred_at": t.tick(),
                            "actor_login": t.accounts[actor]["subject"] if actor else None,
                            "actor_name": t.accounts[actor]["display_name"] if actor else None})
        else:
            raise AssertionError(sql)


def body_of(**kw):
    return {"login": "kim.hq", "displayName": "김 HQ", "email": "kim@example.test", "role": "hq", "brands": ["Genesis"], **kw}


# ═══ rules ═══════════════════════════════════════════════════════════════════════════════════════════════

class Rules(unittest.TestCase):
    def scope(self, **kw):
        return acc.scope_of(acc.AccountFields(**{"role": "hq", "brands": ["Genesis"], **kw}))

    def refused_fields(self, **kw):
        with self.assertRaises(HTTPException) as caught:
            self.scope(**kw)
        return caught.exception.detail["details"]["fields"]

    def test_each_role_keeps_the_axes_it_uses(self):
        self.assertEqual(self.scope(role="admin", brands=["Kia"], regions=["kia-africa"]), ("admin", [], [], []))
        self.assertEqual(self.scope(brands=["genesis", "Genesis"], regions=["genesis-asia-pacific"]), ("hq", ["Genesis"], [], []))
        self.assertEqual(self.scope(role="region", regions=["genesis-asia-pacific"], countries=["KR"]),
                         ("region", ["Genesis"], ["genesis-asia-pacific"], []))
        self.assertEqual(self.scope(role="country", regions=["genesis-asia-pacific"], countries=["kr"]),
                         ("country", ["Genesis"], ["genesis-asia-pacific"], ["KR"]))

    def test_scope_follows_the_brand_region_country_cascade(self):
        self.assertEqual(self.refused_fields(role="viewer"), ["role"])
        self.assertEqual(self.refused_fields(brands=[]), ["brands"])
        self.assertEqual(self.refused_fields(brands=["Toyota"]), ["brands"])
        self.assertEqual(self.refused_fields(role="region"), ["regions"])
        self.assertEqual(self.refused_fields(role="region", regions=["kia-africa"]), ["regions"])   # not a Genesis region
        self.assertEqual(self.refused_fields(role="region", regions=["nowhere"]), ["regions"])
        self.assertEqual(self.refused_fields(role="country", regions=["genesis-asia-pacific"]), ["countries"])
        self.assertEqual(self.refused_fields(role="country", regions=["genesis-asia-pacific"], countries=["DE"]), ["countries"])

    def test_an_account_manages_only_the_roles_below_its_own(self):
        below = lambda role: [r for r in (*acc.ROLES, None) if acc.below(r, role)]   # noqa: E731
        self.assertEqual(below("admin"), ["hq", "region", "country", None])
        self.assertEqual(below("region"), ["country", None])
        self.assertEqual(below("country"), [None])

    def test_login_email_name_and_passwords(self):
        self.assertEqual(acc.login_of("  kim.hq@hmg "), "kim.hq@hmg")
        for bad in ("ab", "김", "a b c", "x" * 201):
            with self.assertRaises(HTTPException):
                acc.login_of(bad)
        self.assertIsNone(acc.email_of("  "))
        with self.assertRaises(HTTPException):
            acc.email_of("not-an-email")
        with self.assertRaises(HTTPException):
            acc.text_of("two\nlines", "displayName", acc.NAME_MAX)
        with self.assertRaises(HTTPException):
            acc.check_new_password("short")
        with self.assertRaises(HTTPException):
            acc.check_new_password("same password", "same password")
        temp = acc.temporary_password()
        self.assertRegex(temp, r"^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$")
        self.assertGreaterEqual(len(temp), acc.PASSWORD_MIN)
        self.assertNotEqual(temp, acc.temporary_password())


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

    def test_no_account_holds_a_dedicated_site_code(self):
        # The website-only site codes (worldwide · CPO · HYUNDAI-N, front lib/scope/website-virtual-geo) are no country of
        # an RHQ region, so the Admin screen cannot give one to an account: the dedicated-site rules never apply here.
        for code in ("worldwide", "CPO", "HYUNDAI-N", "EU", "MIDDLEEAST", "SA-Dammam"):
            body = acc.AccountCreate(login="site", role="country", brands=["Hyundai"], regions=["hyundai-middle-east"],
                                     countries=["SA", code])
            with self.assertRaises(HTTPException, msg=code) as caught:
                acc.scope_of(body)
            self.assertEqual(caught.exception.detail["details"]["fields"], ["countries"], code)

    def test_unresolved_regions_deny_rather_than_open(self):
        self.assertEqual(access.scope_countries({"all": False, "regions": ["kia-north-america", "nowhere"]}), [])
        self.assertIsNone(access.scope_countries({"all": False, "brands": ["Kia"], "regions": []}))


# ═══ routes ══════════════════════════════════════════════════════════════════════════════════════════════

class Routes(unittest.TestCase):
    def setUp(self):
        self.t = Tables()
        self.admin = self.t.add("admin@hub")
        t = self.t

        @asynccontextmanager
        async def reader():
            yield Conn(t)

        hub_auth.limiter.failures.clear()
        for p in (mock.patch.dict(os.environ, {"HGH_AUTH_SECRET": SECRET}),
                  mock.patch.object(hub_auth.operations_db, "connection", reader),
                  mock.patch.object(acc, "_pool", Pool(Conn(t)))):
            p.start()
            self.addCleanup(p.stop)

    def login(self, login="admin@hub", password=PASSWORD):
        return run(call("POST", "/v1/auth/login", {"login": login, "password": password}))

    def token(self, login="admin@hub", password=PASSWORD):
        status, body = self.login(login, password)
        self.assertEqual(status, 200, body)
        return body["data"]["token"]

    def create(self, token, **kw):
        return run(call("POST", "/v1/hub/accounts", body_of(**kw), token))

    # ── sign-in ──────────────────────────────────────────────────────────────────────────────────────────
    def test_every_role_signs_in_with_its_scope_and_the_sign_in_is_noted(self):
        uid = self.t.add("Lee.Region", "region", ["Kia"], ["kia-north-america"])
        status, body = self.login("lee.region")   # login IDs compare without case
        self.assertEqual(status, 200, body)
        self.assertEqual(body["data"]["user"]["role"], "region")
        self.assertEqual(body["data"]["user"]["scope"], {"all": False, "brands": ["Kia"], "regions": ["kia-north-america"], "countries": []})
        self.assertIsNotNone(self.t.accounts[uid]["last_sign_in_at"])

    def test_an_account_without_a_role_or_disabled_cannot_sign_in(self):
        self.t.add("norole", role=None)
        self.assertEqual(self.login("norole")[0], 401)
        uid = self.t.add("off", "hq", ["Kia"])
        self.t.accounts[uid]["status"] = "disabled"
        self.assertEqual(self.login("off")[0], 401)

    # ── administrator only ───────────────────────────────────────────────────────────────────────────────
    def test_account_management_and_prompt_editing_are_the_administrators(self):
        self.t.add("hq", "hq", ["Genesis"])
        hq = self.token("hq")
        uid = str(self.admin)
        for method, path, body in (("GET", "/v1/hub/accounts", None), ("POST", "/v1/hub/accounts", body_of()),
                                   ("GET", f"/v1/hub/accounts/{uid}", None),
                                   ("PUT", f"/v1/hub/accounts/{uid}", {**body_of(), "expectedVersion": "x"}),
                                   ("POST", f"/v1/hub/accounts/{uid}/disable", None),
                                   ("POST", f"/v1/hub/accounts/{uid}/reset-password", None),
                                   ("GET", "/v1/hub/global-prompts", None), ("GET", "/v1/hub/prompts", None)):
            self.assertEqual(run(call(method, path, body))[0], 401, (method, path))
            status, out = run(call(method, path, body, hq))
            self.assertEqual((status, out["error"]["code"]), (403, "forbidden"), (method, path))
        self.assertEqual(len(self.t.accounts), 2)

    # ── create, temporary password, first sign-in ────────────────────────────────────────────────────────
    def test_create_issues_a_temporary_password_replaced_at_the_first_sign_in(self):
        admin = self.token()
        status, out = self.create(admin, login="Kim.HQ")
        self.assertEqual(status, 201, out)
        item, temp = out["data"]["item"], out["data"]["temporaryPassword"]
        self.assertEqual((item["login"], item["role"], item["brands"], item["mustChangePassword"]), ("Kim.HQ", "hq", ["Genesis"], True))
        self.assertEqual(self.t.audit[-1]["action"], "account.create")
        self.assertEqual(self.t.audit[-1]["details"]["changes"]["role"], [None, "hq"])
        self.assertEqual(self.create(admin, login="kim.hq")[1]["error"]["code"], "login_taken")

        status, body = self.login("kim.hq", temp)
        self.assertEqual((status, body["data"]["user"]["mustChangePassword"]), (200, True))
        token = body["data"]["token"]
        self.assertEqual(run(call("GET", "/v1/auth/me", token=token))[0], 200)
        status, out = run(call("GET", "/v1/screens/overview", token=token))
        self.assertEqual((status, out["error"]["code"]), (403, "password_change_required"))
        self.assertEqual(run(call("POST", "/v1/auth/password", {"current": "wrong", "new": "a brand new secret"}, token))[1]["error"]["code"],
                         "wrong_password")
        self.assertEqual(run(call("POST", "/v1/auth/password", {"current": temp, "new": temp}, token))[0], 422)
        status, out = run(call("POST", "/v1/auth/password", {"current": temp, "new": "a brand new secret"}, token))
        self.assertEqual(status, 200, out)
        fresh = out["data"]["token"]
        self.assertFalse(out["data"]["user"]["mustChangePassword"])
        self.assertEqual(run(call("GET", "/v1/auth/me", token=token))[0], 401)   # the issued password's session ended
        self.assertEqual(self.login("kim.hq", temp)[0], 401)
        self.assertEqual(self.t.audit[-1]["action"], "account.password_change")
        with mock.patch.object(screens, "build", mock.AsyncMock(return_value={})):
            self.assertEqual(run(call("GET", "/v1/screens/overview", token=fresh))[0], 200)

    def test_bad_bodies_name_their_fields(self):
        admin = self.token()
        for kw, field in (({"login": "a"}, "login"), ({"role": "region"}, "regions"), ({"email": "x"}, "email"),
                          ({"brands": ["Kia"], "role": "country", "regions": ["kia-africa"], "countries": ["US"]}, "countries")):
            status, out = self.create(admin, **kw)
            self.assertEqual((status, out["error"]["details"]["fields"]), (422, [field]), kw)
        status, out = run(call("POST", "/v1/hub/accounts", {**body_of(), "password": "chosen"}, admin))
        self.assertEqual(status, 422)
        self.assertEqual(len(self.t.accounts), 1)

    # ── edit, disable, reset ─────────────────────────────────────────────────────────────────────────────
    def test_edit_changes_role_and_scope_and_records_what_changed(self):
        admin = self.token()
        item = self.create(admin)[1]["data"]["item"]
        path = f"/v1/hub/accounts/{item['id']}"
        change = {**body_of(), "role": "country", "regions": ["genesis-asia-pacific"], "countries": ["KR"], "email": None}
        change.pop("login")
        status, out = run(call("PUT", path, {**change, "expectedVersion": item["version"]}, admin))
        self.assertEqual(status, 200, out)
        self.assertEqual((out["data"]["item"]["role"], out["data"]["item"]["countries"], out["data"]["item"]["email"]), ("country", ["KR"], None))
        self.assertEqual(self.t.audit[-1]["details"]["changes"], {"email": ["kim@example.test", None], "role": ["hq", "country"],
                                                                 "regions": [[], ["genesis-asia-pacific"]], "countries": [[], ["KR"]]})
        status, out = run(call("PUT", path, {**change, "expectedVersion": item["version"]}, admin))   # the version it saw is gone
        self.assertEqual((status, out["error"]["code"]), (409, "version_conflict"))
        seen = run(call("GET", path, token=admin))[1]["data"]["item"]["version"]
        run(call("POST", f"{path}/reset-password", token=admin))   # a password or status change is not an edit
        run(call("POST", f"{path}/disable", token=admin))
        status, out = run(call("PUT", path, {**change, "displayName": "김", "expectedVersion": seen}, admin))
        self.assertEqual((status, out["data"]["item"]["displayName"]), (200, "김"))
        status, detail = run(call("GET", path, token=admin))
        self.assertEqual([e["action"] for e in detail["data"]["history"]],
                         ["account.update", "account.disable", "account.reset_password", "account.update", "account.create"])
        self.assertEqual(detail["data"]["history"][0]["actor"]["login"], "admin@hub")

    def test_a_role_or_scope_change_applies_to_open_sessions(self):
        uid = self.t.add("hq", "hq", ["Genesis"])
        token = self.token("hq")
        self.t.roles[uid] = {"role": "hq", "brands": ["Kia"], "regions": [], "countries": []}
        self.assertEqual(run(call("GET", "/v1/auth/me", token=token))[1]["data"]["user"]["scope"]["brands"], ["Kia"])
        del self.t.roles[uid]
        self.assertEqual(run(call("GET", "/v1/auth/me", token=token))[0], 401)

    def test_disable_enable_and_reset_end_sessions(self):
        admin = self.token()
        uid = self.t.add("hq", "hq", ["Genesis"])
        token = self.token("hq")
        self.assertEqual(run(call("POST", f"/v1/hub/accounts/{uid}/disable", token=admin))[1]["data"]["item"]["status"], "disabled")
        self.assertEqual(run(call("GET", "/v1/auth/me", token=token))[0], 401)
        self.assertEqual(self.login("hq")[0], 401)
        run(call("POST", f"/v1/hub/accounts/{uid}/enable", token=admin))
        token = self.token("hq")
        status, out = run(call("POST", f"/v1/hub/accounts/{uid}/reset-password", token=admin))
        self.assertEqual((status, out["data"]["item"]["mustChangePassword"]), (200, True))
        self.assertEqual(run(call("GET", "/v1/auth/me", token=token))[0], 401)
        self.assertEqual(self.login("hq")[0], 401)
        self.assertEqual(self.login("hq", out["data"]["temporaryPassword"])[0], 200)
        self.assertEqual([e["action"] for e in self.t.audit], ["account.disable", "account.enable", "account.reset_password"])

    def test_accounts_at_or_above_the_actors_role_are_not_managed(self):
        admin = self.token()
        other = self.t.add("second@hub")
        for uid in (self.admin, other):   # their own account and another administrator's
            path = f"/v1/hub/accounts/{uid}"
            item = run(call("GET", path, token=admin))[1]["data"]["item"]
            self.assertFalse(item["manageable"])
            edit = {**body_of(), "role": "admin", "brands": [], "displayName": "관리자", "expectedVersion": item["version"]}
            edit.pop("login")
            for method, action, body in (("PUT", "", edit), ("POST", "/disable", None), ("POST", "/reset-password", None)):
                status, out = run(call(method, path + action, body, admin))
                self.assertEqual((status, out["error"]["code"]), (403, "rank"), (uid, action))
        status, out = self.create(admin, role="admin", brands=[])   # nor is the role handed out
        self.assertEqual((status, out["error"]["code"], out["error"]["details"]["fields"]), (403, "rank", ["role"]))
        hq = self.create(admin)[1]["data"]["item"]
        promote = {**body_of(), "role": "admin", "brands": [], "expectedVersion": hq["version"]}
        promote.pop("login")
        status, out = run(call("PUT", f"/v1/hub/accounts/{hq['id']}", promote, admin))
        self.assertEqual((status, out["error"]["code"]), (403, "rank"))
        self.assertEqual(sorted(r["role"] for r in self.t.roles.values()), ["admin", "admin", "hq"])
        self.assertEqual([self.t.accounts[u]["status"] for u in (self.admin, other)], ["active", "active"])
        self.assertEqual([e["action"] for e in self.t.audit], ["account.create"])

    def test_listing_shows_every_account_and_which_this_one_manages(self):
        self.t.add("second@hub")
        self.t.add("hq", "hq", ["Genesis"])
        self.t.add("norole", role=None)
        data = run(call("GET", "/v1/hub/accounts", token=self.token()))[1]["data"]
        self.assertEqual([(i["login"], i["role"], i["self"], i["manageable"]) for i in data["items"]],
                         [("admin@hub", "admin", True, False), ("second@hub", "admin", False, False),
                          ("hq", "hq", False, True), ("norole", None, False, True)])
        self.assertEqual(data["roles"], ["hq", "region", "country"])   # the roles it may hand out

    # ── reads need a session and run in its scope ────────────────────────────────────────────────────────
    def test_screens_and_reads_run_in_the_accounts_scope(self):
        self.t.add("country", "country", ["Kia"], ["kia-north-america"], ["US"])
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
            token = self.token("country")
            self.assertEqual(run(call("GET", "/v1/screens/overview", token=token))[0], 200)
            self.assertEqual(seen["scope"], {"all": False, "brands": ["Kia"], "regions": ["kia-north-america"], "countries": ["US"]})
            self.assertEqual(seen["read"], "{'path': 'summary', 'q': 'brand=Kia&country=US&surface=global'}")
            status, out = run(call("GET", "/v1/summary?brand=hmg&country=KR", token=token))
            self.assertEqual((status, out["q"]), (200, "brand=Kia&country=US"))
            status, out = run(call("GET", "/v1/summary?surface=website", token=token))
            self.assertEqual((status, out["q"]), (200, "brand=Kia&country=US&surface=website"))
            status, out = run(call("GET", "/v1/summary?surface=project&project_id=x", token=token))
            self.assertEqual((status, out["error"]["code"]), (403, "out_of_scope"))
            status, out = run(call("GET", "/v1/summary?surface=website&brand=hmg", token=self.token()))
            self.assertEqual((status, out["q"]), (200, "surface=website&brand=hmg"))
        self.assertEqual(access.reader_scope(), access.ALL)   # the request's scope does not outlive it


if __name__ == "__main__":
    unittest.main()
