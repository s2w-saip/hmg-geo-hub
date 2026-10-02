"""app.core.ecat 매처 단위 시험(DB 없음). 설계 8절 E2 수용 기준: 표면 픽스처 30종 이상에서 단어 내부 적중 0, 멱등, 한·중·일·영 혼합 본문.

픽스처 표 FIXTURES: (표면, 본문, 기대 적중 원문 조각 목록). 음성 사례(빈 목록)는 전부 "표면이 더 긴 단어 안에 들어 있는" 본문이다.
기대 목록은 원문 표기 그대로(text[start:end]) 비교해 오프셋까지 단언한다.
"""
from __future__ import annotations

import random

import pytest

from app.core.ecat.matcher import (
    Hit,
    ScopeMention,
    SurfaceSpec,
    build_rematch_mentions,
    compile_surfaces,
    hits_of,
    match_text,
    resolve_overlaps,
    scan_text,
)
from app.core.ecat.text import fold, infer_surface_lang, normalize_surface, passes_word_boundary

FIXTURES: list[tuple[str, str, list[str]]] = [
    # Scope 사고 표면(제안서 §2·§5)
    ("N", "también la información", []),
    ("N", "también", []),                                   # NFD 결합 악센트 뒤 n
    ("N", "Hyundai N Vision 74 and the N-Line", ["N", "N"]),
    ("Epit", "Il prodotto è percepito come affidabile", []),
    ("Epit", "Epit, un marchio.", ["Epit"]),
    ("pass", "passenger cars, bypass roads, a compass", []),
    ("pass", "Pass de recharge", ["Pass"]),
    ("HMIL", "HMILY tech, sHMIL", []),
    ("HMIL", "HMIL (Hyundai Motor India) said", ["HMIL"]),
    ("Probe", "probeer het, probed", []),
    ("Probe", "Ford Probe", ["Probe"]),
    ("X", "Xbox, BMW X5, xenon", []),
    ("X", "model X 출시", ["X"]),
    # 짧은 라틴 표면
    ("GV", "GV80, GV70, GVs", []),
    ("GV", "GV 라인업과 GV의 전략", ["GV", "GV"]),
    ("EV6", "EV60 KEV6 EV6s", []),
    ("EV6", "EV6가 1위, EV6.", ["EV6", "EV6"]),
    ("BMW", "BMWs iBMW", []),
    ("BMW", "BMW의 선택, BMW's lineup, ＢＭＷ", ["BMW", "BMW", "ＢＭＷ"]),
    ("LG", "aLGo LGBT", []),
    ("LG", "LG전자, LG의", ["LG", "LG"]),
    ("KT", "KTX 열차, SKT", []),
    ("KT", "KT와 SKT", ["KT"]),
    ("Kia", "Nokia, Kiara, Kias", []),
    ("Kia", "KIA는 Kia-Hyundai", ["KIA", "Kia"]),
    ("i30", "Hi30 i30N", []),
    ("i30", "Hyundai i30, i30 N", ["i30", "i30"]),
    ("DS", "DSG gearbox, ads", []),
    ("DS", "DS 7 Crossback", ["DS"]),
    ("Ram", "Ramadan program RAMs", []),
    ("Ram", "RAM 1500", ["RAM"]),
    # 일반어 류(설계 1-5: Plus·Modern)
    ("Plus", "Plusieurs modèles, surplus", []),
    ("Plus", "Galaxy Plus, PLUS", ["Plus", "PLUS"]),
    ("Modern", "Modernization, modernes, hypermodern", []),
    ("Modern", "Modern design", ["Modern"]),
    ("Mini", "minimum miniature", []),
    ("Mini", "MINI Cooper", ["MINI"]),
    ("Apple", "pineapple Applebee", []),
    ("Apple", "Apple CarPlay", ["Apple"]),
    ("Genesis", "Regenesis", []),
    ("Genesis", "Genesis의 GV80", ["Genesis"]),
    ("Hyundai N", "Hyundai Nexo", []),
    ("Hyundai N", "Hyundai  N 브랜드, Hyundai\nN", ["Hyundai  N", "Hyundai\nN"]),
    ("Ioniq 5", "Ioniq 50", []),
    ("Ioniq 5", "IONIQ 5와 Ioniq 5", ["IONIQ 5", "Ioniq 5"]),
    # 발음 구별 기호·정규화
    ("Škoda", "Škodas, SKODA", []),                             # 복수형은 단어 내부, 기호 없는 표기는 다른 표면
    ("Škoda", "Škoda Octavia", ["Škoda"]),
    ("Citroën", "Citroën C4", ["Citroën"]),          # NFD 원문
    ("Straße", "STRASSE 1", ["STRASSE"]),                       # casefold ß = ss
    # 한글
    ("현대", "근현대사, 전근현대", []),
    ("현대", "현대차는 현대자동차의", ["현대", "현대"]),
    ("기아", "시기아", []),
    ("기아", "기아차와 기아의", ["기아", "기아"]),
    # 한자·가나(띄어쓰기 없는 체계: 부분 문자열이 설계 의도, 오탐은 린트 L2 담당)
    ("现代", "现代汽车 现代化", ["现代", "现代"]),
    ("现代", "現代自動車", []),                                   # 번체·일본 표기는 다른 코드포인트
    ("ヒョンデ", "ヒョンデの新型", ["ヒョンデ"]),
    ("起亚", "起亚汽车", ["起亚"]),
    # 키릴·히브리·아랍
    ("Лада", "Ладакх", []),
    ("Лада", "Лада Веста", ["Лада"]),
    ("סקודה", "וסקודה", ["סקודה"]),                              # 한 글자 전치 접어 허용
    ("סקודה", "בוסקודה", []),                                     # 두 글자 앞 = 단어 내부
]


