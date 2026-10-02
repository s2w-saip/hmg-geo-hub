#!/usr/bin/env bash
# S1 네트워크: 전용 VPC·서브넷·IGW·NAT·라우트·S3 게이트웨이 엔드포인트·SG. 재실행해도 이름 태그로 기존 자원을 재사용한다.
source "$(dirname "$0")/lib.sh"
AZ_A=ap-northeast-2a; AZ_C=ap-northeast-2c

echo "▶ VPC"
VPC_ID=$(find_by_name describe-vpcs 'Vpcs[0].VpcId' vpc)
if [ -z "$VPC_ID" ]; then
  VPC_ID=$(aws ec2 create-vpc --cidr-block 10.${CB}.0.0/16 --tag-specifications "$(tagspec vpc vpc)" --query Vpc.VpcId --output text)
  aws ec2 wait vpc-available --vpc-ids "$VPC_ID"
fi
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support '{"Value":true}'
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames '{"Value":true}'
save VPC_ID "$VPC_ID"

subnet() {  # 이름 CIDR AZ
  local id; id=$(find_by_name describe-subnets 'Subnets[0].SubnetId' "$1")
  if [ -z "$id" ]; then
    id=$(aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block "$2" --availability-zone "$3" \
         --tag-specifications "$(tagspec subnet "$1")" --query Subnet.SubnetId --output text)
  fi
  echo "$id"
}
echo "▶ 서브넷"
save SUBNET_PUB_A  "$(subnet subnet-public-a  10.${CB}.0.0/24  $AZ_A)"
save SUBNET_PUB_C  "$(subnet subnet-public-c  10.${CB}.1.0/24  $AZ_C)"
save SUBNET_PRIV_A "$(subnet subnet-private-a 10.${CB}.10.0/24 $AZ_A)"
save SUBNET_PRIV_C "$(subnet subnet-private-c 10.${CB}.11.0/24 $AZ_C)"

echo "▶ 인터넷 게이트웨이"
IGW_ID=$(find_by_name describe-internet-gateways 'InternetGateways[0].InternetGatewayId' igw)
if [ -z "$IGW_ID" ]; then
  IGW_ID=$(aws ec2 create-internet-gateway --tag-specifications "$(tagspec internet-gateway igw)" --query InternetGateway.InternetGatewayId --output text)
fi
ATT=$(aws ec2 describe-internet-gateways --internet-gateway-ids "$IGW_ID" --query 'InternetGateways[0].Attachments[0].VpcId' --output text)
[ "$ATT" = "$VPC_ID" ] || aws ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"
save IGW_ID "$IGW_ID"

echo "▶ 퍼블릭 라우트 테이블"
RT_PUB=$(find_by_name describe-route-tables 'RouteTables[0].RouteTableId' rt-public)
if [ -z "$RT_PUB" ]; then
  RT_PUB=$(aws ec2 create-route-table --vpc-id "$VPC_ID" --tag-specifications "$(tagspec route-table rt-public)" --query RouteTable.RouteTableId --output text)
fi
aws ec2 create-route --route-table-id "$RT_PUB" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID" >/dev/null 2>&1 || true
for s in "$SUBNET_PUB_A" "$SUBNET_PUB_C"; do
  aws ec2 associate-route-table --route-table-id "$RT_PUB" --subnet-id "$s" >/dev/null 2>&1 || true
done
save RT_PUB "$RT_PUB"

echo "▶ NAT 게이트웨이(퍼블릭 a)"
NAT_ID=$(aws ec2 describe-nat-gateways --filter "Name=tag:Name,Values=${NP}_nat" "Name=state,Values=pending,available" \
         --query 'NatGateways[0].NatGatewayId' --output text | grep -v '^None$' || true)
if [ -z "$NAT_ID" ]; then
  EIP_ALLOC=$(aws ec2 describe-addresses --filters "Name=tag:Name,Values=${NP}_nat-eip" --query 'Addresses[0].AllocationId' --output text | grep -v '^None$' || true)
  if [ -z "$EIP_ALLOC" ]; then
    EIP_ALLOC=$(aws ec2 allocate-address --domain vpc --tag-specifications "$(tagspec elastic-ip nat-eip)" --query AllocationId --output text)
  fi
  save EIP_ALLOC "$EIP_ALLOC"
  NAT_ID=$(aws ec2 create-nat-gateway --subnet-id "$SUBNET_PUB_A" --allocation-id "$EIP_ALLOC" \
           --tag-specifications "$(tagspec natgateway nat)" --query NatGateway.NatGatewayId --output text)
