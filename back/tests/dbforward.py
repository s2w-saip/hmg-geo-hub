"""시험 DB 전진(복제본 전용): 템플릿보다 뒤의 DB 패치를 시험 복제본에 1회 적용하고 대역 밖 채우기를 운영과 같은 SQL 파일로 돈다.

왜: 로컬 템플릿 hmg_tpl 은 v2.10 이고(back/tests/README.md 1절) 공유 자원이라 다시 만들지 않는다. DB-v2.13(rd.answer.cit_off, 동기화 S1 BE-B)
부터는 적재기·core.measure·seed-40 이 새 열을 읽고 쓰므로 모든 DB 시험의 복제본이 v2.13 이어야 한다(v2.11 rcache_db·v2.12 db_v212 는
해당 시험만 요청하던 픽스처). 루트 conftest 의 세션 자동 픽스처가 이 모듈을 부른다. 새 템플릿(DB-v2.13.sql 합본 + seed-40)이면 할 일이 없다.

순서: v2.11 패치(없으면) → v2.12 패치(없으면) → v2.13 패치(없으면) → v2.14 패치(없으면, 원장 발행 게이트 ing.cycle_unit·cycle_gate·active_units)
→ v2.15 패치(없으면, 현행 재현 되돌림 열: 자식 is_rep·cit_n_all·cit_c1..13·region_geo_key·cat_mask_all, 전부 NULL 열)
→ v2.16 패치(없으면, WU-7 웹 보고서 유닛 표 3개, 빈 표·채우기 없음)
→ v2.17 패치(없으면, 엔티티 직접 관리·버전 반영 데이터 모델 app.ecat_*·ing.hub_match·rd.answer.ecat_ver. 버전 행 없음 = 기존 명부 동작 그대로)
→ v2.13 을 이번에 적용했으면 back/migration/fill-cit-off.sql(commit=1, 배치 단언). v2.14 는 rd 를 건드리지 않아 채우기와 순서 무관.
v2.15 를 이번에 적용했으면 bulk 시드(seed-30·40)를 한 번 다시 돈다: 시드가 쓰는 P85 자식 is_rep·P88·P89 열(WU-2·WU-4)을 새 템플릿
(합본 + 현 시드, dev-db.sh·CI)과 같게 채운다(옛 템플릿 행은 그 열이 기본값·NULL 이라 증분 = bulk 대조가 어긋난다). 이어서
back/migration/fill-v215-rep.sql(commit=1)로 자식 is_rep 사본을 단언한다(시드 뒤라 0행이 예상값). P86·P87 도 시드가 쓴다(P87 region_geo_key 는
be/incr-parity 부터, 그 전 행은 back/migration/fill-v215.sql 이 채운다: 채우기 경로 시험은 열을 NULL 로 되돌려 직접 만든다).
시험 프로필(HGH_TEST_LEGACY_PROFILE)의 투영 스위치가 켜져 있으면 project_test_profile 이 그 프로필로 rd 를 다시 투영한다(conftest _db_latest).
템플릿 DB 이름이면 거부한다(복제본으로만 시험한다).
"""
from __future__ import annotations

import pathlib
import re
from typing import Any

BACK = pathlib.Path(__file__).resolve().parents[1]
DB = BACK / "db"
FILL_CIT_OFF = BACK / "migration" / "fill-cit-off.sql"
FILL_V215_REP = BACK / "migration" / "fill-v215-rep.sql"
TEMPLATE_NAMES = ("hmg_tpl", "hmg_core")

