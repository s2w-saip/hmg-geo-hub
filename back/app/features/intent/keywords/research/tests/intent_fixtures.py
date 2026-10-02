"""intent 기능 테스트 공용 합성 데이터(로컬 개발 DB 복제본 전용, 고객 데이터 아님).

합성 픽스처(tests/fixtures)에는 rd.kw_*·ext.ctx_* 가 없어 테스트가 직접 넣는다(적재기가 쓸 자리를 소유자 접속으로 흉내).
- rd.* 는 SQL 문자열 대신 asyncpg COPY(copy_records_to_table)로 넣는다: 기능 SQL 경계 가드(G6 'API 는 rd 를 쓰지 않는다')가
  기능 경로의 문자열을 정적으로 검사하기 때문이다. rd 행은 세션마다 고유 term·call_id 로 새로 만들고 지우지 않는다(누적 무해, CI 는 새 DB).
- app·ext 테스트 행(임시 프로젝트·스냅샷·큐 행·초안)은 teardown 에서 지운다(다른 기능 테스트의 기대값을 흔들지 않게).
- 임시 프로젝트 멤버십: HQ_HYUNDAI(operator assigned) 를 임시 프로젝트 owner 로 넣어 '배정 운영자 + 활성 멤버' 경로를 만든다.
"""
from __future__ import annotations

import secrets
import time
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

import asyncpg

from tests.support import ADMIN, DB_URL, HQ_HYUNDAI

TOKEN = secrets.token_hex(4)
_CALL_BASE = (int(time.time() * 1000) % 10 ** 9) * 1000


def uniq(term: str) -> str:
    return f"{term} {TOKEN}"


def norm(term: str) -> str:
    return unicodedata.normalize("NFC", term).strip().lower()


def next_call_id(i: int) -> int:
    return _CALL_BASE + i


async def su() -> asyncpg.Connection:
    return await asyncpg.connect(DB_URL)


async def kw_key(c: asyncpg.Connection, term: str) -> int:
    n = norm(term)
    k = await c.fetchval("SELECT kw_key FROM rd.dim_keyword WHERE term_norm = $1", n)
    if k is None:
        await c.copy_records_to_table("dim_keyword", schema_name="rd", columns=["term", "term_norm"], records=[(term, n)])
        k = await c.fetchval("SELECT kw_key FROM rd.dim_keyword WHERE term_norm = $1", n)
    return int(k)


def months_back(n: int, *, today: date | None = None) -> list[date]:
    """오늘 달 포함 과거 n 개월(1일), 오래된 순."""
    t = today or date.today()
    out, y, m = [], t.year, t.month
    for _ in range(n):
        out.append(date(y, m, 1))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return list(reversed(out))


async def put_volume(c: asyncpg.Connection, kw: int, loc: int, lang: str, rows: list[tuple[date, int]], observed: datetime, call_id: int):
    await c.copy_records_to_table("kw_volume_monthly", schema_name="rd",
                                  columns=["kw_key", "location_code", "language_code", "month", "search_volume", "competition_index",
                                           "cpc", "call_id", "observed_at"],
                                  records=[(kw, loc, lang, m, v, 50, None, call_id, observed) for m, v in rows])


async def put_serp(c: asyncpg.Connection, kw: int, loc: int, lang: str, call_id: int, n: int, observed: datetime, tag: str = ""):
    await c.copy_records_to_table("kw_serp", schema_name="rd",
                                  columns=["call_id", "kw_key", "location_code", "language_code", "rank", "url", "domain", "title",
                                           "snippet", "observed_at"],
                                  records=[(call_id, kw, loc, lang, r, f"https://ex{r}.test/{tag}", f"ex{r}.test", f"title {tag}{r}",
                                            f"snippet {tag}{r}", observed) for r in range(1, n + 1)])


