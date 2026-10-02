"""창 해석(resolve_window): 함대 스냅샷 규칙(Q1)·기간 모드(round_date)·숨김 계열 배제(HIDDEN_EXCLUDE).

규칙(DESIGN-CONTRACT §3, DECISIONS-API Q1, 모듈-필터 §2.1)
- 후보 회차 = rd.cycle 중 surface = :sf ∧ project_key = ANY(허용 프로젝트) ∧ servable ∧ view_date ≤ 오늘(KST, R03).
- 스냅샷(from/to 없음): 후보 중 hidden_scope ≠ 1(all) 인 회차의 round_date 내림차순 (offset+1)번째 하나(함대 규칙: 허용 프로젝트 전체에
  같은 날 하나). 그 날 회차가 없는 프로젝트는 missing 으로 돌려주고 로그를 남긴다. lo = hi = 그 날.
- 기간(from/to): round_date BETWEEN from AND to 인 후보 회차 전부(G-04: 시간 축 = round_date).
- 계열별 회차 키: mentions 는 hidden {1,3}, citations 는 {1,2}, any 는 {1,2,3}, row 는 {1} 을 뺀다(core.codes.HIDDEN_EXCLUDE).
- 사실 표 질의는 Window.where(alias, family, binder) 가 내는 세 술어(surface = · round_date 범위 · cyc_key = ANY)를 반드시 함께 쓴다.
  이 셋 없이 rd.answer·answer_brand·answer_stance·citation 을 읽지 않는다(CI 경계 가드 대상).
- 기본값 없는 필수 인자: surface·project_keys·family 조합과 date_from·date_to(없으면 None 을 명시)를 키워드로 받는다.

회차 원장 조회(창이 아니라 rd.cycle 만 읽는다: 사실 표 아님, 같은 후보 술어를 기능이 다시 쓰지 않게 여기 둔다)
- resolve_recent_window: 기간 미지정 추이의 "최근 N 버킷" 창(Q9). 자리 = hidden_scope ≠ 1 ∨ hidden_reason = collection_error.
- ledger_rows: 누락 비중(Q2)·진행률 원장. 진행 중(비서빙 open)·노출일 전·계열 숨김 회차를 빼고, 발행 여부(published)를 창과 같은 술어로 싣는다.
- first_published: 계열별 전 이력 첫 발행 회차(family 필수, 기본값 없음: 계열 혼동 방지).
- selectable_round_dates: 계열 숨김을 뺀 노출 회차 날짜(DB DISTINCT, 내림차순 절단)·전체 개수·가장 이른 날짜.

현행 프로필(core.profile, WU-1 골격): resolve_window·resolve_recent_window 는 profile(기본 OFF)을 받아 스위치 자리를 표시한다
(card_slot_rep 은 카드 기간 창, trend_grid 는 추이 자리). OFF 면 문장·결과가 도입 전과 같다. 구현 전 스위치가 켜지면 NotImplementedError.
- trend_grid(WU-6 구현): resolve_trend_grid = 현행 X.trendGrid 추이 격자(원장 자리 최신 13개·자리 대표 회차·완결성 갭·끝 절단·인용 표식).
  규칙과 file:line 은 아래 '현행 추이 격자' 절.
- card_slot_rep(WU-3 구현): resolve_window(card=True, from·to) = 현행 대시보드 카드 기간 창(자리마다 대표 회차 하나, card_period_keys).
  격자와 같은 자리 판정(pick_slot)을 기간 안 자리 전부에 건다.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from typing import Any, Literal

from app.core.codes import CYCLE_STATUS, HIDDEN_EXCLUDE, HIDDEN_REASON, SURFACE_CODE
from app.core.profile import OFF, LegacyProfile, require_slot
from app.core.sqlb import Binder

log = logging.getLogger("hgh.cycles")

WindowMode = Literal["snapshot", "cumulative"]
FAMILIES = ("mentions", "citations", "any", "row")


Bucket = Literal["cycle", "week", "month"]


@dataclass(frozen=True)
class CycleRow:
    cyc_key: int
    project_key: int
    round_date: date
    hidden_scope: int
    hidden_reason: int = 0          # 0 없음 1 collection_error 2 operator(core.codes.HIDDEN_REASON)

    @property
    def is_slot(self) -> bool:
        """추이 자리(T-1 R11): 운영자 전체 숨김은 자리가 아니고, 수집 오류 전체 숨김은 갭 자리로 남는다."""
        return self.hidden_scope != 1 or self.hidden_reason == HIDDEN_REASON["collection_error"]


@dataclass(frozen=True)
class Window:
    """해석된 창. keys[family] 는 그 계열에서 쓸 회차 키(정렬), round_dates 는 meta.cycles 용 날짜(row 계열)."""
    surface: str
    sf: int
    mode: WindowMode
    lo: date | None
    hi: date | None
    keys: dict[str, tuple[int, ...]]
    round_dates: tuple[date, ...]
    as_of: date | None
    generation: int | None
    missing_project_keys: tuple[int, ...] = ()
    missing_project_ids: tuple[str, ...] = ()
    cycles: tuple[CycleRow, ...] = field(default=(), repr=False)
    # 숨김 판정용 계열 키(현행 프로필 card_slot_rep 이 keys 를 자리 대표로 좁힌 창만 싣는다, 나머지는 None = keys).
    # 자리 대표 좁힘은 값 정의이지 숨김이 아니므로 hidden·partially_hidden(억제 사유)은 좁히기 전 키로 판정한다(현행 카드는 대표 밖 회차를 조용히 뺀다).
    hidden_basis: dict[str, tuple[int, ...]] | None = field(default=None, repr=False)
    # 동결 층 창 판정(S4, frz_judge): None = 판정 대상 아님(동결 읽기 스위치 끔·비카드·project), True = 창 회차 전부 동결(동결 읽기),
    # False = 세대 없는 발행 회차(구멍)가 있거나 쓸 회차가 없다(현행 요청 전체 미러 폴백 → ReadContext.bind_frozen 이 card=False 로 내린다)
    frz: bool | None = None

    @property
    def empty(self) -> bool:
        return self.lo is None or not self.keys.get("row")

    def cyc_keys(self, family: str) -> tuple[int, ...]:
        if family not in FAMILIES:
            raise ValueError(f"알 수 없는 계열: {family}")
        return self.keys.get(family, ())

    def _basis(self, family: str) -> tuple[int, ...]:
        if self.hidden_basis is None:
            return self.cyc_keys(family)
        if family not in FAMILIES:
            raise ValueError(f"알 수 없는 계열: {family}")
        return self.hidden_basis.get(family, ())

    def hidden(self, family: str) -> bool:
        """창에 회차는 있는데 이 계열에서 전부 숨김이면 True(지표 억제 사유 'hidden')."""
        return bool(self.cycles) and not self._basis(family)

    def partially_hidden(self, family: str) -> bool:
        """창의 행 회차 일부만 이 계열에서 숨김이면 True(억제 사유 'partial_hidden': 남은 회차 값만 나온다)."""
        rows = set(self._basis("row"))
        kept = rows & set(self._basis(family))
        return bool(kept) and kept != rows

    def all_keys(self) -> tuple[int, ...]:
        """창 후보 회차 전부(숨김 무관). 카탈로그 측정 메타처럼 숨김 게이트를 걸지 않는 현행 패리티 전용."""
        return tuple(sorted({r.cyc_key for r in self.cycles}))

    def hidden_reason_of(self, cyc_key: int) -> int:
        """창 회차의 숨김 사유 코드(없는 키는 0)."""
        return next((r.hidden_reason for r in self.cycles if r.cyc_key == cyc_key), 0)

    def union_keys(self, *families: str) -> tuple[int, ...]:
        s: set[int] = set()
        for f in families:
            s.update(self.cyc_keys(f))
        return tuple(sorted(s))

    def where(self, alias: str, family: str, b: Binder, *, keys: tuple[int, ...] | None = None) -> list[str]:
        """사실 표 필수 술어 3개. keys 를 주면 그 회차 키 집합(계열 합집합 등)을 쓴다."""
        if self.lo is None or self.hi is None:
            return ["false"]
        ks = self.cyc_keys(family) if keys is None else keys
        w = [f"{alias}.surface = {b.v(self.sf, 'int2')}"]
        if self.lo == self.hi:
            w.append(f"{alias}.round_date = {b.date(self.lo)}")
        else:
            w.append(f"{alias}.round_date BETWEEN {b.date(self.lo)} AND {b.date(self.hi)}")
        w.append(f"{alias}.cyc_key = ANY({b.ints(ks, 'int4')})")
        return w


def build_window(*, surface: str, mode: WindowMode, rows: list[CycleRow], lo: date | None, hi: date | None,
                 generation: int | None, project_keys: tuple[int, ...], project_ids: dict[int, str] | None = None) -> Window:
    """후보 회차 행(이미 창 날짜로 좁힌 것)에서 계열별 키를 만든다(순수 함수: 단위 테스트 대상)."""
    sf = SURFACE_CODE[surface]
    keys = {f: tuple(sorted({r.cyc_key for r in rows if r.hidden_scope not in HIDDEN_EXCLUDE[f]})) for f in FAMILIES}
    rds = tuple(sorted({r.round_date for r in rows if r.hidden_scope not in HIDDEN_EXCLUDE["row"]}))
    as_of = rds[-1] if rds else None
    missing: tuple[int, ...] = ()
    if mode == "snapshot" and lo is not None:
        present = {r.project_key for r in rows if r.hidden_scope not in HIDDEN_EXCLUDE["row"]}
        missing = tuple(sorted(set(project_keys) - present))
    ids = tuple(project_ids[k] for k in missing if project_ids and project_ids.get(k)) if missing else ()
    if not rows and mode == "snapshot":
        lo = hi = None
    return Window(surface=surface, sf=sf, mode=mode, lo=lo, hi=hi, keys=keys, round_dates=rds, as_of=as_of,
                  generation=generation, missing_project_keys=missing, missing_project_ids=ids, cycles=tuple(rows))


# 후보 회차 술어(R01 servable · R03 view_date ≤ 오늘 KST). 아래 문장들이 같은 조각을 쓴다(한 곳에서만 고친다).
# ungated=True 면 게이트 없이 그 표면·프로젝트의 측정 회차 전부(발행·노출일 무관): 카탈로그 측정 메타 현행 패리티(catalog #11,
# front website-sites.ts:386-407 websitePromptLens 는 앵커 축 기본 off 에서 a.status = completed + 기간만 건다). 숨김은 호출자가
# Window.cycles 전부를 keys 로 넘겨 무시한다(Window.all_keys).
_CAND = ("c.surface = CAST(:sf AS int2) AND c.project_key = ANY(CAST(:pks AS int2[])) AND c.servable\n"
         "   AND c.view_date IS NOT NULL AND c.view_date <= coalesce(CAST(:today AS date), rd.today_kst())")
_CAND_UNGATED = "c.surface = CAST(:sf AS int2) AND c.project_key = ANY(CAST(:pks AS int2[]))"
# 현행 프로필 compare_cycle_set(WU-12, 글로벌 기간 비교 전용): 발행 = 원장 status published ∧ 노출일 ≤ 오늘, 함대 가시성(servable 의 fleet_visible) 무관.
# 현행 summary-period-compare.ts:218-236 ledgerScopeConds 는 fleet_visible 을 웹사이트에만 건다(글로벌 자리 병합 비서빙 회차도 발행으로 센다).
_PUB_FLEET_ANY = f"(c.servable OR c.status = {CYCLE_STATUS['published']})"
_CAND_FLEET_ANY = ("c.surface = CAST(:sf AS int2) AND c.project_key = ANY(CAST(:pks AS int2[])) AND " + _PUB_FLEET_ANY + "\n"
                   "   AND c.view_date IS NOT NULL AND c.view_date <= coalesce(CAST(:today AS date), rd.today_kst())")
_GEN = "(SELECT generation FROM rd.surface_generation g WHERE g.surface = CAST(:sf AS int2))"


def _snapshot_sql(cand: str) -> str:
    return f"""
