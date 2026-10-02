"""표면·본문 정규화와 문자 체계 인지 단어 경계(순수 함수).

정규화(표면과 본문이 같은 함수를 쓴다)
- 글자 묶음(기저 글자 + 뒤따르는 결합 부호, 한글 조합형 중성·종성) 단위로 NFKC → casefold.
  전각 라틴 `ＢＭＷ` = `bmw`, 합자 `ﬁ` = `fi`, NFD 원문 `Citroën` = `citroën`, `ß` = `ss`, 어말 시그마 `ς` = `σ`.
- 대소문자는 casefold(문맥 무관)라서 본문 전체를 한 번에 접든 글자 묶음별로 접든 결과가 같다(멱등·경로 무관).
  Scope normalize.ts 는 toLocaleLowerCase("und")(어말 시그마 문맥 의존) 라 `Σ` 근처에서만 갈린다.
- 발음 구별 기호는 **보존**한다(설계 1-2: Scope 와 같은 NFKC 계열). `Škoda` 표면은 `SKODA` 본문에 맞지 않는다: 그런 표기는
  별칭을 따로 추가한다.
- 공백: 표면은 공백 연속을 한 칸으로 접고 앞뒤를 자른다. 본문은 접지 않는다(오프셋 보존). 대신 매처가 표면의 공백을 `\\s+` 로
  맞춘다(`Ioniq  5`·`Ioniq\\n5` 도 `ioniq 5` 에 맞는다).
- 오프셋은 **원문 코드포인트** 기준(파이썬 str 인덱스 = PostgreSQL substr(text, start+1, end-start)), 끝은 배타.

단어 경계(Scope normalize.ts passesWordBoundary 와 같은 규칙, 코드포인트 단위)
- 띄어쓰기 문자 체계(라틴·그리스·키릴·히브리·아랍·인도계 등): 표면 가장자리 글자 옆에 **같은 체계 글자**·숫자·결합 부호가 붙으면
  더 긴 단어의 일부다(`también` 의 `n`, `percepito` 의 `epit`, `passenger` 의 `pass`, `GV80` 의 `GV`).
- 한글 표면: 왼쪽만 본다(앞 글자가 한글이면 단어 내부: `근현대` 의 `현대` 불일치). 오른쪽은 조사가 붙으므로 연다(`현대차는`).
- 한자·가나·태국어 등 띄어쓰기 없는 체계: 경계를 판정할 수 없어 부분 문자열로 맞춘다(`现代化` 안의 `现代`). 이 체계의 오탐은
  린트 L2(비라틴 1~2자·일반어 사전)가 맡는다.
- 문자 체계가 바뀌는 지점은 경계다: `LG전자`·`BMW의`·`レクサスLS` 는 맞는다.
- 히브리·아랍 한 글자 전치 접어(`ו`·`و` 등, 단어 첫머리일 때만)는 왼쪽 경계로 허용한다(`וסקודה` = "그리고 스코다").
"""
from __future__ import annotations

import bisect
import re
import unicodedata
from dataclasses import dataclass

__all__ = ["Folded", "fold", "infer_surface_lang", "is_word_char", "normalize_surface", "passes_word_boundary", "script_of",
           "surface_pattern", "NO_SPACE_SCRIPTS"]

