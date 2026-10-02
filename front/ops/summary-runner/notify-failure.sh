#!/usr/bin/env bash
# notify-failure.sh — systemd `OnFailure=` 가 부르는 알림 전달자.
# 설치 위치: /opt/hmg-runner/bin/notify-failure.sh (root:root 0755, 실행자는 root)
#
# 사용: notify-failure.sh <실패한 유닛 이름>
#   예) notify-failure.sh hmg-summary.service
#
# ── 왜 필요한가 (2026-09-16) ─────────────────────────────────────────────────
# `hmg-summary.timer` 는 **일부러 disabled** 로 두고 있었다. README 가 그 이유를
# "타이머 enable 은 옵션 — 실패 알림 배선 뒤 상시화" 라고 적어 뒀다. 상시화의 조건이
# 이 파일이다. 타이머를 켜 놓고 실패가 조용하면, 2026-09-13 처럼 **4.5일 동안 0건**
# 이어도 아무도 모른다(그때는 타이머가 꺼져 있었고, 그것 역시 조용했다).
#
# ── 목적지 (사내 운영 규칙) ──────────────────────────────────
# 러너가 실패하면 회차가 안 만들어지고 고객 화면이 낡은 값을 낸다 = **라이브 이슈**
# → Slack(운영 알림 채널, 2026-09-25 잔디에서 전환). 사람이 코드를 고쳐야 해소되는 신호가 아니다
# (대부분은 재실행·자격증명·네트워크다). 등급은 사내 공용 알림 헬퍼 와 같은 어휘를 쓴다:
#   0=PASS(초록) · 1=주의(주황) · 2=긴급(적색). 러너 실패는 **1(주의)** 이다 —
#   한 번의 실패는 30분 뒤 타이머가 다시 시도하므로 그 자체로는 서비스가 죽지 않는다.
#   "계속 실패한다" 는 회차 사슬 감시(`/api/cron/cycle-chain-watch`)가 적체로 잡아
#   등급 2까지 올린다. 매 실패를 적색으로 내면 그 긴급이 묻힌다(룰 6).
#
# ── 시크릿 규율 (run-generate.sh 와 **같은 규율**) ──────────────────────────
#   · 웹훅 URL 은 인스턴스 롤로 Secrets Manager 에서 직독해 **셸 변수에만** 둔다.
#   · argv 금지 — curl 에 URL 을 인자로 주는 순간 `ps` 에 보인다. `--url` 도 argv 다.
#     그래서 **stdin(`--config -`)** 으로 넘긴다.
#   · `.env` 를 만들지 않고 bash `source` 도 하지 않는다.
#   · `set -x` 금지. 어떤 경로에서도 값을 echo 하지 않는다 — 지문 8자만 남긴다.
#   · **내보내는 로그를 마스킹한다**(아래 `mask`). 우리가 만든 출력만 조심해서는
#     부족하다 — 실패한 자식 프로세스의 스택트레이스가 접속 문자열을 들고 온다.
set -euo pipefail

UNIT="${1:-unknown.service}"
SECRETS_REGION=us-west-2
STATE_DIR=/var/lib/hmg-runner

# ARN 은 비밀이 아니다(포인터). 유닛 파일이 Environment= 로 넣어 준다.
# 시크릿: hmg-geo/summary-runner/slack-webhook (JSON 키 SLACK_WEBHOOK_URL).
SLACK_SECRET_ARN="${SLACK_SECRET_ARN:?SLACK_SECRET_ARN 미설정}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# 시크릿은 평문 문자열일 수도, JSON 일 수도 있다(run-generate.sh 와 같은 관용).
_read_secret() {  # $1=arn  $2=json key(선택)
  local raw
  raw="$(aws --region "$SECRETS_REGION" secretsmanager get-secret-value \
          --secret-id "$1" --query SecretString --output text)"
  if [ -n "${2:-}" ] && printf '%s' "$raw" | jq -e 'type=="object"' >/dev/null 2>&1; then
    printf '%s' "$raw" | jq -r --arg k "$2" 'if has($k) then .[$k] else (to_entries[0].value) end'
  else
    printf '%s' "$raw"
  fi
}

WEBHOOK="$(_read_secret "$SLACK_SECRET_ARN" SLACK_WEBHOOK_URL)"
if [ -z "$WEBHOOK" ]; then
  log "FATAL: Slack 웹훅이 비어 있음 — 알림 미발송(실패 사실은 journal 에만 남는다)"
  exit 1
fi
case "$WEBHOOK" in
  https://hooks.slack.com/services/*) : ;;
  # 오타로 엉뚱한 곳에 POST 하는 것을 막는다. 값은 출력하지 않는다.
  *) log "FATAL: 웹훅 형식이 Slack Incoming Webhook 이 아니다: 미발송"; exit 1 ;;
esac
log "webhook ok (sha256:$(printf '%s' "$WEBHOOK" | sha256sum | cut -c1-8))"

