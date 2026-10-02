"""DB 합본 사슬(be/int3 통합 기준선): DB-v2.(n).sql = DB-v2.(n-1).sql + DB-v2.(n)-patch.sql 바이트 연결(n = 16..32), 패치 P 번호가 겹치지 않음.
v2.19(가번호 P106~P109 → P107~P110)·v2.20(가번호 DB-vNEXT-wu12 PW1~PW3 → P111~P113)·v2.25(가번호 DB-vNEXT-entity-mention-total PE1~PE4 → P132~P135)·v2.29~v2.31(be/int4: 가번호 dim-brand-name-hash PH1~PH3 → P145~P147, pick-basis PB1~PB4
→ P148~P151, ecat-refreeze-audit PR1 → P152, frz-perf PF1~PF3 → P153~P155) 재번호의 회귀 방지. DB 없이 도는 정적 시험.
빈 DB 에서 순차 적용 대 합본 통째 적용의 스키마 동치(pg_dump -s)는 통합 절차의 수동 점검이다(be/int2 머지 기록)."""
from __future__ import annotations

import pathlib
import re

import pytest

DB = pathlib.Path(__file__).resolve().parents[2] / "db"
CHAIN = range(16, 33)


@pytest.mark.parametrize("n", CHAIN)
def test_merged_is_previous_plus_patch(n):
    assert (DB / f"DB-v2.{n}.sql").read_bytes() == (DB / f"DB-v2.{n - 1}.sql").read_bytes() + (DB / f"DB-v2.{n}-patch.sql").read_bytes()


def test_patch_numbers_disjoint_and_increasing():
    """각 패치가 '-- ── P<n>' 절로 여는 P 번호: 패치끼리 겹치지 않고 버전 순서대로 커진다(통합 때 가번호가 남지 않게)."""
    seen: dict[int, int] = {}
    last = 0
    for n in range(17, 33):
        nums = sorted({int(x) for x in re.findall(r"^-- ── P(\d+)", (DB / f"DB-v2.{n}-patch.sql").read_text(encoding="utf-8"), re.M)})
        assert nums, n
        for p in nums:
            assert p not in seen, f"P{p}: DB-v2.{seen[p]} 과 DB-v2.{n} 이 같은 번호"
            seen[p] = n
        assert nums[0] > last, (n, nums[0], last)
        last = nums[-1]


def test_no_provisional_patch_files():
    """통합 기준선 관문: 가번호 패치(DB-vNEXT-*)가 남아 있지 않다. 가번호 패치를 가진 기능 브랜치에서는 이 시험 하나만 실패하는 것이 정상이고
    (통합 때 번호 배정·합본 연결로 해소), 다른 사슬 시험과 섞이지 않게 따로 둔다."""
    assert not list(DB.glob("DB-vNEXT*")), "가번호 패치 파일이 남아 있다"
