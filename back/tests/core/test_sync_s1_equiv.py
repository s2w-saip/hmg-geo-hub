"""BE-11(동기화 S1 계획 sync-s1-plan.md §5) 동치 확인. hub 는 아래 2 규칙을 이미 2670a16 과 같게 구현하고 있다 — 전환 코드는
없고, 이 파일은 그 현행을 합성 데이터로 고정하는 회귀 시험이다(다른 파일은 건드리지 않는다).

1. 글로벌 회차 주 버킷 = KST 좌석일(round_date) 기준 date_trunc('week', round_date)(#300 8c26ade).
   근거: ingest/cycles/ledger/service.py 의 CANONICAL_DOW(global=월)·_kst_date, app/core/measure.py GROUPS['week'].
   계획 worked example: 앵커 09-20T15:50Z(UTC) → round_date 09-21(KST) → week 09-21.
2. 우선 노출도(M04·M-1) 경쟁 순위 축 = rank() OVER (PARTITION BY answer_key ORDER BY tp)(#308 6bc5c54).
   근거: ingest/project/apply/queries.py:832(_ig_ab.rk), app/core/measure.py:21 "순위는 앱에서(LIMIT 금지)".
   tp = 브랜드 최소 위치(avg_position, 작을수록 우선). 동률·NULL·10 위 밖(캡 없음)을 확인한다.
"""
from __future__ import annotations

import datetime as dt
import pathlib

import asyncpg
import pytest

from app.core.measure import GROUPS
from ingest.cycles.ledger.service import _kst_date, canonical_dow
from tests.support import DB_URL, needs_db

QUERIES_PY = pathlib.Path(__file__).resolve().parents[2] / "ingest" / "project" / "apply" / "queries.py"
RANK_SRC_LITERAL = "rank() OVER (PARTITION BY answer_key ORDER BY tp)::int2 AS rk"


class TestGlobalWeekKst:
    """#300(8c26ade): 글로벌 표준 요일 = 월(KST), 주 버킷 = 그 좌석일의 ISO 주(월요일 시작)."""

    def test_canonical_dow_global_is_monday(self):
        assert canonical_dow("global") == 1

    @pytest.mark.parametrize(
        "utc_iso, expected_kst_date",
        [
            ("2026-09-20T15:50:00+00:00", dt.date(2026, 9, 21)),  # 계획 worked example(앵커 → round_date)
            ("2026-09-20T14:59:59+00:00", dt.date(2026, 9, 20)),  # KST 자정 1초 전(경계 미달)
            ("2026-09-20T15:00:00+00:00", dt.date(2026, 9, 21)),  # KST 자정 정각(경계)
        ],
    )
    def test_kst_date_boundary(self, utc_iso, expected_kst_date):
        assert _kst_date(dt.datetime.fromisoformat(utc_iso)) == expected_kst_date

    def test_worked_example_anchor_lands_on_canonical_monday(self):
        """앵커 09-20T15:50Z 의 KST 좌석일(09-21)은 이미 정규 월요일이라 assign_seat 의 prev/next 병합 분기를
        타지 않는다(round_date == anchor_date, basis='canonical'). 이 값이 정규 요일이 아니면 이 시험이 깨진다."""
        anchor_date = _kst_date(dt.datetime.fromisoformat("2026-09-20T15:50:00+00:00"))
        assert anchor_date == dt.date(2026, 9, 21)
        assert anchor_date.isoweekday() == canonical_dow("global")

    @needs_db
    async def test_week_bucket_matches_measure_groups_formula(self):
        """app.core.measure.GROUPS['week'] 식을 실제 Postgres 로 돌려, 계획 worked example 의 round_date(09-21)에
        적용한 값이 같은 날짜(09-21, 월요일이 이미 주 시작)인지 — 코드에 하드코딩된 규칙을 재구현하지 않고 그대로 실행한다."""
        _, expr = GROUPS["week"]
        sql = f"SELECT {expr.format(a='x')} AS week FROM (SELECT date '2026-09-21' AS round_date) x"
        conn = await asyncpg.connect(DB_URL)
        try:
            week = await conn.fetchval(sql)
        finally:
            await conn.close()
        assert week == dt.date(2026, 9, 21)