async def put_suggest(c: asyncpg.Connection, seed_kw: int, loc: int, lang: str, call_id: int,
                      rows: list[tuple[int, str, int | None, str | None, bool]], observed: datetime, total_count: int | None = None):
    """rows = (pos, term, volume, intent, is_seed). observed = 그 호출의 관측 시각(DB-v2.6 P43 NOT NULL, related·search 신선도).
    total_count = 그 호출의 DataForSEO total_count(DB-v2.9 P62, 호출 단위 같은 값을 행마다)."""
    recs = []
    for pos, term, vol, intent, is_seed in rows:
        recs.append((call_id, seed_kw, loc, lang, pos, await kw_key(c, term), vol, intent, is_seed, observed, total_count))
    await c.copy_records_to_table("kw_suggestion", schema_name="rd",
                                  columns=["call_id", "seed_kw_key", "location_code", "language_code", "pos", "kw_key", "search_volume",
                                           "intent", "is_seed", "observed_at", "total_count"], records=recs)


@dataclass
class KwWorld:
    """모듈별 키워드 데이터(US 프리셋 2840/en, KR 2410/ko). 모듈마다 tag 로 term·call_id 를 따로 만든다(서로의 쓰기에 흔들리지 않게)."""
    tag: str
    fresh: str = ""      # 검색량 14개월 + SERP 2회(최신 10행) + 초안 + 연관어(seed 포함, 1시간 전)
    stale: str = ""      # 3일 전 관측(검색량·SERP) + 연관어(seed 포함, 8일 전 = related·search 7일 TTL 밖)
    half: str = ""       # 검색량만(SERP 없음) + 연관어(seed 없음, 1시간 전 = related 는 신선, search 는 seed 호출이 없어 미수집)
    korean: str = ""     # NFC 저장(NFD 입력 매칭 확인)
    missing: str = ""
    serp_old: int = 0
    serp_new: int = 0
    serp_stale: int = 0
    months: list[date] = field(default_factory=list)
    kr_volume: int = 777

    def t(self, term: str) -> str:
        return uniq(f"{term} {self.tag}")


_CALLS = iter(range(1, 10 ** 6))


async def build_kw_world(tag: str) -> KwWorld:
    w = KwWorld(tag)
    w.fresh, w.stale, w.half, w.korean, w.missing = (w.t("kona fresh"), w.t("tucson stale"), w.t("ioniq half"),
                                                     w.t("코나 하이브리드"), w.t("never fetched"))
    now = datetime.now(UTC)
    w.months = months_back(14)
    w.serp_old, w.serp_new, w.serp_stale = next_call_id(next(_CALLS)), next_call_id(next(_CALLS)), next_call_id(next(_CALLS))
    c = await su()
    try:
        kf = await kw_key(c, w.fresh)
        await put_volume(c, kf, 2840, "en", [(m, 100 + i) for i, m in enumerate(w.months)], now - timedelta(hours=1), w.serp_new)
        await put_serp(c, kf, 2840, "en", w.serp_old, 3, now - timedelta(days=2), "old")
        await put_serp(c, kf, 2840, "en", w.serp_new, 10, now - timedelta(minutes=30), "new")
        # 같은 키워드의 KR 데이터(국가를 바꾸면 값이 바뀐다)
        await put_volume(c, kf, 2410, "ko", [(w.months[-1], w.kr_volume)], now - timedelta(hours=1), w.serp_new)
        await c.execute("INSERT INTO app.kw_prompt_draft (serp_call_id, rank, gen, prompt, model) VALUES "
                        "($1, 2, 1, 'old draft', 'm0'), ($1, 2, 2, 'new draft', 'm1')", w.serp_new)
        await put_suggest(c, kf, 2840, "en", next_call_id(next(_CALLS)), [(1, w.fresh, 900, "commercial", True),
                                                                          (2, w.t("kona price"), 300, "transactional", False),
                                                                          (3, w.t("kona review"), None, "informational", False)],
                          now - timedelta(hours=1), total_count=1234)
        ks = await kw_key(c, w.stale)
        await put_volume(c, ks, 2840, "en", [(w.months[-1], 55)], now - timedelta(days=3), w.serp_stale)
        await put_serp(c, ks, 2840, "en", w.serp_stale, 2, now - timedelta(days=3), "stale")
        await put_suggest(c, ks, 2840, "en", next_call_id(next(_CALLS)), [(1, w.stale, 70, "commercial", True),
                                                                          (2, w.t("tucson size"), 20, "informational", False)],
                          now - timedelta(days=8))
        kh = await kw_key(c, w.half)
        await put_volume(c, kh, 2840, "en", [(w.months[-1], 42)], now - timedelta(hours=2), next_call_id(next(_CALLS)))
        await put_suggest(c, kh, 2840, "en", next_call_id(next(_CALLS)), [(1, w.t("ioniq range"), 10, "informational", False)],
                          now - timedelta(hours=1))
        kk = await kw_key(c, w.korean)
        await put_volume(c, kk, 2410, "ko", [(w.months[-1], 1234)], now - timedelta(hours=1), next_call_id(next(_CALLS)))
    finally:
        await c.close()
    return w