HOSTNAME_S="$(hostname -s 2>/dev/null || echo unknown)"
WHEN="$(date -u '+%Y-%m-%d %H:%M:%SZ')"

# ── 로그 마스킹 (필수) ──────────────────────────────────────────────────────
# ⚠️ **journal 은 무가공으로 내보내면 안 된다.** 웹훅 URL 은 argv 를 피해 stdin 으로
#    막아 놨는데, 정작 실패한 러너의 스택트레이스에 섞인 **접속 문자열**이 그대로
#    사내 채널로 나간다(2026-09-16 독립 검증 지적). run-generate.sh 가 다루는
#    값만 해도 DATABASE_URL(비번 포함)·CRON_SECRET 이고, node 는 연결 실패 시 URL 을
#    메시지에 그대로 싣는다.
#
# 자세: **화이트리스트가 아니라 "의심스러우면 가린다".** 전례가 있다 — 한 사용자명 접두만
# 커버한 정규식이 다른 사용자명을 놓쳤다(2026-07-25). 패턴을 좁게 믿지 말고 자격증명이
# 있을 법한 모양을 넓게 지운다. 과하게 가려서 잃는 것은 진단 편의뿐이고, 덜 가려서
# 잃는 것은 자격증명이다.
#
# 순서가 중요하다: URL 전체를 먼저 죽이고, 그 다음 key=value 류를 잡는다.
SQ="'"
mask() {
  sed -E \
    -e "s#[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]\"${SQ}]*@[^[:space:]\"${SQ}]*#<REDACTED-URL>#g" \
    -e "s#(postgres|postgresql|mysql|mongodb|redis|rediss|amqp)://[^[:space:]\"${SQ}]*#<REDACTED-URL>#g" \
    -e "s#(wh\.jandi\.com|hooks\.slack\.com)[^[:space:]\"${SQ}]*#<REDACTED-WEBHOOK>#g" \
    -e "s#([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii]_?[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]?)([\"${SQ}]?[[:space:]]*[:=][[:space:]]*[\"${SQ}]?)[^[:space:],;}\"${SQ}]+#\1\2<REDACTED>#g" \
    -e "s#(AKIA|ASIA)[0-9A-Z]{16}#<REDACTED-AWS-KEY>#g" \
    -e "s#(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}#<REDACTED-GH-TOKEN>#g" \
    -e "s#ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}#<REDACTED-JWT>#g" \
    -e "s#Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{8,}#Bearer <REDACTED>#g"
}

# 실패 직전 로그. journal 은 root 로 읽는다(OnFailure 유닛은 User= 를 두지 않는다).
# **반드시 mask 를 통과시킨다.** 자르기는 마스킹 **뒤에** 한다 — 먼저 자르면 잘린
# 조각이 패턴을 깨서 마스킹이 빗나간다.
TAIL="$(journalctl -u "$UNIT" -n 25 --no-pager -o cat 2>/dev/null | mask | tail -c 1200 || true)"
RESULT="$(systemctl show -p Result --value "$UNIT" 2>/dev/null || echo unknown)"
STATUS="$(systemctl show -p ExecMainStatus --value "$UNIT" 2>/dev/null || echo unknown)"

TITLE="⚠️ [러너 실패] $UNIT"
BODY="$(printf '호스트 %s · %s (UTC)\nResult=%s ExecMainStatus=%s\n\n--- journal (마지막 25줄) ---\n%s' \
        "$HOSTNAME_S" "$WHEN" "$RESULT" "$STATUS" "$TAIL")"

# Slack 페이로드 `{text, attachments:[{color,text}]}` (tools/slack-notify.sh 와 같은 형태).
# journal 은 외부 입력이다: Slack 제어문자 `& < >` 를 이스케이프한다(`<!channel>` 멘션·링크 주입 차단).
# 등급 1(주의) = 주황 #FB8C00.
PAYLOAD="$(jq -n --arg t "$TITLE" --arg b "$BODY" '
  def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
  {text: ($t | esc), attachments: [{color: "#FB8C00", text: ($b | esc)}]}')"

# URL 은 argv 가 아니라 **stdin 설정 파일**로 넘긴다 — `ps` 로 새지 않게.
# `--config -` 는 curl 이 stdin 에서 옵션을 읽게 한다.
CODE="$(printf 'url = "%s"\n' "$WEBHOOK" | curl -sS -m 15 --config - \
          -o /dev/null -w '%{http_code}' \
          -X POST \
          -H 'Content-Type: application/json' \
          --data-binary "$PAYLOAD" 2>/dev/null || true)"
unset WEBHOOK

if [ "$CODE" = "200" ]; then
  log "Slack 발송 완료 (unit=$UNIT)"
  exit 0
fi
# URL 은 절대 출력하지 않는다.
log "Slack 발송 실패 HTTP ${CODE:-none} (unit=$UNIT)"
exit 1
