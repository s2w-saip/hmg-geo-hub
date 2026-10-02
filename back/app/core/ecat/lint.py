"""버전 초안 린트(설계 3절 ②, 8절 E3). 순수 함수: 초안·기준 버전 스냅샷과 테넌트 설정을 인자로 받는다(DB·상수 읽기 없음).

등급
- L1 차단(미리보기 거부 ECAT_LINT_BLOCKED): `add` 표면이 정규형 1자, ASCII 2~3자 중 허용 목록 밖, 글자·숫자 없음(공백·기호만).
  ASCII 는 라틴 문자 체계(발음 구별 기호 포함)·숫자·기호로만 된 표면을 뜻한다(`Öl` 같은 짧은 라틴 표면도 같은 위험이라 포함).
- L2 경고(항목별 확인 체크 필요): ASCII 4~5자, 비라틴 2자(1자는 L1), 일반어 사전 적중(언어 무관: 답변이 다국어라 어느 언어의
  일반어든 위험하다, 적중 언어를 detail 에 적는다), 다른 엔티티의 관측 표면과 충돌, 같은 초안에서 한 표면을 두 엔티티에 추가,
  자사(추적) 엔티티 대상 편집(역할·병합·모 브랜드·표면 차단, 자사로의 병합·롤업).
- L3 구조 차단: 자기 병합, 병합 순환, 병합 체인(대상이 다시 병합 원본), 제거된 엔티티로의 병합, 자사 역할인데 병합 원본,
  자사 역할인데 brand_code 없음, 자사(추적) 엔티티 제거, 모 브랜드 자기 참조·순환, 활성이 아닌(제거·병합 원본) 엔티티에 표면 추가,
  엔티티 없는 표면 추가, 같은 표면의 추가·차단 동시 지정, 알 수 없는 역할·동작.
- 에스컬레이션(escalate=True): 대상 엔티티가 추적 집합(설정 tracked_entity_ids ∪ 초안·기준 버전의 role=own)이면 모든 등급에 붙인다
  (Scope 제안서 L4: 배치 일괄 승인 불가, 항목별 확인 + 표본 문맥).

L1·L2 표면 규칙은 기준 버전 대비 **새로 켜진 표면**(같은 surface_id·같은 action 이 기준에 없던 것)에만 적용한다: 이미 활성인
표면을 매번 다시 막지 않는다. 자사 편집 L2(자사로의 병합·롤업, 자사 행 편집)도 기준 대비 새로 생기거나 바뀐 행에만 붙는다.
L3 도 기준 대비 **새로 생긴** 구조 문제만 차단한다: 기준 버전을 그 자신과 린트해 같은 (코드·대상·detail) 이 이미 있으면 등급 INFO
(정보성: 차단·확인 대상 아님)로 내린다. 예: v1 이관의 자사∩별칭 겹침 행(OWN_MERGED)은 이미 활성 내용이라 모든 초안을 막지 않는다.
단 무결성 규칙(INTEGRITY: 자기 병합·병합 순환·체인, 모 브랜드 자기 참조·순환, 알 수 없는 역할·동작)은 기준에 있어도 L3 로 남는다.

전역 차단(entity 없는 block) 표면은 관측 표면(observed_surfaces) ∪ 추적 엔티티의 이름(초안·기준 행 name) ∪ 초안의 추적 엔티티 add
표면과 대조한다: 같으면 L2 TRACKED_ENTITY_EDIT(에스컬레이션). 자사 이름을 전역 차단하면 자사 언급이 통째로 사라지기 때문이다.
추적 밖이지만 자사로 귀속되는 엔티티(예 접두 교정 'Hyundai India')의 편집(제거·병합·모 브랜드 덮어쓰기·역할·덮어쓰기 행 삭제)과 엔티티 한정
표면 차단은 L2 OWN_ATTRIBUTED_EDIT(자사 에스컬레이션, 문구에 바뀌는 자사 KPI): 귀속 = RollupRule.entity_own(기준·초안 각각, 덮어쓰기 없을 때는
호출자가 넘긴 scope_own = 활성 투영 차원의 표시 브랜드 자사). 기준 또는 초안 어느 쪽이든 자사이면 경고한다(보수적).
제거·병합 편집 대상을 Scope 롤업으로 두는 자사 귀속 엔티티가 있으면(호출자가 역방향 조회해 scope_rollups 로 넘긴다) 편집 대상에도
L2 OWN_ATTRIBUTED_EDIT: 롤업 대상이 제거면 엔진은 접두 교정 전에 그 언급의 브랜드 귀속을 버린다(검증 N8, 예 Tata 제거 → 'Hyundai Creta').
자사 브랜드로 롤업되는 엔티티(제품 등)도 같다(검증 N4 잔여): rollup_observed = {정규형: (엔티티, Scope 롤업[, 접두 교정 id])} 관측과 초안 이름·add 표면을
RollupRule(투영 오버레이 seed _ecat_x·_meff 와 같은 규칙: 덮어쓰기(자기 → 병합 대상) 우선, 없으면 Scope 롤업, 2단, 제거·별칭 접기)로
판정해, 자사로 가는 언급이 있으면 L2 TRACKED_ENTITY_EDIT("자사 브랜드로 롤업되는 엔티티 표면 차단", 자사 엔티티 에스컬레이션).

L2 확인 키(Finding.key) = 코드|대상|내용 지문. 지문은 detail 과 대상 행(엔티티 행 또는 표면 행)의 내용이라, 확인한 뒤 그 행이나
충돌 내용이 바뀌면 키가 달라져 확인이 풀린다(같은 대상의 다른 내용을 옛 확인으로 통과시키지 않는다).

설정(LintConfig) 은 테넌트 값이다. 적재 원천은 app.rule_param(설계 7절, 키 예: ecat_lint) 등이고 이 모듈은 값을 주입받기만 한다.
"""
from __future__ import annotations

