#!/usr/bin/env bash
# SSM 하네스: 로컬 스크립트 파일을 EC2 에서 실행하고 결과를 출력한다. 사용: ssm.sh <script> [timeoutSec]
# 원격 경로는 실행마다 유니크(동시 실행 덮어쓰기 방지), 실행 후 삭제, rc 전파.
source "$(dirname "$0")/lib.sh"
SCRIPT="$1"; TMO="${2:-600}"
B64=$(base64 < "$SCRIPT" | tr -d '\n')
REMOTE="/tmp/_hmg_run.$$.$(date +%s).sh"
PARAMS=$(python3 - "$B64" "$REMOTE" "$TMO" <<'PY'
import json,sys
b64,remote,tmo=sys.argv[1:4]
cmd=f"echo {b64} | base64 -d > {remote} && chmod +x {remote} && bash {remote}; rc=$?; rm -f {remote}; exit $rc"
print(json.dumps({"commands":[cmd],"executionTimeout":[tmo]}))
PY
)
CID=$(aws ssm send-command --instance-ids "$EC2_ID" --document-name AWS-RunShellScript \
      --parameters "$PARAMS" --timeout-seconds 60 --query Command.CommandId --output text)
echo "CID=$CID" >&2
while :; do
  ST=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$EC2_ID" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac
  sleep 3
done
aws ssm get-command-invocation --command-id "$CID" --instance-id "$EC2_ID" --query StandardOutputContent --output text
ERR=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$EC2_ID" --query StandardErrorContent --output text)
[ -n "$ERR" ] && [ "$ERR" != "None" ] && { echo "--- stderr"; echo "$ERR" | tail -20; }
echo "STATUS=$ST"
[ "$ST" = "Success" ]