# (시작, 끝(포함), 체계). 정렬 유지. 블록 단위 근사이며 판정에 필요한 체계만 둔다(목록 밖 글자 = None = 모르는 체계).
_RANGES: tuple[tuple[int, int, str], ...] = tuple(sorted((
    (0x0041, 0x005A, "Latin"), (0x0061, 0x007A, "Latin"), (0x00AA, 0x00AA, "Latin"), (0x00BA, 0x00BA, "Latin"),
    (0x00C0, 0x00D6, "Latin"), (0x00D8, 0x00F6, "Latin"), (0x00F8, 0x024F, "Latin"), (0x0250, 0x02AF, "Latin"),
    (0x1D00, 0x1D7F, "Latin"), (0x1E00, 0x1EFF, "Latin"), (0x2C60, 0x2C7F, "Latin"), (0xA720, 0xA7FF, "Latin"),
    (0xAB30, 0xAB6F, "Latin"), (0xFF21, 0xFF3A, "Latin"), (0xFF41, 0xFF5A, "Latin"),
    (0x0370, 0x03FF, "Greek"), (0x1F00, 0x1FFF, "Greek"),
    (0x0400, 0x052F, "Cyrillic"), (0x1C80, 0x1C8F, "Cyrillic"), (0x2DE0, 0x2DFF, "Cyrillic"), (0xA640, 0xA69F, "Cyrillic"),
    (0x0530, 0x058F, "Armenian"), (0x0590, 0x05FF, "Hebrew"), (0xFB1D, 0xFB4F, "Hebrew"),
    (0x0600, 0x06FF, "Arabic"), (0x0750, 0x077F, "Arabic"), (0x08A0, 0x08FF, "Arabic"), (0xFB50, 0xFDFF, "Arabic"),
    (0xFE70, 0xFEFF, "Arabic"),
    (0x0900, 0x097F, "Devanagari"), (0x0980, 0x09FF, "Bengali"), (0x0A00, 0x0A7F, "Gurmukhi"), (0x0A80, 0x0AFF, "Gujarati"),
    (0x0B00, 0x0B7F, "Oriya"), (0x0B80, 0x0BFF, "Tamil"), (0x0C00, 0x0C7F, "Telugu"), (0x0C80, 0x0CFF, "Kannada"),
    (0x0D00, 0x0D7F, "Malayalam"), (0x0D80, 0x0DFF, "Sinhala"),
    (0x0E00, 0x0E7F, "Thai"), (0x0E80, 0x0EFF, "Lao"), (0x0F00, 0x0FFF, "Tibetan"), (0x1000, 0x109F, "Myanmar"),
    (0x10A0, 0x10FF, "Georgian"), (0x1200, 0x139F, "Ethiopic"), (0x1780, 0x17FF, "Khmer"),
    (0x1100, 0x11FF, "Hangul"), (0x3130, 0x318F, "Hangul"), (0xA960, 0xA97F, "Hangul"), (0xAC00, 0xD7AF, "Hangul"),
    (0xD7B0, 0xD7FF, "Hangul"), (0xFFA0, 0xFFDC, "Hangul"),
    (0x3040, 0x309F, "Hiragana"), (0x30A0, 0x30FF, "Katakana"), (0x31F0, 0x31FF, "Katakana"), (0xFF66, 0xFF9F, "Katakana"),
    (0x2E80, 0x2FDF, "Han"), (0x3005, 0x3007, "Han"), (0x3021, 0x3029, "Han"), (0x3038, 0x303B, "Han"),
    (0x3400, 0x4DBF, "Han"), (0x4E00, 0x9FFF, "Han"), (0xF900, 0xFAFF, "Han"), (0x20000, 0x3134F, "Han"),
)))
_STARTS = [r[0] for r in _RANGES]

# 띄어쓰기를 쓰지 않는 체계: 경계 판정 대상이 아니다.
NO_SPACE_SCRIPTS = frozenset({"Han", "Hiragana", "Katakana", "Thai", "Lao", "Khmer", "Myanmar", "Tibetan"})

_HEBREW_PROCLITICS = frozenset("ובלמהשכ")
_ARABIC_PROCLITICS = frozenset("وفبلك")


def script_of(ch: str) -> str | None:
    """한 글자(코드포인트)의 문자 체계. 목록 밖이면 None."""
    cp = ord(ch)
    i = bisect.bisect_right(_STARTS, cp) - 1
    if i >= 0:
        lo, hi, name = _RANGES[i]
        if lo <= cp <= hi:
            return name
    return None


def is_word_char(ch: str | None) -> bool:
    return bool(ch) and unicodedata.category(ch)[0] in "LNM"


def _is_letter(ch: str) -> bool:
    return unicodedata.category(ch)[0] == "L"


def _is_number_or_mark(ch: str) -> bool:
    return unicodedata.category(ch)[0] in "NM"


def _is_hangul(ch: str | None) -> bool:
    return bool(ch) and script_of(ch) == "Hangul"


def _is_no_space(ch: str | None) -> bool:
    return bool(ch) and script_of(ch) in NO_SPACE_SCRIPTS


# ── 정규화 ────────────────────────────────────────────────────────────────────

def _joins_previous(ch: str) -> bool:
    """앞 글자 묶음에 붙는 글자: 결합 부호, 한글 조합형 중성·종성(NFD 한글이 음절로 합성되게)."""
    cp = ord(ch)
    return unicodedata.category(ch)[0] == "M" or 0x1160 <= cp <= 0x11FF or 0xD7B0 <= cp <= 0xD7FF


def _fold_cluster(cluster: str) -> str:
    return unicodedata.normalize("NFKC", cluster).casefold()


