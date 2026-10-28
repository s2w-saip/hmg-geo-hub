#!/usr/bin/env bash
# macOS/Linux counterpart of start-gold.ps1 without Docker: API on 127.0.0.1:5555, Next on 127.0.0.1:3333.
# HGH_PYTHON selects a Python 3.12 that has back/bff/requirements.txt installed (default: python3).
# The HUB data/operations stores (native mode, scripts/start-hub-storage.sh) are started and connected when they exist.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
secret="$repo/.env.gold.local"
[ -f "$secret" ] || { echo 'Create the git-ignored .env.gold.local with HGH_GOLD_DB_URL first.' >&2; exit 1; }
python="${HGH_PYTHON:-python3}"
logs="$repo/.local"
mkdir -p "$logs"
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# Native HUB stores (local PostgreSQL in .local/pg): start them after a reboot; the API reads their env files.
hub_env=()
if [ -f "$repo/.local/pg/analytics/PG_VERSION" ] && [ -f "$repo/.local/pg/operations/PG_VERSION" ]; then
    (cd "$repo" && HGH_HUB_NATIVE=1 "$python" -X utf8 back/hub_storage/manage.py start)
    for f in .env.analytics.local .env.operations.local .env.hub-edit.local; do
        [ -f "$repo/$f" ] && hub_env+=("$repo/$f")
    done
fi

# Restart only the API this script started; leave a running Next process alone.
if [ -f "$logs/api.pid" ] && kill -0 "$(cat "$logs/api.pid")" 2>/dev/null; then
    pid="$(cat "$logs/api.pid")"
    kill "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
fi
if listening 5555; then echo 'Port 5555 is in use by another process.' >&2; exit 1; fi
(
    cd "$repo/back"
    set -a; . "$secret"; for f in ${hub_env[@]+"${hub_env[@]}"}; do . "$f"; done; set +a
    nohup "$python" -m uvicorn bff.app:app --host 127.0.0.1 --port 5555 >"$logs/api.log" 2>&1 &
    echo $! >"$logs/api.pid"
)
ready=
for _ in $(seq 60); do
    health="$(curl -fs --max-time 2 http://127.0.0.1:5555/healthz || true)"
    case "$health" in *'"database":"gold"'*'"read_only":"on"'*) ready=1; break ;; esac
    sleep 0.5
done
[ -n "$ready" ] || { echo "Gold read-only health check failed. See $logs/api.log" >&2; exit 1; }

if ! listening 3333; then
    (cd "$repo/front" && HGH_LOCAL_READ_ONLY=1 HGH_API_BASE_URL=http://127.0.0.1:5555 NEXT_TELEMETRY_DISABLED=1 \
        nohup npm run dev >"$logs/front.log" 2>&1 &)
fi
echo 'Gold read-only API ready. Frontend: http://127.0.0.1:3333/ko/renewal/dashboard'
