"""app.core.ecat 린트 단위 시험(DB 없음). 설계 8절 E3 수용 기준: Scope 제안서 §5 반사실 재현
(`N` L1 차단, `Epit` L2 경고, `现代` L2 경고, 병합 순환 L3 차단) + 추적 엔티티 에스컬레이션.

설정 값(허용 목록·일반어 사전·추적 엔티티)은 시험이 주입한다: 코어에 테넌트 값이 없다는 것도 함께 단언한다.
"""
from __future__ import annotations

import json
import pathlib

from app.core.ecat.lint import (
    EntityRow,
    LintConfig,
    RollupRule,
    SurfaceRow,
    VersionSnapshot,
    lint_version,
    rollup_edit_targets,
    tracked_ids,
)

HY, KIA, GEN, ACME, FOO, BAR, BAZ = "hyundai", "kia", "genesis", "acme", "foo", "bar", "baz"

CFG = LintConfig.from_mapping({
    "short_ascii_allowlist": ["LG", "KT", "GV", "SKT", "BMW", "AMG", "HMC", "EV6"],
    "generic_words": {"zh": ["现代"], "en": ["Plus", "Modern", "pass"], "ko": ["현대"]},
    "tracked_entity_ids": [HY, KIA, GEN],
})
BASE = VersionSnapshot(entities=(EntityRow(HY, "own", "Hyundai", brand_code="H"), EntityRow(KIA, "own", "Kia", brand_code="K")))


def _draft(*surfaces: SurfaceRow, entities: tuple[EntityRow, ...] | None = None) -> VersionSnapshot:
    return VersionSnapshot(entities=BASE.entities if entities is None else entities, surfaces=tuple(surfaces))


def _codes(report, level=None):
    return sorted((f.level, f.code) for f in report.findings if level is None or f.level == level)


def _key(report, code, target):
    """확인 키 = 코드|대상|내용 지문. 시험은 (코드, 대상)으로 찾는다."""
    return next(f.key for f in report.findings if f.code == code and f.target == target)


# ── Scope 제안서 §5 반사실 ─────────────────────────────────────────────────────

def test_counterfactual_N_blocked_L1_and_escalated():
    r = lint_version(_draft(SurfaceRow(1, HY, "N", "add")), CFG, base=BASE)
    assert r.blocked
    f = next(f for f in r.findings if f.code == "SURFACE_SINGLE_CHAR")
    assert f.level == "L1" and f.escalate and f.target == "surface:1"


def test_counterfactual_Epit_warned_L2_and_escalated():
    r = lint_version(_draft(SurfaceRow(2, HY, "Epit", "add")), CFG, base=BASE)
    assert not r.blocked
    assert ("L2", "SURFACE_ASCII_4_5") in _codes(r)
    assert all(f.escalate for f in r.findings)                                   # Hyundai = 추적 엔티티
    k = _key(r, "SURFACE_ASCII_4_5", "surface:2")
    assert k in r.needs_ack and k.startswith("SURFACE_ASCII_4_5|surface:2|")


def test_counterfactual_xiandai_warned_L2():
    r = lint_version(_draft(SurfaceRow(3, HY, "现代", "add", lang="zh")), CFG, base=BASE)
    assert not r.blocked
    assert {("L2", "SURFACE_SHORT_NON_LATIN"), ("L2", "SURFACE_GENERIC_WORD")} <= set(_codes(r))
    gw = next(f for f in r.findings if f.code == "SURFACE_GENERIC_WORD")
    assert "zh" in gw.detail and gw.escalate


def test_counterfactual_merge_cycle_blocked_L3():
    ents = BASE.entities + (EntityRow(FOO, "competitor", merge_into=BAR), EntityRow(BAR, "competitor", merge_into=FOO))
    r = lint_version(_draft(entities=ents), CFG, base=BASE)
    assert r.blocked
    assert sorted(f.target for f in r.findings if f.code == "MERGE_CYCLE") == ["entity:bar", "entity:foo"]
    assert not any(f.code == "MERGE_CHAIN" for f in r.findings)                 # 순환은 체인으로 중복 보고하지 않는다


# ── L1 ──────────────────────────────────────────────────────────────────────