import hashlib
import unicodedata
from collections.abc import Hashable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from app.core.ecat.text import normalize_surface, script_of

__all__ = ["ROLES", "EntityRow", "Finding", "LintConfig", "LintReport", "RollupRule", "SurfaceRow", "VersionSnapshot", "lint_version",
           "tracked_ids"]

ROLES = frozenset({"own", "competitor", "hidden", "removed"})
ACTIONS = frozenset({"add", "block"})
LEVELS = ("L1", "L2", "L3", "INFO")
# 기준 버전에 이미 있어도 L3 로 남는 무결성 규칙(그 밖의 L3 는 기준에 있던 것이면 INFO)
INTEGRITY = frozenset({"MERGE_SELF", "MERGE_CYCLE", "MERGE_CHAIN", "PARENT_SELF", "PARENT_CYCLE", "INVALID_ROLE", "INVALID_ACTION"})


@dataclass(frozen=True, slots=True)
class EntityRow:
    """ecat_entity 1행(덮어쓸 엔티티만 행을 가진다)."""
    entity_id: Hashable
    role: str = "competitor"
    name: str = ""
    brand_code: str | None = None
    merge_into: Hashable | None = None
    parent_brand_id: Hashable | None = None


@dataclass(frozen=True, slots=True)
class SurfaceRow:
    """ecat_surface(버전이 켠 표면) ⋈ ecat_surface_def. entity_id None = 전역(차단 전용)."""
    surface_id: int
    entity_id: Hashable | None
    surface: str
    action: str
    lang: str | None = None


@dataclass(frozen=True, slots=True)
class VersionSnapshot:
    entities: tuple[EntityRow, ...] = ()
    surfaces: tuple[SurfaceRow, ...] = ()


@dataclass(frozen=True, slots=True)
class LintConfig:
    """테넌트 설정. 값은 정규형(normalize_surface)으로 저장된다."""
    short_ascii_allowlist: frozenset[str] = frozenset()
    generic_words: Mapping[str, frozenset[str]] = field(default_factory=dict)
    tracked_entity_ids: frozenset[Hashable] = frozenset()

    @classmethod
    def build(cls, *, short_ascii_allowlist: Iterable[str] = (), generic_words: Mapping[str, Iterable[str]] | None = None,
              tracked_entity_ids: Iterable[Hashable] = ()) -> LintConfig:
        return cls(short_ascii_allowlist=frozenset(n for n in (normalize_surface(s) for s in short_ascii_allowlist) if n),
                   generic_words={lang: frozenset(n for n in (normalize_surface(w) for w in words) if n)
                                  for lang, words in (generic_words or {}).items()},
                   tracked_entity_ids=frozenset(tracked_entity_ids))

    @classmethod
    def from_mapping(cls, d: Mapping[str, Any] | None) -> LintConfig:
        """설정 jsonb 모양: {"short_ascii_allowlist": [..], "generic_words": {"zh": [..], "en": [..]}, "tracked_entity_ids": [..]}.
        모르는 키는 무시, 없는 키는 빈 값."""
        d = d or {}
        return cls.build(short_ascii_allowlist=d.get("short_ascii_allowlist") or (), generic_words=d.get("generic_words") or {},
                         tracked_entity_ids=d.get("tracked_entity_ids") or ())


@dataclass(frozen=True, slots=True)
class Finding:
    level: str                       # L1 | L2 | L3 | INFO
    code: str
    target: str                      # "surface:<id>" | "entity:<id>"
    detail: str = ""
    entity_id: Hashable | None = None
    surface_id: int | None = None
    escalate: bool = False
    fingerprint: str = ""            # 대상 행 내용 + detail 지문(확인 키에 들어간다)

    @property
    def key(self) -> str:
        """L2 확인 체크의 식별자: 코드|대상|내용 지문(대상 행이나 detail 이 바뀌면 달라진다)."""
        return f"{self.code}|{self.target}|{self.fingerprint}" if self.fingerprint else f"{self.code}|{self.target}"

    def as_json(self) -> dict[str, Any]:
        return {"level": self.level, "code": self.code, "target": self.target, "key": self.key, "detail": self.detail,
                "entity_id": None if self.entity_id is None else str(self.entity_id), "surface_id": self.surface_id,
                "escalate": self.escalate}


