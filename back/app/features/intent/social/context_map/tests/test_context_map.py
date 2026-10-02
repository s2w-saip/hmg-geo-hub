"""intent.social.context_map 테스트: 합성 스냅샷(손계산 기대값)·키셋 페이지·검색 이스케이프·버킷·상세·스냅샷 없음·xlsx·권한."""
from __future__ import annotations

import io
import re
import uuid
import zipfile
from urllib.parse import quote
from xml.sax.saxutils import unescape

import pytest_asyncio

from app.core.config import get_settings, set_settings
from app.core.xlsx import XlsxReader
from app.features.intent.keywords.research.tests import intent_fixtures as fx
from app.features.intent.social.context_map.service import categorize, like_pattern
from tests.support import HQ_HYUNDAI, KIA_US, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db
BASE = "/v1/intent/social/context-map"
SNAP_A, SNAP_B = 30001, 30002


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def ctx(seeded):
    a = await fx.build_ctx_world(SNAP_A)
    b = await fx.build_ctx_world(SNAP_B)
    base = get_settings()
    _use(a.industry)                    # 산업 = core.config context_map_industry_entity_id(intent R2: get_ctx_config 폐기)
    yield a, b
    set_settings(base)
    await fx.drop_ctx_world(SNAP_A)
    await fx.drop_ctx_world(SNAP_B)


def _use(industry: uuid.UUID | None) -> None:
    set_settings(get_settings().model_copy(update={"context_map_industry_entity_id": industry}))


def read_workbook(data: bytes) -> dict[str, list[list[str]]]:
    """검증용 역변환: 시트명 → 행(문자열, 빈 칸 생략). core.xlsx.XlsxReader 는 첫 시트만 읽으므로 시트 목록·2~3번째 시트는 zipfile 로 본다
    (intent R6: 기능 안 xlsx 작성기·read_workbook 폐기, core.xlsx 작성기 출력 = 인라인 문자열·숫자 셀)."""
    out: dict[str, list[list[str]]] = {}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = re.findall(r'<sheet name="([^"]*)"', z.read("xl/workbook.xml").decode())
        for i, nm in enumerate(names):
            xml = z.read(f"xl/worksheets/sheet{i + 1}.xml").decode()
            rows = []
            for row in re.findall(r"<row [^>]*>(.*?)</row>", xml):
                cells = re.findall(r"<c [^>]*>(?:<is><t[^>]*>(.*?)</t></is>|<v>(.*?)</v>)</c>", row)
                rows.append([unescape(a or b, {"&quot;": '"'}) for a, b in cells])
            out[unescape(nm, {"&quot;": '"'})] = rows
    return out


def test_pure_helpers():
    assert like_pattern("50%_\\") == "%50\\%\\_\\\\%"
    assert categorize("연비 좋은 차") == "연비·동력" and categorize("50% 할인") == "가격·비용" and categorize("무관") == "기타"


async def test_stats(client_as, ctx):
    a, _ = ctx
    async with client_as(VENDOR) as c:                    # 인증 사용자면 누구나(코퍼스 전역)
        r = await c.get(f"{BASE}/stats")
    assert r.status_code == 200
    assert r.json()["data"] == {"contexts": 3, "conditions": 4, "drives": 4, "combinations": 4, "relationships": 8, "sources": 3}
    m = r.json()["meta"]
    assert m["source"]["snapshot_id"] == SNAP_A and m["as_of"] == "2026-09-01" and m["mode"] == "catalog" and m["suppressed"] == {}


