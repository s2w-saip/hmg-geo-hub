#!/usr/bin/env bash
# 한 환경을 처음부터 끝까지 올린다(재실행 안전). 사용: ENV=stg|prod bash up.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${ENV:?ENV=stg|prod}"
echo "== up $ENV $(date +%T)"
for s in 10-network.sh 20-iam-s3.sh 30-rds.sh 40-ec2.sh 50-alb.sh 60-cloudfront.sh; do
  echo "---- $s"; ENV="$ENV" bash "$s"
done
ENV="$ENV" bash wait-ready.sh | tail -2
EP=$(ENV="$ENV" bash -c 'source ./lib.sh; aws rds describe-db-instances --db-instance-identifier "$DB_ID" --query "DBInstances[0].Endpoint.Address" --output text')
ENV="$ENV" bash -c "source ./lib.sh; save DB_ENDPOINT '$EP'"
echo "UP_DONE $ENV $(date +%T)"
