"""E1 엔티티 버전 투영 오버레이 수용 기준(설계 hmg-entity-management-versioning-design-20261001.md 2-3·8절 E1, 제품 결정 26~29).

1. v1(운영 명부 그대로 이관) 전량 재투영 = 이관 전 rd: leaf 4표(answer·answer_brand·answer_stance·acr_choice) md5 차이 0(증분·bulk 둘 다),
   bulk 시드 = 증분 행 단위 차이 0(testkit 동치 판정과 같은 식).
2. v2 픽스처 각각 기대 행(손 계산): 제거 1(Apple: 언급·스탠스·ACR 행) + 제거 대상 롤업(Tata → Hyundai Creta 브랜드 귀속 상실),
   차단 전부(Epit 9월 발생 / 8월 표면 배열)·일부(Hyundai 의 N: 9월 발생 = 개수 재계산, 8월 = 불변 근사), 병합 1(TOYOTA → Toyota),
   관계 1(Smart Fortwo → Kia), 재매칭 추가(Scope 언급 가산·새 언급·존재만·Scope 발생 겹침 제거·본문 해시 불일치 무시).
3. G20: 병합으로 같은 표시 브랜드의 롤업 id 가 하나가 되면 rid_n 2 → 1(답변 × 표시 브랜드 1행 유지).
4. 재매칭 언급은 감성 KPI 분모(sent_all = 감성 4종 합, app.core.measure)를 바꾸지 않는다(언급 수 분모는 바뀐다).
5. 영향 집합(ecat.impact)만 재투영 + 버전 표시 = 전량 bulk 시드(행 단위), rd.answer.ecat_ver 전수 = 새 버전.
6. 회차 고정(rd.cycle.ecat_ver): 고정 회차는 이전 버전 값·표시, 전량 재구축(seed-30 → seed-40)이 고정을 보존한다.
   강제 미리보기(ecat_force, 이전 버전) = 반영 전 rd md5(되돌리기).
증분 경로는 loader 롤(SET ROLE)로 돌려 새 객체(app.ecat_*·ing.hub_match·rd.cycle.ecat_ver) 권한도 확인한다. 전부 롤백(복제본 불변).
"""
from __future__ import annotations

import hashlib
import time
import uuid

import asyncpg

from app.core.ecat.matcher import SurfaceSpec, compile_surfaces, scan_text
from app.core.ecat.text import normalize_surface
from app.core.measure import own_cols, ratios
from ingest.common.db import LoadContext, current_rule_ver
from ingest.project.apply.ecat import EcatImpact, impact
from ingest.project.apply.rejudge import REGISTRY_ROLE_REFRESH
from ingest.project.apply.service import apply, project
from ingest.testkit import EQ_TABLES, bulk_seed, diff, referenced_extras, snapshot, strict_diff
from tests.support import DB_URL, needs_db

LEAF = ("rd.answer", "rd.answer_brand", "rd.answer_stance", "rd.acr_choice")
ACTOR = uuid.UUID("7e000000-0000-4000-8000-0000000000e0")
HYUNDAI, KIA, GENESIS = (uuid.UUID(f"00000000-0000-0000-0000-000000000{n}") for n in (301, 302, 304))
KIA_KO = uuid.UUID("ed4b8012-4a73-4174-9b43-4cb696934b25")
TOYOTA, TOYOTA2, APPLE = (uuid.UUID(f"71000000-0000-4000-8000-00000000000{n}") for n in (1, 2, 3))
CRETA, TATA, SMART, FORTWO = (uuid.UUID(f"71000000-0000-4000-8000-00000000000{n}") for n in (4, 5, 6, 7))
EPIT = uuid.UUID("7b000000-0000-4000-8000-000000000001")
POLESTAR = uuid.UUID("7b000000-0000-4000-8000-000000000002")              # 허브 추가 엔티티(Scope 에 없음)
IONIQ = uuid.UUID("7b000000-0000-4000-8000-000000000003")                 # Hyundai 로 롤업되는 제품(v2 제거: 살아 있는 브랜드 아래 제거)
J1, J2, J3 = (uuid.UUID(f"90000000-0000-4000-8000-00000000000{n}") for n in (1, 2, 3))
RX = uuid.UUID("e0000000-0000-4000-8000-0000000000e1")                    # 회차 12(루트 프로젝트, 앵커 09-21 00:30) 합성 run


def rx_cycle() -> int:
    """합성 run RX(JA·JB·JC·JD)가 투영되는 회차 키. RX 는 원장 회차 12 멤버인데 run 5 와 같은 코호트(앵커 09-21 00:30)이고 그 코호트에
    픽스처 pin(job 17 → 09-07)이 있다: hub 규칙(코호트 pin → 원장 선택)은 RX 를 노출 회차 10 으로, 현행 프로필 resub_phantom_exclude
    (답변 회차 = run 원장 멤버십)는 비노출 회차 12 로 귀속한다. 손 계산 기대값 중 회차에 걸린 것은 이 값으로 가른다(활성 프로필 = 시험 프로필)."""
    from app.core.profile import active_profile

    return 12 if active_profile().resub_phantom_exclude else 10