@dataclass(frozen=True, slots=True)
class LintReport:
    findings: tuple[Finding, ...]

    def of(self, level: str) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.level == level)

    @property
    def blocked(self) -> bool:
        """L1 또는 L3 가 하나라도 있으면 미리보기 거부(ECAT_LINT_BLOCKED)."""
        return any(f.level in ("L1", "L3") for f in self.findings)

    @property
    def needs_ack(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(f.key for f in self.findings if f.level == "L2"))

    @property
    def escalated(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.escalate)

    def unacked(self, acked: Iterable[str]) -> tuple[str, ...]:
        done = set(acked)
        return tuple(k for k in self.needs_ack if k not in done)

    def as_json(self) -> dict[str, Any]:
        """ecat_version.lint jsonb 모양."""
        return {"blocked": self.blocked,
                "counts": {lv: len(self.of(lv)) for lv in LEVELS},
                "escalated": len(self.escalated),
                "findings": [f.as_json() for f in self.findings]}


# ── 표면 분류 ─────────────────────────────────────────────────────────────────

def _has_word_char(norm: str) -> bool:
    return any(unicodedata.category(ch)[0] in "LN" for ch in norm)


def _is_latin_class(norm: str) -> bool:
    """ASCII 류: 글자는 전부 라틴 체계(발음 구별 기호 포함), 나머지는 숫자·기호·공백·결합 부호."""
    return all(ch.isascii() or unicodedata.category(ch)[0] != "L" or script_of(ch) == "Latin" for ch in norm)


def _generic_langs(norm: str, cfg: LintConfig) -> list[str]:
    return sorted(lang for lang, words in cfg.generic_words.items() if norm in words)


# ── 자사 롤업(엔티티 엔진과 같은 규칙) ─────────────────────────────────────────

def tracked_ids(draft: VersionSnapshot, config: LintConfig, base: VersionSnapshot | None = None) -> set[Hashable]:
    """추적 집합 = 설정 tracked_entity_ids ∪ 초안·기준 버전의 role=own."""
    base = base or VersionSnapshot()
    return set(config.tracked_entity_ids) | {e.entity_id for e in draft.entities if e.role == "own"} \
        | {e.entity_id for e in base.entities if e.role == "own"}


