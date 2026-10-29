#!/usr/bin/env bash
# Internal VM (taeho-dev) with Docker and no sudo, after back/hub_storage/manage.py init (Docker mode):
#   bff         the BFF on 127.0.0.1:18091 only (Next on the VM reads it there): Gold plus the HUB stores,
#               which the HUB login needs (every page asks for it since 2026-10-28)
#   ext         the external API on hgh-ext-network, no host port, its ext-only DB connection
#   proxy       TLS on $HGH_VM_IP:$HGH_EXT_PORT for the internal network (infra/vm/ext-proxy/ext.conf); 8087
#               because the network between the office and the VM passes 80xx ports (8443 and 9443 time out)
#   sync        cron, hourly: the Gold catalog import (refused reads are recorded and retried next run)
#   check-sync  cron: WARN when the last successful import is older than HGH_SYNC_STALE_HOURS (3)
#   ga4         the GA4 collector (back/analytics/ga4_collect.py) once, by hand: its arguments pass through
#               (--dry-run, --backfill 180, --from/--to, --property). It runs in a throwaway container of the BFF
#               image on the host network (the HUB data DB on 127.0.0.1, GA4 on the internet); the secrets travel in
#               env files only. Needs .env.ga4.local (GA4 credentials); the properties are the HUB data DB's registry,
#               kept on the renewal Admin › GA4 연동 screen (analytics.ga4_registry).
#   ga4-cron    cron, daily: `ga4` with its defaults (the last 3 days again). The production and dev builds share
#               the one HUB data DB, so this one schedule serves both; a run by hand only replaces the same days.
# sync, check-sync and ga4-cron append one line each to .local/vm-cron.log.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
host_ip="${HGH_VM_IP:-10.0.20.132}"
ext_port="${HGH_EXT_PORT:-8087}"
ext_net=hgh-ext-network
proxy_ip=172.30.0.10   # the one address the external API trusts for X-Forwarded-For
ext_ip=172.30.0.11     # fixed, so the proxy's resolved upstream survives an ext restart
logs=(--log-opt max-size=10m --log-opt max-file=5)
log() { mkdir -p .local; echo "$(date -u +%FT%TZ) $*" >>.local/vm-cron.log; }
replace() { docker rm -f "$1" >/dev/null 2>&1 || true; }
ga4_run() {
    for f in .env.analytics-ingest.local .env.ga4.local; do
        [ -f "$f" ] || { echo "$f is missing (back/analytics/README.md, GA4 수집기)" >&2; return 1; }
    done
    if grep -q '^GA4_SERVICE_ACCOUNT_FILE=' .env.ga4.local; then
        echo 'a service account key needs google-auth, which the BFF image does not have: use the OAuth refresh token' >&2; return 1
    fi
    docker image inspect hgh-gold-api:local >/dev/null 2>&1 || { echo 'hgh-gold-api:local is missing: run vm.sh bff first' >&2; return 1; }
    docker run --rm --network host --env-file .env.analytics-ingest.local --env-file .env.ga4.local \
        -v "$repo/back/analytics/ga4_collect.py:/collector/ga4_collect.py:ro" \
        hgh-gold-api:local python -X utf8 /collector/ga4_collect.py "$@"
}

case "${1:-}" in
bff)
    # Without the HUB env files the BFF reads Gold only and answers the login with 503, so no page opens.
    hub_env=()
    for f in .env.analytics.local .env.operations.local .env.hub-edit.local; do
        [ -f "$f" ] || { echo "$f is missing: run back/hub_storage/manage.py init first" >&2; exit 1; }
        hub_env+=(--env-file "$f")
    done
    docker build -q -t hgh-gold-api:local back/bff >/dev/null
    replace hgh-gold-api
    docker run -d --name hgh-gold-api --restart unless-stopped "${logs[@]}" --env-file .env.gold.local \
        "${hub_env[@]}" -p 127.0.0.1:18091:8000 hgh-gold-api:local >/dev/null
    # The HUB reads and the login reach both stores here; manage.py also runs the Gold import in this container.
    docker network connect hgh-analytics-network hgh-gold-api
    docker network connect hgh-operations-network hgh-gold-api
    for _ in $(seq 60); do
        case "$(curl -fs --max-time 2 http://127.0.0.1:18091/healthz || true)" in
            *'"database":"gold"'*'"read_only":"on"'*'"analytics":{"ok":true'*'"operations":{"ok":true'*)
                echo 'BFF ready on 127.0.0.1:18091'; exit 0 ;;
        esac
        sleep 0.5
    done
    echo 'BFF health check failed: docker logs hgh-gold-api' >&2; exit 1 ;;
