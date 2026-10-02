#!/usr/bin/env bash
# run-generate.sh — 러너 본체. systemd oneshot 이 이것만 부른다.
# 설치 위치: /opt/hmg-runner/bin/run-generate.sh (root:root 0755, 실행자는 hmgrunner)
#
# 모드 (env):
#   DRY_RUN=1  → `--dry-run`(쓰기 0). 시크릿·포트 가드·flock·env 전달까지 **운영과 같은 경로**를
#                지나므로, 별도 dry-run 사본을 두지 않는다(사본은 곧 갈라진다).
#   기본       → `--yes --revalidate` (실제 적재 + published 스왑 + Next 캐시 무효화)
#
# ⚠️ 이 스크립트는 **hmgrunner 로 실행된다**(유닛의 User=hmgrunner). sudo 를 쓰지 않는다 —
#    유닛의 NoNewPrivileges=yes 가 setuid 를 막기 때문이고, 애초에 권한 상승이 필요 없다.
#    Secrets Manager 는 인스턴스 롤(IMDS)로 읽으므로 어떤 리눅스 사용자든 읽는다.
#
# 시크릿 규율 (secrets-handling 룰 5·6, remote-ops 룰 9·10):
#   · 값은 **env 로만** 자식에 넘긴다. argv 금지 — `ps`/`/proc/<pid>/cmdline` 은 어떤
#     출력 마스킹도 지나간다(2026-08-06 scope/staging/db 노출 실증).
#   · `.env` 파일을 만들지 않는다. bash `source` 도 하지 않는다(룰 10 — 특수문자 비번이
#     syntax error 로 로그에 전문 노출된 전례 2회).
#   · set -x 금지. 어떤 경로에서도 값을 echo 하지 않는다(지문 8자만 남긴다).
set -euo pipefail

APP_ROOT=/opt/hmg-runner
STATE_DIR=/var/lib/hmg-runner
LOCK="$STATE_DIR/hmg-summary.lock"
SECRETS_REGION=us-west-2

DB_SECRET_ARN="${DB_SECRET_ARN:?DB_SECRET_ARN 미설정}"
CRON_SECRET_ARN="${CRON_SECRET_ARN:?CRON_SECRET_ARN 미설정}"
HMG_INTERNAL_BASE_URL="${HMG_INTERNAL_BASE_URL:-https://app.example.com}"
DRY_RUN="${DRY_RUN:-0}"

# 한 틱이 소화할 회차 **묶음** 수 — 행 수가 아니다(generate-cycle.ts `--max-cycles`, 2026-09-10).
#   글로벌  = anchor 1개가 묶음 1개(밀린 주가 있어도 소수) → 2
#   웹사이트 = cycle_week 1개가 묶음 1개 = **함대 95개 전부**. 1 이면 "한 틱에 함대 한 회차"
#             (설계 §7-2) 가 그대로 성립하고, 밀린 주는 틱마다 1주씩 소화한다. 예전 120 은
#             행 수 시절 값이라 지금 의미로는 "백로그 120주 전부" 가 된다.
MAX_CYCLES_GLOBAL="${MAX_CYCLES_GLOBAL:-2}"
MAX_CYCLES_WEBSITE="${MAX_CYCLES_WEBSITE:-1}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# ── 동시 실행 방지 ─────────────────────────────────────────────────────────
# systemd 는 같은 유닛의 중복 기동을 이미 막지만, 수동 실행이 타이머와 겹치는 경로가
# 남는다. 생성기는 스왑 tx 에서 `FOR SHARE` 낙관 검사를 하므로 두 개가 붙으면 한쪽이
# 통째로 실패한다 — 락으로 애초에 막는다. dry-run 도 같은 락을 쓴다(읽기라도 라이브 고객
# DB 에 부하를 겹쳐 걸지 않는다).
exec 9>"$LOCK"
flock -n 9 || { log "다른 실행이 진행 중 — 이번 틱 건너뜀(실패 아님)"; exit 0; }

# ── 시크릿 로딩 (인스턴스 롤 → Secrets Manager 직독, 교차 리전) ─────────────
# 시크릿은 "Other type of secret" 로 등록돼 평문 문자열일 수도, JSON 일 수도 있다.
# 양쪽 다 받는다. 어느 경로에서도 값을 출력하지 않는다.
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