async def test_contexts_keyset_pages(client_as, ctx):
    a, _ = ctx
    async with client_as(HQ_HYUNDAI) as c:
        p1 = await c.get(f"{BASE}/contexts", params={"limit": 2})
        cur = p1.json()["meta"]["page"]["next_cursor"]
        p2 = await c.get(f"{BASE}/contexts", params={"limit": 2, "cursor": cur})
        wrong_sort = await c.get(f"{BASE}/contexts", params={"limit": 2, "cursor": cur, "sort": "name"})
        garbage = await c.get(f"{BASE}/contexts", params={"cursor": "not-a-cursor"})
    i1 = p1.json()["data"]["items"]
    assert [x["name"] for x in i1] == ["주말 가족 여행", "첫 차 구매"]
    assert i1[0] == {"id": str(a.ctx[0]), "name": "주말 가족 여행", "theme_id": "occasion", "theme_name": "상황·시즌", "mention_count": 50,
                     "utterance_count": 60, "linked_count": 3,
                     "sentiment": {"positive": {"num": 6, "den": 10}, "negative": {"num": 2, "den": 10}, "neutral": {"num": 2, "den": 10}}}
    assert i1[1]["theme_id"] == "weird" and i1[1]["theme_name"] == "기타" and i1[1]["sentiment"]["neutral"] == {"num": 0, "den": 0}
    assert p1.json()["meta"]["page"] == {"next_cursor": cur, "limit": 2, "total": 3} and cur
    assert [x["name"] for x in p2.json()["data"]["items"]] == ["출퇴근"] and p2.json()["meta"]["page"]["next_cursor"] is None
    assert p2.json()["data"]["items"][0]["theme_id"] == "기타"
    assert wrong_sort.status_code == 422 and wrong_sort.json()["error"]["code"] == "cursor_invalid"
    assert garbage.status_code == 422


async def test_sort_name_and_dir(client_as, ctx):
    async with client_as(HQ_HYUNDAI) as c:
        asc = await c.get(f"{BASE}/contexts", params={"sort": "name", "dir": "asc"})
        mentions_asc = await c.get(f"{BASE}/contexts", params={"sort": "mentions", "dir": "asc", "limit": 1})
        cur = mentions_asc.json()["meta"]["page"]["next_cursor"]
        nxt = await c.get(f"{BASE}/contexts", params={"sort": "mentions", "dir": "asc", "limit": 1, "cursor": cur})
    c0 = await fx.su()        # 이름 정렬은 DB 정렬 규칙(collation)을 따른다 → 기대값도 DB 에서 독립 조회
    try:
        expect = [r[0] for r in await c0.fetch("SELECT canonical_name FROM ext.ctx_entity WHERE snapshot_id = $1 "
                                                "AND type = 'ConsumerContext' ORDER BY canonical_name, id", SNAP_A)]
    finally:
        await c0.close()
    assert [x["name"] for x in asc.json()["data"]["items"]] == expect and len(expect) == 3
    async with client_as(HQ_HYUNDAI) as c:    # 이름 정렬 키셋: 한 행씩 넘겨도 누락·중복 없음
        seen, cur = [], None
        for _ in range(4):
            pg = (await c.get(f"{BASE}/contexts", params={"sort": "name", "dir": "desc", "limit": 1, **({"cursor": cur} if cur else {})})).json()
            seen += [x["name"] for x in pg["data"]["items"]]
            cur = pg["meta"]["page"]["next_cursor"]
            if not cur:
                break
    assert seen == list(reversed(expect))
    assert [x["mention_count"] for x in mentions_asc.json()["data"]["items"]] == [10]
    assert [x["mention_count"] for x in nxt.json()["data"]["items"]] == [30]


async def test_conditions_search_escape(client_as, ctx):
    async with client_as(KIA_US) as c:
        all_ = await c.get(f"{BASE}/conditions")
        pct = await c.get(f"{BASE}/conditions", params={"search": "%"})
        und = await c.get(f"{BASE}/conditions", params={"search": "_"})
        none = await c.get(f"{BASE}/conditions", params={"search": "없는말"})
        long = await c.get(f"{BASE}/conditions", params={"search": "x" * 101})
    items = all_.json()["data"]["items"]
    assert [(x["name"], x["category"], x["linked_count"]) for x in items] == [
        ("연비 좋은 차", "연비·동력", 2), ("50% 할인", "가격·비용", 1), ("넓은 트렁크", "공간·적재", 1), ("기타 조건_x", "기타", 0)]
    assert all_.json()["meta"]["page"]["total"] == 4
    assert [x["name"] for x in pct.json()["data"]["items"]] == ["50% 할인"] and pct.json()["meta"]["page"]["total"] == 1
    assert [x["name"] for x in und.json()["data"]["items"]] == ["기타 조건_x"]
    assert none.json()["data"]["items"] == [] and none.json()["meta"]["page"]["total"] == 0
    assert long.status_code == 422


