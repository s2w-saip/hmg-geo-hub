#!/usr/bin/env bash
# 환경 기동·정지. 사용: ENV=stg|prod bash env-power.sh stop|start|status
# stop: RDS·EC2 정지(스토리지만 과금). NAT·ALB 는 정지 개념이 없어 유휴 과금이 남는다(약 $60/월/환경).
# 주의: RDS 는 정지 7일 뒤 AWS 가 자동 기동한다 → 장기 정지는 스케줄 재정지가 필요(미구현, S10).
source "$(dirname "$0")/lib.sh"
case "${1:-status}" in
  stop)
    aws rds stop-db-instance --db-instance-identifier "$DB_ID" >/dev/null 2>&1 && echo "  RDS 정지 요청" || echo "  RDS 정지 불가(상태 확인)"
    aws ec2 stop-instances --instance-ids "$EC2_ID" >/dev/null && echo "  EC2 정지 요청" ;;
  start)
    aws rds start-db-instance --db-instance-identifier "$DB_ID" >/dev/null 2>&1 && echo "  RDS 기동 요청" || echo "  RDS 기동 불가(상태 확인)"
    aws ec2 start-instances --instance-ids "$EC2_ID" >/dev/null && echo "  EC2 기동 요청" ;;
esac
echo "[$ENV] rds=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" --query 'DBInstances[0].DBInstanceStatus' --output text) ec2=$(aws ec2 describe-instances --instance-ids "$EC2_ID" --query 'Reservations[0].Instances[0].State.Name' --output text)"
