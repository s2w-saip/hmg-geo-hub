"""intent.social.context_map 업무 규칙: 구매 맥락 지도(정적 스냅샷 ext.ctx_*) 조회·내보내기(CM-1 흡수).

- 권한: 인증 사용자면 된다(코퍼스는 브랜드·프로젝트 축이 없는 산업 전역 데이터, 현행 app/api/context-map/route.ts 판단 이관).
- 스냅샷: 설정 산업(core.config context_map_industry_entity_id, env HGH_CONTEXT_MAP_INDUSTRY_ENTITY_ID)의 활성 스냅샷 1개.
  미설정이면 활성 스냅샷이 정확히 1개일 때만 그것을 쓴다(2개 이상이면 '준비 중' + 경고). 없으면 200 + meta.suppressed{'*': no_active_snapshot}
  (A12 '준비 중').
- 목록: 키셋 페이지네이션(core.pagination, 정렬키 + id 튜플). 커서 세대 = snapshot_id(스냅샷이 바뀌면 409 cursor_stale).
  현행 page/size 오프셋을 키셋으로 바꿨다(CM-1). total 은 같은 조건 count(*) 로 매 요청 계산(D8: 저장 안 함).
- 표시 매핑(theme_name·category)은 현행 DIMENSION_THEME·CATEGORY_RULES(scope-context-map.ts:57-83) 그대로(서버 고정 한국어).
- 빈도 버킷은 스냅샷 전체 max 대비(페이지 max 아님), 연결 강도는 그 엔티티 연결 중 max 대비(현행 bucketStrength).
"""
from __future__ import annotations

import logging
import math
import re
import uuid
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.config import get_settings
from app.core.db import fetch_all, fetch_one, fetch_val
from app.core.envelope import Page, ratio
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.xlsx import SheetSpec, auto_widths
from app.features.intent.social.context_map import queries as q
from app.features.intent.social.context_map.schemas import (
    CombinationRow,
    ConditionRow,
    ContextRow,
    Domain,
    EntityDetail,
    Evidence,
    Linked,
    Sentiment,
    Stats,
)

log = logging.getLogger("hgh.intent.context_map")

EntityType = Literal["ConsumerContext", "ConsumerRequirement"]
Sort = Literal["name", "mentions"]
Dir = Literal["asc", "desc"]
MAX_PAGE = 200
DEFAULT_PAGE = 50
EVIDENCE_PER_ENTITY = 8

DIMENSION_THEME = {"demographic": "인구통계", "trait": "특성", "lifestage": "생애주기", "role": "역할",
                   "occasion": "상황·시즌", "usecase": "사용 목적", "emotional": "심리·감정"}
CATEGORY_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("가격·비용", re.compile(r"원|가격|비용|할인|가성비|예산|리스|할부")),
    ("연비·동력", re.compile(r"연비|하이브리드|전기|엔진|출력|마력|토크|배기량")),
    ("공간·적재", re.compile(r"공간|시트|트렁크|적재|좌석|열 |인승")),
    ("안전·내구성", re.compile(r"안전|사고|내구|고장|주행거리|상태")),
    ("옵션·편의", re.compile(r"옵션|편의|기능|어시스트|센서|카메라|내비")),
    ("디자인·외관", re.compile(r"디자인|외관|색상|컬러|스타일")),
)

# 정렬 화이트리스트: (정렬 SQL 식, 커서 키 형)
_SORT_COL: dict[str, tuple[str, str]] = {"name": ("e.canonical_name", "text"), "mentions": ("e.mention_count", "int4")}
_LINK_COL: dict[str, str] = {"ConsumerContext": "d.context_id", "ConsumerRequirement": "d.requirement_id"}


def categorize(name: str) -> str:
    for cat, rx in CATEGORY_RULES:
        if rx.search(name):
            return cat
    return "기타"


def theme_of(dimension: str | None) -> tuple[str, str]:
    return (dimension or "기타", DIMENSION_THEME.get(dimension or "", "기타"))


def bucket_strength(value: int, mx: int) -> Literal["high", "medium", "low"]:
    if mx <= 0:
        return "low"
    r = value / mx
    return "high" if r >= 0.66 else "medium" if r >= 0.33 else "low"


def sentiment(pos: int, neg: int, neu: int) -> Sentiment:
    den = int(pos) + int(neg) + int(neu)
    return Sentiment(positive=ratio(pos, den), negative=ratio(neg, den), neutral=ratio(neu, den))


