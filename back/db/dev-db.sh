#!/usr/bin/env bash
# 로컬 개발·테스트 DB(PostgreSQL 17, 합성 데이터만). 기능 모듈 빌더가 공유하고, 각자 템플릿을 복제해 쓴다.
#   up            컨테이너 기동(-m 4g, max_connections 500: 개발자 16명 동시 pytest × 풀 4종) + 템플릿 hmg_tpl 구성
#                 (DB-v2.32 → 규칙·합성 픽스처 → rd 투영 seed-30·40). 이미 떠 있으면 템플릿만 재구성하고, 메모리 한도는 즉시 올리며
#                 max_connections 가 500 미만이면 ALTER SYSTEM 으로 예약한다(적용은 restart 때, 다른 빌더 세션이 끊기므로 합의 후).
#   restart       컨테이너 재기동(docker restart: 데이터·복제본 유지, 설정 반영). 다른 빌더의 연결이 끊긴다
#   clone <이름>  hmg_<이름> = hmg_tpl 복제(빌더·테스트마다 따로. 이름 = 빌더 키, back/tests/README.md)
#   url <이름>    접속 URL 출력(로컬 전용 비밀번호)
#   down          정지(--rm 이라 삭제)
# 포트는 127.0.0.1 에만 연다. 고객 데이터는 절대 넣지 않는다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BACK="$(cd "$HERE/.." && pwd)"
NAME="${DEV_PG_NAME:-hgh-dev-pg}"; PORT="${DEV_PG_PORT:-55432}"; PW="${DEV_PG_PASSWORD:-dev}"
MEM="${DEV_PG_MEM:-4g}"; MAXCONN="${DEV_PG_MAXCONN:-500}"
psqlc() { docker exec -i "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }

case "${1:-}" in
  up)
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      docker run -d --rm --name "$NAME" -m "$MEM" --memory-swap "$MEM" -p "127.0.0.1:${PORT}:5432" -e POSTGRES_PASSWORD="$PW" \
        postgres:17 -c max_connections="$MAXCONN" >/dev/null
      for i in $(seq 1 30); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
    else
      docker update --memory "$MEM" --memory-swap "$MEM" "$NAME" >/dev/null 2>&1 || echo "메모리 한도 갱신 실패(수동: docker update)"
      CUR=$(psqlc -d postgres -At -c "SHOW max_connections")
      if [ "$CUR" -lt "$MAXCONN" ]; then
        psqlc -d postgres -c "ALTER SYSTEM SET max_connections = $MAXCONN" >/dev/null
        echo "max_connections $CUR → $MAXCONN 예약(적용: bash $0 restart, 다른 빌더 연결이 끊긴다)"
      fi
    fi
    psqlc -d postgres -c "DROP DATABASE IF EXISTS hmg_tpl WITH (FORCE)" -c "CREATE DATABASE hmg_tpl"
    docker exec "$NAME" rm -rf /work && docker exec "$NAME" mkdir -p /work
    # 레포 back/ 구조 그대로 복사(\ir 상대 경로가 레포 기준)
    docker cp "$BACK/." "$NAME:/work/back"
    run() { docker exec -w "/work/back/$1" "$NAME" psql -U postgres -X -q -d hmg_tpl -v ON_ERROR_STOP=1 -f "$2" >/dev/null; }
    run db DB-v2.32.sql                  # seed-40 이 rd.answer.cit_off(DB-v2.13)를, 적재기가 발행 게이트(DB-v2.14)를 쓴다. v2.15 열은 NULL(채우기 = fill-v215.sql), v2.16 보고서 유닛 표는 빈 표(채우기 = fill-v216.sql), v2.17 엔티티 버전은 비어 있다(v1 이관 = ecat-v1-cutover.sql), v2.25 엔티티 합계는 아래 재계산(= fill-v225.sql), v2.26 롤업 대표 표기 원장은 픽스처 적재 트리거가 채운다, v2.27·v2.28 동결 접기 보관 함수는 채우기 없음, v2.29 표시명 해시 키·v2.31 감사 권한·v2.32 카드 뷰 본문 교체는 채우기 없음, v2.30 창 판정 기초는 아래 전체 계산(= fill-v230.sql)
    run tests/fixtures fixture-00-rules.sql
    run tests/fixtures fixture-10-data.sql
    run migration/seed seed-30-dims.sql
    run migration/seed seed-40-facts.sql
    psqlc -d hmg_tpl -c "SELECT rd.refresh_entity_mention_total(NULL)" >/dev/null   # 픽스처 언급의 엔티티 합계(= fill-v225.sql)
    psqlc -d hmg_tpl -c "SELECT rd.refresh_cycle_pick_basis(NULL)" >/dev/null       # 창 판정 함대 가시·판정 갭 전체 계산(= fill-v230.sql, seed-40 도 부르지만 시드 끝 상태로 한 번 더)
    psqlc -d hmg_tpl -At -F ' ' -c "SELECT 'rd.answer', count(*) FROM rd.answer UNION ALL SELECT 'rd.answer_brand', count(*) FROM rd.answer_brand UNION ALL SELECT 'rd.citation', count(*) FROM rd.citation UNION ALL SELECT 'rd.cycle', count(*) FROM rd.cycle"
    echo "UP ${NAME} 127.0.0.1:${PORT} hmg_tpl" ;;
  clone)
    N="hmg_${2:?이름}"; psqlc -d postgres -c "DROP DATABASE IF EXISTS \"$N\" WITH (FORCE)" -c "CREATE DATABASE \"$N\" TEMPLATE hmg_tpl"; echo "$N" ;;
  url)
    echo "postgresql://postgres:${PW}@127.0.0.1:${PORT}/hmg_${2:?이름}" ;;
  restart)
    docker restart "$NAME" >/dev/null
    for i in $(seq 1 30); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
    psqlc -d postgres -At -c "SELECT 'max_connections', current_setting('max_connections')" ;;
  down)
    docker stop "$NAME" >/dev/null 2>&1 || true; docker ps -a --filter "name=^${NAME}$" --format '{{.Names}}' | grep -c . || true ;;
  *) echo "usage: up | restart | clone <이름> | url <이름> | down"; exit 2 ;;
esac