WITH cand AS (
  SELECT c.cyc_key, c.project_key, c.round_date, c.hidden_scope, c.hidden_reason
    FROM rd.cycle c
   WHERE {cand}),
d AS (SELECT DISTINCT round_date FROM cand WHERE hidden_scope <> 1 ORDER BY round_date DESC LIMIT CAST(:n AS int4)),
pick AS (SELECT CASE WHEN (SELECT count(*) FROM d) = CAST(:n AS int4) THEN (SELECT min(round_date) FROM d) END AS rd)
SELECT cand.cyc_key, cand.project_key, cand.round_date, cand.hidden_scope, cand.hidden_reason, {_GEN} AS generation
  FROM cand JOIN pick ON cand.round_date = pick.rd
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, {_GEN}
"""


def _range_sql(cand: str) -> str:
    return f"""
SELECT c.cyc_key, c.project_key, c.round_date, c.hidden_scope, c.hidden_reason, {_GEN} AS generation
  FROM rd.cycle c
 WHERE {cand}
   AND c.round_date BETWEEN CAST(:lo AS date) AND CAST(:hi AS date)
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, {_GEN}
"""


_SNAPSHOT_SQL = _snapshot_sql(_CAND)
# 동결 층(freeze_at_publish, S3) 카드 스냅샷: 후보 = 활성 동결 세대가 있는 회차(현행 pickGlobalCycle·pickWebsiteCycles 의
# active_generation_id IS NOT NULL, summary-cycles.ts:225-245). 동결 회차가 하나도 없으면 종전 후보(현행: 세대 없음 = 미러 폴백 = 최신 회차 라이브)
_SNAPSHOT_SQL_FRZ = _snapshot_sql(_CAND).replace(
    "WITH cand AS (\n  SELECT c.cyc_key, c.project_key, c.round_date, c.hidden_scope, c.hidden_reason\n    FROM rd.cycle c\n   WHERE " + _CAND + "),",
    "WITH cand0 AS (\n  SELECT c.cyc_key, c.project_key, c.round_date, c.hidden_scope, c.hidden_reason\n    FROM rd.cycle c\n   WHERE " + _CAND + "),\n"
    "fz AS (SELECT * FROM cand0 x WHERE EXISTS (SELECT 1 FROM frz.generation g WHERE g.cyc_key = x.cyc_key AND g.state = 'active')),\n"
    "cand AS (SELECT * FROM fz UNION ALL SELECT * FROM cand0 WHERE NOT EXISTS (SELECT 1 FROM fz)),")
assert _SNAPSHOT_SQL_FRZ != _SNAPSHOT_SQL

# 동결 층 창 판정(S4). 활성 동결 세대가 있는 회차 키(사실 표 아님: frz.generation 만 읽는다)
_FRZ_ACTIVE_SQL = ("SELECT coalesce(array_agg(g.cyc_key), '{}') AS ks FROM frz.generation g "
                   "WHERE g.state = 'active' AND g.cyc_key = ANY(CAST(:ks AS int4[]))")


def frz_eligible(profile: LegacyProfile, *, surface: str, card: bool, ungated: bool = False) -> bool:
    """이 창 해석이 동결 판정 대상인가: freeze_at_publish ∧ 카드 요청 ∧ global·website ∧ 게이트 있는 창(core.facts.frozen_read 와 같은 조건)."""
    return bool(profile.freeze_at_publish) and card and not ungated and surface in ("global", "website")


async def frozen_keys(conn: Any, keys: Any) -> frozenset[int]:
    """키 중 활성 동결 세대가 있는 회차 키."""
    from app.core.db import fetch_one

    ks = sorted({int(k) for k in keys})
    if not ks:
        return frozenset()
    r = await fetch_one(conn, _FRZ_ACTIVE_SQL, {"ks": ks})
    return frozenset(int(k) for k in (r["ks"] if r else ()) or ())


def frz_judge(rows: Any, frozen: frozenset[int]) -> bool:
    """현행 판정(lib/summary/read/cycle-set.ts:345-357 classifyCycleRange·:400-401 judgeCycleRange)의 허브 대응(순수 함수).
    rows = 창 후보 회차(허브 후보 = 발행·노출일 지남 = 현행 renderable 의 세대 외 조건). 현행 구멍 = 노출 가능인데 세대 없음 ∧ 숨김 아님
    (숨김 회차는 범위 무관 면제), 쓸 회차(usable) = 세대 있음 ∧ 회차 전체 숨김 아님(허브 hidden_scope 1·3 = 현행 'all'). 구멍이 하나라도
    있거나 쓸 회차가 없으면(현행 빈 집합) 거짓 = 요청 전체 미러 폴백."""
    rows = list(rows)
    if any(r.hidden_scope == 0 and r.cyc_key not in frozen for r in rows):
        return False
    return any(r.cyc_key in frozen and r.hidden_scope not in (1, 3) for r in rows)


# 현행 생성기 갭 상한(hmg-geo 2670a16 lib/summary/read/analysis-gap.ts:20 ANALYSIS_GAP_MAX, 생성기 --pending 술어 generate/cycle.ts:288)
ANALYSIS_GAP_MAX = "0.05"
# 생성 대기 구멍(DB-v2.30): 현행 구멍 중 허브 창 후보(servable ∧ 노출일)에 오지 않는 것 = 닫힘 ∧ 생성기가 뽑을 갭(≤ 상한, NULL 아님) ∧ 세대 없음.
# 현행 classifyCycleRange(cycle-set.ts:345-357): 비렌더 ∧ status ∉ {open, generating} ∧ 노출 대기 아님 ∧ 면제(숨김 ∨ isGeneratorSkipped
# :967-971) 아님. 현행 기간 행은 웹만 fleet_visible 술어(summary-cycles.ts:558), 글로벌은 모든 회차. 허브 대응:
#   status 1(closed) ∧ 원장 회차(ledger_backed: 파생 회차는 현행 원장에 없다) ∧ 숨김 아님 ∧ (웹이면 함대 가시) ∧ 판정 갭 ≤ 상한
#   ∧ 현행 상태 generating 아님(이관 투영이 closed 로 접은 재생성 중 회차, 현행은 구멍 아님) ∧ 활성 동결 세대 없음.
# 함대 가시·판정 갭 = rd.cycle_pick_basis(현행 cycleFleetSql 재계산, 이관 회차 갭 = 현행 원값). 기간 경계는 창 후보와 같은 round_date.
_PICK_HOLE_SQL = f"""
SELECT EXISTS (
  SELECT 1 FROM rd.cycle c JOIN rd.cycle_pick_basis p ON p.cyc_key = c.cyc_key
   WHERE c.surface = CAST(:sf AS int2) AND c.project_key = ANY(CAST(:pks AS int2[])) AND c.status = {CYCLE_STATUS['closed']}
     AND c.ledger_backed AND c.hidden_scope = 0
     AND c.round_date >= CAST(:lo AS date) AND c.round_date <= coalesce(CAST(:hi AS date), rd.today_kst())
     AND (c.surface <> {SURFACE_CODE['website']} OR p.fleet_visible)
     AND p.gap_ratio <= CAST(:gmax AS numeric) AND p.ops_status IS DISTINCT FROM 'generating'
     AND NOT EXISTS (SELECT 1 FROM frz.generation g WHERE g.cyc_key = c.cyc_key AND g.state = 'active')) AS hole
