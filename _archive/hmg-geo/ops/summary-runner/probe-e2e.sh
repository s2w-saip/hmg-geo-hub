#!/usr/bin/env bash
# probe-e2e.sh — 러너 경로 성립 확인(쓰기 0): 시크릿 직독(교차 리전) → DATABASE_URL env → verify-global-0831(읽기 전용).
# 값은 어디에도 출력하지 않는다(길이·sha256 앞 8자만). argv 에도 넣지 않는다(sudo --preserve-env).
# 실행: bash ../ssm-run.sh <iid> --file 04-systemd/probe-e2e.sh   (ARN 두 줄은 ssm-run 호출 측이 prepend)
set -uo pipefail
APP=/opt/hmg-runner/current; STATE=/var/lib/hmg-runner; SECRETS_REGION=us-west-2
echo "== toolchain =="; node -v; npm -v; uname -m; free -m | awk '/^Mem:/{print "mem avail "$7" MiB"}'
echo "== release =="; readlink -f "$APP"; cat "$APP/.install-mode" 2>/dev/null
echo "== secrets (instance role, cross-region) =="
for A in "${DB_SECRET_ARN:?}" "${CRON_SECRET_ARN:?}"; do
  V="$(aws --region "$SECRETS_REGION" secretsmanager get-secret-value --secret-id "$A" --query SecretString --output text 2>&1)" \
    && echo "  ok len=${#V} sha256:$(printf '%s' "$V" | sha256sum | cut -c1-8)" || echo "  FAIL: $(echo "$V" | head -c 120)"
done
echo "== revalidate route (T10 배포 후: GET 405 · POST 401/503 기대. 404 면 아직 미배포) =="
curl -s -o /dev/null -m 15 -w "  GET  %{http_code}\n" https://www.hmg-ggmd.com/api/internal/summary/published
curl -s -o /dev/null -m 15 -X POST -w "  POST %{http_code}\n" https://www.hmg-ggmd.com/api/internal/summary/published
echo "== DB read-only: verify-global-0831 via session pooler (5432) =="
DATABASE_URL="$(aws --region "$SECRETS_REGION" secretsmanager get-secret-value --secret-id "$DB_SECRET_ARN" --query SecretString --output text)"
case "$DATABASE_URL" in *:5432/*) echo "  url port=5432 (session) ok";; *) echo "  WARN url port not 5432";; esac
export DATABASE_URL HOME="$STATE" NODE_OPTIONS="--max-old-space-size=2048"
s=$(date +%s)
sudo --preserve-env=DATABASE_URL,HOME,NODE_OPTIONS -u hmgrunner bash -c "cd $APP && npm run --silent summary:verify-global-0831" 2>&1 \
  | sed -E 's#postgres(ql)?://[^ ]+#<REDACTED-URL>#g' | tail -6
echo "  verify wall=$(( $(date +%s) - s ))s"
unset DATABASE_URL
echo "PROBE_DONE"
