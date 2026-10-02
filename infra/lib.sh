#!/usr/bin/env bash
# HMG-GEO-HUB 인프라 공용: 환경(ENV=stg|prod)·프로파일·리전·태그·상태 파일. 비밀값은 절대 출력하지 않는다.
set -euo pipefail
export AWS_PROFILE=scope
export AWS_REGION=ap-northeast-2
export AWS_PAGER=""
ENV="${ENV:-stg}"
case "$ENV" in stg) CB=40;; prod) CB=41;; *) echo "ENV 는 stg|prod" >&2; exit 2;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$HERE/state.${ENV}.env"
PREFIX="HMG-GEO-HUB"          # 공통 Project 태그
NP="${PREFIX}_${ENV}"         # Name 태그·IAM·시크릿·SG 이름: HMG-GEO-HUB_stg_*
LP="hmg-geo-hub-${ENV}"       # 소문자·하이픈만 허용되는 식별자(RDS·S3·파라미터 그룹): hmg-geo-hub-stg-*
UP="HMG-GEO-HUB-${ENV}"       # 영숫자·하이픈만 허용(ALB·대상 그룹): HMG-GEO-HUB-stg-*
touch "$STATE"
# shellcheck disable=SC1090
source "$STATE"

tags() { echo "{Key=Name,Value=${NP}_$1},{Key=Project,Value=${PREFIX}},{Key=Env,Value=${ENV}},{Key=ManagedBy,Value=aws-cli}"; }
tagspec() { echo "ResourceType=$1,Tags=[$(tags "$2")]"; }
CTAGS="Key=Project,Value=${PREFIX} Key=Env,Value=${ENV} Key=ManagedBy,Value=aws-cli"   # 공백 구분형(IAM·RDS·ELB·시크릿)

save() {
  local k="$1" v="$2"
  grep -v "^${k}=" "$STATE" > "$STATE.tmp" || true
  echo "${k}=${v}" >> "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
  export "$k=$v"
  echo "  · [$ENV] $k=$v"
}

find_by_name() {  # $1 describe 명령, $2 jmes id 경로, $3 이름(접두 제외)
  aws ec2 "$1" --filters "Name=tag:Name,Values=${NP}_$3" --query "$2" --output text 2>/dev/null | grep -v '^None$' | head -1 || true
}