JA, JB, JC, JD = (uuid.UUID(f"9e000000-0000-4000-8000-0000000000a{n}") for n in (1, 2, 3, 4))

REGISTRY = [  # tests/core/test_db_v217.py 와 같은 명부(own 4 · excluded 2). KIA_KO 는 픽스처 별칭과 겹친다
    (HYUNDAI, "Hyundai", "own", "Hyundai"), (KIA, "Kia", "own", "Kia"), (GENESIS, "Genesis", "own", "Genesis"),
    (KIA_KO, "기아", "own", "Kia"), (APPLE, "Apple", "excluded", None), (SMART, "smart", "excluded", "Hyundai"),
]

# 합성 답변(고객 데이터 아님). JA·JB = 9월 적재(발생 행 있음), JC = 8월 모양(발생 행 없음), JD = Scope 언급 없음
TEXT = {
    JA: "Hyundai Ioniq is great. Hyundai N is sporty. Genesis GV80 and Polestar 2 compete.",
    JB: "The Epit platform is new.",
    JC: "Hyundai N and EPIT with Ioniq and Polestar.",
    JD: "Polestar 2 review.",
}
HASH = {JA: b"\xa1", JB: b"\xa2", JC: b"\xa3", JD: b"\xa4"}


def _at(job: uuid.UUID, s: str, nth: int = 0) -> tuple[int, int]:
    t, i = TEXT[job], -1
    for _ in range(nth + 1):
        i = t.index(s, i + 1)
    return i, i + len(s)


def _synth_sql() -> str:
    """run RX(회차 12) + JA·JB·JC·JD 답변·언급·발생 + J1 의 Apple 스탠스(제거 시 스탠스 제외 확인용)."""
    ha0, ha1, hn, io = _at(JA, "Hyundai"), _at(JA, "Hyundai", 1), _at(JA, "N"), _at(JA, "Ioniq")
    gen, ep = _at(JA, "Genesis"), _at(JB, "Epit")
    ans = ",\n".join(
        f"('{j}', '{m}', {n}, '\\x{HASH[j].hex()}', $t${TEXT[j]}$t$)"
        for j, m, n in ((JA, "2026-09-21 03:00+00", 3), (JB, "2026-09-21 03:10+00", 1), (JC, "2026-08-10 03:00+00", 2),
                        (JD, "2026-09-21 03:20+00", 0)))
    return f"""
INSERT INTO ing.answer_stance (run_month, job_id, turn_index, entity_id, brand_label, stance)
VALUES ('2026-09-01', '{J1}', 0, '{APPLE}', 'Apple', 'positive');
-- 키는 max+1 로 명시한다(픽스처가 OVERRIDING SYSTEM VALUE 로 넣어 새 복제본의 식별 순번이 1 에 머문다)
INSERT INTO ing.run (run_id, run_key, scope_project_id, run_month, status, total_jobs, started_at, cycle_anchor_at, sync_state) OVERRIDING SYSTEM VALUE
SELECT '{RX}', (SELECT max(run_key) + 1 FROM ing.run), 'a0000000-0000-4000-8000-000000000001', '2026-09-01', 'completed', 4,
       '2026-09-21 02:00+00', '2026-09-21 00:30+00', 'loaded';
INSERT INTO ing.cycle_run (run_id, cycle_id, attributed_by) VALUES ('{RX}', 'f0000000-0000-4000-8000-000000000012', 'scope');
INSERT INTO ing.answer_key_map (job_id, answer_key, run_month) OVERRIDING SYSTEM VALUE
SELECT j, (SELECT max(answer_key) FROM ing.answer_key_map) + n, '2026-09-01'
  FROM (VALUES ('{JA}'::uuid, 1), ('{JB}'::uuid, 2), ('{JC}'::uuid, 3), ('{JD}'::uuid, 4)) v(j, n);
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions,
                        n_citations, content_hash, load_id, answer_text)
SELECT '2026-09-01', k.job_id, k.answer_key, '{RX}', 'b0000000-0000-4000-8000-000000000001', 'chatgpt', 'US', 'completed', v.m::timestamptz,
       'completed', v.n, 0, v.h::bytea, 1, v.t
  FROM ing.answer_key_map k JOIN (VALUES {ans}) v(j, m, n, h, t) ON v.j::uuid = k.job_id;
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, sentiment_positive, sentiment_neutral,
                         sentiment_negative, sentiment_mixed, avg_position, surfaces, brand_rollup_entity_id, type_mention) VALUES
  ('2026-09-01', '{JA}', 1, '{HYUNDAI}', 'Hyundai', 'Brand', 3, 2, 0, 1, 0, 1, ARRAY['Hyundai', 'N'], '{HYUNDAI}', 3),
  ('2026-09-01', '{JA}', 2, '{GENESIS}', 'Genesis', 'Brand', 1, 1, 0, 0, 0, 2, ARRAY['Genesis'], '{GENESIS}', 1),
  ('2026-09-01', '{JA}', 3, '{IONIQ}', 'Ioniq', 'Product', 1, 1, 0, 0, 0, 1.5, ARRAY['Ioniq'], '{HYUNDAI}', 1),
  ('2026-09-01', '{JB}', 1, '{EPIT}', 'Epit', 'Brand', 1, 0, 1, 0, 0, 1, ARRAY['Epit'], '{EPIT}', 1),
  ('2026-09-01', '{JC}', 1, '{HYUNDAI}', 'Hyundai', 'Brand', 2, 1, 0, 1, 0, 1, ARRAY['Hyundai', 'N'], '{HYUNDAI}', 2),
  ('2026-09-01', '{JC}', 2, '{EPIT}', 'EPIT', 'Brand', 1, 0, 1, 0, 0, 2, ARRAY['EPIT'], '{EPIT}', 1);
INSERT INTO ing.mention_occurrence (run_month, job_id, ord, entity_id, brand_rollup_entity_id, turn_index, source_start, source_end,
                                    surface_text, sentiment) VALUES
  ('2026-09-01', '{JA}', 1, '{HYUNDAI}', '{HYUNDAI}', 1, {ha0[0]}, {ha0[1]}, 'Hyundai', 'positive'),
  ('2026-09-01', '{JA}', 2, '{HYUNDAI}', '{HYUNDAI}', 1, {ha1[0]}, {ha1[1]}, 'Hyundai', 'positive'),
  ('2026-09-01', '{JA}', 3, '{HYUNDAI}', '{HYUNDAI}', 1, {hn[0]}, {hn[1]}, 'N', 'negative'),
  ('2026-09-01', '{JA}', 4, '{GENESIS}', '{GENESIS}', 1, {gen[0]}, {gen[1]}, 'Genesis', 'positive'),
  ('2026-09-01', '{JA}', 5, '{IONIQ}', '{HYUNDAI}', 1, {io[0]}, {io[1]}, 'Ioniq', 'positive'),
  ('2026-09-01', '{JB}', 1, '{EPIT}', '{EPIT}', 1, {ep[0]}, {ep[1]}, 'Epit', 'neutral');
"""


