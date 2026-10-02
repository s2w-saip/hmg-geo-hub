#!/bin/bash
# EC2 에서 nohup 으로 실행: RDS hmg DB 준비(롤·DB-v2.1·mig_src) → S3 스냅샷을 mig_src 로 COPY(파일 단위 완료 마커로 재개) → ANALYZE·행 수.
# 비밀번호는 셸 변수로만. 진행은 /opt/hmg/s9/load.log, 끝나면 LOAD_COMPLETE 또는 LOAD_FAILED.
set -uo pipefail
B=__BUCKET__; SECRET_ARN='__SECRET_ARN__'; EP=__ENDPOINT__
W=/opt/hmg/s9; mkdir -p "$W/snap" "$W/done"; cd "$W"
exec >> "$W/load.log" 2>&1
echo "== start $(date -u +%FT%TZ)"
_SEC=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --region ap-northeast-2 --query SecretString --output text)
export PGPASSWORD="$(printf '%s' "$_SEC" | jq -r .password)"; unset _SEC
export PGHOST="$EP" PGUSER=hmgadmin PGSSLMODE=require PGCONNECT_TIMEOUT=10
# core 9 D-5: 백엔드 배포(DB_TLS=verify-full)가 둔 RDS CA 번들이 있으면 libpq 도 verify-full(체인 + 호스트 이름). 없으면 현행 require
if [ -s /opt/hmg-geo-hub/certs/rds-ca-bundle.pem ]; then export PGSSLMODE=verify-full PGSSLROOTCERT=/opt/hmg-geo-hub/certs/rds-ca-bundle.pem; fi
aws s3 cp "s3://$B/ddl/" "$W/" --recursive --quiet --region ap-northeast-2 --exclude '*' --include 'DB-v2.1.sql' --include 'rds-prelude.sql' --include 'mig_src.sql' --include 'mig_src_frz.sql'

if ! psql -d postgres -XAtc "select 1 from pg_database where datname='hmg'" | grep -q 1; then
  psql -d postgres -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE hmg"
fi
psql -d hmg -X -q -v ON_ERROR_STOP=1 -f rds-prelude.sql >/dev/null || { echo LOAD_FAILED prelude; exit 1; }
if ! psql -d hmg -XAtc "select 1 from pg_namespace where nspname='rd'" | grep -q 1; then
  psql -d hmg -X -q -v ON_ERROR_STOP=1 -f DB-v2.1.sql > apply.txt 2>&1 || { echo LOAD_FAILED ddl; tail -5 apply.txt; exit 1; }
  echo "DB-v2.1 applied"
fi
if ! psql -d hmg -XAtc "select 1 from pg_namespace where nspname='mig_src'" | grep -q 1; then
  psql -d hmg -X -q -v ON_ERROR_STOP=1 -f mig_src.sql > migsrc.txt 2>&1 || { echo LOAD_FAILED mig_src; tail -5 migsrc.txt; exit 1; }
  echo "mig_src created"
fi
# 동결 층 이관 입력 표(결정 32, IF NOT EXISTS 멱등). snap/frz_ops_* 는 export.py --frz 산출
if [ -f mig_src_frz.sql ]; then
  psql -d hmg -X -q -v ON_ERROR_STOP=1 -f mig_src_frz.sql > migsrc_frz.txt 2>&1 || { echo LOAD_FAILED mig_src_frz; tail -5 migsrc_frz.txt; exit 1; }
fi

aws s3 sync "s3://$B/snap/" "$W/snap/" --quiet --region ap-northeast-2 --exclude '*.done' --exclude '_manifest.json'
N=0; F=0
for f in $(ls "$W"/snap/*/*.csv.gz | sort); do
  t=$(basename "$(dirname "$f")"); key="$t.$(basename "$f")"
  [ -f "$W/done/$key" ] && continue
  if gzip -dc "$f" | psql -d hmg -X -q -v ON_ERROR_STOP=1 -c "\\copy mig_src.$t FROM STDIN WITH (FORMAT csv)"; then
    touch "$W/done/$key"; N=$((N+1))
  else
    echo "COPY 실패 $key"; F=$((F+1))
  fi
done
echo "copied_files=$N failed=$F"
[ "$F" = 0 ] || { echo LOAD_FAILED copy; exit 1; }
psql -d hmg -X -q -c "ANALYZE"
psql -d hmg -XAt -F ' ' -c "select relname, n_live_tup from pg_stat_user_tables where schemaname='mig_src' order by n_live_tup desc limit 12"
psql -d hmg -XAt -c "select pg_size_pretty(pg_database_size('hmg'))"
unset PGPASSWORD
echo "LOAD_COMPLETE $(date -u +%FT%TZ)"
