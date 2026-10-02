"""증분 적재 = bulk 재구축 동치(현행 프로필을 켠 상태). be/incr-parity, 2026-10-01.

stg hmg_r2 재투영(reproject-attrib-member·wu5_reproject)에서 적재기가 DB-v2.15 P87 region_geo_key 를 쓰지 않아 17,488 답변이 NULL 로 남았다
(fill 로 메움). 기존 동치 시험(test_equivalence)은 프로필 끔·v2.15 열 일부만 비교해 이를 못 잡았다. 여기서는
  - 적재기 활성 프로필 = 구현된 스위치 전부(stg c37de4ae 배포 값과 같은 20개), bulk = 같은 투영 스위치를 시드 입력으로(testkit.bulk_seed_profile)
  - 비교 = testkit.EQ_TABLES 전부(사실 8·차원 8·rd.cycle·report_unit_value·catalog_entry·web_unit·web_report_prompt), rd.answer 는 v2.15 열
    (is_rep·elig_nc·std_in_nc·cit_in_nc·cit_n_all·cit_c1..13·region_geo_key) 포함, 자식 is_rep·std_in_nc·cit_in_nc·rid_n 포함, 자연 키
  - 경로 3종: ① 새 답변 적재(빈 사실 표에서 run 순서대로) ② 재적재(재pull·재분석으로 바뀐 job, capture_prior 경로) ③ 재제출 run
    (원장 유령 회차 멤버 run + 발행 회차에 늦게 붙는 run, ledger.attribute 경로)
  - 단언: rd.assert_answer_v215(NULL)·rd.assert_rep(NULL, true) 또는 rd.assert_rep_seat(rep_round_date_cell)·rd.assert_web_report_prompt() 가 증분 결과에서 통과(stg 점검과 같은 함수)
합성 입력만(고객 데이터 아님). 커밋하는 시험이라 일회 DB(fresh_db)를 쓴다.
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from app.core.config import set_settings
from app.core.profile import IMPLEMENTED, SWITCHES, parse_profile
from ingest.common.db import LoaderDB
from ingest.cycles.ledger.service import attribute, handle_report_publication, project_cycles
from ingest.project.apply.rejudge import rejudge
from ingest.project.apply.service import apply, capture_prior
from ingest.project.apply.tests.test_attrib_member import SYNTH_PHANTOM
from ingest.project.apply.tests.test_equivalence import SYNTH_1, SYNTH_2, _ctx, _keys, _report
from ingest.project.apply.tests.test_wu5_projection import SYNTH as SYNTH_WU5
from ingest.testkit import (
    EQ_TABLES,
    PROJECTION_SEED_ARGS,
    WIPE_FACTS,
    WIPE_ING_DIMS,
    bulk_seed_profile,
    diff,
    referenced_extras,
    snapshot,
    strict_diff,
)
from tests.support import needs_db

PROFILE_SPEC = ",".join(n for n in SWITCHES if n in IMPLEMENTED)      # stg c37de4ae 배포 프로필(구현 20개 전부)
PROFILE = parse_profile(PROFILE_SPEC)

KIA_DE = "d0000000-0000-4000-8000-000000000002"
RUN21 = "e0000000-0000-4000-8000-000000000021"
NWP = uuid.UUID("b0000000-0000-4000-8000-0000000000a5")        # 새 웹 프롬프트(보고서 유닛 소속 → 적재기가 rd.web_report_prompt 를 넣어야 한다)
JNW = uuid.UUID("90000000-0000-4000-8000-0000000000a5")
KG = uuid.UUID("7b000000-0000-4000-8000-0000000000c1")          # 대표 표기 콜레이션 엔티티(NAME: libc 'KG모빌리티' < 'KGM', ICU 반대)
ZV1 = uuid.UUID("7b000000-0000-4000-8000-0000000000c2")         # NAME 키: 대소문자만 다른 두 롤업(운영 = 두 행, frz 4차 'Vivo'·'vivo')
ZV2 = uuid.UUID("7b000000-0000-4000-8000-0000000000c3")
ZM = uuid.UUID("7b000000-0000-4000-8000-0000000000c4")          # NAME 키: 언급 'Zmart' + 경쟁사 토큰 정본 'zmart'(운영 = 'Zmart', frz 4차 'Smart')
WX = uuid.UUID("7b000000-0000-4000-8000-0000000000c5")          # NAME 원장: Brand 행 'Wahlx'(J6) + 제품 행(J4) 롤업. 재적재로 Brand 행이 사라져도
WXP = uuid.UUID("7b000000-0000-4000-8000-0000000000c6")         #   이름 'Wahlx'(비경쟁 명부) 유지(frz 4차 Wahl·Sharp·Arrival, S5 정리)
J1 = uuid.UUID("90000000-0000-4000-8000-000000000001")
J4 = uuid.UUID("90000000-0000-4000-8000-000000000004")
J6 = uuid.UUID("90000000-0000-4000-8000-000000000006")
RS = uuid.UUID("e0000000-0000-4000-8000-0000000000b1")          # 재제출 run: 루트 프로젝트, run 1 과 같은 앵커(09-14 00:30) → 발행 회차 11 에 늦게 붙는다
JR = uuid.UUID("90000000-0000-4000-8000-0000000000b1")          # run 1 job 1 과 같은 셀(prompt 01·chatgpt·US), 더 늦은 측정 → 현행 대표 이동
RP = uuid.UUID("e0000000-0000-4000-8000-0000000000a1")          # test_attrib_member 의 원장 유령 회차 멤버 run
JP = uuid.UUID("90000000-0000-4000-8000-0000000000a1")
CY = uuid.UUID("f0000000-0000-4000-8000-0000000000a1")

# 보고서 유닛 명세(Kia DE, de, '/sub' 타겟 제외) → 프롬프트 21·22·새 웹 프롬프트 소속, 23 밖
REPORT_UNITS = """
INSERT INTO app.website_report_unit (ix, brand_code, country_code, lang_code, url_like, url_not_like, spec_fs)
VALUES (0, 'Kia', 'DE', 'de', NULL, '%/sub%', 101);
"""
NEW_WEB_APP = f"""
INSERT INTO app.website_prompt (site_id, file_seq, domain, lang_code, seq_no, target_url, prompt_text, owned_base_url, scope_prompt_id)
VALUES ('{KIA_DE}', 101, 'kia.com', 'de', 3, 'https://www.kia.com/de/modelle/ev6/', 'ev6?', 'https://www.kia.com/de/', '{NWP}');
"""
NEW_WEB_ING = f"""
INSERT INTO ing.prompt (scope_prompt_id, scope_project_id, text, lang, regions, kind)
VALUES ('{NWP}', 'a0000000-0000-4000-8000-000000000002', 'ev6?', 'DE', NULL, 'single');
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{JNW}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions,
                        n_citations, content_hash, load_id)
