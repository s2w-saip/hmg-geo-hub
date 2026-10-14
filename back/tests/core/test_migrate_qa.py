"""QA 검수 기록 이관(back/migration: export-qa.sql·mig_src_qa.sql·migrate-qa.sql·verify-qa.sql·rollback-qa.sql) 회귀.

레거시 qa_answer_reviews·qa_review_notes(스냅샷 = mig_src 스테이지) → app.qa_answer_review·app.qa_review_note. 픽스처 DB 에는 mig_src 가 없어
시험이 트랜잭션 안에서 mig_src_qa.sql 본문으로 표를 만들고 합성 레거시 행(qa_migrate.pgsql)을 넣은 뒤 롤백한다(test_core10 방식).
SQL 파일의 트랜잭션 본문(BEGIN; 뒤 ~ COMMIT/ROLLBACK 분기 앞)을 psql 메타 줄을 지우고 변수를 치환해 asyncpg 로 실행한다(시험 이미지에 psql 이 없다).
psql 분기(드라이런 기본·expect 불일치 거부·commit·from_snapshot·verify strict)는 개발 DB 컨테이너의 psql 로 따로 실측했다(보고서).
API 동등(T11)만 커밋한 상태에서 /v1/qa/* 를 부르고, 끝나면 mig_src 를 지우고 qa_clean 이 app.qa_* 를 비운다.
"""
from __future__ import annotations

import json
import pathlib
import re
import uuid
from datetime import UTC, datetime

import asyncpg
import pytest

from app.features.qa.answers.list.tests.qa_support import new_session, qa_clean, qa_client  # noqa: F401
from tests.support import DB_URL, load_named_sql, needs_db

pytestmark = [needs_db, pytest.mark.usefixtures("qa_clean")]

BACK = pathlib.Path(__file__).resolve().parents[2]
MIG = BACK / "migration"
DATA = load_named_sql(pathlib.Path(__file__).with_name("qa_migrate.pgsql"))

J1 = uuid.UUID("90000000-0000-4000-8000-000000000001")
J12 = uuid.UUID("90000000-0000-4000-8000-000000000012")
J14 = uuid.UUID("90000000-0000-4000-8000-000000000014")
J21 = uuid.UUID("90000000-0000-4000-8000-000000000021")
JO = uuid.UUID("a0a0a0a0-0000-4000-8000-00000000f001")          # rd.job 에 없는 job(새 고아)
N = {i: uuid.UUID(f"b1000000-0000-4000-8000-{i:012d}") for i in range(1, 15)}
ACR_KEY = "aa000000-0000-4000-8000-000000000001:00000000-0000-0000-0000-000000000301"

# 기본 실행(recover_stale=0)의 노트 번역 기대값: map_status, 새 키(None = 원래 키 그대로)
NOTE_MAP = {
    1: ("cit_mapped", f"{J1}:3"), 2: ("cit_stale", None), 3: ("cit_drift", None), 4: ("cit_unverified", f"{JO}:2"),
    5: ("identity", None), 6: ("identity", None), 7: ("identity", None), 8: ("nokey", None), 9: ("nokey", None),
    10: ("cit_newfmt", None), 11: ("opaque", None), 12: ("nokey", None), 13: ("cit_stale", None), 14: ("nokey", None),
}
MIG_TEMP = "DROP TABLE IF EXISTS _qa_pre, _rv, _nm, _rv_act, _nt_act, _qa_res"
VERIFY_TEMP = "DROP TABLE IF EXISTS _qv, _qv_scope, _qv_led, _qv_last, _qv_att"
RB_TEMP = "DROP TABLE IF EXISTS _rb_pre, _rb, _rb_res"


def _strip_psql(body: str) -> str:
    body = re.sub(r"\s*\\gset \w+", ";", body)
    out = "\n".join(ln for ln in body.splitlines() if not ln.lstrip().startswith("\\"))
    assert not re.search(r":'[a-z_]+'", out), "치환하지 않은 psql 변수"
    return out


def _txn_body(name: str, end: str, **psql_vars: object) -> str:
    """파일의 트랜잭션 본문(BEGIN; 뒤 ~ end 앞). psql 변수는 값으로 치환(test_core10._fix_body 와 같은 방식)."""
    s = (MIG / name).read_text(encoding="utf-8")
    body = s[s.index("BEGIN;") + len("BEGIN;"):s.rindex(end)]
    for k, v in psql_vars.items():
        body = body.replace(f":'{k}'", f"'{v}'")
    return _strip_psql(body)


def _ddl() -> str:
    s = (MIG / "mig_src_qa.sql").read_text(encoding="utf-8")
    return _strip_psql(s[:s.index("\\if :{?from_snapshot}")])