REG_SQL = "INSERT INTO app.entity_registry (entity_id, name, role, brand_code, updated_by) VALUES ($1, $2, $3, $4, $5)"
ADD_SURFACES = [("Ioniq", HYUNDAI), ("Hyundai N", HYUNDAI), ("GV80", GENESIS), ("Polestar", POLESTAR)]
BLOCK_SURFACES = [("epit", None), ("N", HYUNDAI)]


async def _ctx(c: asyncpg.Connection) -> LoadContext:
    rv = await current_rule_ver(c)
    lid = await c.fetchval("INSERT INTO ing.load (kind, rule_ver) VALUES ('run', $1) RETURNING load_id", rv)
    return LoadContext(load_id=int(lid), kind="run", rule_ver=rv)


async def _all_keys(c: asyncpg.Connection) -> list[int]:
    return [r[0] for r in await c.fetch("SELECT k.answer_key FROM ing.answer a JOIN ing.answer_key_map k ON k.job_id = a.job_id")]


async def _all_prs(c: asyncpg.Connection) -> list[uuid.UUID]:
    return [r[0] for r in await c.fetch("SELECT prompt_run_id FROM ing.acr_prompt_run")]


async def _key(c: asyncpg.Connection, job: uuid.UUID) -> int:
    return int(await c.fetchval("SELECT answer_key FROM ing.answer_key_map WHERE job_id = $1", job))


async def _leaf_md5(c: asyncpg.Connection) -> dict[str, str]:
    """자연 키 스냅샷(testkit.snapshot: 정수 차원 키 → 자연 키, load_id 제외) 의 표별 md5."""
    snap = await snapshot(c, LEAF)
    return {t: hashlib.md5(repr(snap[t]).encode()).hexdigest() for t in LEAF}


async def _raw_md5(c: asyncpg.Connection) -> dict[str, str]:
    """원시 행(정수 키 그대로, load_id 만 뺀 전 열) md5. 같은 키 공간(증분 경로끼리) 비교용."""
    out = {}
    for t in LEAF:
        out[t] = await c.fetchval(f"SELECT md5(coalesce(string_agg(x, E'\\n' ORDER BY x), '')) FROM "
                                  f"(SELECT (to_jsonb(t) - 'load_id')::text AS x FROM {t} t) q")
    return out


