"""결정적 표면 매처(설계 1-2절 "별칭 추가·허브 엔티티 추가", 2-1절 ing.hub_match, 8절 E2). 순수 함수, DB 없음.

흐름
1. compile_surfaces(specs)        활성 버전이 켠 `add` 표면들을 정규화·정규식으로 컴파일(surface_id 순, 입력 순서 무관).
2. scan_text(text, compiled)      본문 한 턴을 **표면별로 독립** 스캔 → {surface_id: SurfaceScan}. 이것이 ing.hub_match 1행의 내용이다
                                  (버전과 무관: 버전은 어느 surface_id 를 켤지만 정하므로 버전 전환 때 다시 스캔하지 않는다).
3. resolve_overlaps(hits, occupied)  투영 시점: 켜진 표면들의 발생을 합쳐 겹침 제거. Scope 기존 언급 발생 위치(occupied)와 겹치는
                                  발생은 먼저 뺀다. 남은 것끼리는 왼쪽 우선, 같은 시작이면 긴 표면 우선(탐욕). 완전히 같은 구간을
                                  서로 다른 엔티티 표면이 가지면 둘 다 남긴다(Scope dedupeMatches 의 한 발생 다중 엔티티와 같음,
                                  린트 L2 SURFACE_DUP_ACROSS_ENTITIES 가 미리 경고한다).
4. build_rematch_mentions(...)    겹침 제거된 발생 → 엔티티별 재매칭 언급 속성(감성 미상 = 감성 4종 0, 유형 type_mention 만,
                                  위치 = 턴 안 첫 발생 오프셋 순위 또는 NULL).

멱등: 모든 출력은 입력 값만의 함수이고 정렬 키가 전순서다(시작, -길이, surface_id). 같은 입력을 몇 번 돌려도, 표면 목록 순서를
바꿔도 결과가 같다.

Scope 매처(lib/measurement-analysis core.ts findDeterministicMatches·surface-match.ts·tracked-brand-augment.ts)와 다른 점
- 보정 경로(tracked-brand-augment → surface-match.ts)의 "ASCII 4자 이상 = 대소문자 무시 부분 문자열" 규칙을 쓰지 않는다
  (Epit·pass·HMIL·Probe 사고 원인, Scope 제안서 R6). 길이와 무관하게 모든 표면에 문자 체계 경계를 적용한다.
- 압축 매칭(compactSurface: 하이픈·괄호·마침표를 지우고 맞추기)이 없다. `Hyundai-N` 과 `HyundaiN` 은 별도 표면으로 추가한다.
- 정책 게이트(alias-policy: brand_context·exact form)·문맥 재지정(context-redirect)이 없다. 허브는 린트(L1·L2)로 표면 자체를 거른다.
- 대소문자 casefold(`ß`=`ss`), NFD 결합 부호를 글자 묶음으로 합성한 뒤 비교(Scope 는 코드포인트별 NFKC 라 NFD 원문의 `é` 가
  합성되지 않는다). 표면 공백은 본문 공백 연속(`\\s+`)에 맞는다(Scope 는 본문 공백을 한 칸으로 접은 사본을 쓴다: 결과 같음).
- 오프셋은 원문 코드포인트(Scope 는 매칭 중 UTF-16, 영속 시 코드포인트로 변환: scope#632).
- 겹침 제거에 Scope 기존 언급 위치를 먼저 반영한다(허브 재매칭이 Scope 가 이미 센 발생을 두 번 세지 않게).
"""
from __future__ import annotations

import re
from collections.abc import Hashable, Iterable
from dataclasses import dataclass, field

from app.core.ecat.text import Folded, fold, normalize_surface, passes_word_boundary, surface_pattern

__all__ = ["CompiledSurface", "Hit", "RematchMention", "ScopeMention", "SurfaceScan", "SurfaceSpec", "build_rematch_mentions",
           "compile_surfaces", "find_surface", "hits_of", "match_text", "resolve_overlaps", "scan_text"]

EXTRACTION_SOURCE = "hub_rematch"


@dataclass(frozen=True, slots=True)
class SurfaceSpec:
    """ecat_surface_def 1행 중 매처에 필요한 것(action='add' 인 것만 넘긴다)."""
    surface_id: int
    entity_id: Hashable
    surface: str


@dataclass(frozen=True, slots=True)
class CompiledSurface:
    surface_id: int
    entity_id: Hashable
    surface: str
    norm: str
    pattern: re.Pattern[str] = field(compare=False, repr=False)


