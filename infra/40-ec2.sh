#!/usr/bin/env bash
# S4 EC2: 프라이빗 서브넷 m7g.large(AL2023 arm64), 퍼블릭 IP 없음, IMDSv2, SSM 관리, 암호화 gp3 100GB.
source "$(dirname "$0")/lib.sh"
AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=${NP}_app" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
      --query 'Reservations[0].Instances[0].InstanceId' --output text | grep -v '^None$' || true)
if [ -z "$IID" ]; then
  IID=$(aws ec2 run-instances --image-id "$AMI" --instance-type m7g.large \
    --subnet-id "$SUBNET_PRIV_A" --security-group-ids "$SG_EC2" --no-associate-public-ip-address \
    --iam-instance-profile Name="$EC2_PROFILE" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2 \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=100,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
    --user-data "file://$HERE/userdata.sh" \
    --tag-specifications "$(tagspec instance app)" "$(tagspec volume app-root)" \
    --query 'Instances[0].InstanceId' --output text)
fi
save EC2_ID "$IID"
echo "  running 대기…"; aws ec2 wait instance-running --instance-ids "$IID"
aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].{type:InstanceType,ip:PrivateIpAddress,public:PublicIpAddress,az:Placement.AvailabilityZone,imds:MetadataOptions.HttpTokens,profile:IamInstanceProfile.Arn}' --output json
save EC2_PRIVATE_IP "$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)"
echo "  SSM 온라인 대기(최대 5분)…"
for i in $(seq 1 30); do
  S=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$IID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
  [ "$S" = "Online" ] && { echo "  SSM Online ($((i*10))s)"; break; }
  sleep 10
done
echo "S4 완료"
