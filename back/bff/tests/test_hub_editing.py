"""HUB login and Global prompt editing: password and token rules, the definition rules, and the routes
end to end through the ASGI app against an in-memory catalog (no database)."""
import asyncio
import json
import os
import unittest
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from unittest import mock
from uuid import UUID, uuid4

try:
    import asyncpg

    from bff import app as bff_app
    from bff.hub_stores import catalog_editor as ce
    from bff.hub_stores import hub_auth, hub_catalog, passwords
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_hub_editing)") from exc

SECRET = "s" * 40
T0 = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)


# ═══ fakes ═══════════════════════════════════════════════════════════════════════════════════════════════

class Ctx:
    def __init__(self, value=None):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *exc):
        return False


class Catalog:
    """catalog.prompt / prompt_version in memory, answering the SQL constants catalog_editor sends."""

    def __init__(self):
        self.project = uuid4()
        self.prompts, self.versions, self.locks = {}, {}, 0
        # catalog.current_reference, family taxon (what the last Gold import recorded)
        self.taxa = [{"axis": "list_type", "code": "comparison", "path": []}, {"axis": "depth1", "code": "charging", "path": []},
                     {"axis": "depth1", "code": "ev", "path": []}, {"axis": "depth2", "code": "cost", "path": ["charging"]},
                     {"axis": "depth3", "code": "home", "path": ["charging", "cost"]}, {"axis": "depth2", "code": "range", "path": ["ev"]},
                     {"axis": "presence", "code": "brand", "path": []}, {"axis": "unknown_axis", "code": "x", "path": []}]

    def add(self, origin, text, definition, project=None, versions=1):
        pid = uuid4()
        self.prompts[pid] = {"project_id": project or self.project, "origin": origin, "registered_at": T0}
        self.versions[pid] = []
        for v in range(1, versions + 1):
            self.versions[pid].append({"version": v, "text": text, "definition": json.dumps(definition),
                                       "sha256": ce.digest(text, definition), "recorded_at": T0 + timedelta(minutes=v), "recorded_by": None})
        return pid

    def current(self, pid):
        p, v = self.prompts[pid], self.versions[pid][-1]
        return {"prompt_id": pid, "source_id": None, **p, **v}

    def currents(self, project):
        return [self.current(pid) for pid, p in self.prompts.items() if p["project_id"] == project]


class Conn:
    def __init__(self, catalog):
        self.c = catalog

    def transaction(self):
        return Ctx()

    async def execute(self, sql, *args):
        if sql.startswith("SET LOCAL lock_timeout"):
            pass
        elif "pg_advisory_xact_lock" in sql:
            self.c.locks += 1
        elif sql.startswith("INSERT INTO catalog.prompt("):
            pid, project = args
            self.c.prompts[pid] = {"project_id": project, "origin": "hub", "registered_at": T0}
            self.c.versions[pid] = []
        elif "INSERT INTO catalog.prompt_version" in sql:
            pid, version, text, definition, sha, by = args
            if any(v["version"] == version for v in self.c.versions[pid]):
                raise asyncpg.UniqueViolationError("duplicate key")
            self.c.versions[pid].append({"version": version, "text": text, "definition": definition, "sha256": sha,
                                         "recorded_at": T0 + timedelta(hours=version), "recorded_by": by})
        else:
            raise AssertionError(sql)

    async def fetch(self, sql, *args):
        if sql is ce.GLOBAL_PROJECT_SQL:
            return [{"project_id": self.c.project}]
        if sql is ce.VOCABULARY_SQL:
            counts = {}
            for row in self.c.currents(args[0]):
                d = json.loads(row["definition"])
                for api, key in ce.SCALARS.items():
                    if d.get(key):
                        counts[(api, d[key])] = counts.get((api, d[key]), 0) + 1
                for r in d.get("regions") or []:
                    counts[("regions", r)] = counts.get(("regions", r), 0) + 1
            return [{"key": k, "value": v, "n": n} for (k, v), n in counts.items()]
        if sql is ce.TAXON_SQL:
            return [{**t, "path": json.dumps(t["path"])} for t in self.c.taxa]
        if sql is ce.VERSIONS_SQL:
            pid, limit = args
            return list(reversed(self.c.versions[pid]))[:limit]
        if "FROM catalog.current_prompt p WHERE" in sql:
            return self.c.currents(args[0])[: args[-2]]
        raise AssertionError(sql)

    async def fetchrow(self, sql, *args):
        if sql is ce.CURRENT_SQL:
            return self.c.current(args[0]) if args[0] in self.c.prompts else None
        if sql is ce.COUNTS_SQL:
            rows = self.c.currents(args[0])
            return {"total": len(rows), "hub": sum(r["origin"] == "hub" for r in rows), "gold": sum(r["origin"] == "gold" for r in rows),
                    "archived": sum(json.loads(r["definition"]).get("status") == "archived" for r in rows),
                    "removed": sum(json.loads(r["definition"]).get("status") == "removed" for r in rows)}
        raise AssertionError(sql)

    async def fetchval(self, sql, *args):
        if sql is ce.DUPLICATE_SQL:
            project, text, language, own = args
            for row in self.c.currents(project):
                d = json.loads(row["definition"])
                if (row["text"] == text and (d.get("language") or "").lower() == language and d.get("status", "active") == "active"
                        and row["prompt_id"] != own):
                    return row["prompt_id"]
            return None
        if sql.startswith("SELECT count(*) FROM catalog.current_prompt p"):
            return len(self.c.currents(args[0]))
        raise AssertionError(sql)