fi
echo "  NAT 대기…"; aws ec2 wait nat-gateway-available --nat-gateway-ids "$NAT_ID"
save NAT_ID "$NAT_ID"

echo "▶ 프라이빗 라우트 테이블"
RT_PRIV=$(find_by_name describe-route-tables 'RouteTables[0].RouteTableId' rt-private)
if [ -z "$RT_PRIV" ]; then
  RT_PRIV=$(aws ec2 create-route-table --vpc-id "$VPC_ID" --tag-specifications "$(tagspec route-table rt-private)" --query RouteTable.RouteTableId --output text)
fi
aws ec2 create-route --route-table-id "$RT_PRIV" --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT_ID" >/dev/null 2>&1 || true
for s in "$SUBNET_PRIV_A" "$SUBNET_PRIV_C"; do
  aws ec2 associate-route-table --route-table-id "$RT_PRIV" --subnet-id "$s" >/dev/null 2>&1 || true
done
save RT_PRIV "$RT_PRIV"

echo "▶ S3 게이트웨이 엔드포인트(번들 전송이 NAT 을 안 타게)"
VPCE_S3=$(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" "Name=service-name,Values=com.amazonaws.${AWS_REGION}.s3" \
          --query 'VpcEndpoints[0].VpcEndpointId' --output text | grep -v '^None$' || true)
if [ -z "$VPCE_S3" ]; then
  VPCE_S3=$(aws ec2 create-vpc-endpoint --vpc-id "$VPC_ID" --service-name "com.amazonaws.${AWS_REGION}.s3" --vpc-endpoint-type Gateway \
            --route-table-ids "$RT_PRIV" --tag-specifications "$(tagspec vpc-endpoint vpce-s3)" --query VpcEndpoint.VpcEndpointId --output text)
fi
save VPCE_S3 "$VPCE_S3"

sg() {  # 이름 설명
  local id; id=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=${NP}_$1" \
                 --query 'SecurityGroups[0].GroupId' --output text | grep -v '^None$' || true)
  if [ -z "$id" ]; then
    id=$(aws ec2 create-security-group --vpc-id "$VPC_ID" --group-name "${NP}_$1" --description "$2" \
         --tag-specifications "$(tagspec security-group "$1")" --query GroupId --output text)
  fi
  echo "$id"
}
echo "▶ 보안 그룹"
save SG_ALB "$(sg alb-sg 'ALB: CloudFront origin-facing only')"
save SG_EC2 "$(sg ec2-sg 'EC2 app: from ALB only')"
save SG_RDS "$(sg rds-sg 'RDS: from EC2 only')"
CF_PL=$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
        --query 'PrefixLists[0].PrefixListId' --output text)
save CF_PREFIX_LIST "$CF_PL"
aws ec2 authorize-security-group-ingress --group-id "$SG_ALB" \
  --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,PrefixListIds=[{PrefixListId=$CF_PL,Description=CloudFront}]" >/dev/null 2>&1 || true
aws ec2 authorize-security-group-ingress --group-id "$SG_EC2" \
  --ip-permissions "IpProtocol=tcp,FromPort=8000,ToPort=8000,UserIdGroupPairs=[{GroupId=$SG_ALB,Description=ALB}]" >/dev/null 2>&1 || true
aws ec2 authorize-security-group-ingress --group-id "$SG_RDS" \
  --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$SG_EC2,Description=EC2}]" >/dev/null 2>&1 || true

echo "▶ 확인"
aws ec2 describe-security-groups --group-ids "$SG_ALB" "$SG_EC2" "$SG_RDS" \
  --query 'SecurityGroups[].{name:GroupName,in:IpPermissions[].{p:FromPort,pl:PrefixListIds[0].PrefixListId,sg:UserIdGroupPairs[0].GroupId}}' --output json
aws ec2 describe-route-tables --route-table-ids "$RT_PUB" "$RT_PRIV" \
  --query 'RouteTables[].{rt:RouteTableId,routes:Routes[].[DestinationCidrBlock,GatewayId,NatGatewayId],assoc:length(Associations)}' --output json
echo "S1 완료"