def test_L1_short_ascii_outside_allowlist_and_allowlisted_pass():
    r = lint_version(_draft(SurfaceRow(10, ACME, "XY", "add"), SurfaceRow(11, ACME, "abc", "add"),
                            SurfaceRow(12, ACME, "ＢＭＷ", "add"), SurfaceRow(13, ACME, "gv", "add")), CFG, base=BASE)
    l1 = sorted(f.target for f in r.of("L1"))
    assert l1 == ["surface:10", "surface:11"]                                   # 전각 ＢＭＷ = bmw, gv = GV(허용 목록 정규형 비교)


def test_L1_symbols_only_and_accented_short_latin():
    r = lint_version(_draft(SurfaceRow(20, ACME, " -- ", "add"), SurfaceRow(21, ACME, "Öl", "add")), CFG, base=BASE)
    assert _codes(r, "L1") == [("L1", "SURFACE_NO_WORD_CHAR"), ("L1", "SURFACE_SHORT_ASCII")]


def test_L1_does_not_apply_to_block_surfaces():
    """표면 차단은 짧아도 된다(N 차단이 바로 허브 대응 수단). 추적 엔티티 표면 차단은 L2 에스컬레이션."""
    r = lint_version(_draft(SurfaceRow(30, HY, "N", "block"), SurfaceRow(31, None, "Plus", "block")), CFG, base=BASE)
    assert not r.blocked
    assert _codes(r) == [("L2", "TRACKED_ENTITY_EDIT")]
    assert r.findings[0].escalate


def test_existing_surfaces_not_relinted():
    base = VersionSnapshot(BASE.entities, (SurfaceRow(40, ACME, "XY", "add"),))
    r = lint_version(_draft(SurfaceRow(40, ACME, "XY", "add")), CFG, base=base)
    assert r.findings == ()


# ── L2 ──────────────────────────────────────────────────────────────────────

def test_L2_generic_word_any_language_and_ack_flow():
    r = lint_version(_draft(SurfaceRow(50, ACME, "Modern", "add"), SurfaceRow(51, ACME, "Plus", "add")), CFG, base=BASE)
    assert not r.blocked
    k50 = _key(r, "SURFACE_GENERIC_WORD", "surface:50")
    assert set(r.needs_ack) == {k50, _key(r, "SURFACE_GENERIC_WORD", "surface:51"), _key(r, "SURFACE_ASCII_4_5", "surface:51")}
    assert r.unacked([k50]) == tuple(k for k in r.needs_ack if k != k50)
    assert not any(f.escalate for f in r.findings)


def test_L2_observed_collision_escalates_when_other_is_tracked():
    r = lint_version(_draft(SurfaceRow(60, ACME, "Hyundai Motor", "add")), CFG, base=BASE,
                     observed_surfaces={"hyundai motor": [HY]})
    f = next(f for f in r.findings if f.code == "SURFACE_OBSERVED_COLLISION")
    assert f.level == "L2" and f.escalate


def test_L2_dup_across_entities():
    r = lint_version(_draft(SurfaceRow(70, ACME, "Zenith Cars", "add"), SurfaceRow(71, FOO, "zenith  cars", "add")), CFG, base=BASE)
    assert sorted(f.target for f in r.findings if f.code == "SURFACE_DUP_ACROSS_ENTITIES") == ["surface:70", "surface:71"]


def test_L2_tracked_entity_edits():
    ents = (EntityRow(HY, "own", "Hyundai", brand_code="H"), EntityRow(KIA, "hidden", "Kia"),
            EntityRow(ACME, "competitor", merge_into=HY), EntityRow(FOO, "competitor", parent_brand_id=GEN))
    r = lint_version(_draft(entities=ents), CFG, base=BASE)
    edits = sorted(f.target for f in r.findings if f.code == "TRACKED_ENTITY_EDIT")
    assert edits == ["entity:acme", "entity:foo", "entity:kia"]
    assert all(f.escalate for f in r.findings if f.code == "TRACKED_ENTITY_EDIT")


def test_L2_tracked_override_row_deleted():
    r = lint_version(_draft(entities=(EntityRow(HY, "own", "Hyundai", brand_code="H"),)), CFG, base=BASE)
    assert [(f.code, f.target) for f in r.findings] == [("TRACKED_ENTITY_EDIT", "entity:kia")]


# ── L3 ──────────────────────────────────────────────────────────────────────

