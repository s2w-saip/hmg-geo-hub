"""키워드 정규화·DataForSEO 지역 프리셋(API·적재기 한 벌).

현행 이식: lib/keyword/location-presets.ts LOCATION_LANGUAGE_PRESETS(29개, 순서 포함, 기본 kr), lib/keyword/dataforseo.ts sanitizeKeywords,
lib/keyword/insight.ts 키 정규화(trim·lower). 모듈-고객-관심 §3 "적재기와 한 벌을 공유".

- 정규화 정본은 DB 함수 app.term_norm(text)(DB-v2.7 P55): 추적 키워드 생성 열·rd.dim_keyword.term_norm 쓰기(적재기)·중복 판정·조회가
  전부 그것을 쓴다. 코드에서 정규화 값이 필요하면 db_term_norms(conn, terms)(DB 왕복 1회)로 얻는다(검증 m-5).
- term_norm(파이썬) = NFC → strip → lower 는 표시·미리보기용이다. DB 와 다른 문자가 있다(한계): 'İ'(U+0130) 파이썬 'i̇' 대 DB 'i',
  어말 시그마 'Σ' 파이썬 'ς' 대 DB 'σ'(libc lower). 유일성·중복 판정에 쓰지 않는다.
- sanitize = DataForSEO 가 거부하는 문자 제거(괄호류·쉼표), 줄바꿈 → 공백, 공백 접기, 100자 이상·빈 값은 ''.
- 프리셋 id 는 ISO2 소문자(현행 id). preset_of 는 모르면 422 unknown_country.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from app.core import errors

__all__ = ["DEFAULT_PRESET_ID", "MAX_TERM_LEN", "PRESETS", "PRESET_LANGUAGES", "Preset", "clean_term", "db_term_norms", "preset_by_id",
           "preset_by_location", "preset_of", "sanitize", "sanitize_all", "term_norm"]


@dataclass(frozen=True)
class Preset:
    id: str
    name_ko: str
    name_en: str
    location_code: int
    language_code: str
    region: str


_ROWS: tuple[tuple[str, str, str, int, str, str], ...] = (
    ("us", "미국", "United States", 2840, "en", "North America"), ("ca", "캐나다", "Canada", 2124, "en", "North America"),
    ("mx", "멕시코", "Mexico", 2484, "es", "North America"),
    ("kr", "한국", "South Korea", 2410, "ko", "Asia"), ("jp", "일본", "Japan", 2392, "ja", "Asia"), ("cn", "중국", "China", 2156, "zh-CN", "Asia"),
    ("sg", "싱가포르", "Singapore", 2702, "en", "Asia"), ("hk", "홍콩", "Hong Kong", 2344, "zh-HK", "Asia"),
    ("tw", "대만", "Taiwan", 2158, "zh-TW", "Asia"), ("th", "태국", "Thailand", 2764, "th", "Asia"), ("vn", "베트남", "Vietnam", 2704, "vi", "Asia"),
    ("in", "인도", "India", 2356, "en", "Asia"),
    ("gb", "영국", "United Kingdom", 2826, "en", "Europe"), ("de", "독일", "Germany", 2276, "de", "Europe"),
    ("fr", "프랑스", "France", 2250, "fr", "Europe"), ("it", "이탈리아", "Italy", 2380, "it", "Europe"), ("es", "스페인", "Spain", 2724, "es", "Europe"),
    ("nl", "네덜란드", "Netherlands", 2528, "nl", "Europe"), ("se", "스웨덴", "Sweden", 2752, "sv", "Europe"),
    ("no", "노르웨이", "Norway", 2578, "no", "Europe"), ("dk", "덴마크", "Denmark", 2208, "da", "Europe"), ("fi", "핀란드", "Finland", 2246, "fi", "Europe"),
    ("au", "호주", "Australia", 2036, "en", "Oceania"), ("nz", "뉴질랜드", "New Zealand", 2554, "en", "Oceania"),
    ("br", "브라질", "Brazil", 2076, "pt", "South America"), ("ar", "아르헨티나", "Argentina", 2032, "es", "South America"),
    ("ae", "아랍에미리트", "United Arab Emirates", 2784, "ar", "Middle East"), ("sa", "사우디아라비아", "Saudi Arabia", 2682, "ar", "Middle East"),
    ("za", "남아프리카공화국", "South Africa", 2710, "en", "Africa"),
)
PRESETS: dict[str, Preset] = {r[0]: Preset(*r) for r in _ROWS}          # 삽입 순서 = 현행 표 순서
DEFAULT_PRESET_ID = "kr"
_BY_LOC: dict[int, Preset] = {p.location_code: p for p in PRESETS.values()}
PRESET_LANGUAGES: dict[str, str] = {p.language_code.lower(): p.language_code for p in PRESETS.values()}   # 소문자 → 정본 표기
MAX_TERM_LEN = 200
_STRIP = re.compile(r"[()\[\]{}]")
_WS = re.compile(r"\s+")
_CONTROL = re.compile(r"[\x00-\x1f\x7f\ud800-\udfff]")


def term_norm(term: str) -> str:
    """NFC → trim → lower(표시·미리보기용). 판정·조회 키는 db_term_norms(DB app.term_norm) 를 쓴다."""
    return unicodedata.normalize("NFC", term).strip().lower()


_DB_NORMS_SQL = "SELECT u.t, app.term_norm(u.t) AS n FROM unnest(CAST(:terms AS text[])) AS u(t)"


async def db_term_norms(conn: object, terms: list[str]) -> dict[str, str]:
    """원문 term → DB 정규화 값(app.term_norm, 정본). conn = SQLAlchemy AsyncConnection(api_ro·api_rw 어느 쪽이든)."""
    from app.core.db import fetch_all

    uniq = list(dict.fromkeys(terms))
    if not uniq:
        return {}
    rows = await fetch_all(conn, _DB_NORMS_SQL, {"terms": uniq})  # type: ignore[arg-type]
    return {r["t"]: r["n"] for r in rows}


def sanitize(k: str) -> str:
    """현행 sanitizeKeywords 한 원소: 괄호류·쉼표 제거, 줄바꿈 → 공백, 공백 접기. 100자 이상·빈 값은 ''."""
    s = _WS.sub(" ", _STRIP.sub("", (k or "").strip()).replace(",", "").replace("\n", " ")).strip()
    return s if 0 < len(s) < 100 else ""


def sanitize_all(keywords: list[str]) -> list[str]:
    """sanitize 후 빈 값 제거·중복 제거(첫 등장 순서)."""
    return list(dict.fromkeys(s for s in (sanitize(k) for k in keywords) if s))


def clean_term(raw: str | None, *, field: str = "term", max_len: int = MAX_TERM_LEN) -> str:
    """사용자 입력 검색어 정리(NFC·trim). 빈 값·제어문자·서로게이트·길이 초과는 422."""
    t = unicodedata.normalize("NFC", raw or "").strip()
    if not t:
        raise errors.unprocessable("검색어가 비어 있다", details={"field": field})
    if len(t) > max_len or _CONTROL.search(t):
        raise errors.unprocessable(f"검색어는 제어문자 없이 {max_len}자 이하", details={"field": field})
    return t


def preset_by_id(pid: str | None) -> Preset | None:
    return PRESETS.get((pid or "").strip().lower())


def preset_by_location(code: int | None) -> Preset | None:
    return _BY_LOC.get(code) if code is not None else None


def preset_of(country: str | None, *, field: str = "country") -> Preset:
    """국가(ISO2, 대소문자 무관) → 프리셋. 모르면 422 unknown_country."""
    p = preset_by_id(country)
    if p is None:
        raise errors.unprocessable("지원하지 않는 국가", code="unknown_country", details={"field": field, "value": country})
    return p
