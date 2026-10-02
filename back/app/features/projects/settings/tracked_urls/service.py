"""projects.settings.tracked_urls 업무 규칙(PJ-4). 현행 추적 URL 액션(setting/_actions.ts:626~779) 이식.

- 조회·내보내기: 활성 멤버 또는 admin. 쓰기·가져오기: 활성 Owner 또는 admin.
- 추가·삭제·가져오기(변경이 있으면)는 같은 트랜잭션에서 judgment_change('project_target_url') 1건(Q5: M06·M07 재판정).
- 정규화: url = http(s) 정규 URL(core.urls.canonical_http_url), url_norm = core.urls.normalize_url_for_match(url)
  (타겟 인용 판정의 등치 비교 값, 적재 SQL cit_norm 과 한 벌).
- 가져오기 행 규칙(현행 계승, 행 식별자 id → url_norm): url_norm 이 있으면 그 행 수정(없으면 경고 후 건너뜀),
  없으면 url 로 추가(이미 있으면 경고 후 건너뜀). label 열이 없으면 label 을 바꾸지 않는다.
- xlsx: 읽기 = core.xlsx.XlsxReader(스트리밍, 이 기능의 예산 BUDGET), 쓰기 = core.xlsx SheetSpec(라우터가 core.export.xlsx_response).
  현행 lib/tracked-urls/excel.ts 계약 계승: 시트 1개, 1행 = 기계 헤더(url_norm·url·label), 헤더는 공백·대소문자·_- 무시 매칭,
  빈 행 건너뜀, label 열이 없으면 label 은 건드리지 않는다. 파일 오류는 422(core XlsxError.code 그대로: invalid_xlsx·file_too_large·
  too_many_rows 등). 업로드 크기 상한 초과는 core.upload 가 413 payload_too_large.
"""
from __future__ import annotations

import re
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection
from starlette.concurrency import run_in_threadpool

from app.core import errors
from app.core.auth import Principal
from app.core.db import fetch_all, fetch_one, fetch_val
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.urls import canonical_http_url, normalize_url_for_match
from app.core.write import enqueue_change
from app.core.xlsx import MiB, SheetSpec, XlsxBudget, XlsxError, XlsxReader
from app.features.projects.project.core.shared import JUDGMENT_DEDUPE, project_access
from app.features.projects.settings.tracked_urls import queries as Q

LIST_DEFAULT = 50
_SORT = "created_at"

# ── xlsx 계약·예산(기존 상한 유지: 업로드 5MB, 읽는 부분 파일 20MB, 데이터 행 5,000) ──
# 예전 '압축 해제 합계 50MB' 는 core 리더가 읽는 엔트리만 풀고(엔트리당 max_entry_bytes·압축비 상한) 나머지는 열지 않아 대응 값이 없다.
MAX_UPLOAD = 5 * MiB
MAX_PART_BYTES = 20 * MiB
MAX_ROWS = 5000
MAX_COLS = 64                   # 이 열 밖의 셀은 버린다(extra_columns='drop'): 기계 헤더 3열만 읽으므로 먼 열은 의미가 없다
SHEET_NAME = "tracked-urls"
COLUMNS = ("url_norm", "url", "label")
WIDTHS = (50, 60, 30)
BUDGET = XlsxBudget(max_upload_bytes=MAX_UPLOAD, max_entry_bytes=MAX_PART_BYTES, max_rows=MAX_ROWS * 2 + 1000,
                    max_cols=MAX_COLS, extra_columns="drop", strict_order=False,
                    max_shared_strings=(MAX_ROWS + 1) * MAX_COLS)
_HDR = re.compile(r"[\s_\-]+")


@dataclass
class ParsedRow:
    row_number: int                 # 시트 행 번호(헤더 1, 데이터 2부터)
    url_norm: str | None
    url: str | None
    label: str | None
    has_label: bool                 # label 열 존재 여부(없으면 label 을 건드리지 않는다)


def export_sheet(rows: Iterable[Mapping[str, Any]]) -> SheetSpec:
    """{url_norm, url, label} 행 → 내보내기 시트(헤더 = 기계 열 이름, 첫 행 고정)."""
    return SheetSpec(SHEET_NAME, list(COLUMNS), ([r.get(c) for c in COLUMNS] for r in rows), widths=list(WIDTHS))


def _norm_header(s: str) -> str:
    return _HDR.sub("", s.lower())


def parse_workbook(data: bytes) -> tuple[list[ParsedRow], list[str]]:
    """xlsx 바이트 → (행, 경고). 형식·예산 위반은 core XlsxError(파싱 중에 예산을 적용한다). CPU 작업이라 스레드 풀에서 부른다."""
    sheet = XlsxReader(BUDGET).read(data)
    warnings = list(sheet.warnings)
    if not sheet.rows:
        return [], [*warnings, "시트가 비어 있다"]
    lookup = {_norm_header(c): c for c in COLUMNS}
    header: dict[int, str] = {}
    for i, v in enumerate(sheet.rows[0].cells):
        key = lookup.get(_norm_header(v))
        if key:
            header[i] = key
    keys = set(header.values())
    if "url" not in keys and "url_norm" not in keys:
        return [], [*warnings, "헤더에 'url' 또는 'url_norm' 열이 없다"]
    has_label = "label" in keys
    out: list[ParsedRow] = []
    for r in sheet.rows[1:]:
        vals = {k: r.cells[i] for i, k in header.items() if i < len(r.cells)}
        if not any(vals.values()):
            continue
        if len(out) >= MAX_ROWS:
            raise XlsxError("too_many_rows", f"데이터 행은 {MAX_ROWS}개까지")
        out.append(ParsedRow(r.number, vals.get("url_norm") or None, vals.get("url") or None,
                             (vals.get("label") or None) if has_label else None, has_label))
    return out, warnings


