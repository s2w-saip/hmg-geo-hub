#!/usr/bin/env python3
"""hmg-geo 재설계 대조·지연 러너 (EC2 에서 실행, stg RDS hmg DB 의 rd·app 만 읽는다).

  python runner.py values  --combos combos.json --mode new|emu [--impl core|scan] --out values.jsonl [--features F01,..] [--only C01,..]
  (--impl: F01 카드·F02 추이·F05 국가별 구현. core = DB-v2.2 인용 수 열로 app.core.measure 빌더 SQL 을 그대로 실행(기본),
           scan = DB-v2.1 인용 원소 스캔 경로. latency·concur 에도 같은 옵션)
  python runner.py latency --combos combos.json --out latency.jsonl --repeat 7 [--explain-dir DIR]
  python runner.py concur  --combos combos.json --out concur.jsonl --users 1,3,5 --rounds 7

모드
  new : 설계(K-1·T-1·M-1·C-1·G-1·F-1·K-2, DESIGN-CONTRACT §3 술어 규약) 그대로.
        스냅샷 = 함대 최신 노출 round_date 의 모든 완료 측정(A1·Q1), 기간 = round_date 범위(G-04)·발행 회차(R07),
        언급 모수 std_in, 인용 모수 cit_in ∧ 호스트 있음(G-21 a), 기본 엔진 dflt.
  emu : 현행(old) 정의를 rd 위에서 흉내 낸 진단용 변형. 스냅샷 = 셀 대표(is_rep ∧ elig), 기간 = elig 전량(ACR 반복·갭 포함),
        인용 호스트 없는 행 포함, F02 글로벌 = 측정 주(UTC) 버킷 + 버킷 내 셀 최신 1건, ⑥ = 프롬프트 단위.
        정의 변경이 차이를 설명하는지 보이는 데만 쓴다(값 산출 경로 아님).
안전: SET ROLE api_ro · default_transaction_read_only=on · SHOW 단언. 쓰기 없음.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import statistics
import sys
import threading
import time
import unicodedata

import psycopg2
import psycopg2.extras

# core 지표 빌더(app.core.measure 등, 표준 라이브러리만 의존)를 그대로 쓴다: 레포 back/ 또는 EC2 작업 폴더에 app/ 를 둔다.
sys.path.insert(0, os.environ.get("HGH_BACK", os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app.core.codes import OwnedBase  # noqa: E402
from app.core.cycles import CycleRow, build_window  # noqa: E402
from app.core.measure import MeasureScope, allowed_owner_keys, merge_counts, plan_counts  # noqa: E402
from app.core.sqlb import render_literals  # noqa: E402

OWN = {"Hyundai": (1, "h"), "Kia": (2, "k"), "Genesis": (4, "g")}
TODAY = dt.date(2026, 9, 27)          # old 측정일(2026-09-27 17:14 KST) — 노출 게이트를 old 와 맞춘다
EMU_TREND_DAYS = 120                  # 현행 미러 추이 창(TREND_WINDOW_DAYS)
TOP_BRANDS, TOP_DOMAINS, TREND_SLOTS = 10, 20, 12


# ── 접속 ─────────────────────────────────────────────────────────────────────
def connect(stmt_timeout="120s", role="api_ro"):
    """role=api_ro: 기능 API 와 같은 권한(rd·app·ext). role=admin: emu 진단 전용(미러 스냅샷 mig_src 읽기) — 둘 다 읽기 전용."""
    cn = psycopg2.connect(application_name="hmg-parity-C")
    cn.autocommit = True
    cur = cn.cursor()
    if role == "api_ro":
        cur.execute("SET ROLE api_ro")
    cur.execute("SET default_transaction_read_only = on")
    cur.execute("SET jit = off")
    cur.execute(f"SET statement_timeout = '{stmt_timeout}'")
    cur.execute("SET TIME ZONE 'UTC'")
    cur.execute("SELECT current_user, current_setting('transaction_read_only')")
    u, ro = cur.fetchone()
    assert ro == "on" and (role != "api_ro" or u == "api_ro"), f"읽기 전용 단언 실패 {u} {ro}"
    return cn


def arr(xs, typ="int"):
    xs = sorted(set(xs))
    if not xs:
        return f"'{{}}'::{typ}[]"
    return "'{" + ",".join(str(x) for x in xs) + "}'::" + typ + "[]"


def dlit(d):
    return f"DATE '{d.isoformat()}'"


# ── 차원(작은 표, 요청 전 1회) ─────────────────────────────────────────────────
class Dims:
    def __init__(self, cur):
        cur.execute("SELECT engine_key, code, is_default FROM rd.dim_engine")
        self.eng = {c: k for k, c, d in cur.fetchall()}
        cur.execute("SELECT engine_key, code FROM rd.dim_engine")
        self.eng_code = dict(cur.fetchall())
        cur.execute("SELECT geo_key, code FROM rd.dim_country")
        rows = cur.fetchall()
        self.geo = {c: k for k, c in rows}
        self.geo_code = {k: c for k, c in rows}
        cur.execute("SELECT owner_key, kind, brand_code, geo_code, prefix, language FROM app.owned_base")
        rows = cur.fetchall()
        self.owned = [(k, kind, b, g) for k, kind, b, g, _, _ in rows]
        self.owned_bases = [OwnedBase(k, kind, pfx, b, g, lang) for k, kind, b, g, pfx, lang in rows]
        cur.execute("""SELECT cyc_key, surface, project_key, round_date, servable, view_date, hidden_scope,
                              coalesce(expected_units,0), coalesce(completed_units,0) FROM rd.cycle""")
        self.cycles = [dict(zip(["cyc", "sf", "pk", "rd", "serv", "view", "hid", "exp", "comp"], r)) for r in cur.fetchall()]
        cur.execute("SELECT project_key, surface, site_brand_bit, site_geo_key FROM rd.dim_project")
        self.proj = {r[0]: r for r in cur.fetchall()}
        cur.execute("SELECT brand_key, name, own_bit FROM rd.dim_brand_name")
        self.bname = {k: (n, o) for k, n, o in cur.fetchall()}
        cur.execute("SELECT geo_key FROM rd.dim_country WHERE hidden_standard")
        self.hidden_geo = {r[0] for r in cur.fetchall()}

    def own_keys(self, brand, countries):
        """글로벌 자사 인용 허용 owner_key 배열(ownedBasePrefixesForScope 규칙: 브랜드 → 국가 좁힘은 결과가 있을 때만)."""
        by = [(k, g) for k, kind, b, g in self.owned if b == brand]
        if countries:
            cc = {c.upper() for c in countries}
            byc = [(k, g) for k, g in by if g and g.upper() in cc]
            if byc:
                by = byc
        return [k for k, _ in by]


# ── 조합 문맥 ─────────────────────────────────────────────────────────────────
class Ctx:
    def __init__(self, combo, dims: Dims, mode: str, today=TODAY):
        self.c, self.d, self.mode, self.today = combo, dims, mode, today
        self.id = combo["id"]
        self.sf = 1 if combo["surface"] == "global" else 2
        self.own = combo["own_brand"]
        self.ob, self.col = OWN[self.own]
        # 관점 모수: 글로벌 = 카탈로그 brand(own) ∪ 공통(HMG 엄브렐러 8), 웹 = 사이트 브랜드(own)
        self.bgrps = [v for v in range(32) if v & (self.ob | 8)] if self.sf == 1 else [self.ob]
        self.engines = [dims.eng[e] for e in combo.get("engines") or []]
        self.countries = [c.upper() for c in combo.get("countries") or []]
        self.geos = [dims.geo[c] for c in self.countries if c in dims.geo]
        self.own_keys = dims.own_keys(self.own, self.countries) if self.sf == 1 else []
        self.kind = combo["period"]["kind"]
        if self.kind == "range":
            self.lo = dt.date.fromisoformat(combo["period"]["from"])
            self.hi = dt.date.fromisoformat(combo["period"]["to"])
        # 허용 프로젝트: 글로벌 = 루트(표면 1 전부), 웹 = 사이트 브랜드 = own
        self.pks = [pk for pk, r in dims.proj.items() if r[1] == self.sf and (self.sf == 1 or r[2] == self.ob)]
        self.cands = [c for c in dims.cycles if c["sf"] == self.sf and c["pk"] in set(self.pks)
                      and c["serv"] and c["view"] is not None and c["view"] <= today]
        if self.kind == "latest_cycle":
            L = max((c["rd"] for c in self.cands if c["hid"] != 1), default=None)
            self.L = L
            self.lo = self.hi = L

    def cycs(self, family, lo=None, hi=None):
        lo = lo or self.lo
        hi = hi or self.hi
        bad = {1, 3} if family == "m" else {1, 2}
        return sorted({c["cyc"] for c in self.cands if lo <= c["rd"] <= hi and c["hid"] not in bad})

    def slots(self):
        """T-1 자리: 최신 회차 조합 = 최근 12 round_date, 기간 조합 = 기간 안 round_date."""
        rds = sorted({c["rd"] for c in self.cands if c["hid"] != 1})
        if self.kind == "latest_cycle":
            rds = [r for r in rds if r <= self.L][-TREND_SLOTS:]
        else:
            rds = [r for r in rds if self.lo <= r <= self.hi]
        return rds

    # 공통 술어(WHERE: 불리언·= ANY 상수 배열만)
    def where(self, alias, family, lo=None, hi=None, cycs=None, engine=True, geo=True):
        a = alias
        lo = lo or self.lo
        hi = hi or self.hi
        cy = cycs if cycs is not None else self.cycs(family, lo, hi)
        w = [f"{a}.surface = {self.sf}"]
        w.append(f"{a}.round_date = {dlit(lo)}" if lo == hi else f"{a}.round_date BETWEEN {dlit(lo)} AND {dlit(hi)}")
        w.append(f"{a}.cyc_key = ANY({arr(cy)})")
        w.append(f"{a}.bgrp = ANY({arr(self.bgrps, 'int2')})")
        if engine:
            w.append(f"{a}.engine_key = ANY({arr(self.engines, 'int2')})" if self.engines else f"{a}.dflt")
        if geo and self.geos:
            w.append(f"{a}.geo_key = ANY({arr(self.geos, 'int2')})")
        return w

    def owned_expr(self, a="c"):
        if self.sf == 1:
            return f"{a}.owner_key = ANY({arr(self.own_keys, 'int2')})"
        return f"({a}.loc_owned OR {a}.tgt_hit)"


# ── SQL 조립 ─────────────────────────────────────────────────────────────────
# emu(현행 정의 모사) 전용 상수·조각 — 진단용. 근거: parity/sql/x02~x09 프로브.
GEN_CUTOFF = {873: "2026-09-15 17:12:04+00"}   # 09-14 글로벌 회차 집계층 사실표 생성 완료 시각(proto REPORT-addendum3 §4)
OLDCAT = ("(SELECT dp.prompt_key FROM rd.dim_prompt dp JOIN (SELECT p.scope_prompt_id AS pid, bit_or(coalesce(b.brand_bit, 8)) AS m "
          "FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root' "
          "LEFT JOIN app.brand b ON b.brand_code = p.brand_code WHERE p.scope_prompt_id IS NOT NULL GROUP BY 1) o "
          "ON o.pid = dp.prompt_id WHERE (o.m & {mask}) <> 0)")


def emu_src(x: Ctx, family, lo=None, hi=None):
    """현행 답변셋 모사.
    스냅샷(집계층): 셀 대표 = elig 중 (회차, 프롬프트, 엔진, 지역) 최신 1건. 글로벌은 사실표 생성 시각 이전 측정만(GEN_CUTOFF).
    기간(미러 anchorPeriod): 발행·노출·run 상태 게이트 없음(진행 중 회차 포함), 한국어 비-KR·시장 태그 게이트 없음, 숨김 지역만 제외.
    글로벌 카탈로그 모집단 = 소프트삭제 행 포함(A4 #1 이전)."""
    lo = lo or x.lo
    hi = hi or x.hi
    bad = {1, 3} if family == "m" else {1, 2}
    eng = f"a.engine_key = ANY({arr(x.engines, 'int2')})" if x.engines else ("true" if getattr(x, "emu_all_engines", False) else "a.dflt")
    geo = f" AND a.geo_key = ANY({arr(x.geos, 'int2')})" if x.geos else ""
    popg = f"a.prompt_key IN {OLDCAT.format(mask=x.ob | 8)}" if x.sf == 1 else f"a.bgrp = ANY({arr(x.bgrps, 'int2')})"
    if x.kind == "latest_cycle":
        cy = x.cycs(family, lo, hi)
        cut = ""
        cuts = [f"(a.cyc_key = {k} AND j.measured_at > '{v}')" for k, v in GEN_CUTOFF.items() if k in cy]
        if x.sf == 1 and cuts:
            cut = " AND NOT (" + " OR ".join(cuts) + ")"
        return (f"(SELECT DISTINCT ON (a.cyc_key, a.prompt_key, a.engine_key, a.geo_key) a.* FROM rd.answer a "
                f"JOIN rd.job j ON j.answer_key = a.answer_key WHERE a.surface = {x.sf} AND a.round_date = {dlit(lo)} "
                f"AND a.cyc_key = ANY({arr(cy)}) AND a.elig AND {eng}{geo} AND {popg}{cut} "
                f"ORDER BY a.cyc_key, a.prompt_key, a.engine_key, a.geo_key, j.measured_at DESC, a.answer_key DESC)")
    # 현행 기간 경로는 인용 숨김(hidden_scope='citations')을 적용하지 않는다(x12 프로브 ②) → 'all' 숨김만 제외
    allc = sorted({c["cyc"] for c in x.d.cycles if c["sf"] == x.sf and c["pk"] in set(x.pks) and lo <= c["rd"] <= hi
                   and c["hid"] != 1})
    hid = ""
    if x.sf == 1:
        hidden = [k for k, cc in x.d.geo_code.items() if k in x.d.hidden_geo] + [0]
        hid = f" AND a.geo_key <> ALL({arr(hidden, 'int2')})"
    return (f"(SELECT a.* FROM rd.answer a WHERE a.surface = {x.sf} AND a.round_date BETWEEN {dlit(lo)} AND {dlit(hi)} "
            f"AND a.cyc_key = ANY({arr(allc)}) AND {eng}{geo} AND {popg}{hid})")


def ans_filter_sql(x: Ctx, family, lo=None, hi=None, cycs=None, engine=True, geo=True):
    w = x.where("a", family, lo, hi, cycs, engine, geo)
    w += ["a.std_in"] if family == "m" else ["a.cit_in"]
    return " AND ".join(w)


def asrc(x: Ctx, family, lo=None, hi=None, cycs=None):
    """(FROM 절, WHERE 절) — new = rd.answer 술어, emu = 모사 답변셋."""
    if x.mode == "new":
        return "rd.answer a", ans_filter_sql(x, family, lo, hi, cycs)
    return emu_src(x, family, lo, hi) + " a", "true"


def cit_sql(x: Ctx, group=None, lo=None, hi=None, cycs=None):
    """인용 집계. new = rd.citation 단독(cit_in ∧ 호스트). emu = 모사 답변셋과 조인(호스트 없는 행 포함)."""
    gsel = f"{group}, " if group else ""
    gby = f" GROUP BY {group}" if group else ""
    if x.mode == "new":
        w = x.where("c", "c", lo, hi, cycs) + ["c.cit_in", "c.source_key <> 0"]
        return (f"SELECT {gsel}count(*) AS cit, count(*) FILTER (WHERE {x.owned_expr('c')}) AS own "
                f"FROM rd.citation c WHERE {' AND '.join(w)}{gby}")
    lo2, hi2 = lo or x.lo, hi or x.hi
    return (f"SELECT {gsel}count(*) AS cit, count(*) FILTER (WHERE {x.owned_expr('c')}) AS own "
            f"FROM rd.citation c JOIN {emu_src(x, 'c', lo, hi)} s ON s.surface = c.surface AND s.round_date = c.round_date "
            f"AND s.answer_key = c.answer_key WHERE c.surface = {x.sf} AND c.round_date BETWEEN {dlit(lo2)} AND {dlit(hi2)}{gby}")


def own_cols(x: Ctx):
    k = x.col
    return (f"count(*) AS n, count(*) FILTER (WHERE (a.own_mask & {x.ob}) <> 0) AS vis, "
            f"coalesce(sum(a.ment_{k}),0) AS sov_n, coalesce(sum(a.ment_total),0) AS sov_d, "
            f"coalesce(sum(a.sent_pos_{k}),0) AS sp, coalesce(sum(a.sent_all_{k}),0) AS sa, "
            f"coalesce(sum(a.own_rk_{k}) FILTER (WHERE a.own_rk_{k} > 0),0) AS rks, count(*) FILTER (WHERE a.own_rk_{k} > 0) AS rkn")


def ans_sql(x: Ctx, group=None, lo=None, hi=None, cycs=None, extra=""):
    gsel = f"{group}, " if group else ""
    gby = f" GROUP BY {group}" if group else ""
    frm, wh = asrc(x, "m", lo, hi, cycs)
    return f"SELECT {gsel}{own_cols(x)}{extra} FROM {frm} WHERE {wh}{gby}"


def web_rate_sql(x: Ctx, group=None, lo=None, hi=None):
    """⑥ 타겟 URL 인용률. new = A2 측정 단위(web_reg ∧ cit_in 답변 중 tgt_cited). emu = 프롬프트 단위."""
    gsel = f"{group}, " if group else ""
    gby = f" GROUP BY {group}" if group else ""
    if x.mode == "new":
        w = x.where("a", "c", lo, hi) + ["a.cit_in", "a.web_reg"]
        return (f"SELECT {gsel}count(*) AS reg, count(*) FILTER (WHERE a.tgt_cited) AS tgt, "
                f"count(*) FILTER (WHERE a.own_url_cited) AS ownu FROM rd.answer a WHERE {' AND '.join(w)}{gby}")
    # 현행 ⑥(aggregateWebsiteTargetHitRate): 프롬프트마다 가장 최근 round 의 측정으로 적중 판정(스냅샷은 전 기간, 기간은 창 안)
    lo = lo or x.lo
    hi = hi or x.hi
    w = [f"a.surface = {x.sf}", f"a.round_date <= {dlit(hi)}", f"a.bgrp = ANY({arr(x.bgrps, 'int2')})", "a.elig", "a.web_reg",
         (f"a.engine_key = ANY({arr(x.engines, 'int2')})" if x.engines else "a.dflt")]
    if x.kind == "range":
        w.append(f"a.round_date >= {dlit(lo)}")
    if x.geos:
        w.append(f"a.geo_key = ANY({arr(x.geos, 'int2')})")
    if x.kind == "range":   # 기간: 창 안 한 번이라도 적중한 프롬프트 / 창 안 측정 프롬프트(x12 프로브 ③)
        return (f"SELECT count(DISTINCT a.prompt_key) AS reg, count(DISTINCT a.prompt_key) FILTER (WHERE a.tgt_cited) AS tgt, "
                f"count(DISTINCT a.prompt_key) FILTER (WHERE a.own_url_cited) AS ownu FROM rd.answer a WHERE {' AND '.join(w)}")
    return (f"WITH a AS (SELECT a.prompt_key, a.round_date, a.tgt_cited, a.own_url_cited FROM rd.answer a WHERE {' AND '.join(w)}), "
            f"lr AS (SELECT prompt_key, max(round_date) AS m FROM a GROUP BY 1), "
            f"p AS (SELECT a.prompt_key, bool_or(a.tgt_cited) AS t, bool_or(a.own_url_cited) AS o FROM a JOIN lr ON lr.prompt_key = a.prompt_key AND lr.m = a.round_date GROUP BY 1) "
            f"SELECT count(*) AS reg, count(*) FILTER (WHERE t) AS tgt, count(*) FILTER (WHERE o) AS ownu FROM p")


def report_rounds(cur, x: Ctx, rds):
    """R09·G-22: 활성 발행 회차(website) — 그 회차의 ⑥ 은 rd.report_unit_value 로 대체(엔진 기본값일 때만)."""
    if x.sf != 2 or x.engines:
        return {}
    cur = cur.connection.cursor()
    cur.execute(f"""SELECT v.round_date, coalesce(sum(v.measured_prompts),0), coalesce(sum(v.target_hit_prompts),0)
                      FROM rd.report_unit_value v JOIN app.report_publication p ON p.id = v.pub_id AND p.status = 'active'
                     WHERE v.round_date = ANY({arr([r.isoformat() for r in rds], 'date')}) AND v.brand = %s
                       {"AND v.country_code = ANY(%s)" if x.countries else ""}
                     GROUP BY 1""", [x.own] + ([x.countries] if x.countries else []))
    return {r[0]: (int(r[1]), int(r[2])) for r in cur.fetchall()}


# ── 값 줄 ────────────────────────────────────────────────────────────────────
def V(x, feat, key, num, den, **kw):
    if den is None:
        v = num
    else:
        v = (100.0 * num / den) if den else None
    r = {"combo_id": x.id, "feature": feat, "key": key, "num": num, "den": den, "value": v, "source": f"new-{x.mode}"}
    r.update(kw)
    return r


def lc_key(s):
    """JS String.localeCompare(ICU 루트) 근사: 1차 = 악센트 제거·대소문자 무시, 2차 = 악센트, 3차 = 소문자 우선."""
    base = "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch)).casefold()
    grp = {"Z": 0, "P": 1, "S": 2, "N": 3}   # ICU 루트 순서: 공백 < 구두점 < 기호 < 숫자 < 문자
    prim = tuple((grp.get(unicodedata.category(ch)[0], 4), ch) for ch in base)
    return (prim, s.casefold(), tuple(0 if ch.islower() else 1 for ch in s))


def pos_val(rks, rkn):
    return (round(rks / rkn + 1e-9, 1) if rkn else None)


def kpi_lines(x, feat, prefix, r, cit=None, own=None):
    out = [V(x, feat, f"{prefix}visibility", int(r["vis"]), int(r["n"])),
           V(x, feat, f"{prefix}sov", int(r["sov_n"]), int(r["sov_d"])),
           V(x, feat, f"{prefix}sentiment", int(r["sp"]), int(r["sa"])),
           V(x, feat, f"{prefix}position", pos_val(r["rks"], r["rkn"]), None, raw=[int(r["rks"]), int(r["rkn"])])]
    if cit is not None:
        out.append(V(x, feat, f"{prefix}citation_share", int(own), int(cit)))
    return out


def q(cur, sql, log=None):
    t0 = time.perf_counter()
    cur.execute(sql)
    rows = cur.fetchall()
    ms = (time.perf_counter() - t0) * 1000
    if log is not None:
        log.append({"sql": sql, "ms": round(ms, 2), "rows": len(rows)})
    return rows


# ── 기능 ─────────────────────────────────────────────────────────────────────
def f01(cur, x: Ctx, log):
    if x.lo is None:
        return []
    extra = ", count(*) FILTER (WHERE a.gap) AS gap_n" if x.mode == "new" else ""
    if x.mode == "new":
        # 한 스캔: WHERE cit_in(⊇ std_in), 언급 지표는 FILTER (std_in), 결손은 FILTER (gap)
        k = x.col
        w = x.where("a", "m") + ["a.cit_in"]
        cols = (f"count(*) FILTER (WHERE a.std_in) AS n, count(*) FILTER (WHERE a.std_in AND (a.own_mask & {x.ob}) <> 0) AS vis, "
                f"coalesce(sum(a.ment_{k}) FILTER (WHERE a.std_in),0) AS sov_n, coalesce(sum(a.ment_total) FILTER (WHERE a.std_in),0) AS sov_d, "
                f"coalesce(sum(a.sent_pos_{k}) FILTER (WHERE a.std_in),0) AS sp, coalesce(sum(a.sent_all_{k}) FILTER (WHERE a.std_in),0) AS sa, "
                f"coalesce(sum(a.own_rk_{k}) FILTER (WHERE a.std_in AND a.own_rk_{k} > 0),0) AS rks, "
                f"count(*) FILTER (WHERE a.std_in AND a.own_rk_{k} > 0) AS rkn, count(*) FILTER (WHERE a.gap) AS gap_n, count(*) AS cit_n")
        if x.sf == 2:
            cols += (", count(*) FILTER (WHERE a.web_reg) AS reg, count(*) FILTER (WHERE a.web_reg AND a.tgt_cited) AS tgt, "
                     "count(*) FILTER (WHERE a.web_reg AND a.own_url_cited) AS ownu")
        sql = f"SELECT * FROM (SELECT {cols} FROM rd.answer a WHERE {' AND '.join(w)}) a, ({cit_sql(x)}) c"
    else:
        sql = f"SELECT * FROM ({ans_sql(x)}) a, ({cit_sql(x)}) c"
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    r = q(cur2, sql, log)[0]
    out = kpi_lines(x, "F01", "", r, r["cit"], r["own"])
    if x.mode == "new":
        out.append(V(x, "F01", "analysis_gap", int(r["gap_n"]), int(r["cit_n"])))
        out.append(V(x, "F01", "answers", int(r["n"]), None))
    if x.sf == 2:
        if x.mode == "new":
            rep = report_rounds(cur2, x, [x.L] if x.kind == "latest_cycle" else [])
            if x.kind == "latest_cycle" and x.L in rep:
                den, num = rep[x.L]
                out.append(V(x, "F01", "target_rate", num, den, origin="report"))
            else:
                out.append(V(x, "F01", "target_rate", int(r["tgt"]), int(r["reg"])))
                out.append(V(x, "F01", "owned_rate", int(r["ownu"]), int(r["reg"])))
        else:
            w = q(cur2, web_rate_sql(x), log)[0]
            out.append(V(x, "F01", "target_rate", int(w["tgt"]), int(w["reg"])))
    return out


def f02(cur, x: Ctx, log):
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    out = []
    if x.mode == "emu" and x.sf == 1:
        return f02_emu_global(cur2, x, log)
    rds = x.slots()
    if not rds:
        return out
    lo, hi = rds[0], rds[-1]
    cm = [c["cyc"] for c in x.cands if c["rd"] in set(rds) and c["hid"] not in (1, 3)]
    cc = [c["cyc"] for c in x.cands if c["rd"] in set(rds) and c["hid"] not in (1, 2)]
    if x.mode == "emu":   # 웹사이트 현행 = 집계층 회차 대표(회차 단위). x축은 round_date 로 둔다(현행 함대 회차 라벨은 모사하지 않음, 보고서 참조)
        sa = (f"SELECT a.round_date, {own_cols(x)} FROM rd.answer a "
              f"WHERE {' AND '.join(x.where('a','m',lo,hi,cm) + ['a.elig','a.is_rep'])} GROUP BY 1")
        sc = (f"SELECT s.round_date, count(*) AS cit, count(*) FILTER (WHERE {x.owned_expr('c')}) AS own FROM rd.citation c "
              f"JOIN (SELECT a.answer_key, a.round_date FROM rd.answer a WHERE {' AND '.join(x.where('a','c',lo,hi,cc) + ['a.elig','a.is_rep'])}) s "
              f"ON s.answer_key = c.answer_key WHERE {' AND '.join(x.where('c','c',lo,hi,cc))} GROUP BY 1")
    else:
        sa = ans_sql(x, "a.round_date", lo, hi, cm)
        sc = cit_sql(x, "c.round_date", lo, hi, cc)
    A = {r["round_date"]: r for r in q(cur2, sa, log)}
    C = {r["round_date"]: r for r in q(cur2, sc, log)}
    W, REP = {}, {}
    if x.sf == 2 and x.mode == "new":
        W = {r["round_date"]: r for r in q(cur2, web_rate_sql(x, "a.round_date", lo, hi), log)}
        REP = report_rounds(cur2, x, rds)
    keys = sorted(A) if x.mode == "emu" else rds
    for d in keys:
        r = A.get(d)
        if not r or not r["n"]:
            continue   # 갭 자리는 값이 없다
        c = C.get(d, {"cit": 0, "own": 0})
        out += kpi_lines(x, "F02", f"{d.isoformat()}:", r, c["cit"], c["own"])
        if x.sf == 2 and x.mode == "new":
            if d in REP:
                out.append(V(x, "F02", f"{d.isoformat()}:target_rate", REP[d][1], REP[d][0], origin="report"))
            elif d in W:
                out.append(V(x, "F02", f"{d.isoformat()}:target_rate", int(W[d]["tgt"]), int(W[d]["reg"])))
    return out


def f02_emu_global(cur2, x: Ctx, log):
    """현행 글로벌 추이(미러): 측정 주(UTC 월요일) 버킷, 버킷 안 셀(프롬프트·엔진·지역) 최신 1건, 비발행 회차 포함(allRuns)."""
    if x.kind == "latest_cycle":
        lo = TODAY - dt.timedelta(days=EMU_TREND_DAYS)
        hi = TODAY
    else:
        lo, hi = x.lo, x.hi
    # 모집단 = 현행 미러 추이(allRuns): 기간 모사와 같은 규칙(emu_src 기간 분기) + 측정일 창
    xr = Ctx(dict(x.c, period={"kind": "range", "from": (lo - dt.timedelta(days=14)).isoformat(), "to": hi.isoformat()}), x.d, "emu")
    src = emu_src(xr, "m")
    w = ["true"]
    k = x.col
    sql = f"""WITH s AS MATERIALIZED (
  SELECT DISTINCT ON (wk, a.prompt_key, a.engine_key, a.geo_key) a.answer_key, a.round_date, a.own_mask, a.ment_{k}, a.ment_total,
         a.sent_pos_{k}, a.sent_all_{k}, a.own_rk_{k}, wk
    FROM {src} a JOIN rd.job j0 ON j0.answer_key = a.answer_key
    LEFT JOIN mig_src.scope_answers sa ON sa.job_id = j0.job_id   -- 현행 미러 measured_at(앵커 고정 접힌 값)
    CROSS JOIN LATERAL (SELECT coalesce(sa.measured_at, j0.measured_at) AS measured_at) j
    CROSS JOIN LATERAL (SELECT date_trunc('week', j.measured_at AT TIME ZONE 'UTC')::date AS wk) b
   WHERE {' AND '.join(w)} AND (j.measured_at AT TIME ZONE 'UTC')::date BETWEEN {dlit(lo)} AND {dlit(hi)}
   ORDER BY wk, a.prompt_key, a.engine_key, a.geo_key, j.measured_at DESC, a.answer_key DESC),
aa AS (SELECT wk, count(*) AS n, count(*) FILTER (WHERE (own_mask & {x.ob}) <> 0) AS vis, coalesce(sum(ment_{k}),0) AS sov_n,
              coalesce(sum(ment_total),0) AS sov_d, coalesce(sum(sent_pos_{k}),0) AS sp, coalesce(sum(sent_all_{k}),0) AS sa,
              coalesce(sum(own_rk_{k}) FILTER (WHERE own_rk_{k} > 0),0) AS rks, count(*) FILTER (WHERE own_rk_{k} > 0) AS rkn FROM s GROUP BY wk),
cc AS (SELECT s.wk, count(*) AS cit, count(*) FILTER (WHERE {x.owned_expr('c')}) AS own FROM s
         JOIN rd.citation c ON c.surface = {x.sf} AND c.round_date = s.round_date AND c.answer_key = s.answer_key GROUP BY s.wk)
SELECT aa.*, coalesce(cc.cit,0) AS cit, coalesce(cc.own,0) AS own FROM aa LEFT JOIN cc USING (wk) ORDER BY wk"""
    out = []
    for r in q(cur2, sql, log):
        out += kpi_lines(x, "F02", f"{r['wk'].isoformat()}:", r, r["cit"], r["own"])
    return out


def f03(cur, x: Ctx, log):
    if x.lo is None:
        return []
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    own = q(cur2, ans_sql(x), log)[0]
    wb = x.where("b", "m")
    if x.mode == "new":
        wb += ["b.std_in"]
        src = "rd.answer_brand b"
    else:
        wb = [f"b.surface = {x.sf}", f"b.round_date BETWEEN {dlit(x.lo)} AND {dlit(x.hi)}"]
        src = (f"rd.answer_brand b JOIN {emu_src(x, 'm')} s ON s.surface = b.surface AND s.round_date = b.round_date "
               f"AND s.answer_key = b.answer_key")
    # 경쟁 브랜드: competitive 행 중 당사(own) 제외 — 형제 HMG 브랜드는 포함(현행 agg.brands 와 같은 모집단)
    sql = (f"SELECT b.brand_key, sum(b.mention_count) AS m, count(*) AS ans, coalesce(sum(b.rk) FILTER (WHERE b.rk > 0),0) AS rks, "
           f"count(*) FILTER (WHERE b.rk > 0) AS rkn FROM {src} WHERE {' AND '.join(wb)} AND b.competitive AND b.own_bit <> {x.ob} "
           f"GROUP BY b.brand_key")
    rows = q(cur2, sql, log)
    items = [{"name": x.d.bname[r["brand_key"]][0], "m": int(r["m"]), "ans": int(r["ans"]), "rks": int(r["rks"]), "rkn": int(r["rkn"]),
              "own": False} for r in rows if r["brand_key"] != 0]
    items.append({"name": x.own, "m": int(own["sov_n"]), "ans": int(own["vis"]), "rks": int(own["rks"]), "rkn": int(own["rkn"]), "own": True})
    items.sort(key=lambda i: (-i["m"], lc_key(i["name"])))
    uncapped = "*" in (x.c.get("brands") or [])
    comps = [i for i in items if not i["own"]]
    pick = {i["name"] for i in (comps if uncapped else comps[:TOP_BRANDS])} | {x.own}
    out = []
    for rank, i in enumerate(items, 1):
        if i["name"] not in pick:
            continue
        out += [V(x, "F03", f"brand:{i['name']}:mentions", i["m"], None),
                V(x, "F03", f"brand:{i['name']}:exposure", i["ans"], int(own["n"])),
                V(x, "F03", f"brand:{i['name']}:sov", i["m"], int(own["sov_d"])),
                V(x, "F03", f"brand:{i['name']}:rank", rank, None)]
        if x.mode == "new":
            out.append(V(x, "F03", f"brand:{i['name']}:position", pos_val(i["rks"], i["rkn"]), None, raw=[i["rks"], i["rkn"]]))
    return out


def f04(cur, x: Ctx, log):
    if x.lo is None:
        return []
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    inner = cit_sql(x, "c.source_key")
    sql = (f"SELECT s.domain, sum(g.cit)::bigint AS cit, sum(g.own)::bigint AS own FROM ({inner}) g "
           f"JOIN rd.dim_source s ON s.source_key = g.source_key GROUP BY s.domain ORDER BY 2 DESC, 1 LIMIT {TOP_DOMAINS}")
    out = []
    for r in q(cur2, sql, log):
        out += [V(x, "F04", f"domain:{r['domain']}:citations", int(r["cit"]), None),
                V(x, "F04", f"domain:{r['domain']}:owned", int(r["own"]), None)]
    return out


def f05(cur, x: Ctx, log):
    if x.lo is None:
        return []
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    out = []
    if x.mode == "emu" and x.sf == 2 and x.kind == "range":
        x.emu_all_engines = True   # 현행 웹사이트 국가 경쟁(미러 누적)은 엔진 무필터(x18 프로브)
    A = q(cur2, ans_sql(x, "a.geo_key"), log)
    x.emu_all_engines = False
    if x.sf == 1:
        csql = cit_sql(x, "c.geo_key")
        if x.mode == "emu" and x.kind == "range":   # 현행 기간 국가별 인용(미러)은 호스트 있는 인용만(C04·C05 +1 대조)
            csql = csql.replace(" GROUP BY c.geo_key", " AND c.source_key <> 0 GROUP BY c.geo_key")
        C = {r["geo_key"]: r for r in q(cur2, csql, log)}
    for r in sorted(A, key=lambda r: x.d.geo_code[r["geo_key"]]):
        cc = x.d.geo_code[r["geo_key"]]
        if x.sf == 1:
            out.append(V(x, "F05", f"country:{cc}:visibility", int(r["vis"]), int(r["n"])))
            c = C.get(r["geo_key"], {"cit": 0, "own": 0})
            out.append(V(x, "F05", f"country:{cc}:citation_share", int(c["own"]), int(c["cit"])))
        out.append(V(x, "F05", f"country:{cc}:sov", int(r["sov_n"]), int(r["sov_d"])))
    return out


def f06(cur, x: Ctx, log):
    if x.lo is None:
        return []
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    w = x.where("a", "m", engine=False, geo=False) + ["a.std_in"]
    sql = f"SELECT DISTINCT a.geo_key, a.engine_key FROM rd.answer a WHERE {' AND '.join(w)}"
    rows = q(cur2, sql, log)
    geos = sorted({x.d.geo_code[r["geo_key"]] for r in rows if r["geo_key"] != 0})
    engs = sorted({x.d.eng_code[r["engine_key"]] for r in rows if r["engine_key"] != 0})
    return ([V(x, "F06", f"opt:country:{c}", 1, None) for c in geos] + [V(x, "F06", f"opt:engine:{e}", 1, None) for e in engs])


def f07(cur, x: Ctx, log):
    """K-2 기간 비교 Δ(언급 계열 4지표). 기간 조합 = 같은 길이 직전 창(window), 최신 회차 조합 = 직전 노출 회차 대비."""
    if x.lo is None:
        return []
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    if x.kind == "range":
        n = (x.hi - x.lo).days + 1
        cur_w = (x.lo, x.hi)
        prev_w = (x.lo - dt.timedelta(days=n), x.lo - dt.timedelta(days=1))
        kind = "window"
    else:
        rds = sorted({c["rd"] for c in x.cands if c["hid"] not in (1, 3) and c["rd"] <= x.L})
        if len(rds) < 2:
            return [V(x, "F07", f"suppressed:{k}", 1, None, reason="no_prev") for k in ("visibility", "sov", "sentiment", "position")]
        cur_w, prev_w, n, kind = (rds[-1], rds[-1]), (rds[-2], rds[-2]), 1, "cycle"
    lo = prev_w[0]
    cm = x.cycs("m", lo, cur_w[1])
    k = x.col
    sql = f"""SELECT CASE WHEN a.round_date >= {dlit(cur_w[0])} THEN 'cur' ELSE 'prev' END AS w, {own_cols(x)}, count(DISTINCT a.cyc_key) AS data_cycles
  FROM rd.answer a WHERE {ans_filter_sql(x, 'm', lo, cur_w[1], cm)} GROUP BY 1"""
    R = {r["w"]: r for r in q(cur2, sql, log)}
    # 원장(rd.cycle, Q2 카운터 투영): 발행 회차 수·계획/누락 유닛, 최초 발행 round_date
    led = {}
    for wname, (a, b) in (("prev", prev_w), ("cur", cur_w)):
        cs = [c for c in x.d.cycles if c["sf"] == x.sf and c["pk"] in set(x.pks) and a <= c["rd"] <= b]
        led[wname] = {"pub": sum(1 for c in cs if c["serv"] and c["view"] and c["view"] <= x.today),
                      "planned": sum(c["exp"] for c in cs), "missing": sum(max(c["exp"] - c["comp"], 0) for c in cs if c["exp"])}
    first = min((c["rd"] for c in x.cands), default=None)
    reason = None
    if led["prev"]["pub"] <= 0:
        reason = "no_prev"
    elif not R.get("prev") or not R.get("cur") or not R["prev"]["data_cycles"] or not R["cur"]["data_cycles"]:
        reason = "no_data"
    elif kind == "window" and n >= 30 and any(l["planned"] > 0 and l["missing"] / l["planned"] >= 0.3 for l in led.values()):
        reason = "missing_share"
    elif kind == "window" and first and first > prev_w[0] + dt.timedelta(days=-(-n // 4)):
        reason = "start_window"
    out = []
    for key, nk, dk, unit in (("visibility", "vis", "n", "pp"), ("sov", "sov_n", "sov_d", "pp"), ("sentiment", "sp", "sa", "pp"),
                              ("position", "rks", "rkn", "rank")):
        vals = {}
        for wname in ("prev", "cur"):
            r = R.get(wname)
            vals[wname] = (r[nk] / r[dk]) if (r and r[dk]) else None
        if reason or vals["prev"] is None or vals["cur"] is None:
            out.append(V(x, "F07", f"suppressed:{key}", 1, None, reason=reason or "no_value"))
        else:
            d = (vals["cur"] - vals["prev"]) * (100 if unit == "pp" else 1)
            out.append(V(x, "F07", f"delta:{key}", round(d, 6), None, cur=vals["cur"], prev=vals["prev"]))
    return out


# ── G-25(DB-v2.2): 카드·추이·국가별 = app.core.measure 빌더(rd.answer 인용 수 열, rd.citation 스캔 없음) ──
OWN_BIT = {"Hyundai": 1, "Kia": 2, "Genesis": 4}


def core_scope(x: Ctx) -> MeasureScope:
    """러너 조합 문맥 → core MeasureScope(관점 = 조합 own_brand, 자사 허용 배열 = allowed_owner_keys)."""
    owner = allowed_owner_keys(x.d.owned_bases, {x.own}, OWN_BIT, x.countries or None, None) if x.sf == 1 else None
    return MeasureScope(sf=x.sf, project_keys=tuple(x.pks), own_bits=(x.ob,), bgrps=tuple(x.bgrps),
                        geo_keys=tuple(x.geos) if x.geos else None, engine_keys=tuple(x.engines) if x.engines else None, owner=owner)


def core_window(x: Ctx, lo, hi):
    rows = [CycleRow(c["cyc"], c["pk"], c["rd"], c["hid"]) for c in x.cands if lo <= c["rd"] <= hi]
    return build_window(surface=x.c["surface"], mode="snapshot" if (x.kind == "latest_cycle" and lo == hi) else "cumulative",
                        rows=rows, lo=lo, hi=hi, generation=None, project_keys=tuple(x.pks))


def core_counts(cur2, x: Ctx, log, *, lo=None, hi=None, group_by=(), parts=("mentions", "gap", "citations")):
    plan = plan_counts(core_scope(x), core_window(x, lo or x.lo, hi or x.hi), group_by=group_by, parts=parts)
    x.owner_mode = core_scope(x).owner.mode if x.sf == 1 else "local"
    return merge_counts(plan, [q(cur2, render_literals(sql), log) for _, sql in plan.statements])


def _kpi_row(r):
    return {"vis": r["tracked"], "n": r["answers"], "sov_n": r["own_mentions"], "sov_d": r["total_mentions"], "sp": r["sent_pos"],
            "sa": r["sent_all"], "rks": r["rank_sum"], "rkn": r["ranked"]}


def f01_core(cur, x: Ctx, log):
    if x.lo is None:
        return []
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    parts = ("mentions", "gap", "citations") + (("urls",) if x.sf == 2 else ())
    r = core_counts(cur2, x, log, parts=parts)[0]
    out = kpi_lines(x, "F01", "", _kpi_row(r), r["cit_total"], r["cit_owned"])
    out.append(V(x, "F01", "analysis_gap", int(r["gap_answers"]), int(r["gap_base"])))
    out.append(V(x, "F01", "answers", int(r["answers"]), None))
    if x.sf == 2:
        rep = report_rounds(cur2, x, [x.L] if x.kind == "latest_cycle" else [])
        if x.kind == "latest_cycle" and x.L in rep:
            den, num = rep[x.L]
            out.append(V(x, "F01", "target_rate", num, den, origin="report"))
        else:
            out.append(V(x, "F01", "target_rate", int(r["tgt_hits"]), int(r["url_den"])))
            out.append(V(x, "F01", "owned_rate", int(r["own_url_hits"]), int(r["url_den"])))
    return out


def f02_core(cur, x: Ctx, log):
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    rds = x.slots()
    if not rds:
        return []
    parts = ("mentions", "citations") + (("urls",) if x.sf == 2 else ())
    rows = {r["round_date"]: r for r in core_counts(cur2, x, log, lo=rds[0], hi=rds[-1], group_by=("round_date",), parts=parts)}
    REP = report_rounds(cur2, x, rds) if x.sf == 2 else {}
    out = []
    for d in rds:
        r = rows.get(d)
        if not r or not r["answers"]:
            continue
        out += kpi_lines(x, "F02", f"{d.isoformat()}:", _kpi_row(r), r["cit_total"], r["cit_owned"])
        if x.sf == 2:
            if d in REP:
                out.append(V(x, "F02", f"{d.isoformat()}:target_rate", REP[d][1], REP[d][0], origin="report"))
            elif r["url_den"]:
                out.append(V(x, "F02", f"{d.isoformat()}:target_rate", int(r["tgt_hits"]), int(r["url_den"])))
    return out


def f05_core(cur, x: Ctx, log):
    if x.lo is None:
        return []
    cur2 = cur.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    parts = ("mentions", "citations") if x.sf == 1 else ("mentions",)
    out = []
    for r in sorted(core_counts(cur2, x, log, group_by=("geo",), parts=parts), key=lambda r: x.d.geo_code[r["geo_key"]]):
        if not r["answers"]:
            continue
        cc = x.d.geo_code[r["geo_key"]]
        if x.sf == 1:
            out.append(V(x, "F05", f"country:{cc}:visibility", int(r["tracked"]), int(r["answers"])))
            out.append(V(x, "F05", f"country:{cc}:citation_share", int(r["cit_owned"]), int(r["cit_total"])))
        out.append(V(x, "F05", f"country:{cc}:sov", int(r["own_mentions"]), int(r["total_mentions"])))
    return out


FEATURES_SCAN = {"F01": f01, "F02": f02, "F03": f03, "F04": f04, "F05": f05, "F06": f06, "F07": f07}   # DB-v2.1 경로(인용 원소 스캔)
FEATURES = {**FEATURES_SCAN, "F01": f01_core, "F02": f02_core, "F05": f05_core}                        # DB-v2.2(G-25) 경로


def features_for(impl: str):
    return FEATURES_SCAN if impl == "scan" else FEATURES


# ── 명령 ─────────────────────────────────────────────────────────────────────
def load_combos(p, only):
    cs = json.load(open(p))
    return [c for c in cs if not only or c["id"] in only.split(",")]


def cmd_values(a):
    cn = connect(role="api_ro" if a.mode == "new" else "admin")
    cur = cn.cursor()
    dims = Dims(cur)
    feats = a.features.split(",")
    with open(a.out, "w") as fo, open(a.out + ".sql.jsonl", "w") as fs:
        for combo in load_combos(a.combos, a.only):
            x = Ctx(combo, dims, a.mode)
            for f in feats:
                log = []
                try:
                    rows = features_for(a.impl if a.mode == "new" else "scan")[f](cur, x, log)
                except Exception as e:  # noqa: BLE001
                    rows = [{"combo_id": combo["id"], "feature": f, "error": f"{type(e).__name__}: {e}"[:400]}]
                for r in rows:
                    fo.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
                fs.write(json.dumps({"combo_id": combo["id"], "feature": f, "stmts": log}, ensure_ascii=False, default=str) + "\n")
                fo.flush()
                print(combo["id"], f, len(rows), round(sum(s["ms"] for s in log), 1), "ms", flush=True)


def plan_stats(plan):
    top = plan["Plan"]
    agg = {"exec_ms": plan.get("Execution Time"), "plan_ms": plan.get("Planning Time"),
           "shared_hit": top.get("Shared Hit Blocks", 0), "shared_read": top.get("Shared Read Blocks", 0),
           "temp_read": top.get("Temp Read Blocks", 0), "temp_written": top.get("Temp Written Blocks", 0),
           "scan_rows": 0, "scan_nodes": [], "workers_planned": 0, "workers_launched": 0, "sort_disk_kb": 0, "hash_batches_max": 1}

    def walk(n):
        t = n.get("Node Type", "")
        if "Scan" in t and "Relation Name" in n:
            rows = (n.get("Actual Rows", 0) + n.get("Rows Removed by Filter", 0)) * max(n.get("Actual Loops", 1), 1)
            agg["scan_rows"] += rows
            agg["scan_nodes"].append(f"{n['Relation Name']}:{t}:{rows}")
        if t == "Gather" or t == "Gather Merge":
            agg["workers_planned"] += n.get("Workers Planned", 0)
            agg["workers_launched"] += n.get("Workers Launched", 0)
        if n.get("Sort Space Type") == "Disk":
            agg["sort_disk_kb"] += n.get("Sort Space Used", 0)
        if n.get("Hash Batches"):
            agg["hash_batches_max"] = max(agg["hash_batches_max"], n.get("Hash Batches", 1))
        for ch in n.get("Plans", []):
            walk(ch)
    walk(top)
    agg["scan_nodes"] = agg["scan_nodes"][:12]
    return agg


def run_feature_timed(cn, x, f, impl="core"):
    cur = cn.cursor()
    log = []
    t0 = time.perf_counter()
    rows = features_for(impl)[f](cur, x, log)
    ms = (time.perf_counter() - t0) * 1000
    return ms, rows, log


def cmd_latency(a):
    """조합 × 기능: 콜드 1회(새 커넥션 = 새 백엔드, 버퍼·OS 캐시는 웜일 수 있음) + 웜 N회, EXPLAIN(ANALYZE,BUFFERS) 1회."""
    cn0 = connect()
    dims = Dims(cn0.cursor())
    cn0.close()
    feats = a.features.split(",")
    os.makedirs(a.explain_dir, exist_ok=True) if a.explain_dir else None
    with open(a.out, "w") as fo, open(a.out.replace(".jsonl", "-explain.jsonl"), "w") as fe:
        for combo in load_combos(a.combos, a.only):
            x = Ctx(combo, dims, "new")
            for f in feats:
                cn = connect()
                try:
                    cn.cursor().execute("DISCARD PLANS")
                    ms, rows, log = run_feature_timed(cn, x, f, a.impl)
                    fo.write(json.dumps({"combo_id": x.id, "feature": f, "source": "new", "run": 0, "ms": round(ms, 2), "rows": len(rows),
                                         "cold": True, "stmts": len(log), "stmt_ms": [s["ms"] for s in log]}) + "\n")
                    for i in range(1, a.repeat + 1):
                        ms, rows, log2 = run_feature_timed(cn, x, f, a.impl)
                        fo.write(json.dumps({"combo_id": x.id, "feature": f, "source": "new", "run": i, "ms": round(ms, 2), "rows": len(rows),
                                             "cold": False, "stmts": len(log2), "stmt_ms": [s["ms"] for s in log2]}) + "\n")
                    fo.flush()
                    # EXPLAIN (ANALYZE, BUFFERS) — 기능이 낸 문장마다
                    cur = cn.cursor()
                    plans = []
                    for s in log:
                        cur.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + s["sql"])
                        plan = cur.fetchone()[0][0]
                        st = plan_stats(plan)
                        plans.append(st)
                        if a.explain_dir:
                            cur.execute("EXPLAIN (ANALYZE, BUFFERS) " + s["sql"])
                            txt = "\n".join(r[0] for r in cur.fetchall())
                            with open(os.path.join(a.explain_dir, f"{x.id}-{f}.txt"), "a") as ft:
                                ft.write("-- SQL\n" + s["sql"] + "\n-- PLAN\n" + txt + "\n\n")
                    fe.write(json.dumps({"combo_id": x.id, "feature": f, "plans": plans}, default=str) + "\n")
                    fe.flush()
                    print(x.id, f, "ok", flush=True)
                except Exception as e:  # noqa: BLE001
                    fo.write(json.dumps({"combo_id": x.id, "feature": f, "error": f"{type(e).__name__}: {e}"[:300]}) + "\n")
                    print(x.id, f, "ERR", e, flush=True)
                finally:
                    cn.close()


def resolve_dates(cur, x):
    """F-2 선택 가능 날짜·기준일(대시보드 첫 렌더 'dates')."""
    t0 = time.perf_counter()
    cur.execute(f"""WITH picked AS (SELECT DISTINCT round_date FROM rd.cycle WHERE surface = {x.sf} AND project_key = ANY({arr(x.pks, 'int2')})
                      AND servable AND view_date IS NOT NULL AND view_date <= {dlit(x.today)} AND hidden_scope <> ALL('{{1,3}}'::int2[])),
                    agg AS (SELECT min(round_date) f, max(round_date) l, count(*) n FROM picked)
                    SELECT p.round_date, a.f, a.l, a.n FROM picked p CROSS JOIN agg a ORDER BY p.round_date DESC LIMIT 400""")
    cur.fetchall()
    return (time.perf_counter() - t0) * 1000


def cmd_concur(a):
    """G-25: 대시보드 첫 렌더 4 API(dates·summary(F01)·compare(F07)·trend(F02))를 사용자 N명이 동시에. 사용자 1명 = 커넥션 4개 동시."""
    cn0 = connect()
    dims = Dims(cn0.cursor())
    cn0.close()
    combos = load_combos(a.combos, a.only)
    out = open(a.out, "w")
    for users in [int(u) for u in a.users.split(",")]:
        for combo in combos:
            x = Ctx(combo, dims, "new")
            for rnd in range(a.rounds + 1):
                conns = [[connect() for _ in range(4)] for _ in range(users)]
                if a.workers is not None:
                    for u in conns:
                        for cn in u:
                            cn.cursor().execute(f"SET max_parallel_workers_per_gather = {int(a.workers)}")
                res = []
                barrier = threading.Barrier(users * 4)

                def work(cn, api, u):
                    barrier.wait()
                    t0 = time.perf_counter()
                    try:
                        if api == "dates":
                            resolve_dates(cn.cursor(), x)
                        else:
                            features_for(a.impl)[{"summary": "F01", "compare": "F07", "trend": "F02"}[api]](cn.cursor(), x, [])
                        err = None
                    except Exception as e:  # noqa: BLE001
                        err = str(e)[:200]
                    res.append({"users": users, "workers": a.workers, "combo_id": x.id, "round": rnd, "user": u, "api": api,
                                "ms": round((time.perf_counter() - t0) * 1000, 2), "cold": rnd == 0, "error": err})
                ths = []
                for u in range(users):
                    for api, cn in zip(["dates", "summary", "compare", "trend"], conns[u]):
                        th = threading.Thread(target=work, args=(cn, api, u))
                        th.start()
                        ths.append(th)
                for th in ths:
                    th.join()
                for u in conns:
                    for cn in u:
                        cn.close()
                for r in res:
                    out.write(json.dumps(r) + "\n")
                out.flush()
            print("concur", users, x.id, "done", flush=True)
    out.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["values", "latency", "concur"])
    ap.add_argument("--combos", required=True)
    ap.add_argument("--mode", default="new", choices=["new", "emu"])
    ap.add_argument("--features", default="F01,F02,F03,F04,F05,F06,F07")
    ap.add_argument("--only")
    ap.add_argument("--out", required=True)
    ap.add_argument("--repeat", type=int, default=7)
    ap.add_argument("--explain-dir")
    ap.add_argument("--users", default="1,3,5")
    ap.add_argument("--rounds", type=int, default=7)
    ap.add_argument("--workers", type=int, default=None, help="concur: 세션 max_parallel_workers_per_gather (미지정 = 서버 기본)")
    ap.add_argument("--impl", default="core", choices=["core", "scan"],
                    help="F01·F02·F05 구현: core = DB-v2.2 인용 수 열(app.core.measure), scan = DB-v2.1 인용 원소 스캔")
    a = ap.parse_args()
    {"values": cmd_values, "latency": cmd_latency, "concur": cmd_concur}[a.cmd](a)


if __name__ == "__main__":
    main()
