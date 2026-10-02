"""성능 라운드(A1~A3, 2026-09-30) 이전 구현 사본: 동치 테스트(test_perf_equiv)의 기준. de720bb 코드를 식 그대로 옮겼다.
요청 경로에서 쓰지 않는다. 테스트는 service·queries 의 해당 이름을 이 함수들로 바꿔 끼운 응답과 새 응답을 바이트 단위로 비교한다.

- measured_days_sql: count(DISTINCT KST 날짜) 한 단계 집계(A1 이전).
- own_parts: split_own 비트마다 core fetch_counts 를 따로 부르던 N 번 스캔(A3 이전).
- series_mix: citation_counts(group_by=(버킷, source)) 전부를 앱으로 받아 파이썬에서 합산·전체 출처 순위(A2 이전).
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from typing import Any

from app.core.cycles import Window
from app.core.db import fetch_all
from app.core.filters import ReadContext
from app.core.measure import (
    CATEGORY_EXPR,
    OVERRIDE_JOIN,
    MeasureScope,
    citation_counts,
    fetch_counts,
    rank_brand_items,
    scope_where,
    split_own_label,
    split_own_scopes,
)
from app.core.sqlb import Binder, Sql
from app.features.analytics.trend.series import queries as q
from app.features.analytics.trend.series import service as s

MEASURED_TZ = "Asia/Seoul"

SOURCES_SQL = f"""
SELECT ds.source_key, ds.skey, ds.domain, {CATEGORY_EXPR} AS category_key
  FROM rd.dim_source ds {OVERRIDE_JOIN}
 WHERE ds.source_key = ANY(CAST(:keys AS int4[]))
"""


def measured_days_sql(ms: MeasureScope, win: Window, group: str, families: Sequence[str]) -> Sql:
    b = Binder("d")
    name, expr = q._bucket(group, "a")
    keys = win.union_keys(*families)
    w = win.where("a", "row", b, keys=keys) + scope_where(ms, "a", b) + ["a.cit_in"]
    jw = [f"j.surface = {b.v(win.sf, 'int2')}", f"j.cyc_key = ANY({b.ints(keys, 'int4')})", "j.served"]
    if win.lo is not None and win.hi is not None:
        jw.append(f"j.round_date BETWEEN {b.date(win.lo)} AND {b.date(win.hi)}")
    t = (f"SELECT {expr} AS {name}, count(DISTINCT (j.measured_at AT TIME ZONE {b.v(MEASURED_TZ, 'text')})::date) AS measured_days\n"
         "  FROM rd.answer a\n"
         "  JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date\n"
         f" WHERE {' AND '.join(w + jw)}\n GROUP BY 1")
    return b.sql(t)


async def own_parts(conn: Any, ctx: ReadContext, win: Window, g: str, label: str, idx: dict[tuple[Any, ...], dict[str, Any]],
                    split_own: bool) -> list[s.OwnPart]:
    splits = split_own_scopes(ctx.measure()) if split_own else ()
    if not splits:
        return [s.OwnPart("own", label, None, idx)]
    codes = [split_own_label(ctx.refs, bit) for bit, _ in splits]
    keys = {str(r["name"]): int(r["brand_key"]) for r in await fetch_all(conn, q.OWN_BRAND_KEYS_SQL, {"names": codes})}
    out = []
    for code, (_, sms) in zip(codes, splits, strict=True):
        rows = await fetch_counts(conn, sms, win, group_by=(g,), parts=("mentions",))
        out.append(s.OwnPart(code, code, code, s._rows_by(rows, g), keys.get(code)))
    return out


async def source_categories(conn: Any, source_keys: set[int]) -> dict[int, dict[str, Any]]:
    if not source_keys:
        return {}
    return {int(r["source_key"]): r for r in await fetch_all(conn, SOURCES_SQL, {"keys": sorted(source_keys)})}


async def series_mix(conn: Any, ctx: ReadContext, win: Window, slots: list[s.Slot], bucket: str,
                     dimension: str, top: int) -> list[s.TrendSeries]:
    md = s.MIX_DEF[dimension]
    ms = ctx.measure()
    g = s.BUCKET_GROUP[bucket]
    seen = await s.citation_presence(conn, ctx, win, (g,), None)
    cit = await citation_counts(conn, ms, win, group_by=(g, "source"))
    src = await source_categories(conn, {int(r["source_key"]) for r in cit})
    bucket_total: dict[Any, int] = defaultdict(int)
    for r in cit:
        bucket_total[r[g]] += int(r["cit_total"] or 0)
    per: dict[Any, dict[Any, int]] = defaultdict(lambda: defaultdict(int))
    labels: dict[Any, tuple[str, str]] = {}
    if dimension == "source":
        for r in cit:
            sk = int(r["source_key"])
            d = src.get(sk)
            if d is None:
                continue
            per[sk][r[g]] += int(r["cit_total"] or 0)
            labels[sk] = (d["skey"], d["domain"])
    else:
        for r in cit:
            d = src.get(int(r["source_key"]))
            if d is None:
                continue
            ck = int(d["category_key"])
            per[ck][r[g]] += int(r["cit_total"] or 0)
            c = ctx.refs.category(ck)
            labels[ck] = (c.slug, c.name) if c else (str(ck), str(ck))
    items = rank_brand_items([{"k": k, "mentions": sum(v.values()), "name": labels[k][1]} for k, v in per.items()])[:top]
    out: list[s.TrendSeries] = []
    for i in items:
        k = i["k"]
        pts = []
        for sl in slots:
            hidden = s.family_gap(sl, win, md.family)
            pts.append(s.make_point(md, sl, hidden, s._presence(md, None, (sl.key,) in seen),
                                    (per[k].get(sl.key, 0), bucket_total.get(sl.key, 0))))
        out.append(s.TrendSeries(metric=md.name, code=md.code, kind="ratio", key=labels[k][0], label=labels[k][1], points=pts))
    return out