class RollupRule:
    """언급의 브랜드 롤업이 자사(추적)로 가는가. 투영 오버레이(seed-3x-common §4-2 _ecat_x, seed-40 §5-0 _meff)와 같은 규칙:
      ① 엔티티(또는 병합 대상)가 removed 면 언급이 빠진다(자사 KPI 와 무관)
      ② 롤업 = coalesce(관계 덮어쓰기 = coalesce(자기 parent_brand_id, 병합 대상 parent_brand_id), Scope 롤업 brand_rollup_entity_id)  (2단, 재귀 없음)
      ③ 롤업 대상(또는 그 병합 대상)이 removed 면 롤업 없음
      ④ 표시 브랜드 rid(seed-3x-common §6 _bn_pair J1) = 덮어쓰기가 있으면 별칭 접기(롤업), 없으면 접두 교정(표시명이 3사 접두로 시작:
         app.ecat_hmg_prefix_id = seed pg_temp.hmg_prefix_id 사본, 호출자가 prefix_id 로 넘긴다) → 별칭 접기 → 롤업. rid 가 추적이면 자사.
         롤업이 없으면(③ 포함) 접두가 있어도 브랜드 귀속 없음(_mr 은 rollup IS NOT NULL 행만).
    엔티티 자신이 추적(또는 추적으로 병합되는 별칭)이면 그 자체로 자사 언급이다."""

    def __init__(self, draft: VersionSnapshot, tracked: Iterable[Hashable]):
        self.ents = {e.entity_id: e for e in draft.entities}
        self.tracked = set(tracked)
        self.alias = {e.entity_id: e.merge_into for e in draft.entities
                      if e.merge_into is not None and e.merge_into in self.tracked and e.entity_id not in self.tracked}

    def _target(self, eid: Hashable) -> EntityRow | None:
        e = self.ents.get(eid)
        return self.ents.get(e.merge_into) if e is not None and e.merge_into is not None else None

    def removed(self, eid: Hashable) -> bool:
        e, t = self.ents.get(eid), self._target(eid)
        return (e is not None and e.role == "removed") or (t is not None and t.role == "removed")

    def override(self, eid: Hashable) -> Hashable | None:
        e, t = self.ents.get(eid), self._target(eid)
        if e is not None and e.parent_brand_id is not None:
            return e.parent_brand_id
        return t.parent_brand_id if t is not None else None

    def fold(self, eid: Hashable | None) -> Hashable | None:
        """추적 엔티티(별칭은 그 추적 대상)로 접은 id, 자사가 아니면 None."""
        if eid is None:
            return None
        if eid in self.tracked:
            return eid
        return self.alias.get(eid)

    def own_of(self, eid: Hashable, scope_rollup: Hashable | None, prefix_id: Hashable | None = None) -> Hashable | None:
        """이 엔티티 언급(Scope 롤업 scope_rollup, 표시명 접두 교정 결과 prefix_id)이 귀속되는 자사 엔티티, 아니면 None."""
        if self.removed(eid):
            return None
        direct = self.fold(eid)
        if direct is not None:
            return direct
        ovr = self.override(eid)
        r = ovr if ovr is not None else scope_rollup
        if r is None or self.removed(r):
            return None
        if ovr is None and prefix_id is not None:              # J1: 접두 교정은 덮어쓰기가 없을 때만(관리자 지정 모 브랜드가 우선)
            return self.fold(prefix_id)
        return self.fold(r)

    def entity_own(self, eid: Hashable, scope_own: Mapping[Hashable, Hashable] | None,
                   scope_rollups: Mapping[Hashable, Iterable[Hashable]] | None = None) -> Hashable | None:
        """엔티티 단위 자사 귀속(그 엔티티 언급 전체를 한 판정으로). 엔진(own_of·seed _ecat_x·_acr_nm·_bn_pair)과 같은 순서:
          제거 → 없음, 자신이 자사(별칭) → 그 자사, 관계 덮어쓰기(자기 → 병합 대상)가 있으면 접두 교정을 건너뛰고 그 롤업(대상 제거면 없음),
          없으면 Scope 롤업 대상 제거 → 없음(접두 교정보다 먼저: 롤업이 없으면 접두가 있어도 브랜드 귀속 없음, 검증 N8),
          그 밖은 scope_own(덮어쓰기 없을 때의 귀속 = 투영 차원의 표시 브랜드, 호출자가 활성 버전 차원에서 넘긴다. 접두 교정·별칭 접기·롤업이
          이미 반영된 자사 엔티티 id. 차원은 원본 쌍이라 롤업 대상 제거를 모른다).
        scope_rollups = {엔티티: 그 엔티티 언급의 Scope 롤업 id 들}(호출자가 제거 대상을 롤업으로 두는 엔티티만 채운다, 없으면 롤업 제거 판정 생략).
        엔티티 단위라 언급의 롤업이 전부 제거일 때만 없음으로 본다(일부만 제거면 나머지 언급이 남아 자사 그대로, 린트는 일부여도 경고)."""
        if self.removed(eid):
            return None
        direct = self.fold(eid)
        if direct is not None:
            return direct
        ovr = self.override(eid)
        if ovr is not None:
            return None if self.removed(ovr) else self.fold(ovr)
        rups = [r for r in (scope_rollups or {}).get(eid, ()) if r is not None]
        if rups and all(self.removed(r) for r in rups):
            return None
        own = (scope_own or {}).get(eid)
        return self.fold(own) if own is not None else None

    def override_own(self) -> set[Hashable]:
        """관계 덮어쓰기로 자사에 롤업되는 초안 엔티티(병합 원본 포함: 병합 대상의 관계를 따른다)."""
        return {eid for eid in self.ents if self.fold(eid) is None and self.own_of(eid, None) is not None}

    def query_ids(self) -> set[Hashable]:
        """관측 표면 조회 대상 엔티티(entity_id 또는 Scope 롤업이 이 집합): 추적 ∪ 자사 별칭 ∪ 덮어쓰기로 자사 롤업."""
        return self.tracked | set(self.alias) | self.override_own()


# ── 린트 ─────────────────────────────────────────────────────────────────────

def _fingerprint(detail: str, row: Any) -> str:
    raw = repr((detail, row)).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:10]  # noqa: S324 (식별용 지문, 보안 해시 아님)


def lint_version(draft: VersionSnapshot, config: LintConfig, *, base: VersionSnapshot | None = None,
                 observed_surfaces: Mapping[str, Iterable[Hashable]] | None = None,
                 rollup_observed: Mapping[str, Iterable[tuple[Hashable | None, ...]]] | None = None,
                 scope_own: Mapping[Hashable, Hashable] | None = None,
                 own_labels: Mapping[Hashable, str] | None = None,
                 scope_rollups: Mapping[Hashable, Iterable[Hashable]] | None = None) -> LintReport:
    """초안 린트. base = 초안이 복사해 온 활성 버전(None = 빈 버전), observed_surfaces = {정규형 표면: 그 표면으로 관측된 엔티티들}
    (ing.mention.surfaces 집계, 선택). scope_own = {엔티티: 덮어쓰기 없을 때 귀속되는 자사 엔티티}(투영 차원, 선택), own_labels = {자사 엔티티:
    표시 이름}(경고 문구용), scope_rollups = {엔티티: Scope 롤업 id 들}(rollup_edit_targets 의 제거·병합 편집 대상을 롤업으로 두는 엔티티를
    역방향 조회한 결과, 선택: 그 엔티티가 자사 귀속이면 편집 대상에 L2). 결과는 입력 순서와 무관하게 (등급, 코드, 대상) 순으로 정렬된다.
    기준에 이미 있던 비무결성 L3 는 INFO 로 내린다(머리 주석)."""
    base = base or VersionSnapshot()
    findings = _lint(draft, config, base, observed_surfaces, rollup_observed, scope_own, own_labels, scope_rollups)
    if base.entities or base.surfaces:
        pre = {(f.code, f.target, f.detail) for f in _lint(base, config, base, None, None, None, None, None) if f.level == "L3"}
        findings = [Finding("INFO", f.code, f.target, f.detail, f.entity_id, f.surface_id, f.escalate, f.fingerprint)
                    if f.level == "L3" and f.code not in INTEGRITY and (f.code, f.target, f.detail) in pre else f
                    for f in findings]
    level_rank = {"L1": 0, "L3": 1, "L2": 2, "INFO": 3}
    uniq = {(f.level, f.code, f.target, f.detail): f for f in findings}
    return LintReport(tuple(sorted(uniq.values(), key=lambda f: (level_rank.get(f.level, 9), f.code, f.target, f.detail))))