SELECT '2026-09-01', '{JNW}', k.answer_key, '{RUN21}', '{NWP}', 'chatgpt', 'AT', 'completed', '2026-09-18 02:00+00', 'completed', 1, 2, '\\x05', 1
  FROM ing.answer_key_map k WHERE k.job_id = '{JNW}';
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, brand_rollup_entity_id, type_mention)
VALUES ('2026-09-01', '{JNW}', 1, '00000000-0000-0000-0000-000000000302', 'Kia', 'Brand', 1, 1.0, '00000000-0000-0000-0000-000000000302', 1);
INSERT INTO ing.citation (run_month, job_id, ord, url, host, domain_label) VALUES
  ('2026-09-01', '{JNW}', 1, 'https://www.kia.com/de/modelle/ev6/?x=1', 'kia.com', 'kia.com'),
  ('2026-09-01', '{JNW}', 2, 'https://www.kia.com/de/modelle/ev6/?x=1', 'kia.com', NULL);
"""
# 웹 답변 JNW 의 region AT ≠ 사이트 국가 DE: geo_key(사이트 국가) ≠ region_geo_key(답변 region) 인 행
NAMES = f"""
UPDATE ing.answer SET n_mentions = 1 WHERE job_id IN ('{J4}', '{J6}');
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, brand_rollup_entity_id, type_mention)
VALUES ('2026-09-01', '{J4}', 1, '{KG}', 'KG모빌리티', 'Brand', 1, 1.0, '{KG}', 1),
       ('2026-09-01', '{J6}', 1, '{KG}', 'KGM', 'Brand', 2, 1.0, '{KG}', 2),
       ('2026-09-01', '{J4}', 2, '{ZV1}', 'Zivo', 'Brand', 1, 2.0, '{ZV1}', 1),
       ('2026-09-01', '{J6}', 2, '{ZV2}', 'zivo', 'Brand', 1, 2.0, '{ZV2}', 1),
       ('2026-09-01', '{J6}', 3, '{ZM}', 'Zmart', 'Brand', 1, 3.0, '{ZM}', 1),
       ('2026-09-01', '{J6}', 4, '{WX}', 'Wahlx', 'Brand', 1, 4.0, '{WX}', 1),
       ('2026-09-01', '{J4}', 3, '{WXP}', 'Opel Zed Motor', 'Product', 2, 4.0, '{WX}', 2);
