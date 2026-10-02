#!/usr/bin/env bash
# S2 IAM·S3: EC2 롤·인스턴스 프로파일(SSM + 번들 버킷 읽기/쓰기), 번들 버킷(비공개·암호화).
# RDS 관리형 비밀번호 시크릿 권한은 ARN 이 생기는 30-rds.sh 에서 정확한 ARN 으로 붙인다(와일드카드 금지: 같은 리전 다른 RDS 시크릿 차단).
source "$(dirname "$0")/lib.sh"
ACCT=$(aws sts get-caller-identity --query Account --output text)
ROLE="${NP}_ec2-role"; PROFILE_NAME="${NP}_ec2-profile"
BUCKET="${LP}-artifacts-${ACCT}-apne2"   # S3 이름은 소문자·밑줄 불가 → Name 태그로 접두 구분

echo "▶ 번들 버킷 $BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{Key=Name,Value=${NP}_artifacts},{Key=Project,Value=${PREFIX}},{Key=Env,Value=${ENV}},{Key=ManagedBy,Value=aws-cli}]"
save BUCKET "$BUCKET"

echo "▶ IAM 롤 $ROLE"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" \
    --description "HMG-GEO-HUB ${ENV} app/runner EC2" \
    --tags Key=Name,Value="$ROLE" $CTAGS >/dev/null
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
S3POL=$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::${BUCKET}"},
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::${BUCKET}/*"}]}
JSON
)
aws iam put-role-policy --role-name "$ROLE" --policy-name "${NP}_artifacts-rw" --policy-document "$S3POL"
save EC2_ROLE "$ROLE"

echo "▶ 인스턴스 프로파일 $PROFILE_NAME"
if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" \
    --tags Key=Name,Value="$PROFILE_NAME" $CTAGS >/dev/null
fi
HAS=$(aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" --query "InstanceProfile.Roles[?RoleName=='$ROLE'] | length(@)" --output text)
[ "$HAS" = "1" ] || aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE"
save EC2_PROFILE "$PROFILE_NAME"

echo "▶ 확인"
aws iam list-attached-role-policies --role-name "$ROLE" --query 'AttachedPolicies[].PolicyName' --output text
aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames' --output text
aws s3api get-public-access-block --bucket "$BUCKET" --query 'PublicAccessBlockConfiguration' --output text
aws s3api get-bucket-encryption --bucket "$BUCKET" --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text
echo "S2 완료"
