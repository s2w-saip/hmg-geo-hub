"""긴 브랜드 표시명(비압축 3,000자, btree 키 상한 2,704 바이트 초과) 적재·재적재 = bulk (be/int3-longkey, 검증 D'').

결함: 표시 브랜드 쌍 임시 표 _ig_pairs(증분)·_bn_pair(시드)가 표시명 원문(dkey·disp)에 btree 유일 색인을 걸어, 비압축 2.7KB 를 넘는
Brand 표기가 있으면 'index row size … exceeds btree version 4 maximum 2704' 로 적재 트랜잭션 전체가 실패했다(재시도마다 반복 = run blocked).
수정 = 유일 색인 키를 md5(표시명)로 접고(값 비교·조인은 원문), 원문 등치 조회는 해시 색인. 같은 유형 = _ig_prior_url(be/int3-prior).
갈래 product(긴 제품 표기 → 자사 브랜드 롤업)는 임시 색인 수정으로, brand(검증 D'' 그대로: 긴 표기가 표시 브랜드 이름 자체)는 영구 표
rd.dim_brand_name name·bare 키를 md5 유일 + 해시 조회로 바꾼 DB-v2.29(가번호 DB-vNEXT-dim-brand-name-hash) 로 통과한다.
시나리오(프로필 끔·켬 각각, 일회 DB): bulk 시드(그 프로필) → loader 롤로 긴 Brand 언급을 부모 표로 넣고 apply → bulk 동치 → 표기를 다른 긴 문자열로
바꿔 재적재 → bulk 동치.
"""
from __future__ import annotations

import hashlib
import uuid

import asyncpg
import pytest

from app.core.config import set_settings
from app.core.profile import OFF, parse_profile
from ingest.project.apply.service import apply
from ingest.project.apply.tests.test_equivalence import _ctx, _keys
from ingest.testkit import bulk_equivalence, bulk_seed
from tests.support import needs_db


def _long_name(seed: str, n: int = 3000) -> str:
    """압축이 잘 안 되는 3,000자 표기(해시 사슬 16진, 문자·숫자만)."""
    h, out = seed.encode(), ""
    while len(out) < n:
        h = hashlib.sha256(h).digest()
        out += h.hex()
    return "Brand" + out[:n]


INS = ("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, "
       "brand_rollup_entity_id, type_mention) VALUES ('2026-09-01', $1, 78, $2, $3, $4, 1, 1.0, $5, 1)")
HYUNDAI = uuid.UUID("00000000-0000-0000-0000-000000000301")
# 갈래: (엔티티 유형, 롤업 대상). product = 긴 제품 표기가 자사 브랜드(Hyundai)로 롤업(표시 브랜드 이름은 롤업 대표 'Hyundai', 쌍 키만 긺),
#        brand = 자기 롤업 Brand 의 긴 표기(검증 D'' 그대로: 표시 브랜드 이름 자체가 긺 → 영구 표 rd.dim_brand_name name·bare UNIQUE btree 에 걸린다)
CASES = [pytest.param("Product", True, id="product"), pytest.param("Brand", False, id="brand")]


@needs_db
@pytest.mark.parametrize("etype, to_hyundai", CASES)
@pytest.mark.parametrize("spec", ["off", "current"])
async def test_long_brand_display_name_load_reload_equals_bulk(fresh_db, settings, spec, etype, to_hyundai):
    set_settings(settings.model_copy(update={"legacy_profile": spec}))
    prof = OFF if spec == "off" else parse_profile(spec)
    ent = uuid.uuid4()
    s = await asyncpg.connect(fresh_db)                                 # 시드 세션(슈퍼유저 임시 객체)과 적재 세션을 나눈다
    try:
        async with s.transaction():
            await bulk_seed(s, profile=prof)                           # 이 프로필로 투영된 출발점
    finally:
        await s.close()
    c = await asyncpg.connect(fresh_db)
    try:
        job = await c.fetchval("SELECT job_id FROM ing.answer WHERE run_month = '2026-09-01' AND status = 'completed' ORDER BY job_id LIMIT 1")
        for i, name in enumerate((_long_name("a"), _long_name("b"))):  # 적재 → 표기가 바뀐 재적재
            await c.execute("SET ROLE loader")
            try:
                async with c.transaction():
                    if i:
                        await c.execute("DELETE FROM ing.mention WHERE job_id = $1 AND ord = 78", job)
                    await c.execute(INS, job, ent, name, etype, HYUNDAI if to_hyundai else ent)
                    await apply(c, await _ctx(c), await _keys(c, "a.job_id = $1", job))
            finally:
                await c.execute("RESET ROLE")
            assert len(name.encode()) > 2704
            want = "Hyundai" if to_hyundai else name
            n = await c.fetchval("SELECT count(*) FROM rd.answer_brand ab JOIN rd.dim_brand_name b ON b.brand_key = ab.brand_key "
                                 "JOIN rd.job j ON j.answer_key = ab.answer_key WHERE j.job_id = $1 AND b.name = $2", job, want)
            assert n >= 1, (spec, i, "긴 표기 언급의 표시 브랜드 행이 투영됐다")
            strict, referenced = await bulk_equivalence(fresh_db)
            assert not strict and not referenced, (spec, i, strict, referenced)
    finally:
        await c.close()
