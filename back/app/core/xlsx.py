"""공용 xlsx 읽기·쓰기(표준 라이브러리 zipfile·xml.etree 만, openpyxl 미도입: 메인 결정 2026-09-28). 기능별 가져오기 파서
(projects.prompts.io, admin.catalog.bulk, projects.settings.tracked_urls)와 내보내기 작성기(catalog·intent 컨텍스트 맵·관리 카탈로그·
프로젝트 추적 URL·프로젝트 프롬프트)를 대체한다. 쓰기는 이 파일 끝 "쓰기" 절.

왜 공용인가(검증 pj-prompts D3-R·ad-content D2-R): 두 기능이 파서를 따로 두다 보니 한쪽은 부분 파일 전체를 DOM 으로 만들고
(ET.fromstring, '<c/>' 폭탄 20KB 업로드가 RSS +547MB·이벤트 루프 591ms 정지), 다른 쪽은 공유 문자열을 참조마다 복사하고
경고에 원문을 그대로 실어 인증된 업로드 한 건이 GB 급 메모리를 쓸 수 있었다. 예산을 한곳에서 파싱 중에 집행한다.

읽기 방식
- 스트리밍: zip 엔트리를 64KB 조각으로 ET.XMLPullParser 에 먹이고 start·end 이벤트로 처리한다. 값은 end 이벤트에서 꺼내고,
  행은 end 에서 처리한 뒤 elem.clear() 한다. 조각 하나를 다 처리하면 열린 원소들에 붙은 끝난 자식을 떼어 낸다. 메모리에 남는 트리는
  열린 원소 경로(깊이 ≤ max_depth)와 조각 하나(64KB) 분량뿐이다.
- 조각 하나를 먹일 때마다 파이썬 바이트코드로 돌아오므로(전환 간격 5ms) 작업 스레드(anyio.to_thread)에서 돌리면 이벤트 루프 스레드가
  GIL 을 얻는다. 파싱 중 5ms 티커의 최대 간격은 back/tests/core/test_xlsx.py 가 측정해 단언한다(실측 6~17ms, 수정 전 DOM 파서
  276~560ms. 정상 20,000행×20열 약 1초로 수정 전과 같다).
- 공유 문자열은 읽을 때 한 번만 정규화(strip·길이 상한)해 저장하고 셀은 같은 str 객체를 참조한다(참조마다 복사하지 않는다).
  행 누적 문자 예산(max_total_chars)은 참조마다 센다: 하류(검증·JSON 응답)가 다룰 총량의 상한이기 때문이다.
- 안전: UTF-8 XML 만 받고 DOCTYPE·ENTITY 선언을 바이트로 거부한다(엔티티 확장·외부 참조). 깨진 zip·zlib·XML·정수 변환은
  전부 XlsxError 하나로 나간다.

오류 계약: XlsxError(code, message, location). 기능이 API 오류로 바꾼다(422 등). 코드
  invalid_xlsx      형식 위반(zip·XML·DTD·UTF-8 아님·행/열 참조·깊이·토큰 과대·순서 위반)
  file_too_large    업로드·엔트리 비압축 상한(선언값과 실제 읽은 바이트)·압축비 상한
  too_many_rows / too_many_columns / too_many_cells(공유 문자열 수·XML 원소 수)
  text_too_large    공유 문자열 총 문자·행 누적 총 문자
  cell_too_long     셀 값 길이(cell_overflow="reject" 일 때만)
  empty_sheet       워크북에 시트가 없다
"""
from __future__ import annotations

import io
import re
import zipfile
import zlib
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Literal
from xml.etree import ElementTree as ET

MiB = 1024 * 1024
CHUNK = 64 * 1024

# 압축 해제·엔트리 열기 중 깨진 zip 이 내는 예외(CRC 불일치·손상 deflate·잘린 파일·미지원 압축·암호화 항목)
_ZIP_ERRORS = (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError, OSError, ValueError)
_CTRL = re.compile(r"[\x00-\x1f\x7f\ud800-\udfff]")
_ENCODING = re.compile(rb"""encoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']""")
_DTD_MARKS = (b"<!DOCTYPE", b"<!ENTITY")
_MARK_TAIL = max(len(m) for m in _DTD_MARKS) - 1
# XMLPullParser 이벤트 이름(정적 SQL 스캔은 낱말 하나뿐인 문자열을 SQL 로 보지 않는다: tests/core/test_guards.py _SINGLE_WORD)
_START, _END = "start", "end"


