"""관리 엔티티 목록 합계(rd.entity_mention_total, DB-v2.25 P132~P135) 쓰기 경로 정적 가드(엔티티 관리 5차 검증 4). DB 없이 소스만 읽는다.

합계 증분은 ing.mention·ing.answer_drop 의 **부모 표 문장 트리거**가 쌓는다. 트리거 밖 쓰기는 차분을 남기지 않는다:
  ① leaf 파티션 직접 쓰기(ing.mention_YYYYMM 등): 부모 문장 트리거가 돌지 않는다 → 금지(이 시험이 잡는다).
  ② TRUNCATE ing.mention·ing.answer_drop: 트리거가 돌지 않는다 → 같은 파일 안에서 rd.refresh_entity_mention_total(NULL) 로 전체 재계산 필수.
시험 코드(*/tests/*)·이 가드가 설명하는 패치 파일은 대상 밖.
"""
from __future__ import annotations

import pathlib
import re

BACK = pathlib.Path(__file__).resolve().parents[2]
ROOTS = ("app", "ingest", "migration", "db")
EXCLUDE = ("db/DB-v2.25-patch.sql",)
LEAF_WRITE = re.compile(r"(?i)\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?(?:\s+only)?|copy|merge\s+into)\s+"
                        r"ing\s*\.\s*(?:mention|answer_drop)_[0-9a-z_]+\b")
OCC = re.compile(r"(?i)ing\s*\.\s*mention_occurrence")
TRUNC = re.compile(r"(?im)^\s*truncate\b[^;]*\bing\s*\.\s*(?:mention|answer_drop)\b(?!_)")     # 문장 머리(주석 문장 제외)
REFRESH = re.compile(r"rd\.refresh_entity_mention_total\(\s*NULL\s*\)")


def _files() -> list[pathlib.Path]:
    out = []
    for root in ROOTS:
        for p in sorted((BACK / root).rglob("*")):
            rel = p.relative_to(BACK).as_posix()
            if p.suffix not in (".py", ".sql", ".pgsql") or "/tests/" in f"/{rel}" or rel in EXCLUDE:
                continue
            out.append(p)
    return out


def test_no_direct_leaf_partition_writes():
    bad = []
    for p in _files():
        for m in LEAF_WRITE.finditer(p.read_text(encoding="utf-8", errors="replace")):
            if not OCC.search(m.group(0)):
                bad.append(f"{p.relative_to(BACK)}: {m.group(0)}")
    assert not bad, "leaf 파티션 직접 쓰기는 합계 트리거를 우회한다(부모 표로 쓴다):\n" + "\n".join(bad)


def test_truncate_paths_refresh_totals():
    bad = []
    for p in _files():
        src = p.read_text(encoding="utf-8", errors="replace")
        if TRUNC.search(src) and not REFRESH.search(src):
            bad.append(str(p.relative_to(BACK)))
    assert not bad, "TRUNCATE ing.mention·ing.answer_drop 뒤 rd.refresh_entity_mention_total(NULL) 이 없다: " + ", ".join(bad)
    assert REFRESH.search((BACK / "migration/seed/seed-20-ing.sql").read_text(encoding="utf-8"))


def test_guard_catches_violations(tmp_path):
    """음성 시험: 가드 정규식이 leaf 쓰기·재계산 없는 TRUNCATE 를 잡는다."""
    assert LEAF_WRITE.search("INSERT INTO ing.mention_202609 (run_month) VALUES (1)")
    assert not LEAF_WRITE.search("INSERT INTO ing.mention (run_month) VALUES (1)")
    assert OCC.search("DELETE FROM ing.mention_occurrence m")
    assert TRUNC.search("TRUNCATE ing.cycle_run, ing.answer_drop, ing.sync_cursor;")
    assert not TRUNC.search("-- 기존 쓰기 경로가 TRUNCATE(fixture-00), ing.mention 설명;")
    assert not TRUNC.search("TRUNCATE ing.mention_occurrence;")
