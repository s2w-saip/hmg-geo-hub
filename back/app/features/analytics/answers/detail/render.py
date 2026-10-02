"""답변 상세의 서버 계산(순수 함수): 감성 밑줄 문장 span, 스탠스 근거 원문 대조.

현행 포팅(모듈-답변-드릴다운 결정 9):
- build_sentiment_spans ← lib/answer-sentiment/spans.ts:88 (sentenceBounds :53)
- verify_stance_evidence ← lib/answer-sentiment/stance-evidence.ts:31
오프셋은 코드포인트 기준이다. Python str 인덱스가 코드포인트라 JS 의 Array.from(text) 와 그대로 맞는다.
차이 한 가지: 당사 판정 입력을 엔티티 id 집합(trackedEntityIds) 대신 발생마다 own(bool)로 받는다. 판정은 서비스가 rd 차원(엔티티 →
브랜드 → own_bit ∈ 관점 비트)으로 미리 한다(현행 trackedIds + 롤업 정본 id 합집합과 같은 목적).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

Sentiment = Literal["positive", "negative", "mixed", "neutral"]
Match = Literal["verified", "mismatch", "unavailable"]

TERMINAL = frozenset({".", "!", "?", "。", "！", "？"})
# JS /^(\s*(?:[-*•]|\d+[.)])\s+)/u: \d 는 u 플래그에서도 ASCII 숫자만이라 [0-9] 로 쓴다
BULLET_PREFIX = re.compile(r"^(\s*(?:[-*•]|[0-9]+[.)])\s+)")


def _ws(ch: str) -> bool:
    return bool(re.match(r"\s", ch))


@dataclass(frozen=True)
class OccurrenceInput:
    own: bool
    brand_name: str | None
    source_start: int
    source_end: int
    surface_text: str
    sentiment: Sentiment
    assertion: str | None = None
    context_snippet: str | None = None
    descriptors: tuple[str, ...] = ()
    criteria: tuple[str, ...] = ()
    turn_index: int | None = None


@dataclass
class Span:
    start: int
    end: int
    sentiment: Sentiment
    evidence: list[dict] = field(default_factory=list)


def sentence_bounds(cp: str, start: int, end: int) -> tuple[int, int]:
    """발생 [start, end) 를 담는 문장 경계(코드포인트). spans.ts sentenceBounds 와 같은 규칙."""
    n = len(cp)
    s = start
    while s > 0:
        prev = cp[s - 1]
        if prev == "\n":
            break
        if prev in TERMINAL and (s >= n or _ws(cp[s])):
            break
        s -= 1
    line_end = s
    while line_end < n and cp[line_end] != "\n":
        line_end += 1
    window_end = min(line_end, s + 64, n)
    lead = BULLET_PREFIX.match(cp[s:window_end])
    if lead:
        s += len(lead.group(1))
    s = min(s, start)
    while s < start and _ws(cp[s]):
        s += 1
    e = max(end, s)
    if not (e > s and cp[e - 1] in TERMINAL and (e >= n or _ws(cp[e]))):
        while e < n:
            ch = cp[e]
            if ch == "\n":
                break
            e += 1
            if ch in TERMINAL and (e >= n or _ws(cp[e])):
                break
    return s, e


def build_sentiment_spans(answer_text: str, occurrences: list[OccurrenceInput]) -> tuple[list[Span], int]:
    """당사 발생만 문장 span 으로 접는다. 오프셋이 원문과 안 맞는 발생은 칠하지 않고 skipped 로 센다. 겹치는 span 은 합치고 감성이 갈리면 mixed."""
    cp = answer_text
    n = len(cp)
    skipped = 0
    raw: list[Span] = []
    for o in occurrences:
        if not o.own:
            continue
        if o.source_start < 0 or o.source_end <= o.source_start or o.source_end > n or len(o.surface_text) == 0:
            skipped += 1
            continue
        if cp[o.source_start:o.source_end] != o.surface_text:
            skipped += 1
            continue
        s, e = sentence_bounds(cp, o.source_start, o.source_end)
        ev = {"brand_name": o.brand_name, "sentiment": o.sentiment, "assertion": o.assertion,
              "descriptors": list(o.descriptors), "criteria": list(o.criteria), "context_snippet": o.context_snippet}
        raw.append(Span(s, e, o.sentiment, [ev]))
    raw.sort(key=lambda x: (x.start, x.end))
    spans: list[Span] = []
    for sp in raw:
        last = spans[-1] if spans else None
        if last is not None and sp.start < last.end:
            last.end = max(last.end, sp.end)
            last.evidence.extend(sp.evidence)
            if last.sentiment != sp.sentiment:
                last.sentiment = "mixed"
        else:
            spans.append(sp)
    return spans, skipped


def verify_stance_evidence(answer_text: str | None, turn_index: int, evidence_text: str | None,
                           evidence_start: int | None, evidence_end: int | None) -> Match:
    """스탠스 근거 인용을 원문과 대조. 원문은 1턴만 있으므로 turn>0 은 대조 불가(unavailable)."""
    if not evidence_text:
        return "unavailable"
    if turn_index != 0:
        return "unavailable"
    if not answer_text:
        return "unavailable"
    if evidence_start is not None and evidence_end is not None:
        if not isinstance(evidence_start, int) or not isinstance(evidence_end, int) or isinstance(evidence_start, bool) \
                or isinstance(evidence_end, bool):
            return "mismatch"
        if evidence_start < 0 or evidence_end <= evidence_start or evidence_end > len(answer_text):
            return "mismatch"
        return "verified" if answer_text[evidence_start:evidence_end] == evidence_text else "mismatch"
    return "verified" if evidence_text in answer_text else "mismatch"


def norm_sentiment(v: str | None) -> Sentiment:
    """발생 감성 어휘 밖 값은 neutral(현행 getMirrorAnswerBody 발생 입력 규칙)."""
    return v if v in ("positive", "negative", "mixed") else "neutral"  # type: ignore[return-value]
