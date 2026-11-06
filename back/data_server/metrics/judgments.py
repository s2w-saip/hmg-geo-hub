"""판정: 어떤 답변을 세는가, 어느 브랜드가 경쟁사인가. These rules live here and nowhere else (CLAUDE.md 1절): a read asks for them, never for
a flag upstream worked out. A rule is SQL over the columns an adapter names (AnswerColumns), so an adapter on the OBT uses the same rule.

The rules are legacy's (back/ingest/project/apply/queries.py, _ig_ans). Checked against upstream's flags on every round of the gold_db, the three
surfaces, 2026-11-06: eligible, citation monitoring, monitoring and the analysis gap differ on no answer.

Inputs, not judgments: the extraction (mentions, positions, sentiment, citations, analysis_state) and a brand row's own_bit, the analysis's 자사 분류
(SSOT input-contract); which of those brands are 당사 is the perspective's, in the read. The representative answer's rule is formulas.representative;
the reads keep is_rep until the KPI-by-KPI check (five old rounds differ, decision 2026-11-06)."""
from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

#: before this, a Korean prompt measured outside Korea is left out (legacy lib/scope/region-tagging.ts REGION_TAGGING_CUTOFF_ISO)
REGION_TAGGING_CUTOFF = "2026-08-19 00:00:00+00"

#: 비경쟁 사전: real companies and common words the extraction tags as brands (legacy front/lib/scope/non-competitor-brands.ts, by lower-cased name).
#: They leave the ranks and the denominators.
NON_COMPETITOR_BRANDS = frozenset((
    '/drive', 'a-premium', 'across', 'acsi', 'advanced', 'alcantara', 'alliance', 'amazon prime', 'app store', 'apple', 'arka',
    'australia', 'automotive manufacturer', 'automotive repair shop', 'bank', 'bolt', 'canada', 'century', 'charger', 'china', 'city',
    'clever', 'comp cams', 'contact', 'credit union', 'crown', 'cruise', 'dealership', 'destination mazda', 'digit insurance',
    'dollar rent a car', 'drift', 'dual electronics', 'edge', 'element', 'ergo', 'españa', 'ethos car care', 'event tires',
    'evs tuning', 'fahren', 'falcon', 'fastback', 'fila', 'fit', 'five', 'flat', 'focus', 'form lighting', 'game',
    'german automotive industry', 'german luxury car brands', 'germany', 'global pet foods', 'golf', 'google', 'gran turismo',
    'gravity', 'green filter', 'guest', 'impact', 'index', 'integra', 'international', 'is', 'italian automotive brands', 'jd power',
    'king george/kingsway dealership', 'kobalt', 'legacy', 'lightning', 'link ecu', 'local dealership', 'march performance', "mark's",
    'mass', 'maximum', 'microsoft surface', 'miles', 'mobile.de', 'modern', 'more than', 'motion', 'motor trend', 'one', 'option',
    'original equipment manufacturer', 'pace american', 'particular', 'peak', 'pilot', 'plus', 'point s', 'power performance',
    'powerful', 'punch', 'race', 'reach', 'real', 'record', 'reliance', 'retailer', 'rise', 'samsung', 'security', 'sharp', 'silence',
    'smart', 'specialist', 'specialized', 'stack', 'stance wheels', 'status', 'sure', 'target', 'third party', 'torque', 'transit',
    'urban', 'usa', 'vanguard', 'victory', 'vision', 'volt', 'wahl', 'wedge performance', 'western motorsports', 'winners', 'wise',
    '고가 브랜드', '국내 배터리 제조사', '국토교통부', '대만 모터사이클 산업', '독3사', '독립 정비소', '독일 자동차 브랜드', '레카로', '말레이시아', '보배드림', '사설 정비소', '삼성전자', '세나',
    '순정부품', '아우디 공식 딜러', '온라인샵', '요코하마', '일본 럭셔리 자동차 브랜드', '자동차 동호회', '자동차리콜센터', '저가 브랜드', '중고차 플랫폼', '차지비', '카센터', '카카오', '캐피탈사',
    '테인', '파파존스', '프랑스 자동차 제조사',
))

#: Names that are noise as a bare word and a real brand in a longer product name ("Smart" against "Smart Fortwo"): judged per mention. A source whose
#: brand rows are already split by that judgement keeps the split (the gold_db's competitive).
BARE_ONLY_NON_COMPETITORS = frozenset((
    'bolt', 'century', 'charger', 'city', 'crown', 'cruise', 'dual electronics', 'edge', 'element', 'falcon', 'fastback', 'fit',
    'focus', 'golf', 'gravity', 'integra', 'international', 'is', 'legacy', 'lightning', 'one', 'pilot', 'punch', 'smart', 'transit',
    'vision', 'volt',
))