def js_round_pct(num: int, den: int) -> int:
    """현행 Math.round((x/total)*100) 과 같은 반올림(.5 는 올림). den 0 이면 호출자가 중립 100 으로 채운다."""
    return math.floor(num / den * 100 + 0.5)


def like_pattern(search: str) -> str:
    """ILIKE 와일드카드(%, _)와 이스케이프 문자(\\)를 이스케이프하고 %…% 로 감싼다(현행 likePattern)."""
    return "%" + re.sub(r"([\\%_])", r"\\\1", search) + "%"


def clean_search(search: str | None) -> str | None:
    s = (search or "").strip()
    if not s:
        return None
    if len(s) > 100 or re.search(r"[\x00-\x1f\x7f]", s):
        raise errors.unprocessable("검색어는 제어문자 없이 100자 이하", details={"field": "search"})
    return s


async def active_snapshot(conn: AsyncConnection) -> dict[str, Any] | None:
    industry = get_settings().context_map_industry_entity_id
    if industry is not None:
        return await fetch_one(conn, q.ACTIVE_BY_INDUSTRY, {"ind": industry})
    rows = await fetch_all(conn, q.ACTIVE_ANY)
    if len(rows) > 1:
        log.warning("활성 컨텍스트 스냅샷이 여럿인데 HGH_CONTEXT_MAP_INDUSTRY_ENTITY_ID 미설정: 준비 중으로 응답")
        return None
    return rows[0] if rows else None


def snapshot_source(snap: dict[str, Any] | None) -> dict[str, Any] | None:
    if snap is None:
        return None
    return {"snapshot_id": int(snap["snapshot_id"]), "taken_at": snap["taken_at"].isoformat(), "source": snap["source"],
            "utterance_total": snap["utterance_total"]}


async def stats(conn: AsyncConnection, snap_id: int) -> Stats:
    r = await fetch_one(conn, q.STATS, {"s": snap_id}) or {}
    d, c = int(r.get("drives") or 0), int(r.get("combinations") or 0)
    return Stats(contexts=int(r.get("contexts") or 0), conditions=int(r.get("conditions") or 0), drives=d, combinations=c,
                 relationships=d + c, sources=int(r.get("sources") or 0))


async def list_entities(conn: AsyncConnection, snap_id: int, etype: EntityType, *, search: str | None, sort: Sort, dir: Dir,
                        cursor: str | None, limit: int) -> tuple[list[ContextRow] | list[ConditionRow], Page]:
    limit = clamp_limit(limit, DEFAULT_PAGE)
    sort_sql, sort_type = _SORT_COL[sort]
    fh = filter_hash({"t": etype, "q": search})
    cur = decode_cursor(cursor, sort=sort, dir=dir, fh=fh, types=(sort_type, "uuid"), generation=snap_id)   # type: ignore[arg-type]
    b = Binder()
    where = [f"e.snapshot_id = {b.v(snap_id)}", f"e.type = {b.v(etype)}"]
    if search:
        where.append(f"e.canonical_name ILIKE {b.v(like_pattern(search))} ESCAPE '\\'")
    count_where = list(where)
    kp = keyset_predicate([sort_sql, "e.id"], dir, cur, b)
    if kp:
        where.append(kp)
    d = "ASC" if dir == "asc" else "DESC"
    sql = (f"SELECT e.id, e.canonical_name, e.dimension, e.mention_count, e.utterance_count, "
           f"e.sentiment_positive, e.sentiment_negative, e.sentiment_neutral, "
           f"(SELECT count(*) FROM ext.ctx_drive d WHERE d.snapshot_id = e.snapshot_id AND {_LINK_COL[etype]} = e.id) AS linked_count "
           f"FROM ext.ctx_entity e WHERE {' AND '.join(where)} ORDER BY {sort_sql} {d}, e.id {d} LIMIT {b.v(limit + 1)}")
    rows = await fetch_keyset(conn, sql, b.params)
    total = await fetch_val(conn, f"SELECT count(*) FROM ext.ctx_entity e WHERE {' AND '.join(count_where)}", b.params)
    page, nxt = keyset_page(rows, limit, lambda r: (r["canonical_name"] if sort == "name" else r["mention_count"], r["id"]),
                            sort=sort, dir=dir, fh=fh, generation=snap_id)
    items: list[Any] = []
    for r in page:
        sent = sentiment(r["sentiment_positive"], r["sentiment_negative"], r["sentiment_neutral"])
        if etype == "ConsumerContext":
            tid, tname = theme_of(r["dimension"])
            items.append(ContextRow(id=r["id"], name=r["canonical_name"], theme_id=tid, theme_name=tname, mention_count=r["mention_count"],
                                    utterance_count=r["utterance_count"], sentiment=sent, linked_count=r["linked_count"]))
        else:
            items.append(ConditionRow(id=r["id"], name=r["canonical_name"], category=categorize(r["canonical_name"]),
                                      mention_count=r["mention_count"], utterance_count=r["utterance_count"], sentiment=sent,
                                      linked_count=r["linked_count"]))
    return items, Page(next_cursor=nxt, limit=limit, total=int(total or 0))