def _from_snapshot() -> str:
    s = (MIG / "mig_src_qa.sql").read_text(encoding="utf-8")
    return _strip_psql(s[s.index("\\if :{?from_snapshot}"):s.index("\\endif")])


def _create_tables(path: pathlib.Path, schema: str, names: tuple[str, ...]) -> str:
    """pg_dump 파일(mirror-schema.sql·mig_src.sql)에서 그 표들의 CREATE TABLE 문만."""
    s = path.read_text(encoding="utf-8")
    out = []
    for t in names:
        m = re.search(rf"CREATE TABLE {schema}\.{t} \(.*?\n\);", s, re.S)
        assert m, (path.name, t)
        out.append(m.group(0))
    return "\n".join(out)


async def migrate(c, *, expect_reviews: int = -1, expect_notes: int = -1, overwrite_foreign: int = 0, recover_stale: int = 0) -> dict:
    await c.execute(MIG_TEMP)
    await c.execute(_txn_body("migrate-qa.sql", "\\if :{?commit}", expect_reviews=expect_reviews, expect_notes=expect_notes,
                              overwrite_foreign=overwrite_foreign, recover_stale=recover_stale))
    rv = {r["job_id"]: r["action"] for r in await c.fetch("SELECT job_id, action FROM _rv_act")}
    nt = {r["note_id"]: (r["action"], r["map_status"]) for r in await c.fetch("SELECT note_id, action, map_status FROM _nt_act")}
    return {"reviews": rv, "notes": nt}


async def verify(c, *, surfaces: str = "{1,2,3}", since: str = "", strict: int = 0) -> dict[str, dict]:
    await c.execute(VERIFY_TEMP)
    await c.execute(_txn_body("verify-qa.sql", "ROLLBACK;", surfaces=surfaces, since=since, strict=strict))
    return {f"{r['no']}:{r['check_name'].split(' ')[0]}": {**dict(r), "detail": json.loads(r["detail"]) if r["detail"] else None}
            for r in await c.fetch("SELECT * FROM _qv ORDER BY no")}


async def rollback(c, *, expect_reviews: int = -1, expect_notes: int = -1) -> dict:
    await c.execute(RB_TEMP)
    await c.execute(_txn_body("rollback-qa.sql", "\\if :{?commit}", expect_reviews=expect_reviews, expect_notes=expect_notes))
    return {(r["kind"], r["key"]): r["action"] for r in await c.fetch("SELECT kind, key, action FROM _rb")}


async def stage(c) -> None:
    """mig_src QA 표 + 합성 레거시 스냅샷 + back 세션·락 1행(이관이 건드리면 안 된다). app.qa_* 는 비운 상태에서 시작."""
    for t in ("app.qa_answer_lock", "app.qa_review_note", "app.qa_answer_review", "app.qa_review_session"):
        await c.execute(f"DELETE FROM {t}")
    await c.execute(_ddl())
    await c.execute(DATA["stage"])


async def app_notes(c) -> dict[uuid.UUID, dict]:
    return {r["note_id"]: dict(r) for r in await c.fetch("SELECT * FROM app.qa_review_note")}


async def ledger(c) -> list[dict]:
    return [dict(r) for r in await c.fetch("SELECT * FROM mig_src.qa_carry_ledger ORDER BY kind, key")]


class _Rollback(Exception):
    pass


