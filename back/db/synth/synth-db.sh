#!/usr/bin/env bash
# 합성 운영형 DB(PostgreSQL 17). 고객 데이터 0·운영 접속 0: 값은 전부 back/db/synth/synth.py 가 만든 생성값이다(README.md).
# 쓰임 = 운영과 비슷하게 보이는 개발·데모·QA 화면, 운영 규모 성능 시험. 공유 개발 DB(dev-db.sh, hgh-dev-pg)와 컨테이너를 나눈다
# (큰 적재·성능 시험이 다른 빌더의 pytest 를 느리게 하지 않게).
#   gen  [scale] [seed]  synth.py 로 산출물 생성 → back/db/synth/out/s<scale>-r<seed>/ (gitignore)
#   up                   컨테이너 기동(-m SYNTH_PG_MEM 기본 8g, --shm-size 2g: 병렬 질의 공유 메모리. 데이터 = 이름 있는 볼륨이라 down 뒤에도 남는다)
#   load [scale] [seed]  DB SYNTH_DB(기본 hmg_synth) 재구성: DB-v2.32 → 규칙(fixture-00, 코드 상수 발췌) → 합성 app·ing COPY
#                        → seed-30·40 → 파생 계산(dev-db.sh 와 같은 2종) → ANALYZE → 행 수
#   url                  접속 URL(로컬 전용 비밀번호)
#   api                  백엔드(FastAPI)를 SYNTH_DB 에 붙여 띄운다: 컨테이너 hgh-synth-api, 127.0.0.1:SYNTH_API_PORT(기본 18090).
#                        이미지 = back 테스트 이미지(hgh-renewal-tests:local, requirements-dev.lock). JWKS = 호스트의 mock auth
#   api-down             백엔드 정지
#   demo                 호스트에 mock auth(front/e2e/mock-auth, 127.0.0.1:SYNTH_AUTH_PORT 기본 54599: Windows 예약 대역 54467-54566 밖)와
#                        화면 next dev(127.0.0.1:SYNTH_FRONT_PORT 기본 3200, 외부 통신 차단 훅, 모든 화면 그룹 = 백엔드 경로)를 띄운다.
#                        로그 = back/db/synth/out/run/. 로그인 admin@admin / admin(SYNTH_DEMO_PASSWORD, 로컬 mock auth 전용).
#                        mock auth 계정 파일은 out/run/demo-accounts.json 으로 새로 만든다(E2E 계정 + 데모 관리자, 비밀번호 공통).
#                        mock auth 를 새로 띄우면 서명 키가 바뀌므로 백엔드 컨테이너를 재시작해 JWKS 캐시를 비운다
#   demo-down            demo 가 띄운 두 프로세스(트리)만 정지(포트로 찾고 명령줄이 mock-auth·next dev -p 포트 일 때만)
#   down                 DB 정지(볼륨 유지)
#   purge                DB 정지 + 볼륨 삭제
# 이 DB 는 버려도 되는 사본이다: 적재 속도를 위해 fsync·full_page_writes 를 끈다(장애 시 load 로 다시 만든다).
# 포트는 127.0.0.1 에만 연다.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash 가 컨테이너 경로(/work/…)를 Windows 경로로 바꾸지 않게
HERE="$(cd "$(dirname "$0")" && pwd)"
BACK="$(cd "$HERE/../.." && pwd)"
FRONT="$(cd "$BACK/../front" && pwd)"
NAME="${SYNTH_PG_NAME:-hgh-synth-pg}"; PORT="${SYNTH_PG_PORT:-56432}"; PW="${SYNTH_PG_PASSWORD:-dev}"
MEM="${SYNTH_PG_MEM:-8g}"; DB="${SYNTH_DB:-hmg_synth}"; VOL="${SYNTH_PG_VOLUME:-hgh-synth-pgdata}"
API="${SYNTH_API_NAME:-hgh-synth-api}"; API_PORT="${SYNTH_API_PORT:-18090}"; AUTH_PORT="${SYNTH_AUTH_PORT:-54599}"
FRONT_PORT="${SYNTH_FRONT_PORT:-3200}"; NET="${SYNTH_NET:-hgh-synth-net}"; IMAGE="${SYNTH_API_IMAGE:-hgh-renewal-tests:local}"
SCALE="${2:-0.02}"; SEED="${3:-1}"; TAG="s${SCALE}-r${SEED}"; RUN="$HERE/out/run"
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
psqlw() {   # psqlw <컨테이너 작업 디렉터리> <psql 인자…>
  local dir="$1"; shift
  docker exec -i -w "$dir" "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 "$@"
}
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-5}" "$1" 2>/dev/null || true; }
wait_http() {   # wait_http <이름> <URL> <초>
  local i
  for i in $(seq 1 "$3"); do [ "$(http_code "$2" 60)" = 200 ] && return 0; sleep 1; done
  echo "$1 응답 없음: $2 (로그 $RUN/$1.log)"; return 1
}
stop_port() {   # stop_port <포트> <명령줄 조각>: 그 포트를 듣는 프로세스(부모가 조각을 담으면 부모 트리)를, 명령줄이 조각을 담을 때만 정지
  local port="$1" pat="$2" pid
  if command -v powershell >/dev/null 2>&1; then   # Windows(Git Bash): $! 는 node 가 아니라 중간 셸이라 포트 기준으로 찾는다
    powershell -NoProfile -Command "
      foreach (\$x in (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
        \$p = Get-CimInstance Win32_Process -Filter \"ProcessId=\$(\$x.OwningProcess)\"
        \$q = Get-CimInstance Win32_Process -Filter \"ProcessId=\$(\$p.ParentProcessId)\"
        if (\$q -and \$q.CommandLine -like '*$pat*') { taskkill /F /T /PID \$q.ProcessId | Out-Null }
        elseif (\$p.CommandLine -like '*$pat*') { taskkill /F /T /PID \$p.ProcessId | Out-Null }
        else { Write-Output \"port ${port}: 다른 프로세스 \$(\$p.ProcessId) 라 건드리지 않음\" } }"
  else
    for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
      if ps -o args= -p "$pid" | grep -qF -- "$pat"; then kill -TERM "$pid" 2>/dev/null || true
      else echo "port ${port}: 다른 프로세스 $pid 라 건드리지 않음"; fi
    done
  fi
}

case "${1:-}" in
  gen)
    python "$(hostpath "$HERE/synth.py")" --scale "$SCALE" --seed "$SEED" --out "$(hostpath "$HERE/out/$TAG")" ;;
  up)
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      docker run -d --rm --name "$NAME" -m "$MEM" --memory-swap "$MEM" --shm-size "${SYNTH_PG_SHM:-2g}" \
        -p "127.0.0.1:${PORT}:5432" -e POSTGRES_PASSWORD="$PW" \
        -v "$VOL:/var/lib/postgresql/data" -v "$(hostpath "$BACK"):/work/back:ro" \
        postgres:17 -c shared_buffers=2GB -c maintenance_work_mem=1GB -c work_mem=256MB -c max_wal_size=16GB \
        -c checkpoint_timeout=30min -c fsync=off -c full_page_writes=off -c synchronous_commit=off \
        -c max_parallel_workers_per_gather=4 -c max_connections=200 >/dev/null
    fi
    for i in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
    echo "UP ${NAME} 127.0.0.1:${PORT}" ;;
  load)
    OUT="/work/back/db/synth/out/$TAG"
    docker exec "$NAME" test -f "$OUT/load.sql" || { echo "산출물 없음: $OUT (먼저 gen $SCALE $SEED)"; exit 1; }
    psqlw / -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\""
    t0=$(date +%s)
    psqlw /work/back/db -d "$DB" -f DB-v2.32.sql >/dev/null
    psqlw /work/back/tests/fixtures -d "$DB" -f fixture-00-rules.sql >/dev/null
    echo "DDL·규칙 $(( $(date +%s) - t0 ))s"
    psqlw "$OUT" -d "$DB" -f load.sql >/dev/null
    echo "합성 적재 $(( $(date +%s) - t0 ))s"
    psqlw /work/back/migration/seed -d "$DB" -f seed-30-dims.sql >/dev/null
    echo "seed-30 $(( $(date +%s) - t0 ))s"
    psqlw /work/back/migration/seed -d "$DB" -f seed-40-facts.sql >/dev/null
    echo "seed-40 $(( $(date +%s) - t0 ))s"
    psqlw / -d "$DB" -c "SELECT rd.refresh_entity_mention_total(NULL)" -c "SELECT rd.refresh_cycle_pick_basis(NULL)" >/dev/null
    psqlw / -d "$DB" -c "ANALYZE" >/dev/null
    psqlw / -d "$DB" -At -F ' ' -c "SELECT 'rd.answer', count(*)::text FROM rd.answer UNION ALL SELECT 'rd.answer_brand', count(*)::text FROM rd.answer_brand
      UNION ALL SELECT 'rd.citation', count(*)::text FROM rd.citation UNION ALL SELECT 'rd.answer_stance', count(*)::text FROM rd.answer_stance
      UNION ALL SELECT 'rd.acr_choice', count(*)::text FROM rd.acr_choice UNION ALL SELECT 'rd.cycle', count(*)::text FROM rd.cycle
      UNION ALL SELECT 'db_size', pg_size_pretty(pg_database_size(current_database()))"
    echo "LOADED ${DB} (${TAG}) $(( $(date +%s) - t0 ))s" ;;
  url)
    echo "postgresql://postgres:${PW}@127.0.0.1:${PORT}/${DB}" ;;
  api)
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
    docker network connect "$NET" "$NAME" >/dev/null 2>&1 || true
    docker rm -f "$API" >/dev/null 2>&1 || true
    docker run -d --rm --name "$API" --network "$NET" -p "127.0.0.1:${API_PORT}:8000" \
      -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONUNBUFFERED=1 -e HGH_ENV=local \
      -e HGH_DB_URL="postgresql://postgres:${PW}@${NAME}:5432/${DB}" -e HGH_DB_POOL_SIZE=5 -e HGH_DB_MAX_OVERFLOW=5 \
      -e HGH_JWKS_URL="http://host.docker.internal:${AUTH_PORT}/auth/v1/.well-known/jwks.json" \
      -e HGH_JWT_ISSUER="http://127.0.0.1:${AUTH_PORT}/auth/v1" -e HGH_SQL_GUARD=1 \
      -v "$(hostpath "$BACK"):/work/back:ro" -w /work/back "$IMAGE" \
      python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --log-level info >/dev/null
    wait_http api "http://127.0.0.1:${API_PORT}/healthz" 90 || true
    echo "API ${API} http://127.0.0.1:${API_PORT} → ${DB} (log: docker logs ${API})" ;;
  api-down)
    docker stop "$API" >/dev/null 2>&1 || true ;;
  demo)
    mkdir -p "$RUN"
    [ "$(http_code "http://127.0.0.1:${API_PORT}/healthz")" = 200 ] || { echo "백엔드 없음: 먼저 api"; exit 1; }
    if [ "$(http_code "http://127.0.0.1:${AUTH_PORT}/__e2e/health")" != 200 ]; then
      # 데모 계정 파일 = E2E 계정 + 데모 관리자(synth.py DEMO_ADMIN). E2E 파일(front/e2e/accounts.json)은 고치지 않는다
      python - "$(hostpath "$FRONT/e2e/accounts.json")" "$(hostpath "$RUN/demo-accounts.json")" "${SYNTH_DEMO_PASSWORD:-admin}" <<'PY'
import json, sys
src, out, password = sys.argv[1:4]
with open(src, encoding="utf-8") as f:
    doc = json.load(f)
doc["$comment"] = "합성 데모 전용(back/db/synth/synth-db.sh demo 가 생성). E2E 계정 + 데모 관리자. 비밀번호는 로컬 mock auth 전용"
doc["password"] = password
doc["accounts"].append({"key": "DEMO_ADMIN", "id": "5e7a0000-0000-4000-8000-00000000ad01", "email": "admin@admin",
                        "role": "admin", "menuGroups": None, "status": "active"})
with open(out, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=1)
PY
      (cd "$FRONT" && E2E_ALLOW_MOCK_AUTH=1 E2E_AUTH_HOST=127.0.0.1 E2E_AUTH_PORT="$AUTH_PORT" \
         E2E_ACCOUNTS="$(hostpath "$RUN/demo-accounts.json")" \
         nohup node e2e/mock-auth/server.mjs >"$RUN/auth.log" 2>&1 </dev/null &)
      wait_http auth "http://127.0.0.1:${AUTH_PORT}/__e2e/health" 20
      # mock auth 는 띄울 때마다 서명 키를 새로 만든다 → 백엔드를 재시작해 미리 받아 둔 JWKS 를 비운다
      docker restart "$API" >/dev/null && wait_http api "http://127.0.0.1:${API_PORT}/healthz" 90
    fi
    if [ "$(http_code "http://127.0.0.1:${FRONT_PORT}/ko/login")" != 200 ]; then
      (cd "$FRONT" && env -u DATABASE_URL -u SCOPE_API_BASE -u SCOPE_API_KEY -u SCOPE_MODE \
         NODE_OPTIONS="--require ./e2e/lib/no-egress.cjs --max-old-space-size=8192" NEXT_TELEMETRY_DISABLED=1 \
         NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:${AUTH_PORT}" NEXT_PUBLIC_SUPABASE_ANON_KEY=e2e-anon \
         HGH_API_BASE_URL="http://127.0.0.1:${API_PORT}" HGH_SOURCE_SESSION=api HGH_SOURCE_G1=api HGH_SOURCE_G2=api \
         HGH_SOURCE_G3=api HGH_SOURCE_G4=api HGH_SOURCE_G5=api HGH_SOURCE_G6=api HGH_SOURCE_G7=api \
         nohup node node_modules/next/dist/bin/next dev -p "$FRONT_PORT" -H 127.0.0.1 >"$RUN/front.log" 2>&1 </dev/null &)
      wait_http front "http://127.0.0.1:${FRONT_PORT}/ko/login" 300
    fi
    api_db="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$API" 2>/dev/null | sed -n 's#^HGH_DB_URL=.*/##p')"
    echo "DEMO http://127.0.0.1:${FRONT_PORT}/ko/login  (admin@admin / ${SYNTH_DEMO_PASSWORD:-admin}, 백엔드 DB = ${api_db:-?})" ;;
  demo-down)
    stop_port "$FRONT_PORT" "next dev -p $FRONT_PORT"; stop_port "$AUTH_PORT" "mock-auth/server.mjs" ;;
  down)
    docker stop "$NAME" >/dev/null 2>&1 || true ;;
  purge)
    docker stop "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true ;;
  *) echo "usage: gen|load [scale] [seed] | up | url | api | api-down | demo | demo-down | down | purge"; exit 2 ;;
esac
