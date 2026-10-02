"""analytics.citations.domain_detail 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

- 경로 skey = rd.dim_source.skey(출처 그룹 키). 모르는 skey 는 404(존재 은폐 규약과 같은 코드).
- 알려진 출처인데 창·필터 안 인용이 0 이면 200 + 빈 목록.
- source[] 를 줬는데 이 출처의 유효 카테고리(오버라이드 반영)가 선택 밖이면 빈 결과(도메인 순위와 같은 모집단).
- 순서 동률: URL 은 url_hash(외부 비노출 고정 키), 프롬프트는 prompt_id, 답변 참조는 answer_key(적재 키, 자른 뒤 job_id 조회).
- BG-25: urls_limit·prompts_limit·answers_limit(기본 = 현행 10·12·8) + 자르기 전 url_total·prompt_total. BG-23: URL 행 prompt_text.
  embed(도메인 순위 선적재)는 하지 않는다(갭 표 BG-25 에서 선택). 근거: 어댑터 설계 컴포넌트 수정 #6(front-adapter-plan.md:378,
  :1476 '펼칠 때 조회')이 드릴다운을 행 펼침 시 이 경로로 지연 조회하도록 정했다.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from fastapi import Request

from app.core import errors
from app.core.auth import Principal
from app.core.db import fetch_one
from app.core.envelope import Envelope, build_meta
from app.features.analytics.citations.domain_detail import queries as q
from app.features.analytics.citations.domain_detail.schemas import (
    DetailPrompt,
    DetailUrl,
    DomainDetailData,
    DomainDetailQuery,
    SourceInfo,
)
from app.features.analytics.citations.domains.service import resolve_mention_brand
from app.features.analytics.citations.domains.shared import AnswerRef, CitationRead, open_read


async def get_detail(conn: Any, principal: Principal, skey: str, params: DomainDetailQuery, request: Request) -> Envelope[DomainDetailData]:
    rd = await open_read(conn, principal, params, request)
    src = await fetch_one(conn, q.SOURCE_SQL, {"skey": skey})
    if src is None:
        raise errors.not_found("출처 없음")
    info = SourceInfo(skey=src["skey"], domain=src["domain"], is_social=bool(src["is_social"]), category=rd.category(src["category_key"]),
                      competitor_brand=src["competitor_brand"])
    data = DomainDetailData(source=info, citations=0, own_citations=0, urls=[], prompts=[], url_total=0, prompt_total=0)
    brand_key, unknown = await resolve_mention_brand(conn, params.mention_brand)
    cats = rd.ctx.source_category_keys
    out_of_category = cats is not None and int(src["category_key"]) not in cats
    if not (rd.empty or unknown or out_of_category):
        s = q.detail_sql(rd.ctx, rd.win, source_key=int(src["source_key"]), mention_brand_key=brand_key, urls_limit=params.urls_limit,
                         prompts_limit=params.prompts_limit, answers_limit=params.answers_limit)
        r = await fetch_one(conn, s.text, s.params) or {}
        data = _assemble(rd, info, r)
    meta = build_meta(mode=rd.win.mode, ctx=rd.ctx, window=rd.win, suppressed=rd.suppressed)
    if unknown and params.mention_brand is not None:
        meta.dropped_filters["mention_brand"] = [params.mention_brand]
    return Envelope[DomainDetailData](data=data, meta=meta)


def _assemble(rd: CitationRead, info: SourceInfo, r: dict[str, Any]) -> DomainDetailData:
    refs: dict[int, list[AnswerRef]] = defaultdict(list)
    for x in r.get("refs") or []:
        refs[int(x["prompt_key"])].append(AnswerRef(job_id=str(x["job_id"]), engine=rd.engine_code.get(int(x["engine_key"])),
                                                    country=rd.country_code(x["geo_key"]), citations=int(x["cites"])))
    urls = [DetailUrl(url=u["url"] or "", title=u["title"], citations=int(u["citations"]), engines=rd.engines(u["engines"]),
                      country=u["geo_code"], prompt_text=u.get("prompt_text")) for u in r.get("urls") or []]
    prompts = [DetailPrompt(prompt_id=str(p["prompt_id"]), text=p["text"], funnel=p["funnel"], citations=int(p["citations"]),
                            own_citations=int(p["own_citations"]), engines=rd.engines(p["engines"]), answers=refs.get(int(p["prompt_key"]), []))
               for p in r.get("prompts") or []]
    return DomainDetailData(source=info, citations=int(r.get("citations") or 0), own_citations=int(r.get("own_citations") or 0),
                            urls=urls, prompts=prompts, url_total=int(r.get("url_total") or 0), prompt_total=int(r.get("prompt_total") or 0))
