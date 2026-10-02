"""analytics.mentions.prompts 업무 규칙(M-3). 공통 술어는 app.core.cycles·app.core.measure, 페이지는 app.core.pagination.

- mode=brand: brand_key 가 rd.dim_brand_name 에 없으면 404. 추적 브랜드 명부 검사는 하지 않는다(행 수준 스코프가 곧 권한, 모듈-언급 §6).
  BG-17: mention_brand(이름 → brand_key, answers 목록과 같은 해석: name 일치 우선, 없으면 bare 소문자, 없으면 404) 또는 own=true(당사 행,
  관점 비트 전체). own_brand_code 는 D13 split_own 행 키(common.own_splits, mentions/brands·trend 와 같은 규칙)만 그 비트 하나로 받는다.
  브랜드 코드가 아니면 422, 행 키가 아닌 코드(관점 밖·하위 브랜드 코드·단일 관점)는 빈 목록(다른 이름표로 같은 값을 내지 않는다).
  mode=signal 에 brand_key·own·mention_brand 가 오면 422(스키마, 조용히 무시하지 않는다).
- BG-18 terms=true: 페이지 답변 참조마다 하이라이트 표기(build_terms, 현행 highlightTermsForBrand 규칙 이식). 타깃 = brand 는 그 브랜드,
  own·signal 은 관점(당사) 비트. own·signal 씨앗(관점 브랜드 코드)은 그 답변에 정본 브랜드로 실제 나온 것만 넣는다(D-4: 없는 표기가 상한을 먹지 않게).
  model 표기는 현행과 같이 롤업으로만 잇는다(검증 D3). mode=signal 의 terms 는 현행 신호 드릴다운(하이라이트 없음, scope-aggregates.ts:7329)에
  없는 확장이라 화면을 그대로 두려면 어댑터가 signal 에는 terms 를 요청하지 않는다(모듈-언급 §3.3.1).
- 커서 = (count, prompt_key) + 필터 해시(공통 필터·커스텀 필드·타깃) + 데이터 세대. 세대가 바뀌면 409 cursor_stale.
  새 타깃 인자는 기본값이면 해시에서 빠진다(배포 전 커서 호환, 검증 D5).
- 빈 창·언급 숨김이면 질의 없이 빈 목록.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from app.core import errors
from app.core.cycles import Window
from app.core.db import fetch_all, fetch_one
from app.core.envelope import Page, ratio
from app.core.filters import ReadContext
from app.core.pagination import decode_cursor, fetch_keyset, filter_hash, keyset_page
from app.features.analytics.mentions.brands.common import own_splits, runnable, viewpoint_label
from app.features.analytics.mentions.prompts.queries import (
    KEY_TYPES,
    RESOLVE_BRAND_SQL,
    SORT,
    TargetSpec,
    answers_sql,
    brand_name_sql,
    page_sql,
    terms_sql,
)
from app.features.analytics.mentions.prompts.schemas import AnswerRef, PromptItem, PromptsData, PromptsQuery, Target, Terms

TERMS_BRAND_CAP = 8      # 답변 참조당 브랜드 표기 상한(현행 슬림 수준 0: hlBrand 8)
TERMS_MODEL_CAP = 24     # 답변 참조당 모델 표기 상한(현행 hlModel 24)


async def resolve_target(conn: Any, q: PromptsQuery, ctx: ReadContext) -> tuple[TargetSpec, Target]:
    if q.mode == "brand" and q.own:
        if q.own_brand_code is not None:
            if ctx.refs.brand(q.own_brand_code) is None:
                raise errors.unprocessable("own_brand_code 는 브랜드 코드(app.brand)")
            keys = {sp.code: sp.bit for sp in own_splits(ctx, ctx.measure())}        # split_own 행 키만(D-3)
            bits = (keys[q.own_brand_code],) if q.own_brand_code in keys else ()
            return (TargetSpec("brand", own_bits=bits),
                    Target(name=q.own_brand_code, own=True, own_brand_code=q.own_brand_code))
        return TargetSpec("brand", own_bits=tuple(ctx.own_bits)), Target(name=viewpoint_label(ctx), own=True)
    if q.mode == "brand":
        if q.mention_brand is not None:
            r = await fetch_one(conn, RESOLVE_BRAND_SQL, {"n": q.mention_brand})
        else:
            s = brand_name_sql(q.brand_key)  # type: ignore[arg-type]
            r = await fetch_one(conn, s.text, s.params)
        if r is None:
            raise errors.not_found("브랜드 없음", code="brand_not_found")
        return TargetSpec("brand", brand_key=int(r["brand_key"])), Target(brand_key=int(r["brand_key"]), name=r["name"])
    return TargetSpec("signal", signal=q.signal), Target(signal=q.signal)


def build_terms(rows: Sequence[dict[str, Any]], *, brand_key: int | None, name: str | None, bits: Sequence[int],
                seeds: Sequence[str], seeds_if_present: bool = False) -> Terms:
    """현행 highlightTermsForBrand(result-adapter.ts:300-349) 이식. 한 답변의 언급 원본 행(ord 순)에서
    - brand: 씨앗(타깃 표시명) → 타깃 브랜드 행(Brand 엔티티 중 정본 브랜드 = 타깃, 또는 표시명 = 타깃, 당사 타깃이면 정본 브랜드 own_bit ∈ bits)의
      표시명·표면 표기.
    - model: Brand 가 아닌 엔티티 중 롤업이 위 브랜드 행이거나(현행 brandIds), 롤업 엔티티의 정본 브랜드가 타깃(당사면 own_bit ∈ bits,
      현행 rollupBrandId = 드릴다운 브랜드 엔티티)인 행의 표시명·표면 표기. 엔티티 자기 정본 브랜드(e_bk)로는 잇지 않는다
      (현행과 같다, 검증 D3: 롤업이 다른 브랜드인 'Hyundai Creta' 는 Hyundai 타깃에서 칠하지 않는다).
    2자 미만(앞뒤 공백 제거 후) 제외, 순서 유지 중복 제거, brand 에 있는 표기는 model 에서 뺀다. 상한 TERMS_BRAND_CAP·TERMS_MODEL_CAP.
    seeds_if_present(당사·신호 타깃): 씨앗은 그 답변의 타깃 Brand 행 정본 브랜드 이름(e_name)에 있는 것만 넣는다
    (관점 브랜드 코드 전부를 넣으면 답변에 없는 표기가 brand 상한을 먼저 차지한다)."""
    bset: list[str] = []
    mset: list[str] = []
    bitset = {int(x) for x in bits}

    def push(out: list[str], v: Any) -> None:
        t = str(v or "").strip()
        if len(t) >= 2 and t not in out:
            out.append(t)

    def is_target(bk: Any, own: Any) -> bool:
        if brand_key is not None and bk is not None and int(bk) == brand_key:
            return True
        return bool(bitset) and own is not None and int(own) in bitset

    if seeds_if_present:
        present = {r.get("e_name") for r in rows if r.get("entity_type") == "Brand" and is_target(r.get("e_bk"), r.get("e_own"))}
        seeds = [s for s in seeds if s in present]
    for s in seeds:
        push(bset, s)
    ids: set[Any] = set()
    for r in rows:
        if r.get("entity_type") == "Brand" and (is_target(r.get("e_bk"), r.get("e_own"))
                                                or (name is not None and r.get("display_name") == name)):
            push(bset, r.get("display_name"))
            for x in r.get("surfaces") or ():
                push(bset, x)
            ids.add(r.get("entity_id"))
    for r in rows:
        if r.get("entity_type") == "Brand":
            continue
        if (r.get("rollup_id") is not None and r.get("rollup_id") in ids) or is_target(r.get("r_bk"), r.get("r_own")):
            push(mset, r.get("display_name"))
            for x in r.get("surfaces") or ():
                push(mset, x)
    model = [t for t in mset if t not in bset]
    return Terms(brand=bset[:TERMS_BRAND_CAP], model=model[:TERMS_MODEL_CAP])


def _terms_target(ctx: ReadContext, spec: TargetSpec, target: Target) -> dict[str, Any]:
    """build_terms 인자: brand 타깃 = (brand_key, 표시명), 당사·신호 타깃 = 당사 비트와 그 비트로 접히는 관점 브랜드 코드."""
    if spec.mode == "brand" and spec.own_bits is None:
        return {"brand_key": spec.brand_key, "name": target.name, "bits": (), "seeds": [target.name] if target.name else [],
                "seeds_if_present": False}
    bits = tuple(spec.own_bits) if spec.own_bits is not None else tuple(ctx.own_bits)
    if target.own_brand_code is not None:
        seeds = [target.own_brand_code] if bits else []
    else:
        seeds = [c for c in ctx.own_brands if ctx.refs.own_bit_of(c) in bits]
    return {"brand_key": None, "name": None, "bits": bits, "seeds": seeds, "seeds_if_present": True}


# BG 라운드에 더한 타깃 인자와 그 기본값. 기본값이면 커서 해시에서 빼서 배포 전(8890406) 커서가 그대로 이어진다(검증 D5).
_ADDED_TARGET_DEFAULTS: dict[str, object] = {"mention_brand": None, "own": False, "own_brand_code": None}


def cursor_hash(q: PromptsQuery, custom: dict[str, list[str]]) -> str:
    """커서가 다른 필터·타깃으로 재사용되지 않게: 공통 필터 전 축 + 커스텀 필드 + mode·타깃(limit·answers_limit·cursor·terms 제외).
    새 타깃 인자(mention_brand·own·own_brand_code)는 값이 있을 때만 넣는다: 기본값 요청의 해시 = BG 라운드 전 해시."""
    skip = {"limit", "cursor", "answers_limit", "terms"} | {k for k, v in _ADDED_TARGET_DEFAULTS.items() if getattr(q, k) == v}
    f = q.model_dump(mode="json", by_alias=True, exclude=skip)
    return filter_hash({"f": f, "cf": {k: sorted(v) for k, v in sorted(custom.items())}})


async def mention_prompts(conn: Any, ctx: ReadContext, win: Window, q: PromptsQuery, *,
                          custom: dict[str, list[str]]) -> tuple[PromptsData, Page]:
    spec, target = await resolve_target(conn, q, ctx)
    fh = cursor_hash(q, custom)
    cur = decode_cursor(q.cursor, sort=SORT, dir="desc", fh=fh, types=KEY_TYPES, generation=win.generation)
    if not runnable(win) or spec.own_bits == ():
        return PromptsData(mode=q.mode, target=target, total=0, items=[]), Page(next_cursor=None, limit=q.limit, total=0)

    ms = ctx.measure()
    s = page_sql(ms, win, spec, cursor=cur, limit=q.limit)
    rows = await fetch_keyset(conn, s.text, s.params, cursor=cur)
    page, nxt = keyset_page(rows, q.limit, lambda r: (int(r["cnt"]), int(r["prompt_key"])), sort=SORT, dir="desc", fh=fh,
                            generation=win.generation)
    total = int(rows[0]["total"]) if rows else 0
    n_prompts = int(rows[0]["n_prompts"]) if rows else 0
    if cur is not None and not rows:                        # 마지막 페이지 뒤: 합계는 커서 없는 첫 문장과 같아야 하므로 다시 센다
        s0 = page_sql(ms, win, spec, cursor=None, limit=1)
        first = await fetch_all(conn, s0.text, s0.params)
        total = int(first[0]["total"]) if first else 0
        n_prompts = int(first[0]["n_prompts"]) if first else 0

    refs: dict[int, list[AnswerRef]] = {}
    if page:
        a = answers_sql(ms, win, spec, prompt_keys=[int(r["prompt_key"]) for r in page], answers_limit=q.answers_limit)
        arows = await fetch_all(conn, a.text, a.params)
        terms: dict[int, Terms] = {}
        if q.terms and arows:
            tt = _terms_target(ctx, spec, target)
            by_answer: dict[int, list[dict[str, Any]]] = {}
            h = terms_sql(sorted({int(r["answer_key"]) for r in arows}), ctx.sf, ctx.project_keys)
            for r in await fetch_all(conn, h.text, h.params):
                by_answer.setdefault(int(r["answer_key"]), []).append(r)
            terms = {k: build_terms(by_answer.get(k, []), **tt) for k in {int(r["answer_key"]) for r in arows}}
        for r in arows:
            refs.setdefault(int(r["prompt_key"]), []).append(AnswerRef(
                job_id=r["job_id"], engine=r["engine"], region=r["region"], value=int(r["val"] or 0),
                position=int(r["pos"]) if r["pos"] else None, measured_at=r["measured_at"], runs=int(r["runs"]),
                terms=terms.get(int(r["answer_key"])) if q.terms else None))

    eng = {k: code for code, (k, _) in ctx.refs.engines.items()}
    items = [PromptItem(prompt_id=r["prompt_id"], prompt_text=r["prompt_text"], funnel_code=r["funnel_code"], count=int(r["cnt"]),
                        share=ratio(int(r["cnt"]), total), providers=[eng.get(int(k), str(k)) for k in (r["engines"] or [])],
                        answers=refs.get(int(r["prompt_key"]), [])) for r in page]
    return (PromptsData(mode=q.mode, target=target, total=total, items=items),
            Page(next_cursor=nxt, limit=q.limit, total=n_prompts))