async def list_combinations(conn: AsyncConnection, snap_id: int, *, search: str | None, dir: Dir, cursor: str | None,
                            limit: int) -> tuple[list[CombinationRow], int, Page]:
    limit = clamp_limit(limit, DEFAULT_PAGE)
    fh = filter_hash({"t": "combination", "q": search})
    cur = decode_cursor(cursor, sort="cooccurrence", dir=dir, fh=fh, types=("int4", "uuid", "uuid"), generation=snap_id)
    b = Binder()
    where = [f"c.snapshot_id = {b.v(snap_id)}"]
    if search:
        pat = b.v(like_pattern(search))
        where.append(f"(a.canonical_name ILIKE {pat} ESCAPE '\\' OR b.canonical_name ILIKE {pat} ESCAPE '\\')")
    count_where = list(where)
    kp = keyset_predicate(["c.co_count", "c.cond_a", "c.cond_b"], dir, cur, b)
    if kp:
        where.append(kp)
    d = "ASC" if dir == "asc" else "DESC"
    joins = ("FROM ext.ctx_combination c JOIN ext.ctx_entity a ON a.snapshot_id = c.snapshot_id AND a.id = c.cond_a "
             "JOIN ext.ctx_entity b ON b.snapshot_id = c.snapshot_id AND b.id = c.cond_b")
    sql = (f"SELECT c.cond_a, c.cond_b, c.co_count, a.canonical_name AS a_name, b.canonical_name AS b_name {joins} "
           f"WHERE {' AND '.join(where)} ORDER BY c.co_count {d}, c.cond_a {d}, c.cond_b {d} LIMIT {b.v(limit + 1)}")
    rows = await fetch_keyset(conn, sql, b.params)
    total = await fetch_val(conn, f"SELECT count(*) {joins} WHERE {' AND '.join(count_where)}", b.params)
    mx = int(await fetch_val(conn, q.MAX_CO, {"s": snap_id}) or 0)
    page, nxt = keyset_page(rows, limit, lambda r: (r["co_count"], r["cond_a"], r["cond_b"]), sort="cooccurrence", dir=dir, fh=fh,
                            generation=snap_id)
    items = [combo_row(r, mx) for r in page]
    return items, mx, Page(next_cursor=nxt, limit=limit, total=int(total or 0))


def combo_row(r: dict[str, Any], mx: int) -> CombinationRow:
    return CombinationRow(id=f"{r['cond_a']}:{r['cond_b']}", cond_a_id=r["cond_a"], cond_a_name=r["a_name"], cond_b_id=r["cond_b"],
                          cond_b_name=r["b_name"], co_count=r["co_count"], frequency=bucket_strength(r["co_count"], mx))


async def entity_detail(conn: AsyncConnection, snap_id: int, entity_id: uuid.UUID) -> EntityDetail:
    e = await fetch_one(conn, q.ENTITY, {"s": snap_id, "id": entity_id})
    if e is None:
        raise errors.not_found("엔티티 없음")
    prm = {"s": snap_id, "id": entity_id}
    ev = await fetch_all(conn, q.EVIDENCE, {**prm, "n": EVIDENCE_PER_ENTITY})
    dom = await fetch_all(conn, q.DOMAINS, prm)
    links = await fetch_all(conn, q.LINKED_FROM_CONTEXT if e["type"] == "ConsumerContext" else q.LINKED_FROM_CONDITION, prm)
    mx = max([1] + [int(x["co_count"]) for x in links])
    return EntityDetail(id=e["id"], name=e["canonical_name"], type=e["type"], mention_count=e["mention_count"],
                        utterance_count=e["utterance_count"],
                        sentiment=sentiment(e["sentiment_positive"], e["sentiment_negative"], e["sentiment_neutral"]),
                        evidence=[Evidence(**x) for x in ev], source_domains=[Domain(host=x["host"], count=x["n"]) for x in dom],
                        linked=[Linked(id=x["id"], name=x["name"], co_count=x["co_count"], strength=bucket_strength(x["co_count"], mx))
                                for x in links])


