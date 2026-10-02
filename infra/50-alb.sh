#!/usr/bin/env bash
# S5 ALB: 인터넷 대면 ALB(인바운드는 SG 로 CloudFront 원본 접두사만) → 대상 그룹 EC2:8000.
# 리스너 기본 동작 403, X-Origin-Verify 헤더가 비밀값과 같을 때만 전달. 비밀값은 argv·출력에 싣지 않는다(파일 → --cli-input-json, 즉시 삭제).
source "$(dirname "$0")/lib.sh"
umask 077
ALB_NAME=${UP}-alb; TG_NAME=${UP}-tg      # ALB·TG 이름은 영숫자·하이픈만 → Name 태그로 접두 구분
SECRET_NAME="${NP}_origin-verify"
SEC_DIR="$HERE/_secret"; mkdir -p "$SEC_DIR"; chmod 700 "$SEC_DIR"

echo "▶ 원본 검증 비밀값(Secrets Manager)"
if ! aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  python3 -c 'import secrets;print(secrets.token_urlsafe(32),end="")' > "$SEC_DIR/ov.txt"
  aws secretsmanager create-secret --name "$SECRET_NAME" --description "CloudFront->ALB origin verify header" \
    --secret-string "file://$SEC_DIR/ov.txt" --tags Key=Name,Value="$SECRET_NAME" $CTAGS >/dev/null
  rm -f "$SEC_DIR/ov.txt"
fi
save ORIGIN_SECRET_ARN "$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text)"

echo "▶ 대상 그룹"
TG_ARN=$(aws elbv2 describe-target-groups --names "$TG_NAME" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN=$(aws elbv2 create-target-group --name "$TG_NAME" --protocol HTTP --port 8000 --vpc-id "$VPC_ID" --target-type instance \
    --health-check-protocol HTTP --health-check-path /healthz --health-check-interval-seconds 15 --healthy-threshold-count 2 \
    --tags Key=Name,Value="${NP}_tg" $CTAGS --query 'TargetGroups[0].TargetGroupArn' --output text)
fi
aws elbv2 register-targets --target-group-arn "$TG_ARN" --targets Id="$EC2_ID",Port=8000
save TG_ARN "$TG_ARN"

echo "▶ ALB"
ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  ALB_ARN=$(aws elbv2 create-load-balancer --name "$ALB_NAME" --type application --scheme internet-facing --ip-address-type ipv4 \
    --subnets "$SUBNET_PUB_A" "$SUBNET_PUB_C" --security-groups "$SG_ALB" \
    --tags Key=Name,Value="${NP}_alb" $CTAGS --query 'LoadBalancers[0].LoadBalancerArn' --output text)
fi
save ALB_ARN "$ALB_ARN"
save ALB_DNS "$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].DNSName' --output text)"
aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$ALB_ARN" --attributes \
  Key=routing.http.drop_invalid_header_fields.enabled,Value=true Key=idle_timeout.timeout_seconds,Value=60 >/dev/null

echo "▶ 리스너 80(기본 403)"
LSN_ARN=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query 'Listeners[?Port==`80`].ListenerArn | [0]' --output text)
if [ -z "$LSN_ARN" ] || [ "$LSN_ARN" = "None" ]; then
  LSN_ARN=$(aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
    --default-actions 'Type=fixed-response,FixedResponseConfig={StatusCode=403,ContentType=text/plain,MessageBody=forbidden}' \
    --query 'Listeners[0].ListenerArn' --output text)
fi
save LISTENER_ARN "$LSN_ARN"

echo "▶ 헤더 일치 규칙(우선순위 10)"
NRULES=$(aws elbv2 describe-rules --listener-arn "$LSN_ARN" --query 'length(Rules[?Priority==`10`])' --output text)
if [ "$NRULES" = "0" ]; then
  aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --query SecretString --output text > "$SEC_DIR/ov.txt"
  python3 - "$LSN_ARN" "$TG_ARN" "$SEC_DIR/ov.txt" "$SEC_DIR/rule.json" "${NP}_origin-verify-rule" <<'PY'
import json,sys
lsn,tg,vf,out=sys.argv[1:5]
v=open(vf).read().strip()
json.dump({"ListenerArn":lsn,"Priority":10,
  "Conditions":[{"Field":"http-header","HttpHeaderConfig":{"HttpHeaderName":"X-Origin-Verify","Values":[v]}}],
  "Actions":[{"Type":"forward","TargetGroupArn":tg}],
  "Tags":[{"Key":"Name","Value":sys.argv[5]}]}, open(out,"w"))
PY
  aws elbv2 create-rule --cli-input-json "file://$SEC_DIR/rule.json" >/dev/null
  rm -f "$SEC_DIR/ov.txt" "$SEC_DIR/rule.json"
fi
aws elbv2 describe-rules --listener-arn "$LSN_ARN" --query 'Rules[].{p:Priority,cond:Conditions[0].Field,hdr:Conditions[0].HttpHeaderConfig.HttpHeaderName,act:Actions[0].Type}' --output text
echo "  ALB 활성 대기…"; aws elbv2 wait load-balancer-available --load-balancer-arns "$ALB_ARN"
aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --query 'TargetHealthDescriptions[].TargetHealth.State' --output text
ls -A "$SEC_DIR" | wc -l | xargs echo "  남은 비밀 파일 수:"
echo "S5 완료"
