"""인용 기능(an-cit-a) 테스트 공용 도우미.

픽스처(back/tests/fixtures/fixture-10-data.sql) 손 계산 근거(글로벌 스냅샷 = 회차 11, round_date 2026-09-14):
  인용 계열 서빙 인용 = 답변 k1(chatgpt·US·bgrp 5·prompt 'best suv') 의 ord 1~10 중 호스트 없는 ord5 를 뺀 9건.
    ord1 hyundai.com(자사 AU base, owner 9) · ord2·ord4 reddit.com · ord3 linkedin.com/hyundai-motor-group(공식 소셜, Official HMG)
    ord6 example.org(오버라이드 → News & Media) · ord7 caranddriver.com · ord8 foo-bar.xyz(Other)
    ord9 hyundaiusa.com(현대 US root_home, owner 193) · ord10 worldwide.kia.com(출처 kia.com, 기아 base owner 103)
  k5(gemini·DE·bmwusa.com) 는 cit_in 거짓이라 모수 밖. 커버리지 분모(cit_in·기본 엔진) = k1·k2·k4·k9·k12 = 5.
  톤: k1 현대 sent_pos 3 > sent_neg 0 → 긍정. 픽스처에 부정 톤 답변은 없다.
  프로젝트(회차 31): k31 인용 4건 = example.com 3(loc_owned t·f·t, tgt_hit f·t·f) + hyundaiusa.com 1(loc_owned t).
  웹사이트(회차 21, 인용 숨김): k21 3건 + k22 1건 = kia.com 3(자사 판정 loc_owned ∨ tgt_hit = t·f·t) + kia.de 1(t).

기능 테스트는 rd 를 쓰지 않는다(정적 SQL 가드 G6: app/features/** 의 rd 쓰기 문장 금지). 숨김 없는 웹사이트 경로는 숨김만 뺀 창을
core.cycles.build_window(순수 함수)로 만들어 기능 SQL 빌더를 그대로 실행해 검증한다(website_window).
운영자 오버라이드(app 표)는 로컬 복제본에 잠깐 넣고 지운다(override).
"""
from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator
from datetime import date
from typing import Any

import asyncpg

from app.core.cycles import CycleRow, Window, build_window
from tests.support import DB_URL

SEED_ACTOR = "5eed0000-0000-4000-8000-000000000001"
WEBSITE_ROUND = date(2026, 9, 18)


@contextlib.asynccontextmanager
async def override(domain: str, category_key: int) -> AsyncIterator[None]:
    """app.citation_domain_override 1행을 잠깐 넣는다(적재기 반영 전 상태 = rd.dim_source 는 그대로). 끝나면 지운다."""
    c = await asyncpg.connect(DB_URL)
    try:
        async with c.transaction():
            await c.execute("SELECT set_config('app.actor_id', $1, true)", SEED_ACTOR)
            await c.execute("INSERT INTO app.citation_domain_override (domain, category_key, note) VALUES ($1, $2, 'an-cit-a test')",
                            domain, category_key)
        try:
            yield
        finally:
            async with c.transaction():
                await c.execute("SELECT set_config('app.actor_id', $1, true)", SEED_ACTOR)
                await c.execute("DELETE FROM app.citation_domain_override WHERE domain = $1", domain)
    finally:
        await c.close()


def website_window(project_keys: tuple[int, ...]) -> Window:
    """웹사이트 회차 21(round_date 2026-09-18)을 인용 숨김 없이 본 창(hidden_scope 0)."""
    return build_window(surface="website", mode="snapshot", rows=[CycleRow(21, 2, WEBSITE_ROUND, 0)], lo=WEBSITE_ROUND, hi=WEBSITE_ROUND,
                        generation=1, project_keys=project_keys)


async def fetch_scalar(sql: str, *args: Any) -> Any:
    """독립 기대값 조회(기능 코드와 다른 경로)."""
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetchval(sql, *args)
    finally:
        await c.close()
