"""엔티티 버전 반영 계약(E1 → E4 미리보기·E5 반영이 쓴다). 투영 오버레이 자체는 queries.FACT_SRC·FACT_MR·ACR_NM 과
migration/seed/seed-4x-ecat.sql(seed-40 과 같은 파일)이고, 이 모듈은 "두 버전 사이에 어떤 답변을 다시 투영해야 하는가"만 계산한다.

영향 집합(impact, 두 버전 a → b)
  D  내용이 다른 엔티티: app.ecat_entity 의 의미 열(역할·자사 브랜드·병합 대상·모 브랜드·이름·유형)이 다른 것. 한쪽에만 행이 있으면
     없는 쪽 = 기본값(competitor, 병합·모 브랜드 없음)과 비교한다. D 로 병합되는(어느 버전에서든) 원본 엔티티를 더한다(대상의 제거·관계를 따른다).
     이어서 모 브랜드 참조를 따라간다: 어느 버전에서든 parent_brand_id 가 D 인 엔티티, 병합 대상(같은 버전)의 parent_brand_id 가 D 인
     엔티티(2단: 병합 원본은 대상의 관계를 따른다)를 더한다. 롤업 = coalesce(관계 덮어쓰기, Scope 롤업)이고 롤업 대상의 제거·이름이 투영에
     들어가므로, 롤업 대상이 D 이면 그 엔티티의 언급도 바뀐다(검증 반례 CE5: v2 Smart Fortwo 모 브랜드 = Toyota → v3 Toyota 제거).
  답변  언급(엔티티·브랜드 롤업) 또는 스탠스가 D 에 닿는 답변
       ∪ 차단 표면이 한쪽 버전에만 있는 표면 정의의 언급(표면 배열·발생 원문을 ecat_norm 으로 비교, 엔티티 한정이면 그 엔티티·병합 원본만)
       ∪ 추가 표면이 한쪽 버전에만 있거나 추가 표면 엔티티가 D 이거나 그 엔티티의 Scope 롤업(재매칭 행 롤업의 마지막 대체값)이 D 인
         표면의 ing.hub_match 적중 답변
  ACR  롤업 행의 엔티티·브랜드 롤업이 D 에 닿는 prompt-run
  차원 D(dim_entity.registry_role 은 활성 버전 투영: 활성화 뒤 REGISTRY_ROLE_REFRESH)
정확성 근거: 투영 규칙이 쓰는 버전 입력은 위 셋(엔티티 행·차단 표면·추가 표면)뿐이고, 각 입력이 닿는 원천 행을 그대로 따라간다.
시험 ingest/project/apply/tests/test_ecat_overlay.py 가 "영향 집합만 재투영 = 전량 bulk 시드" 를 행 단위로 대조한다.

이 모듈은 읽기 전용이다(rd 쓰기 위치는 결과 캐시 규약상 finalize 트랜잭션 함수 안에만 둔다: tests/core/rcache_writers.py). 쓰기는 E5
(ecat_engine.py)가 process_change(judgment_change 'entity_version') 안에서 아래 순서로 한다(청크마다 한 트랜잭션, 끝에 finalize 세대 +1.
실제 구현은 범위 회차를 현재 버전별로 묶어 이 함수를 버전마다 부르고, ⑤ 앞에 작업 답변을 대기 표시(ecat_ver = −새 버전)해 청크로 나눈다):
  ① 노출 회차 고정  UPDATE rd.cycle SET ecat_ver = <이전 버전> WHERE <노출 회차> AND ecat_ver IS NULL      (범위 unexposed·from_round)
  ② app.ecat_activate(b)                                                          (기존 명부·별칭 표 = b 의 투영)
  ③ rejudge.REGISTRY_ROLE_REFRESH                                                   (rd.dim_entity.registry_role = b)
  ④ service.project(conn, ctx, [], extra_keys=imp.answer_keys, extra_prompt_runs=imp.prompt_run_ids,
                     extra_entities=imp.entities, detect_global=False, ecat_ver=b, ecat_force=<범위 all>)
  ⑤ 범위 회차의 나머지 답변 버전 표시(내용은 두 버전에서 같다 = 영향 집합의 정의, ecat_ver 는 색인 열이 아니라 HOT):
       UPDATE rd.answer SET ecat_ver = b WHERE cyc_key = ANY(<범위 회차>) AND ecat_ver IS DISTINCT FROM b
  영향 답변이 escalate 상한(20만)을 넘으면 project 가 Escalated → leaf 재구축(시드 = hgh.ecat_ver·hgh.ecat_force GUC 로 같은 규칙).
되돌리기 = 이전 버전 내용의 새 초안(origin rollback)을 같은 흐름으로. 미리보기(E4)는 저장점 안에서 service.stage()(④ 의 앞 단계, 사실 행
쓰기 없음)만 초안 버전으로 돌려 임시 표(_ig_own·_ig_ab)를 읽고 저장점을 되돌린다(rd 불변, 근거는 ecat_engine.py 머리 주석).
시험의 쓰기 흐름 = tests/test_ecat_overlay.py _apply_version(E1), 큐 경로 전체 = tests/test_ecat_apply.py(E4·E5).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import asyncpg

# 두 버전의 엔티티 의미 열 차이 + 병합 원본(어느 버전이든 D 로 병합되는 엔티티) + 모 브랜드 참조(자기 관계 또는 병합 대상의 관계가 D 를
#   가리키는 엔티티, seed-3x-common §4-2 _ecat_x.parent = coalesce(자기, 병합 대상)와 같은 2단)
DIFF_ENTITIES = """
WITH a AS (SELECT * FROM app.ecat_entity WHERE ver = $1), b AS (SELECT * FROM app.ecat_entity WHERE ver = $2),
d0 AS (
  SELECT coalesce(a.entity_id, b.entity_id) AS entity_id
    FROM a FULL JOIN b ON b.entity_id = a.entity_id
   WHERE (coalesce(a.role, 'competitor'), a.brand_code, a.merge_into, a.parent_brand_id, a.name, a.entity_type)
         IS DISTINCT FROM (coalesce(b.role, 'competitor'), b.brand_code, b.merge_into, b.parent_brand_id, b.name, b.entity_type)),