# (이미 적용됐는지 판정하는 SELECT(참이면 적용됨), 패치 파일)
PATCHES: tuple[tuple[str, pathlib.Path], ...] = (
    ("SELECT to_regnamespace('rcache') IS NOT NULL", DB / "DB-v2.11-patch.sql"),
    ("SELECT position('scope_regions' in coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint "
     "WHERE conrelid = 'app.user_account'::regclass AND conname = 'ua_country_scope'), '')) > 0", DB / "DB-v2.12-patch.sql"),
    ("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_off' AND NOT attisdropped)",
     DB / "DB-v2.13-patch.sql"),
    ("SELECT to_regclass('ing.cycle_gate') IS NOT NULL", DB / "DB-v2.14-patch.sql"),
    ("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_n_all' AND NOT attisdropped)",
     DB / "DB-v2.15-patch.sql"),
    # WU-7(WEBREG16): 새 표 3개(명세·제외 유닛·프롬프트 소속)뿐이라 채우기 없음. 명세 행은 시험이 직접 준비한다(tests/core/test_db_v216.py)
    ("SELECT to_regclass('rd.web_report_prompt') IS NOT NULL", DB / "DB-v2.16-patch.sql"),
    # 엔티티 관리(옛 DB-v2.16 P91~P101 → DB-v2.17 P94~P104). 패치 직후 버전 행 없음 = 기존 명부 동작 그대로
    ("SELECT to_regclass('app.ecat_version') IS NOT NULL", DB / "DB-v2.17-patch.sql"),
    # 인용 출처 유형 답변 열(DB-v2.18 P105 rd.answer.t_own, NULL 열). 적재기·seed-40 이 쓰고, 옛 행은 fill-v218.sql 이 채운다(아래 ensure_latest)
    ("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 't_own' AND NOT attisdropped)",
     DB / "DB-v2.18-patch.sql"),
    # WU-12: ing.answer_mirror_time·rd.rep_order_at(스냅샷 층용, 결정 31) + 답변분석 경로 셀 대표 rd.rep_cit_delta·rd.rep_rules 등. 새 표·함수뿐이라 채우기 없음
    # (be/int2: v2.18 뒤로 재번호. 이 패치는 v2.18 객체를 읽거나 쓰지 않는다)
    ("SELECT to_regclass('rd.rep_cit_delta') IS NOT NULL", DB / "DB-v2.19-patch.sql"),
    # WU-12 ⑥ 미러 정의 타겟 URL 사전 해석(가번호, 통합 때 번호 배정). 적용 뒤(또는 시드 재실행 뒤) 전체 맞추기
    ("SELECT to_regclass('rd.web_target_url') IS NOT NULL", DB / "DB-v2.20-patch.sql"),
    # 카드 경로 동결 층 S1(결정 31·32): frz 스키마(세대·셀·프롬프트 축·보관) + 보관 관문 함수·리프 쓰기 권한 회수. 동결 세대가 없으면 관문은 할 일이 없다(채우기 없음)
    ("SELECT to_regnamespace('frz') IS NOT NULL", DB / "DB-v2.21-patch.sql"),
    # 동결 층 S2: 발행 때 생성기(frz.freeze_cycle·regenerate, ing.full_cycle_expected). 새 함수뿐(채우기 없음)
    ("SELECT to_regprocedure('frz.freeze_cycle(uuid, jsonb)') IS NOT NULL", DB / "DB-v2.22-patch.sql"),
    # 동결 층 S3: 카드·격자 읽기 뷰(frz.card_*·grid_*). 새 뷰뿐(채우기 없음)
    ("SELECT to_regclass('frz.card_answer') IS NOT NULL", DB / "DB-v2.23-patch.sql"),
    # 동결 층 S4: 웹 셀 판정·택소노미 축·브랜드 표시명 표 + 웹 카드 읽기 뷰 + 생성기 굽기(활성 허브 세대는 패치가 굽는다). 활성 이관 세대가 있으면 실패
    ("SELECT to_regclass('frz.cell_web') IS NOT NULL", DB / "DB-v2.24-patch.sql"),
    # 엔티티 관리 5차 목록 합계(rd.entity_mention_total, 문장 트리거 차분 + finalize flush) + ing 하위 파티션 쓰기 권한 회수(P136).
    # 적용 뒤 픽스처 언급의 합계를 전체 재계산한다(= fill-v225.sql, 아래 ensure_latest)
    ("SELECT to_regclass('rd.entity_mention_total') IS NOT NULL", DB / "DB-v2.25-patch.sql"),
    # 롤업 대표 표기 원장(ing.entity_brand_name, 현행 프로필 NAME 의 이름 원천, be/int3-name). 적용 뒤 지금 언급의 Brand 표기를 원장에 넣는다
    ("SELECT to_regclass('ing.entity_brand_name') IS NOT NULL", DB / "DB-v2.26-patch.sql"),
    # 동결 층 answer_brand 운영 summary 접기 보관(frz.keep_fold, frz.kept src 'fold', be/int3-smartfold). 새 함수·CHECK 교체뿐(채우기 없음)
    ("SELECT to_regprocedure('frz.keep_fold(int4, jsonb)') IS NOT NULL", DB / "DB-v2.27-patch.sql"),
    # frz.keep_fold 입력 불변식 강화(I1~I7, 함수 본문 교체만, be/int3-smartfold 검증 결함 D1). 채우기 없음
    ("SELECT position('I7 순위 순서' in pg_get_functiondef('frz.keep_fold(int4, jsonb)'::regprocedure)) > 0", DB / "DB-v2.28-patch.sql"),
    # rd.dim_brand_name name·bare 원문 UNIQUE → md5 유일 색인 + 해시 조회 색인(btree 키 길이 상한, be/int3-longkey 검증 D'', DB-v2.29 P145~P147).
    # 제약 교체뿐이라 채우기 없음
    ("SELECT to_regclass('rd.dim_brand_name_name_md5_uq') IS NOT NULL", DB / "DB-v2.29-patch.sql"),
    # 창 판정 생성 대기 구멍(be/int3-skip, DB-v2.30 P148~P151): ing.cycle_ops_gap·rd.cycle_pick_basis + 재계산 함수. 적용 뒤 전체 계산
    # (= fill-v230.sql, 픽스처는 mig_src 가 없어 P148 행 없음 = 허브 카운터 갭)
    ("SELECT to_regclass('rd.cycle_pick_basis') IS NOT NULL", DB / "DB-v2.30-patch.sql"),
    # 엔티티 반영 재동결 감사(be/int3-ecatfrz, DB-v2.31 P152): loader 의 app.ecat_audit_log INSERT 권한뿐(채우기 없음)
    ("SELECT has_table_privilege('loader', 'app.ecat_audit_log', 'insert')", DB / "DB-v2.31-patch.sql"),
    # 동결 카드 읽기 뷰 계획 안정화(be/int3-frzperf, DB-v2.32 P153~P155): 카드·웹 카드 뷰 본문 교체뿐(채우기 없음). 표식 = 뷰 주석의 'DB-v2.32'
    ("SELECT position('DB-v2.32' in coalesce(obj_description('frz.card_citation'::regclass, 'pg_class'), '')) > 0",
     DB / "DB-v2.32-patch.sql"),
)
FILL_V218 = BACK / "migration" / "fill-v218.sql"


