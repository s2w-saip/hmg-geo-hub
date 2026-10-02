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

# 실패 알림 유닛(2026-09-16). ARN 이 없으면 **설치를 중단한다** — 유닛에
# `OnFailure=` 만 걸어 두고 알림 유닛이 없으면 systemd 가 조용히 넘어가고,
# 그러면 "배선했다고 믿는 미배선" 이 된다(alert-routing 룰 4가 금지하는 상태).
: "${SLACK_SECRET_ARN:?SLACK_SECRET_ARN 미설정: Slack 웹훅 시크릿(hmg-geo/summary-runner/slack-webhook)의 ARN 을 00-env.sh 에 등록하고 러너 롤에 GetSecretValue 를 허용할 것}"
sed -e "s#__SLACK_SECRET_ARN__#${SLACK_SECRET_ARN}#" \
    04-systemd/hmg-runner-failure@.service > "$TMP/hmg-runner-failure@.service"

# 파일 5개를 base64 로 실어 원격 설치 스크립트를 만든다(인라인 heredoc 금지 — 룰 1).
B_SVC="$(base64 < "$TMP/hmg-summary.service" | tr -d '\n')"
B_TMR="$(base64 < 04-systemd/hmg-summary.timer | tr -d '\n')"
B_RUN="$(base64 < 04-systemd/run-generate.sh   | tr -d '\n')"
B_FSV="$(base64 < "$TMP/hmg-runner-failure@.service" | tr -d '\n')"
B_FNO="$(base64 < 04-systemd/notify-failure.sh | tr -d '\n')"

{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  echo 'mkdir -p /opt/hmg-runner/bin /var/lib/hmg-runner'
  echo 'chown hmgrunner:hmgrunner /var/lib/hmg-runner'
  echo "echo $B_RUN | base64 -d > /opt/hmg-runner/bin/run-generate.sh"
  echo 'chown root:root /opt/hmg-runner/bin/run-generate.sh'
  echo 'chmod 0755 /opt/hmg-runner/bin/run-generate.sh'
  echo 'bash -n /opt/hmg-runner/bin/run-generate.sh'
  echo "echo $B_FNO | base64 -d > /opt/hmg-runner/bin/notify-failure.sh"
  echo 'chown root:root /opt/hmg-runner/bin/notify-failure.sh'
  echo 'chmod 0755 /opt/hmg-runner/bin/notify-failure.sh'
  echo 'bash -n /opt/hmg-runner/bin/notify-failure.sh'
  echo "echo $B_SVC | base64 -d > /etc/systemd/system/hmg-summary.service"
  echo "echo $B_TMR | base64 -d > /etc/systemd/system/hmg-summary.timer"
  echo "echo $B_FSV | base64 -d > /etc/systemd/system/hmg-runner-failure@.service"
  echo 'chmod 0644 /etc/systemd/system/hmg-summary.{service,timer}'
  echo 'chmod 0644 /etc/systemd/system/hmg-runner-failure@.service'
  echo 'systemctl daemon-reload'
  echo 'systemd-analyze verify /etc/systemd/system/hmg-summary.service || true'
  echo 'systemd-analyze verify /etc/systemd/system/hmg-runner-failure@.service || true'
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
4) **실패 알림 도달 실증** (상시화의 선결 조건 — 실증 못 하면 배선 안 한 것으로 친다):
   bash ./ssm-run.sh $IID 'systemctl start hmg-runner-failure@hmg-summary.service.service; journalctl -u hmg-runner-failure -n 30 --no-pager'
   기대: Slack 운영 알림 채널 채널에 `[러너 실패] hmg-summary.service` 메시지 도착 + journal 에 `Slack 발송 완료`
5) 상시화:
   bash 04-systemd/install.sh --enable-timer

── 롤백 ──
   bash ./ssm-run.sh $IID 'systemctl disable --now hmg-summary.timer && systemctl list-timers --all --no-pager | head'
EOF