class TestPriorityExposureRankAxis:
    """#308(6bc5c54): 우선 노출도 경쟁 순위 축은 이미 답변 안 경쟁 순위(rank() OVER PARTITION BY answer_key ORDER BY tp)로
    통일돼 있다. 적재기(ingest/project/apply/queries.py) 의 _ig_ab.rk 조립과 동일한 SQL 을 합성 VALUES 로 돌려 확인한다."""

    def test_source_uses_tp_order_axis(self):
        """적재기 소스에 순위축(tp 오름차순) 리터럴이 그대로 있는지 — 축이 바뀌면(예: mention_count 순) 즉시 깨진다."""
        assert RANK_SRC_LITERAL in QUERIES_PY.read_text(encoding="utf-8")

    @needs_db
    async def test_rank_semantics_tie_null_beyond_cap(self):
        """_ig_ab.rk 와 같은 조립(rank() OVER(PARTITION BY answer_key ORDER BY tp), 대상 = competitive ∧ brand_key<>0 ∧
        tp IS NOT NULL, 그 외는 default rk=0). 동률(brand 2·3 공동 2위, brand 4 는 4위로 건너뜀)·NULL(brand 99)·
        brand_key=0(자사 합계 행)·비경쟁(brand 50)·10 위 밖(brand 11, 캡 없음 — measure.py:21 "LIMIT 없음")을 한 번에 덮는다."""
        conn = await asyncpg.connect(DB_URL)
        try:
            rows = await conn.fetch("""
                WITH _ig_ab AS (
                    SELECT * FROM (VALUES
                        (1::bigint, 1::int, true, 1::numeric),      -- 1위
                        (1::bigint, 2::int, true, 2::numeric),      -- 동률 2위
                        (1::bigint, 3::int, true, 2::numeric),      -- 동률 2위
                        (1::bigint, 4::int, true, 3::numeric),      -- 4위(동률 2건 건너뜀)
                        (1::bigint, 99::int, true, NULL::numeric),  -- NULL tp: 순위 없음
                        (1::bigint, 0::int, true, 0.5::numeric),    -- brand_key=0(자사 합계 행): 순위 없음
                        (1::bigint, 50::int, false, 0.4::numeric),  -- 비경쟁: 순위 없음
                        (1::bigint, 5::int, true, 4::numeric),      -- 5위(캡 밖 채움용)
                        (1::bigint, 6::int, true, 5::numeric),      -- 6위
                        (1::bigint, 7::int, true, 6::numeric),      -- 7위
                        (1::bigint, 8::int, true, 7::numeric),      -- 8위
                        (1::bigint, 9::int, true, 8::numeric),      -- 9위
                        (1::bigint, 10::int, true, 9::numeric),     -- 10위
                        (1::bigint, 11::int, true, 10::numeric)     -- 11위(10 위 캡을 넘어도 계속 매겨진다)
                    ) AS t(answer_key, brand_key, competitive, tp)
                ),
                ranked AS (
                    SELECT answer_key, brand_key, rank() OVER (PARTITION BY answer_key ORDER BY tp)::int2 AS rk
                      FROM _ig_ab WHERE competitive AND brand_key <> 0 AND tp IS NOT NULL
                )
                SELECT a.brand_key, coalesce(r.rk, 0) AS rk
                  FROM _ig_ab a LEFT JOIN ranked r ON r.answer_key = a.answer_key AND r.brand_key = a.brand_key
                 ORDER BY a.brand_key
            """)
        finally:
            await conn.close()
        by_brand = {r["brand_key"]: r["rk"] for r in rows}
        assert by_brand == {0: 0, 1: 1, 2: 2, 3: 2, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 50: 0, 99: 0}