"""


async def pick_holes(conn: Any, *, sf: int, pks: Any, lo: date | None, hi: date | None) -> bool:
    """[lo, hi](hi 없음 = 오늘 KST) 창에 생성 대기 구멍(현행 judgeCycleRange 구멍, 허브 후보 밖)이 있나. lo 가 없으면(빈 창) 거짓."""
    from app.core.db import fetch_val

    if lo is None:
        return False
    return bool(await fetch_val(conn, _PICK_HOLE_SQL, {"sf": sf, "pks": sorted({int(k) for k in pks}), "lo": lo, "hi": hi,
                                                       "gmax": ANALYSIS_GAP_MAX}))
_RANGE_SQL = _range_sql(_CAND)
# 카드 자리 대표(card_slot_rep)용 기간 문장: _RANGE_SQL 과 같은 후보·범위에 자리 대표 사다리 입력(앵커일·cycle_id·완결성 카운터)을 더 싣는다
_CARD_RANGE_SQL = f"""
SELECT c.cyc_key, c.project_key, c.round_date, c.hidden_scope, c.hidden_reason, {_GEN} AS generation,
       c.anchor_date, c.cycle_id::text AS cycle_id, c.expected_units, c.completed_units, c.completed_answers
  FROM rd.cycle c
 WHERE {_CAND}
   AND c.round_date BETWEEN CAST(:lo AS date) AND CAST(:hi AS date)
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, {_GEN}, NULL, NULL, NULL, NULL, NULL
"""
_SNAPSHOT_SQL_UNGATED = _snapshot_sql(_CAND_UNGATED)
_RANGE_SQL_UNGATED = _range_sql(_CAND_UNGATED)
_RANGE_SQL_FLEET_ANY = _range_sql(_CAND_FLEET_ANY)
ALL_VISIBLE_LO = date(1900, 1, 1)       # 가시 회차 전부 창의 조회 하한·상한(실날짜: asyncpg 가 date.min·max 를 ±infinity 로 보낸다)
ALL_VISIBLE_HI = date(2999, 12, 31)

# 최근 N 버킷: 자리 회차(hidden_scope ≠ 1 ∨ 수집 오류 숨김)의 버킷 키 상위 N 개 → 하한 이후 후보 회차 전부
_BUCKET_EXPR = {"cycle": "c.round_date", "week": "date_trunc('week', c.round_date)::date",
                "month": "date_trunc('month', c.round_date)::date"}
_RECENT_SQL = """
WITH b AS (SELECT DISTINCT {bucket} AS k
             FROM rd.cycle c
            WHERE {cand} AND (c.hidden_scope <> 1 OR c.hidden_reason = CAST(:cerr AS int2))
            ORDER BY 1 DESC LIMIT CAST(:n AS int4)),
