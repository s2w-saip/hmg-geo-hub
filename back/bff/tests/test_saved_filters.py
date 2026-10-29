"""Saved filters of the renewal screens: the routes end to end through the ASGI app against an in-memory
system.saved_filter (no database). Every account sees and changes only its own rows."""
import os
import time
import unittest
from contextlib import asynccontextmanager
from datetime import timedelta
from unittest import mock
from uuid import UUID, uuid4

try:
    import asyncpg

    from bff.hub_stores import hub_auth
    from bff.hub_stores import saved_filters as sf
    from bff.tests.test_hub_editing import SECRET, T0, Ctx, Pool, call, run
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_saved_filters)") from exc


# ═══ fakes ═══════════════════════════════════════════════════════════════════════════════════════════════

class Store:
    """system.saved_filter (with its one-default-per-account-and-page index) and two signed-in accounts."""

    def __init__(self):
        self.rows, self.locks, self.clock = [], [], 0
        self.accounts = {uid: {"user_id": uid, "subject": name, "email": None, "display_name": None, "status": "active",
                               "password_hash": "scrypt$x", "changed_at": T0, "must_change": False, "role": "admin",
                               "brands": [], "regions": [], "countries": []}
                         for uid, name in ((uuid4(), "admin"), (uuid4(), "other"))}

    def tick(self):
        self.clock += 1
        return T0 + timedelta(seconds=self.clock)

    def mine(self, user, page):
        return sorted((r for r in self.rows if r["user_id"] == user and r["page"] == page), key=lambda r: (r["position"], r["created_at"]))

    def own(self, fid, user):
        return next((r for r in self.rows if r["filter_id"] == fid and r["user_id"] == user), None)


class Conn:
    def __init__(self, store):
        self.s = store

    def transaction(self):
        return Ctx()

    async def execute(self, sql, *args):
        s = self.s
        if sql is sf.LOCK_SQL:
            s.locks.append(args)
        elif sql is sf.SHIFT_SQL:
            user, page, position = args
            for r in s.mine(user, page):
                if r["position"] >= position:
                    r["position"] += 1
        elif sql is sf.CLEAR_DEFAULT_SQL:
            user, page, fid = args
            for r in s.mine(user, page):
                if r["is_default"] and r["filter_id"] != fid:
                    r["is_default"] = False
        elif sql is sf.INSERT_SQL:
            fid, user, page, name, query, default, position = args
            if default and any(r["is_default"] for r in s.mine(user, page)):
                raise asyncpg.UniqueViolationError("saved_filter_default")
            now = s.tick()
            s.rows.append({"filter_id": fid, "user_id": user, "page": page, "name": name, "query": query, "is_default": default,
                           "position": position, "created_at": now, "updated_at": now})
        elif sql is sf.UPDATE_SQL:
            fid, user, name, query, default = args
            r = s.own(fid, user)
            if default and any(x["is_default"] and x is not r for x in s.mine(user, r["page"])):
                raise asyncpg.UniqueViolationError("saved_filter_default")
            r.update(name=name if name is not None else r["name"], query=query if query is not None else r["query"],
                     is_default=default if default is not None else r["is_default"], updated_at=s.tick())
        else:
            raise AssertionError(sql)

    async def fetch(self, sql, *args):
        if sql is sf.LIST_SQL:
            return [dict(r) for r in self.s.mine(*args)]
        raise AssertionError(sql)

    async def fetchrow(self, sql, *args):
        if sql is sf.OWN_SQL:
            r = self.s.own(*args)
            return {"page": r["page"], "position": r["position"]} if r else None
        if sql.startswith("SELECT a.user_id") and "a.user_id=$1" in sql:   # hub_auth.principal
            return dict(self.s.accounts[args[0]]) if args[0] in self.s.accounts else None
        raise AssertionError(sql)

    async def fetchval(self, sql, *args):
        if sql is sf.COUNT_SQL:
            return len(self.s.mine(*args))
        if sql is sf.NEXT_SQL:
            return max((r["position"] for r in self.s.mine(*args)), default=-1) + 1
        if sql is sf.DELETE_SQL:
            r = self.s.own(*args)
            if r is None:
                return None
            self.s.rows.remove(r)
            return r["page"]
        raise AssertionError(sql)


# ═══ routes ══════════════════════════════════════════════════════════════════════════════════════════════

