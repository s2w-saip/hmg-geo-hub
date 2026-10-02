"""이 기능의 xlsx 예산·격자 규칙. 읽기·쓰기 구현은 전부 공용 app.core.xlsx 다(메인 결정 2026-09-28: openpyxl 미도입, core 로 통일).

쓰기: build = core.xlsx.write_workbook(SheetSpec) 얇은 포장(시트 1장, 인라인 문자열 셀, 첫 행 굵게·틀 고정·열 너비).
  내보내기 응답은 service.export_sheet → core.export.xlsx_response(스트리밍)이고, build 는 테스트·손작성 파일용으로 남긴다.
읽기: 첫 워크시트(workbook.xml 의 첫 sheet → rels 대상, 없으면 xl/worksheets/sheet1.xml), 공유 문자열·인라인 문자열·숫자·불리언·
수식 결과(str) 셀. 파서·예산 집행은 core(검증 D2-R: 예전 구현은 ET.fromstring 으로 부분 파일 전체를 DOM 으로 만들어 '<c/>' 폭탄
20KB 업로드가 RSS +547MB·이벤트 루프 591ms 정지를 냈다). 여기에는 이 기능의 예산과 격자 모양(행 번호 = 격자 위치) 규칙만 둔다.
오류 계약: 어떤 깨진 입력이든 XlsxError(core) 하나로만 나간다. 호출자는 XlsxError 만 잡으면 된다.
"""
from __future__ import annotations

from collections.abc import Sequence

from app.core.xlsx import MiB, SheetSpec, XlsxBudget, XlsxError, XlsxReader, column_index, write_workbook
from app.features.admin.catalog.prompts.schemas import TEXT_MAX

__all__ = ["MAX_COLS", "MAX_ROWS", "NS", "XlsxError", "build", "read_first_sheet", "read_sheet"]

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
MAX_UPLOAD = 5 * MiB
MAX_UNCOMPRESSED = 50 * MiB     # 읽는 부분 파일 하나의 비압축 상한(예전: 전체 합). 스트리밍이라 메모리는 이 값에 묶이지 않는다
MAX_ENTRIES = 200
MAX_ROWS = 20_000
MAX_COLS = 64
MAX_TEXT_CHARS = 24_000_000     # 공유 문자열 총 문자·행 누적 문자(참조마다 센다). 20,000행 × 행당 수백 자의 수 배
MAX_ELEMENTS = 3_000_000        # 시트 XML 원소 총수. 20,000행 × 64열 × 2(c·v) + 행 ≈ 258만을 담는다
MAX_WARNINGS = 200
MAX_WARNING_BYTES = 64 * 1024

BUDGET = XlsxBudget(
    max_upload_bytes=MAX_UPLOAD, max_entries=MAX_ENTRIES, max_entry_bytes=MAX_UNCOMPRESSED, max_elements=MAX_ELEMENTS,
    max_rows=MAX_ROWS, max_row_number=MAX_ROWS,        # 행 번호 r 자체가 상한 안(빈 행 채우기로 상한 우회 불가) + 증가
    max_cols=MAX_COLS, extra_columns="drop", strict_order=True,   # 열 상한 밖 셀은 버린다, 같은 행 열 참조도 증가
    max_cell_chars=TEXT_MAX + 1, cell_overflow="truncate",        # 본문 상한 + 1: preview 가 '본문이 TEXT_MAX자를 넘어' 로 판정
    max_shared_strings=MAX_ROWS * MAX_COLS, max_shared_chars=MAX_TEXT_CHARS, max_total_chars=MAX_TEXT_CHARS,
    max_warnings=MAX_WARNINGS, max_warning_bytes=MAX_WARNING_BYTES, bool_text=("true", "false"))
_READER = XlsxReader(BUDGET)


def _col_index(ref: str) -> int:
    """셀 참조(A1)의 열 번호(0 기준). MAX_COLS 를 넘으면 곧바로 MAX_COLS(core.column_index)."""
    return column_index(ref, MAX_COLS)


def build(sheet: str, header: Sequence[str], rows: Sequence[Sequence[str | None]], widths: Sequence[float] | None = None) -> bytes:
    """시트 1장 xlsx 바이트(core.xlsx.write_workbook). 빈 문자열·None 셀은 빈 칸."""
    return write_workbook([SheetSpec(sheet, list(header), rows, widths)])


def read_sheet(data: bytes) -> tuple[list[list[str]], list[str]]:
    """(첫 워크시트의 셀 문자열 격자(행 번호 순, 빈 셀 = "", 빠진 행 = []), 파서 경고). 숫자는 정수면 소수점 없이."""
    sheet = _READER.read(data)
    grid: list[list[str]] = []
    for r in sheet.rows:
        while len(grid) < r.number - 1:
            grid.append([])
        grid.append(r.cells)
    return grid, sheet.warnings


def read_first_sheet(data: bytes) -> list[list[str]]:
    return read_sheet(data)[0]
