#!/usr/bin/env bash
# macOS counterpart of start-hub-storage.ps1 without Docker (native mode, back/analytics/manage.py): local
# PostgreSQL servers for the HUB data (127.0.0.1:55436), operations (:55437), input (:55438) and metrics (:55439) stores under .local/pg, their
# migrations, the API restart with their connections, the Gold catalog import, the service week check (once here; it
# runs again at every start-local.sh) and the verification.
# HGH_PYTHON: the BFF Python whose environment also has postgresql (micromamba hgh-bff). Safe to re-run.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
python="${HGH_PYTHON:-python3}"
cd "$repo"
export HGH_HUB_NATIVE=1
"$python" -X utf8 back/hub_storage/manage.py init
HGH_PYTHON="$python" bash scripts/start-local.sh
"$python" -X utf8 back/hub_storage/manage.py sync-gold-catalog
"$python" -X utf8 back/hub_storage/manage.py sync-service-week
"$python" -X utf8 back/hub_storage/manage.py verify
echo 'HUB stores ready. Register the top-level administrator once:'
echo "  HGH_HUB_NATIVE=1 $python -X utf8 back/hub_storage/manage.py set-admin"
