"""IG-2 핵심 수용 기준: 같은 ing 입력에서 증분 적재 경로(apply)로 만든 rd 표 = bulk 시드(seed-30·40)로 만든 rd 표(행 단위).

기준값은 구현 SQL 이 아니라 bulk 시드 파일 자체를 같은 트랜잭션 상태에서 돌려 만든다(ingest.testkit.bulk_seed).
정수 키는 경로마다 발급 순서가 달라 자연 키(job_id·cycle_id·prompt_id·bare·entity_id·url_hash·skey·코드)로 바꿔 비교한다.
load_id·세대·first_seen 만 비교에서 뺀다. 증분 쪽은 loader 롤(SET ROLE loader)로 돌려 권한 경계도 함께 확인한다.
모든 쓰기는 트랜잭션 안이고 끝에 롤백한다(복제본 DB 불변).
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from ingest.common.db import LoadContext, LoaderDB, current_rule_ver
from ingest.cycles.ledger.service import handle_report_publication, project_cycles
from ingest.project.apply.service import apply, capture_prior
from ingest.testkit import EQ_TABLES, WIPE_FACTS, WIPE_ING_DIMS, bulk_seed, diff, referenced_extras, snapshot, strict_diff
from tests.support import DB_URL, TEST_NAME_KEY, needs_db

TABLES = EQ_TABLES

# ── 합성 추가 입력(고객 데이터 아님): 전역 판정이 적재 순서에 걸리는 경우를 만든다 ──
R9 = uuid.UUID("e0000000-0000-4000-8000-000000000009")          # run 5 와 같은 코호트(루트 프로젝트, 앵커 09-21 00:30)
SPX = uuid.UUID("b0000000-0000-4000-8000-000000000099")         # 새 Scope 프롬프트(카탈로그 밖)
J91 = uuid.UUID("90000000-0000-4000-8000-000000000091")         # 1차 적재: 제품 언급(롤업 엔티티 ZB 의 Brand 언급 아직 없음) + URL U1(도메인 a)
J92 = uuid.UUID("90000000-0000-4000-8000-000000000092")         # 2차 적재: ZB 의 Brand 언급 'Zeta' + U1 인용 2건(도메인 b → 최빈 도메인이 바뀜)
J93 = uuid.UUID("90000000-0000-4000-8000-000000000093")         # 2차 적재: run 5(같은 코호트·회차)의 J91 과 같은 R05 셀(더 늦은 측정) → 셀 대표 이동
ZB = uuid.UUID("7a000000-0000-4000-8000-0000000000b0")
Z1 = uuid.UUID("7a000000-0000-4000-8000-0000000000b1")
U1 = "https://news.zeta-example.org/story"

SYNTH_1 = f"""
INSERT INTO ing.prompt (scope_prompt_id, scope_project_id, text, lang, regions, kind)
VALUES ('{SPX}', 'a0000000-0000-4000-8000-000000000001', 'zeta q', 'EN', NULL, 'single');
INSERT INTO ing.run (run_id, scope_project_id, run_month, status, total_jobs, started_at, cycle_anchor_at, sync_state)
VALUES ('{R9}', 'a0000000-0000-4000-8000-000000000001', '2026-09-01', 'completed', 3, '2026-09-21 02:00+00', '2026-09-21 00:30+00', 'loaded');
INSERT INTO ing.cycle_run (run_id, cycle_id, attributed_by) VALUES ('{R9}', 'f0000000-0000-4000-8000-000000000012', 'scope');
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{J91}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions, n_citations, content_hash, load_id)
SELECT '2026-09-01', '{J91}', k.answer_key, '{R9}', 'b0000000-0000-4000-8000-000000000001', 'perplexity', 'XK', 'completed', '2026-09-21 03:00+00', 'completed', 1, 1, '\\x01', 1
  FROM ing.answer_key_map k WHERE k.job_id = '{J91}';
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, brand_rollup_entity_id, type_mention)
VALUES ('2026-09-01', '{J91}', 1, '{Z1}', 'Zeta One', 'Product', 2, 1.0, '{ZB}', 2);
INSERT INTO ing.citation (run_month, job_id, ord, url, host, domain_label) VALUES ('2026-09-01', '{J91}', 1, '{U1}', 'news.zeta-example.org', 'a-example.org');
"""
SYNTH_2 = f"""
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{J92}', '2026-09-01'), ('{J93}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions, n_citations, content_hash, load_id)
SELECT '2026-09-01', k.job_id, k.answer_key, v.run::uuid, v.p::uuid, v.t, v.r, 'completed', v.m::timestamptz, 'completed', v.nm, v.nc, '\\x02', 1
  FROM ing.answer_key_map k
  JOIN (VALUES ('{J92}', '{R9}', '{SPX}', 'chatgpt', 'US', '2026-09-21 04:00+00', 1, 2),
               ('{J93}', 'e0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'perplexity', 'XK',
                '2026-09-21 05:00+00', 0, 0)) v(j, run, p, t, r, m, nm, nc)
    ON v.j::uuid = k.job_id;
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, brand_rollup_entity_id, type_mention)
VALUES ('2026-09-01', '{J92}', 1, '{ZB}', 'Zeta', 'Brand', 1, 2.0, '{ZB}', 1);
INSERT INTO ing.citation (run_month, job_id, ord, url, host, domain_label) VALUES
  ('2026-09-01', '{J92}', 1, '{U1}', 'news.zeta-example.org', 'b-example.org'),
  ('2026-09-01', '{J92}', 2, '{U1}', 'news.zeta-example.org', 'b-example.org');