async def ensure_latest(conn: Any) -> list[str]:
    """복제본을 최신 패치까지 올린다. 반환 = 이번에 적용한 파일 이름(빈 목록 = 이미 최신). v2.13 을 적용했으면 cit_off 를,
    v2.15 를 적용했으면 자식 is_rep 을 채운다."""
    applied: list[str] = []
    for check, patch in PATCHES:
        if await conn.fetchval(check):
            continue
        db = await conn.fetchval("SELECT current_database()")
        if db in TEMPLATE_NAMES:
            raise RuntimeError(f"템플릿 DB({db})에는 패치를 적용하지 않는다: 복제본으로 시험한다(back/tests/README.md)")
        await conn.execute(patch.read_text(encoding="utf-8"))
        applied.append(patch.name)
    if "DB-v2.18-patch.sql" in applied and "DB-v2.15-patch.sql" not in applied:
        # DB-v2.18: 템플릿 행의 t_own 은 NULL(패치 직후 운영과 같다) → 운영과 같은 채우기 파일로 채우고 CHECK 검증까지(새 템플릿 = seed-40 이 쓴 값과 같다).
        # v2.15 를 같이 적용한 복제본은 아래 bulk 시드가 t_own 까지 쓴다(시드가 이 패치 뒤에 돈다)
        await run_psql_file(conn, FILL_V218, {"commit": "1"})
    if "DB-v2.13-patch.sql" in applied:
        await run_psql_file(conn, FILL_CIT_OFF, {"commit": "1"})
    if "DB-v2.15-patch.sql" in applied:
        # WU-2·WU-4: bulk 시드(seed-30·40)가 P85 자식 is_rep·P88(dim_prompt 삭제 포함 카탈로그)·P89(elig_nc·모수 열·rid_n)를 쓴다 →
        # 복제본에서 시드를 한 번 다시 돌려 새 템플릿과 같은 상태로 맞춘다(재투영). 그 뒤 자식 is_rep 채우기·단언(0행 예상).
        from app.core.profile import OFF
        from ingest.testkit import bulk_seed

        await bulk_seed(conn, profile=OFF)     # 템플릿과 같은 투영(끔). 시험 프로필 투영은 project_test_profile
        await run_psql_file(conn, FILL_V215_REP, {"commit": "1"})
    if applied and await conn.fetchval("SELECT to_regprocedure('rd.refresh_web_target_url(int4[], int4[])') IS NOT NULL"):
        await conn.fetchval("SELECT rd.refresh_web_target_url(NULL, NULL)")     # WU-12: 템플릿·재시드 상태의 사전 해석(시드는 이 표를 모른다)
    if "DB-v2.25-patch.sql" in applied:
        await conn.fetchval("SELECT rd.refresh_entity_mention_total(NULL)")     # 엔티티 합계 전체 재계산(= fill-v225.sql, dev-db.sh 템플릿과 같다)
    if "DB-v2.26-patch.sql" in applied:
        await conn.fetchval("SELECT rd.refresh_entity_brand_name()")            # 패치 전 언급의 Brand 표기(새 템플릿은 픽스처 적재 때 트리거가 넣는다)
    if "DB-v2.30-patch.sql" in applied:
        await conn.fetchval("SELECT rd.refresh_cycle_pick_basis(NULL)")         # 함대 가시·판정 갭 전체 계산(= fill-v230.sql)
    return applied