def _lint(draft: VersionSnapshot, config: LintConfig, base: VersionSnapshot,
          observed_surfaces: Mapping[str, Iterable[Hashable]] | None,
          rollup_observed: Mapping[str, Iterable[tuple[Hashable | None, ...]]] | None,
          scope_own: Mapping[Hashable, Hashable] | None, own_labels: Mapping[Hashable, str] | None,
          scope_rollups: Mapping[Hashable, Iterable[Hashable]] | None) -> list[Finding]:
    observed = {normalize_surface(k): frozenset(v) for k, v in (observed_surfaces or {}).items()}
    rolled: dict[str, set[tuple[Hashable, Hashable | None, Hashable | None]]] = {}   # (엔티티, Scope 롤업, 접두 교정 id)
    for k, pairs in (rollup_observed or {}).items():
        rolled.setdefault(normalize_surface(k), set()).update((t[0], t[1], t[2] if len(t) > 2 else None) for t in pairs)
    ents = {e.entity_id: e for e in draft.entities}
    base_ents = {e.entity_id: e for e in base.entities}
    tracked = tracked_ids(draft, config, base)
    rule = RollupRule(draft, tracked)
    base_rule = RollupRule(base, tracked)
    out: list[Finding] = []

    def label(o: Hashable | None) -> str:
        return str((own_labels or {}).get(o, o))

    def own_change(eid: Hashable) -> tuple[Hashable | None, Hashable | None]:
        """(기준 귀속, 초안 귀속) 자사 엔티티(엔티티 단위 RollupRule.entity_own)."""
        return base_rule.entity_own(eid, scope_own, scope_rollups), rule.entity_own(eid, scope_own, scope_rollups)

    def own_edit(eid: Hashable, what: str) -> None:
        """추적 밖 엔티티의 편집이 자사 귀속 엔티티에 닿으면(기준 또는 초안 귀속이 자사) L2: 어느 자사 KPI 가 바뀌는지 적는다."""
        ob, oa = own_change(eid)
        if ob is None and oa is None:
            return
        kpi = label(ob) if ob == oa or oa is None else (label(oa) if ob is None else f"{label(ob)} → {label(oa)}")
        add("L2", "OWN_ATTRIBUTED_EDIT", entity_id=eid, detail=f"자사 귀속 엔티티 편집({what}): {kpi} KPI 가 바뀔 수 있다",
            escalate_ids=(ob, oa))
    surf_rows = {s.surface_id: s for s in draft.surfaces}

    def add(level: str, code: str, *, entity_id: Hashable | None = None, surface_id: int | None = None, detail: str = "",
            escalate_ids: Iterable[Hashable | None] = ()) -> None:
        target = f"surface:{surface_id}" if surface_id is not None else f"entity:{entity_id}"
        esc = any(x is not None and x in tracked for x in (entity_id, *escalate_ids))
        row = surf_rows.get(surface_id) if surface_id is not None else ents.get(entity_id)
        out.append(Finding(level, code, target, detail, entity_id, surface_id, esc, _fingerprint(detail, row)))

    # ── 엔티티 구조(L3)와 자사 편집(L2) ──
    for e in draft.entities:
        eid = e.entity_id
        if e.role not in ROLES:
            add("L3", "INVALID_ROLE", entity_id=eid, detail=repr(e.role))
        if e.role == "own" and not e.brand_code:
            add("L3", "OWN_WITHOUT_BRAND_CODE", entity_id=eid)
        if e.role == "own" and e.merge_into is not None:
            add("L3", "OWN_MERGED", entity_id=eid, detail=f"merge_into={e.merge_into}")
        if e.role == "removed" and eid in tracked:
            add("L3", "TRACKED_REMOVED", entity_id=eid)
        changed = base_ents.get(eid) != e                     # 기준 대비 새 행이거나 바뀐 행(자사 편집 L2 는 이것만)
        if e.merge_into is not None:
            if e.merge_into == eid:
                add("L3", "MERGE_SELF", entity_id=eid)
            else:
                tgt = ents.get(e.merge_into)
                if tgt is not None and tgt.role == "removed":
                    add("L3", "MERGE_INTO_REMOVED", entity_id=eid, detail=f"merge_into={e.merge_into}")
                if changed and e.merge_into in tracked:
                    add("L2", "TRACKED_ENTITY_EDIT", entity_id=eid, detail=f"자사 엔티티로 병합: {e.merge_into}",
                        escalate_ids=(e.merge_into,))
        if e.parent_brand_id is not None:
            if e.parent_brand_id == eid:
                add("L3", "PARENT_SELF", entity_id=eid)
            elif changed and e.parent_brand_id in tracked:
                add("L2", "TRACKED_ENTITY_EDIT", entity_id=eid, detail=f"자사 엔티티로 롤업: {e.parent_brand_id}",
                    escalate_ids=(e.parent_brand_id,))
        if eid in tracked and changed:
            add("L2", "TRACKED_ENTITY_EDIT", entity_id=eid, detail=f"role={e.role}")
        elif changed and rule.fold(eid) is None:              # 추적 밖이지만 자사로 귀속되는 엔티티(접두 교정·롤업·덮어쓰기)
            what = _kpi_change(base_ents.get(eid), e)
            if what:                                           # 숨김·이름·메모·유형만 바뀌면 KPI 불변(검증 5차 3: 오탐 제외)
                own_edit(eid, what)
    for eid in base_ents.keys() - ents.keys():                 # 기준에 있던 덮어쓰기 행을 초안에서 지움(= Scope 기본으로 복귀)
        if eid in tracked:
            add("L2", "TRACKED_ENTITY_EDIT", entity_id=eid, detail="덮어쓰기 행 삭제(기본 역할로 복귀)")
        elif base_rule.fold(eid) is None and _kpi_change(base_ents[eid], None):
            own_edit(eid, "덮어쓰기 행 삭제")
    # 제거·병합 편집 대상을 Scope 롤업으로 두는 자사 귀속 엔티티(역방향, 검증 N8): 롤업 대상이 제거면 엔진은 접두 교정 전에 그 언급의 브랜드
    # 귀속을 버린다(예 경쟁사 Tata 제거 → 'Hyundai Creta' 언급이 Hyundai 에서 빠짐). 편집 대상 자신은 자사가 아니어도 L2.
    for t, what in rollup_edit_targets(draft, base).items():
        owns: set[Hashable] = set()
        deps = 0
        for d, rups in (scope_rollups or {}).items():
            if d == t or t not in set(rups):
                continue
            ob, oa = own_change(d)
            if ob is None and oa is None:
                continue
            deps += 1
            owns.update(x for x in (ob, oa) if x is not None)
        if deps:
            add("L2", "OWN_ATTRIBUTED_EDIT", entity_id=t,
                detail=f"자사 귀속 엔티티 {deps}개의 Scope 롤업 대상 편집({what}): {', '.join(sorted(label(o) for o in owns))} KPI 가 바뀔 수 있다",
                escalate_ids=tuple(owns))

    _merge_graph(ents, add)
    _parent_cycles(ents, add)

    # ── 표면 ──
    base_keys = {(s.surface_id, s.action) for s in base.surfaces}
    inactive = {e.entity_id for e in draft.entities if e.role == "removed" or (e.merge_into is not None and e.merge_into != e.entity_id)}
    norms = {s.surface_id: normalize_surface(s.surface) for s in draft.surfaces}
    adds_by_norm: dict[str, set[Hashable]] = {}
    blocks_by_norm: dict[str, set[Hashable | None]] = {}
    for s in draft.surfaces:
        if s.action == "add" and s.entity_id is not None:
            adds_by_norm.setdefault(norms[s.surface_id], set()).add(s.entity_id)
        elif s.action == "block":
            blocks_by_norm.setdefault(norms[s.surface_id], set()).add(s.entity_id)
    tracked_names: dict[str, set[Hashable]] = {}                # 추적 엔티티 이름(초안·기준 행): 전역 차단 대조
    for e in (*draft.entities, *base.entities):
        if e.entity_id in tracked and e.name:
            n = normalize_surface(e.name)
            if n:
                tracked_names.setdefault(n, set()).add(e.entity_id)
    for e in draft.entities:                                    # 관계 덮어쓰기로 자사에 롤업되는 엔티티 이름(초안 행)
        if e.name and rule.fold(e.entity_id) is None and rule.own_of(e.entity_id, None) is not None:
            n = normalize_surface(e.name)
            if n:
                rolled.setdefault(n, set()).add((e.entity_id, None, None))

    for s in draft.surfaces:
        sid, eid, norm = s.surface_id, s.entity_id, norms[s.surface_id]
        is_new = (sid, s.action) not in base_keys
        if s.action not in ACTIONS:
            add("L3", "INVALID_ACTION", entity_id=eid, surface_id=sid, detail=repr(s.action))
            continue
        if is_new and not _has_word_char(norm):
            add("L1", "SURFACE_NO_WORD_CHAR", entity_id=eid, surface_id=sid, detail=repr(s.surface))
            continue
        if s.action == "block":
            if is_new:
                if eid is not None:
                    hit_tracked = {eid} & tracked
                else:                                               # 전역 차단: 관측·추적 이름·추적 add 표면과 대조
                    hit_tracked = (set(observed.get(norm, ())) | tracked_names.get(norm, set()) | adds_by_norm.get(norm, set())) & tracked
                if hit_tracked:
                    add("L2", "TRACKED_ENTITY_EDIT", entity_id=eid, surface_id=sid, detail=f"자사 엔티티 표면 차단: {norm!r}",
                        escalate_ids=sorted(hit_tracked, key=str))
                elif eid is not None:                               # 엔티티 한정 차단: 그 엔티티가 자사로 귀속되면(접두 교정·롤업·덮어쓰기)
                    o = rule.entity_own(eid, scope_own, scope_rollups)
                    if o is not None:
                        add("L2", "OWN_ATTRIBUTED_EDIT", entity_id=eid, surface_id=sid,
                            detail=f"자사 귀속 엔티티 표면 차단: {norm!r}, {label(o)} KPI 가 바뀔 수 있다", escalate_ids=(o,))
                elif eid is None:                                   # 자사 브랜드로 롤업되는 엔티티(제품 등)의 표면·이름·add 표면
                    pairs = rolled.get(norm, set()) | {(a, None, None) for a in adds_by_norm.get(norm, set())}
                    own = {o for e2, r2, p2 in pairs for o in (rule.own_of(e2, r2, p2),) if o is not None}
                    if own:
                        via = sorted({str(e2) for e2, r2, p2 in pairs if rule.own_of(e2, r2, p2) is not None})
                        add("L2", "TRACKED_ENTITY_EDIT", surface_id=sid,
                            detail=f"자사 브랜드로 롤업되는 엔티티 표면 차단: {norm!r} (엔티티 {len(via)}개 → 자사 {len(own)}개)",
                            escalate_ids=sorted(own, key=str))
            continue
        # action == add
        if eid is None:
            add("L3", "ADD_WITHOUT_ENTITY", surface_id=sid, detail=repr(norm))
            continue
        if eid in inactive:
            add("L3", "SURFACE_ON_INACTIVE_ENTITY", entity_id=eid, surface_id=sid, detail=repr(norm))
        blockers = blocks_by_norm.get(norm, set())
        if None in blockers or eid in blockers:
            add("L3", "ADD_BLOCK_CONFLICT", entity_id=eid, surface_id=sid, detail=repr(norm))
        if not is_new:
            continue
        n = len(norm)
        latin = _is_latin_class(norm)
        if n == 1:
            add("L1", "SURFACE_SINGLE_CHAR", entity_id=eid, surface_id=sid, detail=repr(norm))
        elif latin and n <= 3 and norm not in config.short_ascii_allowlist:
            add("L1", "SURFACE_SHORT_ASCII", entity_id=eid, surface_id=sid, detail=repr(norm))
        elif latin and 4 <= n <= 5:
            add("L2", "SURFACE_ASCII_4_5", entity_id=eid, surface_id=sid, detail=repr(norm))
        elif not latin and n == 2:
            add("L2", "SURFACE_SHORT_NON_LATIN", entity_id=eid, surface_id=sid, detail=repr(norm))
        langs = _generic_langs(norm, config)
        if langs:
            add("L2", "SURFACE_GENERIC_WORD", entity_id=eid, surface_id=sid, detail=f"{norm!r} lang={','.join(langs)}")
        others = set(observed.get(norm, ())) - {eid}
        if others:
            add("L2", "SURFACE_OBSERVED_COLLISION", entity_id=eid, surface_id=sid,
                detail=f"{norm!r} 관측 엔티티 {len(others)}개", escalate_ids=sorted(others, key=str))
        dup = adds_by_norm.get(norm, set()) - {eid}
        if dup:
            add("L2", "SURFACE_DUP_ACROSS_ENTITIES", entity_id=eid, surface_id=sid, detail=f"{norm!r} 다른 엔티티 {len(dup)}개",
                escalate_ids=sorted(dup, key=str))
        if eid in tracked:
            add("L2", "TRACKED_ENTITY_EDIT", entity_id=eid, surface_id=sid, detail=f"자사 엔티티 표면 추가: {norm!r}")
        elif (o := rule.entity_own(eid, scope_own, scope_rollups)) is not None:   # 자사 귀속 엔티티 표면 추가 = 재매칭으로 자사 언급이 는다(검증 5차 3)
            add("L2", "OWN_ATTRIBUTED_EDIT", entity_id=eid, surface_id=sid,
                detail=f"자사 귀속 엔티티 표면 추가: {norm!r}, {label(o)} KPI 가 늘 수 있다", escalate_ids=(o,))

    # 기준에 있던 엔티티 한정 차단을 초안에서 해제 = 그 엔티티 언급이 돌아온다: 자사 귀속(추적 포함)이면 L2(검증 5차 3)
    draft_keys = {(s.surface_id, s.action) for s in draft.surfaces}
    for s in base.surfaces:
        if s.action != "block" or s.entity_id is None or (s.surface_id, "block") in draft_keys:
            continue
        o = rule.entity_own(s.entity_id, scope_own, scope_rollups) or base_rule.entity_own(s.entity_id, scope_own, scope_rollups)
        if o is not None:
            add("L2", "OWN_ATTRIBUTED_EDIT", entity_id=s.entity_id, surface_id=s.surface_id,
                detail=f"자사 귀속 엔티티 한정 차단 해제: {normalize_surface(s.surface)!r}, {label(o)} KPI 가 늘 수 있다", escalate_ids=(o,))

    return out