"""


async def _bulk_reference(extra_sql: list[str]) -> dict:
    """슈퍼유저 연결·롤백 트랜잭션: 추가 입력 → bulk 시드 → 스냅샷."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        for s in extra_sql:
            await c.execute(s)
        await bulk_seed(c)
        snap = await snapshot(c, TABLES)
        await tr.rollback()
        return snap
    finally:
        await c.close()


async def _ctx(c: asyncpg.Connection) -> LoadContext:
    rv = await current_rule_ver(c)
    lid = await c.fetchval("INSERT INTO ing.load (kind, rule_ver) VALUES ('run', $1) RETURNING load_id", rv)
    return LoadContext(load_id=int(lid), kind="run", rule_ver=rv)


async def _keys(c: asyncpg.Connection, where: str, *args) -> list[int]:
    return [r[0] for r in await c.fetch(
        f"SELECT k.answer_key FROM ing.answer a JOIN ing.answer_key_map k ON k.job_id = a.job_id WHERE {where}", *args)]


def _report(d: dict) -> str:
    return "\n".join(f"{t}: {v['len']} only_bulk={v['only_a'][:3]} only_inc={v['only_b'][:3]}" for t, v in d.items())


@needs_db
async def test_replay_by_run_from_scratch_equals_bulk():
    """rd 사실 표·ing 유래 차원(표시 브랜드·엔티티·출처·URL)을 비우고 run 을 시작 순서대로 하나씩 증분 적재 → bulk 와 행 단위 동일."""
    ref = await _bulk_reference([])
    db = LoaderDB(DB_URL, role="loader")
    c = await db.connect()
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(WIPE_FACTS)
        await c.execute(WIPE_ING_DIMS)
        ctx = await _ctx(c)
        async with c.transaction():
            await project_cycles(c, ctx, [r[0] for r in await c.fetch("SELECT cycle_id FROM ing.cycle")])
        for (run_id,) in await c.fetch("SELECT run_id FROM ing.run ORDER BY started_at, run_id"):
            async with c.transaction():
                await apply(c, ctx, await _keys(c, "a.run_id = $1", run_id))
        async with c.transaction():
            await handle_report_publication(c, ctx, [r[0] for r in await c.fetch("SELECT id FROM app.report_publication")], None)
        got = await snapshot(c, TABLES)
        await tr.rollback()
    finally:
        await c.close()
    d = diff(ref, got)
    assert not d, _report(d)
    assert len(got["rd.answer"]) == 19 and len(got["rd.job"]) == 21     # 손계산: 서빙 19·job 21(비완료 1·드롭 1)