INSERT INTO app.competitor_domain_token (token, brand_name) VALUES ('zmartzz', 'zmart');
INSERT INTO app.non_competitor_name (name, bare_only_pattern) VALUES ('wahlx', NULL);
"""
BASE_EXTRA = [REPORT_UNITS, NEW_WEB_APP, NEW_WEB_ING, NAMES, SYNTH_WU5]

J21 = uuid.UUID("90000000-0000-4000-8000-000000000021")         # 웹 답변(유닛 101), 인용 ord 1 = ev9 타겟 URL 의 유일한 인용
WT_READY = "SELECT to_regclass('rd.web_target_url') IS NOT NULL"
WT_ROWS = "SELECT count(*) FROM rd.web_target_url"
WT_DANGLING = "SELECT count(*) FROM rd.web_target_url w WHERE NOT EXISTS (SELECT 1 FROM rd.dim_url d WHERE d.url_key = w.url_key)"

RESUB = f"""
INSERT INTO ing.run (run_id, scope_project_id, run_month, status, total_jobs, started_at, cycle_anchor_at, sync_state)
VALUES ('{RS}', 'a0000000-0000-4000-8000-000000000001', '2026-09-01', 'completed', 1, '2026-09-15 01:00+00', '2026-09-14 00:30+00', 'loaded');
INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('{JR}', '2026-09-01');
INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, analysis_status, n_mentions,
                        n_citations, content_hash, load_id)
