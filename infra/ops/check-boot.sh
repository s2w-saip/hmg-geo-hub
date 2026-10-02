#!/bin/bash
cat /opt/hmg/bootstrap.done 2>/dev/null || echo "bootstrap 미완료"
psql --version; python3.12 --version
systemctl is-active hmg-health.service
curl -s -o /dev/null -w 'healthz=%{http_code}\n' http://127.0.0.1:8000/healthz
curl -s -o /dev/null -w 'egress(NAT)=%{http_code}\n' https://aws.amazon.com/
