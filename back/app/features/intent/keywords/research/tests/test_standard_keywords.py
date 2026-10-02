"""GET /v1/intent/standard-keywords(BG-41) 테스트: 값(손계산)·권한·브랜드 스코프·필터·빈 결과·422·키셋 페이지.

app.standard_keyword 는 합성 픽스처에 행이 없어 staged(롤백 전용)로 표식 행 7개(ROWS, keyword_id 접두 5eed4100)를 더한다.
표가 비어 있다고 가정하지 않는다(검증 D1): 같은 복제본에서 admin 관심 키워드 테스트가 행을 커밋해 남기므로, 순서·목록 대조는
응답을 표식 keyword_id 로 걸러서 하고, total 은 "독립 SQL 로 센 가시 행 수"(계정별 브랜드 목록을 손으로 적은 술어)와 대조한다.
기대 term 목록은 ROWS 정의에서 손으로 고른 값이다(구현 SQL 을 쓰지 않는다). 정렬 = created_at 내림차순, 동률 keyword_id 오름차순.
한 항목 = 가시 행을 term_norm 으로 합친 묶음(수정 라운드 검증 D4). 그래서 total 대조값은 가시 행의 서로 다른 term_norm 수다.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from app.features.intent.keywords.research import service as research_svc
from tests.support import (
    ADMIN,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    SUSPENDED,
    VENDOR,
    WEBSITE_KIA,
    Rows,
    Sql,
    Update,
    needs_db,
    raw_fetch,
    stage,
    staged,
)

pytestmark = needs_db

URL = "/v1/intent/standard-keywords"

# 계정별 가시 브랜드(tests/support.ACCOUNTS_SQL 의 scope_brands 를 손으로 옮김). None = scope_all(전 브랜드)
VISIBLE = {ADMIN: None, HQ_HYUNDAI: ["Hyundai"], KIA_US: ["Kia"], KIA_EU: ["Kia"]}


def _kid(n: int) -> uuid.UUID:
    return uuid.UUID(f"5eed4100-0000-4000-8000-{n:012d}")


def _row(n: int, term: str, source_type: str, brand: str | None, *, enabled: bool = True) -> dict:
    return {"keyword_id": _kid(n), "term": term, "source_type": source_type, "brand_code": brand, "enabled": enabled,
            "notes": f"내부 메모 {n}", "created_by": ADMIN, "created_at": datetime(2026, 9, n, tzinfo=UTC),
            "updated_at": datetime(2026, 9, n, 12, tzinfo=UTC)}


# n = 생성일(9월 n일). 정렬 기대값은 n 내림차순.
ROWS = Rows("app.standard_keyword", [
    _row(1, "bgi sonata", "google_keyword", "Hyundai"),
    _row(2, "bgi ev6", "google_keyword", "Kia"),
    _row(3, "bgi common suv", "google_keyword", None),
    _row(4, "bgi g80", "google_keyword", "Genesis"),
    _row(5, "bgi disabled", "google_keyword", "Hyundai", enabled=False),
    _row(6, "bgi voc", "community_voc", "Hyundai"),
    _row(7, "bgi hmg", "google_keyword", "HMG"),          # 엄브렐러: scope_all(admin)만 본다
])
MINE = {str(r["keyword_id"]) for r in ROWS.rows}


def _foreign(n: int, term: str, brand: str | None, created_at: datetime, *, source_type: str = "google_keyword",
             enabled: bool = True) -> dict:
    return {"keyword_id": uuid.UUID(f"f0e1a000-0000-4000-8000-{n:012d}"), "term": term, "source_type": source_type,
            "brand_code": brand, "enabled": enabled, "notes": None, "created_by": ADMIN, "created_at": created_at,
            "updated_at": created_at}


# 다른 테스트가 커밋해 남긴 행을 흉내 낸 표식 밖 행(검증 D1 재현): 표식 행 사이·앞에 끼어드는 created_at, 공통·각 브랜드·비활성·VOC.
FOREIGN = Rows("app.standard_keyword", [
    _foreign(1, "ext common late", None, datetime(2030, 1, 1, tzinfo=UTC)),   # 커밋된 행(now())보다도 뒤
    _foreign(2, "ext hyundai mid", "Hyundai", datetime(2026, 9, 3, 6, tzinfo=UTC)),
    _foreign(3, "ext kia early", "Kia", datetime(2026, 8, 30, tzinfo=UTC)),
    _foreign(4, "ext genesis", "Genesis", datetime(2026, 9, 5, 1, tzinfo=UTC)),
    _foreign(5, "ext off", None, datetime(2026, 9, 6, tzinfo=UTC), enabled=False),
    _foreign(6, "ext voc common", None, datetime(2026, 9, 6, tzinfo=UTC), source_type="community_voc"),
])


def _terms(body: dict) -> list[str]:
    return [i["term"] for i in body["data"]["items"]]


def _mine(body: dict) -> list[str]:
    """응답 items 중 표식 행을 품은 항목만(순서 유지)."""
    return [i["term"] for i in body["data"]["items"] if MINE & set(i["keyword_ids"])]


def _brands_ok(body: dict, allowed: set[str | None]) -> bool:
    """모든 항목의 brand_codes 가 allowed 안인가(스코프 밖 누출 0 확인용)."""
    return all(set(i["brand_codes"]) <= allowed for i in body["data"]["items"])


def _norms_unique(body: dict) -> bool:
    """응답 안에서 정규화 term 이 겹치지 않는다(화면 탭 label 유일 가정, D4). 손 규칙 = NFC 없이 strip·lower(테스트 term 은 ASCII)."""
    norms = [i["term"].strip().lower() for i in body["data"]["items"]]
    return len(norms) == len(set(norms))


async def _visible_count(conn, uid: uuid.UUID, source_type: str = "google_keyword", narrow: list[str] | None = None) -> int:
    """독립 기대값: 그 계정이 볼 수 있는 enabled 행의 서로 다른 term_norm 수(공통 NULL 포함, D4 합치기 반영).
    narrow = 요청 brand 중 볼 수 있는 값(손으로 고른 목록)."""
    brands = VISIBLE[uid] if narrow is None else narrow
    rows = await raw_fetch(conn, "SELECT count(DISTINCT app.term_norm(term)) AS n FROM app.standard_keyword WHERE enabled AND source_type = $1 "
                                 "AND ($2::text[] IS NULL OR brand_code IS NULL OR brand_code = ANY($2::text[]))",
                           source_type, brands)
    return int(rows[0]["n"])


async def test_values_shape_and_scope_by_account(client_as):
    async with staged(ROWS) as conn:
        exp = {uid: await _visible_count(conn, uid) for uid in VISIBLE}
        async with client_as(ADMIN) as c:
            ad = await c.get(URL)
        async with client_as(HQ_HYUNDAI) as c:
            hq = await c.get(URL)
        async with client_as(KIA_US) as c:
            ku = await c.get(URL)
        async with client_as(KIA_EU) as c:
            ke = await c.get(URL)
    assert ad.status_code == 200, ad.text
    b = ad.json()
    # admin(전체 스코프): enabled 구글 키워드 전부(비활성 5·VOC 6 제외), created_at 내림차순
    assert _mine(b) == ["bgi hmg", "bgi g80", "bgi common suv", "bgi ev6", "bgi sonata"]
    assert b["data"]["source_type"] == "google_keyword"
    first = next(i for i in b["data"]["items"] if i["keyword_id"] == str(_kid(7)))
    assert set(first) == {"keyword_id", "keyword_ids", "term", "source_type", "brand_codes", "created_at",
                          "updated_at"}                                  # notes·created_by 비노출
    assert first["brand_codes"] == ["HMG"] and first["keyword_ids"] == [str(_kid(7))]
    assert first["created_at"].startswith("2026-09-07") and first["updated_at"].startswith("2026-09-07T12")
    assert b["meta"]["page"]["total"] == exp[ADMIN] and b["meta"]["page"]["limit"] == research_svc.MAX_STANDARD_KEYWORDS
    assert b["meta"]["mode"] == "catalog" and b["meta"]["ignored_filters"] == [] and b["meta"]["dropped_filters"] == {}
    # 브랜드 스코프: 자기 브랜드 + 공통(NULL). 남의 브랜드·엄브렐러는 0건
    assert _mine(hq.json()) == ["bgi common suv", "bgi sonata"] and hq.json()["meta"]["page"]["total"] == exp[HQ_HYUNDAI]
    assert _mine(ku.json()) == ["bgi common suv", "bgi ev6"] and ku.json()["meta"]["page"]["total"] == exp[KIA_US]
    assert _mine(ke.json()) == ["bgi common suv", "bgi ev6"]          # 권역 계정도 브랜드 기준(원천에 국가 없음)
    for r in (hq, ku, ke):                                             # 표식 밖 행도 스코프 밖 브랜드는 없다
        assert _brands_ok(r.json(), {None, "Hyundai" if r is hq else "Kia"})
    for r in (ad, hq, ku, ke):
        assert _norms_unique(r.json())


async def test_foreign_rows_do_not_break_expectations(client_as):
    """검증 D1 회귀: 표에 다른 행(다른 테스트가 커밋한 행 흉내)이 먼저 있어도 표식 대조·total 대조가 맞는다."""
    async with staged(FOREIGN, ROWS) as conn:
        assert len(await raw_fetch(conn, "SELECT 1 FROM app.standard_keyword")) >= 13     # 비어 있다는 전제를 쓰지 않는다
        exp = {uid: await _visible_count(conn, uid) for uid in (ADMIN, HQ_HYUNDAI, KIA_US)}
        exp_kia = await _visible_count(conn, ADMIN, narrow=["Kia"])
        async with client_as(ADMIN) as c:
            ad = await c.get(URL)
            kia = await c.get(URL, params={"brand": "Kia"})
        async with client_as(HQ_HYUNDAI) as c:
            hq = await c.get(URL)
        async with client_as(KIA_US) as c:
            ku = await c.get(URL)
    assert _mine(ad.json()) == ["bgi hmg", "bgi g80", "bgi common suv", "bgi ev6", "bgi sonata"]
    assert ad.json()["meta"]["page"]["total"] == exp[ADMIN] >= 9                        # 표식 5 + 표식 밖 가시 4
    assert _terms(ad.json())[0] == "ext common late"                                   # 표식 밖 행도 같은 정렬에 섞인다
    assert _mine(hq.json()) == ["bgi common suv", "bgi sonata"] and hq.json()["meta"]["page"]["total"] == exp[HQ_HYUNDAI]
    assert "ext kia early" not in _terms(hq.json()) and "ext hyundai mid" in _terms(hq.json())
    assert _mine(ku.json()) == ["bgi common suv", "bgi ev6"] and ku.json()["meta"]["page"]["total"] == exp[KIA_US]
    assert _mine(kia.json()) == ["bgi common suv", "bgi ev6"] and kia.json()["meta"]["page"]["total"] == exp_kia
    assert "ext genesis" not in _terms(kia.json()) and "ext off" not in _terms(ad.json())


async def test_brand_filter_narrows_and_drops(client_as):
    async with staged(ROWS):
        async with client_as(ADMIN) as c:
            kia = await c.get(URL, params={"brand": "Kia"})
            two = await c.get(URL, params=[("brand", "Kia"), ("brand", "Genesis")])
            umb = await c.get(URL, params={"brand": "HMG"})
            unk = await c.get(URL, params=[("brand", "Kia"), ("brand", "NoSuch")])
        async with client_as(KIA_US) as c:
            out = await c.get(URL, params={"brand": "Hyundai"})       # 스코프 밖 → dropped, 스코프 전체로
    assert _mine(kia.json()) == ["bgi common suv", "bgi ev6"]
    assert _mine(two.json()) == ["bgi g80", "bgi common suv", "bgi ev6"]
    assert _mine(umb.json()) == ["bgi hmg", "bgi common suv"]
    assert _mine(unk.json()) == ["bgi common suv", "bgi ev6"] and unk.json()["meta"]["dropped_filters"] == {"brand": ["NoSuch"]}
    ob = out.json()
    assert _mine(ob) == ["bgi common suv", "bgi ev6"] and ob["meta"]["dropped_filters"] == {"brand": ["Hyundai"]}
    assert _brands_ok(ob, {None, "Kia"})                                              # 스코프 밖 누출 0(표식 밖 행 포함)


async def test_source_type_empty_and_ignored_axes(client_as):
    async with staged(ROWS):
        async with client_as(ADMIN) as c:
            voc = await c.get(URL, params={"source_type": "community_voc"})
            ign = await c.get(URL, params={"country": "US", "engine": "chatgpt", "surface": "global"})
            plain = await c.get(URL)
        async with client_as(KIA_US) as c:
            kvoc = await c.get(URL, params={"source_type": "community_voc"})   # 표식 VOC 는 Hyundai 1행뿐
    assert _mine(voc.json()) == ["bgi voc"] and voc.json()["data"]["source_type"] == "community_voc"
    assert all(i["source_type"] == "community_voc" for i in voc.json()["data"]["items"])
    assert kvoc.status_code == 200 and _mine(kvoc.json()) == []
    assert ign.json()["meta"]["ignored_filters"] == ["country", "engine", "surface"]
    assert _terms(ign.json()) == _terms(plain.json())                    # 무시된 축은 값에 영향 없음


async def test_empty_without_rows(client_as):
    """가시 행이 정말 0이면 items [] · total 0(표에 커밋된 행이 있어도 이 트랜잭션에서만 전부 비활성으로 좁힌다: D1)."""
    async with staged(Sql("UPDATE app.standard_keyword SET enabled = false")), client_as(HQ_HYUNDAI) as c:
        r = await c.get(URL)
    assert r.status_code == 200 and r.json()["data"]["items"] == [] and r.json()["meta"]["page"] == {
        "next_cursor": None, "limit": research_svc.MAX_STANDARD_KEYWORDS, "total": 0}


async def test_cap_applies_and_total_reports_all(client_as, monkeypatch):
    monkeypatch.setattr(research_svc, "MAX_STANDARD_KEYWORDS", 2)
    async with staged(Sql("UPDATE app.standard_keyword SET enabled = false"), ROWS), client_as(ADMIN) as c:
        r = await c.get(URL)
    b = r.json()
    assert _terms(b) == ["bgi hmg", "bgi g80"]
    assert b["meta"]["page"]["limit"] == 2 and b["meta"]["page"]["total"] == 5 and b["meta"]["page"]["next_cursor"]


def _bulk(n: int) -> list[dict]:
    """키셋 대조용 공통 행 n개. 3행씩 같은 created_at(동률 → keyword_id 오름차순)."""
    base = datetime(2026, 7, 1, tzinfo=UTC)
    return [{"keyword_id": uuid.UUID(f"b01c0000-0000-4000-8000-{i:012d}"), "term": f"bulk {i:04d}", "source_type": "google_keyword",
             "brand_code": None, "enabled": True, "notes": None, "created_by": ADMIN,
             "created_at": base + timedelta(minutes=i // 3), "updated_at": base} for i in range(n)]


def _bulk_order(n: int) -> list[str]:
    """손계산 정렬: created_at(분 = i//3) 내림차순, 동률은 keyword_id(= i) 오름차순."""
    return [f"bulk {i:04d}" for i in sorted(range(n), key=lambda i: (-(i // 3), i))]


async def test_keyset_cursor_walks_past_cap(client_as):
    """수정 라운드 검증 D2 회귀: 상한(500)을 넘는 행도 next_cursor 로 이어 받는다. 중복·누락 없이 손계산 순서와 같고 total 은 전 페이지 공통."""
    n = 520
    async with staged(Sql("UPDATE app.standard_keyword SET enabled = false"), Rows("app.standard_keyword", _bulk(n))), \
            client_as(ADMIN) as c:
        p1 = await c.get(URL)
        p2 = await c.get(URL, params={"cursor": p1.json()["meta"]["page"]["next_cursor"]})
        # 작은 limit 로 끝까지 걸어도 같은 순서(동률 경계가 페이지 사이에 걸리게 limit 7)
        walked: list[str] = []
        cur = None
        pages = 0
        while True:
            params = {"limit": 7} | ({"cursor": cur} if cur else {})
            r = await c.get(URL, params=params)
            assert r.status_code == 200, r.text
            walked += _terms(r.json())
            assert r.json()["meta"]["page"]["total"] == n
            cur = r.json()["meta"]["page"]["next_cursor"]
            pages += 1
            if not cur:
                break
            assert pages < 100
    b1, b2 = p1.json(), p2.json()
    assert len(_terms(b1)) == 500 and b1["meta"]["page"]["total"] == n and b1["meta"]["page"]["next_cursor"]
    assert len(_terms(b2)) == 20 and b2["meta"]["page"]["total"] == n and b2["meta"]["page"]["next_cursor"] is None
    assert _terms(b1) + _terms(b2) == _bulk_order(n)
    assert walked == _bulk_order(n) and pages == 75                     # ceil(520 / 7)


async def test_cursor_exact_end_and_limits(client_as):
    """행 수 = limit 이면 커서 없음. 커서 뒤 행이 그 사이 사라져 빈 페이지가 되어도 total 은 유지(LEFT JOIN LATERAL).
    변조 커서는 422 cursor_invalid, limit 범위 밖은 422."""
    async with staged(Sql("UPDATE app.standard_keyword SET enabled = false"), ROWS) as conn, client_as(ADMIN) as c:
        full = await c.get(URL, params={"limit": 5})
        p1 = await c.get(URL, params={"limit": 4})
        await stage(conn, Update("app.standard_keyword", {"keyword_id": _kid(1)}, {"enabled": False}))   # 5번째(sonata) 삭제 흉내
        p2 = await c.get(URL, params={"limit": 4, "cursor": p1.json()["meta"]["page"]["next_cursor"]})
        bad = await c.get(URL, params={"cursor": "not-a-cursor"})
        l0 = await c.get(URL, params={"limit": 0})
        l501 = await c.get(URL, params={"limit": 501})
    assert _terms(full.json()) == ["bgi hmg", "bgi g80", "bgi common suv", "bgi ev6", "bgi sonata"]
    assert full.json()["meta"]["page"] == {"next_cursor": None, "limit": 5, "total": 5}
    assert _terms(p1.json()) == ["bgi hmg", "bgi g80", "bgi common suv", "bgi ev6"] and p1.json()["meta"]["page"]["next_cursor"]
    assert p2.status_code == 200 and _terms(p2.json()) == [] and p2.json()["meta"]["page"] == {"next_cursor": None, "limit": 4, "total": 4}
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "cursor_invalid"
    assert l0.status_code == 422 and l501.status_code == 422


async def test_cursor_from_other_filter_rejected(client_as):
    """brand 좁히기가 다른 요청의 커서는 422 cursor_invalid(필터 해시)."""
    async with staged(Sql("UPDATE app.standard_keyword SET enabled = false"), ROWS), client_as(ADMIN) as c:
        p1 = await c.get(URL, params={"limit": 2})
        cur = p1.json()["meta"]["page"]["next_cursor"]
        ok = await c.get(URL, params={"limit": 2, "cursor": cur})
        mism = await c.get(URL, params={"limit": 2, "cursor": cur, "brand": "Kia"})
        voc = await c.get(URL, params={"limit": 2, "cursor": cur, "source_type": "community_voc"})
    assert cur and _terms(p1.json()) == ["bgi hmg", "bgi g80"]
    assert _terms(ok.json()) == ["bgi common suv", "bgi ev6"] and ok.json()["meta"]["page"]["total"] == 5
    assert mism.status_code == 422 and mism.json()["error"]["code"] == "cursor_invalid"
    assert voc.status_code == 422 and voc.json()["error"]["code"] == "cursor_invalid"


def _dk(n: int) -> uuid.UUID:
    return uuid.UUID(f"d4d40000-0000-4000-8000-{n:012d}")


def _dup(n: int, term: str, brand: str | None, day: int, *, upd_day: int | None = None, enabled: bool = True) -> dict:
    return {"keyword_id": _dk(n), "term": term, "source_type": "google_keyword", "brand_code": brand, "enabled": enabled,
            "notes": None, "created_by": ADMIN, "created_at": datetime(2026, 9, day, tzinfo=UTC),
            "updated_at": datetime(2026, 9, upd_day or day, tzinfo=UTC)}


# 수정 라운드 검증 D4 재현: 같은 term 이 공통·브랜드 행으로 겹친다. 3번은 공백·대소문자만 다른 같은 term_norm,
# 2·4번은 created_at 동률(대표 = keyword_id 작은 2번), 6번은 비활성(가장 최신이지만 대표가 되면 안 된다).
DUP = Rows("app.standard_keyword", [
    _dup(1, "p common", None, 10),
    _dup(2, "p common", "Kia", 12),
    _dup(3, " P Common ", "Hyundai", 11, upd_day=20),
    _dup(4, "p common", "Genesis", 12),
    _dup(5, "p other", "Kia", 9),
    _dup(6, "p common", "Kia", 30, enabled=False),
])


def _item(body: dict, term_norm: str) -> dict:
    [it] = [i for i in body["data"]["items"] if i["term"].strip().lower() == term_norm]
    return it


async def test_same_term_merged_into_one_item(client_as):
    """수정 라운드 검증 D4 회귀: 공통 'p common' 과 Kia 'p common' 이 KIA_US 에게 두 항목으로 오던 것을 term_norm 으로 합친다.
    기대값은 DUP 정의에서 손으로 계산(대표 = created_at 최신·동률 keyword_id 최소, brand_codes 는 NULL 먼저 정렬, updated_at 최댓값)."""
    async with staged(Sql("UPDATE app.standard_keyword SET enabled = false"), DUP):
        async with client_as(KIA_US) as c:
            ku = await c.get(URL)
        async with client_as(HQ_HYUNDAI) as c:
            hq = await c.get(URL)
        async with client_as(ADMIN) as c:
            ad = await c.get(URL)
            kia = await c.get(URL, params={"brand": "Kia"})
            p1 = await c.get(URL, params={"limit": 1})
            p2 = await c.get(URL, params={"limit": 1, "cursor": p1.json()["meta"]["page"]["next_cursor"]})
    for r in (ku, hq, ad, kia, p1, p2):
        assert r.status_code == 200, r.text
        assert _norms_unique(r.json())
        ids = [i["keyword_id"] for i in r.json()["data"]["items"]]
        assert len(ids) == len(set(ids))
    # KIA_US: 가시 행 1(공통)·2(Kia)·5(Kia) → 항목 2개
    kb = ku.json()
    assert _terms(kb) == ["p common", "p other"] and kb["meta"]["page"]["total"] == 2
    c_ku = _item(kb, "p common")
    assert c_ku["keyword_id"] == str(_dk(2)) and c_ku["keyword_ids"] == [str(_dk(2)), str(_dk(1))]
    assert c_ku["brand_codes"] == [None, "Kia"] and c_ku["created_at"].startswith("2026-09-12")
    assert c_ku["updated_at"].startswith("2026-09-12")
    # HQ_HYUNDAI: 가시 행 1·3 → 대표 3(9/11 > 9/10), 원문 term 은 대표 행 그대로
    hb = hq.json()
    assert _terms(hb) == [" P Common "] and hb["meta"]["page"]["total"] == 1
    c_hq = hb["data"]["items"][0]
    assert c_hq["keyword_id"] == str(_dk(3)) and c_hq["keyword_ids"] == [str(_dk(3)), str(_dk(1))]
    assert c_hq["brand_codes"] == [None, "Hyundai"] and c_hq["updated_at"].startswith("2026-09-20")
    # ADMIN: 가시 행 1~5 → 'p common' 묶음 4행(2·4 동률은 keyword_id 순), 비활성 6 은 없다
    ab = ad.json()
    assert _terms(ab) == ["p common", "p other"] and ab["meta"]["page"]["total"] == 2
    c_ad = _item(ab, "p common")
    assert c_ad["keyword_id"] == str(_dk(2))
    assert c_ad["keyword_ids"] == [str(_dk(2)), str(_dk(4)), str(_dk(3)), str(_dk(1))]
    assert c_ad["brand_codes"] == [None, "Genesis", "Hyundai", "Kia"] and c_ad["updated_at"].startswith("2026-09-20")
    assert str(_dk(6)) not in {k for i in ab["data"]["items"] for k in i["keyword_ids"]}
    # ADMIN brand=Kia 좁히기 = KIA_US 와 같은 묶음
    assert _item(kia.json(), "p common")["keyword_ids"] == [str(_dk(2)), str(_dk(1))] and kia.json()["meta"]["page"]["total"] == 2
    # 페이지 단위도 항목: limit 1 로 두 페이지, 겹침 없음, total 2
    assert _terms(p1.json()) == ["p common"] and _terms(p2.json()) == ["p other"]
    assert p1.json()["meta"]["page"]["total"] == 2 and p2.json()["meta"]["page"]["next_cursor"] is None


async def test_permissions(client_as):
    async with staged(ROWS):
        async with client_as(VENDOR) as c:
            v = await c.get(URL)
        async with client_as(WEBSITE_KIA) as c:
            w = await c.get(URL)
        async with client_as(SUSPENDED) as c:
            s = await c.get(URL)
        async with client_as(None) as c:
            n = await c.get(URL)
    assert v.status_code == 403 and v.json()["error"]["code"] == "role_forbidden"
    assert w.status_code == 403 and w.json()["error"]["code"] == "role_forbidden"
    assert s.status_code == 401 and n.status_code == 401
    # 메뉴 standard 가 없는 hq 계정 → menu_forbidden
    async with staged(ROWS, Update("app.user_account", {"user_id": HQ_HYUNDAI}, {"menu_groups": ["project"]}), actor=ADMIN), \
            client_as(HQ_HYUNDAI) as c:
        m = await c.get(URL)
    assert m.status_code == 403 and m.json()["error"]["code"] == "menu_forbidden"


async def test_bad_params_422(client_as):
    async with client_as(ADMIN) as c:
        st = await c.get(URL, params={"source_type": "bogus"})
        ctl = await c.get(URL, params={"brand": "Kia\x01"})
        long_ = await c.get(URL, params={"brand": "K" * 101})
        many = await c.get(URL, params=[("brand", f"b{i}") for i in range(21)])
    assert st.status_code == 422 and ctl.status_code == 422 and long_.status_code == 422 and many.status_code == 422
