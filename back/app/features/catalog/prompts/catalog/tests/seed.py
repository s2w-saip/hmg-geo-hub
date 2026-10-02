"""카탈로그·이력 테스트 전용 합성 행(로컬 개발 DB 복제본 hmg_catalog 에만 쓴다). 모듈 픽스처로 넣고 끝나면 지운다.

추가 행(공용 픽스처 fixture-10-data.sql 위에)
- 글로벌(app.prompt, 루트): G1..G9. 대상 시장(regions) 3분기·정규화·검색 이스케이프·NULL 정렬·긴 본문·soft-delete 경우.
- 웹사이트: 사이트 S1 Kia US·S2 Hyundai N DE·S3 Hyundai KR(Scope 프로젝트 없음 = 측정 메타 0) + 프롬프트 4행.
- 이력(app.prompt_audit_log): 위 INSERT 가 트리거로 남기는 created 9건 + 명시 행 A1(2026-06-01 KST)·A2(2026-09-21 00:30 KST =
  UTC 09-20)·A3(하드 삭제된 프롬프트의 deleted, app.prompt 행 없음).
- 계정: WEBSITE_USER(role website, Kia, 메뉴 website).
행은 복제본에 남는다(멱등 시드, 지우지 않는다): 감사 원장은 append-only 이고 기능 테스트 SQL 도 경계 가드 정적 검사를 받으므로
트리거를 끄는 정리를 하지 않는다. core 테스트는 이 표들(app.prompt·website_*·prompt_audit_log)을 세지 않는다.
"""
from __future__ import annotations

import uuid

import asyncpg

from tests.support import ADMIN, DB_URL, SYSTEM

ROOT = "c0000000-0000-4000-8000-000000000001"


def gid(n: int) -> uuid.UUID:
    return uuid.UUID(f"c7a70000-0000-4000-8000-{n:012d}")


def sid(n: int) -> uuid.UUID:
    return uuid.UUID(f"d7a70000-0000-4000-8000-{n:012d}")


def wid(n: int) -> uuid.UUID:
    return uuid.UUID(f"e7a70000-0000-4000-8000-{n:012d}")


WEBSITE_USER = uuid.UUID("11111111-0000-4000-8000-0000000000c1")
PURGED = gid(99)
A1, A2, A3 = 900001, 900002, 900003          # 명시 감사 행 audit_id(OVERRIDING SYSTEM VALUE)
LONG_TEXT = "zz long " + "a" * 600

# (id, text, brand, regions, lang, list_type, depth1, depth2, depth3, depth4, funnel, kind, deleted)
GLOBAL_ROWS = [
    (gid(1), "kr market suv", "Hyundai", ["KR"], "KO", "L1", "D1", "D2a", "D3x", "D4x", "F1", "single", False),
    (gid(2), "us market kia", "Kia", [" us ", "x:na"], "EN", "L1", "D1", None, None, None, "F2", "single", False),
    (gid(3), "pseudo only kia", "Kia", ["x:global"], "EN", None, None, None, None, None, None, "single", False),
    (gid(4), "empty regions kia", "Kia", [], None, None, None, None, None, None, None, "single", False),
    (gid(5), "de market kia", "Kia", ["DE"], "DE", "L2", "D1", None, None, None, None, "single", False),
    (gid(6), "n brand prompt", "Hyundai N", None, None, None, None, None, None, None, None, "single", False),
    (gid(7), "rate 100%_off\\x", None, None, None, None, "D1", None, None, None, None, "single", False),
    (gid(8), LONG_TEXT, "Kia", None, None, None, None, None, None, None, None, "single", False),
    (gid(9), "hyundai deleted", "Hyundai", None, None, None, None, None, None, None, None, "single", True),
]
LIVE_GLOBAL = [r[0] for r in GLOBAL_ROWS if not r[12]]