def _hits(surface: str, text: str) -> list[str]:
    compiled = compile_surfaces([SurfaceSpec(1, "E", surface)])
    return [text[h.start:h.end] for h in match_text(text, compiled)]


def test_fixture_count_and_distinct_surfaces():
    assert len({normalize_surface(s) for s, _, _ in FIXTURES}) >= 30
    assert len(FIXTURES) >= 60


@pytest.mark.parametrize(("surface", "text", "expected"), FIXTURES, ids=[f"{s}|{t[:18]}" for s, t, _ in FIXTURES])
def test_fixture(surface, text, expected):
    assert _hits(surface, text) == expected


@pytest.mark.parametrize(("surface", "text", "_exp"), FIXTURES, ids=[f"{s}|{t[:18]}" for s, t, _ in FIXTURES])
def test_no_word_internal_hit(surface, text, _exp):
    """모든 적중이 원문에서도 경계를 지킨다(띄어쓰기 체계 표면): 적중 좌우 이웃이 같은 체계 글자·숫자가 아니다."""
    compiled = compile_surfaces([SurfaceSpec(1, "E", surface)])
    f = fold(text)
    for h in match_text(text, compiled):
        assert normalize_surface(text[h.start:h.end]) == normalize_surface(surface)
        # 접은 본문 좌표로 되돌려 같은 경계 함수로 재판정(원문 좌표 = 접은 좌표가 아닌 경우 포함)
        fs = next(i for i in range(len(f.text)) if f.source_span(i, i + 1)[0] == h.start)
        fe = next(i + 1 for i in range(len(f.text) - 1, -1, -1) if f.source_span(i, i + 1)[1] == h.end)
        assert passes_word_boundary(f.text, fs, fe)


def test_offsets_are_codepoints_with_astral_and_expansion():
    text = "🚗İSTANBUL ﬁ HYUNDAI 👍 Hyundai"
    compiled = compile_surfaces([SurfaceSpec(7, "H", "Hyundai")])
    hits = match_text(text, compiled)
    assert [text[h.start:h.end] for h in hits] == ["HYUNDAI", "Hyundai"]
    assert hits[0].start == text.index("HYUNDAI")                 # İ(1→2)·ﬁ(1→2) 확장 뒤에도 원문 코드포인트
    assert hits[1].start == text.rindex("Hyundai")


