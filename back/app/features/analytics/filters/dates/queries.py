"""analytics.filters.dates 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

이 기능은 자체 SQL 이 없다: 회차 후보(rd.cycle, R01·R03 게이트)는 core.cycles.resolve_window 가 읽고,
숨김 계열(R04)·절단·프리셋은 service.py 가 파이썬으로 계산한다(게이트 술어 이중 정의 방지).
"""
