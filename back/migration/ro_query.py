#!/usr/bin/env python3
"""미러(프로덕션 hmg-geo Supabase) 읽기 전용 조회. 사용: ro_query.py <sql 파일>
- 접속 URL 은 private/source-db-url.txt 에서 직접 읽는다(argv·env·출력 금지).
- autocommit + 명시 BEGIN READ ONLY … COMMIT: 트랜잭션 풀러에서도 세션 설정이 새지 않는다(set_session 금지).
- 첫 문장으로 transaction_read_only = on 을 단언하고, 아니면 즉시 중단.
"""
import sys
import psycopg2

URL_FILE = "/path/to/private/source-db-url.txt"
sql = open(sys.argv[1], encoding="utf-8").read()
stmts = [s.strip() for s in sql.split(";") if s.strip() and not s.strip().upper().startswith(("BEGIN", "COMMIT", "SHOW"))]
conn = psycopg2.connect(open(URL_FILE).read().strip(), connect_timeout=15)
conn.autocommit = True
cur = conn.cursor()
cur.execute("BEGIN READ ONLY")
cur.execute("SHOW transaction_read_only")
ro = cur.fetchone()[0]
assert ro == "on", f"read-only 아님: {ro}"
print(f"-- transaction_read_only={ro}", file=sys.stderr)
cur.execute("SET LOCAL statement_timeout = '60s'")
for s in stmts:
    cur.execute(s)
    if cur.description:
        print("\t".join(d[0] for d in cur.description))
        for row in cur.fetchall():
            print("\t".join("" if v is None else str(v) for v in row))
cur.execute("COMMIT")
conn.close()
