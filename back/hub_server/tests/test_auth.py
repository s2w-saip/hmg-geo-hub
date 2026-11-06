"""Login and the login token, on the hub server: password and token rules, sign-in end to end through the app against an in-memory account."""
import json
import os
import unittest
from contextlib import asynccontextmanager
from datetime import timedelta
from unittest import mock
from uuid import uuid4

from hub_server import accounts as hub_server_accounts
from hub_server import auth as hub_auth
from hub_server import passwords
from hub_server.tests.util import SECRET, T0, call, run


class Accounts:
    """system.user_account + user_credential + global_role for one account."""

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
        yield C()


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


class SignIn(unittest.TestCase):
    def setUp(self):
        self.accounts = Accounts()
        hub_auth.limiter.failures.clear()
        for p in (mock.patch.dict(os.environ, {"HGH_AUTH_SECRET": SECRET}),
                  mock.patch.object(hub_auth.operations_db, "connection", self.accounts.connection),
                  mock.patch.object(hub_server_accounts, "signed_in", mock.AsyncMock())):
            p.start()
            self.addCleanup(p.stop)

    def login(self, password="correct horse battery"):
        return run(call("POST", "/v1/auth/login", {"login": "admin", "password": password}))

    def token(self):
        status, body = self.login()
        self.assertEqual(status, 200, body)
        return body["data"]["token"]

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

if __name__ == "__main__":
    unittest.main()