PROFILE_MARK = "hgh-test-projection:"      # 복제본 DB 주석(COMMENT ON DATABASE): 지금 rd 를 투영한 투영 스위치(없으면 템플릿 = off)


def projection_spec(profile: Any) -> str:
    """프로필의 투영 스위치만(시드 입력이 되는 것, ingest.testkit.PROJECTION_SEED_ARGS 순서). 없으면 'off'."""
    from ingest.testkit import PROJECTION_SEED_ARGS

    return ",".join(sw for sw in PROJECTION_SEED_ARGS if getattr(profile, sw)) or "off"


async def project_test_profile(conn: Any, profile: Any) -> bool:
    """시험 복제본 rd 를 시험 프로필의 투영 스위치로 다시 투영한다(bulk 시드 1회, 트랜잭션 1개). 이미 그 투영이면(DB 주석) 할 일 없음.
    읽기 스위치만 다른 프로필은 재투영이 필요 없다. 템플릿 이름이면 거부. 반환 = 재투영했는가."""
    want = projection_spec(profile)
    row = await conn.fetchrow("SELECT current_database() AS db, shobj_description(d.oid, 'pg_database') AS note "
                              "FROM pg_database d WHERE d.datname = current_database()")
    note = row["note"] or ""
    have = note[len(PROFILE_MARK):] if note.startswith(PROFILE_MARK) else "off"
    if have == want:
        return False
    if row["db"] in TEMPLATE_NAMES:
        raise RuntimeError(f"템플릿 DB({row['db']})는 재투영하지 않는다: 복제본으로 시험한다(back/tests/README.md)")
    from ingest.testkit import bulk_seed

    async with conn.transaction():
        await bulk_seed(conn, profile=profile)
        db_ident = await conn.fetchval("SELECT quote_ident(current_database())")
        await conn.execute(f"COMMENT ON DATABASE {db_ident} IS '{PROFILE_MARK}{want}'")
    return True