@needs_db
async def test_split_loads_global_effects_equal_bulk():
    """전역 판정이 뒤 적재에 걸리는 경우: 대표 표기(names) 변경·URL 최빈 도메인 변경·같은 셀 대표 이동·코호트 pin 회차·새 차원.
    1차(J91) → 2차(J92·J93) 순서로 적재한 결과 = 전체 입력 bulk 시드."""
    ref = await _bulk_reference([SYNTH_1, SYNTH_2])
    db = LoaderDB(DB_URL, role="loader")
    c = await db.connect()
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(SYNTH_1)
        ctx = await _ctx(c)
        async with c.transaction():
            r1 = await apply(c, ctx, await _keys(c, "a.job_id = $1", J91))
        # 1차 뒤: J91 의 표시 브랜드 = 제품 표기 'zeta one'(ZB 의 Brand 언급이 아직 없다)
        bare1 = await c.fetchval("""SELECT b.bare FROM rd.job j JOIN rd.answer_brand ab ON ab.surface = j.surface AND ab.round_date = j.round_date
                                     AND ab.answer_key = j.answer_key JOIN rd.dim_brand_name b ON b.brand_key = ab.brand_key WHERE j.job_id = $1""", J91)
        assert bare1 == ("Zeta One" if TEST_NAME_KEY else "zeta one")     # NAME: bare = 정본 표시명 그대로
        await c.execute(SYNTH_2)
        async with c.transaction():
            r2 = await apply(c, ctx, await _keys(c, "a.job_id = ANY($1::uuid[])", [J92, J93]))
        got = await snapshot(c, TABLES)
        loose = diff(ref, got)
        referenced = await referenced_extras(c, loose)
        skey2 = await c.fetchval("""SELECT s.skey FROM rd.job j JOIN rd.citation ci ON ci.surface = j.surface AND ci.round_date = j.round_date
                                     AND ci.answer_key = j.answer_key JOIN rd.dim_source s ON s.source_key = ci.source_key WHERE j.job_id = $1""", J91)
        reps = dict(await c.fetch("""SELECT j.job_id, a.is_rep FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date
                                        AND a.answer_key = j.answer_key WHERE j.job_id = ANY($1::uuid[])""", [J91, J93]))
        bare2 = await c.fetchval("""SELECT b.bare FROM rd.job j JOIN rd.answer_brand ab ON ab.surface = j.surface AND ab.round_date = j.round_date
                                     AND ab.answer_key = j.answer_key JOIN rd.dim_brand_name b ON b.brand_key = ab.brand_key WHERE j.job_id = $1""", J91)
        await tr.rollback()
    finally:
        await c.close()
    assert r1.answers == 1
    assert bare2 == ("Zeta" if TEST_NAME_KEY else "zeta"), "2차 적재의 Brand 언급이 1차 답변의 표시 브랜드를 바꿔야 한다(시드 _names 전역 규칙)"
    assert r2.impacted_by_names >= 1                                 # J91 은 바뀌지 않았지만 다시 투영됐다
    assert skey2 == "b-example.org", "U1 의 최빈 도메인이 바뀌면 1차 답변 인용의 출처도 바뀐다(시드 _u 최빈 규칙)"
    assert reps == {J91: False, J93: True}                          # 같은 R05 셀에서 더 늦은 측정이 대표
    d = strict_diff(loose)
    assert not d, _report(d)
    assert not referenced, f"발급 원장 차원의 증분 전용 행이 참조된다: {referenced}"
    # 옛 대표 표기 'zeta one'·옛 출처 'a-example.org' 는 참조 없는 원장 행으로 남는다(재번호 금지, 모듈 README 차이 기록)
    assert {r[1] for r in loose.get("rd.dim_brand_name", {}).get("only_b", [])} <= {"Zeta One" if TEST_NAME_KEY else "zeta one"}
    assert {r[0] for r in loose.get("rd.dim_source", {}).get("only_b", [])} <= {"a-example.org"}


@needs_db
async def test_reapply_same_input_is_stable():
    """같은 입력을 두 번 적재해도 rd 가 같다(멱등). 두 번째 적재의 대표 뒤집힘 0."""
    db = LoaderDB(DB_URL, role="loader")
    c = await db.connect()
    try:
        tr = c.transaction()
        await tr.start()
        before = await snapshot(c, TABLES)
        ctx = await _ctx(c)
        keys = await _keys(c, "true")
        async with c.transaction():
            r = await apply(c, ctx, keys)
        after = await snapshot(c, TABLES)
        await tr.rollback()
    finally:
        await c.close()
    assert not diff(before, after), _report(diff(before, after))
    assert r.rep_flips == 0 and r.impacted_by_names == 0 and r.impacted_by_urls == 0
    assert r.answers == 19 and r.gate_propagated == 0            # 방금 넣은 자식 사본이 이미 게이트와 같다