STAMP_VERSION = "UPDATE rd.answer SET ecat_ver = $1::int2 WHERE cyc_key = ANY($2::int4[]) AND ecat_ver IS DISTINCT FROM $1::int2"


async def _apply_version(c: asyncpg.Connection, ctx: LoadContext, imp: EcatImpact, cyc_keys: list[int]) -> tuple:
    """E5 반영 흐름 ③~⑤(ingest/project/apply/ecat.py 머리 주석): 차원 역할 → 영향 집합만 새 버전으로 재투영 → 범위 회차 버전 표시."""
    await c.execute(REGISTRY_ROLE_REFRESH)
    res = await project(c, ctx, [], extra_keys=imp.answer_keys, extra_prompt_runs=imp.prompt_run_ids, extra_entities=imp.entities,
                        detect_global=False, ecat_ver=imp.to_ver)
    tag = await c.execute(STAMP_VERSION, imp.to_ver, cyc_keys)
    return res, int(str(tag).split()[-1])


async def _as_loader(c: asyncpg.Connection, coro_fn):
    await c.execute("SET ROLE loader")
    try:
        async with c.transaction():
            return await coro_fn()
    finally:
        await c.execute("RESET ROLE")


async def _brands(c: asyncpg.Connection, job: uuid.UUID) -> dict[tuple[str, bool], tuple]:
    """답변의 표시 브랜드 행을 (소문자 bare, 경쟁) 로 접어 본다. 끔은 bare 가 이미 소문자라 행 그대로다. 현행 프로필 NAME 은 bare = 정본 표시명
    그대로라 대소문자 표기가 다른 행('Toyota'·'TOYOTA')이 따로 있다(운영 생성기와 같다): 이 시험들은 엔티티 버전 귀속을 보므로 그 행들을 합친다
    (가산 열은 합, 순위 rk 는 0(순위 없음)을 뺀 최소 = 끔의 한 행 값과 같다, be/int3-name2)."""
    rows = await c.fetch("""
        SELECT lower(b.bare) AS bare, ab.competitive, max(ab.own_bit) AS own_bit, sum(ab.entity_rows)::int AS entity_rows, sum(ab.rid_n)::int AS rid_n,
               sum(ab.mention_count)::int AS mention_count, coalesce(min(nullif(ab.rk, 0)), 0)::int AS rk, sum(ab.s_pos)::int AS s_pos, sum(ab.s_neu)::int AS s_neu,
               sum(ab.s_neg)::int AS s_neg, sum(ab.s_mix)::int AS s_mix, sum(ab.t_mention)::int AS t_mention
          FROM rd.job j JOIN rd.answer_brand ab ON ab.surface = j.surface AND ab.round_date = j.round_date AND ab.answer_key = j.answer_key
          JOIN rd.dim_brand_name b ON b.brand_key = ab.brand_key WHERE j.job_id = $1
         GROUP BY lower(b.bare), ab.competitive""", job)
    return {(r["bare"], r["competitive"]): tuple(r)[2:] for r in rows}


async def _answer(c: asyncpg.Connection, job: uuid.UUID) -> asyncpg.Record:
    return await c.fetchrow("""SELECT a.* FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date
                                AND a.answer_key = j.answer_key WHERE j.job_id = $1""", job)


async def _stage_v1(c: asyncpg.Connection) -> LoadContext:
    """명부 6행 + 합성 입력 → v1 이관 전 상태로 전량 투영(legacy) 은 호출자가."""
    for eid, name, role, code in REGISTRY:
        await c.execute(REG_SQL, eid, name, role, code, None)
    await c.execute(_synth_sql())
    return await _ctx(c)