class Pool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return Ctx(self.conn)


class Accounts:
    """system.user_account + credential + global_role for one administrator."""

    def __init__(self, password="correct horse battery"):
        self.row = {"user_id": uuid4(), "subject": "admin", "email": "admin@example.test", "display_name": "Admin",
                    "status": "active", "password_hash": passwords.hash_password(password), "changed_at": T0, "must_change": False,
                    "role": "admin", "brands": [], "regions": [], "countries": []}

    @asynccontextmanager
    async def connection(self):
        accounts = self

        class C:
            async def fetchrow(self, sql, value):
                if hub_auth.BY_LOGIN in sql:   # login IDs compare without case
                    return dict(accounts.row) if accounts.row["subject"].lower() == value.lower() else None
                return dict(accounts.row) if accounts.row["user_id"] == value else None

            async def fetch(self, sql, ids):
                return [{"user_id": accounts.row["user_id"], "subject": "admin", "display_name": "Admin"}] if accounts.row["user_id"] in ids else []
        yield C()


async def call(method, path, body=None, token=None, raw=None):
    """One request through the real FastAPI app (routing, handlers, error envelope)."""
    path, _, query = path.partition("?")
    payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
    headers = [(b"content-type", b"application/json")] if payload else []
    if token:
        headers.append((b"authorization", f"Bearer {token}".encode()))
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "path": path,
             "raw_path": path.encode(), "query_string": query.encode(), "headers": headers, "client": ("127.0.0.1", 1),
             "server": ("127.0.0.1", 5555), "scheme": "http", "root_path": ""}
    sent, out = False, {"status": None, "body": b""}

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": payload, "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
        elif message["type"] == "http.response.body":
            out["body"] += message.get("body", b"")

    await bff_app.app(scope, receive, send)
    return out["status"], json.loads(out["body"] or b"null")


def run(coro):
    return asyncio.run(coro)


GOLD_DEF = {"surface": 1, "kind": "single", "language": "ko", "regions": ["KR", "x:ww"], "funnel": "awareness",
            "brand_presence": "brand", "list_type": "faq", "depth1": "ev", "depth2": None, "depth3": None, "depth4": None,
            "targets": [], "rule_ver": "r1"}


# ═══ passwords and tokens ════════════════════════════════════════════════════════════════════════════════

