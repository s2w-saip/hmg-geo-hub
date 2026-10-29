#!/usr/bin/env bash
# 04-systemd/install.sh — 러너 래퍼 + systemd 유닛 설치. 멱등.
# 사용: bash 04-systemd/install.sh [--enable-timer]
#   기본은 **타이머를 켜지 않는다** — 먼저 dry-run 으로 성립을 확인하고 켠다.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./00-env.sh

IID="$(cat ./.instance-id.txt 2>/dev/null || true)"
[ -n "$IID" ] || { echo "FATAL: .instance-id.txt 없음"; exit 1; }
ENABLE_TIMER=0
[ "${1:-}" = "--enable-timer" ] && ENABLE_TIMER=1

TMP="$(mktemp -d "${TMPDIR:-/tmp}/hmg-unit.$$.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ARN·URL 을 유닛에 치환해 넣는다 (값이 아니라 포인터다 — 비밀 아님).
sed -e "s#__DB_SECRET_ARN__#${DB_SECRET_ARN}#" \
    -e "s#__CRON_SECRET_ARN__#${CRON_SECRET_ARN}#" \
    -e "s#__HMG_INTERNAL_BASE_URL__#${HMG_INTERNAL_BASE_URL}#" \
    04-systemd/hmg-summary.service > "$TMP/hmg-summary.service"

# 파일 3개를 base64 로 실어 원격 설치 스크립트를 만든다(인라인 heredoc 금지 — 룰 1).
B_SVC="$(base64 < "$TMP/hmg-summary.service" | tr -d '\n')"
B_TMR="$(base64 < 04-systemd/hmg-summary.timer | tr -d '\n')"
B_RUN="$(base64 < 04-systemd/run-generate.sh   | tr -d '\n')"

{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo 'mkdir -p /opt/hmg-runner/bin /var/lib/hmg-runner'
  echo 'chown hmgrunner:hmgrunner /var/lib/hmg-runner'
  echo "echo $B_RUN | base64 -d > /opt/hmg-runner/bin/run-generate.sh"
  echo 'chown root:root /opt/hmg-runner/bin/run-generate.sh'
  echo 'chmod 0755 /opt/hmg-runner/bin/run-generate.sh'
  echo 'bash -n /opt/hmg-runner/bin/run-generate.sh'
  echo "echo $B_SVC | base64 -d > /etc/systemd/system/hmg-summary.service"
  echo "echo $B_TMR | base64 -d > /etc/systemd/system/hmg-summary.timer"
  echo 'chmod 0644 /etc/systemd/system/hmg-summary.{service,timer}'
  echo 'systemctl daemon-reload'
  echo 'systemd-analyze verify /etc/systemd/system/hmg-summary.service || true'
  if [ "$ENABLE_TIMER" = 1 ]; then
    echo 'systemctl enable --now hmg-summary.timer'
  else
    echo 'systemctl disable --now hmg-summary.timer 2>/dev/null || true'
    echo 'echo "TIMER_NOT_ENABLED (의도된 기본값 — --enable-timer 로 켠다)"'
  fi
  echo 'systemctl list-timers hmg-summary.timer --all --no-pager || true'
  echo 'echo UNIT_INSTALL_DONE'
} > "$TMP/remote.sh"

bash ./ssm-run.sh "$IID" --file "$TMP/remote.sh"

cat <<EOF

── 검증 순서 (이 순서를 지킬 것) ──
1) dry-run (쓰기 0 — 러너 본체를 DRY_RUN=1 로 그대로 태운다):
   bash ./ssm-run.sh $IID --file 04-systemd/dryrun.sh
   기대: `표면 … 대상 회차 N개 · DRY-RUN(쓰기 없음)` 줄 + 회차별 run 수·셀 수, DRYRUN_DONE
2) 1회 수동 실행 + 로그:
   bash ./ssm-run.sh $IID 'systemctl start hmg-summary.service; journalctl -u hmg-summary -n 200 --no-pager'
3) 커넥션 ≤ 2 확인 + 회차 소요(summary_generations.timings) 확인
   — 별도 세션에서 DB 조회, 계획 문서 §5-2 의 세 쿼리
4) 상시화:
   bash 04-systemd/install.sh --enable-timer

── 롤백 ──
   bash ./ssm-run.sh $IID 'systemctl disable --now hmg-summary.timer && systemctl list-timers --all --no-pager | head'
EOF
