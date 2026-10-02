#!/usr/bin/env bash
# RDS available + CloudFront Deployed 까지 대기(최대 40분). 백그라운드 실행용.
source "$(dirname "$0")/lib.sh"
for i in $(seq 1 240); do
  R=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null)
  C=$(aws cloudfront get-distribution --id "$CF_ID" --query Distribution.Status --output text 2>/dev/null)
  echo "$(date +%H:%M:%S) rds=$R cf=$C"
  [ "$R" = "available" ] && [ "$C" = "Deployed" ] && { echo READY; exit 0; }
  sleep 10
done
echo TIMEOUT; exit 1