class Passwords(unittest.TestCase):
    def test_round_trip_and_wrong_password(self):
        encoded = passwords.hash_password("s3cret-pass")
        self.assertTrue(encoded.startswith("scrypt$16384$8$1$"))
        self.assertTrue(passwords.verify_password("s3cret-pass", encoded))
        self.assertFalse(passwords.verify_password("s3cret-pasS", encoded))
        self.assertNotEqual(encoded, passwords.hash_password("s3cret-pass"))   # salted

    def test_malformed_or_oversized_hashes_are_refused(self):
        good = passwords.hash_password("x")
        for bad in ("", "scrypt$1$2", good.replace("scrypt", "bcrypt", 1), "scrypt$1048576$8$1$AAAA$AAAA",
                    good.rsplit("$", 1)[0] + "$***"):
            self.assertFalse(passwords.verify_password("x", bad), bad)


class Tokens(unittest.TestCase):
    key = SECRET.encode()

    def test_issue_and_decode(self):
        uid = uuid4()
        token, exp = hub_auth.issue(self.key, uid, 42, 1000.0)
        self.assertEqual(exp, 1000 + hub_auth.TOKEN_TTL_S)
        claims = hub_auth.decode(self.key, token, 1001.0)
        self.assertEqual((claims["sub"], claims["cv"]), (str(uid), 42))

    def test_tampered_foreign_expired_or_malformed_tokens_are_refused(self):
        token, exp = hub_auth.issue(self.key, uuid4(), 1, 1000.0)
        head, payload, sig = token.split(".")
        forged = hub_auth._b64(json.dumps({"sub": str(uuid4()), "cv": 1, "iat": 1000, "exp": exp}).encode())
        for bad in (f"{head}.{forged}.{sig}", f"v2.{payload}.{sig}", token + "x", "v1.e30", "", "Bearer"):
            self.assertIsNone(hub_auth.decode(self.key, bad, 1001.0), bad)
        self.assertIsNone(hub_auth.decode(b"k" * 40, token, 1001.0))
        self.assertIsNone(hub_auth.decode(self.key, token, float(exp)))

    def test_limiter_blocks_after_the_limit_inside_the_window(self):
        lim = hub_auth.FailureLimiter(limit=2, window=10)
        lim.fail("a", 0)
        self.assertFalse(lim.blocked("a", 1))
        lim.fail("a", 1)
        self.assertTrue(lim.blocked("a", 2))
        self.assertFalse(lim.blocked("a", 11.5))   # the first failure left the window
        lim.reset("a")
        self.assertFalse(lim.blocked("a", 2))


# ═══ definition rules ════════════════════════════════════════════════════════════════════════════════════