SITES = [(sid(1), "Kia", "US"), (sid(2), "Hyundai N", "DE"), (sid(3), "Hyundai", "KR")]
# (id, site, file_seq, seq, domain, lang, target_url, prompt_text)
WEB_ROWS = [
    (wid(1), sid(1), 1, 1, "kia.com", "en", "https://www.kia.com/us/a", "us kia a"),
    (wid(2), sid(1), 1, 2, "kia.com", "en", "https://www.kia.com/us/b_x", "=1+1 us kia 50%_b"),
    (wid(3), sid(2), 1, 1, "hyundai-n.com", "de", "https://www.hyundai-n.com/de/", "n de"),
    (wid(4), sid(3), 1, 1, "hyundai.com", "ko", "https://www.hyundai.com/kr/", "kr hy"),
]

_SEED = """
SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', true),
       set_config('app.actor_type', 'system', true)
"""
_USER = """
INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, menu_groups, status)
VALUES ('11111111-0000-4000-8000-0000000000c1', 't-web-kia@example.test', 'website', 'none', false, '{Kia}', '{website}', 'active')
ON CONFLICT (user_id) DO NOTHING
"""


async def seed() -> None:
    """멱등 시드(ON CONFLICT DO NOTHING). 이미 있으면 아무것도 바꾸지 않는다(트리거 감사 행도 다시 생기지 않는다).
    행 정의를 바꾸면 복제본을 다시 만든다(bash db/dev-db.sh clone catalog). 행위자 GUC 는 트랜잭션 로컬(set_config …, true)."""
    c = await asyncpg.connect(DB_URL)
    try:
        async with c.transaction():
            await c.execute(_SEED)
            await c.execute(_USER)
            for (pid, text, brand, regions, lang, lt, d1, d2, d3, d4, fn, kind, deleted) in GLOBAL_ROWS:
                await c.execute(
                    "INSERT INTO app.prompt (prompt_id, project_id, text, brand_code, regions, lang, list_type, depth1, depth2, depth3, depth4,"
                    " funnel_stage, kind, status, created_by, deleted_at)"
                    " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'done', $14, CASE WHEN $15 THEN now() END)"
                    " ON CONFLICT (prompt_id) DO NOTHING",
                    pid, uuid.UUID(ROOT), text, brand, regions, lang, lt, d1, d2, d3, d4, fn, kind, SYSTEM, deleted)
            for s, brand, cc in SITES:
                await c.execute("INSERT INTO app.website_site (site_id, brand_code, country_code) VALUES ($1, $2, $3)"
                                " ON CONFLICT (site_id) DO NOTHING", s, brand, cc)
            for w, s, fs, seq, dom, lang, url, text in WEB_ROWS:
                await c.execute(
                    "INSERT INTO app.website_prompt (website_prompt_id, site_id, file_seq, domain, lang_code, seq_no, target_url, prompt_text)"
                    " VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (website_prompt_id) DO NOTHING", w, s, fs, dom, lang, seq, url, text)
            await c.execute(
                "INSERT INTO app.prompt_audit_log (audit_id, prompt_id, project_id, actor_id, actor_type, event_type, changes, created_at)"
                " OVERRIDING SYSTEM VALUE VALUES"
                " ($1, $4, $7, $8, 'user', 'meta_updated', '{\"list_type\": {\"old\": \"L1\", \"new\": \"L2\"}}', '2026-06-01 10:00+09'),"
                " ($2, $5, $7, $8, 'user', 'text_updated', '{\"text\": {\"old\": \"kr suv\", \"new\": \"kr market suv\"}}', '2026-09-21 00:30+09'),"
                " ($3, $6, $7, $8, 'user', 'deleted', '{\"purged\": {\"old\": \"false\", \"new\": \"true\"}, \"text\": {\"old\": \"secret kia\", \"new\": null}}', now())"
                " ON CONFLICT (audit_id) DO NOTHING",
                A1, A2, A3, gid(5), gid(1), PURGED, uuid.UUID(ROOT), ADMIN)
    finally:
        await c.close()


async def q(sql: str, *args):
    """독립 기대값 조회(구현 SQL 과 별개로 손으로 쓴 SQL). asyncpg 직접 = SQL 가드 밖."""
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetch(sql, *args)
    finally:
        await c.close()
