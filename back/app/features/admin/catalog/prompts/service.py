"""admin.catalog.prompts 업무 규칙(표준 루트 카탈로그 CRUD). admin.catalog.bulk·reference 도 이 모듈의 도우미를 쓴다.

쓰기 규칙(DECISIONS-API Q3, DB-v2.4 P04, core.write)
- app.prompt 만 쓴다(api_rw). 감사(prompt_audit_log)와 재판정 요청(judgment_change catalog·prompt_kind)은 DB 트리거
  tg_catalog_change 가 같은 트랜잭션에서 남긴다. 앱은 두 표에 직접 INSERT 하지 않는다(이중 기록 금지).
- Scope 반영은 app.scope_outbox(aggregate='prompt')로만 한다(요청 경로에서 Scope API 호출 금지). payload 는 Scope 에 보일
  필드의 "현재 전체 상태"라서 같은 (prompt, op) 미완료 행이 최신 payload 로 덮여도(enqueue_scope 병합) 잃는 값이 없다.
  · 생성 = op 'create'. 연결된 행(scope_prompt_id 있음)의 변경 = op 'update'.
  · 미연결 행은 대기 중 'create' 가 있으면 그 payload 만 갱신하고, 없으면 outbox 를 쓰지 않는다(현행: 미추적 행은 로컬만 바꾼다).
  · Scope 에 보이는 필드 = text·kind·regions·keywords(prompt_type·category·brand 인코딩)·enabled(삭제 여부).
    lang·funnel_stage·brand_presence·list_type·depth* 는 로컬 전용(현행 _actions.ts 규약)이다.
- 시장 어휘 = rd.dim_project.regions(표준 루트, api_ro 로 먼저 읽는다). 어휘가 없으면 형식만 검사한다(현행 동일).
- 상태 가드: 삭제는 deleted_at IS NULL, 복원은 IS NOT NULL, 그 밖의 수정은 IS NULL. 어긋나면 409 state_mismatch.
"""
from __future__ import annotations

import re
import uuid
from collections.abc import Iterable, Mapping
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all, fetch_one
from app.core.envelope import Page
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.write import enqueue_scope
from app.features.admin.catalog.prompts import queries as q
from app.features.admin.catalog.prompts.admin_common import brand_codes, clean_text, like_pattern
from app.features.admin.catalog.prompts.schemas import (
    LABEL_FIELDS,
    LABEL_MAX,
    TEXT_MAX,
    CatalogListData,
    CatalogPrompt,
    CatalogPromptDetail,
    CatalogStats,
    PendingChange,
    PendingOutbox,
)

REGION_CODE = re.compile(r"^(?:[A-Z]{2}|x:[A-Z0-9]{2,8})$")   # lib/standards/prompt-regions.ts REGION_CODE
LANG_CODE = re.compile(r"^[A-Z]{2}$")
SCOPE_VISIBLE = frozenset({"text", "kind", "regions", "prompt_type", "category", "brand_code", "deleted_at"})
KEYWORD_FIELDS = (("prompt_type", "hmg:type:"), ("category", "hmg:category:"), ("brand_code", "hmg:brand:"))


# ════════════════════════════════════════════════════════════════════════════
# 표준 루트·어휘
# ════════════════════════════════════════════════════════════════════════════
async def root_project_id(conn: AsyncConnection) -> uuid.UUID:
    r = await fetch_one(conn, q.ROOT_PROJECT_SQL)
    if r is None:
        raise errors.unavailable("표준 루트 프로젝트 없음", code="no_standard_root")
    return uuid.UUID(str(r["project_id"]))


async def root_dim(ro: AsyncConnection) -> tuple[int | None, list[str] | None]:
    """(루트 project_key, 시장 어휘). 적재 전이면 (None, None). 어휘가 비면 None(= 상한 없음)."""
    r = await fetch_one(ro, q.ROOT_DIM_SQL)
    if r is None:
        return None, None
    vocab = sorted({c for c in (normalize_market(x) for x in (r["regions"] or [])) if c})
    return int(r["project_key"]), (vocab or None)