# ════════════════════════════════════════════════════════════════════════════
# psql 파일 실행기(시험용): \if·\else·\endif·\set·\echo 와 :var·:'var'·:{?var} 를 psql 처럼 풀고 문장을 하나씩 자동 커밋으로 보낸다
# (fill-cit-off.sql 의 DO 블록이 배치마다 COMMIT 하려면 문장마다 따로 보내야 한다). 운영은 psql 로 같은 파일을 돈다.
# ════════════════════════════════════════════════════════════════════════════
_VAR_Q = re.compile(r":'([A-Za-z_]\w*)'")


def _truthy(v: str) -> bool:
    x = v.strip().lower()
    if x in ("1", "true", "on", "yes", "t", "y"):
        return True
    if x in ("0", "false", "off", "no", "f", "n", ""):
        return False
    raise ValueError(f"psql \\if 불리언 아님: {v!r}")


def expand(text: str, variables: dict[str, str], base: pathlib.Path | None = None) -> str:
    """메타 명령을 풀고 변수를 치환한 SQL(메타 명령 줄은 사라진다). base 를 주면 \\ir <상대 경로> 를 그 폴더 기준으로 펼친다
    (psql 과 같이 포함 파일 안의 \\ir 은 그 파일 폴더 기준. 포함 파일에는 메타 명령이 없다고 본다: 시드 공용 파일 seed-00-fn·seed-3x-*)."""
    vars_ = dict(variables)
    out: list[str] = []
    stack: list[tuple[bool, bool]] = []          # (이 가지를 실행 중인가, 부모가 실행 중인가)

    def active() -> bool:
        return all(s[0] for s in stack)

    for line in text.splitlines():
        s = line.strip()
        if s.startswith("\\if "):
            cond = s[4:].strip()
            m = re.fullmatch(r":\{\?([A-Za-z_]\w*)\}", cond)
            if m:
                val = m.group(1) in vars_
            else:
                m2 = re.fullmatch(r":([A-Za-z_]\w*)", cond)
                if not m2:
                    raise ValueError(f"지원하지 않는 \\if: {cond}")
                val = _truthy(vars_.get(m2.group(1), ""))
            parent = active()
            stack.append((val, parent))
            continue
        if s == "\\else":
            val, parent = stack.pop()
            stack.append((not val, parent))
            continue
        if s == "\\endif":
            stack.pop()
            continue
        if not active():
            continue
        if s.startswith("\\ir ") and base is not None:
            inc = base / s.split(None, 1)[1]
            out.append(expand(inc.read_text(encoding="utf-8"), vars_, inc.parent))
            continue
        if s.startswith("\\set "):
            _, name, *rest = s.split(None, 2)
            vars_[name] = rest[0] if rest else ""
            continue
        if s.startswith("\\"):
            continue                              # \echo 등
        line = _VAR_Q.sub(lambda m: "'" + vars_[m.group(1)].replace("'", "''") + "'", line)
        out.append(line)
    if stack:
        raise ValueError("\\if 가 닫히지 않았다")
    return "\n".join(out)


async def run_psql_file(conn: Any, path: pathlib.Path, variables: dict[str, str]) -> list[Any]:
    """파일을 psql 처럼 실행한다(문장마다 자동 커밋). 반환 = SELECT 문장별 행 목록."""
    from pglast import split

    sql = expand(path.read_text(encoding="utf-8"), variables, path.parent)
    results: list[Any] = []
    for stmt in split(sql, with_parser=False):
        body = stmt.strip()
        if not body:
            continue
        if re.match(r"(?is)^\s*(SELECT|WITH)\b", body):
            results.append(await conn.fetch(body))
        else:
            await conn.execute(body)
    return results
