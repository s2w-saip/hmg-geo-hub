"""analytics.answers.detail(GET /v1/answers/{job_id}) 테스트.

기대값은 합성 픽스처를 손으로 푼 것이다(구현 SQL 복붙 금지). job_id = 90000000-0000-4000-8000-{answer_key 12자리}.
  k1 (global 회차 11·09-14, bgrp5·chatgpt·US·en, 프롬프트 'best suv' 카탈로그 Hyundai·Genesis)
     answer_brand: Hyundai(당사 1, 4회 rk2) · Toyota(경쟁 3회 rk1) · Apple(비경쟁 1)
     원본 언급: Hyundai·Toyota·TOYOTA·Apple(Brand), Hyundai Creta(Product, 롤업 → Tata 엔티티), safety(Feature 5회)
     스탠스: 턴0 Hyundai 긍정 · 턴0 Toyota 중립 · 턴1 Hyundai 부정. 인용 10건(ord 1 hyundai.com/au·9 hyundaiusa.com·10 kia.com = 자사 베이스)
  k9 분석 실패(gap), k12 bgrp8(US), k13 비완료, k14 드롭, k21 웹사이트(인용 숨김 회차), k31 고객 프로젝트.
픽스처의 ing.answer.answer_text 는 비어 있다(body.available=false). 원문이 있는 경로는 번들 결과에 원문만 주입해 검사한다.
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from app.core.filters import CommonFilters, FilterSupport, ignored_axes, resolve_read_context
from app.core.write import get_audit_writer
from app.features.analytics.answers.detail import queries as Q
from app.features.analytics.answers.detail import service as S
from app.features.analytics.answers.detail.render import (
    OccurrenceInput,
    build_sentiment_spans,
    sentence_bounds,
    verify_stance_evidence,
)
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    DB_URL,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    ROOT_PROJECT,
    SUSPENDED,
    TEST_NAME_KEY,
    VENDOR,
    needs_db,
    principal,
)


def jid(k: int) -> str:
    return str(uuid.UUID(f"90000000-0000-4000-8000-{k:012d}"))


def url(k: int) -> str:
    return f"/v1/answers/{jid(k)}"


# ════════════════════════════════════════════════════════════════════════════
# 순수 함수(현행 spans.test.ts·stance-evidence.test.ts 사례 이식)
# ════════════════════════════════════════════════════════════════════════════
EMOJI = "🚗"
TEXT = f"{EMOJI} 추천 정리\n\n제네시스 GV70는 정숙성이 뛰어나 장거리에 적합합니다. 다만 연비는 아쉽습니다.\n- 기아 EV6는 충전이 빠릅니다."


def occ(**over) -> OccurrenceInput:
    s = TEXT.index("제네시스")
    base = dict(own=True, brand_name="Genesis", source_start=s, source_end=s + len("제네시스 GV70"), surface_text="제네시스 GV70",
                sentiment="positive", assertion="recommend", descriptors=("정숙성",), turn_index=1)
    return OccurrenceInput(**(base | over))


def test_sentence_bounds():
    s, e = sentence_bounds(TEXT, TEXT.index("제네시스"), TEXT.index("제네시스") + 3)
    assert TEXT[s:e] == "제네시스 GV70는 정숙성이 뛰어나 장거리에 적합합니다."
    s, e = sentence_bounds(TEXT, TEXT.index("기아"), TEXT.index("기아") + 2)
    assert TEXT[s:e] == "기아 EV6는 충전이 빠릅니다."                 # 불릿 제외
    t = "제네시스는 좋은가? 그렇다. 끝."
    s0 = t.index("좋은가")
    assert t[slice(*sentence_bounds(t, s0, s0 + 4))] == "제네시스는 좋은가?"      # 발생 끝이 종결부호면 다음 문장을 삼키지 않는다
    t = "1234567) 제네시스는 좋습니다."
    g = t.index("제네시스")
    assert t[slice(*sentence_bounds(t, g, g + 4))] == "제네시스는 좋습니다."
    assert TEXT[slice(*sentence_bounds(TEXT, 0, 1))] == f"{EMOJI} 추천 정리"


def test_sentiment_spans_rules():
    spans, skipped = build_sentiment_spans(TEXT, [occ()])
    assert skipped == 0 and len(spans) == 1 and spans[0].sentiment == "positive"
    assert "제네시스 GV70는" in TEXT[spans[0].start:spans[0].end] and spans[0].evidence[0]["assertion"] == "recommend"
    kia = occ(own=False, brand_name="Kia", source_start=TEXT.index("기아"), source_end=TEXT.index("기아") + 6, surface_text="기아 EV6")
    assert build_sentiment_spans(TEXT, [kia]) == ([], 0)                         # 당사 아님 = 칠하지 않는다
    g = TEXT.index("GV70")
    spans, _ = build_sentiment_spans(TEXT, [occ(), occ(brand_name="Hyundai", source_start=g, source_end=g + 4, surface_text="GV70",
                                                     sentiment="negative")])
    assert len(spans) == 1 and spans[0].sentiment == "mixed" and [e["sentiment"] for e in spans[0].evidence] == ["positive", "negative"]
    assert build_sentiment_spans(TEXT, [occ(source_start=0, source_end=3)]) == ([], 1)          # 구간 ≠ surface_text
    bad = [occ(source_start=-1, source_end=3), occ(source_start=5, source_end=5), occ(source_start=0, source_end=len(TEXT) + 10),
           occ(source_start=2, source_end=2, surface_text="")]
    assert build_sentiment_spans(TEXT, bad) == ([], 4)
    a = TEXT.index("적합합니다")
    straddle = occ(source_start=a, source_end=a + len("적합합니다. 다만"), surface_text="적합합니다. 다만", sentiment="negative")
    spans, _ = build_sentiment_spans(TEXT, [occ(), straddle])
    assert len(spans) == 1 and spans[0].sentiment == "mixed" and "아쉽습니다." in TEXT[spans[0].start:spans[0].end]


def test_verify_stance_evidence():
    ans = "현대차는 품질 우려가 함께 지적된다. 기아는 가성비가 좋다."
    quote = "품질 우려가 함께 지적된다"
    st = ans.index(quote)
    assert verify_stance_evidence(ans, 0, quote, st, st + len(quote)) == "verified"
    assert verify_stance_evidence(ans, 0, quote, None, None) == "verified"
    assert verify_stance_evidence(ans, 0, "배터리 화재가 잦다", None, None) == "mismatch"
    assert verify_stance_evidence(ans, 0, quote, 0, 5) == "mismatch"
    assert verify_stance_evidence(ans, 1, quote, st, st + len(quote)) == "unavailable"
    assert verify_stance_evidence(None, 0, quote, None, None) == "unavailable"
    assert verify_stance_evidence(ans, 0, None, 0, 3) == "unavailable"
    for a, b in ((-3, 9), (20, 10), (5, 5), (0, 9999)):
        assert verify_stance_evidence(ans, 0, quote, a, b) == "mismatch"
    t = "🚗🚙 현대차는 좋다"
    assert verify_stance_evidence(t, 0, "현대차는 좋다", 3, 10) == "verified"       # 코드포인트 오프셋


def _ignored(keys: set[str], surface: str) -> list[str]:
    """서비스와 같은 호출(core.filters.ignored_axes + DETAIL_SUPPORT, surface 는 자체 파라미터, project 표면의 project_id 는 선택 게이트)."""
    return ignored_axes(keys, S.DETAIL_SUPPORT, surface, consumed=("surface", "project_id") if surface == "project" else ("surface",))


def test_ignored_axes():
    assert _ignored({"surface", "brand", "from", "to", "engine"}, "global") == ["engine", "period"]
    # website 도 brand[] 가 관점 입력이 됐다(AN-2 요청 관점 = 목록 규칙): 이전 기대 ["brand", "country"] 에서 brand 가 빠진다
    assert _ignored({"brand", "country"}, "website") == ["country"]
    assert _ignored({"brand", "country"}, "project") == ["brand", "country"]
    # 선택 게이트(B002·B003·B004): project 의 project_id 는 쓰는 값, 게이트·lite 파라미터는 공통 축이 아니라 세지 않는다
    assert _ignored({"project_id", "gate_country", "gate_brand", "lite"}, "project") == []
    assert _ignored({"project_id", "gate_country", "gate_brand", "lite"}, "website") == ["project_id"]


# ════════════════════════════════════════════════════════════════════════════
# HTTP: 형태·권한·404
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_detail_shape_global(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(url(1))
    assert r.status_code == 200
    d, meta = r.json()["data"], r.json()["meta"]
    h = d["header"]
    assert d["id"] == jid(1)
    assert h["surface"] == "global" and h["cycle_id"] == "f0000000-0000-4000-8000-000000000011"
    assert h["round_date"] == "2026-09-14" and h["anchor_date"] == "2026-09-14" and h["measured_at"].startswith("2026-09-14T01:00")
    assert (h["engine"], h["country"], h["lang"]) == ("chatgpt", "US", "en")
    assert h["prompt"]["prompt_id"] == "b0000000-0000-4000-8000-000000000001" and h["prompt"]["text"] == "best suv"
    assert h["prompt"]["kind"] == "single" and h["catalog"]["brand"] == "Hyundai"          # 관점 3사: 비트 1 행 우선
    assert (h["analysis_state"], h["gap"], h["is_acr"], h["acr_iter_rank"]) == (0, False, False, 1)
    assert d["body"] == {"available": False, "answer_text": None}                          # 픽스처 원문 없음 → 이하 빈 값(현행 계약)
    assert d["mentions"] == {"brands": [], "models": []} and d["citations"] == [] and d["stances"] == []
    assert meta["mode"] == "snapshot" and meta["as_of"] == "2026-09-14" and meta["cycles"] == ["2026-09-14"]
    assert meta["generation"] == 1 and meta["suppressed"] == {} and meta["surface"] == "global"
    assert "answer_key" not in d and "cyc_key" not in h
    async with client_as(ADMIN) as c:                       # 관점 Genesis → 카탈로그 Genesis 행
        g = await c.get(url(1), params={"brand": ["Genesis"]})
    assert g.json()["data"]["header"]["catalog"]["brand"] == "Genesis"


@needs_db
async def test_detail_gap_and_ignored(client_as):
    async with client_as(ADMIN) as c:
        gap = await c.get(url(9))
        ign = await c.get(url(1), params={"country": ["US"], "engine": ["gemini"], "from": "2026-09-01", "to": "2026-09-30"})
    assert gap.json()["data"]["header"]["gap"] is True and gap.json()["data"]["header"]["analysis_state"] == 3
    assert gap.json()["meta"]["suppressed"] == {"mentions": "analysis_gap"}
    assert ign.status_code == 200 and ign.json()["meta"]["ignored_filters"] == ["country", "engine", "period"]


@needs_db
async def test_detail_not_found_cases(client_as):
    async with client_as(ADMIN) as c:
        for k in (13, 14):                                   # 비완료·드롭(비 served)
            assert (await c.get(url(k))).status_code == 404
        assert (await c.get(f"/v1/answers/{uuid.uuid4()}")).status_code == 404
        mis = await c.get(url(1), params={"surface": "website"})          # 실제 표면과 다름
        bad = await c.get("/v1/answers/not-a-uuid")
        badq = await c.get(url(1), params={"surface": "nope"})
    assert mis.status_code == 404 and mis.json()["error"]["code"] == "not_found"
    assert bad.status_code == 422 and badq.status_code == 422


@needs_db
async def test_detail_scope(client_as):
    async with client_as(None) as c:
        assert (await c.get(url(1))).status_code == 401
    async with client_as(SUSPENDED) as c:
        assert (await c.get(url(1))).status_code == 401
    async with client_as(KIA_US) as c:
        k1 = await c.get(url(1))                             # bgrp5(Hyundai|Genesis) = Kia 관점 모수 밖
        k12 = await c.get(url(12))                           # bgrp8(공통)·US
        k31 = await c.get(url(31))                           # 고객 프로젝트 Hyundai US: 브랜드 스코프 밖
    assert k1.status_code == 404 and k12.status_code == 200 and k31.status_code == 404
    async with client_as(KIA_EU) as c:                       # 권역 국가에 US 없음
        assert (await c.get(url(12))).status_code == 404
    async with client_as(VENDOR) as c:
        assert (await c.get(url(31))).status_code == 200    # 프로젝트 멤버
        assert (await c.get(url(1))).status_code == 404     # 표준 경로 밖 = 존재 은폐
        r = await c.get(url(1), params={"surface": "global"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    async with client_as(HQ_HYUNDAI) as c:
        assert (await c.get(url(31))).status_code == 200    # 비멤버·스코프 안
        assert (await c.get(url(21))).status_code == 404    # 메뉴 그룹에 website 없음
        r = await c.get(url(21), params={"surface": "website"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"


@needs_db
async def test_detail_website_hidden_citations(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(url(21))
    assert r.status_code == 200 and r.json()["data"]["header"]["surface"] == "website" and r.json()["data"]["header"]["catalog"] is None
    assert r.json()["meta"]["suppressed"] == {"citations": "hidden"}


@needs_db
async def test_detail_access_audit(client_as):
    w = get_audit_writer()
    before = len(w._buf)
    async with client_as(HQ_HYUNDAI) as c:
        assert (await c.get(url(12))).status_code == 200
        assert (await c.get(url(12), params={"surface": "website"})).status_code == 403      # 거부는 기록하지 않는다
    ev = w._buf[before:]
    assert len(ev) == 1 and ev[0].kind == "data_access" and ev[0].target == jid(12) and ev[0].actor_id == HQ_HYUNDAI
    await w.flush()
    c = await asyncpg.connect(DB_URL)
    try:
        n = await c.fetchval("SELECT count(*) FROM app.access_audit_log WHERE actor_id = $1 AND target = $2 AND kind = 'data_access'",
                             HQ_HYUNDAI, jid(12))
    finally:
        await c.close()
    assert n >= 1


# ════════════════════════════════════════════════════════════════════════════
# 번들 SQL(실 DB) + 원문이 있는 조립 경로
# ════════════════════════════════════════════════════════════════════════════
async def _ctx(ro, uid, surface="global", **kw):
    p = await principal(ro, uid)
    return await resolve_read_context(ro, p, CommonFilters(surface=surface, **kw), support=FilterSupport.of(global_=("brand",)))


@needs_db
async def test_bundle_sql_reads_sections(ro):
    ctx = await _ctx(ro, ADMIN)
    from datetime import date

    from app.core.db import fetch_all
    x = Q.BundleInput(answer_key=1, sf=1, project_key=1, round_date=date(2026, 9, 14), cyc_key=11, prompt_key=1,
                      with_catalog=True, with_mentions=True, with_citations=True)
    s = Q.bundle_sql(x, ctx.measure())
    bd = (await fetch_all(ro, s.text, s.params))[0]
    assert bd["body"] == {"answer_text": None, "model_slug": None}
    assert sorted(int(e["brand_bit"]) for e in bd["catalog"]) == [1, 4]
    # 현행 프로필 NAME: 픽스처 'Toyota'(2)·'TOYOTA'(1, 순위 3)는 운영 생성기처럼 표기별 행(끔은 'Toyota' 3 한 행)
    toyota = [("TOYOTA", 1, 3), ("Toyota", 2, 1)] if TEST_NAME_KEY else [("Toyota", 3, 1)]
    assert sorted((b["name"], b["mention_count"], b["rk"]) for b in bd["brands"]) == [("Apple", 1, 0), ("Hyundai", 4, 2), *toyota]
    cits = bd["citations"]
    assert [c["ord"] for c in cits] == list(range(1, 11))
    assert [c["ord"] for c in cits if c["owned"]] == [1, 9, 10]                  # 관점 3사 베이스(hyundai.com/au·hyundaiusa·kia.com/en)
    assert cits[1]["domain"] == "reddit.com" and cits[1]["category"] == "communityForums" and cits[4]["domain"] is None
    assert len(bd["mention_raw"]) == 6 and bd["occurrences"] == []
    assert sorted((st["turn_index"], st["brand"], st["stance"]) for st in bd["stances"]) == [(0, "Hyundai", "positive"), (0, "Toyota", "neutral"),
                                                                                     (1, "Hyundai", "negative")]
    # 숨김 계열은 읽지 않는다
    s2 = Q.bundle_sql(x.__class__(**(x.__dict__ | {"with_mentions": False, "with_citations": False})), ctx.measure())
    bd2 = (await fetch_all(ro, s2.text, s2.params))[0]
    assert bd2["brands"] is None and bd2["stances"] is None and bd2["citations"] is None


@pytest.fixture
def with_text(monkeypatch):
    """번들 결과에 원문만 주입(픽스처 ing 원문이 비어 있어서). 나머지 섹션은 실 DB 값 그대로."""
    orig = S.fetch_all
    body = "Hyundai is solid. Toyota is fine."

    async def fake(conn, sql, params=None):
        rows = await orig(conn, sql, params)
        if rows and "body" in rows[0] and "answer" in rows[0]:
            rows[0]["body"] = {"answer_text": body, "model_slug": "gpt-test"}
        return rows
    monkeypatch.setattr(S, "fetch_all", fake)
    return body


@needs_db
async def test_detail_available_path(client_as, with_text):
    async with client_as(ADMIN) as c:
        r = await c.get(url(1))
    d = r.json()["data"]
    assert d["body"] == {"available": True, "answer_text": with_text} and d["header"]["model_slug"] == "gpt-test"
    if TEST_NAME_KEY:                                       # 현행 프로필 NAME: 대소문자 표기별 행(위 번들 시험과 같은 이유)
        assert d["mentions"]["brands"] == [{"name": "Hyundai", "mention_count": 4, "rank": 2, "own": True},
                                           {"name": "Toyota", "mention_count": 2, "rank": 1, "own": False},
                                           {"name": "Apple", "mention_count": 1, "rank": None, "own": False},
                                           {"name": "TOYOTA", "mention_count": 1, "rank": 3, "own": False}]
    else:
        assert d["mentions"]["brands"] == [{"name": "Hyundai", "mention_count": 4, "rank": 2, "own": True},
                                           {"name": "Toyota", "mention_count": 3, "rank": 1, "own": False},
                                           {"name": "Apple", "mention_count": 1, "rank": None, "own": False}]
    assert d["mentions"]["models"] == [{"name": "safety", "mention_count": 5, "avg_position": None, "parent_brand": None},
                                       {"name": "Hyundai Creta", "mention_count": 1, "avg_position": 1.5, "parent_brand": "Tata"}]
    assert [(s["turn_index"], s["brand"], s["own"], s["stance"], s["evidence_match"]) for s in d["stances"]] == [
        (0, "Hyundai", True, "positive", "unavailable"), (0, "Toyota", False, "neutral", "unavailable"),
        (1, "Hyundai", True, "negative", "unavailable")]
    assert len(d["citations"]) == 10 and [c["ord"] for c in d["citations"] if c["owned"]] == [1, 9, 10]
    assert d["sentiment"] == {"spans": [], "skipped": 0}
    async with client_as(KIA_US) as c:                        # 관점 Kia: k12 의 Hyundai 는 당사 아님, 자사 인용 베이스도 Kia US 로 좁음
        r12 = await c.get(url(12))
    assert r12.json()["data"]["mentions"]["brands"] == [{"name": "Hyundai", "mention_count": 1, "rank": 1, "own": False}]
    async with client_as(ADMIN) as c:
        w = await c.get(url(21))
        g = await c.get(url(9))
    assert w.json()["data"]["citations"] == [] and w.json()["data"]["mentions"]["brands"][0]["own"] is True
    assert g.json()["data"]["mentions"] == {"brands": [], "models": []}       # gap: 언급 계열 비움


# ════════════════════════════════════════════════════════════════════════════
# 검증 결함 회귀(197bd92 판정 D1·D2)
# ════════════════════════════════════════════════════════════════════════════
@pytest.fixture
def extra_brand(monkeypatch):
    """번들 결과의 rd.answer_brand 행에 브랜드 하나를 덧붙인다(기능 트리는 rd 쓰기 금지 G6 이라 DB 대신 번들 결과에 주입).
    나머지 섹션은 실 DB 값 그대로. 주입 행은 같은 답변의 첫 행을 본뜬다."""
    orig = S.fetch_all
    extra: list[dict] = []

    async def fake(conn, sql, params=None):
        rows = await orig(conn, sql, params)
        if extra and rows and "brands" in rows[0] and "answer" in rows[0] and rows[0]["brands"]:
            rows[0]["brands"] = list(rows[0]["brands"]) + [rows[0]["brands"][0] | e for e in extra]
        return rows
    monkeypatch.setattr(S, "fetch_all", fake)
    return extra


@needs_db
async def test_detail_website_own_is_request_viewpoint(client_as, with_text, extra_brand):
    """AN-2 website 당사 = 요청 관점(계정 스코프 ∩ brand[], 없으면 스코프 전체): 목록 analytics.answers.list(ctx.own_bits)와 같은 규칙,
    현행 front scope-aggregates.ts:7954(trackedEntityIdsFor(contextBrand ?? brand)) + server.ts:4173-4182(withWebsite contextBrand).
    이전 규칙(D1: 답변 사이트 브랜드 고정, 계정·brand[] 무관)에서 바뀐 이유 = 메인 결정 AN-2. 손계산: Kia DE 사이트 답변 21 에
    Hyundai(당사 비트 1) 언급을 넣는다. ADMIN 무필터 = 3사 관점 → 둘 다 당사, ADMIN brand=Hyundai → Hyundai 만, KIA_EU → Kia 만.
    brand[] 는 접근 범위를 바꾸지 않는다(KIA_EU 의 스코프 밖 brand=Hyundai 는 dropped, 관점은 스코프 Kia)."""
    extra_brand.append({"name": "Hyundai", "own_bit": 1, "mention_count": 2, "rank": 2, "competitive": True})
    async with client_as(ADMIN) as c:
        adm = await c.get(url(21))
        adm_h = await c.get(url(21), params={"brand": ["Hyundai"]})
    async with client_as(KIA_EU) as c:
        kia = await c.get(url(21))
        kia_h = await c.get(url(21), params={"brand": ["Hyundai"]})

    def own(r) -> dict[str, bool]:
        assert r.status_code == 200, r.text
        return {b["name"]: b["own"] for b in r.json()["data"]["mentions"]["brands"]}
    assert own(adm) == {"Hyundai": True, "Kia": True}
    assert own(adm_h) == {"Hyundai": True, "Kia": False}
    assert own(kia) == own(kia_h) == {"Hyundai": False, "Kia": True}
    assert adm_h.json()["meta"]["ignored_filters"] == [] and adm_h.json()["meta"]["dropped_filters"] == {}
    assert kia_h.json()["meta"]["dropped_filters"] == {"brand": ["Hyundai"]}
    assert [b["mention_count"] for b in adm_h.json()["data"]["mentions"]["brands"]] == [2, 1]      # 수치는 관점과 무관


def test_ignored_axes_custom_and_project_id():
    """D2: cf.* 는 'custom', project_id 는 'project_id' 로 ignored_filters 에 드러낸다(website brand 는 관점 입력이 돼 이전 기대에서 빠짐)."""
    keys = {"cf.11111111-1111-1111-1111-111111111111", "project_id", "brand"}
    assert _ignored(keys, "website") == ["custom", "project_id"]
    assert _ignored(keys, "global") == ["custom", "project_id"]


@needs_db
async def test_detail_ignored_custom_and_project_id(client_as):
    """D2 재현: KIA_EU 가 답변 21 에 cf.*·project_id 를 붙이면 custom·project_id 를 무시 고지(website brand 는 관점 입력: 이전 기대에서 빠짐)."""
    async with client_as(KIA_EU) as c:
        r = await c.get(url(21), params={"cf.11111111-1111-1111-1111-111111111111": "x",
                                         "project_id": "a0000000-0000-4000-8000-000000000001", "brand": ["Kia"]})
    assert r.status_code == 200 and r.json()["meta"]["ignored_filters"] == ["custom", "project_id"]


# ════════════════════════════════════════════════════════════════════════════
# 선택 게이트(백로그 B002·B003): 화면(BFF)이 게이트한 범위 밖 답변 = 404. 없으면 종전(계정 스코프만)
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_detail_project_id_gate(client_as):
    """B002 교차 프로젝트 열람 차단. 현행 fetchProjectAnswerBody 는 ?projectId= 프로젝트(assertProjectInScope) + 그 프로젝트 run 소속 답변만 연다.
    k31 = 고객 프로젝트 B(CUST_PROJECT). 프로젝트 A 를 게이트한 화면(BFF 가 A 의 활성 멤버를 확인)에서 B 의 job_id 를 넣으면 404 — HQ_HYUNDAI 는
    B 비멤버지만 스코프 안이라 project_id 없이는 열리던(종전 그대로) 바로 그 경우다. 백엔드는 A 의 멤버십을 보지 않고 답변 프로젝트와의 일치만
    본다(멤버십은 BFF 게이트). 같은 프로젝트면 본문·meta 가 project_id 없을 때와 같고, project_id 는 쓰는 값이라 ignored 가 아니다."""
    other = str(uuid.uuid4())                              # 프로젝트 A(어느 id 든 답변 프로젝트와 다르면 404, 존재 여부를 드러내지 않는다)
    for uid in (HQ_HYUNDAI, VENDOR, ADMIN):
        async with client_as(uid) as c:
            base = await c.get(url(31), params={"surface": "project"})
            same = await c.get(url(31), params={"surface": "project", "project_id": str(CUST_PROJECT)})
            cross = await c.get(url(31), params={"surface": "project", "project_id": other})
            root = await c.get(url(31), params={"surface": "project", "project_id": str(ROOT_PROJECT)})
            bare = await c.get(url(31), params={"project_id": other})          # surface 없이도 실제 표면(project)으로 건다
        assert base.status_code == 200 and same.status_code == 200, (uid, base.text, same.text)
        assert same.json()["data"] == base.json()["data"]
        assert same.json()["meta"]["ignored_filters"] == base.json()["meta"]["ignored_filters"] == []
        for r in (cross, root, bare):
            assert r.status_code == 404 and r.json()["error"]["code"] == "not_found", (uid, r.text)
    async with client_as(VENDOR) as c:                     # 거부는 표면 게이트 다음: 경로 밖 표면은 종전대로 403/404
        r = await c.get(url(1), params={"surface": "global", "project_id": str(CUST_PROJECT)})
    assert r.status_code == 403
    async with client_as(HQ_HYUNDAI) as c:                 # project 는 gate_country·gate_brand 를 쓰지 않는다(종전)
        r = await c.get(url(31), params={"project_id": str(CUST_PROJECT), "gate_country": ["DE"], "gate_brand": ["Kia"]})
    assert r.status_code == 200


@needs_db
async def test_detail_gate_filters_global(client_as):
    """B003 global: 화면 URL 국가·브랜드(gate_country[]·gate_brand[]) 밖이지만 계정 스코프 안인 답변 = 404. 현행 getMirrorAnswerBody 의 IDOR
    게이트(region IN f.region, prompt brand IN f.brand: f = 계정 스코프로 해석한 화면 URL 필터)와 같은 범위. 안이면 본문이 게이트 없을 때와 같다.
    손계산: k1 = US·bgrp5(Hyundai|Genesis 카탈로그), k12 = US·bgrp8(공통 HMG 엄브렐러: 브랜드로 좁히면 빠진다 = 현행 prompts.brand 정확 일치)."""
    async with client_as(ADMIN) as c:
        base = await c.get(url(1))
        ok = [await c.get(url(1), params=q) for q in ({"gate_country": ["US"]}, {"gate_country": ["DE", "US"]},
                                                      {"gate_brand": ["Hyundai"]}, {"gate_brand": ["Genesis", "Kia"], "gate_country": ["US"]})]
        out = [await c.get(url(1), params=q) for q in ({"gate_country": ["DE"]}, {"gate_brand": ["Kia"]},
                                                       {"gate_brand": ["Hyundai"], "gate_country": ["KR"]}, {"gate_country": ["ZZ"]})]
        common = await c.get(url(12))
        common_kia = await c.get(url(12), params={"gate_brand": ["Kia"]})
    assert base.status_code == 200
    for r in ok:
        assert r.status_code == 200 and r.json()["data"] == base.json()["data"], r.text      # 게이트는 관점·값을 바꾸지 않는다
    for r in out:
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found", r.text
    assert common.status_code == 200 and common_kia.status_code == 404
    async with client_as(KIA_US) as c:                     # 스코프 Kia·US
        us = await c.get(url(12), params={"gate_country": ["US"]})
        de = await c.get(url(12), params={"gate_country": ["DE"]})        # 스코프 밖 국가만 = 버려져 빈 집합(화면은 보내지 않는다: 아래 주석)
        hy = await c.get(url(12), params={"gate_brand": ["Hyundai"]})     # 스코프 밖 브랜드는 버림 → 계정 스코프 그대로(넓어지지 않는다)
        k1 = await c.get(url(1), params={"gate_brand": ["Hyundai"]})      # 게이트로 스코프 밖 답변이 열리지 않는다
    # 화면 경로: readStandardFilters 가 스코프 밖 URL 국가를 스코프 전체로 폴백하고 lib/hgh/query.ts urlCountries 가 그 주입값을 빼서
    # gate_country 를 보내지 않는다(현행 폴백과 같은 결과, front answers.parity.test.ts).
    assert us.status_code == 200 and hy.status_code == 200
    assert de.status_code == 404 and k1.status_code == 404


@needs_db
async def test_detail_gate_filters_website(client_as):
    """B003 website: gate_brand[] = 그 브랜드 사이트(현행 withWebsite narrowScopeBrands(scope, brand) → website project ids → run 소속). gate_country
    는 쓰지 않는다: 현행 라우트가 region 을 websiteCountry 로 옮겨 답변 region 게이트가 없다(app/api/scope/answer/route.ts 2026-09-04 사례 —
    worldwide 같은 가상 사이트 국가로 답변 region 을 걸면 전부 '원문 없음'). k21 = Kia DE 사이트 답변."""
    async with client_as(ADMIN) as c:
        base = await c.get(url(21))
        kia = await c.get(url(21), params={"gate_brand": ["Kia"]})
        both = await c.get(url(21), params={"gate_brand": ["Hyundai", "Kia"]})
        hy = await c.get(url(21), params={"gate_brand": ["Hyundai"]})
        ww = await c.get(url(21), params={"gate_country": ["worldwide"]})
        us = await c.get(url(21), params={"gate_country": ["US"]})
    assert base.status_code == 200
    for r in (kia, both, ww, us):
        assert r.status_code == 200 and r.json()["data"] == base.json()["data"], r.text
    assert hy.status_code == 404 and hy.json()["error"]["code"] == "not_found"
    async with client_as(KIA_EU) as c:                     # 스코프 밖 브랜드는 버림 → 스코프(Kia) 사이트(현행 intersectOrFallback)
        assert (await c.get(url(21), params={"gate_brand": ["Hyundai"]})).status_code == 200


@needs_db
async def test_detail_gate_param_validation(client_as):
    async with client_as(ADMIN) as c:
        bad_pid = await c.get(url(31), params={"project_id": "not-a-uuid"})
        bad_gate = await c.get(url(1), params={"gate_country": ["U\x01S"]})
    assert bad_pid.status_code == 422 and bad_gate.status_code == 422


# ════════════════════════════════════════════════════════════════════════════
# lite(백로그 B004): 모달이 쓰지 않는 값을 계산하지 않는다. 어댑터(front answers.ts toMirrorAnswerDetail)가 읽는 값은 같다
# ════════════════════════════════════════════════════════════════════════════
def test_header_sql_lite():
    h_full = Q.header_sql(jid(1), (1,), None, None).text
    h_lite = Q.header_sql(jid(1), (1,), None, None, lite=True).text
    assert "c.cycle_id" in h_full and "c.anchor_date" in h_full
    assert "c.cycle_id" not in h_lite and "c.anchor_date" not in h_lite
    assert h_full.split("WHERE")[1] == h_lite.split("WHERE")[1]             # 게이트 술어는 같다


@needs_db
async def test_bundle_sql_lite(ro):
    from datetime import date

    from app.core.db import fetch_all
    ctx = await _ctx(ro, ADMIN)
    full = Q.BundleInput(answer_key=1, sf=1, project_key=1, round_date=date(2026, 9, 14), cyc_key=11, prompt_key=1,
                         with_catalog=True, with_mentions=True, with_citations=True)
    lite = Q.BundleInput(**(full.__dict__ | {"with_catalog": False, "lite": True}))      # 서비스: lite 면 with_catalog 도 끈다
    fs, ls = Q.bundle_sql(full, ctx.measure()), Q.bundle_sql(lite, ctx.measure())
    for frag in ("rd.catalog_entry", "a.is_rep", "a.acr_iter_rank", "v.model_slug", "c.tgt_hit", "owner_key"):
        assert frag in fs.text and frag not in ls.text, frag
    a = (await fetch_all(ro, fs.text, fs.params))[0]
    b = (await fetch_all(ro, ls.text, ls.params))[0]
    assert b["catalog"] is None and b["answer"]["is_rep"] is None and b["answer"]["acr_iter_rank"] is None
    assert b["body"]["model_slug"] is None and {c["owned"] for c in b["citations"]} == {None} and {c["target_hit"] for c in b["citations"]} == {None}
    keep = ("ord", "url", "title", "domain", "category")
    assert [{k: c[k] for k in keep} for c in a["citations"]] == [{k: c[k] for k in keep} for c in b["citations"]]
    for k in ("prompt", "brands", "mention_raw", "occurrences", "stances"):
        assert a[k] == b[k], k
    assert {k: a["answer"][k] for k in ("analysis_state", "gap", "is_acr")} == {k: b["answer"][k] for k in ("analysis_state", "gap", "is_acr")}
    assert a["body"]["answer_text"] == b["body"]["answer_text"]


@pytest.fixture
def with_text_slug(monkeypatch):
    """with_text 와 같되 model_slug 는 번들 문장이 v.model_slug 를 읽을 때만 채운다(픽스처 원문·슬러그가 비어 있어서. lite 는 읽지 않는다)."""
    orig = S.fetch_all
    body = "Hyundai is solid. Toyota is fine."

    async def fake(conn, sql, params=None):
        rows = await orig(conn, sql, params)
        if rows and "body" in rows[0] and "answer" in rows[0]:
            rows[0]["body"] = {"answer_text": body, "model_slug": "gpt-test" if "v.model_slug" in sql else None}
        return rows
    monkeypatch.setattr(S, "fetch_all", fake)
    return body


def _adapter_view(d: dict) -> dict:
    """front answers.ts toMirrorAnswerDetail 이 읽는 값만(body·measured_at·인용 ord/url/domain/title/category·언급·감성·스탠스)."""
    return {"body": d["body"], "measured_at": d["header"]["measured_at"],
            "citations": [{k: c[k] for k in ("ord", "url", "domain", "title", "category")} for c in d["citations"]],
            "mentions": d["mentions"], "sentiment": d["sentiment"], "stances": d["stances"]}


@needs_db
async def test_detail_lite_same_adapter_fields(client_as, with_text_slug):
    """B004: lite=true 와 기본 응답의 어댑터 사용 값이 같고, lite 면 생략 값이 null(카탈로그·cycle_id·anchor_date·model_slug·is_rep·
    acr_iter_rank·인용 owned·target_hit). 나머지 헤더·meta 도 같다. global(카탈로그·인용)·website(인용 숨김)·project·관점 Kia 를 본다."""
    lite_null = ("catalog", "cycle_id", "anchor_date", "model_slug", "is_rep", "acr_iter_rank")
    for uid, k in ((ADMIN, 1), (ADMIN, 21), (ADMIN, 31), (KIA_US, 12), (ADMIN, 9)):
        async with client_as(uid) as c:
            full = await c.get(url(k))
            lite = await c.get(url(k), params={"lite": "true"})
        assert full.status_code == 200 and lite.status_code == 200, (k, full.text, lite.text)
        fd, ld = full.json()["data"], lite.json()["data"]
        assert ld["body"]["available"] is True and _adapter_view(ld) == _adapter_view(fd), k
        assert all(ld["header"][f] is None for f in lite_null), (k, ld["header"])
        assert all(c["owned"] is None and c["target_hit"] is None for c in ld["citations"]), k
        assert {f: v for f, v in ld["header"].items() if f not in lite_null} == {f: v for f, v in fd["header"].items() if f not in lite_null}
        assert lite.json()["meta"] == full.json()["meta"], k
    async with client_as(ADMIN) as c:                      # 기본 응답(종전)은 값이 그대로 있다
        fd = (await c.get(url(1))).json()["data"]
    assert fd["header"]["catalog"]["brand"] == "Hyundai" and fd["header"]["model_slug"] == "gpt-test" and fd["header"]["is_rep"] is not None
    assert fd["header"]["cycle_id"] == "f0000000-0000-4000-8000-000000000011" and [c["ord"] for c in fd["citations"] if c["owned"]] == [1, 9, 10]
