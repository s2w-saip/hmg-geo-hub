#!/usr/bin/env bash
# 통합 DDL(DB-보정.sql)을 빈 PG17 에 적용해 실행 오류를 찾는다. 고객 데이터 없음, 포트 노출 없음.
# 사용: ddl-check.sh up | apply [sql] | down
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=hmg-ddl-check
case "${1:-}" in
  up)
    docker run -d --rm --name "$NAME" -m 1g -e POSTGRES_PASSWORD=ddlcheck -e POSTGRES_DB=hmg postgres:17 >/dev/null
    for i in $(seq 1 30); do
      docker exec "$NAME" pg_isready -U postgres -d hmg >/dev/null 2>&1 && { echo "ready ($i)"; exit 0; }
      sleep 1
    done
    echo "not ready"; exit 1 ;;
  apply)
    SQL="${2:-$HERE/DB-보정.sql}"
    # 매번 빈 DB 로 다시 만든다.
    docker exec "$NAME" psql -U postgres -d postgres -qc "DROP DATABASE IF EXISTS hmg WITH (FORCE)" -c "CREATE DATABASE hmg" 2>&1
    # 롤이 DDL 밖에 있을 수 있으므로 없으면 만든다(비번 없음, 로그인 없음).
    docker exec -i "$NAME" psql -U postgres -d hmg -v ON_ERROR_STOP=1 -q 2>&1 <<'EOF'
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['loader','loader_ro','api_ro','api_rw','admin_long','migrator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP; END $$;
EOF
    docker exec -i "$NAME" psql -U postgres -d hmg -v ON_ERROR_STOP=1 -q -f - < "$SQL" 2>&1
    echo "rc=$?" ;;
  down)
    docker stop "$NAME" >/dev/null 2>&1; docker ps -a --filter "name=$NAME" --format '{{.Names}}' | grep -c . ;;
  *) echo "usage: up|apply [sql]|down"; exit 2 ;;
esac