class XlsxError(ValueError):
    """읽을 수 없는·예산을 넘는 파일. code 는 API 오류 코드, location 은 부분 파일·셀 위치(예: 'xl/worksheets/sheet1.xml!B12')."""

    def __init__(self, code: str, message: str, location: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.location = location

    def __str__(self) -> str:
        return f"{self.message} ({self.location})" if self.location else self.message

    def details(self) -> dict[str, str] | None:
        """API 오류 details(위치만, 원문 값은 싣지 않는다)."""
        return {"location": self.location} if self.location else None


@dataclass(frozen=True, slots=True)
class XlsxBudget:
    """파싱 예산. 전부 파싱 중에 즉시 적용한다(다 읽은 뒤 세지 않는다). 기능은 자기 기본값으로 만든다."""
    max_upload_bytes: int = 5 * MiB           # 업로드(zip) 바이트
    max_entries: int = 1000                   # zip 항목 수
    max_entry_bytes: int = 16 * MiB           # 읽는 엔트리 하나의 비압축 바이트(선언값·실제 둘 다)
    max_meta_bytes: int = 1 * MiB             # workbook.xml·관계 파일
    max_ratio: int = 200                      # 비압축/압축 비율(zip 폭탄). ratio_grace_bytes 넘게 읽은 뒤부터 적용. 정상 시트 실측 ≤ 35:1, 폭탄 ≈ 1000:1
    ratio_grace_bytes: int = 1 * MiB
    max_elements: int = 2_000_000             # 엔트리 하나의 XML 원소 총수(행×열 상한과 별개: 버려지는 셀·시트 밖 원소 포함)
    max_depth: int = 64                       # 원소 중첩 깊이
    max_token_bytes: int = 1 * MiB            # 이벤트 없이 연달아 먹일 수 있는 바이트(거대 태그·속성·텍스트 하나)
    max_rows: int = 20_000                    # <row> 원소 수(빈 행 포함)
    max_row_number: int | None = None         # 행 번호 r 상한(None 이면 9자리까지)
    max_cols: int = 64                        # 열 번호 상한(0 기준 max_cols - 1 까지)
    extra_columns: Literal["reject", "drop"] = "reject"   # 상한 밖 열: 거부(too_many_columns) 또는 버림
    strict_order: bool = True                 # 행 번호·같은 행 열 참조가 증가해야 한다(False 면 뒤 셀이 덮는다)
    max_cell_chars: int = 32_767              # 셀 값 길이(strip 뒤). Excel 셀 상한
    cell_overflow: Literal["truncate", "reject"] = "truncate"   # 넘으면 잘라서 경고 또는 거부(cell_too_long)
    max_shared_strings: int = 1_000_000       # 공유 문자열 개수
    max_shared_chars: int = 16_000_000        # 공유 문자열 총 문자(저장된 값 기준)
    max_total_chars: int = 16_000_000         # 행 누적 문자 총량(공유 문자열은 참조마다 센다)
    max_warnings: int = 200                   # 경고 건수(넘치면 마지막에 요약 1줄)
    max_warning_bytes: int = 64 * 1024        # 경고 총 바이트(UTF-8)
    bool_text: tuple[str, str] = ("TRUE", "FALSE")   # t="b" 셀 1·0 의 문자열


@dataclass(frozen=True, slots=True)
class XlsxRow:
    number: int                # 시트 행 번호(1 기준)
    cells: list[str]           # 열 번호 순 셀 문자열(strip). 없는 칸은 "", 길이 = 마지막으로 나온 셀 열 + 1


@dataclass(slots=True)
class XlsxSheet:
    rows: list[XlsxRow]
    warnings: list[str]
    stats: dict[str, int] = field(default_factory=dict)   # 측정·테스트용(원소 수·비압축 바이트 등)


# ── 경고 ──
def clip(s: str, n: int = 40) -> str:
    """경고 문구에 넣는 원문: 제어 문자·서로게이트를 빼고 n 자로 자른다."""
    t = _CTRL.sub("", s[: n * 4])
    return t if len(t) <= n else t[:n] + "…"


class Warnings:
    """건수·총 바이트 상한이 있는 경고 모음. 넘치면 버리고 to_list() 끝에 '경고 N건 더 있음' 한 줄을 붙인다.
    문구 하나도 max_message_chars 로 자른다(호출자가 원문을 clip 하지 않아도 한 건이 커지지 않게)."""

    __slots__ = ("items", "max_count", "max_bytes", "max_message_chars", "used", "dropped")

    def __init__(self, max_count: int = 200, max_bytes: int = 64 * 1024, *, max_message_chars: int = 300):
        self.items: list[str] = []
        self.max_count = max_count
        self.max_bytes = max_bytes
        self.max_message_chars = max_message_chars
        self.used = 0
        self.dropped = 0

    def add(self, msg: str) -> None:
        if self.dropped:
            self.dropped += 1
            return
        if len(msg) > self.max_message_chars:
            msg = msg[: self.max_message_chars] + "…"
        b = len(msg.encode("utf-8", "replace"))
        if len(self.items) >= self.max_count or self.used + b > self.max_bytes:
            self.dropped = 1
            return
        self.items.append(msg)
        self.used += b

    def extend(self, msgs: Iterable[str]) -> None:
        for m in msgs:
            self.add(m)

    def __len__(self) -> int:
        return len(self.items) + self.dropped

    def to_list(self) -> list[str]:
        return [*self.items, f"경고 {self.dropped}건 더 있음"] if self.dropped else list(self.items)


# ── 셀 참조 ──
def column_index(ref: str, limit: int) -> int:
    """셀 참조(A1·ab12)의 열 번호(0 기준). 앞의 영문자만 본다(없으면 -1). limit 이상이 되는 즉시 limit 을 돌려준다
    (아주 긴 열 문자가 큰 정수 연산으로 CPU 를 잡지 않게)."""
    n = 0
    for ch in ref:
        o = ord(ch)
        if 65 <= o <= 90:
            n = n * 26 + (o - 64)
        elif 97 <= o <= 122:
            n = n * 26 + (o - 96)
        else:
            break
        if n > limit:
            return limit
    return n - 1


def column_letter(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _uint(raw: str | None) -> int | None:
    """1 이상 9자리 이하 10진 정수(공백 허용). 아니면 None."""
    if raw is None:
        return None
    t = raw.strip()
    if not t or len(t) > 9 or not (t.isascii() and t.isdigit()):
        return None
    v = int(t)
    return v if v >= 1 else None


# ── 텍스트 누적(strip·길이 상한을 쌓는 동안 적용) ──
class _Text:
    """<si>·<is> 의 <t> 조각을 이어 붙인다. 앞 공백은 버리고 cap+1 자까지만 보관한다(그 뒤는 공백 아닌 문자가 있는지만 본다)."""

    __slots__ = ("parts", "n", "cap", "over")

    def __init__(self, cap: int):
        self.parts: list[str] = []
        self.n = 0
        self.cap = cap
        self.over = False

    def add(self, s: str | None) -> None:
        if not s:
            return
        if not self.n:
            s = s.lstrip()
            if not s:
                return
        room = self.cap + 1 - self.n
        if room <= 0:
            if not self.over and not s.isspace():
                self.over = True
            return
        if len(s) > room:
            if not self.over and not s[room:].isspace():
                self.over = True
            s = s[:room]
        self.parts.append(s)
        self.n += len(s)

    def take(self) -> tuple[str, bool]:
        """(strip 한 값, 상한을 넘어 잘렸는가). 상태를 비운다."""
        v = "".join(self.parts).rstrip() if len(self.parts) != 1 else self.parts[0].rstrip()
        cut = self.over or len(v) > self.cap
        if cut:
            v = v[: self.cap].rstrip()
        self.parts, self.n, self.over = [], 0, False
        return v, cut


def _one(s: str | None, cap: int) -> tuple[str, bool]:
    """<v> 텍스트 하나의 strip·상한."""
    if not s:
        return "", False
    v = s.strip()
    if len(v) > cap:
        return v[:cap].rstrip(), True
    return v, False


def _local_name(tag: str, cache: dict[str, str]) -> str:
    ln = cache.get(tag)
    if ln is None:
        ln = tag.rpartition("}")[2]
        if len(cache) < 256:           # 서로 다른 태그 이름 폭탄이 캐시를 키우지 않게
            cache[tag] = ln
    return ln


# ── 읽기 ──
class XlsxReader:
    """첫 워크시트 읽기. 상태는 read() 호출마다 새로 만든다(인스턴스는 여러 스레드에서 공유해도 된다)."""

    def __init__(self, budget: XlsxBudget | None = None):
        self.budget = budget or XlsxBudget()

    def read(self, data: bytes) -> XlsxSheet:
        return _Run(self.budget).read(data)


class _Run:
    def __init__(self, b: XlsxBudget):
        self.b = b
        self.warn = Warnings(b.max_warnings, b.max_warning_bytes)
        self.stats: dict[str, int] = {"elements": 0, "bytes": 0}
        self.names: dict[str, str] = {}

    def _walk(self, z: zipfile.ZipFile, name: str, cap: int) -> Iterator[list[tuple[bool, ET.Element, str, int]]]:
        """zip 엔트리를 64KB 조각으로 XMLPullParser 에 먹이고, 조각 하나의 이벤트를 (start 여부, 원소, 지역 이름, 깊이) 목록으로 낸다.

        조각마다 비압축 상한(실제 읽은 바이트)·압축비·DTD·토큰 크기, 이벤트마다 원소 수·깊이 예산을 적용한다(넘으면 그 조각을
        소비자에게 넘기기 전에 거부). 소비자가 목록을 다 처리하고 다음 조각을 청하면, 열린 원소들에 붙은 끝난 자식을 떼어 낸다
        (끝난 원소와 그 하위 트리가 해제된다). 소비자는 end 이벤트를 처리하는 그 목록 안에서 text·attrib 을 꺼내야 한다.
        빌더는 조각 단위로 앞서 달리므로 end 시점의 '마지막 자식'이 그 원소라는 보장이 없어 조각 끝에서 한 번에 뗀다."""
        b = self.b
        info = z.getinfo(name)
        if info.file_size > cap:
            raise XlsxError("file_too_large", f"압축 해제 크기 상한({cap} 바이트) 초과", name)
        parser = ET.XMLPullParser(events=(_START, _END))
        stack: list[ET.Element] = []
        names = self.names
        names_get = names.get
        max_el, max_depth = b.max_elements, b.max_depth
        elements = seen = quiet = 0
        tail = b""
        first = True
        done = False
        packed = max(info.compress_size, 1)
        try:
            f = z.open(info)
        except _ZIP_ERRORS as e:
            raise XlsxError("invalid_xlsx", "xlsx(zip) 항목을 열 수 없다", name) from e
        with f:
            while not done:
                try:
                    chunk = f.read(CHUNK)
                except _ZIP_ERRORS as e:
                    raise XlsxError("invalid_xlsx", "xlsx(zip) 압축 해제 실패", name) from e
                try:
                    if chunk:
                        seen += len(chunk)
                        if seen > cap:
                            raise XlsxError("file_too_large", f"압축 해제 크기 상한({cap} 바이트) 초과", name)
                        if seen > b.ratio_grace_bytes and seen > b.max_ratio * packed:
                            raise XlsxError("file_too_large", f"압축비 상한({b.max_ratio}:1) 초과", name)
                        if first:
                            _check_prolog(chunk, name)
                            first = False
                        if any(m in chunk for m in _DTD_MARKS) or (tail and any(m in tail + chunk[:_MARK_TAIL] for m in _DTD_MARKS)):
                            raise XlsxError("invalid_xlsx", "DTD·엔티티가 있는 XML 은 받지 않는다", name)
                        tail = chunk[-_MARK_TAIL:]
                        parser.feed(chunk)
                    else:
                        parser.close()
                        done = True
                except ET.ParseError as e:
                    raise _parse_error(e, name) from None
                batch: list[tuple[bool, ET.Element, str, int]] = []
                add = batch.append
                depth = len(stack)
                try:
                    for ev, el in parser.read_events():         # 파싱 오류는 feed 가 아니라 여기서 나온다(대기열에 실린 예외)
                        tag = el.tag
                        ln = names_get(tag)
                        if ln is None:
                            ln = _local_name(tag, names)
                        if ev == _START:
                            elements += 1
                            if elements > max_el:
                                raise XlsxError("too_many_cells", f"XML 원소 수 상한({max_el}) 초과", name)
                            if depth >= max_depth:
                                raise XlsxError("invalid_xlsx", f"XML 중첩 깊이 상한({max_depth}) 초과", name)
                            stack.append(el)
                            depth += 1
                            add((True, el, ln, depth))
                        else:
                            add((False, el, ln, depth))
                            stack.pop()
                            depth -= 1
                except ET.ParseError as e:
                    raise _parse_error(e, name) from None
                if batch:
                    quiet = 0
                    yield batch
                    batch = []
                    last = len(stack) - 1
                    for i, open_el in enumerate(stack):        # 끝난 자식 떼기(열린 자식 = stack[i+1] 은 항상 마지막 자식)
                        n = len(open_el)
                        if i < last:
                            if n > 1:
                                del open_el[: n - 1]
                        elif n:
                            del open_el[:]
                elif chunk:
                    quiet += len(chunk)
                    if quiet > b.max_token_bytes:
                        raise XlsxError("invalid_xlsx", f"XML 태그·텍스트 하나가 상한({b.max_token_bytes} 바이트)을 넘는다", name)
        self.stats["elements"] += elements
        self.stats["bytes"] += seen

    # ── 워크북 → 첫 시트 경로 ──
    def _first_sheet(self, z: zipfile.ZipFile, names: set[str]) -> str:
        fallback = "xl/worksheets/sheet1.xml"
        if "xl/workbook.xml" not in names or "xl/_rels/workbook.xml.rels" not in names:
            if fallback in names:
                return fallback
            raise XlsxError("invalid_xlsx", "워크북(xl/workbook.xml)이 없다")
        rid: str | None = None
        found = False
        for start, el, ln, _ in _flat(self._walk(z, "xl/workbook.xml", self.b.max_meta_bytes)):
            if start and ln == "sheet" and not found:
                found = True
                rid = next((v for k, v in el.attrib.items() if k.rpartition("}")[2] == "id"), None)
        if not found:
            if fallback in names:
                return fallback
            raise XlsxError("empty_sheet", "시트가 없다", "xl/workbook.xml")
        target: str | None = None
        for start, el, ln, _ in _flat(self._walk(z, "xl/_rels/workbook.xml.rels", self.b.max_meta_bytes)):
            if start and ln == "Relationship" and target is None and rid is not None and el.get("Id") == rid:
                target = el.get("Target") or ""
        if not target:
            if fallback in names:
                return fallback
            raise XlsxError("invalid_xlsx", "첫 시트의 관계가 없다", "xl/_rels/workbook.xml.rels")
        t = target.lstrip("/")
        path = t if t.startswith("xl/") else "xl/" + t
        if path not in names:
            raise XlsxError("invalid_xlsx", "첫 시트 부분 파일이 없다", path)
        return path

    # ── 공유 문자열 ──
    def _shared(self, z: zipfile.ZipFile) -> tuple[list[str], set[int]]:
        b = self.b
        name = "xl/sharedStrings.xml"
        out: list[str] = []
        cut: set[int] = set()
        chars = 0
        text = _Text(b.max_cell_chars)
        si_depth = 0
        rph = 0
        for batch in self._walk(z, name, b.max_entry_bytes):
            for start, el, ln, depth in batch:
                if start:
                    if ln == "si" and depth == 2:
                        if len(out) >= b.max_shared_strings:
                            raise XlsxError("too_many_cells", f"공유 문자열 개수 상한({b.max_shared_strings}) 초과", name)
                        si_depth = depth
                    elif si_depth and ln == "rPh":
                        rph += 1
                elif si_depth:
                    if depth == si_depth:              # </si>
                        v, over = text.take()
                        if over:
                            cut.add(len(out))
                        chars += len(v)
                        if chars > b.max_shared_chars:
                            raise XlsxError("text_too_large", f"공유 문자열 총 문자 상한({b.max_shared_chars}) 초과", name)
                        out.append(v)
                        si_depth = 0
                    elif ln == "rPh":
                        rph -= 1
                    elif ln == "t" and not rph:
                        text.add(el.text)
        self.stats["shared_strings"] = len(out)
        return out, cut

    # ── 시트 ──
    def _sheet(self, z: zipfile.ZipFile, name: str, shared: list[str], shared_cut: set[int]) -> list[XlsxRow]:
        b = self.b
        cap = b.max_cell_chars
        reject_cols = b.extra_columns == "reject"
        strict = b.strict_order
        row_cap = b.max_row_number
        t_true, t_false = b.bool_text
        rows: list[XlsxRow] = []
        total = 0
        sd_depth = 0              # sheetData 깊이(0 = 밖)
        row_depth = 0             # 열린 행 깊이(0 = 행 밖)
        rn = last_rn = 0
        cells: dict[int, str] = {}
        n_cells = 0
        last_col = -1             # 같은 행 마지막 셀 열(자동 열 번호·순서 검사)
        c_depth = 0               # 열린(받아들인) 셀 깊이(0 = 셀 밖)
        c_col = 0
        c_type: str | None = None
        v_text: str | None = None
        in_is = False
        rph = 0
        text = _Text(cap)

        def where(col: int | None = None) -> str:
            return f"{name}!{column_letter(col)}{rn}" if col is not None else f"{name} 행 {rn}"

        def overflow(col: int) -> None:
            if b.cell_overflow == "reject":
                raise XlsxError("cell_too_long", f"셀 값이 {cap}자를 넘는다", where(col))
            self.warn.add(f"{column_letter(col)}{rn}: 셀 값이 {cap}자를 넘어 앞 {cap}자만 읽었습니다")

        for batch in self._walk(z, name, b.max_entry_bytes):
            for start, el, ln, depth in batch:
                if start:
                    if c_depth:
                        if depth == c_depth + 1 and ln == "is":
                            in_is = True
                        elif in_is and ln == "rPh":
                            rph += 1
                    elif row_depth:
                        if depth == row_depth + 1 and ln == "c":
                            n_cells += 1
                            ref = el.get("r")
                            col = column_index(ref, b.max_cols) if ref else -1
                            if col < 0:
                                col = last_col + 1
                            if reject_cols and (col >= b.max_cols or n_cells > b.max_cols):
                                raise XlsxError("too_many_columns", f"열은 {b.max_cols}개까지", where())
                            if col >= b.max_cols:
                                last_col = col                 # 버리는 셀(drop): 값·순서 검사 없이 지나간다
                                continue
                            if strict and col <= last_col:
                                raise XlsxError("invalid_xlsx", "같은 행 안에서 열 참조가 중복이거나 역순", where(col))
                            last_col = col
                            c_depth, c_col, c_type, v_text, in_is, rph = depth, col, el.get("t"), None, False, 0
                    elif sd_depth:
                        if depth == sd_depth + 1 and ln == "row":
                            if len(rows) >= b.max_rows:
                                raise XlsxError("too_many_rows", f"행 요소는 {b.max_rows}개까지", name)
                            raw = el.get("r")
                            if raw is None or not raw.strip():
                                rn = last_rn + 1
                            else:
                                got = _uint(raw)
                                if got is None:
                                    raise XlsxError("invalid_xlsx", f"행 번호 형식 오류: {clip(raw, 20)!r}", name)
                                rn = got
                            if row_cap is not None and rn > row_cap:
                                raise XlsxError("too_many_rows", f"행 번호 {rn} 가 상한({row_cap}) 초과", name)
                            if strict and rn <= last_rn:
                                raise XlsxError("invalid_xlsx", f"행 번호 {rn} 가 중복이거나 역순", name)
                            last_rn = rn
                            row_depth, cells, n_cells, last_col = depth, {}, 0, -1
                    elif ln == "sheetData":
                        sd_depth = depth
                    continue
                # end
                if c_depth:
                    if depth == c_depth:                                   # </c>
                        t = c_type
                        if t == "inlineStr":
                            val, over = text.take()
                        elif t == "s":
                            val, over = "", False
                            s = (v_text or "").strip()
                            if s:
                                i = int(s) if (len(s) <= 9 and s.isascii() and s.isdigit()) else -1
                                if not 0 <= i < len(shared):
                                    raise XlsxError("invalid_xlsx", "공유 문자열 참조 오류", where(c_col))
                                val, over = shared[i], i in shared_cut
                        else:
                            val, over = _one(v_text, cap)
                            if t == "b":
                                val = t_true if val == "1" else t_false if val == "0" else val
                            elif (t is None or t == "n") and val:
                                try:
                                    fv = float(val)
                                    if fv.is_integer() and abs(fv) < 1e15:
                                        val = str(int(fv))
                                except (ValueError, OverflowError):
                                    pass
                        if over:
                            overflow(c_col)
                        total += len(val)
                        if total > b.max_total_chars:
                            raise XlsxError("text_too_large", f"셀 문자 총량 상한({b.max_total_chars}) 초과", where(c_col))
                        cells[c_col] = val
                        c_depth = 0
                        text.parts, text.n, text.over = [], 0, False
                    elif in_is:
                        if ln == "t" and not rph:
                            text.add(el.text)
                        elif ln == "rPh":
                            rph -= 1
                        elif ln == "is" and depth == c_depth + 1:
                            in_is = False
                    elif ln == "v" and depth == c_depth + 1:
                        v_text = el.text
                elif row_depth:
                    if depth == row_depth:                                 # </row>
                        width = max(cells) + 1 if cells else 0
                        rows.append(XlsxRow(rn, [cells.get(i, "") for i in range(width)]))
                        row_depth = 0
                        el.clear()                                         # 행 처리 끝: 셀 하위 트리를 바로 놓는다
                elif sd_depth and depth == sd_depth:
                    sd_depth = 0
        self.stats["rows"] = len(rows)
        self.stats["total_chars"] = total
        return rows

    def read(self, data: bytes) -> XlsxSheet:
        b = self.b
        if len(data) > b.max_upload_bytes:
            raise XlsxError("file_too_large", f"업로드 상한({b.max_upload_bytes} 바이트) 초과")
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except _ZIP_ERRORS as e:
            raise XlsxError("invalid_xlsx", "xlsx(zip) 형식이 아니다") from e
        with z:
            infos = z.infolist()
            if len(infos) > b.max_entries:
                raise XlsxError("file_too_large", f"zip 항목 수 상한({b.max_entries}) 초과")
            names = {i.filename for i in infos}
            sheet = self._first_sheet(z, names)
            shared, cut = self._shared(z) if "xl/sharedStrings.xml" in names else ([], set())
            rows = self._sheet(z, sheet, shared, cut)
        return XlsxSheet(rows=rows, warnings=self.warn.to_list(), stats=self.stats)


def _flat(batches: Iterable[list[tuple[bool, ET.Element, str, int]]]) -> Iterator[tuple[bool, ET.Element, str, int]]:
    for batch in batches:
        yield from batch


def _check_prolog(chunk: bytes, name: str) -> None:
    """UTF-8 XML 만 받는다. DTD 검사를 바이트로 하려면 ASCII 호환 인코딩이어야 하기 때문이다(UTF-16·EBCDIC 거부).
    Excel·LibreOffice·ExcelJS·openpyxl 은 모두 UTF-8 로 쓴다."""
    b = chunk[3:] if chunk.startswith(b"\xef\xbb\xbf") else chunk
    if b[:1] == b"\x00" or b[1:2] == b"\x00" or b[:2] in (b"\xff\xfe", b"\xfe\xff") or b.lstrip()[:1] not in (b"<", b""):
        raise XlsxError("invalid_xlsx", "UTF-8 이 아닌 XML 은 받지 않는다", name)       # 첫 글자는 ASCII '<'(앞 공백 허용)
    if b.startswith(b"<?xml"):
        end = b.find(b"?>", 0, 512)
        if end < 0:
            raise XlsxError("invalid_xlsx", "XML 선언 형식 오류", name)
        m = _ENCODING.search(b, 0, end)
        if m and m.group(1).lower() not in (b"utf-8", b"utf8"):
            raise XlsxError("invalid_xlsx", "UTF-8 이 아닌 XML 은 받지 않는다", name)


def _parse_error(e: ET.ParseError, name: str) -> XlsxError:
    line, col = getattr(e, "position", (0, 0))
    return XlsxError("invalid_xlsx", "XML 형식 오류", f"{name}:{line}:{col}")


# ════════════════════════════════════════════════════════════════════════════
# 쓰기: 인라인 문자열(t="inlineStr") + 숫자 셀, 첫 행 굵게·틀 고정, 시트 여러 장. 행은 흘려 쓴다(시트 XML 전체를 문자열로 만들지 않는다).
#   write_workbook  → bytes(탐색 가능한 버퍼, 일반 zip). 작은 파일·테스트.
#   iter_workbook   → bytes 조각 이터레이터(탐색 불가 스트림, 데이터 서술자 zip). 응답 스트리밍(core.export)이 쓴다.
#   셀: None·'' 는 빈 칸, bool 은 'true'·'false' 문자열, int·float·Decimal 은 숫자(유한값만, 아니면 빈 칸), 날짜는 ISO 문자열,
#   목록은 ';' 결합, dict 는 JSON, 그 밖은 str(). XML 1.0 금지 문자(제어·U+FFFE·FFFF·서로게이트)는 지운다.
#   인라인 문자열 셀은 수식이 아니므로 수식 주입 무력화가 필요 없다(CSV 는 core.export 가 무력화).
#   시트명: [ ] : * ? / \ 를 공백으로, 31자, 대소문자 무시 중복은 ' 2'·' 3' 접미(현행 context-map-export.ts addSheet 방어).
# ════════════════════════════════════════════════════════════════════════════
_NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
_XML_BAD = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff\ud800-\udfff]")
_SHEET_BAD = re.compile(r"[\[\]:*?/\\]")
_ROWS_PER_WRITE = 500
_STYLES_XML = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="{_NS_MAIN}">'
               '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
               '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
               '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
               '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
               '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
               '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>')