def normalize_market(raw: Any) -> str | None:
    """표시·비교용 표준형(lib/standards/prompt-markets.ts normalizeMarket): 실국가 대문자, 의사코드 x: + 대문자."""
    s = str(raw or "").strip()
    if not s:
        return None
    return "x:" + s[2:].upper() if s.lower().startswith("x:") else s.upper()


def normalize_regions(values: Iterable[Any] | None, vocab: list[str] | None) -> tuple[list[str] | None, list[str], list[str]]:
    """(저장값, 형식 오류, 어휘 밖). lib/standards/prompt-regions.ts normalizePromptRegions 이식.
    트림·대문자·중복 제거·정렬, 결과가 비면 None(미지정 = 상속). 어휘가 없으면 형식만 본다."""
    if values is None:
        return None, [], []
    allowed = set(vocab) if vocab else None
    invalid: list[str] = []
    oov: list[str] = []
    seen: set[str] = set()
    for raw in values:
        code = normalize_market(raw)
        if code is None:
            continue
        if not REGION_CODE.match(code):
            if code not in invalid:
                invalid.append(code)
            continue
        if allowed is not None and code not in allowed:
            if code not in oov:
                oov.append(code)
            continue
        seen.add(code)
    out = sorted(seen)
    return (out or None), invalid, oov


def normalize_lang(v: Any) -> tuple[str | None, str | None]:
    """(저장값, 형식 오류값). 빈 값 = None(미지정)."""
    if v is None:
        return None, None
    s = str(v).strip().upper()
    if not s:
        return None, None
    return (s, None) if LANG_CODE.match(s) else (None, s)


def regions_key(v: Iterable[str] | None) -> str | None:
    """감사·비교용 정렬 CSV(regionsForAudit). None·빈 배열 = None."""
    if not v:
        return None
    return ",".join(sorted(v))


def regions_or_422(values: list[str] | None, vocab: list[str] | None) -> list[str] | None:
    val, invalid, oov = normalize_regions(values, vocab)
    if invalid:
        raise errors.unprocessable("시장 코드 형식이 아니다", code="invalid_region", details={"field": "regions", "values": invalid})
    if oov:
        raise errors.unprocessable("표준 루트 프로젝트의 측정 시장이 아니다", code="region_out_of_vocabulary",
                                   details={"field": "regions", "values": oov})
    return val


def lang_or_422(v: str | None) -> str | None:
    val, bad = normalize_lang(v)
    if bad is not None:
        raise errors.unprocessable("언어 코드 형식이 아니다(ISO 639-1 두 글자)", code="invalid_lang", details={"field": "lang"})
    return val


# ════════════════════════════════════════════════════════════════════════════
# 라벨 검증
# ════════════════════════════════════════════════════════════════════════════
def clean_labels(raw: Mapping[str, Any], fields: Iterable[str]) -> dict[str, str | None]:
    """준 라벨 필드만 트림(빈 문자열 = null)."""
    return {f: clean_text(raw.get(f), field=f, max_len=LABEL_MAX) for f in fields}


def label_errors(labels: Mapping[str, str | None], brands: Mapping[str, bool]) -> list[str]:
    """쓰기 전 FK·CHECK 사전 검증(오류 코드 목록). brand_code ∈ app.brand, brand_presence ∈ {branded, unbranded},
    prompt_type ∈ 현행 4종. 빈 목록 = 통과."""
    bad = []
    b = labels.get("brand_code")
    if b is not None and b not in brands:
        bad.append("unknown_brand")
    pr = labels.get("brand_presence")
    if pr is not None and pr not in ("branded", "unbranded"):
        bad.append("invalid_brand_presence")
    pt = labels.get("prompt_type")
    if pt is not None and pt not in ("comparison", "recommendation", "information", "other"):
        bad.append("invalid_prompt_type")
    return bad


def labels_or_422(labels: Mapping[str, str | None], brands: Mapping[str, bool]) -> None:
    bad = label_errors(labels, brands)
    if bad:
        raise errors.unprocessable("라벨 값 오류", code=bad[0], details={"errors": bad})


