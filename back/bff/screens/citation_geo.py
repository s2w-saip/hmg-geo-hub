"""The cited site's catalog country of a citation URL (port of front/lib/geo-catalog/index.ts
geoEntryForUrl(url)?.country, the drilldown URL country, U7-N9).

Match keys of a URL, most specific first: `host?country=XX` (a `country` query parameter, upper
case), `host/<first path segment>` (lower case), `host`; the host is lower case without `www.`.
The first key the catalog maps to a single country wins (citation_geo_data.URL_KEY_COUNTRY).

`url_keys` follows the WHATWG URL parser (the browser's `new URL`) as far as these keys see it:
leading/trailing C0 controls and spaces stripped, tab/newline removed, special schemes take `\\` as
`/` and any number of slashes before the authority, userinfo and port dropped, the host percent-
decoded and lower cased (non-ASCII: NFKC then punycode), the path percent-encoded with dot segments
resolved, the query decoded as application/x-www-form-urlencoded. A string `new URL` refuses
(no scheme, empty or forbidden host) has no keys.
"""
from __future__ import annotations

import re
import unicodedata
from urllib.parse import parse_qsl, unquote

from bff.screens.citation_geo_data import URL_KEY_COUNTRY

_SCHEME = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*):(.*)", re.S)
_SPECIAL = {"http", "https", "ws", "wss", "ftp"}
_FORBIDDEN_HOST = set("\x00\t\n\r #/:<>?@[\\]^|%")
# WHATWG path percent-encode set (beyond C0 controls and non-ASCII).
_PATH_ENCODE = set(' "#<>?`{}')
_DOT = {".", "%2e"}
_DOTDOT = {"..", ".%2e", "%2e.", "%2e%2e"}


def _encode_path_segment(seg: str) -> str:
    out = []
    for ch in seg:
        o = ord(ch)
        if o < 0x20 or o == 0x7F or o > 0x7E or ch in _PATH_ENCODE:
            out.extend(f"%{b:02X}" for b in ch.encode("utf-8", "surrogatepass"))
        else:
            out.append(ch)
    return "".join(out)


def _host(raw: str) -> str | None:
    if raw.startswith("["):
        return raw.lower() if raw.endswith("]") else None
    try:
        host = unquote(raw, errors="strict") if "%" in raw else raw
    except UnicodeDecodeError:
        return None
    if any(ch in _FORBIDDEN_HOST or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in host):
        return None
    if not host.isascii():
        host = unicodedata.normalize("NFKC", host).lower()
        if not host.isascii():
            try:
                host = ".".join(label if label.isascii() else "xn--" + label.encode("punycode").decode("ascii")
                                for label in host.split("."))
            except UnicodeError:
                return None
    host = host.lower()
    return host or None


def _parse(url: str) -> tuple[str, str, str] | None:
    """(hostname, pathname, query) as `new URL(url)` gives them, or None when it throws."""
    s = url.strip("".join(chr(c) for c in range(0x21)))
    s = re.sub(r"[\t\n\r]", "", s)
    m = _SCHEME.fullmatch(s)
    if not m:
        return None
    scheme, rest = m[1].lower(), m[2]
    rest = rest.split("#", 1)[0]
    if scheme in _SPECIAL:
        rest = rest.replace("\\", "/").lstrip("/")
        end = min((i for i in (rest.find("/"), rest.find("?")) if i >= 0), default=len(rest))
        authority, rest = rest[:end], rest[end:]
        authority = authority.rsplit("@", 1)[-1]
        if authority.startswith("["):
            host_raw = authority[: authority.find("]") + 1] if "]" in authority else authority
        else:
            host_raw = authority.split(":", 1)[0]
        hostname = _host(host_raw)
        if hostname is None:
            return None
    elif scheme == "file":
        rest = rest.replace("\\", "/")
        if rest.startswith("//"):
            rest = rest[2:]
            end = min((i for i in (rest.find("/"), rest.find("?")) if i >= 0), default=len(rest))
            host_raw, rest = rest[:end], rest[end:]
            hostname = _host(host_raw) if host_raw else ""
            if hostname is None:
                return None
            hostname = "" if hostname == "localhost" else hostname
        else:
            hostname = ""
    else:
        if rest.startswith("//"):
            rest = rest[2:]
            end = min((i for i in (rest.find("/"), rest.find("?")) if i >= 0), default=len(rest))
            authority, rest = rest[:end], rest[end:]
            host_raw = authority.rsplit("@", 1)[-1].split(":", 1)[0]
            hostname = host_raw.lower() if host_raw else ""
        else:
            hostname = ""
    path, _, query = rest.partition("?")
    special = scheme in _SPECIAL or scheme == "file"
    if special or path.startswith("/"):
        segs: list[str] = []
        parts = path.split("/")[1:] if path.startswith("/") else path.split("/")
        for i, seg in enumerate(parts):
            low = seg.lower()
            last = i == len(parts) - 1
            if low in _DOTDOT:
                if segs:
                    segs.pop()
                if last:
                    segs.append("")
            elif low in _DOT:
                if last:
                    segs.append("")
            else:
                segs.append(_encode_path_segment(seg))
        pathname = "/" + "/".join(segs)
    else:
        pathname = _encode_path_segment(path)
    return hostname, pathname, query


def url_keys(url: str) -> list[str] | None:
    """lib/geo-catalog urlKeys: the catalog match keys of a URL, most specific first; None = not a URL."""
    parsed = _parse(url)
    if parsed is None:
        return None
    hostname, pathname, query = parsed
    host = re.sub(r"^www\.", "", hostname.lower())
    keys: list[str] = []
    country = next((v for k, v in parse_qsl(query, keep_blank_values=True, errors="replace") if k == "country"), None)
    if country:
        keys.append(f"{host}?country={country.upper()}")
    seg = next((s for s in pathname.split("/") if s), None)
    if seg:
        keys.append(f"{host}/{seg.lower()}")
    keys.append(host)
    return keys


def geo_country_for_url(url: str) -> str | None:
    """geoEntryForUrl(url)?.country ?? null: the catalog country of the cited site, None when unknown."""
    keys = url_keys(url)
    if not keys:
        return None
    for k in keys:
        country = URL_KEY_COUNTRY.get(k)
        if country is not None:
            return country
    return None