class Rules(unittest.TestCase):
    def fields(self, **kw):
        return ce.parse(ce.PromptFields, {"text": "  EV 충전 요금은?  ", **kw})

    def test_normalize_trims_lowers_language_and_normalizes_regions(self):
        text, d = ce.normalize(self.fields(language=" KO ", regions=[" kr", "x:ww", "KR", ""], funnel=" ", depth1=" ev "))
        self.assertEqual(text, "EV 충전 요금은?")
        self.assertEqual(d, {"surface": 1, "kind": "single", "language": "ko", "regions": ["KR", "x:WW"], "funnel": None,
                             "brand_presence": None, "list_type": None, "depth1": "ev", "depth2": None, "depth3": None, "depth4": None})

    def test_text_rules(self):
        for text in ("   ", "line\nbreak", "tab\there", "x" * (ce.TEXT_MAX + 1)):
            with self.assertRaises(ce.HTTPException) as cm:
                ce.normalize(ce.parse(ce.PromptFields, {"text": text}))
            self.assertEqual(cm.exception.status_code, 422, text)

    def test_parse_refuses_unknown_fields_and_bad_kinds_in_the_envelope(self):
        for body in ({"text": "a", "brand": "Kia"}, {"text": "a", "kind": "multi"}, {"kind": "single"}, ["text"]):
            with self.assertRaises(ce.HTTPException) as cm:
                ce.parse(ce.PromptFields, body)
            self.assertEqual((cm.exception.status_code, cm.exception.detail["code"]), (422, "invalid_value"))

    def test_vocabulary_check_names_the_unknown_fields(self):
        vocab = {"language": [{"value": "ko", "count": 1}], "regions": [{"value": "KR", "count": 1}], "funnel": [{"value": "awareness", "count": 1}]}
        _, ok = ce.normalize(self.fields(language="ko", regions=["KR"], funnel="awareness"))
        ce.check_vocabulary(ok, vocab)
        _, bad = ce.normalize(self.fields(language="fr", regions=["KR", "US"], funnel="awareness", depth1="new"))
        with self.assertRaises(ce.HTTPException) as cm:
            ce.check_vocabulary(bad, vocab)
        self.assertEqual(cm.exception.detail["details"]["fields"], ["language", "depth1", "regions"])

    def test_taxonomy_path_follows_the_recorded_tree(self):
        taxa = [("depth1", "charging", ()), ("depth1", "ev", ()), ("depth2", "cost", ("charging",)),
                ("depth2", "cost", ("ev",)), ("depth3", "home", ("charging", "cost"))]
        for ok in ({}, {"depth1": "ev"}, {"depth1": "ev", "depth2": "cost"}, {"depth1": "charging", "depth2": "cost", "depth3": "home"}):
            ce.check_taxonomy_path(ok, taxa)
        for bad, field in (({"depth1": "ev", "depth2": "cost", "depth3": "home"}, "depth3"),   # home sits under charging / cost
                           ({"depth2": "cost"}, "depth2"), ({"depth1": "ev", "depth3": "home"}, "depth3"),
                           ({"depth1": "made-up"}, "depth1")):
            with self.assertRaises(ce.HTTPException) as cm:
                ce.check_taxonomy_path(bad, taxa)
            self.assertEqual((cm.exception.detail["code"], cm.exception.detail["details"]["fields"]), ("invalid_taxonomy", [field]), bad)
        ce.check_taxonomy_path({"depth2": "anything"}, [])   # nothing recorded yet: nothing to check against

    def test_removed_is_a_status_of_its_own(self):
        self.assertEqual([ce.status_of({"status": s}) for s in ("active", "archived", "removed", None, "x")],
                         ["active", "archived", "removed", "active", "active"])
        project = uuid4()
        self.assertEqual(ce.list_filters({"status": "removed"}, project)[1], [project, "removed"])
        base = {**GOLD_DEF, "status": "active"}
        rows = [{"version": v, "text": "a", "definition": json.dumps({**base, "status": s}), "recorded_at": T0, "recorded_by": None}
                for v, s in ((1, "active"), (2, "removed"), (3, "active"))]
        self.assertEqual([e["event"] for e in ce.history(rows)], ["restored", "removed", "created"])

    def test_history_events_and_changes(self):
        base = {**GOLD_DEF, "status": "active"}
        rows = [{"version": 1, "text": "a", "definition": json.dumps(base), "recorded_at": T0, "recorded_by": None},
                {"version": 2, "text": "b", "definition": json.dumps({**base, "funnel": "consideration"}), "recorded_at": T0, "recorded_by": uuid4()},
                {"version": 3, "text": "b", "definition": json.dumps({**base, "funnel": "consideration", "status": "archived"}), "recorded_at": T0, "recorded_by": None},
                {"version": 4, "text": "b", "definition": json.dumps({**base, "funnel": "consideration"}), "recorded_at": T0, "recorded_by": None},
                {"version": 5, "text": "b", "definition": json.dumps({**base, "funnel": "consideration", "rule_ver": "r2"}), "recorded_at": T0, "recorded_by": None}]
        events = ce.history(rows)
        self.assertEqual([e["event"] for e in events], ["updated", "restored", "archived", "updated", "created"])
        self.assertEqual(events[3]["changes"], {"text": {"old": "a", "new": "b"}, "funnel": {"old": "awareness", "new": "consideration"}})
        self.assertEqual(events[0]["changes"], {})   # a Gold-only field changed
        self.assertEqual(events[4]["recordedBy"], None)
        self.assertEqual(events[3]["recordedBy"], str(rows[1]["recorded_by"]))

    def test_list_filters_bind_every_value(self):
        project = uuid4()
        where, args = ce.list_filters({"status": "all", "origin": "hub", "kind": "acr", "language": " KO ", "q": "50%_off"}, project)
        self.assertEqual(where, "p.project_id=$1 AND p.origin=$2 AND coalesce(p.definition->>'kind','single')=$3 AND "
                                "lower(p.definition->>'language')=$4 AND strpos(lower(p.text),lower($5))>0")
        self.assertEqual(args, [project, "hub", "acr", "ko", "50%_off"])
        self.assertEqual(ce.list_filters({}, project)[1], [project, "active"])
        where, args = ce.list_filters({"funnel": "인지/탐색", "brandPresence": "branded", "depth1": "1. Car+Features", "region": " x:ww "}, project)
        self.assertEqual(where, "p.project_id=$1 AND coalesce(p.definition->>'status','active')=$2 AND p.definition->>'funnel'=$3 AND "
                                "p.definition->>'brand_presence'=$4 AND p.definition->>'depth1'=$5 AND "
                                "p.definition->'regions' @> jsonb_build_array($6::text)")
        self.assertEqual(args, [project, "active", "인지/탐색", "branded", "1. Car+Features", "x:WW"])
        for bad in ({"status": "deleted"}, {"origin": "x"}, {"kind": "x"}, {"q": "a\nb"}, {"funnel": "a\tb"}, {"region": "K" * 201}):
            with self.assertRaises(ce.HTTPException):
                ce.list_filters(bad, project)

    def test_list_order_sorts_by_one_column_then_the_latest_change(self):
        self.assertEqual(ce.list_order({}), "p.recorded_at DESC NULLS LAST,p.recorded_at DESC,p.prompt_id")
        self.assertEqual(ce.list_order({"sort": "text"}), "p.text ASC NULLS LAST,p.recorded_at DESC,p.prompt_id")
        self.assertEqual(ce.list_order({"sort": "depth1", "order": "desc"}), "p.definition->>'depth1' DESC NULLS LAST,p.recorded_at DESC,p.prompt_id")
        self.assertEqual(ce.list_order({"sort": "status"}), "coalesce(p.definition->>'status','active') ASC NULLS LAST,p.recorded_at DESC,p.prompt_id")
        for bad in ({"sort": "p.text; DROP"}, {"sort": "text", "order": "up"}):
            with self.assertRaises(ce.HTTPException):
                ce.list_order(bad)