DATABASE_URL="$(_read_secret "$DB_SECRET_ARN" url)"
CRON_SECRET="$(_read_secret "$CRON_SECRET_ARN" CRON_SECRET)"
[ -n "$DATABASE_URL" ] || { log "FATAL: DB URL 비어 있음"; exit 1; }
[ -n "$CRON_SECRET"  ] || { log "FATAL: CRON_SECRET 비어 있음"; exit 1; }
# 값이 아니라 지문만 남긴다 — 로테이션 전후 동일성 확인용.
log "secrets ok (db sha256:$(printf '%s' "$DATABASE_URL" | sha256sum | cut -c1-8) cron sha256:$(printf '%s' "$CRON_SECRET" | sha256sum | cut -c1-8))"

# 접속 규율(설계 v4.1 §7-2): 앱은 6543 transaction, 러너는 **5432 session** 을 쓴다.
# 시크릿에 5432 가 아닌 값이 들어오면 앱 풀과 섞이므로 중단한다.
case "$DATABASE_URL" in
  *:5432/*) : ;;
  *) log "FATAL: 러너 DB URL 이 5432(session) 가 아니다 — 앱 풀과 분리 원칙 위반"; exit 1 ;;
esac

# ── 릴리스 sha → HMG_GIT_SHA ───────────────────────────────────────────────
# 릴리스는 `git archive` 번들이라 `.git` 이 없다. 그대로 두면 생성기의 `git rev-parse` 가
# stderr 로 `fatal: not a git repository` 를 매 틱 뱉고 `generator_version` 이
# `…-v1+unknown` 으로 찍혀 **프로덕션 행이 어느 코드에서 나왔는지 추적할 수 없다**
# (2026-09-10 실측). 릴리스 디렉토리명(`<UTC타임스탬프>-<sha>`)의 꼬리를 떼어 넣어 준다.
RELEASE_DIR="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
RELEASE_NAME="$(basename "${RELEASE_DIR:-}")"
RELEASE_SHA="${RELEASE_NAME##*-}"
if printf '%s' "$RELEASE_SHA" | grep -Eq '^[0-9a-f]{7,40}$'; then
  export HMG_GIT_SHA="$RELEASE_SHA"
  log "release=$RELEASE_NAME → HMG_GIT_SHA=$HMG_GIT_SHA"
else
  # 여기서 죽이지 않는다 — 생성 자체는 되고, 추적성만 잃는다. 대신 눈에 띄게 남긴다.
  log "WARN: 릴리스명에서 sha 를 못 뗐다(name='$RELEASE_NAME') → generator_version 이 +unknown 으로 찍힌다"
fi

# ── 실행 ───────────────────────────────────────────────────────────────────
cd "$APP_ROOT/current"
export DATABASE_URL CRON_SECRET HMG_INTERNAL_BASE_URL
export DB_POOL_MAX=2          # 설계 §7-2: 커넥션 ≤ 2. CLI 의 `??=2` 와 같은 값을 명시한다
export NODE_ENV=production
export HOME="$STATE_DIR"
export NODE_OPTIONS="--max-old-space-size=2048"

if [ "$DRY_RUN" = "1" ]; then
  MODE_ARGS=(--dry-run)
  log "MODE=DRY-RUN (쓰기 0)"
else
  MODE_ARGS=(--yes --revalidate)
  log "MODE=APPLY (적재 + published 스왑 + revalidate)"
fi

rc=0
for SURFACE in global website; do
  case "$SURFACE" in
    global)  MAXC="$MAX_CYCLES_GLOBAL" ;;
    website) MAXC="$MAX_CYCLES_WEBSITE" ;;
  esac
  log "── surface=$SURFACE (max-cycles=$MAXC) 시작 ──"
  t0=$(date +%s)
  # 시크릿은 전부 env 다 — argv 에는 표면·모드·상한만 실린다.
  if npm run --silent summary:generate -- \
       --surface="$SURFACE" --pending "${MODE_ARGS[@]}" --max-cycles="$MAXC"; then
    log "── surface=$SURFACE 완료 ($(( $(date +%s) - t0 ))s) ──"
  else
    rc=1
    log "── surface=$SURFACE 실패 ($(( $(date +%s) - t0 ))s) — 다음 surface 로 계속 ──"
  fi
done

unset DATABASE_URL CRON_SECRET
log "종료코드 $rc"
exit "$rc"