lo AS (SELECT min(k) AS lo FROM b)
SELECT c.cyc_key, c.project_key, c.round_date, c.hidden_scope, c.hidden_reason, {gen} AS generation
  FROM rd.cycle c, lo
 WHERE {cand} AND c.round_date >= lo.lo
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, {gen}
"""


async def resolve_window(conn: Any, *, surface: str, project_keys: tuple[int, ...] | list[int], date_from: date | None,
                         date_to: date | None, offset: int = 0, today: date | None = None,
                         project_ids: dict[int, str] | None = None, ungated: bool = False,
                         all_visible: bool = False, profile: LegacyProfile = OFF, card: bool = False,
                         fleet_any: bool = False) -> Window:
    """창 해석. conn = SQLAlchemy AsyncConnection(요청 트랜잭션). today 는 테스트·대조용 고정값(기본 rd.today_kst()).

    date_from·date_to 는 둘 다 있거나 둘 다 None(CommonFilters 가 422 로 강제). offset 은 스냅샷에서만(0 최신, 1 직전).
    all_visible=True: from·to 가 없을 때 스냅샷(1회차) 대신 가시 회차 전부(누적 창, lo·hi = 실제 가시 회차 최소·최대). 카탈로그 측정 메타용.
    ungated=True: 발행(servable)·노출일(view_date) 게이트를 뺀다(측정 회차 전부). 카탈로그 측정 메타 현행 패리티 전용이며
      지표(분자·분모)에는 쓰지 않는다(계약 §3 R01·R03). 숨김까지 무시하려면 where(keys=win.all_keys()).
    card=True: 대시보드 카드 경로 요청(CommonFilters.card). 현행 프로필 card_slot_rep(R04CIT, WU-3)이 켜져 있고 from·to 가 있는
      global·website 창이면 계열 키를 자리 대표로 좁힌다(card_period_keys). 숨김 억제 판정은 좁히기 전 키(Window.hidden_basis).
    fleet_any=True: 기간 창(from·to)의 후보 = 원장 발행(status published) ∧ 노출일 ≤ 오늘, 함대 가시성 무관(_CAND_FLEET_ANY).
      현행 프로필 compare_cycle_set(WU-12) 의 글로벌 기간 비교 전용. card·ungated 와 함께 쓰지 않는다(그때는 무시).
    """
    from app.core.db import fetch_all

    require_slot(profile, "card_slot_rep", "freeze_at_publish")

    if surface not in SURFACE_CODE:
        raise ValueError(f"알 수 없는 표면: {surface}")
    if (date_from is None) != (date_to is None):
        raise ValueError("date_from·date_to 는 둘 다 있거나 둘 다 없어야 한다")
    if offset not in (0, 1):
        raise ValueError("offset 은 0|1")
    pks = tuple(sorted({int(k) for k in project_keys}))
    sf = SURFACE_CODE[surface]
    fz = frz_eligible(profile, surface=surface, card=card, ungated=ungated) and not all_visible
    snap_sql, range_sql = (_SNAPSHOT_SQL_UNGATED, _RANGE_SQL_UNGATED) if ungated else (_SNAPSHOT_SQL, _RANGE_SQL)
    if all_visible and date_from is None:
        rs = await fetch_all(conn, range_sql, {"sf": sf, "pks": list(pks), "today": today, "lo": ALL_VISIBLE_LO, "hi": ALL_VISIBLE_HI})
        mode: WindowMode = "cumulative"
    elif date_from is None:
        if fz:
            snap_sql = _SNAPSHOT_SQL_FRZ             # 동결 층 카드 스냅샷(S3): 최신 동결 회차
        rs = await fetch_all(conn, snap_sql, {"sf": sf, "pks": list(pks), "today": today, "n": offset + 1})
        mode = "snapshot"
    else:
        if date_from > date_to:  # type: ignore[operator]
            raise ValueError("date_from ≤ date_to")
        slot_rep = profile.card_slot_rep and card and not ungated and surface in GRID_RULES
        if fleet_any and not slot_rep and not ungated:
            range_sql = _RANGE_SQL_FLEET_ANY
        rs = await fetch_all(conn, _CARD_RANGE_SQL if slot_rep else range_sql,
                             {"sf": sf, "pks": list(pks), "today": today, "lo": date_from, "hi": date_to})
        mode = "cumulative"
        if slot_rep:
            generation = rs[-1]["generation"] if rs else None
            gcs = [GridCycle(int(r["cyc_key"]), str(r["cycle_id"]), int(r["project_key"]), r["round_date"], r["anchor_date"],
                             int(r["hidden_scope"]), int(r["hidden_reason"] or 0), True, r["expected_units"], r["completed_units"],
                             r["completed_answers"]) for r in rs if r["cyc_key"] is not None]
            judged: bool | None = None
            if fz:
                # 동결 판정(S4). 통과하면 현행 집합(usable = 세대 있는 회차)처럼 세대 없는 (숨김) 회차를 자리 대표 후보에서 뺀다
                frozen = await frozen_keys(conn, [c.cyc_key for c in gcs])
                judged = frz_judge([c.row() for c in gcs], frozen)
                if judged and await pick_holes(conn, sf=sf, pks=pks, lo=date_from, hi=date_to):
                    judged = False                       # 생성 대기 구멍(현행 judgeCycleRange, DB-v2.30)
                if judged:
                    gcs = [c for c in gcs if c.cyc_key in frozen]
            base = build_window(surface=surface, mode=mode, rows=[c.row() for c in gcs], lo=date_from, hi=date_to,
                                generation=generation, project_keys=pks, project_ids=project_ids)
            return replace(base, keys=card_period_keys(surface, gcs), hidden_basis=dict(base.keys), frz=judged)
    generation = rs[-1]["generation"] if rs else None
    rows = _rows(rs)
    judged = None
    if fz:
        frozen = await frozen_keys(conn, [r.cyc_key for r in rows])
        judged = frz_judge(rows, frozen)
        if judged and mode == "cumulative" and await pick_holes(conn, sf=sf, pks=pks, lo=date_from, hi=date_to):
            judged = False                               # 생성 대기 구멍(현행 judgeCycleRange 는 기간 창만, DB-v2.30)
        if judged:
            rows = [r for r in rows if r.cyc_key in frozen]      # 현행 usable: 세대 없는 (숨김) 회차는 집합 밖
    if mode == "snapshot":
        lo = hi = rows[0].round_date if rows else None
    elif all_visible and date_from is None:
        rds = [r.round_date for r in rows]
        lo, hi = (min(rds), max(rds)) if rds else (None, None)
    else:
        lo, hi = date_from, date_to
    w = build_window(surface=surface, mode=mode, rows=rows, lo=lo, hi=hi, generation=generation, project_keys=pks,
                     project_ids=project_ids)
    if w.missing_project_keys:
        log.info("fleet snapshot %s %s: 결손 프로젝트 %d", surface, lo, len(w.missing_project_keys))
    return replace(w, frz=judged) if judged is not None else w


def _rows(rs: list[dict[str, Any]]) -> list[CycleRow]:
    return [CycleRow(int(r["cyc_key"]), int(r["project_key"]), r["round_date"], int(r["hidden_scope"]), int(r["hidden_reason"] or 0))
            for r in rs if r["cyc_key"] is not None]


def _check(surface: str, project_keys: tuple[int, ...] | list[int]) -> tuple[int, list[int]]:
    if surface not in SURFACE_CODE:
        raise ValueError(f"알 수 없는 표면: {surface}")
    return SURFACE_CODE[surface], sorted({int(k) for k in project_keys})


def bucket_start(d: date, bucket: str) -> date:
    """버킷 키(core.measure GROUPS 와 같은 규칙): cycle = 그 날, week = date_trunc('week') = ISO 월요일, month = 1일."""
    if bucket == "week":
        return d - timedelta(days=d.weekday())
    if bucket == "month":
        return d.replace(day=1)
    if bucket == "cycle":
        return d
    raise ValueError(f"알 수 없는 버킷: {bucket}")


async def resolve_recent_window(conn: Any, *, surface: str, project_keys: tuple[int, ...] | list[int], n: int, bucket: Bucket,
                                today: date | None = None, project_ids: dict[int, str] | None = None,
                                profile: LegacyProfile = OFF, card: bool = False) -> Window:
    """기간 미지정 추이의 기본 창(Q9: 최근 N 버킷). 버킷 = cycle(round_date)·week(ISO 월요일)·month(1일), core.measure GROUPS 와 같은 규칙.
    자리 회차(CycleRow.is_slot)의 버킷 상위 n 개의 가장 이른 버킷 시작일부터 후보 회차 전부를 담은 누적 창을 돌려준다(hi = 그중 최대 round_date).
    자리가 없으면 lo = hi = None 인 빈 누적 창.
    profile.trend_grid(XAXIS_G·XAXIS_W, WU-6) ∧ bucket=cycle ∧ global·website 면 현행 추이 격자 창(resolve_trend_grid: 원장 자리 최신 13개,
    자리 대표 회차만 계열 키로)을 돌려준다(n 은 무시한다: 현행 자리 수는 TREND_GRID_SLOTS 상수). 격자 밖 조합은 아래 새 정의 그대로."""
    from app.core.db import fetch_all

    require_slot(profile, "trend_grid")
    fz = frz_eligible(profile, surface=surface, card=card)
    if profile.trend_grid and bucket == "cycle" and surface in GRID_RULES:
        return (await resolve_trend_grid(conn, surface=surface, project_keys=project_keys, date_from=None, date_to=None, today=today,
                                         project_ids=project_ids, frz=fz)).window
    if bucket not in _BUCKET_EXPR:
        raise ValueError(f"알 수 없는 버킷: {bucket}")
    if n < 1:
        raise ValueError("n ≥ 1")
    sf, pks = _check(surface, project_keys)
    sql = _RECENT_SQL.format(bucket=_BUCKET_EXPR[bucket], cand=_CAND, gen=_GEN)
    rs = await fetch_all(conn, sql, {"sf": sf, "pks": pks, "today": today, "n": n, "cerr": HIDDEN_REASON["collection_error"]})
    generation = rs[-1]["generation"] if rs else None
    rows = _rows(rs)
    first_slot = min((r.round_date for r in rows if r.is_slot), default=None)
    lo = None if first_slot is None else bucket_start(first_slot, bucket)   # = SQL 의 min(k)
    hi = max((r.round_date for r in rows), default=None)
    if lo is None:
        rows, hi = [], None
    judged = None
    if fz:                                           # 동결 판정(S4): 최근 N 버킷 창 회차 전부
        frozen = await frozen_keys(conn, [r.cyc_key for r in rows])
        judged = frz_judge(rows, frozen)
        if judged and await pick_holes(conn, sf=sf, pks=pks, lo=lo, hi=hi):
            judged = False                               # 생성 대기 구멍(DB-v2.30)
        if judged:
            rows = [r for r in rows if r.cyc_key in frozen]
    w = build_window(surface=surface, mode="cumulative", rows=rows, lo=lo, hi=hi, generation=generation, project_keys=tuple(pks),
                     project_ids=project_ids)
    return replace(w, frz=judged) if judged is not None else w


# ════════════════════════════════════════════════════════════════════════════
# 현행 추이 격자(프로필 trend_grid, XAXIS_G·XAXIS_W, WU-6). 운영 hmg-geo 2670a16 + read_screens X.trendGrid 의 재현
# ════════════════════════════════════════════════════════════════════════════
# 현행 규칙(file:line 은 hmg-geo 2670a16 front, 허브 벤더 사본 front/ 와 같다)
#   자리 목록   lib/db/repositories/trend-grid-slots.ts:192-229 trendGridSlotSql: 원장 회차(상태 무관)를 round_date 로 묶어
#               서빙 가능(노출일 ∧ 발행 ∧ 함대 ∧ 숨김 아님, 대시보드 추이 계열 'all' = 숨김 범위 무관) 수·수집 오류 수·운영 숨김 수·
#               귀속(앵커 표 행) 수를 센다. 창 = 오늘(KST) − 180일 이후(trend-grid.ts:62 TREND_GRID_MAX_DAYS).
#   자리 판정   lib/period/trend-grid.ts:125-149 toTrendSlots: 서빙 가능 0 ∧ 귀속 0 → 자리 아님, 서빙 가능 0 ∧ 수집 오류 0 ∧ 운영 숨김뿐 →
#               자리 아님, 서빙 가능 0 → 갭(수집 오류 있으면 hidden-collection-error, 아니면 not-published).
#   창          trend-grid.ts:288-331 buildTrendGrid: 기간(from·to) 안으로 좁힘 → 같은 주 접기(글로벌·웹은 무동작) →
#               끝쪽 not-published 절단(trend-grid-axis.ts:81-87) → 최신 13자리(trend-grid.ts:56·155-161).
#   자리 대표   lib/summary/read/cycle-set.ts:267-346 restrictToSlotRepresentative: 그룹(글로벌 = 자리, 웹 = (프로젝트, 자리),
#               server.ts:4880-4895 websiteSlotRestrictedSet perProject) 마다 언급 대표 = 함대 노출 → 완결성 0.9 통과 → 늦은 앵커 →
#               cycleId 최대(인용 전용 숨김은 보지 않는다), 인용 대표 = 인용 숨김 회차를 뺀 같은 사다리.
#   완결성 갭   cycle-set.ts:126-162 restrictToCompleteCycles(글로벌만, server.ts:3010 viaGlobalSeries → restrictToTrendSlotSet):
#               자리 대표의 완결성(completed/expected, 5자리 반올림, cycle-completion.ts:50-62)이 0.9(cycle-completion.ts:35) 미만이면
#               자리 전체 갭(모르면 갭 아님, :90-97). 웹사이트는 완결성을 보지 않는다(server.ts:4868-4873 머리 주석).
#   인용 표식   lib/summary/read/trend-gaps.ts:336-409 withTrendGapBuckets ② 패스: 자리에 수집 오류 인용 숨김 회차가 있으면(같은 자리의
#               수집 오류 전체 숨김이 있으면 'all' 이 이겨 표식 없음, :103-106 widen) 인용 계열 두 필드를 비우고 갭 표식. 운영 숨김은 표식 없음(:83).
# 허브 대응
#   서빙 가능   = rd.cycle.servable(발행 ∧ 함대, ingest/cycles/ledger/queries.py:21) ∧ view_date ≤ 오늘 ∧ hidden_scope = 0.
#               함대 노출은 servable 에 이미 들어 있어 대표 사다리의 ⓪ 단계는 후보 술어로 흡수된다.
#   귀속        현행 앵커 표 행 = 완료 답변이 있는 회차. 허브는 모든 회차에 round_date 가 있으므로 completed_answers > 0 을 대리로 쓴다.
#   늦은 앵커   현행 cycle_anchor_at(시각). rd.cycle 에는 anchor_date(날짜)만 있어 같은 날 두 앵커는 cycle_id 문자열 최대로 가른다.
TREND_GRID_SLOTS = 13            # trend-grid.ts:56
TREND_GRID_MAX_DAYS = 180        # trend-grid.ts:62
TREND_COMPLETION_MIN = 0.9       # cycle-completion.ts:35


@dataclass(frozen=True)
class GridRule:
    """표면별 현행 격자 규칙: per_project = 자리 대표 그룹을 (프로젝트, 자리)로, completion = 완결성 갭 적용."""
    per_project: bool
    completion: bool


GRID_RULES: dict[str, GridRule] = {"global": GridRule(per_project=False, completion=True),     # viaGlobalSeries
                                   "website": GridRule(per_project=True, completion=False)}    # websiteSlotRestrictedSet


@dataclass(frozen=True)
class GridCycle:
    """격자 판정용 원장 회차 한 행(rd.cycle). cand = 창 후보(servable ∧ 노출일 ≤ 오늘, 숨김 무관)."""
    cyc_key: int
    cycle_id: str
    project_key: int
    round_date: date
    anchor_date: date
    hidden_scope: int
    hidden_reason: int
    cand: bool
    expected_units: int | None = None
    completed_units: int | None = None
    completed_answers: int | None = None

    @property
    def ratio(self) -> float | None:
        """완결성(cycle-completion.ts:50-62 completionRatioFromUnits): 기대 유닛이 없거나 0 이하·완료 NULL 이면 모른다(None), 5자리 반올림."""
        if self.expected_units is None or self.completed_units is None or not self.expected_units > 0:
            return None
        return round(self.completed_units / self.expected_units * 1e5) / 1e5

    @property
    def complete(self) -> bool:
        """임계 통과(모르면 통과: cycle-completion.ts:90-97 slotIsIncomplete 의 '모르면 갭이 아니다')."""
        r = self.ratio
        return r is None or r >= TREND_COMPLETION_MIN

    @property
    def servable(self) -> bool:
        """현행 자리 SQL 의 servable(계열 'all': 숨김 범위 무관하게 숨긴 회차는 서빙 불가)."""
        return self.cand and self.hidden_scope == 0

    @property
    def assigned(self) -> bool:
        return (self.completed_answers or 0) > 0

    def row(self) -> CycleRow:
        return CycleRow(self.cyc_key, self.project_key, self.round_date, self.hidden_scope, self.hidden_reason)


@dataclass(frozen=True)
class GridSlot:
    """격자 한 자리. gap = None(서빙 가능) | 'collection_error'(수집 오류로 숨긴 회차뿐) | 'not_published'(미발행·진행 중·노출일 전)."""
    round_date: date
    cycles: tuple[GridCycle, ...]
    gap: str | None


def grid_slots(cycles: list[GridCycle], *, date_from: date | None = None, date_to: date | None = None,
               n: int = TREND_GRID_SLOTS) -> list[GridSlot]:
    """원장 회차 → 현행 격자 자리(오름차순). toTrendSlots → 기간 좁힘 → 끝쪽 미발행 절단 → 최신 n 자리(순서가 계약: trend-grid.ts:300-320).
    같은 주 접기(collapseSameWeekSlots)는 글로벌(월요일)·웹사이트(금요일) 좌석이 주당 하나라 무동작이므로 두지 않는다."""
    by: dict[date, list[GridCycle]] = {}
    for c in cycles:
        by.setdefault(c.round_date, []).append(c)
    out: list[GridSlot] = []
    for d in sorted(by):
        cs = by[d]
        renderable = any(c.servable for c in cs)
        if not renderable and not any(c.assigned for c in cs):
            continue                                                            # 원장 귀속 없는 후보(trend-grid.ts:130)
        coll_err = sum(1 for c in cs if c.hidden_scope != 0 and c.hidden_reason == HIDDEN_REASON["collection_error"])
        operator = sum(1 for c in cs if c.hidden_reason == HIDDEN_REASON["operator"])
        if not renderable and coll_err == 0 and operator >= len(cs):
            continue                                                            # 운영 숨김뿐인 자리(trend-grid.ts:132)
        gap = None if renderable else ("collection_error" if coll_err else "not_published")
        if (date_from is None or d >= date_from) and (date_to is None or d <= date_to):
            out.append(GridSlot(d, tuple(sorted(cs, key=lambda c: c.cyc_key)), gap))
    while out and out[-1].gap == "not_published":                               # trimTrailingUnpublished
        out.pop()
    return out[-n:] if n > 0 else []


def _later(cs: list[GridCycle]) -> GridCycle:
    """늦은 앵커 → cycle_id 최대(cycle-set.ts:189-192 laterPick). 완결성 통과 후보가 있으면 그 안에서(narrow, :198-204)."""
    pool = [c for c in cs if c.complete] or cs
    return max(pool, key=lambda c: (c.anchor_date, c.cycle_id))


@dataclass(frozen=True)
class GridPick:
    """자리 하나의 판정 결과. mention·citation = 계열별 대표 회차(그룹마다 하나), gaps = 계열 → 갭 사유(API gap_reason 어휘).
    gaps 키: mentions·citations·accuracy(웹사이트 ⑥: 현행 fetchWebsiteCitationAccuracyTrend 는 ② 인용 표식을 보지 않는다)."""
    slot: GridSlot
    mention: tuple[GridCycle, ...]
    citation: tuple[GridCycle, ...]
    gaps: dict[str, str]


def pick_slot(slot: GridSlot, rule: GridRule) -> GridPick:
    """자리 대표·완결성 갭·인용 표식(현행 restrictToSlotRepresentative → restrictToCompleteCycles → withTrendGapBuckets ②)."""
    if slot.gap is not None:
        reason = "collection_error" if slot.gap == "collection_error" else "hidden"
        return GridPick(slot, (), (), {"mentions": reason, "citations": reason, "accuracy": reason})
    groups: dict[int, list[GridCycle]] = {}
    for c in slot.cycles:
        groups.setdefault(c.project_key if rule.per_project else 0, []).append(c)
    ments: list[GridCycle] = []
    cits: list[GridCycle] = []
    for k in sorted(groups):
        g = groups[k]
        mc = [c for c in g if c.cand and c.hidden_scope in (0, 2)]            # 현행 집합(usable): 인용 전용 숨김은 남는다
        if not mc:
            continue
        ments.append(_later(mc))
        cc = [c for c in mc if c.hidden_scope == 0]                             # 인용 사다리: 인용 숨김을 먼저 뺀다
        if cc:
            cits.append(_later(cc))
    known = [r for r in (c.ratio for c in ments) if r is not None]
    if rule.completion and known and max(known) < TREND_COMPLETION_MIN:
        return GridPick(slot, (), (), {"mentions": "collection_error", "citations": "collection_error", "accuracy": "collection_error"})
    cerr = HIDDEN_REASON["collection_error"]
    cit_err = any(c.hidden_scope == 2 and c.hidden_reason == cerr for c in slot.cycles)
    all_err = any(c.hidden_scope in (1, 3) and c.hidden_reason == cerr for c in slot.cycles)
    gaps = {"citations": "collection_error"} if cit_err and not all_err else {}
    return GridPick(slot, tuple(ments), tuple(cits), gaps)


def card_period_keys(surface: str, cycles: list[GridCycle]) -> dict[str, tuple[int, ...]]:
    """현행 프로필 card_slot_rep(R04CIT, WU-3): 대시보드 카드 경로 기간 창의 계열 키 = 자리 대표(순수 함수).

    현행(2670a16 + X.trendGrid·S1/S4.periodRoute): 기간 카드는 회차 집합(judgeCycleRange usable)을 restrictToTrendSlotSet 으로 좁힌다
    (글로벌 viaGlobalS1 server.ts:1945-1958, 웹사이트 viaTrend server.ts:5124 → websiteSlotRestrictedSet :4894). 규칙은 추이 격자의
    자리 판정(pick_slot)과 같은 함수다(cycle-set.ts:883 restrictToTrendSlotSet = 함대 대표 → 자리 대표 → 완결성).
      자리 그룹   글로벌 = round_date, 웹사이트 = (프로젝트, round_date)(GRID_RULES.per_project).
      언급 대표   숨김 'all'(과 허브 'mentions') 을 뺀 회차 중 완결성 통과 → 늦은 앵커 → cycle_id(인용 전용 숨김은 보지 않는다, :800-803).
      인용 대표   인용 숨김까지 뺀 같은 사다리(:814-822, citationCycles). 후보가 없으면 그 자리 인용 없음.
      완결성 갭   글로벌만: 언급 대표 완결성이 알려져 있고 0.9 미만이면 자리 전체를 뺀다(:126-162 restrictToCompleteCycles). 웹사이트는 보지 않는다.
      함대 대표   restrictToFleetVisible 은 허브 후보 술어(servable = 발행 ∧ fleet_visible)가 이미 건다.
    격자와 다른 점: 기간 안 자리 전부(13자리 상한·끝쪽 미발행 절단·180일 창 없음), 후보 = 창 후보 회차(servable ∧ 노출일)뿐(미발행 갭 자리 없음).
    반환 키: mentions = 언급 대표, citations = 인용 대표, any = 숨김 없는 언급 대표, row = 합집합(build_trend_grid 와 같은 뜻)."""
    rule = GRID_RULES[surface]
    by: dict[date, list[GridCycle]] = {}
    for c in cycles:
        by.setdefault(c.round_date, []).append(c)
    ment: set[int] = set()
    cit: set[int] = set()
    clean: set[int] = set()
    for d in sorted(by):
        p = pick_slot(GridSlot(d, tuple(sorted(by[d], key=lambda c: c.cyc_key)), None), rule)
        ment.update(c.cyc_key for c in p.mention)
        cit.update(c.cyc_key for c in p.citation)
        clean.update(c.cyc_key for c in p.mention if c.hidden_scope == 0)
    return {"mentions": tuple(sorted(ment)), "citations": tuple(sorted(cit)), "any": tuple(sorted(clean)),
            "row": tuple(sorted(ment | cit))}


@dataclass(frozen=True)
class TrendGrid:
    """격자 창: window 의 계열 키 = 자리 대표 회차(mentions = 언급 대표, citations = 인용 대표, any = 숨김 없는 언급 대표, row = 합집합),
    picks = 자리 판정(오름차순)."""
    window: Window
    picks: tuple[GridPick, ...]


def build_trend_grid(*, surface: str, cycles: list[GridCycle], date_from: date | None, date_to: date | None, generation: int | None,
                     project_keys: tuple[int, ...], project_ids: dict[int, str] | None = None) -> TrendGrid:
    """원장 회차 → 격자 창(순수 함수). lo·hi = 첫·끝 자리(갭 자리 포함), 자리가 없으면 빈 누적 창."""
    rule = GRID_RULES[surface]
    picks = tuple(pick_slot(s, rule) for s in grid_slots(cycles, date_from=date_from, date_to=date_to))
    reps = {c.cyc_key: c for p in picks for c in (*p.mention, *p.citation)}
    lo = picks[0].slot.round_date if picks else None
    hi = picks[-1].slot.round_date if picks else None
    win = build_window(surface=surface, mode="cumulative", rows=[c.row() for c in sorted(reps.values(), key=lambda c: c.cyc_key)],
                       lo=lo, hi=hi, generation=generation, project_keys=project_keys, project_ids=project_ids)
    ment = tuple(sorted({c.cyc_key for p in picks for c in p.mention}))
    cit = tuple(sorted({c.cyc_key for p in picks for c in p.citation}))
    union = tuple(sorted(set(ment) | set(cit)))
    # any = 어느 계열에서도 숨기지 않은 언급 대표(HIDDEN_EXCLUDE['any'] 의 뜻). 합집합으로 두면 언급·인용 대표가 갈린 자리가 두 번 센다.
    clean = tuple(sorted({c.cyc_key for p in picks for c in p.mention if c.hidden_scope == 0}))
    win = replace(win, keys={"mentions": ment, "citations": cit, "any": clean, "row": union})
    return TrendGrid(window=win, picks=picks)


_GRID_SQL = f"""
SELECT c.cyc_key, c.cycle_id::text AS cycle_id, c.project_key, c.round_date, c.anchor_date, c.hidden_scope, c.hidden_reason,
       (c.servable AND c.view_date IS NOT NULL AND c.view_date <= coalesce(CAST(:today AS date), rd.today_kst())) AS cand,
       c.expected_units, c.completed_units, c.completed_answers, {_GEN} AS generation
  FROM rd.cycle c
 WHERE c.surface = CAST(:sf AS int2) AND c.project_key = ANY(CAST(:pks AS int2[]))
   AND c.round_date >= coalesce(CAST(:today AS date), rd.today_kst()) - CAST(:days AS int4)
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, {_GEN}
"""


async def resolve_trend_grid(conn: Any, *, surface: str, project_keys: tuple[int, ...] | list[int], date_from: date | None,
                             date_to: date | None, today: date | None = None, project_ids: dict[int, str] | None = None,
                             frz: bool = False) -> TrendGrid:
    """현행 추이 격자(프로필 trend_grid). 원장 rd.cycle(상태 무관, 오늘 − 180일 이후)을 한 문장으로 읽어 build_trend_grid 로 판정한다.
    date_from·date_to(round_date)가 있으면 자리를 그 안으로 좁히고 최신 13자리는 그대로 상한이다(현행 buildTrendGrid from·to).
    frz=True(동결 판정 대상, S4): 현행 viaGlobalSeries·websiteTrendSet 은 격자 바닥(가장 이른 자리, server.ts:2999 gridFloor)부터 오늘까지
    회차 집합을 judgeCycleRange 로 판정해 구멍이면 미러로 간다. 같은 범위(자리 lo 이후·to 이하)의 후보 회차로 frz_judge 하고 결과를
    window.frz 에 싣는다. 통과하면 세대 없는 (숨김) 회차는 자리 대표 후보에서 뺀다(현행 집합 = 세대 있는 회차)."""
    from app.core.db import fetch_all

    if surface not in GRID_RULES:
        raise ValueError(f"추이 격자는 global·website 표면만: {surface}")
    if (date_from is None) != (date_to is None):
        raise ValueError("date_from·date_to 는 둘 다 있거나 둘 다 없어야 한다")
    sf, pks = _check(surface, project_keys)
    rs = await fetch_all(conn, _GRID_SQL, {"sf": sf, "pks": pks, "today": today, "days": TREND_GRID_MAX_DAYS})
    generation = rs[-1]["generation"] if rs else None
    cycles = [GridCycle(int(r["cyc_key"]), str(r["cycle_id"]), int(r["project_key"]), r["round_date"], r["anchor_date"],
                        int(r["hidden_scope"]), int(r["hidden_reason"] or 0), bool(r["cand"]), r["expected_units"], r["completed_units"],
                        r["completed_answers"]) for r in rs if r["cyc_key"] is not None]
    grid = build_trend_grid(surface=surface, cycles=cycles, date_from=date_from, date_to=date_to, generation=generation,
                            project_keys=tuple(pks), project_ids=project_ids)
    if not frz:
        return grid
    lo = grid.window.lo
    span = [c for c in cycles if c.cand and lo is not None and c.round_date >= lo and (date_to is None or c.round_date <= date_to)]
    frozen = await frozen_keys(conn, [c.cyc_key for c in span])
    if not frz_judge([c.row() for c in span], frozen) or await pick_holes(conn, sf=sf, pks=pks, lo=lo, hi=date_to):
        return replace(grid, window=replace(grid.window, frz=False))    # 구멍(후보·생성 대기, DB-v2.30)
    pruned = [c if c.cyc_key in frozen or not c.cand or c.hidden_scope == 0 else replace(c, cand=False) for c in cycles]
    g2 = build_trend_grid(surface=surface, cycles=pruned, date_from=date_from, date_to=date_to, generation=generation,
                          project_keys=tuple(pks), project_ids=project_ids)
    return replace(g2, window=replace(g2.window, frz=True))


# ════════════════════════════════════════════════════════════════════════════
# 원장·발행 이력(rd.cycle 만)
# ════════════════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class LedgerRow:
    """원장 행 하나(프로젝트 × 회차). 원장 대상만 싣는다(진행 중·노출일 전·계열 숨김 제외). published = 창 후보 술어 통과."""
    cyc_key: int
    project_key: int
    round_date: date
    expected_units: int
    published: bool
    hidden_scope: int


_LEDGER_PUBLISHED = "(c.servable AND c.view_date IS NOT NULL AND c.view_date <= coalesce(CAST(:today AS date), rd.today_kst()))"
_LEDGER_SQL = """
SELECT c.cyc_key, c.project_key, c.round_date, c.expected_units, c.hidden_scope,
       (c.servable AND c.view_date IS NOT NULL AND c.view_date <= coalesce(CAST(:today AS date), rd.today_kst())) AS published
  FROM rd.cycle c
 WHERE c.surface = CAST(:sf AS int2) AND c.project_key = ANY(CAST(:pks AS int2[]))
   AND c.round_date BETWEEN CAST(:lo AS date) AND CAST(:hi AS date)
   AND NOT (NOT c.servable AND c.status = CAST(:open AS int2))
   AND NOT (c.view_date IS NOT NULL AND c.view_date > coalesce(CAST(:today AS date), rd.today_kst()))
   AND c.hidden_scope <> ALL(CAST(:hid AS int2[]))
 ORDER BY c.round_date, c.project_key, c.cyc_key
