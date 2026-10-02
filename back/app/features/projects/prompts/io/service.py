"""projects.prompts.io 업무 규칙(현행 prompt/_actions.ts exportPromptsXlsx·importPromptsXlsx, lib/prompts/excel.ts 이식).

형식(2026-07-31 개정): 예약 열 id·text 둘, 그 밖 헤더 = 커스텀 태그 이름. id·text 헤더는 공백·_·- 무시·대소문자 무시로 맞추고,
태그 헤더는 원문(trim) 그대로 태그 이름. 중복 태그 헤더는 첫 열만(경고).
가져오기 규칙: id 있으면 수정(없는 id 는 건너뜀), 없으면 신규(본문 필수, 기존·파일 내 같은 본문은 건너뜀). 본문 변경은 draft 만.
태그 열 있음 + 빈 셀 = 값 비움, 열 없음 = 손대지 않음. 없는 태그 헤더는 자동 생성(예약어는 건너뜀).
한 트랜잭션(api_rw)에서 배치 문장으로 쓴다. app.prompt INSERT·UPDATE 는 트리거가 감사한다(Q3).
"""
from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all, fetch_one
from app.core.filters import single_line
from app.core.xlsx import SheetSpec, Warnings, clip, write_workbook
from app.features.projects.prompts.crud.schemas import CTRL_IN_BODY, MAX_TEXT
from app.features.projects.prompts.fields.schemas import MAX_LABEL, MAX_VALUE
from app.features.projects.prompts.fields.service import is_reserved

from . import queries as q
from .schemas import MAX_ROWS, MAX_WARNINGS, ImportSummary
from .xlsx import MAX_WARNING_BYTES, XlsxError, read_sheet

_HDR = re.compile(r"[\s_-]+")
EXPORT_SHEET = "prompts"


def _norm_header(s: str) -> str:
    return _HDR.sub("", s.lower())


def _bad_line(s: str) -> bool:
    """한 줄 값 규칙 위반(C0 제어 문자·DEL·서로게이트): core.filters.PgLine 과 같은 규칙(single_line)."""
    try:
        single_line(s)
    except ValueError:
        return True
    return False


# ── 내보내기 ──
async def export_xlsx(conn: AsyncConnection, project_id: uuid.UUID) -> tuple[bytes, str, int]:
    prompts = await fetch_all(conn, q.EXPORT_PROMPTS_SQL, {"pid": project_id})
    tags = [f for f in await fetch_all(conn, q.FIELDS_SQL, {"pid": project_id}) if not f["archived"]]
    vals: dict[str, dict[str, str]] = {}
    for v in await fetch_all(conn, q.VALUES_SQL, {"pid": project_id}):
        vals.setdefault(str(v["prompt_id"]), {})[str(v["field_id"])] = v["value"]
    headers = ["id", "text", *[t["label"] for t in tags]]
    rows = [[str(p["prompt_id"]), p["text"], *[vals.get(str(p["prompt_id"]), {}).get(str(t["field_id"]), "") for t in tags]]
            for p in prompts]
    data = write_workbook([SheetSpec(EXPORT_SHEET, headers, rows, widths=[38, 60, *[18] * len(tags)])])
    stamp = datetime.now(UTC).strftime("%Y%m%d")
    return data, f"prompts-{str(project_id)[:8]}-{stamp}.xlsx", len(rows)


# ── 파싱(순수) ──
def new_warnings() -> Warnings:
    """가져오기 경고 모음: 건수 MAX_WARNINGS·총 64KB 상한(넘치면 끝에 요약 1줄). 원문은 clip 해서 넣는다(검증 D3-R)."""
    return Warnings(MAX_WARNINGS, MAX_WARNING_BYTES)