async def test_combinations(client_as, ctx):
    a, _ = ctx
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get(f"{BASE}/combinations")
        asc = await c.get(f"{BASE}/combinations", params={"dir": "asc", "limit": 3})
        cur = asc.json()["meta"]["page"]["next_cursor"]
        asc2 = await c.get(f"{BASE}/combinations", params={"dir": "asc", "limit": 3, "cursor": cur})
        s = await c.get(f"{BASE}/combinations", params={"search": "트렁크"})
    d = r.json()["data"]
    assert d["max_co_count"] == 30
    assert [(x["cond_a_name"], x["cond_b_name"], x["co_count"], x["frequency"]) for x in d["items"]] == [
        ("연비 좋은 차", "50% 할인", 30, "high"), ("연비 좋은 차", "넓은 트렁크", 12, "medium"),
        ("50% 할인", "넓은 트렁크", 9, "low"), ("넓은 트렁크", "기타 조건_x", 5, "low")]
    assert d["items"][0]["id"] == f"{a.cond[0]}:{a.cond[1]}"
    assert [x["co_count"] for x in asc.json()["data"]["items"]] == [5, 9, 12]
    assert [x["co_count"] for x in asc2.json()["data"]["items"]] == [30]
    assert s.json()["meta"]["page"]["total"] == 3


async def test_entity_detail(client_as, ctx):
    a, _ = ctx
    async with client_as(VENDOR) as c:
        r = await c.get(f"{BASE}/entities/{a.ctx[0]}")
        r1 = await c.get(f"{BASE}/entities/{a.cond[0]}")
        miss = await c.get(f"{BASE}/entities/{a.ctx[0].hex[:-4]}ffff")
        bad = await c.get(f"{BASE}/entities/not-uuid")
    d = r.json()["data"]
    assert d["type"] == "ConsumerContext" and d["mention_count"] == 50
    assert [e["quote"] for e in d["evidence"]] == [f"quote {k:02d}" for k in range(8)]
    assert d["source_domains"] == [{"host": "b.test", "count": 9}, {"host": "a.test", "count": 7}]
    assert [(x["name"], x["co_count"], x["strength"]) for x in d["linked"]] == [
        ("연비 좋은 차", 9, "high"), ("50% 할인", 3, "medium"), ("넓은 트렁크", 1, "low")]
    assert [(x["name"], x["strength"]) for x in r1.json()["data"]["linked"]] == [("주말 가족 여행", "high"), ("첫 차 구매", "medium")]
    assert r1.json()["data"]["evidence"] == []
    assert miss.status_code == 404 and bad.status_code == 422


async def test_no_active_snapshot_and_stale_cursor(client_as, ctx):
    a, b = ctx
    async with client_as(HQ_HYUNDAI) as c:
        cur = (await c.get(f"{BASE}/contexts", params={"limit": 1})).json()["meta"]["page"]["next_cursor"]
        try:
            _use(b.industry)                            # 다른 스냅샷(세대) → 409 cursor_stale
            stale = await c.get(f"{BASE}/contexts", params={"limit": 1, "cursor": cur})
            _use(uuid.uuid4())                          # 활성 스냅샷 없음 → '준비 중'
            st = await c.get(f"{BASE}/stats")
            lst = await c.get(f"{BASE}/conditions")
            det = await c.get(f"{BASE}/entities/{a.ctx[0]}")
            ex = await c.get(f"{BASE}/export")
            _use(None)                                   # 설정 없음 + 활성 스냅샷 여럿 → '준비 중'
            amb = await c.get(f"{BASE}/stats")
        finally:
            _use(a.industry)
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "cursor_stale"
    assert st.status_code == 200 and st.json()["data"] is None and st.json()["meta"]["suppressed"] == {"*": "no_active_snapshot"}
    assert lst.json()["data"]["items"] == [] and lst.json()["meta"]["page"]["total"] == 0
    assert det.status_code == 404 and ex.status_code == 409 and ex.json()["error"]["code"] == "no_active_snapshot"
    assert amb.json()["data"] is None