def rollup_edit_targets(draft: VersionSnapshot, base: VersionSnapshot | None = None) -> dict[Hashable, str]:
    """초안에서 Scope 롤업 대상으로서의 효과가 바뀌는 엔티티 {id: 편집 종류}: 제거·병합(해제 포함) 행 편집, 병합 대상 제거로 제거 상태가 바뀐 것.
    모 브랜드 덮어쓰기는 롤업 대상으로서 효과가 없다(2단, 모 브랜드의 모 브랜드는 따라가지 않는다). 호출자는 이 id 들을 롤업으로 두는
    엔티티를 역방향 조회해 lint_version(scope_rollups=...)에 넘긴다(상한·비차단)."""
    base = base or VersionSnapshot()
    a, b = {e.entity_id: e for e in draft.entities}, {e.entity_id: e for e in base.entities}
    ra, rb = RollupRule(draft, ()), RollupRule(base, ())
    out: dict[Hashable, str] = {}
    for eid in a.keys() | b.keys():
        what = _kpi_change(b.get(eid), a.get(eid))
        if what in ("제거", "제거 해제", "병합", "병합 해제"):
            out[eid] = what
        elif ra.removed(eid) != rb.removed(eid):
            out[eid] = "병합 대상 제거" if ra.removed(eid) else "병합 대상 제거 해제"
    return out