# ── 내보내기(서버 xlsx, 라벨 서버 고정 ko/en: Q13) ──
EXPORT_LABELS: dict[str, dict[str, Any]] = {
    "ko": {"sheets": ("구매 맥락", "구매 조건", "조합 패턴"), "name": "이름", "theme": "주제", "category": "카테고리",
           "positive": "긍정", "negative": "부정", "neutral": "중립", "driven": "유발 조건", "driven_by": "유발한 맥락",
           "mentions": "언급", "cond_a": "조건 A", "cond_b": "조건 B", "frequency": "빈도", "cooccurrence": "동시 언급",
           "freq": {"high": "강", "medium": "중", "low": "약"}, "file": "구매맥락지도"},
    "en": {"sheets": ("Buyer contexts", "Purchase Conditions", "Combination patterns"), "name": "Name", "theme": "Theme",
           "category": "Category", "positive": "Positive", "negative": "Negative", "neutral": "Neutral",
           "driven": "Driven conditions", "driven_by": "Driven by", "mentions": "Mentions", "cond_a": "Condition A",
           "cond_b": "Condition B", "frequency": "Frequency", "cooccurrence": "Co-occurrence",
           "freq": {"high": "High", "medium": "Med", "low": "Low"}, "file": "context-map"},
}


def _pcts(r: dict[str, Any]) -> tuple[int, int, int]:
    pos, neg, neu = int(r["sentiment_positive"]), int(r["sentiment_negative"]), int(r["sentiment_neutral"])
    tot = pos + neg + neu
    if tot == 0:
        return 0, 0, 100
    return js_round_pct(pos, tot), js_round_pct(neg, tot), js_round_pct(neu, tot)


def _sheet(name: str, headers: list[str], rows: list[list[Any]]) -> SheetSpec:
    """열 너비 = 현행 내보내기 규칙(최장 + 2, 10~60, core.xlsx.auto_widths), 첫 행 굵게·틀 고정."""
    return SheetSpec(name, headers, rows, widths=auto_widths(headers, rows))


async def export_sheets(conn: AsyncConnection, snap_id: int, lang: str) -> list[SheetSpec]:
    """3시트(맥락·조건·조합). 시트명 규칙(31자·금지 문자·중복 접미)은 core.xlsx 가 적용한다."""
    lb = EXPORT_LABELS[lang]
    ctx = await fetch_all(conn, q.EXPORT_CONTEXTS, {"s": snap_id})
    cond = await fetch_all(conn, q.EXPORT_CONDITIONS, {"s": snap_id})
    combo = await fetch_all(conn, q.EXPORT_COMBINATIONS, {"s": snap_id})
    mx = max([0] + [int(r["co_count"]) for r in combo])
    pct = [f"{lb['positive']}%", f"{lb['negative']}%", f"{lb['neutral']}%"]
    s1 = _sheet(lb["sheets"][0], [lb["name"], lb["theme"], *pct, lb["driven"], lb["mentions"]],
                [[r["canonical_name"], theme_of(r["dimension"])[1], *_pcts(r), r["linked_count"], r["mention_count"]] for r in ctx])
    s2 = _sheet(lb["sheets"][1], [lb["name"], lb["category"], *pct, lb["driven_by"], lb["mentions"]],
                [[r["canonical_name"], categorize(r["canonical_name"]), *_pcts(r), r["linked_count"], r["mention_count"]] for r in cond])
    s3 = _sheet(lb["sheets"][2], [lb["cond_a"], lb["cond_b"], lb["frequency"], lb["cooccurrence"]],
                [[r["a_name"], r["b_name"], lb["freq"][bucket_strength(r["co_count"], mx)], r["co_count"]] for r in combo])
    return [s1, s2, s3]