"""


# compare_cycle_set(WU-12): 발행 판정만 함대 가시성 무관(_PUB_FLEET_ANY)으로 바꾼 같은 문장
_LEDGER_SQL_FLEET_ANY = _LEDGER_SQL.replace(_LEDGER_PUBLISHED, _LEDGER_PUBLISHED.replace("c.servable", _PUB_FLEET_ANY, 1), 1)
assert _LEDGER_SQL_FLEET_ANY != _LEDGER_SQL


# 동결 층(freeze_at_publish, S4) 기간 비교: 현행 발행 = 노출 가능 ∧ active_generation_id IS NOT NULL(summary-period-compare.ts:184-185
# publishedExpr, 원장·첫 발행 F 둘 다). 허브 대응 = 발행 술어에 활성 동결 세대를 더한다(세대 없는 회차 = 미발행 = 누락 비중에 든다)
_FRZ_GEN = "EXISTS (SELECT 1 FROM frz.generation fg WHERE fg.cyc_key = c.cyc_key AND fg.state = 'active')"


def _ledger_sql(fleet_any: bool, frz: bool) -> str:
    sql = _LEDGER_SQL_FLEET_ANY if fleet_any else _LEDGER_SQL
    if frz:
        pub = _LEDGER_PUBLISHED.replace("c.servable", _PUB_FLEET_ANY, 1) if fleet_any else _LEDGER_PUBLISHED
        sql2 = sql.replace(pub, f"({pub} AND {_FRZ_GEN})", 1)
        assert sql2 != sql
        sql = sql2
    return sql


async def ledger_rows(conn: Any, *, surface: str, project_keys: tuple[int, ...] | list[int], lo: date, hi: date, family: str,
                      today: date | None = None, fleet_any: bool = False, frz: bool = False) -> list[LedgerRow]:
    """누락 비중(Q2)·진행률(AD-4) 원장. 대상 = round_date ∈ [lo, hi] 인 회차 중 진행 중(비서빙 ∧ open)·노출일 전·계열 숨김
    (HIDDEN_EXCLUDE[family]) 이 아닌 것. published 는 창 후보 술어(servable ∧ view_date ≤ 오늘)와 같다. 원장은 함대 기준이다
    (필터·스코프 무관: project_keys 는 표면의 허용 프로젝트 전체를 넘긴다)."""
    from app.core.db import fetch_all

    if family not in HIDDEN_EXCLUDE:
        raise ValueError(f"알 수 없는 계열: {family}")
    if lo > hi:
        raise ValueError("lo ≤ hi")
    sf, pks = _check(surface, project_keys)
    rs = await fetch_all(conn, _ledger_sql(fleet_any, frz),
                         {"sf": sf, "pks": pks, "lo": lo, "hi": hi, "today": today, "open": CYCLE_STATUS["open"],
                                             "hid": sorted(HIDDEN_EXCLUDE[family])})
    return [LedgerRow(int(r["cyc_key"]), int(r["project_key"]), r["round_date"], int(r["expected_units"] or 0), bool(r["published"]),
                      int(r["hidden_scope"])) for r in rs]


_FIRST_SQL = f"""
SELECT min(c.round_date) AS first
  FROM rd.cycle c
 WHERE {_CAND} AND c.hidden_scope <> ALL(CAST(:hid AS int2[]))