def test_L3_structure():
    ents = BASE.entities + (
        EntityRow(FOO, "competitor", merge_into=FOO),                          # 자기 병합
        EntityRow(BAR, "competitor", merge_into=BAZ), EntityRow(BAZ, "competitor", merge_into=ACME),   # 체인
        EntityRow("r1", "removed"), EntityRow("m1", "competitor", merge_into="r1"),                    # 제거된 엔티티로 병합
        EntityRow("o1", "own"),                                                  # brand_code 없음
        EntityRow("o2", "own", brand_code="X", merge_into="c9"),                 # 자사인데 병합 원본
        EntityRow(GEN, "removed"),                                               # 추적 엔티티 제거
        EntityRow("p1", "competitor", parent_brand_id="p2"), EntityRow("p2", "competitor", parent_brand_id="p1"),
        EntityRow("p3", "competitor", parent_brand_id="p3"),
        EntityRow("q1", "banned"),
    )
    surfaces = (SurfaceRow(80, "r1", "Rover One", "add"), SurfaceRow(81, None, "Orphan Surface", "add"),
                SurfaceRow(82, ACME, "Acme Motors", "add"), SurfaceRow(83, None, "acme motors", "block"),
                SurfaceRow(84, ACME, "Acme Two", "hide"))
    r = lint_version(VersionSnapshot(ents, surfaces), CFG, base=BASE)
    assert r.blocked
    got = {(f.code, f.target) for f in r.of("L3")}
    assert got >= {("MERGE_SELF", "entity:foo"), ("MERGE_CHAIN", "entity:bar"), ("MERGE_INTO_REMOVED", "entity:m1"),
                   ("OWN_WITHOUT_BRAND_CODE", "entity:o1"), ("OWN_MERGED", "entity:o2"), ("TRACKED_REMOVED", "entity:genesis"),
                   ("PARENT_CYCLE", "entity:p1"), ("PARENT_CYCLE", "entity:p2"), ("PARENT_SELF", "entity:p3"),
                   ("INVALID_ROLE", "entity:q1"), ("SURFACE_ON_INACTIVE_ENTITY", "surface:80"), ("ADD_WITHOUT_ENTITY", "surface:81"),
                   ("ADD_BLOCK_CONFLICT", "surface:82"), ("INVALID_ACTION", "surface:84")}
    assert not any(f.code == "MERGE_CHAIN" and f.target == "entity:baz" for f in r.findings)   # baz → acme 는 체인 끝


def test_own_removed_from_base_is_L3():
    ents = (EntityRow(HY, "removed"), EntityRow(KIA, "own", "Kia", brand_code="K"))
    cfg = LintConfig.build()                                                     # 설정 추적 집합이 비어도 기준 버전 own 은 추적
    r = lint_version(_draft(entities=ents), cfg, base=BASE)
    assert ("TRACKED_REMOVED", "entity:hyundai") in {(f.code, f.target) for f in r.findings}


# ── 기준 대비(D4)·전역 차단 대조(D3)·확인 키 지문 ──────────────────────────

# v1 이관 모양: 자사 행이 병합 원본(자사∩별칭 겹침)이고 별칭 행들이 자사로 병합된다
V1 = VersionSnapshot(entities=(EntityRow(HY, "own", "Hyundai", brand_code="H"), EntityRow("hy_ko", "own", "현대", brand_code="H", merge_into=HY),
                               EntityRow("a1", "competitor", merge_into=HY), EntityRow("a2", "competitor", merge_into=KIA),
                               EntityRow("p9", "competitor", parent_brand_id=GEN)))


def test_unchanged_base_copy_is_clean():
    """반례 CE7: 편집 없는 v1 복사 초안은 차단도 확인도 없다(기존 자사∩별칭 겹침 = INFO, 변경 없는 별칭 행 = L2 없음)."""
    r = lint_version(V1, CFG, base=V1)
    assert not r.blocked and r.needs_ack == ()
    assert _codes(r) == [("INFO", "OWN_MERGED")]
    assert r.as_json()["counts"] == {"L1": 0, "L2": 0, "L3": 0, "INFO": 1}


