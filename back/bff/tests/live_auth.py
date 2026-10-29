"""The HUB session of the live checks (2026-10-29): every BFF route but /healthz and the login needs one.
HGH_TEST_TOKEN, else HGH_TEST_LOGIN + HGH_TEST_PASSWORD signed in once. Use an administrator: the checks read
every scope."""
import json
import os
from urllib.request import Request

_tokens: dict[str, str] = {}


def token(base: str) -> str | None:
    if os.environ.get("HGH_TEST_TOKEN"):
        return os.environ["HGH_TEST_TOKEN"]
    login, password = os.environ.get("HGH_TEST_LOGIN"), os.environ.get("HGH_TEST_PASSWORD")
    if not (login and password):
        return None
    if base not in _tokens:
        from urllib.request import urlopen
        body = json.dumps({"login": login, "password": password}).encode()
        with urlopen(Request(base + "/v1/auth/login", data=body, headers={"Content-Type": "application/json"}), timeout=15) as r:
            _tokens[base] = json.load(r)["data"]["token"]
    return _tokens[base]


def request(base: str, route: str, method: str = "GET") -> Request:
    t = token(base)
    return Request(base + route, method=method, headers={"Authorization": f"Bearer {t}"} if t else {})


SKIP = "Set HGH_TEST_TOKEN or HGH_TEST_LOGIN + HGH_TEST_PASSWORD (an administrator) for the live checks"
