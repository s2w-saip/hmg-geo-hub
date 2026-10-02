"""내보내기 응답(CSV·xlsx) 한 벌(전체-통합 §5 core.export, Q19 서버 변환).

- CSV: UTF-8 BOM, CRLF, 스트리밍(500행 조각). 스프레드시트 수식 주입(=·+·-·@·탭·CR 로 시작하는 셀)은 작은따옴표 접두로 무력화한다.
  원값 형과 무관하게 직렬화된 셀 문자열에 건다(목록·dict 포함). 예외는 숫자형(int·float·Decimal)뿐이다(음수 -5 는 수식이 아니다).
- xlsx: core.xlsx.iter_workbook 스트리밍(인라인 문자열 셀이라 수식이 없다). 동기 이터레이터라 Starlette 가 스레드 풀에서 돌린다
  (행 직렬화·압축이 이벤트 루프를 막지 않는다).
- 헤더: Content-Disposition(ASCII 이름 + RFC 5987 filename*), Cache-Control: no-store, 상한에서 잘렸으면 X-Export-Truncated: true.
- rows 는 dict(열 키 → 값) 목록·이터러블. labels 를 주면 첫 행 표시 이름(없으면 열 키).
"""
from __future__ import annotations

import csv
import io
import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from decimal import Decimal
from typing import Any, Literal
from urllib.parse import quote

from fastapi.responses import StreamingResponse

from app.core.xlsx import SheetSpec, cell_text, iter_workbook

__all__ = ["CSV_MEDIA", "XLSX_MEDIA", "csv_chunks", "csv_safe", "export_headers", "export_response", "xlsx_response"]

CSV_MEDIA = "text/csv; charset=utf-8"
XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def csv_safe(v: Any) -> str:
    s = cell_text(v)
    if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
        return s
    return "'" + s if s.startswith(_FORMULA_LEAD) else s


def csv_chunks(columns: Sequence[str], rows: Iterable[Mapping[str, Any]], *, labels: Sequence[str] | None = None,
               chunk: int = 500) -> Iterator[bytes]:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    buf.write("﻿")
    w.writerow([csv_safe(x) for x in (labels or columns)])
    for n, r in enumerate(rows, start=1):
        w.writerow([csv_safe(r.get(c)) for c in columns])
        if n % chunk == 0:
            yield buf.getvalue().encode("utf-8")
            buf.seek(0)
            buf.truncate(0)
    tail = buf.getvalue()
    if tail:
        yield tail.encode("utf-8")


def _ascii_name(filename: str) -> str:
    """ASCII 대체 이름: 허용 밖 문자는 '_', 앞머리 구분자 제거, 이름 부분이 비면 'export' + 확장자."""
    stem, dot, ext = filename.rpartition(".")
    if not dot:
        stem, ext = filename, ""
    s = _UNSAFE_NAME.sub("_", stem).strip("_-.")
    e = _UNSAFE_NAME.sub("", ext)
    return (s or "export") + (f".{e}" if e else "")


def export_headers(filename: str, *, truncated: bool = False, ascii_fallback: str | None = None) -> dict[str, str]:
    """ascii_fallback: filename 이 ASCII 가 아닐 때 filename="" 에 쓸 이름(기본: filename 에서 허용 문자만 남긴 것)."""
    ascii_name = _ascii_name(ascii_fallback or filename)
    cd = f'attachment; filename="{ascii_name}"'
    if ascii_name != filename:
        cd += f"; filename*=UTF-8''{quote(filename, safe='')}"
    h = {"Content-Disposition": cd, "Cache-Control": "no-store"}
    if truncated:
        h["X-Export-Truncated"] = "true"
    return h


def xlsx_response(sheets: Sequence[SheetSpec], *, filename: str, truncated: bool = False,
                  ascii_fallback: str | None = None) -> StreamingResponse:
    """여러 시트 xlsx 스트리밍 응답(컨텍스트 맵 등)."""
    return StreamingResponse(iter_workbook(sheets), media_type=XLSX_MEDIA,
                             headers=export_headers(filename, truncated=truncated, ascii_fallback=ascii_fallback))


def export_response(fmt: Literal["csv", "xlsx"] | str, columns: Sequence[str], rows: Iterable[Mapping[str, Any]], *, basename: str,
                    truncated: bool = False, labels: Sequence[str] | None = None, sheet: str = "data",
                    widths: Sequence[float] | None = None) -> StreamingResponse:
    """한 표 내보내기. fmt csv|xlsx(그 밖은 ValueError: 라우터가 Literal 로 막는다)."""
    if fmt == "csv":
        return StreamingResponse(csv_chunks(columns, rows, labels=labels), media_type=CSV_MEDIA,
                                 headers=export_headers(f"{basename}.csv", truncated=truncated))
    if fmt != "xlsx":
        raise ValueError(f"내보내기 형식: {fmt}")
    spec = SheetSpec(sheet, list(labels or columns), ([r.get(c) for c in columns] for r in rows), widths)
    return xlsx_response([spec], filename=f"{basename}.xlsx", truncated=truncated)