async def new_serp(term: str, n: int, *, loc: int = 2840, lang: str = "en", tag: str = "own") -> int:
    """테스트 한 개가 혼자 쓰는 SERP 호출(고유 call_id, 관측 = 지금). 다른 테스트의 초안 쓰기에 흔들리지 않게 한다."""
    cid = next_call_id(next(_CALLS))
    c = await su()
    try:
        await put_serp(c, await kw_key(c, term), loc, lang, cid, n, datetime.now(UTC), tag)
    finally:
        await c.close()
    return cid


async def cleanup_drafts(call_ids: list[int]) -> None:
    c = await su()
    try:
        await c.execute("DELETE FROM app.kw_prompt_draft WHERE serp_call_id = ANY($1::bigint[])", call_ids)
    finally:
        await c.close()


# ── 임시 프로젝트 ──
@dataclass
class Projects:
    own: uuid.UUID          # Hyundai US 고객 프로젝트, HQ_HYUNDAI = owner(배정 운영자 + 활성 멤버)
    other: uuid.UUID        # Kia DE 고객 프로젝트(멤버 없음)


async def create_projects() -> Projects:
    own, other = uuid.uuid4(), uuid.uuid4()
    c = await su()
    try:
        await c.execute("""INSERT INTO app.project (project_id, kind, name, brand_code, country_code, created_by) VALUES
                           ($1, 'customer', 'intent-test own', 'Hyundai', 'US', $3), ($2, 'customer', 'intent-test other', 'Kia', 'DE', $3)""",
                        own, other, ADMIN)
        await c.execute("""INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at)
                           VALUES ($1, $2, 'owner', 'active', $3, now())""", own, HQ_HYUNDAI, ADMIN)
    finally:
        await c.close()
    return Projects(own, other)


async def drop_projects(pr: Projects) -> None:
    c = await su()
    try:
        await c.execute("DELETE FROM app.project WHERE project_id = ANY($1::uuid[])", [pr.own, pr.other])
    finally:
        await c.close()


# ── 컨텍스트 맵 스냅샷 ──
@dataclass
class CtxWorld:
    snapshot_id: int
    industry: uuid.UUID
    ctx: list[uuid.UUID]          # C1(언급 50, occasion), C2(30, 모르는 dimension), C3(10, dimension 없음)
    cond: list[uuid.UUID]         # R1 '연비 좋은 차'(40), R2 '50% 할인'(20), R3 '넓은 트렁크'(15), R4 '기타 조건_x'(5)
    names: dict[uuid.UUID, str]
    taken_at: datetime


