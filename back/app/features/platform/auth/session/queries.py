"""platform.auth.session 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

이 기능은 자체 SQL 이 없다. 세션 사용자는 core.auth.get_principal(app.user_account PK 단건, status='active'),
스코프 계산에 필요한 참조 차원(엄브렐러 브랜드·권역 → 국가)은 core.codes.load_refs 가 읽는다. 사실 표를 읽지 않는다.
"""
