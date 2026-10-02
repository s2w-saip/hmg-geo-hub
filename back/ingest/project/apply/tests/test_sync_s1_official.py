"""동기화 S1 BE-B(hmg-geo 2670a16 #320·#321, 제품 책임자 Q2 (a)): rd.answer.cit_off(DB-v2.13 P71) 적재·재판정·채우기·카테고리 판정 대조.

  R7  현행 ⑤ 분자는 행 카테고리 없이 그룹 키만으로 분류한다(official-hmg-citations.ts:37-45 isOfficialHmgGroupKey = resolveCitationCategory
      (rowCategory = null, key, overrides)). hub rd.dim_source.category_key 의 판정식 pg_temp.category_of(seed-3x-common.sql §9: 오버라이드 →
      공식 소셜 → 공식 도메인 → 시드 → 규칙 → Other)가 같은 입력에 같은 카테고리를 내는지, 현행 TS 로 뽑은 오라클
      (migration/seed/ts-dump-official.json = dump-official.ts@2670a16, 후보 = gen_official_cases.py)과 전수 대조한다. 오버라이드 없음·있음 두 상태.
  재판정  citation_override: 공식 여부가 바뀐 출처를 인용한 답변만 재투영(cit_off 재계산 + 엄격 단언), 공식 여부가 그대로인 카테고리 변경은
      사실 행 불변. 증분 결과 = bulk(seed-30·40, cit_off 포함) 동치. 되돌리면 원래 값.
  채우기  back/migration/fill-cit-off.sql: 드라이런은 쓰지 않는다, commit=1 은 배치마다 단언하고 원소 오라클과 같아진다, 다시 돌리면 0행,
      공식 인용이 없는데 cit_off > 0 인 행도 0 으로 되돌린다.
경로는 운영과 같다: 앱 편집(슈퍼유저 + 행위자 GUC) → app.judgment_change → run_queue(loader 롤) → rd. 커밋 경로라 일회 DB(fresh_db).
"""
from __future__ import annotations

import json
from pathlib import Path

import asyncpg

from ingest.common.db import LoaderDB
from ingest.common.rules import ensure_session_rules
from ingest.cycles.workers.service import run_queue
from ingest.testkit import EQ_TABLES, bulk_equivalence
from tests.dbforward import FILL_CIT_OFF, run_psql_file
from tests.support import needs_db

SEED = Path(__file__).resolve().parents[4] / "migration" / "seed"
ACTOR = "5eed0000-0000-4000-8000-000000000001"
OFFICIAL_BY_ANSWER = """
SELECT a.answer_key, a.cit_off, a.cit_n, a.load_id,
       (SELECT count(*) FROM rd.citation c JOIN rd.dim_source s ON s.source_key = c.source_key
          JOIN app.citation_category cc ON cc.category_key = s.category_key
         WHERE c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
           AND c.source_key <> 0 AND cc.name = 'Official (HMG)') AS off_el,
       ARRAY[a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10, a.cit_c11, a.cit_c12, a.cit_c13] AS cat_cols,
       ARRAY(SELECT count(*) FILTER (WHERE s.category_key = k)::int2 FROM generate_series(1, 13) k
               LEFT JOIN rd.citation c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key AND c.source_key <> 0
               LEFT JOIN rd.dim_source s ON s.source_key = c.source_key GROUP BY k ORDER BY k) AS cat_el
  FROM rd.answer a
"""


async def _fetch(url: str, sql: str, *a):
    c = await asyncpg.connect(url)
    try:
        return await c.fetch(sql, *a)
    finally:
        await c.close()


async def _by_answer(url: str) -> dict[int, asyncpg.Record]:
    return {int(r["answer_key"]): r for r in await _fetch(url, OFFICIAL_BY_ANSWER)}


async def _app(url: str, sql: str) -> None:
    """앱 편집(행위자 GUC). 픽스처 적재 때 남은 대기 요청은 적용 완료로 치운다(test_sync_s1_rules 와 같은 규약)."""
    c = await asyncpg.connect(url)
    try:
        async with c.transaction():
            await c.execute("UPDATE app.judgment_change SET status = 'applied', applied_at = now() WHERE status = 'pending' AND requested_at < now()")
            await c.execute(f"SELECT set_config('app.actor_id', '{ACTOR}', true), set_config('app.actor_type', 'system', true)")
            await c.execute(sql)
    finally:
        await c.close()