def parse_rows(data: bytes) -> tuple[list[dict[str, Any]], list[str], Warnings]:
    """(행[{row, id, text, tags{label: value|None}}], 태그 헤더, 경고). 파일 자체 오류는 422(XlsxError 코드 그대로)."""
    try:
        sheet, parse_warnings = read_sheet(data, max_rows=MAX_ROWS)
    except XlsxError as e:
        raise errors.unprocessable(str(e), code=e.code, details=e.details()) from e
    if not sheet:
        raise errors.unprocessable("시트가 비어 있다", code="empty_sheet")
    warnings = new_warnings()
    warnings.extend(parse_warnings)
    id_col = text_col = None
    tag_cols: dict[int, str] = {}
    seen: set[str] = set()
    for i, raw in enumerate(sheet[0][1]):
        if not raw:
            continue
        n = _norm_header(raw)
        if n == "id" and id_col is None:
            id_col = i
        elif n == "text" and text_col is None:
            text_col = i
        elif n in seen or n in ("id", "text"):
            warnings.add(f"헤더 '{clip(raw)}'가 중복되어 첫 번째 열만 사용합니다")
        elif len(raw) > MAX_LABEL or _bad_line(raw):       # fields API 와 같은 태그 이름 규칙(검증 D5)
            warnings.add(f"헤더 '{clip(raw)}'는 태그 이름 규칙(최대 {MAX_LABEL}자·제어 문자 금지)에 맞지 않아 건너뜁니다")
        else:
            seen.add(n)
            tag_cols[i] = raw
    if id_col is None and text_col is None:
        raise errors.unprocessable("헤더에 'id' 또는 'text' 열이 없다", code="missing_header")
    rows = []
    for rn, vals in sheet[1:]:
        def cell(i: int | None, vals: list[str] = vals) -> str:
            return vals[i] if i is not None and i < len(vals) else ""
        tags = {label: (cell(i) or None) for i, label in tag_cols.items()}
        rid, txt = cell(id_col) or None, cell(text_col) or None
        if not rid and not txt and not any(tags.values()):
            continue
        rows.append({"row": rn, "id": rid, "text": txt, "tags": tags})
    return rows, list(tag_cols.values()), warnings