def test_mixed_language_answer():
    text = ("2026년 판매 1위는 현대차(Hyundai)였고, 기아의 EV6가 뒤를 이었다. 中国市场上现代汽车和起亚表现稳定。"
            "日本ではヒョンデのIONIQ 5が話題。In the US, Hyundai N and Kia were strong; Nokia and passengers are unrelated.")
    specs = [SurfaceSpec(1, "HY", "Hyundai"), SurfaceSpec(2, "HY", "현대"), SurfaceSpec(3, "HY", "现代"), SurfaceSpec(4, "HY", "ヒョンデ"),
             SurfaceSpec(5, "KIA", "Kia"), SurfaceSpec(6, "KIA", "기아"), SurfaceSpec(7, "KIA", "起亚"), SurfaceSpec(8, "EV6", "EV6"),
             SurfaceSpec(9, "IQ5", "IONIQ 5"), SurfaceSpec(10, "HN", "Hyundai N"), SurfaceSpec(11, "X", "pass")]
    compiled = compile_surfaces(specs)
    got = [(text[h.start:h.end], h.entity_id) for h in match_text(text, compiled)]
    assert got == [("현대", "HY"), ("Hyundai", "HY"), ("기아", "KIA"), ("EV6", "EV6"), ("现代", "HY"), ("起亚", "KIA"),
                   ("ヒョンデ", "HY"), ("IONIQ 5", "IQ5"), ("Hyundai N", "HN"), ("Kia", "KIA")]


def test_idempotent_and_order_independent():
    text = "Hyundai N, Hyundai, 현대, 现代汽车, BMW X5, GV80, GV " * 3
    specs = [SurfaceSpec(i, f"E{i % 4}", s) for i, s in enumerate(["Hyundai", "Hyundai N", "현대", "现代", "BMW", "GV", "X"], 1)]
    a = scan_text(text, compile_surfaces(specs))
    b = scan_text(text, compile_surfaces(specs))
    shuffled = specs[:]
    random.Random(7).shuffle(shuffled)
    c = scan_text(text, compile_surfaces(shuffled))
    assert a == b == c
    ra = resolve_overlaps(hits_of(a.values()))
    rb = resolve_overlaps(list(reversed(hits_of(c.values()))))
    assert ra == rb
    assert resolve_overlaps(ra) == ra                                 # 겹침 제거 결과에 다시 적용해도 같다


def test_scan_is_per_surface_and_resolve_prefers_longer():
    text = "Hyundai N and Hyundai"
    compiled = compile_surfaces([SurfaceSpec(1, "H", "Hyundai"), SurfaceSpec(2, "HN", "Hyundai N")])
    scans = scan_text(text, compiled)
    assert scans[1].starts == (0, 14) and scans[1].ends == (7, 21)   # 표면별 독립: 짧은 표면도 0 에서 적중으로 저장
    assert scans[2].starts == (0,) and scans[2].n_occ == 1 and scans[2].first_start == 0
    kept = resolve_overlaps(hits_of(scans.values()))
    assert [(h.start, h.end, h.surface_id) for h in kept] == [(0, 9, 2), (14, 21, 1)]


def test_resolve_excludes_scope_occupied_spans():
    text = "Hyundai N and Hyundai"
    compiled = compile_surfaces([SurfaceSpec(1, "H", "Hyundai"), SurfaceSpec(2, "HN", "Hyundai N")])
    kept = match_text(text, compiled, occupied=[(0, 7)])                # Scope 가 0..7 을 이미 언급으로 셈
    assert [(h.start, h.surface_id) for h in kept] == [(14, 1)]


def test_resolve_same_span_two_entities_keeps_both_once():
    hits = [Hit(0, 3, 1, "A"), Hit(0, 3, 2, "B"), Hit(0, 3, 3, "A"), Hit(1, 5, 4, "C")]
    kept = resolve_overlaps(hits)
    assert [(h.surface_id, h.entity_id) for h in kept] == [(1, "A"), (2, "B")]