@needs_db
async def test_stance_cyc_key_is_right_before_gate_propagation(monkeypatch):
    """검증 V3: INSERT_STANCE 가 넣는 cyc_key 가 전파(rd.propagate_answer_gates) 전에 이미 rd.answer.cyc_key 와 같아야 한다.
    전파는 서빙 답변(SERVED_KEYS)만 고쳐 쓰므로, 여기서 틀리면 서빙 아닌 답변 경로에서는 틀린 값이 남는다(동치 테스트는 못 잡는다).
    전파 직전 ANALYZE 호출(service.analyze)을 감싸 그 시점의 상태를 단언한다."""
    from ingest.project.apply import service as svc

    seen: list[tuple[int, int]] = []
    orig = svc.analyze

    async def probe(conn, tables):
        bad = await conn.fetchval("""SELECT count(*) FROM rd.answer_stance s JOIN rd.answer a
                                      ON a.surface = s.surface AND a.round_date = s.round_date AND a.answer_key = s.answer_key
                                     WHERE s.cyc_key IS DISTINCT FROM a.cyc_key""")
        n = await conn.fetchval("SELECT count(*) FROM rd.answer_stance")
        seen.append((int(bad), int(n)))
        return await orig(conn, tables)

    monkeypatch.setattr(svc, "analyze", probe)
    db = LoaderDB(DB_URL, role="loader")
    c = await db.connect()
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(WIPE_FACTS)                    # 사본을 비우고 새로 넣어 INSERT_STANCE 가 모든 스탠스 행을 만든다
        ctx = await _ctx(c)
        async with c.transaction():
            await project_cycles(c, ctx, [r[0] for r in await c.fetch("SELECT cycle_id FROM ing.cycle")])
        async with c.transaction():
            await apply(c, ctx, await _keys(c, "true"))
        await tr.rollback()
    finally:
        await c.close()
    assert seen and all(bad == 0 for bad, _ in seen), seen
    assert sum(n for _, n in seen) > 0                 # 스탠스 행이 실제로 있었다(빈 단언 방지)


# ── 줄어드는 방향(결함 D2·D6): 재pull·재분석으로 바뀐 job 의 인용·언급이 빠진다 ──
# 적재기 순서 그대로: capture_prior(자식 행을 지우기 전) → ing 자식 행 교체(여기선 삭제) + content_hash 변경 → apply(바뀐 job).
DROP_J92_CIT = f"""
DELETE FROM ing.citation WHERE job_id = '{J92}';
UPDATE ing.answer SET content_hash = '\\x03', n_citations = 0 WHERE job_id = '{J92}';
"""
DROP_J92_MENTION = f"""
DELETE FROM ing.mention WHERE job_id = '{J92}';
UPDATE ing.answer SET content_hash = '\\x04', n_mentions = 0 WHERE job_id = '{J92}';
"""
F1 = uuid.UUID("90000000-0000-4000-8000-000000000001")
DROP_F1 = f"""
DELETE FROM ing.citation WHERE job_id = '{F1}' AND ord = 9;
DELETE FROM ing.mention WHERE job_id = '{F1}' AND ord = 1;
UPDATE ing.answer SET content_hash = '\\x05' WHERE job_id = '{F1}';
"""