@dataclass(frozen=True, slots=True, order=True)
class Hit:
    """발생 1개. start·end 는 원문 코드포인트 [start, end)."""
    start: int
    end: int
    surface_id: int
    entity_id: Hashable = field(compare=False)

    @property
    def length(self) -> int:
        return self.end - self.start


@dataclass(frozen=True, slots=True)
class SurfaceScan:
    """표면 1개가 본문 1턴에서 찾은 결과(= ing.hub_match 1행: n_occ·first_start·starts·ends)."""
    surface_id: int
    entity_id: Hashable
    starts: tuple[int, ...]
    ends: tuple[int, ...]

    @property
    def n_occ(self) -> int:
        return len(self.starts)

    @property
    def first_start(self) -> int:
        return self.starts[0]


def compile_surfaces(specs: Iterable[SurfaceSpec]) -> tuple[CompiledSurface, ...]:
    """정규화·컴파일. surface_id 중복·정규형이 빈 표면은 ValueError(린트 L1 이 먼저 막는 입력이다)."""
    out: dict[int, CompiledSurface] = {}
    for s in specs:
        if s.surface_id in out:
            raise ValueError(f"surface_id 중복: {s.surface_id}")
        norm = normalize_surface(s.surface)
        if not norm:
            raise ValueError(f"빈 표면: surface_id={s.surface_id}")
        out[s.surface_id] = CompiledSurface(s.surface_id, s.entity_id, s.surface, norm, surface_pattern(norm))
    return tuple(out[k] for k in sorted(out))


def find_surface(folded: Folded, cs: CompiledSurface) -> tuple[Hit, ...]:
    """표면 1개의 발생(자기 자신과는 겹치지 않게 왼쪽부터). 경계 불통과 자리에서는 한 글자 뒤부터 다시 찾는다."""
    text = folded.text
    hits: list[Hit] = []
    pos = 0
    pat = cs.pattern
    while True:
        m = pat.search(text, pos)
        if m is None:
            break
        fs, fe = m.start(), m.end()
        if passes_word_boundary(text, fs, fe):
            s, e = folded.source_span(fs, fe)
            hits.append(Hit(s, e, cs.surface_id, cs.entity_id))
            pos = fe
        else:
            pos = fs + 1
    return tuple(hits)


def scan_text(text: str, compiled: Iterable[CompiledSurface]) -> dict[int, SurfaceScan]:
    """본문 1턴 스캔 → 적중한 표면만 {surface_id: SurfaceScan}(키 오름차순). 빈 본문이면 {}."""
    if not text:
        return {}
    folded = fold(text)
    out: dict[int, SurfaceScan] = {}
    for cs in sorted(compiled, key=lambda c: c.surface_id):
        hits = find_surface(folded, cs)
        if hits:
            out[cs.surface_id] = SurfaceScan(cs.surface_id, cs.entity_id, tuple(h.start for h in hits), tuple(h.end for h in hits))
    return out


def hits_of(scans: Iterable[SurfaceScan]) -> list[Hit]:
    """저장된 스캔 결과(ing.hub_match 행) → 발생 목록."""
    return [Hit(s, e, sc.surface_id, sc.entity_id) for sc in scans for s, e in zip(sc.starts, sc.ends, strict=True)]


def _overlaps(a0: int, a1: int, b0: int, b1: int) -> bool:
    return a0 < b1 and a1 > b0


def resolve_overlaps(hits: Iterable[Hit], occupied: Iterable[tuple[int, int]] = ()) -> tuple[Hit, ...]:
    """겹침 제거. occupied(Scope 기존 언급 발생 [start, end))와 겹치는 발생을 빼고, 남은 것을 (시작, -길이, surface_id) 순 탐욕으로
    고른다. 채택된 발생과 완전히 같은 구간의 다른 엔티티 발생은 함께 남긴다(같은 엔티티의 같은 구간은 surface_id 가 작은 것 하나)."""
    occ = sorted(set(occupied))
    cand = sorted({h for h in hits if not any(_overlaps(h.start, h.end, o0, o1) for o0, o1 in occ)},
                  key=lambda h: (h.start, -h.length, h.surface_id))
    kept: list[Hit] = []
    for h in cand:
        if kept:
            last = kept[-1]
            if (h.start, h.end) == (last.start, last.end):
                if all(k.entity_id != h.entity_id for k in kept if (k.start, k.end) == (h.start, h.end)):
                    kept.append(h)
                continue
            if any(_overlaps(h.start, h.end, k.start, k.end) for k in kept):
                continue
        kept.append(h)
    return tuple(kept)