async def _in_txn(fn):
    """새 접속 한 트랜잭션에서 fn(c) 을 돌리고 항상 롤백한다(복제본 불변)."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        try:
            return await fn(c)
        finally:
            await tr.rollback()
    finally:
        await c.close()


def _counts(actions: dict) -> dict:
    out: dict = {}
    for v in actions.values():
        out[v] = out.get(v, 0) + 1
    return out


# ── T1 드라이런 ───────────────────────────────────────────────────────────────
async def test_t1_dry_run_plans_and_leaves_nothing():
    """드라이런(커밋 안 함): 계획 = 리뷰 5 insert, 노트 14 insert(map_status 기대표). 롤백 뒤 app.qa_* 리뷰·노트·원장·보고 0행, 세션·락 그대로."""
    async def run(c):
        await stage(c)
        try:
            async with c.transaction():
                got = await migrate(c)
                raise _Rollback(got)
        except _Rollback as e:
            got = e.args[0]
        assert got["reviews"] == {j: "insert" for j in (J1, J12, J14, JO, J21)}
        assert got["notes"] == {N[i]: ("insert", NOTE_MAP[i][0]) for i in N}
        left = await c.fetchrow("SELECT (SELECT count(*) FROM app.qa_answer_review) r, (SELECT count(*) FROM app.qa_review_note) n, "
                                "(SELECT count(*) FROM mig_src.qa_carry_ledger) l, (SELECT count(*) FROM mig_src.qa_carry_report) p, "
                                "(SELECT count(*) FROM app.qa_answer_lock) k, (SELECT count(*) FROM app.qa_review_session) s")
        assert tuple(left) == (0, 0, 0, 0, 1, 1)
    await _in_txn(run)


# ── T2·T3 반영 + 검증 + 키 번역 ─────────────────────────────────────────────────
async def test_t2_t3_apply_verify_and_translate():
    """반영 뒤 verify-qa V1~V7·V8m·V10 이 모두 OK, status GENERATED = 레거시 status, 시각·이름 그대로, session_id·reviewer_id NULL.
    인용 키: cit_mapped(id 1003 → ord 3, url 일치) → 'job:3', cit_unverified(고아 job) → 'job:2', stale·drift·newfmt·opaque 는 원래 키.
    V8 붙음 대조: 멘션 TT1·TF1(사라진 멘션), 인용 TT1·TF2(drift·고아)·FT1(newfmt)·FF2(stale), ACR TT1. V9: 드롭 job 이 새로 보이고 고아는 숨는다."""
    async def run(c):
        await stage(c)
        got = await migrate(c, expect_reviews=5, expect_notes=14)
        assert _counts(got["reviews"]) == {"insert": 5} and _counts({k: v[0] for k, v in got["notes"].items()}) == {"insert": 14}
        # 리뷰: flag 6열·GENERATED status·원천 시각
        rows = {r["job_id"]: dict(r) for r in await c.fetch("SELECT * FROM app.qa_answer_review")}
        src = {r["job_id"]: dict(r) for r in await c.fetch("SELECT * FROM mig_src.qa_answer_reviews")}
        assert set(rows) == set(src)
        for j, s in src.items():
            a = rows[j]
            assert (a["status"], a["reviewer_name"], a["reviewed_at"], a["updated_at"]) == (s["status"], s["reviewer_name"], s["reviewed_at"],
                                                                                         s["updated_at"])
            assert a["session_id"] is None and a["reviewer_id"] is None
        assert (rows[J1]["flag_answer"], rows[J1]["flag_citations"], rows[J1]["flag_prompt"]) == ("ok", "issue", None)
        assert rows[J14]["status"] == "ok" and all(rows[J14][f"flag_{k}"] is None for k in ("answer", "prompt", "mentions", "citations", "acr", "meta"))
        assert rows[J1]["reviewed_at"] == datetime(2026, 9, 20, 1, 2, 3, 123456, tzinfo=UTC)
        # 노트: 키 번역·내용 그대로
        notes = await app_notes(c)
        src_n = {r["id"]: dict(r) for r in await c.fetch("SELECT * FROM mig_src.qa_review_notes")}
        for i, (_, new_key) in NOTE_MAP.items():
            a, s = notes[N[i]], src_n[N[i]]
            assert a["target_key"] == (new_key if new_key is not None else s["target_key"]), i
            for f in ("job_id", "target_kind", "target_label", "severity", "body", "reviewer_name", "created_at", "resolved_at", "resolved_by"):
                assert a[f] == s[f], (i, f)
            assert a["session_id"] is None and a["reviewer_id"] is None
        assert notes[N[8]]["body"] == '블록 노트\n둘째 줄, "따옴표"'
        led = {(r["kind"], r["key"]): r for r in await ledger(c)}
        assert len(led) == 19
        assert led[("note", N[1])]["legacy_key"] == "1003" and led[("note", N[1])]["new_key"] == f"{J1}:3"
        assert [led[("note", N[i])]["legacy_attached"] for i in (1, 2, 3, 4, 5, 6, 7, 8, 10, 13)] == [True, False, True, True, True, True, True,
                                                                                                    None, False, False]
        # 검증
        v = await verify(c)
        bad = {k: (x["actual"], x["detail"]) for k, x in v.items() if x["verdict"] == "FAIL"}
        assert bad == {}
        assert {k for k, x in v.items() if x["verdict"] == "OK"} >= {"V1:review", "V1:note", "V2:review", "V3:note", "V4:note", "V5:job",
                                                                     "V6:대상별", "V7:진행률(서버", "V8m:cit_mapped·cit_label", "V10:이관"}
        assert v["V8:mention"]["actual"] == "TT 1 · TF 1 · FT 0 · FF 0"
        assert v["V8:citation"]["actual"] == "TT 1 · TF 2 · FT 1 · FF 2"
        assert v["V8:acr"]["actual"] == "TT 1 · TF 0 · FT 0 · FF 0"
        assert v["V9:review"]["actual"] == "TT 3 · TF 1 · FT 1 · FF 0 · 새 고아 1"
        assert v["V9:note"]["actual"] == "TT 12 · TF 1 · FT 1 · FF 0 · 새 고아 1"
        assert v["V10b:락·세션"]["actual"].startswith("lock 1 · session 1")
        # 서버 범위를 website 로 좁혀도 같은 모집단 비교라 V7 은 OK
        v2 = await verify(c, surfaces="{2}", since="2026-09-18")
        assert v2["V7:진행률(서버"]["verdict"] == "OK" and "FAIL" not in {x["verdict"] for x in v2.values()}
    await _in_txn(run)


async def test_t3_recover_stale_label_option():
    """recover_stale=1(결정 1, 기본 꺼짐): 끊긴 숫자 키 중 target_label 이 job 안 현재 인용 하나와만 맞고 새 ord url 도 같으면 cit_label('job:ord').
    라벨이 둘 이상 맞으면(reddit.com 두 건) cit_stale 그대로."""
    async def run(c):
        await stage(c)
        got = await migrate(c, recover_stale=1)
        assert got["notes"][N[13]] == ("insert", "cit_label") and got["notes"][N[2]] == ("insert", "cit_stale")
        notes = await app_notes(c)
        assert notes[N[13]]["target_key"] == f"{J1}:6" and notes[N[2]]["target_key"] == "999"
        v = await verify(c)
        assert v["V8m:cit_mapped·cit_label"]["verdict"] == "OK" and v["V4:note"]["verdict"] == "OK"
        # 같은 원장에서 기본값(0)으로 다시 돌리면 번역이 바뀐 행만 update(remap) → 원래 키로 돌아간다
        again = await migrate(c)
        assert again["notes"][N[13]] == ("update", "cit_stale") and _counts({k: v[0] for k, v in again["notes"].items()}) == {"noop": 13, "update": 1}
        assert (await app_notes(c))[N[13]]["target_key"] == "998"
    await _in_txn(run)


# ── T4 멱등 · T5 원천 변경 ───────────────────────────────────────────────────────
async def test_t4_t5_idempotent_then_source_change():
    """두 번째 실행은 전부 noop·원장 불변(expect 0·0 통과). 스테이지 리뷰 1건(updated_at 뒤·플래그 변경)과 노트 1건(해결)을 바꾸면 그 2건만 update."""
    async def run(c):
        await stage(c)
        await migrate(c)
        before = await ledger(c)
        again = await migrate(c, expect_reviews=0, expect_notes=0)
        assert set(again["reviews"].values()) == {"noop"} and {a for a, _ in again["notes"].values()} == {"noop"}
        assert await ledger(c) == before
        await c.execute("UPDATE mig_src.qa_answer_reviews SET section_flags = '{\"answer\": \"ok\", \"citations\": \"ok\"}', status = 'ok', "
                        "updated_at = '2026-09-25 00:00:00.000007+00' WHERE job_id = $1", J1)
        await c.execute("UPDATE mig_src.qa_review_notes SET resolved_at = '2026-09-25 00:00:00+00', resolved_by = '검수자C' WHERE id = $1", N[5])
        third = await migrate(c, expect_reviews=1, expect_notes=1)
        assert _counts(third["reviews"]) == {"update": 1, "noop": 4} and third["reviews"][J1] == "update"
        assert third["notes"][N[5]][0] == "update" and _counts({k: v[0] for k, v in third["notes"].items()}) == {"update": 1, "noop": 13}
        r = await c.fetchrow("SELECT status, flag_citations, updated_at FROM app.qa_answer_review WHERE job_id = $1", J1)
        assert tuple(r) == ("ok", "ok", datetime(2026, 9, 25, 0, 0, 0, 7, tzinfo=UTC))
        assert (await app_notes(c))[N[5]]["resolved_by"] == "검수자C"
        rep = await c.fetchval("SELECT detail->>'change' FROM mig_src.qa_carry_report WHERE kind = 'review' AND key = $1 AND action = 'update'", J1)
        assert rep == "source"
    await _in_txn(run)


# ── T6 back 수정 보존 · T7 삭제 보존 · T13 롤백 ─────────────────────────────────────
async def test_t6_t7_t13_back_edits_survive_rerun_and_rollback():
    """전환 뒤 back 수정(노트 본문)·삭제(노트)·새 노트는 재실행이 덮거나 되살리지 않는다(skip_edited_in_back·skip_deleted_in_back).
    롤백: 미수정 이관 행만 지우고(리뷰 5·노트 12), 수정 행·back 새 노트는 남긴다. 원장에는 수정 행만 남고, 다시 이관하면 지운 행이 다시 insert."""
    async def run(c):
        await stage(c)
        await migrate(c)
        await c.execute("UPDATE app.qa_review_note SET body = 'back 에서 고침' WHERE note_id = $1", N[5])
        await c.execute("DELETE FROM app.qa_review_note WHERE note_id = $1", N[8])
        back_note = await c.fetchval("INSERT INTO app.qa_review_note (job_id, target_kind, body, reviewer_name) VALUES ($1, 'answer', 'new', 'b') "
                                     "RETURNING note_id", J1)
        again = await migrate(c, expect_reviews=0, expect_notes=0)
        assert again["notes"][N[5]][0] == "skip_edited_in_back" and again["notes"][N[8]][0] == "skip_deleted_in_back"
        assert back_note not in again["notes"]                                  # 원장·스테이지 밖 back 행은 판정 대상도 아니다
        notes = await app_notes(c)
        assert notes[N[5]]["body"] == "back 에서 고침" and N[8] not in notes and back_note in notes
        v = await verify(c)
        assert v["V1:note"]["verdict"] == "OK" and v["V1:note"]["detail"] is not None      # skip_* 로 설명되는 차이
        assert v["V5:job"]["verdict"] == "FAIL"                                              # 전체 비교는 back 쓰기만큼 달라진다(컷오버 직후 기준)
        with pytest.raises(asyncpg.RaiseError, match="노트 삭제 12 <> 기대 13"):
            async with c.transaction():
                await rollback(c, expect_reviews=5, expect_notes=13)
        rb = await rollback(c, expect_reviews=5, expect_notes=12)
        assert rb[("note", N[5])] == "rollback_keep_edited" and rb[("note", N[8])] == "rollback_forget"
        assert _counts(rb) == {"rollback_delete": 17, "rollback_keep_edited": 1, "rollback_forget": 1}
        assert await c.fetchval("SELECT count(*) FROM app.qa_answer_review") == 0
        assert set(await app_notes(c)) == {N[5], back_note}
        assert [(r["kind"], r["key"]) for r in await ledger(c)] == [("note", N[5])]
        lk = await c.fetchrow("SELECT (SELECT count(*) FROM app.qa_answer_lock) k, (SELECT count(*) FROM app.qa_review_session) s")
        assert tuple(lk) == (1, 1)
        # 다시 이관: 지운 행은 insert, 수정 행은 계속 보존, back 에서 지운 노트(원장도 정리됨)는 다시 들어온다
        re_run = await migrate(c)
        assert _counts(re_run["reviews"]) == {"insert": 5}
        assert re_run["notes"][N[5]][0] == "skip_edited_in_back" and re_run["notes"][N[8]][0] == "insert"
    await _in_txn(run)


# ── T8 foreign ──────────────────────────────────────────────────────────────
async def test_t8_foreign_back_verdict_skip_or_overwrite():
    """같은 job 에 back 판정이 먼저 있으면 skip_foreign(back 값 유지, 원장 없음). overwrite_foreign=1 이면 레거시 값으로 덮고 원장에 올린다."""
    async def run(c):
        await stage(c)
        await c.execute("INSERT INTO app.qa_answer_review (job_id, flag_answer, reviewer_name) VALUES ($1, 'issue', 'back')", J12)
        got = await migrate(c, expect_reviews=4)
        assert got["reviews"][J12] == "skip_foreign"
        assert tuple(await c.fetchrow("SELECT reviewer_name, status FROM app.qa_answer_review WHERE job_id = $1", J12)) == ("back", "issue")
        assert not any(r["key"] == J12 for r in await ledger(c))
        v = await verify(c)
        assert v["V1:review"]["verdict"] == "OK" and v["V1:review"]["detail"]["skip_foreign"] == 1
        over = await migrate(c, overwrite_foreign=1, expect_reviews=1, expect_notes=0)
        assert over["reviews"][J12] == "overwrite_foreign"
        r = await c.fetchrow("SELECT reviewer_name, status, flag_meta, session_id FROM app.qa_answer_review WHERE job_id = $1", J12)
        assert tuple(r) == ("검수자B", "ok", "ok", None)
        assert any(r["key"] == J12 for r in await ledger(c))
        assert (await migrate(c, expect_reviews=0, expect_notes=0))["reviews"][J12] == "noop"
    await _in_txn(run)


# ── T9 가드 ──────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("prep,match", [
    (None, "리뷰 반영 5 <> 기대 4"),
    ("UPDATE mig_src.qa_review_notes SET resolved_at = now() WHERE id = 'b1000000-0000-4000-8000-000000000005'", "해결 시각·해결자 한쪽만"),
    ("UPDATE mig_src.qa_answer_reviews SET section_flags = '{\"answer\": \"ok\", \"extra\": \"ok\"}' "
     "WHERE job_id = '90000000-0000-4000-8000-000000000012'", "6키 밖 키"),
    ("UPDATE mig_src.qa_answer_reviews SET section_flags = '{\"answer\": \"maybe\"}' WHERE job_id = '90000000-0000-4000-8000-000000000012'",
     "ok/issue 밖 값"),
    ("UPDATE mig_src.qa_answer_reviews SET status = 'ok' WHERE job_id = '90000000-0000-4000-8000-000000000001'", "파생값과 다른 리뷰 1건"),
    ("DELETE FROM mig_src.qa_ref_job WHERE job_id = '90000000-0000-4000-8000-000000000021'", "참조 qa_ref_job 에 없는 job 1건"),
    ("DROP TABLE mig_src.qa_ref_acr", "mig_src QA 표·지문 함수 없음"),
], ids=["expect", "resolved_pair", "flag_key", "flag_value", "status", "ref_job", "no_table"])
async def test_t9_guards_abort_without_writing(prep, match):
    """기대 반영 수가 드라이런과 다르거나 원천 위반(해결 쌍·플래그·status·참조 누락)·선행 표 없음이면 예외, 아무것도 쓰지 않는다."""
    async def run(c):
        await stage(c)
        with pytest.raises(asyncpg.RaiseError, match=match):
            async with c.transaction():
                if prep:
                    await c.execute(prep)
                await migrate(c, expect_reviews=4)
        assert (await c.fetchval("SELECT count(*) FROM app.qa_answer_review")) == 0
        assert (await c.fetchval("SELECT count(*) FROM app.qa_review_note")) == 0
    await _in_txn(run)


async def test_t9_verify_strict_raises_on_fail():
    """verify strict(기본 1): 이관 미수정이 아닌데 skip 보고도 없는 행(검증 전 back 수정)이 있으면 QA_VERIFY_FAIL 예외."""
    async def run(c):
        await stage(c)
        await migrate(c)
        await c.execute("UPDATE app.qa_answer_review SET reviewer_name = 'changed' WHERE job_id = $1", J21)
        with pytest.raises(asyncpg.RaiseError, match="QA_VERIFY_FAIL V1"):
            async with c.transaction():
                await verify(c, strict=1)
    await _in_txn(run)


# ── T10 시간대 ───────────────────────────────────────────────────────────────
async def test_t10_timezone_roundtrip_and_hash():
    """COPY CSV(오프셋 포함)로 LA 시간대 세션에서 내보내고 서울 시간대 세션에서 적재해도 마이크로초 timestamptz 가 같다.
    지문(epoch)은 세션 TimeZone 과 무관: 서울에서 이관한 뒤 UTC 세션에서 다시 돌리면 전부 noop."""
    async def run(c):
        await stage(c)
        want_r = {r["job_id"]: (r["reviewed_at"], r["updated_at"]) for r in await c.fetch("SELECT * FROM mig_src.qa_answer_reviews")}
        want_n = {r["id"]: (r["created_at"], r["resolved_at"]) for r in await c.fetch("SELECT * FROM mig_src.qa_review_notes")}
        await c.execute("SET LOCAL TIME ZONE 'America/Los_Angeles'")
        dumps = {}
        for t in ("qa_answer_reviews", "qa_review_notes"):
            chunks: list[bytes] = []

            async def sink(b: bytes, chunks=chunks) -> None:
                chunks.append(b)
            await c.copy_from_query(f"SELECT * FROM mig_src.{t}", output=sink, format="csv")
            dumps[t] = b"".join(chunks)
        assert b"-07" in dumps["qa_answer_reviews"]                                  # CSV 시각에 오프셋이 붙는다
        await c.execute("TRUNCATE mig_src.qa_answer_reviews, mig_src.qa_review_notes")
        await c.execute("SET LOCAL TIME ZONE 'Asia/Seoul'")
        for t, data in dumps.items():
            async def src(data=data):
                yield data
            await c.copy_to_table(t, schema_name="mig_src", source=src(), format="csv")
        await migrate(c, expect_reviews=5, expect_notes=14)
        got_r = {r["job_id"]: (r["reviewed_at"], r["updated_at"]) for r in await c.fetch("SELECT * FROM app.qa_answer_review")}
        got_n = {r["note_id"]: (r["created_at"], r["resolved_at"]) for r in await c.fetch("SELECT * FROM app.qa_review_note")}
        assert got_r == want_r and got_n == want_n
        await c.execute("SET LOCAL TIME ZONE 'UTC'")
        again = await migrate(c, expect_reviews=0, expect_notes=0)
        assert set(again["reviews"].values()) == {"noop"} and {a for a, _ in again["notes"].values()} == {"noop"}
    await _in_txn(run)


# ── T12 추출 질의(export-qa.sql)와 from_snapshot ──────────────────────────────────
MIRROR_TABLES = ("qa_answer_reviews", "qa_review_notes", "scope_answers", "scope_citations", "scope_mentions", "scope_acr_rollups")
QA_EXPORT = ("qa_answer_reviews", "qa_review_notes", "qa_ref_job", "qa_ref_citation", "qa_ref_mention", "qa_ref_acr")
REF_ORDER = {"qa_ref_job": "job_id", "qa_ref_citation": "job_id, id", "qa_ref_mention": "job_id, entity_id",
             "qa_ref_acr": "job_id, prompt_run_id, entity_id"}


async def test_t12_export_queries_and_from_snapshot():
    """export-qa.sql 블록을 레거시 public 표(mirror-schema.sql 정의) 위에서 COPY → mig_src_qa.sql 표로 COPY(열 순서 일치).
    ord = job 안 id 순(id 12·5·9 → 9 는 ord 2), 인용 노트 없는 job 의 인용은 뺀다, ACR = 4축 근사(region NULL 끼리 일치, region 다르면 제외),
    in_mirror = scope_answers 에 있음. from_snapshot(mig_src.scope_* = mig_src.sql 정의)도 같은 참조를 만든다."""
    q = load_named_sql(MIG / "export-qa.sql")
    assert tuple(q) == QA_EXPORT

    async def run(c):
        await c.execute(_ddl())
        for t in MIRROR_TABLES:
            assert await c.fetchval("SELECT to_regclass($1) IS NULL", f"public.{t}")
        await c.execute(_create_tables(MIG / "mirror-schema.sql", "public", MIRROR_TABLES))
        await c.execute(DATA["legacy_public"])
        for t in QA_EXPORT:
            chunks: list[bytes] = []

            async def sink(b: bytes, chunks=chunks) -> None:
                chunks.append(b)
            await c.copy_from_query(q[t], output=sink, format="csv")

            async def src(data=b"".join(chunks)):
                yield data
            await c.copy_to_table(t, schema_name="mig_src", source=src(), format="csv")
        cit = [tuple(r) for r in await c.fetch("SELECT id, ord, url, ref_index, domain FROM mig_src.qa_ref_citation ORDER BY id")]
        assert cit == [(5, 1, "https://a.example/1", 1, "a.example"), (9, 2, "https://b.example/2", None, "b.example"),
                       (12, 3, "https://a.example/3", 3, "a.example")]
        jobs = {str(r["job_id"])[-1]: r["in_mirror"] for r in await c.fetch("SELECT * FROM mig_src.qa_ref_job")}
        assert jobs == {"1": True, "2": True, "4": False}
        acr = {(str(r["job_id"])[-1], str(r["prompt_run_id"])[-1]) for r in await c.fetch("SELECT * FROM mig_src.qa_ref_acr")}
        assert acr == {("1", "1"), ("2", "3")}
        assert await c.fetchval("SELECT count(*) FROM mig_src.qa_ref_mention") == 2
        n = await c.fetchrow("SELECT body, created_at FROM mig_src.qa_review_notes WHERE id = 'c2000000-0000-4000-8000-000000000001'")
        assert n["body"] == '줄\n바꿈, "쉼표"' and n["created_at"] == datetime(2026, 9, 20, 0, 20, 0, 1, tzinfo=UTC)
        r = await c.fetchrow("SELECT section_flags, reviewed_at FROM mig_src.qa_answer_reviews WHERE job_id = 'c1000000-0000-4000-8000-000000000001'")
        assert r["section_flags"] == '{"citations": "issue"}' and r["reviewed_at"] == datetime(2026, 9, 19, 15, 10, 0, 123456, tzinfo=UTC)
        exported = {t: [tuple(x) for x in await c.fetch(f"SELECT * FROM mig_src.{t} ORDER BY {o}")] for t, o in REF_ORDER.items()}
        # from_snapshot: 10-06 mig_src 스냅샷 표(mig_src.sql 정의)에 같은 레거시 행 → 같은 참조
        await c.execute(_create_tables(MIG / "mig_src.sql", "mig_src", ("scope_answers", "scope_citations", "scope_mentions", "scope_acr_rollups")))
        for t in ("scope_answers", "scope_citations", "scope_mentions", "scope_acr_rollups"):
            cols = [r["attname"] for r in await c.fetch("SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 "
                                                         "AND NOT attisdropped ORDER BY attnum", f"mig_src.{t}")]
            await c.execute(f"INSERT INTO mig_src.{t} ({', '.join(cols)}) SELECT {', '.join(cols)} FROM public.{t}")
        await c.execute(_from_snapshot())
        assert {t: [tuple(x) for x in await c.fetch(f"SELECT * FROM mig_src.{t} ORDER BY {o}")] for t, o in REF_ORDER.items()} == exported
    await _in_txn(run)


# ── T11 API 동등(커밋 상태) ───────────────────────────────────────────────────────
async def test_t11_api_after_carry(client_as):
    """이관을 커밋한 뒤 검수 API 가 이관 행을 레거시와 같은 뜻으로 낸다.
    - 상세 J1 의 인용 ord 3 target_key = 이관된 인용 노트 키(배지 1), newfmt 노트도 ord 4 에 붙는다. 멘션·ACR 키 = 노트 키 그대로.
    - 진행률(서버 범위 전 표면) = 손계산: total 21, reviewed 4(고아 제외), issues 1, notes 4. 노트 건수 = 스테이지(고아 job 제외) target_kind 별."""
    c = await asyncpg.connect(DB_URL)
    had_schema = await c.fetchval("SELECT to_regnamespace('mig_src') IS NOT NULL")
    try:
        async with c.transaction():
            await stage(c)
            await c.execute("DELETE FROM app.qa_answer_lock; DELETE FROM app.qa_review_session")
            await migrate(c, expect_reviews=5, expect_notes=14)
        rv = await new_session("검수자A")
        async with qa_client(client_as, rv) as cl:
            d = (await cl.get(f"/v1/qa/answers/{J1}")).json()["data"]
            notes = (await cl.get(f"/v1/qa/answers/{J1}/notes")).json()["data"]["items"]
            d12 = (await cl.get(f"/v1/qa/answers/{J12}")).json()["data"]
            prog = (await cl.get("/v1/qa/answers/progress")).json()["data"]
            counts_all = (await cl.get("/v1/qa/notes/counts", params={"include_resolved": "true"})).json()["data"]
            counts_open = (await cl.get("/v1/qa/notes/counts")).json()["data"]
            listed = (await cl.get("/v1/qa/notes", params={"include_resolved": "true", "limit": 200})).json()["data"]["items"]
            orphan = await cl.get(f"/v1/qa/answers/{JO}/notes")
        by_key: dict[tuple[str, str | None], int] = {}
        for n in notes:
            if n["resolved_at"] is None:
                by_key[(n["target_kind"], n["target_key"])] = by_key.get((n["target_kind"], n["target_key"]), 0) + 1
        cit_badges = {c_["ord"]: by_key.get(("citation", c_["target_key"]), 0) for c_ in d["citations"]}
        assert cit_badges == {1: 0, 2: 0, 3: 1, 4: 1, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0}
        men_badges = {m["display_name"]: by_key.get(("mention", m["entity_id"]), 0) for m in d["mentions"]}
        assert men_badges["Toyota"] == 1 and sum(men_badges.values()) == 1
        cell = d12["acr"][0]
        assert {f"{cell['prompt_run_id']}:{ch['entity_id']}" for ch in cell["choices"]} >= {ACR_KEY}
        assert len(notes) == 9 and {n["note_id"] for n in notes} == {str(N[i]) for i in (1, 2, 3, 5, 8, 10, 11, 12, 13)}
        assert prog["total"] == {"total": 21, "reviewed": 4, "issues": 1, "notes": 4}
        assert counts_all == {"acr": 1, "answer": 2, "citation": 6, "mention": 2, "meta": 1, "prompt": 1}
        assert counts_open == {**counts_all, "answer": 1}
        assert len(listed) == 13 and [x["created_at"] for x in listed] == sorted((x["created_at"] for x in listed), reverse=True)
        assert orphan.status_code == 404                                         # 새 고아 job 은 이관됐지만 화면에 나오지 않는다
    finally:
        await c.execute("DROP SCHEMA mig_src CASCADE" if not had_schema else
                        "DROP TABLE IF EXISTS mig_src.qa_answer_reviews, mig_src.qa_review_notes, mig_src.qa_ref_job, mig_src.qa_ref_citation, "
                        "mig_src.qa_ref_mention, mig_src.qa_ref_acr, mig_src.qa_carry_ledger, mig_src.qa_carry_report; "
                        "DROP FUNCTION IF EXISTS mig_src.qa_review_hash, mig_src.qa_note_hash, mig_src.qa_name_off")
        await c.close()
