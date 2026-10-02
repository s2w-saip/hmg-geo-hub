#!/usr/bin/env bash
# S6 CloudFront: 원본 = ALB(HTTP 80) + X-Origin-Verify 비밀 헤더, 캐시 끔(D8), 뷰어 HTTPS 리다이렉트.
# 비밀값을 담은 설정 JSON 은 _secret(700)에 쓰고 file:// 로 넘긴 뒤 즉시 지운다.
source "$(dirname "$0")/lib.sh"
umask 077
COMMENT="${NP}_cf"
SEC_DIR="$HERE/_secret"; mkdir -p "$SEC_DIR"; chmod 700 "$SEC_DIR"
CACHE_DISABLED=4135ea2d-6df8-44a3-9df3-4b5a84be39ad          # Managed-CachingDisabled
ORP_ALL_EXCEPT_HOST=b689b0a8-53d0-40ab-baf2-68738e2966ac     # Managed-AllViewerExceptHostHeader

DIST_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='${COMMENT}'].Id | [0]" --output text 2>/dev/null || true)
if [ -z "$DIST_ID" ] || [ "$DIST_ID" = "None" ]; then
  aws secretsmanager get-secret-value --secret-id "${NP}_origin-verify" --query SecretString --output text > "$SEC_DIR/ov.txt"
  python3 - "$ALB_DNS" "$SEC_DIR/ov.txt" "$SEC_DIR/cf.json" "$COMMENT" "$CACHE_DISABLED" "$ORP_ALL_EXCEPT_HOST" "$ENV" <<'PY'
import json,sys,time
alb,vf,out,comment,cp,orp,env=sys.argv[1:8]
v=open(vf).read().strip()
oid=f"HMG-GEO-HUB-{env}-alb-origin"
cfg={"CallerReference":f"HMG-GEO-HUB-{env}-cf-{int(time.time())}","Comment":comment,"Enabled":True,"PriceClass":"PriceClass_200",
 "HttpVersion":"http2and3","IsIPV6Enabled":True,
 "Origins":{"Quantity":1,"Items":[{"Id":oid,"DomainName":alb,
   "CustomOriginConfig":{"HTTPPort":80,"HTTPSPort":443,"OriginProtocolPolicy":"http-only","OriginReadTimeout":60,"OriginKeepaliveTimeout":5,
                         "OriginSslProtocols":{"Quantity":1,"Items":["TLSv1.2"]}},
   "CustomHeaders":{"Quantity":1,"Items":[{"HeaderName":"X-Origin-Verify","HeaderValue":v}]}}]},
 "DefaultCacheBehavior":{"TargetOriginId":oid,"ViewerProtocolPolicy":"redirect-to-https","Compress":True,
   "CachePolicyId":cp,"OriginRequestPolicyId":orp,
   "AllowedMethods":{"Quantity":7,"Items":["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
                     "CachedMethods":{"Quantity":2,"Items":["GET","HEAD"]}}}}
json.dump({"DistributionConfig":cfg,"Tags":{"Items":[{"Key":"Name","Value":comment},{"Key":"Project","Value":"HMG-GEO-HUB"},{"Key":"Env","Value":env}]}},open(out,"w"))
PY
  DIST_ID=$(aws cloudfront create-distribution-with-tags --distribution-config-with-tags "file://$SEC_DIR/cf.json" --query Distribution.Id --output text)
  rm -f "$SEC_DIR/ov.txt" "$SEC_DIR/cf.json"
fi
save CF_ID "$DIST_ID"
save CF_DOMAIN "$(aws cloudfront get-distribution --id "$DIST_ID" --query Distribution.DomainName --output text)"
aws cloudfront get-distribution --id "$DIST_ID" \
  --query 'Distribution.{status:Status,comment:DistributionConfig.Comment,cache:DistributionConfig.DefaultCacheBehavior.CachePolicyId,viewer:DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy,origin:DistributionConfig.Origins.Items[0].DomainName,hdr:DistributionConfig.Origins.Items[0].CustomHeaders.Items[0].HeaderName}' --output json
ls -A "$SEC_DIR" | wc -l | xargs echo "  남은 비밀 파일 수:"
echo "S6 생성 요청 완료(배포 대기는 별도)"