# ════════════════════════════════════════════════════════════════════════════
# 응답 변환
# ════════════════════════════════════════════════════════════════════════════
def to_model(r: Mapping[str, Any]) -> CatalogPrompt:
    return CatalogPrompt(
        prompt_id=r["prompt_id"], text=r["text"], prompt_type=r["prompt_type"], category=r["category"], brand_code=r["brand_code"],
        brand_presence=r["brand_presence"], list_type=r["list_type"], depth1=r["depth1"], depth2=r["depth2"], depth3=r["depth3"],
        depth4=r["depth4"], funnel_stage=r["funnel_stage"], kind=r["kind"], lang=r["lang"],
        regions=list(r["regions"]) if r["regions"] is not None else None, scope_prompt_id=r["scope_prompt_id"],
        scope_text=r.get("scope_text"), tracked=r["scope_prompt_id"] is not None, status=r["status"],
        created_at=r["created_at"], updated_at=r["updated_at"], deleted_at=r["deleted_at"],
        outbox_pending=r.get("outbox_pending"), outbox_error=r.get("outbox_error"))


def diff(before: Mapping[str, Any], after: Mapping[str, Any]) -> dict[str, dict[str, str | None]]:
    """필드별 {old, new}(문자열화, 현행 computeChanges). regions 는 정렬 CSV 로 비교한다(순서만 다른 가짜 변경 방지)."""
    out: dict[str, dict[str, str | None]] = {}
    for f, new in after.items():
        old = before.get(f)
        if f == "regions":
            o, n = regions_key(old), regions_key(new)
        else:
            o = None if old is None else str(old)
            n = None if new is None else str(new)
        if o != n:
            out[f] = {"old": o, "new": n}
    return out


# ════════════════════════════════════════════════════════════════════════════
# 읽기
# ════════════════════════════════════════════════════════════════════════════
async def list_catalog(ro: AsyncConnection, *, q_text: str | None, kind: str | None, include_deleted: bool,
                       axes: Mapping[str, list[str]], cursor: str | None, limit: int | None) -> tuple[CatalogListData, Page]:
    root = await root_project_id(ro)
    rk, _ = await root_dim(ro)
    n = clamp_limit(limit, default=100)
    fh = filter_hash({"q": q_text, "kind": kind, "del": include_deleted, **{k: sorted(v) for k, v in axes.items() if v}})
    cur = decode_cursor(cursor, sort="catalog", dir="asc", fh=fh, types=q.SORT_TYPES)
    b = Binder()
    where = [f"p.project_id = {b.v(root)}"]
    if not include_deleted:
        where.append("p.deleted_at IS NULL")
    if q_text:
        where.append(f"p.text ILIKE {b.v(like_pattern(q_text))}")
    if kind:
        where.append(f"p.kind = {b.v(kind)}")
    col = {"brand": "p.brand_code", "funnel": "p.funnel_stage", "brand_presence": "p.brand_presence", "list_type": "p.list_type",
           "depth1": "p.depth1", "depth2": "p.depth2", "depth3": "p.depth3"}
    for axis, vals in axes.items():
        if vals:
            where.append(f"{col[axis]} = ANY({b.v(sorted(set(vals)), 'text[]')})")
    kp = keyset_predicate(list(q.SORT_EXPRS), "asc", cur, b)
    if kp:
        where.append(kp)
    sql = f"{q.LIST_SELECT}\n WHERE {' AND '.join(where)}\n ORDER BY {', '.join(q.SORT_EXPRS)}\n LIMIT {b.v(n + 1, 'int4')}"
    rows = await fetch_keyset(ro, sql, b.params)
    page, nxt = keyset_page(rows, n, lambda r: [r[f"k{i}"] for i in range(len(q.SORT_EXPRS))], sort="catalog", dir="asc", fh=fh)
    stats = await catalog_stats(ro, root, rk, include_deleted=include_deleted)
    return CatalogListData(items=[to_model(r) for r in page], stats=stats), Page(next_cursor=nxt, limit=n)