@dataclass
class SheetSpec:
    """쓸 시트 하나. rows 는 한 번만 순회한다(제너레이터 가능). widths 는 열 너비(문자 수), None 이면 지정 안 함."""
    name: str
    headers: Sequence[str]
    rows: Iterable[Sequence[object]]
    widths: Sequence[float] | None = None
    freeze_header: bool = True


def cell_text(v: object) -> str:
    """셀·CSV 공용 문자열 표현(숫자 제외 규칙은 _cell_xml 이 먼저 처리)."""
    import datetime as _dt
    import json as _json
    from uuid import UUID as _UUID

    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (_dt.datetime, _dt.date)):
        return v.isoformat()
    if isinstance(v, _UUID):
        return str(v)
    if isinstance(v, (list, tuple)):
        return ";".join(cell_text(x) for x in v)
    if isinstance(v, dict):
        return _json.dumps(v, ensure_ascii=False, sort_keys=True, default=str)
    return str(v)


def sheet_title(name: str) -> str:
    return _SHEET_BAD.sub(" ", name or "")[:31] or "Sheet"


def auto_widths(headers: Sequence[str], rows: Sequence[Sequence[object]], *, sample: int = 1000, lo: int = 10, hi: int = 60) -> list[int]:
    """앞 sample 행의 문자 수로 열 너비(현행 컨텍스트 맵 내보내기와 같은 규칙: 최장 + 2, 10~60)."""
    out = []
    for i, h in enumerate(headers):
        m = max([len(str(h))] + [len(cell_text(r[i])) for r in rows[:sample] if i < len(r) and r[i] is not None])
        out.append(min(max(m + 2, lo), hi))
    return out