async def _drop_after_loads(pre: list[tuple[str, list]], drop_sql: str, drop_jobs: list) -> tuple[dict, dict, dict]:
    """pre = [(추가 입력 SQL, 그 뒤 apply 할 job)] 을 차례로 적재한 뒤 drop 을 적재기 순서로 반영. 반환 = (엄격 차이, 참조 고아, 관측값)."""
    ref = await _bulk_reference([*[p[0] for p in pre if p[0]], drop_sql])
    db = LoaderDB(DB_URL, role="loader")
    c = await db.connect()
    try:
        tr = c.transaction()
        await tr.start()
        ctx = await _ctx(c)
        for sql, jobs in pre:
            if sql:
                await c.execute(sql)
            async with c.transaction():
                await apply(c, ctx, await _keys(c, "a.job_id = ANY($1::uuid[])", jobs))
        async with c.transaction():
            keys = await _keys(c, "a.job_id = ANY($1::uuid[])", drop_jobs)
            await capture_prior(c, keys)
            await c.execute(drop_sql)
            res = await apply(c, ctx, keys)
        got = await snapshot(c, TABLES)
        loose = diff(ref, got)
        referenced = await referenced_extras(c, loose)
        obs = {
            "skey_j91": await c.fetchval("""SELECT s.skey FROM rd.job j JOIN rd.citation ci ON ci.surface = j.surface AND ci.round_date = j.round_date
                                             AND ci.answer_key = j.answer_key JOIN rd.dim_source s ON s.source_key = ci.source_key WHERE j.job_id = $1""", J91),
            "bare_j91": await c.fetchval("""SELECT b.bare FROM rd.job j JOIN rd.answer_brand ab ON ab.surface = j.surface AND ab.round_date = j.round_date
                                             AND ab.answer_key = j.answer_key JOIN rd.dim_brand_name b ON b.brand_key = ab.brand_key WHERE j.job_id = $1""", J91),
            "zb_dim": await c.fetchval("SELECT count(*) FROM rd.dim_entity WHERE entity_id = $1", ZB),
            "res": res,
        }
        await tr.rollback()
    finally:
        await c.close()
    return strict_diff(loose), referenced, obs


@needs_db
async def test_repull_drops_citations_restores_url_majority():
    """J92 의 U1 인용 2건이 빠지면 U1 최빈 도메인이 a-example.org 로 돌아가고 J91 인용 출처도 따라 돌아온다(bulk 과 같음)."""
    strict, referenced, obs = await _drop_after_loads([(SYNTH_1, [J91]), (SYNTH_2, [J92, J93])], DROP_J92_CIT, [J92])
    assert obs["skey_j91"] == "a-example.org"
    assert obs["res"].impacted_by_urls >= 1
    assert not strict, _report(strict)
    assert not referenced, referenced


@needs_db
async def test_repull_drops_brand_mention_restores_display_name():
    """J92 의 ZB Brand 언급('Zeta')이 빠지면 J91 표시 브랜드가 제품 표기 'zeta one' 으로 돌아가고 ZB 엔티티 차원 행이 사라진다(bulk 과 같음)."""
    strict, referenced, obs = await _drop_after_loads([(SYNTH_1, [J91]), (SYNTH_2, [J92, J93])], DROP_J92_MENTION, [J92])
    if TEST_NAME_KEY:
        # 현행 프로필 NAME: 롤업 대표 표기 원장(ing.entity_brand_name, DB-v2.26)이 'Zeta' 를 지우지 않아 J91 은 엔티티 이름 그대로다(원천에서 Brand 행이
        # 사라져도 이름·키 유지 = S5 정리 대응 요구). 이름이 바뀌지 않았으니 이름 영향 재투영도 없다. bulk 도 같은 원장을 읽어 같다(아래 단언)
        assert obs["bare_j91"] == "Zeta"
        assert obs["res"].impacted_by_names == 0
    else:
        assert obs["bare_j91"] == "zeta one"
        assert obs["res"].impacted_by_names >= 1
    assert obs["zb_dim"] == 0
    assert not strict, _report(strict)
    assert not referenced, referenced


@needs_db
async def test_repull_drops_only_citation_of_url_removes_dim_url():
    """픽스처 job 0001 의 인용 ord 9(그 URL 의 유일한 인용)·언급 ord 1 이 빠지면 dim_url 에 참조 없는 행이 남지 않는다(결함 D6, bulk 과 같음)."""
    strict, referenced, _ = await _drop_after_loads([], DROP_F1, [F1])
    assert not strict, _report(strict)
    assert not referenced, referenced