def _validated(raw: str | None, field: str = "url") -> tuple[str, str]:
    url = canonical_http_url(raw, field=field)
    norm = normalize_url_for_match(url)
    if not norm:
        raise errors.unprocessable("URL 형식 오류", code="invalid_url", details={"field": field})
    return url, norm


async def _enqueue(rw: AsyncConnection, project_id: uuid.UUID, op: str, detail: dict[str, Any]) -> int:
    # 매 편집 1행(대기 행 합치기를 쓰지 않는 이유: shared.JUDGMENT_DEDUPE 주석)
    return await enqueue_change(rw, "project_target_url", subject_uuids=[project_id],
                                payload={"op": op, "project_id": str(project_id), **detail}, dedupe=JUDGMENT_DEDUPE)


async def list_urls(ro: AsyncConnection, p: Principal, project_id: uuid.UUID, cursor: str | None, limit: int | None
                    ) -> tuple[list[dict[str, Any]], str | None, int, int]:
    await project_access(ro, p, project_id, "active_member")
    lim = clamp_limit(limit, LIST_DEFAULT)
    fh = filter_hash({"project_id": str(project_id)})
    cur = decode_cursor(cursor, sort=_SORT, dir="desc", fh=fh, types=("timestamptz", "text"))
    b = Binder("k")
    ks = keyset_predicate(Q.SORT_COLS, "desc", cur, b)
    rows = await fetch_keyset(ro, Q.list_sql(ks), {"pid": project_id, "lim": lim + 1, **b.params})
    page, nxt = keyset_page(rows, lim, lambda r: (r["created_at"], r["url_norm"]), sort=_SORT, dir="desc", fh=fh)
    total = int(await fetch_val(ro, Q.COUNT, {"pid": project_id}) or 0)
    return page, nxt, lim, total


async def add(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, url: str, label: str | None
              ) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    u, norm = _validated(url)
    row = await fetch_one(rw, Q.INSERT, {"pid": project_id, "url": u, "norm": norm, "label": (label or "").strip() or None,
                                         "uid": p.user_id})
    if row is None:
        raise errors.conflict("duplicate_tracked_url", "이미 등록된 URL", {"url_norm": norm})
    cid = await _enqueue(rw, project_id, "add", {"url_norm": norm})
    return {"tracked_url": row, "url_norm": norm, "change_id": cid}


async def remove(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, url_norm: str) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    if await fetch_one(rw, Q.DELETE, {"pid": project_id, "norm": url_norm}) is None:
        raise errors.not_found("추적 URL 없음", code="tracked_url_not_found")
    cid = await _enqueue(rw, project_id, "remove", {"url_norm": url_norm})
    return {"tracked_url": None, "url_norm": url_norm, "change_id": cid}


async def export_rows(ro: AsyncConnection, p: Principal, project_id: uuid.UUID) -> list[dict[str, Any]]:
    await project_access(ro, p, project_id, "active_member")
    return await fetch_all(ro, Q.ALL, {"pid": project_id})


async def import_xlsx(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, data: bytes) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    try:
        rows, warnings = await run_in_threadpool(parse_workbook, data)      # 압축 해제·XML 파싱은 이벤트 루프 밖
    except XlsxError as e:
        raise errors.unprocessable(str(e), code=e.code, details=e.details()) from e
    if await fetch_one(rw, Q.LOCK_PROJECT, {"pid": project_id}) is None:
        raise errors.not_found("프로젝트 없음")
    created = updated = skipped = 0
    for r in rows:
        new: tuple[str, str] | None = None
        if r.url is not None:
            try:
                new = _validated(r.url)
            except errors.ApiError as e:
                skipped += 1
                warnings.append(f"행 {r.row_number}: {e.message}, 건너뜀")
                continue
        label = r.label.strip() or None if r.label is not None else None
        if r.url_norm:
            cur = await fetch_one(rw, Q.EXISTS, {"pid": project_id, "norm": r.url_norm})
            if cur is None:
                skipped += 1
                warnings.append(f"행 {r.row_number}: url_norm 을 이 프로젝트에서 찾을 수 없어 건너뜀(신규는 url_norm 칸을 비운다)")
                continue
            url, norm = new if new else (cur["url"], cur["url_norm"])
            lab = label if r.has_label else cur["label"]
            if (url, norm, lab) == (cur["url"], cur["url_norm"], cur["label"]):
                skipped += 1
                continue
            if await fetch_one(rw, Q.UPDATE, {"pid": project_id, "norm": r.url_norm, "new_norm": norm, "url": url, "label": lab}) is None:
                skipped += 1
                warnings.append(f"행 {r.row_number}: 이미 등록된 URL 이라 건너뜀")
                continue
            updated += 1
        else:
            if new is None:
                skipped += 1
                warnings.append(f"행 {r.row_number}: url_norm·url 이 없어 건너뜀")
                continue
            ins = await fetch_one(rw, Q.INSERT, {"pid": project_id, "url": new[0], "norm": new[1], "label": label, "uid": p.user_id})
            if ins is None:
                skipped += 1
                warnings.append(f"행 {r.row_number}: 이미 등록된 URL 이라 건너뜀")
                continue
            created += 1
    cid = await _enqueue(rw, project_id, "import", {"created": created, "updated": updated}) if created or updated else None
    return {"created": created, "updated": updated, "skipped": skipped, "warnings": warnings, "change_id": cid,
            "propagation": "pending" if cid else "none"}