def test_leftmost_wins_over_later_longer():
    hits = [Hit(0, 5, 1, "A"), Hit(3, 12, 2, "B")]
    assert [h.surface_id for h in resolve_overlaps(hits)] == [1]


def test_rematch_mentions_attributes():
    text = "Kia and BMW; later BMW again, then Audi."
    compiled = compile_surfaces([SurfaceSpec(1, "BMW", "BMW"), SurfaceSpec(2, "AUDI", "Audi")])
    hits = match_text(text, compiled, occupied=[(0, 3)])
    ms = build_rematch_mentions(text, hits, scope_mentions=[ScopeMention("KIA", 0)], positions_known=True)
    assert [(m.entity_id, m.is_new, m.mention_count, m.first_start, m.avg_position) for m in ms] == [
        ("BMW", True, 2, 8, 2.0), ("AUDI", True, 1, 35, 3.0)]
    for m in ms:
        assert (m.sentiment_positive, m.sentiment_neutral, m.sentiment_negative, m.sentiment_mixed) == (0, 0, 0, 0)
        assert m.sentiment_known is False
        assert m.type_mention == m.mention_count
        assert (m.type_recommendation, m.type_comparison, m.type_definition, m.type_final_choice) == (0, 0, 0, 0)
        assert m.extraction_source == "hub_rematch"
    assert ms[0].surfaces == ("BMW",) and ms[0].starts == (8, 19)


def test_rematch_positions_null_when_unknown():
    text = "BMW and Audi"
    compiled = compile_surfaces([SurfaceSpec(1, "BMW", "BMW"), SurfaceSpec(2, "AUDI", "Audi")])
    hits = match_text(text, compiled)
    assert all(m.avg_position is None for m in build_rematch_mentions(text, hits, positions_known=False))
    # Scope 언급 중 발생 위치 없는 것이 있으면 순위를 못 매긴다
    ms = build_rematch_mentions(text, hits, scope_mentions=[ScopeMention("KIA", None)], positions_known=True)
    assert all(m.avg_position is None for m in ms)


def test_rematch_existing_entity_rules():
    text = "BMW and BMW and Audi"
    compiled = compile_surfaces([SurfaceSpec(1, "BMW", "BMW"), SurfaceSpec(2, "AUDI", "Audi")])
    # BMW: Scope 가 0..3 발생을 이미 가짐 → 겹치지 않는 1개만 더함(is_new False, 위치 불변)
    # AUDI: Scope 언급 있고 발생 행 없음(6~8월) → 존재만 인정, 결과 없음
    hits = match_text(text, compiled, occupied=[(0, 3)])
    ms = build_rematch_mentions(text, hits, scope_mentions=[ScopeMention("BMW", 0), ScopeMention("AUDI", None)],
                                positions_known=True)
    assert [(m.entity_id, m.is_new, m.mention_count, m.avg_position) for m in ms] == [("BMW", False, 1, None)]


def test_compile_rejects_empty_and_duplicate():
    with pytest.raises(ValueError):
        compile_surfaces([SurfaceSpec(1, "E", "   ")])
    with pytest.raises(ValueError):
        compile_surfaces([SurfaceSpec(1, "E", "BMW"), SurfaceSpec(1, "F", "Kia")])


def test_normalize_surface_and_lang():
    assert normalize_surface("  ＢＭＷ   Ｘ５ ") == "bmw x5"
    assert normalize_surface("Citroën") == normalize_surface("Citroën") == "citroën"
    assert normalize_surface("ΟΔΟΣ") == normalize_surface("οδος")         # casefold: 어말 시그마 문맥 무관
    assert [infer_surface_lang(s) for s in ("현대", "ヒョンデ", "现代", "Hyundai", "Лада")] == ["ko", "ja", "zh", "en", "und"]


def test_empty_text_and_no_hits():
    compiled = compile_surfaces([SurfaceSpec(1, "E", "BMW")])
    assert scan_text("", compiled) == {}
    assert scan_text("nothing here", compiled) == {}
