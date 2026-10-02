"""admin.catalog.bulk 업무 규칙: 시장 일괄 설정, xlsx 가져오기 프리뷰·적용, 내보내기.

- 쓰기는 admin.catalog.prompts.service.apply_patch 하나를 행마다 부른다(상태 가드·diff·트리거 감사·outbox 규칙 동일).
  공통 batch_id 는 트랜잭션 로컬 GUC app.batch_id 로 심어 트리거가 prompt_audit_log.batch_id 에 싣는다.
- 부분 성공(행 단위 SAVEPOINT, core.write.savepoint): 행마다 세이브포인트 안에서 쓴다. 한 행의 DB 오류(사전 검증 뒤 사라진 FK 대상,
  CHECK·형식 위반 등)는 그 행만 되돌리고 failed 로 돌려준다(코드 = core.errors.from_db_error, 해당 없으면 db_error). 나머지 행은 반영된다.
  DB 제약에 걸릴 값(brand_code FK·brand_presence CHECK·lang·regions 형식)은 여전히 쓰기 전에 검증해 기능 코드(unknown_brand 등)로 준다.
  DB 오류가 아닌 예기치 않은 예외(코드 결함)는 요청 전체를 롤백한다(500).
- xlsx 계약(현행 lib/standards/excel.ts): 열 = id·text·brand·brand_presence·list_type·depth1~4·funnel_stage·category·prompt_type·
  regions·lang·kind. kind 는 내보내기 전용(가져오기 무시). 열이 없으면 불변, 빈 셀이면 비우기(text 는 비우기 불허 → 경고 후 불변).
  id 없는 행은 경고 후 건너뜀(신규는 단건 생성 경로).
"""
from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from typing import Any

import anyio.to_thread
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all
from app.core.filters import single_line
from app.core.write import savepoint
from app.core.xlsx import SheetSpec, Warnings, clip
from app.features.admin.catalog.bulk import queries as q
from app.features.admin.catalog.bulk import xlsx
from app.features.admin.catalog.bulk.schemas import (
    ApplyResult,
    BulkItem,
    BulkRegionsResult,
    PreviewData,
    PreviewItem,
    RowFailure,
)
from app.features.admin.catalog.prompts import service as ps
from app.features.admin.catalog.prompts.schemas import LABEL_FIELDS, TEXT_MAX

SHEET = "catalog"
COLUMNS = ("id", "text", "brand", "brand_presence", "list_type", "depth1", "depth2", "depth3", "depth4", "funnel_stage",
           "category", "prompt_type", "regions", "lang", "kind")
_HEADER_LABEL = {"brand": "brand_code", "brandcode": "brand_code", "brandpresence": "brand_presence", "listtype": "list_type",
                 "depth1": "depth1", "depth2": "depth2", "depth3": "depth3", "depth4": "depth4", "funnelstage": "funnel_stage",
                 "category": "category", "prompttype": "prompt_type"}
_REGION_CELL = re.compile(r"^(?:[A-Za-z]{2}|[xX]:[A-Za-z0-9]{2,8})$")
MAX_UPLOAD = xlsx.MAX_UPLOAD                 # 업로드 상한 5MB(core 상한 10MiB 보다 좁게: core.upload.read_upload_request max_bytes)


def _header(s: str) -> str:
    return re.sub(r"[\s_-]+", "", s.lower())


def _one_line(v: str) -> bool:
    try:
        single_line(v)
    except ValueError:
        return False
    return True


# ════════════════════════════════════════════════════════════════════════════
# 행 단위 적용(bulk/regions·bulk/apply 공용)
# ════════════════════════════════════════════════════════════════════════════
def item_patch(item: BulkItem, brands: Mapping[str, bool], vocab: list[str] | None) -> dict[str, Any]:
    """BulkItem → UPDATE patch(준 필드만). 형식·FK 위반은 ApiError(422)로 그 행만 실패시킨다."""
    patch: dict[str, Any] = {}
    if "text" in item.model_fields_set:
        patch["text"] = ps.text_or_422(item.text or "")
    lf = [f for f in LABEL_FIELDS if f in item.labels.model_fields_set]
    if lf:
        labels = ps.clean_labels(item.labels.model_dump(), lf)
        ps.labels_or_422(labels, brands)
        patch.update(labels)
    if "regions" in item.model_fields_set:
        patch["regions"] = ps.regions_or_422(item.regions, vocab)
    if "lang" in item.model_fields_set:
        patch["lang"] = ps.lang_or_422(item.lang)
    return patch


