#!/usr/bin/env bash
# Existing runner host only. No secret values in argv, logs, or files.
set -euo pipefail

: "${DB_SECRET_ARN:?DB_SECRET_ARN required}"
: "${CRON_SECRET_ARN:?CRON_SECRET_ARN required}"
: "${SCOPE_API_KEY_SECRET_ARN:?SCOPE_API_KEY_SECRET_ARN required}"
: "${SCOPE_API_BASE:?SCOPE_API_BASE required}"
: "${SCOPE_ROOT_PROJECT_ID:?SCOPE_ROOT_PROJECT_ID required}"
: "${HMG_INTERNAL_BASE_URL:?HMG_INTERNAL_BASE_URL required}"

exec 9>/var/lib/hmg-runner/hmg-mirror.lock
flock -n 9 || exit 0

read_secret() {
  local raw
  raw="$(aws --region "${SECRETS_REGION:-us-west-2}" secretsmanager get-secret-value \
    --secret-id "$1" --query SecretString --output text)"
  if printf '%s' "$raw" | jq -e 'type == "object"' >/dev/null 2>&1; then
    printf '%s' "$raw" | jq -er --arg key "$2" '.[$key] | select(type == "string" and length > 0)'
  else
    printf '%s' "$raw"
  fi
}

DATABASE_URL="$(read_secret "$DB_SECRET_ARN" url)"
CRON_SECRET="$(read_secret "$CRON_SECRET_ARN" CRON_SECRET)"
SCOPE_API_KEY="$(read_secret "$SCOPE_API_KEY_SECRET_ARN" SCOPE_API_KEY)"
# Preserve the runner's session-pool rule; never use the app's transaction pool.
case "$DATABASE_URL" in
  *:5432/*) ;;
  *) echo 'Mirror runner requires the session DB endpoint on port 5432' >&2; exit 2 ;;
esac
export DATABASE_URL CRON_SECRET SCOPE_API_KEY SCOPE_API_BASE SCOPE_ROOT_PROJECT_ID HMG_INTERNAL_BASE_URL
export SCOPE_MODE=live DB_POOL_MAX=2 NODE_ENV=production
export NODE_OPTIONS=--max-old-space-size=2048
cd "${MIRROR_APP_ROOT:-/opt/hmg-runner/current}"
exec ./node_modules/.bin/tsx --tsconfig scripts/summary/tsconfig.json \
  scripts/scope/mirror-worker.ts --watch --discover --budget-ms=180000