def removed_ids(snap: VersionSnapshot) -> set[Hashable]:
    """버전에서 언급이 빠지는 엔티티(자신 또는 병합 대상이 removed): Scope 롤업 대상 제거 판정의 역방향 조회 대상."""
    r = RollupRule(snap, ())
    return {e.entity_id for e in snap.entities if r.removed(e.entity_id)}


def _kpi_change(before: EntityRow | None, after: EntityRow | None) -> str | None:
    """엔티티 행 변경이 언급 귀속(KPI)을 바꿀 수 있는가(투영 오버레이 입력 = 제거·병합·모 브랜드). 바뀌면 무엇이 바뀌었는지, 아니면 None.
    숨김(hidden = 현행 excluded, KPI 불변)·이름·메모·유형·자사 브랜드 코드 변경은 None(자사 역할은 추적 집합이 따로 본다)."""
    def k(r: EntityRow | None) -> tuple[bool, Hashable | None, Hashable | None]:
        return (r is not None and r.role == "removed", r.merge_into if r else None, r.parent_brand_id if r else None)
    b, a = k(before), k(after)
    if b[0] != a[0]:
        return "제거" if a[0] else "제거 해제"
    if b[1] != a[1]:
        return "병합" if a[1] is not None else "병합 해제"
    if b[2] != a[2]:
        return "모 브랜드"
    return None