d1 AS (SELECT entity_id FROM d0
       UNION SELECT e.entity_id FROM app.ecat_entity e WHERE e.ver IN ($1, $2) AND e.merge_into IN (SELECT entity_id FROM d0))
SELECT entity_id FROM d1
UNION SELECT e.entity_id FROM app.ecat_entity e WHERE e.ver IN ($1, $2) AND e.parent_brand_id IN (SELECT entity_id FROM d1)
UNION SELECT e.entity_id FROM app.ecat_entity e JOIN app.ecat_entity t ON t.ver = e.ver AND t.entity_id = e.merge_into
       WHERE e.ver IN ($1, $2) AND t.parent_brand_id IN (SELECT entity_id FROM d1)
"""
# 한쪽 버전에만 켜진 표면(동작까지 같아야 같은 것으로 본다)
DIFF_SURFACES = """
WITH a AS (SELECT surface_id, action FROM app.ecat_surface WHERE ver = $1), b AS (SELECT surface_id, action FROM app.ecat_surface WHERE ver = $2),
x AS (SELECT * FROM a EXCEPT SELECT * FROM b UNION (SELECT * FROM b EXCEPT SELECT * FROM a))
SELECT x.surface_id, x.action, d.entity_id, d.surface_norm FROM x JOIN app.ecat_surface_def d ON d.surface_id = x.surface_id
"""
KEYS_OF_ENTITIES = """
WITH jobs AS (SELECT job_id FROM ing.mention WHERE entity_id = ANY($1::uuid[]) OR brand_rollup_entity_id = ANY($1::uuid[])
              UNION SELECT job_id FROM ing.answer_stance WHERE entity_id = ANY($1::uuid[]))
SELECT j.answer_key FROM rd.job j WHERE j.job_id IN (SELECT job_id FROM jobs)
"""
PRS_OF_ENTITIES = """
SELECT DISTINCT prompt_run_id FROM ing.acr_rollup_row WHERE entity_id = ANY($1::uuid[]) OR brand_rollup_entity_id = ANY($1::uuid[])
"""
# 차단 표면 차이: 원문 표면(언급 표면 배열 ∪ 발생 원문)을 정규화해 맞춘다. $1 = surface_norm[], $2 = 엔티티 한정(NULL = 전역)[],
#   $3 = 버전 쌍(병합 원본 확장용). 세션에 seed-3x-common §10 함수(pg_temp.ecat_norm)가 있어야 한다(rules.ensure_session_rules).
KEYS_OF_BLOCKS = """
WITH blk AS (SELECT normalize(n, NFC) AS norm, e AS entity_id FROM unnest($1::text[], $2::uuid[]) AS t(n, e)),
blk_x AS (SELECT norm, entity_id FROM blk
          UNION SELECT b.norm, s.entity_id FROM blk b JOIN app.ecat_entity s ON s.ver = ANY($3::int4[]) AND s.merge_into = b.entity_id),