async def _drain(url: str) -> None:
    out = await run_queue(LoaderDB(url, role="loader"))
    assert out and all(o.status == "applied" for o in out), out


async def _assert_bulk_equal(url: str) -> None:
    strict, referenced = await bulk_equivalence(url, EQ_TABLES)
    assert not strict, {t: (v["len"], v["only_a"][:2], v["only_b"][:2]) for t, v in strict.items()}
    assert not referenced, referenced


# ════════════════════════════════════════════════════════════════════════════
# R7: 카테고리 판정 = 현행 TS(2670a16) 전수 대조
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_r7_category_of_matches_current_ts_oracle():
    from tests.support import DB_URL

    d = json.loads((SEED / "ts-dump-official.json").read_text(encoding="utf-8"))
    assert d["official"] == "Official (HMG)" and "2670a16" in d["source"] and len(d["cases"]) > 1500
    assert d["overrides"] and sum(x["off"] for x in d["cases"]) > 300 and sum(x["off"] != x["off_ov"] for x in d["cases"]) >= 5
    keys = [x["key"] for x in d["cases"]]
    q = "SELECT (pg_temp.category_of(k.k)).cat FROM unnest($1::text[]) WITH ORDINALITY k(k, i) ORDER BY k.i"
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        try:
            await ensure_session_rules(c)
            await c.execute("DELETE FROM app.citation_domain_override")          # 오라클 기준 = 오버라이드 없음(픽스처 example.org 행을 비운다)
            got = [r[0] for r in await c.fetch(q, keys)]
            for dom, cat in d["overrides"].items():
                await c.execute("INSERT INTO app.citation_domain_override (domain, category_key) "
                                "SELECT $1, category_key FROM app.citation_category WHERE name = $2", dom, cat)
            got_ov = [r[0] for r in await c.fetch(q, keys)]
        finally:
            await tr.rollback()
    finally:
        await c.close()
    bad = [(x["key"], x["cat"], g) for x, g in zip(d["cases"], got, strict=True) if g != x["cat"]]
    bad_ov = [(x["key"], x["cat_ov"], g) for x, g in zip(d["cases"], got_ov, strict=True) if g != x["cat_ov"]]
    assert bad == [] and bad_ov == [], (bad[:10], bad_ov[:10])
    # ⑤ 분자가 보는 것은 공식 여부다: 같은 판정이 곧 같은 분자(오버라이드 → 공식 소셜 → 공식 도메인 우선순위 포함)
    assert [g == d["official"] for g in got_ov] == [x["off_ov"] for x in d["cases"]]


# ════════════════════════════════════════════════════════════════════════════
# 재판정 citation_override → 카테고리가 바뀐 출처의 답변 재투영(cit_off·cit_c1..13)
# ════════════════════════════════════════════════════════════════════════════
OVERRIDE_ON = """
INSERT INTO app.citation_domain_override (domain, category_key)
SELECT v.d, cc.category_key FROM (VALUES ('reddit.com', 'Official (HMG)'), ('kia.com', 'Blogs & Reviews'), ('example.com', 'Blogs & Reviews')) v(d, n)
  JOIN app.citation_category cc ON cc.name = v.n;
INSERT INTO app.judgment_change (kind, subject_texts, requested_by)
VALUES ('citation_override', ARRAY['reddit.com', 'kia.com', 'example.com'], '5eed0000-0000-4000-8000-000000000001');
"""
OVERRIDE_OFF = """
DELETE FROM app.citation_domain_override WHERE domain IN ('reddit.com', 'kia.com', 'example.com');
INSERT INTO app.judgment_change (kind, subject_texts, requested_by)
VALUES ('citation_override', ARRAY['reddit.com', 'kia.com', 'example.com'], '5eed0000-0000-4000-8000-000000000001');
"""


