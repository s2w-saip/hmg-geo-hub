"""analytics.mentions.brands 업무 규칙(M-1). 공통 술어·지표 식은 app.core.measure 를 쓴다(모듈별 재구현 금지).

조립(QUERY-FIXES M-1, parity runner f03 과 같은 모집단)
1) 당사 합계: fetch_counts(parts=mentions) → 답변 수·전체 언급·당사 노출·당사 언급·순위 합(rd.answer 당사 열, G-03).
2) 경쟁 행: brand_rows → competitive ∧ std_in ∧ NOT (own_bit = ANY(관점 비트)). 형제 HMG 브랜드는 경쟁 행에 남는다. brand_key 0(이름 없음) 제외.
3) 당사 감성 4계열: rd.answer_brand 당사 행 합(own_sentiment_sql).
4) 순위: 당사 1행 + 전체 경쟁 행을 언급 수 내림차순·이름 localeCompare 순으로 앱에서 매긴다(core.measure.rank_brand_items, SQL LIMIT 금지).
5) 선택: brand_key[]·q(이름 부분 일치)로 경쟁 행을 한정한 뒤 sort 기준 상위 top_n(full = 전량, 상한 FULL_CAP). 당사 행은 항상 포함.

값 갭 보강(BG 라운드, 전부 선택 인자: 주지 않으면 1)~5) 결과·모양이 그대로다)
- split_own(D13): 관점 비트가 둘 이상이면 당사 행을 core.measure.split_own_scopes(trend 와 공용 판정, common.own_splits)로 가른다.
  가른 행 = 그 비트만 관점으로 둔 당사 열·감성(비트별 GROUP BY), 행 키 own_brand_code = 그 비트의 부모 브랜드 코드(trend 와 같다).
  당사 합계는 관점 전체 + 비트별을 rd.answer 한 번 스캔(own_counts_sql, 비트마다 FILTER)으로 센다(검증 D7, 엔진별도 한 번).
  관점 비트가 하나면 가르지 않는다(합친 1행, own_brand_code 없음). 순위·brand_count 는 가른 행 + 경쟁 행 기준, own 블록은 합친 관점 그대로.
- include: prompts·multi(당사 = rd.answer 당사 열 own_extras_sql, 경쟁 = rd.answer_brand brand_extras_sql), types(rd.answer_brand t_*,
  당사 = 관점 비트 경쟁 행 합, types_total = 당사 + 전 경쟁 행 합), hmg(rd.dim_brand_name.own_bit ≠ 0, 당사 행은 참).
- group_by=engine(BG-16): 1)~3)을 engine 으로 묶어 엔진마다 같은 순위·선택 규칙. 엔진 = 창 안 std_in 답변이 있는 엔진(필터 없으면
  기본 엔진). 답변 0 엔진 블록은 내지 않는다(검증 D4).

명부 제외(동기화 S1 BE-5, 현행 hmg-geo 2670a16 lib/scope/excluded-brands.ts, 원천·키 = core.entities)
- 경쟁 행 중 제외 키(core.entities.excluded_brand_keys) 행은 순위·선택(brands·by_engine[].brands) 전에 뺀다: 순위(rank·own.rank)는
  남은 행으로 다시 매기고 top_n·full 선택은 다음 순위로 채운다(현행 filterMentionsLive·filterCompetitorValues·filterAggregatesBrands·
  filterEngineKpiTrend: Overview 경쟁사 4개·KPI #16 SOV 1위 경쟁사·엔진×브랜드 스냅샷이 거른 목록에서 고른다). 당사(관점) 행은
  경쟁 행에 없으므로 빠지지 않는다(현행 isTracked 보호).
- 값은 그대로: totals.answers·mentions_total(rd.answer 원천), 각 행 값, own 블록 값, types_total(전 경쟁 행 합, 현행 typesByBrand.totals
  "top-N 컷 이전 전 브랜드 합"), totals.brand_count(제외 행 포함 = 현행 summary.uniqueBrands 불변).
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from app.core.cycles import Window
from app.core.db import fetch_all, fetch_one
from app.core.entities import excluded_brand_keys, keep
from app.core.envelope import rank_avg_or_none, ratio
from app.core.filters import ReadContext
from app.core.measure import MeasureScope, brand_rows, fetch_counts, frozen_brand_names, rank_brand_items
from app.features.analytics.mentions.brands.common import OwnSplit, own_splits, runnable, viewpoint_label
from app.features.analytics.mentions.brands.queries import (
    OWN_COUNT_KEYS,
    TYPE_COLS,
    brand_extras_sql,
    brand_names_sql,
    own_counts_sql,
    own_extras_sql,
    own_sentiment_sql,
)
from app.features.analytics.mentions.brands.schemas import (
    FULL_CAP,
    BrandItem,
    BrandsData,
    EngineBrands,
    Multi,
    OwnBlock,
    Sentiment,
    SortKey,
    Totals,
    TypeCounts,
)

_ZERO_COUNTS = {"answers": 0, "tracked": 0, "own_mentions": 0, "total_mentions": 0, "rank_sum": 0, "ranked": 0}
_ZERO_SENT = {"s_pos": 0, "s_neu": 0, "s_neg": 0, "s_mix": 0}
_SENT_KEYS = tuple(_ZERO_SENT)


def _sentiment(r: dict[str, Any]) -> Sentiment:
    return Sentiment(positive=int(r["s_pos"] or 0), neutral=int(r["s_neu"] or 0), mixed=int(r["s_mix"] or 0),
                     negative=int(r["s_neg"] or 0))


def _avg_value(i: dict[str, Any]) -> float | None:
    return i["rank_sum"] / i["ranked"] if i["ranked"] else None


def select_items(ranked: list[dict[str, Any]], *, top_n: int, sort: SortKey, only_keys: set[int] | None,
                 q: str | None = None, full: bool = False) -> tuple[list[dict[str, Any]], bool]:
    """순위가 매겨진 전체 행에서 응답 행을 고른다. 당사 행(가른 행 포함)은 항상, 경쟁 행은 brand_key·이름(q, 대소문자 무시 부분 일치)
    한정 후 sort 기준 상위 top_n(full = 전량, 상한 FULL_CAP). 반환 = (행, full 상한으로 잘렸는가).
    sort = mentions·share(분모 공유라 같은 순서) → rank 오름차순, avg_rank → 평균 순위 오름차순(순위 없음은 뒤), 동률은 rank."""
    def key(i: dict[str, Any]) -> tuple[Any, ...]:
        if sort == "avg_rank":
            v = _avg_value(i)
            return (v is None, v if v is not None else 0.0, i["rank"])
        return (i["rank"],)

    needle = q.casefold() if q else None
    comps = [i for i in ranked if not i["is_own"] and (only_keys is None or i["brand_key"] in only_keys)
             and (needle is None or needle in str(i["name"]).casefold())]
    cap = FULL_CAP if full else top_n
    picked = sorted(comps, key=key)[:cap]
    own = [i for i in ranked if i["is_own"]]
    return sorted(own + picked, key=key), full and len(comps) > FULL_CAP


# 현행 집계층 브랜드 축 상한(hmg-geo 2670a16 lib/db/repositories/summary-trend-aggregates.ts:353 DEFAULT_LIMITS.brand = 200)
CARD_BRAND_CAP = 200


def _card_kept(ms: MeasureScope, comp_items: list[dict[str, Any]], n_own: int) -> set[int] | None:
    """현행 프로필 card_brand_cap(WU-12): 카드 경로(ms.card) 경쟁 행 중 집계층 브랜드 축 상위 200행 안에 드는 키. 꺼짐·비카드 = None(절단 없음).
    현행: summary_trend_brands 의 (brand_name) 축을 row_number() OVER (ORDER BY mentions DESC, brand_name) <= 200 으로 자른다
    (summary-trend-aggregates.ts:1014-1022, 당사 행도 같은 축의 행). 명부 제외는 그 뒤 캐시 밖에서 건다(withExcludedBrands,
    excluded-brands.ts filterAggregatesBrands) → 절단 모집단 = 제외 전 경쟁 행 + 당사 행 n_own 개. 당사 행은 언급 상위라 늘 200 안에
    든다고 보고(현행 화면의 자사 언급 수는 경쟁 꼬리보다 크다) 경쟁 몫 = 200 − n_own. 동률 순서 = rank_brand_items(이름 localeCompare)."""
    if not (ms.card and ms.profile.card_brand_cap):
        return None
    ranked = rank_brand_items([dict(i) for i in comp_items])
    return {int(i["brand_key"]) for i in ranked[:max(CARD_BRAND_CAP - n_own, 0)]}


def _shown(comp_items: list[dict[str, Any]], excluded: frozenset[int], kept: set[int] | None = None) -> list[dict[str, Any]]:
    """순위·선택 모집단 = 명부 제외 키가 아닌 경쟁 행(core.entities.keep). 경쟁 행은 관점 비트 밖이라 자사 보호는 구조로 성립한다.
    kept(card_brand_cap) = 카드 경로 집계층 상위 200 안의 키(_card_kept). None 이면 절단 없음."""
    if kept is not None:
        comp_items = [i for i in comp_items if int(i["brand_key"]) in kept]
    if not excluded:
        return comp_items
    return [i for i in comp_items if keep(i["brand_key"], is_own=bool(i["is_own"]), excluded=excluded)]


def _own_item(tot: dict[str, Any], sent: dict[str, Any], *, name: str, brand_key: int | None,
              code: str | None = None, bits: tuple[int, ...] = ()) -> dict[str, Any]:
    return {"brand_key": brand_key, "name": name, "is_own": True, "mentions": int(tot["own_mentions"]), "exposed": int(tot["tracked"]),
            "rank_sum": int(tot["rank_sum"]), "ranked": int(tot["ranked"]), "sent": sent, "own_brand_code": code, "bits": bits}


def _comp_item(r: dict[str, Any], names: dict[int, str]) -> dict[str, Any]:
    k = int(r["brand_key"])
    return {"brand_key": k, "name": r.get("frz_name") or names.get(k, str(k)), "is_own": False, "mentions": int(r["mentions"] or 0),
            "exposed": int(r["exposure_answers"] or 0), "rank_sum": int(r["rank_sum"] or 0), "ranked": int(r["ranked"] or 0),
            "sent": r, "own_brand_code": None, "bits": ()}


def _unpack_own_counts(r: dict[str, Any] | None, n: int) -> list[dict[str, int]]:
    """own_counts_sql 한 행 → [관점 전체, 비트1, 비트2, ...] 합계 dict(fetch_counts parts=mentions 와 같은 키)."""
    r = r or {}
    shared = {"answers": int(r.get("answers") or 0), "total_mentions": int(r.get("total_mentions") or 0)}
    return [{**shared, **{k: int(r.get(f"{k}{i}") or 0) for k in OWN_COUNT_KEYS}} for i in range(n)]


async def _split_counts(conn: Any, ms: MeasureScope, win: Window, splits: list[OwnSplit], *,
                        by_engine: bool = False) -> dict[int | None, list[dict[str, int]]]:
    """split_own 당사 합계를 rd.answer 한 번 스캔으로(검증 D7). 반환 = 그룹 키(엔진 키, 전체면 None) → [관점 전체, 가른 비트 순서]."""
    groups = [tuple(sorted(ms.own_bits))] + [(sp.bit,) for sp in splits]
    q = own_counts_sql(ms, win, groups, by_engine=by_engine)
    rows = await fetch_all(conn, q.text, q.params)
    if not by_engine:
        return {None: _unpack_own_counts(rows[0] if rows else None, len(groups))}
    return {int(r["engine_key"]): _unpack_own_counts(r, len(groups)) for r in rows}


def _sum_sent(rows: list[dict[str, Any]]) -> dict[str, int]:
    return {k: sum(int(r[k] or 0) for r in rows) for k in _SENT_KEYS}


class _Extras:
    """include 보강 값(당사 묶음·경쟁 브랜드별). 요청하지 않은 부분은 None 으로 남아 응답에서 빠진다."""

    def __init__(self, include: set[str]):
        self.include = include
        self.comp: dict[int, dict[str, Any]] = {}              # brand_key → brand_extras 행
        self.own_types: dict[int, dict[str, int]] = {}         # 당사 비트 → 유형 합
        self.own_counts: dict[tuple[int, ...], dict[str, int]] = {}   # 당사 비트 묶음 → prompts·multi
        self.hmg: dict[int, bool] = {}

    def types_for_bits(self, bits: tuple[int, ...]) -> TypeCounts:
        return TypeCounts(**{t: sum(self.own_types.get(b, {}).get(t, 0) for b in bits) for t in TYPE_COLS})

    def apply(self, item: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if item["is_own"]:
            oc = self.own_counts.get(item["bits"], {"p": 0, "ma": 0, "mm": 0, "mp": 0})
            if "prompts" in self.include:
                out["prompts"] = oc["p"]
            if "multi" in self.include:
                out["multi"] = Multi(mentions=oc["mm"], answers=oc["ma"], prompts=oc["mp"])
            if "types" in self.include:
                out["types"] = self.types_for_bits(item["bits"])
            if "hmg" in self.include:
                out["is_hmg_own"] = True
            return out
        r = self.comp.get(int(item["brand_key"]), {})
        if "prompts" in self.include:
            out["prompts"] = int(r.get("prompts") or 0)
        if "multi" in self.include:
            out["multi"] = Multi(mentions=int(r.get("multi_mentions") or 0), answers=int(r.get("multi_answers") or 0),
                                 prompts=int(r.get("multi_prompts") or 0))
        if "types" in self.include:
            out["types"] = TypeCounts(**{t: int(r.get(t) or 0) for t in TYPE_COLS})
        if "hmg" in self.include:
            out["is_hmg_own"] = self.hmg.get(int(item["brand_key"]), False)
        return out


def _to_item(i: dict[str, Any], answers: int, mentions_total: int, extras: _Extras | None) -> BrandItem:
    add = extras.apply(i) if extras is not None else {}
    return BrandItem(brand_key=i["brand_key"], name=i["name"], is_own=i["is_own"], rank=i["rank"], mentions=i["mentions"],
                     exposure=ratio(i["exposed"], answers), share=ratio(i["mentions"], mentions_total),
                     avg_rank=rank_avg_or_none(i["rank_sum"], i["ranked"]), sentiment=_sentiment(i["sent"]),
                     own_brand_code=i["own_brand_code"], **add)


async def _names(conn: Any, keys: list[int], lookup: list[str]) -> tuple[dict[int, str], dict[str, int], dict[int, bool]]:
    """brand_key → 표시명, 이름 → brand_key(당사 코드 조회), brand_key → HMG 여부(own_bit ≠ 0)."""
    names: dict[int, str] = {}
    by_name: dict[str, int] = {}
    hmg: dict[int, bool] = {}
    if keys or lookup:
        q = brand_names_sql(keys, lookup)
        for r in await fetch_all(conn, q.text, q.params):
            k = int(r["brand_key"])
            names[k] = r["name"]
            by_name[r["name"]] = k
            hmg[k] = int(r["own_bit"] or 0) != 0
    return names, by_name, hmg


async def mention_brands(conn: Any, ctx: ReadContext, win: Window, *, top_n: int, sort: SortKey,
                         brand_keys: list[int] | None, split_own: bool = False, include: list[str] | None = None,
                         group_by: str | None = None, q: str | None = None, full: bool = False) -> BrandsData:
    ms = ctx.measure()
    label = viewpoint_label(ctx)
    run = runnable(win)
    splits: list[OwnSplit] = own_splits(ctx, ms) if split_own else []
    split = bool(splits)
    if run:
        if split:                    # 관점 전체 + 비트별 당사 열을 한 스캔(D7). 비트별 스코프는 own_bits 만 다르다(split_own_scopes)
            tot, *split_tot = (await _split_counts(conn, ms, win, splits))[None]
        else:
            tot, split_tot = (await fetch_counts(conn, ms, win, parts=("mentions",)))[0], []
        comp = await brand_rows(conn, ms, win)
        s = own_sentiment_sql(ms, win, by_bit=split)
        sent_rows = await fetch_all(conn, s.text, s.params)
        own_sent = _sum_sent(sent_rows) if split else (sent_rows[0] if sent_rows else dict(_ZERO_SENT))
    else:
        tot, comp, sent_rows, own_sent = dict(_ZERO_COUNTS), [], [], dict(_ZERO_SENT)
        split_tot = [dict(_ZERO_COUNTS) for _ in splits] if split else []

    comp = [r for r in comp if int(r["brand_key"]) != 0]                       # 0 = 이름 없음(파서 미해석) 행: 현행 F03 과 같이 제외
    excluded = await excluded_brand_keys(conn) if comp else frozenset()        # 명부 제외(BE-5): 경쟁 행이 없으면 문장 생략
    own_codes = [sp.code for sp in splits] + ([label] if len(ctx.own_brands) == 1 or splits else [])
    names, by_name, hmg = await _names(conn, [int(r["brand_key"]) for r in comp], sorted(set(own_codes)))
    names.update(await frozen_brand_names(conn, ms, win, list(names)))          # 동결 읽기: 생성 시점 표시명(S4)
    own_key = by_name.get(label) if len(ctx.own_brands) == 1 else None

    answers, mentions_total = int(tot["answers"]), int(tot["total_mentions"])
    merged_own = _own_item(tot, own_sent, name=label, brand_key=own_key, bits=tuple(sorted(ms.own_bits)))
    comp_items = [_comp_item(r, names) for r in comp]                          # 전 경쟁 행(types_total·brand_count 원천)
    n_own = len(splits) if split else len(ms.own_bits)                         # 집계층 브랜드 축의 당사 행 수(관점 브랜드마다 1행)
    shown = _shown(comp_items, excluded, _card_kept(ms, comp_items, n_own))    # 순위·선택 모집단(카드 상한 → 제외 행 뺌)
    merged_ranked = rank_brand_items([dict(merged_own)] + [dict(i) for i in shown])
    if split:
        sent_by_bit = {int(r["own_bit"]): r for r in sent_rows}
        own_items = [_own_item(t, sent_by_bit.get(sp.bit, dict(_ZERO_SENT)), name=sp.code,
                               brand_key=by_name.get(sp.code), code=sp.code, bits=(sp.bit,))
                     for sp, t in zip(splits, split_tot, strict=True)]
        ranked = rank_brand_items(own_items + shown)
    else:
        ranked = merged_ranked
    chosen, truncated = select_items(ranked, top_n=top_n, sort=sort, only_keys=set(brand_keys) if brand_keys else None, q=q, full=full)
    own_rank_item = next(i for i in merged_ranked if i["is_own"])

    inc = set(include or ())
    extras: _Extras | None = None
    types_total: TypeCounts | None = None
    if inc:
        extras = _Extras(inc)
        extras.hmg = hmg
        if run and inc & {"prompts", "multi", "types"}:
            groups = [i["bits"] for i in ranked if i["is_own"]]
            if inc & {"prompts", "multi"}:
                oq = own_extras_sql(ms, win, groups)
                r0 = await fetch_one(conn, oq.text, oq.params) or {}
                extras.own_counts = {g: {k: int(r0.get(f"{k}{n}") or 0) for k in ("p", "ma", "mm", "mp")} for n, g in enumerate(groups)}
            bq = brand_extras_sql(ms, win)
            own_bits = set(ms.own_bits)
            for r in await fetch_all(conn, bq.text, bq.params):
                bit = int(r["own_bit"] or 0)
                if bit in own_bits:
                    cur = extras.own_types.setdefault(bit, dict.fromkeys(TYPE_COLS, 0))
                    for t in TYPE_COLS:
                        cur[t] += int(r[t] or 0)
                else:
                    extras.comp[int(r["brand_key"])] = r
        if "types" in inc:
            comp_keys = {int(i["brand_key"]) for i in comp_items}
            types_total = TypeCounts(**{t: sum(v.get(t, 0) for v in extras.own_types.values())
                                        + sum(int(r.get(t) or 0) for k, r in extras.comp.items() if k in comp_keys) for t in TYPE_COLS})

    by_engine = await _by_engine(conn, ctx, win, ms, splits, label=label, own_key=own_key,
                                 names=names, by_name=by_name, hmg=hmg, include=inc, top_n=top_n, sort=sort,
                                 brand_keys=brand_keys, q=q, full=full, excluded=excluded) if group_by == "engine" else None

    out = [_to_item(i, answers, mentions_total, extras) for i in chosen]
    return BrandsData(
        totals=Totals(answers=answers, mentions_total=mentions_total, brand_count=len(ranked) + len(comp_items) - len(shown)),
        own=OwnBlock(vp_label=label, brands=list(ctx.own_brands), rank=own_rank_item["rank"], mentions=own_rank_item["mentions"],
                     exposure=ratio(own_rank_item["exposed"], answers), share=ratio(own_rank_item["mentions"], mentions_total),
                     avg_rank=rank_avg_or_none(own_rank_item["rank_sum"], own_rank_item["ranked"])),
        brands=out, types_total=types_total, by_engine=by_engine, truncated=truncated if full else None)


async def _by_engine(conn: Any, ctx: ReadContext, win: Window, ms: MeasureScope, splits: list[OwnSplit], *, label: str,
                     own_key: int | None, names: dict[int, str], by_name: dict[str, int], hmg: dict[int, bool], include: set[str],
                     top_n: int, sort: SortKey, brand_keys: list[int] | None, q: str | None, full: bool,
                     excluded: frozenset[int] = frozenset()) -> list[EngineBrands]:
    """BG-16 엔진 × 브랜드 스냅샷. 합계·경쟁 행·당사 감성을 engine 으로 묶어 같은 순위·선택 규칙을 엔진마다 적용한다.
    엔진별 행에는 own_brand_code·is_hmg_own(include=hmg)만 싣는다(prompts·multi·types 는 전체 행에만).
    블록 = 창 안 std_in 답변이 있는 엔진만(검증 D4: 창 WHERE 는 cit_in 이라 분석 대기 답변만 있는 엔진이 answers 0 블록으로 나왔다).
    엔진 블록 answers 합 = 전체 totals.answers. 명부 제외 행은 전체 창과 같은 규칙(순위·선택에서 뺌, brand_count 는 포함)."""
    if not runnable(win):
        return []
    g = ("engine",)
    split_tots: dict[int | None, list[dict[str, int]]] = {}
    if splits:
        split_tots = await _split_counts(conn, ms, win, splits, by_engine=True)
        tots: dict[int, dict[str, Any]] = {int(ek): v[0] for ek, v in split_tots.items() if ek is not None}
    else:
        tots = {int(r["engine_key"]): r for r in await fetch_counts(conn, ms, win, group_by=g, parts=("mentions",))}
    tots = {ek: t for ek, t in tots.items() if int(t["answers"] or 0) > 0}
    comps: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for r in await brand_rows(conn, ms, win, group_by=g):
        if int(r["brand_key"]) != 0:
            comps[int(r["engine_key"])].append(r)
    s = own_sentiment_sql(ms, win, by_bit=bool(splits), by_engine=True)
    sent_rows = await fetch_all(conn, s.text, s.params)
    missing = sorted({int(r["brand_key"]) for rs in comps.values() for r in rs} - set(names))
    if missing:                      # 전체 창에서 걸러졌던 키는 없다(엔진 행 ⊆ 전체 행). 방어: 이름 없는 키는 조회로 채운다
        more, _, more_hmg = await _names(conn, missing, [])
        names = {**names, **more, **await frozen_brand_names(conn, ms, win, missing)}
        hmg = {**hmg, **more_hmg}
    extras = None
    if "hmg" in include:
        extras = _Extras({"hmg"})
        extras.hmg = hmg
    out: list[EngineBrands] = []
    for ek in sorted(tots):
        t = tots[ek]
        answers, mentions_total = int(t["answers"]), int(t["total_mentions"])
        erows = [r for r in sent_rows if int(r["engine_key"]) == ek]
        comp_items = [_comp_item(r, names) for r in comps.get(ek, [])]
        # 엔진 축도 같은 상한(현행 keepBrand 가 (engine, brand_name) 축 파티션마다 걸린다, summary-trend-aggregates.ts:1003-1018)
        shown = _shown(comp_items, excluded, _card_kept(ms, comp_items, len(splits) if splits else len(ms.own_bits)))
        if splits:
            sent_by_bit = {int(r["own_bit"]): r for r in erows}
            own_items = [_own_item(st, sent_by_bit.get(sp.bit, dict(_ZERO_SENT)), name=sp.code,
                                   brand_key=by_name.get(sp.code), code=sp.code, bits=(sp.bit,))
                         for sp, st in zip(splits, split_tots[ek][1:], strict=True)]
        else:
            own_items = [_own_item(t, erows[0] if erows else dict(_ZERO_SENT), name=label, brand_key=own_key,
                                   bits=tuple(sorted(ms.own_bits)))]
        ranked = rank_brand_items(own_items + shown)
        chosen, cut = select_items(ranked, top_n=top_n, sort=sort, only_keys=set(brand_keys) if brand_keys else None, q=q, full=full)
        out.append(EngineBrands(engine=ctx.refs.engine_code(ek) or str(ek),
                                totals=Totals(answers=answers, mentions_total=mentions_total,
                                              brand_count=len(ranked) + len(comp_items) - len(shown)),
                                brands=[_to_item(i, answers, mentions_total, extras) for i in chosen], truncated=cut if full else None))
    return out


def truncation_meta(data: BrandsData, *, full: bool) -> dict[str, bool] | None:
    """meta.truncated(core 9 U6-3): full=true 일 때만 {brands: 잘림 여부, by_engine: 엔진 블록 중 하나라도 잘림(group_by=engine 일 때)}."""
    if not full:
        return None
    out = {"brands": bool(data.truncated)}
    if data.by_engine is not None:
        out["by_engine"] = any(bool(e.truncated) for e in data.by_engine)
    return out