def test_new_structure_problem_still_L3_and_integrity_always_L3():
    ents = V1.entities + (EntityRow("o3", "own", "X", brand_code="X", merge_into=KIA),)     # 새 자사∩병합 = L3
    r = lint_version(VersionSnapshot(ents), CFG, base=V1)
    assert ("L3", "OWN_MERGED") in _codes(r) and r.blocked
    assert {f.target for f in r.of("L3")} == {"entity:o3"} and {f.target for f in r.of("INFO")} == {"entity:hy_ko"}
    chain = VersionSnapshot(V1.entities + (EntityRow("c1", "competitor", merge_into="a1"),))   # 기준에 있던 체인도 계속 L3
    r2 = lint_version(chain, CFG, base=chain)
    assert ("L3", "MERGE_CHAIN") in _codes(r2) and r2.blocked


def test_changed_alias_row_into_tracked_is_L2_unchanged_is_not():
    ents = tuple(EntityRow("a1", "competitor", merge_into=GEN) if e.entity_id == "a1" else e for e in V1.entities)
    r = lint_version(VersionSnapshot(ents), CFG, base=V1)
    assert [(f.code, f.target) for f in r.of("L2")] == [("TRACKED_ENTITY_EDIT", "entity:a1")]


def test_global_block_matches_tracked_name_surface_or_observed():
    """반례 CE2: 전역 차단 표면이 추적 엔티티 이름·추적 add 표면·관측 표면과 같으면 L2 에스컬레이션."""
    by_name = lint_version(_draft(SurfaceRow(90, None, "HYUNDAI", "block")), CFG, base=BASE)
    f = next(f for f in by_name.findings if f.target == "surface:90")
    assert (f.level, f.code, f.escalate) == ("L2", "TRACKED_ENTITY_EDIT", True)
    by_surface = lint_version(_draft(SurfaceRow(91, KIA, "Kia Motors", "add"), SurfaceRow(92, None, "kia motors", "block")), CFG,
                             base=VersionSnapshot(BASE.entities, (SurfaceRow(91, KIA, "Kia Motors", "add"),)))
    assert any(f.target == "surface:92" and f.code == "TRACKED_ENTITY_EDIT" and f.escalate for f in by_surface.findings)
    by_obs = lint_version(_draft(SurfaceRow(93, None, "Genesis Motor", "block")), CFG, base=BASE, observed_surfaces={"genesis motor": [GEN]})
    assert any(f.target == "surface:93" and f.escalate for f in by_obs.findings)
    other = lint_version(_draft(SurfaceRow(94, None, "Toyota", "block")), CFG, base=BASE, observed_surfaces={"toyota": ["toyota"]})
    assert other.findings == ()                                                # 추적 밖 엔티티 표면 전역 차단은 대상 아님


def test_ack_key_changes_when_target_content_changes():
    """확인 키에 내용 지문: 같은 대상이라도 행 내용이 바뀌면 옛 확인으로 통과하지 않는다."""
    a = lint_version(_draft(entities=(EntityRow(HY, "own", "Hyundai", brand_code="H"), EntityRow(KIA, "hidden", "Kia"))), CFG, base=BASE)
    b = lint_version(_draft(entities=(EntityRow(HY, "own", "Hyundai", brand_code="H"), EntityRow(KIA, "hidden", "Kia", merge_into=HY))), CFG,
                     base=BASE)
    ka = _key(a, "TRACKED_ENTITY_EDIT", "entity:kia")
    assert ka not in b.needs_ack and b.unacked([ka]) == b.needs_ack
    same = lint_version(_draft(entities=(EntityRow(HY, "own", "Hyundai", brand_code="H"), EntityRow(KIA, "hidden", "Kia"))), CFG, base=BASE)
    assert same.needs_ack == a.needs_ack                                       # 같은 내용 = 같은 키


# ── 자사 롤업 대조(검증 N4 잔여: 제품 표면 전역 차단) ───────────────────────

def _rolled_hit(r, sid):
    return next((f for f in r.findings if f.target == f"surface:{sid}"), None)