# ── 검증 관찰(core 9라운드): rd.dim_country 대소문자 중복 방지 ──────────────────────────────────────────────
J94 = uuid.UUID("90000000-0000-4000-8000-000000000094")         # region 'sa-dammam'(정본 'SA-Dammam' 이 이미 있다: 웹사이트 사이트 국가)
J95 = uuid.UUID("90000000-0000-4000-8000-000000000095")         # region 'Zz-New'(새 코드)
J96 = uuid.UUID("90000000-0000-4000-8000-000000000096")         # region 'ZZ-NEW'(같은 배치의 대소문자 변형)
SYNTH_CASE = f"""
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{J94}', '2026-09-01'), ('{J95}', '2026-09-01'), ('{J96}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions, n_citations, content_hash, load_id)
SELECT '2026-09-01', k.job_id, k.answer_key, 'e0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'perplexity', v.r,
       'completed', '2026-09-21 06:00+00', 'completed', 0, 0, '\\x03', 1
  FROM ing.answer_key_map k JOIN (VALUES ('{J94}', 'sa-dammam'), ('{J95}', 'Zz-New'), ('{J96}', 'ZZ-NEW')) v(j, r) ON v.j::uuid = k.job_id;
"""
CASE_DUPS = "SELECT upper(code) FROM rd.dim_country GROUP BY 1 HAVING count(*) > 1"


@needs_db
async def test_dim_country_case_variants_reuse_canonical_row():
    """답변 region 이 기존 코드와 대소문자만 다르면(sa-dammam vs SA-Dammam) 새 행을 만들지 않고 정본 행을 재사용하고,
    같은 배치 안 변형(Zz-New·ZZ-NEW)은 한 행(대문자 표기)으로 접는다. 결과 = 같은 입력의 bulk 시드(seed-30 §2 같은 규칙).
    예전 적재기는 대소문자 구분으로 중복을 걸러 'sa-dammam' 행을 새로 넣었고, core load_refs 가 그 상태를 거부해 전 요청이 500 이었다
    (지금은 DB-v2.10 P65 유일 색인이 23505 로도 막는다)."""
    ref = await _bulk_reference([SYNTH_CASE])
    db = LoaderDB(DB_URL, role="loader")
    c = await db.connect()
    try:
        tr = c.transaction()
        await tr.start()
        canon = await c.fetchrow("SELECT geo_key, code FROM rd.dim_country WHERE upper(code) = 'SA-DAMMAM'")
        n0 = await c.fetchval("SELECT count(*) FROM rd.dim_country")
        await c.execute(SYNTH_CASE)
        ctx = await _ctx(c)
        async with c.transaction():
            await apply(c, ctx, await _keys(c, "a.job_id = ANY($1::uuid[])", [J94, J95, J96]))
        got = await snapshot(c, TABLES)
        dups = await c.fetch(CASE_DUPS)
        n1 = await c.fetchval("SELECT count(*) FROM rd.dim_country")
        geo = dict(await c.fetch("SELECT j.job_id, g.code FROM rd.job j JOIN rd.dim_country g ON g.geo_key = j.geo_key "
                                 "WHERE j.job_id = ANY($1::uuid[])", [J94, J95, J96]))
        await tr.rollback()
    finally:
        await c.close()
    assert canon is not None and canon["code"] == "SA-Dammam"
    assert dups == [] and n1 == n0 + 1                                    # ZZ-NEW 한 행만 늘었다
    assert geo == {J94: "SA-Dammam", J95: "ZZ-NEW", J96: "ZZ-NEW"}
    d = diff(ref, got)
    assert not d, _report(d)


@needs_db
async def test_dim_country_upper_unique_index_rejects_variant():
    """DB-v2.10 P65: 적재기 밖 경로로도 대소문자만 다른 코드를 넣을 수 없다(23505)."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        try:
            gk = await c.fetchval("SELECT max(geo_key) + 1 FROM rd.dim_country")
            try:
                await c.execute("INSERT INTO rd.dim_country (geo_key, code, kind) VALUES ($1, 'sa-dammam', 'pseudo')", gk)
                raised = False
            except asyncpg.UniqueViolationError as e:
                raised = e.constraint_name == "dim_country_code_upper_uq"
            assert raised
        finally:
            await tr.rollback()
    finally:
        await c.close()


# ── 검증 F1(core 8b): 정본 표기가 적재 순서와 무관해야 한다 ────────────────────────────────────────────────────
J97 = uuid.UUID("90000000-0000-4000-8000-000000000097")
J98 = uuid.UUID("90000000-0000-4000-8000-000000000098")


def _synth_region(job: uuid.UUID, region: str) -> str:
    return f"""
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{job}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions, n_citations, content_hash, load_id)
SELECT '2026-09-01', k.job_id, k.answer_key, 'e0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'perplexity', '{region}',
       'completed', '2026-09-21 06:30+00', 'completed', 0, 0, '\\x04', 1
  FROM ing.answer_key_map k WHERE k.job_id = '{job}';
