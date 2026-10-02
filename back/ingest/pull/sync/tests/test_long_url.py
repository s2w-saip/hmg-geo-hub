"""긴 인용 URL(btree 키 상한 2,704 바이트 초과) 적재·재적재·재투영 = bulk (be/int3-prior, stg 4차 결함).

결함: 옛 자식 행 스냅샷 _ig_prior_url 이 URL 원문에 PK 를 걸어, 3,160 바이트 인용 URL 이 있는 답변을 다시 받으면 적재 트랜잭션 전체가
실패했다(재시도마다 같은 실패 → run blocked). 수정 = 키를 url_hash(= rd.dim_url.url_hash = sha256(url))로.
시나리오(가짜 Scope 원천, loader 롤, 일회 DB):
  ① 첫 적재: j101 이 긴 URL 을 인용 → dim_url 1행, rd = bulk
  ② 재적재(재분석으로 j101 언급이 바뀜, 긴 URL 인용 유지): 옛 자식 스냅샷에 긴 URL 이 들어간다 → 커밋, rd = bulk
  ③ 재투영(service.reproject, 적재 없이 사실 행 다시 쓰기) → rd = bulk
  ④ 재적재로 긴 URL 인용이 빠짐 → 고아 dim_url 정리(해시 키 조인), rd = bulk
"""
from __future__ import annotations

import hashlib

import asyncpg

from ingest.common.db import LoaderDB
from ingest.project.apply.service import reproject
from ingest.project.apply.tests.test_equivalence import _ctx
from ingest.pull.sync.service import run_pass
from ingest.pull.sync.tests.test_pull import NOW, R10, ROOT, TOY, _j, _rows, _settings, _source
from ingest.testkit import bulk_equivalence
from tests.support import needs_db


def _long_url(nbytes: int = 3200) -> str:
    """압축이 잘 안 되는(해시 사슬 16진) 긴 URL. btree 색인 튜플은 압축 뒤에도 2,704 바이트를 넘는다."""
    h, parts = b"seed", []
    while sum(len(p) for p in parts) < nbytes:
        h = hashlib.sha256(h).digest()
        parts.append(h.hex())
    return "https://long-url.example.com/path?q=" + "".join(parts)[:nbytes]


LONG = _long_url()


def _src(*, cite_long: bool, drop_toyota: bool):
    src = _source()
    j101 = next(j for j in src.jobs[R10] if j["job_id"] == _j(101))
    if cite_long:
        j101["result"]["citations"].append({"url": LONG, "title": "long"})
    if drop_toyota:
        j101["analysis"]["resolved_mentions"] = [m for m in j101["analysis"]["resolved_mentions"] if m["entity_id"] != TOY]
    return src


async def _eq(url: str) -> None:
    strict, referenced = await bulk_equivalence(url)
    assert not strict and not referenced, (strict, referenced)


@needs_db
async def test_long_citation_url_load_reload_reproject_equals_bulk(fresh_db):
    assert len(LONG.encode()) > 3000
    db = LoaderDB(fresh_db, role="loader")
    n_long = "SELECT count(*) FROM rd.dim_url WHERE url_hash = sha256(convert_to($1, 'UTF8'))"
    # ① 첫 적재
    rep = await run_pass(db, _src(cite_long=True, drop_toyota=False), project=ROOT, now=NOW, settings=_settings())
    assert rep.error is None and [r.status for r in rep.runs] == ["committed"], rep
    assert (await _rows(fresh_db, n_long, LONG))[0][0] == 1
    await _eq(fresh_db)
    # ② 재적재(j101 이 바뀐다 = 옛 자식 스냅샷에 긴 URL)
    rep = await run_pass(db, _src(cite_long=True, drop_toyota=True), project=ROOT, now=NOW, force=True, settings=_settings())
    assert [(r.status, r.jobs_changed) for r in rep.runs if str(r.run_id) == R10] == [("committed", 1)], rep
    assert (await _rows(fresh_db, n_long, LONG))[0][0] == 1
    await _eq(fresh_db)
    # ③ 재투영(j101 답변, loader 롤 한 트랜잭션)
    c = await asyncpg.connect(fresh_db)
    try:
        ak = await c.fetchval("SELECT answer_key FROM ing.answer_key_map WHERE job_id = $1::uuid", _j(101))
        await c.execute("SET ROLE loader")
        async with c.transaction():
            ctx = await _ctx(c)
            res = await reproject(c, ctx, [int(ak)])
        await c.execute("RESET ROLE")
        assert res.answers >= 1
    finally:
        await c.close()
    await _eq(fresh_db)
    # ④ 긴 URL 인용이 빠진 재적재 → 고아 dim_url 정리(해시 키)
    rep = await run_pass(db, _src(cite_long=False, drop_toyota=True), project=ROOT, now=NOW, force=True, settings=_settings())
    assert [(r.status, r.jobs_changed) for r in rep.runs if str(r.run_id) == R10] == [("committed", 1)], rep
    assert (await _rows(fresh_db, n_long, LONG))[0][0] == 0
    assert (await _rows(fresh_db, "SELECT count(*) FROM ing.citation WHERE url = $1", LONG))[0][0] == 0
    await _eq(fresh_db)
