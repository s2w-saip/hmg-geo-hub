"""qa.notes.notes: 노트 작성·조회·목록(키셋)·건수·CSV·수정·삭제(작성자 제한, Q17)."""
from __future__ import annotations

import csv
import io
import json
import uuid

import pytest

from app.core.write import get_audit_writer
from app.features.qa.answers.list.tests.qa_support import (
    db_exec,
    db_rows,
    db_val,
    job_id_of,
    new_session,
    qa_client,
)
from app.features.qa.notes.notes import queries as NQ
from tests.support import needs_db

pytestmark = [needs_db, pytest.mark.usefixtures("qa_clean")]


async def post(c, answer_key: int, **body):
    return await c.post(f"/v1/qa/answers/{await job_id_of(answer_key)}/notes", json={"target_kind": "answer", "body": "x", **body})


async def test_create_and_job_notes(client_as):
    a = await new_session("갑")
    jid = await job_id_of(1)
    async with qa_client(client_as, a) as c:
        r = await post(c, 1, target_kind="citation", target_key=f"{jid}:6", target_label="example.org", severity="question", body="  분류? ")
        assert r.status_code == 201, r.text
        n = r.json()["data"]
        assert n["body"] == "분류?" and n["reviewer_name"] == "갑" and n["severity"] == "question" and n["resolved_at"] is None
        await post(c, 1, body="둘째")
        r = await c.get(f"/v1/qa/answers/{jid}/notes")
        assert [x["body"] for x in r.json()["data"]["items"]] == ["분류?", "둘째"]           # created_at 순
    rows = await db_rows("SELECT reviewer_id, session_id, target_key FROM app.qa_review_note ORDER BY created_at")
    assert rows[0]["reviewer_id"] is None and str(rows[0]["session_id"]) == a.session_id and rows[0]["target_key"] == f"{jid}:6"


@pytest.mark.parametrize("body", [{"target_kind": "answer", "body": "   "}, {"target_kind": "nope", "body": "x"},
                                  {"target_kind": "answer", "body": "x" * 4001}, {"target_kind": "answer", "body": "x", "severity": "fatal"},
                                  {"target_kind": "answer", "body": "x", "extra": 1}])
async def test_create_invalid_422(client_as, body):
    a = await new_session("갑")
    async with qa_client(client_as, a) as c:
        r = await c.post(f"/v1/qa/answers/{await job_id_of(1)}/notes", json=body)
    assert r.status_code == 422
    assert await db_val("SELECT count(*) FROM app.qa_review_note") == 0