"""


@needs_db
@pytest.mark.parametrize("first,second", [("qz", "QZ"), ("QZ", "qz")], ids=["qz 다음 QZ", "QZ 다음 qz"])
async def test_dim_country_canonical_independent_of_load_order(first, second):
    """1차 적재 region=first, 2차 region=second 로 나눠 적재한 결과 = 두 입력을 한 번에 본 bulk(정본 'QZ', kind iso).
    예전 규칙(배치 안에서만 우선순위, 기존 행은 그대로)은 'qz' 다음 'QZ' 에서 ('qz', pseudo) 로 남아 bulk('QZ', iso)와 갈렸다."""
    s1, s2 = _synth_region(J97, first), _synth_region(J98, second)
    ref = await _bulk_reference([s1, s2])
    db = LoaderDB(DB_URL, role="loader")
    c = await db.connect()
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(s1)
        ctx = await _ctx(c)
        async with c.transaction():
            await apply(c, ctx, await _keys(c, "a.job_id = $1", J97))
        mid = await c.fetchrow("SELECT geo_key, code, kind FROM rd.dim_country WHERE upper(code) = 'QZ'")
        await c.execute(s2)
        async with c.transaction():
            await apply(c, ctx, await _keys(c, "a.job_id = $1", J98))
        got = await snapshot(c, TABLES)
        end = await c.fetchrow("SELECT geo_key, code, kind FROM rd.dim_country WHERE upper(code) = 'QZ'")
        geos = dict(await c.fetch("SELECT job_id, geo_key FROM rd.job WHERE job_id = ANY($1::uuid[])", [J97, J98]))
        await tr.rollback()
    finally:
        await c.close()
    assert mid["code"] == first and (end["code"], end["kind"]) == ("QZ", "iso")
    assert end["geo_key"] == mid["geo_key"] and geos == {J97: end["geo_key"], J98: end["geo_key"]}     # geo_key 유지, 두 job 같은 행
    d = diff(ref, got)
    assert not d, _report(d)


@needs_db
async def test_hidden_market_and_virtual_geo_compare_upper_f2():
    """검증 F2: 숨김 시장 app.hidden_market('global', 'SA-DAMMAM') 은 정본 'SA-Dammam' 행의 hidden_standard 를 켠다(증분 재판정·bulk 모두)."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute("INSERT INTO app.hidden_market (surface, country_code) VALUES ('global', 'SA-DAMMAM')")
        from ingest.project.apply.rejudge import HIDDEN_REFRESH
        await c.execute("SET ROLE loader")
        changed = [r[0] for r in await c.fetch(HIDDEN_REFRESH)]
        inc = await c.fetchrow("SELECT geo_key, code, hidden_standard FROM rd.dim_country WHERE upper(code) = 'SA-DAMMAM'")
        await c.execute("RESET ROLE")
        await bulk_seed(c)
        bulk = await c.fetchrow("SELECT code, hidden_standard FROM rd.dim_country WHERE upper(code) = 'SA-DAMMAM'")
        await tr.rollback()
    finally:
        await c.close()
    assert inc["code"] == "SA-Dammam" and inc["hidden_standard"] is True and changed == [inc["geo_key"]]
    assert (bulk["code"], bulk["hidden_standard"]) == ("SA-Dammam", True)