def _is_number(v: object) -> bool:
    import math
    from decimal import Decimal

    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    if isinstance(v, float):
        return math.isfinite(v)
    if isinstance(v, Decimal):
        return v.is_finite()
    return False


def _xml_text(s: str) -> str:
    s = _XML_BAD.sub("", s)
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _cell_xml(ref: str, v: object, style: int = 0) -> str:
    st = f' s="{style}"' if style else ""
    if _is_number(v):
        return f'<c r="{ref}"{st}><v>{v}</v></c>'
    if isinstance(v, float):                     # nan·inf
        return ""
    t = cell_text(v)
    if t == "":
        return ""
    return f'<c r="{ref}" t="inlineStr"{st}><is><t xml:space="preserve">{_xml_text(t)}</t></is></c>'


def _row_xml(r: int, values: Sequence[object], style: int = 0) -> str:
    return f'<row r="{r}">' + "".join(_cell_xml(f"{column_letter(j)}{r}", v, style) for j, v in enumerate(values)) + "</row>"


def _unique_titles(sheets: Sequence[SheetSpec]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for sh in sheets:
        t = sheet_title(sh.name)
        base, k = t, 2
        while t.lower() in seen:
            t = f"{base[:28]} {k}"
            k += 1
        seen.add(t.lower())
        names.append(t)
    return names


def _package_parts(names: Sequence[str]) -> list[tuple[str, str]]:
    n = len(names)
    sheets_ct = "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" '
                        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(n))
    head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    return [
        ("[Content_Types].xml", head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
         '<Default Extension="xml" ContentType="application/xml"/>'
         '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
         '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
         f"{sheets_ct}</Types>"),
        ("_rels/.rels", head + f'<Relationships xmlns="{_NS_PKG}">'
         '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
         'Target="xl/workbook.xml"/></Relationships>'),
        ("xl/workbook.xml", head + f'<workbook xmlns="{_NS_MAIN}" xmlns:r="{_NS_REL}"><sheets>'
         + "".join(f'<sheet name="{_xml_text(t)}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, t in enumerate(names))
         + "</sheets></workbook>"),
        ("xl/_rels/workbook.xml.rels", head + f'<Relationships xmlns="{_NS_PKG}">'
         + "".join(f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                   f'Target="worksheets/sheet{i + 1}.xml"/>' for i in range(n))
         + f'<Relationship Id="rId{n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
           'Target="styles.xml"/></Relationships>'),
        ("xl/styles.xml", _STYLES_XML),
    ]


def _sheet_prefix(sh: SheetSpec) -> str:
    views = ('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
             '</sheetView></sheetViews>') if sh.freeze_header else ""
    cols = ""
    if sh.widths:
        cols = "<cols>" + "".join(f'<col min="{j + 1}" max="{j + 1}" width="{w}" customWidth="1"/>' for j, w in enumerate(sh.widths)) + "</cols>"
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="{_NS_MAIN}" xmlns:r="{_NS_REL}">'
            f"{views}{cols}<sheetData>" + _row_xml(1, list(sh.headers), 1))