def test_rollup_rule_matches_engine_overlay():
    """seed _ecat_x·_meff 와 같은 규칙: 덮어쓰기(자기 → 병합 대상) 우선, 없으면 Scope 롤업, 2단(재귀 없음), 제거·별칭 접기."""
    from app.core.ecat.lint import RollupRule
    ents = (EntityRow(HY, "own", "Hyundai", brand_code="H"), EntityRow("hy_alias", "competitor", merge_into=HY),
            EntityRow("p_over", "competitor", parent_brand_id=HY), EntityRow("p_away", "competitor", parent_brand_id=ACME),
            EntityRow("src", "competitor", merge_into="p_over"), EntityRow("chain", "competitor", parent_brand_id="p_over"),
            EntityRow("gone", "removed"), EntityRow("p_gone", "competitor", parent_brand_id="gone"))
    rule = RollupRule(VersionSnapshot(ents), {HY})
    assert rule.own_of("creta", HY) == HY                                       # Scope 롤업 = 자사
    assert rule.own_of("creta", "hy_alias") == HY                               # 롤업 대상이 자사 별칭 → 접기
    assert rule.own_of("fortwo", "smart") is None                               # 자사 아님
    assert rule.own_of("p_over", "smart") == HY                                 # 덮어쓰기가 Scope 롤업보다 앞선다
    assert rule.own_of("p_away", HY) is None                                    # 덮어쓰기로 자사에서 빠짐
    assert rule.own_of("src", None) == HY                                       # 병합 원본은 대상의 관계(2단)
    assert rule.own_of("chain", None) is None                                   # 모 브랜드의 모 브랜드는 따라가지 않는다
    assert rule.own_of("gone", HY) is None and rule.own_of("p_gone", HY) is None  # 제거·롤업 대상 제거
    assert rule.own_of("hy_alias", None) == HY                                  # 자사 별칭 자체
    assert rule.query_ids() == {HY, "hy_alias", "p_over", "src"}


def test_global_block_of_product_rolling_up_to_own_warns():
    base = VersionSnapshot(entities=BASE.entities)
    r = lint_version(_draft(SurfaceRow(95, None, "Creta", "block")), CFG, base=base, rollup_observed={"creta": [("creta", HY)]})
    f = _rolled_hit(r, 95)
    assert f and (f.level, f.code, f.escalate) == ("L2", "TRACKED_ENTITY_EDIT", True) and "롤업" in f.detail
    none = lint_version(_draft(SurfaceRow(96, None, "Fortwo", "block")), CFG, base=base, rollup_observed={"fortwo": [("fortwo", "smart")]})
    assert _rolled_hit(none, 96) is None
    # 같은 관측이어도 초안 덮어쓰기에 따라 바뀐다: 자사 → 경쟁사로 덮어쓰면 경고 없음, 경쟁 제품을 자사로 덮어쓰면 경고
    away = lint_version(VersionSnapshot(BASE.entities + (EntityRow("creta", "competitor", parent_brand_id=ACME),), (SurfaceRow(95, None, "Creta", "block"),)),
                        CFG, base=base, rollup_observed={"creta": [("creta", HY)]})
    assert _rolled_hit(away, 95) is None
    into = lint_version(VersionSnapshot(BASE.entities + (EntityRow("fortwo", "competitor", "Smart Fortwo", parent_brand_id=KIA),),
                                        (SurfaceRow(96, None, "Fortwo", "block"), SurfaceRow(97, None, "smart fortwo", "block"))),
                        CFG, base=base, rollup_observed={"fortwo": [("fortwo", "smart")]})
    assert _rolled_hit(into, 96) is not None and _rolled_hit(into, 97) is not None   # 관측 표면 + 초안 이름(덮어쓰기 자사 롤업)


# ── 추적 밖 자사 귀속 엔티티 편집(5차: 'Hyundai India' 류, 접두 교정으로 자사) ─────

INDIA, RIVAL = "india", "rival"                                  # INDIA: 덮어쓰기 없이 자사(Hyundai) 귀속(차원), RIVAL: 순수 경쟁사
OWN_LBL = {HY: "Hyundai", KIA: "Kia"}


def _own_edits(r):
    return [f for f in r.findings if f.code == "OWN_ATTRIBUTED_EDIT"]