@dataclass(frozen=True, slots=True)
class Folded:
    """접은 본문. start_map[i]·end_map[i] = 접은 글자 i 가 나온 원문 [시작, 끝) (None = 항등, 오프셋 그대로)."""
    text: str
    start_map: tuple[int, ...] | None = None
    end_map: tuple[int, ...] | None = None

    def source_span(self, start: int, end: int) -> tuple[int, int]:
        """접은 본문 [start, end) → 원문 코드포인트 [시작, 끝)."""
        if self.start_map is None or self.end_map is None:
            return start, end
        return self.start_map[start], self.end_map[end - 1]


def fold(text: str) -> Folded:
    """본문 접기. 이미 NFKC 이고 casefold 가 길이를 안 바꾸면(대부분의 답변) 항등 대응표(빠른 경로)."""
    folded = text.casefold()
    if len(folded) == len(text) and unicodedata.is_normalized("NFKC", text):
        return Folded(folded)
    out: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    n = len(text)
    i = 0
    while i < n:
        j = i + 1
        while j < n and _joins_previous(text[j]):
            j += 1
        piece = _fold_cluster(text[i:j])
        out.append(piece)
        starts.extend([i] * len(piece))
        ends.extend([j] * len(piece))
        i = j
    return Folded("".join(out), tuple(starts), tuple(ends))


_WS = re.compile(r"\s+")


def normalize_surface(surface: str) -> str:
    """표면 정규형(ecat_surface_def.surface_norm 의 정본): 본문과 같은 접기 + 공백 접기·자르기."""
    return _WS.sub(" ", fold(surface).text).strip()


def surface_pattern(surface_norm: str) -> re.Pattern[str]:
    """정규형 표면 → 접은 본문 검색 정규식(표면의 공백 = 본문의 공백 연속)."""
    if not surface_norm:
        raise ValueError("빈 표면")
    return re.compile(r"\s+".join(re.escape(part) for part in surface_norm.split(" ")))


def infer_surface_lang(surface: str) -> str:
    """Scope normalize.ts inferSurfaceLanguage 와 같은 순서(ko → ja → zh → en → und)."""
    scripts = {script_of(ch) for ch in surface}
    if "Hangul" in scripts:
        return "ko"
    if scripts & {"Hiragana", "Katakana"}:
        return "ja"
    if "Han" in scripts:
        return "zh"
    if any(ch.isascii() and ch.isalpha() for ch in surface):
        return "en"
    return "und"


# ── 단어 경계 ─────────────────────────────────────────────────────────────────

def _continues_spaced_word(neighbor: str | None, edge: str) -> bool:
    """표면 가장자리 글자 edge 옆의 neighbor 가 같은 단어를 잇는가(Scope continuesSpacedWord 와 같음)."""
    if not neighbor or not is_word_char(neighbor):
        return False
    if _is_number_or_mark(neighbor):
        return True
    if _is_hangul(neighbor) or _is_no_space(neighbor):
        return False
    if not _is_letter(edge):
        return True                     # 가장자리가 숫자·기호면 띄어쓰기 체계 글자는 잇는다(`500e`, `EV6s`)
    a, b = script_of(neighbor), script_of(edge)
    if a is None or b is None:
        return True                     # 모르는 체계는 잇는 것으로(보수적)
    return a == b


def _single_proclitic(text: str, start: int, first: str, prev: str) -> bool:
    script = script_of(first)
    allowed = _HEBREW_PROCLITICS if script == "Hebrew" else _ARABIC_PROCLITICS if script == "Arabic" else None
    if allowed is None or prev not in allowed:
        return False
    before = text[start - 2] if start >= 2 else None
    return not is_word_char(before)


def passes_word_boundary(text: str, start: int, end: int) -> bool:
    """text[start:end] 가 단어 경계를 지키는가. text 는 매칭에 쓴 문자열(접은 본문), 오프셋은 코드포인트."""
    if end <= start:
        return False
    first, last = text[start], text[end - 1]
    prev = text[start - 1] if start > 0 else None
    nxt = text[end] if end < len(text) else None
    if is_word_char(first) and not _is_no_space(first):
        if _is_hangul(first):
            if _is_hangul(prev):
                return False
        elif _continues_spaced_word(prev, first) and not (prev and _single_proclitic(text, start, first, prev)):
            return False
    return not (is_word_char(last) and not _is_no_space(last) and not _is_hangul(last) and _continues_spaced_word(nxt, last))