async def _make_v2(c: asyncpg.Connection, ctx: LoadContext, *, activate: bool = True) -> int:
    """v1 을 복사한 초안 v2 에 편집(제거 2·병합 1·관계 1·허브 엔티티 1·차단 2·추가 4)을 넣고 재스캔 결과(ing.hub_match)를 쓴 뒤 활성화
    (activate=False = 초안으로 둔다: E4·E5 시험이 미리보기·반영 흐름으로 활성화한다)."""
    v2 = await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, created_by) VALUES (1, 'v2 시험', '픽스처', $1) RETURNING ver",
                          ACTOR)
    await c.execute("""INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id,
                                                    note, updated_by, updated_at)
                       SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by, updated_at
                         FROM app.ecat_entity WHERE ver = 1""", v2)
    await c.execute("UPDATE app.ecat_entity SET role = 'removed' WHERE ver = $1 AND entity_id = $2", v2, APPLE)       # 숨김 → 제거
    await c.executemany(
        "INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, merge_into, parent_brand_id, updated_by) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [(v2, TATA, "scope", "Tata", "Brand", "removed", None, None, ACTOR),
         (v2, IONIQ, "scope", "Ioniq", "Product", "removed", None, None, ACTOR),
         (v2, TOYOTA2, "scope", "TOYOTA", "Brand", "competitor", TOYOTA, None, ACTOR),
         (v2, FORTWO, "scope", "Smart Fortwo", "Product", "competitor", None, KIA, ACTOR),
         (v2, POLESTAR, "hub", "Polestar", "Brand", "competitor", None, None, ACTOR)])
    sids: dict[str, int] = {}
    for surf, ent, action in [*((s, e, "block") for s, e in BLOCK_SURFACES), *((s, e, "add") for s, e in ADD_SURFACES)]:
        sid = await c.fetchval("INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, created_by) VALUES ($1, $2, $3, $4) "
                               "RETURNING surface_id", ent, surf, normalize_surface(surf), ACTOR)
        await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) VALUES ($1, $2, $3)", v2, sid, action)
        sids[surf] = sid
    # E2 재스캔이 쓸 행을 매처로 만든다(본문 턴 1 = 단일 턴 답변). JD 에는 본문 해시가 다른 낡은 GV80 행을 하나 둔다(무시돼야 한다)
    compiled = compile_surfaces(SurfaceSpec(sids[s], e, s) for s, e in ADD_SURFACES)
    await c.execute("SELECT rd.ensure_hub_match_leaf('2026-09-01')")
    rows = []
    for job, text in TEXT.items():
        for sc in scan_text(text, compiled).values():
            rows.append((sc.surface_id, job, sc.entity_id, sc.n_occ, sc.first_start, list(sc.starts), list(sc.ends), HASH[job]))
    rows.append((sids["GV80"], JD, GENESIS, 1, 0, [0], [4], b"\xff"))
    await c.executemany("INSERT INTO ing.hub_match (surface_id, run_month, job_id, turn_index, entity_id, n_occ, first_start, starts, ends, "
                        "answer_hash, load_id) VALUES ($1, '2026-09-01', $2, 1, $3, $4, $5, $6, $7, $8, " + str(ctx.load_id) + ")", rows)
    # 전체 스캔 완료 원장(E4·E5 스캔 완결 확인 ECAT_SCAN_PENDING 이 읽는다): 위 행이 곧 전 기간 스캔 결과다
    await c.executemany("INSERT INTO ing.hub_match_scan (surface_id, scanned_to_load_id, answers_scanned, hits) VALUES ($1, $2, $3, 0)",
                        [(sids[s], ctx.load_id, len(TEXT)) for s, _ in ADD_SURFACES])
    if activate:
        await c.execute("SELECT app.ecat_activate($1)", v2)
    return int(v2)


