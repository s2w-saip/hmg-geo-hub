"""SQL 경계 가드의 동결 층(DB-v2.21 frz) 규칙: frz 사실 관계(동결 읽기 뷰·보관 표)도 G1 세 술어를 요구하고, API 문장은 frz 를 쓰지 못한다(G6).
DB 없이 도는 정적 시험."""
from __future__ import annotations

import pytest

from app.core.sqlguard import FACT_RELS, fact_guard

OK_PRED = "a.surface = 1 AND a.round_date BETWEEN '2026-09-01' AND '2026-09-30' AND a.cyc_key = ANY(:k)"


@pytest.mark.parametrize("rel", ["frz.answer", "frz.answer_brand", "frz.citation", "frz.keep_answer", "frz.keep_answer_brand", "frz.keep_citation"])
def test_frz_fact_relations_need_three_predicates(rel):
    assert fact_guard(f"SELECT count(*) FROM {rel} a WHERE {OK_PRED}") == []
    v = fact_guard(f"SELECT count(*) FROM {rel} a WHERE a.surface = 1")
    assert any("round_date 술어 없음" in x for x in v) and any("cyc_key 술어 없음" in x for x in v), v
    assert all(x.startswith(f"G1 {rel}") for x in v), v


def test_frz_non_fact_tables_and_writes():
    assert fact_guard("SELECT gen_key FROM frz.generation WHERE state = 'active'") == []
    assert fact_guard("SELECT answer_key FROM frz.cell WHERE cyc_key = ANY(:k)") == []
    for sql in ("INSERT INTO frz.cell (gen_key) VALUES (1)", "UPDATE frz.generation SET state = 'retired'", "DELETE FROM frz.kept"):
        assert any(x.startswith("G6 frz 쓰기") for x in fact_guard(sql)), sql
    assert any(x.startswith("G6 rd 쓰기") for x in fact_guard("DELETE FROM rd.answer WHERE true"))
    assert ("rd", "answer") in FACT_RELS and ("frz", "answer") in FACT_RELS and ("frz", "cell") not in FACT_RELS
