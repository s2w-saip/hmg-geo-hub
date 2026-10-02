#!/usr/bin/env bash
# S3 RDS: 서브넷 그룹·파라미터 그룹·PostgreSQL 17 인스턴스(비공개·암호화·관리형 비밀번호). 생성만 하고 대기는 40-wait-rds.sh.
# RDS 식별자는 밑줄·대문자 불가 → 식별자 hmg-geo-hub-*, Name 태그 HMG-GEO-HUB_* 로 구분.
source "$(dirname "$0")/lib.sh"
DBID=${LP}-rds
SNG=${LP}-db-subnets
PG=${LP}-pg17
VER=17.11
RTAGS="$CTAGS"; DB_CLASS="${DB_CLASS:-db.r7g.xlarge}"

echo "▶ DB 서브넷 그룹"
if ! aws rds describe-db-subnet-groups --db-subnet-group-name "$SNG" >/dev/null 2>&1; then
  aws rds create-db-subnet-group --db-subnet-group-name "$SNG" --db-subnet-group-description "HMG-GEO-HUB ${ENV} private subnets" \
    --subnet-ids "$SUBNET_PRIV_A" "$SUBNET_PRIV_C" --tags Key=Name,Value="${NP}_db-subnets" $RTAGS >/dev/null
fi
save DB_SUBNET_GROUP "$SNG"

echo "▶ 파라미터 그룹(테스트 계측용)"
if ! aws rds describe-db-parameter-groups --db-parameter-group-name "$PG" >/dev/null 2>&1; then
  aws rds create-db-parameter-group --db-parameter-group-name "$PG" --db-parameter-group-family postgres17 \
    --description "HMG-GEO-HUB ${ENV} PG17" --tags Key=Name,Value="${NP}_pg17-params" $RTAGS >/dev/null
fi
# work_mem 64MB(설계 기본), SSD 비용 계수, I/O 계측, 1초 넘는 문장 로그, 자동 EXPLAIN 없음
aws rds modify-db-parameter-group --db-parameter-group-name "$PG" --parameters \
  "ParameterName=work_mem,ParameterValue=65536,ApplyMethod=immediate" \
  "ParameterName=random_page_cost,ParameterValue=1.1,ApplyMethod=immediate" \
  "ParameterName=effective_io_concurrency,ParameterValue=200,ApplyMethod=immediate" \
  "ParameterName=track_io_timing,ParameterValue=1,ApplyMethod=immediate" \
  "ParameterName=log_min_duration_statement,ParameterValue=1000,ApplyMethod=immediate" \
  "ParameterName=pg_stat_statements.track,ParameterValue=all,ApplyMethod=immediate" >/dev/null
save DB_PARAM_GROUP "$PG"

echo "▶ RDS 인스턴스 $DBID"
if ! aws rds describe-db-instances --db-instance-identifier "$DBID" >/dev/null 2>&1; then
  aws rds create-db-instance --db-instance-identifier "$DBID" \
    --engine postgres --engine-version "$VER" --db-instance-class "$DB_CLASS" \
    --allocated-storage 400 --storage-type gp3 --storage-encrypted \
    --master-username hmgadmin --manage-master-user-password \
    --db-name hmg --port 5432 \
    --db-subnet-group-name "$SNG" --vpc-security-group-ids "$SG_RDS" --no-publicly-accessible \
    --availability-zone ap-northeast-2a --no-multi-az \
    --db-parameter-group-name "$PG" \
    --backup-retention-period 1 --copy-tags-to-snapshot \
    --enable-performance-insights --performance-insights-retention-period 7 \
    --deletion-protection --no-auto-minor-version-upgrade \
    --tags Key=Name,Value="${NP}_rds" $RTAGS >/dev/null
fi
save DB_ID "$DBID"
aws rds describe-db-instances --db-instance-identifier "$DBID" \
  --query 'DBInstances[0].{status:DBInstanceStatus,class:DBInstanceClass,ver:EngineVersion,storage:[AllocatedStorage,StorageType,Iops,StorageThroughput],enc:StorageEncrypted,public:PubliclyAccessible,az:AvailabilityZone,secret:MasterUserSecret.SecretStatus}' --output json
SECRET_ARN=$(aws rds describe-db-instances --db-instance-identifier "$DBID" --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
save DB_SECRET_ARN "$SECRET_ARN"

echo "▶ EC2 롤에 이 시크릿 1개만 읽기 권한"
POL=$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"],"Resource":"${SECRET_ARN}"}]}
JSON
)
aws iam put-role-policy --role-name "$EC2_ROLE" --policy-name "${NP}_rds-master-secret-read" --policy-document "$POL"
aws iam list-role-policies --role-name "$EC2_ROLE" --query 'PolicyNames' --output text
echo "S3 생성 요청 완료(가용 대기는 별도)"