def _merge_graph(ents: Mapping[Hashable, EntityRow], add: Any) -> None:
    """병합 순환(L3 MERGE_CYCLE, 순환 위 모든 엔티티)과 체인(L3 MERGE_CHAIN: 대상이 다시 병합 원본, 순환 제외)."""
    nxt = {eid: e.merge_into for eid, e in ents.items() if e.merge_into is not None and e.merge_into != eid}
    on_cycle: set[Hashable] = set()
    for start in nxt:
        seen: list[Hashable] = []
        cur: Hashable | None = start
        while cur is not None and cur in nxt and cur not in seen:
            seen.append(cur)
            cur = nxt[cur]
        if cur is not None and cur in seen:
            on_cycle.update(seen[seen.index(cur):])
    for eid in sorted(on_cycle, key=str):
        add("L3", "MERGE_CYCLE", entity_id=eid, detail=f"merge_into={nxt[eid]}")
    for eid, tgt in nxt.items():
        if eid not in on_cycle and tgt in nxt:
            add("L3", "MERGE_CHAIN", entity_id=eid, detail=f"{eid} → {tgt} → {nxt[tgt]}")


def _parent_cycles(ents: Mapping[Hashable, EntityRow], add: Any) -> None:
    par = {eid: e.parent_brand_id for eid, e in ents.items() if e.parent_brand_id is not None and e.parent_brand_id != eid}
    on_cycle: set[Hashable] = set()
    for start in par:
        seen: list[Hashable] = []
        cur: Hashable | None = start
        while cur is not None and cur in par and cur not in seen:
            seen.append(cur)
            cur = par[cur]
        if cur is not None and cur in seen:
            on_cycle.update(seen[seen.index(cur):])
    for eid in sorted(on_cycle, key=str):
        add("L3", "PARENT_CYCLE", entity_id=eid, detail=f"parent_brand_id={par[eid]}")