@dataclass(frozen=True)
class AnswerColumns:
    """An answer's inputs, as SQL on the adapter's row."""
    run_finished: str
    region: str
    measured_at: str
    in_standard_catalog: str
    is_korean: str
    prompt_regions: str
    market_hidden: str
    is_acr: str
    acr_iteration: str
    analysis_state: str
    representative: str


def eligible(c: AnswerColumns, *, is_global: bool) -> str:
    """집계 자격: a finished run; on global also a prompt of the standard catalog in a market not hidden, measured where the prompt is meant for."""
    if not is_global:
        return f"({c.run_finished})"
    no_regions = f"({c.prompt_regions} IS NULL OR cardinality({c.prompt_regions})=0)"
    korean_abroad = (f"({c.region}<>'KR' AND {c.is_korean} AND ({c.measured_at} IS NULL "
                     f"OR {c.measured_at}<TIMESTAMPTZ '{REGION_TAGGING_CUTOFF}' OR {no_regions}))")
    return (f"({c.run_finished} AND {c.in_standard_catalog} AND NOT {c.market_hidden} AND coalesce(NOT {korean_abroad},false) "
            f"AND ({no_regions} OR coalesce({c.region}=ANY({c.prompt_regions}),false)))")


def later_iteration(c: AnswerColumns) -> str:
    """ACR 측정의 뒤 반복: a cell counts its first iteration."""
    return f"({c.is_acr} AND coalesce({c.acr_iteration},0)>1)"


def citation_monitoring(c: AnswerColumns, *, is_global: bool) -> str:
    return f"({eligible(c, is_global=is_global)} AND NOT {later_iteration(c)})"


def monitoring(c: AnswerColumns, *, is_global: bool) -> str:
    return f"({citation_monitoring(c, is_global=is_global)} AND {c.analysis_state}<2)"


def older_acr_run(c: AnswerColumns, *, is_global: bool) -> str:
    """셀마다 1건: a cell measured again in a round counts its representative run, in every population."""
    return f"({c.is_acr} AND {citation_monitoring(c, is_global=is_global)} AND NOT {c.representative})"


def analysis_gap(state: int | None) -> bool:
    """분석 갭: the answer has no analysis (an answer the analysis found nothing in has one)."""
    return (state or 0) >= 2


def normal_url(value: str | None) -> str:
    """A URL as registered URLs are compared: lower case, no scheme, no leading www., no trailing slash."""
    v = (value or "").strip().lower()
    for scheme in ("https://", "http://"):
        v = v.removeprefix(scheme)
    return v.removeprefix("www.").rstrip("/")


def normal_url_sql(value: str) -> str:
    """normal_url in SQL."""
    return f"rtrim(regexp_replace(lower(btrim({value})),'^(https?://)?(www\\.)?',''),'/')"


def registered_urls(owned_urls: Iterable[str] | None, web_units: Iterable[Mapping[str, Any]] | None) -> set[str]:
    """자사 URL (decisions 2026-11-06, '자사 url로 등록했으면 자사인거야', '등록한 URL을 오리진으로 하는 모든 URL은 자사'): the origins of a site's 소유 URL
    and its units' 대표 주소. Every page of such an origin counts; a subdomain is another origin and counts only when it is registered itself."""
    values = [*(owned_urls or []), *(unit.get("base") for unit in web_units or [])]
    return {url.split("/", 1)[0] for url in map(normal_url, values) if url}


def is_registered(url: str | None, registered: Iterable[str]) -> bool:
    """The rule on one URL, which gold_judged.own_url runs in SQL over a site's rows."""
    u = normal_url(url)
    return any(u == r or u.startswith(r + "/") for r in registered)


def tracked_urls(values: Iterable[str] | None) -> set[str]:
    """타겟 URL (추적 URL, 2026-11-07, D-25와 같은 시점): the project's 추적 URL as entered, each the address and what is under it. Unlike 자사 URL it stays the path it names."""
    return {url for url in map(normal_url, values or []) if url}


def is_target(url: str | None, *, prompt_target: str | None, tracked: Iterable[str] = ()) -> bool:
    """타겟 URL 인용 on one URL, which gold_judged.target_url and silver_obt._target run in SQL: the URL the prompt names (website, the SSOT's '그 프롬프트에 지정한 타겟 URL'),
    or a project's 추적 URL."""
    u = normal_url(url)
    return bool(u) and (u == normal_url(prompt_target) or any(u == r or u.startswith(r + "/") for r in tracked))


def excluded_from_ranks(name: str | None, *, is_own: bool, excluded: Collection[str]) -> bool:
    """엔티티 명부 '제외' (legacy lib/scope/excluded-brands.ts, 2026-09-30 HMG QA): out of the brand ranks, the lists and the competitor pick, never out
    of a KPI or its denominator, and 당사's own rows never leave."""
    return not is_own and bool(name) and name in excluded
