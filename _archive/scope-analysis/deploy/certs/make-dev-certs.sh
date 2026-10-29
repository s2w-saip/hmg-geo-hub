#!/usr/bin/env bash
# 개발용 mTLS 인증서 생성 — **로컬 compose `--profile mtls` 전용.**
#
# ⚠️ 라이브 자격증명은 이 스크립트로 만들지 않는다. 승인 L4 는 "측정 lane 과 같은 CA" 이고,
#    발급·보관은 Secrets Manager 와 그 절차가 소유한다(워크스페이스 룰 secrets-handling 5:
#    값은 Claude 컨텍스트·툴출력에 들어가지 않는다).
set -euo pipefail
cd "$(dirname "$0")"

SUBJ_CA="/CN=scope-analysis-dev-ca"
SUBJ_SERVER="/CN=localhost"
SUBJ_CLIENT="/CN=scope-core-dev"

openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout ca.key -out ca.crt -subj "$SUBJ_CA" 2>/dev/null

openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "$SUBJ_SERVER" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 365 -out server.crt \
  -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1") 2>/dev/null

openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr -subj "$SUBJ_CLIENT" 2>/dev/null
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 365 -out client.crt 2>/dev/null

rm -f server.csr client.csr
echo "dev certs written to $(pwd) (gitignored)"
echo "probe: curl --cacert ca.crt --cert client.crt --key client.key https://localhost:8443/healthz"