async def test_create_unknown_job_revoked_session_no_cookie(client_as):
    a = await new_session("갑")
    async with qa_client(client_as, a) as c:
        assert (await c.post(f"/v1/qa/answers/{uuid.uuid4()}/notes", json={"target_kind": "answer", "body": "x"})).status_code == 404
        await db_exec("DELETE FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(a.session_id))
        assert (await post(c, 1)).status_code == 401
    async with qa_client(client_as, None) as c:
        assert (await post(c, 1)).status_code == 401
        assert (await c.get("/v1/qa/notes")).status_code == 401
    assert await db_val("SELECT count(*) FROM app.qa_review_note") == 0


async def _seed(client_as):
    a = await new_session("갑")
    async with qa_client(client_as, a) as c:
        for k, kind, sev in ((1, "answer", "issue"), (1, "citation", "info"), (2, "mention", "issue"), (21, "answer", "question"),
                             (31, "meta", "issue")):
            assert (await post(c, k, target_kind=kind, severity=sev, body=f"n{k}-{kind}")).status_code == 201
    await db_exec("UPDATE app.qa_review_note SET resolved_at = now(), resolved_by = '을' WHERE body = 'n2-mention'")
    return a


async def test_list_filters_and_keyset(client_as):
    a = await _seed(client_as)
    async with qa_client(client_as, a) as c:
        r = await c.get("/v1/qa/notes")
        items = r.json()["data"]["items"]
        want = [x["body"] for x in await db_rows("SELECT body FROM app.qa_review_note WHERE resolved_at IS NULL ORDER BY created_at DESC, note_id DESC")]
        assert [x["body"] for x in items] == want and len(want) == 4                        # 기본 미해결만
        web = next(x for x in items if x["body"] == "n21-answer")
        assert web["surface"] == "website" and web["country"] == "DE" and web["prompt_text"] == "ev9?" and web["engine"] == "chatgpt"
        assert web["brand"] == ["Kia"]                                  # qa R1(DB-v2.6 P47): 행 브랜드 좌표(손계산: job 21 bgrp 2 = Kia)
        assert len((await c.get("/v1/qa/notes", params={"include_resolved": "true"})).json()["data"]["items"]) == 5
        assert [x["body"] for x in (await c.get("/v1/qa/notes", params={"surface": "website"})).json()["data"]["items"]] == ["n21-answer"]
        assert {x["body"] for x in (await c.get("/v1/qa/notes", params={"severity": "issue"})).json()["data"]["items"]} == {"n1-answer", "n31-meta"}
        assert [x["body"] for x in (await c.get("/v1/qa/notes", params={"target_kind": "citation"})).json()["data"]["items"]] == ["n1-citation"]
        assert (await c.get("/v1/qa/notes", params={"engine": "nope"})).json()["data"]["items"] == []
        got, cursor = [], None
        while True:
            r = await c.get("/v1/qa/notes", params={"limit": 2, "include_resolved": "true", **({"cursor": cursor} if cursor else {})})
            assert r.status_code == 200, r.text
            got += [x["note_id"] for x in r.json()["data"]["items"]]
            cursor = r.json()["meta"]["page"]["next_cursor"]
            if not cursor:
                break
        all_ids = [str(x["note_id"]) for x in await db_rows("SELECT note_id FROM app.qa_review_note ORDER BY created_at DESC, note_id DESC")]
        assert got == all_ids
        assert (await c.get("/v1/qa/notes", params={"cursor": "zz"})).status_code == 422


async def test_counts(client_as):
    a = await _seed(client_as)
    async with qa_client(client_as, a) as c:
        r = await c.get("/v1/qa/notes/counts")
        assert r.json()["data"] == {"answer": 2, "citation": 1, "meta": 1}
        r = await c.get("/v1/qa/notes/counts", params={"include_resolved": "true", "surface": "global"})
        assert r.json()["data"] == {"answer": 1, "citation": 1, "mention": 1}


async def test_export_csv(client_as):
    a = await _seed(client_as)
    w = get_audit_writer()
    before = len(w.pending())
    async with qa_client(client_as, a) as c:
        await post(c, 3, body="=HYPERLINK(\"http://x\")")
        r = await c.get("/v1/qa/notes/export", params={"funnel": "x"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert r.headers["x-row-count"] == "5" and r.headers["x-ignored-filters"] == "funnel"
    # core.export 로 통일: 헤더(no-store·첨부 파일명)는 그대로, 상한 안이면 X-Export-Truncated 없음
    assert r.headers["cache-control"] == "no-store" and "x-export-truncated" not in r.headers
    assert r.headers["content-disposition"].startswith('attachment; filename="qa-notes-') and r.headers["content-disposition"].endswith('.csv"')
    # qa R2: 다운로드 1건 = 접근 감사 1건(kind download, 검수자 = 세션 id·'vendor'·detail.actor_kind)
    ev = w.pending()[before:]
    assert len(ev) == 1 and (ev[0].kind, ev[0].action, ev[0].actor_role) == ("download", "qa.notes.export", "vendor")
    assert ev[0].actor_id == uuid.UUID(a.session_id)
    assert ev[0].detail == {"actor_kind": "qa_reviewer", "reviewer_name": "갑", "rows": 5, "truncated": False}
    text = r.content.decode("utf-8")
    assert text.startswith("﻿")
    rows = list(csv.reader(io.StringIO(text[1:])))
    assert rows[0] == ["created_at", "reviewer", "job_id", "target_kind", "target_key", "target_label", "severity", "body", "prompt",
                       "surface", "resolved_at", "resolved_by"]
    assert len(rows) == 6 and "\r\n" in text
    inj = next(x for x in rows[1:] if "HYPERLINK" in x[7])
    assert inj[7].startswith("'=")                                                          # 수식 주입 방지


async def test_patch_author_rules(client_as):
    a, b = await new_session("갑"), await new_session("을")
    async with qa_client(client_as, a) as ca, qa_client(client_as, b) as cb:
        nid = (await post(ca, 1, body="원문")).json()["data"]["note_id"]
        r = await cb.patch(f"/v1/qa/notes/{nid}", json={"body": "남이 고침"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_author"
        r = await ca.patch(f"/v1/qa/notes/{nid}", json={"body": "고침", "severity": "info"})
        assert r.status_code == 200 and r.json()["data"]["body"] == "고침" and r.json()["data"]["severity"] == "info"
        r = await cb.patch(f"/v1/qa/notes/{nid}", json={"resolved": True})                  # 해소 토글은 누구나, 처리자 기록
        assert r.json()["data"]["resolved_by"] == "을" and r.json()["data"]["resolved_at"]
        r = await ca.patch(f"/v1/qa/notes/{nid}", json={"resolved": False})
        assert r.json()["data"]["resolved_by"] is None and r.json()["data"]["resolved_at"] is None
        assert (await ca.patch(f"/v1/qa/notes/{nid}", json={})).status_code == 422
        assert (await ca.patch(f"/v1/qa/notes/{nid}", json={"body": " "})).status_code == 422
        assert (await ca.patch(f"/v1/qa/notes/{uuid.uuid4()}", json={"resolved": True})).status_code == 404
    row = (await db_rows("SELECT body, severity FROM app.qa_review_note WHERE note_id = $1", uuid.UUID(nid)))[0]
    assert (row["body"], row["severity"]) == ("고침", "info")


async def test_delete_author_only(client_as):
    a, b = await new_session("갑"), await new_session("을")
    async with qa_client(client_as, a) as ca, qa_client(client_as, b) as cb:
        nid = (await post(ca, 1)).json()["data"]["note_id"]
        r = await cb.delete(f"/v1/qa/notes/{nid}")
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_author"
        assert await db_val("SELECT count(*) FROM app.qa_review_note") == 1
        r = await ca.delete(f"/v1/qa/notes/{nid}")
        assert r.status_code == 200 and r.json()["data"] == {"note_id": nid, "deleted": True}
        assert (await ca.delete(f"/v1/qa/notes/{nid}")).status_code == 404
    assert await db_val("SELECT count(*) FROM app.qa_review_note") == 0


async def test_d6_export_reports_dropped_and_suppressed(client_as):
    """재현(D6): country=ZZ 는 헤더만 있는 빈 CSV 인데 dropped·suppressed 가 어디에도 없었다."""
    a = await _seed(client_as)
    async with qa_client(client_as, a) as c:
        r = await c.get("/v1/qa/notes/export", params={"country": "ZZ"})
        assert r.status_code == 200 and r.headers["x-row-count"] == "0"
        assert json.loads(r.headers["x-dropped-filters"]) == {"country": ["ZZ"]}
        # qa R1(DB-v2.6 P47) 반영: 가릴 값이 없어 X-Suppressed 가 없다(목록 meta.suppressed 도 빈 객체)
        assert "x-suppressed" not in r.headers
        lst = await c.get("/v1/qa/notes", params={"country": "ZZ"})                     # 목록 API meta 와 같은 값
        assert lst.json()["meta"]["dropped_filters"] == json.loads(r.headers["x-dropped-filters"])
        assert lst.json()["meta"]["suppressed"] == {}
        r = await c.get("/v1/qa/notes/export", params={"country": "한국"})                # 비ASCII 값도 헤더에 안전하게
        assert json.loads(r.headers["x-dropped-filters"]) == {"country": ["한국"]}
        r = await c.get("/v1/qa/notes/export")
        assert "x-suppressed" not in r.headers and "x-dropped-filters" not in r.headers


async def test_export_truncated_header(client_as, monkeypatch):
    """core.export 통일: 상한(EXPORT_LIMIT)을 넘으면 잘라서 X-Export-Truncated: true(예전에는 X-Row-Count 로만 짐작). 상한을 2로 낮춰 확인."""
    a = await _seed(client_as)
    monkeypatch.setattr(NQ, "EXPORT_LIMIT", 2)
    async with qa_client(client_as, a) as c:
        r = await c.get("/v1/qa/notes/export")
    assert r.status_code == 200 and r.headers["x-row-count"] == "2" and r.headers["x-export-truncated"] == "true"
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8")[1:])))
    want = [x["body"] for x in await db_rows("SELECT body FROM app.qa_review_note WHERE resolved_at IS NULL "
                                             "ORDER BY created_at DESC, note_id DESC LIMIT 2")]
    assert [x[7] for x in rows[1:]] == want
