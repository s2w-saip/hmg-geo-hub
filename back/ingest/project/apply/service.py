"""ingest.project.apply: 판정·읽기 투영(IG-2, DB-보정 §4 4~8단계) · 재투영 · 재판정.

FUNC 표면(HTTP 없음)
  apply(conn, ctx, changed_keys)     적재 트랜잭션 안: 바뀐 job 의 rd.job·rd.answer·자식·당사 요약·게이트·is_rep·ACR 재투영
  reproject(conn, ctx, answer_keys)  운영 요청·재판정이 부르는 같은 함수(판정 입력만 바뀌어 전역 영향 감지 불필요)
  rejudge(conn, ctx, kind, change)   judgment_change 판정 입력 kind → 영향 답변 계산 → 차원 갱신 → reproject

판정식의 정본은 bulk 시드(seed-30·40)이고 이 모듈은 같은 식을 답변 키 집합으로 좁혀 실행한다(queries.py 머리 주석).
동치(같은 ing 입력 → 증분 경로 rd = bulk rd, 행 단위)는 tests/test_equivalence.py 가 대조한다.

재투영 방식: 영향 답변을 옛 좌표(rd.job 경유)에서 지우고 다시 넣는다(leaf 재구축 전용 열 source_key·url_key·brand_key·competitive·
rk·owner_key·loc_owned·tgt_hit 가 바뀌어도 같은 경로. HOT 규율상 제자리 UPDATE 대상이 아닌 열을 UPDATE 하지 않는다).
전파 직전 ANALYZE(방금 채운 leaf 통계, seed-40 §8), rd.propagate_answer_gates 5만 청크, rd.assert_answer_cit_counts(엄격),
rd.assert_answer_nc(DB-v2.15 P89 A41 모수 열), cit_n_all·cit_c1..13(P86)·region_geo_key(P87) 재계산 대조,
당사 합 불변식을 같은 트랜잭션에서 단언한다. 위반은 예외 → 적재 트랜잭션 롤백.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from app.core.profile import active_profile
from ingest.common.config import get_ingest_settings
from ingest.common.db import LoadContext, analyze, lock_dims
from ingest.common.rules import ecat_overlay_sql, refresh_app_rules, set_ecat_target, set_name_rule
from ingest.frz import keep as frz_keep

from . import queries as q

log = logging.getLogger("hgh.ingest.apply")

FACT_TABLES = ("rd.job", "rd.answer", "rd.answer_brand", "rd.answer_stance", "rd.citation")


class Escalated(Exception):
    """영향 답변이 단일 트랜잭션 상한을 넘었다(escalated_rebuild: leaf 스왑 재구축으로 넘긴다)."""

    def __init__(self, n: int, limit: int):
        super().__init__(f"영향 답변 {n} > 상한 {limit}")
        self.n = n
        self.limit = limit


class InvariantError(Exception):
    """적재 불변식 위반(롤백 대상)."""


# WEBREG16(DB-v2.16 P93, WU-7): 새 웹 프롬프트의 보고서 유닛 소속. 패치 전 DB 면 함수가 없어 건너뛴다(배포 순서 무관).
WEB_REPORT_READY = "SELECT to_regprocedure('rd.refresh_web_report_prompt(int4[])') IS NOT NULL"
WEB_REPORT_NEW_KEYS = ("SELECT coalesce(array_agg(d.prompt_key ORDER BY d.prompt_key), '{}') FROM rd.dim_prompt d "
                       "JOIN _ig_np n ON n.prompt_id = d.prompt_id WHERE d.surface = 2")


# WU-12(DB-v2.20 P111): ⑥ 미러 정의 타겟 URL 사전 해석. 패치 전 DB 면 건너뛴다(배포 순서 무관).
WEB_TARGET_READY = "SELECT to_regprocedure('rd.refresh_web_target_url(int4[], int4[])') IS NOT NULL"
WEB_TARGET_LOAD_URLS = ("SELECT coalesce(array_agg(DISTINCT d.url_key), '{}') FROM rd.dim_url d JOIN _ig_u u ON u.url_hash = d.url_hash")
WEB_TARGET_NEW_GROUPS = ("SELECT coalesce(array_agg(DISTINCT d.project_key::int4 * 65536 + d.lang_key::int4), '{}') FROM rd.dim_prompt d "
                         "JOIN _ig_np n ON n.prompt_id = d.prompt_id WHERE d.surface = 2 AND cardinality(d.targets) > 0")


async def refresh_web_target(conn: asyncpg.Connection, url_keys: list[int] | None, groups: list[int] | None) -> int:
    """rd.web_target_url 를 범위 안에서 맞춘다(url_key 집합·(프로젝트 × 65536 + 언어) 집합, 둘 다 None = 전체). 빈 목록 = 할 일 없음."""
    if (url_keys is not None and not url_keys) or (groups is not None and not groups):
        return 0
    if not await conn.fetchval(WEB_TARGET_READY):
        return 0
    return int(await conn.fetchval("SELECT rd.refresh_web_target_url($1::int4[], $2::int4[])", url_keys, groups) or 0)


async def refresh_web_report(conn: asyncpg.Connection, keys: list[int] | None) -> int:
    """rd.web_report_prompt 를 기대값으로 맞춘다(keys None = 전체, 빈 목록 = 할 일 없음). 반환 = 바뀐 행 수(패치 전 DB 는 0)."""
    if keys is not None and not keys:
        return 0
    if not await conn.fetchval(WEB_REPORT_READY):
        return 0
    return int(await conn.fetchval("SELECT rd.refresh_web_report_prompt($1::int4[])", keys) or 0)


@dataclass
class ApplyResult:
    answers: int = 0                 # 다시 넣은 rd.answer 행
    jobs: int = 0                    # 다시 넣은 rd.job 행
    children: int = 0
    gate_propagated: int = 0
    rep_flips: int = 0
    impacted_by_names: int = 0
    impacted_by_urls: int = 0
    moved_runs_jobs: int = 0
    surfaces: set[int] = field(default_factory=set)
    warnings: list[str] = field(default_factory=list)
    frz_kept: int = 0                # 동결 층 보관 관문(DB-v2.21 P117): 이번에 보관한 (세대, 답변)
    frz_settled: int = 0             # 그중 값이 같아 정리한 것


async def _keys(conn: asyncpg.Connection, sql: str, *args: Any) -> list[int]:
    return [int(r[0]) for r in await conn.fetch(sql, *args)]


async def _prepare_scope(conn: asyncpg.Connection, res: ApplyResult) -> None:
    """_ig_s 가 바뀐 뒤 부르는 준비: 코호트 귀속 → 이동 run 의 job·ACR 형제 편입 → job 원천 표."""
    for _ in range(4):                                 # 편입이 멎을 때까지(보통 1~2회)
        await conn.execute(q.runc_sql())
        moved = await _keys(conn, q.RUNC_MOVED_KEYS)
        grow = [k for k in moved]
        sib = await _keys(conn, q.SIBLING_KEYS)
        before = await conn.fetchval("SELECT count(*) FROM _ig_s")
        if grow:
            await conn.execute(q.ADD_S, grow)
        if sib:
            await conn.execute(q.ADD_S, sib)
        after = await conn.fetchval("SELECT count(*) FROM _ig_s")
        res.moved_runs_jobs += max(0, len(set(grow)))
        if after == before:
            break
    await conn.execute(q.JOBS)
    await conn.execute(q.JOBS0)
    await conn.execute(q.ACR_SCOPE)


async def project(conn: asyncpg.Connection, ctx: LoadContext, changed_keys: list[int], *, extra_keys: list[int] | None = None,
                  extra_runs: list[Any] | None = None, extra_prompts: list[Any] | None = None, extra_entities: list[Any] | None = None,
                  extra_prompt_runs: list[Any] | None = None, detect_global: bool = True, escalate_at: int | None = None,
                  repick_names: bool = False, ecat_ver: int | None = None, ecat_force: bool = False) -> ApplyResult:
    """투영 본체. changed_keys = 내용이 바뀐 job(전역 판정 영향 감지 기준), extra_* = 판정 입력만 바뀐 대상.

    엔티티 버전(E1): ecat_ver = 기준 버전(None = 활성 버전, 활성도 없으면 legacy = 기존 명부 그대로). 답변 버전 = 그 회차의
    rd.cycle.ecat_ver(노출 때 고정) → 기준 버전. ecat_force = 고정을 무시하고 전부 기준 버전(미리보기·전 기간 반영).
    rd.answer.ecat_ver 에 답변 버전을 기록한다. 버전 전환(활성화)·rd.cycle 고정은 이 함수가 하지 않는다(E5).
    앞 단계(범위·차원·투영 원천 임시 표)는 stage() 이고 이 함수는 그 뒤 사실 행 쓰기를 더한다(E4 미리보기는 stage() 만 부른다)."""
    res = await stage(conn, ctx, changed_keys, extra_keys=extra_keys, extra_runs=extra_runs, extra_prompts=extra_prompts,
                      extra_entities=extra_entities, extra_prompt_runs=extra_prompt_runs, detect_global=detect_global,
                      escalate_at=escalate_at, repick_names=repick_names, ecat_ver=ecat_ver, ecat_force=ecat_force)
    return await _write_facts(conn, ctx, res)


async def stage(conn: asyncpg.Connection, ctx: LoadContext, changed_keys: list[int], *, extra_keys: list[int] | None = None,
                extra_runs: list[Any] | None = None, extra_prompts: list[Any] | None = None, extra_entities: list[Any] | None = None,
                extra_prompt_runs: list[Any] | None = None, detect_global: bool = True, escalate_at: int | None = None,
                repick_names: bool = False, ecat_ver: int | None = None, ecat_force: bool = False) -> ApplyResult:
    """project() 의 앞 단계: 답변 키 집합(_ig_s) 확정 → 차원(NS_DIM 잠금 아래, 추적 표) → 투영 원천 임시 표(_ig_job·_ig_ans·_ig_mr·
    _ig_ab·_ig_own·_ig_cr·_ig_citf·_ig_citc). 사실 표(rd.job·answer·answer_brand·answer_stance·citation·acr_*)는 쓰지 않는다.
    E4 미리보기는 이 함수만 저장점 안에서 부르고 임시 표를 읽은 뒤 저장점을 되돌린다(차원 쓰기도 함께 사라진다)."""
    res = ApplyResult()
    await set_ecat_target(conn, ecat_ver, ecat_force)     # 같은 트랜잭션의 앞 호출 값이 남지 않게 매번 정한다(빈 값 = 활성 버전)
    await refresh_app_rules(conn)
    await conn.execute(q.MAKE_S0)
    await conn.execute(q.PRIOR_MAKE)                  # capture_prior 가 없던 호출(재판정·운영)은 빈 표
    await conn.execute(q.FILL_S0, [int(k) for k in changed_keys])
    await conn.execute(q.S_FROM_S0)
    if extra_keys:
        await conn.execute(q.ADD_S, [int(k) for k in extra_keys])
    if extra_runs:
        await conn.execute(q.ADD_XRUNS, list(extra_runs))
        await conn.execute("""INSERT INTO _ig_s SELECT k.answer_key FROM ing.answer a JOIN ing.answer_key_map k ON k.job_id = a.job_id
                               WHERE a.run_id IN (SELECT run_id FROM _ig_xruns) ON CONFLICT DO NOTHING""")
    if extra_prompts:
        await conn.execute(q.ADD_XPROMPTS, list(extra_prompts))
    if extra_entities:
        await conn.execute(q.ADD_XENTS, list(extra_entities))
    if extra_prompt_runs:
        await conn.execute(q.ADD_PR, list(extra_prompt_runs))
    await _prepare_scope(conn, res)

    # 전역 판정 영향(바뀐 job 기준): 대표 표기·URL 판정이 바뀌면 그 값을 쓰는 기존 답변도 다시 투영
    await conn.execute(q.ENT_IDS)
    await conn.execute(q.PAIR_SRC)
    await conn.execute(q.name_sql(q.PAIRS))
    if detect_global:
        grew = False
        changed_ents = [r[0] for r in await conn.fetch(q.name_sql(q.NAME_CHANGED))]
        if changed_ents:
            ks = await _keys(conn, q.NAME_IMPACT_KEYS, changed_ents)
            prs = [r[0] for r in await conn.fetch(q.NAME_IMPACT_PR, changed_ents)]
            ents = [r[0] for r in await conn.fetch(q.NAME_IMPACT_ENTS, changed_ents)]
            if ents:
                await conn.execute(q.ADD_XENTS, ents)
                grew = True
            if ks:
                await conn.execute(q.ADD_S, ks)
                res.impacted_by_names = len(ks)
                grew = True
            if prs:
                await conn.execute(q.ADD_PR, prs)
                grew = True
        await conn.execute(q.URLS)
        ks = await _keys(conn, q.URL_CHANGED_KEYS)
        if ks:
            await conn.execute(q.ADD_S, ks)
            res.impacted_by_urls = len(ks)
            grew = True
        if grew:
            await _prepare_scope(conn, res)
            await conn.execute(q.ENT_IDS)
            await conn.execute(q.PAIR_SRC)
            await conn.execute(q.name_sql(q.PAIRS))
    else:
        await conn.execute(q.URLS)

    n_scope = int(await conn.fetchval("SELECT count(*) FROM _ig_s"))
    limit = escalate_at if escalate_at is not None else get_ingest_settings().escalate_answers
    if n_scope > limit:
        raise Escalated(n_scope, limit)

    # 차원(수동 키는 NS_DIM 잠금 아래 max+1)
    await lock_dims(conn)
    await conn.execute(q.DIM_ENGINE)
    await conn.execute(q.DIM_COUNTRY, [r[0] for r in await conn.fetch(q.COUNTRY_CODES)])
    await conn.execute(q.NEW_PROMPTS)
    await conn.execute(q.DIM_LANG)
    await conn.execute(q.DIM_PROJECT, [r[0] for r in await conn.fetch(q.RUN_PROJECTS)])
    await conn.execute(q.DIM_PROMPT, ctx.rule_ver)
    if await refresh_web_report(conn, [int(k) for k in (await conn.fetchval(WEB_REPORT_NEW_KEYS) or [])]):
        ctx.rd_changed = True
    new_groups = [int(g) for g in (await conn.fetchval(WEB_TARGET_NEW_GROUPS) or [])]     # 새 웹 프롬프트의 (프로젝트, 언어)
    await conn.execute(q.ACR_NM)
    await conn.execute(q.DIM_BRAND)
    if repick_names:
        await conn.fetch(q.REPICK_NAMES)
    await conn.execute(q.DIM_ENTITY)
    await conn.execute(q.DIM_SOURCE, ctx.rule_ver)
    await conn.execute(q.DIM_URL, ctx.rule_ver)
    # WU-12: 이 적재 URL(새로 넣거나 정규형이 바뀐 행 포함)과 새 웹 프롬프트 타겟의 사전 해석. url_key 범위는 PK 조회라 싸다
    if await refresh_web_target(conn, [int(k) for k in (await conn.fetchval(WEB_TARGET_LOAD_URLS) or [])], None) + \
            await refresh_web_target(conn, None, new_groups):
        ctx.rd_changed = True

    # 회차 귀속 단언(IG-3 attribute 가 먼저 돌아야 한다)
    un = await conn.fetchval(q.RUNC_UNATTRIBUTED)
    if un:
        raise InvariantError(f"회차 미귀속 run {un}(ing.cycle_run 누락: cycles.attribute 먼저)")
    pin_un = await conn.fetchval(q.RUNC_PIN_UNRESOLVED)
    if pin_un:
        res.warnings.append(f"R02 pin 회차 미해소 run {pin_un}: run 귀속 회차 유지")

    # 사실 원천 → 옛 행 삭제 → 삽입
    await conn.execute(q.fact_src_sql(q.FACT_SRC))    # 인용 판정 투영 스위치(G21A·OWN4, WU-5)
    miss = await conn.fetchval(q.JOB_UNMATCHED)
    if miss:
        raise InvariantError(f"투영 원천 누락 job {miss}(rd.cycle·rd.dim_project 투영 누락)")
    # 엔티티 버전 오버레이(E1): 차단·재매칭 보정(_ecat_madj·_ecat_hnew) → 유효 언급 → 표시 브랜드 접기
    await conn.execute(q.ECAT_IN)
    await conn.execute(ecat_overlay_sql())
    await conn.execute(q.fact_src_sql(q.FACT_MR))      # 표식은 FACT_SRC 에만 있다(시험 test_ecat_profile 이 단언): 여기는 무해한 보험
    return res


async def _write_facts(conn: asyncpg.Connection, ctx: LoadContext, res: ApplyResult) -> ApplyResult:
    """project() 의 뒤 단계(stage() 가 만든 임시 표 → 옛 행 삭제 → 사실 행 삽입 → 대표·전파·단언 → ACR). project 만 부른다.
    사실 쓰기 SQL 상수를 참조하는 함수 = 이 함수·_project_acr(결과 캐시 쓰기 분류 tests/core/rcache_writers.py WRITER_FUNCS).
    동결 층 보관 관문(DB-v2.21 P117, ingest.frz.keep): 옛 행을 지우기 전에 다시 쓸 답변(_ig_s) 중 활성 동결 셀 답변의 지금 행을 보관하고,
    끝에서 값이 같아진 보관을 정리한다. rd 사실 행을 쓰는 적재 경로는 전부 이 함수를 지난다(tests/core/test_frz_keep_gate.py)."""
    rewrite = await _keys(conn, "SELECT answer_key FROM _ig_s ORDER BY answer_key")
    res.frz_kept = await frz_keep.before(conn, rewrite)
    await conn.execute(q.OLD_COORDS)
    await conn.execute(q.DELETE_OLD)
    for r in await conn.fetch(q.LEAVES):
        await conn.execute("SELECT rd.ensure_leaf($1::int2, $2::date)", r["surface"], r["m"])
    res.jobs = _n(await conn.execute(q.INSERT_JOB, ctx.load_id))
    res.answers = _n(await conn.execute(q.INSERT_ANSWER, ctx.rule_ver, ctx.load_id))

    # R05 대표 재선정(새 셀 ∪ 옛 셀, 제자리 UPDATE). 이 적재가 넣은 행의 최초 true 는 뒤집힘으로 세지 않는다.
    # 규칙 = 현행 프로필 rep_pick_latest_first(core.profile, 적재기 활성 프로필. WU-2). 자식 삽입 앞에 둔다(DB-v2.15 P85): 이 적재의 자식은
    # 부모 최종 is_rep 으로 바로 들어가고(REP_STAGE), 뒤집힌 다른 답변(own 거짓)만 게이트 전파로 자식 사본을 맞춘다.
    await conn.execute(q.REP_CELLS)
    prof = active_profile()
    # 답변분석 경로 셀 대표(rep_round_date_cell, WU-12, DB-v2.19 P110)가 우선: is_rep = round_date 셀 규칙(원본 시각), 인용 계열 보정 rd.rep_cit_delta 를
    # 같은 함수가 범위 교체. 아니면 회차 셀 규칙 둘(rep_pick_latest_first)
    rep_sql = (q.REP_UPDATE_SEAT if prof.rep_round_date_cell
               else q.REP_UPDATE_LATEST_FIRST if prof.rep_pick_latest_first else q.REP_UPDATE)
    flips = await conn.fetch(rep_sql)
    res.rep_flips = sum(1 for f in flips if not f["own"])
    flipped_other = sorted({int(f["answer_key"]) for f in flips if not f["own"]})
    await conn.execute(q.REP_STAGE)

    await conn.execute(q.INSERT_BRAND, ctx.rule_ver)
    await conn.execute(q.INSERT_STANCE)
    await conn.execute(q.INSERT_CITATION, ctx.rule_ver)
    # 재pull 로 원천 행이 0 이 된 URL·엔티티 차원 정리(bulk = 전 ing 행에서 발급) → 스냅샷 소비
    gone_urls = [int(r[0]) for r in await conn.fetch(q.URL_ORPHANS_DELETE)]
    # 지운 URL 의 타겟 사전 해석 행(DB-v2.20 P111)도 맞춘다: 위 refresh_web_target 은 이 삭제 전에 돌아 url_key 가 가리키는 dim_url 이
    # 사라진 행을 남긴다(be/int2 동치 시험이 잡음: bulk = 지금 dim_url 로 다시 계산이라 그 행이 없다)
    if gone_urls and await refresh_web_target(conn, gone_urls, None):
        ctx.rd_changed = True
    await conn.execute(q.ENTITY_ORPHANS_DELETE)
    await conn.execute(q.PRIOR_CLEAR)
    cc = await conn.fetchrow(q.CHILD_COUNTS)
    res.children = int(cc["n"])

    # 전파 직전 ANALYZE → 게이트 전파(5만 청크) + 인용 수 단언(엄격) → 당사 합·1:1 그레인 단언
    await analyze(conn, FACT_TABLES)
    served = await _keys(conn, q.SERVED_KEYS)
    chunk = get_ingest_settings().gate_chunk
    for i in range(0, len(served), chunk):
        part = served[i:i + chunk]
        res.gate_propagated += int(await conn.fetchval("SELECT rd.propagate_answer_gates($1::int4[])", part) or 0)
        await conn.fetchval("SELECT rd.assert_answer_cit_counts($1::int4[], true)", part)
        await conn.fetchval("SELECT rd.assert_answer_nc($1::int4[])", part)      # DB-v2.15 P89(A41 모수 열 = 재계산, 자식 사본 = 부모)
        bad_ext = await conn.fetchval(q.ASSERT_CIT_EXT, part)                     # DB-v2.15 P86(WU-5 cit_n_all·cit_c1..13 = 재계산)
        if bad_ext:
            raise InvariantError(f"cit_n_all·cit_c1..13 ≠ 재계산 {bad_ext} 답변(DB-v2.15 P86)")
        bad_geo = await conn.fetchval(q.ASSERT_REGION_GEO, part)                  # DB-v2.15 P87(WU-7 region_geo_key = 재계산, NULL 금지)
        if bad_geo:
            raise InvariantError(f"region_geo_key ≠ 재계산 {bad_geo} 답변(DB-v2.15 P87)")
    for i in range(0, len(flipped_other), chunk):   # 인용 수는 안 바뀌었다(대표만 뒤집힘): 인용 단언 불필요
        res.gate_propagated += int(await conn.fetchval("SELECT rd.propagate_answer_gates($1::int4[])", flipped_other[i:i + chunk]) or 0)
    bad = await conn.fetchval(q.ASSERT_OWN)
    if bad:
        raise InvariantError(f"당사 합 ≠ 답변 열 {bad}(G-03 불변식)")
    g = await conn.fetchrow(q.ASSERT_GRAIN)
    if g["cit_diff"] or g["st_diff"]:
        raise InvariantError(f"1:1 그레인 위반 citation {g['cit_diff']} stance {g['st_diff']}")

    # ACR(prompt-run 1:1)
    await _project_acr(conn, ctx, res)
    # 동결 층 보관 정리: 이번에 보관한 답변 중 다시 쓴 값이 같은 것(장부 열 제외)은 보관을 푼다
    res.frz_settled = await frz_keep.settle(conn, rewrite) if res.frz_kept else 0

    res.surfaces |= {int(r[0]) for r in await conn.fetch(q.TOUCHED_SURFACES)}
    ctx.surfaces |= res.surfaces
    if res.jobs or res.answers or res.rep_flips or res.surfaces:
        ctx.rd_changed = True
    ctx.add("rd_answers_upserted", res.answers)
    ctx.add("rd_gate_propagated", res.gate_propagated)
    ctx.add("rd_rep_flips", res.rep_flips)
    ctx.add("rd_children_rows", res.children)
    if res.frz_kept:
        ctx.add("frz_kept", res.frz_kept - res.frz_settled)
    return res


async def _project_acr(conn: asyncpg.Connection, ctx: LoadContext, res: ApplyResult) -> None:
    n = await conn.fetchval("SELECT count(*) FROM _ig_pr")
    if not n:
        await conn.execute("DROP TABLE IF EXISTS _ig_acr; CREATE TEMP TABLE _ig_acr (surface int2) ON COMMIT DROP;"
                           "DROP TABLE IF EXISTS _ig_acr_old; CREATE TEMP TABLE _ig_acr_old (surface int2) ON COMMIT DROP;")
        return
    miss = await conn.fetchval(q.ACR_RUNC_MISSING)
    if miss:   # 이름 영향으로 들어온 다른 run 의 prompt-run: 그 run 들의 귀속도 판정 범위에 넣는다
        await conn.execute("INSERT INTO _ig_xruns SELECT DISTINCT run_id FROM ing.acr_prompt_run WHERE prompt_run_id IN (SELECT prompt_run_id FROM _ig_pr) ON CONFLICT DO NOTHING")
        await conn.execute(q.runc_sql())
    await conn.execute(q.ACR_DELETE)
    await conn.execute(q.ACR_PREP)
    await conn.execute(q.ACR_INSERT_CELL, ctx.rule_ver)
    await conn.execute(q.ACR_INSERT_REST)
    await conn.execute(q.ACR_REP)
    d = await conn.fetchrow(q.ACR_ASSERT)
    if d["cell_diff"] or d["choice_diff"]:
        raise InvariantError(f"ACR 1:1 위반 cell {d['cell_diff']} choice {d['choice_diff']}")
    res.surfaces |= {int(r[0]) for r in await conn.fetch(q.ACR_SURFACES)}


async def capture_prior(conn: asyncpg.Connection, answer_keys: list[int]) -> None:
    """바뀐 job 의 ing 자식 행을 지우기 전에 부른다(적재 트랜잭션 안). 옛 인용 URL·언급/스탠스 엔티티·옛 대표 표기를 잡아 두면
    다음 apply 가 새 집합과 합쳐 전역 판정(URL 최빈 도메인·대표 표기)을 다시 세고, 원천 행이 0 이 된 차원 행을 지운다(결함 D2·D6).
    부르지 않으면 줄어드는 방향의 변경을 감지하지 못한다(늘어나는 방향은 새 행만으로 감지된다)."""
    keys = [int(k) for k in answer_keys]
    await set_name_rule(conn)                       # 옛 대표 표기도 같은 이름 규칙(NAME: 롤업 대표 표기 원장 포함)으로 잡는다
    await conn.execute(q.PRIOR_MAKE)
    if not keys:
        return
    await conn.execute(q.PRIOR_URLS, keys)
    await conn.execute(q.PRIOR_ENTS, keys)
    await conn.execute(q.name_sql(q.PRIOR_NAMES), keys)


async def capture_prior_acr(conn: asyncpg.Connection, prompt_run_ids: list[Any]) -> None:
    """ACR prompt-run 의 롤업 행을 지우고 다시 쓰기 직전에 부른다(적재 트랜잭션 안, sync _write_acr). 지워질 옛 롤업 엔티티를
    _ig_prior_ent 에 넣어 다음 apply 가 dim_entity 를 다시 세고, 롤업에서만 나오던 엔티티가 빠져 원천 행이 0 이 되면 지운다(결함 N1).
    capture_prior 와 같은 표에 쌓는다(먼저 부른 쪽의 값을 지우지 않는다)."""
    await conn.execute(q.PRIOR_MAKE)
    ids = [x for x in prompt_run_ids if x is not None]
    if ids:
        await conn.execute(q.PRIOR_ACR_ENTS, ids)


def _n(tag: str) -> int:
    try:
        return int(str(tag).split()[-1])
    except (ValueError, IndexError):
        return 0


async def apply(conn: asyncpg.Connection, ctx: LoadContext, changed_keys: list[int], *, extra_runs: list[Any] | None = None) -> ApplyResult:
    """적재 트랜잭션 안(4~8단계): 바뀐 job 과 상태가 바뀐 run(extra_runs, R07 run 상태 게이트) 을 투영한다."""
    return await project(conn, ctx, changed_keys, extra_runs=extra_runs)


async def reproject(conn: asyncpg.Connection, ctx: LoadContext, answer_keys: list[int], *, extra_runs: list[Any] | None = None,
                    extra_prompt_runs: list[Any] | None = None, escalate_at: int | None = None, ecat_ver: int | None = None,
                    ecat_force: bool = False, extra_entities: list[Any] | None = None) -> ApplyResult:
    """판정 입력만 바뀐 답변의 재투영(내용 불변이라 전역 영향 감지 생략). ecat_ver·ecat_force = project 와 같다(E4·E5 반영이 부른다)."""
    return await project(conn, ctx, [], extra_keys=answer_keys, extra_runs=extra_runs, extra_prompt_runs=extra_prompt_runs,
                         extra_entities=extra_entities, detect_global=False, escalate_at=escalate_at, ecat_ver=ecat_ver, ecat_force=ecat_force)
