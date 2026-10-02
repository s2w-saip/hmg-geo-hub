"""언급 모듈(M-1·M-2·M-3) 공용: 지원 필터 축, 표면 경로 게이트, 읽기 문맥·창 해석, 억제 사유, 관점 라벨.

- 세 엔드포인트가 같은 규칙을 쓰도록 한 곳에 둔다(모듈-언급 §2 "세 단위가 반드시 같게").
- 표면 경로 게이트(route-policy 역할 천장 + menu_groups)는 core.filters.resolve_read_context 가 core.auth.require_surface 로 건다
  (an-mentions R2 이관, D-vendor: vendor 는 표준·웹사이트 경로 밖, website 역할은 웹사이트만).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import Request

from app.core.auth import Principal
from app.core.cycles import Window
from app.core.envelope import SUPPRESS_HIDDEN, SUPPRESS_NO_SNAPSHOT
from app.core.filters import TAXONOMY_AXES, CommonFilters, FilterSupport, ReadContext, parse_custom_fields, resolve_read_context
from app.core.measure import MeasureScope, split_own_label, split_own_scopes

# 모듈-언급 §2.6: lang 은 global·website 만(project 는 ignored), 택소노미는 global·project, 커스텀 필드는 project. source 는 전 표면 ignored.
MENTIONS_SUPPORT = FilterSupport.of(
    global_=("brand", "country", "lang", "engine", "period", *TAXONOMY_AXES),
    website=("brand", "country", "lang", "engine", "period"),
    project=("country", "engine", "period", *TAXONOMY_AXES, "custom"),
)

# rd.dim_brand_name.brand_key 는 int4. 요청 brand_key 상한을 두어 바인드 전에 422 로 막는다(D1: 넘는 값은 asyncpg DataError → 500 이었다)
INT4_MAX = 2**31 - 1

async def read_scope(conn: Any, p: Principal, filters: CommonFilters, request: Request) -> tuple[ReadContext, Window]:
    """경로 게이트·스코프 ∩ 요청(core.filters) → 창(core.cycles). 커스텀 필드(cf.<id>)는 project 외 표면에서 ignored 로 드러난다."""
    custom = parse_custom_fields(request.query_params)
    ctx = await resolve_read_context(conn, p, filters, support=MENTIONS_SUPPORT, custom_fields=custom)
    return await ctx.card_window(conn, route="brands")                                 # 동결 판정(S4): 구멍이면 비카드 문맥·창


def suppression(win: Window) -> dict[str, str]:
    """응답 전체 억제 사유. 스냅샷 회차 없음 = no_active_snapshot, 창 회차가 전부 언급 숨김 = hidden. 기간 모드 빈 창은 억제 없이 0."""
    if win.hidden("mentions"):
        return {"*": SUPPRESS_HIDDEN}
    if win.empty and win.mode == "snapshot":
        return {"*": SUPPRESS_NO_SNAPSHOT}
    return {}


def runnable(win: Window) -> bool:
    """사실 표를 읽을 필요가 있는 창인가(빈 창·언급 숨김이면 질의를 생략하고 0 을 낸다)."""
    return not win.empty and bool(win.cyc_keys("mentions"))


def viewpoint_label(ctx: ReadContext) -> str:
    """관점 라벨: 관점 브랜드 하나면 그 brand_code, 둘 이상이면 엄브렐러 brand_code(app.brand, 리터럴 금지)."""
    if len(ctx.own_brands) == 1:
        return ctx.own_brands[0]
    return ctx.refs.brand_code_of_bit(ctx.refs.umbrella_bit) or "+".join(ctx.own_brands)


@dataclass(frozen=True)
class OwnSplit:
    """D13 split_own 으로 가른 당사 행 하나: code = 행 키 own_brand_code, bit = 관점 비트, ms = 그 비트만 당사로 둔 스코프."""
    code: str
    bit: int
    ms: MeasureScope


def own_brand_code_of_bit(ctx: ReadContext, bit: int) -> str:
    """split_own 행 키(own_brand_code): core.measure.split_own_label 정본(trend 와 한 정의, core 8라운드)."""
    return split_own_label(ctx.refs, bit)


def own_splits(ctx: ReadContext, ms: MeasureScope) -> list[OwnSplit]:
    """core.measure.split_own_scopes(ms)(trend 와 공용 판정) + 행 키. 관점 비트가 하나면 빈 목록(가르지 않음 = 합친 당사 1행)."""
    return [OwnSplit(own_brand_code_of_bit(ctx, bit), bit, sms) for bit, sms in split_own_scopes(ms)]