def _fail(pid: Any, e: errors.ApiError) -> RowFailure:
    return RowFailure(prompt_id=str(pid), code=e.code, message=e.message)


def _db_fail(pid: Any, e: DBAPIError) -> RowFailure:
    """세이브포인트까지 되돌린 행의 DB 오류 → 행 실패. 코드는 core 전역 처리기와 같은 매핑(값·쿼리 원문은 싣지 않는다)."""
    mapped = errors.from_db_error(e, write=True)
    if mapped is None:
        return RowFailure(prompt_id=str(pid), code="db_error", message="DB 오류: 이 행만 되돌렸다")
    return _fail(pid, mapped)


async def bulk_regions(rw: AsyncConnection, *, root: uuid.UUID, ids: list[uuid.UUID], regions: list[str] | None,
                       vocab: list[str] | None) -> BulkRegionsResult:
    value = ps.regions_or_422(regions, vocab)            # 모든 행에 같은 값이라 형식·어휘 오류는 요청 전체 422
    batch = uuid.uuid4()
    updated = unchanged = 0
    failed: list[RowFailure] = []
    outboxes: list[int] = []
    for pid in dict.fromkeys(ids):
        try:
            async with savepoint(rw):
                _, _, changes, ob = await ps.apply_patch(rw, root=root, prompt_id=pid, patch={"regions": value}, batch_id=batch)
        except errors.ApiError as e:
            failed.append(_fail(pid, e))
            continue
        except DBAPIError as e:
            failed.append(_db_fail(pid, e))
            continue
        if changes:
            updated += 1
        else:
            unchanged += 1
        if ob is not None and ob not in outboxes:
            outboxes.append(ob)
    return BulkRegionsResult(batch_id=batch, updated=updated, unchanged=unchanged, failed=failed, outbox_ids=outboxes,
                             propagation="pending" if outboxes else "none")


async def apply_items(rw: AsyncConnection, *, root: uuid.UUID, batch_id: uuid.UUID, items: list[BulkItem],
                      brands: Mapping[str, bool], vocab: list[str] | None) -> ApplyResult:
    applied = unchanged = 0
    failed: list[RowFailure] = []
    change_ids: list[int] = []
    outboxes: list[int] = []
    for item in items:
        try:
            patch = item_patch(item, brands, vocab)
            async with savepoint(rw):
                _, _, changes, ob = await ps.apply_patch(rw, root=root, prompt_id=item.prompt_id, patch=patch, batch_id=batch_id)
        except errors.ApiError as e:
            failed.append(_fail(item.prompt_id, e))
            continue
        except DBAPIError as e:
            failed.append(_db_fail(item.prompt_id, e))
            continue
        if not changes:
            unchanged += 1
            continue
        applied += 1
        for cid in await ps.tx_change_ids(rw, item.prompt_id):
            if cid not in change_ids:
                change_ids.append(cid)
        if ob is not None and ob not in outboxes:
            outboxes.append(ob)
    pending = bool(change_ids or outboxes)
    return ApplyResult(batch_id=batch_id, applied=applied, unchanged=unchanged, failed=failed, change_ids=change_ids,
                       outbox_ids=outboxes, change_id=change_ids[0] if change_ids else None,
                       propagation="pending" if pending else "none")


# ════════════════════════════════════════════════════════════════════════════
# xlsx 내보내기·가져오기 프리뷰
# ════════════════════════════════════════════════════════════════════════════
def _cell(v: Any) -> str:
    return "" if v is None else str(v)


WIDTHS = [38 if c == "id" else 80 if c == "text" else 16 for c in COLUMNS]