async def catalog_stats(ro: AsyncConnection, root: uuid.UUID, rk: int | None, *, include_deleted: bool) -> CatalogStats:
    """루트 카탈로그 전체 통계(STATS·SCOPE_ORPHANS 두 문장). rk = root_dim 의 루트 project_key(적재 전 None → orphans 0).
    목록(list_catalog)과 관리 카탈로그 화면 stats(catalog.prompts.catalog.screen)가 같이 쓴다."""
    st = await fetch_one(ro, q.STATS_SQL, {"root": root}) or {}
    orphans = 0
    if rk is not None:
        orphans = int((await fetch_one(ro, q.SCOPE_ORPHANS_SQL, {"rk": rk}) or {}).get("n") or 0)
    total, tracked = int(st.get("total") or 0), int(st.get("tracked") or 0)
    return CatalogStats(total=total, tracked=tracked, untracked=total - tracked, scope_orphans=orphans, acr=int(st.get("acr") or 0),
                        deleted=int(st.get("deleted") or 0) if include_deleted else 0)


async def detail(ro: AsyncConnection, prompt_id: uuid.UUID) -> CatalogPromptDetail:
    root = await root_project_id(ro)
    r = await fetch_one(ro, q.DETAIL_SQL, {"pid": prompt_id, "root": root})
    if r is None:
        raise errors.not_found("카탈로그 행 없음")
    ch = await fetch_all(ro, q.PENDING_CHANGES_SQL, {"pid": str(prompt_id)})
    ob = await fetch_all(ro, q.PENDING_OUTBOX_SQL, {"pid": prompt_id})
    return CatalogPromptDetail(prompt=to_model(r), pending_changes=[PendingChange(**c) for c in ch],
                               pending_outbox=[PendingOutbox(**o) for o in ob])


# ════════════════════════════════════════════════════════════════════════════
# 쓰기 도우미(api_rw)
# ════════════════════════════════════════════════════════════════════════════
async def lock_row(rw: AsyncConnection, root: uuid.UUID, prompt_id: uuid.UUID) -> dict[str, Any] | None:
    return await fetch_one(rw, q.LOCK_ROW_SQL, {"pid": prompt_id, "root": root})


async def update_row(rw: AsyncConnection, root: uuid.UUID, prompt_id: uuid.UUID, patch: Mapping[str, Any], *,
                     state: Literal["live", "deleted"] = "live", deleted_at: Literal["delete", "restore"] | None = None
                     ) -> dict[str, Any] | None:
    """상태 가드 UPDATE. 0행이면 None. patch 키는 queries.UPDATABLE 화이트리스트만."""
    b = Binder()
    sets = []
    for k, v in patch.items():
        if k not in q.UPDATABLE:
            raise ValueError(f"갱신 불가 열: {k}")
        sets.append(f"{k} = {b.v(v, 'text[]') if k == 'regions' else b.v(v)}")
    if deleted_at is not None:
        sets.append(f"deleted_at = {q.DELETED_AT_SET[deleted_at]}")
    sets += ["updated_by = app.actor()", "updated_at = now()"]
    guard = "p.deleted_at IS NULL" if state == "live" else "p.deleted_at IS NOT NULL"
    sql = (f"UPDATE app.prompt AS p SET {', '.join(sets)}\n WHERE p.prompt_id = {b.v(prompt_id)} AND p.project_id = {b.v(root)} "
           f"AND {guard}\nRETURNING {q.PROMPT_COLS}")
    return await fetch_one(rw, sql, b.params)


async def set_batch(rw: AsyncConnection, batch_id: uuid.UUID) -> None:
    """트랜잭션 로컬 app.batch_id(트리거가 prompt_audit_log.batch_id 에 싣는다)."""
    await fetch_one(rw, "SELECT set_config('app.batch_id', :b, true) AS v", {"b": str(batch_id)})


def scope_payload(row: Mapping[str, Any]) -> dict[str, Any]:
    """Scope 에 보일 필드의 현재 전체 상태(outbox payload). keywords = 현행 encodeStandardKeywords(hmg:type·category·brand)."""
    kws = [f"{prefix}{row[f]}" for f, prefix in KEYWORD_FIELDS if row.get(f)]
    return {"prompt_id": str(row["prompt_id"]), "scope_prompt_id": str(row["scope_prompt_id"]) if row.get("scope_prompt_id") else None,
            "project": "standard_root", "text": row["text"], "kind": row["kind"],
            "regions": list(row["regions"]) if row.get("regions") else None, "keywords": kws,
            "enabled": row.get("deleted_at") is None}


