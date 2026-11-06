#!/usr/bin/env bash
# macOS/Linux counterpart of start-gold.ps1 without Docker: data server on 127.0.0.1:5555, hub server on 127.0.0.1:5556, Next on 127.0.0.1:3333.
# Next calls only the hub server.
# HGH_PYTHON selects a Python 3.12 that has back/data_server/requirements.txt installed (default: python3).
# The HUB data/operations stores (native mode, scripts/start-hub-storage.sh) are started and connected when they exist,
# and the service week is checked against Gold before the API starts.
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
if [ -f "$repo/.local/pg/operations/PG_VERSION" ]; then
    (cd "$repo" && HGH_HUB_NATIVE=1 "$python" -X utf8 back/hub_storage/manage.py start)
    # The service week (catalog.service_week) before the API starts, so its Gold reads have a week to stop at. A failure
    # does not stop the API: it keeps the last recorded week, and with none recorded yet its Gold screens answer 503.
    if ! (cd "$repo" && HGH_HUB_NATIVE=1 "$python" -X utf8 back/hub_storage/manage.py sync-service-week); then
        echo 'Service week check failed (above). The API starts anyway with the last recorded week; with none recorded its Gold screens answer 503.' >&2
        echo "  Retry after manage.py init has applied 011: HGH_HUB_NATIVE=1 $python -X utf8 back/hub_storage/manage.py sync-service-week" >&2
    fi
    (cd "$repo" && HGH_HUB_NATIVE=1 "$python" -X utf8 back/hub_storage/manage.py internal-token)
    for f in .env.analytics.local .env.input.local .env.metrics.local .env.silver.local .env.internal-token.local; do
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
    nohup "$python" -m uvicorn data_server.app:app --host 127.0.0.1 --port 5555 >"$logs/api.log" 2>&1 &
    echo $! >"$logs/api.pid"
)
ready=
for _ in $(seq 60); do
    health="$(curl -fs --max-time 2 http://127.0.0.1:5555/healthz || true)"
    case "$health" in *'"database":"gold_db"'*'"read_only":"on"'*) ready=1; break ;; esac
    sleep 0.5
done
[ -n "$ready" ] || { echo "Gold read-only health check failed. See $logs/api.log" >&2; exit 1; }

# The hub server, Next's only door. Restart only the one this script started.
if [ -f "$logs/hub.pid" ] && kill -0 "$(cat "$logs/hub.pid")" 2>/dev/null; then
    pid="$(cat "$logs/hub.pid")"
    kill "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
fi
if listening 5556; then echo 'Port 5556 is in use by another process.' >&2; exit 1; fi
(
    cd "$repo/back"
    set -a; for f in .env.operations.local .env.input.local .env.hub-edit.local .env.internal-token.local; do [ -f "$repo/$f" ] && . "$repo/$f"; done; set +a
    HGH_DATA_SERVER_URL=http://127.0.0.1:5555 nohup "$python" -m uvicorn hub_server.app:app --host 127.0.0.1 --port 5556 >"$logs/hub.log" 2>&1 &
    echo $! >"$logs/hub.pid"
)
ready=
for _ in $(seq 60); do
    curl -fs --max-time 2 http://127.0.0.1:5556/healthz >/dev/null && { ready=1; break; }
    sleep 0.5
done
[ -n "$ready" ] || { echo "Hub server health check failed. See $logs/hub.log" >&2; exit 1; }

if ! listening 3333; then
    (cd "$repo/front" && HGH_LOCAL_READ_ONLY=1 HGH_API_BASE_URL=http://127.0.0.1:5556 NEXT_TELEMETRY_DISABLED=1 \
        nohup npm run dev >"$logs/front.log" 2>&1 &)
fi
# The unfiltered first screens' values: computed when the live snapshot or the definition version moved, else nothing happens. Until it
# finishes, those values are counted at query time as the last resort. In the background, so the API does not wait; see the log.
if [ ${#hub_env[@]} -gt 0 ]; then
    (cd "$repo" && HGH_HUB_NATIVE=1 nohup "$python" -X utf8 back/hub_storage/manage.py rollup >"$logs/rollup.log" 2>&1 &)
fi
echo 'Gold read-only API ready. Frontend: http://127.0.0.1:3333/ko/renewal/dashboard'
