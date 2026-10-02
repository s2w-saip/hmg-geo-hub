"""core.xlsx 단위·회귀 테스트(DB 없음): 셀 해석, 오류 계약, 예산 집행, 폭탄 입력의 메모리·시간·이벤트 루프 간격.

폭탄 회귀(검증 pj-prompts D3-R·ad-content D2-R)는 tracemalloc 피크·처리 시간·파싱 중 5ms asyncio 티커의 최대 간격을 단언한다.
간격은 기능과 같은 경로(anyio.to_thread.run_sync 작업 스레드)로 잰다. 수정 전 기능 파서의 실측은 각 테스트 주석에 적었다.
파싱이 실제로 작업 스레드에서 돌았는지(이벤트 루프 스레드가 아닌지)는 XlsxReader.read 를 감싸 스레드를 기록해 결정적으로 단언한다.
간격(gap·비율) 단언은 공용 셀프호스트 러너(HGH_CI_SHARED_RUNNER=1)에서만 판정하지 않고 값을 경고로 남긴다(assert_loop_gap).
"""
from __future__ import annotations

import asyncio
import base64
import io
import os
import random
import threading
import time
import tracemalloc
import warnings as pywarnings
import zipfile
from collections.abc import Callable
from typing import Any

import anyio.to_thread
import pytest

from app.core.xlsx import (
    CHUNK,
    MiB,
    Warnings,
    XlsxBudget,
    XlsxError,
    XlsxReader,
    XlsxSheet,
    clip,
    column_index,
    column_letter,
)

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WB = f'<workbook xmlns="{NS}" xmlns:r="{REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'.encode()


def rels(target: str = "worksheets/sheet1.xml") -> bytes:
    return ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{REL}/worksheet" Target="{target}"/></Relationships>').encode()