async def build_ctx_world(snapshot_id: int, *, active: bool = True) -> CtxWorld:
    ind = uuid.uuid4()
    ctx = [uuid.UUID(int=(snapshot_id << 64) + i) for i in (1, 2, 3)]
    cond = [uuid.UUID(int=(snapshot_id << 64) + i) for i in (11, 12, 13, 14)]
    names = {ctx[0]: "주말 가족 여행", ctx[1]: "첫 차 구매", ctx[2]: "출퇴근",
             cond[0]: "연비 좋은 차", cond[1]: "50% 할인", cond[2]: "넓은 트렁크", cond[3]: "기타 조건_x"}
    taken = datetime(2026, 9, 1, 3, 0, tzinfo=UTC)
    c = await su()
    try:
        await drop_ctx_world(snapshot_id, c)
        await c.execute("INSERT INTO ext.ctx_snapshot (snapshot_id, industry_entity_id, source, utterance_total, taken_at, is_active) "
                        "VALUES ($1, $2, 'test', 999, $3, $4)", snapshot_id, ind, taken, active)
        ent = [(ctx[0], "ConsumerContext", "occasion", 50, 60, 6, 2, 2), (ctx[1], "ConsumerContext", "weird", 30, 31, 0, 0, 0),
               (ctx[2], "ConsumerContext", None, 10, 12, 1, 1, 1),
               (cond[0], "ConsumerRequirement", None, 40, 41, 3, 0, 0), (cond[1], "ConsumerRequirement", None, 20, 22, 1, 1, 0),
               (cond[2], "ConsumerRequirement", None, 15, 15, 0, 3, 0), (cond[3], "ConsumerRequirement", None, 5, 5, 0, 0, 5)]
        await c.executemany("INSERT INTO ext.ctx_entity (snapshot_id, id, type, canonical_name, dimension, mention_count, utterance_count, "
                            "sentiment_positive, sentiment_negative, sentiment_neutral) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                            [(snapshot_id, i, t, names[i], d, m, u, p, n, z) for i, t, d, m, u, p, n, z in ent])
        drives = [(ctx[0], cond[0], 9), (ctx[0], cond[1], 3), (ctx[0], cond[2], 1), (ctx[1], cond[0], 4)]
        await c.executemany("INSERT INTO ext.ctx_drive (snapshot_id, context_id, requirement_id, co_count) VALUES ($1,$2,$3,$4)",
                            [(snapshot_id, a, b, n) for a, b, n in drives])
        combos = [(cond[0], cond[1], 30), (cond[0], cond[2], 12), (cond[1], cond[2], 9), (cond[2], cond[3], 5)]
        await c.executemany("INSERT INTO ext.ctx_combination (snapshot_id, cond_a, cond_b, co_count) VALUES ($1,$2,$3,$4)",
                            [(snapshot_id, a, b, n) for a, b, n in combos])
        ev = [(snapshot_id, uuid.UUID(int=(snapshot_id << 64) + 100 + k), ctx[0], uuid.uuid4(), f"quote {k:02d}", "a.test",
               f"https://a.test/{k}", "positive") for k in range(10)]
        await c.executemany("INSERT INTO ext.ctx_evidence (snapshot_id, id, entity_id, utterance_id, quote, source_host, source_url, sentiment) "
                            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", ev)
        dom = [(ctx[0], "a.test", 7), (ctx[0], "b.test", 9), (cond[0], "a.test", 2), (cond[1], "c.test", 1)]
        await c.executemany("INSERT INTO ext.ctx_domain (snapshot_id, entity_id, host, n) VALUES ($1,$2,$3,$4)",
                            [(snapshot_id, e, h, n) for e, h, n in dom])
    finally:
        await c.close()
    return CtxWorld(snapshot_id, ind, ctx, cond, names, taken)


async def drop_ctx_world(snapshot_id: int, c: asyncpg.Connection | None = None) -> None:
    own = c is None
    c = c or await su()
    try:
        for t in ("ctx_domain", "ctx_evidence", "ctx_combination", "ctx_drive", "ctx_entity"):
            await c.execute(f"DELETE FROM ext.{t} WHERE snapshot_id = $1", snapshot_id)
        await c.execute("DELETE FROM ext.ctx_snapshot WHERE snapshot_id = $1", snapshot_id)
    finally:
        if own:
            await c.close()


async def delete_changes(ids: list[int]) -> None:
    c = await su()
    try:
        await c.execute("DELETE FROM app.judgment_change WHERE change_id = ANY($1::bigint[])", ids)
    finally:
        await c.close()


class FakeLlm:
    """주입용 가짜 LLM(core.llm.LlmClient 모양). responder(prompt, schema) → dict. 호출 기록을 남긴다.
    주입: app.dependency_overrides[app.core.llm.get_llm] = lambda: fake."""

    def __init__(self, responder, model: str = "fake/model"):
        self.model = model
        self.calls: list[str] = []
        self._responder = responder

    async def complete_json(self, prompt, schema, *, temperature, max_tokens, timeout_s=None):
        self.calls.append(prompt)
        r = self._responder(prompt, schema)
        if hasattr(r, "__await__"):
            r = await r
        return r


# ── 검증 결함 회귀용: 임시 계정·프로젝트·추적 키워드(세션마다 고유 id, teardown 에서 지운다) ──
@dataclass(frozen=True)
class TempUser:
    uid: uuid.UUID
    role: str
    operator: str
    brands: tuple[str, ...]
    countries: tuple[str, ...]
    menu: tuple[str, ...] | None


def temp_user(role: str, operator: str, brands: tuple[str, ...], menu: tuple[str, ...] | None,
              countries: tuple[str, ...] = ()) -> TempUser:
    return TempUser(uuid.uuid4(), role, operator, brands, countries, menu)


async def create_users(users: list[TempUser]) -> None:
    c = await su()
    try:
        async with c.transaction():
            await c.execute("SELECT set_config('app.actor_id', $1, true)", str(ADMIN))    # 계정 쓰기 = 행위자 필수(감사 트리거)
            for u in users:
                await c.execute("""INSERT INTO app.user_account (user_id, email, role, operator, scope_brands, scope_countries, menu_groups)
                                   VALUES ($1, $2, $3::app.user_role, $4::app.operator_scope, $5, $6, $7::app.menu_group[])""",
                                u.uid, f"t-intent-{u.uid.hex[:12]}@example.test", u.role, u.operator, list(u.brands),
                                list(u.countries), list(u.menu) if u.menu is not None else None)
    finally:
        await c.close()


async def drop_users(users: list[TempUser]) -> None:
    c = await su()
    try:
        async with c.transaction():
            await c.execute("SELECT set_config('app.actor_id', $1, true)", str(ADMIN))
            ids = [u.uid for u in users]
            await c.execute("DELETE FROM app.judgment_change WHERE requested_by = ANY($1::uuid[])", ids)
            await c.execute("DELETE FROM app.user_account WHERE user_id = ANY($1::uuid[])", ids)
    finally:
        await c.close()


async def create_project(brand: str, country: str, *, member: tuple[uuid.UUID, str] | None = None) -> uuid.UUID:
    """고객 프로젝트 1개(+ 활성 멤버 1명 선택). 지울 때는 drop_project_ids."""
    pid = uuid.uuid4()
    c = await su()
    try:
        await c.execute("INSERT INTO app.project (project_id, kind, name, brand_code, country_code, created_by) "
                        "VALUES ($1, 'customer', 'intent-test extra', $2, $3, $4)", pid, brand, country, ADMIN)
        if member is not None:
            await c.execute("""INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at)
                               VALUES ($1, $2, $3::app.member_role, 'active', $4, now())""", pid, member[0], member[1], ADMIN)
    finally:
        await c.close()
    return pid


async def drop_project_ids(ids: list[uuid.UUID]) -> None:
    c = await su()
    try:
        await c.execute("DELETE FROM app.project WHERE project_id = ANY($1::uuid[])", ids)
    finally:
        await c.close()


async def add_tracked(pid: uuid.UUID, term: str, country: str | None) -> None:
    """저장 국가 = ISO 대문자(DB-v2.7 CHECK ptk_country_upper, 검증 m-4). 호출자는 프리셋 id(소문자)를 줘도 된다."""
    c = await su()
    try:
        await c.execute("INSERT INTO app.project_tracked_keyword (project_id, term, country_code) VALUES ($1, $2, $3)", pid, term,
                        country.upper() if country else None)
    finally:
        await c.close()