# ── 가져오기(쓰기) ──
async def import_rows(rw: AsyncConnection, project_id: uuid.UUID, rows: list[dict[str, Any]], tag_headers: list[str],
                      warnings: Warnings) -> ImportSummary:
    existing = {str(r["prompt_id"]): r for r in await fetch_all(rw, q.EXISTING_SQL, {"pid": project_id})}
    fields = await fetch_all(rw, q.FIELDS_SQL, {"pid": project_id})
    cur_vals: dict[str, dict[str, str]] = {}
    for v in await fetch_all(rw, q.VALUES_SQL, {"pid": project_id}):
        cur_vals.setdefault(str(v["prompt_id"]), {})[str(v["field_id"])] = v["value"]

    # 헤더 ↔ 태그 매칭은 fields API 의 중복 기준(대소문자 무시, 보관 포함)과 같다(검증 D5: 보관된 'color' 가 있으면
    # 헤더 'Color' 는 새 태그를 만들지 않고 그 태그를 쓴다). 같은 이름이 둘이면 보관 안 된 쪽, 먼저 만든 쪽.
    by_label: dict[str, str] = {}
    for f in sorted(fields, key=lambda f: bool(f["archived"])):
        by_label.setdefault(f["label"].lower(), str(f["field_id"]))
    label_field: dict[str, str] = {}
    created_tags = 0
    for header in tag_headers:
        if is_reserved(header):
            warnings.add(f"'{clip(header)}' 은(는) 고정 분류축 이름이라 태그로 쓸 수 없어 건너뜁니다")
            continue
        fid = by_label.get(header.lower())
        if fid is None:
            r = await fetch_one(rw, q.INSERT_FIELD_SQL, {"pid": project_id, "label": header})
            if r is not None:
                created_tags += 1
                fid = str(r["field_id"])
            else:                      # (project_id, label) UNIQUE 충돌(보관된 같은 이름 등) → 재조회
                r = await fetch_one(rw, q.FIELD_BY_LABEL_SQL, {"pid": project_id, "label": header})
                fid = str(r["field_id"]) if r else None
            if fid:
                by_label[header.lower()] = fid
        if fid:
            label_field[header] = fid

    created = updated = skipped = 0
    upd_ids: list[str] = []
    upd_texts: list[str] = []
    ups: list[tuple[str, str, str]] = []
    clears: list[tuple[str, str]] = []
    new_rows: list[tuple[str, list[tuple[str, str]]]] = []
    existing_texts = {r["text"].strip() for r in existing.values()}
    seen_new: set[str] = set()

    for row in rows:
        ops: list[tuple[str, str | None]] = []
        for lb, val in row["tags"].items():
            if lb not in label_field:
                continue
            if val is not None and (len(val) > MAX_VALUE or _bad_line(val)):   # fields API 값 규칙(검증 D5)
                warnings.add(f"행 {row['row']}: 태그 '{clip(lb)}' 값이 규칙(최대 {MAX_VALUE}자·제어 문자 금지)에 맞지 않아 건너뜀")
                continue
            ops.append((label_field[lb], val))
        txt = row["text"]
        if txt is not None and len(txt) > MAX_TEXT:
            skipped += 1
            warnings.add(f"행 {row['row']}: 본문이 {MAX_TEXT}자를 넘어 건너뜀")
            continue
        if txt is not None and CTRL_IN_BODY.search(txt):
            skipped += 1
            warnings.add(f"행 {row['row']}: 본문에 제어 문자가 있어 건너뜀")
            continue
        if row["id"]:
            cur = existing.get(_uuid_or_none(row["id"]) or "")
            if cur is None:
                skipped += 1
                warnings.add(f"행 {row['row']}: id를 이 프로젝트에서 찾을 수 없어 건너뜀(신규 등록은 id 칸을 비워두세요)")
                continue
            pid = str(cur["prompt_id"])
            changed = False
            if txt is not None and txt != cur["text"]:
                if cur["status"] == "draft":
                    upd_ids.append(pid)
                    upd_texts.append(txt)
                    changed = True
                else:
                    warnings.add(f"행 {row['row']}: 초안이 아니어서 본문은 변경하지 않음 (태그만 반영)")
            have = cur_vals.get(pid, {})
            for fid, val in ops:
                if val is None:
                    if fid in have:
                        clears.append((pid, fid))
                        changed = True
                elif have.get(fid) != val:
                    ups.append((pid, fid, val))
                    changed = True
            if changed:
                updated += 1
            else:
                skipped += 1
        else:
            if not txt:
                skipped += 1
                warnings.add(f"행 {row['row']}: id·본문이 없어 건너뜀")
                continue
            key = txt.strip()
            if key in existing_texts:
                skipped += 1
                warnings.add(f"행 {row['row']}: 이미 있는 본문이라 건너뜀")
                continue
            if key in seen_new:
                skipped += 1
                warnings.add(f"행 {row['row']}: 파일 내 중복 본문이라 건너뜀")
                continue
            seen_new.add(key)
            new_rows.append((txt, [(fid, val) for fid, val in ops if val is not None]))
            created += 1

    if upd_ids:
        await rw.execute(text(q.UPDATE_TEXTS_SQL), {"pid": project_id, "ids": upd_ids, "texts": upd_texts})
    if new_rows:
        ins = await fetch_all(rw, q.INSERT_PROMPTS_SQL, {"pid": project_id, "texts": [t for t, _ in new_rows]})
        id_of = {r["text"]: str(r["prompt_id"]) for r in ins}
        for t, ops in new_rows:
            ups += [(id_of[t], fid, val) for fid, val in ops]
    if clears:
        await rw.execute(text(q.CLEAR_VALUES_SQL), {"pid": project_id, "ps": [c[0] for c in clears], "fs": [c[1] for c in clears]})
    if ups:
        await rw.execute(text(q.UPSERT_VALUES_SQL), {"pid": project_id, "ps": [u[0] for u in ups], "fs": [u[1] for u in ups],
                                                     "vs": [u[2] for u in ups]})
    return ImportSummary(created=created, updated=updated, skipped=skipped, created_tags=created_tags, warnings=warnings.to_list())


def _uuid_or_none(s: str) -> str | None:
    try:
        return str(uuid.UUID(s))
    except ValueError:
        return None