def match_text(text: str, compiled: Iterable[CompiledSurface], occupied: Iterable[tuple[int, int]] = ()) -> tuple[Hit, ...]:
    """편의: scan_text + resolve_overlaps(시험·미리보기 표본용)."""
    return resolve_overlaps(hits_of(scan_text(text, compiled).values()), occupied)


@dataclass(frozen=True, slots=True)
class ScopeMention:
    """같은 턴에 이미 있는 Scope 언급 1개(엔티티 단위). first_start None = 발생 행 없음(6~8월 적재분 등)."""
    entity_id: Hashable
    first_start: int | None


@dataclass(frozen=True, slots=True)
class RematchMention:
    """재매칭 언급(ing.mention 열 모양). 감성은 미상: 감성 4종 0 이고 sentiment_known=False. 유형은 type_mention 에만 센다.

    is_new=True  이 턴에 Scope 언급이 없던 엔티티: 새 언급 행. avg_position = 턴 안 첫 발생 오프셋 순위(1부터) 또는 None.
    is_new=False 이 턴에 발생 행 있는 Scope 언급이 이미 있는 엔티티: mention_count 는 **더할 개수**(Scope 발생과 겹치지 않는 것만,
                 호출자가 occupied 로 겹침을 뺀 경우), avg_position 은 None(Scope 값을 바꾸지 않는다).
    """
    entity_id: Hashable
    is_new: bool
    mention_count: int
    first_start: int
    starts: tuple[int, ...]
    surface_ids: tuple[int, ...]
    surfaces: tuple[str, ...]            # 원문 표기(등장 순, 중복 제거)
    avg_position: float | None
    sentiment_positive: int = 0
    sentiment_neutral: int = 0
    sentiment_negative: int = 0
    sentiment_mixed: int = 0
    sentiment_known: bool = False
    type_mention: int = 0
    type_recommendation: int = 0
    type_comparison: int = 0
    type_definition: int = 0
    type_final_choice: int = 0
    extraction_source: str = EXTRACTION_SOURCE


def build_rematch_mentions(text: str, resolved: Iterable[Hit], *, scope_mentions: Iterable[ScopeMention] = (),
                           positions_known: bool) -> tuple[RematchMention, ...]:
    """겹침 제거된 발생(resolve_overlaps 결과) → 엔티티별 재매칭 언급(첫 발생 순, 같으면 엔티티 문자열 순).

    - Scope 언급이 있고 발생 행이 없는 엔티티(first_start None)는 **존재만 인정**(설계 1-2: 개수 불변) → 결과에서 뺀다.
    - 위치: positions_known(9월 이후 답변 등 발생 오프셋을 믿을 수 있는 턴)이고 이 턴 Scope 언급의 first_start 가 전부 있을 때만
      새 언급에 순위를 준다. 순위 = 1 + (첫 발생이 더 앞인 서로 다른 엔티티 수, Scope 언급 포함). Scope 언급 위치는 바꾸지 않는다.
      Scope avg_position 과 같은 척도인지는 미확인(설계 10절): 투영이 쓰지 않기로 하면 None 으로 둔다.
    """
    scope = {m.entity_id: m.first_start for m in scope_mentions}
    by_entity: dict[Hashable, list[Hit]] = {}
    for h in sorted(set(resolved)):
        by_entity.setdefault(h.entity_id, []).append(h)

    rank_ok = positions_known and all(v is not None for v in scope.values())
    firsts: dict[Hashable, int] = {e: v for e, v in scope.items() if v is not None}
    for e, hs in by_entity.items():
        if e not in scope:
            firsts[e] = hs[0].start

    out: list[RematchMention] = []
    for e, hs in by_entity.items():
        if e in scope and scope[e] is None:
            continue
        is_new = e not in scope
        starts = tuple(h.start for h in hs)
        surfaces: list[str] = []
        for h in hs:
            s = text[h.start:h.end]
            if s not in surfaces:
                surfaces.append(s)
        pos: float | None = None
        if is_new and rank_ok:
            pos = float(1 + sum(1 for other, f in firsts.items() if other != e and f < hs[0].start))
        out.append(RematchMention(entity_id=e, is_new=is_new, mention_count=len(hs), first_start=hs[0].start, starts=starts,
                                  surface_ids=tuple(sorted({h.surface_id for h in hs})), surfaces=tuple(surfaces),
                                  avg_position=pos, type_mention=len(hs)))
    out.sort(key=lambda m: (m.first_start, str(m.entity_id)))
    return tuple(out)