raws AS (SELECT DISTINCT u AS raw FROM ing.mention m CROSS JOIN LATERAL unnest(m.surfaces) u
         UNION SELECT DISTINCT surface_text FROM ing.mention_occurrence),
hit AS (SELECT r.raw, x.entity_id FROM raws r JOIN blk_x x ON x.norm = pg_temp.ecat_norm(r.raw)),
jobs AS (
  SELECT m.job_id FROM ing.mention m
   WHERE EXISTS (SELECT 1 FROM unnest(m.surfaces) u JOIN hit h ON h.raw = u WHERE h.entity_id IS NULL OR h.entity_id = m.entity_id)
  UNION
  SELECT o.job_id FROM ing.mention_occurrence o JOIN hit h ON h.raw = o.surface_text WHERE h.entity_id IS NULL OR h.entity_id = o.entity_id)
SELECT j.answer_key FROM rd.job j WHERE j.job_id IN (SELECT job_id FROM jobs)
"""
KEYS_OF_HUB = """
SELECT DISTINCT j.answer_key FROM ing.hub_match h JOIN rd.job j ON j.job_id = h.job_id WHERE h.surface_id = ANY($1::int4[])
"""
ADD_SURFACES_OF_ENTITIES = """
SELECT DISTINCT s.surface_id FROM app.ecat_surface s JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id
 WHERE s.ver IN ($1, $2) AND s.action = 'add'
   AND (d.entity_id = ANY($3::uuid[])
        OR EXISTS (SELECT 1 FROM ing.mention m WHERE m.entity_id = d.entity_id AND m.brand_rollup_entity_id = ANY($3::uuid[])))
"""


@dataclass
class EcatImpact:
    """두 버전 사이 재투영 대상. answer_keys·prompt_run_ids 를 project(extra_keys·extra_prompt_runs)에, entities 를 extra_entities 에 넘긴다."""
    from_ver: int
    to_ver: int
    entities: list[Any] = field(default_factory=list)
    block_surfaces: list[int] = field(default_factory=list)
    add_surfaces: list[int] = field(default_factory=list)
    answer_keys: list[int] = field(default_factory=list)
    prompt_run_ids: list[Any] = field(default_factory=list)


async def impact(conn: asyncpg.Connection, from_ver: int, to_ver: int) -> EcatImpact:
    """from_ver → to_ver 로 바꿀 때 다시 투영할 답변·ACR prompt-run·차원 엔티티(읽기 전용, rd·ing 쓰기 없음)."""
    from ingest.common.rules import ensure_session_rules

    await ensure_session_rules(conn)
    out = EcatImpact(int(from_ver), int(to_ver))
    out.entities = [r[0] for r in await conn.fetch(DIFF_ENTITIES, out.from_ver, out.to_ver)]
    surf = await conn.fetch(DIFF_SURFACES, out.from_ver, out.to_ver)
    out.block_surfaces = sorted({int(r["surface_id"]) for r in surf if r["action"] == "block"})
    adds = {int(r["surface_id"]) for r in surf if r["action"] == "add"}
    if out.entities:
        adds |= {int(r[0]) for r in await conn.fetch(ADD_SURFACES_OF_ENTITIES, out.from_ver, out.to_ver, out.entities)}
    out.add_surfaces = sorted(adds)
    keys: set[int] = set()
    if out.entities:
        keys |= {int(r[0]) for r in await conn.fetch(KEYS_OF_ENTITIES, out.entities)}
        out.prompt_run_ids = [r[0] for r in await conn.fetch(PRS_OF_ENTITIES, out.entities)]
    blk = [r for r in surf if r["action"] == "block"]
    if blk:
        keys |= {int(r[0]) for r in await conn.fetch(KEYS_OF_BLOCKS, [r["surface_norm"] for r in blk], [r["entity_id"] for r in blk],
                                                        [out.from_ver, out.to_ver])}
    if out.add_surfaces:
        keys |= {int(r[0]) for r in await conn.fetch(KEYS_OF_HUB, out.add_surfaces)}
    out.answer_keys = sorted(keys)
    return out


__all__ = ["EcatImpact", "impact"]
