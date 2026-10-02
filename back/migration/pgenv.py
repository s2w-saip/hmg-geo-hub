#!/usr/bin/env python3
"""private/source-db-url.txt 를 PG* 환경 변수로 풀어 libpq 도구(pg_dump 등)를 실행한다. URL·비밀번호를 argv·출력에 싣지 않는다.
사용: pgenv.py <도구> [인자…]   예) pgenv.py pg_dump --version
세션은 default_transaction_read_only=on 으로 시작(PGOPTIONS; 풀러가 무시할 수 있으므로 pg_dump 는 자체적으로 읽기 전용 트랜잭션을 쓴다).
"""
import os
import sys
from urllib.parse import urlparse, unquote

u = urlparse(open("/path/to/private/source-db-url.txt").read().strip())
env = dict(os.environ)
env.update({"PGHOST": u.hostname or "", "PGPORT": str(u.port or 5432), "PGUSER": unquote(u.username or ""),
            "PGPASSWORD": unquote(u.password or ""), "PGDATABASE": (u.path or "/postgres").lstrip("/") or "postgres",
            "PGSSLMODE": "require", "PGOPTIONS": "-c default_transaction_read_only=on"})
tool = sys.argv[1]
path = tool if "/" in tool else f"/opt/homebrew/opt/libpq/bin/{tool}"
os.execve(path, [path] + sys.argv[2:], env)