def test_canon_order_is_identical_in_loader_and_bulk_seed():
    """증분(DIM_COUNTRY)과 bulk(seed-30 §2 cu)의 정본 순서 식은 글자까지 같아야 순서 독립 증명(결합법칙)이 두 경로에 함께 성립한다."""
    import pathlib
    import re

    from ingest.project.apply.queries import CANON_ORDER, DIM_COUNTRY

    norm = lambda t: re.sub(r"\s+", " ", t).strip()  # noqa: E731
    seed = (pathlib.Path(__file__).resolve().parents[4] / "migration" / "seed" / "seed-30-dims.sql").read_text(encoding="utf-8")
    assert norm(CANON_ORDER.format(x="c0.code")) in norm(seed)
    assert norm(CANON_ORDER.format(x="x.code")) in norm(DIM_COUNTRY)


# ── 검증 F3(core 8c): app 원천 표기 변경 뒤에도 증분 = bulk ─────────────────────────────────────────────────
@needs_db
@pytest.mark.parametrize("hidden,region", [("qz", "QZ"), ("SA-JEDDAH", "SA-Jeddah")], ids=["숨김 qz + 답변 QZ", "숨김 SA-JEDDAH + 답변 SA-Jeddah"])
async def test_app_variant_then_answer_one_load_equals_bulk_f3(hidden, region):
    """숨김 시장에 소문자·다른 표기가 먼저 들어오고(재판정 없이) 답변이 다른 표기로 한 번 적재돼도 = bulk. DIM_COUNTRY 후보에 같은 upper 묶음의
    app 원천 표기를 넣는다. 예전(검증 F3 재현)은 증분 ('QZ', iso) 대 bulk ('qz', pseudo)."""
    hid = f"INSERT INTO app.hidden_market (surface, country_code) VALUES ('global', '{hidden}');"
    s1 = _synth_region(J97, region)
    ref = await _bulk_reference([hid, s1])
    db = LoaderDB(DB_URL, role="loader")
    c = await db.connect()
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute("RESET ROLE")
        await c.execute(hid)
        await c.execute("SET ROLE loader")
        await c.execute(s1)
        ctx = await _ctx(c)
        async with c.transaction():
            await apply(c, ctx, await _keys(c, "a.job_id = $1", J97))
        got = await snapshot(c, TABLES)
        row = await c.fetchrow("SELECT code, kind, hidden_standard FROM rd.dim_country WHERE upper(code) = upper($1)", region)
        await tr.rollback()
    finally:
        await c.close()
    assert row["code"] == hidden and row["hidden_standard"] is True          # 정본 = 숨김 시장 표기(원천 순위 6 > 답변만 7)
    d = diff(ref, got)
    assert not d, _report(d)


@needs_db
async def test_answer_then_app_variant_rejudge_equals_bulk_f3():
    """역순: 답변 'QZ' 가 먼저 적재된 뒤 숨김 시장 'qz' 가 생기면 hidden_market 재판정의 APP 병합이 기존 행을 'qz' 로 고친다 = bulk."""
    from ingest.project.apply.rejudge import rejudge

    hid = "INSERT INTO app.hidden_market (surface, country_code) VALUES ('global', 'qz');"
    s1 = _synth_region(J97, "QZ")
    ref = await _bulk_reference([hid, s1])
    db = LoaderDB(DB_URL, role="loader")
    c = await db.connect()
    try:
        tr = c.transaction()
        await tr.start()
        await c.execute(s1)
        ctx = await _ctx(c)
        async with c.transaction():
            await apply(c, ctx, await _keys(c, "a.job_id = $1", J97))
        before = await c.fetchrow("SELECT geo_key, code, kind FROM rd.dim_country WHERE upper(code) = 'QZ'")
        await c.execute("RESET ROLE")
        await c.execute(hid)
        await c.execute("SET ROLE loader")
        async with c.transaction():
            await rejudge(c, ctx, "hidden_market")
        got = await snapshot(c, TABLES)
        after = await c.fetchrow("SELECT geo_key, code, kind, hidden_standard FROM rd.dim_country WHERE upper(code) = 'QZ'")
        await tr.rollback()
    finally:
        await c.close()
    assert (before["code"], before["kind"]) == ("QZ", "iso")
    assert (after["code"], after["kind"], after["hidden_standard"]) == ("qz", "pseudo", True) and after["geo_key"] == before["geo_key"]
    d = diff(ref, got)
    assert not d, _report(d)
