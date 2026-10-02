"""analytics.citations.targets 읽기 SQL. 기능 고유 SQL 은 없다.

M06·M07 값과 발행값 출처(합산에 들어간 발행물 slug·라이브 사유)는 전부 core.measure.url_rates 가 낸다(core 5라운드: 헤드라인 풀 규칙·
웹사이트 발행물 한정·출처 반환이 core 로 이관돼 기능 쪽 거울 조회 report_provenance_sql 을 지웠다).
"""