async def test_export_xlsx(client_as, ctx):
    async with client_as(VENDOR) as c:
        r = await c.get(f"{BASE}/export")
        en = await c.get(f"{BASE}/export", params={"lang": "en"})
        bad = await c.get(f"{BASE}/export", params={"lang": "jp"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert "attachment" in r.headers["content-disposition"] and quote("구매맥락지도-") in r.headers["content-disposition"]
    wb = read_workbook(r.content)
    assert list(wb) == ["구매 맥락", "구매 조건", "조합 패턴"]
    assert wb["구매 맥락"] == [["이름", "주제", "긍정%", "부정%", "중립%", "유발 조건", "언급"],
                           ["주말 가족 여행", "상황·시즌", "60", "20", "20", "3", "50"],
                           ["첫 차 구매", "기타", "0", "0", "100", "1", "30"],
                           ["출퇴근", "기타", "33", "33", "33", "0", "10"]]
    assert wb["구매 조건"][1:] == [["연비 좋은 차", "연비·동력", "100", "0", "0", "2", "40"], ["50% 할인", "가격·비용", "50", "50", "0", "1", "20"],
                               ["넓은 트렁크", "공간·적재", "0", "100", "0", "1", "15"], ["기타 조건_x", "기타", "0", "0", "100", "0", "5"]]
    assert wb["조합 패턴"] == [["조건 A", "조건 B", "빈도", "동시 언급"], ["연비 좋은 차", "50% 할인", "강", "30"],
                           ["연비 좋은 차", "넓은 트렁크", "중", "12"], ["50% 할인", "넓은 트렁크", "약", "9"],
                           ["넓은 트렁크", "기타 조건_x", "약", "5"]]
    assert list(read_workbook(en.content)) == ["Buyer contexts", "Purchase Conditions", "Combination patterns"]
    assert bad.status_code == 422
    # core.xlsx 읽기(첫 시트)와도 같은 값(작성기·읽기 한 벌 대조), 응답은 no-store
    first = XlsxReader().read(r.content)
    assert [x.cells for x in first.rows] == wb["구매 맥락"] and r.headers["cache-control"] == "no-store"


async def test_auth_required(client_as, ctx):
    async with client_as(None) as c:
        assert (await c.get(f"{BASE}/stats")).status_code == 401
        assert (await c.get(f"{BASE}/export")).status_code == 401
    async with client_as(SUSPENDED) as c:
        assert (await c.get(f"{BASE}/contexts")).status_code == 401
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get(f"{BASE}/contexts", params={"brand": "Kia", "country": "US"})
    assert r.json()["meta"]["ignored_filters"] == ["brand", "country"] and len(r.json()["data"]["items"]) == 3


# ── 검증 D2: lang 은 export 에서만 자기 파라미터, 조회 5종에서는 ignored_filters 에 드러난다 ──
async def test_lang_reported_as_ignored_outside_export_d2(client_as, ctx):
    a, _ = ctx
    async with client_as(HQ_HYUNDAI) as c:
        stats = await c.get(f"{BASE}/stats", params={"lang": "EN"})
        lst = await c.get(f"{BASE}/contexts", params={"lang": "EN", "country": "US", "engine": "x"})
        cond = await c.get(f"{BASE}/conditions", params={"lang": "EN"})
        combo = await c.get(f"{BASE}/combinations", params={"lang": "EN"})
        ent = await c.get(f"{BASE}/entities/{a.ctx[0]}", params={"lang": "EN"})
        exp = await c.get(f"{BASE}/export", params={"lang": "en"})
    assert stats.json()["meta"]["ignored_filters"] == ["lang"]
    assert lst.json()["meta"]["ignored_filters"] == ["country", "engine", "lang"]
    assert cond.json()["meta"]["ignored_filters"] == ["lang"] and combo.json()["meta"]["ignored_filters"] == ["lang"]
    assert ent.json()["meta"]["ignored_filters"] == ["lang"]
    assert exp.status_code == 200                    # export 는 lang 을 시트 언어로 쓴다