async def export_sheet(ro: AsyncConnection) -> tuple[SheetSpec, int]:
    """내보내기 시트(core.xlsx 작성기: 첫 행 굵게·틀 고정·열 너비). 셀은 전부 문자열(인라인 문자열, 수식 없음)."""
    root = await ps.root_project_id(ro)
    rows = await fetch_all(ro, q.LIVE_ROWS_SQL, {"root": root})
    out = []
    for r in rows:
        out.append([str(r["prompt_id"]), r["text"], _cell(r["brand_code"]), _cell(r["brand_presence"]), _cell(r["list_type"]),
                    _cell(r["depth1"]), _cell(r["depth2"]), _cell(r["depth3"]), _cell(r["depth4"]), _cell(r["funnel_stage"]),
                    _cell(r["category"]), _cell(r["prompt_type"]),
                    ",".join(sorted(r["regions"])) if r["regions"] else "",      # 정렬 CSV: 왕복이 가짜 변경을 만들지 않는다
                    _cell(r["lang"]), r["kind"]])
    return SheetSpec(SHEET, list(COLUMNS), out, WIDTHS), len(out)


def new_warnings() -> Warnings:
    """프리뷰 경고 모음: 건수·총 바이트 상한(넘치면 끝에 요약 1줄). 원문은 clip 해서 넣는다(검증 D2-R 과 같은 증폭 계열)."""
    return Warnings(xlsx.MAX_WARNINGS, xlsx.MAX_WARNING_BYTES)


def parse_workbook(data: bytes) -> tuple[list[dict[str, Any]], Warnings]:
    """xlsx → 행 목록({id, text?, labels{…}, regions?, lang?}) + 경고. 형식만 본다(어휘·FK 는 preview 가 본다).
    읽을 수 없는·예산을 넘는 파일은 현행(excel.ts '파일을 읽을 수 없습니다')처럼 200 + 경고로 돌려준다(422 아님, README)."""
    warnings = new_warnings()
    try:
        grid, parse_warnings = xlsx.read_sheet(data)
    except ValueError as e:                     # XlsxError(ValueError 하위) + 파서가 놓친 변환 오류까지: 500 대신 경고
        warnings.add(f"파일을 읽을 수 없습니다: {e}")
        return [], warnings
    warnings.extend(parse_warnings)
    if not grid or not any(grid[0]):
        warnings.add("시트가 비어 있습니다")
        return [], warnings
    cols: dict[str, int] = {}
    labels: dict[int, str] = {}
    for i, h in enumerate(grid[0]):
        n = _header(h)
        if n in ("id", "text", "regions", "lang"):
            cols.setdefault(n, i)
        elif n in _HEADER_LABEL:
            labels.setdefault(i, _HEADER_LABEL[n])
    if "id" not in cols:
        warnings.add("헤더에 'id' 열이 없습니다: 벌크는 기존 행 수정 전용입니다")
        return [], warnings

    def get(row: list[str], i: int | None) -> str:
        return row[i].strip() if i is not None and i < len(row) else ""

    rows: list[dict[str, Any]] = []
    for rn, row in enumerate(grid[1:], start=2):
        pid = get(row, cols["id"])
        rec: dict[str, Any] = {"id": pid, "labels": {}}
        any_value = False
        for i, field in labels.items():
            v = get(row, i)
            rec["labels"][field] = v or None
            any_value = any_value or bool(v)
        if "text" in cols:
            t = get(row, cols["text"])
            if t:
                rec["text"] = t
                any_value = True
            elif pid:
                warnings.add(f"행 {rn}: text 셀이 비어 있어 본문은 건드리지 않습니다(본문 비우기는 불허)")
        if "regions" in cols:
            raw = get(row, cols["regions"])
            if not raw:
                rec["regions"] = None
            else:
                any_value = True
                parts = [x.strip() for x in re.split(r"[,;|]", raw) if x.strip()]
                bad = [x for x in parts if not _REGION_CELL.match(x)]
                if bad:
                    warnings.add(f"행 {rn}: 시장 코드 형식이 아닙니다({clip(', '.join(bad))}): 이 행의 시장은 변경하지 않습니다")
                else:
                    rec["regions"] = [ps.normalize_market(x) for x in parts]
        if "lang" in cols:
            raw = get(row, cols["lang"])
            if not raw:
                rec["lang"] = None
            else:
                any_value = True
                if re.fullmatch(r"[A-Za-z]{2}", raw):
                    rec["lang"] = raw.upper()
                else:
                    warnings.add(f"행 {rn}: 언어 코드 형식이 아닙니다({clip(raw)}): 이 행의 언어는 변경하지 않습니다")
        if not pid:
            if any_value:
                warnings.add(f"행 {rn}: id 가 없어 건너뜁니다(신규 추가는 단건 생성 경로 사용)")
            continue
        rows.append(rec)
    return rows, warnings


