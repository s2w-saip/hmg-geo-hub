"""Global prompt editing: the definition rules, and the routes
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

    from data_server import app as bff_app
    from data_server.hub_stores import catalog_editor as ce
    from data_server.hub_stores import hub_catalog
    from data_server.tests.signed_in import SECRET, token_for
    from shared import internal_token
    from shared.account import Principal
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_hub_editing)") from exc

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
                    "status": "active", "changed_at": T0, "must_change": False,
                    "role": "admin", "brands": [], "regions": [], "countries": []}

    @asynccontextmanager
    async def connection(self):
        accounts = self

        class C:
            async def fetchrow(self, sql, value):
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


class EmptyKind(unittest.TestCase):
    """Last review (2026-11-02, F7): Admin › Global prompts showed a prompt with no Gold kind as 'single' and found it under
    the 'single' pick, a value Gold does not have (Global Prompts dropped the same fill in renewal audit step 13)."""

    def test_an_empty_kind_stays_empty(self):
        self.assertIsNone(ce.snapshot("q", {})["kind"])
        self.assertEqual(ce.snapshot("q", {"kind": "acr"})["kind"], "acr")

    def test_the_kind_pick_and_sort_read_gold_s_value(self):
        self.assertNotIn("coalesce(p.definition->>'kind','single')", ce.SORTS["kind"])


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
        self.assertEqual(where, "p.project_id=$1 AND p.origin=$2 AND p.definition->>'kind'=$3 AND "
                                "lower(p.definition->>'language')=$4 AND strpos(lower(p.text),lower($5))>0")
        self.assertEqual(args, [project, "hub", "acr", "ko", "50%_off"])
        self.assertEqual(ce.list_filters({}, project)[1], [project, "active"])
        where, args = ce.list_filters({"funnel": "인지/탐색", "brandPresence": "branded", "depth1": "1. Car+Features", "region": " x:ww "}, project)
        self.assertEqual(where, "p.project_id=$1 AND coalesce(p.definition->>'status','active')=$2 AND "
                                f"{ce.label_sql('funnel')}=$3 AND {ce.label_sql('brand_presence')}=$4 AND {ce.label_sql('depth1')}=$5 AND "
                                "p.definition->'regions' @> jsonb_build_array($6::text)")
        self.assertEqual(args, [project, "active", "인지/탐색", "branded", "1. Car+Features", "x:WW"])
        for bad in ({"status": "deleted"}, {"origin": "x"}, {"kind": "x"}, {"q": "a\nb"}, {"funnel": "a\tb"}, {"region": "K" * 201}):
            with self.assertRaises(ce.HTTPException):
                ce.list_filters(bad, project)

    def test_list_order_sorts_by_one_column_then_the_latest_change(self):
        self.assertEqual(ce.list_order({}), "p.recorded_at DESC NULLS LAST,p.recorded_at DESC,p.prompt_id")
        self.assertEqual(ce.list_order({"sort": "text"}), "p.text ASC NULLS LAST,p.recorded_at DESC,p.prompt_id")
        self.assertEqual(ce.list_order({"sort": "depth1", "order": "desc"}), f"{ce.label_sql('depth1')} DESC NULLS LAST,p.recorded_at DESC,p.prompt_id")
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

        for p in (mock.patch.dict(os.environ, {"HGH_INTERNAL_TOKEN_SECRET": SECRET}),
                  mock.patch.object(ce.operations_db, "connection", self.accounts.connection),
                  mock.patch.object(ce.input_db, "connection", reader),
                  mock.patch.object(ce, "_pool", Pool(Conn(self.catalog)))):
            p.start()
            self.addCleanup(p.stop)

    def token(self):
        return token_for(self.accounts.row["user_id"])

    def new(self, token, **kw):
        return run(call("POST", "/v1/hub/global-prompts", {"text": "새 프롬프트", "language": "ko", "regions": ["kr"], **kw}, token))

    def test_without_a_key_the_data_server_refuses(self):
        with mock.patch.dict(os.environ, {"HGH_INTERNAL_TOKEN_SECRET": "short"}):
            self.assertEqual(run(call("GET", "/v1/hub/global-prompts", token="i1.a.b"))[0], 503)

    def test_a_login_token_or_an_expired_token_is_refused(self):
        expired = internal_token.sign(SECRET.encode(), Principal(self.accounts.row["user_id"], "", None, None, "admin"), 1000.0)
        for token in ("v1.a.b", expired, self.token() + "x"):
            self.assertEqual(run(call("GET", "/v1/screens/overview/cards", token=token))[0], 401, token)

    # ── login and accounts live on the hub server ─────────────────────────────────────────────────────────
    def test_login_and_accounts_are_not_here(self):
        self.assertEqual(run(call("GET", "/v1/auth/me"))[0], 401)   # the read catch-all, which needs a token
        self.assertEqual(run(call("POST", "/v1/auth/login", {"login": "admin", "password": "x"}))[0], 405)
        self.assertEqual(run(call("POST", "/v1/hub/accounts", {}, self.token()))[0], 405)

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

    def test_stale_versions_and_removed_prompts_are_refused(self):
        token = self.token()
        pid = self.new(token)[1]["data"]["item"]["id"]
        run(call("PUT", f"/v1/hub/global-prompts/{pid}", {"text": "v2", "expectedVersion": 1}, token))
        status, body = run(call("PUT", f"/v1/hub/global-prompts/{pid}", {"text": "v3", "expectedVersion": 1}, token))
        self.assertEqual((status, body["error"]["code"], body["error"]["details"]), (409, "version_conflict", {"currentVersion": 2}))
        removed = self.catalog.add("gold", "Gold에서 빠진 프롬프트", {"surface": 1, "status": "removed"})
        status, body = run(call("POST", f"/v1/hub/global-prompts/{removed}/archive", {"expectedVersion": 1}, token))
        self.assertEqual((status, body["error"]["code"]), (409, "removed"))

    def test_a_gold_prompt_is_edited_here_and_keeps_golds_keys(self):
        """T4.2: every Global prompt is edited in the input store; what the screen does not edit (catalog rows, Gold's keys) stays."""
        token = self.token()
        status, body = run(call("GET", f"/v1/hub/global-prompts/{self.gold}", token=token))
        item = body["data"]["item"]
        self.assertEqual((item["origin"], item["editable"]), ("gold", True))
        stored = dict(self.catalog.versions[self.gold][-1]["definition"]) if isinstance(self.catalog.versions[self.gold][-1]["definition"], dict) \
            else json.loads(self.catalog.versions[self.gold][-1]["definition"])
        unchanged = {k: item[k] for k in ("kind", "language", "regions", "funnel", "brandPresence", "listType", "depth1", "depth2", "depth3", "depth4")}
        status, body = run(call("PUT", f"/v1/hub/global-prompts/{self.gold}", {**unchanged, "text": item["text"], "expectedVersion": item["version"]}, token))
        self.assertEqual((status, body["data"]["changed"]), (200, False))
        status, body = run(call("PUT", f"/v1/hub/global-prompts/{self.gold}", {**unchanged, "text": "고친 Gold 프롬프트", "expectedVersion": item["version"]}, token))
        self.assertEqual((status, body["data"]["changed"], body["data"]["item"]["text"]), (200, True, "고친 Gold 프롬프트"))
        latest = self.catalog.versions[self.gold][-1]["definition"]
        latest = latest if isinstance(latest, dict) else json.loads(latest)
        for key in set(stored) - {"status"} - set(ce.LABELS.values()) - {"kind", "language", "regions"}:
            self.assertEqual(latest[key], stored[key], key)

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
