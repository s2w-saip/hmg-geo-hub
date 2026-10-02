"""판정 규칙 세션 로더: 시드(빌더 B)와 같은 pg_temp 함수·규칙 표를 적재기 연결에 올린다(DB 함수 한 벌 원칙, G-16).

원천(수정하지 않고 읽기만): back/migration/seed/
  seed-00-fn.sql      js_trim·norm_match·owned_prefix·kst_month (현행 TS 정규화의 SQL 쌍둥이)
  seed-3x-rules.sql   _r_owned_domain·_r_shared_host·_r_iso_region·_r_virtual_geo·_r_social·_r_cat_seed·_r_set·_r_rx
                      (gen_seed3x.py 가 현행 TS 에서 생성한 판정 입력)
  seed-3x-common.sql  §1·2·3·9 판정 함수(cit_norm·canon_brand·hmg_prefix_id·brand_competitive·category_of·group_key·owner_key_of …)
                      §10 엔티티 버전 오버레이 함수(ecat_norm·ecat_resolve, E1)
                      §4·7 app 파생 임시 표(엔티티 버전 _ecat_*·_alias_map·_roster·_wp_pick): app 이 바뀔 수 있어 트랜잭션마다 다시 만든다.
  seed-4x-ecat.sql    엔티티 버전 오버레이의 언급 보정(차단·재매칭, 입력 _ecat_in → _ecat_madj·_ecat_hnew). 적재기 FACT_SRC 가 트랜잭션마다 돈다.
  §5·6·8(_names·_bn_pair·_acr_nm)은 ing 전량을 읽는 시드 전용 표라 올리지 않는다. 적재기는 같은 식을 답변·엔티티 범위로
  좁혀 ingest.project.apply 가 만든다(범위만 다르고 식은 같다: 동치 테스트가 확인).

규칙 표는 연결 수명 동안 유지된다(워커는 직접 연결 1개를 오래 쓴다). 규칙 원천(TS)이 바뀌면 시드 파일을 다시 생성하고
워커를 재기동한다(rule_set 지문이 바뀌면 전역 재판정: judgment_change 'brand_rule' 등).
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

import asyncpg

SEED_DIR = Path(__file__).resolve().parents[2] / "migration" / "seed"
_SECTION = re.compile(r"^-- ── (\d+)\.", re.M)
FUNC_SECTIONS = (1, 2, 3, 9, 10)
TABLE_SECTIONS = (4, 7)


def _sections(text: str) -> dict[int, str]:
    marks = [(int(m.group(1)), m.start()) for m in _SECTION.finditer(text)]
    out: dict[int, str] = {}
    for i, (n, pos) in enumerate(marks):
        end = marks[i + 1][1] if i + 1 < len(marks) else len(text)
        out[n] = text[pos:end]
    return out


@lru_cache(maxsize=1)
def rule_scripts() -> tuple[str, str]:
    """(연결당 1회 스크립트, 트랜잭션마다 스크립트). 섹션 구조가 바뀌면 여기서 실패한다(조용히 빠지지 않게)."""
    fn = (SEED_DIR / "seed-00-fn.sql").read_text(encoding="utf-8")
    rules = (SEED_DIR / "seed-3x-rules.sql").read_text(encoding="utf-8")
    common = _sections((SEED_DIR / "seed-3x-common.sql").read_text(encoding="utf-8"))
    missing = [n for n in (*FUNC_SECTIONS, *TABLE_SECTIONS) if n not in common]
    if missing:
        raise RuntimeError(f"seed-3x-common.sql 섹션 없음: {missing}")
    once = "\n".join([fn, rules, *(common[n] for n in FUNC_SECTIONS)])
    per_tx = "\n".join(common[n] for n in TABLE_SECTIONS) + "\nANALYZE _alias_map, _roster, _wp_pick;\n"
    for word in ("_bn_pair", "_names", "_acr_nm"):   # 전량 표를 만드는 절이 섞이면 거부
        if re.search(rf"CREATE TEMP TABLE {word}\b", per_tx):
            raise RuntimeError(f"트랜잭션 스크립트에 전량 표 {word} 가 섞였다")
    return once, per_tx


@lru_cache(maxsize=1)
def ecat_overlay_sql() -> str:
    """엔티티 버전 오버레이 언급 보정 스크립트(seed-4x-ecat.sql, 시드 seed-40 §5 와 같은 파일). 입력 임시 표 _ecat_in 을 먼저 만든다."""
    text = (SEED_DIR / "seed-4x-ecat.sql").read_text(encoding="utf-8")
    if re.search(r"^\s*\\", text, re.M):
        raise RuntimeError("seed-4x-ecat.sql 에 psql 메타 명령이 섞였다")
    return text


async def ensure_session_rules(conn: asyncpg.Connection) -> None:
    """연결에 규칙 함수·표가 없으면 올린다(pg_temp._r_set·owner_key_of·ecat_resolve 존재로 판정)."""
    have = await conn.fetchval("SELECT to_regclass('pg_temp._r_set') IS NOT NULL AND to_regprocedure('pg_temp.owner_key_of(text)') IS NOT NULL"
                               " AND to_regprocedure('pg_temp.ecat_resolve(int[],int[],int[],uuid[],int[],int[])') IS NOT NULL"
                               " AND to_regprocedure('pg_temp.name_key(text)') IS NOT NULL")
    if not have:
        once, _ = rule_scripts()
        await conn.execute(once)


async def refresh_app_rules(conn: asyncpg.Connection) -> None:
    """app 파생 임시 표(엔티티 버전 규칙 _ecat_*·_alias_map·_roster·_wp_pick)를 이 트랜잭션의 app 상태로 다시 만든다.
    기준 버전·고정 무시는 호출자가 먼저 트랜잭션 GUC(hgh.ecat_ver·hgh.ecat_force)로 정한다(set_ecat_target)."""
    await ensure_session_rules(conn)
    await set_name_rule(conn)
    _, per_tx = rule_scripts()
    await conn.execute(per_tx)


async def set_name_rule(conn: asyncpg.Connection) -> None:
    """표시 브랜드 이름 규칙(현행 프로필 display_name_latin, 투영 스위치)을 이 트랜잭션 GUC hgh.legacy_name 으로 건다(트랜잭션 로컬).
    seed-3x-common §3 name_key·brand_bare 와 §5 대표 표기 콜레이션이 읽는다. 시드는 같은 GUC 를 세션(PGOPTIONS)으로 받는다."""
    from app.core.profile import active_profile

    await conn.execute("SELECT set_config('hgh.legacy_name', $1, true)", "1" if active_profile().display_name_latin else "")


async def set_ecat_target(conn: asyncpg.Connection, ver: int | None, force: bool = False) -> None:
    """이 트랜잭션의 투영 기준 버전(None = 활성 버전)과 고정 무시(force: rd.cycle.ecat_ver 를 보지 않고 전부 ver)를 정한다.
    refresh_app_rules 앞에서 부른다(트랜잭션 로컬 GUC, 커밋·롤백 때 풀린다)."""
    await conn.execute("SELECT set_config('hgh.ecat_ver', $1, true), set_config('hgh.ecat_force', $2, true)",
                       "" if ver is None else str(int(ver)), "1" if force else "")
