#!/bin/bash
# HMG-GEO-HUB EC2 부트스트랩(AL2023 arm64). 비밀값 없음.
set -euxo pipefail
dnf -y install postgresql17 python3.12 python3.12-pip jq tar gzip
mkdir -p /opt/hmg/health
echo ok > /opt/hmg/health/healthz
cat > /etc/systemd/system/hmg-health.service <<'UNIT'
[Unit]
Description=HMG-GEO-HUB placeholder health endpoint (:8000/healthz) until FastAPI app is deployed
After=network-online.target
[Service]
WorkingDirectory=/opt/hmg/health
ExecStart=/usr/bin/python3.12 -m http.server 8000 --bind 0.0.0.0
Restart=always
User=nobody
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now hmg-health.service
echo "bootstrap done $(date -u +%FT%TZ)" > /opt/hmg/bootstrap.done
