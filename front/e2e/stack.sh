#!/usr/bin/env bash
# Local E2E stack for the front (design 5.1). Everything on 127.0.0.1, no external network.
#
#   bash front/e2e/stack.sh up       clone DB, start mock auth, backend, tap, next dev; wait for health
#   bash front/e2e/stack.sh status   pid, port and health per component
#   bash front/e2e/stack.sh down     stop this worktree's processes (pid files only); the DB clone stays
#
#   Playwright(chromium) -> next dev :3100 --Supabase--> mock auth :54399 (e2e/mock-auth)
#                                      --HGH_API_BASE_URL--> tap :18081 -> uvicorn :18080 --JWKS--> mock auth
#                                                                             `-- DB hgh-dev-pg :55432 / hmg_e2e_front
#
# Rules this script keeps:
#   - DB: shared container hgh-dev-pg. Only `dev-db.sh clone e2e_front` (never up/down/restart), then
#     the clone (never the template hmg_tpl) is brought forward to DB-v2.13 by back/tests/dbforward.py.
#     Accounts = back/tests/support.py ACCOUNTS_SQL, checked against e2e/accounts.json.
#   - Ports: a leftover listener is stopped only when it belongs to this worktree (its process
#     group is in our pid files, or its cwd is inside this worktree). Anything else: stop and report.
#   - Processes: nohup, own process group each (set -m), logs e2e/.run/<name>.log, pid e2e/.run/<name>.pid.
#     down kills those process groups only. No name-based kill.
#   - Environment: every process starts from an emptied environment plus what is listed here, so
#     legacy data variables (DATABASE_URL, SCOPE_*, GA4_*) are never set and a legacy path fails loudly.
#   - Secrets: QA password, QA cookie secret and the D2 relay secret are generated per `up`; only the
#     QA password is kept (e2e/.run/qa-password, 0600, the gate form needs it). None is printed.
#   - Run files live OUTSIDE front/ ($E2E_HOME, default ~/.cache/hgh-front-e2e/<worktree>-<hash>) and
#     front/e2e/.run and front/e2e/.out are symlinks to it. Reason: next dev (Tailwind source
#     detection) watches the whole front/ tree, so a trace or log line written under front/ triggers
#     a rebuild, the browser gets serverComponentChanges, router.refresh() re-renders the page, which
#     writes the trace again: an endless refresh loop observed on 2026-09-29. Writes through the
#     symlink land outside the watched tree.
#
# Overrides: E2E_BACK_VENV (python venv with uvicorn), E2E_KEEP_DB=1 (reuse hmg_e2e_front),
# E2E_FRONT_PORT / E2E_API_PORT / E2E_TAP_PORT / E2E_AUTH_PORT (defaults 3100/18080/18081/54399).
set -euo pipefail
set -m

E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONT="$(cd "$E2E/.." && pwd)"
ROOT="$(cd "$FRONT/.." && pwd)"
BACK="$ROOT/back"
E2E_HOME="${E2E_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/hgh-front-e2e/$(basename "$ROOT")-$(printf '%s' "$ROOT" | shasum | cut -c1-8)}"
RUN="$E2E_HOME/run"
OUT="$E2E_HOME/out"

FRONT_PORT="${E2E_FRONT_PORT:-3100}"
API_PORT="${E2E_API_PORT:-18080}"
TAP_PORT="${E2E_TAP_PORT:-18081}"
AUTH_PORT="${E2E_AUTH_PORT:-54399}"
PG_NAME="${DEV_PG_NAME:-hgh-dev-pg}"
DB_KEY="e2e_front"
DB_NAME="hmg_${DB_KEY}"
COMPONENTS=(front tap back auth)

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }

port_of() {
  case "$1" in
    front) echo "$FRONT_PORT" ;; tap) echo "$TAP_PORT" ;; back) echo "$API_PORT" ;; auth) echo "$AUTH_PORT" ;;
  esac
}

pid_of() { [ -f "$RUN/$1.pid" ] && cat "$RUN/$1.pid" || true; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
listener_pids() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }
proc_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
proc_name() { ps -o comm= -p "$1" 2>/dev/null | head -1; }
proc_pgid() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }

# Is pid part of a process group we started (pid file = group leader)?
ours_by_pidfile() {
  local g c
  g="$(proc_pgid "$1")"
  for c in "${COMPONENTS[@]}"; do
    [ -n "$g" ] && [ "$g" = "$(pid_of "$c")" ] && return 0
  done
  return 1
}

in_worktree() { case "$1" in "$ROOT" | "$ROOT"/*) return 0 ;; *) return 1 ;; esac; }

# Stop a leftover listener on $1 when it is ours; refuse otherwise.
free_port() {
  local port="$1" pid cwd i
  for pid in $(listener_pids "$port"); do
    cwd="$(proc_cwd "$pid")"
    if ours_by_pidfile "$pid" || in_worktree "$cwd"; then
      log "port $port: leftover listener pid $pid ($(proc_name "$pid")) from this worktree, stopping"
      kill -TERM "$pid" 2>/dev/null || true
    else
      die "port $port is held by pid $pid ($(proc_name "$pid"), cwd ${cwd:-unknown}), not this worktree. Left untouched."
    fi
  done
  for i in $(seq 1 20); do
    [ -z "$(listener_pids "$port")" ] && return 0
    sleep 0.5
  done
  for pid in $(listener_pids "$port"); do
    cwd="$(proc_cwd "$pid")"
    if ours_by_pidfile "$pid" || in_worktree "$cwd"; then kill -KILL "$pid" 2>/dev/null || true; fi
  done
  sleep 1
  [ -z "$(listener_pids "$port")" ] || die "port $port still busy after stopping our listener"
}

resolve_venv() {
  local c
  for c in "${E2E_BACK_VENV:-}" "$BACK/.venv" "$ROOT/../core/back/.venv"; do
    if [ -n "$c" ] && [ -x "$c/bin/uvicorn" ] && [ -x "$c/bin/python" ]; then
      (cd "$c" && pwd)
      return 0
    fi
  done
  return 1
}

psql_db() { docker exec -i "$PG_NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }

# Base environment for every process (see start): nothing is inherited but these.
BASE=("PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" "HOME=$HOME"
  "TMPDIR=${TMPDIR:-/tmp}" "LANG=en_US.UTF-8" "TZ=${TZ:-Asia/Seoul}")

# start <name> <dir> VAR=value ... -- command args...
# The environment is rebuilt inside the subshell with the `export` builtin (every inherited
# variable unset, then BASE and the given assignments), so values such as the QA password never
# appear in any process argv (`env -i A=b cmd` would show them in env's argv; secrets-handling rule 6).
start() {
  local name="$1" dir="$2" v a
  shift 2
  local assigns=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do assigns+=("$1"); shift; done
  [ "${1:-}" = "--" ] || die "start $name: missing -- before the command"
  shift
  : >"$RUN/$name.log"
  (
    cd "$dir" || exit 1
    for v in $(compgen -e); do unset "$v" 2>/dev/null || true; done
    for a in "${BASE[@]}" "${assigns[@]}"; do export "$a"; done
    exec nohup "$@"
  ) >>"$RUN/$name.log" 2>&1 </dev/null &
  echo "$!" >"$RUN/$name.pid"
  log "started $name pid $(pid_of "$name") (log front/e2e/.run/$name.log)"
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-5}" "$1" 2>/dev/null || true; }

wait_http() {
  local name="$1" url="$2" want="$3" secs="$4" start_s="$SECONDS" code=""
  while [ $((SECONDS - start_s)) -lt "$secs" ]; do
    code="$(http_code "$url" 60)"
    [ "$code" = "$want" ] && { log "$name healthy ($url -> $code, $((SECONDS - start_s))s)"; return 0; }
    if ! alive "$(pid_of "$name")"; then
      echo "--- last lines of e2e/.run/$name.log ---" >&2
      tail -n 40 "$RUN/$name.log" >&2 || true
      die "$name exited before becoming healthy"
    fi
    sleep 1
  done
  echo "--- last lines of e2e/.run/$name.log ---" >&2
  tail -n 40 "$RUN/$name.log" >&2 || true
  die "$name not healthy after ${secs}s ($url -> ${code:-none})"
}

stop_one() {
  local name="$1" pid i
  pid="$(pid_of "$name")"
  if alive "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for i in $(seq 1 20); do alive "$pid" || break; sleep 0.5; done
    if alive "$pid"; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi
    log "stopped $name (pgid $pid)"
  fi
  rm -f "$RUN/$name.pid"
}

cmd_down() {
  local c port pid cwd left=0
  for c in "${COMPONENTS[@]}"; do stop_one "$c"; done
  for c in "${COMPONENTS[@]}"; do
    port="$(port_of "$c")"
    for pid in $(listener_pids "$port"); do
      cwd="$(proc_cwd "$pid")"
      if in_worktree "$cwd"; then
        kill -TERM "$pid" 2>/dev/null || true
        log "port $port: stopped leftover pid $pid ($(proc_name "$pid")) from this worktree"
      else
        log "port $port: held by pid $pid ($(proc_name "$pid")) outside this worktree, left alone"
        left=1
      fi
    done
  done
  log "down. DB $DB_NAME is kept in $PG_NAME (drop: docker exec $PG_NAME psql -U postgres -c 'DROP DATABASE $DB_NAME WITH (FORCE)')"
  return "$left"
}

cmd_status() {
  local c pid port listen code url
  for c in "${COMPONENTS[@]}"; do
    pid="$(pid_of "$c")"
    port="$(port_of "$c")"
    listen="$(listener_pids "$port" | tr '\n' ' ')"
    case "$c" in
      front) url="http://127.0.0.1:$port/ko/login" ;;
      tap) url="http://127.0.0.1:$port/healthz" ;;
      back) url="http://127.0.0.1:$port/healthz" ;;
      auth) url="http://127.0.0.1:$port/__e2e/health" ;;
    esac
    code="$(http_code "$url" 10)"
    printf '%-6s pid %-7s alive %-3s port %-5s listeners [%s] health %s\n' "$c" "${pid:--}" \
      "$(alive "$pid" && echo yes || echo no)" "$port" "${listen% }" "${code:-none}"
  done
}

# front/e2e/.run and .out -> $E2E_HOME/{run,out} (see header). A real directory left by an older
# layout holds only this harness's output: it is replaced.
link_run_dirs() {
  local name target
  mkdir -p "$RUN" "$OUT"
  chmod 700 "$E2E_HOME" "$RUN"
  for name in run out; do
    target="$E2E_HOME/$name"
    if [ -L "$E2E/.$name" ]; then
      [ "$(readlink "$E2E/.$name")" = "$target" ] || ln -sfn "$target" "$E2E/.$name"
    else
      rm -rf "${E2E:?}/.$name"
      ln -s "$target" "$E2E/.$name"
    fi
  done
}

cmd_up() {
  local all_up=1 c venv db_url applied flags qa_secret qa_password relay_secret count
  link_run_dirs
  for c in "${COMPONENTS[@]}"; do alive "$(pid_of "$c")" || all_up=0; done
  if [ "$all_up" = 1 ]; then
    log "already up (use down first to restart)"
    cmd_status
    return 0
  fi
  for c in "${COMPONENTS[@]}"; do stop_one "$c"; done
  # A failed or interrupted up (die, error, Ctrl-C, closed output pipe) leaves no half stack.
  UP_DONE=0
  trap 'if [ "$UP_DONE" != 1 ]; then for c in "${COMPONENTS[@]}"; do stop_one "$c" >&2 || true; done; fi' EXIT
  trap 'exit 1' INT TERM HUP PIPE

  # ── preconditions ──
  for f in .env .env.local .env.development .env.development.local; do
    [ -e "$FRONT/$f" ] && die "front/$f exists: next dev would load it (legacy variables must stay unset). Move it away for E2E."
  done
  venv="$(resolve_venv)" || die "no python venv with uvicorn (set E2E_BACK_VENV)"
  docker ps --format '{{.Names}}' | grep -qx "$PG_NAME" || die "container $PG_NAME is not running (this script never starts it; ask the DB owner)"
  [ "$(docker exec "$PG_NAME" psql -U postgres -At -c "SELECT 1 FROM pg_database WHERE datname = 'hmg_tpl'")" = "1" ] \
    || die "template hmg_tpl does not exist in $PG_NAME"
  for c in "${COMPONENTS[@]}"; do free_port "$(port_of "$c")"; done

  # ── DB clone + accounts ──
  if [ "${E2E_KEEP_DB:-}" = "1" ]; then
    log "E2E_KEEP_DB=1: reusing $DB_NAME"
  else
    local ok=0 i
    for i in 1 2 3 4 5; do
      if bash "$BACK/db/dev-db.sh" clone "$DB_KEY" >/dev/null 2>"$RUN/clone.err"; then ok=1; break; fi
      log "clone attempt $i failed (template busy?), retrying"
      sleep 3
    done
    [ "$ok" = 1 ] || { cat "$RUN/clone.err" >&2; die "could not clone hmg_tpl -> $DB_NAME"; }
    log "cloned hmg_tpl -> $DB_NAME"
  fi
  db_url="$(bash "$BACK/db/dev-db.sh" url "$DB_KEY")"
  # The backend expects DB-v2.13 (rd.answer.cit_off, S1 BE-B). The shared template hmg_tpl may be an
  # older build (v2.10 on 2026-09-30) and is never rebuilt here: the clone is brought forward with the
  # backend tests' own code (back/tests/dbforward.py: v2.11 -> v2.12 -> v2.13 patches when missing,
  # then back/migration/fill-cit-off.sql commit=1). Idempotent: a v2.13 template or a kept DB is a no-op.
  # It refuses a template database name. The URL goes by environment, not argv.
  applied="$(HGH_E2E_DB_URL="$db_url" "$venv/bin/python" -c 'import asyncio, os, sys
sys.path.insert(0, sys.argv[1])
import asyncpg
from tests.dbforward import ensure_latest
async def main():
    c = await asyncpg.connect(os.environ["HGH_E2E_DB_URL"])
    try:
        print(" ".join(await ensure_latest(c)) or "none")
    finally:
        await c.close()
asyncio.run(main())' "$BACK" 2>"$RUN/dbforward.err")" || { tail -n 20 "$RUN/dbforward.err" >&2; die "could not bring $DB_NAME forward to DB-v2.13"; }
  [ "$(psql_db -d "$DB_NAME" -At -c "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_off' AND NOT attisdropped)")" = "t" ] \
    || die "$DB_NAME is not DB-v2.13 after the forward step (rd.answer.cit_off missing)"
  log "$DB_NAME forward to DB-v2.13: applied ${applied}"
  count="$(psql_db -d "$DB_NAME" -At -c "SELECT count(*) FROM rd.answer")"
  [ "${count:-0}" -gt 0 ] || die "$DB_NAME has no rd.answer rows (template not built?)"
  log "$DB_NAME rd.answer rows: $count"
  "$venv/bin/python" -c 'import sys; sys.path.insert(0, sys.argv[1]); from tests.support import ACCOUNTS_SQL; sys.stdout.write(ACCOUNTS_SQL)' "$BACK" \
    | psql_db -d "$DB_NAME" >/dev/null
  psql_db -d "$DB_NAME" -At -c "SELECT user_id::text || '|' || email || '|' || status FROM app.user_account WHERE user_id::text LIKE '11111111-0000-4000-8000-%' ORDER BY 1" \
    | node "$E2E/lib/stack-helper.mjs" check-accounts

  # ── per-run files ──
  (umask 077 && openssl rand -hex 24 >"$RUN/qa-password" && : >"$RUN/api-trace.jsonl" && : >"$RUN/tap.jsonl")
  qa_password="$(cat "$RUN/qa-password")"
  qa_secret="$(openssl rand -hex 32)"
  relay_secret="$(openssl rand -hex 24)" # D2: BFF sends the viewer IP with this shared secret
  node "$E2E/lib/stack-helper.mjs" select "$RUN/trace-select.json"
  flags="$(node "$E2E/lib/stack-helper.mjs" flags)"
  log "source flags: $(echo "$flags" | tr '\n' ' ')"

  # ── mock auth ──
  start auth "$E2E" E2E_ALLOW_MOCK_AUTH=1 E2E_AUTH_HOST=127.0.0.1 E2E_AUTH_PORT="$AUTH_PORT" \
    -- node "$E2E/mock-auth/server.mjs"
  wait_http auth "http://127.0.0.1:$AUTH_PORT/__e2e/health" 200 20

  # ── backend ──
  start back "$BACK" PYTHONUNBUFFERED=1 \
    HGH_ENV=local HGH_DB_URL="$db_url" HGH_DB_POOL_SIZE=3 HGH_DB_MAX_OVERFLOW=3 \
    HGH_JWKS_URL="http://127.0.0.1:$AUTH_PORT/auth/v1/.well-known/jwks.json" \
    HGH_JWT_ISSUER="http://127.0.0.1:$AUTH_PORT/auth/v1" \
    HGH_QA_ENABLED=1 HGH_QA_PASSWORD="$qa_password" HGH_QA_SECRET="$qa_secret" HGH_RELAY_SECRET="$relay_secret" \
    HGH_SQL_GUARD=1 \
    -- "$venv/bin/uvicorn" app.main:app --app-dir "$BACK" --host 127.0.0.1 --port "$API_PORT" --log-level info
  wait_http back "http://127.0.0.1:$API_PORT/healthz" 200 90

  # ── tap ──
  start tap "$E2E" E2E_ALLOW_MOCK_AUTH=1 E2E_TAP_PORT="$TAP_PORT" \
    E2E_TAP_UPSTREAM="http://127.0.0.1:$API_PORT" E2E_TAP_LOG="$RUN/tap.jsonl" \
    -- node "$E2E/tap/server.mjs"
  wait_http tap "http://127.0.0.1:$TAP_PORT/healthz" 200 20

  # ── next dev ──
  # Heap 10240: with every U5..U11 route in the list, next dev's heap grows with each compile and
  # visit until it hits "approaching the used memory threshold, restarting" (2026-09-29: at 4096
  # twice in one run, at 6144 once, about 110 of 150 page loads in). The restart drops the request
  # in flight (a 25 s goto timeout) and its update check lands in a case slice as an egress block.
  # It is a cap, not a reservation: the full run at 10240 had no restart, worker RSS peaked 5.2 GB.
  # One full run per next dev process: next restarts when used heap (garbage included) passes 80% of
  # the cap, and the heap carries over between runs (2026-09-30: run 1 clean, run 2 on the same
  # process restarted about 38 of 92 cases in and dropped that case). Between full runs: down, up.
  # screens.e2e.ts names such a restart in the case result.
  # shellcheck disable=SC2086
  start front "$FRONT" $flags \
    NODE_OPTIONS="--require $E2E/lib/no-egress.cjs --max-old-space-size=10240" NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$AUTH_PORT" NEXT_PUBLIC_SUPABASE_ANON_KEY=e2e-anon \
    HGH_API_BASE_URL="http://127.0.0.1:$TAP_PORT" HGH_RELAY_SECRET="$relay_secret" \
    HGH_API_TRACE_FILE="$RUN/api-trace.jsonl" HGH_API_TRACE_SELECT="$RUN/trace-select.json" \
    RAW_DATA_QA_ENABLED=1 \
    -- node "$FRONT/node_modules/next/dist/bin/next" dev -p "$FRONT_PORT" -H 127.0.0.1
  wait_http front "http://127.0.0.1:$FRONT_PORT/ko/login" 200 300
  UP_DONE=1
  log "up. run: cd front && npx playwright test -c e2e/playwright.config.ts [-g <screen id>]"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: bash front/e2e/stack.sh up | down | status" >&2; exit 2 ;;
esac
