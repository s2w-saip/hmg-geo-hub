"""xlsx 읽기 예산·행 모양(공용 app.core.xlsx 스트리밍 파서에 이 기능의 예산을 걸어 쓴다).

읽기: 첫 워크시트만(공유 문자열·inlineStr·str·n·b 셀). 파서·예산 집행은 core(검증 D3-R: 공유 문자열을 참조마다 복사하던 증폭,
원문을 싣던 경고를 core 에서 막는다). 여기에는 이 기능의 예산 값과 행 모양(1행 = 헤더, 빈 데이터 행 생략) 규칙만 둔다.
쓰기(내보내기)는 core.xlsx.write_workbook(SheetSpec)(6라운드 통일, pj-prompts §1 처분): 인라인 문자열 셀이라
'=' 로 시작해도 수식이 아니고, 1행 굵게·고정, 빈 값('')은 셀을 쓰지 않는다.
"""
from __future__ import annotations

from app.core.xlsx import MiB, XlsxBudget, XlsxError, XlsxReader
from app.features.projects.prompts.crud.schemas import MAX_TEXT

__all__ = ["MAX_COLS", "MAX_PART_BYTES", "XlsxError", "budget", "read_sheet", "read_workbook"]

# 압축 해제 후 부분 파일 상한(검증 D3 로 40MB → 16MB). 업로드 5MB·5,000행 기준 본문 평균 1,000자 한글도 담는다.
MAX_PART_BYTES = 16 * MiB
MAX_META_BYTES = 1 * MiB                # workbook.xml·관계 파일
MAX_COLS = 200
MAX_CELL_CHARS = MAX_TEXT + 1           # 본문 상한 + 1 에서 자른다: 하류가 '본문이 MAX_TEXT자를 넘어 건너뜀' 으로 그대로 판정한다
MAX_TEXT_CHARS = 16_000_000             # 공유 문자열 총 문자·행 누적 문자(참조마다 센다). 부분 파일 16MB 와 같은 규모
MAX_ELEMENTS = 2_000_000                # 시트 XML 원소 총수(16MB 안 정상 파일은 ≤ 약 100만)
MAX_WARNINGS = 200
MAX_WARNING_BYTES = 64 * 1024


# ── 읽기 ──
def budget(max_rows: int) -> XlsxBudget:
    """이 기능의 파싱 예산. max_rows = 데이터 행 상한(비어 있지 않은 행)."""
    return XlsxBudget(
        max_entry_bytes=MAX_PART_BYTES, max_meta_bytes=MAX_META_BYTES, max_elements=MAX_ELEMENTS,
        max_rows=max_rows * 2 + 1000,                  # 행 요소(빈 행 포함)
        max_cols=MAX_COLS, extra_columns="reject", strict_order=False,
        max_cell_chars=MAX_CELL_CHARS, cell_overflow="truncate",
        max_shared_strings=(max_rows + 1) * MAX_COLS, max_shared_chars=MAX_TEXT_CHARS, max_total_chars=MAX_TEXT_CHARS,
        max_warnings=MAX_WARNINGS, max_warning_bytes=MAX_WARNING_BYTES, bool_text=("TRUE", "FALSE"))


def read_sheet(data: bytes, *, max_rows: int) -> tuple[list[tuple[int, list[str]]], list[str]]:
    """(첫 시트의 행 [(시트 행 번호, 셀 문자열(strip) 목록)], 파서 경고). 첫 행 = 헤더(비어도 둔다), 빈 데이터 행은 뺀다.
    비어 있지 않은 데이터 행이 max_rows 를 넘으면 too_many_rows. 그 밖의 상한은 budget(max_rows) 를 파싱 중에 적용한다."""
    sheet = XlsxReader(budget(max_rows)).read(data)
    out: list[tuple[int, list[str]]] = []
    for r in sheet.rows:
        if r.number > 1 and not any(r.cells):
            continue
        out.append((r.number, r.cells))
        if len(out) - 1 > max_rows:
            raise XlsxError("too_many_rows", f"데이터 행은 {max_rows}개까지")
    return out, sheet.warnings


def read_workbook(data: bytes, *, max_rows: int) -> list[tuple[int, list[str]]]:
    return read_sheet(data, max_rows=max_rows)[0]
