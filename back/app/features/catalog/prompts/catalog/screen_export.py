"""catalog.prompts.catalog 웹사이트 내보내기 화면 모양(columns=screen, BG-35).

현행 파일 = front app/api/website/prompts/export/route.ts:63-98 + lib/website/prompt-export.ts:55-83(buildWebsitePromptSheet).
- 8열(화면 prompt-table.tsx 의 <th> 순서): 프롬프트 · 브랜드 · 국가 · 언어 · 타겟 URL · 측정 횟수 · 최근 측정 · 측정 엔진.
- 머리글·'측정 없음' 문구·시트 이름·파일 이름 = messages/{ko,en}.json website.prompts.*(route.ts:74-86·89·95) 값을 옮긴 LABELS.
- 국가·언어 = 표시명(country-name.ts·language-name.ts: 의사 국가 코드 정본 라벨 → Intl.DisplayNames → 모르면 코드 그대로).
  Intl 결과는 names_data 고정 표(생성물)로 옮겼다(백엔드에 ICU 없음).
- 측정 횟수 = 숫자(0 도 숫자 0, prompt-export.ts:78), 최근 측정 = YYYY-MM-DD 또는 '측정 없음' 문구, 측정 엔진 = 엔진 코드 ', ' 연결.
- 파일 이름 = '<exportFilename>-<KST 오늘>.xlsx'(route.ts:103-111), ASCII 대체 이름 website-prompts-<날짜>.<확장자>.
값(행 집합·정렬·측정 메타)은 api 모양과 같은 조회 결과를 쓴다. 바뀌는 것은 열 모양뿐이다.
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi.responses import StreamingResponse

from app.core.export import CSV_MEDIA, csv_chunks, export_headers, xlsx_response
from app.core.xlsx import SheetSpec, auto_widths
from app.features.catalog.prompts.catalog.names_data import (
    LANGUAGE_ALIASES,
    LANGUAGE_NAMES,
    LANGUAGE_REGION_ALIASES,
    REGION_ALIASES,
    REGION_NAMES,
    SCRIPT_ALIASES,
    SCRIPT_NAMES,
)

KST = ZoneInfo("Asia/Seoul")
DEFAULT_LOCALE = "ko"            # front i18n/routing.ts defaultLocale, route.ts:58-61(모르는 locale 은 기본값)

# messages/{ko,en}.json website.prompts.*(ko.json:112-132, en.json:112-132) 값 그대로
LABELS: dict[str, dict[str, str]] = {
    "ko": {"prompt": "프롬프트", "brand": "브랜드", "country": "국가", "lang": "언어", "target_url": "타겟 URL", "answers": "측정 횟수",
           "last_measured": "최근 측정", "engines": "측정 엔진", "not_measured": "측정 없음",
           "file": "웹사이트-프롬프트", "sheet": "웹사이트 프롬프트"},
    "en": {"prompt": "Prompt", "brand": "Brand", "country": "Country", "lang": "Language", "target_url": "Target URL",
           "answers": "Measurements", "last_measured": "Last measured", "engines": "Engines", "not_measured": "Not measured",
           "file": "website-prompts", "sheet": "Website Prompts"},
}
SCREEN_COLUMNS: tuple[str, ...] = ("prompt", "brand", "country", "lang", "target_url", "answers", "last_measured", "engines")
ASCII_STEM = "website-prompts"

# 의사 국가 코드 정본 라벨(front lib/geo-catalog/pseudo-country.ts:33-54 PSEUDO_COUNTRIES.labels). Intl 이 모르는 코드라 먼저 본다
PSEUDO_COUNTRY_LABELS: dict[str, dict[str, str]] = {
    "SA-Dammam": {"ko": "사우디 아라비아 - 담맘", "en": "Saudi Arabia - Dammam"},
    "SA-Jeddah": {"ko": "사우디 아라비아 - 제다", "en": "Saudi Arabia - Jeddah"},
    "SA-Riyadh": {"ko": "사우디 아라비아 - 리야드", "en": "Saudi Arabia - Riyadh"},
    "CN-BJ": {"ko": "중국-베이징", "en": "China-Beijing"},
}
# Intl 이 받는 언어 태그 모양 중 표·규칙으로 옮긴 범위: 언어(2·3·5~8글자)[-문자 4글자][-지역 2글자|숫자 3자리](소문자 정규화 뒤).
# 변이·확장 하위 태그(en-us-posix 등)는 코드 그대로(README 다른 점 6). Intl 이 거부하는 모양(en_us 등)도 front 처럼 코드 그대로.
_TAG = re.compile(r"^([a-z]{2,3}|[a-z]{5,8})(?:-([a-z]{4}))?(?:-([a-z]{2}|[0-9]{3}))?$")
_REGION = re.compile(r"^(?:[A-Z]{2}|[0-9]{3})$")
# Intl(ICU) 조합 형식: ko '{0}({1})', en '{0} ({1})', 한정어는 ', ' 로 잇는다(ko '중국어(간체, 중국)')
_COMBINE = {"ko": "{0}({1})", "en": "{0} ({1})"}
_BRACKETS = str.maketrans("()", "[]")      # 한정어 이름 안의 괄호는 대괄호로(ko '홍콩(중국 특별행정구)' → '중국어(홍콩[중국 특별행정구])')


def country_name(code: str | None, locale: str) -> str:
    """front countryName(country-name.ts:26-37): 의사 코드 라벨 → Intl region 표시명(대문자 정규화) → 모르면 코드.
    Intl 은 지역 모양(두 글자·숫자 세 자리)이면 모르는 코드를 대문자 코드로 돌려주고, 모양 밖이면 throw 라 front 가 원문을 쓴다."""
    if not code:
        return ""
    pseudo = PSEUDO_COUNTRY_LABELS.get(code.strip())
    if pseudo:
        return pseudo[locale]
    up = code.strip().upper()
    name = REGION_NAMES[locale].get(up)
    if name is not None:
        return name
    return up if _REGION.match(up) else code


def language_name(code: str | None, locale: str) -> str:
    """front languageName(language-name.ts:19-27): 소문자 정규화 → Intl language 표시명 → 모르면 코드.

    Intl 결과를 표 + 조립 규칙으로 옮겼다(생성기 names_gen.mjs 가 규칙과 한 벌이고, 규칙으로 안 맞는 태그만 표에 넣는다).
    1) 표(언어 이름 + 방언 등 규칙 밖 조합) 2) 언어 별칭 펼치기(sh → sr-Latn, 태그의 문자·지역 우선) 3) 문자·지역 별칭
    (언어별 지역 별칭 먼저: hy-SU → AM, 언어+지역 별칭 sgn-US → ase) 4) 한정어가 하나면 정규 태그의 규칙 밖 이름(en-840 → en-us 'American English')
    5) 조립: 언어 이름 + (문자, 지역). 모르는 언어 = 소문자 코드, 모르는 문자 = 'Qaaa' 꼴, 모르는 지역 = 대문자 코드."""
    if not code:
        return ""
    norm = code.strip().lower()
    names = LANGUAGE_NAMES[locale]
    exact = names.get(norm)
    if exact is not None:
        return exact
    m = _TAG.match(norm)
    if not m:
        return code
    lang = m.group(1)
    script = m.group(2).title() if m.group(2) else None
    region = m.group(3).upper() if m.group(3) else None
    alias = LANGUAGE_ALIASES.get(lang)
    if alias:
        lang, *rest = alias.split("-")
        for part in rest:
            if len(part) == 4:
                script = script or part
            else:
                region = region or part
    if script:
        script = SCRIPT_ALIASES.get(script, script)
    if region:
        region = LANGUAGE_REGION_ALIASES.get(f"{lang}-{region}") or REGION_ALIASES.get(region, region)
        swap = LANGUAGE_ALIASES.get(f"{lang}-{region}")        # 언어+지역 별칭(sgn-US → ase): 지역을 소비하고 언어를 바꾼다
        if swap:
            lang, *rest = swap.split("-")
            region = None
            for part in rest:
                if len(part) == 4:
                    script = script or part
                else:
                    region = region or part
    one = f"{lang}-{script.lower()}" if script and not region else f"{lang}-{region.lower()}" if region and not script else None
    if one is not None and one in names:
        return names[one]
    base = names.get(lang, lang)
    quals = ([SCRIPT_NAMES[locale].get(script, script)] if script else []) + ([REGION_NAMES[locale].get(region, region)] if region else [])
    if not quals:
        return base
    return _COMBINE[locale].format(base, ", ".join(q.translate(_BRACKETS) for q in quals))


def screen_cells(row: Mapping[str, Any], locale: str) -> list[Any]:
    """api 모양 행(WebsitePromptRow dump) 하나 → 화면 파일 8칸(prompt-export.ts:72-82 와 같은 순서·값)."""
    lb = LABELS[locale]
    last = row.get("last_measured")
    return [
        row["prompt_text"],
        row["brand_code"],
        country_name(row["country_code"], locale),
        language_name(row["lang_code"], locale),
        row["target_url"],
        int(row.get("answers") or 0),
        last.isoformat() if last is not None else lb["not_measured"],
        ", ".join(row.get("engines") or []),
    ]


def screen_headers(locale: str) -> list[str]:
    lb = LABELS[locale]
    return [lb[c] for c in SCREEN_COLUMNS]


def kst_today() -> str:
    return datetime.now(KST).date().isoformat()


def screen_response(fmt: str, rows: Sequence[Mapping[str, Any]], locale: str, *, truncated: bool) -> StreamingResponse:
    """화면 모양 파일 응답. xlsx = 시트 이름·머리글 굵게·1행 고정·열 너비(최장 + 2, 10~60: xlsx-server.ts:36-43 과 같은 규칙)."""
    lb = LABELS[locale]
    headers = screen_headers(locale)
    cells = [screen_cells(r, locale) for r in rows]
    day = kst_today()
    if fmt == "csv":
        filename = f"{lb['file']}-{day}.csv"
        body = csv_chunks(list(SCREEN_COLUMNS), (dict(zip(SCREEN_COLUMNS, c, strict=True)) for c in cells), labels=headers)
        return StreamingResponse(body, media_type=CSV_MEDIA,
                                 headers=export_headers(filename, truncated=truncated, ascii_fallback=f"{ASCII_STEM}-{day}.csv"))
    widths = auto_widths(headers, cells, sample=len(cells) or 1)
    spec = SheetSpec(lb["sheet"], headers, cells, widths)
    return xlsx_response([spec], filename=f"{lb['file']}-{day}.xlsx", truncated=truncated, ascii_fallback=f"{ASCII_STEM}-{day}.xlsx")