class _Sink(io.RawIOBase):
    """탐색 불가 쓰기 대상: zipfile 이 데이터 서술자 방식으로 쓴다. take() 로 쌓인 바이트를 꺼낸다."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._pos = 0

    def writable(self) -> bool:
        return True

    def write(self, b: bytes) -> int:            # type: ignore[override]
        self._buf += b
        self._pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self._pos

    def take(self) -> bytes:
        out = bytes(self._buf)
        self._buf.clear()
        return out


def write_workbook(sheets: Iterable[SheetSpec]) -> bytes:
    """시트 목록 → xlsx 바이트(일반 zip)."""
    bio = io.BytesIO()
    with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
        for _ in _write_parts(z, list(sheets), lambda: None, []):
            pass
    return bio.getvalue()


def iter_workbook(sheets: Iterable[SheetSpec]) -> Iterator[bytes]:
    """시트 목록 → xlsx 바이트 조각(행 500개마다 압축된 만큼 내보낸다). 동기 이터레이터: Starlette 가 스레드 풀에서 돌린다."""
    sink = _Sink()
    out: list[bytes] = []

    def flush() -> None:
        b = sink.take()
        if b:
            out.append(b)

    specs = list(sheets)
    z = zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED)   # noqa: SIM115  닫기는 아래 finally
    try:
        yield from _write_parts(z, specs, flush, out)
    finally:
        z.close()
    tail = sink.take()
    if tail:
        yield tail


def _write_parts(z: zipfile.ZipFile, sheets: Sequence[SheetSpec], flush: Callable[[], None], out: list[bytes]) -> Iterator[bytes]:
    """패키지 부분 → 시트(행 500개 단위로 압축 스트림에 쓴다). flush 때마다 쌓인 조각을 내보낸다(write_workbook 은 버린다)."""
    names = _unique_titles(sheets)
    for name, body in _package_parts(names):
        z.writestr(name, body.encode("utf-8"))
    flush()
    yield from _drain(out)
    for i, sh in enumerate(sheets):
        with z.open(f"xl/worksheets/sheet{i + 1}.xml", "w") as f:
            f.write(_sheet_prefix(sh).encode("utf-8"))
            buf: list[str] = []
            for r_i, row in enumerate(sh.rows, start=2):
                buf.append(_row_xml(r_i, row))
                if len(buf) >= _ROWS_PER_WRITE:
                    f.write("".join(buf).encode("utf-8"))
                    buf.clear()
                    flush()
                    yield from _drain(out)
            if buf:
                f.write("".join(buf).encode("utf-8"))
            f.write(b"</sheetData></worksheet>")
        flush()
        yield from _drain(out)


def _drain(out: list[bytes]) -> Iterator[bytes]:
    while out:
        yield out.pop(0)
