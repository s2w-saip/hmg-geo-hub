"""적재 모듈 테스트 도구(운영 코드가 import 하지 않는다).

- bulk_seed(conn): bulk 시드(migration/seed/seed-30-dims.sql → seed-40-facts.sql)를 psql 없이 asyncpg 로 실행한다.
  psql 메타 명령(\\ir·\\set·\\if·\\gset·\\timing)만 풀고 SQL 은 그대로 보낸다. BEGIN·COMMIT 은 지우고 호출자 트랜잭션 안에서 돈다
  (테스트는 끝에 롤백). 동치 테스트의 기준값(같은 ing 입력의 bulk rd)을 만든다.
- snapshot(conn): rd 표를 자연 키(job_id·cycle_id·prompt_id·bare·entity_id·url_hash·skey·코드)로 바꾼 정렬 목록.
  정수 키 발급 순서·load_id·세대·first_seen 은 경로마다 달라 비교에서 뺀다(나머지 열은 전부 비교).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import asyncpg

SEED_DIR = Path(__file__).resolve().parents[1] / "migration" / "seed"
_VAR = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)\b")
_GSET = re.compile(r"\\gset\s*$")


def _expand(path: Path, flags: dict[str, bool] | None = None) -> list[str]:
    """\\ir 를 펼치고 \\if 는 flags 로 가지를 고른다: \\if :{?x} 는 x 가 flags 에 있으면 참, \\if :x 는 flags[x] 가 참이면 참,
    없으면 else 쪽(flags 없음 = 종전: 항상 else 쪽, 예 \\if :{?work_mem}). 중첩 \\if 는 psql 처럼 쌓는다(WU-12,
    종전 비중첩 스크립트는 결과 같음). 나머지 메타 명령 줄은 버린다."""
    fl = flags or {}
    out: list[str] = []
    stack: list[bool] = []                       # 열린 \\if 마다 "이 가지를 실행 중인가"
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("\\if"):
            arg = s[3:].strip()
            if arg.startswith(":{?") and arg.endswith("}"):
                take = arg[3:-1] in fl
            elif arg.startswith(":"):
                take = bool(fl.get(arg[1:], False))
            else:
                take = False
            stack.append(take)
            continue
        if s.startswith("\\else"):
            stack[-1] = not stack[-1]
            continue
        if s.startswith("\\endif"):
            stack.pop()
            continue
        if not all(stack):
            continue
        if s.startswith("\\ir "):
            out.extend(_expand(path.parent / s.split(None, 1)[1], flags))
            continue
        if s.startswith("\\") and not _GSET.search(s):
            continue
        if re.fullmatch(r"(BEGIN|COMMIT);", s):
            continue
        out.append(line)
    return out


async def run_psql_script(conn: asyncpg.Connection, path: Path, flags: dict[str, bool] | None = None) -> dict[str, Any]:
    """메타 명령을 푼 스크립트 실행. \\gset 문장(한 줄 SELECT 또는 여러 줄 INSERT … RETURNING)은 그 자리에서 실행해
    변수를 채우고(:name 치환) 그 사이 SQL 은 여러 문장 묶음으로 보낸다(달러 인용 본문을 쪼개지 않는다)."""
    vars_: dict[str, Any] = {}

    def sub(text: str) -> str:
        return _VAR.sub(lambda m: str(vars_[m.group(1)]) if m.group(1) in vars_ else m.group(0), text)

    lines = _expand(path, flags)
    chunk: list[str] = []
    for line in lines:
        if not _GSET.search(line):
            chunk.append(line)
            continue
        # \gset 문장 = 직전 ';' 로 끝나는 줄 다음부터 이 줄까지
        cut = len(chunk)
        while cut > 0 and not chunk[cut - 1].rstrip().endswith(";"):
            cut -= 1
        head, stmt = chunk[:cut], chunk[cut:] + [_GSET.sub("", line)]
        chunk = []
        if _has_code("\n".join(head)):
            await conn.execute(sub("\n".join(head)))
        row = await conn.fetchrow(sub("\n".join(stmt)))
        if row is not None:
            vars_.update(dict(row))
    if _has_code("\n".join(chunk)):
        await conn.execute(sub("\n".join(chunk)))
    return vars_


def _has_code(sql: str) -> bool:
    return any(ln.strip() and not ln.strip().startswith("--") for ln in sql.splitlines())


# 투영 스위치(core.profile kind = projection 중 구현된 것) → bulk 시드 입력. 적재기는 같은 스위치를 활성 프로필로 읽는다(값이 같아야 증분 = bulk).
#   freeze_at_publish 는 미구현(설정이 켜지 못한다)이라 여기 없다. 새 투영 스위치를 구현하면 이 표와 bulk_seed 인자를 함께 늘린다
#   (ingest/project/apply/tests/test_incr_parity.py 가 core.profile 의 projection 스위치 전부가 이 표에 있는지 대조한다).
PROJECTION_SEED_ARGS = {
    "rep_pick_latest_first": "rep_latest_first",
    "rep_round_date_cell": "rep_round_date_cell",
    "resub_phantom_exclude": "attrib_member",
    "cit_hostless_per_row": "cit_row_host",
    "web_owned_target_base": "web_tgt_base",
    "display_name_latin": "legacy_name",
}


async def bulk_seed(conn: asyncpg.Connection, *, profile: Any = None, rep_latest_first: bool | None = None, attrib_member: bool | None = None,
                    cit_row_host: bool | None = None, web_tgt_base: bool | None = None, legacy_name: bool | None = None,
                    rep_round_date_cell: bool | None = None, frz_keep: bool = True) -> None:
    """seed-30 → seed-40 (같은 ing·app 입력으로 rd 전량 재구축). 호출자 트랜잭션 안(슈퍼유저 연결, TRUNCATE 권한 필요).
    시드 입력(투영 스위치)은 profile(core.profile.LegacyProfile, None = 지금 활성 프로필 = 적재기와 같은 값)에서 정하고, 인자를 주면 그 값이 이긴다.
    스위치를 고정하는 시험은 profile=OFF(또는 parse_profile(spec))를 넘겨 세션 프로필(HGH_TEST_LEGACY_PROFILE)과 무관하게 돈다.
    rep_latest_first = seed-40 psql 변수(R05 대표 규칙, 현행 프로필 rep_pick_latest_first).
    rep_round_date_cell = seed-40 psql 변수(is_rep = 답변분석 경로 round_date 셀 규칙 + 인용 계열 보정 표, 현행 프로필 같은 이름. DB-v2.19 P109·P110).
    attrib_member = seed-40 psql 변수(R02 답변 회차 = run 원장 멤버십, 현행 프로필 resub_phantom_exclude).
    cit_row_host·web_tgt_base = seed-40 psql 변수(인용 판정 투영 스위치 cit_hostless_per_row·web_owned_target_base, WU-5).
    legacy_name = 세션 GUC hgh.legacy_name(seed-3x-common §5 대표 표기 콜레이션, 현행 프로필 display_name_latin. 운영 = PGOPTIONS).
      seed-30·40 동안만 세션 값으로 건다(끝나면 지운다).
    frz_keep = 동결 층 보관(DB-v2.21 P117 관문, src bulk). False = 이관 명시 모드(psql -v frz_no_keep=1, 설계 12.11: 열 백필·fill 재구축은 보관하지 않는다)."""
    if profile is None:
        from app.core.profile import active_profile

        profile = active_profile()
    given = {"rep_latest_first": rep_latest_first, "attrib_member": attrib_member, "cit_row_host": cit_row_host,
             "web_tgt_base": web_tgt_base, "legacy_name": legacy_name,
             "rep_round_date_cell": rep_round_date_cell}
    flags = {arg: (bool(getattr(profile, sw)) if given[arg] is None else bool(given[arg])) for sw, arg in PROJECTION_SEED_ARGS.items()}
    if flags["legacy_name"]:                      # seed-30·40 이 둘 다 포함하는 seed-3x-common §5 가 읽는 GUC. 세션 값으로 걸고 두 시드 뒤 지운다(실패하면 호출자 롤백이 되돌린다)
        await conn.execute("SELECT set_config('hgh.legacy_name', '1', false)")
    nokeep = {} if frz_keep else {"frz_no_keep": True}
    await run_psql_script(conn, SEED_DIR / "seed-30-dims.sql", nokeep or None)
    vars_ = {k: True for k in ("rep_latest_first", "rep_round_date_cell", "attrib_member", "cit_row_host", "web_tgt_base")
             if flags[k]} | nokeep
    await run_psql_script(conn, SEED_DIR / "seed-40-facts.sql", vars_ or None)
    if flags["legacy_name"]:
        await conn.execute("SELECT set_config('hgh.legacy_name', '', false)")      # 세션 GUC 를 남기지 않는다(같은 연결의 뒤 시험)


async def bulk_seed_profile(conn: asyncpg.Connection, profile: Any) -> None:
    """프로필의 투영 스위치를 bulk 시드 입력으로 옮겨 bulk_seed 를 돈다(stg 재투영 절차와 같은 대응). = bulk_seed(conn, profile=profile)."""
    await bulk_seed(conn, profile=profile)


# ════════════════════════════════════════════════════════════════════════════
# 자연 키 스냅샷
# ════════════════════════════════════════════════════════════════════════════
_K = {
    "ak": "(SELECT m.job_id FROM ing.answer_key_map m WHERE m.answer_key = {c})",
    "run": "(SELECT r.run_id FROM ing.run r WHERE r.run_key = {c})",
    "cyc": "(SELECT y.cycle_id FROM ing.cycle y WHERE y.cyc_key = {c})",
    "prompt": "(SELECT p.prompt_id FROM rd.dim_prompt p WHERE p.prompt_key = {c})",
    "brand": "(SELECT b.bare FROM rd.dim_brand_name b WHERE b.brand_key = {c})",
    "entity": "(SELECT e.entity_id FROM rd.dim_entity e WHERE e.entity_key = {c})",
    "url": "(SELECT encode(u.url_hash, 'hex') FROM rd.dim_url u WHERE u.url_key = {c})",
    "source": "(SELECT s.skey FROM rd.dim_source s WHERE s.source_key = {c})",
    "engine": "(SELECT e.code FROM rd.dim_engine e WHERE e.engine_key = {c})",
    "geo": "(SELECT g.code FROM rd.dim_country g WHERE g.geo_key = {c})",
    "lang": "(SELECT l.code FROM rd.dim_lang l WHERE l.lang_key = {c})",
    "project": "(SELECT d.scope_project_id FROM rd.dim_project d WHERE d.project_key = {c})",
    "unit": "(SELECT d.scope_project_id::text || '#' || w.file_seq FROM rd.web_unit w JOIN rd.dim_project d ON d.project_key = w.project_key WHERE w.unit_key = {c})",
    "acr": "(SELECT p.prompt_run_id FROM ing.acr_prompt_run p WHERE p.acr_cell_key = {c})",
    "taxon": "(SELECT t.axis || ':' || t.code || ':' || coalesce(pt.code, '') FROM rd.dim_taxon t LEFT JOIN rd.dim_taxon pt ON pt.taxon_key = t.parent_key WHERE t.taxon_key = {c})",
    "region": "(SELECT r.code FROM rd.dim_region r WHERE r.region_key = {c})",
    # rd.citation.scope_key(seed-40 §4): global·project = project_key, website = unit_key(없으면 0). 표면별 자연 키로 바꾼다(결함 D7).
    "scope": ("(CASE WHEN {a}.surface = 2 THEN coalesce((SELECT d.scope_project_id::text || '#' || w.file_seq FROM rd.web_unit w"
              " JOIN rd.dim_project d ON d.project_key = w.project_key WHERE w.unit_key = {c}), '0')"
              " ELSE (SELECT d.scope_project_id::text FROM rd.dim_project d WHERE d.project_key = {c}) END)"),
}


def _cols(spec: list[tuple[str, str | None]], alias: str) -> str:
    out = []
    for col, kind in spec:
        ref = f"{alias}.{col}"
        out.append((_K[kind].format(c=ref, a=alias) if kind else ref) + f" AS {col}")
    return ", ".join(out)


SPECS: dict[str, tuple[str, list[tuple[str, str | None]]]] = {
    "rd.job": ("rd.job", [("answer_key", "ak"), ("job_id", None), ("run_key", "run"), ("prompt_key", "prompt"), ("cyc_key", "cyc"),
                          ("round_date", None), ("measured_at", None), ("surface", None), ("project_key", "project"), ("engine_key", "engine"),
                          ("geo_key", "geo"), ("lang_key", "lang"), ("bgrp", None), ("status_code", None), ("analysis_code", None),
                          ("dropped", None), ("served", None)]),
    "rd.answer": ("rd.answer", [("round_date", None), ("answer_key", "ak"), ("anchor_date", None), ("cyc_key", "cyc"), ("run_key", "run"),
                                ("prompt_key", "prompt"), ("surface", None), ("project_key", "project"), ("engine_key", "engine"),
                                ("geo_key", "geo"), ("lang_key", "lang"), ("cat_mask", None), ("bgrp", None), ("anchor_src", None),
                                ("acr_iter_rank", None), ("analysis_state", None), ("own_mask", None), ("own_rk_h", None), ("own_rk_k", None),
                                ("own_rk_g", None), ("ment_total", None), ("ment_h", None), ("ment_k", None), ("ment_g", None),
                                ("sent_pos_h", None), ("sent_pos_k", None), ("sent_pos_g", None), ("sent_neg_h", None), ("sent_neg_k", None),
                                ("sent_neg_g", None), ("sent_all_h", None), ("sent_all_k", None), ("sent_all_g", None), ("t_own", None), ("elig", None),
                                ("dflt", None), ("is_acr", None), ("is_rep", None), ("web_reg", None), ("has_cit", None), ("tgt_cited", None),
                                ("own_url_cited", None), ("acr_in", None), ("gap", None), ("std_in", None), ("cit_in", None),
                                ("rule_ver", None), ("cit_n", None), ("cit_own_h", None), ("cit_own_k", None), ("cit_own_g", None),
                                ("cit_own_hc", None), ("cit_own_kc", None), ("cit_own_gc", None), ("cit_own_x", None), ("cit_loc", None),
                                ("cit_tgt", None), ("cit_loc_tgt", None), ("cit_off", None), ("elig_nc", None), ("std_in_nc", None), ("cit_in_nc", None),
                                ("ecat_ver", None),
                                # DB-v2.15 P86(cit_n_all·cit_c1..13)·P87(region_geo_key, 자연 키 = 국가 코드)
                                ("cit_n_all", None), *((f"cit_c{i}", None) for i in range(1, 14)), ("region_geo_key", "geo")]),
    "rd.answer_brand": ("rd.answer_brand", [("round_date", None), ("answer_key", "ak"), ("brand_key", "brand"), ("cyc_key", "cyc"),
                                            ("prompt_key", "prompt"), ("surface", None), ("project_key", "project"), ("engine_key", "engine"),
                                            ("geo_key", "geo"), ("lang_key", "lang"), ("bgrp", None), ("own_bit", None), ("entity_rows", None),
                                            ("mention_count", None), ("rk", None), ("s_pos", None), ("s_neu", None), ("s_neg", None),
                                            ("s_mix", None), ("t_mention", None), ("t_recommendation", None), ("t_comparison", None),
                                            ("t_definition", None), ("t_final_choice", None), ("competitive", None), ("std_in", None),
                                            ("elig", None), ("dflt", None), ("rule_ver", None), ("std_in_nc", None), ("rid_n", None),
                                            ("is_rep", None)]),
    "rd.answer_stance": ("rd.answer_stance", [("round_date", None), ("answer_key", "ak"), ("entity_key", "entity"), ("brand_key", "brand"),
                                              ("surface", None), ("turn_index", None), ("own_bit", None), ("stance", None), ("first_turn", None),
                                              ("std_in", None), ("cyc_key", "cyc"), ("std_in_nc", None), ("is_rep", None)]),
    "rd.citation": ("rd.citation", [("round_date", None), ("answer_key", "ak"), ("url_key", "url"), ("source_key", "source"), ("cyc_key", "cyc"),
                                    ("prompt_key", "prompt"), ("surface", None), ("ord", None), ("project_key", "project"),
                                    ("engine_key", "engine"), ("geo_key", "geo"), ("lang_key", "lang"), ("bgrp", None), ("scope_key", "scope"),
                                    ("owner_key", None), ("cit_in", None), ("gap", None), ("dflt", None), ("loc_owned", None), ("tgt_hit", None),
                                    ("src_first", None), ("rule_ver", None), ("cit_in_nc", None), ("is_rep", None)]),
    "rd.cycle": ("rd.cycle", [("cyc_key", "cyc"), ("cycle_id", None), ("surface", None), ("project_key", "project"), ("ledger_backed", None),
                              ("round_date", None), ("anchor_date", None), ("status", None), ("servable", None), ("view_date", None),
                              ("hidden_scope", None), ("hidden_reason", None), ("expected_units", None), ("completed_units", None),
                              ("completed_answers", None), ("gap_answers", None), ("ecat_ver", None)]),
    "rd.acr_cell": ("rd.acr_cell", [("acr_cell_key", "acr"), ("round_date", None), ("cyc_key", "cyc"), ("prompt_key", "prompt"),
                                    ("surface", None), ("bgrp", None), ("project_key", "project"), ("engine_key", "engine"), ("geo_key", "geo"),
                                    ("lang_key", "lang"), ("cat_mask", None), ("planned", None), ("valid_turn1", None), ("valid_acr", None),
                                    ("co_single", None), ("co_conditional", None), ("co_generic", None), ("co_off_shortlist", None),
                                    ("co_unresolved", None), ("co_none", None), ("is_rep", None), ("acr_in", None), ("measured_date", None),
                                    ("rule_ver", None)]),
    "rd.acr_cell_job": ("rd.acr_cell_job", [("answer_key", "ak"), ("acr_cell_key", "acr")]),
    "rd.acr_choice": ("rd.acr_choice", [("acr_cell_key", "acr"), ("entity_key", "entity"), ("brand_key", "brand"),
                                        ("parent_brand_key", "brand"), ("level", None), ("own_bit", None), ("name_own", None),
                                        ("appearance", None), ("choice", None), ("cond_choice", None), ("off_shortlist", None),
                                        ("unresolved", None), ("generic", None), ("keep", None)]),
    "rd.report_unit_value": ("rd.report_unit_value", [("round_date", None), ("file_seq", None), ("cyc_key", "cyc"), ("pub_id", None),
                                                      ("brand", None), ("country_code", None), ("lang_code", None), ("in_headline_pool", None),
                                                      ("target_hit_prompts", None), ("measured_prompts", None), ("owned_prompts", None),
                                                      ("owned_prompts_den", None), ("prev_target_hit_prompts", None),
                                                      ("prev_measured_prompts", None), ("prev_owned_prompts", None),
                                                      ("prev_owned_prompts_den", None)]),
    "rd.dim_brand_name": ("rd.dim_brand_name", [("name", None), ("bare", None), ("kind", None), ("own_bit", None)]),
    "rd.dim_entity": ("rd.dim_entity", [("entity_id", None), ("entity_type", None), ("rep_name", None), ("brand_key", "brand"),
                                        ("registry_role", None)]),
    "rd.dim_source": ("rd.dim_source", [("skey", None), ("domain", None), ("is_social", None), ("category_key", None), ("category_src", None),
                                        ("owned_brand_bit", None), ("competitor_brand_key", "brand"), ("rule_ver", None)]),
    "rd.dim_url": ("rd.dim_url", [("url_hash", None), ("url", None), ("url_norm", None), ("url_base_norm", None), ("host", None),
                                  ("domain", None), ("source_key", "source"), ("owner_key", None), ("title", None), ("rule_ver", None)]),
    "rd.dim_prompt": ("rd.dim_prompt", [("prompt_id", None), ("surface", None), ("project_key", "project"), ("kind", None), ("text", None),
                                        ("lang_key", "lang"), ("cat_mask", None), ("in_root_catalog", None), ("funnel_key", "taxon"),
                                        ("unit_key", "unit"), ("targets", None), ("web_reg", None), ("regions", None), ("is_korean", None),
                                        ("cat_mask_all", None), ("in_root_catalog_all", None)]),
    "rd.dim_engine": ("rd.dim_engine", [("code", None), ("is_default", None)]),
    "rd.dim_country": ("rd.dim_country", [("code", None), ("region_key", "region"), ("kind", None), ("virtual_brand_bit", None),
                                          ("hidden_standard", None)]),
    "rd.dim_project": ("rd.dim_project", [("scope_project_id", None), ("surface", None), ("is_root", None), ("project_id", None),
                                          ("site_id", None), ("site_brand_bit", None), ("site_geo_key", "geo"), ("regions", None)]),
    "rd.catalog_entry": ("rd.catalog_entry", [("catalog_row_id", None), ("prompt_key", "prompt"), ("brand_bit", None),
                                              ("presence_key", "taxon"), ("funnel_key", "taxon"), ("list_type_key", "taxon"),
                                              ("depth1_key", "taxon"), ("depth2_key", "taxon"), ("depth3_key", "taxon"), ("kind", None)]),
    # DB-v2.16 P93 보고서 유닛 소속(키 = 프롬프트 자연 키). bulk = seed-30 끝 rd.refresh_web_report_prompt(NULL), 증분 = 새 웹 프롬프트·website_catalog 재판정
    "rd.web_report_prompt": ("rd.web_report_prompt", [("prompt_key", "prompt"), ("report_fs", None)]),
    # DB-v2.20 P111 타겟 URL 사전 해석(키 = 프로젝트·언어·URL 자연 키). bulk = seed-30 끝 rd.refresh_web_target_url(NULL, NULL), 증분 = 적재기 범위 맞추기
    "rd.web_target_url": ("rd.web_target_url", [("project_key", "project"), ("lang_key", "lang"), ("url_key", "url")]),
    # DB-v2.19 P109 인용 계열 셀 대표 보정(현행 프로필 rep_round_date_cell, WU-12). bulk = seed-40 §8 rd.reselect_rep_seat(전체), 증분 = 적재기 REP_UPDATE_SEAT·원장 훅
    "rd.rep_cit_delta": ("rd.rep_cit_delta", [("answer_key", "ak"), ("surface", None), ("round_date", None)]),
    "rd.web_unit": ("rd.web_unit", [("unit_key", "unit"), ("lang_codes", None), ("base", None), ("base_src", None), ("sibs", None),
                                    ("home_host", None), ("turls", None)]),
}
FACTS = ("rd.job", "rd.answer", "rd.answer_brand", "rd.answer_stance", "rd.citation", "rd.acr_cell", "rd.acr_cell_job", "rd.acr_choice")
DIMS = ("rd.dim_brand_name", "rd.dim_entity", "rd.dim_source", "rd.dim_url", "rd.dim_prompt", "rd.dim_engine", "rd.dim_country", "rd.dim_project")


async def snapshot(conn: asyncpg.Connection, tables: tuple[str, ...] | list[str]) -> dict[str, list[tuple]]:
    out: dict[str, list[tuple]] = {}
    for t in tables:
        rel, spec = SPECS[t]
        rows = await conn.fetch(f"SELECT {_cols(spec, 'x')} FROM {rel} x")
        out[t] = sorted((tuple(_hashable(v) for v in r) for r in rows), key=lambda r: tuple("" if v is None else str(v) for v in r))
    return out


def _hashable(v: Any) -> Any:
    return tuple(v) if isinstance(v, list) else v


def diff(a: dict[str, list[tuple]], b: dict[str, list[tuple]]) -> dict[str, dict[str, list[tuple]]]:
    """표별 (a 에만, b 에만) 행. 빈 dict = 동일."""
    out: dict[str, dict[str, list[tuple]]] = {}
    for t in a:
        sa, sb = set(a[t]), set(b.get(t, []))
        if sa != sb or len(a[t]) != len(b.get(t, [])):
            out[t] = {"only_a": sorted(sa - sb, key=str)[:20], "only_b": sorted(sb - sa, key=str)[:20],
                      "len": [len(a[t]), len(b.get(t, []))]}
    return out


# 발급 원장 차원(재번호·재사용 금지): 전역 판정(대표 표기·최빈 도메인)이 뒤 적재에서 바뀌면 옛 키가 참조 없는 행으로 남는다.
#   bulk 는 현재 입력에서 다시 만들어 그 행이 없다 → 동치 판정은 "bulk ⊆ 증분 ∧ 차이 행은 어떤 사실·차원도 참조하지 않음".
LEDGER_DIMS = ("rd.dim_brand_name", "rd.dim_source")
ORPHAN_SQL = {
    "rd.dim_brand_name": """
