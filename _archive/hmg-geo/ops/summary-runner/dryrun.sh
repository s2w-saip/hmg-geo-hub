#!/usr/bin/env bash
# dryrun.sh — 원격 성립 확인. **쓰기 0.** ssm-run.sh --file 로 보낸다.
#   bash ssm-run.sh <iid> --file 04-systemd/dryrun.sh
#
# 6단계에서 러너 본체를 `DRY_RUN=1` 로 그대로 태운다 — 시크릿 직독·5432 포트 가드·flock·
# env 전달까지 운영과 **같은 코드 경로**를 지난다. dry-run 전용 사본을 두지 않는 이유는
# 사본이 곧 갈라지기 때문이다(생성기 자체가 그 이유로 이번 PR 에서 코어로 합쳐졌다).
set -uo pipefail   # -e 의도적 제외: 프로브 한 줄이 실패해도 나머지를 계속 수집한다

APP=/opt/hmg-runner/current
STATE=/var/lib/hmg-runner
SECRETS_REGION=us-west-2
BASE_URL="${HMG_INTERNAL_BASE_URL:-https://www.hmg-ggmd.com}"

echo "== 1. 툴체인 =="
node -v; npm -v; echo "arch=$(uname -m)"; ( . /etc/os-release && echo "$PRETTY_NAME" )
echo "mem: $(free -m | awk '/^Mem:/{print $2" MiB total, "$7" MiB avail"}')  swap: $(free -m | awk '/^Swap:/{print $2" MiB"}')"
df -h / | tail -1

echo "== 2. 릴리스 =="
readlink -f "$APP"; ls -1 /opt/hmg-runner/releases 2>/dev/null
[ -d "$APP/node_modules" ] && du -sh "$APP/node_modules" || echo "node_modules 없음"
sudo -u hmgrunner env HOME=$STATE bash -lc "cd $APP && npx tsx --version" 2>&1 | tail -2
# T9 가 tsx 를 devDependencies 에 명시했다 — 전이 의존이 아니라 선언 의존인지 확인한다.
sudo -u hmgrunner env HOME=$STATE bash -lc "cd $APP && node -e \"console.log('tsx declared:', !!require('./package.json').devDependencies.tsx)\"" 2>&1 | tail -1
sudo -u hmgrunner env HOME=$STATE bash -lc "cd $APP && node -e \"console.log('summary:generate:', require('./package.json').scripts['summary:generate'] || 'MISSING')\"" 2>&1 | tail -1

echo "== 3. RTT — 러너 → Supabase pooler (ap-south-1) =="
H=aws-1-ap-south-1.pooler.supabase.com
getent hosts "$H" | head -3
for i in $(seq 1 10); do
  s=$(date +%s%N)
  timeout 5 bash -c "exec 3<>/dev/tcp/$H/5432" 2>/dev/null \
    && { e=$(date +%s%N); echo "  $(( (e-s)/1000000 )) ms"; } || echo "  FAIL"
done

echo "== 4. 시크릿 도달 (값 미출력 — 길이·지문만) =="
for A in "${DB_SECRET_ARN:-}" "${CRON_SECRET_ARN:-}"; do
  [ -n "$A" ] || { echo "  ARN 미주입 — ssm-run 호출 측이 prepend 하거나 유닛 env 로 들어온다"; continue; }
  V="$(aws --region $SECRETS_REGION secretsmanager get-secret-value --secret-id "$A" \
        --query SecretString --output text 2>&1)" \
    && echo "  ok len=${#V} sha256:$(printf '%s' "$V" | sha256sum | cut -c1-8)" \
    || echo "  FAIL(권한/리전 확인)"
  unset V
done

echo "== 5. revalidate 라우트 도달 (T10 배포 후 기대: GET 405 · POST 401 또는 503) =="
curl -s -o /dev/null -m 15 -w "  GET  %{http_code} (405 기대)\n" "$BASE_URL/api/internal/summary/published"
curl -s -o /dev/null -m 15 -X POST -w "  POST %{http_code} (토큰 없음 → 401, CRON_SECRET 미설정이면 503)\n" \
  "$BASE_URL/api/internal/summary/published"

echo "== 6. 생성기 dry-run (쓰기 0 — 운영과 같은 코드 경로) =="
if [ -z "${DB_SECRET_ARN:-}" ] || [ -z "${CRON_SECRET_ARN:-}" ]; then
  echo "  건너뜀: ARN 두 개가 env 에 없다. ssm-run 호출 측이 아래 두 줄을 prepend 해야 한다."
  echo "    export DB_SECRET_ARN=… ; export CRON_SECRET_ARN=…"
else
  s=$(date +%s)
  sudo --preserve-env=DB_SECRET_ARN,CRON_SECRET_ARN,HMG_INTERNAL_BASE_URL \
    -u hmgrunner env DRY_RUN=1 HOME=$STATE /opt/hmg-runner/bin/run-generate.sh 2>&1 \
    | sed -E 's#postgres(ql)?://[^ ]+#<REDACTED-URL>#g' | tail -40
  echo "  dry-run wall=$(( $(date +%s) - s ))s"
fi

echo "== 7. 유닛 상태 (타이머는 이 시점에 꺼져 있어야 한다) =="
systemctl is-enabled hmg-summary.timer 2>&1 || true
systemctl list-timers hmg-summary.timer --all --no-pager 2>&1 | head -3

echo "DRYRUN_DONE"
