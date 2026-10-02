"""analytics.citations.targets 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

C-4 타겟·자사 URL 인용률(M06·M07, 측정 단위 A2)
- 값 = core.measure.url_rates(K-1 카드와 같은 함수, 전체-통합 §3-5): 라이브는 rd.answer 의 cit_in 답변(website 는 web_reg 게이트,
  project 는 게이트 없음: Q5·D-url-denominator) 중 tgt_cited / own_url_cited(Q5·P11: own_url_cited ⊇ tgt_cited 를 DDL CHECK 가 보장),
  웹사이트 스냅샷(또는 회차 하나를 고른 기간 from = to, D-R09) 회차에 활성 웹사이트 발행물이 있고 엔진이 기본값이면
  rd.report_unit_value 합(R09·A5·G-22). 헤드라인 풀 규칙(선택에 풀 유닛이 있으면 풀만, D-headline)은 core 가 적용한다.
- 표면: website·project 가 값을 낸다. global 은 타겟 개념이 없어 422 surface_unsupported(모듈-인용 §2 필터 표).
- 억제(meta.suppressed, 지표 키 target_url_rate·owned_url_rate): 인용 숨김 회차 hidden(url_rates 는 호출자가 먼저 판단),
  source[] 가 오면 source_filter(현행 카드 생략 동작, 모듈-인용 §2 C-4), 분모 0 no_measurement. 스냅샷 회차 없음 '*': no_active_snapshot.

출처 표시(meta.source, 모듈-인용 §2 C-4 provenance {source, publication_slug, reason}): core url_rates 가 판정한 그대로 싣는다.
- 발행값: {origin: 'report', publication_slugs: [합산에 실제로 들어간 발행물 slug]}(스코프 안 발행물만, 검증 D1).
- 라이브: {origin: 'live', reason}. reason = core R09_* 사유: engine_axis · period_range(회차 둘 이상 기간) · no_publication ·
  not_website(project 표면) · empty_window.
- BG-26(추가형): 발행값이면 publications[{slug, cycle_label, cycle_label_en, round_date, site_count, headline_pool_applied,
  manifest_verified}] 를 더한다(현행 카드 툴팁 출처 문구의 회차 라벨·기준일·사이트 수). 값은 core report_publications(발행값 합산과
  같은 선택 술어)에서 오고, publication_slugs 에 든 발행물만 싣는다. 라이브면 키를 더하지 않는다(기존 모양 그대로).
"""
from __future__ import annotations

from typing import Any

from app.core import errors
from app.core.cycles import Window
from app.core.envelope import SUPPRESS_HIDDEN, SUPPRESS_NO_SNAPSHOT, Envelope, build_meta, ratio_or_none
from app.core.filters import TAXONOMY_AXES, FilterSupport, ReadContext
from app.core.measure import report_publications, url_rates

from .schemas import TargetsData

SUPPORT = FilterSupport.of(
    website=("brand", "country", "lang", "engine", "period"),
    project=("country", "lang", "engine", "period", *TAXONOMY_AXES, "custom"),
)
METRICS = ("target_url_rate", "owned_url_rate")


def check_surface(surface: str) -> None:
    if surface == "global":
        raise errors.unprocessable("타겟·자사 URL 인용률은 website(·project) 표면 전용", code="surface_unsupported",
                                   details={"field": "surface"})


async def window_for(ctx: ReadContext, conn: Any) -> Window:
    """창 해석(테스트가 인용 노출 회차를 주입할 수 있게 한 곳에 둔다)."""
    return await ctx.window(conn)


def _suppress(reason: str) -> dict[str, str]:
    return dict.fromkeys(METRICS, reason)


async def _publications(conn: Any, ctx: ReadContext, win: Window, slugs: set[str]) -> list[dict[str, Any]]:
    rows = await report_publications(conn, ctx.measure(), win, brands=ctx.own_brands, countries=ctx.countries, langs=ctx.langs, req=ctx.r09)
    return [{"slug": r["slug"], "cycle_label": r["cycle_label"], "cycle_label_en": r["cycle_label_en"], "round_date": r["round_date"].isoformat(),
             "site_count": int(r["site_count"]), "headline_pool_applied": bool(r["headline_pool_applied"]),
             "manifest_verified": bool(r["manifest_verified"])}
            for r in rows if r["slug"] in slugs]


async def compute_targets(conn: Any, ctx: ReadContext, win: Window) -> Envelope[TargetsData]:
    empty = TargetsData(measured=0, target=None, owned=None)

    def out(data: TargetsData, suppressed: dict[str, str], source: dict[str, Any] | None = None) -> Envelope[TargetsData]:
        return Envelope[TargetsData](data=data, meta=build_meta(mode=win.mode, window=win, ctx=ctx, suppressed=suppressed, source=source))

    if "source" in ctx.ignored_filters:
        return out(empty, _suppress("source_filter"))
    if win.empty:
        return out(empty, {"*": SUPPRESS_NO_SNAPSHOT} if win.mode == "snapshot" else _suppress("no_measurement"))
    if win.hidden("citations"):
        return out(empty, _suppress(SUPPRESS_HIDDEN))
    rates = (await url_rates(conn, ctx.measure(), win, brands=ctx.own_brands, countries=ctx.countries, langs=ctx.langs, req=ctx.r09))[None]
    source: dict[str, Any] = ({"origin": "report", "publication_slugs": rates["publications"]} if rates["origin"] == "report"
                              else {"origin": "live", "reason": rates["reason"]})
    if rates["origin"] == "report":
        source["publications"] = await _publications(conn, ctx, win, set(rates["publications"]))
    (t_num, t_den), (o_num, o_den) = rates["target"], rates["owned"]
    data = TargetsData(measured=int(t_den), target=ratio_or_none(t_num, t_den), owned=ratio_or_none(o_num, o_den))
    suppressed = {k: "no_measurement" for k, v in zip(METRICS, (data.target, data.owned), strict=True) if v is None}
    return out(data, suppressed, source)