async def preview(ro: AsyncConnection, data: bytes) -> PreviewData:
    # 압축 해제·XML 파싱은 CPU 작업이라 이벤트 루프 밖(작업 스레드)에서 돈다: 큰 파일이 공유 API 프로세스를 멈추지 않게(D2).
    parsed, warnings = await anyio.to_thread.run_sync(parse_workbook, data)
    root = await ps.root_project_id(ro)
    current = {str(r["prompt_id"]): r for r in await fetch_all(ro, q.LIVE_ROWS_SQL, {"root": root})}
    _, vocab = await ps.root_dim(ro)
    brands = await ps.known_brands(ro)
    items: list[PreviewItem] = []
    unmatched: list[str] = []
    unchanged = 0
    for p in parsed:
        try:
            key = str(uuid.UUID(p["id"]))
        except ValueError:
            key = p["id"]
        cur = current.get(key)
        if cur is None:
            unmatched.append(clip(p["id"], 80))           # 파일 원문 id 를 되돌려 준다: 길이는 자른다(uuid 는 36자)
            continue
        item: dict[str, Any] = {"prompt_id": key}
        if "text" in p:
            if len(p["text"]) > TEXT_MAX:
                warnings.add(f"{key}: 본문이 {TEXT_MAX}자를 넘어 본문 변경을 건너뜁니다")
            else:
                item["text"] = p["text"]
        lab = {}
        for f, v in p["labels"].items():
            if v is not None and not _one_line(v):
                # 라벨은 한 줄(bulk/apply 스키마 PgLine). 기존 값 그대로면 변경이 없으니 조용히 빼고, 새 값이면 경고 후 뺀다
                if v != cur.get(f):
                    warnings.add(f"{key}: {f} 값에 줄바꿈·제어 문자가 있어 이 라벨 변경을 건너뜁니다")
                continue
            bad = ps.label_errors({f: v}, brands) if v is not None else []
            if bad or (v is not None and len(v) > 200):
                warnings.add(f"{key}: {f} 값 '{clip(v)}' 을(를) 쓸 수 없어 이 라벨 변경을 건너뜁니다({clip(', '.join(bad)) or 'too_long'})")
                continue
            lab[f] = v
        if lab:
            item["labels"] = lab
        if "regions" in p:
            val, invalid, oov = ps.normalize_regions(p["regions"], vocab)
            if invalid or oov:
                why = " · ".join(x for x in (f"형식 아님({', '.join(invalid)})" if invalid else "",
                                              f"프로젝트 시장 밖({', '.join(oov)})" if oov else "") if x)
                warnings.add(f"{key}: 시장 변경을 건너뜁니다: {clip(why, 120)}")
            else:
                item["regions"] = val
        if "lang" in p:
            item["lang"] = p["lang"]
        after = {k: v for k, v in item.items() if k in ("text", "regions", "lang")} | item.get("labels", {})
        changes = ps.diff(cur, after)
        if not changes:
            unchanged += 1
            continue
        items.append(PreviewItem(prompt_id=key, current_text=cur["text"], changes=changes, item=item))
    return PreviewData(items=items, unmatched_ids=unmatched, unchanged=unchanged, warnings=warnings.to_list(), batch_id=uuid.uuid4())