@needs_db
async def test_v1_cutover_reprojection_md5_identical():
    """수용 기준 1: 이관 전(legacy) 전량 재투영 → v1 이관 → 전량 재투영(증분) = md5 차이 0, bulk 시드도 같다, 증분 = bulk 행 단위."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        ctx = await _stage_v1(c)
        keys, prs = await _all_keys(c), await _all_prs(c)
        await _as_loader(c, lambda: apply(c, ctx, keys))                           # legacy(버전 없음) 기준선: 명부·합성 입력 반영
        md0, raw0 = await _leaf_md5(c), await _raw_md5(c)
        cut = await c.fetchrow("SELECT * FROM app.ecat_cutover_v1($1, 'E1 시험')", ACTOR)
        assert (cut["ver"], cut["own_rows"], cut["hidden_rows"]) == (1, 4, 2)
        t0 = time.perf_counter()
        r = await _as_loader(c, lambda: project(c, ctx, [], extra_keys=keys, extra_prompt_runs=prs, detect_global=False))
        took = time.perf_counter() - t0
        md1, raw1 = await _leaf_md5(c), await _raw_md5(c)
        vers = dict(await c.fetch("SELECT ecat_ver, count(*) FROM rd.answer GROUP BY 1"))
        got = await snapshot(c, EQ_TABLES)
        sp = c.transaction()
        await sp.start()
        await bulk_seed(c)                                                          # v1 활성 상태의 bulk 재구축
        md2 = await _leaf_md5(c)
        ref = await snapshot(c, EQ_TABLES)
        await sp.rollback()
        d = diff(ref, got)
        referenced = await referenced_extras(c, d)
        await tr.rollback()
    finally:
        await c.close()
    assert r.answers == len(keys) - 2                                               # 서빙 = 비완료 1·드롭 1 뺀 전부
    assert md1 == md0 and raw1 == raw0, "v1 증분 재투영이 이관 전 rd 와 다르다"
    assert md2 == md0, "v1 bulk 재구축이 이관 전 rd 와 다르다"
    assert vers == {1: len(keys) - 2}
    assert not strict_diff(d) and not referenced, d
    print(f"v1 전량 증분 재투영 {len(keys)} 답변 {took:.2f}s")


@needs_db
async def test_v2_overlay_rows_impact_and_bulk_equivalence():
    """수용 기준 2~5."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        ctx = await _stage_v1(c)
        keys = await _all_keys(c)
        await c.execute("SELECT app.ecat_cutover_v1($1, 'E1 시험')", ACTOR)
        await _as_loader(c, lambda: apply(c, ctx, keys))
        v1 = {j: await _brands(c, j) for j in (J1, J2, J3, JA, JB, JC, JD)}
        a1 = {j: await _answer(c, j) for j in (J1, JA)}
        st1 = await c.fetchval("SELECT count(*) FROM rd.answer_stance")
        acr1 = await c.fetchval("SELECT count(*) FROM rd.acr_choice")
        raw_v1 = await _raw_md5(c)

        v2 = await _make_v2(c, ctx)
        imp = await _as_loader(c, lambda: impact(c, 1, v2))
        cyc = [r[0] for r in await c.fetch("SELECT cyc_key FROM rd.cycle")]

        t0 = time.perf_counter()
        res, stamped = await _as_loader(c, lambda: _apply_version(c, ctx, imp, cyc))
        took = time.perf_counter() - t0
        v2b = {j: await _brands(c, j) for j in (J1, J2, J3, JA, JB, JC, JD)}
        a2 = {j: await _answer(c, j) for j in (J1, JA)}
        st2 = await c.fetch("""SELECT e.entity_id FROM rd.answer_stance s JOIN rd.dim_entity e ON e.entity_key = s.entity_key""")
        acr2 = await c.fetch("""SELECT e.entity_id FROM rd.acr_choice s JOIN rd.dim_entity e ON e.entity_key = s.entity_key""")
        vers = dict(await c.fetch("SELECT ecat_ver, count(*) FROM rd.answer GROUP BY 1"))
        role_apple = await c.fetchval("SELECT registry_role FROM rd.dim_entity WHERE entity_id = $1", APPLE)
        got = await snapshot(c, EQ_TABLES)
        sp = c.transaction()
        await sp.start()
        await bulk_seed(c)
        ref = await snapshot(c, EQ_TABLES)
        await sp.rollback()
        d = diff(ref, got)
        referenced = await referenced_extras(c, d)
        # 되돌리기(강제 미리보기와 같은 경로): v1 로 전 기간 재투영 → 반영 전 원시 md5
        allk, prs = await _all_keys(c), await _all_prs(c)
        await _as_loader(c, lambda: project(c, ctx, [], extra_keys=allk, extra_prompt_runs=prs, detect_global=False, ecat_ver=1, ecat_force=True))
        raw_back = await _raw_md5(c)
        k = {j: await _key(c, j) for j in (J1, J2, J3, JA, JB, JC, JD)}
        await tr.rollback()
    finally:
        await c.close()

    # 영향 집합: 편집이 닿는 답변(J1 Apple·Creta·TOYOTA, J2 Fortwo, J3 Tata, JA N·추가, JB·JC Epit, JC·JD 추가) 전부, ACR prompt-run(Apple)
    assert set(imp.answer_keys) >= {k[j] for j in (J1, J2, J3, JA, JB, JC, JD)}
    assert set(imp.entities) >= {APPLE, TATA, TOYOTA2, FORTWO, POLESTAR, IONIQ} and len(imp.prompt_run_ids) == 1
    assert res.answers >= len(imp.answer_keys) - 2                                 # 영향 집합 중 서빙 답변 전부(+ ACR 형제 편입)

    # ── 수용 기준 2: 기대 행(손 계산). 값 = (own_bit, entity_rows, rid_n, mention_count, rk, s_pos, s_neu, s_neg, s_mix, t_mention)
    # J1 v1: apple(비경쟁) · hyundai(Hyundai 3 + Creta 1 접두 교정, tp 1.5) · toyota(Toyota 2 + TOYOTA 1, rid 2개)
    assert v1[J1] == {("apple", False): (0, 1, 1, 1, 0, 0, 0, 0, 0, 1), ("hyundai", True): (1, 2, 1, 4, 2, 3, 1, 0, 0, 4),
                      ("toyota", True): (0, 2, 2, 3, 1, 0, 1, 1, 0, 3)}
    # v2: Apple 제거 → 행 없음, Tata 제거 → Creta 브랜드 귀속 상실(hyundai 1행·3), TOYOTA → Toyota 병합 → rid_n 1(G20)
    assert v2b[J1] == {("hyundai", True): (1, 1, 1, 3, 2, 2, 1, 0, 0, 3), ("toyota", True): (0, 2, 1, 3, 1, 0, 1, 1, 0, 3)}
    # J2 v1: kia(기아) · smart 비경쟁(smart) · smart 경쟁(Smart Fortwo 표기 패턴). v2: Fortwo 모 브랜드 = Kia → kia 2행 접기
    assert v1[J2] == {("kia", True): (2, 1, 1, 2, 1, 1, 0, 0, 1, 2), ("smart", False): (0, 1, 1, 1, 0, 0, 0, 0, 0, 1),
                      ("smart", True): (0, 1, 1, 1, 2, 0, 0, 0, 0, 1)}
    assert v2b[J2] == {("kia", True): (2, 2, 1, 3, 1, 1, 0, 0, 1, 3), ("smart", False): (0, 1, 1, 1, 0, 0, 0, 0, 0, 1)}
    assert v1[J3] == {("kia", True): (2, 1, 1, 1, 1, 1, 0, 0, 0, 1), ("tata", True): (0, 1, 1, 1, 2, 0, 0, 0, 0, 1)}
    assert v2b[J3] == {("kia", True): (2, 1, 1, 1, 1, 1, 0, 0, 0, 1)}
    # JA(9월, 발생 있음) v1: hyundai = Hyundai 3 + 제품 Ioniq 1(롤업 Hyundai). v2: 제품 Ioniq 제거(브랜드는 살아 있음) → 1행,
    #   N 차단 = 발생 1(부정) 빼고 재계산 3 → 2, Ioniq·'Hyundai N' 추가 표면은 Scope 발생(제거된 Ioniq 발생 포함)과 겹쳐 버림,
    #   GV80 → Genesis +1(Scope 발생 있음 → 가산), Polestar 새 언급(위치 = Hyundai·Ioniq·Genesis 다음 = 4 → 답변 순위 3, 감성 0)
    assert v1[JA] == {("hyundai", True): (1, 2, 1, 4, 1, 3, 0, 1, 0, 4), ("genesis", True): (4, 1, 1, 1, 2, 1, 0, 0, 0, 1)}
    assert v2b[JA] == {("hyundai", True): (1, 1, 1, 2, 1, 2, 0, 0, 0, 2), ("genesis", True): (4, 1, 1, 2, 2, 1, 0, 0, 0, 2),
                       ("polestar", True): (0, 1, 1, 1, 3, 0, 0, 0, 0, 1)}
    # JB(9월): Epit 발생 전부 차단 → 언급 제외
    assert v1[JB] == {("epit", True): (0, 1, 1, 1, 1, 0, 1, 0, 0, 1)} and v2b[JB] == {}
    # JC(8월 모양, 발생 없음): Hyundai 표면 일부(N) 차단 = 불변(근사), EPIT 표면 전부 차단 = 제외, Ioniq·'Hyundai N' 은 Scope 언급이 있고
    #   그 턴 발생이 없어 존재만 인정(가산 없음), Polestar 새 언급(발생 없는 턴 = 위치 NULL → 순위 0)
    assert v1[JC] == {("hyundai", True): (1, 1, 1, 2, 1, 1, 0, 1, 0, 2), ("epit", True): (0, 1, 1, 1, 2, 0, 1, 0, 0, 1)}
    assert v2b[JC] == {("hyundai", True): (1, 1, 1, 2, 1, 1, 0, 1, 0, 2), ("polestar", True): (0, 1, 1, 1, 0, 0, 0, 0, 0, 1)}
    # JD: Scope 언급 없음 → Polestar 새 언급(위치 NULL), 본문 해시가 다른 GV80 행은 무시
    assert v1[JD] == {} and v2b[JD] == {("polestar", True): (0, 1, 1, 1, 0, 0, 0, 0, 0, 1)}
    # 스탠스·ACR: Apple 행 제외(v1 스탠스 5 = 픽스처 4 + Apple 1, ACR 3 → 2), 그 밖 엔티티 행은 남는다
    assert st1 == 5 and APPLE not in {r[0] for r in st2} and len(st2) == 4
    assert acr1 == 3 and APPLE not in {r[0] for r in acr2} and len(acr2) == 2
    assert role_apple is None                                                      # 차원 역할 = 활성 버전(제거 = 명부 행 없음)

    # ── 수용 기준 3(G20): 병합으로 toyota 의 롤업 id 2개 → 1개, 답변 × 표시 브랜드 1행 유지(entity_rows 2)
    assert v1[J1][("toyota", True)][2] == 2 and v2b[J1][("toyota", True)][1:3] == (2, 1)

    # ── 수용 기준 4: 감성 분모 = 감성 4종 합(rd.answer.sent_all_*, core.measure OwnCols.sent_all·ratios["sentiment"]). 재매칭 가산은 언급 수만 바꾼다
    assert own_cols([4]).sent_all == "(a.sent_all_g)" and ratios({"answers": 1, "tracked": 1, "own_mentions": 1, "total_mentions": 1,
                                                                   "sent_pos": 3, "sent_all": 7, "rank_sum": 0, "ranked": 0})["sentiment"] == (3, 7)
    assert (a1[JA]["ment_g"], a2[JA]["ment_g"]) == (1, 2) and a1[JA]["sent_all_g"] == a2[JA]["sent_all_g"] == 1
    assert (a1[JA]["ment_total"], a2[JA]["ment_total"]) == (5, 5)                  # 언급 수 분모: 4+1 → 2+2+1(Polestar 1 포함)
    assert (a1[JA]["ment_h"], a2[JA]["ment_h"]) == (4, 2)
    assert (a1[JA]["sent_all_h"], a2[JA]["sent_all_h"]) == (4, 2)                  # 제거(Ioniq 긍정 1)·차단(N 부정 발생 1)은 감성도 뺀다
    assert (a1[J1]["ment_total"], a2[J1]["ment_total"], a2[J1]["ment_h"]) == (7, 6, 3)

    # ── 수용 기준 5: 영향 집합 재투영 + 버전 표시 = bulk(행 단위), ecat_ver 전수 = 2
    assert not strict_diff(d) and not referenced, d
    assert set(vers) == {v2} and stamped > 0
    # 되돌리기(v1 강제 재투영) = 반영 전 원시 md5(ecat_ver 도 1 로 돌아온다)
    assert raw_back == raw_v1
    print(f"v2 영향 {len(imp.answer_keys)} 답변 재투영 {took:.2f}s")