# ═══ routes ══════════════════════════════════════════════════════════════════════════════════════════════

class Routes(unittest.TestCase):
    def setUp(self):
        self.catalog = Catalog()
        self.gold = self.catalog.add("gold", "기존 Gold 프롬프트", GOLD_DEF)
        self.accounts = Accounts()

        @asynccontextmanager
        async def reader():
            yield Conn(self.catalog)

        hub_auth.limiter.failures.clear()
        for p in (mock.patch.dict(os.environ, {"HGH_AUTH_SECRET": SECRET}),
                  mock.patch.object(hub_auth.operations_db, "connection", self.accounts.connection),
                  mock.patch.object(ce.operations_db, "connection", self.accounts.connection),
                  mock.patch.object(ce.analytics_db, "connection", reader),
                  mock.patch.object(ce, "_pool", Pool(Conn(self.catalog)))):
            p.start()
            self.addCleanup(p.stop)

    def login(self, password="correct horse battery"):
        return run(call("POST", "/v1/auth/login", {"login": "admin", "password": password}))

    def token(self):
        status, body = self.login()
        self.assertEqual(status, 200, body)
        return body["data"]["token"]

    def new(self, token, **kw):
        return run(call("POST", "/v1/hub/global-prompts", {"text": "새 프롬프트", "language": "ko", "regions": ["kr"], **kw}, token))

    # ── login ───────────────────────────────────────────────────────────────────────────────────────────
    def test_login_and_me(self):
        status, body = self.login()
        self.assertEqual(status, 200)
        self.assertEqual(body["data"]["user"], {"id": str(self.accounts.row["user_id"]), "login": "admin",
                                                "email": "admin@example.test", "displayName": "Admin", "role": "admin",
                                                "scope": {"all": True}, "mustChangePassword": False})
        status, me = run(call("GET", "/v1/auth/me", token=body["data"]["token"]))
        self.assertEqual((status, me["data"]["user"]["login"]), (200, "admin"))

    def test_wrong_unknown_and_non_admin_logins_look_the_same(self):
        self.assertEqual(self.login("wrong")[0], 401)
        self.assertEqual(run(call("POST", "/v1/auth/login", {"login": "nobody", "password": "x"}))[1]["error"]["code"], "unauthorized")
        self.accounts.row["role"] = None
        status, body = self.login()
        self.assertEqual((status, body["error"]["code"]), (401, "unauthorized"))

    def test_repeated_failures_are_refused_for_a_while(self):
        for _ in range(hub_auth.FAILURE_LIMIT):
            self.assertEqual(self.login("wrong")[0], 401)
        status, body = self.login()
        self.assertEqual((status, body["error"]["code"]), (429, "rate_limited"))

    def test_sessions_end_on_password_change_role_revoke_or_disable(self):
        for change in ({"changed_at": T0 + timedelta(seconds=1)}, {"role": None}, {"status": "disabled"}):
            token = self.token()
            saved = dict(self.accounts.row)
            self.accounts.row.update(change)
            status, body = run(call("GET", "/v1/auth/me", token=token))
            self.assertEqual((status, body["error"]["code"]), (401, "unauthorized"), change)
            self.accounts.row = saved

    def test_without_a_secret_login_is_unavailable(self):
        with mock.patch.dict(os.environ, {"HGH_AUTH_SECRET": "short"}):
            self.assertEqual(self.login()[0], 503)
            self.assertEqual(run(call("GET", "/v1/hub/global-prompts", token="v1.a.b"))[0], 503)

    def test_every_editing_route_needs_the_administrator(self):
        pid = str(self.gold)
        for method, path, body in (("GET", "/v1/hub/global-prompts", None), ("GET", "/v1/hub/global-prompts/options", None),
                                   ("POST", "/v1/hub/global-prompts", {"text": "x"}), ("GET", f"/v1/hub/global-prompts/{pid}", None),
                                   ("PUT", f"/v1/hub/global-prompts/{pid}", {"text": "x", "expectedVersion": 1}),
                                   ("POST", f"/v1/hub/global-prompts/{pid}/archive", {"expectedVersion": 1})):
            for token in (None, "v1.forged.token"):
                status, out = run(call(method, path, body, token))
                self.assertEqual((status, out["error"]["code"]), (401, "unauthorized"), (method, path, token))
        self.assertEqual(len(self.catalog.prompts), 1)

    def test_other_routes_keep_their_behaviour(self):
        status, body = run(call("POST", "/v1/prompts", {}))
        self.assertEqual((status, body["error"]["code"]), (405, "read_only"))
        with mock.patch.object(hub_catalog, "listing", mock.AsyncMock(return_value={"data": {"items": []}})) as listing:
            self.assertEqual(run(call("GET", "/v1/hub/prompts"))[0], 401)
            self.assertEqual(run(call("GET", "/v1/hub/prompts", token=self.token()))[0], 200)
        listing.assert_awaited_once()

    # ── editing ─────────────────────────────────────────────────────────────────────────────────────────
    def test_create_records_a_hub_prompt_with_its_author(self):
        status, body = self.new(self.token(), kind="acr", funnel="awareness")
        self.assertEqual(status, 201, body)
        item = body["data"]["item"]
        self.assertEqual((item["origin"], item["editable"], item["version"], item["status"]), ("hub", True, 1, "active"))
        self.assertEqual((item["text"], item["kind"], item["language"], item["regions"], item["funnel"]), ("새 프롬프트", "acr", "ko", ["KR"], "awareness"))
        stored = self.catalog.versions[UUID(item["id"])][0]
        self.assertEqual(stored["recorded_by"], self.accounts.row["user_id"])
        self.assertEqual(json.loads(stored["definition"])["status"], "active")
        self.assertEqual(self.catalog.locks, 1)

    def test_create_refuses_unknown_codes_duplicates_and_bad_bodies(self):
        token = self.token()
        status, body = self.new(token, funnel="made-up")
        self.assertEqual((status, body["error"]["code"], body["error"]["details"]["fields"]), (422, "unknown_code", ["funnel"]))
        status, body = run(call("POST", "/v1/hub/global-prompts", {"text": "기존 Gold 프롬프트", "language": "KO"}, token))
        self.assertEqual((status, body["error"]["code"], body["error"]["details"]["promptId"]), (409, "duplicate", str(self.gold)))
        status, body = run(call("POST", "/v1/hub/global-prompts", raw=b"{", token=token))
        self.assertEqual((status, body["error"]["code"]), (422, "invalid_value"))
        status, body = run(call("POST", "/v1/hub/global-prompts", {"text": "x", "brand": "Kia"}, token))
        self.assertEqual((status, body["error"]["details"]["fields"]), (422, ["brand"]))
        self.assertEqual(len(self.catalog.prompts), 1)

    def test_edit_archive_restore_and_history(self):
        token = self.token()
        pid = self.new(token)[1]["data"]["item"]["id"]
        status, body = run(call("PUT", f"/v1/hub/global-prompts/{pid}", {"text": "고친 프롬프트", "language": "ko", "regions": ["KR"], "expectedVersion": 1}, token))
        self.assertEqual((status, body["data"]["item"]["version"], body["data"]["changed"]), (200, 2, True))
        # the same fields again: nothing recorded
        status, body = run(call("PUT", f"/v1/hub/global-prompts/{pid}", {"text": "고친 프롬프트 ", "language": "KO", "regions": ["kr"], "expectedVersion": 2}, token))
        self.assertEqual((body["data"]["item"]["version"], body["data"]["changed"]), (2, False))
        status, body = run(call("POST", f"/v1/hub/global-prompts/{pid}/archive", {"expectedVersion": 2}, token))
        self.assertEqual((body["data"]["item"]["status"], body["data"]["item"]["version"]), ("archived", 3))
        status, body = run(call("PUT", f"/v1/hub/global-prompts/{pid}", {"text": "y", "expectedVersion": 3}, token))
        self.assertEqual((status, body["error"]["code"]), (409, "archived"))
        status, body = run(call("POST", f"/v1/hub/global-prompts/{pid}/restore", {"expectedVersion": 3}, token))
        self.assertEqual((body["data"]["item"]["status"], body["data"]["item"]["version"]), ("active", 4))
        status, body = run(call("GET", f"/v1/hub/global-prompts/{pid}", token=token))
        history = body["data"]["history"]
        self.assertEqual([h["event"] for h in history], ["restored", "archived", "updated", "created"])
        self.assertEqual(history[2]["changes"], {"text": {"old": "새 프롬프트", "new": "고친 프롬프트"}})
        self.assertEqual(history[0]["actor"], {"login": "admin", "displayName": "Admin"})

    def test_stale_versions_and_gold_prompts_are_refused(self):
        token = self.token()
        pid = self.new(token)[1]["data"]["item"]["id"]
        run(call("PUT", f"/v1/hub/global-prompts/{pid}", {"text": "v2", "expectedVersion": 1}, token))
        status, body = run(call("PUT", f"/v1/hub/global-prompts/{pid}", {"text": "v3", "expectedVersion": 1}, token))
        self.assertEqual((status, body["error"]["code"], body["error"]["details"]), (409, "version_conflict", {"currentVersion": 2}))
        status, body = run(call("POST", f"/v1/hub/global-prompts/{self.gold}/archive", {"expectedVersion": 1}, token))
        self.assertEqual((status, body["error"]["code"]), (409, "gold_owned"))
        self.assertEqual(len(self.catalog.versions[self.gold]), 1)

    def test_prompts_outside_the_global_project_are_not_found(self):
        token = self.token()
        other = self.catalog.add("hub", "프로젝트 프롬프트", {"surface": 3}, project=uuid4())
        for method, path, body in (("GET", f"/v1/hub/global-prompts/{other}", None),
                                   ("PUT", f"/v1/hub/global-prompts/{other}", {"text": "x", "expectedVersion": 1}),
                                   ("POST", f"/v1/hub/global-prompts/{uuid4()}/archive", {"expectedVersion": 1})):
            self.assertEqual(run(call(method, path, body, token))[0], 404, (method, path))
        self.assertEqual(run(call("POST", f"/v1/hub/global-prompts/{other}/delete", {"expectedVersion": 1}, token))[0], 404)

    def test_listing_and_options(self):
        token = self.token()
        self.new(token)
        status, body = run(call("GET", "/v1/hub/global-prompts?status=all&limit=10", token=token))
        self.assertEqual(status, 200, body)
        self.assertEqual(body["data"]["page"], {"total": 2, "limit": 10, "offset": 0})
        self.assertEqual(body["data"]["counts"], {"total": 2, "hub": 1, "gold": 1, "archived": 0, "removed": 0})
        self.assertEqual(run(call("GET", "/v1/hub/global-prompts?limit=0", token=token))[0], 422)
        status, body = run(call("GET", "/v1/hub/global-prompts/options", token=token))
        self.assertEqual(body["data"]["kinds"], ["single", "acr"])
        self.assertEqual(body["data"]["regions"], [{"value": "KR", "count": 2}, {"value": "x:WW", "count": 1}])
        self.assertEqual(body["data"]["funnel"], [{"value": "awareness", "count": 1}])
        # taxonomy fields: Gold's dictionary, used codes first (a Gold-only code counts 0)
        self.assertEqual(body["data"]["listType"], [{"value": "faq", "count": 1}, {"value": "comparison", "count": 0}])
        self.assertEqual(body["data"]["brandPresence"], [{"value": "brand", "count": 1}])
        self.assertEqual(body["data"]["depth4"], [])
        # the depth codes with their parents (the form's cascade); other axes are not part of it
        self.assertEqual(body["data"]["taxonomy"], [
            {"field": "depth1", "code": "charging", "path": []}, {"field": "depth1", "code": "ev", "path": []},
            {"field": "depth2", "code": "cost", "path": ["charging"]}, {"field": "depth3", "code": "home", "path": ["charging", "cost"]},
            {"field": "depth2", "code": "range", "path": ["ev"]}])

    def test_recorded_taxonomy_codes_are_accepted_and_none_recorded_falls_back(self):
        token = self.token()
        # nothing recorded yet: only codes the catalog already uses; `charging` is taxonomy-only
        recorded, self.catalog.taxa = self.catalog.taxa, []
        with self.assertLogs("hgh.hub", "WARNING"):
            status, body = self.new(token, depth1="charging")
        self.assertEqual((status, body["error"]["code"], body["error"]["details"]["fields"]), (422, "unknown_code", ["depth1"]))
        self.catalog.taxa = recorded
        status, body = self.new(token, listType="comparison", depth1="charging", depth2="cost", depth3="home")
        self.assertEqual((status, body["data"]["item"]["listType"], body["data"]["item"]["depth3"]), (201, "comparison", "home"))
        # every code known, but range sits under ev, not charging
        status, body = self.new(token, text="다른 프롬프트", depth1="charging", depth2="range")
        self.assertEqual((status, body["error"]["code"], body["error"]["details"]["fields"]), (422, "invalid_taxonomy", ["depth2"]))

    def test_a_running_gold_import_makes_writes_wait_then_503(self):
        token = self.token()

        async def locked(sql, *args):
            if "pg_advisory_xact_lock" in sql:
                raise asyncpg.LockNotAvailableError("lock timeout")
        with mock.patch.object(Conn, "execute", side_effect=locked, autospec=False):
            status, body = self.new(token)
        self.assertEqual((status, body["error"]["code"]), (503, "source_unavailable"))


if __name__ == "__main__":
    unittest.main()