SELECT b.bare FROM rd.dim_brand_name b WHERE b.bare = ANY($1::text[]) AND (
  EXISTS (SELECT 1 FROM rd.answer_brand x WHERE x.brand_key = b.brand_key)
  OR EXISTS (SELECT 1 FROM rd.answer_stance x WHERE x.brand_key = b.brand_key)
  OR EXISTS (SELECT 1 FROM rd.acr_choice x WHERE x.brand_key = b.brand_key OR x.parent_brand_key = b.brand_key)
  OR EXISTS (SELECT 1 FROM rd.dim_entity x WHERE x.brand_key = b.brand_key)
  OR EXISTS (SELECT 1 FROM rd.dim_source x WHERE x.competitor_brand_key = b.brand_key))""",
    "rd.dim_source": """
SELECT s.skey FROM rd.dim_source s WHERE s.skey = ANY($1::text[]) AND (
  EXISTS (SELECT 1 FROM rd.dim_url x WHERE x.source_key = s.source_key)
  OR EXISTS (SELECT 1 FROM rd.citation x WHERE x.source_key = s.source_key))""",
}
_ORPHAN_KEYCOL = {"rd.dim_brand_name": 1, "rd.dim_source": 0}


async def referenced_extras(conn: asyncpg.Connection, d: dict[str, dict[str, list[tuple]]]) -> dict[str, list[str]]:
    """발급 원장 차원의 증분 전용 행 중 참조되는 것(있으면 동치 위반)."""
    out: dict[str, list[str]] = {}
    for t in LEDGER_DIMS:
        if t in d and d[t]["only_b"]:
            keys = [r[_ORPHAN_KEYCOL[t]] for r in d[t]["only_b"]]
            bad = [r[0] for r in await conn.fetch(ORPHAN_SQL[t], keys)]
            if bad:
                out[t] = bad
    return out


def strict_diff(d: dict[str, dict[str, list[tuple]]]) -> dict[str, dict[str, list[tuple]]]:
    """발급 원장 차원은 bulk 쪽 누락(only_a)만 위반으로 본다."""
    return {t: v for t, v in d.items() if t not in LEDGER_DIMS or v["only_a"]}


WIPE_FACTS = """
DELETE FROM rd.answer_brand; DELETE FROM rd.answer_stance; DELETE FROM rd.citation; DELETE FROM rd.answer; DELETE FROM rd.job;
DELETE FROM rd.acr_choice; DELETE FROM rd.acr_cell_job; DELETE FROM rd.acr_cell; DELETE FROM rd.cycle; DELETE FROM rd.report_unit_value;
DELETE FROM rd.surface_generation;
"""
WIPE_ING_DIMS = """
DELETE FROM rd.dim_entity; DELETE FROM rd.dim_url WHERE url_key <> 0;
DO $w$ BEGIN IF to_regclass('rd.web_target_url') IS NOT NULL THEN DELETE FROM rd.web_target_url; END IF; END $w$; DELETE FROM rd.dim_source WHERE source_key <> 0;
DELETE FROM rd.dim_brand_name WHERE brand_key <> 0;
"""


# 재판정(catalog·website_catalog)이 쓰는 판정 입력 표도 대조한다(결함 D7)
EQ_TABLES = (*FACTS, "rd.cycle", "rd.report_unit_value", *DIMS, "rd.catalog_entry", "rd.web_unit", "rd.web_report_prompt", "rd.rep_cit_delta", "rd.web_target_url")


async def bulk_equivalence(url: str, tables: tuple[str, ...] = EQ_TABLES) -> tuple[dict, dict]:
    """현재 DB 의 rd(증분 결과) vs 같은 ing·app 로 bulk 시드를 돌린 rd(롤백). 반환 = (엄격 차이, 참조되는 원장 고아).
    둘 다 빈 dict 면 동치(발급 원장 차원의 참조 없는 고아 행만 허용)."""
    c = await asyncpg.connect(url)
    try:
        got = await snapshot(c, tables)
        tr = c.transaction()
        await tr.start()
        await bulk_seed(c)
        ref = await snapshot(c, tables)
        await tr.rollback()
        d = diff(ref, got)
        return strict_diff(d), await referenced_extras(c, d)
    finally:
        await c.close()


def make_job(job_id: str, prompt_id: str | None, target: str, region: str | None, *, status: str = "completed",
             measured_at: str = "2026-09-28T01:00:00Z", analysis_status: str | None = "completed",
             mentions: list[dict[str, Any]] | None = None, citations: list[dict[str, Any]] | None = None,
             stances: list[dict[str, Any]] | None = None, answer_text: str | None = "answer", with_result: bool = True,
             acr: dict[str, Any] | None = None) -> dict[str, Any]:
    """Scope MeasurementJob 형태(listRunJobs include=result,occurrences,stances)."""
    job: dict[str, Any] = {"job_id": job_id, "prompt_id": prompt_id, "target": target, "region": region, "status": status,
                           "measured_at": measured_at}
    if analysis_status is not None:
        a: dict[str, Any] = {"status": analysis_status, "analysis_version": "v1", "resolved_mentions": mentions or [],
                             "brand_stances": stances or []}
        if acr:
            a["acr_summary"] = acr
        job["analysis"] = a
    if with_result and status == "completed":
        job["result"] = {"answer_text": answer_text, "citations": citations or [], "measured_at": measured_at, "model_slug": f"{target}-m"}
    return job


def mention(entity_id: str, name: str, etype: str = "Brand", *, rollup: str | None = None, count: int = 1, pos: int = 0,
            neg: int = 0, avg: float | None = 1.0) -> dict[str, Any]:
    return {"entity_id": entity_id, "entity_type": etype, "display_name": name,
            "rollups": {"brand_entity_id": rollup or entity_id, "product_entity_id": None, "company_entity_id": None},
            "surfaces": ["answer"], "mention_count": count, "sentiment": {"positive": pos, "neutral": 0, "negative": neg, "mixed": 0},
            "avg_position": avg, "type_breakdown": {"mention": count, "recommendation": 0, "comparison": 0, "definition": 0, "final_choice": 0},
            "occurrences": [{"source_start": 0, "source_end": 3, "surface_text": name, "sentiment": "positive", "mention_role": None,
                             "assertion": None, "context_snippet": None, "descriptors": [], "criteria": [], "turn_index": 0}]}
