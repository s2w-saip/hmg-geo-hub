"""What the hub server sends for a signed-in account: the internal token, for routes tested on the data server alone. Signing in itself is tested
on the hub server (hub_server/tests)."""
import time
from uuid import uuid4

from shared import internal_token
from shared.account import Principal

SECRET = "s" * 40


def token_for(user_id=None, role="admin", brands=(), regions=(), countries=()) -> str:
    who = Principal(user_id or uuid4(), "", None, None, role, tuple(brands), tuple(regions), tuple(countries))
    return internal_token.sign(SECRET.encode(), who, time.time())


class Tables:
    """The accounts a test signs in as, and the names its history shows."""

    def __init__(self):
        self.accounts, self.roles = {}, {}

    def add(self, login, role="admin", brands=(), regions=(), countries=()):
        uid = uuid4()
        self.accounts[uid] = {"subject": login, "display_name": None}
        self.roles[uid] = {"role": role, "brands": list(brands), "regions": list(regions), "countries": list(countries)}
        return uid


class Conn:
    """The operations store of a data server test: the names of accounts (catalog_editor.actors)."""

    def __init__(self, t):
        self.t = t

    async def fetch(self, sql, ids):
        return [{"user_id": u, "subject": a["subject"], "display_name": a["display_name"]} for u, a in self.t.accounts.items() if u in ids]


def sign_in(t: Tables, login: str):
    uid = next(u for u, a in t.accounts.items() if a["subject"] == login)
    return 200, {"data": {"token": token_for(uid, **t.roles[uid])}}