ext)
    docker network inspect "$ext_net" >/dev/null 2>&1 || docker network create --subnet 172.30.0.0/24 "$ext_net" >/dev/null
    docker build -q -t hgh-ext-api:local back/ext >/dev/null
    replace hgh-ext-api
    docker run -d --name hgh-ext-api --restart unless-stopped "${logs[@]}" --env-file .env.ext-api.local \
        -e FORWARDED_ALLOW_IPS="$proxy_ip" --network "$ext_net" --ip "$ext_ip" hgh-ext-api:local >/dev/null
    docker network connect hgh-analytics-network hgh-ext-api
    echo 'External API started on hgh-ext-network' ;;
proxy)
    tls=.local/ext-tls
    if [ ! -f "$tls/ext.key" ]; then
        mkdir -p "$tls" && chmod 700 "$tls"
        openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 -subj "/CN=$host_ip" \
            -addext "subjectAltName=IP:$host_ip" -keyout "$tls/ext.key" -out "$tls/ext.crt" 2>/dev/null
        chmod 600 "$tls/ext.key"
    fi
    replace hgh-ext-proxy
    docker run -d --name hgh-ext-proxy --restart unless-stopped "${logs[@]}" --network "$ext_net" --ip "$proxy_ip" \
        -v "$repo/infra/vm/ext-proxy:/etc/nginx/conf.d:ro" -v "$repo/$tls:/etc/nginx/tls:ro" \
        -p "$host_ip:$ext_port:8443" nginx:1.27-alpine >/dev/null
    echo "Proxy on https://$host_ip:$ext_port/ext/ (certificate $tls/ext.crt)" ;;
sync)
    exec 9>.local/vm-sync.lock
    flock -n 9 || { log 'sync skipped: the previous run is still going'; exit 0; }
    if out="$(python3 -X utf8 back/hub_storage/manage.py sync-gold-catalog 2>&1)"; then
        log "sync ok $(printf '%s' "$out" | tail -1 | python3 -c 'import json,sys; d=json.load(sys.stdin)
print(" ".join(f"{k}={d[k]}" for k in ("projects","prompts","new_project_versions","new_prompt_versions",
      "new_reference_sets","removed_projects","removed_prompts")))')"
    else
        log "sync FAILED $(printf '%s' "$out" | tail -1 | cut -c1-400)"; exit 1
    fi ;;
check-sync)
    hours="$(docker exec hgh-analytics-db psql -X -A -t -U hmg_analytics_reader -d hmg_analytics -c \
        "SELECT coalesce(round(extract(epoch FROM now()-max(finished_at))/3600,1)::text,'never')
         FROM catalog.sync_run WHERE result='ok'")"
    limit="${HGH_SYNC_STALE_HOURS:-3}"
    if [ "$hours" = never ] || python3 -c "import sys; sys.exit(not float('$hours') > $limit)"; then
        log "check-sync WARN last successful import: $hours h ago (limit $limit h)"; exit 1
    fi
    log "check-sync ok last successful import $hours h ago" ;;
ga4)
    shift
    ga4_run "$@" ;;
ga4-cron)
    exec 9>.local/vm-ga4.lock
    flock -n 9 || { log 'ga4 skipped: the previous run is still going'; exit 0; }
    if out="$(ga4_run 2>&1)"; then state=ok; else state=FAILED; fi
    # one line: every property's state, its days and rows, GA4's notes (thresholded · other_row) and errors
    line="$(printf '%s' "$out" | python3 -c 'import json,sys
t=sys.stdin.read(); d=json.loads(t[t.index("{"):])
print(" ".join(p["property"]+"/"+p["country"]+"="+p["status"]+(" "+p["from"]+".."+p["to"]+" rows="+str(p["rows"]) if "rows" in p else "")
      +("" if not p.get("notes") else " notes="+",".join(p["notes"]))+(" error="+p["error"][:120] if p.get("error") else "") for p in d["properties"]))' 2>/dev/null)" \
        || line="$(printf '%s' "$out" | tail -1 | cut -c1-400)"
    log "ga4 $state $line"
    [ "$state" = ok ] ;;
*)
    echo "usage: $0 bff|ext|proxy|sync|check-sync|ga4|ga4-cron" >&2; exit 2 ;;
esac