"""


_FIRST_SQL_FLEET_ANY = f"""
SELECT min(c.round_date) AS first
  FROM rd.cycle c
 WHERE {_CAND_FLEET_ANY} AND c.hidden_scope <> ALL(CAST(:hid AS int2[]))
"""


async def first_published(conn: Any, *, surface: str, project_keys: tuple[int, ...] | list[int], family: str,
                          today: date | None = None, fleet_any: bool = False, frz: bool = False) -> date | None:
    """계열별 전 이력 첫 발행 회차(창 후보 술어 ∧ 계열 숨김 제외의 최소 round_date). family 는 필수(기본값 없음)."""
    from app.core.db import fetch_val

    if family not in HIDDEN_EXCLUDE:
        raise ValueError(f"알 수 없는 계열: {family}")
    sf, pks = _check(surface, project_keys)
    sql = _FIRST_SQL_FLEET_ANY if fleet_any else _FIRST_SQL
    if frz:                                          # 동결 층 기간 비교(S4): 첫 발행 = 활성 동결 세대 있는 회차(현행 publishedExpr)
        sql = sql.replace(" AND c.hidden_scope <> ALL(", f" AND {_FRZ_GEN} AND c.hidden_scope <> ALL(", 1)
    return await fetch_val(conn, sql, {"sf": sf, "pks": pks, "today": today, "hid": sorted(HIDDEN_EXCLUDE[family])})


@dataclass(frozen=True)
class RoundDates:
    dates: tuple[date, ...]         # 내림차순, 최대 limit 개
    total: int                      # 절단 전 전체 개수
    first: date | None              # 가장 이른 날짜(절단과 무관)
    generation: int | None


_DATES_SQL = f"""
WITH d AS (SELECT DISTINCT c.round_date FROM rd.cycle c WHERE {_CAND} AND c.hidden_scope <> ALL(CAST(:hid AS int2[])))
SELECT (SELECT coalesce(array_agg(x.round_date ORDER BY x.round_date DESC), '{{}}')
          FROM (SELECT round_date FROM d ORDER BY round_date DESC LIMIT CAST(:n AS int4)) x) AS dates,
       (SELECT count(*) FROM d) AS total, (SELECT min(round_date) FROM d) AS first, {_GEN} AS generation
"""


async def selectable_round_dates(conn: Any, *, surface: str, project_keys: tuple[int, ...] | list[int], family: str, limit: int,
                                 today: date | None = None) -> RoundDates:
    """선택 가능 회차 날짜(F-2): 창 후보 술어 ∧ 계열 숨김 제외의 DISTINCT round_date 를 DB 에서 내림차순 limit 개로 자른다
    (cycle_pick_idx Index Only Scan). 전체 개수·가장 이른 날짜·generation 을 함께 낸다."""
    from app.core.db import fetch_one

    if family not in HIDDEN_EXCLUDE:
        raise ValueError(f"알 수 없는 계열: {family}")
    if limit < 1:
        raise ValueError("limit ≥ 1")
    sf, pks = _check(surface, project_keys)
    r = await fetch_one(conn, _DATES_SQL, {"sf": sf, "pks": pks, "today": today, "n": limit, "hid": sorted(HIDDEN_EXCLUDE[family])})
    assert r is not None
    return RoundDates(dates=tuple(r["dates"] or ()), total=int(r["total"] or 0), first=r["first"], generation=r["generation"])
