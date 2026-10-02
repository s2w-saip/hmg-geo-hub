#!/usr/bin/env bash
# 대분류별 격리 pytest(공식 게이트). 쓰기 테스트가 커밋한 행(예: admin 표준 프롬프트 생성)이
# 다른 대분류의 읽기 기대값을 바꾸지 않도록, 대분류마다 템플릿 DB 의 새 복제본에서 돈다.
# 같은 대분류 안의 테스트는 한 DB 를 공유한다(대분류 단독 두 번 실행 = 재진입 안전이 규약).
#
#   TEMPLATE_DB  복제 원본 DB 이름(구성이 끝난 개발 DB, 이 스크립트 도중 접속 없어야 함)  기본 hmg_tpl
#   URL_PREFIX   접속 URL 에서 DB 이름 앞까지                                           기본 postgresql://postgres:dev@127.0.0.1:55432/
#   PSQL_ADMIN   postgres DB 에 붙는 psql 명령                                          기본 psql -X -q -v ON_ERROR_STOP=1 -d postgres
#   PYTEST       pytest 명령                                                            기본 python -m pytest
#   ISO_PREFIX   복제본 이름 접두(동시 실행끼리 겹치지 않게 PID 포함)                  기본 <TEMPLATE_DB>_iso<PID>
# 인자는 pytest 에 그대로 넘긴다(예: -x). 로컬 예:
#   PSQL_ADMIN="docker exec -i hgh-dev-pg psql -U postgres -X -q -v ON_ERROR_STOP=1 -d postgres" bash tests/run-areas.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TEMPLATE_DB="${TEMPLATE_DB:-hmg_tpl}"
URL_PREFIX="${URL_PREFIX:-postgresql://postgres:dev@127.0.0.1:55432/}"
read -r -a PSQL_ADMIN <<< "${PSQL_ADMIN:-psql -X -q -v ON_ERROR_STOP=1 -d postgres}"
read -r -a PYTEST <<< "${PYTEST:-python -m pytest}"
ISO_PREFIX="${ISO_PREFIX:-${TEMPLATE_DB}_iso$$}"

# 대분류 = tests/core + app/features/* + (있으면) ingest. 새 대분류가 생겨도 자동으로 포함된다.
areas=("tests/core")
for d in app/features/*/; do
  case "$d" in */__pycache__/) continue ;; esac
  areas+=("${d%/}")
done
[ -d ingest ] && areas+=("ingest")

collected() { "${PYTEST[@]}" --collect-only -q -p no:cacheprovider "$@" 2>/dev/null | grep -cE '::' || true; }

# 누락 방지: 기본 testpaths 전체 수집 수 = 대분류 수집 합.
total=$(collected)
sum=0
for a in "${areas[@]}"; do n=$(collected "$a"); sum=$((sum + n)); done
if [ "$total" -ne "$sum" ]; then
  echo "대분류 합($sum) != 전체 수집($total): 대분류 목록 밖 테스트가 있다" >&2
  exit 3
fi
echo "수집 ${total}건, 대분류 ${#areas[@]}개"

fail=0
for a in "${areas[@]}"; do
  name=$(echo "$a" | tr '/.-' '___')
  db="${ISO_PREFIX}_${name}"
  "${PSQL_ADMIN[@]}" -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\" TEMPLATE \"$TEMPLATE_DB\"" >/dev/null
  echo "== $a ($db)"
  rc=0
  HGH_TEST_DB_URL="${URL_PREFIX}${db}" "${PYTEST[@]}" -q -p no:cacheprovider "$a" "$@" || rc=$?
  # 5 = 수집 0건(테스트가 아직 없는 대분류). 그 밖의 비0 은 실패
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 5 ]; then fail=1; fi
  "${PSQL_ADMIN[@]}" -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null
done
exit $fail