def book(sheet: bytes | str, shared: bytes | str | None = None, *, target: str = "worksheets/sheet1.xml",
         extra: dict[str, bytes] | None = None, method: int = zipfile.ZIP_DEFLATED) -> bytes:
    path = target.lstrip("/")
    path = path if path.startswith("xl/") else "xl/" + path
    parts: dict[str, bytes] = {"xl/workbook.xml": WB, "xl/_rels/workbook.xml.rels": rels(target),
                               path: sheet.encode() if isinstance(sheet, str) else sheet}
    if shared is not None:
        parts["xl/sharedStrings.xml"] = shared.encode() if isinstance(shared, str) else shared
    parts.update(extra or {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", method) as z:
        for k, v in parts.items():
            z.writestr(k, v)
    return buf.getvalue()


def ws(body: bytes | str, after: bytes = b"") -> bytes:
    b = body.encode() if isinstance(body, str) else body
    return b'<worksheet xmlns="' + NS.encode() + b'"><sheetData>' + b + b"</sheetData>" + after + b"</worksheet>"


def sst(*items: bytes | str) -> bytes:
    out = [b'<sst xmlns="' + NS.encode() + b'">']
    for s in items:
        out += [b'<si><t xml:space="preserve">', s.encode() if isinstance(s, str) else s, b"</t></si>"]
    return b"".join([*out, b"</sst>"])


def junk(n: int, seed: int = 7) -> bytes:
    """압축이 잘 안 되는 XML 안전 문자열 n 바이트(base64 문자). 압축비 가드를 피해 다른 예산을 시험할 때 쓴다."""
    return base64.b64encode(random.Random(seed).randbytes(n * 3 // 4 + 3))[:n]


def read(data: bytes, **kw: Any) -> XlsxSheet:
    return XlsxReader(XlsxBudget(**kw)).read(data)


def code_of(data: bytes, **kw: Any) -> str:
    with pytest.raises(XlsxError) as e:
        read(data, **kw)
    return e.value.code


def cells(sheet: XlsxSheet) -> list[tuple[int, list[str]]]:
    return [(r.number, r.cells) for r in sheet.rows]


# ── 셀 해석·모양 ──
def test_cell_types_rich_text_and_row_shape():
    shared = sst("  id ", b"<r><t>te</t></r><r><t>xt</t></r><rPh><t>PHON</t></rPh>")
    sheet = ws('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v> 1 </v></c></row>'
               '<row r="3"><c r="A3"><v>12.0</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" t="b"><v>0</v></c>'
               '<c r="D3"><v>1.5</v></c><c r="E3"><v>1E+20</v></c><c r="F3" t="str"><f>A1</f><v> s </v></c>'
               '<c r="G3" t="inlineStr"><is><t>  in </t><r><t>line  </t></r></is></c><c r="H3" t="s"/><c r="J3"/></row>'
               '<row r="4"></row>')
    got = read(book(sheet, shared))
    assert cells(got) == [(1, ["id", "", "text"]),
                          (3, ["12", "TRUE", "FALSE", "1.5", "1E+20", "s", "in line", "", "", ""]),
                          (4, [])]
    assert read(book(sheet, shared), bool_text=("true", "false")).rows[1].cells[1:3] == ["true", "false"]
    assert got.warnings == [] and got.stats["rows"] == 3


def test_sheet_resolution_and_fallback():
    sheet = ws('<row><c t="inlineStr"><is><t>x</t></is></c><c t="inlineStr"><is><t>y</t></is></c></row>')
    assert cells(read(book(sheet, target="/xl/worksheets/data.xml"))) == [(1, ["x", "y"])]      # 절대 경로·r 없는 행·셀
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:                                                          # 워크북 없음 → sheet1.xml
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    assert cells(read(buf.getvalue())) == [(1, ["x", "y"])]
    empty_wb = book(sheet, extra={"xl/workbook.xml": f'<workbook xmlns="{NS}"><sheets/></workbook>'.encode()},
                    target="worksheets/other.xml")
    assert code_of(empty_wb) == "empty_sheet"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("docProps/app.xml", "<x/>")
    assert code_of(buf.getvalue()) == "invalid_xlsx"


def test_column_index_and_letter():
    assert [column_index(r, 64) for r in ("A1", "b2", "BL9", "BM1", "1", "")] == [0, 1, 63, 64, -1, -1]
    assert column_index("Z" * 200_000 + "1", 64) == 64                  # 큰 정수 연산 없이 즉시 멈춘다
    assert [column_letter(i) for i in (0, 25, 26, 63, 16383)] == ["A", "Z", "AA", "BL", "XFD"]


# ── 오류 계약: 깨진 입력은 전부 XlsxError(코드) ──
def _flip_deflate(data: bytes, part: str) -> bytes:
    info = zipfile.ZipFile(io.BytesIO(data)).getinfo(part)
    off = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra) + 5
    bad = bytearray(data)
    bad[off] ^= 0xFF
    return bytes(bad)


def _unsupported_method(data: bytes) -> bytes:
    """모든 항목의 압축 방식을 99 로 바꾼다(로컬 헤더 +8, 중앙 디렉터리 +10)."""
    b = bytearray(data)
    for sig, off in ((b"PK\x03\x04", 8), (b"PK\x01\x02", 10)):
        i = b.find(sig)
        while i >= 0:
            b[i + off:i + off + 2] = (99).to_bytes(2, "little")
            i = b.find(sig, i + 4)
    return bytes(b)


def _dtd_at_chunk_boundary() -> bytes:
    pad = b"<!--" + b" " * (CHUNK - 4 - 4 - 3) + b"-->"                  # '<!DOCTYPE' 가 64KB 조각 경계에 걸리게
    return pad + b"<!DOCTYPE w [<!ENTITY e 'x'>]>" + ws("")


@pytest.mark.parametrize("data,code", [
    (b"not a zip", "invalid_xlsx"),
    (book(ws('<row r="1"><c t="inlineStr"><is><t>' + "b" * 4000 + "</t></is></c></row>"))[:-30], "invalid_xlsx"),   # 잘린 zip
    (_flip_deflate(book(ws('<row r="1"><c t="inlineStr"><is><t>' + "ab" * 3000 + "</t></is></c></row>")), "xl/worksheets/sheet1.xml"),
     "invalid_xlsx"),
    (book(ws('<row r="1"><c>')), "invalid_xlsx"),                                                # 닫히지 않은 XML
    (book(ws('<row r="abc"/>')), "invalid_xlsx"),
    (book(ws('<row r="0"/>')), "invalid_xlsx"),
    (book(ws('<row r="-3"/>')), "invalid_xlsx"),
    (book(ws('<row r="1234567890"/>')), "invalid_xlsx"),                                         # 10자리: 정수 변환 전에 거부
    (book(ws('<row r="5"/><row r="2"/>')), "invalid_xlsx"),                                      # 역순
    (book(ws('<row r="1"><c r="C1"><v>1</v></c><c r="A1"><v>2</v></c></row>')), "invalid_xlsx"),   # 같은 행 열 역순
    (book(ws('<row r="1"><c r="A1" t="s"><v>abc</v></c></row>'), sst("x")), "invalid_xlsx"),     # 공유 문자열 번호 형식
    (book(ws('<row r="1"><c r="A1" t="s"><v>1</v></c></row>'), sst("x")), "invalid_xlsx"),       # 공유 문자열 범위 밖
    (book(b'<?xml version="1.0"?><!DOCTYPE w [<!ENTITY e "x">]>' + ws("")), "invalid_xlsx"),
    (book(_dtd_at_chunk_boundary()), "invalid_xlsx"),
    (book(b"\xff\xfe" + ws("").decode().encode("utf-16-le")), "invalid_xlsx"),                  # UTF-16(BOM)
    (book(ws("").decode().encode("utf-16-le")), "invalid_xlsx"),                                  # UTF-16(BOM 없음)
    (book(b'<?xml version="1.0" encoding="ISO-8859-1"?>' + ws("")), "invalid_xlsx"),
    (_unsupported_method(book(ws(""), method=zipfile.ZIP_STORED)), "invalid_xlsx"),               # 미지원 압축 방식
])
def test_malformed_inputs_raise_only_xlsx_error(data, code):
    assert code_of(data) == code


def test_utf8_declaration_and_bom_are_accepted():
    body = ws('<row r="1"><c t="inlineStr"><is><t>한글</t></is></c></row>')
    for prefix in (b"", b"\xef\xbb\xbf", b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n', b"<?xml version='1.0' encoding='utf-8'?>"):
        assert cells(read(book(prefix + body))) == [(1, ["한글"])]


# ── 구조 예산 ──
def test_structure_budgets():
    deep = ws("", b"<a>" * 100 + b"</a>" * 100)
    assert code_of(book(deep)) == "invalid_xlsx"                                                  # 깊이 64
    assert read(book(deep), max_depth=128).rows == []
    huge_text = ws(b'<row r="1"><c t="inlineStr"><is><t>' + junk(2 * MiB) + b"</t></is></c></row>")
    assert code_of(book(huge_text)) == "invalid_xlsx"                                             # 토큰(텍스트 하나) 1MB
    attrs = b"".join(b' a%d=""' % i for i in range(200_000))                                     # 태그 하나에 속성 20만 개
    assert code_of(book(ws(b"", b"<x" + attrs + b"/>"))) == "invalid_xlsx"
    many = ws(b"", b"<e>" + b"".join(b"<%s/>" % bytes([97 + i % 26]) for i in range(5000)) + b"</e>")
    assert code_of(book(many), max_elements=4000) == "too_many_cells"                            # 시트 밖 원소도 센다
    assert code_of(book(ws('<row r="1"><c t="inlineStr"><is><t>a</t></is></c></row>')), max_upload_bytes=100) == "file_too_large"
    lots = book(ws(""), extra={f"x/{i}.bin": b"" for i in range(50)})
    assert code_of(lots, max_entries=20) == "file_too_large"
    assert code_of(book(ws("<row/>" * 3000)), max_entry_bytes=10_000) == "file_too_large"         # 선언 크기


def test_row_and_column_budgets():
    wide = book(ws('<row r="1">' + "".join(f'<c r="{column_letter(i)}1"><v>{i}</v></c>' for i in range(70)) + "</row>"))
    assert code_of(wide, max_cols=64) == "too_many_columns"
    assert len(read(wide, max_cols=64, extra_columns="drop").rows[0].cells) == 64                  # 상한 밖 열은 버림
    same = book(ws('<row r="1">' + '<c r="A1"><v>1</v></c>' * 300 + "</row>"))
    assert code_of(same, max_cols=200, strict_order=False) == "too_many_columns"                  # 같은 칸 반복도 셀 수로 센다
    assert code_of(same) == "invalid_xlsx"                                                        # strict: 중복 열
    assert read(book(ws('<row r="1"><c r="B1"><v>2</v></c><c r="A1"><v>1</v></c></row>')), strict_order=False).rows[0].cells == ["1", "2"]
    assert code_of(book(ws("<row/>" * 11)), max_rows=10) == "too_many_rows"
    assert code_of(book(ws('<row r="21"/>')), max_row_number=20) == "too_many_rows"
    assert read(book(ws('<row r="20"/>')), max_row_number=20).rows[0].number == 20


# ── 셀 길이·공유 문자열·총량 ──
def test_cell_overflow_truncate_or_reject():
    body = ws('<row r="3"><c r="B3" t="inlineStr"><is><t>' + " " * 5000 + "abc" + " " * 5000 + '</t></is></c>'
              '<c r="C3" t="inlineStr"><is><t>' + "a" * 20 + '</t></is></c><c r="D3"><v>' + "9" * 20 + "</v></c></row>")
    got = read(book(body), max_cell_chars=10)
    assert got.rows[0].cells == ["", "abc", "a" * 10, "9" * 10]
    assert got.warnings == ["C3: 셀 값이 10자를 넘어 앞 10자만 읽었습니다", "D3: 셀 값이 10자를 넘어 앞 10자만 읽었습니다"]
    with pytest.raises(XlsxError) as e:
        read(book(body), max_cell_chars=10, cell_overflow="reject")
    assert (e.value.code, e.value.location) == ("cell_too_long", "xl/worksheets/sheet1.xml!C3")


def test_shared_strings_normalized_once_and_counted_per_reference():
    refs = "".join(f'<c r="{column_letter(i)}2" t="s"><v>0</v></c>' for i in range(5))
    data = book(ws(f'<row r="2">{refs}</row>'), sst(" " + "x" * 50 + " "))
    row = read(data, max_cell_chars=20).rows[0].cells
    assert row == ["x" * 20] * 5 and all(c is row[0] for c in row)                               # 한 번 저장, 셀은 같은 객체 참조
    assert len(read(data, max_cell_chars=20).warnings) == 5                                       # 경고는 참조한 셀마다(위치)
    assert code_of(data, max_cell_chars=20, max_total_chars=99) == "text_too_large"               # 참조마다 20자 × 5 = 100
    assert code_of(data, max_shared_chars=10) == "text_too_large"
    assert code_of(book(ws(""), sst(*["a"] * 11)), max_shared_strings=10) == "too_many_cells"


def test_warnings_sink_bounds_and_clip():
    w = Warnings(3, 1000, max_message_chars=10)
    for i in range(5):
        w.add(f"경고 {i} " + "x" * 50)
    assert w.to_list() == ["경고 0 xxxxx…", "경고 1 xxxxx…", "경고 2 xxxxx…", "경고 2건 더 있음"] and len(w) == 5
    w = Warnings(100, 40)
    w.extend(["가" * 5] * 10)                                                                      # 한 건 15바이트 → 2건까지
    assert w.to_list() == ["가" * 5, "가" * 5, "경고 8건 더 있음"]
    assert clip("a\x00b\ud800c\x7f" + "d" * 100, 5) == "abcdd…" and clip("짧다") == "짧다"


# ── 폭탄 회귀: 메모리·시간·이벤트 루프 ──
BIG = XlsxBudget(max_entry_bytes=50 * MiB, max_rows=20_000, max_row_number=20_000, max_cols=64, extra_columns="drop",
                 max_cell_chars=5001, max_shared_strings=1_280_000, max_shared_chars=24_000_000, max_total_chars=24_000_000,
                 max_elements=3_000_000)                         # admin.catalog.bulk 와 같은 규모(가장 큰 기능 예산)
SMALL = XlsxBudget(max_entry_bytes=16 * MiB, max_rows=11_000, max_cols=200, strict_order=False, max_cell_chars=4001,
                   max_shared_strings=1_000_200)                 # projects.prompts.io 와 같은 규모


def outcome(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except XlsxError as e:
        return e


def peak_of(fn: Callable[[], Any]) -> tuple[int, Any]:
    tracemalloc.start()
    try:
        res = outcome(fn)
        return tracemalloc.get_traced_memory()[1], res
    finally:
        tracemalloc.stop()


# 공용 셀프호스트 러너(조직 공용 러너, back-ci 가 HGH_CI_SHARED_RUNNER=1 을 넘긴다)는 머신 과부하(loadavg 27, 8코어 실측)로 긴 GIL 보유
# 구간이 늘어 이 간격이 0.26~0.65초로 흔들린다(2026-09-30, 같은 시험이 호스티드·로컬에서는 통과). 거기서는 간격을 판정하지 않고
# 값만 경고로 남긴다. 스레드 배정(작업 스레드 여부)·피크 메모리·처리 시간·결과 단언은 어디서나 그대로 판정한다.
SHARED_RUNNER = os.environ.get("HGH_CI_SHARED_RUNNER") == "1"


def assert_loop_gap(ok: bool, detail: Any) -> None:
    if SHARED_RUNNER:
        pywarnings.warn(f"HGH_CI_SHARED_RUNNER=1: 이벤트 루프 간격 단언 판정 생략(공용 러너 부하), 만족={ok} {detail}", stacklevel=2)
        return
    assert ok, detail


async def timed_gap(fn: Callable[[], Any]) -> tuple[float, float, Any]:
    """fn 을 작업 스레드(anyio.to_thread, 기능과 같은 경로)에서 돌리는 동안 5ms 티커의 최대 간격. (최대 간격 초, 처리 초, 결과)."""
    gaps: list[float] = []
    done = asyncio.Event()

    async def ticker() -> None:
        last = time.perf_counter()
        while not done.is_set():
            await asyncio.sleep(0.005)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    task = asyncio.create_task(ticker())
    await asyncio.sleep(0.03)
    gaps.clear()
    t0 = time.perf_counter()
    res = await anyio.to_thread.run_sync(outcome, fn)
    took = time.perf_counter() - t0
    done.set()
    await task
    return max(gaps, default=0.0), took, res


def cell_bomb(mb: int) -> bytes:
    """검증 ad-content D2-R 재현: 한 행에 '<c/>' 를 N MB. 수정 전 ad 파서 실측(이 파일들): 10MB 피크 238MB·루프 간격 291ms,
    20MB 피크 477MB·0.7~0.8초·루프 간격 558~618ms(검증 보고: RSS +547MB·591ms)."""
    return book(ws(b'<row r="1">' + b"<c/>" * (mb * MiB // 4) + b"</row>"))


def normal_20000x20() -> bytes:
    """정상 대용량: 20,000행 × 20열 인라인 문자열(기능 내보내기와 같은 형태, 시트 약 32MB). 수정 전 ad 파서: 피크 477MB·루프 간격 443~473ms."""
    rows = []
    for r in range(1, 20_001):
        cs = "".join(f'<c r="{column_letter(c)}{r}" t="inlineStr"><is><t xml:space="preserve">r{r}c{c}-값</t></is></c>' for c in range(20))
        rows.append(f'<row r="{r}">{cs}</row>')
    return book(ws("".join(rows)))


def shared_amp(refs_per_row: int, rows: int, size: int = 900_000) -> bytes:
    """검증 pj-prompts D3-R(a): 큰 공유 문자열 하나를 셀 여럿이 참조. 압축비 가드에 걸리지 않게 압축 안 되는 문자열을 쓴다
    (검증 원판 = 공백 2MB 는 압축비 200:1 에 먼저 걸린다, 아래 테스트)."""
    body = "".join(f'<row r="{r}">' + "".join(f'<c r="{column_letter(c)}{r}" t="s"><v>0</v></c>' for c in range(refs_per_row)) + "</row>"
                   for r in range(1, rows + 1))
    return book(ws(body), sst(b"  " + junk(size) + b"  "))


BOMBS = {
    # 이름: (파일 생성, 예산, 기대 코드 또는 None(성공), 피크 상한 MB, 시간 상한 초)
    "shared_amp_50": (lambda: shared_amp(50, 1), SMALL, None, 16, 3),                 # 수정 전 pj: 셀당 복사(50 × 0.9MB)
    "shared_amp_200x100": (lambda: shared_amp(200, 100), SMALL, "text_too_large", 16, 3),   # 수정 전: 2만 참조 × 0.9MB ≈ 18GB
    "shared_amp_verifier": (lambda: book(ws('<row r="2">' + "".join(f'<c r="{column_letter(c)}2" t="s"><v>0</v></c>' for c in range(50))
                                            + "</row>"), sst(b" " + b"x" * (2 * MiB) + b" ")), SMALL, "file_too_large", 8, 3),
    "cell_bomb_10MB": (lambda: cell_bomb(10), BIG, "file_too_large", 16, 3),
    "cell_bomb_20MB": (lambda: cell_bomb(20), BIG, "file_too_large", 16, 3),
    "ratio_bomb_16MB": (lambda: book(ws(b"", b"<extLst>" + b"<x/>" * (4 * MiB) + b"</extLst>")), BIG, "file_too_large", 16, 3),
    "normal_20000x20": (normal_20000x20, BIG, None, 96, 10),
}


@pytest.mark.parametrize("name", list(BOMBS))
async def test_bomb_memory_time_and_event_loop(name, monkeypatch):
    make, budget, code, peak_mb, secs = BOMBS[name]
    data = make()
    assert len(data) < 5 * MiB, name                                                     # 업로드 상한 안의 작은 파일
    reader = XlsxReader(budget)
    loop_thread = threading.get_ident()
    read_threads: list[int] = []
    real_read = XlsxReader.read

    def spy_read(self: XlsxReader, *args: Any, **kwargs: Any) -> Any:                   # 실제 파싱 함수가 도는 스레드를 기록
        read_threads.append(threading.get_ident())
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(XlsxReader, "read", spy_read)
    gap, took, res = await timed_gap(lambda: reader.read(data))
    gap_threads = list(read_threads)
    # 결정적 단언: 간격을 잰 파싱은 이벤트 루프 스레드가 아닌 작업 스레드에서 돌았다(timed_gap 이 동기 호출이면 여기서 실패)
    assert gap_threads and loop_thread not in gap_threads, (name, loop_thread, gap_threads)
    peak, res2 = peak_of(lambda: reader.read(data))
    got = res.code if isinstance(res, XlsxError) else None
    assert got == code and (res2.code if isinstance(res2, XlsxError) else None) == code, (name, res)
    assert peak < peak_mb * MiB, (name, peak)
    assert took < secs, (name, took)
    # 루프 정지 = 절대 100ms 가 아니라 처리 시간 대비(수정 전 파서는 정지/처리 약 0.8, CI 2 vCPU 는 로컬보다 7~10배 느려 절대값이 흔들림).
    # 비율 0.25 는 CI 에서 0.27 로 흔들림(2026-09-29) → 0.5. 공용 러너에서는 판정 생략(assert_loop_gap)
    assert_loop_gap(gap < max(0.1, 0.5 * took) and gap < 0.5, (name, gap, took))
    if name == "ratio_bomb_16MB":
        assert "압축비" in res.message                                                     # 1MB 유예 뒤 비율로 조기 거부
    if name == "normal_20000x20":
        assert len(res.rows) == 20_000 and res.rows[-1].cells[-1] == "r20000c19-값"
    if name == "shared_amp_50":
        row = res.rows[0].cells
        assert len(row) == 50 and len(row[0]) == 4001 and all(c is row[0] for c in row)
        assert len(res.warnings) == 50                                                    # 잘림 경고(위치별), 건수·바이트 상한 안