@needs_db
async def test_pinned_cycle_keeps_version_and_bulk_preserves_pins():
    """수용 기준 6: 회차 11 을 v1 에 고정하고 v2 활성으로 전량 재투영 → 회차 11 = v1 값·표시, 그 밖 = v2. bulk(seed-30 → seed-40) = 증분,
    고정은 전량 재구축 뒤에도 남는다(seed-30 적재 원장 ecat_pins → seed-40)."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        ctx = await _stage_v1(c)
        keys, prs = await _all_keys(c), await _all_prs(c)
        await c.execute("SELECT app.ecat_cutover_v1($1, 'E1 시험')", ACTOR)
        await _as_loader(c, lambda: apply(c, ctx, keys))
        v1 = {j: await _brands(c, j) for j in (J1, J2, J3, JA)}
        v2 = await _make_v2(c, ctx)
        await c.execute("UPDATE rd.cycle SET ecat_ver = 1 WHERE cyc_key = 11")
        ents = [r[0] for r in await c.fetch("SELECT entity_id FROM rd.dim_entity")]
        async def run_pinned():
            await c.execute(REGISTRY_ROLE_REFRESH)                                  # 활성화 뒤 차원 역할(E5 반영 순서 ③)
            # 실제 반영(ecat.py E5)처럼 편집 엔티티를 차원 재계산 대상으로 넘긴다(여기서는 상위 집합 = 전 엔티티). 현행 프로필 NAME 은 v2 의
            # 병합·관계 편집이 엔티티 표시 브랜드 키를 대소문자까지 바꿔('TOYOTA' → 'Toyota') 차원 갱신이 빠지면 bulk 와 갈린다(be/int3-name2)
            return await project(c, ctx, [], extra_keys=keys, extra_prompt_runs=prs, extra_entities=ents, detect_global=False)
        await _as_loader(c, run_pinned)
        pinned = {j: await _brands(c, j) for j in (J1, J2, J3, JA)}
        vers = {r[0]: r[1] for r in await c.fetch("SELECT cyc_key, array_agg(DISTINCT ecat_ver) FROM rd.answer GROUP BY 1")}
        got = await snapshot(c, EQ_TABLES)
        sp = c.transaction()
        await sp.start()
        await bulk_seed(c)
        ref = await snapshot(c, EQ_TABLES)
        pin_after = await c.fetchval("SELECT ecat_ver FROM rd.cycle WHERE cyc_key = 11")
        await sp.rollback()
        d = diff(ref, got)
        referenced = await referenced_extras(c, d)
        await tr.rollback()
    finally:
        await c.close()
    assert pinned[J1] == v1[J1] and pinned[J2] == v1[J2] and pinned[J3] == v1[J3]      # 회차 11(고정 v1): Apple·Tata·병합·관계 미적용
    assert ("polestar", True) in pinned[JA]                                             # 회차 12(활성 v2): 재매칭 적용
    assert vers[11] == [1] and all(v == [v2] for k2, v in vers.items() if k2 != 11)
    assert pin_after == 1
    assert not strict_diff(d) and not referenced, d