@needs_db
async def test_rejudge_citation_override_reprojects_official_flips(fresh_db):
    url = fresh_db
    before = await _by_answer(url)
    assert all(r["cit_off"] == r["off_el"] for r in before.values())
    assert (before[1]["cit_off"], before[21]["cit_off"], before[22]["cit_off"], before[31]["cit_off"]) == (4, 3, 1, 1)
    await _app(url, OVERRIDE_ON)
    await _drain(url)
    after = await _by_answer(url)
    assert all(r["cit_off"] == r["off_el"] for r in after.values())                  # 열 = 원소(재판정 뒤 반영된 카테고리)
    # k1: kia.com 공식 → 비공식(-1), reddit 2건 비공식 → 공식(+2). 웹 k21: kia.com 2건 빠지고 kia.de 1. k22: kia.com 1 → 0
    assert (after[1]["cit_off"], after[21]["cit_off"], after[22]["cit_off"]) == (5, 1, 0)
    assert after[1]["load_id"] != before[1]["load_id"] and after[21]["load_id"] != before[21]["load_id"]   # 재투영됨
    # k31(project): example.com Other → Blogs(공식 여부 그대로) + hyundaiusa.com 공식. 공식 여부는 그대로지만 카테고리가 바뀌어
    # 답변 카테고리별 인용 수 열(cit_c1..13, DB-v2.15 P86 WU-5)이 바뀌므로 재투영된다(종전: 공식 여부가 바뀐 출처만 재투영)
    assert after[31]["cit_off"] == 1 and after[31]["load_id"] != before[31]["load_id"]
    assert all(list(r["cat_cols"]) == list(r["cat_el"]) for r in after.values())      # 열 = 원소(반영된 카테고리), 모든 답변
    assert list(after[31]["cat_cols"]) != list(before[31]["cat_cols"])
    c = await asyncpg.connect(url)
    try:
        assert await c.fetchval("SELECT rd.assert_answer_cit_counts(NULL)") == len(after)
    finally:
        await c.close()
    await _assert_bulk_equal(url)                                                      # 증분 = bulk(seed-30 카테고리·seed-40 cit_off)
    await _app(url, OVERRIDE_OFF)
    await _drain(url)
    back = await _by_answer(url)
    assert {k: r["cit_off"] for k, r in back.items()} == {k: r["cit_off"] for k, r in before.items()}
    await _assert_bulk_equal(url)


# ════════════════════════════════════════════════════════════════════════════
# 채우기 SQL(back/migration/fill-cit-off.sql): 드라이런·배치·멱등·되돌림
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_fill_sql_dry_run_batches_and_idempotent(fresh_db):
    url = fresh_db
    want = {k: int(r["off_el"]) for k, r in (await _by_answer(url)).items()}
    assert sum(want.values()) > 0 and sum(1 for v in want.values() if v) >= 3
    c = await asyncpg.connect(url)
    notes: list[str] = []
    c.add_log_listener(lambda _c, m: notes.append(m.message))
    try:
        stale = await c.fetchval("SELECT answer_key FROM rd.answer WHERE cit_n > 0 AND cit_off = 0 ORDER BY answer_key LIMIT 1")
        assert stale is not None and want[stale] == 0
        await c.execute("UPDATE rd.answer SET cit_off = 0")                          # 패치 직후(DEFAULT 0)
        await c.execute("UPDATE rd.answer SET cit_off = 1 WHERE answer_key = $1", stale)   # 공식 인용 없는데 > 0(재실행 되돌림 대상)
        try:
            await c.fetchval("SELECT rd.assert_answer_cit_counts(NULL)")
            raise AssertionError("단언이 어긋남을 못 잡았다")
        except asyncpg.RaiseError as e:
            assert "자식 합" in str(e)
        dry = await run_psql_file(c, FILL_CIT_OFF, {})
        head = dry[1][0]
        assert head["target_answers"] == sum(1 for v in want.values() if v) + 1 and head["already_filled"] == 1
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE cit_off > 0") == 1       # 드라이런은 쓰지 않는다
        notes.clear()
        await run_psql_file(c, FILL_CIT_OFF, {"commit": "1", "batch": "2"})
        got = {int(r[0]): int(r[1]) for r in await c.fetch("SELECT answer_key, cit_off FROM rd.answer")}
        assert got == want
        done = [m for m in notes if m.startswith("fill-cit-off 끝")]
        assert done and done[-1].endswith(f"갱신 {sum(1 for v in want.values() if v) + 1} 행")
        assert sum(m.startswith("fill-cit-off 배치") for m in notes) == -(-head["target_answers"] // 2)   # 배치 = ceil(대상 / 2)
        notes.clear()
        await run_psql_file(c, FILL_CIT_OFF, {"commit": "1", "full_assert": "1"})
        assert [m for m in notes if m.startswith("fill-cit-off 끝")][-1].endswith("갱신 0 행")    # 멱등
        assert await c.fetchval("SELECT rd.assert_answer_cit_counts(NULL)") == len(want)
    finally:
        await c.close()
