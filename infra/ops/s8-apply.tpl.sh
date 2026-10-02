#!/bin/bash
# EC2 에서 실행: RDS 에 hmg_smoke DB 를 새로 만들고 DB-v2.1 적용 + 스모크 2종. 비밀번호는 셸 변수로만(출력 금지).
set -euo pipefail
B=__BUCKET__; SECRET_ARN='__SECRET_ARN__'; EP=__ENDPOINT__
W=/opt/hmg/s8; rm -rf "$W"; mkdir -p "$W"; cd "$W"
aws s3 cp "s3://$B/ddl/" "$W/" --recursive --quiet --region ap-northeast-2
_SEC=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --region ap-northeast-2 --query SecretString --output text)
export PGPASSWORD="$(printf '%s' "$_SEC" | jq -r .password)"; unset _SEC
export PGHOST="$EP" PGUSER=hmgadmin PGSSLMODE=require PGCONNECT_TIMEOUT=10
# core 9 D-5: 백엔드 배포(DB_TLS=verify-full)가 둔 RDS CA 번들이 있으면 libpq 도 verify-full(체인 + 호스트 이름). 없으면 현행 require
if [ -s /opt/hmg-geo-hub/certs/rds-ca-bundle.pem ]; then export PGSSLMODE=verify-full PGSSLROOTCERT=/opt/hmg-geo-hub/certs/rds-ca-bundle.pem; fi
psql -d postgres -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS hmg_smoke WITH (FORCE)" -c "CREATE DATABASE hmg_smoke"
echo "== prelude"; psql -d hmg_smoke -X -v ON_ERROR_STOP=1 -At -f rds-prelude.sql
echo "== apply DB-v2.1"
set +e
psql -d hmg_smoke -X -q -v ON_ERROR_STOP=1 -f DB-v2.1.sql > apply.txt 2>&1; RC=$?
set -e
echo "apply rc=$RC"; tail -5 apply.txt
psql -d hmg_smoke -X -At -c "select count(*) filter (where c.relkind in ('r','p')) tables, count(*) filter (where c.relkind='v') views from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('ing','rd','app','ext','mig','archive') and not c.relispartition"
if [ "$RC" = 0 ]; then
  psql -d hmg_smoke -X -f smoke.sql > smoke-rds.txt 2>&1 || true
  psql -d hmg_smoke -X -f smoke-v21.sql > smoke-v21-rds.txt 2>&1 || true
  # psql -f 는 메시지 앞에 'psql:파일:줄:' 을 붙이므로 줄머리 고정 패턴을 쓰지 않는다
  for f in smoke-rds.txt smoke-v21-rds.txt; do
    echo "$f OK=$(grep -c 'NOTICE:  OK' $f || true) FAIL=$(grep -c 'NOTICE:  FAIL' $f || true) ERROR=$(grep -c 'ERROR:' $f || true)"
    grep -E 'NOTICE:  FAIL|ERROR:' "$f" | head -8 || true
  done
  grep -E 'Execution Time' smoke-rds.txt | head -4 || true
fi
aws s3 cp "$W/" "s3://$B/results/s8/" --recursive --quiet --region ap-northeast-2 --exclude '*.sql'
unset PGPASSWORD