def test_own_attributed_entity_edits_warn_with_brand():
    so = {INDIA: HY}
    for ents, what in (((EntityRow(INDIA, "removed"),), "제거"), ((EntityRow(INDIA, "competitor", merge_into=RIVAL),), "병합"),
                       ((EntityRow(INDIA, "competitor", parent_brand_id=RIVAL),), "모 브랜드")):
        r = lint_version(_draft(entities=BASE.entities + ents), CFG, base=BASE, scope_own=so, own_labels=OWN_LBL)
        f = _own_edits(r)
        assert len(f) == 1 and f[0].level == "L2" and f[0].escalate and f"({what})" in f[0].detail and "Hyundai KPI" in f[0].detail, r.findings
    # 순수 경쟁사 편집 = 경고 없음
    quiet = lint_version(_draft(entities=BASE.entities + (EntityRow(RIVAL, "removed"),)), CFG, base=BASE, scope_own=so, own_labels=OWN_LBL)
    assert _own_edits(quiet) == [] and not any(f.level == "L2" for f in quiet.findings)
    # 경쟁 엔티티를 자사로 덮어쓰기 = 초안 귀속이 자사 → 경고(Kia KPI)
    into = lint_version(_draft(entities=BASE.entities + (EntityRow(RIVAL, "competitor", parent_brand_id=KIA),)), CFG, base=BASE,
                        scope_own=so, own_labels=OWN_LBL)
    assert [("Kia KPI" in f.detail) for f in _own_edits(into)] == [True]
    # 기준에 있던 덮어쓰기 행 삭제(모 브랜드 Kia → 기본): 기준 귀속 Kia → 경고
    base2 = VersionSnapshot(BASE.entities + (EntityRow(RIVAL, "competitor", parent_brand_id=KIA),))
    gone = lint_version(_draft(entities=BASE.entities), CFG, base=base2, scope_own=so, own_labels=OWN_LBL)
    assert [("덮어쓰기 행 삭제" in f.detail and "Kia KPI" in f.detail) for f in _own_edits(gone)] == [True]


def test_entity_limited_block_on_own_attributed_entity_warns():
    r = lint_version(_draft(SurfaceRow(98, INDIA, "India", "block")), CFG, base=BASE, scope_own={INDIA: HY}, own_labels=OWN_LBL)
    f = next(f for f in r.findings if f.target == "surface:98")
    assert (f.level, f.code, f.escalate) == ("L2", "OWN_ATTRIBUTED_EDIT", True) and "Hyundai KPI" in f.detail
    none = lint_version(_draft(SurfaceRow(99, RIVAL, "Rival", "block")), CFG, base=BASE, scope_own={INDIA: HY}, own_labels=OWN_LBL)
    assert not any(f.target == "surface:99" for f in none.findings)


def test_own_attributed_kpi_neutral_edits_are_quiet_and_increases_warn():
    """검증 5차 3(probe_own_lint): 숨김·이름만 변경은 KPI 불변이라 경고 없음. 자사 귀속 엔티티 add 표면 추가·기존 엔티티 한정 차단 해제는
    자사 언급을 늘리므로 L2."""
    so = {INDIA: HY}
    for ents in ((EntityRow(INDIA, "hidden", "Hyundai India"),), (EntityRow(INDIA, "competitor", "India X"),)):
        r = lint_version(_draft(entities=BASE.entities + ents), CFG, base=BASE, scope_own=so, own_labels=OWN_LBL)
        assert _own_edits(r) == [], r.findings
    add = lint_version(_draft(SurfaceRow(110, INDIA, "India SUV", "add")), CFG, base=BASE, scope_own=so, own_labels=OWN_LBL)
    f = [x for x in add.findings if x.target == "surface:110" and x.code == "OWN_ATTRIBUTED_EDIT"]
    assert len(f) == 1 and f[0].level == "L2" and f[0].escalate and "늘 수 있다" in f[0].detail
    base_blk = VersionSnapshot(BASE.entities, (SurfaceRow(111, INDIA, "India", "block"),))
    rel = lint_version(_draft(), CFG, base=base_blk, scope_own=so, own_labels=OWN_LBL)
    f = [x for x in rel.findings if x.target == "surface:111"]
    assert [(x.level, x.code) for x in f] == [("L2", "OWN_ATTRIBUTED_EDIT")] and "차단 해제" in f[0].detail
    quiet = lint_version(_draft(), CFG, base=VersionSnapshot(BASE.entities, (SurfaceRow(112, RIVAL, "Rival", "block"),)), scope_own=so,
                         own_labels=OWN_LBL)
    assert not any(x.target == "surface:112" for x in quiet.findings)                  # 순수 경쟁사 차단 해제 = 경고 없음