class Routes(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.me, self.other = list(self.store.accounts)

        @asynccontextmanager
        async def reader():
            yield Conn(self.store)

        for p in (mock.patch.dict(os.environ, {"HGH_AUTH_SECRET": SECRET}),
                  mock.patch.object(sf.operations_db, "connection", reader),
                  mock.patch.object(sf, "_pool", Pool(Conn(self.store)))):
            p.start()
            self.addCleanup(p.stop)

    def token(self, user=None):
        user = user or self.me
        return hub_auth.issue(SECRET.encode(), user, hub_auth.credential_version(T0), time.time())[0]

    def save(self, name, query="brand=Kia", page="overview", user=None, **kw):
        status, body = run(call("POST", "/v1/hub/saved-filters", {"page": page, "name": name, "query": query, **kw}, self.token(user)))
        self.assertEqual(status, 201, body)
        return body["data"]

    def listed(self, page="overview", user=None):
        status, body = run(call("GET", f"/v1/hub/saved-filters?page={page}", token=self.token(user)))
        self.assertEqual(status, 200, body)
        return body["data"]["items"]

    def names(self, page="overview", user=None):
        return [(i["name"], i["isDefault"]) for i in self.listed(page, user)]

    def test_every_route_needs_the_login(self):
        fid = str(uuid4())
        for method, path, body in (("GET", "/v1/hub/saved-filters?page=overview", None),
                                   ("POST", "/v1/hub/saved-filters", {"page": "overview", "name": "x", "query": ""}),
                                   ("POST", "/v1/hub/saved-filters/import", {"page": "overview", "items": []}),
                                   ("PATCH", f"/v1/hub/saved-filters/{fid}", {"name": "x"}),
                                   ("DELETE", f"/v1/hub/saved-filters/{fid}", None)):
            for token in (None, "v1.forged.token"):
                status, out = run(call(method, path, body, token))
                self.assertEqual((status, out["error"]["code"]), (401, "unauthorized"), (method, path, token))
        self.assertEqual(self.store.rows, [])

    def test_save_lists_in_order_from_the_operations_store(self):
        first = self.save("독일 전기차", "geography=DE&engine=chatgpt")
        self.assertEqual((first["item"]["name"], first["item"]["query"], first["item"]["isDefault"]),
                         ("독일 전기차", "geography=DE&engine=chatgpt", False))
        self.save("  유럽  ", "geography=DE~FR")
        status, body = run(call("GET", "/v1/hub/saved-filters?page=overview", token=self.token()))
        self.assertEqual(body["meta"], {"source": "hub_operations", "database": "hmg_operations"})
        self.assertEqual([(i["name"], i["query"]) for i in body["data"]["items"]],
                         [("독일 전기차", "geography=DE&engine=chatgpt"), ("유럽", "geography=DE~FR")])
        self.assertEqual(self.listed("mention"), [])
        self.assertTrue(all(lock == (sf.FILTER_LOCK, str(self.me)) for lock in self.store.locks))

    def test_rename_overwrite_and_one_default_per_page(self):
        a = self.save("A")["item"]["id"]
        b = self.save("B", isDefault=True)["item"]["id"]
        self.save("M", page="mention", isDefault=True)
        status, body = run(call("PATCH", f"/v1/hub/saved-filters/{a}", {"isDefault": True}, self.token()))
        self.assertEqual(status, 200, body)
        self.assertEqual([(i["name"], i["isDefault"]) for i in body["data"]["items"]], [("A", True), ("B", False)])
        self.assertEqual(self.names("mention"), [("M", True)])
        status, body = run(call("PATCH", f"/v1/hub/saved-filters/{b}", {"name": "B2", "query": "brand=Hyundai"}, self.token()))
        self.assertEqual((body["data"]["item"]["name"], body["data"]["item"]["query"], body["data"]["item"]["isDefault"]),
                         ("B2", "brand=Hyundai", False))
        run(call("PATCH", f"/v1/hub/saved-filters/{a}", {"isDefault": False}, self.token()))
        self.assertEqual(self.names(), [("A", False), ("B2", False)])
        status, body = run(call("PATCH", f"/v1/hub/saved-filters/{b}", {"query": ""}, self.token()))
        self.assertEqual((status, body["data"]["item"]["query"]), (200, ""))

    def test_a_new_default_takes_over(self):
        self.save("A", isDefault=True)
        self.save("B", isDefault=True)
        self.assertEqual(self.names(), [("A", False), ("B", True)])

    def test_delete_and_undo_back_in_place(self):
        ids = [self.save(n)["item"]["id"] for n in ("A", "B", "C")]
        status, body = run(call("DELETE", f"/v1/hub/saved-filters/{ids[1]}", token=self.token()))
        self.assertEqual((status, [i["name"] for i in body["data"]["items"]]), (200, ["A", "C"]))
        self.save("B", before=ids[2])
        self.assertEqual([n for n, _ in self.names()], ["A", "B", "C"])
        self.save("D", before=str(uuid4()))   # the follower is gone too: at the end
        self.assertEqual([n for n, _ in self.names()], ["A", "B", "C", "D"])
        status, body = run(call("DELETE", f"/v1/hub/saved-filters/{ids[1]}", token=self.token()))
        self.assertEqual((status, body["error"]["code"]), (404, "not_found"))

    def test_another_accounts_filters_are_out_of_reach(self):
        theirs = self.save("theirs", user=self.other, isDefault=True)["item"]["id"]
        self.assertEqual(self.listed(), [])
        for method, body in (("PATCH", {"name": "mine now"}), ("PATCH", {"isDefault": False}), ("DELETE", None)):
            status, out = run(call(method, f"/v1/hub/saved-filters/{theirs}", body, self.token()))
            self.assertEqual((status, out["error"]["code"]), (404, "not_found"), method)
        self.save("before it", before=theirs)   # someone else's id is no anchor
        self.assertEqual(self.names(user=self.other), [("theirs", True)])
        self.assertEqual(self.names(), [("before it", False)])

    def test_invalid_input_is_refused_in_the_envelope(self):
        token, fid = self.token(), self.save("A")["item"]["id"]
        for method, path, body, fields in (
                ("GET", "/v1/hub/saved-filters?page=dashboard", None, ["page"]),
                ("GET", "/v1/hub/saved-filters", None, ["page"]),
                ("POST", "/v1/hub/saved-filters", {"page": "x", "name": "n", "query": ""}, ["page"]),
                ("POST", "/v1/hub/saved-filters", {"page": "overview", "name": "   ", "query": ""}, ["name"]),
                ("POST", "/v1/hub/saved-filters", {"page": "overview", "name": "n" * 41, "query": ""}, ["name"]),
                ("POST", "/v1/hub/saved-filters", {"page": "overview", "name": "a\nb", "query": ""}, ["name"]),
                ("POST", "/v1/hub/saved-filters", {"page": "overview", "name": "n", "query": "q\x00"}, ["query"]),
                ("POST", "/v1/hub/saved-filters", {"page": "overview", "name": "n", "query": "q" * 4001}, ["query"]),
                ("POST", "/v1/hub/saved-filters", {"page": "overview", "name": "n", "query": "", "star": True}, ["star"]),
                ("PATCH", f"/v1/hub/saved-filters/{fid}", {}, ["isDefault", "name", "query"]),
                ("PATCH", f"/v1/hub/saved-filters/{fid}", {"page": "mention"}, ["page"])):
            status, out = run(call(method, path, body, token))
            self.assertEqual((status, out["error"]["code"]), (422, "invalid_value"), (method, path, body))
            self.assertEqual(sorted(out["error"]["details"]["fields"]), fields, body)
        self.assertEqual(self.names(), [("A", False)])

    def test_a_page_keeps_at_most_the_limit(self):
        for n in range(sf.PER_PAGE_MAX):
            self.save(f"f{n}")
        status, body = run(call("POST", "/v1/hub/saved-filters", {"page": "overview", "name": "one more", "query": ""}, self.token()))
        self.assertEqual((status, body["error"]["code"], body["error"]["details"]), (409, "limit", {"limit": sf.PER_PAGE_MAX}))
        self.assertEqual(self.save("other page", page="acr")["item"]["name"], "other page")

    def test_import_moves_a_browser_list_once(self):
        self.save("이미 있음", "brand=Kia")
        legacy = {"page": "overview", "items": [{"name": "이미 있음", "query": "brand=Kia", "isDefault": False},
                                                {"name": "독일", "query": "geography=DE", "isDefault": True},
                                                {"name": "프랑스", "query": "geography=FR", "isDefault": True}]}
        status, body = run(call("POST", "/v1/hub/saved-filters/import", legacy, self.token()))
        self.assertEqual(status, 200, body)
        self.assertEqual((body["data"]["imported"], body["data"]["skipped"]), (2, 1))
        self.assertEqual([(i["name"], i["isDefault"]) for i in body["data"]["items"]], [("이미 있음", False), ("독일", True), ("프랑스", False)])
        status, body = run(call("POST", "/v1/hub/saved-filters/import", legacy, self.token()))
        self.assertEqual((body["data"]["imported"], body["data"]["skipped"], len(body["data"]["items"])), (0, 3, 3))

    def test_import_keeps_an_existing_default_and_the_limit(self):
        self.save("기본", isDefault=True)
        items = [{"name": f"f{n}", "query": f"q={n}", "isDefault": n == 0} for n in range(sf.PER_PAGE_MAX)]
        status, body = run(call("POST", "/v1/hub/saved-filters/import", {"page": "overview", "items": items}, self.token()))
        self.assertEqual((status, body["data"]["imported"], body["data"]["skipped"]), (200, sf.PER_PAGE_MAX - 1, 1))
        self.assertEqual([i["name"] for i in body["data"]["items"] if i["isDefault"]], ["기본"])
        status, body = run(call("POST", "/v1/hub/saved-filters/import", {"page": "overview", "items": items + items[:1]}, self.token()))
        self.assertEqual((status, body["error"]["details"]["fields"]), (422, ["items"]))

    def test_without_the_writer_lists_still_read_and_writes_answer_503(self):
        self.save("A")
        with mock.patch.object(sf, "_pool", None):
            self.assertEqual(self.names(), [("A", False)])
            status, body = run(call("POST", "/v1/hub/saved-filters", {"page": "overview", "name": "B", "query": ""}, self.token()))
            self.assertEqual((status, body["error"]["code"]), (503, "source_unavailable"))

    def test_routes_keep_their_neighbours(self):
        status, body = run(call("PUT", f"/v1/hub/saved-filters/{uuid4()}", {"name": "x"}, self.token()))
        self.assertEqual(status, 405)
        status, body = run(call("PATCH", "/v1/hub/saved-filters/not-a-uuid", {"name": "x"}, self.token()))
        self.assertEqual(status, 422)
        self.assertEqual(UUID(self.save("A")["item"]["id"]).version, 4)


if __name__ == "__main__":
    unittest.main()
