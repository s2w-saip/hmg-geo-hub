"""One worksheet as an .xlsx file, for the downloads that are a screen's answer (website/prompts-export, citation/domains-export).

The shape is the removed legacy writer's (git d77f278 back/app/core/xlsx.py): inline strings, so no cell can be a formula; a bold first row, frozen;
column widths of the longest value + 2, within 10 and 60. Standard library only. The file is built whole: these lists hold thousands of rows, not millions."""
from __future__ import annotations

import io
import re
import zipfile
from collections.abc import Iterable, Sequence
from typing import Any
from urllib.parse import quote
from xml.sax.saxutils import escape

from starlette.responses import Response

MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_NOT_IN_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_NOT_IN_SHEET_NAME = re.compile(r"[\[\]:*?/\\]")
_MIN_WIDTH, _MAX_WIDTH = 10, 60

_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"""
_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"""
_WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"""
_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>"""


def _column(index: int) -> str:
    name = ""
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        name = chr(65 + rest) + name
    return name


def _cell(ref: str, value: Any, style: str) -> str:
    if value is None:
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"{style}><v>{value}</v></c>'
    text = escape(_NOT_IN_XML.sub("", str(value)))
    return f'<c r="{ref}"{style} t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'


def workbook(sheet: str, headers: Sequence[str], rows: Iterable[Sequence[Any]]) -> bytes:
    """The bytes of a workbook with one sheet: `headers`, then `rows` (a number stays a number, None an empty cell, anything else text)."""
    rows = list(rows)
    widths = [len(str(h)) for h in headers]
    for row in rows:
        for i, value in enumerate(row):
            if value is not None:
                widths[i] = max(widths[i], len(str(value)))
    cols = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{min(_MAX_WIDTH, max(_MIN_WIDTH, w + 2))}" customWidth="1"/>' for i, w in enumerate(widths))
    lines = [f'<row r="1">{"".join(_cell(f"{_column(i)}1", h, " s=\"1\"") for i, h in enumerate(headers))}</row>']
    for n, row in enumerate(rows, 2):
        lines.append(f'<row r="{n}">{"".join(_cell(f"{_column(i)}{n}", v, "") for i, v in enumerate(row))}</row>')
    worksheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                 '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
                 f'<cols>{cols}</cols><sheetData>{"".join(lines)}</sheetData></worksheet>')
    name = escape(_NOT_IN_SHEET_NAME.sub(" ", sheet)[:31], {'"': "&quot;"})
    book = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets><sheet name="{name}" sheetId="1" r:id="rId1"/></sheets></workbook>')
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _CONTENT_TYPES)
        z.writestr("_rels/.rels", _ROOT_RELS)
        z.writestr("xl/workbook.xml", book)
        z.writestr("xl/_rels/workbook.xml.rels", _WORKBOOK_RELS)
        z.writestr("xl/styles.xml", _STYLES)
        z.writestr("xl/worksheets/sheet1.xml", worksheet)
    return out.getvalue()


def attachment(body: bytes, filename: str, *, ascii_name: str | None = None, truncated: bool = False) -> Response:
    """The file as an answer. `ascii_name` is the plain name for a `filename` that is not ASCII."""
    plain = ascii_name or filename
    headers = {"Content-Disposition": f"attachment; filename=\"{plain}\"; filename*=UTF-8''{quote(filename)}", "Cache-Control": "no-store"}
    if truncated:
        headers["X-Export-Truncated"] = "true"
    return Response(body, media_type=MEDIA, headers=headers)