async def enqueue_prompt_outbox(rw: AsyncConnection, row: Mapping[str, Any], *, create: bool = False) -> int | None:
    pid = uuid.UUID(str(row["prompt_id"]))
    if create:
        return await enqueue_scope(rw, "prompt", pid, "create", scope_payload(row))
    if row.get("scope_prompt_id") is not None:
        return await enqueue_scope(rw, "prompt", pid, "update", scope_payload(row))
    if await fetch_one(rw, q.PENDING_CREATE_SQL, {"pid": pid}) is not None:
        return await enqueue_scope(rw, "prompt", pid, "create", scope_payload(row))
    return None


async def outbox_flags(conn: AsyncConnection, prompt_id: uuid.UUID) -> dict[str, Any]:
    """쓰기 응답 prompt 의 outbox_pending·outbox_error(검증 D4). 같은 트랜잭션이라 이번 쓰기의 outbox 행이 보인다."""
    r = await fetch_one(conn, q.OUTBOX_FLAGS_SQL, {"pid": prompt_id})
    return dict(r) if r is not None else {"outbox_pending": False, "outbox_error": None}


async def tx_change_ids(rw: AsyncConnection, prompt_id: uuid.UUID) -> list[int]:
    rs = await fetch_all(rw, q.TX_CHANGES_SQL, {"pid": str(prompt_id)})
    return [int(r["change_id"]) for r in rs]


async def create(rw: AsyncConnection, *, root: uuid.UUID, text: str, labels: Mapping[str, str | None], kind: str,
                 lang: str | None, regions: list[str] | None) -> tuple[dict[str, Any], int | None]:
    params = {"root": root, "text": text, "kind": kind, "lang": lang, "regions": regions,
              **{f: labels.get(f) for f in LABEL_FIELDS}}
    row = await fetch_one(rw, q.INSERT_SQL, params)
    assert row is not None
    return row, await enqueue_prompt_outbox(rw, row, create=True)


async def apply_patch(rw: AsyncConnection, *, root: uuid.UUID, prompt_id: uuid.UUID, patch: Mapping[str, Any],
                      deleted_at: Literal["delete", "restore"] | None = None, batch_id: uuid.UUID | None = None
                      ) -> tuple[dict[str, Any], dict[str, Any], dict[str, dict[str, str | None]], int | None]:
    """잠금 → 상태 확인 → diff → UPDATE → outbox. 반환 (새 행, 옛 행, 변경, outbox_id). 변경 없으면 새 행 = 옛 행, outbox None.
    없음 404, 상태 불일치 409 state_mismatch."""
    old = await lock_row(rw, root, prompt_id)
    if old is None:
        raise errors.not_found("카탈로그 행 없음")
    want_deleted = deleted_at == "restore"
    if (old["deleted_at"] is not None) != want_deleted:
        raise errors.conflict("state_mismatch", "삭제 상태가 요청과 맞지 않는다",
                              {"deleted": old["deleted_at"] is not None})
    changes = diff(old, patch)
    if deleted_at is not None:
        changes["deleted"] = {"old": str(deleted_at == "restore").lower(), "new": str(deleted_at == "delete").lower()}
    if not changes:
        return old, old, {}, None
    if batch_id is not None:
        await set_batch(rw, batch_id)
    real = {k: v for k, v in patch.items() if k in changes}
    new = await update_row(rw, root, prompt_id, real, state="deleted" if deleted_at == "restore" else "live", deleted_at=deleted_at)
    if new is None:                        # 잠금 뒤라 일어나지 않지만 가드는 둔다
        raise errors.conflict("state_mismatch", "상태가 바뀌었다")
    outbox = None
    if deleted_at is not None or SCOPE_VISIBLE & set(real):
        outbox = await enqueue_prompt_outbox(rw, new)
    return new, old, changes, outbox


async def known_brands(conn: AsyncConnection) -> dict[str, bool]:
    return await brand_codes(conn)


def text_or_422(v: str) -> str:
    return clean_text(v, field="text", max_len=TEXT_MAX, required=True)  # type: ignore[return-value]