def test_rollup_target_removal_drops_entity_own_and_warns_on_target():
    """검증 N8(CE27): 덮어쓰기 없는 INDIA 의 Scope 롤업이 RIVAL 뿐이면 RIVAL 제거 → 엔티티 귀속 없음(접두 교정 전에 롤업 대상 제거, 엔진 순서),
    린트는 편집 대상 RIVAL 에 L2(자사 귀속 엔티티 수·바뀌는 자사 KPI). 롤업 정보가 없거나 다른 살아 있는 롤업이 남으면 귀속 유지."""
    so, rups = {INDIA: HY}, {INDIA: {RIVAL}}
    rm = _draft(entities=BASE.entities + (EntityRow(RIVAL, "removed", "Rival"),))
    rule = RollupRule(rm, tracked_ids(rm, CFG, BASE))
    assert rule.entity_own(INDIA, so, rups) is None
    assert rule.entity_own(INDIA, so) == HY                                           # 롤업 정보 없음 = 차원 귀속 그대로
    assert rule.entity_own(INDIA, so, {INDIA: {RIVAL, "other"}}) == HY                # 일부 롤업만 제거 = 나머지 언급이 남는다
    ovr = _draft(entities=BASE.entities + (EntityRow(RIVAL, "removed", "Rival"), EntityRow(INDIA, "competitor", "Hyundai India",
                                                                                            parent_brand_id=KIA)))
    assert RollupRule(ovr, tracked_ids(ovr, CFG, BASE)).entity_own(INDIA, so, rups) == KIA   # 덮어쓰기가 롤업 대상 제거보다 먼저
    r = lint_version(rm, CFG, base=BASE, scope_own=so, own_labels=OWN_LBL, scope_rollups=rups)
    f = [x for x in r.findings if x.target == f"entity:{RIVAL}" and x.code == "OWN_ATTRIBUTED_EDIT"]
    assert len(f) == 1 and f[0].level == "L2" and f[0].escalate and "1개" in f[0].detail and "Hyundai KPI" in f[0].detail, r.findings
    assert not [x for x in lint_version(rm, CFG, base=BASE, scope_own=so, own_labels=OWN_LBL).findings if x.target == f"entity:{RIVAL}"]
    hid = _draft(entities=BASE.entities + (EntityRow(RIVAL, "hidden", "Rival"),))  # 숨김·모 브랜드는 롤업 대상으로서 효과 없음
    assert not [x for x in lint_version(hid, CFG, base=BASE, scope_own=so, own_labels=OWN_LBL, scope_rollups=rups).findings
                if x.target == f"entity:{RIVAL}" and x.code == "OWN_ATTRIBUTED_EDIT"]
    assert rollup_edit_targets(rm, BASE) == {RIVAL: "제거"} and rollup_edit_targets(hid, BASE) == {}
    mg = _draft(entities=BASE.entities + (EntityRow(ACME, "removed", "Acme"), EntityRow(RIVAL, "competitor", "Rival", merge_into=ACME)))
    assert rollup_edit_targets(mg, BASE)[RIVAL] == "병합"
    assert RollupRule(mg, tracked_ids(mg, CFG, BASE)).entity_own(INDIA, so, rups) is None     # 롤업 대상의 병합 대상 제거


# ── 결정성·직렬화·테넌트 무상수 ─────────────────────────────────────────────

def test_deterministic_and_json_roundtrip():
    s = (SurfaceRow(1, HY, "N", "add"), SurfaceRow(2, HY, "Epit", "add"), SurfaceRow(3, HY, "现代", "add"))
    a = lint_version(_draft(*s), CFG, base=BASE)
    b = lint_version(_draft(*reversed(s)), CFG, base=BASE)
    assert a == b
    js = json.loads(json.dumps(a.as_json()))
    assert js["blocked"] is True and js["counts"]["L1"] == 1 and js["counts"]["L3"] == 0
    assert js["escalated"] == len(js["findings"])


def test_default_config_has_no_tenant_values():
    cfg = LintConfig.from_mapping(None)
    assert cfg.short_ascii_allowlist == frozenset() and dict(cfg.generic_words) == {} and cfg.tracked_entity_ids == frozenset()
    # 허용 목록이 비면 BMW 도 L1: 코어가 HMG·고객 값을 내장하지 않는다
    r = lint_version(_draft(SurfaceRow(1, ACME, "BMW", "add")), cfg)
    assert r.blocked
    src = (pathlib.Path(__file__).resolve().parents[2] / "app" / "core" / "ecat").glob("*.py")
    body = "\n".join(p.read_text(encoding="utf-8") for p in src)
    for tenant_token in ("'Hyundai'", '"Hyundai"', "'Kia'", '"Kia"', "'Genesis'", '"Genesis"', '"hyundai"'):
        assert tenant_token not in body
