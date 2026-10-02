#!/usr/bin/env bash
# 서울 리전 단가 조회(읽기 전용, Pricing API 는 us-east-1 엔드포인트).
set -uo pipefail
P="--profile scope --region us-east-1"
LOC="Asia Pacific (Seoul)"
rds() {
  aws $P pricing get-products --service-code AmazonRDS --output json --filters \
    Type=TERM_MATCH,Field=location,Value="$LOC" Type=TERM_MATCH,Field=instanceType,Value="$1" \
    Type=TERM_MATCH,Field=databaseEngine,Value=PostgreSQL Type=TERM_MATCH,Field=deploymentOption,Value=Single-AZ \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
for s in d["PriceList"]:
    p=json.loads(s)
    for t in p["terms"].get("OnDemand",{}).values():
        for dim in t["priceDimensions"].values():
            u=dim["pricePerUnit"].get("USD")
            if u and float(u)>0 and dim["unit"]=="Hrs": print(f"RDS {sys.argv[1]}: ${float(u):.3f}/시간 = ${float(u)*730:,.0f}/월")
' "$1" | sort -u | head -1
}
ec2() {
  aws $P pricing get-products --service-code AmazonEC2 --output json --filters \
    Type=TERM_MATCH,Field=location,Value="$LOC" Type=TERM_MATCH,Field=instanceType,Value="$1" \
    Type=TERM_MATCH,Field=operatingSystem,Value=Linux Type=TERM_MATCH,Field=tenancy,Value=Shared \
    Type=TERM_MATCH,Field=preInstalledSw,Value=NA Type=TERM_MATCH,Field=capacitystatus,Value=Used \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
for s in d["PriceList"]:
    p=json.loads(s)
    for t in p["terms"].get("OnDemand",{}).values():
        for dim in t["priceDimensions"].values():
            u=dim["pricePerUnit"].get("USD")
            if u and float(u)>0: print(f"EC2 {sys.argv[1]}: ${float(u):.4f}/시간 = ${float(u)*730:,.0f}/월")
' "$1" | sort -u | head -1
}
gp3() {
  aws $P pricing get-products --service-code AmazonRDS --output json --filters \
    Type=TERM_MATCH,Field=location,Value="$LOC" Type=TERM_MATCH,Field=volumeType,Value="General Purpose-GP3" \
    Type=TERM_MATCH,Field=deploymentOption,Value=Single-AZ \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
seen=set()
for s in d["PriceList"]:
    p=json.loads(s); a=p["product"]["attributes"]
    if "PostgreSQL" not in a.get("databaseEngine","PostgreSQL"): continue
    for t in p["terms"].get("OnDemand",{}).values():
        for dim in t["priceDimensions"].values():
            k=(a.get("usagetype"),dim["unit"],dim["pricePerUnit"].get("USD"))
            if k not in seen: seen.add(k); print("RDS gp3", k)
' | head -8
}
for i in db.r7g.xlarge db.r7g.2xlarge db.r7g.4xlarge; do rds "$i"; done
for i in t4g.medium c7g.xlarge m7g.xlarge; do ec2 "$i"; done
gp3