SELECT '2026-09-01', '{JR}', k.answer_key, '{RS}', 'b0000000-0000-4000-8000-000000000001', 'chatgpt', 'US', 'completed', '2026-09-15 03:00+00',
       'completed', 1, 1, '\\x06', 1
  FROM ing.answer_key_map k WHERE k.job_id = '{JR}';
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, avg_position, brand_rollup_entity_id, type_mention)
VALUES ('2026-09-01', '{JR}', 1, '00000000-0000-0000-0000-000000000301', 'Hyundai', 'Brand', 1, 1.0, '00000000-0000-0000-0000-000000000301', 1);
INSERT INTO ing.citation (run_month, job_id, ord, url, host, domain_label)
VALUES ('2026-09-01', '{JR}', 1, 'https://www.hyundai.com/us/en/suv', 'hyundai.com', 'hyundai.com');
"""

# 대표 단언 = 프로필의 대표 규칙: rep_round_date_cell 이면 답변분석 자리 규칙·인용 계열 보정 표(DB-v2.19 P110 rd.assert_rep_seat), 아니면 회차 셀 규칙
_REP_ASSERT = "SELECT rd.assert_rep_seat(NULL, NULL, NULL, NULL)" if PROFILE.rep_round_date_cell else "SELECT rd.assert_rep(NULL, true)"
ASSERTS = ("SELECT rd.assert_answer_v215(NULL)", _REP_ASSERT, "SELECT rd.assert_web_report_prompt()")
NULLS = """
SELECT (SELECT count(*) FROM rd.answer WHERE region_geo_key IS NULL OR cit_n_all IS NULL OR elig_nc IS NULL)
     + (SELECT count(*) FROM rd.answer_brand WHERE std_in_nc IS NULL OR rid_n IS NULL)
     + (SELECT count(*) FROM rd.answer_stance WHERE std_in_nc IS NULL)
     + (SELECT count(*) FROM rd.citation WHERE cit_in_nc IS NULL)
     + (SELECT count(*) FROM rd.dim_prompt WHERE cat_mask_all IS NULL)"""


def _on(settings):
    set_settings(settings.model_copy(update={"legacy_profile": PROFILE_SPEC}))


async def _exec_committed(url: str, sqls: list[str], *, bulk: bool = False) -> None:
    """슈퍼유저로 준비 SQL(app 행 포함: loader 는 app 쓰기 권한이 없다)을 커밋. bulk 면 이어서 프로필 bulk 를 커밋(stg 재투영 뒤 상태)."""
    c = await asyncpg.connect(url)
    try:
        async with c.transaction():
            for s in sqls:
                await c.execute(s)
            if bulk:
                await bulk_seed_profile(c, PROFILE)
    finally:
        await c.close()


async def _compare_with_bulk(url: str) -> tuple[dict, dict, dict]:
    """지금 DB(증분 결과) vs 같은 ing·app 로 프로필 bulk(롤백). 반환 = (엄격 차이, 참조되는 원장 고아, 증분 스냅샷). 단언 함수도 증분 쪽에서 돈다."""
    c = await asyncpg.connect(url)
    try:
        for a in ASSERTS:
            await c.fetchval(a)
        assert await c.fetchval(NULLS) == 0, "증분 결과에 v2.15 열 NULL"
        got = await snapshot(c, EQ_TABLES)
        tr = c.transaction()
        await tr.start()
        await bulk_seed_profile(c, PROFILE)
        ref = await snapshot(c, EQ_TABLES)
        await tr.rollback()
        d = diff(ref, got)
        return strict_diff(d), await referenced_extras(c, d), got
    finally:
        await c.close()


def test_projection_switches_all_mapped_to_bulk():
    """구현된 투영 스위치는 전부 bulk 시드 입력이 있어야 한다(없으면 증분과 bulk 가 다른 규칙으로 돌아도 동치 시험이 못 본다)."""
    proj = {n for n, s in SWITCHES.items() if s.kind == "projection" and n in IMPLEMENTED}
    assert proj == set(PROJECTION_SEED_ARGS), proj ^ set(PROJECTION_SEED_ARGS)


@needs_db
async def test_new_loads_from_scratch_equal_bulk_with_profile(settings, fresh_db):
    """① 새 답변 적재: 빈 사실 표에서 run 을 시작 순서대로 증분 적재(프로필 켬) = 프로필 bulk."""
    # 순서 = 운영: 보고서 명세 채움(fill-v216) → 웹 카탈로그에 새 프롬프트 등록(app 트리거 → 큐 website_catalog 재판정) → Scope 답변 도착(pull)
    await _exec_committed(fresh_db, [REPORT_UNITS, NEW_WEB_APP, "SELECT rd.refresh_web_report_prompt(NULL)"])
    _on(settings)
    try:
        c = await LoaderDB(fresh_db, role="loader").connect()
        try:
            async with c.transaction():
                await rejudge(c, await _ctx(c), "website_catalog")
            # 새 웹 프롬프트는 Scope 답변이 오기 전이라 아직 dim_prompt 밖 → 보고서 유닛 소속은 적재기가 첫 답변 때 넣어야 한다
            assert await _web_report_count(fresh_db, NWP) == 0
            await _exec_committed(fresh_db, [NEW_WEB_ING, NAMES, SYNTH_WU5, SYNTH_1, SYNTH_2, SYNTH_PHANTOM])
            async with c.transaction():
                await c.execute(WIPE_FACTS)
                await c.execute(WIPE_ING_DIMS)
                ctx = await _ctx(c)
                await project_cycles(c, ctx, [r[0] for r in await c.fetch("SELECT cycle_id FROM ing.cycle")])
            for (run_id,) in await c.fetch("SELECT run_id FROM ing.run ORDER BY started_at, run_id"):
                async with c.transaction():
                    await apply(c, ctx, await _keys(c, "a.run_id = $1", run_id))
            async with c.transaction():
                await handle_report_publication(c, ctx, [r[0] for r in await c.fetch("SELECT id FROM app.report_publication")], None)
        finally:
            await c.close()
    finally:
        set_settings(settings)
    d, referenced, _ = await _compare_with_bulk(fresh_db)
    assert not d, _report(d)
    assert not referenced, referenced
    assert await _web_report_count(fresh_db, NWP) == 1                 # 새 웹 프롬프트의 보고서 유닛 소속을 적재기가 넣었다
    # 웹 답변 JNW: geo_key = 사이트 국가 DE, region_geo_key = 답변 region AT (P87 이 의미 있는 값을 가진 행)
    assert await _geo_pair(fresh_db, JNW) == ("DE", "AT")


@needs_db
async def test_reload_changed_jobs_equal_bulk_with_profile(settings, fresh_db):
    """② 재적재(재pull·재분석): 프로필 bulk 로 적재된 DB(stg 상태)에서 job 1(인용 변경·호스트 없는 인용)·job 6(Brand 언급 'KGM' 빠짐 →
    NAME 원장이 있어 KG 대표 표기 'KGM'·WX 'Wahlx' 는 유지)을 sync 와 같은 순서(capture_prior → ing 자식 교체 → apply)로 반영 = 프로필 bulk."""
    await _exec_committed(fresh_db, BASE_EXTRA, bulk=True)
    _on(settings)
    try:
        c = await LoaderDB(fresh_db, role="loader").connect()
        try:
            async with c.transaction():
                ctx = await _ctx(c)
                keys = await _keys(c, "a.job_id = ANY($1::uuid[])", [J1, J6, J21])
                wt0 = await c.fetchval(WT_ROWS) if await c.fetchval(WT_READY) else None
                await capture_prior(c, keys)
                await c.execute(f"""
                    DELETE FROM ing.citation WHERE job_id = '{J1}' AND ord IN (9, 10);
                    UPDATE ing.citation SET domain_label = NULL WHERE job_id = '{J1}' AND ord = 2;
                    DELETE FROM ing.mention WHERE job_id = '{J6}';
                    UPDATE ing.answer SET n_citations = 8, content_hash = '\\x11' WHERE job_id = '{J1}';
                    UPDATE ing.answer SET n_mentions = 0, content_hash = '\\x12' WHERE job_id = '{J6}';
                    DELETE FROM ing.citation WHERE job_id = '{J21}' AND ord = 1;
                    UPDATE ing.answer SET content_hash = '\\x13' WHERE job_id = '{J21}';""")
                res = await apply(c, ctx, keys)
                wt1 = await c.fetchval(WT_ROWS) if wt0 is not None else None
                dangling = await c.fetchval(WT_DANGLING) if wt0 is not None else 0
        finally:
            await c.close()
    finally:
        set_settings(settings)
    # 현행 프로필 NAME 은 대표 표기 원장(DB-v2.26 P138)을 이름 원천에 더한다: J6 재적재로 KG 의 'KGM' Brand 행이 지워져도 대표 표기는 'KGM'
    # 그대로라(운영 생성기가 본 이름 유지) job 4 를 이름 영향으로 다시 투영하지 않는다(be/int3-name 전에는 'KG모빌리티' 로 바뀌어 1 이었다)
    assert res.impacted_by_names == (0 if PROFILE.display_name_latin else 1)
    # J6 재적재로 엔티티 WX 의 Brand 행이 모두 사라졌다: 현행 프로필 NAME 은 원장(ing.entity_brand_name)의 'Wahlx' 로 J4 제품 행을 그대로 접고
    # 비경쟁 명부(wahlx)로 경쟁에서 뺀다(제품 표기 'Opel Zed Motor' 로 새 키를 만들지 않는다)
    c = await asyncpg.connect(fresh_db)
    try:
        assert await c.fetchval("SELECT count(*) FROM ing.mention WHERE entity_id = $1", WX) == 0
        rows = await c.fetch("""SELECT n.name, ab.competitive, n.kind FROM rd.answer_brand ab JOIN rd.job j ON j.answer_key = ab.answer_key
                                  JOIN rd.dim_brand_name n ON n.brand_key = ab.brand_key WHERE j.job_id = $1 AND lower(n.name) LIKE '%wahlx%'
                                     OR j.job_id = $1 AND n.name = 'Opel Zed Motor'""", J4)
        assert [tuple(r) for r in rows] == [("Wahlx", False, 3)], rows
    finally:
        await c.close()
    # J21 의 유일한 ev9 타겟 인용(ord 1)이 빠져 dim_url 행이 지워지면 그 url_key 의 타겟 사전 해석 행(DB-v2.20 P111)도 없어야 한다
    assert dangling == 0 and (wt0 is None or wt1 == wt0 - 1), (wt0, wt1, dangling)
    d, referenced, _ = await _compare_with_bulk(fresh_db)
    assert not d, _report(d)
    assert not referenced, referenced


@needs_db
async def test_resubmitted_runs_equal_bulk_with_profile(settings, fresh_db):
    """③ 재제출 run: 프로필 bulk 로 적재된 DB 에 (a) 원장 유령 회차 멤버 run RP(resub_phantom_exclude = 멤버 회차) (b) 발행 회차 11 앵커로
    늦게 들어온 run RS(ledger.attribute 'late', job 1 셀에 더 늦은 측정 → 현행 대표 규칙 이동)를 sync 순서(attribute → project_cycles → apply)로 = 프로필 bulk."""
    await _exec_committed(fresh_db, BASE_EXTRA, bulk=True)
    _on(settings)
    try:
        c = await LoaderDB(fresh_db, role="loader").connect()
        try:
            async with c.transaction():
                await c.execute(SYNTH_PHANTOM)
                await c.execute(RESUB)
                ctx = await _ctx(c)
                touched = await attribute(c, ctx, [RS])
                await project_cycles(c, ctx, {*touched, CY})
                res = await apply(c, ctx, await _keys(c, "a.job_id = ANY($1::uuid[])", [JR, JP]), extra_runs=[RS, RP])
        finally:
            await c.close()
    finally:
        set_settings(settings)
    assert res.rep_flips >= 1                                          # job 1 이 셀 대표에서 내려왔다(다른 답변 뒤집힘)
    d, referenced, _ = await _compare_with_bulk(fresh_db)
    assert not d, _report(d)
    assert not referenced, referenced
    reps = await _reps(fresh_db, [J1, JR])
    assert reps == {J1: False, JR: True}
    c = await asyncpg.connect(fresh_db)
    try:
        assert await c.fetchval("SELECT c.cycle_id FROM rd.job j JOIN rd.cycle c ON c.cyc_key = j.cyc_key WHERE j.job_id = $1", JP) == CY
    finally:
        await c.close()


async def _web_report_count(url: str, prompt_id: uuid.UUID) -> int:
    c = await asyncpg.connect(url)
    try:
        return int(await c.fetchval("SELECT count(*) FROM rd.web_report_prompt w JOIN rd.dim_prompt d ON d.prompt_key = w.prompt_key "
                                    "WHERE d.prompt_id = $1", prompt_id))
    finally:
        await c.close()


async def _geo_pair(url: str, job_id: uuid.UUID) -> tuple[str, str]:
    c = await asyncpg.connect(url)
    try:
        r = await c.fetchrow("""SELECT g.code AS geo, rg.code AS rgeo FROM rd.job j
                                  JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
                                  JOIN rd.dim_country g ON g.geo_key = a.geo_key JOIN rd.dim_country rg ON rg.geo_key = a.region_geo_key
                                 WHERE j.job_id = $1""", job_id)
        return r["geo"], r["rgeo"]
    finally:
        await c.close()


async def _reps(url: str, jobs: list[uuid.UUID]) -> dict:
    c = await asyncpg.connect(url)
    try:
        return dict(await c.fetch("""SELECT j.job_id, a.is_rep FROM rd.job j JOIN rd.answer a ON a.surface = j.surface
                                       AND a.round_date = j.round_date AND a.answer_key = j.answer_key WHERE j.job_id = ANY($1::uuid[])""", jobs))
    finally:
        await c.close()


# 비교에서 빼는 열: 발급 정수 키(자연 키로 바꿔 비교)·적재 메타(load_id·세대·first_seen·발급 당시 rule_ver)뿐. 새 열이 생기면 SPECS 에 넣거나
# 여기 사유와 함께 넣는다(조용히 비교 밖에 남지 않게: stg P87 region_geo_key 가 비교 밖이라 NULL 적재를 못 잡았다).
NOT_COMPARED = {"rd.job": {"load_id"}, "rd.answer": {"load_id"}, "rd.cycle": {"generation"}, "rd.report_unit_value": {"load_id"},
                "rd.dim_brand_name": {"brand_key", "first_seen"}, "rd.dim_entity": {"entity_key", "first_seen"}, "rd.dim_source": {"source_key"},
                "rd.dim_url": {"url_key"}, "rd.dim_prompt": {"prompt_key", "rule_ver"}, "rd.dim_engine": {"engine_key"},
                "rd.dim_country": {"geo_key"}, "rd.dim_project": {"project_key"}, "rd.catalog_entry": {"load_id"},
                "rd.web_unit": {"project_key", "file_seq", "rule_ver"}}


@needs_db
async def test_snapshot_covers_every_projection_column():
    from ingest.testkit import SPECS
    from tests.support import DB_URL

    c = await asyncpg.connect(DB_URL)
    try:
        for t in EQ_TABLES:
            rel, spec = SPECS[t]
            cols = {r[0] for r in await c.fetch("SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 "
                                                "AND NOT attisdropped", rel)}
            assert cols - {x for x, _ in spec} == NOT_COMPARED.get(t, set()), t
    finally:
        await c.close()


@pytest.mark.parametrize("name", sorted(PROJECTION_SEED_ARGS))
def test_profile_spec_turns_on_projection_switch(name):
    assert getattr(PROFILE, name)


# 투영 스위치 표식(/*row_src*/·/*web_tgt*/·/*name_coll*/·/*attrib_member*/)이 든 문장은 실행 직전 프로필 치환을 거쳐야 한다(be/ecat-int 에서 FACT_SRC 를
# 나누며 표식이 다른 문장으로 옮겨 증분 적재가 WU-5 스위치를 끈 채 돌던 결함의 회귀 방지: 표식 문장 집합 = 치환 함수가 감싸는 문장 집합).
_MARKED = {"FACT_SRC": "fact_src_sql", "PAIRS": "name_sql", "NAME_CHANGED": "name_sql", "PRIOR_NAMES": "name_sql", "RUNC": "runc_sql"}


def test_marked_statements_always_go_through_profile_substitution():
    import ast
    import pathlib

    from ingest.project.apply import queries as q

    marks = ("/*row_src*/", "/*web_tgt*/", q.NAME_COLL_MARK, q.ATTRIB_MARK)
    marked = {n for n, v in vars(q).items() if n.isupper() and isinstance(v, str) and any(m in v for m in marks)
              and n not in ("ATTRIB_MARK", "NAME_COLL_MARK")}
    assert marked == set(_MARKED), marked ^ set(_MARKED)
    root = pathlib.Path(q.__file__).resolve().parents[2]
    for f in root.rglob("*.py"):
        if "tests" in f.parts or f.name == "queries.py":
            continue
        # 코드(AST)만 본다: 독스트링·주석의 'queries.FACT_SRC' 언급은 실행이 아니다(be/ecat-int ecat.py 머리 주석이 정규식 가드에 걸렸다)
        tree = ast.parse(f.read_text(encoding="utf-8"))
        wrapped: set[int] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                fn = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
                if fn in set(_MARKED.values()):
                    wrapped |= {id(a) for a in node.args}
        for node in ast.walk(tree):
            name = (node.attr if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                    and node.value.id in ("q", "aq", "queries") else node.id if isinstance(node, ast.Name) else None)
            if name in _MARKED and isinstance(getattr(node, "ctx", None), ast.Load):
                assert id(node) in wrapped and any(
                    isinstance(c, ast.Call) and node in c.args
                    and (c.func.attr if isinstance(c.func, ast.Attribute) else getattr(c.func, "id", "")) == _MARKED[name]
                    for c in ast.walk(tree)), f"{f}:{node.lineno} {name} 이 {_MARKED[name]} 없이 쓰인다"
    on = q.fact_src_sql(q.FACT_SRC, PROFILE)
    assert q.ROW_SRC_ON in on and q.WEB_TGT_ON in on and "/*row_src" not in on and "/*web_tgt" not in on
    assert "/*attrib_member*/true" in q.runc_sql(PROFILE) and "en-US-x-icu" in q.name_sql(q.PAIRS, PROFILE)
